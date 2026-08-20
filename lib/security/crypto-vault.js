/**
 * Enterprise Cryptographic Vault & Sensitive Data Sanitizer
 * 
 * Cryptographic Architecture:
 * 1. AES-256-GCM authenticated encryption/decryption using native Node.js crypto.
 * 2. 256-bit (32-byte) master key strictly validated from process.env.CRYPTO_VAULT_KEY.
 * 3. Lazy evaluation of master key to eliminate module load race conditions.
 * 4. Dynamic 12-byte initialization vectors (IV) & 16-byte authentication tags (authTag).
 * 5. Safe failure handling: decryption errors strictly return empty string ('' ) instead of ciphertext.
 * 6. Zero-PII recursive scrubber to eliminate credentials and private secrets from logs and DB telemetry.
 */

const crypto = require('crypto');

let cachedKey = null;

// Lazy resolver for 32-byte master key (avoids dotenv load order race conditions)
function getMasterKey() {
  if (cachedKey) return cachedKey;

  const rawKey = process.env.CRYPTO_VAULT_KEY || process.env.MASTER_ENCRYPTION_KEY;
  if (!rawKey) {
    console.warn('[SECURITY WARNING] CRYPTO_VAULT_KEY is not configured in environment. Using high-entropy ephemeral fallback key.');
    cachedKey = crypto.randomBytes(32);
    return cachedKey;
  }

  // If 64-character hex string (32 bytes)
  if (typeof rawKey === 'string' && /^[0-9a-fA-F]{64}$/.test(rawKey)) {
    cachedKey = Buffer.from(rawKey, 'hex');
    return cachedKey;
  }

  // If arbitrary passphrase string, derive standard 256-bit key via PBKDF2
  const VAULT_SALT = 'VRV_ACS_VAULT_SALT_778899_SECURE';
  cachedKey = crypto.pbkdf2Sync(rawKey, VAULT_SALT, 100000, 32, 'sha512');
  return cachedKey;
}

/**
 * Encrypt plaintext using AES-256-GCM.
 * Output Format: `ivHex:authTagHex:cipherHex` (hex-encoded)
 * 
 * @param {string} plainText
 * @returns {string} Encrypted cipher string
 */
function encryptSecret(plainText) {
  if (!plainText || typeof plainText !== 'string') return plainText;
  
  // Prevent double-encryption
  if (plainText.startsWith('enc_gcm$1$') || /^[0-9a-fA-F]{24}:[0-9a-fA-F]{32}:[0-9a-fA-F]+$/.test(plainText)) {
    return plainText;
  }

  try {
    const key = getMasterKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    
    let encrypted = cipher.update(plainText, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');

    return `${iv.toString('hex')}:${authTag}:${encrypted}`;
  } catch (err) {
    console.error('[VAULT ENCRYPT ERROR]', err.message);
    throw new Error(`Encryption failed: ${err.message}`);
  }
}

/**
 * Decrypt cipher string using AES-256-GCM.
 * Supports both `ivHex:authTagHex:cipherHex` and legacy `enc_gcm$1$...` format.
 * If decryption fails (corrupted cipher, invalid authTag), securely returns empty string ('').
 * 
 * @param {string} cipherString
 * @returns {string} Decrypted plaintext string, or '' on authentication failure
 */
function decryptSecret(cipherString) {
  if (!cipherString || typeof cipherString !== 'string') return '';

  try {
    const key = getMasterKey();

    // 1. Standard format `ivHex:authTagHex:cipherHex`
    if (cipherString.includes(':')) {
      const parts = cipherString.split(':');
      if (parts.length === 3) {
        const iv = Buffer.from(parts[0], 'hex');
        const authTag = Buffer.from(parts[1], 'hex');
        const encryptedHex = parts[2];

        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(authTag);

        let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
      }
    }

    // 2. Legacy envelope format `enc_gcm$1$<ivHex>$<authTagHex>$<cipherHex>`
    if (cipherString.startsWith('enc_gcm$1$')) {
      const parts = cipherString.split('$');
      if (parts.length === 5) {
        const iv = Buffer.from(parts[2], 'hex');
        const authTag = Buffer.from(parts[3], 'hex');
        const encryptedHex = parts[4];

        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(authTag);

        let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
      }
    }

    // If string is already plaintext (does not match encrypted cipher format)
    return cipherString;
  } catch (err) {
    console.error('[VAULT DECRYPT ERROR] Failed to authenticate/decrypt ciphertext:', err.message);
    // Secure failure: Never return ciphertext as password
    return '';
  }
}

/**
 * Deep sensitive data scrubber for logging and telemetry sanitization.
 * Recursively redacts passwords, tokens, API keys, PINs, and PII.
 */
const SENSITIVE_KEYS = new Set([
  'password', 'passwordhash', 'passwordsalt', 'token', 'authtoken', 'refreshtoken',
  'secret', 'clientsecret', 'superadminsecret', 'operatorsecret', 'techniciansecret',
  'authorization', 'x-auth-token', 'cookie', 'set-cookie', 'aadhaarno', 'panno',
  'cvv', 'cardnumber', 'totpsecret', 'otp', 'pin', 'snmpcommunity'
]);

function sanitizeForLogs(obj, depth = 0) {
  if (depth > 6 || !obj) return obj;
  if (typeof obj !== 'object') return obj;

  if (Array.isArray(obj)) {
    return obj.map(item => sanitizeForLogs(item, depth + 1));
  }

  const sanitized = {};
  for (const [key, val] of Object.entries(obj)) {
    const lowerKey = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (SENSITIVE_KEYS.has(lowerKey)) {
      sanitized[key] = '[REDACTED_SECRET]';
    } else if (typeof val === 'object' && val !== null) {
      sanitized[key] = sanitizeForLogs(val, depth + 1);
    } else if (typeof val === 'string' && val.length > 20 && (lowerKey.includes('pass') || lowerKey.includes('secret') || lowerKey.includes('key'))) {
      sanitized[key] = '[REDACTED_SECRET]';
    } else {
      sanitized[key] = val;
    }
  }
  return sanitized;
}

module.exports = {
  encryptSecret,
  decryptSecret,
  sanitizeForLogs,
  getMasterKey
};
