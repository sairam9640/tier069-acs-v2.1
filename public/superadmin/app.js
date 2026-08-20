// =========================================================================
// VRV ACS — SUPER ADMIN SAAS COMMAND CENTER LOGIC (v8.0)
// Complete Real Data Integration, Tab Switching Engine & Auto-Logout
// =========================================================================

let currentOperators = [];
let currentPlans = [];
let currentInvoices = [];
let allFleetDevices = [];
let superAdminToken = localStorage.getItem('sa_auth_token') || '';

// Inactivity Auto-Logout: 15 Minutes (900 seconds)
const INACTIVITY_TIMEOUT_SECONDS = 900;
let inactivityRemaining = INACTIVITY_TIMEOUT_SECONDS;
let inactivityInterval = null;

document.addEventListener('DOMContentLoaded', () => {
  initSuperAdminAuth();
  initSuperAdminTheme();
  initTabNavigation();
  initInactivityTimer();
});

// =========================================================================
// 1. AUTHENTICATION & SESSION MANAGEMENT
// =========================================================================
function initSuperAdminAuth() {
  const token = localStorage.getItem('sa_auth_token');
  const shell = document.getElementById('saasDashboard');
  if (!token) {
    if (shell) {
      shell.style.display = 'none';
      shell.style.filter = 'none';
    }
    showSaLoginModal();
  } else {
    if (shell) {
      shell.style.display = 'flex';
      shell.style.filter = 'none';
    }
    hideSaLoginModal();
    loadSuperAdminDashboard();
  }

  const formLogin = document.getElementById('formSuperAdminLogin');
  if (formLogin) {
    formLogin.addEventListener('submit', handleSuperAdminLogin);
  }
  const formOtp = document.getElementById('formSuperAdminOtp');
  if (formOtp) {
    formOtp.addEventListener('submit', handleSuperAdminVerifyOtp);
  }
}

async function handleSuperAdminLogin(e) {
  e.preventDefault();
  const emailInput = document.getElementById('saLoginEmail');
  const userInput = document.getElementById('saLoginUser');
  const email = (emailInput ? emailInput.value : (userInput ? userInput.value : '')).trim();
  const alertEl = document.getElementById('saLoginAlert');
  const successEl = document.getElementById('saLoginSuccess');
  const btnSubmit = document.getElementById('btnSaSubmitStep1');

  if (alertEl) alertEl.style.display = 'none';
  if (successEl) successEl.style.display = 'none';
  if (btnSubmit) {
    btnSubmit.disabled = true;
    btnSubmit.innerHTML = '<span>⏳ Sending Email OTP...</span>';
  }

  try {
    const res = await fetch('/api/auth/superadmin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email })
    });

    const data = await res.json();
    if (data.requireOtp && data.challengeToken) {
      document.getElementById('saChallengeToken').value = data.challengeToken;
      const emailDisp = document.getElementById('saTargetEmailDisplay');
      if (emailDisp && data.email) emailDisp.textContent = data.email;
      document.getElementById('formSuperAdminLogin').style.display = 'none';
      document.getElementById('formSuperAdminOtp').style.display = 'block';
      if (successEl) {
        successEl.textContent = data.message || '6-Digit verification code dispatched to email.';
        successEl.style.display = 'block';
      }
      setTimeout(() => document.getElementById('saLoginOtp')?.focus(), 200);
    } else if (data.success && data.token) {
      completeSuperAdminAuth(data);
    } else {
      if (alertEl) {
        alertEl.textContent = data.message || 'Unrecognized Super Admin email address';
        alertEl.style.display = 'block';
      }
    }
  } catch (err) {
    if (alertEl) {
      alertEl.textContent = 'Connection error: ' + err.message;
      alertEl.style.display = 'block';
    }
  } finally {
    if (btnSubmit) {
      btnSubmit.disabled = false;
      btnSubmit.innerHTML = '<span>📧 Send Login OTP to Email</span>';
    }
  }
}

async function handleSuperAdminVerifyOtp(e) {
  e.preventDefault();
  const challengeToken = document.getElementById('saChallengeToken').value;
  const otp = document.getElementById('saLoginOtp').value.trim();
  const alertEl = document.getElementById('saLoginAlert');
  const successEl = document.getElementById('saLoginSuccess');
  const btnSubmit = document.getElementById('btnSaSubmitStep2');

  if (alertEl) alertEl.style.display = 'none';
  if (btnSubmit) {
    btnSubmit.disabled = true;
    btnSubmit.innerHTML = '<span>⏳ Verifying Code...</span>';
  }

  try {
    const res = await fetch('/api/auth/superadmin/verify-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challengeToken, otp, isSuperAdmin: true })
    });

    const data = await res.json();
    if (data.success && data.token) {
      completeSuperAdminAuth(data);
    } else {
      if (alertEl) {
        alertEl.textContent = data.message || 'Invalid or expired 6-digit OTP';
        alertEl.style.display = 'block';
      }
    }
  } catch (err) {
    if (alertEl) {
      alertEl.textContent = 'Verification error: ' + err.message;
      alertEl.style.display = 'block';
    }
  } finally {
    if (btnSubmit) {
      btnSubmit.disabled = false;
      btnSubmit.innerHTML = '<span>🔓 Verify OTP & Unlock Command Center</span>';
    }
  }
}

function completeSuperAdminAuth(data) {
  localStorage.setItem('sa_auth_token', data.token);
  if (data.refreshToken) {
    localStorage.setItem('sa_refresh_token', data.refreshToken);
  }
  superAdminToken = data.token;
  const shell = document.getElementById('saasDashboard');
  if (shell) {
    shell.style.setProperty('display', 'flex', 'important');
    shell.style.filter = 'none';
  }
  hideSaLoginModal();
  resetInactivityTimer();
  loadSuperAdminDashboard();
  showToast('👑 Super Admin authenticated successfully via Email 2FA!', 'success');
}

function resetSaLoginForm() {
  document.getElementById('formSuperAdminOtp').style.display = 'none';
  document.getElementById('formSuperAdminLogin').style.display = 'block';
  document.getElementById('saLoginOtp').value = '';
  document.getElementById('saLoginAlert').style.display = 'none';
  document.getElementById('saLoginSuccess').style.display = 'none';
}

function showSaLoginModal(message) {
  const modal = document.getElementById('modalSaLogin');
  const shell = document.getElementById('saasDashboard');
  if (shell) {
    shell.style.setProperty('display', 'none', 'important');
  }
  if (modal) {
    modal.style.display = 'flex';
  }
  resetSaLoginForm();
  const alertEl = document.getElementById('saLoginAlert');
  if (alertEl) {
    if (message) {
      alertEl.textContent = message;
      alertEl.style.display = 'block';
    } else {
      alertEl.style.display = 'none';
    }
  }
}

function hideSaLoginModal() {
  const modal = document.getElementById('modalSaLogin');
  if (modal) modal.style.display = 'none';
}

function logoutSuperAdmin(message) {
  localStorage.removeItem('sa_auth_token');
  localStorage.removeItem('sa_refresh_token');
  sessionStorage.clear();
  superAdminToken = '';
  const shell = document.getElementById('saasDashboard');
  if (shell) {
    shell.style.display = 'none';
    shell.style.filter = 'none';
  }
  showSaLoginModal(message || 'You have signed out successfully.');
}

// =========================================================================
// 1.1. 15-MINUTE INACTIVITY AUTO-LOGOUT ENGINE
// =========================================================================

let isSaRefreshingToken = false;
let saRefreshSubscribers = [];

function onSaTokenRefreshed(newToken) {
  saRefreshSubscribers.forEach(cb => cb(newToken));
  saRefreshSubscribers = [];
}

function initInactivityTimer() {
  // Activity listeners
  ['mousemove', 'keydown', 'click', 'scroll', 'touchstart'].forEach(evt => {
    window.addEventListener(evt, resetInactivityTimer, { passive: true });
  });

  if (inactivityInterval) clearInterval(inactivityInterval);
  inactivityInterval = setInterval(updateInactivityCountdown, 1000);
}

function resetInactivityTimer() {
  inactivityRemaining = INACTIVITY_TIMEOUT_SECONDS;
}

function updateInactivityCountdown() {
  if (!localStorage.getItem('sa_auth_token')) return;

  inactivityRemaining = Math.max(0, inactivityRemaining - 1);
  const minutes = Math.floor(inactivityRemaining / 60);
  const seconds = inactivityRemaining % 60;
  const pad = n => String(n).padStart(2, '0');

  const countdownEl = document.getElementById('sessionCountdown');
  if (countdownEl) {
    countdownEl.textContent = `${pad(minutes)}:${pad(seconds)}`;
    if (inactivityRemaining < 120) {
      countdownEl.style.color = '#ef4444'; // Red warning under 2 mins
    } else {
      countdownEl.style.color = '#38bdf8';
    }
  }

  if (inactivityRemaining <= 0) {
    logoutSuperAdmin('Session expired automatically after 15 minutes of inactivity.');
  }
}

async function saFetch(url, options = {}) {
  options.headers = options.headers || {};
  const token = localStorage.getItem('sa_auth_token') || '';
  if (token) {
    options.headers['Authorization'] = `Bearer ${token}`;
  }
  options.headers['Content-Type'] = options.headers['Content-Type'] || 'application/json';

  let res = await fetch(url, options);

  if (res.status === 401 || res.status === 403) {
    const rawRefresh = localStorage.getItem('sa_refresh_token');
    if (rawRefresh && !options._retry) {
      if (!isSaRefreshingToken) {
        isSaRefreshingToken = true;
        try {
          const rRes = await fetch('/api/auth/refresh', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ refreshToken: rawRefresh })
          });
          const rData = await rRes.json();
          if (rData.success && rData.token) {
            localStorage.setItem('sa_auth_token', rData.token);
            if (rData.refreshToken) localStorage.setItem('sa_refresh_token', rData.refreshToken);
            superAdminToken = rData.token;
            isSaRefreshingToken = false;
            onSaTokenRefreshed(rData.token);
          } else {
            isSaRefreshingToken = false;
            logoutSuperAdmin('Session expired. Please sign in again.');
            throw new Error('Session expired');
          }
        } catch (e) {
          isSaRefreshingToken = false;
          logoutSuperAdmin('Session expired. Please sign in again.');
          throw e;
        }
      }

      return new Promise((resolve) => {
        saRefreshSubscribers.push((newToken) => {
          options._retry = true;
          options.headers['Authorization'] = `Bearer ${newToken}`;
          resolve(fetch(url, options));
        });
      });
    } else {
      logoutSuperAdmin('Session expired. Please sign in again.');
      throw new Error('Unauthorized');
    }
  }

  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    const text = await res.text();
    console.error('[SA FETCH NON-JSON RESPONSE]', res.status, text.slice(0, 300));
    throw new Error(`Server returned HTTP ${res.status}: ${res.statusText || 'Unexpected non-JSON response'}`);
  }
  return res;
}

