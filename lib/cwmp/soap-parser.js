const { XMLParser } = require('fast-xml-parser');

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  removeNSPrefix: true, // Strips soap-env:, cwmp:, etc. for simple access
  isArray: (name) => {
    return ['ParameterValueStruct', 'EventStruct', 'ParameterInfoStruct', 'MethodList'].includes(name);
  }
});

function safeStr(val, fallback = '') {
  if (val === null || val === undefined) return fallback;
  if (typeof val === 'string') return val;
  if (typeof val === 'number') return String(val);
  if (typeof val === 'object') {
    if (val['#text'] !== undefined) return String(val['#text']);
    if (val._ !== undefined) return String(val._);
    if (val._text !== undefined) return String(val._text);
    return fallback;
  }
  return String(val);
}

function parseSoapMessage(xmlString) {
  if (!xmlString || typeof xmlString !== 'string' || xmlString.trim().length === 0) {
    return null;
  }

  try {
    const parsed = parser.parse(xmlString);
    const envelope = parsed.Envelope || parsed['soap:Envelope'] || parsed['SOAP-ENV:Envelope'] || parsed;
    const header = envelope.Header || envelope['soap:Header'] || envelope['SOAP-ENV:Header'] || {};
    const body = envelope.Body || envelope['soap:Body'] || envelope['SOAP-ENV:Body'] || {};

    // Extract CWMP ID from header if available
    let cwmpId = null;
    if (header.ID) {
      cwmpId = safeStr(header.ID, '1');
    }

    // Determine Message Type in Body
    const bodyKeys = Object.keys(body).filter(k => !k.startsWith('@_'));
    if (bodyKeys.length === 0) {
      return { type: 'Empty', id: cwmpId, raw: parsed };
    }

    const messageType = bodyKeys[0];
    const messageContent = body[messageType];

    const result = {
      type: messageType,
      id: cwmpId || '1',
      content: messageContent,
      raw: parsed
    };

    if (messageType === 'Inform') {
      result.informData = parseInform(messageContent);
    } else if (messageType === 'GetParameterValuesResponse') {
      result.parameters = parseParameterValueStructList(messageContent?.ParameterList || messageContent);
    } else if (messageType === 'SetParameterValuesResponse') {
      result.status = safeStr(messageContent?.Status, '0');
    } else if (messageType === 'GetParameterNamesResponse') {
      result.parameterList = parseParameterInfoStructList(messageContent?.ParameterList || messageContent);
    } else if (messageType === 'DownloadResponse') {
      result.status = safeStr(messageContent?.Status, '0');
      result.startTime = safeStr(messageContent?.StartTime, '');
      result.completeTime = safeStr(messageContent?.CompleteTime, '');
    } else if (messageType === 'TransferComplete') {
      result.transferData = {
        commandKey: safeStr(messageContent?.CommandKey, ''),
        faultCode: parseInt(safeStr(messageContent?.FaultStruct?.FaultCode, '0'), 10) || 0,
        faultString: safeStr(messageContent?.FaultStruct?.FaultString, ''),
        startTime: safeStr(messageContent?.StartTime, ''),
        completeTime: safeStr(messageContent?.CompleteTime, '')
      };
    } else if (messageType === 'RebootResponse') {
      result.rebootSuccess = true;
    } else if (messageType === 'FactoryResetResponse') {
      result.factoryResetSuccess = true;
    } else if (messageType === 'DeleteObjectResponse') {
      result.status = safeStr(messageContent?.Status, '0');
      result.deleteSuccess = true;
    } else if (messageType === 'AddObjectResponse') {
      result.instanceNumber = safeStr(messageContent?.InstanceNumber, '1');
      result.status = safeStr(messageContent?.Status, '0');
      result.addSuccess = true;
    } else if (messageType === 'Fault') {
      result.fault = parseFault(messageContent);
    }

    return result;
  } catch (err) {
    console.error('SOAP XML Parse Error:', err.message);
    return null;
  }
}

function parseInform(informObj) {
  if (!informObj) return {};

  const deviceId = informObj.DeviceId || {};
  const manufacturer = safeStr(deviceId.Manufacturer, 'GENERIC');
  const oui = safeStr(deviceId.OUI, '');
  const productClass = safeStr(deviceId.ProductClass, '');
  const serialNumber = safeStr(deviceId.SerialNumber, '');

  // Parse Events
  const events = [];
  const eventList = informObj.Event;
  const eventStructs = eventList?.EventStruct || (Array.isArray(eventList) ? eventList : [eventList]);
  if (Array.isArray(eventStructs)) {
    for (const ev of eventStructs) {
      if (ev && ev.EventCode) {
        events.push({
          code: safeStr(ev.EventCode, '2 PERIODIC'),
          commandKey: safeStr(ev.CommandKey, '')
        });
      }
    }
  }

  // Parse Parameters
  const parameterList = informObj.ParameterList || informObj;
  const parameters = parseParameterValueStructList(parameterList);

  return {
    deviceId: {
      manufacturer,
      oui,
      productClass,
      serialNumber
    },
    events,
    maxEnvelopes: parseInt(safeStr(informObj.MaxEnvelopes, '1'), 10) || 1,
    currentTime: safeStr(informObj.CurrentTime, new Date().toISOString()),
    retryCount: parseInt(safeStr(informObj.RetryCount, '0'), 10) || 0,
    parameters
  };
}

function parseParameterValueStructList(paramObj) {
  const result = {};
  if (!paramObj) return result;

  // Handle any nesting: ParameterList -> ParameterValueStruct, or direct ParameterValueStruct, or array
  const container = paramObj.ParameterList || paramObj;
  let structs = container.ParameterValueStruct || container;
  if (!Array.isArray(structs)) {
    structs = [structs];
  }

  for (const s of structs) {
    if (!s || typeof s !== 'object') continue;
    const rawName = s.Name !== undefined ? s.Name : (s['@_Name'] !== undefined ? s['@_Name'] : s.name);
    const rawValue = s.Value !== undefined ? s.Value : (s.value !== undefined ? s.value : s['#text']);

    const name = safeStr(rawName, '');
    const value = safeStr(rawValue, '');

    if (name) {
      result[name] = value;
    }
  }
  return result;
}

function parseParameterInfoStructList(paramObj) {
  const result = [];
  if (!paramObj) return result;

  const container = paramObj.ParameterList || paramObj;
  let structs = container.ParameterInfoStruct || container;
  if (!Array.isArray(structs)) {
    structs = [structs];
  }

  for (const s of structs) {
    if (!s) continue;
    const name = safeStr(s.Name || s.name || s, '');
    const writable = s.Writable === '1' || s.Writable === true || s.Writable === 'true';
    if (name) {
      result.push({ name, writable });
    }
  }
  return result;
}

function parseFault(faultObj) {
  if (!faultObj) return { faultCode: 9000, faultString: 'Unknown Fault' };
  const detail = faultObj.detail || faultObj.Detail || faultObj;
  const cwmpFault = detail['cwmp:Fault'] || detail.Fault || faultObj;

  return {
    faultCode: parseInt(safeStr(cwmpFault.FaultCode || faultObj.faultcode, '9000'), 10) || 9000,
    faultString: safeStr(cwmpFault.FaultString || faultObj.faultstring, 'Internal Fault'),
    setParameterValuesFault: cwmpFault.SetParameterValuesFault || []
  };
}

module.exports = {
  parseSoapMessage,
  parseInform,
  parseParameterValueStructList,
  safeStr
};
