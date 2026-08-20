const { MongoClient } = require('mongodb');

async function restoreRealDeviceState() {
  const client = new MongoClient('mongodb://127.0.0.1:27017');
  try {
    await client.connect();
    const db = client.db('tr069_acs');
    const devicesCol = db.collection('devices');

    // TP-Link HOME was specifically disconnected / CWMP removed by user, so it must be offline
    const twoHoursAgo = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
    await devicesCol.updateOne(
      { _id: 'TP-Link_30DE4B78B964' },
      {
        $set: {
          status: 'offline',
          lastContact: twoHoursAgo
        }
      }
    );
    console.log('[DB RESTORE] TP-Link HOME marked OFFLINE as user removed CWMP URL from router.');
  } catch (err) {
    console.error('[RESTORE ERROR]', err);
  } finally {
    await client.close();
  }
}

restoreRealDeviceState();