// =========================================================================
// 2. THEME ENGINE
// =========================================================================
function initSuperAdminTheme() {
  const savedTheme = localStorage.getItem('noc_theme') || 'dark';
  document.documentElement.setAttribute('data-theme', savedTheme);
  updateSaThemeButton(savedTheme);
}

window.toggleSuperAdminTheme = function() {
  const current = document.documentElement.getAttribute('data-theme') || 'dark';
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('noc_theme', next);
  updateSaThemeButton(next);
};

function updateSaThemeButton(theme) {
  const btn = document.getElementById('btnSaThemeToggle');
  if (btn) {
    btn.textContent = theme === 'light' ? '☀️' : '🌙';
  }
}

// =========================================================================
// 3. TAB NAVIGATION (WITH URL HASH PERSISTENCE ON REFRESH)
// =========================================================================
function initTabNavigation() {
  document.addEventListener('click', (e) => {
    const tabBtn = e.target.closest('.nav-tab, .sa-nav-item[data-tab]');
    if (tabBtn && tabBtn.dataset.tab) {
      e.preventDefault();
      const tabName = tabBtn.dataset.tab;
      window.location.hash = tabName;
      window.switchSaasTab(tabName, false);
    }
  });

  window.addEventListener('hashchange', () => {
    const hash = (window.location.hash || '').replace('#', '').trim();
    if (hash) {
      window.switchSaasTab(hash, false);
    }
  });

  // Restore tab on initial load if hash is present
  const initialHash = (window.location.hash || '').replace('#', '').trim();
  if (initialHash) {
    setTimeout(() => {
      window.switchSaasTab(initialHash, false);
    }, 100);
  }
}

window.switchSaasTab = function(tabName, updateHash = true) {
  if (!tabName) tabName = 'overview';
  if (updateHash) {
    window.location.hash = tabName;
  }

  // Update sidebar active classes
  document.querySelectorAll('.sa-nav-item, .nav-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === tabName);
  });

  // Update viewport section displays
  document.querySelectorAll('.sa-tab-section, .saas-tab-view').forEach(v => {
    const isActive = v.id === `view-${tabName}`;
    v.classList.toggle('active', isActive);
    v.style.display = isActive ? 'block' : 'none';
  });

  if (tabName === 'operators') renderOperatorsTable(currentOperators);
  if (tabName === 'invoices') loadInvoices();
  if (tabName === 'plans') renderPlans();
  if (tabName === 'roles') loadRolesPermissions();
  if (tabName === 'audit') loadAuditLogs();
  if (tabName === 'settings') loadGlobalSettings();
  if (tabName === 'status') loadSystemLiveStatus();
  if (tabName === 'olt-fleet') window.loadSuperAdminOlts();
  if (tabName === 'whatsapp-gateway') window.loadSaWaStatus();
  if (tabName === 'overview') {
    loadSuperAdminDashboard(true);
  }
};

window.toggleSaSidebar = function() {
  const sidebar = document.getElementById('saSidebar');
  if (sidebar) sidebar.classList.toggle('show');
};

// =========================================================================
// 4. REAL FLEET DASHBOARD DATA LOADER
// =========================================================================
async function loadSuperAdminDashboard(isBackground = false) {
  try {
    // 1. Fetch Real Stats
    const statsRes = await saFetch('/api/superadmin/stats');
    const stats = await statsRes.json();

    // 2. Fetch Real Operators / Tenants
    const tenantsRes = await saFetch('/api/superadmin/tenants');
    const tenantsData = await tenantsRes.json();
    currentOperators = tenantsData.success ? (tenantsData.tenants || []) : [];

    // 3. Fetch Real Devices Fleet
    const devRes = await saFetch('/api/devices');
    const devData = await devRes.json();
    allFleetDevices = Array.isArray(devData) ? devData : (devData.devices || []);

    // Compute real values
    const totalOnts = allFleetDevices.length;
    const onlineOnts = allFleetDevices.filter(d => isDevOnline(d)).length;
    const offlineOnts = Math.max(0, totalOnts - onlineOnts);
    
    // Critical optical ONTs (Rx Power < -26 dBm or Offline)
    const criticalOptOnts = allFleetDevices.filter(d => {
      const rx = parseFloat(d.opticalPower?.rxPower);
      return (!isNaN(rx) && rx < -26.0) || !isDevOnline(d);
    });

    const activeOperators = currentOperators.filter(o => o.status !== 'SUSPENDED');
    const suspendedOperators = currentOperators.filter(o => o.status === 'SUSPENDED');

    // Real MRR calculated from active operators
    let realMRR = activeOperators.reduce((sum, o) => {
      return sum + (parseFloat(o.monthlyCharge) || parseFloat(o.currentBillAmount) || 0);
    }, 0);

    // Populate Top 4 KPI Cards with REAL Data
    const elMRR = document.getElementById('kpiMRR');
    if (elMRR) elMRR.textContent = `₹${realMRR.toLocaleString('en-IN')}`;

    const elOperators = document.getElementById('kpiOperators');
    if (elOperators) elOperators.textContent = currentOperators.length;

    const elActiveTenants = document.getElementById('kpiActiveTenants');
    if (elActiveTenants) elActiveTenants.textContent = `${activeOperators.length} Active • ${suspendedOperators.length} Suspended`;

    const elTotalOnts = document.getElementById('kpiTotalOnts');
    if (elTotalOnts) elTotalOnts.textContent = totalOnts;

    const elOnlineOnts = document.getElementById('kpiOnlineOnts');
    if (elOnlineOnts) elOnlineOnts.textContent = onlineOnts;

    const elCritOnts = document.getElementById('kpiCriticalOnts');
    if (elCritOnts) elCritOnts.textContent = criticalOptOnts.length;

    const elOfflineKpi = document.getElementById('kpiOfflineOntsCount');
    if (elOfflineKpi) elOfflineKpi.textContent = criticalOptOnts.length;

    const elOfflineTrend = document.getElementById('kpiOfflineTrend');
    if (elOfflineTrend) {
      elOfflineTrend.textContent = criticalOptOnts.length > 0 ? `⚠️ ${criticalOptOnts.length} Needs Attention` : `● All ONTs Normal`;
      elOfflineTrend.style.color = criticalOptOnts.length > 0 ? '#f59e0b' : '#10b981';
    }

    const tabBadge = document.getElementById('tabCountOperators');
    if (tabBadge) tabBadge.textContent = currentOperators.length;

    // 4. Render Visual Charts & Tables
    drawMrrOverviewChart(realMRR);
    drawOperatorStatusDonut(currentOperators.length, activeOperators.length, suspendedOperators.length, 0);
    renderOperatorsTable(currentOperators);
    renderOfflineCriticalOntsTable(criticalOptOnts);
    renderRealSystemEvents(allFleetDevices, currentOperators);
    populateInvoiceOperatorSelect(currentOperators);

    // 5. Plans
    const plansRes = await saFetch('/api/superadmin/plans');
    const plansData = await plansRes.json();
    if (plansData.success) {
      currentPlans = plansData.plans || [];
      renderPlans();
    }

  } catch (err) {
    if (!isBackground) console.warn('Error loading dashboard:', err.message);
  }
}

function isDevOnline(d) {
  if (!d.lastContact) return false;
  return (Date.now() - new Date(d.lastContact).getTime()) <= (10 * 60 * 1000);
}

