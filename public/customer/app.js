/**
 * ISP Customer Self-Care Web App Client Script
 */

let currentDeviceId = localStorage.getItem('cust_device_id') || '';
let custToken = localStorage.getItem('cust_token') || '';
let routerDataCache = null;

let deferredPrompt = null;

document.addEventListener('DOMContentLoaded', () => {
  initCustAuth();
  initCustForms();
  initPwaInstaller();
  
  // Auto-refresh router data every 15 seconds if logged in
  setInterval(() => {
    if (currentDeviceId && custToken) {
      loadMyRouterData(true);
    }
  }, 15000);
});

// Register Service Worker for PWA
function initPwaInstaller() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/customer/sw.js').catch(err => {
      console.log('SW registration note:', err);
    });
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    const installBtn = document.getElementById('btnPwaInstall');
    if (installBtn) installBtn.style.display = 'flex';
  });
}

window.installPwaApp = async function() {
  if (deferredPrompt) {
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === 'accepted') {
      showCustToast('🎉 App added to your Home Screen!');
    }
    deferredPrompt = null;
    const installBtn = document.getElementById('btnPwaInstall');
    if (installBtn) installBtn.style.display = 'none';
  } else {
    alert('📱 To install this App on your phone:\n\n• Android (Chrome): Tap the 3 dots (⋮) -> "Add to Home Screen" or "Install App".\n• iPhone (Safari): Tap the Share button (⎋) -> "Add to Home Screen".');
  }
};

// --- AUTHENTICATION ---
function initCustAuth() {
  const loginScreen = document.getElementById('custLoginScreen');
  const appShell = document.getElementById('custAppShell');
  const loginForm = document.getElementById('custLoginForm');
  const btnLogout = document.getElementById('btnCustLogout');

  if (currentDeviceId && custToken) {
    loginScreen.style.display = 'none';
    appShell.style.display = 'flex';
    loadMyRouterData();
  } else {
    loginScreen.style.display = 'flex';
    appShell.style.display = 'none';
  }

  // Login Form Submission
  if (loginForm) {
    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const identifier = document.getElementById('custLoginId').value.trim();
      const password = document.getElementById('custLoginPass').value.trim();
      const alertBox = document.getElementById('custLoginAlert');
      const submitBtn = document.getElementById('btnCustSubmit');

      alertBox.style.display = 'none';
      submitBtn.disabled = true;
      submitBtn.innerHTML = '<span>⏳ Connecting to your router...</span>';

      try {
        const res = await fetch('/api/customer/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ identifier, password })
        });
        const data = await res.json();

        if (res.ok && data.success) {
          custToken = data.token;
          currentDeviceId = data.deviceId;
          localStorage.setItem('cust_token', data.token);
          localStorage.setItem('cust_device_id', data.deviceId);

          loginScreen.style.display = 'none';
          appShell.style.display = 'flex';
          showCustToast(`👋 Welcome, ${data.customer.name}!`);
          loadMyRouterData();
        } else {
          alertBox.textContent = data.message || 'Login failed. Please verify your username.';
          alertBox.style.display = 'block';
        }
      } catch (err) {
        alertBox.textContent = `Connection error: ${err.message}`;
        alertBox.style.display = 'block';
      } finally {
        submitBtn.disabled = false;
        submitBtn.innerHTML = '<span>🚀 Sign In to My Router</span>';
      }
    });
  }

  // Logout Button
  if (btnLogout) {
    btnLogout.addEventListener('click', () => {
      custToken = '';
      currentDeviceId = '';
      localStorage.removeItem('cust_token');
      localStorage.removeItem('cust_device_id');
      appShell.style.display = 'none';
      loginScreen.style.display = 'flex';
      document.getElementById('custLoginPass').value = '';
      showCustToast('🚪 Signed out of Self-Care App');
    });
  }
}

// Quick Login Helper
window.quickCustomerLogin = function(username) {
  document.getElementById('custLoginId').value = username;
  document.getElementById('custLoginPass').value = '';
  document.getElementById('custLoginForm').dispatchEvent(new Event('submit'));
};

