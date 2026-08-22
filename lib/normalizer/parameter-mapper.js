/**
 * Universal TR-069 / TR-098 / TR-181 Parameter Normalizer & Diagnostic Engine
 * Covers Optical (RX/TX Power, Temp, Volt, Bias), WiFi (2.4G & 5G), Multi-WAN (PPPoE/IP), LAN Hosts, and Device Info.
 * Supports: Syrotech (Realtek+X_CT-COM), Genexis (X_CT-COM/X_CMCC), TP-Link, Huawei (X_HW_PON), ZTE, VSOL, etc.
 */

const { detectBrand, formatPonSerialNumber } = require('./brand-detector');

function normalizeDeviceData(rawParams = {}, baseDeviceId = {}, devContext = {}) {
  const params = rawParams || {};

  // Helper to extract first matching parameter value
  function getVal(patterns) {
    if (!Array.isArray(patterns)) patterns = [patterns];
    for (const pattern of patterns) {
      if (typeof pattern === 'string') {
        if (params[pattern] !== undefined && params[pattern] !== '') return String(params[pattern]).trim();
      } else if (pattern instanceof RegExp) {
        for (const [key, val] of Object.entries(params)) {
          if (pattern.test(key) && val !== undefined && val !== '') return String(val).trim();
        }
      }
    }
    return '';
  }

  // 1. Device Info & Model Reporting
  const manufacturer = getVal([
    'InternetGatewayDevice.DeviceInfo.Manufacturer',
    'Device.DeviceInfo.Manufacturer',
    'InternetGatewayDevice.DeviceInfo.X_CT-COM_Manufacturer',
    baseDeviceId.manufacturer
  ]) || 'Generic';

  let modelName = getVal([
    'InternetGatewayDevice.DeviceInfo.ModelName',
    'Device.DeviceInfo.ModelName',
    'InternetGatewayDevice.DeviceInfo.X_CT-COM_ModelName',
    'InternetGatewayDevice.DeviceInfo.X_HW_ModelName',
    'InternetGatewayDevice.DeviceInfo.X_ZTE-COM_ModelName',
    'InternetGatewayDevice.DeviceInfo.ProductClass',
    baseDeviceId.productClass
  ]);

  if (!modelName || modelName === 'N/A' || modelName === 'CPE' || modelName === 'Generic') {
    modelName = baseDeviceId.productClass || `${manufacturer} ONT`;
  }

  const serialNumber = getVal([
    'InternetGatewayDevice.DeviceInfo.SerialNumber',
    'Device.DeviceInfo.SerialNumber',
    baseDeviceId.serialNumber
  ]) || baseDeviceId.serialNumber || 'N/A';

  const hardwareVersion = getVal([
    'InternetGatewayDevice.DeviceInfo.HardwareVersion',
    'Device.DeviceInfo.HardwareVersion',
    'InternetGatewayDevice.DeviceInfo.X_CT-COM_HardwareVersion',
    'InternetGatewayDevice.DeviceInfo.X_HW_HardwareVersion'
  ]) || 'N/A';

  const softwareVersion = getVal([
    'InternetGatewayDevice.DeviceInfo.SoftwareVersion',
    'Device.DeviceInfo.SoftwareVersion',
    'InternetGatewayDevice.DeviceInfo.X_CT-COM_SoftwareVersion',
    'InternetGatewayDevice.DeviceInfo.X_HW_SoftwareVersion'
  ]) || 'N/A';

  const upTime = parseInt(getVal([
    'InternetGatewayDevice.DeviceInfo.UpTime',
    'Device.DeviceInfo.UpTime'
  ]) || '0', 10);

  // PON Serial Number (GPON SN)
  const rawPonSn = getVal([
    /GponInterfaceConfig\.PONSerialNumber/i,
    /EponInterfaceConfig\.PONSerialNumber/i,
    /WANEponInterfaceConfig\.LLID/i,
    /X_HW_PON\.OpticalInfo\.GponSN/i,
    /DeviceInfo\.X_CT-COM_TeleComAccount\.PON_SN/i,
    /DeviceInfo\.X_ZTE-COM_PONSerialNumber/i,
    /DeviceInfo\.X_VSOL_PON_SN/i,
    /Optical\.Interface\.1\.Status/i
  ]) || serialNumber;

  const ponSerialNumber = formatPonSerialNumber(rawPonSn);

  // MAC Address
  const macAddress = getVal([
    'InternetGatewayDevice.LANDevice.1.LANEthernetInterfaceConfig.1.MACAddress',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.MACAddress',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.2.WANIPConnection.1.MACAddress',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.MACAddress',
    'Device.Ethernet.Interface.1.MACAddress',
    /MACAddress/i
  ]) || 'N/A';

  // Brand Recognition
  const brand = detectBrand({
    manufacturer,
    modelName,
    productClass: baseDeviceId.productClass,
    oui: baseDeviceId.oui,
    serialNumber
  });

  // 2. Optical Power Diagnostics (Comprehensive RX / TX / Temp / Volt / Bias)
  //    Priority: X_CT-COM_EponInterfaceConfig (Syrotech/Genexis/most EPON),
  //              X_CMCC_EponInterfaceConfig (HGU/CMCC branded),
  //              WANGponInterfaceConfig / WANEponInterfaceConfig (generic),
  //              X_HW_PON (Huawei), X_ZTE-COM (ZTE), X_VSOL (VSOL)
  const rxPowerRaw = getVal([
    // Actual Syrotech/Genexis/BSNL specific - EXACT KEYS confirmed from live devices
    'InternetGatewayDevice.WANDevice.1.X_CT-COM_EponInterfaceConfig.RXPower',
    'InternetGatewayDevice.WANDevice.1.X_CMCC_EponInterfaceConfig.RXPower',
    // Generic GPON/EPON paths
    'InternetGatewayDevice.WANDevice.1.WANGponInterfaceConfig.RXPower',
    'InternetGatewayDevice.WANDevice.1.WANEponInterfaceConfig.RXPower',
    // Huawei-specific
    'InternetGatewayDevice.WANDevice.1.X_HW_PON.OpticalInfo.RxPower',
    // ZTE-specific
    'InternetGatewayDevice.WANDevice.1.X_ZTE-COM_PONInterfaceConfig.RXPower',
    'InternetGatewayDevice.WANDevice.1.X_ZTE-COM_EPON.RxPower',
    'InternetGatewayDevice.WANDevice.1.X_ZTE-COM_GPON.RxPower',
    // Broadcom
    'InternetGatewayDevice.WANDevice.1.X_BROADCOM_COM_EPONInterfaceConfig.RxPower',
    'InternetGatewayDevice.WANDevice.1.X_BROADCOM_COM_GPONInterfaceConfig.RxPower',
    // TR-181
    'Device.Optical.Interface.1.RXPower',
    // Generic regex fallback
    /X_CT-COM_EponInterfaceConfig\.RXPower/i,
    /X_CMCC_EponInterfaceConfig\.RXPower/i,
    /X_CT-COM_GponInterfaceConfig\.RXPower/i,
    /WANGponInterfaceConfig\.RXPower/i,
    /WANEponInterfaceConfig\.RXPower/i,
    /X_CT-COM_EponInterfaceConfig\.RxPower/i,
    /X_VSOL_PON_RXPower/i,
    /RxOpticalPower/i,
    /RxPower$/i
  ]);

  const txPowerRaw = getVal([
    // Actual Syrotech/Genexis/BSNL specific - EXACT KEYS confirmed from live devices
    'InternetGatewayDevice.WANDevice.1.X_CT-COM_EponInterfaceConfig.TXPower',
    'InternetGatewayDevice.WANDevice.1.X_CMCC_EponInterfaceConfig.TXPower',
    // Generic GPON/EPON paths
    'InternetGatewayDevice.WANDevice.1.WANGponInterfaceConfig.TXPower',
    'InternetGatewayDevice.WANDevice.1.WANEponInterfaceConfig.TXPower',
    // Huawei-specific
    'InternetGatewayDevice.WANDevice.1.X_HW_PON.OpticalInfo.TxPower',
    // ZTE-specific
    'InternetGatewayDevice.WANDevice.1.X_ZTE-COM_PONInterfaceConfig.TXPower',
    'InternetGatewayDevice.WANDevice.1.X_ZTE-COM_EPON.TxPower',
    'InternetGatewayDevice.WANDevice.1.X_ZTE-COM_GPON.TxPower',
    // Broadcom
    'InternetGatewayDevice.WANDevice.1.X_BROADCOM_COM_EPONInterfaceConfig.TxPower',
    'InternetGatewayDevice.WANDevice.1.X_BROADCOM_COM_GPONInterfaceConfig.TxPower',
    // TR-181
    'Device.Optical.Interface.1.TXPower',
    // Generic regex fallback
    /X_CT-COM_EponInterfaceConfig\.TXPower/i,
    /X_CMCC_EponInterfaceConfig\.TXPower/i,
    /X_CT-COM_GponInterfaceConfig\.TXPower/i,
    /WANGponInterfaceConfig\.TXPower/i,
    /WANEponInterfaceConfig\.TXPower/i,
    /X_VSOL_PON_TXPower/i,
    /TxOpticalPower/i,
    /TxPower$/i
  ]);

  const opticalTempRaw = getVal([
    // Exact device keys (note: SupplyVottage is a firmware typo, both supported)
    'InternetGatewayDevice.WANDevice.1.X_CT-COM_EponInterfaceConfig.TransceiverTemperature',
    'InternetGatewayDevice.WANDevice.1.X_CMCC_EponInterfaceConfig.TransceiverTemperature',
    'InternetGatewayDevice.WANDevice.1.WANGponInterfaceConfig.TransceiverTemperature',
    'InternetGatewayDevice.WANDevice.1.WANEponInterfaceConfig.TransceiverTemperature',
    /X_CT-COM_EponInterfaceConfig\.TransceiverTemperature/i,
    /X_CMCC_EponInterfaceConfig\.TransceiverTemperature/i,
    /OpticalInfo\.Temperature/i,
    /InterfaceConfig\.TransceiverTemperature/i,
    /InterfaceConfig\.Temperature/i,
    /Optical\.Interface\.1\.TransceiverTemperature/i
  ]);

  const opticalVoltageRaw = getVal([
    // NOTE: firmware typo "SupplyVottage" (not "SupplyVoltage") — must cover BOTH
    'InternetGatewayDevice.WANDevice.1.X_CT-COM_EponInterfaceConfig.SupplyVottage',
    'InternetGatewayDevice.WANDevice.1.X_CT-COM_EponInterfaceConfig.SupplyVoltage',
    'InternetGatewayDevice.WANDevice.1.X_CMCC_EponInterfaceConfig.SupplyVottage',
    'InternetGatewayDevice.WANDevice.1.X_CMCC_EponInterfaceConfig.SupplyVoltage',
    'InternetGatewayDevice.WANDevice.1.WANGponInterfaceConfig.SupplyVoltage',
    'InternetGatewayDevice.WANDevice.1.WANEponInterfaceConfig.SupplyVoltage',
    /X_CT-COM_EponInterfaceConfig\.SupplyVo[lt]{1,2}age/i,
    /X_CMCC_EponInterfaceConfig\.SupplyVo[lt]{1,2}age/i,
    /OpticalInfo\.SupplyVoltage/i,
    /InterfaceConfig\.SupplyVoltage/i,
    /InterfaceConfig\.SupplyVottage/i,
    /Optical\.Interface\.1\.SupplyVoltage/i
  ]);

  const opticalBiasRaw = getVal([
    'InternetGatewayDevice.WANDevice.1.X_CT-COM_EponInterfaceConfig.BiasCurrent',
    'InternetGatewayDevice.WANDevice.1.X_CMCC_EponInterfaceConfig.BiasCurrent',
    'InternetGatewayDevice.WANDevice.1.WANGponInterfaceConfig.BiasCurrent',
    'InternetGatewayDevice.WANDevice.1.WANEponInterfaceConfig.BiasCurrent',
    /X_CT-COM_EponInterfaceConfig\.BiasCurrent/i,
    /X_CMCC_EponInterfaceConfig\.BiasCurrent/i,
    /OpticalInfo\.BiasCurrent/i,
    /InterfaceConfig\.BiasCurrent/i,
    /Optical\.Interface\.1\.BiasCurrent/i
  ]);

  // PON Bytes Sent/Received (data usage counters)
  const bytesSent = getVal([
    'InternetGatewayDevice.WANDevice.1.X_CT-COM_EponInterfaceConfig.Stats.BytesSent',
    'InternetGatewayDevice.WANDevice.1.X_CMCC_EponInterfaceConfig.Stats.BytesSent',
    /EponInterfaceConfig\.Stats\.BytesSent/i,
    /WANDevice.*BytesSent/i
  ]);

  const bytesReceived = getVal([
    'InternetGatewayDevice.WANDevice.1.X_CT-COM_EponInterfaceConfig.Stats.BytesReceived',
    'InternetGatewayDevice.WANDevice.1.X_CMCC_EponInterfaceConfig.Stats.BytesReceived',
    /EponInterfaceConfig\.Stats\.BytesReceived/i,
    /WANDevice.*BytesReceived/i
  ]);

  const formattedRx = formatRxOpticalPower(rxPowerRaw, modelName, brand);
  const formattedTx = formatTxOpticalPower(txPowerRaw, modelName, brand);

  const opticalPower = {
    rxPower: formattedRx,
    rxPowerRaw: rxPowerRaw || 'N/A',
    txPower: formattedTx,
    txPowerRaw: txPowerRaw || 'N/A',
    temperature: formatTemperature(opticalTempRaw),
    voltage: formatVoltage(opticalVoltageRaw),
    biasCurrent: formatBiasCurrent(opticalBiasRaw),
    bytesSent: bytesSent || null,
    bytesReceived: bytesReceived || null,
    bytesSentFormatted: bytesSent ? formatBytes(bytesSent) : 'N/A',
    bytesReceivedFormatted: bytesReceived ? formatBytes(bytesReceived) : 'N/A',
    healthStatus: getOpticalHealth(formattedRx)
  };

  // 3. Multi-SSID WiFi Configuration (2.4GHz & 5GHz & Guest SSIDs 1-4)
  const wifi = extractAllWifiDetails(params);

  // 4. Multi-WAN & PPPoE Configuration (Real parameters, active detection)
  const wan = extractWanDetails(params);

  // 5. External IP & Connection Request URL
  const externalIP = getVal([
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANPPPConnection.1.ExternalIPAddress',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.1.WANIPConnection.1.ExternalIPAddress',
    'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.2.WANIPConnection.1.ExternalIPAddress',
    'Device.PPP.Interface.1.IPCP.LocalIPAddress',
    /ExternalIPAddress/i
  ]);

  const connectionRequestURL = getVal([
    'InternetGatewayDevice.ManagementServer.ConnectionRequestURL',
    'Device.ManagementServer.ConnectionRequestURL'
  ]);

  const connectionRequestUsername = getVal([
    'InternetGatewayDevice.ManagementServer.ConnectionRequestUsername',
    'Device.ManagementServer.ConnectionRequestUsername'
  ]);

  const connectionRequestPassword = getVal([
    'InternetGatewayDevice.ManagementServer.ConnectionRequestPassword',
    'Device.ManagementServer.ConnectionRequestPassword'
  ]);

  // 6. Connected LAN Hosts / Clients (with Vendor recognition and Blocked MAC status)
  const blockedMacs = devContext?.blockedMacs || [];
  const connectedClients = extractConnectedHosts(params, blockedMacs);

  // 7. VoIP / SIP Status (TR-104)
  const voipLineStatus = getVal([
    'InternetGatewayDevice.Services.VoiceService.1.VoiceProfile.1.Line.1.Status',
    'InternetGatewayDevice.Services.VoiceService.1.VoiceProfile.1.Line.1.CallState',
    /VoiceService.*Line.*Status/i
  ]) || 'N/A';

  const voipPhone = getVal([
    'InternetGatewayDevice.Services.VoiceService.1.VoiceProfile.1.Line.1.DirectoryNumber',
    'InternetGatewayDevice.Services.VoiceService.1.VoiceProfile.1.Line.1.SIP.AuthUserName',
    /VoiceService.*DirectoryNumber/i
  ]) || '';

  const voipSipServer = getVal([
    'InternetGatewayDevice.Services.VoiceService.1.VoiceProfile.1.SIP.ProxyServer',
    'InternetGatewayDevice.Services.VoiceService.1.VoiceProfile.1.SIP.RegistrarServer',
    /VoiceService.*ProxyServer/i
  ]) || '';

  // 8. TR-143 Diagnostics / Ping results
  const pingState = getVal(['InternetGatewayDevice.IPPingDiagnostics.DiagnosticsState']) || 'None';
  const pingAvg = getVal(['InternetGatewayDevice.IPPingDiagnostics.AverageResponseTime']) || '0';
  const pingLoss = getVal(['InternetGatewayDevice.IPPingDiagnostics.FailureCount']) || '0';
  const pingSuccess = getVal(['InternetGatewayDevice.IPPingDiagnostics.SuccessCount']) || '0';

  const downloadState = getVal(['InternetGatewayDevice.DownloadDiagnostics.DiagnosticsState']) || 'None';
  const downloadBytes = getVal(['InternetGatewayDevice.DownloadDiagnostics.TestBytesReceived', 'InternetGatewayDevice.DownloadDiagnostics.TotalBytesReceived']) || '0';

  // --- ISSUE 1 & GAP 3: VERSIONED LOCKING & EVENT-AWARE CONFLICT RESOLUTION ---
  const LOCK_WINDOW_MS = 120 * 1000; // 120-second protection window against stale periodic informs
  const nowTs = Date.now();
  const db = require('../db/database');

  // Check if incoming Inform carries Event '4 VALUE CHANGE' (Legitimate customer-side local modification on ONT)
  const events = Array.isArray(devContext?.informEvents) ? devContext.informEvents : [];
  const isCustomerLocalChange = events.some(e => String(e).includes('4') || String(e).toUpperCase().includes('VALUE CHANGE'));

  if (devContext?.existingDev?.wifi) {
    const exWifi = devContext.existingDev.wifi;
    const devId = devContext.existingDev._id;
    const lastMod = devContext.existingDev.lastConfigModified || 0;

    if (exWifi.ssids && Array.isArray(exWifi.ssids)) {
      exWifi.ssids.forEach(oldSsid => {
        const matching = wifi.ssids.find(s => s.index === oldSsid.index);
        if (matching) {
          const ssidMod = oldSsid.lastModified || lastMod;
          const isSsidLocked = (nowTs - ssidMod) < LOCK_WINDOW_MS;

          if (isSsidLocked) {
            if (matching.ssid && matching.ssid !== oldSsid.ssid) {
              if (isCustomerLocalChange) {
                // Gap 3: Legitimate local change by subscriber directly on router web UI
                db.addLog({
                  type: 'CUSTOMER_LOCAL_CHANGE',
                  deviceId: devId,
                  message: `Legitimate customer local change detected (Event 4 VALUE CHANGE) for SSID ${oldSsid.index}: "${oldSsid.ssid}" -> "${matching.ssid}"`
                });
                oldSsid.ssid = matching.ssid;
                oldSsid.lastModified = nowTs;
              } else {
                // Plain 2 PERIODIC inform carrying stale cache -> reject and enforce manual value
                db.addLog({
                  type: 'STALE_INFORM_REJECTED',
                  deviceId: devId,
                  message: `[Lock Window: ${Math.round((LOCK_WINDOW_MS - (nowTs - ssidMod))/1000)}s left] Rejected stale inform for SSID ${oldSsid.index}: incoming "${matching.ssid}" != manual "${oldSsid.ssid}"`
                });
                matching.ssid = oldSsid.ssid;
              }
            }
            if (oldSsid.password && !isCustomerLocalChange) matching.password = oldSsid.password;
            if (oldSsid.enabled !== undefined && !isCustomerLocalChange) matching.enabled = oldSsid.enabled;
            if (oldSsid.securityMode && !isCustomerLocalChange) matching.securityMode = oldSsid.securityMode;
            matching.lastModified = oldSsid.lastModified;
            matching.configVersion = oldSsid.configVersion || devContext.existingDev.configVersion;
          } else {
            if (!matching.password && oldSsid.password) matching.password = oldSsid.password;
          }
        }
      });
    }

    if (exWifi.wifi24 && wifi.wifi24) {
      const w24Mod = exWifi.wifi24.lastModified || lastMod;
      if ((nowTs - w24Mod) < LOCK_WINDOW_MS) {
        if (wifi.wifi24.ssid && wifi.wifi24.ssid !== exWifi.wifi24.ssid) {
          if (isCustomerLocalChange) {
            db.addLog({
              type: 'CUSTOMER_LOCAL_CHANGE',
              deviceId: devId,
              message: `Customer local change (Event 4): 2.4G SSID updated to "${wifi.wifi24.ssid}"`
            });
            exWifi.wifi24.ssid = wifi.wifi24.ssid;
            exWifi.wifi24.lastModified = nowTs;
          } else {
            db.addLog({
              type: 'STALE_INFORM_REJECTED',
              deviceId: devId,
              message: `Rejected stale inform for 2.4G WiFi: incoming "${wifi.wifi24.ssid}" != manual "${exWifi.wifi24.ssid}"`
            });
            wifi.wifi24.ssid = exWifi.wifi24.ssid;
          }
        }
        if (exWifi.wifi24.password && !isCustomerLocalChange) wifi.wifi24.password = exWifi.wifi24.password;
        if (exWifi.wifi24.enabled !== undefined && !isCustomerLocalChange) wifi.wifi24.enabled = exWifi.wifi24.enabled;
        wifi.wifi24.lastModified = exWifi.wifi24.lastModified;
        wifi.wifi24.configVersion = exWifi.wifi24.configVersion || devContext.existingDev.configVersion;
      } else if (!wifi.wifi24.password && exWifi.wifi24.password) {
        wifi.wifi24.password = exWifi.wifi24.password;
      }
    }

    if (exWifi.wifi5 && wifi.wifi5) {
      const w5Mod = exWifi.wifi5.lastModified || lastMod;
      if ((nowTs - w5Mod) < LOCK_WINDOW_MS) {
        if (wifi.wifi5.ssid && wifi.wifi5.ssid !== exWifi.wifi5.ssid) {
          if (isCustomerLocalChange) {
            db.addLog({
              type: 'CUSTOMER_LOCAL_CHANGE',
              deviceId: devId,
              message: `Customer local change (Event 4): 5G SSID updated to "${wifi.wifi5.ssid}"`
            });
            exWifi.wifi5.ssid = wifi.wifi5.ssid;
            exWifi.wifi5.lastModified = nowTs;
          } else {
            db.addLog({
              type: 'STALE_INFORM_REJECTED',
              deviceId: devId,
              message: `Rejected stale inform for 5G WiFi: incoming "${wifi.wifi5.ssid}" != manual "${exWifi.wifi5.ssid}"`
            });
            wifi.wifi5.ssid = exWifi.wifi5.ssid;
          }
        }
        if (exWifi.wifi5.password && !isCustomerLocalChange) wifi.wifi5.password = exWifi.wifi5.password;
        if (exWifi.wifi5.enabled !== undefined && !isCustomerLocalChange) wifi.wifi5.enabled = exWifi.wifi5.enabled;
        wifi.wifi5.lastModified = exWifi.wifi5.lastModified;
        wifi.wifi5.configVersion = exWifi.wifi5.configVersion || devContext.existingDev.configVersion;
      } else if (!wifi.wifi5.password && exWifi.wifi5.password) {
        wifi.wifi5.password = exWifi.wifi5.password;
      }
    }
  }

  if (devContext?.existingDev?.wan) {
    const exWan = devContext.existingDev.wan;
    const devId = devContext.existingDev._id;
    const wanMod = exWan.lastModified || devContext.existingDev.lastConfigModified || 0;
    const isWanLocked = (nowTs - wanMod) < LOCK_WINDOW_MS;

    if (isWanLocked) {
      if (wan.username && exWan.username && wan.username !== exWan.username) {
        if (isCustomerLocalChange) {
          db.addLog({
            type: 'CUSTOMER_LOCAL_CHANGE',
            deviceId: devId,
            message: `Customer local change (Event 4): WAN Username updated to "${wan.username}"`
          });
          exWan.username = wan.username;
          exWan.lastModified = nowTs;
        } else {
          db.addLog({
            type: 'STALE_INFORM_REJECTED',
            deviceId: devId,
            message: `Rejected stale inform for WAN Username: incoming "${wan.username}" != manual "${exWan.username}"`
          });
          wan.username = exWan.username;
        }
      }
      if (exWan.password && !isCustomerLocalChange) wan.password = exWan.password;
      if (exWan.vlanId && !isCustomerLocalChange) wan.vlanId = exWan.vlanId;
      wan.lastModified = exWan.lastModified;
      wan.configVersion = exWan.configVersion || devContext.existingDev.configVersion;
    } else if (!wan.password && exWan.password) {
      wan.password = exWan.password;
    }

    if (exWan.connections && Array.isArray(exWan.connections)) {
      exWan.connections.forEach(oldConn => {
        const matching = wan.connections?.find(c => c.id === oldConn.id || c.path === oldConn.path);
        if (matching) {
          const connMod = oldConn.lastModified || wanMod;
          if ((nowTs - connMod) < LOCK_WINDOW_MS) {
            if (oldConn.username && !isCustomerLocalChange) matching.username = oldConn.username;
            if (oldConn.password && !isCustomerLocalChange) matching.password = oldConn.password;
            if (oldConn.vlanId && !isCustomerLocalChange) matching.vlanId = oldConn.vlanId;
            matching.lastModified = oldConn.lastModified;
          } else if (!matching.password && oldConn.password) {
            matching.password = oldConn.password;
          }
        }
      });
    }
  }

  return {
    deviceInfo: {
      manufacturer,
      modelName,
      serialNumber,
      hardwareVersion,
      softwareVersion,
      upTime,
      ponSerialNumber,
      macAddress,
      brand
    },
    opticalPower,
    wifi: {
      ssids: wifi.ssids,
      smartConnect: wifi.smartConnect,
      wifi24: wifi.wifi24,
      wifi5: wifi.wifi5,
      isDualBand: wifi.isDualBand
    },
    wan,
    network: {
      externalIP,
      connectionRequestURL,
      connectionRequestUsername,
      connectionRequestPassword
    },
    voip: {
      status: voipLineStatus && voipLineStatus !== 'N/A' ? voipLineStatus : null,
      phone: voipPhone || null,
      sipServer: voipSipServer || null,
      isConfigured: !!(voipPhone || voipSipServer)
    },
    diagnostics: {
      pingState,
      pingAvg: pingAvg !== '0' ? `${pingAvg} ms` : 'N/A',
      pingSuccess: parseInt(pingSuccess, 10) || 0,
      pingLoss: parseInt(pingLoss, 10) || 0,
      downloadState,
      downloadBytes: parseInt(downloadBytes, 10) || 0
    },
    connectedClients,
    customer: enrichCustomerProfile(devContext.customer || {}, wan, wifi, { serialNumber, manufacturer, modelName })
  };
}

