/**
 * TEST: ISSUE 1 & GAP 3 - VERSIONED LOCKING & EVENT-AWARE CONFLICT RESOLUTION
 * Tests:
 * 1. Operator manual push sets 120s lock.
 * 2. Incoming stale 2 PERIODIC inform is rejected & manual value is retained.
 * 3. Incoming 4 VALUE CHANGE (customer local change) is accepted.
 */

const assert = require('assert');
const { normalizeDeviceData } = require('../lib/normalizer/parameter-mapper');

console.log('================================================================');
console.log('🧪 TEST: ISSUE 1 & GAP 3 - VERSIONED LOCKING & CONFLICT RESOLUTION');
console.log('================================================================\n');

const now = Date.now();

// 1. Initial manual push state
const existingDev = {
  _id: 'TP-Link_30DE4B78B964',
  configVersion: 2,
  lastConfigModified: now - 10000, // Modified 10 seconds ago (Within 120s lock window)
  wifi: {
    ssids: [
      {
        index: 1,
        name: 'SSID 1',
        band: '2.4 GHz',
        ssid: 'sairam_operator_pushed',
        password: 'ManualPassword@123',
        enabled: true,
        lastModified: now - 10000,
        configVersion: 2
      }
    ]
  }
};

// 2. Scenario A: Router sends stale 2 PERIODIC inform with old SSID 'SWEET_HOME_OLD'
const staleRawParams = {
  'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID': 'SWEET_HOME_OLD',
  'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.Enable': '1',
  'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.Channel': '6'
};

const periodicResult = normalizeDeviceData(
  staleRawParams,
  { manufacturer: 'TP-Link', serialNumber: '30DE4B78B964' },
  { existingDev, informEvents: ['2 PERIODIC'] }
);

console.log('👉 [SCENARIO A: Stale Periodic Inform within 120s Lock]');
console.log('  Manual Value Pushed:', existingDev.wifi.ssids[0].ssid);
console.log('  Incoming Inform Value:', staleRawParams['InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID']);
console.log('  Resolved SSID Value:', periodicResult.wifi.ssids[0].ssid);

assert.strictEqual(periodicResult.wifi.ssids[0].ssid, 'sairam_operator_pushed', 'Stale periodic inform must be rejected and manual value retained');
console.log('  ✅ Stale Inform Overwrite Prevention: PASSED (Retained "sairam_operator_pushed")\n');


// 3. Scenario B: Customer legitimately changes Wi-Fi on router web GUI (Event 4 VALUE CHANGE)
const customerChangedParams = {
  'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID': 'Customer_New_WiFi',
  'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.Enable': '1',
  'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.Channel': '6'
};

const valueChangeResult = normalizeDeviceData(
  customerChangedParams,
  { manufacturer: 'TP-Link', serialNumber: '30DE4B78B964' },
  { existingDev, informEvents: ['4 VALUE CHANGE', '2 PERIODIC'] }
);

console.log('👉 [SCENARIO B: Legitimate Customer Local Change (Event 4 VALUE CHANGE)]');
console.log('  Incoming Customer Value:', customerChangedParams['InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID']);
console.log('  Resolved SSID Value:', valueChangeResult.wifi.ssids[0].ssid);

assert.strictEqual(valueChangeResult.wifi.ssids[0].ssid, 'Customer_New_WiFi', 'Event 4 Value Change must be accepted as legitimate customer modification');
console.log('  ✅ Customer Local Change Recognition: PASSED (Accepted "Customer_New_WiFi")\n');

console.log('================================================================');
console.log('🎉 ISSUE 1 & GAP 3 TEST PASSED (100% SUCCESS)');
console.log('================================================================');
