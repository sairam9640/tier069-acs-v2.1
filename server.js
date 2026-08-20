require('dotenv').config();
const http = require('http');
const express = require('express');
const cors = require('cors');
const path = require('path');
const { WebSocketServer } = require('ws');
const EventEmitter = require('events');

const { connectDB } = require('./lib/db/database');
const { createCwmpApp } = require('./lib/cwmp/cwmp-server');
const { createApiRouter } = require('./lib/api/api-routes');
const { startSnmpPoller } = require('./lib/olt/snmp-poller');
const { startSnmpTrapListener } = require('./lib/olt/snmp-trap-listener');

const CWMP_PORT = parseInt(process.env.CWMP_PORT || '7547', 10);
const PORTAL_PORT = parseInt(process.env.PORTAL_PORT || '80', 10);
const HOST = process.env.HOST || '0.0.0.0';

async function startServer() {
  console.log('====================================================');
  console.log('  ANTIGRAVITY FULL-END CUSTOM TR-069 ACS SERVER');
  console.log('  Support: VSOL, Syrotech, Netlink, Huawei, ZTE, etc.');
  console.log('====================================================');

  // Initialize DB
  await connectDB();

  // Verify SMTP Connection
  const emailService = require('./lib/auth/email-service');
  try {
    await emailService.verifySmtpConnection();
  } catch (e) {
    console.warn('[EMAIL STARTUP WARNING]', e.message);
  }

  // Restore active WhatsApp Web multi-device sessions
  const whatsappService = require('./lib/alerts/whatsapp-service');
  try {
    await whatsappService.restoreAllSessions();
  } catch (e) {
    console.warn('[WA STARTUP NOTICE]', e.message);
  }

  // Start Real-Time SNMP Poller & Trap Listener Daemons
  startSnmpPoller(30);
  startSnmpTrapListener(162);

  // Start Safe Read-Only Syrotech EPON OLT Collector (30s Background Sweep)
  const syrotechCollector = require('./lib/olt/syrotech-collector');
  try {
    syrotechCollector.startPolling(30);
  } catch (e) {
    console.warn('[OLT COLLECTOR STARTUP]', e.message);
  }

  // Event bus for real-time WebSocket communication
  const eventBus = new EventEmitter();

  // Load SSL Certificates for Port 443 and Port 7547 HTTPS
  const fs = require('fs');
  const net = require('net');
  const https = require('https');
  const letsEncryptCert = '/etc/letsencrypt/live/ciniplay.in/fullchain.pem';
  const letsEncryptKey = '/etc/letsencrypt/live/ciniplay.in/privkey.pem';
  const localKey = path.join(__dirname, 'ssl_key.pem');
  const localCert = path.join(__dirname, 'ssl_cert.pem');

  let certPath = fs.existsSync(letsEncryptCert) ? letsEncryptCert : (fs.existsSync(localCert) ? localCert : null);
  let keyPath = fs.existsSync(letsEncryptKey) ? letsEncryptKey : (fs.existsSync(localKey) ? localKey : null);

  // 1. Initialize CWMP Server (Port 7547) - Dual HTTP & HTTPS Listener
  const cwmpApp = createCwmpApp(eventBus);
  const httpCwmpServer = http.createServer(cwmpApp);
  let httpsCwmpServer = null;
  if (keyPath && certPath) {
    try {
      httpsCwmpServer = https.createServer({
        key: fs.readFileSync(keyPath),
        cert: fs.readFileSync(certPath)
      }, cwmpApp);
    } catch (e) {
      console.warn('[CWMP SSL Notice]', e.message);
    }
  }

  // Master Port 7547 Listener with automatic TLS/HTTP Protocol Sniffing
  const cwmpServer = net.createServer((socket) => {
    socket.once('data', (buffer) => {
      socket.pause();
      // Byte 0x16 (22) indicates TLS/SSL Handshake (https://)
      if (buffer[0] === 0x16 && httpsCwmpServer) {
        httpsCwmpServer.emit('connection', socket);
      } else {
        httpCwmpServer.emit('connection', socket);
      }
      socket.unshift(buffer);
      socket.resume();
    });
  });

  cwmpServer.listen(CWMP_PORT, HOST, () => {
    console.log(`[CWMP] TR-069 Dual HTTP/HTTPS Engine listening on port ${CWMP_PORT}`);
    console.log(`[CWMP] HTTP URL:  http://222.167.207.220:${CWMP_PORT}/`);
    console.log(`[CWMP] HTTPS URL: https://ciniplay.in:${CWMP_PORT}/`);
  });

  // 2. Initialize ISP Management Web Portal (Port 80)
  const portalApp = express();
  // Speedtest payload endpoint for TR-143 / router speed testing
  portalApp.get('/speedtest/dummy.bin', (req, res) => {
    const size = parseInt(req.query.bytes || '10485760', 10); // 10MB default
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', size);
    const chunk = Buffer.alloc(65536, 0);
    let sent = 0;
    function sendChunk() {
      while (sent < size) {
        const toSend = Math.min(chunk.length, size - sent);
        sent += toSend;
        const ok = res.write(chunk.slice(0, toSend));
        if (!ok) {
          res.once('drain', sendChunk);
          return;
        }
      }
      res.end();
    }
    sendChunk();
  });

  // Enterprise HTTP Security Headers (OWASP Top 10 Compliant)
  portalApp.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(self)');
    res.setHeader('Content-Security-Policy', "default-src 'self' https: http: data: blob: 'unsafe-inline' 'unsafe-eval'; img-src 'self' data: blob: https: http:; font-src 'self' https://fonts.gstatic.com data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://unpkg.com; connect-src 'self' wss: ws: https: http:; frame-ancestors 'self';");
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    next();
  });

  // 2. Intercept CWMP SOAP XML POST requests on ANY path (Port 80 / Port 443) before body parsers
  portalApp.use((req, res, next) => {
    if (req.method === 'POST' && !req.path.startsWith('/api')) {
      let data = '';
      req.setEncoding('utf8');
      req.on('data', chunk => data += chunk);
      req.on('end', () => {
        req.rawBody = data;
        // Check if request is TR-069 CWMP SOAP XML (Inform, Response, TransferComplete)
        const isSoap = data.includes('<soap') || data.includes('<SOAP') || data.includes('<cwmp:') || 
                       data.includes(':Envelope') || req.headers['soapaction'] !== undefined ||
                       (req.headers['content-type'] && req.headers['content-type'].includes('xml'));
        if (isSoap) {
          return cwmpApp(req, res, next);
        }
        // Otherwise parse JSON/urlencoded if needed
        if (req.headers['content-type'] && req.headers['content-type'].includes('json')) {
          try { req.body = JSON.parse(data || '{}'); } catch (_) { req.body = {}; }
        }
        next();
      });
    } else {
      next();
    }
  });

  // Body parsers with large limit for KYC docs & images (for standard API routes)
  portalApp.use(express.json({ limit: '50mb' }));
  portalApp.use(express.urlencoded({ limit: '50mb', extended: true }));

  // Explicit CWMP endpoints on Port 80
  portalApp.use(['/cwmp', '/tr069', '/acs', '/tr69', '/service'], cwmpApp);

  // Mount API Routes
  portalApp.use('/api', createApiRouter(eventBus));

  // Strict API 404 handler: NEVER return HTML for /api/*
  portalApp.all('/api/*', (req, res) => {
    res.status(404).json({
      success: false,
      message: `API endpoint not found: ${req.method} ${req.originalUrl}`
    });
  });

  // Strict Domain Isolation Guard: SuperAdmin is EXCLUSIVELY permanently on ciniplay.in
  const isMasterSuperAdminHost = (req) => {
    const host = (req.headers.host || '').split(':')[0].toLowerCase();
    return host === 'ciniplay.in' || host === 'www.ciniplay.in' || host === '222.167.207.220' || host === 'localhost' || host === '127.0.0.1';
  };

  // 👑 Super Admin SaaS Platform Owner Portal (RESTRICTED TO ciniplay.in ONLY)
  portalApp.use('/superadmin', (req, res, next) => {
    if (!isMasterSuperAdminHost(req)) {
      return res.status(404).send('<!DOCTYPE html><html><head><title>404 Not Found</title></head><body style="background:#0b0f19;color:#94a3b8;font-family:sans-serif;text-align:center;padding:5rem;"><h1 style="color:#fff;">404 Not Found</h1><p>Super Admin portal is only accessible from the primary platform domain (ciniplay.in).</p></body></html>');
    }
    next();
  }, express.static(path.join(__dirname, 'public', 'superadmin'), { etag: false, maxAge: 0 }));

  // Customer Self-Care Web App
  portalApp.use('/customer', express.static(path.join(__dirname, 'public', 'customer'), { etag: false, maxAge: 0 }));
  portalApp.use('/app', express.static(path.join(__dirname, 'public', 'customer'), { etag: false, maxAge: 0 }));

  // Field Technician Mobile Portal & PWA (Phase 4)
  portalApp.use('/technician', express.static(path.join(__dirname, 'public', 'technician'), { etag: false, maxAge: 0 }));
  portalApp.use('/tech', express.static(path.join(__dirname, 'public', 'technician'), { etag: false, maxAge: 0 }));

  // Serve Frontend Operator NOC UI (Rudra FiberNet)
  portalApp.use(express.static(path.join(__dirname, 'public'), {
    etag: false,
    maxAge: 0
  }));

  // Super Admin App SPA fallback (RESTRICTED TO ciniplay.in ONLY)
  portalApp.get(['/superadmin', '/superadmin/*'], (req, res) => {
    if (!isMasterSuperAdminHost(req)) {
      return res.status(404).send('<!DOCTYPE html><html><head><title>404 Not Found</title></head><body style="background:#0b0f19;color:#94a3b8;font-family:sans-serif;text-align:center;padding:5rem;"><h1 style="color:#fff;">404 Not Found</h1><p>Super Admin portal is only accessible from the primary platform domain (ciniplay.in).</p></body></html>');
    }
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.sendFile(path.join(__dirname, 'public', 'superadmin', 'index.html'));
  });

  // Customer App SPA fallback
  portalApp.get(['/customer/*', '/app/*'], (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.sendFile(path.join(__dirname, 'public', 'customer', 'index.html'));
  });

  // Technician App SPA fallback
  portalApp.get(['/technician/*', '/tech/*'], (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.sendFile(path.join(__dirname, 'public', 'technician', 'index.html'));
  });

  // Admin SPA Fallback
  portalApp.get('*', (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });

  const portalServer = http.createServer(portalApp);

  // 3. WebSocket for Live Updates
  const wss = new WebSocketServer({ server: portalServer, path: '/ws' });

  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'WELCOME', message: 'Connected to TR-069 Live Stream' }));
  });

  eventBus.on('device_updated', (device) => {
    const msg = JSON.stringify({ type: 'DEVICE_UPDATED', device });
    wss.clients.forEach(client => {
      if (client.readyState === 1) client.send(msg);
    });
  });

  eventBus.on('log_added', (log) => {
    const msg = JSON.stringify({ type: 'LOG_ADDED', log });
    wss.clients.forEach(client => {
      if (client.readyState === 1) client.send(msg);
    });
  });

  portalServer.listen(PORTAL_PORT, HOST, () => {
    console.log(`[PORTAL] ISP Management Portal running on http://${HOST}:${PORTAL_PORT}/ (Proxied via Nginx)`);
  });

  process.on('SIGTERM', () => {
    console.log('Shutting down TR-069 ACS...');
    cwmpServer.close();
    portalServer.close();
    process.exit(0);
  });
}

startServer().catch(err => {
  console.error('Fatal Server Startup Error:', err);
});