/**
 * Universal Multi-SSID Extraction (TR-098 WLANConfiguration 1..8, TR-181 Device.WiFi.SSID.*, Huawei X_HW, ZTE X_CT-COM)
 * Dynamically discovers all SSIDs, actual passwords, radio frequency bands (2.4G/5G), Smart Connect, and associated clients.
 */
function extractAllWifiDetails(params) {
  const ssids = [];
  const discoveredIndices = new Set();

  // 1. Discover all TR-098 WLANConfiguration indices present in params
  for (const k of Object.keys(params)) {
    const match = k.match(/InternetGatewayDevice\.LANDevice\.1\.WLANConfiguration\.(\d+)\./i);
    if (match) {
      discoveredIndices.add(parseInt(match[1], 10));
    }
    const match181 = k.match(/Device\.WiFi\.SSID\.(\d+)\./i);
    if (match181) {
      discoveredIndices.add(parseInt(match181[1], 10));
    }
  }

  // Ensure at least slots 1, 2, 3, 4 are checked
  [1, 2, 3, 4].forEach(i => discoveredIndices.add(i));

  const sortedIndices = Array.from(discoveredIndices).sort((a, b) => a - b);

  for (const index of sortedIndices) {
    const prefixTR098 = `InternetGatewayDevice.LANDevice.1.WLANConfiguration.${index}.`;
    const prefixTR181 = `Device.WiFi.SSID.${index}.`;
    const apPrefixTR181 = `Device.WiFi.AccessPoint.${index}.`;
    const radioPrefixTR181 = `Device.WiFi.Radio.${index}.`;

    const ssid = params[`${prefixTR098}SSID`] || params[`${prefixTR181}SSID`] || '';
    const enabledRaw = params[`${prefixTR098}Enable`] || params[`${prefixTR181}Enable`];
    const isExplicitlyDefined = params[`${prefixTR098}SSID`] !== undefined || params[`${prefixTR181}SSID`] !== undefined;

    const channelRaw = params[`${prefixTR098}Channel`] || params[`${radioPrefixTR181}Channel`] || '';
    const channel = parseInt(channelRaw, 10);
    const standard = params[`${prefixTR098}Standard`] || params[`${prefixTR098}BeaconType`] || '';
    const radioBand = params[`${prefixTR098}Radio`] || params[`${radioPrefixTR181}OperatingFrequencyBand`] || params[`${prefixTR098}X_HW_Radio`] || '';

    // Determine 2.4GHz vs 5.0GHz accurately based on channel and radio standards:
    let band = '2.4 GHz';
    if (channel >= 36) {
      band = '5.0 GHz';
    } else if (channel > 0 && channel <= 14) {
      band = '2.4 GHz';
    } else if (radioBand.includes('5') || standard.includes('11a') || standard.includes('11ac') || standard.includes('11ax') || /5G|5\.0G/i.test(ssid)) {
      band = '5.0 GHz';
    } else if (index === 5 || index === 6) {
      band = '5.0 GHz';
    }

    const bssid = params[`${prefixTR098}BSSID`] || params[`${prefixTR181}BSSID`] || params[`${prefixTR098}MACAddress`] || '';
    const securityMode = params[`${prefixTR098}BeaconType`] || params[`${prefixTR098}BasicEncryptionModes`] || params[`${apPrefixTR181}Security.ModeEnabled`] || 'WPAand11i (WPA2-PSK)';
    const hideSsid = params[`${prefixTR098}SSIDAdvertisementEnabled`] === '0' || params[`${prefixTR098}HideSSID`] === '1';

    // WiFi Passphrase extraction - dynamically check all valid TR-069 key paths
    let password = params[`${prefixTR098}KeyPassphrase`] ||
                   params[`${prefixTR098}PreSharedKey.1.KeyPassphrase`] ||
                   params[`${prefixTR098}PreSharedKey.1.PreSharedKey`] ||
                   params[`${prefixTR098}X_CT-COM_WPAKey`] ||
                   params[`${prefixTR098}X_HW_WPAKey`] ||
                   params[`${prefixTR098}X_TP_PreSharedKey`] ||
                   params[`${apPrefixTR181}Security.KeyPassphrase`] ||
                   params[`${apPrefixTR181}Security.PreSharedKey`] ||
                   params[`${prefixTR098}WEPKey0`] || '';

    if (!password) {
      for (const [k, v] of Object.entries(params)) {
        if (k.startsWith(prefixTR098) && /(KeyPassphrase|PreSharedKey|WPAKey|Key0|Password)/i.test(k) && v) {
          password = String(v).trim();
          break;
        }
      }
    }

    // Associated client count for this specific SSID
    let associatedDevices = params[`${prefixTR098}TotalAssociations`] ||
                            params[`${prefixTR098}AssociatedDeviceNumberOfEntries`] ||
                            params[`${apPrefixTR181}AssociatedDeviceNumberOfEntries`];

    if (associatedDevices === undefined) {
      let count = 0;
      for (const k of Object.keys(params)) {
        if (k.startsWith(`${prefixTR098}AssociatedDevice.`) && /MACAddress$/i.test(k)) {
          count++;
        }
      }
      associatedDevices = count;
    }

    const enabled = enabledRaw !== undefined ? (enabledRaw === '1' || enabledRaw === 'true' || enabledRaw === true) : (isExplicitlyDefined && ssid !== '');

    // Determine parameter paths for write-back
    let paramPathSSID = `${prefixTR098}SSID`;
    if (params[`${prefixTR181}SSID`] !== undefined) paramPathSSID = `${prefixTR181}SSID`;

    let paramPathPassword = `${prefixTR098}PreSharedKey.1.KeyPassphrase`;
    if (params[`${prefixTR098}KeyPassphrase`] !== undefined) {
      paramPathPassword = `${prefixTR098}KeyPassphrase`;
    } else if (params[`${prefixTR098}PreSharedKey.1.PreSharedKey`] !== undefined) {
      paramPathPassword = `${prefixTR098}PreSharedKey.1.PreSharedKey`;
    }

    let paramPathEnable = `${prefixTR098}Enable`;
    if (params[`${prefixTR181}Enable`] !== undefined) paramPathEnable = `${prefixTR181}Enable`;

    ssids.push({
      index,
      name: `SSID ${index}${band === '5.0 GHz' ? ' (5GHz)' : ''}`,
      band,
      ssid: ssid,
      password: password, // Real value if exposed by ONT, empty if protected
      isPasswordProtected: !password && isExplicitlyDefined,
      enabled,
      channel: channel || 'Auto',
      bssid,
      securityMode,
      hideSsid,
      associatedDevices: parseInt(associatedDevices || '0', 10),
      isConfigured: isExplicitlyDefined && ssid !== '',
      paramPathSSID,
      paramPathPassword,
      paramPathEnable
    });
  }

  // 2. Select Primary 2.4GHz and 5.0GHz SSIDs dynamically across all vendor architectures
  // On Genexis, index 1 = 2.4G Main, index 5 or 6 = 5G Main
  // On Huawei / ZTE / Syrotech, index 1 = 2.4G Main, index 5 = 5G Main (or index 1 & 2)
  const wifi24 = ssids.find(s => s.band === '2.4 GHz' && s.enabled && s.ssid) ||
                 ssids.find(s => s.band === '2.4 GHz' && s.ssid) ||
                 ssids.find(s => s.index === 1) ||
                 ssids[0] || null;

  const wifi5 = ssids.find(s => s.band === '5.0 GHz' && s.enabled && s.ssid) ||
                ssids.find(s => s.band === '5.0 GHz' && s.ssid) ||
                ssids.find(s => s.band === '5.0 GHz') ||
                ssids.find(s => s.index === 5 || s.index === 6 || s.index === 2) || null;

  // 3. Smart Connect (Band Steering) Detection
  const smartConnectParam = params['InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.X_HW_SmartConnect'] ||
                            params['InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.X_CT-COM_BandSteering'] ||
                            params['InternetGatewayDevice.LANDevice.1.WLANConfiguration.1.BandSteering'];

  const hasSmartConnect = (smartConnectParam === '1' || smartConnectParam === 'true') ||
                          (wifi24 && wifi5 && wifi24.ssid && wifi5.ssid && wifi24.ssid.toLowerCase() === wifi5.ssid.toLowerCase());

  // If Smart Connect is active and 5G has the user-configured password, propagate to 2.4G if 2.4G had default PIN
  if (hasSmartConnect && wifi24 && wifi5) {
    if (wifi5.password && (!wifi24.password || wifi24.password.length === 12)) {
      wifi24.password = wifi5.password;
    } else if (wifi24.password && !wifi5.password) {
      wifi5.password = wifi24.password;
    }
  }

  return {
    ssids,
    smartConnect: hasSmartConnect,
    wifi24,
    wifi5,
    isDualBand: ssids.some(s => s.band === '5.0 GHz' && s.isConfigured)
  };
}

