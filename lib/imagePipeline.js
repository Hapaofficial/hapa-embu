// Server-side image sanitization for private documents.
// Never trusts browser MIME, filename or data-URI header: the actual bytes are
// decoded with sharp, validated, auto-oriented, resized when necessary,
// re-encoded to JPEG (which strips EXIF/GPS/all metadata) and hashed.
// The original upload buffer is never persisted.
const sharp = require('sharp');
const crypto = require('crypto');

const MAX_INPUT_BYTES = 5 * 1024 * 1024;   // 5 MB incoming
const MAX_DIMENSION = 2500;                // px, longest side after processing
const JPEG_QUALITY = 82;                   // readable documents
const SUPPORTED = new Set(['jpeg', 'png', 'webp', 'heif']); // heif only if decoder present

async function sanitizeImage(buffer) {
  if (!buffer || !buffer.length) throw pipelineError('Empty upload');
  if (buffer.length > MAX_INPUT_BYTES) throw pipelineError('File exceeds the 5 MB limit');
  let meta;
  try {
    meta = await sharp(buffer, { limitInputPixels: 50 * 1024 * 1024, pages: -1 }).metadata();
  } catch (e) {
    throw pipelineError('File is not a valid image');
  }
  if (!meta.format || !SUPPORTED.has(meta.format)) throw pipelineError('Unsupported format. Use JPEG, PNG, WebP or HEIC photos.');
  if ((meta.pages || 1) > 1) throw pipelineError('Animated images are not allowed');
  if (!meta.width || !meta.height) throw pipelineError('File is not a valid image');

  let out;
  try {
    out = await sharp(buffer, { limitInputPixels: 50 * 1024 * 1024 })
      .rotate() // apply EXIF orientation, then EXIF is dropped on re-encode
      .resize({ width: MAX_DIMENSION, height: MAX_DIMENSION, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
  } catch (e) {
    throw pipelineError('Image could not be processed safely');
  }
  const sha256 = crypto.createHash('sha256').update(out.data).digest('hex');
  return {
    buffer: out.data,
    mimeType: 'image/jpeg',
    width: out.info.width,
    height: out.info.height,
    sizeBytes: out.data.length,
    sha256,
  };
}

function pipelineError(message) { const e = new Error(message); e.statusCode = 400; return e; }

module.exports = { sanitizeImage, MAX_INPUT_BYTES, MAX_DIMENSION };