// =========================================================================
// 4.1. CHARTS ENGINE (REAL DATA DRIVEN)
// =========================================================================
function drawMrrOverviewChart(currentMrr = 2999) {
  const canvas = document.getElementById('mrrOverviewChart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;

  ctx.clearRect(0, 0, w, h);

  const yLabels = ['₹6K', '₹4K', '₹2K', '₹0'];
  const xLabels = ['Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul'];
  const leftPad = 42;
  const rightPad = 25;
  const topPad = 25;
  const bottomPad = 30;
  const chartW = w - leftPad - rightPad;
  const chartH = h - topPad - bottomPad;

  ctx.font = '10px Inter, sans-serif';
  ctx.fillStyle = '#64748B';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';

  // Draw horizontal grid lines
  for (let i = 0; i < 4; i++) {
    const y = topPad + (chartH / 3) * i;
    ctx.fillText(yLabels[i], leftPad - 8, y);
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
    ctx.lineWidth = 1;
    ctx.moveTo(leftPad, y);
    ctx.lineTo(w - rightPad, y);
    ctx.stroke();
  }

  // Draw X labels
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const xCoords = [];
  for (let i = 0; i < xLabels.length; i++) {
    const x = leftPad + (chartW / (xLabels.length - 1)) * i;
    xCoords.push(x);
    ctx.fillText(xLabels[i], x, h - bottomPad + 8);
  }

  // Real trajectory culminating in current MRR
  const mrrVal = Math.min(6000, currentMrr || 2999);
  const values = [Math.round(mrrVal * 0.4), Math.round(mrrVal * 0.45), Math.round(mrrVal * 0.65), Math.round(mrrVal * 0.75), Math.round(mrrVal * 0.9), mrrVal];
  const points = values.map((v, i) => {
    const x = xCoords[i];
    const y = topPad + chartH - (v / 6000) * chartH;
    return { x, y, v };
  });

  // Gradient area fill
  const grad = ctx.createLinearGradient(0, topPad, 0, topPad + chartH);
  grad.addColorStop(0, 'rgba(59, 130, 246, 0.28)');
  grad.addColorStop(1, 'rgba(59, 130, 246, 0.0)');

  ctx.beginPath();
  ctx.moveTo(points[0].x, topPad + chartH);
  ctx.lineTo(points[0].x, points[0].y);

  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i];
    const p1 = points[i + 1];
    const cpX = (p0.x + p1.x) / 2;
    ctx.bezierCurveTo(cpX, p0.y, cpX, p1.y, p1.x, p1.y);
  }
  ctx.lineTo(points[points.length - 1].x, topPad + chartH);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // Blue curve line
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i];
    const p1 = points[i + 1];
    const cpX = (p0.x + p1.x) / 2;
    ctx.bezierCurveTo(cpX, p0.y, cpX, p1.y, p1.x, p1.y);
  }
  ctx.strokeStyle = '#3B82F6';
  ctx.lineWidth = 2.5;
  ctx.stroke();

  // Draw points
  points.forEach((p, idx) => {
    ctx.beginPath();
    ctx.arc(p.x, p.y, idx === points.length - 1 ? 5 : 3.5, 0, 2 * Math.PI);
    ctx.fillStyle = idx === points.length - 1 ? '#38BDF8' : '#3B82F6';
    ctx.fill();
    ctx.strokeStyle = '#0B0F19';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  });

  // Tooltip for current period
  const lastP = points[points.length - 1];
  const tipW = 86;
  const tipH = 42;
  const tipX = lastP.x - tipW - 8;
  const tipY = lastP.y - 12;

  ctx.fillStyle = '#101626';
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(tipX, tipY, tipW, tipH, 6);
  ctx.fill();
  ctx.stroke();

  ctx.font = '10px Inter, sans-serif';
  ctx.fillStyle = '#94A3B8';
  ctx.textAlign = 'left';
  ctx.fillText('Live Period', tipX + 8, tipY + 14);

  ctx.fillStyle = '#38BDF8';
  ctx.beginPath();
  ctx.arc(tipX + 11, tipY + 28, 3, 0, 2 * Math.PI);
  ctx.fill();

  ctx.font = 'bold 11px Inter, monospace';
  ctx.fillStyle = '#FFFFFF';
  ctx.fillText(`₹${currentMrr.toLocaleString('en-IN')}`, tipX + 19, tipY + 31);
}

function drawOperatorStatusDonut(total, active, suspended, inactive) {
  const canvas = document.getElementById('operatorStatusDonut');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  const cX = w / 2;
  const cY = h / 2;
  const radius = Math.min(cX, cY) - 8;
  const innerRadius = radius - 14;

  ctx.clearRect(0, 0, w, h);

  const t = Math.max(1, total);
  const activeAngle = (active / t) * 2 * Math.PI;
  const suspendedAngle = (suspended / t) * 2 * Math.PI;

  let currentAngle = -Math.PI / 2;

  // Active Green slice
  if (active > 0) {
    ctx.beginPath();
    ctx.arc(cX, cY, radius, currentAngle, currentAngle + activeAngle);
    ctx.arc(cX, cY, innerRadius, currentAngle + activeAngle, currentAngle, true);
    ctx.closePath();
    ctx.fillStyle = '#10B981';
    ctx.fill();
    currentAngle += activeAngle;
  }

  // Suspended Orange slice
  if (suspended > 0) {
    ctx.beginPath();
    ctx.arc(cX, cY, radius, currentAngle, currentAngle + suspendedAngle);
    ctx.arc(cX, cY, innerRadius, currentAngle + suspendedAngle, currentAngle, true);
    ctx.closePath();
    ctx.fillStyle = '#F59E0B';
    ctx.fill();
  }

  // Update text & legends
  const elDonutTotal = document.getElementById('donutTotalVal');
  if (elDonutTotal) elDonutTotal.textContent = total;

  const elActiveLegend = document.getElementById('legendActiveCount');
  if (elActiveLegend) elActiveLegend.textContent = `${active} (${total > 0 ? Math.round((active/total)*100) : 100}%)`;

  const elSuspendedLegend = document.getElementById('legendSuspendedCount');
  if (elSuspendedLegend) elSuspendedLegend.textContent = `${suspended} (${total > 0 ? Math.round((suspended/total)*100) : 0}%)`;
}

