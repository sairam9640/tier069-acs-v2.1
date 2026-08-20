/**
 * Enterprise SSRF (Server-Side Request Forgery) Defense Shield
 * Blocks attacks against Cloud Metadata (AWS/GCP/Azure/DigitalOcean), Loopback, and Private Subnets.
 */

const { URL } = require('url');

const PROHIBITED_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  '169.254.169.254',
  'metadata.google.internal',
  'instance-data',
  '100.100.100.200' // Alibaba metadata
]);

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);
const ALLOWED_CWMP_PORTS = new Set([80, 443, 7547, 7548, 8080, 8443, 9000, 3000]);

function isPrivateIp(ip) {
  if (!ip || typeof ip !== 'string') return false;
  const clean = ip.trim();

  // Cloud metadata & link-local: 169.254.0.0/16
  if (clean.startsWith('169.254.')) return true;

  // Loopback: 127.0.0.0/8
  if (clean.startsWith('127.')) return true;

  // 0.0.0.0
  if (clean === '0.0.0.0') return true;

  // IPv6 Loopback / Link-Local / Unique Local
  if (clean === '::1' || clean.startsWith('fe80:') || clean.startsWith('fc00:') || clean.startsWith('fd00:')) return true;

  return false;
}

/**
 * Validates whether a target URL is safe to request from the server
 * @param {string} urlStr
 * @param {object} options { allowPrivateSubnet: boolean, allowedPorts: Set }
 * @returns {{ safe: boolean, error?: string, parsedUrl?: URL }}
 */
function validateSafeUrl(urlStr, options = {}) {
  if (!urlStr || typeof urlStr !== 'string') {
    return { safe: false, error: 'URL string is empty or invalid' };
  }

  try {
    const parsed = new URL(urlStr.trim());
    const protocol = parsed.protocol.toLowerCase();
    const hostname = parsed.hostname.toLowerCase();
    const port = parsed.port ? parseInt(parsed.port, 10) : (protocol === 'https:' ? 443 : 80);

    // 1. Protocol Validation
    if (!ALLOWED_PROTOCOLS.has(protocol)) {
      return { safe: false, error: `Prohibited URL protocol "${protocol}". Only HTTP/HTTPS allowed.` };
    }

    // 2. Prohibited Hostname check
    if (PROHIBITED_HOSTS.has(hostname)) {
      return { safe: false, error: `Security Block: Prohibited destination host "${hostname}" (SSRF Shield)` };
    }

    // 3. IP range checks
    if (isPrivateIp(hostname)) {
      return { safe: false, error: `Security Block: Destination IP "${hostname}" is within a prohibited private/metadata range.` };
    }

    // 4. Port Validation
    const allowedPorts = options.allowedPorts || ALLOWED_CWMP_PORTS;
    if (allowedPorts && !allowedPorts.has(port)) {
      return { safe: false, error: `Security Block: Destination port ${port} is not in the allowed service port whitelist.` };
    }

    return { safe: true, parsedUrl: parsed };
  } catch (err) {
    return { safe: false, error: `Malformed URL: ${err.message}` };
  }
}

module.exports = {
  validateSafeUrl,
  isPrivateIp
};
