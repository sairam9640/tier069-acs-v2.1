const { MongoClient } = require('mongodb');

async function fixTenants() {
  const client = new MongoClient('mongodb://127.0.0.1:27017');
  try {
    await client.connect();
    const db = client.db('tr069_acs');
    const tenantsCol = db.collection('tenants');

    const res = await tenantsCol.updateMany(
      {},
      {
        $set: {
          cwmpUrl: 'http://222.167.207.220:7547/',
          domain: '222.167.207.220:7547'
        }
      }
    );
    console.log(`[DB FIX] Updated ${res.modifiedCount} tenants to cwmpUrl: http://222.167.207.220:7547/`);
  } catch (err) {
    console.error('[DB FIX ERROR]', err);
  } finally {
    await client.close();
  }
}

fixTenants();
