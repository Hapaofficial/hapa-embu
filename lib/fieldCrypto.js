// AES-256-GCM application-level encryption for sensitive Upgrade System text
// fields. Versioned envelope format: v1:<iv b64>:<authTag b64>:<ciphertext b64>
// Key comes from DOCUMENT_ENCRYPTION_KEY (hex, base64 or passphrase — never
// hardcoded, never logged). Production fails closed when the key is missing.
const crypto = require('crypto');

const ENVELOPE_VERSION = 'v1';

function loadKey() {
  const raw = process.env.DOCUMENT_ENCRYPTION_KEY || '';
  if (!raw) return null;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, 'hex');
  try {
    const b = Buffer.from(raw, 'base64');
    if (b.length === 32) return b;
  } catch (_) { /* fall through */ }
  // Passphrase: derive a 32-byte key (deterministic, versioned inside envelope)
  return crypto.createHash('sha256').update(raw, 'utf8').digest();
}

let cachedKey;
function key() {
  if (cachedKey === undefined) cachedKey = loadKey();
  return cachedKey;
}

function available() { return !!key(); }

// Encrypt a plain object of sensitive fields → envelope string (or null for empty).
function encryptFields(obj) {
  const entries = Object.entries(obj || {}).filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== '');
  if (!entries.length) return null;
  const k = key();
  if (!k) throw new Error('DOCUMENT_ENCRYPTION_KEY is not configured');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', k, iv);
  const plaintext = Buffer.from(JSON.stringify(Object.fromEntries(entries)), 'utf8');
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [ENVELOPE_VERSION, iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join(':');
}

// Decrypt envelope string → plain object ({} when null/undecryptable-in-dev).
function decryptFields(envelope) {
  if (!envelope) return {};
  const k = key();
  if (!k) throw new Error('DOCUMENT_ENCRYPTION_KEY is not configured');
  const parts = String(envelope).split(':');
  if (parts.length !== 4 || parts[0] !== ENVELOPE_VERSION) throw new Error('Unsupported sensitive-data envelope');
  const [, ivB64, tagB64, ctB64] = parts;
  const decipher = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const pt = Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]);
  return JSON.parse(pt.toString('utf8'));
}

module.exports = { encryptFields, decryptFields, available, ENVELOPE_VERSION };
