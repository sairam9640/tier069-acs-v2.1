const express = require('express');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const { parseSoapMessage, safeStr } = require('./soap-parser');
const {
  buildInformResponse,
  buildGetParameterValues,
  buildGetParameterNames,
  buildSetParameterValues,
  buildReboot,
  buildFactoryReset,
  buildDownload,
  buildAddObject,
  buildDeleteObject
} = require('./soap-builder');
const { normalizeDeviceData, buildSmartParamList } = require('../normalizer/parameter-mapper');
const { checkAndAlertOpticalStatus } = require('../alerts/telegram-service');
const db = require('../db/database');

// Batch size for GetParameterValues - small to avoid single-fault killing all data
const GET_PARAMS_BATCH_SIZE = 8;

function createCwmpApp(eventBus) {
  const app = express();
  app.use(cookieParser());

  const sessions = new Map();

  // Gap 4: Periodic Task Expiry Sweep (Every 2 minutes)
  setInterval(async () => {
    try {
      const expiredCount = await db.expireStaleDeviceTasks(10 * 60 * 1000);
      if (expiredCount > 0) {
        console.log(`[CWMP TASK SWEEPER] Swept and marked ${expiredCount} unreached tasks as EXPIRED.`);
      }
    } catch (e) {
      console.warn('[CWMP TASK SWEEPER ERROR]', e.message);
    }
  }, 2 * 60 * 1000);

  // Billing Queue Sweeper & Drain Job (Every 3 minutes)
  const billingSyncService = require('../billing/billing-sync-service');
  setInterval(async () => {
    try {
      const drainResult = await billingSyncService.drainBillingSyncQueue(8);
      if (drainResult.drained > 0) {
        console.log(`[BILLING QUEUE SWEEPER] Drained and delivered ${drainResult.drained} pending billing sync tasks.`);
      }
    } catch (e) {
      console.warn('[BILLING QUEUE SWEEPER ERROR]', e.message);
    }
  }, 3 * 60 * 1000);

  app.use((req, res, next) => {
    if (req.rawBody !== undefined) {
      return next();
    }
    if (req.method === 'POST') {
      let data = '';
      req.setEncoding('utf8');
      req.on('data', chunk => data += chunk);
      req.on('end', () => {
        req.rawBody = data;
        next();
      });
    } else {
      next();
    }
  });

  const cwmpHandler = async (req, res) => {
    try {
      const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
      const cleanIp = String(clientIp).replace(/^.*:/, '');

      // Session Handling
      let sessionId = req.cookies['tr069_session'];
      if (!sessionId) {
        sessionId = `SESS_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
        res.cookie('tr069_session', sessionId, { path: '/' });
      }

      // 1. Extract multi-tenant identifier from Subdomain Host header (e.g. vaishnavi.ciniplay.in:7547 or 9948046456.ciniplay.in:7547)
      const host = (req.headers.host || '').split(':')[0].toLowerCase();
      let rawSlug = 'rudra';

      if (host.endsWith('.ciniplay.in')) {
        const sub = host.replace('.ciniplay.in', '').trim();
        if (sub && sub !== 'acs' && sub !== 'api' && sub !== 'www' && sub !== 'ciniplay') {
          rawSlug = sub;
        }
      }

      // 2. Extract multi-tenant identifier from URL path fallback (e.g. /vaishnavi, /9948046456, /vgigafiber, /tr069/vaishnavi)
      const pathParts = (req.path || '/').split('/').filter(Boolean);
      const knownPrefixes = ['tr069', 'cwmp', 'acs', 'tr69', 'service'];
      if (pathParts.length > 0) {
        if (knownPrefixes.includes(pathParts[0].toLowerCase())) {
          if (pathParts[1]) rawSlug = pathParts[1].toLowerCase();
        } else if (pathParts[0].toLowerCase() !== 'rudra') {
          rawSlug = pathParts[0].toLowerCase();
        }
      }

      // 3. Resolve exact tenant from Database (supports slug, phone, username, or name)
      const resolvedTenant = await db.getTenant(rawSlug);
      const tenantSlug = resolvedTenant ? resolvedTenant.slug : (rawSlug && rawSlug !== 'default' ? rawSlug : 'rudra');

      console.log(`[CWMP HIT] 📡 ${req.method} ${req.originalUrl || req.url} | Host: ${req.headers.host} | Client IP: ${cleanIp} | Target Tenant: ${tenantSlug}`);

      let session = sessions.get(sessionId);
      if (!session) {
        session = {
          id: sessionId,
          deviceId: null,
          ip: cleanIp,
          tenantSlug,
          state: 'IDLE',
          activeTask: null,
          createdAt: Date.now()
        };
        sessions.set(sessionId, session);
      } else {
        session.tenantSlug = tenantSlug;
      }

      // Clean old sessions (>10 min)
      for (const [sId, s] of sessions.entries()) {
        if (Date.now() - s.createdAt > 10 * 60 * 1000) {
          sessions.delete(sId);
        }
      }

      // Friendly ACS verification banner for HTTP GET browser checks
      if (req.method === 'GET') {
        const tenantName = resolvedTenant ? resolvedTenant.name : (tenantSlug === 'rudra' ? 'Rudra FiberNet' : tenantSlug);
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.status(200).send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>VRV ACS Cloud TR-069 Engine</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0b0f19; color: #f8fafc; padding: 3rem 1.5rem; text-align: center; }
    .card { max-width: 620px; margin: 0 auto; background: #131b2e; border: 1px solid #1e293b; border-radius: 12px; padding: 2rem; box-shadow: 0 10px 25px rgba(0,0,0,0.5); }
    .badge { display: inline-block; background: #059669; color: #fff; font-size: 0.85rem; font-weight: 700; padding: 0.35rem 0.85rem; border-radius: 9999px; margin-bottom: 1.5rem; }
    h1 { font-size: 1.6rem; margin: 0 0 0.5rem 0; color: #fff; }
    p { color: #94a3b8; font-size: 0.95rem; line-height: 1.5; margin: 0.5rem 0; }
    .url-box { background: #0f172a; border: 1px dashed #38bdf8; color: #38bdf8; font-family: monospace; font-size: 1.1rem; padding: 0.85rem 1.25rem; border-radius: 8px; margin: 1.5rem 0; word-break: break-all; }
  </style>
</head>
<body>
  <div class="card">
    <div class="badge">● TR-069 ACS SERVICE ONLINE</div>
    <div class="url-box">${tenantSlug === 'rudra' ? 'http://ciniplay.in/' : `http://${tenantSlug}.ciniplay.in/`}</div>
    ${tenantSlug !== 'rudra' ? `<div style="font-size:0.75rem;color:#94a3b8;margin-bottom:1rem;" class="mono">🔒 Standard Listening URL: http://${tenantSlug}.ciniplay.in/</div>` : ''}
    <p style="color:#64748b;font-size:0.85rem;">Target Operator: <strong style="color:#e2e8f0;">${tenantName}</strong> | Tenant Slug: <strong style="color:#38bdf8;">${tenantSlug}</strong></p>
  </div>
</body>
</html>`);
      }

      const xmlBody = req.rawBody || '';

      if (!xmlBody || xmlBody.trim().length === 0) {
        return await handleEmptyRequest(session, res, eventBus);
      }

      const parsed = parseSoapMessage(xmlBody);
      if (!parsed) {
        return res.status(204).end();
      }

      const messageType = parsed.type;
      const cwmpId = parsed.id || '1';

      if (messageType === 'Inform') {
        return await handleInform(session, parsed.informData, cwmpId, cleanIp, res, eventBus);
      } else if (messageType === 'GetParameterValuesResponse') {
        return await handleGetParameterValuesResponse(session, parsed.parameters, cwmpId, res, eventBus);
      } else if (messageType === 'GetParameterNamesResponse') {
        return await handleGetParameterNamesResponse(session, parsed.parameterList, cwmpId, res, eventBus);
      } else if (messageType === 'SetParameterValuesResponse') {
        return await handleSetParameterValuesResponse(session, parsed.status, cwmpId, res, eventBus);
      } else if (messageType === 'RebootResponse') {
        return await handleRebootResponse(session, cwmpId, res, eventBus);
      } else if (messageType === 'FactoryResetResponse') {
        return await handleFactoryResetResponse(session, cwmpId, res, eventBus);
      } else if (messageType === 'DownloadResponse') {
        return await handleDownloadResponse(session, parsed.status, cwmpId, res, eventBus);
      } else if (messageType === 'TransferComplete') {
        return await handleTransferComplete(session, parsed.transferData, cwmpId, res, eventBus);
      } else if (messageType === 'Fault') {
        return await handleFault(session, parsed.fault, cwmpId, res, eventBus);
      } else if (messageType === 'Empty') {
        return await handleEmptyRequest(session, res, eventBus);
      } else {
        return res.status(204).end();
      }
    } catch (handlerErr) {
      console.error('[CWMP CRITICAL ERROR]', handlerErr);
      return res.status(204).end();
    }
  };

  app.all('/', cwmpHandler);
  app.all('/tr069', cwmpHandler);
  app.all('/cwmp', cwmpHandler);
  app.all('/acs', cwmpHandler);
  app.all('/tr69', cwmpHandler);
  app.all('/service', cwmpHandler);
  app.all('*', cwmpHandler);

  return app;
}

// --- Handler Functions ---

async function handleInform(session, informData, cwmpId, clientIp, res, eventBus) {
  try {
    if (!informData || !informData.deviceId) {
      return res.status(204).end();
    }

    const { manufacturer, oui, productClass, serialNumber } = informData.deviceId;
    const rawSn = String(serialNumber || oui || '').trim();

    // 1. Plausibility Validation: Must be strictly alphanumeric/dash/underscore with length 4 to 64
    if (!rawSn || rawSn === 'UNKNOWN' || rawSn.length < 4 || rawSn.length > 64 || !/^[a-zA-Z0-9_-]+$/.test(rawSn)) {
      console.warn(`[CWMP REJECT] ❌ Implausible or malformed device serial number received: "${rawSn}". Dropping Inform.`);
      return res.status(204).end();
    }

    const cleanMfr = safeStr(manufacturer, 'GENERIC').replace(/[^a-zA-Z0-9_-]/g, '_');
    const cleanSn = rawSn;
    const deviceId = `${cleanMfr}_${cleanSn}`;

    session.deviceId = deviceId;
    session.ip = clientIp;

    let isNewDevice = false;
    let existingDevice = await db.getDevice(deviceId);
    if (!existingDevice && cleanSn && cleanSn !== 'UNKNOWN') {
      const allDevs = await db.getAllDevices();
      existingDevice = allDevs.find(d => {
        const dSn = d.deviceInfo?.serialNumber || d.deviceInfo?.ponSerialNumber || d._id;
        return dSn && (dSn.includes(cleanSn) || cleanSn.includes(dSn));
      });
    }

    if (!existingDevice) {
      isNewDevice = true;
      existingDevice = {
        _id: deviceId,
        createdAt: new Date().toISOString(),
        isVerified: false,
        quarantined: true,
        quarantineReason: 'Auto-Discovered from CWMP: Awaiting Operator Verification',
        status: 'UNVERIFIED',
        customer: {
          name: 'Unassigned Customer (Pending Verification)',
          phone: '',
          accountId: '',
          address: '',
          olt: '',
          ponPort: '',
          notes: ''
        },
        rawParameters: {}
      };
    }

    const rawParams = {
      ...(existingDevice.rawParameters || {}),
      ...(informData.parameters || {})
    };

    const normalized = normalizeDeviceData(rawParams, informData.deviceId);

    const tenantSlug = session.tenantSlug || 'rudra';
    // Dynamic tenant assignment: if router hits a specific operator subdomain or URL, update tenantId immediately!
    const tenantId = (tenantSlug && tenantSlug !== 'default') 
      ? tenantSlug 
      : (existingDevice.tenantId || 'rudra');
    const tenant = await db.getTenant(tenantId);

    // Customer Auto-Enrichment: Resolve subscriber name from PPPoE username if unassigned
    let custName = existingDevice.customer?.name || '';
    if (!custName || custName === 'Unassigned Customer' || custName.startsWith('Subscriber (')) {
      const pppoeUser = (normalized.wan?.username || existingDevice.wan?.username || '').trim();
      const wifiSsid = (normalized.wifi?.wifi24?.ssid || existingDevice.wifi?.wifi24?.ssid || '').trim();
      if (pppoeUser && !pppoeUser.includes('@') && pppoeUser.length >= 3 && isNaN(Number(pppoeUser))) {
        // Capitalize / Title Case PPPoE username
        custName = pppoeUser.split(/[\s_-]+/).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
      } else if (wifiSsid && !['BSNL', 'FiberNet', 'WiFi', 'ONT'].includes(wifiSsid) && isNaN(Number(wifiSsid))) {
        custName = wifiSsid.replace(/_2\.4G$/i, '').replace(/_5G$/i, '').replace(/_/g, ' ');
      } else if (pppoeUser) {
        custName = pppoeUser;
      }
    }

    let custPhone = existingDevice.customer?.phone || '';
    if (!custPhone) {
      const wifiPass = (normalized.wifi?.wifi24?.password || existingDevice.wifi?.wifi24?.password || '').trim();
      const pppoeUser = (normalized.wan?.username || existingDevice.wan?.username || '').trim();
      if (/^[6-9]\d{9}$/.test(wifiPass)) {
        custPhone = wifiPass;
      } else if (/^[6-9]\d{9}$/.test(pppoeUser)) {
        custPhone = pppoeUser;
      }
    }

    let initialOpticalPower = existingDevice.initialOpticalPower || null;
    let lowestOpticalPower = existingDevice.lowestOpticalPower || null;
    let opticalHistory = Array.isArray(existingDevice.opticalHistory) ? existingDevice.opticalHistory : [];

    const currentRxStr = normalized.opticalPower?.rxPower;
    const currentRxNum = parseFloat(currentRxStr);
    const currentTxStr = normalized.opticalPower?.txPower || '+2.45 dBm';

    if (!isNaN(currentRxNum) && currentRxNum > -90 && currentRxNum < 0) {
      const nowIso = new Date().toISOString();

      // 1. Mandatory Baseline on First Inform with date and time
      if (!initialOpticalPower) {
        initialOpticalPower = {
          rxPower: `${currentRxNum.toFixed(2)} dBm`,
          txPower: currentTxStr,
          timestamp: nowIso
        };
      }

      // 2. Lowest (Worst) Optical Power Record
      const lowestRxNum = lowestOpticalPower ? parseFloat(lowestOpticalPower.rxPower) : 0;
      if (!lowestOpticalPower || isNaN(lowestRxNum) || currentRxNum < lowestRxNum) {
        lowestOpticalPower = {
          rxPower: `${currentRxNum.toFixed(2)} dBm`,
          txPower: currentTxStr,
          timestamp: nowIso
        };
      }

      // 3. Significant Fluctuation Tracking (Last 20 entries with >= 1.0 dB change)
      const lastSample = opticalHistory.length > 0 ? opticalHistory[opticalHistory.length - 1] : null;
      const lastRxNum = lastSample ? parseFloat(lastSample.rxPower) : null;
      const delta = (lastRxNum !== null && !isNaN(lastRxNum)) ? Math.abs(currentRxNum - lastRxNum) : 999;

      if (opticalHistory.length === 0 || delta >= 1.0) {
        const direction = (lastRxNum !== null && !isNaN(lastRxNum))
          ? (currentRxNum < lastRxNum ? 'DEGRADED' : 'IMPROVED')
          : 'BASELINE';

        opticalHistory.push({
          timestamp: nowIso,
          rxPower: `${currentRxNum.toFixed(2)} dBm`,
          txPower: currentTxStr,
          deltaDb: lastRxNum !== null ? delta.toFixed(2) : '0.00',
          direction,
          status: currentRxNum < -27 ? 'CRITICAL' : (currentRxNum < -24 ? 'MARGINAL' : 'NORMAL')
        });

        // Retain strictly the last 20 significant fluctuations
        if (opticalHistory.length > 20) {
          opticalHistory = opticalHistory.slice(-20);
        }

        // 4. Automated Instant WhatsApp Alert to Operator on Degradation (>= 1.0 dB loss or severe loss < -24.0 dBm)
        if ((delta >= 1.0 && currentRxNum < lastRxNum) || currentRxNum < -24.0) {
          try {
            const operatorPhone = tenant?.whatsappConfig?.phone || tenant?.phone || '9949666907';
            const whatsappService = require('../alerts/whatsapp-service');
            whatsappService.sendOperatorOpticalLossAlert(tenantId, operatorPhone, {
              customerName: custName || 'Subscriber',
              customerPhone: custPhone || '',
              pppoeUser: normalized.wan?.username || existingDevice.wan?.username || '',
              modelName: normalized.deviceInfo?.modelName || 'Fiber ONT',
              mac: normalized.deviceInfo?.macAddress || deviceId,
              currentRx: currentRxNum.toFixed(2),
              delta: delta < 100 ? delta.toFixed(2) : null,
              initialRx: initialOpticalPower?.rxPower,
              initialDate: new Date(initialOpticalPower?.timestamp || nowIso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
              statusNote: currentRxNum < -27 ? '🔴 Severe Fiber Attenuation Cut (< -27 dBm)' : '🟡 Significant Attenuation Drop (>= 1 dB)'
            }).catch(() => {});
          } catch (_) {}
        }
      }
    }

    const updatedDevice = {
      ...existingDevice,
      _id: existingDevice._id || deviceId,
      manufacturer: normalized.deviceInfo.manufacturer,
      modelName: normalized.deviceInfo.modelName,
      serialNumber: normalized.deviceInfo.serialNumber,
      hardwareVersion: normalized.deviceInfo.hardwareVersion,
      softwareVersion: normalized.deviceInfo.softwareVersion,
      macAddress: normalized.deviceInfo.macAddress,
      deviceInfo: normalized.deviceInfo,
      customer: {
        ...(existingDevice.customer || {}),
        name: custName || 'Subscriber',
        phone: custPhone || (existingDevice.customer?.phone || '')
      },
      opticalPower: (normalized.opticalPower?.rxPower && normalized.opticalPower.rxPower !== 'N/A') ? normalized.opticalPower : (existingDevice.opticalPower || normalized.opticalPower),
      initialOpticalPower,
      lowestOpticalPower,
      opticalHistory,
      wifi: (normalized.wifi?.wifi24?.ssid || normalized.wifi?.wifi24?.password) ? normalized.wifi : (existingDevice.wifi || normalized.wifi),
      wan: (normalized.wan?.username || normalized.wan?.ipAddress) ? normalized.wan : (existingDevice.wan || normalized.wan),
      connectedClients: (normalized.connectedClients && normalized.connectedClients.length > 0) ? normalized.connectedClients : (existingDevice.connectedClients || []),
      tenantId: tenantId,
      tenantName: tenant ? tenant.name : (tenantId === 'rudra' ? 'Rudra FiberNet' : tenantId),
      lastContact: new Date().toISOString(),
      isVerified: existingDevice.isVerified !== undefined ? existingDevice.isVerified : false,
      quarantined: existingDevice.isVerified === true ? false : true,
      quarantineReason: existingDevice.isVerified === true ? null : (existingDevice.quarantineReason || 'Auto-Discovered from CWMP: Awaiting Operator Verification'),
      status: existingDevice.isVerified === true ? 'online' : 'UNVERIFIED',
      ipAddress: clientIp,
      network: {
        ...normalized.network,
        externalIP: normalized.network.externalIP || clientIp
      },
      rawParameters: rawParams
    };

    await db.saveDevice(updatedDevice);

    if (isNewDevice) {
      await db.addAuditLog({
        event: 'DEVICE_QUARANTINED_UNVERIFIED',
        deviceId,
        tenantId,
        ip: clientIp,
        details: { manufacturer: cleanMfr, serialNumber: cleanSn, status: 'UNVERIFIED' }
      });
    }

    const eventDescriptions = (informData.events || []).map(e => {
      const code = safeStr(e?.code, '2 PERIODIC');
      if (code.includes('0 BOOTSTRAP')) return 'First Connection (Bootstrap)';
      if (code.includes('1 BOOT')) return 'Power On / Boot';
      if (code.includes('2 PERIODIC')) return 'Periodic Keepalive';
      if (code.includes('4 VALUE CHANGE')) return 'Value Changed';
      if (code.includes('6 CONNECTION REQUEST')) return 'Connection Request';
      if (code.includes('7 TRANSFER COMPLETE')) return 'Transfer Complete';
      return code;
    }).join(' | ');

    const optRx = normalized.opticalPower.rxPower !== 'N/A' ? ` | RX: ${normalized.opticalPower.rxPower}` : '';
    const optTx = normalized.opticalPower.txPower !== 'N/A' ? ` | TX: ${normalized.opticalPower.txPower}` : '';
    const wifiStr = normalized.wifi.wifi24?.ssid ? ` | WiFi: "${normalized.wifi.wifi24.ssid}"` : '';
    const wanStr = normalized.wan.username ? ` | PPPoE: "${normalized.wan.username}"` : '';

    const logMsg = `Inform: ${normalized.deviceInfo.brand.name} ${normalized.deviceInfo.modelName} [SN: ${normalized.deviceInfo.ponSerialNumber || serialNumber || 'N/A'}] | Event: ${eventDescriptions || 'Periodic'}${optRx}${optTx}${wifiStr}${wanStr}`;
    console.log(`[CWMP INFORM] ${logMsg}`);

    await db.addLog({
      type: 'INFORM',
      deviceId,
      tenantId: tenantId,
      customerName: existingDevice.customer?.name || 'Unassigned Customer',
      brand: normalized.deviceInfo.brand.name,
      model: normalized.deviceInfo.modelName,
      sn: normalized.deviceInfo.ponSerialNumber || serialNumber,
      ip: clientIp,
      events: informData.events,
      eventSummary: eventDescriptions || 'Periodic Inform',
      opticalPower: {
        rx: normalized.opticalPower.rxPower,
        tx: normalized.opticalPower.txPower,
        temp: normalized.opticalPower.temperature,
        volt: normalized.opticalPower.voltage
      },
      message: logMsg
    });

    if (eventBus) {
      eventBus.emit('device_updated', updatedDevice);
      eventBus.emit('log_added', {
        type: 'INFORM',
        deviceId,
        tenantId: tenantId,
        customerName: existingDevice.customer?.name || 'Unassigned Customer',
        brand: normalized.deviceInfo.brand.name,
        model: normalized.deviceInfo.modelName,
        sn: normalized.deviceInfo.ponSerialNumber || serialNumber,
        message: logMsg,
        opticalPower: {
          rx: normalized.opticalPower.rxPower,
          tx: normalized.opticalPower.txPower,
          temp: normalized.opticalPower.temperature,
          volt: normalized.opticalPower.voltage
        },
        ip: clientIp,
        eventSummary: eventDescriptions || 'Periodic Inform',
        timestamp: new Date().toISOString()
      });
    }

    // Real-time Optical Alert Check (Telegram)
    checkAndAlertOpticalStatus(updatedDevice, normalized.opticalPower).catch(() => {});

    // Check for Zero-Touch Auto-Provisioning (ZTP on 0 BOOTSTRAP)
    const isBootstrap = (informData.events || []).some(e => e.code && e.code.includes('0 BOOTSTRAP'));
    if (isBootstrap) {
      try {
        const settings = await db.getSettings();
        if (settings.ztp?.enabled) {
          console.log(`[ZTP] Auto-provisioning new ONT ${deviceId} (VLAN: ${settings.ztp.vlanId || 100})`);
          if (settings.ztp.vlanId) {
            await db.queueDeviceTask(deviceId, {
              type: 'SET_WAN',
              vlanId: settings.ztp.vlanId,
              username: settings.ztp.defaultPppoeUser || `isp_${(serialNumber || 'ont').slice(-6)}`,
              password: settings.ztp.defaultPppoePassword || crypto.randomBytes(4).toString('hex')
            });
          }
          const informInt = settings.ztp?.informInterval || 30;
          await db.queueDeviceTask(deviceId, {
            type: 'SET_CUSTOM_PARAM',
            parameterName: 'InternetGatewayDevice.ManagementServer.PeriodicInformInterval',
            parameterValue: String(informInt),
            parameterType: 'xsd:unsignedInt'
          });
          await db.queueDeviceTask(deviceId, {
            type: 'SET_CUSTOM_PARAM',
            parameterName: 'InternetGatewayDevice.ManagementServer.PeriodicInformEnable',
            parameterValue: '1',
            parameterType: 'xsd:boolean'
          });
          await db.addLog({
            type: 'ZTP',
            deviceId,
            customerName: updatedDevice.customer?.name || 'New Customer',
            message: `[ZTP Auto-Provisioning] Applied fast periodic inform (VLAN ${settings.ztp?.vlanId || 100}, Inform: ${informInt}s)`
          });
        }
      } catch (e) {
        console.warn('[ZTP ERROR]', e.message);
      }
    }

    // Queue parameter discovery or refresh on every inform
    const hasOpticalData = normalized.opticalPower.rxPower !== 'N/A';
    const hasWifiData = !!(normalized.wifi.wifi24?.ssid);
    const needsFullRefresh = !existingDevice.supportedParams || existingDevice.supportedParams.length === 0;

    if (needsFullRefresh) {
      // First time: discover full parameter tree
      await db.queueDeviceTask(deviceId, {
        type: 'GET_PARAM_NAMES',
        parameterPath: 'InternetGatewayDevice.',
        nextLevel: false,
        priority: 10
      });
      console.log(`[CWMP] Queued full GetParameterNames for new device ${deviceId}`);
    } else if (!hasOpticalData || !hasWifiData) {
      // Has param map but missing optical/wifi - run targeted refresh
      await queueSmartParamRefresh(deviceId, existingDevice.supportedParams || []);
      console.log(`[CWMP] Queued smart param refresh for ${deviceId} (RX missing: ${!hasOpticalData}, WiFi missing: ${!hasWifiData})`);
    }

    // Send InformResponse
    const responseXml = buildInformResponse(cwmpId, informData.maxEnvelopes || 1);
    res.setHeader('Content-Type', 'text/xml; charset=utf-8');
    res.status(200).send(responseXml);
  } catch (err) {
    console.error('[INFORM ERROR]', err);
    res.status(204).end();
  }
}

/**
 * Queue smart param refresh tasks in small batches to avoid bulk faults.
 * Each batch contains only params the device advertised in GetParameterNames.
 */
async function queueSmartParamRefresh(deviceId, supportedParams) {
  const smartList = buildSmartParamList(supportedParams);
  if (smartList.length === 0) return;

  // Split into batches of GET_PARAMS_BATCH_SIZE
  for (let i = 0; i < smartList.length; i += GET_PARAMS_BATCH_SIZE) {
    const batch = smartList.slice(i, i + GET_PARAMS_BATCH_SIZE);
    await db.queueDeviceTask(deviceId, {
      type: 'GET_PARAMS',
      parameterNames: batch,
      batchIndex: Math.floor(i / GET_PARAMS_BATCH_SIZE),
      totalBatches: Math.ceil(smartList.length / GET_PARAMS_BATCH_SIZE)
    });
  }
  console.log(`[CWMP] Queued ${Math.ceil(smartList.length / GET_PARAMS_BATCH_SIZE)} batches for ${deviceId} (${smartList.length} params)`);
}

async function handleEmptyRequest(session, res, eventBus) {
  try {
    if (!session || !session.deviceId) {
      return res.status(204).end();
    }

    const deviceId = session.deviceId;
    const task = await db.popPendingDeviceTask(deviceId);

    if (!task) {
      session.activeTask = null;
      return res.status(204).end();
    }

    session.activeTask = task;
    const msgId = `MSG_${Date.now()}`;

    res.setHeader('Content-Type', 'text/xml; charset=utf-8');

    if (task.type === 'SET_WIFI') {
      const paramsToSet = [];
      const idx = task.ssidIndex || 1;
      const baseWlanPath = `InternetGatewayDevice.LANDevice.1.WLANConfiguration.${idx}.`;

      if (task.ssid) {
        paramsToSet.push({ name: task.paramPathSSID || `${baseWlanPath}SSID`, value: task.ssid, type: 'xsd:string' });
      }
      if (task.password) {
        const passPath = task.paramPathPassword || `${baseWlanPath}KeyPassphrase`;
        paramsToSet.push({ name: passPath, value: task.password, type: 'xsd:string' });
        if (passPath.includes('PreSharedKey.1.KeyPassphrase')) {
          paramsToSet.push({ name: `${baseWlanPath}KeyPassphrase`, value: task.password, type: 'xsd:string' });
        }
        if (passPath.includes('KeyPassphrase')) {
          paramsToSet.push({ name: `${baseWlanPath}X_TP_PreSharedKey`, value: task.password, type: 'xsd:string' });
          paramsToSet.push({ name: `${baseWlanPath}PreSharedKey.1.KeyPassphrase`, value: task.password, type: 'xsd:string' });
        }
      }
      if (task.enable !== undefined) {
        const boolVal = (task.enable === true || task.enable === '1' || task.enable === 1) ? '1' : '0';
        paramsToSet.push({ name: task.paramPathEnable || `${baseWlanPath}Enable`, value: boolVal, type: 'xsd:boolean' });
      }
      if (task.hideSsid !== undefined) {
        const hideVal = (task.hideSsid === true || task.hideSsid === '1' || task.hideSsid === 1) ? '1' : '0';
        paramsToSet.push({ name: `${baseWlanPath}X_CT-COM_HideSSID`, value: hideVal, type: 'xsd:boolean' });
      }
      if (task.channel && task.paramPathChannel) {
        paramsToSet.push({ name: task.paramPathChannel, value: String(task.channel), type: 'xsd:unsignedInt' });
      }
      const xml = buildSetParameterValues(msgId, paramsToSet);
      console.log(`[CWMP] Sending SetParameterValues (WiFi SSID ${idx}) to ${deviceId}: ${paramsToSet.map(p => `${p.name}=${p.name.includes('Pass') || p.name.includes('Key') ? '***' : p.value}`).join(', ')}`);
      return res.status(200).send(xml);

    } else if (task.type === 'SET_WAN') {
      const paramsToSet = [];
      if (task.paramPathUser && task.username !== undefined) {
        paramsToSet.push({ name: task.paramPathUser, value: task.username, type: 'xsd:string' });
      }
      if (task.paramPathPass && task.password !== undefined && task.password !== '') {
        paramsToSet.push({ name: task.paramPathPass, value: task.password, type: 'xsd:string' });
      }
      if (task.paramPathVlan && task.vlanId !== undefined && task.vlanId !== 'None' && task.vlanId !== 'Untagged' && task.vlanId !== '') {
        paramsToSet.push({ name: task.paramPathVlan, value: String(task.vlanId), type: 'xsd:unsignedInt' });
      }
      const xml = buildSetParameterValues(msgId, paramsToSet);
      console.log(`[CWMP] Sending SetParameterValues (WAN) to ${deviceId}: ${paramsToSet.map(p => `${p.name}=${p.name.includes('Pass') ? '***' : p.value}`).join(', ')}`);
      return res.status(200).send(xml);

    } else if (task.type === 'DELETE_WAN') {
      const objectPath = task.objectPath || 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.';
      const xml = buildDeleteObject(msgId, objectPath);
      console.log(`[CWMP] Sending DeleteObject (${objectPath}) to ${deviceId}`);
      return res.status(200).send(xml);

    } else if (task.type === 'ADD_WAN') {
      // Step 1: Add new WAN instance or configure parameters
      const paramsToSet = [];
      if (task.params && Array.isArray(task.params)) {
        task.params.forEach(p => paramsToSet.push(p));
      } else if (task.username && task.password) {
        paramsToSet.push({ name: task.paramPathUser || 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Username', value: task.username, type: 'xsd:string' });
        paramsToSet.push({ name: task.paramPathPass || 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.Password', value: task.password, type: 'xsd:string' });
        if (task.vlanId) {
          paramsToSet.push({ name: task.paramPathVlan || 'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.X_CT-COM_VLANIDMark', value: String(task.vlanId), type: 'xsd:unsignedInt' });
        }
      }
      if (paramsToSet.length > 0) {
        const xml = buildSetParameterValues(msgId, paramsToSet);
        console.log(`[CWMP] Sending SetParameterValues (Add/Configure WAN) to ${deviceId}`);
        return res.status(200).send(xml);
      }
      return res.status(204).end();

    } else if (task.type === 'SET_CUSTOM_PARAM') {
      const paramsToSet = [{
        name: task.parameterName,
        value: task.parameterValue,
        type: task.parameterType || 'xsd:string'
      }];
      const xml = buildSetParameterValues(msgId, paramsToSet);
      return res.status(200).send(xml);

    } else if (task.type === 'REBOOT') {
      const xml = buildReboot(msgId, task.commandKey || 'PORTAL_REBOOT');
      console.log(`[CWMP] Sending Reboot command to ${deviceId}`);
      return res.status(200).send(xml);

    } else if (task.type === 'FACTORY_RESET') {
      const xml = buildFactoryReset(msgId);
      console.log(`[CWMP] Sending FactoryReset command to ${deviceId}`);
      return res.status(200).send(xml);

    } else if (task.type === 'GET_PARAM_NAMES') {
      const xml = buildGetParameterNames(msgId, task.parameterPath || 'InternetGatewayDevice.', task.nextLevel || false);
      console.log(`[CWMP] Sending GetParameterNames (${task.parameterPath || 'IGD.'}) to ${deviceId}`);
      return res.status(200).send(xml);

    } else if (task.type === 'BLOCK_MAC' || task.type === 'UNBLOCK_MAC') {
      const macListStr = (task.blockedMacs || []).join(',');
      const enabled = (task.blockedMacs || []).length > 0 ? '1' : '0';
      const paramsToSet = [
        { name: 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.MACAddressControlFilter', value: macListStr, type: 'xsd:string' },
        { name: 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.MACAddressControlEnabled', value: enabled, type: 'xsd:boolean' },
        { name: 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.2.MACAddressControlFilter', value: macListStr, type: 'xsd:string' },
        { name: 'InternetGatewayDevice.LANDevice.1.WLANConfiguration.2.MACAddressControlEnabled', value: enabled, type: 'xsd:boolean' }
      ];
      const xml = buildSetParameterValues(msgId, paramsToSet);
      console.log(`[CWMP] Sending SetParameterValues (${task.type}: ${task.macAddress || 'all'}) to ${deviceId}`);
      return res.status(200).send(xml);

    } else if (task.type === 'PING_TEST') {
      const paramsToSet = [
        { name: 'InternetGatewayDevice.IPPingDiagnostics.DiagnosticsState', value: 'Requested', type: 'xsd:string' },
        { name: 'InternetGatewayDevice.IPPingDiagnostics.Host', value: task.host || '8.8.8.8', type: 'xsd:string' },
        { name: 'InternetGatewayDevice.IPPingDiagnostics.NumberOfRepetitions', value: '4', type: 'xsd:unsignedInt' },
        { name: 'InternetGatewayDevice.IPPingDiagnostics.Timeout', value: '2000', type: 'xsd:unsignedInt' }
      ];
      const xml = buildSetParameterValues(msgId, paramsToSet);
      console.log(`[CWMP] Sending IPPingDiagnostics (${task.host || '8.8.8.8'}) to ${deviceId}`);
      return res.status(200).send(xml);

    } else if (task.type === 'SPEED_TEST') {
      const paramsToSet = [
        { name: 'InternetGatewayDevice.DownloadDiagnostics.DiagnosticsState', value: 'Requested', type: 'xsd:string' },
        { name: 'InternetGatewayDevice.DownloadDiagnostics.DownloadURL', value: task.downloadUrl || 'http://222.167.207.220/speedtest/dummy.bin', type: 'xsd:string' }
      ];
      const xml = buildSetParameterValues(msgId, paramsToSet);
      console.log(`[CWMP] Sending DownloadDiagnostics (Speed Test) to ${deviceId}`);
      return res.status(200).send(xml);

    } else if (task.type === 'GET_PARAMS') {
      const paths = task.parameterNames || [];
      if (paths.length === 0) return res.status(204).end();
      const xml = buildGetParameterValues(msgId, paths);
      const batchInfo = task.totalBatches ? ` [batch ${(task.batchIndex || 0) + 1}/${task.totalBatches}]` : '';
      console.log(`[CWMP] Sending GetParameterValues${batchInfo} (${paths.length} params) to ${deviceId}`);
      return res.status(200).send(xml);

    } else if (task.type === 'DOWNLOAD') {
      const fileType = task.fileType || '1 Firmware Upgrade Image';
      const url = task.url || '';
      const fileSize = task.fileSize || 0;
      const targetFileName = task.targetFileName || '';
      const xml = buildDownload(msgId, fileType, url, fileSize, targetFileName);
      console.log(`[CWMP] Sending Download RPC (${fileType}) to ${deviceId}: ${url}`);
      return res.status(200).send(xml);
    }

    return res.status(204).end();
  } catch (err) {
    console.error('[EMPTY REQ ERROR]', err);
    return res.status(204).end();
  }
}

async function handleGetParameterNamesResponse(session, parameterList, cwmpId, res, eventBus) {
  try {
    if (!session || !session.deviceId || !Array.isArray(parameterList)) {
      return res.status(204).end();
    }

    const deviceId = session.deviceId;
    const dev = await db.getDevice(deviceId);
    if (dev) {
      const allNames = parameterList.map(p => p.name);
      dev.supportedParams = allNames;
      await db.saveDevice(dev);

      console.log(`[CWMP] Discovered ${allNames.length} supported parameters on ${deviceId}`);

      // Build targeted list from discovered params, split into small batches
      await queueSmartParamRefresh(deviceId, allNames);
    }

    return await handleEmptyRequest(session, res, eventBus);
  } catch (err) {
    console.error('[GET PARAM NAMES RESP ERROR]', err);
    return res.status(204).end();
  }
}

async function handleGetParameterValuesResponse(session, params, cwmpId, res, eventBus) {
  try {
    if (!session || !session.deviceId || !params) {
      return res.status(204).end();
    }

    const deviceId = session.deviceId;
    const dev = await db.getDevice(deviceId);
    if (dev) {
      const keys = Object.keys(params || {});
      console.log(`[CWMP] Received ${keys.length} parameter values for ${deviceId}:`, keys.join(', '));

      dev.rawParameters = {
        ...(dev.rawParameters || {}),
        ...(params || {})
      };
      const normalized = normalizeDeviceData(dev.rawParameters, dev.deviceIdStruct || {});
      dev.deviceInfo = normalized.deviceInfo;
      dev.opticalPower = normalized.opticalPower;
      dev.opticalHistory = recordOpticalHistory(dev.opticalHistory || [], normalized.opticalPower);
      dev.wifi = normalized.wifi;
      dev.wan = normalized.wan;
      dev.connectedClients = normalized.connectedClients;
      dev.lastContact = new Date().toISOString();
      dev.status = 'online';

      // --- ISSUE 3 & GAP 5: READ-BACK VERIFICATION & 1-TIME AUTO-RETRY ---
      if (session.verifyingTask) {
        const vTask = session.verifyingTask;
        const readBackVal = params[vTask.targetPath] || dev.rawParameters[vTask.targetPath];
        const isMatched = readBackVal && String(readBackVal).trim() === String(vTask.expectedValue).trim();

        if (isMatched) {
          dev.lastTaskStatus = {
            id: vTask.id,
            type: vTask.type,
            status: 'COMPLETED',
            message: `Verified & active on hardware (${vTask.expectedValue})`,
            updatedAt: new Date().toISOString()
          };
          if (dev.wifi) dev.wifi.lastApplyFailed = false;
          if (dev.wan) dev.wan.lastApplyFailed = false;

          await db.addLog({
            type: 'CONFIG_VERIFIED',
            deviceId,
            message: `Read-back verification SUCCESS for ${vTask.type}: target value "${vTask.expectedValue}" confirmed on hardware.`
          });
          session.verifyingTask = null;
        } else {
          // Read-back mismatch detected
          if ((vTask.retryCount || 0) < 1) {
            // Gap 5: Automatic 1-time retry before marking as failed
            vTask.retryCount = 1;
            await db.queueDeviceTask(deviceId, vTask);
            dev.lastTaskStatus = {
              id: vTask.id,
              type: vTask.type,
              status: 'RETRYING',
              message: `Read-back mismatch (received "${readBackVal || 'None'}" != expected "${vTask.expectedValue}"). Retrying push...`,
              updatedAt: new Date().toISOString()
            };
            await db.addLog({
              type: 'CONFIG_RETRY',
              deviceId,
              message: `Read-back mismatch on ${deviceId} (received "${readBackVal || 'None'}"). Initiating automatic 1-time retry for ${vTask.type}...`
            });
            session.verifyingTask = null;
          } else {
            // Retry exhausted -> mark as FAILED and flag UI
            dev.lastTaskStatus = {
              id: vTask.id,
              type: vTask.type,
              status: 'FAILED',
              message: `Router rejected value: hardware returned "${readBackVal || 'Previous Value'}"`,
              updatedAt: new Date().toISOString()
            };
            if (dev.wifi) {
              dev.wifi.lastApplyFailed = true;
              dev.wifi.lastApplyError = `Router rejected value: reverted to "${readBackVal || 'hardware default'}"`;
            }
            if (dev.wan) {
              dev.wan.lastApplyFailed = true;
              dev.wan.lastApplyError = `Router rejected value: reverted to "${readBackVal || 'hardware default'}"`;
            }
            await db.addLog({
              type: 'CONFIG_FAILED',
              deviceId,
              message: `Read-back verification FAILED after retry for ${vTask.type} on ${deviceId}: expected "${vTask.expectedValue}", hardware returned "${readBackVal || 'None'}"`
            });
            session.verifyingTask = null;
          }
        }
      }

      await db.saveDevice(dev);

      const rxStr = normalized.opticalPower.rxPower;
      const txStr = normalized.opticalPower.txPower;
      const wifiStr = normalized.wifi.wifi24?.ssid || '';
      const wanStr = normalized.wan.username || '';
      console.log(`[CWMP] Updated ${deviceId}: RX=${rxStr}, TX=${txStr}, WiFi="${wifiStr}", PPPoE="${wanStr}", LAN Hosts=${normalized.connectedClients.length}`);

      if (eventBus) {
        eventBus.emit('device_updated', dev);
      }
    }

    return await handleEmptyRequest(session, res, eventBus);
  } catch (err) {
    console.error('[GET PARAMS RESP ERROR]', err);
    return res.status(204).end();
  }
}

async function handleSetParameterValuesResponse(session, status, cwmpId, res, eventBus) {
  try {
    const deviceId = session.deviceId;
    const task = session.activeTask;
    console.log(`[CWMP] SetParameterValues completed on ${deviceId} (Status: ${status})`);

    const dev = await db.getDevice(deviceId);
    if (task && (task.type === 'SET_WIFI' || task.type === 'SET_WAN')) {
      // Store verifying context on session for read-back check (Gap 5)
      session.verifyingTask = {
        ...task,
        targetPath: task.paramPathSSID || task.paramPathUser || `InternetGatewayDevice.LANDevice.1.WLANConfiguration.${task.ssidIndex || 1}.SSID`,
        expectedValue: task.ssid || task.username,
        retryCount: task.retryCount || 0
      };

      if (dev) {
        dev.lastTaskStatus = {
          id: task.id,
          type: task.type,
          status: 'VERIFYING',
          message: 'Applied in router firmware. Verifying read-back...',
          updatedAt: new Date().toISOString()
        };
        await db.saveDevice(dev);
      }

      await db.addLog({
        type: 'CONFIG_APPLIED',
        deviceId,
        message: `SetParameterValues accepted (Status ${status}) for ${task.type}. Verifying read-back...`
      });
    } else {
      await db.addLog({
        type: 'CONFIG_SUCCESS',
        deviceId,
        message: `Configuration parameters applied successfully on device ${deviceId}`
      });
    }

    return await handleEmptyRequest(session, res, eventBus);
  } catch (err) {
    console.error('[SET PARAMS RESP ERROR]', err);
    return res.status(204).end();
  }
}

async function handleRebootResponse(session, cwmpId, res, eventBus) {
  try {
    const deviceId = session.deviceId;
    console.log(`[CWMP] Reboot accepted by ${deviceId}`);
    await db.addLog({ type: 'REBOOT', deviceId, message: `Remote reboot accepted by ${deviceId}` });
    return res.status(204).end();
  } catch (err) {
    console.error('[REBOOT RESP ERROR]', err);
    return res.status(204).end();
  }
}

async function handleFactoryResetResponse(session, cwmpId, res, eventBus) {
  try {
    const deviceId = session.deviceId;
    console.log(`[CWMP] FactoryReset accepted by ${deviceId}`);
    await db.addLog({ type: 'RESET', deviceId, message: `Factory reset accepted by ${deviceId}` });
    return res.status(204).end();
  } catch (err) {
    console.error('[RESET RESP ERROR]', err);
    return res.status(204).end();
  }
}

async function handleDownloadResponse(session, status, cwmpId, res, eventBus) {
  try {
    const deviceId = session.deviceId;
    console.log(`[CWMP] Download RPC accepted by ${deviceId} (Status: ${status})`);
    await db.addLog({
      type: 'FIRMWARE_DOWNLOAD',
      deviceId,
      message: `🚀 Firmware OTA download accepted by ONT ${deviceId} (Status: ${status === '1' ? 'Downloading in background' : 'Completed'})`
    });
    return await handleEmptyRequest(session, res, eventBus);
  } catch (err) {
    console.error('[DOWNLOAD RESP ERROR]', err);
    return res.status(204).end();
  }
}

async function handleTransferComplete(session, transferData, cwmpId, res, eventBus) {
  try {
    const deviceId = session.deviceId;
    const isSuccess = (transferData?.faultCode || 0) === 0;
    const msg = isSuccess 
      ? `✅ Firmware OTA Upgrade COMPLETE on ${deviceId}! ONT is rebooting with new image.`
      : `❌ Firmware Transfer FAILED on ${deviceId}: Fault ${transferData?.faultCode} - ${transferData?.faultString}`;
    
    console.log(`[CWMP TRANSFER COMPLETE] ${msg}`);
    await db.addLog({
      type: isSuccess ? 'FIRMWARE_SUCCESS' : 'FIRMWARE_FAULT',
      deviceId,
      faultCode: transferData?.faultCode,
      faultString: transferData?.faultString,
      message: msg
    });

    if (eventBus) {
      eventBus.emit('firmware_transfer_complete', {
        deviceId,
        success: isSuccess,
        faultCode: transferData?.faultCode,
        faultString: transferData?.faultString,
        completeTime: transferData?.completeTime
      });
    }

    // Send TransferCompleteResponse
    const responseXml = `<?xml version="1.0" encoding="UTF-8"?>
<soap-env:Envelope xmlns:soap-env="http://schemas.xmlsoap.org/soap/envelope/" xmlns:cwmp="urn:dslforum-org:cwmp-1-0">
  <soap-env:Header>
    <cwmp:ID soap-env:mustUnderstand="1">${cwmpId}</cwmp:ID>
  </soap-env:Header>
  <soap-env:Body>
    <cwmp:TransferCompleteResponse/>
  </soap-env:Body>
</soap-env:Envelope>`;
    res.setHeader('Content-Type', 'text/xml; charset=utf-8');
    return res.status(200).send(responseXml);
  } catch (err) {
    console.error('[TRANSFER COMPLETE ERROR]', err);
    return res.status(204).end();
  }
}

async function handleFault(session, fault, cwmpId, res, eventBus) {
  try {
    const deviceId = session.deviceId;
    const faultCode = fault.faultCode || 9000;
    const faultString = fault.faultString || 'Unknown Fault';
    const activeTask = session.activeTask;

    const msg = `TR-069 Fault on ${deviceId}: Code ${faultCode} - ${faultString}${activeTask ? ` [during ${activeTask.type}]` : ''}`;
    console.warn(`[CWMP FAULT] ${msg}`);

    await db.addLog({
      type: 'FAULT',
      deviceId,
      faultCode,
      faultString,
      message: msg
    });

    // On Fault 9005 (Invalid parameter name) during GET_PARAMS:
    // The whole batch failed. Skip this batch and continue with next task.
    // The remaining valid params will be fetched in subsequent sessions.
    if (faultCode === 9005 && activeTask && activeTask.type === 'GET_PARAMS') {
      console.warn(`[CWMP] Fault 9005 on GET_PARAMS batch for ${deviceId}. Skipping failed batch, continuing with next task.`);
      // Don't re-queue the failed batch - just move on to fetch remaining batches
    }

    // On Fault 9005 during GET_PARAM_NAMES - try alternative root
    if (faultCode === 9005 && activeTask && activeTask.type === 'GET_PARAM_NAMES') {
      const failedPath = activeTask.parameterPath || 'InternetGatewayDevice.';
      if (failedPath.startsWith('InternetGatewayDevice.')) {
        // Try Device. (TR-181) root instead
        console.warn(`[CWMP] GET_PARAM_NAMES failed for IGD, trying Device. root for ${deviceId}`);
        await db.queueDeviceTask(deviceId, {
          type: 'GET_PARAM_NAMES',
          parameterPath: 'Device.',
          nextLevel: false
        });
      }
    }

    session.activeTask = null;
    return await handleEmptyRequest(session, res, eventBus);
  } catch (err) {
    console.error('[FAULT ERROR]', err);
    return res.status(204).end();
  }
}

/**
 * Helper to maintain a ring-buffer of the last 10 optical power change events
 * ONLY records a new entry if the optical power has actually changed (RX/TX difference).
 * If same values are reported, updates the last confirmed timestamp without creating duplicates.
 */
function recordOpticalHistory(existingHistory = [], opticalPower) {
  if (!opticalPower || !opticalPower.rxPower || opticalPower.rxPower === 'N/A') {
    return existingHistory;
  }

  const history = Array.isArray(existingHistory) ? [...existingHistory] : [];
  const now = new Date();
  const last = history[history.length - 1];

  // If there is an existing record, check if optical readings ACTUALLY CHANGED
  if (last) {
    const rxSame = String(last.rxPower || '').trim() === String(opticalPower.rxPower || '').trim();
    const txSame = String(last.txPower || '').trim() === String(opticalPower.txPower || '').trim();

    // Check numeric tolerance (< 0.08 dBm is considered identical)
    const prevRxNum = parseFloat(last.rxPower);
    const currRxNum = parseFloat(opticalPower.rxPower);
    const isNumSame = !isNaN(prevRxNum) && !isNaN(currRxNum) && Math.abs(currRxNum - prevRxNum) < 0.08;

    if ((rxSame || isNumSame) && txSame) {
      // EXACT SAME READING - DO NOT ADD A NEW DUPLICATE ENTRY
      last.lastConfirmed = now.toISOString();
      return history;
    }
  }

  // Calculate exact delta change compared to previous reading
  let trend = 'STABLE';
  let deltaStr = 'Initial Baseline';
  if (last && last.rxPower !== 'N/A' && opticalPower.rxPower !== 'N/A') {
    const prevRx = parseFloat(last.rxPower);
    const currRx = parseFloat(opticalPower.rxPower);
    if (!isNaN(prevRx) && !isNaN(currRx)) {
      const diff = currRx - prevRx;
      const sign = diff > 0 ? '+' : '';
      deltaStr = `${sign}${diff.toFixed(2)} dB`;
      if (diff >= 0.25) trend = 'IMPROVED';
      else if (diff <= -0.25) trend = 'DEGRADED';
      else trend = 'STABLE';
    }
  }

  history.push({
    timestamp: now.toISOString(),
    lastConfirmed: now.toISOString(),
    rxPower: opticalPower.rxPower,
    txPower: opticalPower.txPower,
    temperature: opticalPower.temperature,
    voltage: opticalPower.voltage,
    biasCurrent: opticalPower.biasCurrent,
    delta: deltaStr,
    trend,
    healthStatus: opticalPower.healthStatus || { status: 'Unknown', color: '#64748b', label: 'Unknown' }
  });

  // Keep only the last 10 distinct optical change events
  if (history.length > 10) {
    return history.slice(-10);
  }

  return history;
}

module.exports = {
  createCwmpApp,
  recordOpticalHistory
};
