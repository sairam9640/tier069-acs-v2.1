/**
 * =======================================================================================
 * TIER-069 BILLING & RADIUS SYNCHRONIZATION SERVICE (Issue 4 & Production Hardening)
 * =======================================================================================
 *
 * 🔐 CURRENT AUTHENTICATION SPECIFICATION (Adaptable for External Radius / CRM Engines):
 * ---------------------------------------------------------------------------------------
 *  • Method: Cryptographic HMAC-SHA256 Signature (Zero plaintext secrets on wire).
 *  • Headers Dispatched:
 *      - X-Billing-Timestamp: <UNIX timestamp string in milliseconds, e.g. "1787313545115">
 *      - X-Billing-Signature: sha256=<HMAC_SHA256_HEX_DIGEST>
 *          Signature Formula: HMAC-SHA256("${timestamp}.${JSON.stringify(payload)}", BILLING_WEBHOOK_SECRET)
 *      - X-Idempotency-Key:   sync_${deviceId}_v${configVersion}_${timestamp}
 *      - Content-Type:        application/json
 *      - User-Agent:          Tier069-Billing-Sync/2.1
 *
 *  • Payload JSON Structure:
 *      {
 *        "idempotencyKey": "sync_TP-Link_30DE4B78B964_v6_1787313545115",
 *        "deviceId": "TP-Link_30DE4B78B964",
 *        "username": "9640840216",
 *        "vlanId": 100,
 *        "connectionType": "PPPoE",
 *        "updatedAt": "2026-08-21T12:00:00.000Z",
 *        "configVersion": 6
 *      }
 *
 *  • HOW TO ADAPT FOR OTHER EXTERNAL BILLING ENGINES:
 *      1. Bearer Token (e.g., Splynx / Custom REST API):
 *         Change options.headers to include 'Authorization': `Bearer ${process.env.BILLING_API_TOKEN}`.
 *      2. Basic Auth (e.g., FreeRADIUS REST / Alepo):
 *         Add 'Authorization': 'Basic ' + Buffer.from(USER + ':' + PASS).toString('base64').
 *      3. Custom API Key:
 *         Add 'X-API-Key': process.env.BILLING_API_KEY.
 * =======================================================================================
 */

const https = require('https');
const http = require('http');
const crypto = require('crypto');
const db = require('../db/database');

function getBillingConfig() {
  const url = process.env.BILLING_WEBHOOK_URL ? process.env.BILLING_WEBHOOK_URL.trim() : null;
  const secret = process.env.BILLING_WEBHOOK_SECRET ? process.env.BILLING_WEBHOOK_SECRET.trim() : null;
  return { url, secret };
}

/**
 * Checks if external billing sync is configured in the environment.
 */
function isBillingSyncConfigured() {
  const { url, secret } = getBillingConfig();
  return Boolean(url && secret);
}

/**
 * Startup health and configuration validator (Fails loudly / Warns on loopback).
 */
function checkBillingConfigStartup(customUrl = null, customSecret = null) {
  const cfg = getBillingConfig();
  const activeUrl = customUrl || cfg.url;
  const activeSecret = customSecret || cfg.secret;

  if (!activeUrl || !activeSecret) {
    console.warn('⚠️  [FATAL CONFIG: BILLING_WEBHOOK_URL or BILLING_WEBHOOK_SECRET NOT CONFIGURED]');
    console.warn('   External Billing & Radius synchronization is DISABLED.');
    console.warn('   To enable, set BILLING_WEBHOOK_URL and BILLING_WEBHOOK_SECRET in /opt/tr069-acs/.env.');
    return { configured: false, warning: 'Unconfigured in .env' };
  }

  const urlLower = activeUrl.toLowerCase();
  const isLoopback = (
    urlLower.includes('localhost') ||
    urlLower.includes('127.0.0.1') ||
    urlLower.includes('10.') ||
    urlLower.includes('192.168.') ||
    urlLower.includes('172.16.')
  );

  if (isLoopback) {
    console.warn(`⚠️  [WARNING: BILLING_WEBHOOK_URL (${activeUrl}) IS POINTING TO LOOPBACK / INTERNAL IP]`);
    console.warn('   This is an internal test address, not an external production billing platform.');
    return { configured: true, isLoopback: true, url: activeUrl };
  }

  console.log(`✅ [BILLING SYNC ENGINE ACTIVE] Outbound Target: ${activeUrl}`);
  return { configured: true, isLoopback: false, url: activeUrl };
}

// Run startup check immediately
checkBillingConfigStartup();

/**
 * Computes cryptographic HMAC-SHA256 signature to prevent spoofing.
 */