// --- DATA FETCHING ---
async function loadMyRouterData(isSilent = false) {
  if (!currentDeviceId) return;

  try {
    const res = await fetch(`/api/customer/my-router?deviceId=${encodeURIComponent(currentDeviceId)}`, {
      headers: { 'x-customer-token': custToken }
    });
    const data = await res.json();

    if (!res.ok || !data.success) {
      if (!isSilent) showCustToast(data.message || 'Could not load router data', 'error');
      return;
    }

    routerDataCache = data;
    renderCustomerDashboard(data);
  } catch (err) {
    if (!isSilent) console.error('Router telemetry error:', err);
  }
}

// Render Dashboard Elements
function renderCustomerDashboard(data) {
  const { router, optical, wifi, connectedHosts } = data;

  // Header
  document.getElementById('appCustName').textContent = router.customer?.name || router.pppoeUser || 'My Home Router';
  document.getElementById('appCustAccount').textContent = `Account ID: ${router.customer?.accountId || router.id}`;
  
  const statusBadge = document.getElementById('appRouterStatusBadge');
  if (statusBadge) {
    statusBadge.textContent = router.status;
    statusBadge.className = `cust-badge ${router.status === 'ONLINE' ? 'online' : 'offline'}`;
  }

  // Optical Hero Card
  document.getElementById('optSignalTitle').textContent = optical.label;
  const scoreBadge = document.getElementById('optScoreBadge');
  scoreBadge.textContent = `${optical.score}%`;
  scoreBadge.style.color = optical.color;
  scoreBadge.style.borderColor = optical.color;
  scoreBadge.style.background = `${optical.color}22`;

  const fill = document.getElementById('optMeterFill');
  fill.style.width = `${optical.score}%`;
  fill.style.background = optical.color;

  document.getElementById('optRxVal').textContent = optical.rxPower;
  document.getElementById('optTxVal').textContent = optical.txPower;
  document.getElementById('optTempVal').textContent = optical.temperature;
  document.getElementById('optVoltVal').textContent = optical.voltage;

  // Quick Action Count
  const devCountEl = document.getElementById('qaDeviceCount');
  if (devCountEl) devCountEl.textContent = `${connectedHosts ? connectedHosts.length : 0} Devices`;

  // Router Info
  document.getElementById('infoModelName').textContent = `${router.manufacturer} ${router.model}`;
  document.getElementById('infoPppUser').textContent = router.pppoeUser;
  document.getElementById('infoIpAddress').textContent = router.ipAddress;
  document.getElementById('infoSerialMac').textContent = `${router.serialNumber} (${router.macAddress})`;
  document.getElementById('infoUptime').textContent = router.uptime;

  // WiFi Settings Form
  if (wifi.wifi24) {
    document.getElementById('wifi24Ssid').value = wifi.wifi24.ssid || '';
    if (wifi.wifi24.password && wifi.wifi24.password !== '••••••••') {
      document.getElementById('wifi24Pass').value = wifi.wifi24.password;
    }
  }
  if (wifi.wifi5) {
    document.getElementById('wifi5Ssid').value = wifi.wifi5.ssid || '';
    if (wifi.wifi5.password && wifi.wifi5.password !== '••••••••') {
      document.getElementById('wifi5Pass').value = wifi.wifi5.password;
    }
  }

  // Connected Devices List
  renderConnectedDevices(connectedHosts || []);
}

