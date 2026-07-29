// PUBLIC media storage abstraction (professional profile + portfolio images).
// Completely separate from lib/documentStorage.js and the private-document
// buckets. Never reads DOCUMENT_S3_* variables and never touches
// hapa-private-documents / hapa-staging-private-documents.
//
// PUBLIC_MEDIA_STORAGE_MODE=local → files under var/public-media/ (outside
//                                   public/, streamed only through the public
//                                   media route after sanitization)
// PUBLIC_MEDIA_STORAGE_MODE=s3    → dedicated public-media bucket
//                                   (PUBLIC_MEDIA_S3_BUCKET), served via
//                                   short-lived signed URLs.
const fs = require('fs');
const path = require('path');

const MODE = (process.env.PUBLIC_MEDIA_STORAGE_MODE || 'local').toLowerCase();
const LOCAL_ROOT = path.join(__dirname, '..', 'var', 'public-media');
const SIGNED_URL_TTL_SECONDS = 300;
const FORBIDDEN_BUCKETS = ['hapa-private-documents', 'hapa-staging-private-documents'];

function s3Config() {
  return {
    endpoint: process.env.PUBLIC_MEDIA_S3_ENDPOINT || undefined,
    region: process.env.PUBLIC_MEDIA_S3_REGION || 'auto',
    bucket: process.env.PUBLIC_MEDIA_S3_BUCKET,
    accessKeyId: process.env.PUBLIC_MEDIA_S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.PUBLIC_MEDIA_S3_SECRET_ACCESS_KEY,
    forcePathStyle: String(process.env.PUBLIC_MEDIA_S3_FORCE_PATH_STYLE || '') === 'true',
  };
}

function isConfigured() {
  if (MODE === 'local') return true;
  if (MODE === 's3') {
    const c = s3Config();
    if (!c.bucket || !c.accessKeyId || !c.secretAccessKey) return false;
    // Hard guard: public media must never share a private-document bucket —
    // neither the known bucket names nor whatever DOCUMENT_S3_BUCKET points at.
    if (FORBIDDEN_BUCKETS.includes(c.bucket) || (process.env.DOCUMENT_S3_BUCKET && c.bucket === process.env.DOCUMENT_S3_BUCKET)) {
      console.error('publicMediaStorage: refusing to use private-document bucket', c.bucket);
      return false;
    }
    return true;
  }
  return false;
}

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
  const p = path.resolve(LOCAL_ROOT, objectKey);
  if (!p.startsWith(path.resolve(LOCAL_ROOT) + path.sep)) throw new Error('Invalid object key');
  return p;
}

async function putObject(objectKey, buffer, mimeType) {
  if (MODE === 's3') {
    if (!isConfigured()) throw new Error('Public media storage not configured');
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    await s3Client().send(new PutObjectCommand({
      Bucket: s3Config().bucket, Key: objectKey, Body: buffer, ContentType: mimeType,
    }));
    return { provider: 's3' };
  }
  const p = localPath(objectKey);
  await fs.promises.mkdir(path.dirname(p), { recursive: true });
  await fs.promises.writeFile(p, buffer, { flag: 'wx' });
  return { provider: 'local' };
}

// Local: readable stream. S3: short-lived signed URL with public caching
// (this is public marketing content, unlike private documents).
async function getObjectAccess(objectKey, mimeType) {
  if (MODE === 's3') {
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
    const url = await getSignedUrl(s3Client(), new GetObjectCommand({
      Bucket: s3Config().bucket, Key: objectKey,
      ResponseContentType: mimeType || 'image/jpeg',
      ResponseContentDisposition: 'inline',
      ResponseCacheControl: 'public, max-age=300',
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
  putObject, getObjectAccess, deleteObject,
};