function computeHmacSignature(dataStr, secret) {
  if (!secret) return '';
  return crypto.createHmac('sha256', secret).update(dataStr).digest('hex');
}

/**
 * Dispatches authenticated HTTP request to external Billing / Radius Webhook.
 */
function sendWebhookRequest(urlStr, payload, headers = {}, timeoutMs = 5000, secretOverride = null) {
  return new Promise((resolve) => {
    const activeSecret = secretOverride || BILLING_WEBHOOK_SECRET;
    if (!urlStr || !activeSecret) {
      return resolve({
        success: false,
        error: 'BILLING_WEBHOOK_URL or BILLING_WEBHOOK_SECRET not configured'
      });
    }

    try {
      const parsedUrl = new URL(urlStr);
      const isHttps = parsedUrl.protocol === 'https:';
      const client = isHttps ? https : http;

      const bodyData = JSON.stringify(payload);
      const timestamp = Date.now().toString();
      const signature = computeHmacSignature(`${timestamp}.${bodyData}`, activeSecret);

      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyData),
          'User-Agent': 'Tier069-Billing-Sync/2.1',
          'X-Billing-Timestamp': timestamp,
          'X-Billing-Signature': `sha256=${signature}`,
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
              error: `HTTP ${res.statusCode}: ${respBody.substring(0, 150)}`
            });
          }
        });
      });

      req.on('timeout', () => {
        req.destroy();
        resolve({
          success: false,
          error: `Webhook connection timed out after ${timeoutMs}ms`
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
        error: `URL Parsing error: ${err.message}`
      });
    }
  });
}

/**
 * Dispatches WAN configuration change to external billing engine with retries and persistence.
 */
