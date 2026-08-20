const { MongoClient } = require('mongodb');
const fs = require('fs');
const path = require('path');
const { encryptSecret, decryptSecret, sanitizeForLogs } = require('../security/crypto-vault');

const MONGO_URL = process.env.MONGO_URL || 'mongodb://127.0.0.1:27017';
const DB_NAME = process.env.DB_NAME || 'tr069_acs';
const BACKUP_FILE = path.join(__dirname, '../../data/devices_backup.json');

let db = null;
let client = null;
let useLocalFallback = false;
let memoryStore = {
  devices: new Map(),
  logs: [],
  settings: {
    acsUrl: 'http://222.167.207.220:7547/',
    cwmpPort: 7547,
    portalPort: 80,
    periodicInformInterval: 300,
    serverName: 'Antigravity ISP TR-069 ACS'
  }
};

// Ensure data folder exists
const dataDir = path.join(__dirname, '../../data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Load local backup if present
try {
  if (fs.existsSync(BACKUP_FILE)) {
    const raw = fs.readFileSync(BACKUP_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed.devices && Array.isArray(parsed.devices)) {
      parsed.devices.forEach(d => memoryStore.devices.set(d._id, d));
    }
    if (parsed.settings) memoryStore.settings = parsed.settings;
    if (parsed.logs) memoryStore.logs = parsed.logs;
  }
} catch (e) {
  console.warn('Local backup load warning:', e.message);
}

function persistLocalBackup() {
  try {
    const data = {
      devices: Array.from(memoryStore.devices.values()),
      settings: memoryStore.settings,
      logs: memoryStore.logs.slice(-500)
    };
    fs.writeFileSync(BACKUP_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error('Error saving local backup:', e.message);
  }
}

async function connectDB() {
  try {
    client = new MongoClient(MONGO_URL, {
      serverSelectionTimeoutMS: 3000,
      connectTimeoutMS: 3000
    });
    await client.connect();
    db = client.db(DB_NAME);
    console.log(`[DB] Connected successfully to MongoDB at ${MONGO_URL}/${DB_NAME}`);

    // Create indexes
    await db.collection('devices').createIndex({ _id: 1 });
    await db.collection('devices').createIndex({ 'deviceInfo.serialNumber': 1 });
    await db.collection('devices').createIndex({ 'deviceInfo.macAddress': 1 });
    await db.collection('devices').createIndex({ 'customer.pppoeUsername': 1 });
    await db.collection('devices').createIndex({ lastContact: -1 });
    await db.collection('logs').createIndex({ timestamp: -1 });

    // Super Admin & Operator security and OTP TTL indexes
    await db.collection('superadmins').createIndex({ email: 1 }, { unique: true });
    await db.collection('superadmin_otps').createIndex({ challengeToken: 1 }, { unique: true });
    await db.collection('superadmin_otps').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    await db.collection('superadmin_otps').createIndex({ email: 1 });
    await db.collection('operator_otps').createIndex({ challengeToken: 1 }, { unique: true });
    await db.collection('operator_otps').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    await db.collection('operator_otps').createIndex({ phone: 1 });
    await db.collection('audit_logs').createIndex({ timestamp: -1 });
    await db.collection('audit_logs').createIndex({ event: 1 });
    await db.collection('audit_logs').createIndex({ email: 1 });

    // Seed initial authorized Super Admin if collection is empty
    const superAdminEmail = (process.env.SUPER_ADMIN_EMAIL || 'kanugulasairam2004@gmail.com').toLowerCase().trim();
    const existingSa = await db.collection('superadmins').findOne({ email: superAdminEmail });
    if (!existingSa) {
      await db.collection('superadmins').insertOne({
        email: superAdminEmail,
        name: 'Master Platform Admin',
        role: 'SUPER_ADMIN',
        isActive: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
      console.log(`[DB] Seeded authorized Super Admin: ${superAdminEmail}`);
    }

    useLocalFallback = false;
  } catch (err) {
    console.warn(`[DB] MongoDB connection failed (${err.message}). Using high-speed persistent Local Store.`);
    useLocalFallback = true;
  }
}

// --- Devices API ---

async function getDevice(id) {
  if (!useLocalFallback && db) {
    try {
      return await db.collection('devices').findOne({ _id: id });
    } catch (e) {
      console.warn('DB read fallback:', e.message);
    }
  }
  return memoryStore.devices.get(id) || null;
}

async function getAllDevices(filter = {}, sort = { lastContact: -1 }, limit = 500) {
  if (!useLocalFallback && db) {
    try {
      return await db.collection('devices').find(filter).sort(sort).limit(limit).toArray();
    } catch (e) {
      console.warn('DB getAll fallback:', e.message);
    }
  }

  let list = Array.from(memoryStore.devices.values());
  // Basic filtering
  if (filter.status === 'online') {
    const fiveMinsAgo = Date.now() - 5 * 60 * 1000;
    list = list.filter(d => new Date(d.lastContact).getTime() > fiveMinsAgo);
  } else if (filter.status === 'offline') {
    const fiveMinsAgo = Date.now() - 5 * 60 * 1000;
    list = list.filter(d => new Date(d.lastContact).getTime() <= fiveMinsAgo);
  }

  return list.sort((a, b) => new Date(b.lastContact).getTime() - new Date(a.lastContact).getTime()).slice(0, limit);
}

async function saveDevice(device) {
  if (!device._id) throw new Error('Device must have _id');
  device.updatedAt = new Date().toISOString();

  // Update in-memory
  const existing = memoryStore.devices.get(device._id) || {};
  const merged = { ...existing, ...device };
  memoryStore.devices.set(device._id, merged);
  persistLocalBackup();

  if (!useLocalFallback && db) {
    try {
      await db.collection('devices').updateOne(
        { _id: device._id },
        { $set: merged },
        { upsert: true }
      );
    } catch (e) {
      console.warn('DB save device error:', e.message);
    }
  }

  return merged;
}

async function deleteDevice(id) {
  memoryStore.devices.delete(id);
  persistLocalBackup();

  if (!useLocalFallback && db) {
    try {
      await db.collection('devices').deleteMany({
        $or: [
          { _id: id },
          { _id: `onu_${id}` },
          { 'deviceInfo.serialNumber': id },
          { 'deviceInfo.ponSerialNumber': id },
          { 'deviceInfo.macAddress': id }
        ]
      });
    } catch (e) {
      console.warn('DB delete device error:', e.message);
    }
  }
}

// --- Pending Tasks Queue (Reboot, SetWiFi, SetWAN, etc.) ---

async function queueDeviceTask(deviceId, task) {
  task.id = `TASK_${Date.now()}_${Math.floor(Math.random()*1000)}`;
  task.createdAt = new Date().toISOString();
  task.status = 'PENDING';

  const dev = await getDevice(deviceId);
  if (!dev) return null;

  if (!dev.taskQueue) dev.taskQueue = [];
  dev.taskQueue.push(task);

  await saveDevice(dev);
  return task;
}

async function popPendingDeviceTask(deviceId) {
  const dev = await getDevice(deviceId);
  if (!dev || !dev.taskQueue || dev.taskQueue.length === 0) return null;

  const task = dev.taskQueue.shift();
  await saveDevice(dev);
  return task;
}

// --- Audit & Inform Logs (Zero PII / Sanitized) ---

async function addLog(logEntry) {
  const sanitizedEntry = sanitizeForLogs({
    ...logEntry,
    timestamp: new Date().toISOString()
  });

  memoryStore.logs.push(sanitizedEntry);
  if (memoryStore.logs.length > 500) memoryStore.logs.shift();

  if (!useLocalFallback && db) {
    try {
      await db.collection('logs').insertOne(sanitizedEntry);
    } catch (e) {
      // Ignore
    }
  }
}

async function getLogs(limit = 100, filter = {}) {
  if (!useLocalFallback && db) {
    try {
      return await db.collection('logs').find(filter || {}).sort({ timestamp: -1 }).limit(limit).toArray();
    } catch (e) {
      // Fallback
    }
  }
  let list = memoryStore.logs;
  if (filter && filter.tenantId) {
    list = list.filter(l => (l.tenantId || '').toLowerCase() === String(filter.tenantId).toLowerCase());
  }
  return list.slice(-limit).reverse();
}

// --- Settings ---

async function getSettings() {
  if (!useLocalFallback && db) {
    try {
      const s = await db.collection('settings').findOne({ _id: 'global' });
      if (s) return { ...memoryStore.settings, ...s };
    } catch (e) {
      // Fallback
    }
  }
  return memoryStore.settings;
}

async function saveSettings(newSettings) {
  memoryStore.settings = { ...memoryStore.settings, ...newSettings };
  persistLocalBackup();

  if (!useLocalFallback && db) {
    try {
      await db.collection('settings').updateOne(
        { _id: 'global' },
        { $set: memoryStore.settings },
        { upsert: true }
      );
    } catch (e) {
      // Ignore
    }
  }
  return memoryStore.settings;
}

// --- Network Topology ---
async function getTopology() {
  if (!useLocalFallback && db) {
    try {
      const top = await db.collection('topology').findOne({ _id: 'main' });
      if (top) return top;
    } catch (e) {
      // Fallback
    }
  }
  return memoryStore.topology || { nodes: [], links: [] };
}

async function saveTopology(topologyData) {
  memoryStore.topology = topologyData;
  if (!useLocalFallback && db) {
    try {
      await db.collection('topology').updateOne(
        { _id: 'main' },
        { $set: topologyData },
        { upsert: true }
      );
    } catch (e) {
      // Fallback
    }
  }
  return memoryStore.topology;
}

// --- OLT Fleet Management ---
async function getOlts(includeSecrets = false) {
  if (!memoryStore.olts) {
    memoryStore.olts = new Map();
  }

  if (!useLocalFallback && db) {
    try {
      const options = includeSecrets ? {} : { projection: { password: 0, snmpCommunity: 0 } };
      const list = await db.collection('olts').find({}, options).toArray();
      if (list && list.length > 0) {
        if (includeSecrets) {
          return list.map(o => ({
            ...o,
            password: decryptSecret(o.password),
            snmpCommunity: decryptSecret(o.snmpCommunity)
          }));
        }
        return list;
      }
      return [];
    } catch (e) {
      console.error('[DB ERROR] getOlts failed:', e.message);
    }
  }

  const list = Array.from(memoryStore.olts.values());
  if (includeSecrets) {
    return list.map(o => ({
      ...o,
      password: decryptSecret(o.password),
      snmpCommunity: decryptSecret(o.snmpCommunity)
    }));
  }
  return list.map(o => {
    const copy = { ...o };
    delete copy.password;
    delete copy.snmpCommunity;
    return copy;
  });
}

async function getOlt(id, includeSecrets = false) {
  if (!id) return null;
  if (!memoryStore.olts) memoryStore.olts = new Map();

  let target = null;
  if (!useLocalFallback && db) {
    try {
      target = await db.collection('olts').findOne({ _id: id });
    } catch (e) { console.error("[DB ERROR]:", e.message); }
  }
  if (!target) {
    target = memoryStore.olts.get(id) || null;
  }

  if (!target) return null;

  if (includeSecrets) {
    return {
      ...target,
      password: decryptSecret(target.password),
      snmpCommunity: decryptSecret(target.snmpCommunity)
    };
  }

  const copy = { ...target };
  delete copy.password;
  delete copy.snmpCommunity;
  return copy;
}

async function saveOlt(olt) {
  if (!olt._id) olt._id = `olt_${Date.now()}`;
  if (!memoryStore.olts) memoryStore.olts = new Map();

  // If password not provided in update, retain existing password
  if (olt.password === undefined || olt.password === '') {
    const existing = await getOlt(olt._id, true);
    if (existing && existing.password) {
      olt.password = existing.password;
    }
  }

  // Encrypt secrets at rest
  const toStore = { ...olt };
  if (toStore.password && !toStore.password.startsWith('enc_gcm$1$')) {
    toStore.password = encryptSecret(toStore.password);
  }
  if (toStore.snmpCommunity && !toStore.snmpCommunity.startsWith('enc_gcm$1$')) {
    toStore.snmpCommunity = encryptSecret(toStore.snmpCommunity);
  }

  toStore.updatedAt = new Date().toISOString();
  memoryStore.olts.set(toStore._id, toStore);

  if (!useLocalFallback && db) {
    try {
      await db.collection('olts').updateOne(
        { _id: toStore._id },
        { $set: toStore },
        { upsert: true }
      );
    } catch (e) {
      console.warn('DB saveOlt warning:', e.message);
    }
  }
  return olt;
}

async function deleteOlt(id) {
  if (memoryStore.olts) {
    memoryStore.olts.delete(id);
    for (const [k, v] of memoryStore.olts.entries()) {
      if (k === id || v.host === id || v.name === id || k === `olt_${id}`) {
        memoryStore.olts.delete(k);
      }
    }
  }
  if (!useLocalFallback && db) {
    try {
      await db.collection('olts').deleteMany({
        $or: [
          { _id: id },
          { _id: `olt_${id}` },
          { host: id },
          { name: id }
        ]
      });
      await db.collection('olt_onus').deleteMany({ $or: [{ oltId: id }, { oltHost: id }] });
      await db.collection('logs').deleteMany({ deviceId: id });
    } catch (e) {
      console.warn('DB deleteOlt warning:', e.message);
    }
  }
  return { success: true };
}

// =========================================================================
// MULTI-TENANT OPERATORS, SAAS BILLING & PRICING PLANS ENGINE
// =========================================================================

const DEFAULT_TENANTS = [];

const DEFAULT_PRICING_PLANS = [
  {
    _id: 'plan_pay_per_ont',
    name: 'Pay-Per-ONT (Pay-As-You-Grow)',
    ratePerOnt: 7,
    baseCharge: 499,
    includedOnts: 50,
    extraOntRate: 7,
    features: ['Unlimited OLTs', 'Real-Time CWMP Control', 'Optical Telemetry', 'Customer Self-Care App', 'Telegram Alerts'],
    recommended: true
  },
  {
    _id: 'plan_starter',
    name: 'Starter Tier',
    monthlyPrice: 1499,
    includedOnts: 250,
    extraOntRate: 6,
    features: ['Up to 250 ONTs', '1 OLT Integration', 'Zero-Touch Provisioning (ZTP)', 'Field Tech Mobile App']
  },
  {
    _id: 'plan_growth',
    name: 'Growth Tier',
    monthlyPrice: 2999,
    includedOnts: 600,
    extraOntRate: 5,
    features: ['Up to 600 ONTs', '4 OLTs Integration', 'Batch OTA Firmware Push', 'GIS Outside Plant Mapping', 'WhatsApp & SMS Alerts']
  },
  {
    _id: 'plan_enterprise',
    name: 'Enterprise Tier',
    monthlyPrice: 5999,
    includedOnts: 1500,
    extraOntRate: 4,
    features: ['Up to 1500 ONTs', 'Unlimited OLTs', 'TR-143 Speedtest Diagnostic Engine', 'Full White-Label Branding', 'Dedicated Account Manager']
  }
];

async function getTenants() {
  if (!memoryStore.tenants) memoryStore.tenants = new Map();
  if (!useLocalFallback && db) {
    try {
      const list = await db.collection('tenants').find({}).toArray();
      return list || [];
    } catch (e) {
      console.warn('DB getTenants fallback to memory:', e.message);
    }
  }
  return Array.from(memoryStore.tenants.values());
}

async function getTenant(idOrSlug) {
  if (!idOrSlug) return null;
  const tenants = await getTenants();
  const cleanId = String(idOrSlug).trim().toLowerCase();
  const cleanDigits = cleanId.replace(/\D/g, '');

  return tenants.find(t => {
    const tSlug = (t.slug || '').trim().toLowerCase();
    const tId = (t._id || '').trim().toLowerCase();
    const tUser = (t.username || '').trim().toLowerCase();
    const tPhone = (t.phone || '').replace(/\D/g, '');
    const tName = (t.name || '').trim().toLowerCase().replace(/\s+/g, '');

    return tSlug === cleanId ||
           tId === cleanId ||
           tUser === cleanId ||
           (tPhone && cleanDigits.length >= 10 && (tPhone === cleanDigits || tPhone.endsWith(cleanDigits) || cleanDigits.endsWith(tPhone))) ||
           tName === cleanId.replace(/\s+/g, '') ||
           (tSlug && cleanId.startsWith(tSlug)) ||
           (cleanId.length > 3 && tSlug && cleanId.includes(tSlug));
  }) || null;
}

async function saveTenant(tenant) {
  if (!tenant._id) tenant._id = `tenant_${tenant.slug || Date.now()}`;
  if (!tenant.slug) tenant.slug = tenant._id.replace('tenant_', '');
  tenant.slug = tenant.slug.toLowerCase().trim();
  tenant.updatedAt = new Date().toISOString();

  if (!memoryStore.tenants) memoryStore.tenants = new Map();
  memoryStore.tenants.set(tenant._id, tenant);

  if (!useLocalFallback && db) {
    try {
      await db.collection('tenants').updateOne(
        { _id: tenant._id },
        { $set: tenant },
        { upsert: true }
      );
    } catch (e) {
      console.warn('DB saveTenant warning:', e.message);
    }
  }
  return tenant;
}

async function updateTenant(id, updates) {
  const tenant = await getTenant(id);
  if (!tenant) return null;

  const merged = { ...tenant, ...updates, updatedAt: new Date().toISOString() };
  return await saveTenant(merged);
}

async function deleteTenant(id) {
  if (!id) return { success: false };
  if (memoryStore.tenants) {
    memoryStore.tenants.delete(id);
    // Also remove by slug
    for (const [k, v] of memoryStore.tenants.entries()) {
      if (v._id === id || v.slug === id) memoryStore.tenants.delete(k);
    }
  }
  if (!useLocalFallback && db) {
    try {
      await db.collection('tenants').deleteOne({ $or: [{ _id: id }, { slug: id }] });
    } catch (e) {
      console.warn('DB deleteTenant warning:', e.message);
    }
  }
  return { success: true };
}

async function getPricingPlans() {
  if (!memoryStore.pricingPlans) memoryStore.pricingPlans = new Map();
  if (!useLocalFallback && db) {
    try {
      let list = await db.collection('pricing_plans').find({}).toArray();
      if (!list || list.length === 0) {
        for (const p of DEFAULT_PRICING_PLANS) {
          await db.collection('pricing_plans').updateOne({ _id: p._id }, { $set: p }, { upsert: true });
        }
        list = DEFAULT_PRICING_PLANS;
      }
      return list;
    } catch (e) { console.error("[DB ERROR]:", e.message); }
  }
  if (memoryStore.pricingPlans.size === 0) {
    DEFAULT_PRICING_PLANS.forEach(p => memoryStore.pricingPlans.set(p._id, p));
  }
  return Array.from(memoryStore.pricingPlans.values());
}

async function savePricingPlan(plan) {
  if (!plan._id) plan._id = `plan_${Date.now()}`;
  if (!memoryStore.pricingPlans) memoryStore.pricingPlans = new Map();
  memoryStore.pricingPlans.set(plan._id, plan);

  if (!useLocalFallback && db) {
    try {
      await db.collection('pricing_plans').updateOne({ _id: plan._id }, { $set: plan }, { upsert: true });
    } catch (e) { console.error("[DB ERROR]:", e.message); }
  }
  return plan;
}

async function getInvoices(tenantId = null) {
  if (!useLocalFallback && db) {
    try {
      const query = tenantId ? { tenantId } : {};
      return await db.collection('invoices').find(query).sort({ createdAt: -1 }).toArray();
    } catch (e) { console.error("[DB ERROR]:", e.message); }
  }
  return [];
}

async function createFormalTaxInvoice(invoiceData) {
  const seq = Math.floor(1000 + Math.random() * 9000);
  const now = new Date();
  const monthNames = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  const invoiceNo = invoiceData.invoiceNumber || `VRV-INV-${now.getFullYear()}${monthNames[now.getMonth()]}-${seq}`;

  const subtotal = parseFloat(invoiceData.subtotal || invoiceData.amount || 2999);
  const cgst = parseFloat(invoiceData.cgst || (subtotal * 0.09).toFixed(2));
  const sgst = parseFloat(invoiceData.sgst || (subtotal * 0.09).toFixed(2));
  const totalAmount = Math.round(subtotal + cgst + sgst);

  const fullInvoice = {
    _id: invoiceNo,
    invoiceNumber: invoiceNo,
    tenantId: invoiceData.tenantId || 'operator',
    tenantName: invoiceData.tenantName || 'Operator',
    operatorKYC: invoiceData.operatorKYC || {
      name: invoiceData.tenantName || 'Operator',
      contactPerson: invoiceData.contactPerson || '',
      phone: invoiceData.phone || '',
      address: invoiceData.address || '',
      aadhaarNo: invoiceData.aadhaarNo || '',
      panNo: invoiceData.panNo || '',
      gstin: invoiceData.gstin || ''
    },
    providerInfo: {
      companyName: 'VRV ACS PLATFORM & BROADBAND CLOUD SOLUTIONS',
      address: 'Plot #108, Cyber Gateway, Hitech City, Hyderabad, Telangana - 500081',
      gstin: '36AAACV1234R1Z8',
      pan: 'AAACV1234R',
      supportEmail: 'billing@ciniplay.in',
      supportPhone: '+91 9951716316'
    },
    planDetails: {
      planName: invoiceData.planName || 'Growth Tier (600 ONTs)',
      includedOnts: invoiceData.includedOnts || 600,
      activeOnts: invoiceData.activeOnts || 10,
      ratePerOnt: invoiceData.ratePerOnt || 7
    },
    items: invoiceData.items || [
      {
        description: `VRV ACS Cloud TR-069 Subscription (${invoiceData.planName || 'Growth Tier'})`,
        hsnSac: '998422',
        quantity: 1,
        unitPrice: subtotal,
        amount: subtotal
      }
    ],
    subtotal: subtotal,
    cgst: cgst,
    sgst: sgst,
    totalAmount: totalAmount,
    bankDetails: {
      bankName: 'State Bank of India (SBI)',
      accountName: 'VRV ACS BROADBAND SOLUTIONS',
      accountNumber: '3890124578912',
      ifscCode: 'SBIN0012984',
      branch: 'Hitech City Hyderabad'
    },
    upiString: `upi://pay?pa=ciniplay@upi&pn=VRV+ACS+PLATFORM&am=${totalAmount}&cu=INR`,
    status: invoiceData.status || 'PENDING',
    issueDate: now.toLocaleDateString('en-IN', { year: 'numeric', month: 'short', day: 'numeric' }),
    dueDate: new Date(now.getTime() + 10 * 24 * 3600 * 1000).toLocaleDateString('en-IN', { year: 'numeric', month: 'short', day: 'numeric' }),
    createdAt: now.toISOString()
  };

  if (!useLocalFallback && db) {
    try {
      await db.collection('invoices').updateOne({ _id: fullInvoice._id }, { $set: fullInvoice }, { upsert: true });
    } catch (e) {
      console.warn('DB createFormalTaxInvoice warning:', e.message);
    }
  }
  return fullInvoice;
}

// GIS Fiber Routes (Physical Cable Polylines on Map)
async function getFiberRoutes(tenantId = null) {
  if (!useLocalFallback && db) {
    try {
      const query = tenantId ? { $or: [{ tenantId }, { tenantId: 'default' }, { tenantId: { $exists: false } }] } : {};
      return await db.collection('fiber_routes').find(query).toArray();
    } catch (e) { console.error("[DB ERROR]:", e.message); }
  }
  return [];
}

async function saveFiberRoute(route) {
  if (!route._id) route._id = `route_${Date.now()}`;
  route.updatedAt = new Date().toISOString();

  if (!useLocalFallback && db) {
    try {
      await db.collection('fiber_routes').updateOne({ _id: route._id }, { $set: route }, { upsert: true });
    } catch (e) { console.error("[DB ERROR]:", e.message); }
  }
  return route;
}

async function deleteFiberRoute(id) {
  if (!useLocalFallback && db) {
    try {
      await db.collection('fiber_routes').deleteOne({ _id: id });
    } catch (e) { console.error("[DB ERROR]:", e.message); }
  }
  return { success: true };
}

// --- Field Technicians ---
async function getTechnicians(tenantId = null) {
  if (!useLocalFallback && db) {
    try {
      const query = (tenantId && tenantId !== 'all') ? { $or: [{ tenantId }, { tenantId: 'all' }, { tenantId: { $exists: false } }] } : {};
      const list = await db.collection('technicians')
        .find(query, { projection: { password: 0, passwordHash: 0, passwordSalt: 0 } })
        .sort({ createdAt: -1 })
        .toArray();
      return list;
    } catch (e) {
      console.error('[DB ERROR] getTechnicians failed:', e.message);
      return [];
    }
  }
  return [];
}

async function getTechnician(id, includeSecrets = false) {
  if (!useLocalFallback && db) {
    try {
      const options = includeSecrets ? {} : { projection: { password: 0, passwordHash: 0, passwordSalt: 0 } };
      const t = await db.collection('technicians').findOne({ _id: id }, options);
      return t;
    } catch (e) {
      console.error(`[DB ERROR] getTechnician(${id}) failed:`, e.message);
      return null;
    }
  }
  return null;
}

async function findTechnicianByUsername(username) {
  if (!useLocalFallback && db) {
    try {
      // Must include passwordHash for internal authentication verification
      return await db.collection('technicians').findOne({ username: (username || '').toLowerCase().trim() });
    } catch (e) {
      console.error(`[DB ERROR] findTechnicianByUsername(${username}) failed:`, e.message);
      return null;
    }
  }
  return null;
}

async function saveTechnician(tech) {
  if (!tech._id) tech._id = `tech_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`;
  tech.updatedAt = new Date().toISOString();
  if (!tech.createdAt) tech.createdAt = new Date().toISOString();
  if (tech.username) tech.username = tech.username.toLowerCase().trim();
  if (!useLocalFallback && db) {
    try {
      await db.collection('technicians').updateOne({ _id: tech._id }, { $set: tech }, { upsert: true });
    } catch (e) { console.error("[DB ERROR]:", e.message); }
  }
  return tech;
}

async function deleteTechnician(id) {
  if (!useLocalFallback && db) {
    try {
      await db.collection('technicians').deleteOne({ _id: id });
    } catch (e) { console.error("[DB ERROR]:", e.message); }
  }
  return { success: true };
}

// --- WhatsApp Chats & Inbound History ---

async function saveWhatsAppMessage(msg) {
  if (!useLocalFallback && db) {
    try {
      await db.collection('whatsapp_messages').insertOne(msg);
    } catch (e) { console.error("[DB ERROR]:", e.message); }
  }
  return msg;
}

async function getWhatsAppThreads(tenantId) {
  const cleanTenant = (tenantId || 'rudra').toLowerCase();
  if (!useLocalFallback && db) {
    try {
      const pipeline = [
        { $match: { tenantId: cleanTenant } },
        { $sort: { timestamp: -1 } },
        {
          $group: {
            _id: '$phone',
            lastMessage: { $first: '$text' },
            lastTimestamp: { $first: '$timestamp' },
            senderName: { $first: '$senderName' },
            fromMe: { $first: '$fromMe' },
            count: { $sum: 1 }
          }
        },
        { $sort: { lastTimestamp: -1 } }
      ];
      const threads = await db.collection('whatsapp_messages').aggregate(pipeline).toArray();
      return threads.map(t => ({
        phone: t._id,
        senderName: t.senderName || 'Subscriber',
        lastMessage: t.lastMessage || '',
        lastTimestamp: t.lastTimestamp,
        fromMe: t.fromMe,
        totalMessages: t.count
      }));
    } catch (e) { console.error("[DB ERROR]:", e.message); }
  }
  return [];
}

async function getWhatsAppMessages(tenantId, phone) {
  const cleanTenant = (tenantId || 'rudra').toLowerCase();
  const cleanPhone = String(phone).replace(/\D/g, '');
  if (!useLocalFallback && db) {
    try {
      return await db.collection('whatsapp_messages')
        .find({
          tenantId: cleanTenant,
          $or: [
            { phone: cleanPhone },
            { phone: cleanPhone.startsWith('91') ? cleanPhone.substring(2) : `91${cleanPhone}` }
          ]
        })
        .sort({ timestamp: 1 })
        .limit(100)
        .toArray();
    } catch (e) { console.error("[DB ERROR]:", e.message); }
  }
  return [];
}

// --- Refresh Token Store (Persistent in MongoDB + Memory Fallback) ---

async function saveRefreshTokenRecord(record) {
  if (!memoryStore.refreshTokens) memoryStore.refreshTokens = new Map();
  memoryStore.refreshTokens.set(record.tokenHash, { ...record });

  if (!useLocalFallback && db) {
    try {
      await db.collection('refresh_tokens').updateOne(
        { tokenHash: record.tokenHash },
        { $set: record },
        { upsert: true }
      );
      return record;
    } catch (e) {
      console.error("[DB ERROR saveRefreshTokenRecord]:", e.message);
    }
  }
  return record;
}

async function getRefreshTokenByHash(tokenHash) {
  if (!tokenHash) return null;
  if (!useLocalFallback && db) {
    try {
      const doc = await db.collection('refresh_tokens').findOne({ tokenHash });
      if (doc) return doc;
    } catch (e) {
      console.error("[DB ERROR getRefreshTokenByHash]:", e.message);
    }
  }
  if (!memoryStore.refreshTokens) memoryStore.refreshTokens = new Map();
  return memoryStore.refreshTokens.get(tokenHash) || null;
}

async function consumeRefreshToken(tokenHash) {
  if (!tokenHash) return false;
  let modCount = 0;
  if (!useLocalFallback && db) {
    try {
      const res = await db.collection('refresh_tokens').updateOne(
        { tokenHash, consumed: false, revoked: false },
        { $set: { consumed: true, consumedAt: new Date().toISOString() } }
      );
      modCount = res.modifiedCount;
    } catch (e) {
      console.error("[DB ERROR consumeRefreshToken]:", e.message);
    }
  }
  if (!memoryStore.refreshTokens) memoryStore.refreshTokens = new Map();
  const mem = memoryStore.refreshTokens.get(tokenHash);
  if (mem && !mem.consumed && !mem.revoked) {
    mem.consumed = true;
    mem.consumedAt = new Date().toISOString();
    return true;
  }
  return modCount > 0;
}

async function revokeRefreshTokenFamily(familyId) {
  if (!familyId) return false;
  if (!useLocalFallback && db) {
    try {
      await db.collection('refresh_tokens').updateMany(
        { familyId },
        { $set: { revoked: true, revokedAt: new Date().toISOString() } }
      );
    } catch (e) {
      console.error("[DB ERROR revokeRefreshTokenFamily]:", e.message);
    }
  }
  if (!memoryStore.refreshTokens) memoryStore.refreshTokens = new Map();
  for (const [k, v] of memoryStore.refreshTokens.entries()) {
    if (v.familyId === familyId) {
      v.revoked = true;
      v.revokedAt = new Date().toISOString();
    }
  }
  return true;
}

async function revokeUserRefreshTokens(username) {
  if (!username) return false;
  const u = String(username).toLowerCase().trim();
  if (!useLocalFallback && db) {
    try {
      await db.collection('refresh_tokens').updateMany(
        { username: u },
        { $set: { revoked: true, revokedAt: new Date().toISOString() } }
      );
    } catch (e) {
      console.error("[DB ERROR revokeUserRefreshTokens]:", e.message);
    }
  }
  if (!memoryStore.refreshTokens) memoryStore.refreshTokens = new Map();
  for (const [k, v] of memoryStore.refreshTokens.entries()) {
    if ((v.username || '').toLowerCase() === u) {
      v.revoked = true;
      v.revokedAt = new Date().toISOString();
    }
  }
  return true;
}

// --- Super Admin & Production-Grade Hashed OTP Store ---

async function getSuperAdminByEmail(email) {
  if (!email) return null;
  const cleanEmail = String(email).toLowerCase().trim();
  if (!useLocalFallback && db) {
    try {
      const sa = await db.collection('superadmins').findOne({ email: cleanEmail, isActive: true });
      if (sa) return sa;
      // Fallback check in settings
      const settings = await getSettings();
      if ((settings.superAdmin?.email || '').toLowerCase() === cleanEmail) {
        return {
          email: cleanEmail,
          name: settings.superAdmin?.name || 'Master Platform Admin',
          role: 'SUPER_ADMIN',
          isActive: true
        };
      }
      return null;
    } catch (e) {
      console.error('[DB ERROR getSuperAdminByEmail]:', e.message);
    }
  }
  if (!memoryStore.superadmins) memoryStore.superadmins = new Map();
  const superAdminEmail = (process.env.SUPER_ADMIN_EMAIL || 'kanugulasairam2004@gmail.com').toLowerCase().trim();
  if (cleanEmail === superAdminEmail) {
    return {
      email: cleanEmail,
      name: 'Master Platform Admin',
      role: 'SUPER_ADMIN',
      isActive: true
    };
  }
  return memoryStore.superadmins.get(cleanEmail) || null;
}

async function saveSuperAdminOtpRecord(record) {
  const doc = {
    email: String(record.email || '').toLowerCase().trim(),
    challengeToken: record.challengeToken,
    otpCode: record.otpCode || '',
    otpHash: record.otpHash,
    salt: record.salt,
    attempts: 0,
    isUsed: false,
    createdAt: new Date(),
    expiresAt: new Date(record.expiresAt)
  };

  if (!useLocalFallback && db) {
    try {
      await db.collection('superadmin_otps').insertOne(doc);
      return doc;
    } catch (e) {
      console.error('[DB ERROR saveSuperAdminOtpRecord]:', e.message);
    }
  }
  if (!memoryStore.superadminOtps) memoryStore.superadminOtps = new Map();
  memoryStore.superadminOtps.set(record.challengeToken, doc);
  return doc;
}

async function getSuperAdminOtpRecord(challengeToken) {
  if (!useLocalFallback && db) {
    try {
      return await db.collection('superadmin_otps').findOne({ challengeToken });
    } catch (e) {
      console.error('[DB ERROR getSuperAdminOtpRecord]:', e.message);
    }
  }
  if (!memoryStore.superadminOtps) memoryStore.superadminOtps = new Map();
  return memoryStore.superadminOtps.get(challengeToken) || null;
}

async function incrementOtpAttempts(challengeToken) {
  if (!challengeToken) return 0;
  if (!useLocalFallback && db) {
    try {
      const res = await db.collection('superadmin_otps').findOneAndUpdate(
        { challengeToken },
        { $inc: { attempts: 1 } },
        { returnDocument: 'after' }
      );
      return res?.attempts || 1;
    } catch (e) {
      console.error('[DB ERROR incrementOtpAttempts]:', e.message);
    }
  }
  if (!memoryStore.superadminOtps) memoryStore.superadminOtps = new Map();
  const rec = memoryStore.superadminOtps.get(challengeToken);
  if (rec) {
    rec.attempts = (rec.attempts || 0) + 1;
    return rec.attempts;
  }
  return 1;
}

async function consumeSuperAdminOtpRecord(challengeToken) {
  if (!challengeToken) return false;
  if (!useLocalFallback && db) {
    try {
      await db.collection('superadmin_otps').updateOne(
        { challengeToken },
        { $set: { isUsed: true, consumedAt: new Date().toISOString() } }
      );
      return true;
    } catch (e) {
      console.error('[DB ERROR consumeSuperAdminOtpRecord]:', e.message);
    }
  }
  if (!memoryStore.superadminOtps) memoryStore.superadminOtps = new Map();
  const rec = memoryStore.superadminOtps.get(challengeToken);
  if (rec) {
    rec.isUsed = true;
    rec.consumedAt = new Date().toISOString();
  }
  return true;
}

// --- Operator WhatsApp OTP Storage & Verification ---

async function saveOperatorOtpRecord(record) {
  const doc = {
    phone: String(record.phone).replace(/\D/g, ''),
    tenantSlug: record.tenantSlug || 'rudra',
    tenantName: record.tenantName || 'Operator',
    challengeToken: record.challengeToken,
    otpCode: record.otpCode || '',
    otpHash: record.otpHash,
    salt: record.salt,
    attempts: 0,
    isUsed: false,
    createdAt: new Date(),
    expiresAt: new Date(record.expiresAt)
  };

  if (!useLocalFallback && db) {
    try {
      await db.collection('operator_otps').insertOne(doc);
      return doc;
    } catch (e) {
      console.error('[DB ERROR saveOperatorOtpRecord]:', e.message);
    }
  }
  if (!memoryStore.operatorOtps) memoryStore.operatorOtps = new Map();
  memoryStore.operatorOtps.set(record.challengeToken, doc);
  return doc;
}

async function getOperatorOtpRecord(challengeToken) {
  if (!useLocalFallback && db) {
    try {
      return await db.collection('operator_otps').findOne({ challengeToken });
    } catch (e) {
      console.error('[DB ERROR getOperatorOtpRecord]:', e.message);
    }
  }
  if (!memoryStore.operatorOtps) memoryStore.operatorOtps = new Map();
  return memoryStore.operatorOtps.get(challengeToken) || null;
}

async function incrementOperatorOtpAttempts(challengeToken) {
  if (!useLocalFallback && db) {
    try {
      const res = await db.collection('operator_otps').findOneAndUpdate(
        { challengeToken },
        { $inc: { attempts: 1 } },
        { returnDocument: 'after' }
      );
      return res?.attempts || 1;
    } catch (e) {
      console.error('[DB ERROR incrementOperatorOtpAttempts]:', e.message);
    }
  }
  if (!memoryStore.operatorOtps) memoryStore.operatorOtps = new Map();
  const rec = memoryStore.operatorOtps.get(challengeToken);
  if (rec) {
    rec.attempts = (rec.attempts || 0) + 1;
    return rec.attempts;
  }
  return 1;
}

async function consumeOperatorOtpRecord(challengeToken) {
  if (!useLocalFallback && db) {
    try {
      await db.collection('operator_otps').updateOne(
        { challengeToken },
        { $set: { isUsed: true, consumedAt: new Date().toISOString() } }
      );
      return true;
    } catch (e) {
      console.error('[DB ERROR consumeOperatorOtpRecord]:', e.message);
    }
  }
  if (!memoryStore.operatorOtps) memoryStore.operatorOtps = new Map();
  const rec = memoryStore.operatorOtps.get(challengeToken);
  if (rec) {
    rec.isUsed = true;
    rec.consumedAt = new Date().toISOString();
  }
  return true;
}

async function addAuditLog(entry) {
  const auditDoc = {
    timestamp: entry.timestamp || new Date().toISOString(),
    event: entry.event || 'AUDIT_EVENT',
    email: entry.email ? String(entry.email).toLowerCase() : null,
    ip: entry.ip || '127.0.0.1',
    userAgent: entry.userAgent || 'UNKNOWN',
    status: entry.status || 'INFO',
    details: entry.details || {}
  };

  if (!useLocalFallback && db) {
    try {
      await db.collection('audit_logs').insertOne(auditDoc);
    } catch (e) {
      console.error('[DB ERROR addAuditLog]:', e.message);
    }
  }

  if (!memoryStore.auditLogs) memoryStore.auditLogs = [];
  memoryStore.auditLogs.push(auditDoc);
  if (memoryStore.auditLogs.length > 2000) memoryStore.auditLogs.shift();
  return auditDoc;
}

async function getAuditLogs(filter = {}, limit = 200) {
  if (!useLocalFallback && db) {
    try {
      return await db.collection('audit_logs').find(filter).sort({ timestamp: -1 }).limit(limit).toArray();
    } catch (e) {
      console.error('[DB ERROR getAuditLogs]:', e.message);
    }
  }
  if (!memoryStore.auditLogs) memoryStore.auditLogs = [];
  return memoryStore.auditLogs.slice(-limit).reverse();
}

async function getOtpLogs(limit = 100) {
  const list = [];
  if (!useLocalFallback && db) {
    try {
      const saOtps = await db.collection('superadmin_otps').find({}).sort({ createdAt: -1 }).limit(limit).toArray();
      const opOtps = await db.collection('operator_otps').find({}).sort({ createdAt: -1 }).limit(limit).toArray();
      
      saOtps.forEach(o => {
        list.push({
          type: 'SUPER_ADMIN_EMAIL',
          target: o.email || 'Super Admin',
          recipient: o.email,
          channel: 'Gmail SMTP',
          challengeToken: o.challengeToken,
          otpCode: o.otpCode || '******',
          isUsed: !!o.isUsed,
          attempts: o.attempts || 0,
          createdAt: o.createdAt ? new Date(o.createdAt).toISOString() : new Date().toISOString(),
          expiresAt: o.expiresAt ? new Date(o.expiresAt).toISOString() : new Date().toISOString(),
          consumedAt: o.consumedAt || null,
          status: o.isUsed ? 'VERIFIED' : (new Date(o.expiresAt) < new Date() ? 'EXPIRED' : 'ACTIVE_PENDING')
        });
      });

      opOtps.forEach(o => {
        list.push({
          type: 'OPERATOR_WHATSAPP',
          target: `${o.tenantName || o.tenantSlug || 'Operator'} (+91 ${o.phone})`,
          recipient: `+91 ${o.phone}`,
          channel: 'Master WhatsApp Web',
          tenantSlug: o.tenantSlug,
          challengeToken: o.challengeToken,
          otpCode: o.otpCode || '******',
          isUsed: !!o.isUsed,
          attempts: o.attempts || 0,
          createdAt: o.createdAt ? new Date(o.createdAt).toISOString() : new Date().toISOString(),
          expiresAt: o.expiresAt ? new Date(o.expiresAt).toISOString() : new Date().toISOString(),
          consumedAt: o.consumedAt || null,
          status: o.isUsed ? 'VERIFIED' : (new Date(o.expiresAt) < new Date() ? 'EXPIRED' : 'ACTIVE_PENDING')
        });
      });
    } catch (e) {
      console.error('[DB ERROR getOtpLogs]:', e.message);
    }
  }

  // Memory fallback if no MongoDB
  if (memoryStore.superadminOtps) {
    for (const [t, o] of memoryStore.superadminOtps.entries()) {
      list.push({
        type: 'SUPER_ADMIN_EMAIL',
        target: o.email || 'Super Admin',
        recipient: o.email,
        channel: 'Gmail SMTP',
        challengeToken: t,
        otpCode: o.otpCode || '******',
        isUsed: !!o.isUsed,
        attempts: o.attempts || 0,
        createdAt: o.createdAt ? new Date(o.createdAt).toISOString() : new Date().toISOString(),
        expiresAt: o.expiresAt ? new Date(o.expiresAt).toISOString() : new Date().toISOString(),
        consumedAt: o.consumedAt || null,
        status: o.isUsed ? 'VERIFIED' : (new Date(o.expiresAt) < new Date() ? 'EXPIRED' : 'ACTIVE_PENDING')
      });
    }
  }

  if (memoryStore.operatorOtps) {
    for (const [t, o] of memoryStore.operatorOtps.entries()) {
      list.push({
        type: 'OPERATOR_WHATSAPP',
        target: `${o.tenantName || o.tenantSlug || 'Operator'} (+91 ${o.phone})`,
        recipient: `+91 ${o.phone}`,
        channel: 'Master WhatsApp Web',
        tenantSlug: o.tenantSlug,
        challengeToken: t,
        otpCode: o.otpCode || '******',
        isUsed: !!o.isUsed,
        attempts: o.attempts || 0,
        createdAt: o.createdAt ? new Date(o.createdAt).toISOString() : new Date().toISOString(),
        expiresAt: o.expiresAt ? new Date(o.expiresAt).toISOString() : new Date().toISOString(),
        consumedAt: o.consumedAt || null,
        status: o.isUsed ? 'VERIFIED' : (new Date(o.expiresAt) < new Date() ? 'EXPIRED' : 'ACTIVE_PENDING')
      });
    }
  }

  list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return list.slice(0, limit);
}

const createInvoice = createFormalTaxInvoice;

module.exports = {
  connectDB,
  getDevice,
  getAllDevices,
  getDevices: getAllDevices,
  saveDevice,
  updateDevice: saveDevice,
  deleteDevice,
  queueDeviceTask,
  popPendingDeviceTask,
  addLog,
  getLogs,
  getSettings,
  saveSettings,
  getTopology,
  saveTopology,
  getOlts,
  getOlt,
  saveOlt,
  deleteOlt,
  getTenants,
  getTenant,
  saveTenant,
  updateTenant,
  deleteTenant,
  getPricingPlans,
  savePricingPlan,
  getInvoices,
  createInvoice,
  createFormalTaxInvoice,
  getFiberRoutes,
  saveFiberRoute,
  deleteFiberRoute,
  getTechnicians,
  getTechnician,
  findTechnicianByUsername,
  saveTechnician,
  deleteTechnician,
  saveWhatsAppMessage,
  getWhatsAppThreads,
  getWhatsAppMessages,
  saveRefreshTokenRecord,
  getRefreshTokenByHash,
  consumeRefreshToken,
  revokeRefreshTokenFamily,
  revokeUserRefreshTokens,
  getSuperAdminByEmail,
  saveSuperAdminOtpRecord,
  getSuperAdminOtpRecord,
  incrementOtpAttempts,
  consumeSuperAdminOtpRecord,
  saveOperatorOtpRecord,
  getOperatorOtpRecord,
  incrementOperatorOtpAttempts,
  consumeOperatorOtpRecord,
  addAuditLog,
  getAuditLogs,
  getOtpLogs
};
