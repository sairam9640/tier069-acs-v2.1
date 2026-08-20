/**
 * Multi-Brand Router & ONT Identifier & PON SN Formatter
 */

function detectBrand(deviceInfo = {}) {
  const mfr = (deviceInfo.manufacturer || '').toLowerCase();
  const model = (deviceInfo.modelName || '').toLowerCase();
  const productClass = (deviceInfo.productClass || '').toLowerCase();
  const oui = (deviceInfo.oui || '').toLowerCase();
  const sn = (deviceInfo.serialNumber || '').toLowerCase();

  const combined = `${mfr} ${model} ${productClass} ${oui} ${sn}`;

  if (combined.includes('vsol') || combined.includes('v-sol') || model.startsWith('v28') || model.startsWith('v29') || oui.includes('00259e') || oui.includes('e067b3') || sn.startsWith('vsol')) {
    return { name: 'VSOL', icon: 'vsol', category: 'XPON ONT', logo: '🌐' };
  }
  if (combined.includes('syrotech') || model.includes('sy-') || model.includes('syro') || combined.includes('syro-tech') || sn.startsWith('syro')) {
    return { name: 'Syrotech', icon: 'syrotech', category: 'XPON/GPON ONT', logo: '⚡' };
  }
  if (combined.includes('netlink') || model.includes('hg323') || model.includes('v2804') || combined.includes('net-link') || sn.startsWith('netl')) {
    return { name: 'Netlink', icon: 'netlink', category: 'XPON ONT', logo: '🔗' };
  }
  if (combined.includes('huawei') || model.startsWith('hg8') || model.startsWith('eg8') || model.startsWith('hs8') || combined.includes('echolife') || sn.startsWith('hwtc') || sn.startsWith('48575443')) {
    return { name: 'Huawei', icon: 'huawei', category: 'GPON/EPON ONT', logo: '🔴' };
  }
  if (combined.includes('zte') || model.startsWith('f66') || model.startsWith('f67') || model.startsWith('f60') || combined.includes('zxhn') || sn.startsWith('zteg') || sn.startsWith('5a544547')) {
    return { name: 'ZTE', icon: 'zte', category: 'GPON/XPON ONT', logo: '🔷' };
  }
  if (combined.includes('tp-link') || combined.includes('tplink') || model.startsWith('archer') || model.startsWith('tl-') || model.startsWith('xc')) {
    return { name: 'TP-Link', icon: 'tplink', category: 'Router / ONT', logo: '🟢' };
  }
  if (combined.includes('digisol') || model.includes('dg-gr') || sn.startsWith('dggi')) {
    return { name: 'Digisol', icon: 'digisol', category: 'XPON ONT', logo: '🟡' };
  }
  if (combined.includes('optilink') || model.includes('op-') || sn.startsWith('opti')) {
    return { name: 'Optilink', icon: 'optilink', category: 'XPON ONT', logo: '🟣' };
  }
  if (combined.includes('richerlink') || model.includes('rl804') || model.includes('rl801')) {
    return { name: 'Richerlink', icon: 'richerlink', category: 'XPON ONT', logo: '🟠' };
  }
  if (combined.includes('gx') || combined.includes('genexis') || model.includes('platinum')) {
    return { name: 'GX / Genexis', icon: 'genexis', category: 'Fiber ONT', logo: '💎' };
  }
  if (combined.includes('dbc') || combined.includes('dbcom') || combined.includes('bdcom')) {
    return { name: 'DBC / BDCOM', icon: 'bdcom', category: 'EPON/GPON ONT', logo: '📡' };
  }
  if (combined.includes('tenda')) {
    return { name: 'Tenda', icon: 'tenda', category: 'WiFi Router/ONT', logo: '🔶' };
  }
  if (combined.includes('d-link') || combined.includes('dlink') || model.startsWith('dir-')) {
    return { name: 'D-Link', icon: 'dlink', category: 'Router / ONT', logo: '🔸' };
  }
  if (combined.includes('c-data') || combined.includes('cdata')) {
    return { name: 'C-Data', icon: 'cdata', category: 'XPON ONT', logo: '🛰️' };
  }
  if (combined.includes('nokia') || combined.includes('alcatel') || sn.startsWith('alcl')) {
    return { name: 'Nokia / Alcatel', icon: 'nokia', category: 'GPON ONT', logo: '🟦' };
  }
  if (combined.includes('fiberhome') || sn.startsWith('fhtt')) {
    return { name: 'FiberHome', icon: 'fiberhome', category: 'GPON ONT', logo: '🌐' };
  }

  const fallbackName = deviceInfo.manufacturer || 'Generic TR-069';
  return { name: fallbackName, icon: 'generic', category: 'TR-069 CPE', logo: '📶' };
}

/**
 * Converts 16-character Hex PON Serial Number (e.g. 48575443... -> HWTC...)
 */
function formatPonSerialNumber(rawSn) {
  if (!rawSn) return '';
  const clean = String(rawSn).trim();

  // If already standard format (e.g. HWTC12345678, ZTEG12345678, VSOL12345678)
  if (/^[A-Za-z]{4}[0-9A-Fa-f]{8,12}$/.test(clean)) {
    return clean.toUpperCase();
  }

  // If 16 hex characters (4 bytes vendor prefix in ASCII + 4 bytes serial)
  if (/^[0-9A-Fa-f]{16}$/.test(clean)) {
    const hexPrefix = clean.substring(0, 8);
    const suffix = clean.substring(8);
    let vendorAscii = '';
    for (let i = 0; i < 8; i += 2) {
      vendorAscii += String.fromCharCode(parseInt(hexPrefix.substr(i, 2), 16));
    }
    if (/^[A-Za-z0-9]{4}$/.test(vendorAscii)) {
      return `${vendorAscii.toUpperCase()}${suffix.toUpperCase()}`;
    }
  }

  return clean;
}

module.exports = {
  detectBrand,
  formatPonSerialNumber
};