async function syncBillingWanChange(deviceId, wanData, configVersion = 1, customWebhookUrl = null, customSecret = null) {
  const cfg = getBillingConfig();
  const targetUrl = customWebhookUrl || cfg.url;
  const targetSecret = customSecret || cfg.secret;
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

  // Check configuration availability
  if (!targetUrl || !targetSecret) {
    const unconfigMsg = 'Billing webhook unconfigured: set BILLING_WEBHOOK_URL and BILLING_WEBHOOK_SECRET in .env';
    await db.queueBillingSync({
      idempotencyKey,
      deviceId,
      action: 'UPDATE_PPPOE_WAN',
      payload,
      status: 'UNCONFIGURED',
      error: unconfigMsg
    });

    const dev = await db.getDevice(deviceId);
    if (dev) {
      if (!dev.wan) dev.wan = {};
      dev.wan.billingSynced = false;
      dev.wan.billingSyncError = unconfigMsg;
      await db.saveDevice(dev);
    }

    await db.addLog({
      type: 'BILLING_SYNC_SKIPPED',
      deviceId,
      message: `Billing/Radius sync skipped for [${wanData.username}]: ${unconfigMsg}`
    });

    return { success: false, configured: false, error: unconfigMsg, idempotencyKey };
  }

  // 1. Queue in local MongoDB billing_sync_queue table
  await db.queueBillingSync({
    idempotencyKey,
    deviceId,
    action: 'UPDATE_PPPOE_WAN',
    payload,
    status: 'PENDING'
  });

  // 2. Attempt dispatch with exponential backoff (3 attempts: 0ms -> 1000ms -> 3000ms)
  let attempt = 0;
  let success = false;
  let lastError = null;

  while (attempt < 3) {
    attempt++;
    const res = await sendWebhookRequest(targetUrl, payload, { 'X-Idempotency-Key': idempotencyKey }, 4000, targetSecret);

    if (res.success) {
      success = true;
      break;
    }

    lastError = res.error;
    if (attempt < 3) {
      await new Promise(r => setTimeout(r, attempt * 1000));
    }
  }

  // 3. Confirmation and State Persistence
  if (success) {
    await db.updateBillingSyncRecord(idempotencyKey, {
      status: 'COMPLETED',
      attempts: attempt,
      syncedAt: new Date().toISOString(),
      error: null
    });

    const dev = await db.getDevice(deviceId);
    if (dev) {
      if (!dev.wan) dev.wan = {};
      dev.wan.billingSynced = true;
      dev.wan.billingSyncedAt = new Date().toISOString();
      dev.wan.billingSyncError = null;
      await db.saveDevice(dev);
    }

    await db.addLog({
      type: 'BILLING_SYNC_SUCCESS',
      deviceId,
      message: `Billing/Radius sync completed for [${wanData.username}] on attempt ${attempt}`
    });

    return { success: true, attempts: attempt, idempotencyKey };
  } else {
    await db.updateBillingSyncRecord(idempotencyKey, {
      status: 'FAILED',
      attempts: attempt,
      error: lastError,
      nextRetryAt: new Date(Date.now() + 3 * 60 * 1000).toISOString()
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

/**
 * Background Queue Sweeper / Drain Job (Runs periodically to recover failed syncs)
 */
async function drainBillingSyncQueue(maxRetries = 8, customUrl = null, customSecret = null) {
  const cfg = getBillingConfig();
  const activeUrl = customUrl || cfg.url;
  const activeSecret = customSecret || cfg.secret;

  if (!activeUrl || !activeSecret) {
    return { drained: 0, skipped: 'Billing webhook unconfigured' };
  }

  const pendingItems = await db.getPendingBillingSyncs(25);
  if (!pendingItems || pendingItems.length === 0) return { drained: 0, pending: 0 };

  let drainedCount = 0;
  const nowTs = Date.now();

  for (const item of pendingItems) {
    const attempts = item.attempts || 0;
    const createdAt = new Date(item.createdAt).getTime();
    const isExpired = (nowTs - createdAt) > (24 * 60 * 60 * 1000); // 24-hour limit

    if (attempts >= maxRetries || isExpired) {
      // Flag as DEAD_LETTER for manual review in NOC dashboard
      await db.updateBillingSyncRecord(item.idempotencyKey, {
        status: 'NEEDS_MANUAL_REVIEW',
        error: `Exceeded max retry cap (${attempts}/${maxRetries}) or 24h expiration`
      });
      await db.addLog({
        type: 'BILLING_QUEUE_EXHAUSTED',
        deviceId: item.deviceId,
        message: `Billing sync task ${item.idempotencyKey} exceeded retries. Flagged for manual NOC review.`
      });
      continue;
    }

    // Re-attempt delivery
    const res = await sendWebhookRequest(activeUrl, item.payload, { 'X-Idempotency-Key': item.idempotencyKey }, 5000, activeSecret);
    if (res.success) {
      drainedCount++;
      await db.updateBillingSyncRecord(item.idempotencyKey, {
        status: 'COMPLETED',
        attempts: attempts + 1,
        syncedAt: new Date().toISOString(),
        error: null
      });

      const dev = await db.getDevice(item.deviceId);
      if (dev) {
        if (!dev.wan) dev.wan = {};
        dev.wan.billingSynced = true;
        dev.wan.billingSyncedAt = new Date().toISOString();
        dev.wan.billingSyncError = null;
        await db.saveDevice(dev);
      }

      await db.addLog({
        type: 'BILLING_QUEUE_DRAINED',
        deviceId: item.deviceId,
        message: `Successfully recovered and delivered billing sync task ${item.idempotencyKey} to billing engine.`
      });
    } else {
      await db.updateBillingSyncRecord(item.idempotencyKey, {
        status: 'FAILED',
        attempts: attempts + 1,
        error: res.error,
        nextRetryAt: new Date(Date.now() + Math.min(30 * 60 * 1000, (attempts + 1) * 3 * 60 * 1000)).toISOString()
      });
    }
  }

  return { drained: drainedCount, processed: pendingItems.length };
}

/**
 * Dry-run Connection Validator for Admin Testing (Ping & Handshake).
 */
async function testBillingConnection(targetUrl = null, secret = null) {
  const cfg = getBillingConfig();
  const urlToTest = targetUrl || cfg.url;
  const secretToTest = secret || cfg.secret;

  if (!urlToTest || !secretToTest) {
    return {
      success: false,
      configured: false,
      error: 'BILLING_WEBHOOK_URL or BILLING_WEBHOOK_SECRET is not configured in .env'
    };
  }

  const urlLower = urlToTest.toLowerCase();
  const isLoopback = (
    urlLower.includes('localhost') ||
    urlLower.includes('127.0.0.1') ||
    urlLower.includes('10.') ||
    urlLower.includes('192.168.') ||
    urlLower.includes('172.16.')
  );

  const pingPayload = {
    type: 'HEALTH_CHECK_PING',
    source: 'Tier069-ACS-Admin',
    timestamp: Date.now()
  };

  const startTime = Date.now();
  const res = await sendWebhookRequest(urlToTest, pingPayload, { 'X-Ping-Check': 'true' }, 5000, secretToTest);
  const latencyMs = Date.now() - startTime;

  return {
    success: res.success,
    configured: true,
    targetUrl: urlToTest,
    isLoopback,
    latencyMs,
    statusCode: res.statusCode || null,
    responseBody: res.body ? res.body.substring(0, 200) : null,
    error: res.error || null
  };
}

module.exports = {
  isBillingSyncConfigured,
  checkBillingConfigStartup,
  syncBillingWanChange,
  sendWebhookRequest,
  drainBillingSyncQueue,
  testBillingConnection
};
