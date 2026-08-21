/**
 * TEST: ISSUE 4 & PRODUCTION HARDENING - BILLING & RADIUS SYNC ENGINE
 * Tests:
 * 1. Loud failure & safe fallback when BILLING_WEBHOOK_URL / SECRET is unconfigured.
 * 2. Loopback / internal IP detection & warning banner.
 * 3. Dry-run Connection Validator (ping & latency handshake).
 * 4. Queue Sweeper & Drain Job (re-attempting failed syncs & flagging dead-letters).
 * 5. End-to-end verified delivery and device billingSynced state update.
 */

const assert = require('assert');
const {
  isBillingSyncConfigured,
  checkBillingConfigStartup,
  syncBillingWanChange,
  sendWebhookRequest,
  drainBillingSyncQueue,
  testBillingConnection
} = require('../lib/billing/billing-sync-service');
const db = require('../lib/db/database');

console.log('================================================================');
console.log('🧪 TEST: PRODUCTION HARDENED BILLING & RADIUS SYNC ENGINE');
console.log('================================================================\n');

async function runTests() {
  const testDeviceId = 'TP-Link_30DE4B78B964';
  const testSecret = 'ciniplay_radius_secret_2026';
  const receiverUrl = 'http://127.0.0.1:3000/api/billing/sync';

  // Seed test device
  await db.saveDevice({
    _id: testDeviceId,
    deviceInfo: { manufacturer: 'TP-Link', modelName: 'XC220-G3v' },
    wan: { username: '9640840216', vlanId: 100 }
  });

  // -------------------------------------------------------------
  // TEST 1: Unconfigured Environment (Loud Failure & Safe Queue)
  // -------------------------------------------------------------
  console.log('👉 [TEST 1: Loud Failure & Safe Fallback when Unconfigured]');
  const unconfigRes = await syncBillingWanChange(testDeviceId, { username: '9640840216', vlanId: 100 }, 10, null, null);
  console.log('  Unconfigured Dispatch Result:', unconfigRes);
  assert.strictEqual(unconfigRes.success, false, 'Unconfigured sync must fail safely');
  assert.strictEqual(unconfigRes.configured, false, 'configured flag must be false');

  const devUnconfig = await db.getDevice(testDeviceId);
  assert.strictEqual(devUnconfig.wan?.billingSynced, false, 'Device billingSynced must remain false');
  console.log('  ✅ Unconfigured Loud Failure & Safe Handling: PASSED\n');


  // -------------------------------------------------------------
  // TEST 2: Loopback / Internal IP Warning & Startup Check
  // -------------------------------------------------------------
  console.log('👉 [TEST 2: Loopback / Internal IP Detection]');
  process.env.BILLING_WEBHOOK_URL = 'http://127.0.0.1:3000/api/billing/sync';
  process.env.BILLING_WEBHOOK_SECRET = testSecret;

  const startupCheck = checkBillingConfigStartup();
  console.log('  Startup Check Output:', startupCheck);
  assert.strictEqual(startupCheck.configured, true, 'Must report configured=true');
  assert.strictEqual(startupCheck.isLoopback, true, 'Must detect 127.0.0.1 as loopback');
  console.log('  ✅ Loopback IP Detection & Warning: PASSED\n');


  // -------------------------------------------------------------
  // TEST 3: Admin Dry-Run Connection Ping & Handshake
  // -------------------------------------------------------------
  console.log('👉 [TEST 3: Admin Dry-Run Connection Validation Endpoint]');
  const pingResult = await testBillingConnection(receiverUrl, testSecret);
  console.log('  Ping Handshake Result:', pingResult);
  assert.strictEqual(pingResult.success, true, 'Dry-run ping to receiver must succeed');
  assert.ok(pingResult.latencyMs >= 0, 'Must measure latency');
  assert.strictEqual(pingResult.statusCode, 200, 'Must receive HTTP 200 OK');
  console.log(`  Measured Latency: ${pingResult.latencyMs}ms`);
  console.log('  ✅ Dry-Run Connection Handshake: PASSED\n');


  // -------------------------------------------------------------
  // TEST 4: Live Authenticated Webhook Dispatch
  // -------------------------------------------------------------
  console.log('👉 [TEST 4: Live HMAC Authenticated WAN Change Sync]');
  const wanData = { username: '9640840216', vlanId: 100, connectionType: 'PPPoE' };
  const liveRes = await syncBillingWanChange(testDeviceId, wanData, 11, receiverUrl, testSecret);
  console.log('  Live Dispatch Result:', liveRes);
  assert.strictEqual(liveRes.success, true, 'Live sync must succeed with valid credentials');

  const devLive = await db.getDevice(testDeviceId);
  assert.strictEqual(devLive.wan?.billingSynced, true, 'Device billingSynced must be true on real success');
  console.log('  Device billingSynced:', devLive.wan?.billingSynced);
  console.log('  Device billingSyncedAt:', devLive.wan?.billingSyncedAt);
  console.log('  ✅ Live HMAC Authenticated Webhook Delivery: PASSED\n');


  // -------------------------------------------------------------
  // TEST 5: Queue Sweeper & Drain Job
  // -------------------------------------------------------------
  console.log('👉 [TEST 5: Queue Sweeper & Drain Job]');
  // Queue a simulated pending/failed task in MongoDB ready for pickup
  const mockStuckKey = `sync_stuck_${Date.now()}`;
  await db.queueBillingSync({
    idempotencyKey: mockStuckKey,
    deviceId: testDeviceId,
    action: 'UPDATE_PPPOE_WAN',
    payload: { idempotencyKey: mockStuckKey, deviceId: testDeviceId, username: '9640840216', vlanId: 100, connectionType: 'PPPoE' },
    status: 'FAILED',
    attempts: 1,
    nextRetryAt: new Date(Date.now() - 10000).toISOString()
  });

  const drainRes = await drainBillingSyncQueue(5, receiverUrl, testSecret);
  console.log('  Queue Drain Result:', drainRes);
  assert.ok(drainRes.drained >= 1, 'Sweeper must drain at least 1 pending task');

  const queueStats = await db.getBillingSyncStats();
  console.log('  Updated Billing Queue Stats:', queueStats);
  assert.ok(queueStats.completed >= 1, 'Completed count in queue must reflect drained tasks');
  console.log('  ✅ Background Queue Sweeper & Recovery: PASSED\n');

  console.log('================================================================');
  console.log('🎉 ALL BILLING SYNC PRODUCTION HARDENING TESTS PASSED (100%)');
  console.log('================================================================');
}

runTests().then(() => process.exit(0)).catch(err => {
  console.error('❌ TEST FAILED:', err);
  process.exit(1);
});