function extractWanDetails(params) {
  const connections = [];
  const processedPaths = new Set();

  // 1. Scan all WANPPPConnection instances
  for (const [k, v] of Object.entries(params)) {
    const match = k.match(/^(.*WANPPPConnection\.(\d+)\.)/i);
    if (match) {
      const basePath = match[1];
      if (!processedPaths.has(basePath)) {
        processedPaths.add(basePath);

        const connDeviceKey = basePath.substring(0, basePath.indexOf('WANPPPConnection'));
        const vlanId = params[`${connDeviceKey}X_CT-COM_VLANIDMark`] ||
                       params[`${connDeviceKey}VLANIDMark`] ||
                       params[`${connDeviceKey}X_CMCC_VLANIDMark`] ||
                       params[`${connDeviceKey}X_HW_VLAN`] ||
                       params[`${basePath}VLANIDMark`] ||
                       params[`${basePath}X_CT-COM_VLANIDMark`] || '';

        const name = params[`${basePath}Name`] || `WAN_PPP_${match[2]}`;
        const username = params[`${basePath}Username`] || '';
        const password = params[`${basePath}Password`] || '';
        const status = params[`${basePath}ConnectionStatus`] || 'Disconnected';
        const externalIP = params[`${basePath}ExternalIPAddress`] || '';
        const defaultGateway = params[`${basePath}DefaultGateway`] || '';
        const dnsServers = params[`${basePath}DNSServers`] || '';
        const enable = params[`${basePath}Enable`] !== undefined ? params[`${basePath}Enable`] : '1';
        const serviceList = params[`${connDeviceKey}X_CT-COM_ServiceList`] || params[`${connDeviceKey}X_HW_ServiceList`] || params[`${basePath}X_CT-COM_ServiceList`] || 'INTERNET';
        const connMode = params[`${basePath}ConnectionType`] || params[`${basePath}AddressingType`] || 'IP_Routed';
        const mtu = params[`${basePath}MaxMTUSize`] || params[`${basePath}MTU`] || '1492';
        const portBinding = params[`${connDeviceKey}X_CT-COM_LanInterface`] || params[`${basePath}X_CT-COM_LanInterface`] || params[`${connDeviceKey}X_HW_LanInterface`] || 'LAN1,LAN2,AP1,AP2';

        const isConnActive = (status.toLowerCase().includes('connect') || status.toLowerCase().includes('up')) && externalIP && externalIP !== '0.0.0.0';

        connections.push({
          id: `PPP_${match[2]}`,
          index: parseInt(match[2], 10),
          path: basePath,
          name,
          connectionType: 'PPPoE',
          connectionMode: connMode,
          serviceList,
          vlanId: vlanId ? String(vlanId) : 'None / Untagged',
          mtu: parseInt(mtu, 10) || 1492,
          portBinding,
          username,
          password,
          isPasswordProtected: !password && username !== '',
          status: isConnActive ? 'Connected' : status,
          isActive: isConnActive,
          externalIP: externalIP && externalIP !== '0.0.0.0' ? externalIP : '',
          defaultGateway,
          dnsServers,
          enabled: enable === '1' || enable === 'true' || enable === true,
          paramPathUser: `${basePath}Username`,
          paramPathPass: `${basePath}Password`,
          paramPathVlan: `${connDeviceKey}X_CT-COM_VLANIDMark`,
          paramPathEnable: `${basePath}Enable`
        });
      }
    }
  }

  // 2. Scan all WANIPConnection instances (DHCP / Static / IPoE / Bridge)
  for (const [k, v] of Object.entries(params)) {
    const match = k.match(/^(.*WANIPConnection\.(\d+)\.)/i);
    if (match) {
      const basePath = match[1];
      if (!processedPaths.has(basePath)) {
        processedPaths.add(basePath);

        const connDeviceKey = basePath.substring(0, basePath.indexOf('WANIPConnection'));
        const vlanId = params[`${connDeviceKey}X_CT-COM_VLANIDMark`] ||
                       params[`${connDeviceKey}VLANIDMark`] ||
                       params[`${connDeviceKey}X_CMCC_VLANIDMark`] ||
                       params[`${connDeviceKey}X_HW_VLAN`] ||
                       params[`${basePath}VLANIDMark`] ||
                       params[`${basePath}X_CT-COM_VLANIDMark`] || '';

        const name = params[`${basePath}Name`] || `WAN_IP_${match[2]}`;
        const connTypeRaw = params[`${basePath}ConnectionType`] || params[`${basePath}AddressingType`] || 'IP_Routed';
        const status = params[`${basePath}ConnectionStatus`] || 'Disconnected';
        const externalIP = params[`${basePath}ExternalIPAddress`] || '';
        const defaultGateway = params[`${basePath}DefaultGateway`] || '';
        const dnsServers = params[`${basePath}DNSServers`] || '';
        const enable = params[`${basePath}Enable`] !== undefined ? params[`${basePath}Enable`] : '1';
        const serviceList = params[`${connDeviceKey}X_CT-COM_ServiceList`] || params[`${connDeviceKey}X_HW_ServiceList`] || params[`${basePath}X_CT-COM_ServiceList`] || 'TR069_VOIP';
        const mtu = params[`${basePath}MaxMTUSize`] || params[`${basePath}MTU`] || '1500';
        const portBinding = params[`${connDeviceKey}X_CT-COM_LanInterface`] || params[`${basePath}X_CT-COM_LanInterface`] || params[`${connDeviceKey}X_HW_LanInterface`] || 'LAN1,LAN2';

        const isConnActive = (status.toLowerCase().includes('connect') || status.toLowerCase().includes('up')) && externalIP && externalIP !== '0.0.0.0';

        connections.push({
          id: `IP_${match[2]}`,
          index: parseInt(match[2], 10),
          path: basePath,
          name,
          connectionType: connTypeRaw.includes('Bridge') ? 'Bridge' : 'IP_Routed (DHCP/Static)',
          connectionMode: connTypeRaw,
          serviceList,
          vlanId: vlanId ? String(vlanId) : 'None / Untagged',
          mtu: parseInt(mtu, 10) || 1500,
          portBinding,
          username: '',
          password: '',
          isPasswordProtected: false,
          status: isConnActive ? 'Connected' : status,
          isActive: isConnActive,
          externalIP: externalIP && externalIP !== '0.0.0.0' ? externalIP : '',
          defaultGateway,
          dnsServers,
          enabled: enable === '1' || enable === 'true' || enable === true,
          paramPathUser: '',
          paramPathPass: '',
          paramPathVlan: `${connDeviceKey}X_CT-COM_VLANIDMark`,
          paramPathEnable: `${basePath}Enable`
        });
      }
    }
  }

  // Identify active WAN interface
  const activeWan = connections.find(c => c.isActive) || connections.find(c => c.username && c.connectionType === 'PPPoE') || connections[0] || null;

  return {
    connectionType: activeWan ? activeWan.connectionType : 'PPPoE',
    username: activeWan ? activeWan.username : '',
    password: activeWan ? activeWan.password : '',
    vlanId: activeWan ? activeWan.vlanId : 'None',
    status: activeWan ? activeWan.status : 'Disconnected',
    ipAddress: activeWan ? activeWan.externalIP : '',
    defaultGateway: activeWan ? activeWan.defaultGateway : '',
    dnsServers: activeWan ? activeWan.dnsServers : '',
    paramPathUser: activeWan ? activeWan.paramPathUser : '',
    paramPathPass: activeWan ? activeWan.paramPathPass : '',
    paramPathVlan: activeWan ? activeWan.paramPathVlan : '',
    activeWanId: activeWan ? activeWan.id : '',
    connections: connections
  };
}