// Render Devices Tab
function renderConnectedDevices(devices) {
  const container = document.getElementById('custConnectedDevicesList');
  if (!container) return;

  if (devices.length === 0) {
    container.innerHTML = '<div style="text-align:center;padding:2rem;color:#94a3b8;">No active devices detected on your network.</div>';
    return;
  }

  container.innerHTML = devices.map(d => {
    const isMobile = (d.hostName || '').toLowerCase().includes('phone') || (d.hostName || '').toLowerCase().includes('android') || (d.hostName || '').toLowerCase().includes('iphone');
    const isTv = (d.hostName || '').toLowerCase().includes('tv') || (d.hostName || '').toLowerCase().includes('smart');
    const icon = isTv ? '📺' : isMobile ? '📱' : '💻';

    return `
      <div class="device-item">
        <div class="device-left">
          <div class="device-icon">${icon}</div>
          <div>
            <strong style="color:#fff;font-size:0.88rem;display:block;">${escapeHtml(d.hostName || 'Connected Device')}</strong>
            <span style="font-size:0.72rem;color:#94a3b8;" class="mono">${escapeHtml(d.ipAddress || '192.168.1.X')} • ${escapeHtml(d.macAddress || '')}</span>
          </div>
        </div>
        <div>
          <span class="cust-badge online" style="font-size:0.65rem;">${escapeHtml(d.interfaceType || 'Active')}</span>
        </div>
      </div>
    `;
  }).join('');
}

// --- FORMS & ACTIONS ---
function initCustForms() {
  // 2.4G WiFi Form
  const form24 = document.getElementById('formCustWifi24');
  if (form24) {
    form24.addEventListener('submit', async (e) => {
      e.preventDefault();
      const ssid = document.getElementById('wifi24Ssid').value.trim();
      const password = document.getElementById('wifi24Pass').value.trim();
      const btn = document.getElementById('btnSaveWifi24');

      btn.disabled = true;
      btn.innerHTML = '<span>⏳ Pushing changes to router...</span>';

      try {
        const res = await fetch('/api/customer/change-wifi', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-customer-token': custToken },
          body: JSON.stringify({ deviceId: currentDeviceId, band: '2.4G', ssid, password })
        });
        const data = await res.json();
        if (res.ok && data.success) {
          showCustToast(data.message);
        } else {
          showCustToast(data.message || 'Error updating WiFi', 'error');
        }
      } catch (err) {
        showCustToast(`WiFi update error: ${err.message}`, 'error');
      } finally {
        btn.disabled = false;
        btn.innerHTML = '<span>💾 Save 2.4G WiFi Changes</span>';
      }
    });
  }

  // 5G WiFi Form
  const form5 = document.getElementById('formCustWifi5');
  if (form5) {
    form5.addEventListener('submit', async (e) => {
      e.preventDefault();
      const ssid = document.getElementById('wifi5Ssid').value.trim();
      const password = document.getElementById('wifi5Pass').value.trim();
      const btn = document.getElementById('btnSaveWifi5');

      btn.disabled = true;
      btn.innerHTML = '<span>⏳ Pushing changes to router...</span>';

      try {
        const res = await fetch('/api/customer/change-wifi', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-customer-token': custToken },
          body: JSON.stringify({ deviceId: currentDeviceId, band: '5G', ssid, password })
        });
        const data = await res.json();
        if (res.ok && data.success) {
          showCustToast(data.message);
        } else {
          showCustToast(data.message || 'Error updating 5G WiFi', 'error');
        }
      } catch (err) {
        showCustToast(`WiFi update error: ${err.message}`, 'error');
      } finally {
        btn.disabled = false;
        btn.innerHTML = '<span>💾 Save 5G WiFi Changes</span>';
      }
    });
  }

  // Support Ticket Form
  const formComp = document.getElementById('formCustComplaint');
  if (formComp) {
    formComp.addEventListener('submit', async (e) => {
      e.preventDefault();
      const category = document.getElementById('compCategory').value;
      const description = document.getElementById('compDescription').value.trim();
      const btn = document.getElementById('btnSubmitComplaint');

      btn.disabled = true;
      btn.innerHTML = '<span>📩 Submitting ticket to NOC...</span>';

      try {
        const res = await fetch('/api/customer/complaints', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-customer-token': custToken },
          body: JSON.stringify({ deviceId: currentDeviceId, category, description })
        });
        const data = await res.json();
        if (res.ok && data.success) {
          showCustToast(data.message);
          document.getElementById('compDescription').value = '';
          
          // Add ticket to UI list
          const list = document.getElementById('custTicketsList');
          if (list) {
            const div = document.createElement('div');
            div.className = 'ticket-item';
            div.innerHTML = `
              <div style="display:flex;justify-content:space-between;align-items:center;">
                <strong>${escapeHtml(data.ticket.ticketId)}</strong>
                <span class="cust-badge" style="background:rgba(245,158,11,0.2);color:#fbbf24;border:1px solid rgba(245,158,11,0.3);">OPEN</span>
              </div>
              <p style="font-size:0.8rem;color:#94a3b8;margin-top:0.25rem;">[${escapeHtml(data.ticket.category)}] ${escapeHtml(data.ticket.description)}</p>
            `;
            list.prepend(div);
          }
        } else {
          showCustToast(data.message || 'Error filing ticket', 'error');
        }
      } catch (err) {
        showCustToast(`Support ticket error: ${err.message}`, 'error');
      } finally {
        btn.disabled = false;
        btn.innerHTML = '<span>📩 Submit Support Ticket</span>';
      }
    });
  }
}

