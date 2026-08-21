/**
 * TIER-069 BILLING & RADIUS SYNCHRONIZATION SERVICE (Issue 4)
 * Reliable Webhook Dispatcher with Exponential Backoff, Idempotency, and Audit Queue
 */

const https = require('https');
const http = require('http');
const crypto = require('crypto');
const db = require('../db/database');

const BILLING_WEBHOOK_URL = process.env.BILLING_WEBHOOK_URL || 'http://127.0.0.1:8080/api/billing/sync';
const BILLING_WEBHOOK_SECRET = process.env.BILLING_WEBHOOK_SECRET || 'ciniplay_radius_secret_2026';

/**
 * Computes cryptographic HMAC-SHA256 signature to prevent spoofing (Gap 6).
 */
function computeHmacSignature(dataStr, secret) {
  return crypto.createHmac('sha256', secret).update(dataStr).digest('hex');
}

/**
 * Dispatches authenticated HTTP request to external Billing / Radius Webhook.
 */
function sendWebhookRequest(urlStr, payload, headers = {}, timeoutMs = 4000) {
  return new Promise((resolve) => {
    try {
      const parsedUrl = new URL(urlStr);
      const isHttps = parsedUrl.protocol === 'https:';
      const client = isHttps ? https : http;

      const bodyData = JSON.stringify(payload);
      const timestamp = Date.now().toString();
      const signature = computeHmacSignature(`${timestamp}.${bodyData}`, BILLING_WEBHOOK_SECRET);

      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyData),
          'User-Agent': 'Tier069-Billing-Sync/2.0',
          'Authorization': `Bearer ${BILLING_WEBHOOK_SECRET}`,
          'X-Billing-Timestamp': timestamp,
          'X-Billing-Signature': `sha256=${signature}`,
          'X-Webhook-Secret': BILLING_WEBHOOK_SECRET,
          ...headers
        },
        timeout: timeoutMs
      };

      const req = client.request(options, (res) => {
        let respBody = '';
        res.on('data', chunk => respBody += chunk);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({
              success: true,
              statusCode: res.statusCode,
              body: respBody
            });
          } else {
            resolve({
              success: false,
              statusCode: res.statusCode,
              error: `HTTP ${res.statusCode}: ${respBody.substring(0, 100)}`
            });
          }
        });
      });

      req.on('timeout', () => {
        req.destroy();
        resolve({
          success: false,
          error: `Webhook timed out after ${timeoutMs}ms`
        });
      });

      req.on('error', (err) => {
        resolve({
          success: false,
          error: err.message
        });
      });

      req.write(bodyData);
      req.end();
    } catch (err) {
      resolve({
        success: false,
        error: `URL Parsing/Execution error: ${err.message}`
      });
    }
  });
}

/**
 * Triggers a reliable billing sync with 3 exponential backoff retries and persistence.
 */
async function syncBillingWanChange(deviceId, wanData, configVersion = 1) {
  const idempotencyKey = `sync_${deviceId}_v${configVersion}_${Date.now()}`;
  const payload = {
    idempotencyKey,
    deviceId,
    username: wanData.username,
    vlanId: wanData.vlanId,
    connectionType: wanData.connectionType || 'PPPoE',
    updatedAt: new Date().toISOString(),
    configVersion
  };

  // 1. Queue in local MongoDB billing_sync_queue table
  await db.queueBillingSync({
    idempotencyKey,
    deviceId,
    action: 'UPDATE_PPPOE_WAN',
    payload
  });

  // 2. Attempt dispatch with exponential backoff (3 attempts: 0ms -> 1000ms -> 3000ms)
  let attempt = 0;
  let success = false;
  let lastError = null;

  while (attempt < 3) {
    attempt++;
    const res = await sendWebhookRequest(BILLING_WEBHOOK_URL, payload, { 'X-Idempotency-Key': idempotencyKey });

    if (res.success) {
      success = true;
      break;
    }

    lastError = res.error;
    // Backoff delay
    if (attempt < 3) {
      await new Promise(r => setTimeout(r, attempt * 1000));
    }
  }

  // 3. Confirmation loop & state update
  if (success) {
    await db.updateBillingSyncRecord(idempotencyKey, {
      status: 'COMPLETED',
      attempts: attempt,
      syncedAt: new Date().toISOString()
    });

    // Mark device document billingSynced: true
    const dev = await db.getDevice(deviceId);
    if (dev) {
      if (!dev.wan) dev.wan = {};
      dev.wan.billingSynced = true;
      dev.wan.billingSyncedAt = new Date().toISOString();
      await db.saveDevice(dev);
    }

    await db.addLog({
      type: 'BILLING_SYNC_SUCCESS',
      deviceId,
      message: `Billing/Radius sync completed for [${wanData.username}] on attempt ${attempt}`
    });

    return { success: true, attempts: attempt, idempotencyKey };
  } else {
    // Flag for admin review
    await db.updateBillingSyncRecord(idempotencyKey, {
      status: 'FAILED',
      attempts: attempt,
      error: lastError,
      nextRetryAt: new Date(Date.now() + 5 * 60 * 1000).toISOString()
    });

    const dev = await db.getDevice(deviceId);
    if (dev) {
      if (!dev.wan) dev.wan = {};
      dev.wan.billingSynced = false;
      dev.wan.billingSyncError = lastError;
      await db.saveDevice(dev);
    }

    await db.addLog({
      type: 'BILLING_SYNC_FAILED',
      deviceId,
      message: `Billing/Radius sync failed for [${wanData.username}] after ${attempt} attempts: ${lastError}`
    });

    return { success: false, attempts: attempt, error: lastError, idempotencyKey };
  }
}

module.exports = {
  syncBillingWanChange,
  sendWebhookRequest
};
