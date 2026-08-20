/**
 * SNMP Trap Receiver & Event Listener Daemon (UDP Port 162)
 * Receives real-time autonomous alarm traps and ONU events pushed by OLTs.
 */

const dgram = require('dgram');
const db = require('../db/database');

let trapSocket = null;
const recentTraps = [];

// Common GPON OLT Enterprise Trap OID mappings
const OID_DESCRIPTIONS = {
  '1.3.6.1.4.1.37950': 'VSOL / C-Data Enterprise MIB',
  '1.3.6.1.4.1.2011': 'Huawei SmartAX GPON MIB',
  '1.3.6.1.4.1.3902': 'ZTE GPON MIB',
  '1.3.6.1.2.1.1.3': 'sysUpTime',
  '1.3.6.1.6.3.1.1.4.1.0': 'snmpTrapOID',
  '1.3.6.1.4.1.37950.1.1.5.1': 'onuRegistered',
  '1.3.6.1.4.1.37950.1.1.5.2': 'onuDeregistered / Loss of Signal',
  '1.3.6.1.4.1.37950.1.1.5.3': 'opticalPowerAlarm',
  '1.3.6.1.4.1.37950.1.1.5.4': 'dyingGaspAlarm'
};

function startSnmpTrapListener(port = 162) {
  try {
    trapSocket = dgram.createSocket('udp4');

    trapSocket.on('error', (err) => {
      console.warn(`[SNMP-TRAP] UDP Socket error on port ${port}: ${err.message}`);
      if (err.code === 'EACCES') {
        console.log(`[SNMP-TRAP] Port 162 requires root privilege or alternate port.`);
      }
    });

    trapSocket.on('message', async (msg, rinfo) => {
      const timestamp = new Date();
      const rawHex = msg.toString('hex');
      const rawAscii = msg.toString('utf-8').replace(/[^\x20-\x7E]/g, ' ');

      // Parse community & basic packet info
      const isV1orV2c = msg[0] === 0x30;
      let eventType = 'GENERIC_TRAP';
      let summary = `SNMP Trap received from ${rinfo.address}:${rinfo.port}`;

      if (rawAscii.includes('VSOL') || rawAscii.includes('GPON') || rawHex.includes('37950')) {
        eventType = 'OLT_ONU_EVENT';
        summary = `GPON OLT Event Trap from ${rinfo.address}`;
      } else if (rawAscii.toLowerCase().includes('dying') || rawAscii.toLowerCase().includes('gasp')) {
        eventType = 'DYING_GASP';
        summary = `🚨 Critical Dying Gasp Trap from ONT via OLT ${rinfo.address}`;
      }

      const trapRecord = {
        id: `trap_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
        timestamp: timestamp.toISOString(),
        senderIp: rinfo.address,
        senderPort: rinfo.port,
        packetLength: msg.length,
        eventType,
        summary,
        rawPreview: rawAscii.slice(0, 120).trim()
      };

      recentTraps.unshift(trapRecord);
      if (recentTraps.length > 200) recentTraps.pop();

      console.log(`[SNMP-TRAP] 📥 ${summary} (Bytes: ${msg.length})`);

      try {
        await db.addLog({
          type: 'SNMP_TRAP',
          deviceId: `OLT_${rinfo.address.replace(/\./g, '_')}`,
          ip: rinfo.address,
          eventSummary: summary,
          message: `Trap Event [${eventType}]: ${rawAscii.slice(0, 100).trim()}`
        });
      } catch (_) {}
    });

    trapSocket.bind(port, '0.0.0.0', () => {
      console.log(`[SNMP-TRAP] 📡 SNMP Trap Receiver daemon listening on UDP 0.0.0.0:${port}`);
    });
  } catch (e) {
    console.warn(`[SNMP-TRAP] Could not start trap listener on ${port}: ${e.message}`);
  }
}

function getRecentTraps(limit = 50) {
  return recentTraps.slice(0, limit);
}

module.exports = {
  startSnmpTrapListener,
  getRecentTraps
};