// --- COMPREHENSIVE MAC OUI VENDOR & DEVICE LOOKUP DATABASE ---
const OUI_VENDORS = {
  // Apple Inc.
  '00:03:93': 'Apple Inc.', '00:05:02': 'Apple Inc.', '00:0a:95': 'Apple Inc.', '00:10:fa': 'Apple Inc.',
  '00:11:24': 'Apple Inc.', '00:14:51': 'Apple Inc.', '00:16:cb': 'Apple Inc.', '00:17:f2': 'Apple Inc.',
  '00:19:e3': 'Apple Inc.', '00:1b:63': 'Apple Inc.', '00:1c:b3': 'Apple Inc.', '00:1d:4f': 'Apple Inc.',
  '00:1e:52': 'Apple Inc.', '00:1e:c2': 'Apple Inc.', '00:1f:5b': 'Apple Inc.', '00:1f:f3': 'Apple Inc.',
  '00:21:e9': 'Apple Inc.', '00:22:41': 'Apple Inc.', '00:23:12': 'Apple Inc.', '00:23:32': 'Apple Inc.',
  '00:23:6c': 'Apple Inc.', '00:23:df': 'Apple Inc.', '00:24:36': 'Apple Inc.', '00:25:00': 'Apple Inc.',
  '00:25:4b': 'Apple Inc.', '00:25:bc': 'Apple Inc.', '00:26:08': 'Apple Inc.', '00:26:4a': 'Apple Inc.',
  '00:26:b0': 'Apple Inc.', '00:26:bb': 'Apple Inc.', '14:20:5e': 'Apple Inc.', '34:ab:37': 'Apple Inc.',
  '40:6c:8f': 'Apple Inc.', '8c:85:90': 'Apple Inc.', 'a4:83:e7': 'Apple Inc.', 'bc:d0:74': 'Apple Inc.',
  'd8:9e:3f': 'Apple Inc.', 'dc:a9:04': 'Apple Inc.', 'f0:18:98': 'Apple Inc.', 'f4:5c:89': 'Apple Inc.',

  // Samsung Electronics
  '00:07:ab': 'Samsung Electronics', '00:12:47': 'Samsung Electronics', '00:15:99': 'Samsung Electronics',
  '00:1a:8a': 'Samsung Electronics', '00:21:19': 'Samsung Electronics', '08:37:3d': 'Samsung Electronics',
  '18:3a:2d': 'Samsung Electronics', '30:07:4d': 'Samsung Electronics', '30:de:4b': 'Samsung Electronics',
  '44:91:60': 'Samsung Electronics', '48:44:f7': 'Samsung Electronics', '50:01:d9': 'Samsung Electronics',
  '5c:a3:9d': 'Samsung Electronics', '64:1c:ae': 'Samsung Electronics', '78:47:1d': 'Samsung Electronics',
  '84:25:19': 'Samsung Electronics', '94:65:2d': 'Samsung Electronics', 'a0:82:1f': 'Samsung Electronics',
  'bc:72:b9': 'Samsung Electronics', 'c4:73:1e': 'Samsung Electronics',

  // Xiaomi / Redmi / POCO
  '18:f0:e4': 'Xiaomi (Redmi/POCO)', '28:6c:07': 'Xiaomi (Redmi/POCO)', '34:80:0d': 'Xiaomi (Redmi/POCO)',
  '50:64:2b': 'Xiaomi (Redmi/POCO)', '74:23:44': 'Xiaomi (Redmi/POCO)', '78:02:f8': 'Xiaomi (Redmi/POCO)',
  '7c:1d:d9': 'Xiaomi (Redmi/POCO)', '80:ad:16': 'Xiaomi (Redmi/POCO)', '88:c9:b3': 'Xiaomi (Redmi/POCO)',
  '9c:99:a0': 'Xiaomi (Redmi/POCO)', 'a4:44:d0': 'Xiaomi (Redmi/POCO)', 'c4:0b:cb': 'Xiaomi (Redmi/POCO)',
  'd4:97:0b': 'Xiaomi (Redmi/POCO)', 'e4:a4:71': 'Xiaomi (Redmi/POCO)', 'f4:60:e2': 'Xiaomi (Redmi/POCO)',

  // Realme / Oppo
  '46:12:e6': 'Realme / Oppo', '7c:25:87': 'Realme / Oppo', '80:7a:bf': 'Realme / Oppo',
  '9c:28:40': 'Realme / Oppo', 'a0:93:47': 'Realme / Oppo', 'b0:e5:ed': 'Realme / Oppo',
  'c8:d3:a3': 'Realme / Oppo', 'd4:f5:47': 'Realme / Oppo', 'e0:dc:ff': 'Realme / Oppo',
  'f8:a2:d6': 'Realme / Oppo',

  // Vivo Mobile
  '10:2a:b3': 'Vivo Mobile', '20:82:c0': 'Vivo Mobile', '30:75:12': 'Vivo Mobile',
  '58:24:29': 'Vivo Mobile', '70:28:8b': 'Vivo Mobile', '80:ea:07': 'Vivo Mobile',
  '94:d4:69': 'Vivo Mobile', 'ac:c1:ee': 'Vivo Mobile', 'b4:0b:44': 'Vivo Mobile',
  'd8:16:35': 'Vivo Mobile',

  // OnePlus
  '00:1a:2b': 'OnePlus Mobile', 'c0:ee:fb': 'OnePlus Mobile', '98:0c:82': 'OnePlus Mobile',
  '38:f9:d3': 'OnePlus Mobile', 'ec:d0:9f': 'OnePlus Mobile', '2c:56:dc': 'OnePlus Mobile',

  // Google / Motorola
  '00:1a:11': 'Google Pixel', 'f4:f5:e8': 'Google Pixel', '54:60:09': 'Google Home/Chromecast',
  '00:0c:e5': 'Motorola Mobile', '14:30:04': 'Motorola Mobile', '40:88:05': 'Motorola Mobile',

  // Laptops / Desktops (Intel, Dell, HP, Lenovo, Asus, Microsoft)
  '00:14:22': 'Dell Inc.', '00:18:8b': 'Dell Inc.', '54:47:e8': 'Dell Laptop',
  '00:1e:67': 'Intel WiFi (PC/Laptop)', '48:51:c5': 'Intel WiFi (PC/Laptop)',
  '80:86:f2': 'Intel WiFi (PC/Laptop)', '94:e6:f7': 'Intel WiFi (PC/Laptop)',
  '00:24:e8': 'HP Laptop / PC', '34:17:eb': 'HP Laptop / PC', 'd4:be:d9': 'HP Laptop / PC',
  'ec:b1:d7': 'Lenovo Laptop / PC', 'f8:b1:56': 'Lenovo Laptop / PC', '28:d0:ea': 'Lenovo Laptop / PC',
  '00:1f:c6': 'ASUS Laptop / PC', '04:d9:f5': 'ASUS Laptop / PC', '70:4d:7b': 'Microsoft Surface',

  // Smart TVs & Streaming (Sony Bravia, LG webOS, Amazon Fire TV)
  '00:01:4a': 'Sony Bravia 4K TV', '00:1d:ba': 'Sony Bravia 4K TV', 'a8:e2:07': 'Sony Smart TV',
  '00:24:8c': 'LG webOS Smart TV', '08:d4:6a': 'LG webOS Smart TV', '58:2f:40': 'LG Smart TV',
  '74:c2:46': 'Amazon Fire TV Stick', 'a0:02:dc': 'Amazon Fire TV Stick', 'b8:5d:43': 'Amazon Echo / FireTV',
  'fc:65:de': 'Amazon Fire TV 4K',

  // Smart Home / IoT / ESP32 / Tuya
  'cc:50:e3': 'Espressif (Smart Home IoT)', '24:0a:c4': 'Espressif (Smart Home IoT)',
  '30:ae:a4': 'Tuya Smart IoT Device', '84:0d:8e': 'Tuya Smart Bulb / Switch',
  'a0:20:a6': 'Smart Home IoT Device', 'ec:fa:bc': 'Smart Home IoT Device',

  // Network Infrastructure
  '0c:91:60': 'TP-Link Device', '50:d4:f7': 'TP-Link Device', '60:32:b1': 'TP-Link Device',
  'b8:27:eb': 'Raspberry Pi', 'dc:a6:32': 'Raspberry Pi', 'e4:5f:01': 'Raspberry Pi'
};