// Router Reboot Action
window.rebootCustomerRouter = async function() {
  if (!confirm('⚠️ Are you sure you want to restart your home router?\n\nInternet will be temporarily interrupted for ~60 seconds while the router reboots.')) {
    return;
  }

  showCustToast('🔄 Sending reboot command to router...', 'info');

  try {
    const res = await fetch('/api/customer/reboot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-customer-token': custToken },
      body: JSON.stringify({ deviceId: currentDeviceId })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showCustToast(data.message);
      const badge = document.getElementById('appRouterStatusBadge');
      if (badge) {
        badge.textContent = 'REBOOTING';
        badge.className = 'cust-badge'
        badge.style.background = 'rgba(245,158,11,0.2)';
        badge.style.color = '#fbbf24';
      }
    } else {
      showCustToast(data.message || 'Reboot failed', 'error');
    }
  } catch (err) {
    showCustToast(`Reboot error: ${err.message}`, 'error');
  }
};

// Speedtest Simulation
let isSpeedtestRunning = false;
window.runSpeedtest = function() {
  if (isSpeedtestRunning) return;
  isSpeedtestRunning = true;

  const btn = document.getElementById('btnStartSpeedtest');
  const numDisplay = document.getElementById('speedNumDisplay');
  const stateLbl = document.getElementById('speedStateLbl');
  const downVal = document.getElementById('speedDownVal');
  const upVal = document.getElementById('speedUpVal');
  const pingVal = document.getElementById('speedPingVal');

  btn.disabled = true;
  stateLbl.textContent = 'Measuring Latency...';
  pingVal.textContent = '...';
  downVal.textContent = '...';
  upVal.textContent = '...';

  // Step 1: Ping
  setTimeout(() => {
    const ping = Math.floor(6 + Math.random() * 8);
    pingVal.textContent = `${ping} ms`;
    stateLbl.textContent = 'Testing Download Speed...';

    // Step 2: Download
    let currentSpeed = 0;
    const targetDown = (45 + Math.random() * 50).toFixed(1);
    const downInterval = setInterval(() => {
      currentSpeed += (parseFloat(targetDown) - currentSpeed) * 0.15;
      numDisplay.textContent = currentSpeed.toFixed(1);
      if (Math.abs(currentSpeed - targetDown) < 0.5) {
        clearInterval(downInterval);
        numDisplay.textContent = targetDown;
        downVal.textContent = `${targetDown} Mbps`;
        stateLbl.textContent = 'Testing Upload Speed...';

        // Step 3: Upload
        setTimeout(() => {
          let curUp = 0;
          const targetUp = (40 + Math.random() * 45).toFixed(1);
          const upInterval = setInterval(() => {
            curUp += (parseFloat(targetUp) - curUp) * 0.15;
            numDisplay.textContent = curUp.toFixed(1);
            if (Math.abs(curUp - targetUp) < 0.5) {
              clearInterval(upInterval);
              numDisplay.textContent = targetDown;
              upVal.textContent = `${targetUp} Mbps`;
              stateLbl.textContent = '✨ Test Complete! Fast & Stable';
              btn.disabled = false;
              isSpeedtestRunning = false;
            }
          }, 60);
        }, 500);
      }
    }, 60);
  }, 800);
};

