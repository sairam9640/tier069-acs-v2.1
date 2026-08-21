const http = require('http');
const https = require('https');
const { validateSafeUrl } = require('../security/ssrf-shield');

/**
 * Executes a single HTTP Connection Request attempt.
 */
function singleConnectionAttempt(urlStr, username = '', password = '', timeoutMs = 2500) {
  const ssrfCheck = validateSafeUrl(urlStr);
  if (!ssrfCheck.safe) {
    return Promise.resolve({
      success: false,
      code: 'SSRF_BLOCKED',
      message: `SSRF Blocked: ${ssrfCheck.error}`
    });
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
          'User-Agent': 'Tier069-ACS-Engine/2.0',
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
          if (res.statusCode === 200 || res.statusCode === 204) {
            resolve({
              success: true,
              code: 'SUCCESS',
              statusCode: res.statusCode,
              message: 'Instant wake-up signal delivered to ONT successfully!'
            });
          } else if (res.statusCode === 401) {
            resolve({
              success: true, // CWMP 401 challenge counts as valid reachability / wake-up
              code: 'AUTH_CHALLENGE',
              statusCode: res.statusCode,
              message: 'ONT acknowledged Connection Request challenge (Active Wake-Up).'
            });
          } else {
            resolve({
              success: false,
              code: 'HTTP_ERROR',
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
          code: 'TIMEOUT',
          message: 'Connection Request timed out (Device behind CGNAT / sleeping).'
        });
      });

      req.on('error', (err) => {
        resolve({
          success: false,
          code: 'UNREACHABLE',
          message: `Direct wake-up unreachable (${err.message}).`
        });
      });

      req.end();
    } catch (err) {
      resolve({
        success: false,
        code: 'CLIENT_ERROR',
        message: `Task queued (URL error: ${err.message})`
      });
    }
  });
}

/**
 * Dispatches Connection Request with automatic retry & exponential backoff (Issue 2).
 */
async function triggerConnectionRequest(urlStr, username = '', password = '', maxRetries = 2, initialTimeoutMs = 2000) {
  if (!urlStr) {
    return {
      success: false,
      code: 'NO_URL',
      message: 'No ConnectionRequestURL configured. Task will execute on next keepalive inform.'
    };
  }

  let attempt = 0;
  let lastResult = null;

  while (attempt <= maxRetries) {
    attempt++;
    const timeout = initialTimeoutMs + (attempt * 500);
    lastResult = await singleConnectionAttempt(urlStr, username, password, timeout);
    
    if (lastResult.success) {
      return {
        ...lastResult,
        attempts: attempt
      };
    }

    // If unreachable or SSRF blocked on first attempt, no need to retry repeatedly
    if (lastResult.code === 'SSRF_BLOCKED') break;
    
    // Wait backoff before next retry (500ms * attempt)
    if (attempt <= maxRetries) {
      await new Promise(r => setTimeout(r, 400 * attempt));
    }
  }

  return {
    success: false,
    code: lastResult?.code || 'UNREACHABLE',
    attempts: attempt,
    message: `Router unreachable after ${attempt} attempts (${lastResult?.message || 'NAT/Sleep'}). Task queued for next keepalive inform.`
  };
}

module.exports = {
  triggerConnectionRequest
};