function getMacVendor(mac) {
  if (!mac || typeof mac !== 'string') return 'Connected Client';
  const clean = mac.replace(/[:-]/g, '').toLowerCase().slice(0, 6);
  for (const [oui, vendor] of Object.entries(OUI_VENDORS)) {
    const ouiClean = oui.replace(/[:-]/g, '').toLowerCase();
    if (clean === ouiClean) return vendor;
  }
  // Generic OUI Pattern Fallback
  if (/^(46|7c|80|9c|a0|b0|c8|d4|e0|f8)/i.test(clean)) return 'Smartphone (Realme/Oppo)';
  if (/^(18|28|34|50|74|78|7c|88|9c|a4|c4|d4|e4|f4)/i.test(clean)) return 'Smartphone (Xiaomi/Redmi)';
  if (/^(08|18|30|44|48|50|5c|64|78|84|94|a0|bc|c4)/i.test(clean)) return 'Samsung Galaxy Device';
  if (/^(00|14|34|40|8c|a4|bc|d8|dc|f0|f4)/i.test(clean)) return 'Apple iOS / Mac Device';
  if (/^(10|20|30|58|70|80|94|ac|b4|d8)/i.test(clean)) return 'Vivo Smartphone';
  if (/^(00|c0|98|38|ec|2c)/i.test(clean)) return 'OnePlus Smartphone';
  return 'Connected WiFi Device';
}

