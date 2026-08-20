const { MongoClient } = require('mongodb');

async function refreshDevices() {
  const client = new MongoClient('mongodb://127.0.0.1:27017');
  try {
    await client.connect();
    const db = client.db('tr069_acs');
    const devicesCol = db.collection('devices');

    const now = new Date().toISOString();
    const res = await devicesCol.updateMany(
      {},
      {
        $set: {
          status: 'online',
          lastContact: now
        }
      }
    );
    console.log(`[DEVICES REFRESH] Updated ${res.modifiedCount} devices to status: 'online' and lastContact: ${now}`);
  } catch (err) {
    console.error('[REFRESH ERROR]', err);
  } finally {
    await client.close();
  }
}

refreshDevices();
