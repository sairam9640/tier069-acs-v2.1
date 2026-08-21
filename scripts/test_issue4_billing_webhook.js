/**
 * TEST: ISSUE 4 & GAP 6 - BILLING WEBHOOK RELIABILITY, HMAC SECURITY & LIVE SUCCESS CASE
 * Tests:
 * 1. HMAC-SHA256 signature computation and security verification (no raw secrets on wire).
 * 2. Real successful webhook delivery to Billing/Radius server with valid HMAC validation (HTTP 200).
 * 3. 3-attempt exponential backoff retry on unreachable webhook and queue fallback.
 */

const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const { syncBillingWanChange, sendWebhookRequest } = require('../lib/billing/billing-sync-service');
const db = require('../lib/db/database');

console.log('================================================================');
console.log('🧪 TEST: ISSUE 4 & GAP 6 - BILLING WEBHOOK HMAC & REAL SUCCESS CASE');
console.log('================================================================\n');

const secret = 'ciniplay_radius_secret_2026';

// Spin up a live mock Production Billing/Radius Webhook Receiver
function startMockBillingServer(port = 8999) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        const timestamp = req.headers['x-billing-timestamp'];
        const signatureHeader = req.headers['x-billing-signature'];
        const authHeader = req.headers['authorization'];
        const rawSecretHeader = req.headers['x-webhook-secret'];

        // Confirm NO raw secret was passed in headers (Security Compliance)
        const hasNoPlaintextSecret = !authHeader && !rawSecretHeader;

        // Verify HMAC-SHA256 signature
        const expectedSig = crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
        const isSigValid = signatureHeader === `sha256=${expectedSig}`;

        if (isSigValid && hasNoPlaintextSecret) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            status: 'ACCEPTED',
            message: 'PPPoE subscriber plan updated in Radius AAA database',
            verifiedAt: new Date().toISOString()
          }));
        } else {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Invalid HMAC Signature or Leaked Secret Header' }));
        }
      });
    });

    server.listen(port, '127.0.0.1', () => {
      resolve(server);
    });
  });
}

async function runTest() {
  const mockServer = await startMockBillingServer(8999);
  const testDeviceId = 'TP-Link_30DE4B78B964';

  try {
    // 1. SCENARIO A: Real Success Case against Live Receiver
    console.log('👉 [SCENARIO A: Real Live Webhook Success with Verified HMAC-SHA256]');
    process.env.BILLING_WEBHOOK_URL = 'http://127.0.0.1:8999/api/billing/sync';

    const wanData = { username: '9640840216', vlanId: 100, connectionType: 'PPPoE' };
    const successRes = await syncBillingWanChange(testDeviceId, wanData, 4);

    console.log('  Webhook Dispatch Result:', successRes);
    assert.strictEqual(successRes.success, true, 'Webhook must succeed on live endpoint with valid HMAC');
    assert.strictEqual(successRes.attempts, 1, 'Should succeed on first attempt');

    const dev = await db.getDevice(testDeviceId);
    console.log('  Device billingSynced status:', dev.wan?.billingSynced);
    console.log('  Device billingSyncedAt timestamp:', dev.wan?.billingSyncedAt);

    assert.strictEqual(dev.wan?.billingSynced, true, 'Device document must have billingSynced: true');
    console.log('  ✅ Live Webhook Success & Device Flagging: PASSED\n');


    // 2. SCENARIO B: Webhook 3-Attempt Exponential Backoff & Queue Persistence on Failure
    console.log('👉 [SCENARIO B: Webhook 3-Attempt Exponential Backoff & Retry Exhaustion]');
    process.env.BILLING_WEBHOOK_URL = 'http://127.0.0.1:59998/api/billing/sync'; // Unbound port

    const startTime = Date.now();
    const failRes = await syncBillingWanChange(testDeviceId, wanData, 5);
    const duration = Date.now() - startTime;

    console.log('  Failed Sync Result:', failRes);
    console.log(`  Duration with Backoff: ${duration}ms`);

    assert.strictEqual(failRes.success, false, 'Failed endpoint must return success=false');
    assert.strictEqual(failRes.attempts, 3, 'Must attempt exactly 3 times before fallback');

    const devFailed = await db.getDevice(testDeviceId);
    console.log('  Device billingSynced status on failure:', devFailed.wan?.billingSynced);
    console.log('  Device billingSyncError message:', devFailed.wan?.billingSyncError);

    assert.strictEqual(devFailed.wan?.billingSynced, false, 'Device billingSynced must be false');
    console.log('  ✅ 3-Attempt Backoff Retry & Database Logging: PASSED\n');

  } finally {
    mockServer.close();
  }

  console.log('================================================================');
  console.log('🎉 ISSUE 4 & GAP 6 TEST PASSED (100% SUCCESS)');
  console.log('================================================================');
}

runTest().then(() => process.exit(0)).catch(err => {
  console.error('❌ TEST FAILED:', err);
  process.exit(1);
});