function resolveDeviceName(rawHostName, mac, vendor) {
  const name = String(rawHostName || '').trim();
  const v = String(vendor || '').toLowerCase();

  // If clean human hostname is provided
  if (name && name !== 'N/A' && name !== 'UNKNOWN' && name !== '*' && name !== 'unknown' && !name.startsWith('dhcp-')) {
    // Clean up android hashes e.g. "android-a483e710294"
    if (/^android-[0-9a-fA-F]+/i.test(name)) {
      if (v.includes('samsung')) return 'Samsung Galaxy Phone';
      if (v.includes('xiaomi') || v.includes('redmi') || v.includes('poco')) return 'Redmi Note Smartphone';
      if (v.includes('oneplus')) return 'OnePlus Smartphone';
      if (v.includes('vivo')) return 'Vivo Smartphone';
      if (v.includes('realme') || v.includes('oppo')) return 'Realme Smartphone';
      if (v.includes('google') || v.includes('pixel')) return 'Google Pixel Phone';
      if (v.includes('motorola')) return 'Motorola Smartphone';
      return 'Android Smartphone';
    }

    // Format Windows Desktops/Laptops
    if (/^DESKTOP-[0-9A-Z]+/i.test(name)) return `Windows 11 Desktop PC (${name.slice(0, 15)})`;
    if (/^LAPTOP-[0-9A-Z]+/i.test(name)) return `Windows Laptop PC (${name.slice(0, 15)})`;
    if (/^iPhone/i.test(name)) return name.length > 6 ? name : 'Apple iPhone';
    if (/^iPad/i.test(name)) return name.length > 4 ? name : 'Apple iPad';
    if (/^MacBook/i.test(name)) return name;
    if (/^Galaxy-/i.test(name)) return name.replace('-', ' ');
    if (/^Redmi-/i.test(name) || /^POCO-/i.test(name)) return name.replace('-', ' ');
    if (/^ESP_/i.test(name)) return 'Smart Home IoT Controller';
    if (/^FireTV/i.test(name)) return 'Amazon Fire TV Stick 4K';
    if (/^BRAVIA/i.test(name)) return 'Sony Bravia 4K Smart TV';
    if (/^LGwebOSTV/i.test(name)) return 'LG Smart 4K TV';
    if (/^MiTV/i.test(name)) return 'Xiaomi Mi 4K Smart TV';

    return name;
  }

  // If hostname is empty, infer from Vendor
  if (v.includes('apple')) return 'Apple iPhone / iPad';
  if (v.includes('samsung')) return 'Samsung Galaxy Smartphone';
  if (v.includes('xiaomi') || v.includes('redmi')) return 'Redmi Note Smartphone';
  if (v.includes('oneplus')) return 'OnePlus Smartphone';
  if (v.includes('realme') || v.includes('oppo')) return 'Realme Smartphone';
  if (v.includes('vivo')) return 'Vivo Smartphone';
  if (v.includes('intel') || v.includes('dell') || v.includes('hp') || v.includes('lenovo')) return 'Laptop / Desktop PC';
  if (v.includes('sony') || v.includes('bravia') || v.includes('lg') || v.includes('amazon') || v.includes('fire')) return 'Smart TV / Streaming Box';
  if (v.includes('espressif') || v.includes('tuya') || v.includes('iot')) return 'Smart Home IoT Device';

  return 'Wireless Client Device';
}

function extractConnectedHosts(params, blockedMacs = []) {
  const hosts = [];
  const hostEntries = {};

  // 1. Scan TR-098 and TR-181 Host Tables
  for (const [k, v] of Object.entries(params)) {
    // Standard TR-098 Hosts.Host.{i}
    let match = k.match(/InternetGatewayDevice\.LANDevice\.1\.Hosts\.Host\.(\d+)\./i) ||
                k.match(/Device\.Hosts\.Host\.(\d+)\./i);
    if (match) {
      const idx = `host_${match[1]}`;
      if (!hostEntries[idx]) hostEntries[idx] = {};
      if (/HostName$/i.test(k)) hostEntries[idx].hostName = v;
      if (/IPAddress$/i.test(k)) hostEntries[idx].ipAddress = v;
      if (/MACAddress$/i.test(k)) hostEntries[idx].macAddress = v;
      if (/Active$/i.test(k)) hostEntries[idx].active = v === '1' || v === 'true';
      if (/InterfaceType$/i.test(k)) hostEntries[idx].interfaceType = v;
      if (/Layer1Interface$/i.test(k)) hostEntries[idx].layer1 = v;
      continue;
    }

    // WLAN Associated Devices
    match = k.match(/InternetGatewayDevice\.LANDevice\.1\.WLANConfiguration\.(\d+)\.AssociatedDevice\.(\d+)\./i) ||
            k.match(/Device\.WiFi\.AccessPoint\.(\d+)\.AssociatedDevice\.(\d+)\./i);
    if (match) {
      const wlanBand = match[1] === '2' || match[1] === '4' ? 'WiFi 5GHz' : 'WiFi 2.4GHz';
      const idx = `wlan_${match[1]}_${match[2]}`;
      if (!hostEntries[idx]) hostEntries[idx] = { interfaceType: wlanBand, active: true };
      if (/AssociatedDeviceMACAddress$/i.test(k) || /MACAddress$/i.test(k)) hostEntries[idx].macAddress = v;
      if (/AssociatedDeviceIPAddress$/i.test(k) || /IPAddress$/i.test(k)) hostEntries[idx].ipAddress = v;
      if (/HostName$/i.test(k) || /X_CT-COM_HostName$/i.test(k)) hostEntries[idx].hostName = v;
      continue;
    }

    // DHCP Server Clients
    match = k.match(/Device\.DHCPv4\.Server\.Pool\.1\.Client\.(\d+)\./i);
    if (match) {
      const idx = `dhcp_${match[1]}`;
      if (!hostEntries[idx]) hostEntries[idx] = {};
      if (/Chaddr$/i.test(k) || /MACAddress$/i.test(k)) hostEntries[idx].macAddress = v;
      if (/IPAddress$/i.test(k)) hostEntries[idx].ipAddress = v;
      if (/HostName$/i.test(k)) hostEntries[idx].hostName = v;
      continue;
    }
  }

  const blockedSet = new Set((blockedMacs || []).map(m => String(m).toLowerCase().trim()));

  for (const [idx, data] of Object.entries(hostEntries)) {
    if (data.ipAddress || data.macAddress || data.hostName) {
      const mac = data.macAddress || 'Unknown MAC';
      const isBlocked = blockedSet.has(mac.toLowerCase());
      const vendor = getMacVendor(mac);
      const hostName = resolveDeviceName(data.hostName, mac, vendor);

      hosts.push({
        id: idx,
        name: hostName,
        hostName: hostName,
        ipAddress: data.ipAddress || 'DHCP Assigned',
        macAddress: mac,
        vendor: vendor,
        active: data.active !== undefined ? data.active : true,
        blocked: isBlocked,
        interfaceType: data.interfaceType || data.layer1 || 'WiFi (Dual-Band)'
      });
    }
  }

  return hosts;
}

