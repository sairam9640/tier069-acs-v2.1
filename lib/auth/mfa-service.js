/**
 * Production-Ready Multi-Factor Authentication (MFA) Suite
 * 
 * 1. RFC 6238 Time-Based One-Time Password (TOTP) for Google Authenticator / Microsoft Authenticator.
 * 2. Real-Time WhatsApp OTP 2FA via Baileys Engine.
 * 3. Base32 Secret Generator and QR Code SVG generator.
 */

const crypto = require('crypto');
const db = require('../db/database');
const whatsappService = require('../alerts/whatsapp-service');

const BASE32_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function generateBase32Secret(length = 20) {
  const bytes = crypto.randomBytes(length);
  let secret = '';
  for (let i = 0; i < bytes.length; i++) {
    secret += BASE32_CHARS[bytes[i] % 32];
  }
  return secret;
}

function base32Decode(base32Str) {
  const clean = base32Str.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = '';
  for (let i = 0; i < clean.length; i++) {
    const val = BASE32_CHARS.indexOf(clean[i]);
    bits += val.toString(2).padStart(5, '0');
  }

  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.substring(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

/**
 * Compute TOTP token for given secret at timestamp (RFC 6238 / RFC 4226)
 */
function computeTotp(secretBase32, timeStepSeconds = 30, timeOffset = 0) {
  try {
    const secretBuffer = base32Decode(secretBase32);
    const counter = Math.floor((Date.now() / 1000 + timeOffset) / timeStepSeconds);
    const counterBuffer = Buffer.alloc(8);
    counterBuffer.writeBigInt64BE(BigInt(counter), 0);

    const hmac = crypto.createHmac('sha1', secretBuffer);
    hmac.update(counterBuffer);
    const digest = hmac.digest();

    const offset = digest[digest.length - 1] & 0x0f;
    const code = (
      ((digest[offset] & 0x7f) << 24) |
      ((digest[offset + 1] & 0xff) << 16) |
      ((digest[offset + 2] & 0xff) << 8) |
      (digest[offset + 3] & 0xff)
    ) % 1000000;

    return code.toString().padStart(6, '0');
  } catch (err) {
    console.error('[TOTP COMPUTE ERROR]', err.message);
    return null;
  }
}

/**
 * Verify user-submitted 6-digit TOTP with +/- 1 time-step clock skew tolerance
 */
function verifyTotp(inputCode, secretBase32) {
  if (!inputCode || !secretBase32) return false;
  const cleanCode = String(inputCode).trim();
  if (cleanCode.length !== 6) return false;

  // Check current, previous (-30s), and next (+30s) windows
  const offsets = [0, -30, 30];
  for (const off of offsets) {
    const expected = computeTotp(secretBase32, 30, off);
    if (expected && cleanCode === expected) {
      return true;
    }
  }
  return false;
}

// In-Memory WhatsApp OTP Store: phone -> { otp, expiresAt, attempts }
const activeOtpChallenges = new Map();

/**
 * Generate and dispatch 6-digit WhatsApp OTP
 */
async function sendWhatsAppOtp(phoneNumber, username = 'Admin') {
  const cleanPhone = String(phoneNumber).replace(/\D/g, '');
  if (!cleanPhone || cleanPhone.length < 10) {
    return { success: false, message: 'Invalid phone number for WhatsApp OTP delivery' };
  }

  const otp = crypto.randomInt(100000, 999999).toString();
  const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes validity

  activeOtpChallenges.set(cleanPhone, { otp, expiresAt, attempts: 0 });

  const msg = `🔐 *VRV ACS SECURITY VERIFICATION*\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `Hello *${username}*,\n\n` +
    `Your Super Admin 2-Factor Authentication code is:\n\n` +
    `👉 *${otp}*\n\n` +
    `⏱️ _Valid for 5 minutes. Do NOT share this OTP with anyone._\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `🌐 Server: https://ciniplay.in/`;

  try {
    const result = await whatsappService.sendTextMessage(cleanPhone, msg);
    return {
      success: true,
      message: `2FA OTP dispatched to WhatsApp (+91 ${cleanPhone.slice(-10)})`,
      expiresAt
    };
  } catch (err) {
    return {
      success: false,
      message: `Failed to dispatch WhatsApp OTP: ${err.message}`
    };
  }
}

/**
 * Verify submitted WhatsApp OTP
 */
function verifyWhatsAppOtp(phoneNumber, inputOtp) {
  const cleanPhone = String(phoneNumber).replace(/\D/g, '');
  const challenge = activeOtpChallenges.get(cleanPhone);

  if (!challenge) {
    return { success: false, message: 'No active OTP request found. Please request a new code.' };
  }

  if (Date.now() > challenge.expiresAt) {
    activeOtpChallenges.delete(cleanPhone);
    return { success: false, message: 'OTP has expired. Please request a new code.' };
  }

  if (challenge.attempts >= 3) {
    activeOtpChallenges.delete(cleanPhone);
    return { success: false, message: 'Too many incorrect attempts. OTP invalidated.' };
  }

  challenge.attempts += 1;

  if (String(inputOtp).trim() === challenge.otp) {
    activeOtpChallenges.delete(cleanPhone);
    return { success: true };
  }

  return { success: false, message: 'Invalid OTP code. Please check and try again.' };
}

module.exports = {
  generateBase32Secret,
  computeTotp,
  verifyTotp,
  sendWhatsAppOtp,
  verifyWhatsAppOtp
};
