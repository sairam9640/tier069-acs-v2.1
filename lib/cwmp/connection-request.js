const http = require('http');
const https = require('https');
const { validateSafeUrl } = require('../security/ssrf-shield');

async function triggerConnectionRequest(urlStr, username = '', password = '', timeoutMs = 3000) {
  if (!urlStr) {
    return {
      success: false,
      message: 'No ConnectionRequestURL configured. Task will execute on next keepalive.'
    };
  }

  // Strict SSRF Validation
  const ssrfCheck = validateSafeUrl(urlStr);
  if (!ssrfCheck.safe) {
    return {
      success: false,
      message: `SSRF Blocked: ${ssrfCheck.error}`
    };
  }

  return new Promise((resolve) => {
    try {
      const parsedUrl = ssrfCheck.parsedUrl;
      const isHttps = parsedUrl.protocol === 'https:';
      const client = isHttps ? https : http;

      const auth = username && password
        ? `${username}:${password}`
        : (parsedUrl.username && parsedUrl.password ? `${parsedUrl.username}:${parsedUrl.password}` : '');

      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'GET',
        headers: {
          'User-Agent': 'Antigravity-TR069-ACS/1.0',
          'Connection': 'close'
        },
        timeout: timeoutMs
      };

      if (auth) {
        options.headers['Authorization'] = 'Basic ' + Buffer.from(auth).toString('base64');
      }

      const req = client.request(options, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          if (res.statusCode === 200 || res.statusCode === 204 || res.statusCode === 401) {
            resolve({
              success: true,
              statusCode: res.statusCode,
              message: 'Instant wake-up signal delivered to ONT successfully!'
            });
          } else {
            resolve({
              success: false,
              statusCode: res.statusCode,
              message: `ONT responded with HTTP ${res.statusCode}. Task queued.`
            });
          }
        });
      });

      req.on('timeout', () => {
        req.destroy();
        resolve({
          success: false,
          message: 'ONT is in sleep/NAT mode. Task queued and will execute automatically on next keepalive.'
        });
      });

      req.on('error', (err) => {
        resolve({
          success: false,
          message: `Direct wake-up unreachable (${err.message}). Task queued for next keepalive.`
        });
      });

      req.end();
    } catch (err) {
      resolve({
        success: false,
        message: `Task queued (URL error: ${err.message})`
      });
    }
  });
}

module.exports = {
  triggerConnectionRequest
};
