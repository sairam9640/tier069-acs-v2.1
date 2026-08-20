const db = require('./lib/db/database');
const { normalizeDeviceData } = require('./lib/normalizer/parameter-mapper');

async function run() {
  await db.connectDB();
  const devs = await db.getAllDevices();
  console.log(`Re-normalizing optical metrics for ${devs.length} devices in database...`);

  for (const d of devs) {
    const rawParams = d.rawParameters || {};
    const baseDevId = d.deviceIdStruct || {};
    const normalized = normalizeDeviceData(rawParams, baseDevId, { blockedMacs: d.blockedClients || [] });

    // Keep customer and location
    const updated = {
      ...d,
      deviceInfo: normalized.deviceInfo,
      opticalPower: normalized.opticalPower,
      wifi: normalized.wifi,
      wan: normalized.wan,
      connectedClients: normalized.connectedClients && normalized.connectedClients.length > 0 ? normalized.connectedClients : (d.connectedClients || [])
    };

    await db.saveDevice(updated);
    console.log(`[OK] ${d._id} (${d.customer?.name || 'ONT'}) -> Rx: ${normalized.opticalPower?.rxPower} (Raw: ${normalized.opticalPower?.rxPowerRaw}) | Tx: ${normalized.opticalPower?.txPower} (Raw: ${normalized.opticalPower?.txPowerRaw})`);
  }

  console.log('All devices optical metrics re-calculated with high precision!');
  process.exit(0);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