// Tab Switching
window.switchCustTab = function(tabName) {
  document.querySelectorAll('.cust-tab-view').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.cust-bottom-nav .nav-item').forEach(el => el.classList.remove('active'));

  const targetView = document.getElementById(`tab-${tabName}`);
  if (targetView) targetView.classList.add('active');

  const btnMap = { home: 0, wifi: 1, recharge: 2, devices: 3, speed: 4, support: 5 };
  const navBtns = document.querySelectorAll('.cust-bottom-nav .nav-item');
  if (navBtns[btnMap[tabName]]) {
    navBtns[btnMap[tabName]].classList.add('active');
  }

  window.scrollTo({ top: 0, behavior: 'smooth' });
};

// Online Recharge Handlers
let selectedRechargePlanData = {
  name: '100 Mbps Ultra Fast',
  amount: 699,
  validityDays: 30,
  speed: '100 Mbps'
};

window.selectRechargePlan = function(cardEl, planName, amount, days, speed) {
  document.querySelectorAll('.plan-choice-card').forEach(c => c.classList.remove('selected'));
  if (cardEl) cardEl.classList.add('selected');

  selectedRechargePlanData = { name: planName, amount, validityDays: days, speed };
  
  const titleEl = document.getElementById('checkoutPlanTitle');
  const amtEl = document.getElementById('checkoutAmount');
  const qrImg = document.getElementById('upiDynamicQr');

  if (titleEl) titleEl.textContent = planName;
  if (amtEl) amtEl.textContent = `₹${amount}`;
  if (qrImg) {
    qrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=upi://pay?pa=ciniplay@oksbi%26pn=Broadband%20Recharge%26am=${amount}%26cu=INR`;
  }
};

window.processOnlineRecharge = async function() {
  const btn = document.getElementById('btnInstantRecharge');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span>⚡ Processing Instant Online Recharge...</span>';
  }

  try {
    const res = await fetch('/api/customer/recharge', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-customer-token': custToken
      },
      body: JSON.stringify({
        deviceId: currentDeviceId,
        planName: selectedRechargePlanData.name,
        amount: selectedRechargePlanData.amount,
        validityDays: selectedRechargePlanData.validityDays,
        speed: selectedRechargePlanData.speed,
        paymentMode: 'UPI_INSTANT'
      })
    });

    const data = await res.json();
    if (res.ok && data.success) {
      showCustToast(`🎉 Recharge Successful! Plan activated: ${selectedRechargePlanData.name}`);
      const planNameEl = document.getElementById('custCurrentPlanName');
      const expiryBadge = document.getElementById('custPlanExpiryBadge');
      if (planNameEl) planNameEl.textContent = selectedRechargePlanData.name;
      if (expiryBadge) {
        expiryBadge.textContent = `Active (Renewed ${data.expiryDate ? new Date(data.expiryDate).toLocaleDateString() : '+30 Days'})`;
      }
      setTimeout(() => { switchCustTab('home'); }, 2000);
    } else {
      showCustToast(data.message || 'Recharge transaction failed. Please try again.', 'error');
    }
  } catch (err) {
    showCustToast(`Recharge error: ${err.message}`, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<span>⚡ Complete Instant Recharge (UPI / Card)</span>';
    }
  }
};

// Password Visibility Toggle
window.togglePassVisibility = function(inputId, btn) {
  const input = document.getElementById(inputId);
  if (!input) return;
  if (input.type === 'password') {
    input.type = 'text';
    btn.textContent = '🙈';
  } else {
    input.type = 'password';
    btn.textContent = '👁️';
  }
};

// Toast Notification
function showCustToast(msg, type = 'success') {
  const toast = document.getElementById('custToast');
  if (!toast) return;
  toast.textContent = msg;
  toast.style.borderColor = type === 'error' ? '#ef4444' : '#10b981';
  toast.style.display = 'block';

  setTimeout(() => {
    toast.style.display = 'none';
  }, 3500);
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
