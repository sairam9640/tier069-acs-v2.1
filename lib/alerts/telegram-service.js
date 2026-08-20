const https = require('https');
const db = require('../db/database');

/**
 * Send Telegram Alert notification to ISP operator channel
 */
async function sendTelegramAlert(text) {
  try {
    const settings = await db.getSettings();
    const token = settings.telegramBotToken || process.env.TELEGRAM_BOT_TOKEN;
    const chatId = settings.telegramChatId || process.env.TELEGRAM_CHAT_ID;

    if (!token || !chatId) return { success: false, message: 'Telegram not configured' };

    const payload = JSON.stringify({
      chat_id: chatId,
      text: text,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    });

    return new Promise((resolve) => {
      const req = https.request({
        hostname: 'api.telegram.org',
        port: 443,
        path: `/bot${token}/sendMessage`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        },
        timeout: 6000
      }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          resolve({ success: res.statusCode === 200, status: res.statusCode, body });
        });
      });

      req.on('error', (err) => {
        console.warn('[TELEGRAM] Error sending notification:', err.message);
        resolve({ success: false, error: err.message });
      });

      req.on('timeout', () => {
        req.destroy();
        resolve({ success: false, error: 'Timeout' });
      });

      req.write(payload);
      req.end();
    });
  } catch (err) {
    console.warn('[TELEGRAM] Notification failed:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Check device optical levels and send critical alert if degraded
 */
async function checkAndAlertOpticalStatus(device, opticalPower) {
  if (!device || !opticalPower) return;
  const rxStr = opticalPower.rxPower;
  if (!rxStr || rxStr === 'N/A') return;

  const rxNum = parseFloat(rxStr);
  const custName = device.customer?.name || device._id;
  const sn = device.deviceInfo?.ponSerialNumber || device.deviceInfo?.serialNumber || device._id;

  // Critical Low Optical Power (< -27.0 dBm)
  if (rxNum < -27.0) {
    const alertMsg = `🚨 <b>CRITICAL OPTICAL LOSS ALERT</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `👤 <b>Customer:</b> ${custName}\n` +
      `📟 <b>ONT:</b> ${device.deviceInfo?.brand?.name || 'XPON'} (${device.deviceInfo?.modelName || 'ONT'})\n` +
      `🔢 <b>SN:</b> <code>${sn}</code>\n` +
      `⚡ <b>RX Signal:</b> <b>${rxStr}</b> (High Attenuation / Dirty Fiber)\n` +
      `📤 <b>TX Power:</b> ${opticalPower.txPower || 'N/A'}\n` +
      `🌡️ <b>Temperature:</b> ${opticalPower.temperature || 'N/A'}\n` +
      `⏰ <b>Time:</b> ${new Date().toLocaleTimeString()} UTC`;

    await sendTelegramAlert(alertMsg);
  }

  // Overheating Laser (> 65 C)
  const tempNum = parseFloat(opticalPower.temperature);
  if (!isNaN(tempNum) && tempNum > 65.0) {
    const alertMsg = `🔥 <b>OVERHEATING TRANSCEIVER ALERT</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `👤 <b>Customer:</b> ${custName}\n` +
      `📟 <b>ONT:</b> ${device.deviceInfo?.brand?.name} - ${device.deviceInfo?.modelName}\n` +
      `🌡️ <b>Laser Temp:</b> <b>${opticalPower.temperature}</b> (Thermal Threshold Exceeded)\n` +
      `⚡ <b>RX Power:</b> ${rxStr}\n` +
      `⏰ <b>Time:</b> ${new Date().toLocaleTimeString()} UTC`;

    await sendTelegramAlert(alertMsg);
  }
}

module.exports = {
  sendTelegramAlert,
  checkAndAlertOpticalStatus
};
