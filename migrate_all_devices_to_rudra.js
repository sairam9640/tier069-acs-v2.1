const db = require('./lib/db/database');

async function migrate() {
  await db.connectDB();
  console.log('Migrating all existing devices to Rudra FiberNet (tenantId: rudra)...');

  // Ensure Rudra tenant exists
  const rudraTenant = await db.getTenant('rudra');
  if (!rudraTenant) {
    await db.saveTenant({
      _id: 'tenant_rudra',
      name: 'Rudra FiberNet',
      slug: 'rudra',
      contactPerson: 'Rudra Pratap Reddy',
      phone: '9951716316',
      email: 'admin@rudrafiber.in',
      status: 'ACTIVE',
      planId: 'plan_growth',
      planName: 'Growth Plan (500 ONTs)',
      maxOnts: 500,
      ratePerOnt: 7,
      monthlyCharge: 2999,
      cwmpUrl: 'http://222.167.207.220:7547/rudra',
      domain: 'rudra.ciniplay.in',
      vlanId: '100',
      pppoePrefix: 'RUDR_',
      branding: {
        brandName: 'Rudra FiberNet',
        logoUrl: '',
        helpline: '+91 9951716316',
        telegramChatId: ''
      },
      billingCycle: 'MONTHLY',
      lastBilledAt: new Date().toISOString(),
      expiryDate: new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString(),
      createdAt: new Date().toISOString()
    });
    console.log('[OK] Created default Rudra FiberNet tenant');
  }

  const devices = await db.getAllDevices();
  console.log(`Found ${devices.length} devices in fleet. Tagging with tenantId: 'rudra'...`);

  for (const d of devices) {
    if (!d.tenantId || d.tenantId === 'default') {
      d.tenantId = 'rudra';
      d.tenantName = 'Rudra FiberNet';
      await db.saveDevice(d);
      console.log(`  [MIGRATED] Device ${d._id} (${d.customer?.name || 'CPE'}) -> tenant: rudra`);
    } else {
      console.log(`  [PRESERVED] Device ${d._id} -> tenant: ${d.tenantId}`);
    }
  }

  console.log('Migration complete! All devices now belong to Rudra FiberNet.');
  process.exit(0);
}

migrate().catch(e => {
  console.error('Migration error:', e);
  process.exit(1);
});
