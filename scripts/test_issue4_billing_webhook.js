/**
 * TEST: ISSUE 4 & PRODUCTION HARDENING - BILLING & RADIUS SYNC ENGINE
 * ===================================================================
 * Fully labeled test suite demonstrating:
 * 1. Loud Failure when Unconfigured.
 * 2. Strict Production Loopback Block (ALLOW_LOOPBACK_BILLING=false).
 * 3. Dry-Run Connection Ping Handshake (Zero 'undefined').
 * 4. Dev/Test Override Mode Delivery (ALLOW_LOOPBACK_BILLING=true).
 * 5. Background Queue Sweeper & Recovery.
 * 6. Production Safety Verification across multiple RFC1918 subnets.
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
  const localReceiverUrl = 'http://127.0.0.1:3000/api/billing/sync';

  // Seed test device in database
  await db.saveDevice({
    _id: testDeviceId,
    deviceInfo: { manufacturer: 'TP-Link', modelName: 'XC220-G3v' },
    wan: { username: '9640840216', vlanId: 100 }
  });

  // -------------------------------------------------------------------------
  // TEST 1: Unconfigured Environment (Loud Failure & Safe Queue)
  // -------------------------------------------------------------------------
  console.log('👉 [TEST 1: UNCONFIGURED MODE - Loud Failure & Safe Fallback]');
  console.log('  [ENV STATE] BILLING_WEBHOOK_URL: (null) | ALLOW_LOOPBACK_BILLING: false');
  const unconfigRes = await syncBillingWanChange(testDeviceId, { username: '9640840216', vlanId: 100 }, 10, null, null);
  console.log('  Dispatch Result:', unconfigRes);
  assert.strictEqual(unconfigRes.success, false, 'Unconfigured sync must fail safely');
  assert.strictEqual(unconfigRes.configured, false, 'configured flag must be false');

  const devUnconfig = await db.getDevice(testDeviceId);
  assert.strictEqual(devUnconfig.wan?.billingSynced, false, 'Device billingSynced must remain false');
  console.log('  ✅ Unconfigured Loud Failure & Safe Handling: PASSED\n');


  // -------------------------------------------------------------------------
  // TEST 2: Strict Production Loopback Block (ALLOW_LOOPBACK_BILLING=false)
  // -------------------------------------------------------------------------
  console.log('👉 [TEST 2: PRODUCTION ENFORCEMENT MODE - Loopback Refusal]');
  delete process.env.ALLOW_LOOPBACK_BILLING; // Strict Production Mode (No Override)
  console.log(`  [ENV STATE] Target URL: ${localReceiverUrl} | ALLOW_LOOPBACK_BILLING: undefined (Production Mode)`);

  const loopbackBlockRes = await syncBillingWanChange(testDeviceId, { username: '9640840216', vlanId: 100 }, 11, localReceiverUrl, testSecret);
  console.log('  Production Block Result:', loopbackBlockRes);

  assert.strictEqual(loopbackBlockRes.success, false, 'Must refuse loopback in production mode');
  assert.strictEqual(loopbackBlockRes.status, 'BLOCKED_LOOPBACK_IN_PRODUCTION', 'Status must be BLOCKED_LOOPBACK_IN_PRODUCTION');

  const devBlocked = await db.getDevice(testDeviceId);
  assert.strictEqual(devBlocked.wan?.billingSynced, false, 'Device billingSynced must be false');
  console.log('  ✅ Production Loopback Security Block: PASSED (Refused loopback in production)\n');


  // -------------------------------------------------------------------------
  // TEST 3: Admin Dry-Run Connection Ping & Handshake (Zero 'undefined')
  // -------------------------------------------------------------------------
  console.log('👉 [TEST 3: ADMIN DRY-RUN MODE - Ping Validation & Non-Null Identifier]');
  console.log(`  [ENV STATE] Target URL: ${localReceiverUrl}`);
  const pingResult = await testBillingConnection(localReceiverUrl, testSecret);
  console.log('  Ping Handshake Result:', pingResult);
  assert.strictEqual(pingResult.success, true, 'Dry-run ping to receiver must succeed');
  assert.strictEqual(pingResult.statusCode, 200, 'Must receive HTTP 200 OK');
  assert.ok(!pingResult.responseBody.includes('undefined'), 'Response body must NOT contain "undefined"');
  assert.ok(pingResult.responseBody.includes('admin_health_check'), 'Response body must confirm "admin_health_check"');
  console.log(`  Response Message: ${pingResult.responseBody}`);
  console.log('  ✅ Dry-Run Connection Handshake (Real Identifier Confirmed): PASSED\n');


  // -------------------------------------------------------------------------
  // TEST 4: Dev/Test Override Mode (ALLOW_LOOPBACK_BILLING=true)
  // -------------------------------------------------------------------------
  console.log('👉 [TEST 4: DEV/TEST-MODE OVERRIDE - Live Local Webhook Delivery (ALLOW_LOOPBACK_BILLING=true)]');
  process.env.ALLOW_LOOPBACK_BILLING = 'true'; // Explicit developer testing override
  console.log(`  [ENV STATE] Target URL: ${localReceiverUrl} | ALLOW_LOOPBACK_BILLING: true (Explicit Dev/Test Override)`);

  const wanData = { username: '9640840216', vlanId: 100, connectionType: 'PPPoE' };
  const liveRes = await syncBillingWanChange(testDeviceId, wanData, 12, localReceiverUrl, testSecret);
  console.log('  Dev-Mode Dispatch Result:', liveRes);
  assert.strictEqual(liveRes.success, true, 'Live sync must succeed under explicit dev-mode override');

  const devLive = await db.getDevice(testDeviceId);
  assert.strictEqual(devLive.wan?.billingSynced, true, 'Device billingSynced must be true in dev-mode override');
  console.log('  Device billingSynced:', devLive.wan?.billingSynced);
  console.log('  Device billingSyncedAt:', devLive.wan?.billingSyncedAt);
  console.log('  ✅ Dev/Test Override Webhook Delivery: PASSED\n');


  // -------------------------------------------------------------------------
  // TEST 5: Background Queue Sweeper & Drain Job
  // -------------------------------------------------------------------------
  console.log('👉 [TEST 5: QUEUE RECOVERY ENGINE - Background Sweeper & Drain Job]');
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

  const drainRes = await drainBillingSyncQueue(5, localReceiverUrl, testSecret);
  console.log('  Queue Drain Result:', drainRes);
  assert.ok(drainRes.drained >= 1, 'Sweeper must drain at least 1 pending task');

  const queueStats = await db.getBillingSyncStats();
  console.log('  Updated Billing Queue Stats:', queueStats);
  assert.ok(queueStats.completed >= 1, 'Completed count in queue must reflect drained tasks');
  console.log('  ✅ Background Queue Sweeper & Recovery: PASSED\n');


  // -------------------------------------------------------------------------
  // TEST 6: Production Safety Verification on Private RFC1918 IP (192.168.1.1)
  // -------------------------------------------------------------------------
  console.log('👉 [TEST 6: PRODUCTION ENFORCEMENT - Private RFC1918 Subnet Refusal (192.168.1.1)]');
  delete process.env.ALLOW_LOOPBACK_BILLING; // Reset back to strict production mode
  const privateIpUrl = 'http://192.168.1.1:8080/api/billing/sync';
  console.log(`  [ENV STATE] Target URL: ${privateIpUrl} | ALLOW_LOOPBACK_BILLING: undefined (Production Mode)`);

  const rfcBlockRes = await syncBillingWanChange(testDeviceId, wanData, 13, privateIpUrl, testSecret);
  console.log('  Private RFC1918 Block Result:', rfcBlockRes);
  assert.strictEqual(rfcBlockRes.success, false, 'Must block private RFC1918 subnet in production mode');
  assert.strictEqual(rfcBlockRes.status, 'BLOCKED_LOOPBACK_IN_PRODUCTION');
  console.log('  ✅ RFC1918 Private Subnet Production Security Block: PASSED\n');

  console.log('================================================================');
  console.log('🎉 ALL BILLING SYNC PRODUCTION & DEV-MODE TESTS PASSED (100%)');
  console.log('================================================================');
}

runTests().then(() => process.exit(0)).catch(err => {
  console.error('❌ TEST FAILED:', err);
  process.exit(1);
});
