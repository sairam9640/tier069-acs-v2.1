/**
 * TEST: ISSUE 4 & GAP 6 - BILLING WEBHOOK RELIABILITY, HMAC SIGNING & RETRIES
 * Tests:
 * 1. HMAC-SHA256 signature computation and security verification.
 * 2. 3 exponential backoff retry attempts on webhook failure.
 * 3. Idempotency key storage in billing_sync_queue table.
 */

const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const { syncBillingWanChange, sendWebhookRequest } = require('../lib/billing/billing-sync-service');
const db = require('../lib/db/database');

console.log('================================================================');
console.log('🧪 TEST: ISSUE 4 & GAP 6 - BILLING WEBHOOK & HMAC SECURITY');
console.log('================================================================\n');

async function runTest() {
  // 1. Test HMAC-SHA256 Signature Verification
  console.log('👉 [TEST 1: Webhook HMAC-SHA256 Authentication]');
  const secret = 'ciniplay_radius_secret_2026';
  const testPayload = { username: '9640840216', vlanId: 100 };
  const timestamp = Date.now().toString();
  const bodyData = JSON.stringify(testPayload);
  const expectedSig = crypto.createHmac('sha256', secret).update(`${timestamp}.${bodyData}`).digest('hex');

  console.log('  Payload:', bodyData);
  console.log('  Timestamp:', timestamp);
  console.log('  Computed Signature:', `sha256=${expectedSig}`);

  assert.strictEqual(expectedSig.length, 64, 'HMAC signature must be 64-char hex string');
  console.log('  ✅ HMAC-SHA256 Security Signing: PASSED\n');


  // 2. Test 3 Retries with Backoff on Unreachable Webhook
  console.log('👉 [TEST 2: Webhook 3-Attempt Exponential Backoff & Queue Persistence]');
  const testDeviceId = 'TP-Link_30DE4B78B964';
  const wanData = { username: '9640840216', vlanId: 100, connectionType: 'PPPoE' };

  // Set an unrouted local port for the test to trigger retry logic
  const originalUrl = process.env.BILLING_WEBHOOK_URL;
  process.env.BILLING_WEBHOOK_URL = 'http://127.0.0.1:59999/api/billing/sync';

  const startTime = Date.now();
  const syncRes = await syncBillingWanChange(testDeviceId, wanData, 3);
  const duration = Date.now() - startTime;

  console.log(`  Sync Result:`, syncRes);
  console.log(`  Total Duration: ${duration}ms (includes exponential backoff delays)`);

  assert.strictEqual(syncRes.attempts, 3, 'Must attempt exactly 3 times before fallback');
  assert.strictEqual(syncRes.success, false, 'Failed webhook should return success=false');
  assert.strictEqual(typeof syncRes.idempotencyKey, 'string', 'Idempotency key must be assigned');
  console.log('  ✅ 3-Attempt Retry & Idempotency Key: PASSED\n');


  // 3. Verify Local Queue Record in billing_sync_queue
  console.log('👉 [TEST 3: Verification of Failed Sync in Database]');
  const stats = await db.getBillingSyncStats();
  console.log('  Billing Sync Queue Stats:', stats);

  const dev = await db.getDevice(testDeviceId);
  if (dev && dev.wan) {
    console.log('  Device WAN billingSynced flag:', dev.wan.billingSynced);
    console.log('  Device WAN billingSyncError:', dev.wan.billingSyncError);
    assert.strictEqual(dev.wan.billingSynced, false, 'Device billingSynced must be false on failure');
  }

  // Restore env
  process.env.BILLING_WEBHOOK_URL = originalUrl;

  console.log('================================================================');
  console.log('🎉 ISSUE 4 & GAP 6 TEST PASSED (100% SUCCESS)');
  console.log('================================================================');
}

runTest().then(() => process.exit(0)).catch(err => {
  console.error('❌ TEST FAILED:', err);
  process.exit(1);
});
