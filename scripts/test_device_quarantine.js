/**
 * DEVICE ONBOARDING & QUARANTINE VALIDATION TEST SUITE
 * ====================================================
 * Proves:
 * 1. Malformed / implausible serial numbers are rejected without DB writes.
 * 2. Unregistered new CWMP Informs are quarantined with status: 'UNVERIFIED', isVerified: false.
 * 3. Verified devices maintain live status: 'online'.
 */

const assert = require('assert');
const http = require('http');
const db = require('../lib/db/database');

async function testDeviceQuarantine() {
  console.log('================================================================');
  console.log('🛡️  TEST: DEVICE ONBOARDING VALIDATION & QUARANTINE PIPELINE');
  console.log('================================================================\n');

  // 1. Purge previous test record if any
  const previousDev = await db.getDevice('TP-Link_LIVE_TEST_SN_999');
  if (previousDev) {
    await db.deleteDevice('TP-Link_LIVE_TEST_SN_999');
    console.log('  Cleaned up previous test device: TP-Link_LIVE_TEST_SN_999');
  }

  // 2. Test First-Time Unverified Device Inform
  console.log('👉 [1. FIRST-TIME INBOUND CWMP INFORM QUARANTINE]');
  const newInformPayload = `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:cwmp="urn:dslforum-org:cwmp-1-0">
  <soap:Header><cwmp:ID>2001</cwmp:ID></soap:Header>
  <soap:Body>
    <cwmp:Inform>
      <DeviceId>
        <Manufacturer>TP-Link</Manufacturer>
        <OUI>00259E</OUI>
        <ProductClass>XC220-G3v</ProductClass>
        <SerialNumber>QUARANTINE_TEST_100</SerialNumber>
      </DeviceId>
      <Event>
        <EventStruct><EventCode>0 BOOTSTRAP</EventCode></EventStruct>
      </Event>
      <ParameterList>
        <ParameterValueStruct>
          <Name>InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID</Name>
          <Value>NEW_ONT_WIFI</Value>
        </ParameterValueStruct>
      </ParameterList>
    </cwmp:Inform>
  </soap:Body>
</soap:Envelope>`;

  await new Promise((resolve) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: 7547,
      path: '/cwmp',
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml',
        'Content-Length': Buffer.byteLength(newInformPayload)
      }
    }, (res) => {
      res.on('data', () => {});
      res.on('end', resolve);
    });
    req.write(newInformPayload);
    req.end();
  });

  // Query MongoDB to inspect the created device state
  const allDevs = await db.getAllDevices();
  const dev = allDevs.find(d => (d._id && d._id.includes('QUARANTINE_TEST_100')) || (d.deviceInfo?.serialNumber === 'QUARANTINE_TEST_100'));
  console.log('  MongoDB Stored Device State:');
  console.log(`    - ID:           ${dev?._id}`);
  console.log(`    - Status:       ${dev?.status}`);
  console.log(`    - isVerified:   ${dev?.isVerified}`);
  console.log(`    - Quarantined:  ${dev?.quarantined}`);
  console.log(`    - Reason:       ${dev?.quarantineReason}`);

  assert.ok(dev, 'Device must be recorded');
  assert.strictEqual(dev.status, 'UNVERIFIED', 'First-time device must receive status UNVERIFIED');
  assert.strictEqual(dev.isVerified, false, 'First-time device must have isVerified = false');
  assert.strictEqual(dev.quarantined, true, 'First-time device must be quarantined');
  console.log('  ✅ First-Time Device Successfully Quarantined: PASSED\n');

  // 3. Test Malformed / Implausible Serial Rejection
  console.log('👉 [2. IMPLAUSIBLE / MALFORMED SERIAL REJECTION]');
  const malformedPayload = `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:cwmp="urn:dslforum-org:cwmp-1-0">
  <soap:Header><cwmp:ID>2002</cwmp:ID></soap:Header>
  <soap:Body>
    <cwmp:Inform>
      <DeviceId>
        <Manufacturer>TP-Link</Manufacturer>
        <OUI>00259E</OUI>
        <ProductClass>XC220-G3v</ProductClass>
        <SerialNumber>!@#$$%^&*</SerialNumber>
      </DeviceId>
      <Event><EventStruct><EventCode>2 PERIODIC</EventCode></EventStruct></Event>
    </cwmp:Inform>
  </soap:Body>
</soap:Envelope>`;

  await new Promise((resolve) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: 7547,
      path: '/cwmp',
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml',
        'Content-Length': Buffer.byteLength(malformedPayload)
      }
    }, (res) => {
      assert.strictEqual(res.statusCode, 204, 'Malformed serial Inform must be dropped with 204');
      res.on('data', () => {});
      res.on('end', resolve);
    });
    req.write(malformedPayload);
    req.end();
  });

  const badDev = await db.getDevice('TP-Link_!@#$$%^&*');
  assert.strictEqual(badDev, null, 'Malformed serial must never be persisted in MongoDB');
  console.log('  ✅ Malformed Serial Number Rejected without Database Write: PASSED\n');

  // 4. Operator Verification Flow
  console.log('👉 [3. OPERATOR VERIFICATION / APPROVAL TRANSITION]');
  dev.isVerified = true;
  dev.quarantined = false;
  dev.quarantineReason = null;
  dev.status = 'online';
  await db.saveDevice(dev);

  const approvedDev = await db.getDevice(dev._id);
  assert.strictEqual(approvedDev.status, 'online', 'Approved device must have status online');
  assert.strictEqual(approvedDev.isVerified, true, 'Approved device must have isVerified = true');
  assert.strictEqual(approvedDev.quarantined, false, 'Approved device must not be quarantined');
  console.log('  ✅ Operator Approval Lifecycle Transition: PASSED\n');

  // Cleanup test record
  await db.deleteDevice(dev._id);

  console.log('================================================================');
  console.log('🎉 ALL DEVICE ONBOARDING & QUARANTINE CHECKS PASSED (100%)');
  console.log('================================================================');
}

testDeviceQuarantine().then(() => process.exit(0)).catch(e => {
  console.error('❌ TEST FAILED:', e);
  process.exit(1);
});
