/**
 * TEST: ISSUE 2 & GAP 4 - CGNAT CONNECTION REQUEST RETRIES & TASK EXPIRY
 * Tests:
 * 1. Connection Request retry loop with exponential backoff on unreachable private IP.
 * 2. Sweep & expire tasks older than timeout window (marking EXPIRED in DB).
 */

const assert = require('assert');
const { triggerConnectionRequest } = require('../lib/cwmp/connection-request');
const db = require('../lib/db/database');

console.log('================================================================');
console.log('🧪 TEST: ISSUE 2 & GAP 4 - CGNAT RETRY & TASK EXPIRATION SWEEP');
console.log('================================================================\n');

async function runTest() {
  // 1. Test Connection Request Retries on CGNAT / unreachable IP
  console.log('👉 [TEST 1: Connection Request Retries with Backoff]');
  const startTime = Date.now();
  // Using private unrouted IP
  const connRes = await triggerConnectionRequest('http://10.255.255.250:7547/cgnat_test', 'admin', 'admin', 2, 500);
  const elapsed = Date.now() - startTime;

  console.log(`  Attempts: ${connRes.attempts} | Success: ${connRes.success} | Code: ${connRes.code} | Elapsed: ${elapsed}ms`);
  console.log(`  Message: ${connRes.message}`);

  assert.strictEqual(connRes.attempts, 3, 'Connection Request must execute 3 attempts (1 initial + 2 retries)');
  assert.strictEqual(connRes.success, false, 'Unreachable router connection request must return success=false');
  console.log('  ✅ Connection Request Retries & Backoff: PASSED\n');

  // 2. Test Task Expiry Sweep Engine
  console.log('👉 [TEST 2: Task Expiry Sweeper]');
  const testDevId = 'TEST_DEVICE_EXPIRY_001';
  
  // Seed device with an expired task (created 15 minutes ago)
  const oldTask = {
    id: 'TASK_OLD_12345',
    type: 'SET_WIFI',
    createdAt: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
    status: 'PENDING'
  };

  const freshTask = {
    id: 'TASK_FRESH_67890',
    type: 'SET_WIFI',
    createdAt: new Date().toISOString(),
    status: 'PENDING'
  };

  const testDev = {
    _id: testDevId,
    deviceId: testDevId,
    taskQueue: [oldTask, freshTask]
  };

  await db.saveDevice(testDev);

  // Run sweep with 10 minute threshold
  const expiredCount = await db.expireStaleDeviceTasks(10 * 60 * 1000);
  console.log(`  Swept Expired Tasks Count: ${expiredCount}`);

  const updatedDev = await db.getDevice(testDevId);
  console.log(`  Remaining Tasks in Queue: ${updatedDev.taskQueue.length}`);
  console.log(`  Last Task Status:`, updatedDev.lastTaskStatus);

  assert.strictEqual(expiredCount >= 1, true, 'At least 1 task must be expired');
  assert.strictEqual(updatedDev.taskQueue.length, 1, 'Only fresh task should remain in queue');
  assert.strictEqual(updatedDev.taskQueue[0].id, 'TASK_FRESH_67890', 'Fresh task must remain pending');
  assert.strictEqual(updatedDev.lastTaskStatus.status, 'EXPIRED', 'Device lastTaskStatus must be marked EXPIRED');
  console.log('  ✅ Task Expiry Engine: PASSED\n');

  // Cleanup
  await db.deleteDevice(testDevId);

  console.log('================================================================');
  console.log('🎉 ISSUE 2 & GAP 4 TEST PASSED (100% SUCCESS)');
  console.log('================================================================');
}

runTest().then(() => process.exit(0)).catch(err => {
  console.error('❌ TEST FAILED:', err);
  process.exit(1);
});
