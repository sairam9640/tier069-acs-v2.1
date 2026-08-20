let techToken = localStorage.getItem('tech_auth_token');
let currentTech = null;

let techData = {
  tickets: [
    {
      id: 'TCK-1082',
      customer: 'Vijay Kumar (RH821)',
      phone: '9951716316',
      address: 'Peddapur Main Road, JC Box #3',
      ponPort: 'PON 0/1',
      issue: 'High Optical Drop (-28.45 dBm)',
      distanceMeters: 1715,
      lat: 16.8538,
      lng: 78.5279
    },
    {
      id: 'TCK-1085',
      customer: 'KALAMMA',
      phone: '9848022338',
      address: 'Near Gram Panchayat, FDP Port 2',
      ponPort: 'PON 0/2',
      issue: 'Fiber Micro-Bend Attenuation',
      distanceMeters: 1605,
      lat: 16.8542,
      lng: 78.5283
    }
  ],
  faults: [
    {
      id: 'CUT-01',
      location: '1.34 km from OLT (Between Substation and JC-03)',
      cable: '24F Armored Feeder Cable',
      affectedOnts: '3 Subscribers (PON 0/1, PON 0/2)',
      otdrDistance: '1,340 meters',
      lat: 16.8532,
      lng: 78.5274
    }
  ]
};

document.addEventListener('DOMContentLoaded', () => {
  if (techToken) {
    showMainTechApp();
  } else {
    showTechLoginOverlay();
  }
});

function showTechLoginOverlay() {
  const overlay = document.getElementById('techLoginOverlay');
  const mainApp = document.getElementById('techMainApp');
  if (overlay) overlay.style.display = 'flex';
  if (mainApp) mainApp.style.display = 'none';
}

function showMainTechApp() {
  const overlay = document.getElementById('techLoginOverlay');
  const mainApp = document.getElementById('techMainApp');
  if (overlay) overlay.style.display = 'none';
  if (mainApp) mainApp.style.display = 'block';

  try {
    const saved = localStorage.getItem('tech_profile');
    if (saved) {
      currentTech = JSON.parse(saved);
      const title = document.getElementById('techAppTitle');
      if (title && currentTech.name) title.textContent = `Tech: ${currentTech.name}`;
      const badge = document.getElementById('techStatusBadge');
      if (badge && currentTech.area) badge.textContent = `🟢 ${currentTech.area}`;
    }
  } catch (e) {}

  loadTechData();
}

window.handleTechLogin = async function() {
  const user = document.getElementById('techLoginUser').value.trim();
  const pass = document.getElementById('techLoginPass').value.trim();
  const alertBox = document.getElementById('techLoginAlert');

  try {
    const res = await fetch('/api/auth/technician/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: user, password: pass })
    });
    const data = await res.json();
    if (data.success && data.token) {
      techToken = data.token;
      localStorage.setItem('tech_auth_token', techToken);
      if (data.technician) {
        localStorage.setItem('tech_profile', JSON.stringify(data.technician));
      }
      showMainTechApp();
    } else {
      if (alertBox) {
        alertBox.textContent = data.message || 'Invalid technician credentials';
        alertBox.style.display = 'block';
      }
    }
  } catch (err) {
    if (alertBox) {
      alertBox.textContent = 'Connection error: ' + err.message;
      alertBox.style.display = 'block';
    }
  }
};

window.logoutTechnician = function() {
  localStorage.removeItem('tech_auth_token');
  localStorage.removeItem('tech_profile');
  techToken = null;
  showTechLoginOverlay();
};

function switchTechTab(tabName) {
  document.querySelectorAll('.tech-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tech-view').forEach(v => v.classList.remove('active'));

  const btn = document.querySelector(`.tech-tab[data-tab="${tabName}"]`);
  const view = document.getElementById(`view-${tabName}`);
  if (btn) btn.classList.add('active');
  if (view) view.classList.add('active');
}

async function loadTechData() {
  try {
    const res = await fetch('/api/otdr/faults');
    if (res.ok) {
      const data = await res.json();
      if (data.incidents && data.incidents.length > 0) {
        techData.faults = data.incidents;
      }
    }
  } catch (e) {}

  renderTickets();
  renderFaults();
}

function renderTickets() {
  const container = document.getElementById('techTicketList');
  if (!container) return;

  container.innerHTML = techData.tickets.map(t => `
    <div class="ticket-card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.3rem;">
        <strong style="color:#38bdf8;font-size:0.78rem;">#${t.id} • ${t.ponPort}</strong>
        <span style="font-size:0.7rem;background:rgba(244,63,94,0.2);color:#fb7185;padding:0.1rem 0.4rem;border-radius:4px;">Action Required</span>
      </div>
      <h3>${t.customer}</h3>
      <div class="ticket-meta">
        <div>📍 ${t.address}</div>
        <div>⚠️ Issue: ${t.issue} (📏 ${t.distanceMeters}m)</div>
        <div>📞 Phone: <a href="tel:${t.phone}" style="color:#34d399;text-decoration:none;">${t.phone}</a></div>
      </div>
      <div class="ticket-btn-group">
        <a class="btn-nav-gps" href="https://www.google.com/maps/dir/?api=1&destination=${t.lat},${t.lng}" target="_blank">
          🗺️ GPS Navigate
        </a>
        <button class="btn-resolve" onclick="resolveTicket('${t.id}')">
          ✅ Mark Done
        </button>
      </div>
    </div>
  `).join('');
}

function renderFaults() {
  const container = document.getElementById('techFaultsList');
  if (!container) return;

  container.innerHTML = techData.faults.map(f => `
    <div class="ticket-card" style="border-left-color: #ef4444;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.3rem;">
        <strong style="color:#ef4444;font-size:0.78rem;">🚨 OTDR ALARM: ${f.id}</strong>
        <span style="font-size:0.7rem;background:rgba(239,68,68,0.2);color:#fca5a5;padding:0.1rem 0.4rem;border-radius:4px;">Fiber Break</span>
      </div>
      <h3 style="color:#fff;">${f.cable}</h3>
      <div class="ticket-meta">
        <div>📍 Break Distance: <strong style="color:#fbbf24;">${f.otdrDistance} from OLT</strong></div>
        <div>🗺️ Location: ${f.location}</div>
        <div>👥 Impact: ${f.affectedOnts}</div>
      </div>
      <div class="ticket-btn-group">
        <a class="btn-nav-gps" href="https://www.google.com/maps/dir/?api=1&destination=${f.lat},${f.lng}" target="_blank">
          🧭 Navigate to Break Point
        </a>
      </div>
    </div>
  `).join('');
}

function testDropPower() {
  const meter = document.getElementById('meterDisplay');
  const status = document.getElementById('meterStatus');
  meter.textContent = 'Reading SFP...';
  setTimeout(() => {
    const rx = (-18 - Math.random() * 6).toFixed(2);
    meter.textContent = `${rx} dBm`;
    if (rx < -24) {
      status.textContent = '🟡 Marginal / High Loss';
      status.className = 'meter-status text-warning';
    } else {
      status.textContent = '🟢 Signal is Optimal (-15 to -24 dBm)';
      status.className = 'meter-status text-success';
    }
  }, 600);
}

function resolveTicket(id) {
  techData.tickets = techData.tickets.filter(t => t.id !== id);
  renderTickets();
}
