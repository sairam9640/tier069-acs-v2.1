/**
 * TR-069 SOAP Envelope Generator
 */

function buildSoapEnvelope(headerContent = '', bodyContent = '', cwmpNs = 'urn:dslforum-org:cwmp-1-0') {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soap-env:Envelope 
  xmlns:soap-env="http://schemas.xmlsoap.org/soap/envelope/" 
  xmlns:soap-enc="http://schemas.xmlsoap.org/soap/encoding/" 
  xmlns:xsd="http://www.w3.org/2001/XMLSchema" 
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" 
  xmlns:cwmp="${cwmpNs}">
  <soap-env:Header>
    ${headerContent}
  </soap-env:Header>
  <soap-env:Body>
    ${bodyContent}
  </soap-env:Body>
</soap-env:Envelope>`.trim();
}

function buildHeader(cwmpId = '1', holdRequests = 0) {
  let header = `<cwmp:ID soap-env:mustUnderstand="1">${escapeXml(cwmpId)}</cwmp:ID>`;
  if (holdRequests !== undefined) {
    header += `\n    <cwmp:HoldRequests soap-env:mustUnderstand="1">${holdRequests}</cwmp:HoldRequests>`;
  }
  return header;
}

function buildInformResponse(cwmpId = '1', maxEnvelopes = 1) {
  const header = buildHeader(cwmpId);
  const body = `
    <cwmp:InformResponse>
      <MaxEnvelopes>${maxEnvelopes}</MaxEnvelopes>
    </cwmp:InformResponse>`;
  return buildSoapEnvelope(header, body);
}

function buildGetParameterValues(cwmpId, parameterNames = []) {
  const header = buildHeader(cwmpId);
  const items = parameterNames.map(name => `<string>${escapeXml(name)}</string>`).join('\n        ');
  const body = `
    <cwmp:GetParameterValues>
      <ParameterNames soap-enc:arrayType="xsd:string[${parameterNames.length}]">
        ${items}
      </ParameterNames>
    </cwmp:GetParameterValues>`;
  return buildSoapEnvelope(header, body);
}

function buildGetParameterNames(cwmpId, parameterPath = '', nextLevel = false) {
  const header = buildHeader(cwmpId);
  const body = `
    <cwmp:GetParameterNames>
      <ParameterPath>${escapeXml(parameterPath)}</ParameterPath>
      <NextLevel>${nextLevel ? '1' : '0'}</NextLevel>
    </cwmp:GetParameterNames>`;
  return buildSoapEnvelope(header, body);
}

function buildSetParameterValues(cwmpId, parameterValues = []) {
  // parameterValues = [{ name: '...', value: '...', type: 'xsd:string' }]
  const header = buildHeader(cwmpId);
  const items = parameterValues.map(p => {
    const type = p.type || inferType(p.value);
    return `
        <ParameterValueStruct>
          <Name>${escapeXml(p.name)}</Name>
          <Value xsi:type="${type}">${escapeXml(p.value)}</Value>
        </ParameterValueStruct>`;
  }).join('');

  const body = `
    <cwmp:SetParameterValues>
      <ParameterList soap-enc:arrayType="cwmp:ParameterValueStruct[${parameterValues.length}]">
        ${items}
      </ParameterList>
      <ParameterKey>ACS_SET_${Date.now()}</ParameterKey>
    </cwmp:SetParameterValues>`;
  return buildSoapEnvelope(header, body);
}

function buildReboot(cwmpId, commandKey = 'ACS_REBOOT') {
  const header = buildHeader(cwmpId);
  const body = `
    <cwmp:Reboot>
      <CommandKey>${escapeXml(commandKey)}</CommandKey>
    </cwmp:Reboot>`;
  return buildSoapEnvelope(header, body);
}

function buildFactoryReset(cwmpId) {
  const header = buildHeader(cwmpId);
  const body = `
    <cwmp:FactoryReset/>`;
  return buildSoapEnvelope(header, body);
}

function buildDownload(cwmpId, fileType, url, fileSize = 0, targetFileName = '') {
  const header = buildHeader(cwmpId);
  const body = `
    <cwmp:Download>
      <CommandKey>ACS_FW_${Date.now()}</CommandKey>
      <FileType>${escapeXml(fileType)}</FileType>
      <URL>${escapeXml(url)}</URL>
      <Username></Username>
      <Password></Password>
      <FileSize>${fileSize}</FileSize>
      <TargetFileName>${escapeXml(targetFileName)}</TargetFileName>
      <DelaySeconds>0</DelaySeconds>
      <SuccessURL></SuccessURL>
      <FailureURL></FailureURL>
    </cwmp:Download>`;
  return buildSoapEnvelope(header, body);
}

function inferType(val) {
  if (typeof val === 'boolean' || val === 'true' || val === 'false') {
    return 'xsd:boolean';
  }
  if (/^\d+$/.test(val)) {
    return 'xsd:unsignedInt';
  }
  if (/^-?\d+$/.test(val)) {
    return 'xsd:int';
  }
  return 'xsd:string';
}

function escapeXml(unsafe) {
  if (unsafe === undefined || unsafe === null) return '';
  return String(unsafe).replace(/[<>&'"]/g, c => {
    switch (c) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case '\'': return '&apos;';
      case '"': return '&quot;';
    }
  });
}

function buildAddObject(cwmpId, objectName, parameterKey = `ACS_ADD_${Date.now()}`) {
  const header = buildHeader(cwmpId);
  const body = `
    <cwmp:AddObject>
      <ObjectName>${escapeXml(objectName)}</ObjectName>
      <ParameterKey>${escapeXml(parameterKey)}</ParameterKey>
    </cwmp:AddObject>`;
  return buildSoapEnvelope(header, body);
}

function buildDeleteObject(cwmpId, objectName, parameterKey = `ACS_DEL_${Date.now()}`) {
  const header = buildHeader(cwmpId);
  const body = `
    <cwmp:DeleteObject>
      <ObjectName>${escapeXml(objectName)}</ObjectName>
      <ParameterKey>${escapeXml(parameterKey)}</ParameterKey>
    </cwmp:DeleteObject>`;
  return buildSoapEnvelope(header, body);
}

module.exports = {
  buildSoapEnvelope,
  buildInformResponse,
  buildGetParameterValues,
  buildGetParameterNames,
  buildSetParameterValues,
  buildReboot,
  buildFactoryReset,
  buildDownload,
  buildAddObject,
  buildDeleteObject
};
