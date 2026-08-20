/**
 * PPPoE Radius & Bandwidth Quota Management Engine
 */

const { getDevices, updateDevice } = require('../db/database');

// Standard ISP Bandwidth Profiles
const SPEED_PLANS = [
  { id: 'plan_50m', name: 'Bronze Ultra (50 Mbps)', downloadMbps: 50, uploadMbps: 50, priceInr: 499, quotaGb: 'Unlimited' },
  { id: 'plan_100m', name: 'Silver Fiber (100 Mbps)', downloadMbps: 100, uploadMbps: 100, priceInr: 799, quotaGb: 'Unlimited' },
  { id: 'plan_300m', name: 'Gold Lightning (300 Mbps)', downloadMbps: 300, uploadMbps: 300, priceInr: 1199, quotaGb: 'Unlimited' },
  { id: 'plan_1g', name: 'Diamond Gigabit (1,000 Mbps)', downloadMbps: 1000, uploadMbps: 1000, priceInr: 2499, quotaGb: 'Unlimited' }
];

/**
 * Get all PPPoE subscriber billing & bandwidth accounts
 */
async function getSubscribers() {
  const devices = await getDevices();
  return devices.map((d, index) => {
    const pppUser = d.wan?.username || `pppoe_user_${index + 1}`;
    const plan = d.billing?.plan || SPEED_PLANS[index % SPEED_PLANS.length];
    const status = d.billing?.accountStatus || 'ACTIVE';
    const usageGb = d.billing?.monthlyUsageGb || (Math.floor(Math.random() * 250) + 40);

    return {
      deviceId: d._id,
      customerName: d.customer?.name || 'Subscriber',
      phone: d.customer?.phone || 'N/A',
      pppoeUsername: pppUser,
      macAddress: d.deviceInfo?.macAddress || 'N/A',
      ipAddress: d.ipAddress || '202.62.75.86',
      currentPlan: plan,
      accountStatus: status, // ACTIVE, SUSPENDED, EXPIRED
      monthlyUsageGb: usageGb,
      billingCycleDate: '1st of every month',
      lastPaymentDate: '2026-08-01'
    };
  });
}

/**
 * Update subscriber speed plan or toggle account suspension
 */
async function updateSubscriberPlan(deviceId, planId, status) {
  const devices = await getDevices();
  const dev = devices.find(d => d._id === deviceId);
  if (!dev) throw new Error('Subscriber device not found');

  const selectedPlan = SPEED_PLANS.find(p => p.id === planId) || SPEED_PLANS[1];

  if (!dev.billing) dev.billing = {};
  dev.billing.plan = selectedPlan;
  if (status) dev.billing.accountStatus = status;
  dev.billing.updatedAt = new Date().toISOString();

  await updateDevice(dev._id, dev);

  return {
    success: true,
    message: `Updated subscriber "${dev.customer?.name || dev._id}" to plan: ${selectedPlan.name} (${dev.billing.accountStatus})`,
    billing: dev.billing
  };
}

module.exports = {
  SPEED_PLANS,
  getSubscribers,
  updateSubscriberPlan
};
