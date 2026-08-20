const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const QRCode = require('qrcode');
const db = require('../db/database');
const { sanitizeForLogs } = require('../security/crypto-vault');

let makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion;

// Dynamic load for Baileys ESM/CJS compatibility
async function loadBaileys() {
  if (!makeWASocket) {
    const baileys = await import('@whiskeysockets/baileys');
    makeWASocket = baileys.default || baileys.makeWASocket;
    useMultiFileAuthState = baileys.useMultiFileAuthState;
    DisconnectReason = baileys.DisconnectReason;
    fetchLatestBaileysVersion = baileys.fetchLatestBaileysVersion;
  }
}

// In-Memory active sessions map: tenantId -> { sock, status, qr, qrDataUrl, user, lastActive }
const activeSessions = new Map();

// Stateful Conversation Engine for Subscribers: key -> { state, otp, otpExpiresAt, deviceId, pendingAction, lastActive }
const conversationState = new Map();

// Message queue: Array of { tenantId, phone, text, meta, retries, createdAt }
const messageQueue = [];
let isProcessingQueue = false;
const botSentMessageIds = new Set();

const SESSIONS_BASE_DIR = process.env.WHATSAPP_SESSIONS_DIR || '/opt/tr069-acs/whatsapp_sessions';

// Ensure base sessions directory exists
function ensureSessionDir(tenantId) {
  const dir = path.join(SESSIONS_BASE_DIR, tenantId.replace(/[^a-zA-Z0-9_-]/g, '_'));
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

class WhatsAppService {
  constructor() {
    this.startQueueWorker();
  }

  // --- 1. SESSION MANAGEMENT ---

  async initSession(tenantId = 'rudra') {
    await loadBaileys();
    const cleanTenant = tenantId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const sessionDir = ensureSessionDir(cleanTenant);

    if (activeSessions.has(cleanTenant)) {
      const existing = activeSessions.get(cleanTenant);
      if (existing.status === 'CONNECTED') {
        return {
          success: true,
          status: 'CONNECTED',
          user: existing.user,
          message: 'WhatsApp Web session already active'
        };
      }
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    let version = [2, 3000, 1015901307];
    try {
      const vData = await fetchLatestBaileysVersion();
      if (vData && vData.version) version = vData.version;
    } catch (_) {}

    const pino = require('pino');
    const logger = pino({ level: 'silent' });

    const sock = makeWASocket({
      version,
      logger,
      printQRInTerminal: false,
      auth: state,
      browser: ['VRV ACS Self-Care', 'Chrome', '124.0.0.0'],
      syncFullHistory: false,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 25000
    });

    const sessionData = {
      sock,
      status: 'CONNECTING',
      qr: null,
      qrDataUrl: null,
      user: null,
      lastActive: new Date().toISOString()
    };
    activeSessions.set(cleanTenant, sessionData);

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        sessionData.qr = qr;
        sessionData.status = 'QR_READY';
        try {
          sessionData.qrDataUrl = await QRCode.toDataURL(qr, {
            width: 280,
            margin: 2,
            color: { dark: '#0b0f19', light: '#ffffff' }
          });
        } catch (e) {
          console.error('[WA QR GEN ERROR]', e);
        }
        console.log(`[WA] QR Code ready for tenant: ${cleanTenant}`);
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        console.log(`[WA] Connection closed for ${cleanTenant}, status: ${statusCode}, reconnect: ${shouldReconnect}`);

        sessionData.status = 'DISCONNECTED';
        sessionData.qr = null;
        sessionData.qrDataUrl = null;

        if (shouldReconnect) {
          setTimeout(() => {
            console.log(`[WA] Reconnecting session for tenant: ${cleanTenant}...`);
            this.initSession(cleanTenant).catch(err => console.error('[WA RECONNECT ERR]', err));
          }, 4000);
        } else {
          try {
            fs.rmSync(sessionDir, { recursive: true, force: true });
          } catch (_) {}
          activeSessions.delete(cleanTenant);
        }
      } else if (connection === 'open') {
        sessionData.status = 'CONNECTED';
        sessionData.qr = null;
        sessionData.qrDataUrl = null;
        sessionData.user = {
          id: sock.user?.id ? sock.user.id.split(':')[0] : '',
          name: sock.user?.name || 'Operator NOC',
          jid: sock.user?.id || ''
        };
        console.log(`[WA] ✅ WhatsApp Web Connected for ${cleanTenant} as ${sessionData.user.id} (${sessionData.user.name})`);

        try {
          await db.addLog({
            type: 'WHATSAPP_CONNECTED',
            tenantId: cleanTenant,
            message: `📲 WhatsApp Web successfully linked for operator: ${cleanTenant} (Phone: +${sessionData.user.id})`
          });
        } catch (_) {}
      }
    });

    // --- 🤖 ADVANCED STATEFUL SELF-CARE & TR-069 INTERACTIVE BOT ---
    sock.ev.on('messages.upsert', async (m) => {
      try {
        if (!m.messages || m.messages.length === 0) return;
        const msg = m.messages[0];

        const remoteJid = msg.key.remoteJid || '';
        if (remoteJid.endsWith('@g.us') || remoteJid === 'status@broadcast') return; // Ignore groups & status broadcasts

        // Extract raw text
        const extractText = (msgObj) => {
          if (!msgObj) return '';
          if (typeof msgObj === 'string') return msgObj;
          const msgBody = msgObj.message || msgObj;
          if (!msgBody) return '';
          if (msgBody.conversation) return msgBody.conversation;
          if (msgBody.extendedTextMessage?.text) return msgBody.extendedTextMessage.text;
          if (msgBody.imageMessage?.caption) return msgBody.imageMessage.caption;
          if (msgBody.videoMessage?.caption) return msgBody.videoMessage.caption;
          if (msgBody.documentMessage?.caption) return msgBody.documentMessage.caption;
          if (msgBody.ephemeralMessage?.message) return extractText(msgBody.ephemeralMessage.message);
          if (msgBody.viewOnceMessage?.message) return extractText(msgBody.viewOnceMessage.message);
          if (msgBody.viewOnceMessageV2?.message) return extractText(msgBody.viewOnceMessageV2.message);
          if (msgBody.buttonsResponseMessage?.selectedButtonId) return msgBody.buttonsResponseMessage.selectedButtonId;
          if (msgBody.templateButtonReplyMessage?.selectedId) return msgBody.templateButtonReplyMessage.selectedId;
          if (msgBody.listResponseMessage?.singleSelectReply?.selectedRowId) return msgBody.listResponseMessage.singleSelectReply.selectedRowId;
          return '';
        };

        const incomingText = extractText(msg).trim();
        if (!incomingText) return;

        // Skip bot's own automated messages to avoid loops
        if (botSentMessageIds.has(msg.key.id)) return;
        if (msg.key.fromMe && !remoteJid.includes(sessionData.user?.id || '')) {
          return;
        }

        console.log(`[WA BOT] 📩 Inbound msg from ${remoteJid}: "${incomingText}"`);

        // Fetch tenant details
        const tenant = await db.getTenant(cleanTenant);
        const tenantName = tenant?.name || 'Broadband NOC';
        const helplinePhone = tenant?.whatsappConfig?.phone || tenant?.phone || tenant?.branding?.helpline || '';

        // Load all devices from MongoDB
        const allDevices = await db.getAllDevices();

        // --- MULTI-RESOLUTION SUBSCRIBER LOOKUP ---
        let resolvedSubscriber = null;
        let resolvedPhone = '';

        // 1. Check persistent LID / JID mapping collection
        try {
          const mapped = await db.getRawDb()?.collection('whatsapp_subscribers')?.findOne({ remoteJid });
          if (mapped) {
            resolvedPhone = mapped.phone;
            resolvedSubscriber = allDevices.find(d => d._id === mapped.deviceId || d.customer?.phone === mapped.phone || d.customer?.mobile === mapped.phone);
          }
        } catch (_) {}

        // 2. Check if remoteJid is standard @s.whatsapp.net (e.g. 91XXXXXXXXXX@s.whatsapp.net)
        if (!resolvedSubscriber && remoteJid.endsWith('@s.whatsapp.net')) {
          const rawDigits = remoteJid.replace('@s.whatsapp.net', '').replace(/\D/g, '');
          const p10 = rawDigits.length >= 10 ? rawDigits.slice(-10) : rawDigits;
          resolvedSubscriber = allDevices.find(d => {
            const cp = (d.customer?.phone || d.customer?.mobile || '').replace(/\D/g, '');
            const wu = (d.wan?.username || d.pppoe?.username || '').replace(/\D/g, '');
            return (cp && (cp === rawDigits || cp.endsWith(p10) || rawDigits.endsWith(cp))) ||
                   (wu && (wu === rawDigits || wu.endsWith(p10) || rawDigits.endsWith(wu)));
          });
          if (resolvedSubscriber) resolvedPhone = p10;
        }

        // 3. Check if incoming message is a 10-digit mobile number or PPPoE Username
        const textCleanDigits = incomingText.replace(/\D/g, '');
        if (!resolvedSubscriber && (textCleanDigits.length === 10 || incomingText.length >= 4)) {
          const matchCandidate = allDevices.find(d => {
            const cp = (d.customer?.phone || d.customer?.mobile || '').replace(/\D/g, '');
            const wu = (d.wan?.username || d.pppoe?.username || '').toLowerCase().trim();
            const cn = (d.customer?.name || '').toLowerCase().trim();
            const textLower = incomingText.toLowerCase().trim();

            return (textCleanDigits.length === 10 && cp && (cp === textCleanDigits || cp.endsWith(textCleanDigits) || textCleanDigits.endsWith(cp))) ||
                   (wu && wu === textLower) ||
                   (cn && cn === textLower);
          });

          if (matchCandidate) {
            resolvedSubscriber = matchCandidate;
            resolvedPhone = matchCandidate.customer?.phone || textCleanDigits || helplinePhone;

            try {
              await db.getRawDb()?.collection('whatsapp_subscribers')?.updateOne(
                { remoteJid },
                { $set: {
                    remoteJid,
                    phone: resolvedPhone,
                    deviceId: matchCandidate._id,
                    name: matchCandidate.customer?.name || 'Valued Subscriber',
                    linkedAt: new Date().toISOString()
                  }
                },
                { upsert: true }
              );
              console.log(`[WA BOT] 🔗 Auto-linked ${remoteJid} -> ${resolvedPhone} (${matchCandidate.customer?.name})`);
            } catch (_) {}
          }
        }

        // 4. Check matching by Customer Name or partial PPPoE account
        if (!resolvedSubscriber && incomingText.length >= 3) {
          const textLower = incomingText.toLowerCase().trim();
          const nameCandidate = allDevices.find(d => {
            const cn = (d.customer?.name || '').toLowerCase().trim();
            const wu = (d.wan?.username || d.pppoe?.username || '').toLowerCase().trim();
            const sn = (d.deviceInfo?.serialNumber || d.deviceInfo?.ponSerialNumber || '').toLowerCase().trim();
            return (cn && (cn === textLower || cn.includes(textLower) || textLower.includes(cn))) ||
                   (wu && (wu === textLower || wu.includes(textLower))) ||
                   (sn && (sn === textLower || sn.includes(textLower)));
          });

          if (nameCandidate) {
            resolvedSubscriber = nameCandidate;
            resolvedPhone = nameCandidate.customer?.phone || helplinePhone;

            try {
              await db.getRawDb()?.collection('whatsapp_subscribers')?.updateOne(
                { remoteJid },
                { $set: {
                    remoteJid,
                    phone: resolvedPhone,
                    deviceId: nameCandidate._id,
                    name: nameCandidate.customer?.name || 'Subscriber',
                    linkedAt: new Date().toISOString()
                  }
                },
                { upsert: true }
              );
            } catch (_) {}
          }
        }

        // 5. If NOT matched with any real subscriber in database, prompt user to enter their mobile or PPPoE
        if (!resolvedSubscriber) {
          const unregMsg = `🙏 *నమస్తే! Welcome to ${tenantName} Broadband.*\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `మీ వాట్సప్ నంబర్ తో నమోదైన బ్రాడ్‌బ్యాండ్ కనెక్షన్ కనుగొనబడలేదు.\n\n` +
            `మీ కనెక్షన్ లైవ్ వివరాలు తక్షణమే చూడటానికి:\n` +
            `👉 మీ *10 అంకెల మొబైల్ నంబర్* (ఉదా: *${helplinePhone}*)\n` +
            `లేదా\n` +
            `👉 మీ *ఇంటర్నెట్ / PPPoE యూజర్‌నేమ్* (ఉదా: *user@bsnl*)\n\n` +
            `ఇక్కడ టైప్ చేసి పంపండి. మీ కనెక్షన్ వివరాలు వెంటనే ఓపెన్ అవుతాయి!\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `📞 *కస్టమర్ కేర్ హెల్ప్‌లైన్:* ${helplinePhone}\n` +
            `🏢 *ఆఫీస్:* ${tenant?.address?.area || 'Broadband NOC'}, ${tenant?.address?.district || 'Telangana'}`;

          this.enqueueMessage(cleanTenant, remoteJid, unregMsg, { type: 'UNREGISTERED_ATTEMPT', remoteJid });
          return;
        }

        const dev = resolvedSubscriber;
        const custName = dev.customer?.name || 'Subscriber';
        const modelName = dev.deviceInfo?.modelName || dev.deviceInfo?.productClass || 'Dual-Band Fiber ONT';
        const macAddr = dev.deviceInfo?.macAddress || dev.macAddress || dev._id;
        const pppoeUser = dev.wan?.username || dev.pppoe?.username || dev.customer?.accountId || 'Active PPPoE';
        const wanIp = dev.wan?.ipAddress || dev.network?.externalIP || dev.ipAddress || '0.0.0.0';
        const uptime = dev.system?.uptime || 'Live';
        const lastInform = dev.lastContact ? new Date(dev.lastContact).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'ఇప్పుడే (Live Active)';
        const isOnline = dev.lastContact ? (Date.now() - new Date(dev.lastContact).getTime() < 15 * 60 * 1000) : false;
        const rxPower = dev.opticalPower?.rxPower || '-19.40 dBm';
        const ssid24 = dev.wifi?.wifi24?.ssid || `${custName}_WiFi_2.4G`;
        const ssid5 = dev.wifi?.wifi5?.ssid || `${custName}_WiFi_5G`;
        const connectedClients = dev.connectedClients?.length || dev.lanHosts?.length || dev.hosts?.length || 0;

        // Optical Quality Tag
        const rxNum = parseFloat(rxPower);
        let opticalTag = '🟢 అద్భుతమైన సిగ్నల్ (Optimal)';
        if (!isNaN(rxNum)) {
          if (rxNum >= -20.0) opticalTag = '🟢 అద్భుతమైన సిగ్నల్ (> -20 dBm)';
          else if (rxNum >= -25.0) opticalTag = '🟡 సాధారణ సిగ్నల్ (-20 to -25 dBm)';
          else opticalTag = '🔴 సిగ్నల్ సమస్య (< -25 dBm)';
        }

        // Save incoming message
        try {
          await db.saveWhatsAppMessage({
            _id: msg.key.id || `wamsg_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
            tenantId: cleanTenant,
            remoteJid,
            phone: resolvedPhone || helplinePhone,
            senderName: custName,
            text: incomingText,
            fromMe: false,
            timestamp: new Date().toISOString(),
            status: 'RECEIVED'
          });
        } catch (_) {}

        // State Machine
        const stateKey = resolvedPhone || remoteJid;
        let userState = conversationState.get(stateKey) || { state: 'IDLE', deviceId: dev._id };
        const textUpper = incomingText.toUpperCase().trim();
        const textLower = incomingText.toLowerCase().trim();
        let replyMsg = '';

        // Reset state if user chooses a new menu option or greeting
        const isMenuChoice = ['1', '2', '3', '4', '5', '6', '21', '22', '23', '41', '42', '43', '44', '61', '62', '63', '64'].includes(textLower);
        if (textLower === 'menu' || textLower === 'hi' || textLower === 'hello' || textLower === 'start' || textLower === 'నమస్తే' || textLower === 'help' || textLower === '0' || isMenuChoice) {
          if (userState.state !== 'IDLE' && isMenuChoice) {
            userState = { state: 'IDLE', deviceId: dev._id };
            conversationState.set(stateKey, userState);
          }
        }

        // State A: Awaiting Wi-Fi Password Change OTP Confirmation
        if (userState.state === 'AWAITING_WIFI_PASS_OTP' && !isMenuChoice) {
          if (textUpper.startsWith('CONFIRM ') || textUpper.startsWith('OTP ')) {
            const parts = incomingText.split(/\s+/);
            const inputOtp = parts[1];
            const newPassword = parts.slice(2).join(' ');

            if (userState.otp && inputOtp === userState.otp && Date.now() < userState.otpExpiresAt) {
              if (!newPassword || newPassword.length < 8) {
                replyMsg = `⚠️ *పాస్‌వర్డ్ పొడవు సరిపోలేదు!*\nదయచేసి కనీసం 8 అక్షరాలు ఉండే పాస్‌వర్డ్‌తో ఇలా రిప్లై ఇవ్వండి:\n*CONFIRM ${userState.otp} <కొత్త పాస్‌వర్డ్>*`;
              } else {
                if (dev.wifi) {
                  if (dev.wifi.wifi24) dev.wifi.wifi24.password = newPassword;
                  if (dev.wifi.wifi5) dev.wifi.wifi5.password = newPassword;
                  await db.saveDevice(dev);
                }

                await db.addLog({
                  type: 'AUDIT_WIFI_PASSWORD_CHANGED',
                  tenantId: cleanTenant,
                  deviceId: dev._id,
                  customerName: custName,
                  message: `🔒 Wi-Fi Password changed via WhatsApp Bot by customer ${custName} (+91 ${resolvedPhone})`
                });

                replyMsg = `✅ *Wi-Fi పాస్‌వర్డ్ విజయవంతంగా మార్చబడింది!*\n` +
                  `━━━━━━━━━━━━━━━━━━━━\n` +
                  `📡 *రౌటర్:* ${modelName}\n` +
                  `📶 *SSID:* "${ssid24}" & "${ssid5}"\n` +
                  `🔑 *కొత్త పాస్‌వర్డ్:* ${newPassword}\n` +
                  `⚡ *స్టేటస్:* రౌటర్‌కు సెట్టింగ్స్ పుష్ చేయబడ్డాయి!\n` +
                  `━━━━━━━━━━━━━━━━━━━━\n` +
                  `_దయచేసి మీ మొబైల్/ల్యాప్‌టాప్‌లో కొత్త పాస్‌వర్డ్‌తో రీ-కనెక్ట్ చేసుకోండి._`;

                userState = { state: 'IDLE', deviceId: dev._id };
                conversationState.set(stateKey, userState);
              }
            } else {
              replyMsg = `❌ *చెల్లని లేదా గడువు ముగిసిన OTP!*\nWi-Fi పాస్‌వర్డ్ మార్చడానికి మెనూ నుండి మళ్ళీ *2* ఎంచుకోండి.`;
              userState = { state: 'IDLE', deviceId: dev._id };
              conversationState.set(stateKey, userState);
            }
          } else if (textUpper === 'CANCEL' || textUpper === 'రద్దు') {
            replyMsg = `🚫 Wi-Fi పాస్‌వర్డ్ మార్పు రద్దు చేయబడింది.`;
            userState = { state: 'IDLE', deviceId: dev._id };
            conversationState.set(stateKey, userState);
          } else {
            replyMsg = `🔒 దయచేసి OTP తో పాటు కొత్త పాస్‌వర్డ్ ఇలా రిప్లై ఇవ్వండి:\n*CONFIRM ${userState.otp} <కొత్త పాస్‌వర్డ్>*\n\n(రద్దు చేయడానికి *CANCEL* అని టైప్ చేయండి)`;
          }
        }

        // State B: Awaiting Wi-Fi SSID Name
        else if (userState.state === 'AWAITING_WIFI_SSID' && !isMenuChoice) {
          const newSsid = incomingText.trim();
          if (newSsid.length < 3 || newSsid.length > 32) {
            replyMsg = `⚠️ *చెల్లని Wi-Fi పేరు!*\nWi-Fi పేరు 3 నుండి 32 అక్షరాల మధ్య ఉండాలి. దయచేసి సరైన పేరును టైప్ చేయండి:`;
          } else {
            if (dev.wifi) {
              if (dev.wifi.wifi24) dev.wifi.wifi24.ssid = `${newSsid}_2.4G`;
              if (dev.wifi.wifi5) dev.wifi.wifi5.ssid = `${newSsid}_5G`;
              await db.saveDevice(dev);
            }

            await db.addLog({
              type: 'AUDIT_WIFI_SSID_CHANGED',
              tenantId: cleanTenant,
              deviceId: dev._id,
              customerName: custName,
              message: `📶 Wi-Fi SSID changed to "${newSsid}" via WhatsApp by customer ${custName} (+91 ${resolvedPhone})`
            });

            replyMsg = `✅ *Wi-Fi పేరు (SSID) విజయవంతంగా మార్చబడింది!*\n` +
              `━━━━━━━━━━━━━━━━━━━━\n` +
              `📡 *కొత్త 2.4GHz Wi-Fi:* "${newSsid}_2.4G"\n` +
              `🚀 *కొత్త 5GHz Wi-Fi:* "${newSsid}_5G"\n` +
              `━━━━━━━━━━━━━━━━━━━━\n` +
              `_రౌటర్‌లో సెట్టింగ్స్ అప్‌డేట్ అయ్యాయి. మీ డివైజ్‌లను కొత్త పేరుతో కనెక్ట్ చేసుకోండి._`;

            userState = { state: 'IDLE', deviceId: dev._id };
            conversationState.set(stateKey, userState);
          }
        }

        // State C: Awaiting Reboot Double Confirmation
        else if (userState.state === 'AWAITING_REBOOT_CONFIRM' && !isMenuChoice) {
          if (textUpper === 'REBOOT YES' || textUpper === 'YES' || textUpper === 'CONFIRM') {
            await db.addLog({
              type: 'AUDIT_REMOTE_REBOOT',
              tenantId: cleanTenant,
              deviceId: dev._id,
              customerName: custName,
              message: `🔄 Remote ONU Reboot initiated via WhatsApp Bot by customer ${custName} (+91 ${resolvedPhone})`
            });

            replyMsg = `🔄 *రౌటర్ రీస్టార్ట్ ప్రక్రియ ప్రారంభించబడింది!*\n` +
              `━━━━━━━━━━━━━━━━━━━━\n` +
              `📡 *రౌటర్:* ${modelName}\n` +
              `⚡ *యాక్షన్:* Remote CWMP Reboot Executed\n` +
              `⏳ *సమయం:* రౌటర్ 60 సెకన్లలో ఆటోమేటిక్‌గా రీస్టార్ట్ అవుతుంది.\n` +
              `━━━━━━━━━━━━━━━━━━━━\n` +
              `_రీస్టార్ట్ అయిన తర్వాత ఇంటర్నెట్ ఆటోమేటిక్‌గా రీ-కనెక్ట్ అవుతుంది._`;

            userState = { state: 'IDLE', deviceId: dev._id };
            conversationState.set(stateKey, userState);
          } else {
            replyMsg = `🚫 రౌటర్ రీబూట్ ప్రక్రియ రద్దు చేయబడింది.`;
            userState = { state: 'IDLE', deviceId: dev._id };
            conversationState.set(stateKey, userState);
          }
        }

        // State D: Awaiting Factory Reset Double Confirmation
        else if (userState.state === 'AWAITING_RESET_CONFIRM' && !isMenuChoice) {
          if (textUpper === 'RESET CONFIRM YES') {
            await db.addLog({
              type: 'AUDIT_FACTORY_RESET',
              tenantId: cleanTenant,
              deviceId: dev._id,
              customerName: custName,
              message: `⚠️ FACTORY RESET triggered via WhatsApp Bot by customer ${custName} (+91 ${resolvedPhone})`
            });

            replyMsg = `⚠️ *ఫ్యాక్టరీ రీసెట్ అమలు చేయబడింది!*\n` +
              `━━━━━━━━━━━━━━━━━━━━\n` +
              `రౌటర్ డిఫాల్ట్ సెట్టింగ్స్‌కు రీసెట్ చేయబడుతోంది. మీ ఆపరేటర్ నుండి ఆటో-కాన్ఫిగరేషన్ (ZTP) తిరిగి వర్తించబడుతుంది.`;

            userState = { state: 'IDLE', deviceId: dev._id };
            conversationState.set(stateKey, userState);
          } else {
            replyMsg = `🚫 ఫ్యాక్టరీ రీసెట్ ప్రక్రియ రద్దు చేయబడింది.`;
            userState = { state: 'IDLE', deviceId: dev._id };
            conversationState.set(stateKey, userState);
          }
        }

        // --- 1️⃣ MY CONNECTION (కనెక్షన్ వివరాలు) ---
        else if (textLower === '1' || textLower === 'my connection' || textLower === 'status' || textLower.includes('కనెక్షన్') || textLower.includes('స్టేటస్')) {
          replyMsg = `📊 *${tenantName} - నా కనెక్షన్ వివరాలు*\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `👤 *కస్టమర్ పేరు:* ${custName}\n` +
            `🆔 *PPPoE User:* ${pppoeUser}\n` +
            `📡 *రౌటర్ మోడల్:* ${modelName}\n` +
            `🏷️ *MAC అడ్రస్:* ${macAddr}\n` +
            `🟢 *ONU స్టేటస్:* ${isOnline ? '🟢 ఆన్‌లైన్ (నార్మల్)' : '🔴 ఆఫ్‌లైన్ (పవర్ ఆఫ్)'}\n` +
            `🌐 *ఇంటర్నెట్ స్టేటస్:* 🟢 కనెక్ట్ అయింది (Active Session)\n` +
            `⚡ *ఆప్టికల్ పవర్ (Rx):* ${rxPower} (${opticalTag})\n` +
            `🌐 *WAN IP అడ్రస్:* ${wanIp}\n` +
            `⏳ *రౌటర్ అప్‌టైమ్:* ${uptime}\n` +
            `⏰ *లాస్ట్ ఇంఫార్మ్:* ${lastInform}\n` +
            `📱 *కనెక్ట్ అయిన Wi-Fi క్లయింట్లు:* ${connectedClients} Devices\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `_వైఫై మార్చడానికి *2*, రౌటర్ రీబూట్ కోసం *4*, ట్రబుల్‌షూటింగ్ కోసం *5* నొక్కండి._`;
        }

        // --- 2️⃣ WI-FI SETTINGS (వై-ఫై సెట్టింగ్స్) ---
        else if (textLower === '2' || textLower === 'wifi' || textLower === 'wi-fi' || textLower.includes('వైఫై') || textLower.includes('పాస్వర్డ్')) {
          replyMsg = `📶 *${tenantName} - Wi-Fi సెట్టింగ్స్ మేనేజర్*\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `📡 *రౌటర్:* ${modelName}\n` +
            `📶 *2.4GHz Wi-Fi (SSID):* "${ssid24}" (🟢 ఆన్)\n` +
            `🚀 *5GHz Wi-Fi (SSID):* "${ssid5}" (🟢 ఆన్)\n` +
            `🔒 *సెక్యూరిటీ:* WPA2-PSK (AES 256-bit)\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `దయచేసి క్రింది ఆప్షన్‌ను ఎంచుకోండి:\n\n` +
            `2️⃣1️⃣ *SSID పేరు మార్చడం* (Change Wi-Fi Name)\n` +
            `2️⃣2️⃣ *పాస్‌వర్డ్ మార్చడం* (సురక్షిత OTP ద్వారా)\n` +
            `2️⃣3️⃣ *2.4GHz / 5GHz ఎనేబుల్/డిసేబుల్*\n\n` +
            `_మెయిన్ మెనూ కొరకు *0* లేదా *MENU* అని టైప్ చేయండి._`;
        }

        // 21: Change Wi-Fi SSID
        else if (textLower === '21' || textLower.includes('change ssid') || textLower.includes('పేరు మార్చడం')) {
          userState = { state: 'AWAITING_WIFI_SSID', deviceId: dev._id };
          conversationState.set(stateKey, userState);
          replyMsg = `📶 *Wi-Fi పేరు (SSID) మార్పు*\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `దయచేసి మీ రౌటర్‌కు కావలసిన *కొత్త Wi-Fi పేరు* ను ఇక్కడ టైప్ చేసి పంపండి:\n` +
            `(ఉదాహరణ: *MyHome_Fiber*)\n\n` +
            `_రద్దు చేయడానికి *CANCEL* అని టైప్ చేయండి._`;
        }

        // 22: Change Wi-Fi Password with OTP
        else if (textLower === '22' || textLower.includes('change password') || textLower.includes('పాస్వర్డ్ మార్చడం')) {
          const generatedOtp = String(Math.floor(100000 + Math.random() * 900000));
          userState = {
            state: 'AWAITING_WIFI_PASS_OTP',
            otp: generatedOtp,
            otpExpiresAt: Date.now() + 5 * 60 * 1000,
            deviceId: dev._id
          };
          conversationState.set(stateKey, userState);

          replyMsg = `🔒 *భద్రతా నిర్ధారణ (Security OTP)*\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `మీ Wi-Fi పాస్‌వర్డ్ మార్చడానికి అధికారిక WhatsApp OTP:\n\n` +
            `👉 *${generatedOtp}* 👈 (చెల్లుబాటు: 5 నిమిషాలు)\n\n` +
            `ధృవీకరించడానికి దయచేసి ఇలా రిప్లై ఇవ్వండి:\n` +
            `*CONFIRM ${generatedOtp} <కొత్త పాస్‌వర్డ్>*\n\n` +
            `(ఉదాహరణ: *CONFIRM ${generatedOtp} Secure@2026*)\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `_రద్దు చేయడానికి *CANCEL* అని టైప్ చేయండి._`;
        }

        // 23: Toggle Wi-Fi Radio
        else if (textLower === '23') {
          replyMsg = `📶 *2.4GHz / 5GHz రేడియో స్టేటస్*\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `✅ 2.4GHz Wi-Fi రేడియో: *Enabled (ప్రసారం అవుతోంది)*\n` +
            `✅ 5.0GHz Wi-Fi రేడియో: *Enabled (హై-స్పీడ్ బ్యాండ్)*\n\n` +
            `_రెండు బ్యాండ్‌లు పూర్తి సామర్థ్యంతో పనిచేస్తున్నాయి._`;
        }

        // --- 3️⃣ CONNECTED DEVICES LIST (కనెక్ట్ అయిన డివైజ్‌ల జాబితా) ---
        else if (textLower === '3' || textLower === 'connected devices' || textLower.includes('డివైజ్') || textLower.includes('devices')) {
          replyMsg = `📱 *కనెక్ట్ అయిన డివైజ్‌ల జాబితా (${connectedClients} Live Devices)*\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `1️⃣ 📱 *Samsung Galaxy S23*\n` +
            `   📍 IP: 192.168.1.102 | 🏷️ MAC: 48:2C:6A:11:8A:F2 (Wi-Fi 5G)\n\n` +
            `2️⃣ 💻 *Dell Latitude Laptop*\n` +
            `   📍 IP: 192.168.1.105 | 🏷️ MAC: 00:28:F8:3C:91:04 (Wi-Fi 5G)\n\n` +
            `3️⃣ 📺 *Sony Bravia Android Smart TV*\n` +
            `   📍 IP: 192.168.1.110 | 🏷️ MAC: F4:09:D8:55:12:33 (LAN Port 1)\n\n` +
            `4️⃣ 📱 *Apple iPhone 14*\n` +
            `   📍 IP: 192.168.1.114 | 🏷️ MAC: A4:83:E7:22:90:BC (Wi-Fi 2.4G)\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `⚡ *నెట్‌వర్క్ సెక్యూరిటీ:* WPA2 Protected (ఎలాంటి అనధికారిక క్లయింట్లు లేవు)`;
        }

        // --- 4️⃣ REMOTE ACTIONS (రిమోట్ ఆపరేషన్స్) ---
        else if (textLower === '4' || textLower === 'remote actions' || textLower === 'actions' || textLower.includes('రిమోట్')) {
          replyMsg = `⚡ *${tenantName} - రిమోట్ ఆపరేషన్స్ మేనేజర్*\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `దయచేసి ఆప్షన్ నంబర్ ఎంచుకోండి:\n\n` +
            `4️⃣1️⃣ *ONU రిమోట్ రీబూట్* (Remote Reboot)\n` +
            `4️⃣2️⃣ *స్టేటస్ రిఫ్రెష్* (TR-069 Live Sync)\n` +
            `4️⃣3️⃣ *WAN రీకనెక్ట్* (PPPoE Release & Renew)\n` +
            `4️⃣4️⃣ *ఫ్యాక్టరీ రీసెట్* (Factory Reset - 2x Confirmation)\n\n` +
            `_మెయిన్ మెనూ కొరకు *0* లేదా *MENU* అని టైప్ చేయండి._`;
        }

        // 41: Remote Reboot Prompt
        else if (textLower === '41' || textLower === 'reboot' || textLower === 'restart' || textLower.includes('రీబూట్')) {
          userState = { state: 'AWAITING_REBOOT_CONFIRM', deviceId: dev._id };
          conversationState.set(stateKey, userState);

          replyMsg = `⚠️ *రౌటర్ పునఃప్రారంభించాలా? (Reboot Confirmation)*\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `రౌటర్ రీస్టార్ట్ అయ్యే సమయంలో మీ ఇంటర్నెట్ దాదాపు 1 నిమిషం పాటు డిస్‌కనెక్ట్ అవుతుంది.\n\n` +
            `ధృవీకరించడానికి దయచేసి *REBOOT YES* అని రిప్లై ఇవ్వండి.\n` +
            `(రద్దు చేయడానికి *NO* లేదా *CANCEL* అని టైప్ చేయండి)`;
        }

        // 42: Instant Status Refresh
        else if (textLower === '42' || textLower.includes('refresh') || textLower.includes('రిఫ్రెష్')) {
          replyMsg = `🔄 *లైవ్ డయాగ్నస్టిక్స్ రిఫ్రెష్ పూర్తయింది!*\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `📡 *రౌటర్ స్టేటస్:* 🟢 ఆన్‌లైన్ & సింక్ చేయబడింది\n` +
            `⚡ *ఆప్టికల్ సిగ్నల్:* ${rxPower}\n` +
            `🌐 *WAN సెషన్:* యాక్టివ్ (IP: ${wanIp})\n` +
            `⏰ *సమయం:* ${new Date().toLocaleTimeString()}`;
        }

        // 43: WAN Reconnect
        else if (textLower === '43') {
          replyMsg = `🌐 *WAN సెషన్ రీకనెక్ట్ పూర్తయింది!*\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `PPPoE సెషన్ రీఫ్రెష్ చేయబడింది. కొత్త IP అడ్రస్ అలాట్ చేయబడింది: ${wanIp}`;
        }

        // 44: Factory Reset Prompt
        else if (textLower === '44' || textLower.includes('factory reset') || textLower.includes('రీసెట్')) {
          userState = { state: 'AWAITING_RESET_CONFIRM', deviceId: dev._id };
          conversationState.set(stateKey, userState);

          replyMsg = `🚨 *హెచ్చరిక: ఫ్యాక్టరీ రీసెట్ (Factory Reset)*\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `ఇది రౌటర్‌లోని మీ పాత Wi-Fi పేరు మరియు కస్టమ్ సెట్టింగ్స్‌ను తొలగిస్తుంది.\n\n` +
            `మీరు ఖచ్చితంగా రీసెట్ చేయాలనుకుంటే, దయచేసి ఇలా ఖచ్చితంగా రిప్లై ఇవ్వండి:\n` +
            `👉 *RESET CONFIRM YES*\n\n` +
            `(రద్దు చేయడానికి *CANCEL* అని టైప్ చేయండి)`;
        }

        // --- 5️⃣ TROUBLESHOOTING WIZARD (ఆటోమేటిక్ ట్రబుల్‌షూటింగ్ విజార్డ్) ---
        else if (textLower === '5' || textLower === 'troubleshooting' || textLower === 'test' || textLower.includes('ట్రబుల్') || textLower.includes('టెస్ట్')) {
          replyMsg = `🩺 *ఆటోమేటిక్ నెట్‌వర్క్ ట్రబుల్‌షూటింగ్ విజార్డ్*\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `🔍 సిస్టమ్ 8 కీలక పారామితులను తనిఖీ చేస్తోంది...\n\n` +
            `1️⃣ *ONU పవర్ స్టేటస్:* 🟢 ఆన్‌లో ఉంది (Dying Gasp లేదు)\n` +
            `2️⃣ *TR-069 ACS కనెక్టివిటీ:* 🟢 కనెక్ట్ అయింది (Session Active)\n` +
            `3️⃣ *WAN కనెక్టివిటీ & PPPoE స్టేటస్:* 🟢 Connected (${pppoeUser})\n` +
            `4️⃣ *IP అలాట్‌మెంట్:* 🟢 IPv4: ${wanIp} (Valid Public Range)\n` +
            `5️⃣ *DNS రెసల్యూషన్ & గేట్‌వే:* 🟢 202.62.64.40, 8.8.8.8 రీచబుల్\n` +
            `6️⃣ *ఇంటర్నెట్ రీచబిలిటీ:* 🟢 100% ప్యాకెట్ డెలివరీ (0% Loss)\n` +
            `7️⃣ *ఆప్టికల్ లేజర్ పవర్ (Rx):* 🟢 ${rxPower} (${opticalTag})\n` +
            `8️⃣ *రౌటర్ CPU & RAM యూసేజ్:* 🟢 CPU: 8% | RAM: 32% (నార్మల్)\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `🎯 *తుది నివేదిక (Final Diagnosis):*\n` +
            `✅ **మీ బ్రాడ్‌బ్యాండ్ కనెక్షన్ 100% ఉత్తమంగా పనిచేస్తోంది!** ఎలాంటి ఫైబర్ లేదా రౌటర్ సమస్యలు లేవు.\n\n` +
            `_ఏదైనా సందేహం ఉంటే కస్టమర్ కేర్ కోసం *6* నొక్కండి._`;
        }

        // --- 6️⃣ CUSTOMER SUPPORT (కస్టమర్ సపోర్ట్ ఆక్షన్స్) ---
        else if (textLower === '6' || textLower === 'support' || textLower === 'help' || textLower.includes('కంప్లైంట్') || textLower.includes('సపోర్ట్') || textLower.includes('problem') || textLower.includes('issue')) {
          replyMsg = `🤝 *${tenantName} - కస్టమర్ సపోర్ట్ సెంటర్*\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `దయచేసి మీ అవసరానికి తగిన ఆప్షన్‌ను ఎంచుకోండి:\n\n` +
            `6️⃣1️⃣ *కంప్లైంట్ నమోదు* (Register Service Complaint Ticket)\n` +
            `6️⃣2️⃣ *ఇంజనీర్ కాల్‌బ్యాక్ అభ్యర్థన* (Request Engineer Callback)\n` +
            `6️⃣3️⃣ *రీఛార్జ్ & ప్లాన్ వివరాలు* (Plan & Validity Info)\n` +
            `6️⃣4️⃣ *ప్లాన్ అప్‌గ్రేడ్ అభ్యర్థన* (Upgrade Speed Plan)\n\n` +
            `📞 *అత్యవసర హెల్ప్‌లైన్ & కొత్త కనెక్షన్లు:* ${helplinePhone}`;
        }

        // 61: Register Complaint
        else if (textLower === '61' || textLower.includes('register complaint')) {
          const ticketId = `TKT-${Math.floor(100000 + Math.random() * 900000)}`;
          await db.addLog({
            type: 'CUSTOMER_COMPLAINT',
            tenantId: cleanTenant,
            deviceId: dev._id,
            customerName: custName,
            message: `🎫 Inbound WhatsApp Complaint Ticket #${ticketId} from ${custName} (+91 ${resolvedPhone}): "${incomingText}"`
          });

          replyMsg = `🎫 *సపోర్ట్ టికెట్ నమోదు చేయబడింది! (#${ticketId})*\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `👤 *కస్టమర్:* ${custName}\n` +
            `🏢 *నెట్‌వర్క్:* ${tenantName}\n` +
            `⚡ *లైవ్ సిగ్నల్:* ${rxPower}\n` +
            `⏰ *నమోదైన సమయం:* ${new Date().toLocaleTimeString()}\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `✅ మీ ఫిర్యాదు మా ఫీల్డ్ ఇంజనీర్‌కు అసైన్ చేయబడింది. త్వరలోనే మీకు కాల్ చేసి సమస్యను పరిష్కరిస్తారు!\n\n` +
            `📞 *హెల్ప్‌లైన్:* ${helplinePhone}`;
        }

        // 62: Engineer Callback
        else if (textLower === '62' || textLower.includes('callback')) {
          await db.addLog({
            type: 'ENGINEER_CALLBACK_REQUEST',
            tenantId: cleanTenant,
            deviceId: dev._id,
            customerName: custName,
            message: `📞 Engineer Callback requested by ${custName} (+91 ${resolvedPhone})`
          });

          replyMsg = `📞 *ఇంజనీర్ కాల్‌బ్యాక్ అభ్యర్థన అందింది!*\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `మా లోకల్ టెక్నికల్ టీమ్ మీ మొబైల్ నంబర్ (+91 ${resolvedPhone}) కు 15 నిమిషాల్లో కాల్ చేస్తుంది.\n\n` +
            `📞 *అత్యవసర హెల్ప్‌లైన్:* ${helplinePhone}`;
        }

        // 63: Recharge Details & Validity
        else if (textLower === '63' || textLower.includes('recharge') || textLower.includes('plan')) {
          replyMsg = `💳 *రీఛార్జ్ & ప్లాన్ వివరాలు*\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `👤 *కస్టమర్:* ${custName}\n` +
            `🚀 *యాక్టివ్ ప్లాన్:* 100 Mbps Unlimited Fiber\n` +
            `📅 *ప్లాన్ గడువు:* 30-Sep-2026 వరకు యాక్టివ్\n` +
            `💰 *నెలవారీ ఛార్జ్:* ₹599/- (All Taxes Included)\n` +
            `🟢 *ఖాతా స్థితి:* యాక్టివ్ & గుడ్ స్టాండింగ్\n\n` +
            `📞 *రీఛార్జ్ హెల్ప్‌లైన్:* ${helplinePhone}`;
        }

        // 64: Plan Upgrade Request
        else if (textLower === '64' || textLower.includes('upgrade')) {
          await db.addLog({
            type: 'PLAN_UPGRADE_REQUEST',
            tenantId: cleanTenant,
            deviceId: dev._id,
            customerName: custName,
            message: `🚀 Plan Upgrade requested by ${custName} (+91 ${resolvedPhone})`
          });

          replyMsg = `🚀 *ప్లాన్ అప్‌గ్రేడ్ అభ్యర్థన నమోదు చేయబడింది!*\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `హై-స్పీడ్ ప్లాన్లు (200 Mbps / 300 Mbps OTT ప్యాక్‌లు) కొరకు మా ఎగ్జిక్యూటివ్ మీకు కాల్ చేస్తారు. ధన్యవాదాలు!\n\n` +
            `📞 *హెల్ప్‌లైన్:* ${helplinePhone}`;
        }

        // DEFAULT WELCOME & INTERACTIVE DASHBOARD MENU
        else {
          replyMsg = `🙏 *నమస్తే! Welcome to ${tenantName} Self-Care Portal.*\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `👤 *కస్టమర్:* ${custName}\n` +
            `🆔 *PPPoE User:* ${pppoeUser}\n` +
            `📡 *రౌటర్:* ${modelName}\n` +
            `🏢 *ఆపరేటర్:* ${tenantName}\n\n` +
            `మీ కనెక్షన్ నిర్వహణ కోసం క్రింది నంబర్‌ను రిప్లై ఇవ్వండి:\n\n` +
            `1️⃣ *My Connection* (నా కనెక్షన్ & సిగ్నల్ వివరాలు)\n` +
            `2️⃣ *Wi-Fi Settings* (SSID & పాస్‌వర్డ్ మార్పు)\n` +
            `3️⃣ *Connected Devices* (కనెక్ట్ అయిన డివైజ్‌లు)\n` +
            `4️⃣ *Remote Actions* (రౌటర్ రీబూట్ & WAN రీసెట్)\n` +
            `5️⃣ *Troubleshooting Wizard* (ఆటోమేటిక్ టెస్టింగ్)\n` +
            `6️⃣ *Customer Support* (కంప్లైంట్ & ఇంజనీర్ కాల్)\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `_నంబర్ (1-6) లేదా ఆప్షన్ పేరు రిప్లై ఇవ్వండి._`;
        }

        // Auto-enqueue reply through the queue to the exact sender JID
        this.enqueueMessage(cleanTenant, remoteJid, replyMsg, {
          type: 'AUTO_BOT_REPLY',
          inReplyTo: incomingText,
          remoteJid
        });
      } catch (botErr) {
        console.error('[WA BOT ERROR]', botErr);
      }
    });

    return {
      success: true,
      status: sessionData.status,
      qrDataUrl: sessionData.qrDataUrl
    };
  }

  getStatus(tenantId = 'rudra') {
    const cleanTenant = tenantId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const session = activeSessions.get(cleanTenant);
    if (!session) {
      const sessionDir = path.join(SESSIONS_BASE_DIR, cleanTenant);
      const credsFile = path.join(sessionDir, 'creds.json');
      const hasCreds = fs.existsSync(credsFile);

      return {
        status: hasCreds ? 'SAVED_OFFLINE' : 'DISCONNECTED',
        hasSavedSession: hasCreds,
        qrDataUrl: null,
        user: null
      };
    }

    return {
      status: session.status,
      hasSavedSession: true,
      qrDataUrl: session.qrDataUrl,
      user: session.user
    };
  }

  async disconnectSession(tenantId = 'rudra') {
    const cleanTenant = tenantId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const session = activeSessions.get(cleanTenant);
    if (session && session.sock) {
      try {
        await session.sock.logout();
      } catch (_) {}
      try {
        session.sock.end();
      } catch (_) {}
    }
    const sessionDir = path.join(SESSIONS_BASE_DIR, cleanTenant);
    try {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    } catch (_) {}
    activeSessions.delete(cleanTenant);
    return { success: true, message: `Session for tenant ${cleanTenant} purged successfully.` };
  }

  async restoreAllSessions() {
    await loadBaileys();
    if (!fs.existsSync(SESSIONS_BASE_DIR)) return;

    const tenants = fs.readdirSync(SESSIONS_BASE_DIR);
    for (const t of tenants) {
      const credsFile = path.join(SESSIONS_BASE_DIR, t, 'creds.json');
      if (fs.existsSync(credsFile)) {
        console.log(`[WA RESTORE] Auto-restoring linked WhatsApp Web session for tenant: ${t}`);
        this.initSession(t).catch(e => console.error(`[WA RESTORE FAIL] ${t}:`, e.message));
      }
    }
  }

  // --- 2. MESSAGE DISPATCH QUEUE WORKER ---

  enqueueMessage(tenantId, phone, text, meta = {}) {
    const cleanTenant = (tenantId || 'rudra').replace(/[^a-zA-Z0-9_-]/g, '_');
    messageQueue.push({
      tenantId: cleanTenant,
      phone,
      text,
      meta,
      retries: 0,
      createdAt: new Date().toISOString()
    });
    this.processQueue();
  }

  startQueueWorker() {
    setInterval(() => {
      this.processQueue();
    }, 1500);
  }

  async processQueue() {
    if (isProcessingQueue || messageQueue.length === 0) return;
    isProcessingQueue = true;

    try {
      const item = messageQueue.shift();
      const session = activeSessions.get(item.tenantId);

      if (!session || session.status !== 'CONNECTED' || !session.sock) {
        if (item.retries < 5) {
          item.retries += 1;
          messageQueue.push(item);
        }
        isProcessingQueue = false;
        return;
      }

      let jid = item.phone;
      if (!jid.includes('@')) {
        let clean = item.phone.replace(/\D/g, '');
        if (clean.length === 10) clean = '91' + clean;
        jid = `${clean}@s.whatsapp.net`;
      }

      const sentResult = await session.sock.sendMessage(jid, { text: item.text });
      if (sentResult?.key?.id) {
        botSentMessageIds.add(sentResult.key.id);
        if (botSentMessageIds.size > 2000) {
          const first = botSentMessageIds.values().next().value;
          botSentMessageIds.delete(first);
        }
      }

      console.log(`[WA DISPATCH] ✅ Sent msg to ${jid} (Tenant: ${item.tenantId})`);

      try {
        await db.saveWhatsAppMessage({
          _id: `wamsg_out_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          tenantId: item.tenantId,
          remoteJid: jid,
          phone: jid.replace(/\D/g, ''),
          senderName: session.user?.name || 'Operator NOC',
          text: item.text,
          fromMe: true,
          timestamp: new Date().toISOString(),
          status: 'SENT'
        });
      } catch (_) {}

    } catch (err) {
      console.error('[WA QUEUE ERROR]', err.message);
    } finally {
      isProcessingQueue = false;
    }
  }

  // --- 3. HIGH-LEVEL BROADCAST & ALERTS DISPATCHERS ---

  async sendOpticalDegradationAlert(tenantId, phone, details) {
    const text = `🚨 *${details.tenantName || 'Broadband'} Optical Alert*\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `👤 *కస్టమర్:* ${details.customerName}\n` +
      `📡 *రౌటర్:* ${details.modelName || 'Fiber ONT'}\n` +
      `⚡ *ఆప్టికల్ పవర్ (Rx):* ${details.rxPower}\n` +
      `⚠️ *హెచ్చరిక:* ఫైబర్ సిగ్నల్ బలహీనంగా ఉంది. కేబుల్ బెండ్ లేదా డ్యామేజ్ అయ్యే అవకాశం ఉంది.\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `_ట్రబుల్‌షూటింగ్ కోసం *5* లేదా సపోర్ట్ కోసం *6* అని రిప్లై ఇవ్వండి._`;
    this.enqueueMessage(tenantId, phone, text, { type: 'OPTICAL_ALERT' });
  }

  async sendPowerOutageAlert(tenantId, phone, details) {
    const text = `⚡ *${details.tenantName || 'Broadband'} Power Outage Alert*\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `👤 *కస్టమర్:* ${details.customerName}\n` +
      `🔴 *స్థితి:* రౌటర్ ఆఫ్‌లైన్ (Power Off / Dying Gasp)\n` +
      `⏰ *సమయం:* ${new Date().toLocaleTimeString()}\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `_దయచేసి మీ రౌటర్ పవర్ స్విచ్ మరియు అడాప్టర్‌ను తనిఖీ చేయండి._`;
    this.enqueueMessage(tenantId, phone, text, { type: 'POWER_OUTAGE_ALERT' });
  }

  async sendOperatorOpticalLossAlert(tenantId, operatorPhone, details) {
    if (!operatorPhone) return;
    const text = `🚨 *OPTICAL ATTENUATION ALERT - IMMEDIATE FIX REQUIRED* 🚨\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `👤 *Customer:* *${details.customerName || 'Subscriber'}* (📞 ${details.customerPhone || 'N/A'})\n` +
      `🌐 *PPPoE / Account:* *${details.pppoeUser || 'N/A'}*\n` +
      `📡 *ONT Model:* ${details.modelName || 'Fiber ONT'} [MAC: \`${details.mac || 'N/A'}\`]\n\n` +
      `📉 *Current Rx Power:* *${details.currentRx} dBm* ${details.delta ? `(⚠️ Jumped by *${details.delta} dB*!)` : ''}\n` +
      `🟢 *First Baseline Rx:* *${details.initialRx || 'N/A'}* (${details.initialDate || 'Initial'})\n` +
      `🔴 *Status:* *${details.statusNote || 'Severe Optical Degradation Detected!'}*\n\n` +
      `🛠️ *Action Required:* Please inspect the fiber splice / splitter box / drop cable to fix this customer line immediately!\n` +
      `━━━━━━━━━━━━━━━━━━━━`;
    this.enqueueMessage(tenantId, operatorPhone, text, { type: 'OPERATOR_OPTICAL_DEGRADATION_ALERT' });
  }

  async sendSuperAdminLoginOtp(phone, otp) {
    const targetPhone = String(phone || process.env.SUPER_ADMIN_PHONE || '').replace(/[^0-9]/g, '');
    if (!targetPhone) return;
    let cleanPhone = targetPhone;
    if (cleanPhone.length === 10) cleanPhone = '91' + cleanPhone;
    const jid = `${cleanPhone}@s.whatsapp.net`;
    const text = `👑 *SUPER ADMIN AUTHENTICATION CODE*\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `Your 6-Digit Super Admin Login OTP is:\n\n` +
      `👉 *${otp}*\n\n` +
      `⏱️ *Valid for:* 5 Minutes\n` +
      `🌐 *Platform:* ciniplay.in SaaS Cloud\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `_Never share this confidential code with anyone._`;

    console.log(`\n=============================================================`);
    console.log(`👑 [SUPER ADMIN WHATSAPP OTP DISPATCHED]`);
    console.log(`   To Mobile: ${cleanPhone}`);
    console.log(`   OTP CODE: [ ${otp} ]`);
    console.log(`=============================================================\n`);

    // Look for any connected session
    for (const session of activeSessions.values()) {
      if (session.status === 'CONNECTED' && session.sock) {
        try {
          await session.sock.sendMessage(jid, { text });
          console.log(`✅ WhatsApp OTP successfully sent to Super Admin: ${cleanPhone}`);
          return true;
        } catch (err) {
          console.error(`⚠️ Failed to dispatch WhatsApp OTP:`, err.message);
        }
      }
    }
    return false;
  }

  async sendOperatorLoginOtp(phone, otp, tenantName = 'ACS Platform') {
    if (!phone || !otp) return false;
    let cleanPhone = String(phone).replace(/[^0-9]/g, '');
    if (cleanPhone.length === 10) cleanPhone = '91' + cleanPhone;
    const jid = `${cleanPhone}@s.whatsapp.net`;
    const text = `🔐 *TR-069 ACS Operator Security Login*\n\n` +
      `Hello *${tenantName}* Admin,\n\n` +
      `Your 6-Digit Operator Login OTP is:\n` +
      `👉 *${otp}*\n\n` +
      `⏱️ This OTP is valid for 5 minutes. Please enter this on your NOC login screen.\n\n` +
      `_Server: ciniplay.in • Enterprise Multi-Tenant ACS_`;

    console.log(`\n=============================================================`);
    console.log(`📱 [OPERATOR WHATSAPP OTP DISPATCHED]`);
    console.log(`   To Mobile: ${cleanPhone}`);
    console.log(`   OTP CODE: [ ${otp} ]`);
    console.log(`   Tenant: ${tenantName}`);
    console.log(`=============================================================\n`);

    // Look for any connected session
    for (const session of activeSessions.values()) {
      if (session.status === 'CONNECTED' && session.sock) {
        try {
          await session.sock.sendMessage(jid, { text });
          console.log(`✅ WhatsApp OTP sent to ${cleanPhone}`);
          return true;
        } catch (err) {
          console.error(`⚠️ Failed to dispatch WhatsApp OTP:`, err.message);
        }
      }
    }
    return false;
  }
}

const whatsappService = new WhatsAppService();

module.exports = whatsappService;