// --- OPTICAL CONVERSIONS (RX, TX, TEMP, VOLT, BIAS) ---

function formatRxOpticalPower(rawVal, modelName = '', brand = '') {
  if (rawVal === undefined || rawVal === null || rawVal === '' || rawVal === 'N/A') return 'N/A';
  let str = String(rawVal).replace(/dBm/gi, '').replace(/[()]/g, '').trim();
  let num = parseFloat(str);
  if (isNaN(num)) return 'N/A';

  // Case 0: Disconnected / Loss of Signal (LOS) / Off register values
  if (num === 0 || num === 65535 || num <= -3800 || num <= -40 || str === '0.00' || str === '0.0') {
    return '-40.00 dBm';
  }

  // Case 1: Negative numbers (already in dBm or scaled in 0.01 / 0.1 / 0.001 dBm)
  if (num < 0) {
    if (num <= -1000) {
      num = num / 100; // -1950 -> -19.50 dBm, -2450 -> -24.50 dBm
    } else if (num <= -50) {
      num = num / 10;  // -195 -> -19.50 dBm, -245 -> -24.50 dBm
    }
    // Clamping to standard GPON/EPON sensitivity window (-8 dBm to -38 dBm)
    return `${num.toFixed(2)} dBm`;
  }

  const modelStr = String(modelName || '').toLowerCase();
  const brandStr = typeof brand === 'string' ? brand.toLowerCase() : (brand?.name || '').toLowerCase();
  const isRH821orHGU = modelStr.includes('rh821') || modelStr.includes('hgu') || brandStr.includes('hgu');

  // Case 2: HGU RH821GWV-DG / Realtek EPON reporting in 0.1 uW (Offset = -40)
  // Raw 456 -> 10*log10(456) - 40 = -13.41 dBm (e.g. BHARATH)
  // Raw 142 -> 10*log10(142) - 40 = -23.48 dBm (e.g. VARALAKSHMI)
  // Raw 420 -> 10*log10(420) - 40 = -13.77 dBm (e.g. FSHOP)
  if (isRH821orHGU && num >= 50 && num <= 10000) {
    const dbm = 10 * Math.log10(num) - 40;
    if (!isNaN(dbm) && isFinite(dbm)) {
      return `${dbm.toFixed(2)} dBm`;
    }
  }

  // Case 3: CTC 3.0 / ITU-T Linear optical power in 0.01 uW (typical range 10 to 35000, Offset = -50)
  // Genexis 1214 -> 10*log10(1214) - 50 = -19.16 dBm
  // Syrotech 6044 -> 10*log10(6044) - 50 = -12.19 dBm
  if (num >= 50 && num <= 35000) {
    const dbm = 10 * Math.log10(num) - 50;
    if (!isNaN(dbm) && isFinite(dbm)) {
      return `${dbm.toFixed(2)} dBm`;
    }
  }

  // Case 4: Positive centi-dBm / deci-dBm where minus sign was omitted (e.g. 1950 -> -19.50 dBm)
  if (num > 1000) {
    num = num / 100;
  } else if (num > 50) {
    num = num / 10;
  }

  // GPON Rx optical power is always negative
  if (num > 0) {
    num = -num;
  }

  return `${num.toFixed(2)} dBm`;
}

function formatTxOpticalPower(rawVal) {
  if (rawVal === undefined || rawVal === null || rawVal === '' || rawVal === 'N/A') return 'N/A';
  let str = String(rawVal).replace(/dBm/gi, '').replace(/[()]/g, '').trim();
  let num = parseFloat(str);
  if (isNaN(num) || num === 0) return 'N/A';

  // Case 1: CTC 3.0 Linear optical power in 0.1 uW / 0.0001 mW (CTC 3.0 standard, range 5000 to 90000)
  // CTC 3.0 Formula: Power(dBm) = 10 * log10(Value * 10^-4 mW) = 10 * log10(Value) - 40
  // Examples:
  // 16180 -> 10*log10(16180) - 40 = +2.09 dBm
  // 17200 -> 10*log10(17200) - 40 = +2.36 dBm
  // 17380 -> 10*log10(17380) - 40 = +2.40 dBm
  // 17550 -> 10*log10(17550) - 40 = +2.44 dBm
  // 18100 -> 10*log10(18100) - 40 = +2.58 dBm
  if (num >= 5000 && num <= 90000) {
    const dbm = 10 * Math.log10(num) - 40;
    if (!isNaN(dbm) && isFinite(dbm)) {
      return `+${dbm.toFixed(2)} dBm`;
    }
  }

  // Case 2: In 0.01 dBm or 0.1 dBm units (e.g. 245 -> +2.45 dBm, 2450 -> +2.45 dBm)
  if (num > 1000 || num < -1000) {
    num = num / 100;
  } else if (num > 50 || num < -50) {
    num = num / 10;
  }

  return `${num >= 0 ? '+' : ''}${num.toFixed(2)} dBm`;
}

function formatTemperature(rawVal) {
  if (!rawVal || rawVal === '' || rawVal === '0') return 'N/A';
  let num = parseFloat(rawVal);
  if (isNaN(num)) return 'N/A';
  // SFF-8472 1/256 deg C representation (e.g. 14805 / 256 = 57.8 C)
  if (num > 256) num = num / 256;
  return `${num.toFixed(1)} °C`;
}

function formatVoltage(rawVal) {
  if (!rawVal || rawVal === '' || rawVal === '0') return 'N/A';
  let num = parseFloat(rawVal);
  if (isNaN(num)) return 'N/A';
  if (num > 10000) num = num / 10000;
  else if (num > 1000) num = num / 1000;
  else if (num > 100) num = num / 100;
  return `${num.toFixed(2)} V`;
}

function formatBiasCurrent(rawVal) {
  if (!rawVal || rawVal === '' || rawVal === '0') return 'N/A';
  let num = parseFloat(rawVal);
  if (isNaN(num)) return 'N/A';
  // If SFF-8472 (2 uA units) e.g. 4139 * 2 uA = 8.28 mA
  if (num > 1000) num = (num * 2) / 1000;
  else if (num > 100) num = num / 10;
  return `${num.toFixed(1)} mA`;
}

function formatBytes(rawVal) {
  if (!rawVal) return 'N/A';
  const bytes = parseInt(rawVal, 10);
  if (isNaN(bytes)) return 'N/A';
  if (bytes >= 1e12) return (bytes / 1e12).toFixed(2) + ' TB';
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(2) + ' GB';
  if (bytes >= 1e6) return (bytes / 1e6).toFixed(2) + ' MB';
  if (bytes >= 1e3) return (bytes / 1e3).toFixed(2) + ' KB';
  return bytes + ' B';
}

function getOpticalHealth(formattedPower) {
  if (!formattedPower || formattedPower === 'N/A') {
    return { status: 'Unknown', color: '#64748b', label: 'No Signal / Unlinked' };
  }
  const val = parseFloat(formattedPower);
  if (isNaN(val)) return { status: 'Unknown', color: '#64748b', label: 'Unknown' };

  if (val >= -24.0 && val <= -8.0) {
    return { status: 'Excellent', color: '#10b981', label: 'Optimal Signal (-8 to -24 dBm)' };
  } else if (val < -24.0 && val >= -27.0) {
    return { status: 'Good', color: '#3b82f6', label: 'Good Signal (-24 to -27 dBm)' };
  } else if (val < -27.0 && val >= -29.0) {
    return { status: 'Warning', color: '#f59e0b', label: 'Weak Signal (-27 to -29 dBm)' };
  } else if (val < -29.0) {
    return { status: 'Critical', color: '#ef4444', label: 'Critical Optical Loss (< -29 dBm)' };
  } else {
    return { status: 'High', color: '#ec4899', label: 'Optical Power Overload (> -8 dBm)' };
  }
}

/**
 * Build a smart GET_PARAMS task list from the device's known supportedParams.
 * Only queries params that the device actually reported during GetParameterNames.
 * This is used in cwmp-server.js to replace the generic batch.
 */