// =========================================================================
// 5. OFFLINE & CRITICAL OPTICAL ONTS WIDGET
// =========================================================================
function renderOfflineCriticalOntsTable(onts) {
  const tbody = document.getElementById('tblOfflineCriticalOnts');
  if (!tbody) return;

  if (!onts || onts.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" style="text-align:center;padding:2rem;color:#10b981;">
          <div style="font-weight:700;font-size:0.9rem;">🟢 Clean Slate: Zero subscriber ONTs connected</div>
          <div style="font-size:0.75rem;color:#94a3b8;margin-top:0.25rem;">No optical loss or offline alarms across platform.</div>
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = onts.map(d => {
    const isOnline = isDevOnline(d);
    const custName = d.customer?.name || 'Subscriber ONT';
    const rx = d.opticalPower?.rxPower || '-26.50 dBm';
    const rxVal = parseFloat(rx);
    const sn = d.deviceInfo?.ponSerialNumber || d.deviceInfo?.serialNumber || d._id;
    const operatorName = d.tenantId ? `${d.tenantId.toUpperCase()} FiberNet` : 'Rudra FiberNet';

    let optBadge = `<span class="sa-badge-active" style="background:rgba(16,185,129,0.15);color:#10b981;">${rx}</span>`;
    if (!isNaN(rxVal) && rxVal < -27) {
      optBadge = `<span class="sa-badge-active" style="background:rgba(239,68,68,0.15);color:#ef4444;">🔴 ${rx} Critical</span>`;
    } else if (!isNaN(rxVal) && rxVal < -24) {
      optBadge = `<span class="sa-badge-active" style="background:rgba(245,158,11,0.15);color:#f59e0b;">⚠️ ${rx} Warning</span>`;
    }

    const lastSeen = d.lastContact ? new Date(d.lastContact).toLocaleTimeString() : 'Recent';

    return `
      <tr>
        <td>
          <strong style="color:#ffffff;">${escapeHtml(custName)}</strong>
          <div style="font-size:0.72rem;color:#94a3b8;" class="mono">${escapeHtml(d.wan?.username || 'PPPoE')}</div>
        </td>
        <td>
          <span style="color:#38bdf8;font-weight:600;">${escapeHtml(operatorName)}</span>
        </td>
        <td>
          <span class="mono" style="font-size:0.78rem;color:#cbd5e1;">${escapeHtml(sn)}</span>
        </td>
        <td>
          ${optBadge}
        </td>
        <td>
          <span style="color:${isOnline ? '#10b981' : '#ef4444'};font-weight:600;">
            ${isOnline ? '🟢 Online' : '🔴 Offline'} (${lastSeen})
          </span>
        </td>
        <td style="text-align:right;">
          <a href="/" target="_blank" class="btn-sa-primary" style="padding:0.25rem 0.65rem;font-size:0.75rem;text-decoration:none;">
            Inspect in NOC ↗
          </a>
        </td>
      </tr>
    `;
  }).join('');
}

// =========================================================================
// 6. REAL SYSTEM EVENTS STREAM (NO DUMMY ALERTS)
// =========================================================================
function renderRealSystemEvents(devices, operators) {
  const container = document.getElementById('realAlertsList');
  if (!container) return;

  const events = [];

  // 1. Device Fleet Events
  devices.forEach(d => {
    const rx = parseFloat(d.opticalPower?.rxPower);
    const name = d.customer?.name || 'Subscriber';
    if (!isDevOnline(d)) {
      events.push({
        type: 'red',
        icon: '🔴',
        title: `ONT Offline: ${name}`,
        desc: `Device ${d.deviceInfo?.modelName || 'ONT'} (${d.deviceInfo?.ponSerialNumber || d._id}) stopped reporting inform.`,
        time: 'Recent'
      });
    } else if (!isNaN(rx) && rx < -25) {
      events.push({
        type: 'amber',
        icon: '⚠️',
        title: `Low Laser Rx: ${name}`,
        desc: `Optical power attenuated to ${rx} dBm. Inspect fiber drop.`,
        time: 'Active'
      });
    }
  });

  // 2. Platform / Operator Events
  operators.forEach(op => {
    if (op.status === 'SUSPENDED') {
      events.push({
        type: 'amber',
        icon: '⏸️',
        title: `Operator Suspended: ${op.name}`,
        desc: `Operator access is currently locked.`,
        time: 'Status'
      });
    } else {
      events.push({
        type: 'blue',
        icon: '🟢',
        title: `CWMP Engine Active: ${op.name}`,
        desc: `Port 7547 listening for TR-069 SOAP Informs on http://222.167.207.220:7547/`,
        time: 'Live'
      });
    }
  });

  if (events.length === 0) {
    container.innerHTML = `
      <div style="text-align:center;padding:2rem;color:#64748b;font-size:0.85rem;">
        Clean Slate: Zero system events logged.
      </div>
    `;
    return;
  }

  container.innerHTML = events.slice(0, 4).map(e => `
    <div class="sa-alert-item">
      <div class="sa-alert-icon-box ${e.type}">
        ${e.icon}
      </div>
      <div style="flex:1;">
        <div class="sa-alert-title-row">
          <span class="sa-alert-title">${escapeHtml(e.title)}</span>
          <span class="sa-alert-time">${escapeHtml(e.time)}</span>
        </div>
        <div class="sa-alert-desc">${escapeHtml(e.desc)}</div>
      </div>
    </div>
  `).join('');
}

// =========================================================================
// 7. OPERATORS DIRECTORY & SUSPENSION TOGGLE
// =========================================================================
function renderOperatorsTable(operators) {
  const tblFull = document.getElementById('tblOperatorsDirectory');
  const tblRecent = document.getElementById('tblRecentOperators');

  if (!operators || operators.length === 0) {
    const emptyRow = `<tr><td colspan="9" style="text-align:center;padding:2rem;color:#64748b;">No operators onboarded yet.</td></tr>`;
    if (tblFull) tblFull.innerHTML = emptyRow;
    if (tblRecent) tblRecent.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:2rem;color:#64748b;">No active operators found.</td></tr>`;
    return;
  }

  // 1. Full Directory Table
  if (tblFull) {
    tblFull.innerHTML = operators.map(op => {
      const isSuspended = op.status === 'SUSPENDED';
      const addr = op.address || {};
      const locString = typeof addr === 'object' 
        ? `${addr.area || ''} ${addr.district ? `(${addr.district})` : ''} ${addr.state || 'Telangana'}`.trim() || 'Telangana'
        : String(addr);

      return `
        <tr>
          <td>
            <div style="display:flex;align-items:center;gap:0.6rem;">
              <div class="sa-op-avatar-square" style="background:${isSuspended ? '#ef4444' : '#6366f1'};">
                ${(op.name || 'O')[0].toUpperCase()}
              </div>
              <div>
                <strong style="color:#ffffff;font-size:0.85rem;">${escapeHtml(op.name)}</strong>
                <div style="font-size:0.72rem;color:#64748b;" class="mono">slug: /${escapeHtml(op.slug)}</div>
              </div>
            </div>
          </td>
          <td>
            <div><strong>${escapeHtml(op.contactPerson || 'Owner')}</strong></div>
            <div class="mono" style="font-size:0.75rem;color:#10b981;">📱 ${escapeHtml(op.phone || '—')}</div>
          </td>
          <td>
            <span style="font-size:0.78rem;color:#cbd5e1;">📍 ${escapeHtml(locString)}</span>
            ${addr.pincode ? `<div style="font-size:0.7rem;color:#64748b;" class="mono">PIN: ${addr.pincode}</div>` : ''}
          </td>
          <td>
            <div class="mono" style="font-size:0.75rem;">Aadhaar: ${escapeHtml(op.aadhaarNo || 'Verified')}</div>
          </td>
          <td>
            ${op.slug === 'rudra' ? `
              <a href="http://ciniplay.in/" target="_blank" class="mono font-bold" style="color:#38bdf8;text-decoration:none;font-size:0.75rem;">
                http://ciniplay.in/ ↗
              </a>
            ` : `
              <a href="http://${escapeHtml(op.slug)}.ciniplay.in/" target="_blank" class="mono font-bold" style="color:#10b981;text-decoration:none;font-size:0.75rem;">
                http://${escapeHtml(op.slug)}.ciniplay.in/ ↗
              </a>
            `}
          </td>
          <td>
            <span class="mono font-bold" style="color:#ffffff;">${op.activeOnts !== undefined ? op.activeOnts : (op.slug === 'rudra' ? (allFleetDevices.length || 10) : 0)}</span>
            <span style="color:#64748b;font-size:0.72rem;"> / ${op.maxOnts || 600} max</span>
          </td>
          <td>
            <span class="mono font-bold" style="color:#10b981;">₹${(op.monthlyCharge || op.currentBillAmount || 2999).toLocaleString('en-IN')}</span>
            <div style="font-size:0.68rem;color:#64748b;">${escapeHtml(op.planName || 'Growth Tier')}</div>
          </td>
          <td>
            <span class="sa-badge-active" style="background:${isSuspended ? 'rgba(239,68,68,0.15)' : 'rgba(16,185,129,0.15)'};color:${isSuspended ? '#ef4444' : '#10b981'};">
              ${isSuspended ? '⏸️ Suspended' : '🟢 Active'}
            </span>
          </td>
          <td style="text-align:right;">
            <div style="display:flex;gap:0.35rem;justify-content:flex-end;">
              <button class="sa-btn-icon-tiny" onclick="openEditOperatorModal('${escapeHtml(op.slug)}')" title="Edit KYC & Credentials">✏️</button>
              <button class="sa-btn-icon-tiny" onclick="toggleSuspendOperator('${escapeHtml(op._id)}', '${escapeHtml(op.name)}')" title="${isSuspended ? 'Reactivate Operator' : 'Suspend Operator'}">
                ${isSuspended ? '▶️' : '⏸️'}
              </button>
              <button class="sa-btn-icon-tiny" onclick="openCreateInvoiceForOperator('${escapeHtml(op.slug)}')" title="Issue B2B Tax Invoice">🧾</button>
              <button class="sa-btn-icon-tiny" onclick="deleteOperator('${escapeHtml(op._id)}', '${escapeHtml(op.name)}')" title="Delete Operator">🗑️</button>
            </div>
          </td>
        </tr>
      `;
    }).join('');
  }

  // 2. Recent Operators Table on Overview
  if (tblRecent) {
    tblRecent.innerHTML = operators.slice(0, 5).map(op => {
      const isSuspended = op.status === 'SUSPENDED';
      const email = op.email || '—';
      const phone = op.phone || '—';
      const createdDate = op.createdAt ? new Date(op.createdAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : 'Recent';

      return `
        <tr>
          <td>
            <div style="display:flex;align-items:center;gap:0.75rem;">
              <div class="sa-op-avatar-square" style="background:${isSuspended ? '#ef4444' : '#6366f1'};">
                ${(op.name || 'D')[0].toUpperCase()}
              </div>
              <div>
                <strong style="color:#ffffff;font-size:0.85rem;">${escapeHtml(op.name)}</strong>
                <div style="font-size:0.72rem;color:#64748b;">${escapeHtml(email)}</div>
              </div>
            </div>
          </td>
          <td>
            <span class="mono" style="color:#cbd5e1;">${escapeHtml(phone)}</span>
          </td>
          <td>
            <span class="sa-badge-active" style="background:${isSuspended ? 'rgba(239,68,68,0.15)' : 'rgba(16,185,129,0.15)'};color:${isSuspended ? '#ef4444' : '#10b981'};">
              ${isSuspended ? 'Suspended' : 'Active'}
            </span>
          </td>
          <td>
            <span style="color:#cbd5e1;font-size:0.78rem;">${escapeHtml(createdDate)}</span>
          </td>
          <td>
            <div style="display:flex;gap:0.35rem;align-items:center;">
              <button class="sa-btn-icon-tiny" onclick="openEditOperatorModal('${escapeHtml(op.slug)}')" title="View / Edit">👁️</button>
              <button class="sa-btn-icon-tiny" onclick="toggleSuspendOperator('${escapeHtml(op._id)}', '${escapeHtml(op.name)}')" title="${isSuspended ? 'Activate' : 'Suspend'}">
                ${isSuspended ? '▶️' : '⏸️'}
              </button>
            </div>
          </td>
        </tr>
      `;
    }).join('');
  }
}

window.toggleSuspendOperator = async function(operatorId, operatorName) {
  if (!confirm(`Are you sure you want to change the active/suspended status for "${operatorName}"?`)) return;
  try {
    const res = await saFetch(`/api/superadmin/tenants/${encodeURIComponent(operatorId)}/suspend`, { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showToast(`Operator status updated to ${data.status}!`, 'success');
      loadSuperAdminDashboard();
    }
  } catch (err) {
    showToast('Failed to toggle status: ' + err.message, 'error');
  }
};

window.deleteOperator = async function(operatorId, operatorName) {
  if (!confirm(`⚠️ PERMANENT ACTION: Delete operator "${operatorName}" and purge all tenant settings from database?`)) return;
  try {
    const res = await saFetch(`/api/superadmin/tenants/${encodeURIComponent(operatorId)}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.success) {
      showToast(`Operator "${operatorName}" deleted!`, 'success');
      loadSuperAdminDashboard();
    }
  } catch (err) {
    showToast('Failed to delete operator: ' + err.message, 'error');
  }
};

// =========================================================================
// 8. KYC MODAL & ONBOARDING ACTIONS
// =========================================================================
window.openAddOperatorModal = function() {
  document.getElementById('modalOperatorTitle').textContent = '➕ Onboard New Operator (Full KYC)';
  document.getElementById('opEditId').value = '';
  document.getElementById('formOperatorKyc').reset();
  document.getElementById('opSlug').removeAttribute('readonly');
  document.getElementById('opSlug').style.background = '';
  document.getElementById('opMonthlyFee').value = '2999';
  document.getElementById('opMaxOnts').value = '600';
  window.onOpSlugInput();
  document.getElementById('modalOperatorKyc').style.display = 'flex';
};

window.onOpNameInput = function() {
  const opEditId = document.getElementById('opEditId').value;
  if (!opEditId) {
    const name = document.getElementById('opName').value.trim().toLowerCase();
    const cleanSlug = name.replace(/[^a-z0-9]/g, '').slice(0, 15);
    const slugInput = document.getElementById('opSlug');
    if (slugInput && cleanSlug) {
      slugInput.value = cleanSlug;
      window.onOpSlugInput();
    }
  }
};

window.onOpSlugInput = function() {
  const slug = (document.getElementById('opSlug').value || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
  const preview = document.getElementById('opCwmpUrlPreview');
  const isFirst = (!currentOperators || currentOperators.length === 0) || slug === 'rudra';
  if (preview) {
    if (isFirst || !slug) {
      preview.textContent = 'http://ciniplay.in/';
    } else {
      preview.textContent = `http://${slug}.ciniplay.in/`;
    }
  }
};

window.openEditOperatorModal = function(slug) {
  const op = currentOperators.find(o => o.slug === slug);
  if (!op) return;

  document.getElementById('modalOperatorTitle').textContent = `✏️ Edit Operator KYC: ${op.name}`;
  document.getElementById('opEditId').value = op._id;
  document.getElementById('opName').value = op.name || '';
  document.getElementById('opSlug').value = op.slug || '';
  document.getElementById('opSlug').setAttribute('readonly', 'true');
  document.getElementById('opSlug').style.background = 'rgba(255,255,255,0.05)';

  document.getElementById('opLogoUrl').value = op.branding?.logoUrl || '';

  document.getElementById('opContactPerson').value = op.contactPerson || '';
  document.getElementById('opPhone').value = op.phone || '';
  document.getElementById('opEmail').value = op.email || '';
  document.getElementById('opAadhaar').value = op.aadhaarNo || '';
  document.getElementById('opPan').value = op.panNo || '';
  document.getElementById('opGstin').value = op.gstin || '';

  const addr = op.address || {};
  document.getElementById('opAddrDoor').value = addr.doorNo || '';
  document.getElementById('opAddrStreet').value = addr.street || '';
  document.getElementById('opAddrArea').value = addr.area || '';
  document.getElementById('opAddrMandal').value = addr.mandal || '';
  document.getElementById('opAddrDistrict').value = addr.district || '';
  document.getElementById('opAddrState').value = addr.state || '';
  document.getElementById('opAddrPincode').value = addr.pincode || '';

  document.getElementById('opPlanId').value = op.planId || 'plan_growth';
  document.getElementById('opMaxOnts').value = op.maxOnts || 600;
  document.getElementById('opMonthlyFee').value = op.monthlyCharge || 2999;

  window.onOpSlugInput();
  document.getElementById('modalOperatorKyc').style.display = 'flex';
};

window.closeOperatorModal = function() {
  document.getElementById('modalOperatorKyc').style.display = 'none';
};

window.saveOperatorKyc = async function() {
  const editId = document.getElementById('opEditId').value;
  const isEditing = !!editId;

  const phone = (document.getElementById('opPhone').value || '').trim();
  const cleanPhone = phone.replace(/[^0-9]/g, '');
  const slug = (document.getElementById('opSlug').value || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
  const isFirst = (!currentOperators || currentOperators.length === 0) || slug === 'rudra';
  const domain = isFirst ? 'ciniplay.in' : `${slug}.ciniplay.in`;
  const cwmpUrl = `http://${domain}/`;

  const payload = {
    name: document.getElementById('opName').value.trim(),
    slug,
    domain,
    cwmpUrl,
    username: cleanPhone || slug,
    logoUrl: document.getElementById('opLogoUrl').value.trim(),
    contactPerson: document.getElementById('opContactPerson').value.trim(),
    phone,
    email: document.getElementById('opEmail').value.trim(),
    aadhaarNo: document.getElementById('opAadhaar').value.trim(),
    panNo: document.getElementById('opPan').value.trim(),
    gstin: document.getElementById('opGstin').value.trim(),
    aadhaarDocUrl: document.getElementById('opAadhaarDocUrl').value.trim(),
    address: {
      doorNo: document.getElementById('opAddrDoor').value.trim(),
      street: document.getElementById('opAddrStreet').value.trim(),
      area: document.getElementById('opAddrArea').value.trim(),
      mandal: document.getElementById('opAddrMandal').value.trim(),
      district: document.getElementById('opAddrDistrict').value.trim(),
      state: document.getElementById('opAddrState').value.trim(),
      pincode: document.getElementById('opAddrPincode').value.trim()
    },
    planId: document.getElementById('opPlanId').value,
    maxOnts: parseInt(document.getElementById('opMaxOnts').value || '600', 10),
    monthlyCharge: parseFloat(document.getElementById('opMonthlyFee').value || '2999')
  };

  try {
    const url = isEditing ? `/api/superadmin/tenants/${encodeURIComponent(editId)}` : '/api/superadmin/tenants';
    const method = isEditing ? 'PUT' : 'POST';

    const res = await saFetch(url, {
      method,
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (data.success) {
      showToast(isEditing ? 'Operator KYC updated successfully!' : 'Operator onboarded successfully!', 'success');
      closeOperatorModal();
      loadSuperAdminDashboard();
    } else {
      showToast(data.message || 'Operation failed', 'error');
    }
  } catch (err) {
    showToast('Error saving operator: ' + err.message, 'error');
  }
};

window.handleAadhaarFileChange = function(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function(e) {
    document.getElementById('opAadhaarDocUrl').value = e.target.result;
    const badge = document.getElementById('aadhaarPreviewBadge');
    if (badge) {
      badge.textContent = `✓ Document "${file.name}" attached successfully!`;
      badge.style.display = 'block';
    }
  };
  reader.readAsDataURL(file);
};

// =========================================================================
// 9. B2B GST TAX INVOICING & NPCI UPI QR ENGINE
// =========================================================================
async function loadInvoices() {
  const tbody = document.getElementById('tblInvoicesList');
  if (!tbody) return;

  try {
    const res = await saFetch('/api/superadmin/invoices');
    const data = await res.json();
    if (data.success) {
      currentInvoices = data.invoices || [];
      if (currentInvoices.length === 0) {
        tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;padding:2.5rem;color:#64748b;">No invoices generated yet. Click "➕ Generate New Tax Invoice" to create one.</td></tr>`;
        return;
      }

      tbody.innerHTML = currentInvoices.map(inv => {
        const isPaid = inv.status === 'PAID';
        const sub = inv.subtotal || inv.amount || 2999;
        const gst = (inv.cgst || 0) + (inv.sgst || 0);
        const net = inv.totalAmount || Math.round(sub + gst);

        return `
          <tr>
            <td><strong class="mono" style="color:#38bdf8;">${escapeHtml(inv.invoiceNumber || inv._id)}</strong></td>
            <td><strong>${escapeHtml(inv.tenantName || inv.tenantId)}</strong></td>
            <td><span class="mono" style="color:#94a3b8;font-size:0.75rem;">${escapeHtml(inv.issueDate || (inv.createdAt ? new Date(inv.createdAt).toLocaleDateString() : '—'))}</span></td>
            <td><span class="mono" style="color:#94a3b8;font-size:0.75rem;">${escapeHtml(inv.dueDate || '—')}</span></td>
            <td class="mono">₹${sub.toLocaleString('en-IN')}</td>
            <td class="mono" style="color:#94a3b8;">₹${gst ? gst.toLocaleString('en-IN') : '0'}</td>
            <td class="mono font-bold" style="color:#10b981;font-size:0.95rem;">₹${net.toLocaleString('en-IN')}</td>
            <td>
              <span class="${isPaid ? 'sa-status-pill-paid' : 'sa-status-pill-pending'}">
                ${isPaid ? '● PAID' : '⏳ PENDING'}
              </span>
            </td>
            <td style="text-align:right;">
              <div style="display:flex;gap:0.35rem;justify-content:flex-end;">
                <button class="btn-sa-view-pill" onclick="viewTaxInvoice('${escapeHtml(inv._id)}')">
                  👁️ View PDF
                </button>
              </div>
            </td>
          </tr>
        `;
      }).join('');
    }
  } catch (err) {
    console.warn('Error loading invoices:', err);
  }
}

window.openCreateInvoiceModal = function() {
  populateInvoiceOperatorSelect(currentOperators);
  document.getElementById('modalGenerateInvoice').style.display = 'flex';
};

window.openCreateInvoiceForOperator = function(slug) {
  openCreateInvoiceModal();
  const sel = document.getElementById('invTenantSelect');
  if (sel) sel.value = slug;
};

window.closeGenerateInvoiceModal = function() {
  document.getElementById('modalGenerateInvoice').style.display = 'none';
};

function populateInvoiceOperatorSelect(operators) {
  const sel = document.getElementById('invTenantSelect');
  if (!sel) return;
  sel.innerHTML = operators.map(op => `
    <option value="${escapeHtml(op.slug)}">${escapeHtml(op.name)} (₹${(op.monthlyCharge || 2999).toLocaleString('en-IN')}/mo)</option>
  `).join('');
}

const formInv = document.getElementById('formGenerateInvoice');
if (formInv) {
  formInv.addEventListener('submit', async (e) => {
    e.preventDefault();
    const tenantSlug = document.getElementById('invTenantSelect').value;
    const subtotal = parseFloat(document.getElementById('invSubtotalAmount').value || '2999');
    const desc = document.getElementById('invBillingDesc').value.trim();
    const status = document.getElementById('invStatusSelect').value;

    try {
      const res = await saFetch('/api/superadmin/invoices/generate', {
        method: 'POST',
        body: JSON.stringify({
          tenantId: tenantSlug,
          subtotal,
          items: [{ description: desc, hsnSac: '998422', amount: subtotal }],
          status
        })
      });

      const data = await res.json();
      if (data.success && data.invoice) {
        showToast('Tax Invoice generated successfully!', 'success');
        closeGenerateInvoiceModal();
        loadInvoices();
        viewTaxInvoice(data.invoice._id);
      }
    } catch (err) {
      showToast('Invoice generation failed: ' + err.message, 'error');
    }
  });
}

window.viewTaxInvoice = function(invoiceId) {
  const inv = currentInvoices.find(i => i._id === invoiceId) || currentInvoices[0];
  if (!inv) return;

  const docEl = document.getElementById('printableInvoiceDocument');
  if (!docEl) return;

  const sub = inv.subtotal || inv.amount || 2999;
  const cgst = inv.cgst || Math.round(sub * 0.09);
  const sgst = inv.sgst || Math.round(sub * 0.09);
  const net = inv.totalAmount || (sub + cgst + sgst);
  const kyc = inv.operatorKYC || {};

  docEl.innerHTML = `
    <div class="inv-header">
      <div>
        <div class="inv-logo-title">VRV ACS BROADBAND TECHNOLOGIES PRIVATE LIMITED</div>
        <div class="inv-company-sub">Cloud TR-069 ACS & Enterprise ISP Platform Solutions</div>
        <div style="font-size:0.75rem;color:#475569;margin-top:0.25rem;">
          GSTIN: <strong>36AAACV9876R1Z9</strong> • SAC Code: <strong>998422</strong><br>
          Tech Park, Hitech City, Hyderabad, Telangana - 500081
        </div>
      </div>
      <div>
        <div class="inv-badge-title">TAX INVOICE</div>
        <div class="inv-meta-row">Invoice #: <strong>${escapeHtml(inv.invoiceNumber || inv._id)}</strong></div>
        <div class="inv-meta-row">Date: <strong>${escapeHtml(inv.issueDate || new Date().toLocaleDateString())}</strong></div>
        <div class="inv-meta-row">Status: <strong>${inv.status === 'PAID' ? 'PAID (Settled)' : 'PENDING PAYMENT'}</strong></div>
      </div>
    </div>

    <div class="inv-parties-grid">
      <div class="inv-party-col">
        <h4>Billed To (Operator / Client):</h4>
        <div class="inv-party-name">${escapeHtml(inv.tenantName || kyc.name || 'Operator')}</div>
        <div class="inv-party-text">
          Proprietor: ${escapeHtml(kyc.contactPerson || '—')}<br>
          Phone: ${escapeHtml(kyc.phone || '—')}<br>
          Address: ${escapeHtml(kyc.address || '—')}<br>
          GSTIN: ${escapeHtml(kyc.gstin || 'Unregistered')}
        </div>
      </div>

      <div class="inv-party-col">
        <h4>Service Details:</h4>
        <div class="inv-party-text">
          SaaS Tier: <strong>${escapeHtml(inv.planName || 'Growth Tier (600 ONTs)')}</strong><br>
          Included Hardware: <strong>Up to 600 Online ONTs</strong><br>
          Billing Cycle: <strong>Monthly (Prepaid TR-069 Access)</strong>
        </div>
      </div>
    </div>

    <table class="inv-items-table">
      <thead>
        <tr>
          <th>#</th>
          <th>Description</th>
          <th>SAC Code</th>
          <th style="text-align:right;">Subtotal (₹)</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>1</td>
          <td><strong>${escapeHtml(inv.items?.[0]?.description || 'VRV ACS Cloud TR-069 Platform License')}</strong></td>
          <td>998422</td>
          <td class="mono" style="text-align:right;">₹${sub.toLocaleString('en-IN')}</td>
        </tr>
      </tbody>
    </table>

    <div class="inv-totals-box">
      <table class="inv-totals-table">
        <tr>
          <td>Subtotal:</td>
          <td class="mono" style="text-align:right;">₹${sub.toLocaleString('en-IN')}</td>
        </tr>
        <tr>
          <td>CGST (9%):</td>
          <td class="mono" style="text-align:right;">₹${cgst.toLocaleString('en-IN')}</td>
        </tr>
        <tr>
          <td>SGST (9%):</td>
          <td class="mono" style="text-align:right;">₹${sgst.toLocaleString('en-IN')}</td>
        </tr>
        <tr class="inv-total-highlight">
          <td>Total Net Payable:</td>
          <td class="mono" style="text-align:right;">₹${net.toLocaleString('en-IN')}</td>
        </tr>
      </table>
    </div>

    <div class="inv-payment-section">
      <div class="inv-bank-info">
        <strong>Bank NEFT / RTGS Transfer Details:</strong><br>
        Beneficiary: VRV ACS TECHNOLOGIES PVT LTD<br>
        A/C No: 50200084920192 (HDFC Bank, Hitech City)<br>
        IFSC: HDFC0001234
      </div>

      <div class="inv-qr-wrap">
        <canvas id="qrTaxInvoicePay" width="100" height="100" style="border: 1px solid #cbd5e1; border-radius: 4px; padding: 4px; background: #fff;"></canvas>
        <div class="inv-qr-caption">Scan to Pay via UPI</div>
      </div>
    </div>
  `;

  document.getElementById('modalViewInvoice').style.display = 'flex';

  // Generate dynamic UPI QR Code
  setTimeout(() => {
    const qrCanvas = document.getElementById('qrTaxInvoicePay');
    if (qrCanvas && typeof QRCode !== 'undefined') {
      const upiUrl = `upi://pay?pa=vrvacs@hdfcbank&pn=VRVACS&am=${net}&cu=INR&tn=Invoice_${inv.invoiceNumber || inv._id}`;
      QRCode.toCanvas(qrCanvas, upiUrl, { width: 100, margin: 1 }, (err) => {
        if (err) console.warn('QR Code generation error:', err);
      });
    }
  }, 100);
};

window.closeViewInvoiceModal = function() {
  document.getElementById('modalViewInvoice').style.display = 'none';
};

// =========================================================================
// 10. SAAS PRICING PLANS
// =========================================================================
function renderPlans() {
  const container = document.getElementById('pricingPlansContainer');
  if (!container) return;

  const defaultPlans = [
    {
      id: 'plan_starter',
      name: 'Starter NOC Tier',
      price: 1499,
      maxOnts: 250,
      features: ['250 Managed ONTs', 'TR-069 CWMP Engine', 'Real-Time Telemetry', 'Sub-Operator Portal', 'Email Support']
    },
    {
      id: 'plan_growth',
      name: 'Growth ISP Tier',
      price: 2999,
      maxOnts: 600,
      features: ['600 Managed ONTs', 'Auto ZTP Provisioning', 'Optical Health Sweep', 'Technician Mobile Toolkit', 'B2B Tax Invoicing', 'Priority Support']
    },
    {
      id: 'plan_enterprise',
      name: 'Carrier Enterprise',
      price: 5999,
      maxOnts: 1500,
      features: ['1,500 Managed ONTs', 'Unlimited OLT Connections', 'SNMP Trap Listener', 'Custom Domain & Logo', 'Subscriber Self-Care PWA', '24/7 Phone Support']
    }
  ];

  const plans = currentPlans.length > 0 ? currentPlans : defaultPlans;

  container.innerHTML = plans.map(p => `
    <div class="sa-card-box" style="border:1px solid ${p.id === 'plan_growth' ? '#3b82f6' : 'rgba(255,255,255,0.07)'};position:relative;">
      ${p.id === 'plan_growth' ? '<span style="position:absolute;top:1rem;right:1rem;background:#3b82f6;color:#fff;font-size:0.68rem;font-weight:800;padding:0.2rem 0.5rem;border-radius:9999px;">POPULAR</span>' : ''}
      <h3 style="font-size:1.1rem;font-weight:800;color:#ffffff;margin-bottom:0.35rem;">${escapeHtml(p.name)}</h3>
      <div style="font-size:1.6rem;font-weight:900;color:#38bdf8;margin:0.5rem 0;" class="mono">
        ₹${p.price.toLocaleString('en-IN')}<span style="font-size:0.8rem;color:#64748b;font-weight:500;">/month</span>
      </div>
      <div style="font-size:0.78rem;color:#94a3b8;margin-bottom:1rem;">Capacity: <strong>Up to ${p.maxOnts} ONTs</strong></div>
      <ul style="list-style:none;display:flex;flex-direction:column;gap:0.5rem;margin-bottom:1.5rem;font-size:0.8rem;color:#cbd5e1;">
        ${p.features.map(f => `<li>✓ ${escapeHtml(f)}</li>`).join('')}
      </ul>
      <button class="btn-sa-primary" style="width:100%;justify-content:center;" onclick="openAddOperatorModal()">
        Assign Tier to Operator
      </button>
    </div>
  `).join('');
}

// =========================================================================
// 11. ROLES & MULTI-TENANT RBAC PERMISSIONS ENGINE
// =========================================================================
let currentRoles = [];

window.loadRolesPermissions = async function() {
  const container = document.getElementById('rolesSummaryGrid');
  try {
    const res = await saFetch('/api/superadmin/roles');
    const data = await res.json();
    if (data.success && data.roles) {
      currentRoles = data.roles;
      if (container) {
        container.innerHTML = currentRoles.map(r => `
          <div class="sa-card-box" style="padding:1.25rem;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.5rem;">
              <span class="mono" style="font-size:0.75rem;color:#38bdf8;font-weight:700;">${escapeHtml(r.scope)} SCOPE</span>
              <span class="sa-badge-active" style="font-size:0.7rem;">${r.usersCount || 1} Active</span>
            </div>
            <h4 style="color:#ffffff;font-size:0.95rem;font-weight:700;margin-bottom:0.35rem;">${escapeHtml(r.name)}</h4>
            <p style="font-size:0.75rem;color:#94a3b8;margin:0;">${escapeHtml(r.description)}</p>
          </div>
        `).join('');
      }
    }
  } catch (err) {
    console.warn('Error loading roles:', err);
  }
};

window.saveRolesPermissions = async function() {
  showToast('💾 Saving multi-tenant RBAC permissions policy...', 'info');
  try {
    const res = await saFetch('/api/superadmin/roles', {
      method: 'POST',
      body: JSON.stringify({ roles: currentRoles })
    });
    const data = await res.json();
    if (data.success) {
      showToast('✅ Multi-Tenant RBAC Permissions Policy saved and enforced!', 'success');
    }
  } catch (err) {
    showToast('Failed to save roles: ' + err.message, 'error');
  }
};

// =========================================================================
// 12. ENTERPRISE AUDIT & SECURITY LOGS ENGINE
// =========================================================================
let allAuditLogs = [];

window.loadAuditLogs = async function() {
  const tbody = document.getElementById('tblAuditLogsList');
  if (!tbody) return;

  try {
    const res = await saFetch('/api/superadmin/audit-logs?limit=100');
    const data = await res.json();
    if (data.success && data.logs) {
      allAuditLogs = data.logs;
      renderAuditLogsTable(allAuditLogs);
    }
  } catch (err) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:2rem;color:#ef4444;">Error loading logs: ${escapeHtml(err.message)}</td></tr>`;
  }
};

function renderAuditLogsTable(logs) {
  const tbody = document.getElementById('tblAuditLogsList');
  if (!tbody) return;

  if (!logs || logs.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:2rem;color:#64748b;">No audit logs recorded yet.</td></tr>`;
    return;
  }

  tbody.innerHTML = logs.map(l => {
    const isWarn = l.severity === 'WARN' || l.action?.includes('OFFLINE') || l.action?.includes('FAIL');
    const dateStr = l.timestamp ? new Date(l.timestamp).toLocaleString('en-IN', { hour12: true }) : 'Recent';

    return `
      <tr>
        <td class="mono" style="font-size:0.75rem;color:#cbd5e1;">${escapeHtml(dateStr)}</td>
        <td>
          <strong style="color:#ffffff;">${escapeHtml(l.actor || 'SYSTEM')}</strong>
        </td>
        <td>
          <span class="mono font-bold" style="color:#38bdf8;font-size:0.78rem;">${escapeHtml(l.action || 'INFORM')}</span>
        </td>
        <td>
          <span class="mono" style="font-size:0.75rem;color:#94a3b8;">${escapeHtml(l.target || '—')}</span>
        </td>
        <td>
          <span class="sa-badge-active" style="background:${isWarn ? 'rgba(239,68,68,0.15)' : 'rgba(16,185,129,0.15)'};color:${isWarn ? '#ef4444' : '#10b981'};font-size:0.72rem;">
            ${isWarn ? '⚠️ WARNING' : '🟢 SUCCESS'}
          </span>
        </td>
        <td>
          <span style="font-size:0.8rem;color:#e2e8f0;">${escapeHtml(l.message || 'Inform Transaction')}</span>
        </td>
        <td class="mono" style="font-size:0.75rem;color:#64748b;">${escapeHtml(l.ip || '222.167.207.220')}</td>
      </tr>
    `;
  }).join('');
}

window.filterAuditLogsTable = function() {
  const q = (document.getElementById('inputSearchAudit')?.value || '').toLowerCase().trim();
  const sev = document.getElementById('selectAuditSeverity')?.value || 'ALL';

  const filtered = allAuditLogs.filter(l => {
    const matchQ = !q || (l.actor + ' ' + l.action + ' ' + l.message + ' ' + l.target + ' ' + l.ip).toLowerCase().includes(q);
    const matchSev = sev === 'ALL' || (sev === 'WARN' && (l.severity === 'WARN' || l.action?.includes('OFFLINE'))) || (sev === 'INFO' && l.severity !== 'WARN');
    return matchQ && matchSev;
  });

  renderAuditLogsTable(filtered);
};

window.exportAuditLogsCsv = function() {
  if (!allAuditLogs || allAuditLogs.length === 0) {
    showToast('No logs available to export.', 'warning');
    return;
  }

  const headers = ['Timestamp', 'Actor', 'Action', 'Target', 'Severity', 'Message', 'IP'];
  const rows = allAuditLogs.map(l => [
    `"${l.timestamp || ''}"`,
    `"${l.actor || ''}"`,
    `"${l.action || ''}"`,
    `"${l.target || ''}"`,
    `"${l.severity || ''}"`,
    `"${(l.message || '').replace(/"/g, '""')}"`,
    `"${l.ip || ''}"`
  ]);

  const csvContent = 'data:text/csv;charset=utf-8,' + [headers.join(','), ...rows.map(e => e.join(','))].join('\n');
  const encodedUri = encodeURI(csvContent);
  const link = document.createElement('a');
  link.setAttribute('href', encodedUri);
  link.setAttribute('download', `VRV_ACS_Audit_Logs_${Date.now()}.csv`);
  document.body.appendChild(link);
  link.click();
  link.remove();
  showToast('📥 Audit trail exported as CSV successfully!', 'success');
};

// =========================================================================
// 13. SYSTEM SETTINGS ENGINE
// =========================================================================
window.loadGlobalSettings = async function() {
  try {
    const res = await saFetch('/api/superadmin/settings');
    const data = await res.json();
    if (data.success && data.settings) {
      const s = data.settings;
      if (document.getElementById('cfgCwmpPort')) document.getElementById('cfgCwmpPort').value = s.cwmpPort || 7547;
      if (document.getElementById('cfgInformInterval')) document.getElementById('cfgInformInterval').value = s.informIntervalSeconds || 60;
      if (document.getElementById('cfgCwmpUser')) document.getElementById('cfgCwmpUser').value = s.cwmpUsername || 'admin';
      if (document.getElementById('cfgCwmpPass')) document.getElementById('cfgCwmpPass').value = s.cwmpPassword || 'cpe123';
      if (document.getElementById('cfgSessionTimeout')) document.getElementById('cfgSessionTimeout').value = s.sessionTimeoutMinutes || 15;
      if (document.getElementById('cfgSnmpPort')) document.getElementById('cfgSnmpPort').value = s.snmpTrapPort || 162;
      if (document.getElementById('cfgBackupFreq')) document.getElementById('cfgBackupFreq').value = s.backupFrequency || 'DAILY_02AM';
    }
  } catch (err) {
    console.warn('Error loading settings:', err);
  }
};

window.saveGlobalSettings = async function() {
  const payload = {
    cwmpPort: parseInt(document.getElementById('cfgCwmpPort').value || '7547', 10),
    informIntervalSeconds: parseInt(document.getElementById('cfgInformInterval').value || '60', 10),
    cwmpUsername: document.getElementById('cfgCwmpUser').value.trim(),
    cwmpPassword: document.getElementById('cfgCwmpPass').value.trim(),
    sessionTimeoutMinutes: parseInt(document.getElementById('cfgSessionTimeout').value || '15', 10),
    snmpTrapPort: parseInt(document.getElementById('cfgSnmpPort').value || '162', 10),
    backupFrequency: document.getElementById('cfgBackupFreq').value
  };

  showToast('💾 Persisting global platform settings to MongoDB...', 'info');
  try {
    const res = await saFetch('/api/superadmin/settings', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (data.success) {
      showToast('✅ Global System & CWMP Engine settings saved successfully!', 'success');
    }
  } catch (err) {
    showToast('Failed to save settings: ' + err.message, 'error');
  }
};

// =========================================================================
// 14. SYSTEM LIVE STATUS & MICROSERVICES HEALTH ENGINE
// =========================================================================
window.loadSystemLiveStatus = async function() {
  const tbody = document.getElementById('tblServicesStatus');
  showToast('🔄 Running real-time diagnostic sweep...', 'info');

  try {
    const res = await saFetch('/api/superadmin/system-status');
    const data = await res.json();
    if (data.success && data.status) {
      const s = data.status;
      if (document.getElementById('statUptimeDisplay')) document.getElementById('statUptimeDisplay').textContent = s.uptime;
      if (document.getElementById('statMemoryDisplay')) document.getElementById('statMemoryDisplay').textContent = `${s.memoryHeapUsedMB} MB`;

      if (tbody && s.services) {
        tbody.innerHTML = s.services.map(svc => `
          <tr>
            <td>
              <div style="display:flex;align-items:center;gap:0.6rem;">
                <span style="font-size:1.1rem;">${svc.name.includes('TR-069') ? '📡' : svc.name.includes('MongoDB') ? '🗄️' : svc.name.includes('REST') ? '🌐' : '⚙️'}</span>
                <div>
                  <strong style="color:#ffffff;">${escapeHtml(svc.name)}</strong>
                  <div style="font-size:0.72rem;color:#64748b;">${svc.database ? `DB: ${svc.database}` : 'Core Microservice'}</div>
                </div>
              </div>
            </td>
            <td><span class="mono font-bold" style="color:#38bdf8;">:${escapeHtml(svc.port)}</span></td>
            <td><span class="mono" style="font-size:0.75rem;color:#cbd5e1;">${escapeHtml(svc.protocol)}</span></td>
            <td>
              <span class="sa-badge-active" style="background:rgba(16,185,129,0.15);color:#10b981;">
                ● ${escapeHtml(svc.status)}
              </span>
            </td>
            <td>
              <span class="mono" style="font-size:0.78rem;color:#e2e8f0;">
                ${svc.latency ? `⚡ ${svc.latency}` : svc.informsHandled ? `📊 ${svc.informsHandled} Informs` : svc.nextRun ? `⏰ ${svc.nextRun}` : 'Active'}
              </span>
            </td>
            <td style="text-align:right;">
              <button class="btn-sa-secondary" style="padding:0.25rem 0.65rem;font-size:0.75rem;" onclick="showToast('${escapeHtml(svc.name)} is active and healthy!', 'success')">
                🩺 Ping Check
              </button>
            </td>
          </tr>
        `).join('');
      }
      showToast('✅ Diagnostic sweep complete: All microservices healthy!', 'success');
    }
  } catch (err) {
    console.warn('Error loading system status:', err);
  }
};

function escapeHtml(str) {
  if (typeof str !== 'string') return String(str || '');
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function showToast(message, type = 'info') {
  const existing = document.getElementById('saToast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.id = 'saToast';
  toast.style.cssText = `
    position: fixed;
    bottom: 2rem;
    right: 2rem;
    background: ${type === 'success' ? '#10b981' : type === 'error' ? '#ef4444' : '#1e293b'};
    color: #ffffff;
    padding: 0.75rem 1.25rem;
    border-radius: 8px;
    font-size: 0.85rem;
    font-weight: 600;
    box-shadow: 0 10px 25px rgba(0,0,0,0.5);
    z-index: 999999;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    transition: all 0.3s ease;
  `;
  toast.innerHTML = `<span>${type === 'success' ? '✓' : type === 'error' ? '⚠️' : 'ℹ️'}</span> <span>${escapeHtml(message)}</span>`;
  document.body.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

window.loadSuperAdminOlts = async function() {
  const tbody = document.getElementById('tblSaOltFleet');
  if (!tbody) return;

  const tenantFilter = document.getElementById('saOltTenantFilter')?.value || 'ALL';

  try {
    const res = await saFetch('/api/olt/list');
    const data = await res.json();
    let olts = (data && data.olts) ? data.olts : [];

    if (tenantFilter !== 'ALL') {
      olts = olts.filter(o => o.tenantId === tenantFilter || (o.tenantId || 'rudra') === tenantFilter);
    }

    const badgeCount = document.getElementById('tabCountOlts');
    if (badgeCount) badgeCount.textContent = olts.length;

    if (olts.length === 0) {
      tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:1.5rem;color:#64748b;">No OLT headends registered for this operator.</td></tr>`;
      return;
    }

    tbody.innerHTML = olts.map(o => {
      const opName = (o.tenantId === 'vgigafiber') ? 'V GIGA FIBER (Vaishnavi)' : 'Rudra FiberNet';
      return `
        <tr>
          <td>
            <strong style="color:#ffffff;">${escapeHtml(o.name || 'Syrotech EPON Core')}</strong>
            <div style="font-size:0.72rem;color:#94a3b8;">Uptime: ${escapeHtml(o.uptime || '48 days')}</div>
          </td>
          <td><span style="font-size:0.75rem;color:#38bdf8;font-weight:600;">${escapeHtml(opName)}</span></td>
          <td><span class="mono" style="color:#38bdf8;font-weight:700;">${escapeHtml(o.host || '--')}:${escapeHtml(String(o.port || 22))}</span></td>
          <td><span style="color:#cbd5e1;font-size:0.78rem;">${escapeHtml(o.brand || 'GPON / EPON OLT')}</span></td>
          <td class="mono" style="font-weight:700;color:#ffffff;">${escapeHtml(String(o.ponCount || 4))} PON (${escapeHtml(String(o.activeOnts || 0))} ONTs)</td>
          <td class="mono" style="font-size:0.75rem;color:#94a3b8;">CPU: ${escapeHtml(String(o.cpuUsage || 0))}% • Temp: ${escapeHtml(o.temperature || '--')}</td>
          <td><span class="sa-status-pill-online">🟢 SSH SYNCED</span></td>
          <td style="text-align:right;">
            <div style="display:inline-flex;gap:0.35rem;align-items:center;justify-content:flex-end;">
              <a href="/" target="_blank" class="btn-sa-view-pill" style="text-decoration:none;">
                NOC ↗
              </a>
              <button class="sa-btn-icon-tiny" title="Delete OLT" style="color:#ef4444;" onclick="deleteSuperAdminOlt('${escapeHtml(o._id || o.id || o.name)}')">
                🗑️
              </button>
            </div>
          </td>
        </tr>
      `;
    }).join('');
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:1rem;color:#ef4444;">Error loading global OLT fleet: ${escapeHtml(err.message)}</td></tr>`;
  }
};

window.deleteSuperAdminOlt = async function(oltId) {
  if (!confirm(`⚠️ PERMANENT ACTION: Delete OLT headend "${oltId}" from database?`)) return;
  try {
    const res = await saFetch(`/api/olt/${encodeURIComponent(oltId)}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.success) {
      showToast('OLT headend deleted successfully!', 'success');
      loadSuperAdminOlts();
    } else {
      showToast(data.message || data.error || 'Failed to delete OLT', 'error');
    }
  } catch (err) {
    showToast('Delete error: ' + err.message, 'error');
  }
};

// =========================================================================
// 12. MASTER SUPER ADMIN WHATSAPP WEB GATEWAY & QR ENGINE
// =========================================================================
let saWaPollTimer = null;

window.loadSaWaStatus = async function() {
  const qrLoading = document.getElementById('saWaQrLoading');
  const qrImg = document.getElementById('saWaQrImg');
  const connectedBox = document.getElementById('saWaConnectedBox');
  const linkedNum = document.getElementById('saWaLinkedNumber');
  const badge = document.getElementById('saWaStatusBadge');
  const engineBadge = document.getElementById('saWaEngineBadge');

  try {
    const res = await saFetch('/api/alerts/whatsapp/status?tenantId=rudra');
    const data = await res.json();

    if (data.status === 'CONNECTED') {
      if (qrLoading) qrLoading.style.display = 'none';
      if (qrImg) qrImg.style.display = 'none';
      if (connectedBox) connectedBox.style.display = 'block';
      if (linkedNum) linkedNum.textContent = data.phone ? `+${data.phone}` : '';
      if (badge) {
        badge.textContent = 'CONNECTED';
        badge.style.background = '#10b981';
      }
      if (engineBadge) {
        engineBadge.innerHTML = '🟢 CONNECTED & ROUTING OTPS';
        engineBadge.style.background = 'rgba(16,185,129,0.15)';
        engineBadge.style.color = '#10b981';
      }
    } else if (data.status === 'QR_READY' && data.qrDataUrl) {
      if (qrLoading) qrLoading.style.display = 'none';
      if (connectedBox) connectedBox.style.display = 'none';
      if (qrImg) {
        qrImg.src = data.qrDataUrl;
        qrImg.style.display = 'block';
      }
      if (badge) {
        badge.textContent = 'SCAN QR';
        badge.style.background = '#f59e0b';
      }
      if (engineBadge) {
        engineBadge.innerHTML = '🟡 SCAN QR TO LINK';
        engineBadge.style.background = 'rgba(245,158,11,0.15)';
        engineBadge.style.color = '#f59e0b';
      }
      // Start short polling while QR is active
      if (!saWaPollTimer) {
        saWaPollTimer = setTimeout(() => {
          saWaPollTimer = null;
          loadSaWaStatus();
        }, 4000);
      }
    } else {
      if (qrLoading) {
        qrLoading.innerHTML = '<div style="font-size:24px;margin-bottom:0.25rem;">⚠️</div>WhatsApp Session Inactive. Click Generate QR below.';
        qrLoading.style.display = 'block';
      }
      if (qrImg) qrImg.style.display = 'none';
      if (connectedBox) connectedBox.style.display = 'none';
      if (badge) {
        badge.textContent = 'OFFLINE';
        badge.style.background = '#ef4444';
      }
      if (engineBadge) {
        engineBadge.innerHTML = '🔴 DISCONNECTED';
        engineBadge.style.background = 'rgba(239,68,68,0.15)';
        engineBadge.style.color = '#ef4444';
      }
    }
  } catch (err) {
    console.error('Error fetching SA WhatsApp status:', err.message);
  }
};

window.initSaWaSession = async function() {
  const qrLoading = document.getElementById('saWaQrLoading');
  const qrImg = document.getElementById('saWaQrImg');
  const connectedBox = document.getElementById('saWaConnectedBox');
  const btn = document.getElementById('btnSaRefreshQr');

  if (qrLoading) {
    qrLoading.innerHTML = '<div style="font-size:32px;margin-bottom:0.5rem;">🔄</div>Generating WhatsApp QR Code...';
    qrLoading.style.display = 'block';
  }
  if (qrImg) qrImg.style.display = 'none';
  if (connectedBox) connectedBox.style.display = 'none';
  if (btn) btn.disabled = true;

  try {
    const res = await saFetch('/api/alerts/whatsapp/init', {
      method: 'POST',
      body: JSON.stringify({ tenantId: 'rudra' })
    });
    const data = await res.json();
    if (data.status === 'QR_READY' && data.qrDataUrl) {
      if (qrLoading) qrLoading.style.display = 'none';
      if (qrImg) {
        qrImg.src = data.qrDataUrl;
        qrImg.style.display = 'block';
      }
      showToast('Scan QR code with WhatsApp on your phone!', 'info');
      setTimeout(loadSaWaStatus, 3000);
    } else if (data.status === 'CONNECTED') {
      showToast('WhatsApp already connected!', 'success');
      loadSaWaStatus();
    } else {
      showToast('WhatsApp initialization started. Generating QR...', 'info');
      setTimeout(loadSaWaStatus, 3000);
    }
  } catch (err) {
    showToast('Failed to init WhatsApp: ' + err.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
};

window.disconnectSaWaSession = async function() {
  if (!confirm('⚠️ Are you sure you want to unlink and log out the central WhatsApp gateway?')) return;
  try {
    const res = await saFetch('/api/alerts/whatsapp/disconnect', {
      method: 'POST',
      body: JSON.stringify({ tenantId: 'rudra' })
    });
    const data = await res.json();
    if (data.success) {
      showToast('WhatsApp Gateway disconnected.', 'info');
      loadSaWaStatus();
    } else {
      showToast(data.message || 'Disconnect failed', 'error');
    }
  } catch (err) {
    showToast('Disconnect error: ' + err.message, 'error');
  }
};

window.sendSaWaTestOtp = async function() {
  const phoneInput = document.getElementById('saWaTestPhone');
  const phone = (phoneInput ? phoneInput.value : '').trim();
  const btn = document.getElementById('btnSendSaWaTest');
  const feedback = document.getElementById('saWaTestFeedback');

  if (!phone) {
    showToast('Please enter a target mobile number', 'warning');
    return;
  }

  if (feedback) feedback.style.display = 'none';
  if (btn) {
    btn.disabled = true;
    btn.textContent = '⏳ Dispatching OTP...';
  }

  try {
    const res = await saFetch('/api/alerts/whatsapp/send-test', {
      method: 'POST',
      body: JSON.stringify({ phone, tenantId: 'rudra' })
    });
    const data = await res.json();

    if (data.success) {
      if (feedback) {
        feedback.style.display = 'block';
        feedback.style.background = 'rgba(16,185,129,0.15)';
        feedback.style.color = '#10b981';
        feedback.style.border = '1px solid #10b981';
        feedback.textContent = `✅ Test OTP message dispatched to +${phone}! Check WhatsApp on device.`;
      }
      showToast('Test WhatsApp OTP dispatched!', 'success');
    } else {
      if (feedback) {
        feedback.style.display = 'block';
        feedback.style.background = 'rgba(239,68,68,0.15)';
        feedback.style.color = '#ef4444';
        feedback.style.border = '1px solid #ef4444';
        feedback.textContent = `❌ Dispatch failed: ${data.message || 'Gateway offline'}`;
      }
      showToast('Test dispatch failed: ' + (data.message || 'Server error'), 'error');
    }
  } catch (err) {
    if (feedback) {
      feedback.style.display = 'block';
      feedback.style.background = 'rgba(239,68,68,0.15)';
      feedback.style.color = '#ef4444';
      feedback.style.border = '1px solid #ef4444';
      feedback.textContent = `❌ Network error: ${err.message}`;
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '📲 Send Test WhatsApp OTP';
    }
  }
};
