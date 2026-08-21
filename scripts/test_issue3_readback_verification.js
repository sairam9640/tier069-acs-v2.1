/**
 * TEST: ISSUE 3 & GAP 5 - READ-BACK VERIFICATION, AUTO-RETRY & FAILURE STATE
 * Tests:
 * 1. Read-back value matches pushed value -> Status: COMPLETED.
 * 2. Read-back value mismatches pushed value -> Triggers automatic 1-time retry.
 * 3. Second read-back mismatch -> Status: FAILED, sets wifi.lastApplyFailed = true.
 */

const assert = require('assert');

console.log('================================================================');
console.log('🧪 TEST: ISSUE 3 & GAP 5 - READ-BACK VERIFICATION & AUTO-RETRY');
console.log('================================================================\n');

// Simulated Read-Back Verification Evaluator (Mirroring cwmp-server.js logic)
function evaluateReadBack(session, returnedParams, dev) {
  const vTask = session.verifyingTask;
  const readBackVal = returnedParams[vTask.targetPath];
  const isMatched = readBackVal && String(readBackVal).trim() === String(vTask.expectedValue).trim();

  if (isMatched) {
    dev.lastTaskStatus = {
      id: vTask.id,
      type: vTask.type,
      status: 'COMPLETED',
      message: `Verified & active on hardware (${vTask.expectedValue})`
    };
    if (dev.wifi) dev.wifi.lastApplyFailed = false;
    session.verifyingTask = null;
    return { outcome: 'COMPLETED', retried: false };
  } else {
    if ((vTask.retryCount || 0) < 1) {
      vTask.retryCount = 1;
      dev.lastTaskStatus = {
        id: vTask.id,
        type: vTask.type,
        status: 'RETRYING',
        message: `Read-back mismatch (received "${readBackVal}" != expected "${vTask.expectedValue}"). Retrying push...`
      };
      return { outcome: 'RETRYING', retried: true };
    } else {
      dev.lastTaskStatus = {
        id: vTask.id,
        type: vTask.type,
        status: 'FAILED',
        message: `Router rejected value: hardware returned "${readBackVal || 'Previous Value'}"`
      };
      if (dev.wifi) {
        dev.wifi.lastApplyFailed = true;
        dev.wifi.lastApplyError = `Router rejected value: reverted to "${readBackVal}"`;
      }
      session.verifyingTask = null;
      return { outcome: 'FAILED', retried: false };
    }
  }
}

// 1. SCENARIO A: Successful Verification
console.log('👉 [SCENARIO A: Read-back matches pushed value]');
let sessionA = {
  verifyingTask: {
    id: 'TASK_001',
    type: 'SET_WIFI',
    targetPath: 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID',
    expectedValue: 'sairam_verified',
    retryCount: 0
  }
};
let devA = { wifi: { lastApplyFailed: false } };
let resA = evaluateReadBack(sessionA, { 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID': 'sairam_verified' }, devA);

console.log('  Outcome:', resA.outcome);
console.log('  Dev Status:', devA.lastTaskStatus);
assert.strictEqual(resA.outcome, 'COMPLETED', 'Should complete on match');
assert.strictEqual(devA.wifi.lastApplyFailed, false, 'lastApplyFailed should be false');
console.log('  ✅ Verification Success: PASSED\n');


// 2. SCENARIO B: First Mismatch triggers 1-time Auto-Retry
console.log('👉 [SCENARIO B: First Read-back Mismatch -> Automatic 1-Time Retry]');
let sessionB = {
  verifyingTask: {
    id: 'TASK_002',
    type: 'SET_WIFI',
    targetPath: 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID',
    expectedValue: 'sairam_target',
    retryCount: 0
  }
};
let devB = { wifi: { lastApplyFailed: false } };
let resB = evaluateReadBack(sessionB, { 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID': 'TP-Link_Old' }, devB);

console.log('  Outcome:', resB.outcome);
console.log('  Task Retry Count:', sessionB.verifyingTask.retryCount);
console.log('  Dev Status:', devB.lastTaskStatus);
assert.strictEqual(resB.outcome, 'RETRYING', 'Should trigger retry on first mismatch');
assert.strictEqual(sessionB.verifyingTask.retryCount, 1, 'Retry count must be incremented to 1');
console.log('  ✅ Auto-Retry Trigger: PASSED\n');


// 3. SCENARIO C: Second Mismatch after Retry -> Marks FAILED
console.log('👉 [SCENARIO C: Second Read-back Mismatch -> Marks FAILED & Flags UI]');
let resC = evaluateReadBack(sessionB, { 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID': 'TP-Link_Old' }, devB);

console.log('  Outcome:', resC.outcome);
console.log('  Dev Status:', devB.lastTaskStatus);
console.log('  dev.wifi.lastApplyFailed:', devB.wifi.lastApplyFailed);
console.log('  dev.wifi.lastApplyError:', devB.wifi.lastApplyError);

assert.strictEqual(resC.outcome, 'FAILED', 'Should mark FAILED after retry exhausted');
assert.strictEqual(devB.wifi.lastApplyFailed, true, 'dev.wifi.lastApplyFailed must be true');
assert.strictEqual(devB.lastTaskStatus.status, 'FAILED', 'lastTaskStatus must be FAILED');
console.log('  ✅ Task Failure & Error Flagging: PASSED\n');

console.log('================================================================');
console.log('🎉 ISSUE 3 & GAP 5 TEST PASSED (100% SUCCESS)');
console.log('================================================================');
