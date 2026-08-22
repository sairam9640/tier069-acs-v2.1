/**
 * Universal Device & Customer Data Re-normalization & Synchronization Script
 * =========================================================================
 * Iterates through all devices in MongoDB, applies the full multi-vendor parameter normalizer
 * and intelligent customer auto-enricher, and saves the updated clean data.
 */

const db = require('../lib/db/database');
const { normalizeDeviceData, enrichCustomerProfile } = require('../lib/normalizer/parameter-mapper');

async function syncAllDevices() {
  console.log('================================================================');
  console.log('🔄 RE-NORMALIZING & SYNCHRONIZING ALL ROUTER & CUSTOMER DATA');
  console.log('================================================================\n');

  const devices = await db.getAllDevices({}, { lastContact: -1 }, 500);
  console.log(`Found ${devices.length} devices in MongoDB.\n`);

  let updatedCount = 0;

  for (const dev of devices) {
    const rawParams = dev.rawParameters || {};
    const deviceIdStruct = dev.deviceIdStruct || {
      manufacturer: dev.deviceInfo?.manufacturer || 'Generic',
      oui: dev.deviceInfo?.oui || '',
      productClass: dev.deviceInfo?.modelName || dev.deviceInfo?.productClass || '',
      serialNumber: dev.deviceInfo?.serialNumber || dev._id
    };

    const normalized = normalizeDeviceData(rawParams, deviceIdStruct, dev);

    // Merge normalized structures
    dev.deviceInfo = { ...(dev.deviceInfo || {}), ...normalized.deviceInfo };
    dev.opticalPower = normalized.opticalPower;
    dev.wifi = normalized.wifi;
    dev.wan = normalized.wan;
    dev.network = { ...(dev.network || {}), ...normalized.network };
    dev.connectedClients = normalized.connectedClients;

    // Enrich customer profile
    dev.customer = enrichCustomerProfile(dev.customer, dev.wan, dev.wifi, dev.deviceInfo);

    await db.saveDevice(dev);
    updatedCount++;

    const model = dev.deviceInfo?.modelName || dev.deviceInfo?.brand?.name || 'ONT';
    const custName = dev.customer?.name || 'N/A';
    const custPhone = dev.customer?.phone || 'N/A';
    const pppoe = dev.wan?.username || dev.customer?.pppoeUsername || 'N/A';
    const wifiSsid = dev.wifi?.wifi24?.ssid || 'N/A';
    const rx = dev.opticalPower?.rxPower || 'N/A';

    console.log(`[SYNCED] ${dev._id.padEnd(25)} | ${model.padEnd(16)} | Cust: ${custName.padEnd(20)} | Phone: ${custPhone.padEnd(12)} | PPPoE: ${pppoe.padEnd(22)} | WiFi: ${wifiSsid.padEnd(20)} | RX: ${rx}`);
  }

  console.log(`\n================================================================`);
  console.log(`✅ SUCCESSFULLY SYNCHRONIZED ${updatedCount} DEVICES & CUSTOMER PROFILES`);
  console.log(`================================================================`);
}

syncAllDevices().then(() => process.exit(0)).catch(e => {
  console.error('❌ SYNC ERROR:', e);
  process.exit(1);
});