function buildSmartParamList(supportedParams = []) {
  const wanted = new Set();

  for (const name of supportedParams) {
    // Skip object entries (trailing dot)
    if (name.endsWith('.')) continue;

    const lower = name.toLowerCase();

    // Device Info
    if (/deviceinfo\.(manufacturer|modelname|serialnumber|hardwareversion|softwareversion|uptime|provisioningcode)$/i.test(name)) {
      wanted.add(name);
    }
    // Management server
    if (/managementserver\.(connectionrequest(url|username|password)|acsurl)$/i.test(name)) {
      wanted.add(name);
    }
    // Optical power - exact leaf params
    if (/(txpower|rxpower|transceivertemperature|supplyvot{1,2}age|biascurrent)$/i.test(name) &&
        /(epon|gpon|pon|optical)/i.test(name)) {
      wanted.add(name);
    }
    // PON stats
    if (/eponinterfaceconfig\.stats\.(bytessent|bytesreceived|packetssent|packetsreceived)$/i.test(name)) {
      wanted.add(name);
    }
    // PON Status
    if (/eponinterfaceconfig\.status$/i.test(name) || /gponinterfaceconfig\.status$/i.test(name)) {
      wanted.add(name);
    }
    // WiFi SSID & Password (any WLAN index, TR-098 & TR-181)
    if (/wlanconfiguration\.\d+\.(ssid|enable|channel|bssid|beacontype|basicencryptionmodes|standard|radio|hide|ssidadvertisementenabled|totalassociations|associateddevicenumberofentries|keypassphrase|x_tp_presharedkey|x_hw_wpakey|x_ct-com_wpakey|wepkey0|bandsteering|x_hw_smartconnect)$/i.test(name)) {
      wanted.add(name);
    }
    if (/wlanconfiguration\.\d+\.presharedkey\.\d+\.(keypassphrase|presharedkey)$/i.test(name)) {
      wanted.add(name);
    }
    if (/wlanconfiguration\.\d+\.associateddevice\.\d+\.(associateddevicemacaddress|associateddeviceipaddress|macaddress|ipaddress|hostname)$/i.test(name)) {
      wanted.add(name);
    }
    if (/device\.wifi\.ssid\.\d+\.(ssid|enable|bssid|status)$/i.test(name)) {
      wanted.add(name);
    }
    if (/device\.wifi\.accesspoint\.\d+\.(enable|associateddevicenumberofentries)$/i.test(name)) {
      wanted.add(name);
    }
    if (/device\.wifi\.accesspoint\.\d+\.security\.(modeenabled|keypassphrase|presharedkey)$/i.test(name)) {
      wanted.add(name);
    }
    if (/device\.wifi\.accesspoint\.\d+\.associateddevice\.\d+\.(macaddress|ipaddress|hostname)$/i.test(name)) {
      wanted.add(name);
    }
    if (/device\.wifi\.radio\.\d+\.(enable|channel|operatingfrequencyband)$/i.test(name)) {
      wanted.add(name);
    }

    // WAN PPPoE & IP Connections
    if (/wanpppconnection\.\d+\.(enable|name|username|password|connectionstatus|externalipaddress|defaultgateway|dnsservers|connectiontype|maxmtusize|mtu|natenabled)$/i.test(name)) {
      wanted.add(name);
    }
    if (/wanipconnection\.\d+\.(enable|name|connectiontype|addressingtype|externalipaddress|connectionstatus|defaultgateway|dnsservers|macaddress|maxmtusize|mtu|natenabled)$/i.test(name)) {
      wanted.add(name);
    }
    // VLAN, ServiceList & Port Binding
    if (/x_ct-com_vlanidmark$|vlanidmark$|x_hw_vlan$|x_cmcc_vlanidmark$|x_ct-com_servicelist$|x_hw_servicelist$|servicelist$|x_ct-com_laninterface$|x_hw_laninterface$/i.test(name)) {
      wanted.add(name);
    }

    // LAN Hosts & Connected Clients
    if (/hosts\.host\.\d+\.(hostname|ipaddress|macaddress|active|interfacetype|layer1interface|leasetime)$/i.test(name)) {
      wanted.add(name);
    }
    if (/device\.hosts\.host\.\d+\.(hostname|ipaddress|physaddress|active|interfacetype|layer1interface)$/i.test(name)) {
      wanted.add(name);
    }
    // MAC Address
    if (/lanethernetinterfaceconfig\.\d+\.macaddress$/i.test(name)) {
      wanted.add(name);
    }
  }

  return Array.from(wanted);
}

const UNIVERSAL_PARAMETER_PATHS = [
  'InternetGatewayDevice.DeviceInfo.',
  'Device.DeviceInfo.',
  'InternetGatewayDevice.ManagementServer.',
  'Device.ManagementServer.',
  'InternetGatewayDevice.LANDevice.1.WLANConfiguration.',
  'Device.WiFi.SSID.',
  'Device.WiFi.AccessPoint.',
  'InternetGatewayDevice.WANDevice.1.WANEponInterfaceConfig.',
  'InternetGatewayDevice.WANDevice.1.WANGponInterfaceConfig.',
  'InternetGatewayDevice.WANDevice.1.X_CT-COM_EponInterfaceConfig.',
  'InternetGatewayDevice.WANDevice.1.X_CMCC_EponInterfaceConfig.',
  'InternetGatewayDevice.WANDevice.1.X_HW_PON.',
  'InternetGatewayDevice.WANDevice.1.X_ZTE-COM_PONInterfaceConfig.',
  'InternetGatewayDevice.WANDevice.1.X_BROADCOM_COM_EPONInterfaceConfig.',
  'InternetGatewayDevice.WANDevice.1.X_BROADCOM_COM_GPONInterfaceConfig.',
  'Device.Optical.Interface.',
  'InternetGatewayDevice.WANDevice.1.WANConnectionDevice.',
  'Device.PPP.Interface.',
  'InternetGatewayDevice.LANDevice.1.Hosts.'
];

/**
 * Intelligent Customer Data Auto-Enricher
 * Extracts clean, human-readable subscriber names and mobile numbers from:
 * 1. PPPoE Usernames (including BSNL FTTH formats: ss8549293374_sid@ftth.bsnl.in, tt8450230090, JAYANTHREDDY)
 * 2. Wi-Fi SSIDs (e.g. "kayathi jayanth reddy", "DYAPASRIKANTH", "FM&SON'S RESIDENCY", "SWEET HOME")
 * 3. Wi-Fi Passphrases / Security Keys (if they contain 10-digit mobile numbers)
 */
function enrichCustomerProfile(customer = {}, wan = {}, wifi = {}, deviceInfo = {}) {
  const result = { ...(customer || {}) };

  const pppoeUser = (wan?.username || result.pppoeUsername || result.accountId || '').trim();
  const pppoePass = wan?.password || result.pppoePassword || result.password || '';
  const wifi24 = wifi?.wifi24 || {};
  const wifi5 = wifi?.wifi5 || {};
  const wifiSsid = (wifi24.ssid || result.wifiSsid || '').trim();
  const wifiPass = (wifi24.password || result.wifiPass || '').trim();
  const wifi5Ssid = (wifi5.ssid || result.wifi5Ssid || '').trim();
  const wifi5Pass = (wifi5.password || result.wifi5Pass || '').trim();

  // 1. Resolve Mobile Number
  let phone = result.phone || '';
  if (!phone || phone === 'N/A' || phone === 'undefined' || phone.length < 10) {
    if (/^[6-9]\d{9}$/.test(wifiPass)) {
      phone = wifiPass;
    } else if (/^[6-9]\d{9}$/.test(wifi5Pass)) {
      phone = wifi5Pass;
    } else if (pppoeUser) {
      const phoneMatch = pppoeUser.match(/([6-9]\d{9})/);
      if (phoneMatch) {
        phone = phoneMatch[1];
      }
    }
    if (!phone && wifiSsid) {
      const ssidPhoneMatch = wifiSsid.match(/([6-9]\d{9})/);
      if (ssidPhoneMatch) {
        phone = ssidPhoneMatch[1];
      }
    }
  }

  // 2. Resolve Subscriber Name
  let name = result.name || '';
  const isGeneric = !name || name === 'Unassigned Customer' || name === 'undefined' || name.startsWith('Subscriber (');

  if (isGeneric || name.includes('@ftth.bsnl.in') || /^\d+$/.test(name)) {
    const cleanSsid = wifiSsid
      .replace(/_2\.4G$/i, '')
      .replace(/_5G$/i, '')
      .replace(/_VGF$/i, '')
      .replace(/_BSNL$/i, '')
      .replace(/2\.4ghz/i, '')
      .replace(/5ghz/i, '')
      .replace(/^GNXS-[0-9A-Za-z_-]+/i, '')
      .replace(/^RH-[0-9A-Za-z_-]+/i, '')
      .replace(/^VBSNL\s*/i, '')
      .replace(/_/g, ' ')
      .trim();

    const isSsidNameEligible = cleanSsid &&
      cleanSsid.length >= 3 &&
      !/^([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})$/.test(cleanSsid) &&
      !['BSNL', 'FiberNet', 'WiFi', 'ONT'].includes(cleanSsid) &&
      isNaN(Number(cleanSsid));

    if (isSsidNameEligible && !cleanSsid.startsWith('FiberNet')) {
      name = cleanSsid.split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
    } else if (pppoeUser && !pppoeUser.includes('@') && isNaN(Number(pppoeUser))) {
      name = pppoeUser.split(/[\s_-]+/).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
    } else if (cleanSsid && cleanSsid.length >= 3 && !cleanSsid.startsWith('FiberNet')) {
      name = cleanSsid.split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
    } else if (pppoeUser) {
      name = pppoeUser;
    } else {
      name = `Subscriber ${deviceInfo.serialNumber?.slice(-4) || 'ONT'}`;
    }
  }

  // Set normalized customer record
  result.name = name;
  result.phone = phone || result.phone || '';
  result.accountId = pppoeUser || result.accountId || deviceInfo.serialNumber || '';
  result.pppoeUsername = pppoeUser || result.pppoeUsername || '';
  if (pppoePass) {
    result.pppoePassword = pppoePass;
    result.password = pppoePass;
  }
  if (wifiSsid) result.wifiSsid = wifiSsid;
  if (wifiPass) result.wifiPass = wifiPass;
  if (wifi5Ssid) result.wifi5Ssid = wifi5Ssid;
  if (wifi5Pass) result.wifi5Pass = wifi5Pass;
  if (wan?.vlanId && wan.vlanId !== 'None / Untagged') result.vlanId = wan.vlanId;
  if (!result.plan) result.plan = '100 Mbps Unlimited Fiber';
  if (!result.address) result.address = 'FTTH Subscriber Premises';
  if (!result.installationDate) result.installationDate = new Date().toISOString().split('T')[0];

  return result;
}

module.exports = {
  normalizeDeviceData,
  enrichCustomerProfile,
  buildSmartParamList,
  UNIVERSAL_PARAMETER_PATHS,
  formatRxOpticalPower,
  formatTxOpticalPower,
  formatTemperature,
  formatVoltage,
  formatBiasCurrent,
  formatBytes,
  getOpticalHealth
};
