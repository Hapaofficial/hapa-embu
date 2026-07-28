// Private document storage provider abstraction.
// DOCUMENT_STORAGE_MODE=local  → files under var/private-documents/ (outside
//                                public/, never served statically, streamed
//                                only through authenticated routes)
// DOCUMENT_STORAGE_MODE=s3     → private S3-compatible bucket (R2/AWS/other),
//                                access via short-lived signed URLs only.
// No permanent public URLs are ever generated in either mode.
const fs = require('fs');
const path = require('path');

const MODE = (process.env.DOCUMENT_STORAGE_MODE || 'local').toLowerCase();
const LOCAL_ROOT = path.join(__dirname, '..', 'var', 'private-documents');
const SIGNED_URL_TTL_SECONDS = 120; // short-lived, spec: 60–300s

function s3Config() {
  return {
    endpoint: process.env.DOCUMENT_S3_ENDPOINT || undefined,
    region: process.env.DOCUMENT_S3_REGION || 'auto',
    bucket: process.env.DOCUMENT_S3_BUCKET,
    accessKeyId: process.env.DOCUMENT_S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.DOCUMENT_S3_SECRET_ACCESS_KEY,
    forcePathStyle: String(process.env.DOCUMENT_S3_FORCE_PATH_STYLE || '') === 'true',
  };
}

function isConfigured() {
  if (MODE === 'local') return true;
  if (MODE === 's3') {
    const c = s3Config();
    return !!(c.bucket && c.accessKeyId && c.secretAccessKey);
  }
  return false;
}

// Production must refuse uploads unless secure storage is configured correctly.
// Local-disk mode is not durable/secure enough for production documents.
function productionReady() {
  if (process.env.NODE_ENV !== 'production') return isConfigured();
  return MODE === 's3' && isConfigured();
}

let s3ClientCache = null;
function s3Client() {
  if (s3ClientCache) return s3ClientCache;
  const { S3Client } = require('@aws-sdk/client-s3');
  const c = s3Config();
  s3ClientCache = new S3Client({
    region: c.region,
    endpoint: c.endpoint,
    forcePathStyle: c.forcePathStyle,
    credentials: { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey },
  });
  return s3ClientCache;
}

function localPath(objectKey) {
  // objectKey is generated server-side (uuid segments) — resolve + prefix check
  const p = path.resolve(LOCAL_ROOT, objectKey);
  if (!p.startsWith(path.resolve(LOCAL_ROOT) + path.sep)) throw new Error('Invalid object key');
  return p;
}

async function putObject(objectKey, buffer, mimeType) {
  if (MODE === 's3') {
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    await s3Client().send(new PutObjectCommand({
      Bucket: s3Config().bucket, Key: objectKey, Body: buffer, ContentType: mimeType,
    }));
    return { provider: 's3' };
  }
  const p = localPath(objectKey);
  await fs.promises.mkdir(path.dirname(p), { recursive: true });
  // Never overwrite an existing object silently
  await fs.promises.writeFile(p, buffer, { flag: 'wx' });
  return { provider: 'local' };
}

async function objectExists(objectKey) {
  if (MODE === 's3') {
    const { HeadObjectCommand } = require('@aws-sdk/client-s3');
    try { await s3Client().send(new HeadObjectCommand({ Bucket: s3Config().bucket, Key: objectKey })); return true; }
    catch { return false; }
  }
  try { await fs.promises.access(localPath(objectKey)); return true; } catch { return false; }
}

// Local: return a readable stream. S3: return a short-lived signed URL.
// The signed URL pins safe response headers (content type from sanitized
// metadata, inline disposition, private/no-store caching) via S3 response
// overrides so the object response stays safe regardless of bucket defaults.
async function getObjectAccess(objectKey, mimeType) {
  if (MODE === 's3') {
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
    const url = await getSignedUrl(s3Client(), new GetObjectCommand({
      Bucket: s3Config().bucket, Key: objectKey,
      ResponseContentType: mimeType || 'image/jpeg',
      ResponseContentDisposition: 'inline',
      ResponseCacheControl: 'private, no-store',
    }), { expiresIn: SIGNED_URL_TTL_SECONDS });
    return { kind: 'signedUrl', url, expiresIn: SIGNED_URL_TTL_SECONDS };
  }
  const p = localPath(objectKey);
  await fs.promises.access(p);
  return { kind: 'stream', stream: fs.createReadStream(p) };
}

async function deleteObject(objectKey) {
  if (MODE === 's3') {
    const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
    await s3Client().send(new DeleteObjectCommand({ Bucket: s3Config().bucket, Key: objectKey }));
    return;
  }
  await fs.promises.rm(localPath(objectKey), { force: true });
}

module.exports = {
  MODE, LOCAL_ROOT, SIGNED_URL_TTL_SECONDS,
  isConfigured, productionReady,
  putObject, objectExists, getObjectAccess, deleteObject,
};
