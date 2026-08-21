/**
 * UNIT TEST: BAND-SPECIFIC PARAMETER PATH RESOLUTION (Issue 5)
 * Tests multi-vendor dynamic discovery and exact path resolution for 2.4GHz vs 5.0GHz bands.
 */

const assert = require('assert');
const { normalizeDeviceData } = require('../lib/normalizer/parameter-mapper');

console.log('================================================================');
console.log('🧪 RUNNING BAND-SPECIFIC PARAMETER PATH RESOLUTION UNIT TESTS');
console.log('================================================================\n');

// 1. SAMPLE TEST DATA: TP-Link Archer XC220 Dual-Band ONT
const tplinkRawParams = {
  'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID': 'SWEET_HOME_2.4G',
  'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.Channel': '5',
  'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.Enable': '1',
  'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.KeyPassphrase': 'KotakPass@123',
  'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.X_TP_PreSharedKey': 'KotakPass@123',
  'InternetGatewayDevice.LANDevice.1.WLANConfiguration.2.SSID': 'TP-Link_Guest_B964',
  'InternetGatewayDevice.LANDevice.1.WLANConfiguration.2.Channel': '5',
  'InternetGatewayDevice.LANDevice.1.WLANConfiguration.2.Enable': '1',
  'InternetGatewayDevice.LANDevice.1.WLANConfiguration.6.SSID': 'SWEET_HOME_5G',
  'InternetGatewayDevice.LANDevice.1.WLANConfiguration.6.Channel': '149',
  'InternetGatewayDevice.LANDevice.1.WLANConfiguration.6.Enable': '1',
  'InternetGatewayDevice.LANDevice.1.WLANConfiguration.6.KeyPassphrase': 'KotakPass@123'
};

const tplinkDevInfo = {
  manufacturer: 'TP-Link',
  modelName: 'XC220-G3v',
  serialNumber: '30DE4B78B964'
};

const tplinkNorm = normalizeDeviceData(tplinkRawParams, tplinkDevInfo);
console.log('👉 [TEST 1: TP-Link XC220]');
console.log('  2.4G Main Index:', tplinkNorm.wifi.wifi24.index, '| SSID:', tplinkNorm.wifi.wifi24.ssid, '| Band:', tplinkNorm.wifi.wifi24.band);
console.log('  5.0G Main Index:', tplinkNorm.wifi.wifi5.index, '| SSID:', tplinkNorm.wifi.wifi5.ssid, '| Band:', tplinkNorm.wifi.wifi5.band);

assert.strictEqual(tplinkNorm.wifi.wifi24.index, 1, 'TP-Link 2.4G must resolve to Index 1');
assert.strictEqual(tplinkNorm.wifi.wifi24.band, '2.4 GHz', 'TP-Link 2.4G band must be 2.4 GHz');
assert.strictEqual(tplinkNorm.wifi.wifi5.index, 6, 'TP-Link 5.0G must resolve to Index 6 (Channel 149)');
assert.strictEqual(tplinkNorm.wifi.wifi5.band, '5.0 GHz', 'TP-Link 5.0G band must be 5.0 GHz');
console.log('  ✅ TP-Link Multi-SSID & Band Resolution: PASSED\n');


// 2. SAMPLE TEST DATA: Syrotech Realtek Dual-Band GPON ONT
const syrotechRawParams = {
  'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID': 'Syro_Fiber_Home',
  'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.Channel': '6',
  'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.Enable': '1',
  'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.PreSharedKey.1.KeyPassphrase': 'SyroPassword@1',
  'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.SSID': 'Syro_Fiber_5G',
  'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.Channel': '44',
  'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.Enable': '1',
  'InternetGatewayDevice.LANDevice.1.WLANConfiguration.5.PreSharedKey.1.KeyPassphrase': 'SyroPassword@1'
};

const syrotechDevInfo = {
  manufacturer: 'Syrotech',
  modelName: 'SY-GPON-1110-WDONT',
  serialNumber: 'F32425447E801141E'
};

const syrotechNorm = normalizeDeviceData(syrotechRawParams, syrotechDevInfo);
console.log('👉 [TEST 2: Syrotech Realtek GPON]');
console.log('  2.4G Main Index:', syrotechNorm.wifi.wifi24.index, '| SSID:', syrotechNorm.wifi.wifi24.ssid, '| Band:', syrotechNorm.wifi.wifi24.band);
console.log('  5.0G Main Index:', syrotechNorm.wifi.wifi5.index, '| SSID:', syrotechNorm.wifi.wifi5.ssid, '| Band:', syrotechNorm.wifi.wifi5.band);

assert.strictEqual(syrotechNorm.wifi.wifi24.index, 1, 'Syrotech 2.4G must resolve to Index 1');
assert.strictEqual(syrotechNorm.wifi.wifi5.index, 5, 'Syrotech 5.0G must resolve to Index 5 (Channel 44)');
assert.strictEqual(syrotechNorm.wifi.wifi5.band, '5.0 GHz', 'Syrotech 5.0G band must be 5.0 GHz');
console.log('  ✅ Syrotech Dual-Band Resolution: PASSED\n');


// 3. SAMPLE TEST DATA: Genexis Platinum 4410
const genexisRawParams = {
  'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.SSID': 'Genexis_2.4G',
  'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.Channel': '11',
  'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.Enable': '1',
  'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.KeyPassphrase': 'GenexisPass#2026',
  'InternetGatewayDevice.LANDevice.1.WLANConfiguration.6.SSID': 'Genexis_5G_Ultra',
  'InternetGatewayDevice.LANDevice.1.WLANConfiguration.6.Channel': '157',
  'InternetGatewayDevice.LANDevice.1.WLANConfiguration.6.Enable': '1',
  'InternetGatewayDevice.LANDevice.1.WLANConfiguration.6.KeyPassphrase': 'GenexisPass#2026'
};

const genexisDevInfo = {
  manufacturer: 'Genexis',
  modelName: 'Platinum-4410',
  serialNumber: 'GNXS98765432'
};

const genexisNorm = normalizeDeviceData(genexisRawParams, genexisDevInfo);
console.log('👉 [TEST 3: Genexis Platinum]');
console.log('  2.4G Main Index:', genexisNorm.wifi.wifi24.index, '| SSID:', genexisNorm.wifi.wifi24.ssid, '| Band:', genexisNorm.wifi.wifi24.band);
console.log('  5.0G Main Index:', genexisNorm.wifi.wifi5.index, '| SSID:', genexisNorm.wifi.wifi5.ssid, '| Band:', genexisNorm.wifi.wifi5.band);

assert.strictEqual(genexisNorm.wifi.wifi24.index, 1, 'Genexis 2.4G must resolve to Index 1');
assert.strictEqual(genexisNorm.wifi.wifi5.index, 6, 'Genexis 5.0G must resolve to Index 6 (Channel 157)');
assert.strictEqual(genexisNorm.wifi.wifi5.band, '5.0 GHz', 'Genexis 5.0G band must be 5.0 GHz');
console.log('  ✅ Genexis Dual-Band Resolution: PASSED\n');

console.log('================================================================');
console.log('🎉 ALL MULTI-VENDOR BAND PATH RESOLUTION TESTS PASSED (100%)');
console.log('================================================================');
