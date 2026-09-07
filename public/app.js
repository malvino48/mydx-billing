/* ============================================================
   PGNCOM MyDX Gas Billing — Frontend App
   Ticket-based workflow: Buat Tiket → Worklist → Decision →
   Calculation (USD + IDR + PPN) → Validation → Approval → Invoice eDoc
   ============================================================ */

'use strict';

// ─────────────────────────────────────────
//  Constants & State
// ─────────────────────────────────────────
const TICKET_STATUSES = ['DRAFT','WORKLIST','DECISION','CALCULATED','VALIDATED','APPROVED','INVOICED'];
const STATUS_STEP = { DRAFT:0, WORKLIST:1, DECISION:2, CALCULATED:3, VALIDATED:4, APPROVED:5, INVOICED:6 };
const STEP_LABELS  = ['Draft','Worklist','Decision','Kalkulasi','Validasi','Approval','Invoice'];

let state = {
  view: 'dashboard',
  tickets: [],
  masterdata: null,
  regulations: null,
  jisdor: null,
  activeTicket: null,
  calcResult: null,
  validationResult: null,
  approverChecked: false,
  approverName: '',
  approverNote: '',
  mdActiveTab: 'customers',
};

// ─────────────────────────────────────────
//  API
// ─────────────────────────────────────────
async function api(path, opts) {
  const res = await fetch('/api' + path, opts && { ...opts, headers: { 'Content-Type': 'application/json' } });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.error || body.reason || 'Request gagal');
    err.body = body;
    err.status = res.status;
    throw err;
  }
  return res.json();
}
const get  = p => api(p);
const post = (p, d) => api(p, { method: 'POST', body: JSON.stringify(d || {}) });
const patch = (p, d) => api(p, { method: 'PATCH', body: JSON.stringify(d || {}) });

// ─────────────────────────────────────────
//  Formatters
// ─────────────────────────────────────────
function fmtUsd(n) {
  if (n == null) return '—';
  return 'USD ' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtIdr(n) {
  if (n == null) return '—';
  return 'IDR ' + Math.round(Number(n)).toLocaleString('id-ID');
}
function fmtNum(n) {
  if (n == null) return '—';
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtInt(n) { return n == null ? '—' : Math.round(Number(n)).toLocaleString('en-US'); }
function esc(s) { return s == null ? '' : String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// ─────────────────────────────────────────
//  Status badge HTML
// ─────────────────────────────────────────
function statusBadge(status) {
  return `<span class="status-badge sb-${status}">${status}</span>`;
}
function tag(cls, text) { return `<span class="tag tag-${cls}">${esc(text)}</span>`; }

// ─────────────────────────────────────────
//  Init
// ─────────────────────────────────────────
async function init() {
  try { setupNav(); } catch(e) { console.error('setupNav err:', e); }
  try { setupModal(); } catch(e) { console.error('setupModal err:', e); }
  try { setupPanel(); } catch(e) { console.error('setupPanel err:', e); }
  await loadView('dashboard');
}

// ─────────────────────────────────────────
//  Navigation
// ─────────────────────────────────────────
function setupNav() {
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
      const view = btn.dataset.view;
      if (view) loadView(view);
    });
  });
  document.getElementById('newTicketBtn')?.addEventListener('click', openNewTicketModal);
  
  // Sidebar toggle
  document.getElementById('toggleSidebar')?.addEventListener('click', () => {
    document.getElementById('sidebar')?.classList.toggle('collapsed');
  });
}

async function loadView(view) {
  state.view = view;

  // Nav active state
  document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
  const navBtn = document.getElementById('nav-' + view);
  if (navBtn) navBtn.classList.add('active');

  // Topbar
  const titles = {
    dashboard: ['Dashboard', 'Overview tagihan & status tiket'],
    tickets: ['Transaction', 'Daftar tiket tagihan gas bumi'],
    regulations: ['Report Management', 'Genealogi Permen/Kepmen ESDM'],
    masterdata: ['Master Data', 'Customer, kontrak, harga, formula'],
    jisdor: ['Kurs JISDOR', 'Jakarta Interbank Spot Dollar Rate — Bank Indonesia'],
  };
  const [title, breadcrumb] = titles[view] || [view, 'PGNCOM MyDX'];
  const titleEl = document.getElementById('topbarTitle');
  if (titleEl) titleEl.textContent = title;
  const bcEl = document.getElementById('topbarBreadcrumb');
  if (bcEl) bcEl.textContent = breadcrumb;

  setContent('<div class="loading-state"><div class="spinner"></div><div>Memuat...</div></div>');

  try {
    if (view === 'dashboard') await renderDashboard();
    else if (view === 'tickets') await renderTicketList();
    else if (view === 'regulations') await renderRegulations();
    else if (view === 'masterdata') await renderMasterData();
    else if (view === 'jisdor') await renderJisdor();
  } catch(e) {
    setContent(`<div class="callout callout-danger" style="margin:0"><div class="callout-icon">✕</div><div class="callout-body"><b>Error:</b> ${esc(e.message)}</div></div>`);
    console.error(e);
  }
}

function setContent(html) {
  document.getElementById('contentArea').innerHTML = html;
}

// ─────────────────────────────────────────
//  DASHBOARD VIEW
// ─────────────────────────────────────────
async function renderDashboard() {
  const tickets = await get('/tickets');
  state.tickets = tickets;

  const total   = tickets.length;
  const pending = tickets.filter(t => !['APPROVED','INVOICED'].includes(t.status)).length;
  const approved = tickets.filter(t => t.status === 'APPROVED').length;
  const invoiced = tickets.filter(t => t.status === 'INVOICED').length;

  // Update sidebar badge
  document.getElementById('ticketBadge').textContent = total;

  // Recent tickets for quick view
  const recentHtml = tickets.slice(0, 6).map(t => ticketRowHtml(t, true)).join('');

  setContent(`
    <div class="dashboard-grid">
      <div class="metric-card metric-accent">
        <div class="metric-label">Total Tiket</div>
        <div class="metric-value">${total}</div>
        <div class="metric-sub">Periode aktif</div>
      </div>
      <div class="metric-card metric-warn">
        <div class="metric-label">Menunggu Aksi</div>
        <div class="metric-value">${pending}</div>
        <div class="metric-sub">Belum approved/invoiced</div>
      </div>
      <div class="metric-card metric-ok">
        <div class="metric-label">Approved</div>
        <div class="metric-value">${approved}</div>
        <div class="metric-sub">Siap di-invoice</div>
      </div>
      <div class="metric-card" style="border-top:3px solid var(--status-invoiced)">
        <div class="metric-label">Invoiced</div>
        <div class="metric-value">${invoiced}</div>
        <div class="metric-sub">eDoc diterbitkan</div>
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <div>
          <div class="card-title">Billing Tickets Terbaru</div>
        </div>
        <button class="btn btn-sm" onclick="loadView('tickets')">Lihat Semua →</button>
      </div>
      <table>
        <thead>
          <tr>
            <th>Tiket</th>
            <th>Customer</th>
            <th>Periode</th>
            <th>Skema</th>
            <th>Status</th>
            <th>Aksi</th>
          </tr>
        </thead>
        <tbody id="dashboardTicketBody">
          ${recentHtml || '<tr><td colspan="6" style="text-align:center;color:var(--ink-faint);padding:30px">Belum ada tiket</td></tr>'}
        </tbody>
      </table>
    </div>

    <div class="callout callout-info" style="margin-top:16px">
      <div class="callout-icon">ℹ</div>
      <div class="callout-body">
        <b>Kebijakan HGBT aktif:</b> Harga gas bumi eligible untuk 7 industri HGBT dibatasi maksimum <b>USD 6,00/MMBTU</b> berdasarkan Permen ESDM No. 15/2022. Sistem akan memvalidasi secara otomatis saat kalkulasi dijalankan.
        <div style="margin-top:6px;font-size:11px;opacity:.8">7 Industri HGBT: Pupuk · Petrokimia · Oleokimia · Baja · Keramik · Kaca · Sarung Tangan Karet</div>
      </div>
    </div>
  `);

  // Attach row click events
  attachTicketRowEvents();
}

// ─────────────────────────────────────────
//  TICKET LIST VIEW
// ─────────────────────────────────────────
async function renderTicketList() {
  const tickets = await get('/tickets');
  state.tickets = tickets;
  document.getElementById('ticketBadge').textContent = tickets.length;

  // Status filter buttons
  const allStatuses = ['SEMUA', ...TICKET_STATUSES];

  setContent(`
    <div style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap;align-items:center;justify-content:space-between;">
      <div class="tab-bar" id="statusFilter" style="margin-bottom:0">
        ${allStatuses.map(s => `<button class="tab-btn ${s==='SEMUA'?'active':''}" data-filter="${s}">${s}</button>`).join('')}
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-ghost" id="cleanTicketsBtn" style="border:1px solid var(--border);color:var(--ink-soft)">🧹 Reset / Cleansing Tiket</button>
        <button class="btn btn-primary" id="newTicketBtn2">+ Buat Tiket</button>
      </div>
    </div>
    <div class="card">
      <table>
        <thead>
          <tr>
            <th>Tiket / Kontrak</th>
            <th>Customer</th>
            <th>Industri</th>
            <th>Periode</th>
            <th>Skema Bayar</th>
            <th>Status</th>
            <th>Aksi</th>
          </tr>
        </thead>
        <tbody id="ticketListBody">
          ${tickets.map(t => ticketRowHtml(t, false)).join('') || '<tr><td colspan="7" style="text-align:center;padding:40px;color:var(--ink-faint)">Belum ada tiket billing</td></tr>'}
        </tbody>
      </table>
    </div>
  `);

  document.getElementById('newTicketBtn2')?.addEventListener('click', openNewTicketModal);
  document.getElementById('cleanTicketsBtn')?.addEventListener('click', async () => {
    if (!confirm('Apakah Anda yakin ingin melakukan cleansing / reset semua tiket agar semua kontrak siap digunakan kembali untuk demo?')) return;
    try {
      await post('/tickets/cleansing', { resetAll: true });
      alert('Cleansing berhasil! Semua tiket lama telah dibersihkan dan siap digunakan kembali.');
      await loadView('tickets');
    } catch(e) {
      alert('Gagal cleansing: ' + e.message);
    }
  });


  // Status filter
  document.querySelectorAll('#statusFilter .tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#statusFilter .tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const filter = btn.dataset.filter;
      const rows = document.querySelectorAll('#ticketListBody tr.clickable');
      rows.forEach(row => {
        row.style.display = (filter === 'SEMUA' || row.dataset.status === filter) ? '' : 'none';
      });
    });
  });

  attachTicketRowEvents();
}

function ticketRowHtml(t, compact) {
  const schemeColor = { postpaid: 'info', hybrid: 'warn', prepaid: 'ok' };
  const scheme = t.payment_scheme || t.contract?.payment_scheme || '—';

  return `
    <tr class="clickable" data-ticket-id="${t.id}" data-status="${t.status}">
      <td>
        <div class="ticket-meta">
          <div class="ticket-id">${esc(t.id)}</div>
          <div class="ticket-name">${esc(t.contract?.id || '—')}</div>
        </div>
      </td>
      <td>
        <div class="ticket-name">${esc(t.customer?.name || '—')}</div>
        ${!compact ? `<div class="ticket-customer" style="font-size:11px;color:var(--ink-faint)">${esc(t.customer?.npwp || '')}</div>` : ''}
      </td>
      ${!compact ? `<td>${t.industry ? `<span class="tag tag-hgbt">${esc(t.industry.name)}</span>` : '<span class="tag tag-muted">Non-HGBT</span>'}</td>` : ''}
      <td class="mono">${esc(t.period)}</td>
      <td><span class="tag tag-${schemeColor[scheme] || 'muted'}" style="text-transform:capitalize">${esc(scheme)}</span></td>
      <td>${statusBadge(t.status)}</td>
      <td><button class="btn btn-sm" data-ticket-id="${t.id}">Buka →</button></td>
    </tr>`;
}

function attachTicketRowEvents() {
  document.querySelectorAll('[data-ticket-id]').forEach(el => {
    if (!el) return;
    el.addEventListener('click', (e) => {
      const id = el.dataset.ticketId || el.closest('[data-ticket-id]')?.dataset.ticketId;
      if (id) openTicketPanel(id);
    });
  });
}


// ─────────────────────────────────────────
//  NEW TICKET MODAL
// ─────────────────────────────────────────
function setupModal() {
  document.getElementById('closeModal')?.addEventListener('click', closeModal);
  document.getElementById('cancelModal')?.addEventListener('click', closeModal);
  document.getElementById('submitNewTicket')?.addEventListener('click', submitNewTicket);
  document.getElementById('newTicketBtn')?.addEventListener('click', openNewTicketModal);
  document.getElementById('newTicketModal')?.addEventListener('click', e => {
    if (e.target === e.currentTarget) closeModal();
  });

  document.getElementById('modalCustomerSelect')?.addEventListener('change', updateModalContractOptions);
  document.getElementById('modalPeriod')?.addEventListener('change', updateModalContractOptions);
}

async function openNewTicketModal() {
  // Load masterdata & tickets for dynamic filtering
  if (!state.masterdata) state.masterdata = await get('/masterdata');
  state.tickets = await get('/tickets');

  const custSel = document.getElementById('modalCustomerSelect');
  const contractSel = document.getElementById('modalContractSelect');

  // Populate Customer dropdown
  custSel.innerHTML = '<option value="">— Pilih Customer —</option>' +
    state.masterdata.customers.map(c => {
      const cCount = state.masterdata.contracts.filter(ctr => ctr.customer_id === c.id).length;
      return `<option value="${c.id}">${c.name} (${cCount} Kontrak)</option>`;
    }).join('');

  custSel.value = '';
  contractSel.innerHTML = '<option value="">— Pilih Customer Terlebih Dahulu —</option>';
  contractSel.disabled = true;

  document.getElementById('newTicketModal').classList.add('open');
}

function updateModalContractOptions() {
  const customerId = document.getElementById('modalCustomerSelect')?.value;
  const period = document.getElementById('modalPeriod')?.value;
  const contractSel = document.getElementById('modalContractSelect');

  if (!customerId) {
    contractSel.innerHTML = '<option value="">— Pilih Customer Terlebih Dahulu —</option>';
    contractSel.disabled = true;
    return;
  }

  const md = state.masterdata;
  if (!md) return;

  const customerContracts = md.contracts.filter(c => c.customer_id === customerId);
  const existingTickets = state.tickets || [];

  // Filter out contracts that ALREADY have a ticket for the selected period
  const availableContracts = [];
  const processedContracts = [];

  customerContracts.forEach(ctr => {
    const ticketId = `TKT-${period ? period.replace('-', '') : ''}-${ctr.id}`;
    const hasTicket = existingTickets.some(t => t.id === ticketId || (t.contract_id === ctr.id && t.period === period));
    if (hasTicket) {
      processedContracts.push(ctr);
    } else {
      availableContracts.push(ctr);
    }
  });

  if (availableContracts.length === 0) {
    contractSel.innerHTML = '<option value="">— Semua kontrak customer ini sudah diproses untuk periode ' + (period || '') + ' —</option>';
    contractSel.disabled = true;
    return;
  }

  let html = '<option value="">— Pilih Kontrak —</option>';
  availableContracts.forEach(ctr => {
    html += `<option value="${ctr.id}">${ctr.id} (Skema: ${ctr.payment_scheme}, Alokasi: ${fmtInt(ctr.allocation)} ${ctr.uom||'MMBTU'})</option>`;
  });

  if (processedContracts.length > 0) {
    processedContracts.forEach(ctr => {
      html += `<option value="" disabled style="color:var(--ink-faint)">${ctr.id} — (Sudah Ada Tiket Periode ${period})</option>`;
    });
  }

  contractSel.innerHTML = html;
  contractSel.disabled = false;
}

function closeModal() {
  document.getElementById('newTicketModal').classList.remove('open');
}

async function submitNewTicket() {
  const contractId = document.getElementById('modalContractSelect').value;
  const period = document.getElementById('modalPeriod').value;
  const notes = document.getElementById('modalNotes').value;
  if (!contractId || !period) { alert('Pilih kontrak dan periode terlebih dahulu.'); return; }
  try {
    const ticket = await post('/tickets', { contractId, period, notes });
    closeModal();
    state.tickets = [];
    await openTicketPanel(ticket.id);
    if (state.view === 'tickets' || state.view === 'dashboard') await loadView(state.view);
  } catch(e) {
    alert('Gagal membuat tiket: ' + (e.body?.error || e.message));
  }
}

// ─────────────────────────────────────────
//  TICKET PANEL
// ─────────────────────────────────────────
function setupPanel() {
  document.getElementById('closePanelBtn')?.addEventListener('click', closePanel);
  document.getElementById('panelOverlay')?.addEventListener('click', closePanel);
}

function openPanel() {
  document.getElementById('ticketPanel').classList.add('open');
  document.getElementById('panelOverlay').classList.add('active');
}
function closePanel() {
  document.getElementById('ticketPanel').classList.remove('open');
  document.getElementById('panelOverlay').classList.remove('active');
  state.activeTicket = null;
  state.calcResult = null;
  state.validationResult = null;
  state.approverChecked = false;
}

async function openTicketPanel(ticketId) {
  state.calcResult = null;
  state.validationResult = null;
  state.approverChecked = false;

  document.getElementById('panelTicketId').textContent = ticketId;
  document.getElementById('panelTicketTitle').textContent = 'Memuat...';
  document.getElementById('panelBody').innerHTML = '<div class="loading-state"><div class="spinner"></div><div>Memuat tiket...</div></div>';
  openPanel();

  const ticket = await get('/tickets/' + ticketId);
  state.activeTicket = ticket;
  renderTicketPanel(ticket);
}

async function renderTicketPanel(ticket) {
  document.getElementById('panelTicketId').textContent = ticket.id;
  document.getElementById('panelTicketTitle').textContent =
    `${ticket.customer?.name || '?'} · Periode ${ticket.period}`;

  const stepIdx = STATUS_STEP[ticket.status] ?? 0;
  const body = document.getElementById('panelBody');
  body.innerHTML = '';   // Clear once — never touch innerHTML again after this point

  // Helper: append an HTML string as a real DOM node (safe, no re-serialization)
  function appendHtml(html) {
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    while (tmp.firstChild) body.appendChild(tmp.firstChild);
  }

  // ── Step Tracker ──
  appendHtml(`
    <div class="step-tracker">
      ${STEP_LABELS.map((label, i) => {
        let cls = '';
        if (i < stepIdx) cls = 'done';
        else if (i === stepIdx) cls = 'current';
        const icon = i < stepIdx ? '✓' : (i === stepIdx ? '●' : i+1);
        return `<div class="step-item ${cls}">
          <div class="step-dot">${icon}</div>
          <div class="step-label">${label}</div>
        </div>`;
      }).join('')}
    </div>`);

  // ── Section: Info Tiket ──
  const contract = ticket.contract;
  const customer = ticket.customer;
  const industry = ticket.industry;
  const scheme   = contract?.payment_scheme || '—';
  const schemeColor = { postpaid: 'info', hybrid: 'warn', prepaid: 'ok' };

  appendHtml(`
    <div class="p-section">
      <div class="p-section-header">
        <div class="p-section-title">
          <span class="p-section-step">INFO</span>
          Ringkasan Tiket
        </div>
        ${statusBadge(ticket.status)}
      </div>
      <div class="kv-grid">
        <div class="kv-item">
          <div class="kv-label">Customer</div>
          <div class="kv-value">${esc(customer?.name || '—')}</div>
        </div>
        <div class="kv-item">
          <div class="kv-label">NPWP</div>
          <div class="kv-value kv-mono">${esc(customer?.npwp || '—')}</div>
        </div>
        <div class="kv-item">
          <div class="kv-label">Industri HGBT</div>
          <div class="kv-value">${industry ? `<span class="tag tag-hgbt">${esc(industry.name)}</span>` : '<span class="tag tag-muted">Non-HGBT</span>'}</div>
        </div>
        <div class="kv-item">
          <div class="kv-label">Kontrak</div>
          <div class="kv-value kv-mono">${esc(contract?.id || '—')}</div>
        </div>
        <div class="kv-item">
          <div class="kv-label">Skema Pembayaran</div>
          <div class="kv-value"><span class="tag tag-${schemeColor[scheme]||'muted'}" style="text-transform:capitalize">${esc(scheme)}</span></div>
        </div>
        <div class="kv-item">
          <div class="kv-label">Periode Billing</div>
          <div class="kv-value kv-mono">${esc(ticket.period)}</div>
        </div>
        <div class="kv-item">
          <div class="kv-label">Alokasi Eligible</div>
          <div class="kv-value">${fmtInt(contract?.allocation)} ${contract?.uom || 'MMBTU'}</div>
        </div>
        <div class="kv-item">
          <div class="kv-label">Fixed Fee / Annual Fee</div>
          <div class="kv-value">${fmtUsd(contract?.fixed_fee)} / ${fmtUsd(contract?.annual_fee)}</div>
        </div>
      </div>
      ${contract?.opening_balance > 0 ? `
        <div class="callout callout-info mt-12">
          <div class="callout-icon">⊙</div>
          <div class="callout-body">Saldo ${esc(scheme)}: <b>${fmtUsd(contract.opening_balance)}</b> — akan diperhitungkan saat kalkulasi</div>
        </div>` : ''}
      ${stepIdx === 0 ? `
        <div class="action-bar" style="margin-top:12px">
          <button class="btn btn-primary" id="advanceToWorklistDraft">Mulai Worklist →</button>
        </div>` : ''}
    </div>`);

  // Attach DRAFT → WORKLIST button handler
  document.getElementById('advanceToWorklistDraft')?.addEventListener('click', async () => {
    await patch(`/tickets/${ticket.id}/status`, { status: 'WORKLIST' });
    state.activeTicket = await get('/tickets/' + ticket.id);
    renderTicketPanel(state.activeTicket);
  });

  // ── Step 1: Worklist ──
  await renderWorklistSection(ticket, body, stepIdx);

  // ── Step 2: Decision & Price ──
  await renderDecisionSection(ticket, body, stepIdx);

  // ── Step 3: Calculation ──
  await renderCalculationSection(ticket, body, stepIdx);

  // ── Step 4: Validation ──
  await renderValidationSection(ticket, body, stepIdx);

  // ── Step 5: Approval ──
  await renderApprovalSection(ticket, body, stepIdx);

  // ── Step 6: Invoice ──
  await renderInvoiceSection(ticket, body, stepIdx);
}


// ─────────────────────────────────────────
//  STEP 1: WORKLIST
// ─────────────────────────────────────────
async function renderWorklistSection(ticket, body, stepIdx) {
  // S1 tidak ditampilkan di step DRAFT (stepIdx=0)
  if (stepIdx < 1) return;
  const isDone = stepIdx > 1;
  const isCurrent = stepIdx === 1;
  const cls = isDone ? 'p-section-done' : '';

  let w;
  try { w = await get(`/worklist/${ticket.contract_id}/${ticket.period}`); }
  catch(e) { return; }

  const usage = w.usage;
  const hasMissing = !usage || usage.status === 'missing';

  let usageHtml = '';
  if (!usage) {
    usageHtml = `<tr><td>Meter reading</td><td class="mono">${ticket.period}</td><td>—</td><td>${tag('danger','Missing')}</td></tr>`;
  } else if (usage.status === 'missing') {
    usageHtml = `
      <tr>
        <td>Meter reading</td><td class="mono">${ticket.period}</td>
        <td style="color:var(--ink-faint);font-style:italic">${esc(usage.note || '—')}</td>
        <td>${tag('danger','Missing')}</td>
      </tr>`;
  } else {
    usageHtml = `
      <tr>
        <td>Volume Terukur (raw)</td><td class="mono">${ticket.period}</td>
        <td class="td-mono">${fmtInt(usage.raw_m3)} m³</td><td>${tag('ok','Validated')}</td>
      </tr>
      <tr>
        <td>Volume Terkonversi</td><td class="mono">${ticket.period}</td>
        <td class="td-mono"><b>${fmtInt(usage.qty_mmbtu)} MMBTU</b></td><td>${tag('ok','Ready')}</td>
      </tr>`;
    if (usage.one_time_fee) {
      usageHtml += `<tr><td>Event: ${esc(usage.one_time_label)}</td><td class="mono">${ticket.period}</td><td class="td-mono">${fmtUsd(usage.one_time_fee)}</td><td>${tag('info','One-time')}</td></tr>`;
    }
  }

  const div = document.createElement('div');
  div.className = `p-section ${cls}`;
  div.innerHTML = `
    <div class="p-section-header">
      <div class="p-section-title">
        <span class="p-section-step ${isDone?'':''}">S1</span>
        Billing Worklist
      </div>
      ${isDone ? tag('ok','✓ Selesai') : ''}
    </div>
    <div class="kv-grid" style="margin-bottom:12px">
      <div class="kv-item">
        <div class="kv-label">Konversi UOM</div>
        <div class="kv-value">1 m³ = 0.0364 MMBTU</div>
      </div>
      <div class="kv-item">
        <div class="kv-label">Status Data Meter</div>
        <div class="kv-value">${hasMissing ? tag('danger','Data Tidak Lengkap') : tag('ok','Data Tersedia')}</div>
      </div>
    </div>
    <table>
      <thead><tr><th>Item</th><th>Periode</th><th>Nilai</th><th>Status</th></tr></thead>
      <tbody>${usageHtml}</tbody>
    </table>
    ${hasMissing ? `
      <div class="callout callout-danger mt-12">
        <div class="callout-icon">⚠</div>
        <div class="callout-body">
          <b>Completeness check gagal.</b> Meter reading periode ${ticket.period} belum tersedia.
        </div>
      </div>
      <div style="background:var(--surface-soft);border:1px solid var(--border);border-radius:6px;padding:12px;margin-bottom:12px">
        <div class="form-group" style="margin-bottom:8px">
          <label class="form-label">Masukkan Koreksi Volume (MMBTU)</label>
          <input type="number" class="form-input" id="worklistVolumeInput" value="2600" style="max-width:180px">
        </div>
        <button class="btn btn-warning btn-sm" id="resolveDataBtn">Konfirmasi Koreksi Data (Data Owner)</button>
      </div>` : `
      <div class="action-bar">
        ${stepIdx === 0 ? `<button class="btn btn-primary" id="advanceToWorklist">Mulai Worklist →</button>` : ''}
        ${stepIdx === 1 ? `<button class="btn btn-primary" id="advanceToDecision">Lanjut ke Decision →</button>` : ''}
      </div>`}
  `;
  body.appendChild(div);

  div.querySelector('#resolveDataBtn')?.addEventListener('click', async () => {
    const val = Number(document.getElementById('worklistVolumeInput')?.value || 2600);
    await post(`/worklist/${ticket.contract_id}/${ticket.period}/resolve`, { qtyMmbtu: val });
    await patch(`/tickets/${ticket.id}/status`, { status: 'WORKLIST' });
    state.activeTicket = await get('/tickets/' + ticket.id);
    renderTicketPanel(state.activeTicket);
  });
  div.querySelector('#advanceToWorklist')?.addEventListener('click', async () => {
    await patch(`/tickets/${ticket.id}/status`, { status: 'WORKLIST' });
    state.activeTicket = await get('/tickets/' + ticket.id);
    renderTicketPanel(state.activeTicket);
  });
  div.querySelector('#advanceToDecision')?.addEventListener('click', async () => {
    await patch(`/tickets/${ticket.id}/status`, { status: 'DECISION' });
    state.activeTicket = await get('/tickets/' + ticket.id);
    renderTicketPanel(state.activeTicket);
  });
}

// ─────────────────────────────────────────
//  STEP 2: DECISION & PRICE
// ─────────────────────────────────────────
async function renderDecisionSection(ticket, body, stepIdx) {
  // S2 tidak ditampilkan di step WORKLIST (stepIdx=1) atau DRAFT (stepIdx=0)
  if (stepIdx < 2) return;
  const isDone = stepIdx > 2;

  let d;
  try { d = await get(`/decision/${ticket.contract_id}/${ticket.period}`); }
  catch(e) {
    body.appendChild(Object.assign(document.createElement('div'), { className: 'callout callout-danger', innerHTML: 'Gagal memuat decision: ' + esc(e.message) }));
    return;
  }

  const pv = d.priceVersion;
  const formula = d.formula;
  const hgbt = d.hgbtCheck;
  const regCheck = d.regCheck;
  const regBlocked = regCheck && regCheck.blocked;
  const selectedRule = d.ruleRes?.selected;

  // Options for Formula Dropdown
  const formulaOpts = (d.allFormulas || []).map(f =>
    `<option value="${f.id}" ${formula?.id === f.id ? 'selected' : ''}>${f.name} (${f.id})</option>`
  ).join('');

  // Options for Regulasi / Price Version Dropdown
  const priceOpts = (d.allPriceVersions || []).map(p =>
    `<option value="${p.id}" ${pv?.id === p.id ? 'selected' : ''}>${p.id} — Rate Eligible: USD ${fmtNum(p.rate_eligible)}/MMBTU</option>`
  ).join('');

  let hgbtHtml = '';
  if (hgbt && hgbt.isHgbt) {
    const isOk = hgbt.valid;
    hgbtHtml = `
      <div class="${isOk ? 'callout callout-ok' : 'callout callout-danger'}" style="margin-top:12px">
        <div class="callout-icon">${isOk ? '✓' : '⚠'}</div>
        <div class="callout-body">
          <b>Validasi HGBT (Permen ESDM 15/2022):</b> Rate eligible <b>USD ${pv ? fmtNum(pv.rate_eligible) : '—'}/MMBTU</b> ${isOk ? '≤ cap USD 6,00/MMBTU ✓' : '<b>MELEBIHI cap USD 6,00/MMBTU!</b>'} (Sektor: ${esc(ticket.industry?.name || '—')})
        </div>
      </div>`;
  }

  const div = document.createElement('div');
  div.className = `p-section ${isDone ? 'p-section-done' : ''}`;
  div.innerHTML = `
    <div class="p-section-header">
      <div class="p-section-title"><span class="p-section-step">S2</span> Decision & Price Resolution</div>
      ${isDone ? tag('ok','✓ Selesai') : ''}
    </div>

    ${regBlocked ? `<div class="callout callout-danger" style="margin-bottom:14px"><div class="callout-icon">⚠</div><div class="callout-body"><b>Regulasi dicabut:</b> ${esc(regCheck.reg?.name)} berstatus REVOKED. Mapping pengganti: ${esc(regCheck.replacement?.name)}. <button class="btn btn-sm btn-warning" id="activateReplacementBtn" style="margin-left:8px">Aktifkan Replacement</button></div></div>` : ''}

    <div style="background:var(--surface-soft);border:1px solid var(--border);border-radius:var(--radius);padding:16px;margin-bottom:14px">
      <!-- Billing Rule & Formula Field -->
      <div class="form-group" style="margin-bottom:14px">
        <label class="form-label" style="font-weight:700">Formula Billing yang Digunakan</label>
        <select class="form-select" id="s2FormulaSelect">
          ${formulaOpts}
        </select>
        <div class="form-help-text" id="s2FormulaInfo" style="font-size:12px;color:var(--ink-soft);margin-top:6px;padding:8px 12px;background:var(--surface);border:1px solid var(--border);border-radius:6px">
          <b>Ekspresi:</b> <code style="font-family:var(--mono);color:var(--brand-purple);font-weight:600">${esc(formula?.expr || '—')}</code><br>
          <span style="color:var(--ink-faint)">${esc(formula?.description || 'Formula billing tagihan')}</span>
        </div>
      </div>

      <!-- Regulasi & Price Version Field -->
      <div class="form-group" style="margin-bottom:0">
        <label class="form-label" style="font-weight:700">Regulasi & Price Version</label>
        <select class="form-select" id="s2PriceSelect">
          ${priceOpts}
        </select>
        <div class="form-help-text" id="s2PriceInfo" style="font-size:12px;color:var(--ink-soft);margin-top:6px;padding:8px 12px;background:var(--surface);border:1px solid var(--border);border-radius:6px">
          <b>Regulasi Dasar:</b> ${esc(d.regCheck?.reg?.name || '—')} (Cap HGBT: ${pv?.rate_eligible <= 6 ? 'USD 6,00/MMBTU' : 'Non-HGBT'})<br>
          <b>Tarif Gas:</b> Rate Eligible = <b style="color:var(--ok)">USD ${fmtNum(pv?.rate_eligible)}</b> / MMBTU &nbsp;|&nbsp; Rate Excess = <b>USD ${fmtNum(pv?.rate_excess)}</b> / MMBTU &nbsp;|&nbsp; Masa Berlaku: <b>${esc(pv?.effective_from || '—')} – ${esc(pv?.effective_to || 'sekarang')}</b>
        </div>
      </div>
    </div>

    ${hgbtHtml}

    ${!regBlocked && pv && stepIdx === 2 && hgbt?.valid !== false ? `
      <div class="action-bar" style="margin-top:14px">
        <button class="btn btn-primary" id="advanceToCalc">Lanjut ke Kalkulasi →</button>
      </div>` : ''}
  `;
  body.appendChild(div);

  // Dynamic dropdown info updater if user changes selection
  div.querySelector('#s2FormulaSelect')?.addEventListener('change', (e) => {
    const selectedF = (d.allFormulas || []).find(f => f.id === e.target.value);
    if (selectedF) {
      div.querySelector('#s2FormulaInfo').innerHTML = `
        <b>Ekspresi:</b> <code style="font-family:var(--mono);color:var(--brand-purple);font-weight:600">${esc(selectedF.expr)}</code><br>
        <span style="color:var(--ink-faint)">${esc(selectedF.description || 'Formula billing tagihan')}</span>`;
    }
  });

  div.querySelector('#s2PriceSelect')?.addEventListener('change', (e) => {
    const selectedP = (d.allPriceVersions || []).find(p => p.id === e.target.value);
    if (selectedP) {
      div.querySelector('#s2PriceInfo').innerHTML = `
        <b>Regulasi ID:</b> ${esc(selectedP.regulation_id)}<br>
        <b>Tarif Gas:</b> Rate Eligible = <b style="color:var(--ok)">USD ${fmtNum(selectedP.rate_eligible)}</b> / MMBTU &nbsp;|&nbsp; Rate Excess = <b>USD ${fmtNum(selectedP.rate_excess)}</b> / MMBTU &nbsp;|&nbsp; Masa Berlaku: <b>${esc(selectedP.valid_from)} – ${esc(selectedP.valid_to || 'sekarang')}</b>`;
    }
  });

  div.querySelector('#activateReplacementBtn')?.addEventListener('click', async () => {
    await post('/decision/activate-replacement', { contractId: ticket.contract_id, period: ticket.period });
    state.activeTicket = await get('/tickets/' + ticket.id);
    renderTicketPanel(state.activeTicket);
  });

  div.querySelector('#advanceToCalc')?.addEventListener('click', async () => {
    await patch(`/tickets/${ticket.id}/status`, { status: 'CALCULATED' });
    state.activeTicket = await get('/tickets/' + ticket.id);
    renderTicketPanel(state.activeTicket);
  });
}


// ─────────────────────────────────────────
//  STEP 3: CALCULATION
// ─────────────────────────────────────────
async function renderCalculationSection(ticket, body, stepIdx) {
  if (stepIdx < 3) return;   // S3 hanya ditampilkan saat tiket masuk/melewati tahap CALCULATED
  const isDone = stepIdx > 3;

  // Get existing calc if already done
  const existingCalc = ticket.latestCalc;

  // JISDOR select options
  let jisdorOpts = '';
  try {
    const jRows = await get('/jisdor');
    jisdorOpts = jRows.map(j => `<option value="${j.rate_date}">${j.rate_date} — IDR ${fmtInt(j.idr_per_usd)}/USD</option>`).join('');
  } catch(e) {}

  const div = document.createElement('div');
  div.className = `p-section ${isDone ? 'p-section-done' : ''}`;

  if (existingCalc && stepIdx >= 3) {
    // Show filled calculation fields
    const c = existingCalc;
    const isHgbtOk = c.hgbt_validated === 1;
    const ppn = c.ppn_amount;
    const totalIdr = c.total_idr;

    div.innerHTML = `
      <div class="p-section-header">
        <div class="p-section-title"><span class="p-section-step">S3</span> Kalkulasi Billing</div>
        <div style="display:flex;gap:8px;align-items:center">${tag('ok','✓ Calculated')} <span class="tag tag-muted mono">v${c.version}</span></div>
      </div>
      ${c.hgbt_warning ? `<div class="callout callout-warn"><div class="callout-icon">⚠</div><div class="callout-body">${esc(c.hgbt_warning)}</div></div>` : ''}
      ${c.hgbt_validated ? `<div class="callout callout-ok"><div class="callout-icon">✓</div><div class="callout-body"><b>HGBT Validated:</b> Rate eligible ${fmtNum(0)} USD/MMBTU ≤ cap USD 6.00/MMBTU (Permen ESDM 15/2022)</div></div>` : ''}
      <div class="calc-fields">
        <div class="calc-field">
          <div class="calc-field-label">Eligible Qty</div>
          <div class="calc-field-value">${fmtInt(c.eligible_qty)}</div>
          <div class="calc-field-unit">MMBTU</div>
        </div>
        <div class="calc-field">
          <div class="calc-field-label">Excess Qty</div>
          <div class="calc-field-value">${fmtInt(c.excess_qty)}</div>
          <div class="calc-field-unit">MMBTU</div>
        </div>
        ${c.fixed_fee ? `<div class="calc-field"><div class="calc-field-label">Fixed Fee</div><div class="calc-field-value">${fmtNum(c.fixed_fee)}</div><div class="calc-field-unit">USD</div></div>` : ''}
        ${c.annual_fee_prorated ? `<div class="calc-field"><div class="calc-field-label">Annual Fee (÷12)</div><div class="calc-field-value">${fmtNum(c.annual_fee_prorated)}</div><div class="calc-field-unit">USD/bulan</div></div>` : ''}
        ${c.one_time_fee ? `<div class="calc-field"><div class="calc-field-label">One-time Fee</div><div class="calc-field-value">${fmtNum(c.one_time_fee)}</div><div class="calc-field-unit">USD</div></div>` : ''}
        <div class="calc-field highlighted">
          <div class="calc-field-label">Total USD (before PPN)</div>
          <div class="calc-field-value">${fmtNum(c.total_usd || c.total)}</div>
          <div class="calc-field-unit">USD</div>
        </div>
        ${c.jisdor_rate ? `
        <div class="calc-field">
          <div class="calc-field-label">Kurs JISDOR</div>
          <div class="calc-field-value">${fmtInt(c.jisdor_rate)}</div>
          <div class="calc-field-unit">IDR/USD · ${esc(c.jisdor_date)}</div>
        </div>
        <div class="calc-field">
          <div class="calc-field-label">PPN (${Math.round((c.ppn_rate||0.11)*100)}%)</div>
          <div class="calc-field-value">${fmtInt(ppn)}</div>
          <div class="calc-field-unit">IDR</div>
        </div>
        <div class="calc-field idr-total">
          <div class="calc-field-label">Total IDR (termasuk PPN)</div>
          <div class="calc-field-value">${fmtIdr(totalIdr)}</div>
          <div class="calc-field-unit">Kurs JISDOR ${esc(c.jisdor_date)} · PPN ${Math.round((c.ppn_rate||0.11)*100)}%</div>
        </div>` : ''}

      </div>
      <div class="total-row">
        <span class="total-row-label">Total Kalkulasi (USD, belum PPN) — v${c.version}</span>
        <span class="total-row-value">${fmtUsd(c.total_usd || c.total)}</span>
      </div>
      ${ticket.status !== 'INVOICED' ? `
      <div class="action-bar" style="margin-top:12px">
        <button class="btn btn-ghost btn-sm" id="recalcRateBtn">↺ Hitung Ulang Tarif (v${c.version + 1})</button>
      </div>` : ''}
      <div class="flow-caption">Status: ${esc(c.status)} · Formula: ${esc(c.formula_id)} · Rule: ${esc(c.rule_id)}</div>
    `;
  } else if (stepIdx === 3) {
    // Show calculation form
    div.innerHTML = `
      <div class="p-section-header">
        <div class="p-section-title"><span class="p-section-step">S3</span> Kalkulasi Billing</div>
      </div>
      <div class="callout callout-info">
        <div class="callout-icon">ℹ</div>
        <div class="callout-body">
          Sistem akan menghitung tagihan berdasarkan rule & price version. Anda bisa mengetik langsung Kurs JISDOR manual atau Biaya Tambahan di bawah.
        </div>
      </div>
      <div class="grid2" style="margin-bottom:12px">
        <div class="form-group">
          <label class="form-label">Tanggal Kurs JISDOR</label>
          <select class="form-select" id="jisdorDateSelect">
            ${jisdorOpts}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Override Kurs JISDOR Manual (IDR/USD)</label>
          <input type="number" class="form-input" id="manualJisdorRate" placeholder="e.g. 16150 (Kosongkan jika default)">
        </div>
      </div>
      <div class="form-group" style="max-width:320px;margin-bottom:16px">
        <label class="form-label">Biaya Tambahan Manual / One-Time Fee (USD)</label>
        <input type="number" class="form-input" id="manualOneTimeFee" value="0">
      </div>
      <div class="action-bar">
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px">
          <button class="btn btn-primary" id="runCalculationBtn">▶ Konfirmasi &amp; Jalankan Kalkulasi</button>
          <span style="font-size:11px;color:var(--ink-faint)">Akan menyimpan hasil kalkulasi dan menggerakkan tiket ke status <b>Calculated</b></span>
        </div>
      </div>
      <div id="calcResultPlaceholder"></div>
    `;
  } else {
    div.innerHTML = `
      <div class="p-section-header">
        <div class="p-section-title"><span class="p-section-step">S3</span> Kalkulasi Billing</div>
      </div>
      <div style="color:var(--ink-faint);font-size:13px">Selesaikan step sebelumnya untuk memulai kalkulasi.</div>
    `;
  }

  body.appendChild(div);

  div.querySelector('#recalcRateBtn')?.addEventListener('click', async () => {
    try {
      await post(`/tickets/${ticket.id}/recalculate`, {});
      state.activeTicket = await get('/tickets/' + ticket.id);
      renderTicketPanel(state.activeTicket);
    } catch(e) {
      alert('Gagal menghitung ulang: ' + e.message);
    }
  });

  div.querySelector('#runCalculationBtn')?.addEventListener('click', async () => {
    const jisdorDate = document.getElementById('jisdorDateSelect')?.value;
    const manualJisdorRate = document.getElementById('manualJisdorRate')?.value;
    const oneTimeFee = document.getElementById('manualOneTimeFee')?.value;
    const btn = div.querySelector('#runCalculationBtn');
    btn.disabled = true;
    btn.textContent = 'Menghitung...';
    try {
      const result = await post('/calculate', {
        contractId: ticket.contract_id,
        period: ticket.period,
        ticketId: ticket.id,
        jisdorDate,
        manualJisdorRate,
        oneTimeFee,
      });
      state.calcResult = result;
      state.activeTicket = await get('/tickets/' + ticket.id);
      renderTicketPanel(state.activeTicket);
    } catch(e) {
      btn.disabled = false;
      btn.textContent = '▶ Jalankan Kalkulasi';
      const ph = document.getElementById('calcResultPlaceholder');
      if (ph) ph.innerHTML = `<div class="callout callout-danger mt-12"><div class="callout-icon">✕</div><div class="callout-body"><b>Error:</b> ${esc(e.body?.reason || e.message)}</div></div>`;
    }
  });
}

// ─────────────────────────────────────────
//  STEP 4: VALIDATION
// ─────────────────────────────────────────
async function renderValidationSection(ticket, body, stepIdx) {
  if (stepIdx < 3) return;
  const isDone = stepIdx > 4;
  const isCurrent = stepIdx === 3 || stepIdx === 4;

  const existingCalc = ticket.latestCalc;
  if (!existingCalc) return;

  const div = document.createElement('div');
  div.className = `p-section ${isDone ? 'p-section-done' : ''}`;

  if (stepIdx >= 4 || isDone) {
    let valResult;
    try { valResult = await post('/validate', { calculationId: existingCalc.id }); }
    catch(e) {}

    const isWarning = valResult?.exception?.severity === 'warning';
    const variance = valResult?.validation?.variance;

    div.innerHTML = `
      <div class="p-section-header">
        <div class="p-section-title"><span class="p-section-step">S4</span> Validasi</div>
        ${isDone ? tag('ok','✓ Validated') : ''}
      </div>
      <div class="kv-grid">
        <div class="kv-item"><div class="kv-label">Total Kalkulasi Baru</div><div class="kv-value kv-mono">${fmtUsd(existingCalc.total_usd || existingCalc.total)}</div></div>
        <div class="kv-item"><div class="kv-label">Total IDR (incl. PPN)</div><div class="kv-value kv-mono">${fmtIdr(existingCalc.total_idr)}</div></div>
        ${valResult?.priorTotal != null ? `
        <div class="kv-item"><div class="kv-label">Bill Periode Sebelumnya</div><div class="kv-value kv-mono">${fmtUsd(valResult.priorTotal)}</div></div>
        <div class="kv-item"><div class="kv-label">Variance</div><div class="kv-value" style="color:${isWarning?'var(--danger)':'var(--ok)'}">${variance != null ? (variance>=0?'+':'')+variance.toFixed(1)+'%' : '—'}</div></div>` : ''}
      </div>
      ${isWarning ? `<div class="callout callout-warn"><div class="callout-icon">⚠</div><div class="callout-body"><b>Exception: Variance Tinggi.</b> Menyimpang ${variance!=null?Math.abs(variance).toFixed(1):'?'}% dari bill sebelumnya (threshold 15%). Memerlukan approval manual sebelum invoice dapat dibuat.</div></div>` :
        `<div class="callout callout-ok"><div class="callout-icon">✓</div><div class="callout-body"><b>Straight-through.</b> Tidak ada exception — variance dalam batas normal.</div></div>`}
    `;
  } else {
    // Current step — show validate button
    div.innerHTML = `
      <div class="p-section-header">
        <div class="p-section-title"><span class="p-section-step">S4</span> Validasi</div>
      </div>
      <div class="callout callout-info"><div class="callout-icon">ℹ</div><div class="callout-body">Validasi variance threshold ±15% dibandingkan bill periode sebelumnya.</div></div>
      <div class="action-bar">
        <button class="btn btn-primary" id="runValidateBtn">Jalankan Validasi →</button>
      </div>
      <div id="validateResult"></div>
    `;
  }

  body.appendChild(div);

  div.querySelector('#runValidateBtn')?.addEventListener('click', async () => {
    const btn = div.querySelector('#runValidateBtn');
    btn.disabled = true; btn.textContent = 'Memvalidasi...';
    try {
      const result = await post('/validate', { calculationId: existingCalc.id });
      state.validationResult = result;
      state.activeTicket = await get('/tickets/' + ticket.id);
      renderTicketPanel(state.activeTicket);
    } catch(e) {
      btn.disabled = false; btn.textContent = 'Jalankan Validasi →';
      document.getElementById('validateResult').innerHTML =
        `<div class="callout callout-danger mt-12"><div class="callout-icon">✕</div><div class="callout-body">${esc(e.message)}</div></div>`;
    }
  });
}

// ─────────────────────────────────────────
//  STEP 5: APPROVAL
// ─────────────────────────────────────────
async function renderApprovalSection(ticket, body, stepIdx) {
  if (stepIdx < 4) return;
  const isDone = stepIdx > 5;

  const existingCalc = ticket.latestCalc;
  if (!existingCalc) return;

  let valResult;
  try { valResult = await post('/validate', { calculationId: existingCalc.id }); }
  catch(e) {}

  const isWarning = valResult?.exception?.severity === 'warning';
  const alreadyApproved = existingCalc.status === 'approved' || stepIdx >= 5;

  const div = document.createElement('div');
  div.className = `p-section ${isDone ? 'p-section-done' : ''}`;
  div.innerHTML = `
    <div class="p-section-header">
      <div class="p-section-title"><span class="p-section-step">S5</span> Approval (Maker-Checker)</div>
      ${isDone || alreadyApproved ? tag('ok','✓ Approved') : ''}
    </div>
    ${alreadyApproved && !isWarning ? `<div class="callout callout-ok"><div class="callout-icon">✓</div><div class="callout-body"><b>Auto-approved.</b> Tidak ada exception — kalkulasi langsung disetujui sistem.</div></div>` : ''}
    ${isWarning && !alreadyApproved ? `
      <div class="approval-box">
        <div class="approval-check">
          <input type="checkbox" id="approverChk">
          <label for="approverChk"><b>Saya (Checker) telah meninjau variance dan menyetujui override atas kalkulasi ini.</b></label>
        </div>
        <div class="approver-fields">
          <div class="form-group" style="margin:0">
            <label class="form-label">Nama Approver</label>
            <input type="text" class="form-input" id="approverNameInput" placeholder="e.g. Mas Harry" value="${esc(state.approverName)}">
          </div>
          <div class="form-group" style="margin:0">
            <label class="form-label">Catatan Approval</label>
            <input type="text" class="form-input" id="approverNoteInput" placeholder="Alasan override..." value="${esc(state.approverNote)}">
          </div>
        </div>
      </div>
    ` : ''}
    ${alreadyApproved ? '' : `
      <div class="action-bar">
        <button class="btn btn-success" id="approveBtn" ${isWarning && !state.approverChecked ? 'disabled':''}>
          ✓ Approve Kalkulasi
        </button>
      </div>`}
  `;

  body.appendChild(div);

  div.querySelector('#approverChk')?.addEventListener('change', e => {
    state.approverChecked = e.target.checked;
    div.querySelector('#approveBtn').disabled = !e.target.checked;
  });
  div.querySelector('#approverNameInput')?.addEventListener('input', e => { state.approverName = e.target.value; });
  div.querySelector('#approverNoteInput')?.addEventListener('input', e => { state.approverNote = e.target.value; });

  div.querySelector('#approveBtn')?.addEventListener('click', async () => {
    const btn = div.querySelector('#approveBtn');
    btn.disabled = true; btn.textContent = 'Menyimpan...';
    try {
      await post('/approve', {
        calculationId: existingCalc.id,
        approver: state.approverName || 'Checker',
        approverNote: state.approverNote || null,
      });
      state.activeTicket = await get('/tickets/' + ticket.id);
      renderTicketPanel(state.activeTicket);
    } catch(e) {
      btn.disabled = false; btn.textContent = '✓ Approve Kalkulasi';
      alert('Gagal approve: ' + e.message);
    }
  });
}

// ─────────────────────────────────────────
//  STEP 6: INVOICE eDoc
// ─────────────────────────────────────────
async function renderInvoiceSection(ticket, body, stepIdx) {
  if (stepIdx < 5) return;

  const existingCalc = ticket.latestCalc;
  if (!existingCalc || existingCalc.status !== 'approved') return;

  const div = document.createElement('div');
  div.className = `p-section ${stepIdx >= 6 ? 'p-section-done' : ''}`;

  if (ticket.invoice) {
    // Invoice already exists — display eDoc & Retroactive Adjustment option
    const inv = ticket.invoice;
    let priceOpts = '';
    try {
      let md = state.masterdata;
      if (!md) { md = await get('/masterdata'); state.masterdata = md; }
      priceOpts = md.priceVersions.map(pv => `<option value="${pv.id}">${pv.id} (Eligible: USD ${pv.rate_eligible}/MMBTU)</option>`).join('');
    } catch(e) {}

    div.innerHTML = `
      <div class="p-section-header">
        <div class="p-section-title"><span class="p-section-step p-section-done">S6</span> Invoice eDoc</div>
        ${tag('ok','✓ INVOICED')}
      </div>
      ${renderInvoiceDoc(ticket, existingCalc, inv)}
      
      <!-- Kepatuhan Aturan 3: Retroactive Adjustment Card -->
      <div class="card mt-16" style="border-top: 3px solid var(--accent); padding: 18px 20px;">
        <h3 style="font-size:13.5px;font-weight:700;margin:0 0 4px;color:var(--brand-dark)">Retroactive Adjustment (Penyesuaian Tarif Mundur)</h3>
        <p style="font-size:12px;color:var(--ink-soft);margin:0 0 12px;line-height:1.5">
          Tiket ini sudah <b>INVOICED</b> dan terkunci secara permanen. Jika ada perubahan harga regulasi pemerintah secara retroactive, terbitkan <b>Tiket Penyesuaian Baru (Credit/Debit Note)</b> di bawah ini.
        </p>
        <div class="form-group">
          <label class="form-label">Pilih Price Version Baru</label>
          <select class="form-select" id="retroPriceVersionSelect">
            ${priceOpts}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Alasan Penyesuaian / Catatan</label>
          <input type="text" class="form-input" id="retroReasonInput" placeholder="e.g. Penyesuaian tarif Kepmen ESDM 281/2026" value="Koreksi regulasi Kepmen ESDM">
        </div>
        <button class="btn btn-warning btn-sm" id="processRetroAdjustBtn">▶ Proses Penyesuaian (Credit/Debit Note)</button>
      </div>
    `;
  } else {
    // Show invoice generation UI
    let jisdorOpts = '';
    try {
      const jRows = await get('/jisdor');
      jisdorOpts = jRows.map(j => `<option value="${j.rate_date}" ${j.rate_date === existingCalc.jisdor_date ? 'selected':''}>${j.rate_date} — IDR ${fmtInt(j.idr_per_usd)}/USD</option>`).join('');
    } catch(e) {}

    div.innerHTML = `
      <div class="p-section-header">
        <div class="p-section-title"><span class="p-section-step">S6</span> Generate Invoice eDoc</div>
      </div>
      <div class="callout callout-ok"><div class="callout-icon">✓</div><div class="callout-body">Kalkulasi sudah approved. Pilih kurs JISDOR tanggal pembuatan eDoc lalu generate invoice.</div></div>
      <div class="form-group" style="max-width:320px">
        <label class="form-label">Kurs JISDOR tanggal pembuatan eDoc</label>
        <select class="form-select" id="invoiceJisdorSelect">${jisdorOpts}</select>
      </div>
      <div class="action-bar">
        <button class="btn btn-primary" id="generateInvoiceBtn">Generate Invoice eDoc →</button>
      </div>
      <div id="invoiceResult"></div>
    `;
  }

  body.appendChild(div);

  div.querySelector('#processRetroAdjustBtn')?.addEventListener('click', async () => {
    const newPriceVersionId = document.getElementById('retroPriceVersionSelect')?.value;
    const reason = document.getElementById('retroReasonInput')?.value;
    if (!newPriceVersionId) { alert('Pilih price version baru.'); return; }
    const btn = document.getElementById('processRetroAdjustBtn');
    btn.disabled = true; btn.textContent = 'Memproses...';
    try {
      const res = await post(`/tickets/${ticket.id}/adjust`, { newPriceVersionId, reason });
      alert(`Penyesuaian Retroaktif Berhasil!\n\nTiket Baru: ${res.adjustmentTicketId}\nInvoice Baru: ${res.adjustmentInvoiceId}\nTipe: ${res.adjustmentType.toUpperCase()}\nNilai Selisih: USD ${res.deltaUsd.toFixed(2)} (${res.adjustmentType === 'credit' ? 'Credit Note' : 'Debit Note'})\nNilai IDR: IDR ${Math.round(res.deltaIdr).toLocaleString('id-ID')}`);
      closePanel();
      await loadView('tickets');
    } catch(e) {
      btn.disabled = false; btn.textContent = '▶ Proses Penyesuaian (Credit/Debit Note)';
      alert('Gagal memproses: ' + (e.body?.error || e.message));
    }
  });

  div.querySelector('#generateInvoiceBtn')?.addEventListener('click', async () => {
    const jisdorDate = document.getElementById('invoiceJisdorSelect')?.value;
    const btn = div.querySelector('#generateInvoiceBtn');
    btn.disabled = true; btn.textContent = 'Membuat invoice...';
    try {
      const inv = await post('/invoice', { calculationId: existingCalc.id, jisdorDate });
      state.activeTicket = await get('/tickets/' + ticket.id);
      renderTicketPanel(state.activeTicket);
    } catch(e) {
      btn.disabled = false; btn.textContent = 'Generate Invoice eDoc →';
      document.getElementById('invoiceResult').innerHTML =
        `<div class="callout callout-danger mt-12"><div class="callout-icon">✕</div><div class="callout-body">${esc(e.body?.error || e.message)}</div></div>`;
    }
  });
}

function renderInvoiceDoc(ticket, calc, inv) {
  const ppnRate = Math.round((inv.ppn_rate || 0.11) * 100);
  const baseUsd = inv.invoice_amount;
  const jisdorRate = inv.jisdor_rate;
  const baseIdr = baseUsd * jisdorRate;
  const ppnIdr = inv.ppn_amount;
  const totalIdr = inv.total_idr;

  return `
    <div class="invoice-doc">
      <div class="invoice-doc-header">
        <div>
          <div class="invoice-doc-logo">PGNCOM</div>
          <div class="invoice-doc-sub">PT Perusahaan Gas Negara Tbk — Commercial Invoice</div>
          <div class="invoice-doc-id">${esc(inv.id)}</div>
        </div>
        <div style="text-align:right">
          <div style="font-size:11px;color:var(--ink-faint)">Status</div>
          <div style="margin-top:4px">${tag('ok','ISSUED')}</div>
          <div style="font-size:11px;color:var(--ink-faint);margin-top:6px">Tanggal Invoice</div>
          <div style="font-size:13px;font-weight:600">${inv.issued_at ? inv.issued_at.slice(0,10) : '—'}</div>
        </div>
      </div>

      <div class="invoice-meta-grid">
        <div>
          <div class="invoice-meta-label">Kepada</div>
          <div class="invoice-meta-value">${esc(ticket.customer?.name || '—')}</div>
          <div style="font-size:12px;color:var(--ink-soft);margin-top:3px">NPWP: ${esc(ticket.customer?.npwp || '—')}</div>
          <div style="font-size:12px;color:var(--ink-soft)">${esc(ticket.customer?.address || '—')}</div>
        </div>
        <div>
          <div class="invoice-meta-label">Dari</div>
          <div class="invoice-meta-value">PT Perusahaan Gas Negara Tbk</div>
          <div style="font-size:12px;color:var(--ink-soft);margin-top:3px">Kontrak: ${esc(ticket.contract?.id || '—')}</div>
          <div style="font-size:12px;color:var(--ink-soft)">Periode: ${esc(inv.period)}</div>
          <div style="font-size:12px;color:var(--ink-soft)">Skema: ${esc(ticket.contract?.payment_scheme || '—')}</div>
        </div>
      </div>

      <table style="margin-bottom:4px">
        <thead>
          <tr><th>Komponen Tagihan</th><th style="text-align:right">Qty (MMBTU)</th><th style="text-align:right">Rate (USD)</th><th style="text-align:right">Amount (USD)</th></tr>
        </thead>
        <tbody>
          <tr>
            <td>Eligible Usage <span class="tag tag-hgbt" style="margin-left:6px">HGBT ≤$6</span></td>
            <td style="text-align:right;font-family:var(--mono)">${fmtInt(calc.eligible_qty)}</td>
            <td style="text-align:right;font-family:var(--mono)">${fmtNum(calc.price_version_id ? '' : '—')}</td>
            <td style="text-align:right;font-family:var(--mono)">${fmtUsd(calc.eligible_qty * 6.00)}</td>
          </tr>
          ${calc.excess_qty ? `<tr>
            <td>Excess Usage</td>
            <td style="text-align:right;font-family:var(--mono)">${fmtInt(calc.excess_qty)}</td>
            <td style="text-align:right;font-family:var(--mono)">—</td>
            <td style="text-align:right;font-family:var(--mono)">${fmtUsd((calc.total_usd||calc.total) - calc.eligible_qty * 6.00 - (calc.fixed_fee||0) - (calc.annual_fee_prorated||0) - (calc.one_time_fee||0))}</td>
          </tr>` : ''}
          ${calc.fixed_fee ? `<tr><td>Fixed Fee</td><td style="text-align:right">—</td><td style="text-align:right">—</td><td style="text-align:right;font-family:var(--mono)">${fmtUsd(calc.fixed_fee)}</td></tr>` : ''}
          ${calc.annual_fee_prorated ? `<tr><td>Annual Maintenance Fee (prorata ÷12)</td><td style="text-align:right">—</td><td style="text-align:right">—</td><td style="text-align:right;font-family:var(--mono)">${fmtUsd(calc.annual_fee_prorated)}</td></tr>` : ''}
          ${calc.one_time_fee ? `<tr><td>One-time Event Fee</td><td style="text-align:right">—</td><td style="text-align:right">—</td><td style="text-align:right;font-family:var(--mono)">${fmtUsd(calc.one_time_fee)}</td></tr>` : ''}
        </tbody>
      </table>

      <div class="invoice-total-box">
        <div class="invoice-total-usd">
          <div class="inv-total-label">Sub-total (USD, belum PPN)</div>
          <div class="inv-total-value">${fmtUsd(baseUsd)}</div>
          <div class="inv-total-sub">Kurs JISDOR: IDR ${fmtInt(jisdorRate)}/USD · ${esc(inv.jisdor_date || '—')}</div>
        </div>
        <div class="invoice-total-idr" style="padding:14px 0 14px 20px">
          <div class="inv-total-label">Total IDR (termasuk PPN ${ppnRate}%)</div>
          <div class="inv-total-value">${fmtIdr(totalIdr)}</div>
          <div class="inv-total-sub">PPN: ${fmtIdr(ppnIdr)} · Base IDR: ${fmtIdr(baseIdr)}</div>
        </div>
      </div>

      <div class="flow-caption" style="margin-top:12px">
        Sumber: Rule ${esc(calc.rule_id)} · Price ${esc(calc.price_version_id)} · Formula ${esc(calc.formula_id)} · Calculation v${calc.version}
        <br>JISDOR ${esc(inv.jisdor_date)} — Bank Indonesia · PPN ${ppnRate}% (berlaku sejak 1 April 2022)
      </div>
    </div>
  `;
}

// ─────────────────────────────────────────
//  REGULATIONS VIEW
// ─────────────────────────────────────────
async function renderRegulations() {
  const regs = await get('/regulations');
  state.regulations = regs;

  const genNumbers = { 'REG-4-2016':'01', 'REG-8-2020':'02', 'REG-15-2022':'03', 'REG-91-2023':'04', 'REG-281-2026':'05' };

  const timelineHtml = regs.map(r => {
    const pvs = r.priceVersions || [];
    const gen = genNumbers[r.id] || '?';
    return `
      <div class="reg-item ${r.status === 'active' ? 'active' : 'revoked'}">
        <div class="reg-dot">${gen}</div>
        <div class="reg-card">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
            <div class="reg-name">${esc(r.name)}</div>
            ${r.status === 'active' ? tag('ok','Aktif') : tag('danger','Dicabut')}
            ${tag('muted', r.type.toUpperCase())}
          </div>
          <div class="reg-meta">
            Berlaku: <b>${esc(r.effective_from)}</b> – <b>${esc(r.effective_to || 'sekarang')}</b>
            ${r.revoked_by ? ` · Dicabut oleh: <b>${esc(r.revoked_by)}</b>` : ''}
            ${r.parent_id ? ` · Turunan dari: <b>${esc(r.parent_id)}</b>` : ''}
          </div>
          ${r.hgbt_cap != null ? `
            <div class="hgbt-cap-banner" style="margin-bottom:8px">
              <span>⬡</span>
              <span class="cap-label">HGBT Cap: USD ${fmtNum(r.hgbt_cap)}/MMBTU</span>
              <span class="cap-ref">Pasal 3 — 7 industri</span>
            </div>` : ''}
          ${r.notes ? `<div style="font-size:12px;color:var(--ink-soft);line-height:1.6;margin-bottom:8px">${esc(r.notes)}</div>` : ''}
          ${pvs.length ? `<div class="reg-prices">${pvs.map(pv => `
            <div style="background:var(--surface-soft);border:1px solid var(--border);border-radius:6px;padding:8px 12px;font-size:12px">
              <div class="td-mono" style="font-size:11px;color:var(--ink-faint);margin-bottom:3px">${esc(pv.id)}</div>
              <div>Eligible: <b style="color:var(--ok)">${fmtNum(pv.rate_eligible)} USD</b> · Excess: <b>${fmtNum(pv.rate_excess)} USD</b></div>
              <div style="color:var(--ink-faint);font-size:11px;margin-top:3px">${esc(pv.effective_from)} – ${esc(pv.effective_to || 'sekarang')}</div>
              ${pv.rate_eligible > 6 ? tag('danger', '⚠ > HGBT Cap') : tag('ok', '≤ HGBT Cap')}
            </div>`).join('')}</div>` : ''}
        </div>
      </div>`;
  }).join('');

  setContent(`
    <div class="callout callout-info" style="margin-bottom:20px">
      <div class="callout-icon">§</div>
      <div class="callout-body">
        <b>Genealogi Regulasi HGBT:</b> Permen ESDM 4/2016 → Permen ESDM 8/2020 → Permen ESDM 15/2022 → Kepmen ESDM 91/2023 → Kepmen ESDM 281/2026.
        Seluruh regulasi menetapkan batas harga gas bumi (HGBT) maks <b>USD 6,00/MMBTU</b> untuk 7 industri tertentu.
      </div>
    </div>
    <div class="regulation-timeline">${timelineHtml}</div>
  `);
}

// ─────────────────────────────────────────
//  MASTER DATA VIEW
// ─────────────────────────────────────────
async function renderMasterData() {
  const md = await get('/masterdata');
  state.masterdata = md;

  const tabs = [
    { key: 'customers',    label: `Customers (${md.customers.length})` },
    { key: 'industries',   label: `7 Industri HGBT (${md.hgbtIndustries.length})` },
    { key: 'contracts',    label: `Kontrak (${md.contracts.length})` },
    { key: 'prices',       label: `Harga (${md.priceVersions.length})` },
    { key: 'formulas',     label: `Formula (${md.formulas.length})` },
    { key: 'rules',        label: `Billing Rules (${md.billingRules.length})` },
    { key: 'regulations',  label: `Regulasi (${md.regulations.length})` },
  ];

  setContent(`
    <div class="tab-bar" id="mdTabBar">
      ${tabs.map(t => `<button class="tab-btn ${t.key === state.mdActiveTab ? 'active' : ''}" data-tab="${t.key}">${t.label}</button>`).join('')}
    </div>
    <div id="mdContent"></div>
  `);

  renderMdTab(md, state.mdActiveTab);

  document.querySelectorAll('#mdTabBar .tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#mdTabBar .tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.mdActiveTab = btn.dataset.tab;
      renderMdTab(md, btn.dataset.tab);
    });
  });

  // Setup CRUD modal
  setupMdCrudModal();
}

// ─────────────────────────────────────────
//  CRUD MODAL HELPERS
// ─────────────────────────────────────────
let _crudSubmitHandler = null;

function setupMdCrudModal() {
  const modal = document.getElementById('mdCrudModal');
  if (!modal) return;
  document.getElementById('closeMdCrudModal')?.addEventListener('click', closeMdCrudModal);
  document.getElementById('cancelMdCrud')?.addEventListener('click', closeMdCrudModal);
  modal.addEventListener('click', e => { if (e.target === modal) closeMdCrudModal(); });
}

function openMdCrudModal(title, bodyHtml, onSubmit) {
  document.getElementById('mdCrudModalTitle').textContent = title;
  document.getElementById('mdCrudModalBody').innerHTML = bodyHtml;
  document.getElementById('mdCrudModal').classList.add('open');

  const submitBtn = document.getElementById('submitMdCrud');
  if (_crudSubmitHandler) submitBtn.removeEventListener('click', _crudSubmitHandler);
  _crudSubmitHandler = onSubmit;
  submitBtn.addEventListener('click', _crudSubmitHandler);
}

function closeMdCrudModal() {
  document.getElementById('mdCrudModal').classList.remove('open');
  if (_crudSubmitHandler) {
    document.getElementById('submitMdCrud')?.removeEventListener('click', _crudSubmitHandler);
    _crudSubmitHandler = null;
  }
}

async function mdCrudRefresh() {
  closeMdCrudModal();
  state.masterdata = null;
  await renderMasterData();
}

// ─────────────────────────────────────────
//  RENDER TAB CONTENT WITH CRUD
// ─────────────────────────────────────────
function renderMdTab(md, tab) {
  const el = document.getElementById('mdContent');
  if (!el) return;

  if (tab === 'customers') {
    el.innerHTML = `<div class="card">
      <div class="md-table-header">
        <span class="md-table-header-title">Daftar Customer</span>
        <button class="btn btn-primary btn-sm" id="addCustomerBtn">+ Tambah Customer</button>
      </div>
      <table>
        <thead><tr><th>ID</th><th>Nama</th><th>Industri HGBT</th><th>Segment</th><th>NPWP</th><th>Aksi</th></tr></thead>
        <tbody>${md.customers.map(c => `<tr>
          <td class="td-mono">${esc(c.id)}</td>
          <td><b>${esc(c.name)}</b></td>
          <td>${c.is_hgbt ? `<span class="tag tag-hgbt">${esc(c.industry_name || c.industry_code)}</span>` : '<span class="tag tag-muted">Non-HGBT</span>'}</td>
          <td>${esc(c.segment||'—')}</td>
          <td class="td-mono td-muted">${esc(c.npwp || '—')}</td>
          <td style="white-space:nowrap">
            <button class="btn-icon btn-icon-edit" data-edit-customer="${esc(c.id)}">✏ Edit</button>
            <button class="btn-icon btn-icon-del" data-del-customer="${esc(c.id)}">🗑 Hapus</button>
          </td>
        </tr>`).join('')}</tbody>
      </table></div>`;

    el.querySelector('#addCustomerBtn')?.addEventListener('click', () => {
      const indOpts = md.hgbtIndustries.map(h => `<option value="${h.code}">${h.name}</option>`).join('');
      openMdCrudModal('Tambah Customer', `
        <div class="btn-form-grid">
          <div class="form-group"><label class="form-label">ID Customer *</label><input class="form-input" id="f_id" placeholder="CUST-011"></div>
          <div class="form-group"><label class="form-label">Nama *</label><input class="form-input" id="f_name" placeholder="PT ..."></div>
          <div class="form-group"><label class="form-label">NPWP</label><input class="form-input" id="f_npwp" placeholder="00.000.000.0-000.000"></div>
          <div class="form-group"><label class="form-label">Segment</label><input class="form-input" id="f_segment" placeholder="Industri Besar"></div>
          <div class="form-group"><label class="form-label">Industri HGBT</label><select class="form-select" id="f_industry_code"><option value="">— Non-HGBT —</option>${indOpts}</select></div>
          <div class="form-group"><label class="form-label">HGBT?</label><select class="form-select" id="f_is_hgbt"><option value="0">Tidak (Non-HGBT)</option><option value="1">Ya (HGBT)</option></select></div>
        </div>`, async () => {
        const body = { id: document.getElementById('f_id').value.trim(), name: document.getElementById('f_name').value.trim(), npwp: document.getElementById('f_npwp').value.trim(), segment: document.getElementById('f_segment').value.trim(), industry_code: document.getElementById('f_industry_code').value || null, is_hgbt: document.getElementById('f_is_hgbt').value === '1' };
        try { await api('/customers', { method:'POST', body: JSON.stringify(body) }); await mdCrudRefresh(); } catch(e) { alert('Error: ' + (e.body?.error || e.message)); }
      });
    });
    el.querySelectorAll('[data-edit-customer]').forEach(btn => {
      btn.addEventListener('click', () => {
        const cid = btn.dataset.editCustomer;
        const c = md.customers.find(x => x.id === cid);
        if (!c) return;
        const indOpts = md.hgbtIndustries.map(h => `<option value="${h.code}" ${c.industry_code===h.code?'selected':''}>${h.name}</option>`).join('');
        openMdCrudModal(`Edit Customer: ${c.id}`, `
          <div class="btn-form-grid">
            <div class="form-group"><label class="form-label">Nama</label><input class="form-input" id="f_name" value="${esc(c.name)}"></div>
            <div class="form-group"><label class="form-label">NPWP</label><input class="form-input" id="f_npwp" value="${esc(c.npwp||'')}"></div>
            <div class="form-group"><label class="form-label">Segment</label><input class="form-input" id="f_segment" value="${esc(c.segment||'')}"></div>
            <div class="form-group"><label class="form-label">Industri HGBT</label><select class="form-select" id="f_industry_code"><option value="">— Non-HGBT —</option>${indOpts}</select></div>
            <div class="form-group"><label class="form-label">HGBT?</label><select class="form-select" id="f_is_hgbt"><option value="0" ${!c.is_hgbt?'selected':''}>Tidak</option><option value="1" ${c.is_hgbt?'selected':''}>Ya</option></select></div>
          </div>`, async () => {
          const body = { name: document.getElementById('f_name').value.trim(), npwp: document.getElementById('f_npwp').value.trim(), segment: document.getElementById('f_segment').value.trim(), industry_code: document.getElementById('f_industry_code').value||null, is_hgbt: document.getElementById('f_is_hgbt').value==='1' };
          try { await api(`/customers/${cid}`, { method:'PATCH', body: JSON.stringify(body) }); await mdCrudRefresh(); } catch(e) { alert('Error: ' + (e.body?.error || e.message)); }
        });
      });
    });
    el.querySelectorAll('[data-del-customer]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm(`Hapus customer ${btn.dataset.delCustomer}?`)) return;
        try { await api(`/customers/${btn.dataset.delCustomer}`, { method:'DELETE', body:'{}' }); await mdCrudRefresh(); } catch(e) { alert('Gagal: ' + (e.body?.error || e.message)); }
      });
    });

  } else if (tab === 'industries') {
    el.innerHTML = `
      <div class="callout callout-info" style="margin-bottom:12px"><div class="callout-icon">§</div><div class="callout-body"><b>Permen ESDM 15/2022, Pasal 3</b> — 7 sektor industri yang berhak mendapatkan Harga Gas Bumi Tertentu (HGBT) dengan batas maksimum USD 6,00/MMBTU.</div></div>
      <div class="card">
        <div class="md-table-header"><span class="md-table-header-title">Industri HGBT</span><button class="btn btn-primary btn-sm" id="addIndustryBtn">+ Tambah Industri</button></div>
        <table>
          <thead><tr><th>Kode</th><th>Nama Industri</th><th>Deskripsi</th><th>Aksi</th></tr></thead>
          <tbody>${md.hgbtIndustries.map(h => `<tr>
            <td><span class="tag tag-hgbt">${esc(h.code)}</span></td>
            <td><b>${esc(h.name)}</b></td>
            <td style="font-size:12px;color:var(--ink-soft)">${esc(h.description||'—')}</td>
            <td style="white-space:nowrap">
              <button class="btn-icon btn-icon-edit" data-edit-ind="${esc(h.code)}">✏ Edit</button>
              <button class="btn-icon btn-icon-del" data-del-ind="${esc(h.code)}">🗑 Hapus</button>
            </td>
          </tr>`).join('')}</tbody>
        </table></div>`;
    el.querySelector('#addIndustryBtn')?.addEventListener('click', () => {
      openMdCrudModal('Tambah Industri HGBT', `
        <div class="form-group"><label class="form-label">Kode *</label><input class="form-input" id="f_code" placeholder="Tekstil"></div>
        <div class="form-group"><label class="form-label">Nama *</label><input class="form-input" id="f_name" placeholder="Tekstil"></div>
        <div class="form-group"><label class="form-label">Deskripsi</label><textarea class="form-input" id="f_desc" rows="2"></textarea></div>`, async () => {
        const body = { code: document.getElementById('f_code').value.trim(), name: document.getElementById('f_name').value.trim(), description: document.getElementById('f_desc').value.trim() };
        try { await api('/industries', { method:'POST', body: JSON.stringify(body) }); await mdCrudRefresh(); } catch(e) { alert('Error: ' + (e.body?.error || e.message)); }
      });
    });
    el.querySelectorAll('[data-edit-ind]').forEach(btn => {
      btn.addEventListener('click', () => {
        const code = btn.dataset.editInd;
        const h = md.hgbtIndustries.find(x => x.code === code);
        if (!h) return;
        openMdCrudModal(`Edit Industri: ${h.code}`, `
          <div class="form-group"><label class="form-label">Nama</label><input class="form-input" id="f_name" value="${esc(h.name)}"></div>
          <div class="form-group"><label class="form-label">Deskripsi</label><textarea class="form-input" id="f_desc" rows="2">${esc(h.description||'')}</textarea></div>`, async () => {
          const body = { name: document.getElementById('f_name').value.trim(), description: document.getElementById('f_desc').value.trim() };
          try { await api(`/industries/${code}`, { method:'PATCH', body: JSON.stringify(body) }); await mdCrudRefresh(); } catch(e) { alert('Error: ' + (e.body?.error || e.message)); }
        });
      });
    });
    el.querySelectorAll('[data-del-ind]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm(`Hapus industri ${btn.dataset.delInd}?`)) return;
        try { await api(`/industries/${btn.dataset.delInd}`, { method:'DELETE', body:'{}' }); await mdCrudRefresh(); } catch(e) { alert('Gagal: ' + (e.body?.error || e.message)); }
      });
    });

  } else if (tab === 'contracts') {
    const color = {postpaid:'info',hybrid:'warn',prepaid:'ok'};
    el.innerHTML = `<div class="card">
      <div class="md-table-header"><span class="md-table-header-title">Daftar Kontrak</span><button class="btn btn-primary btn-sm" id="addContractBtn">+ Tambah Kontrak</button></div>
      <table>
        <thead><tr><th>Kontrak</th><th>Customer</th><th>Skema</th><th>Alokasi</th><th>Fixed Fee</th><th>Annual Fee</th><th>Aksi</th></tr></thead>
        <tbody>${md.contracts.map(c => {
          const cust = md.customers.find(x => x.id === c.customer_id);
          return `<tr>
            <td class="td-mono">${esc(c.id)}</td>
            <td>${esc(cust?.name || c.customer_id)}</td>
            <td><span class="tag tag-${color[c.payment_scheme]||'muted'}" style="text-transform:capitalize">${esc(c.payment_scheme)}</span></td>
            <td class="td-mono">${fmtInt(c.allocation)} ${esc(c.uom)}</td>
            <td class="td-mono">${c.fixed_fee ? fmtUsd(c.fixed_fee) : '—'}</td>
            <td class="td-mono">${c.annual_fee ? fmtUsd(c.annual_fee) : '—'}</td>
            <td style="white-space:nowrap">
              <button class="btn-icon btn-icon-edit" data-edit-ctr="${esc(c.id)}">✏ Edit</button>
              <button class="btn-icon btn-icon-del" data-del-ctr="${esc(c.id)}">🗑 Hapus</button>
            </td>
          </tr>`;}).join('')}
        </tbody></table></div>`;
    el.querySelector('#addContractBtn')?.addEventListener('click', () => {
      const custOpts = md.customers.map(c => `<option value="${c.id}">${c.name}</option>`).join('');
      openMdCrudModal('Tambah Kontrak', `
        <div class="btn-form-grid">
          <div class="form-group"><label class="form-label">ID Kontrak *</label><input class="form-input" id="f_id" placeholder="CTR-011"></div>
          <div class="form-group"><label class="form-label">Customer *</label><select class="form-select" id="f_cust"><option value="">— Pilih —</option>${custOpts}</select></div>
          <div class="form-group"><label class="form-label">Skema Bayar *</label><select class="form-select" id="f_scheme"><option value="postpaid">Postpaid</option><option value="hybrid">Hybrid</option><option value="prepaid">Prepaid</option></select></div>
          <div class="form-group"><label class="form-label">Alokasi (MMBTU) *</label><input type="number" class="form-input" id="f_alloc" placeholder="6500"></div>
          <div class="form-group"><label class="form-label">Fixed Fee (USD)</label><input type="number" class="form-input" id="f_fixed" placeholder="0"></div>
          <div class="form-group"><label class="form-label">Annual Fee (USD)</label><input type="number" class="form-input" id="f_annual" placeholder="0"></div>
          <div class="form-group"><label class="form-label">Opening Balance (USD)</label><input type="number" class="form-input" id="f_ob" placeholder="0"></div>
          <div class="form-group"><label class="form-label">Min Qty (MMBTU)</label><input type="number" class="form-input" id="f_minqty" placeholder="0"></div>
        </div>`, async () => {
        const body = { id: document.getElementById('f_id').value.trim(), customer_id: document.getElementById('f_cust').value, payment_scheme: document.getElementById('f_scheme').value, allocation: Number(document.getElementById('f_alloc').value), fixed_fee: Number(document.getElementById('f_fixed').value)||0, annual_fee: Number(document.getElementById('f_annual').value)||0, opening_balance: Number(document.getElementById('f_ob').value)||0, min_qty: Number(document.getElementById('f_minqty').value)||0 };
        try { await api('/contracts', { method:'POST', body: JSON.stringify(body) }); await mdCrudRefresh(); } catch(e) { alert('Error: ' + (e.body?.error || e.message)); }
      });
    });
    el.querySelectorAll('[data-edit-ctr]').forEach(btn => {
      btn.addEventListener('click', () => {
        const cid = btn.dataset.editCtr;
        const c = md.contracts.find(x => x.id === cid);
        if (!c) return;
        openMdCrudModal(`Edit Kontrak: ${c.id}`, `
          <div class="btn-form-grid">
            <div class="form-group"><label class="form-label">Skema Bayar</label><select class="form-select" id="f_scheme"><option value="postpaid" ${c.payment_scheme==='postpaid'?'selected':''}>Postpaid</option><option value="hybrid" ${c.payment_scheme==='hybrid'?'selected':''}>Hybrid</option><option value="prepaid" ${c.payment_scheme==='prepaid'?'selected':''}>Prepaid</option></select></div>
            <div class="form-group"><label class="form-label">Alokasi (MMBTU)</label><input type="number" class="form-input" id="f_alloc" value="${c.allocation}"></div>
            <div class="form-group"><label class="form-label">Fixed Fee (USD)</label><input type="number" class="form-input" id="f_fixed" value="${c.fixed_fee||0}"></div>
            <div class="form-group"><label class="form-label">Annual Fee (USD)</label><input type="number" class="form-input" id="f_annual" value="${c.annual_fee||0}"></div>
            <div class="form-group"><label class="form-label">Opening Balance (USD)</label><input type="number" class="form-input" id="f_ob" value="${c.opening_balance||0}"></div>
            <div class="form-group"><label class="form-label">Min Qty (MMBTU)</label><input type="number" class="form-input" id="f_minqty" value="${c.min_qty||0}"></div>
          </div>`, async () => {
          const body = { payment_scheme: document.getElementById('f_scheme').value, allocation: Number(document.getElementById('f_alloc').value), fixed_fee: Number(document.getElementById('f_fixed').value)||0, annual_fee: Number(document.getElementById('f_annual').value)||0, opening_balance: Number(document.getElementById('f_ob').value)||0, min_qty: Number(document.getElementById('f_minqty').value)||0 };
          try { await api(`/contracts/${cid}`, { method:'PATCH', body: JSON.stringify(body) }); await mdCrudRefresh(); } catch(e) { alert('Error: ' + (e.body?.error || e.message)); }
        });
      });
    });
    el.querySelectorAll('[data-del-ctr]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm(`Hapus kontrak ${btn.dataset.delCtr}?`)) return;
        try { await api(`/contracts/${btn.dataset.delCtr}`, { method:'DELETE', body:'{}' }); await mdCrudRefresh(); } catch(e) { alert('Gagal: ' + (e.body?.error || e.message)); }
      });
    });

  } else if (tab === 'prices') {
    el.innerHTML = `<div class="card">
      <div class="md-table-header"><span class="md-table-header-title">Price Versions</span><button class="btn btn-primary btn-sm" id="addPriceBtn">+ Tambah Harga</button></div>
      <table>
        <thead><tr><th>ID</th><th>Label</th><th>Regulasi</th><th>Rate Eligible</th><th>Rate Excess</th><th>Berlaku</th><th>HGBT</th><th>Aksi</th></tr></thead>
        <tbody>${md.priceVersions.map(p => `<tr>
          <td class="td-mono">${esc(p.id)}</td>
          <td>${esc(p.label || '—')}</td>
          <td class="td-mono td-muted">${esc(p.regulation_id)}</td>
          <td class="td-mono"><b style="color:${p.rate_eligible > 6 ? 'var(--danger)' : 'var(--ok)'}">${fmtNum(p.rate_eligible)} USD</b></td>
          <td class="td-mono">${fmtNum(p.rate_excess)} USD</td>
          <td class="td-mono td-muted" style="font-size:11px">${esc(p.effective_from)} – ${esc(p.effective_to || 'sekarang')}</td>
          <td>${p.rate_eligible <= 6 ? tag('ok','≤ $6 ✓') : tag('danger','> $6 !')}</td>
          <td style="white-space:nowrap">
            <button class="btn-icon btn-icon-edit" data-edit-pv="${esc(p.id)}">✏ Edit</button>
            <button class="btn-icon btn-icon-del" data-del-pv="${esc(p.id)}">🗑 Hapus</button>
          </td>
        </tr>`).join('')}</tbody>
      </table></div>`;
    el.querySelector('#addPriceBtn')?.addEventListener('click', () => {
      const regOpts = md.regulations.map(r => `<option value="${r.id}">${r.name}</option>`).join('');
      openMdCrudModal('Tambah Price Version', `
        <div class="btn-form-grid">
          <div class="form-group"><label class="form-label">ID *</label><input class="form-input" id="f_id" placeholder="PV-HGBT-2026-NEW"></div>
          <div class="form-group"><label class="form-label">Label</label><input class="form-input" id="f_label" placeholder="Tarif HGBT 2026"></div>
          <div class="form-group"><label class="form-label">Regulasi *</label><select class="form-select" id="f_reg"><option value="">— Pilih —</option>${regOpts}</select></div>
          <div class="form-group"><label class="form-label">Rate Eligible (USD/MMBTU) *</label><input type="number" class="form-input" id="f_elig" step="0.01" placeholder="5.80"></div>
          <div class="form-group"><label class="form-label">Rate Excess (USD/MMBTU) *</label><input type="number" class="form-input" id="f_exc" step="0.01" placeholder="8.00"></div>
          <div class="form-group"><label class="form-label">Berlaku Dari *</label><input type="date" class="form-input" id="f_from"></div>
          <div class="form-group"><label class="form-label">Berlaku Sampai</label><input type="date" class="form-input" id="f_to" placeholder="kosong = masih berlaku"></div>
          <div class="form-group"><label class="form-label">Approval</label><input class="form-input" id="f_approval" placeholder="Kemen ESDM..."></div>
        </div>`, async () => {
        const body = { id: document.getElementById('f_id').value.trim(), label: document.getElementById('f_label').value.trim(), regulation_id: document.getElementById('f_reg').value, rate_eligible: Number(document.getElementById('f_elig').value), rate_excess: Number(document.getElementById('f_exc').value), valid_from: document.getElementById('f_from').value, valid_to: document.getElementById('f_to').value||null, approval: document.getElementById('f_approval').value.trim()||null };
        try { await api('/prices', { method:'POST', body: JSON.stringify(body) }); await mdCrudRefresh(); } catch(e) { alert('Error: ' + (e.body?.error || e.message)); }
      });
    });
    el.querySelectorAll('[data-edit-pv]').forEach(btn => {
      btn.addEventListener('click', () => {
        const pid = btn.dataset.editPv;
        const p = md.priceVersions.find(x => x.id === pid);
        if (!p) return;
        openMdCrudModal(`Edit Price: ${p.id}`, `
          <div class="btn-form-grid">
            <div class="form-group"><label class="form-label">Label</label><input class="form-input" id="f_label" value="${esc(p.label||'')}"></div>
            <div class="form-group"><label class="form-label">Rate Eligible (USD/MMBTU)</label><input type="number" class="form-input" id="f_elig" step="0.01" value="${p.rate_eligible}"></div>
            <div class="form-group"><label class="form-label">Rate Excess (USD/MMBTU)</label><input type="number" class="form-input" id="f_exc" step="0.01" value="${p.rate_excess}"></div>
            <div class="form-group"><label class="form-label">Berlaku Dari</label><input type="date" class="form-input" id="f_from" value="${p.valid_from}"></div>
            <div class="form-group"><label class="form-label">Berlaku Sampai</label><input type="date" class="form-input" id="f_to" value="${p.valid_to||''}"></div>
            <div class="form-group"><label class="form-label">Approval</label><input class="form-input" id="f_approval" value="${esc(p.approval||'')}"></div>
          </div>`, async () => {
          const body = { label: document.getElementById('f_label').value.trim(), rate_eligible: Number(document.getElementById('f_elig').value), rate_excess: Number(document.getElementById('f_exc').value), valid_from: document.getElementById('f_from').value, valid_to: document.getElementById('f_to').value||null, approval: document.getElementById('f_approval').value.trim()||null };
          try { await api(`/prices/${pid}`, { method:'PATCH', body: JSON.stringify(body) }); await mdCrudRefresh(); } catch(e) { alert('Error: ' + (e.body?.error || e.message)); }
        });
      });
    });
    el.querySelectorAll('[data-del-pv]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm(`Hapus price version ${btn.dataset.delPv}?`)) return;
        try { await api(`/prices/${btn.dataset.delPv}`, { method:'DELETE', body:'{}' }); await mdCrudRefresh(); } catch(e) { alert('Gagal: ' + (e.body?.error || e.message)); }
      });
    });

  } else if (tab === 'formulas') {
    el.innerHTML = `<div class="card">
      <div class="md-table-header"><span class="md-table-header-title">Formula Kalkulasi</span><button class="btn btn-primary btn-sm" id="addFormulaBtn">+ Tambah Formula</button></div>
      <table>
        <thead><tr><th>ID</th><th>Nama</th><th>Ekspresi</th><th>Deskripsi</th><th>Aksi</th></tr></thead>
        <tbody>${md.formulas.map(f => `<tr>
          <td class="td-mono">${esc(f.id)}</td>
          <td><b>${esc(f.name)}</b></td>
          <td><code style="font-family:var(--mono);font-size:11.5px;background:var(--surface-soft);padding:2px 6px;border-radius:4px">${esc(f.expr)}</code></td>
          <td style="font-size:12px;color:var(--ink-soft)">${esc(f.description || '—')}</td>
          <td style="white-space:nowrap">
            <button class="btn-icon btn-icon-edit" data-edit-f="${esc(f.id)}">✏ Edit</button>
            <button class="btn-icon btn-icon-del" data-del-f="${esc(f.id)}">🗑 Hapus</button>
          </td>
        </tr>`).join('')}</tbody>
      </table></div>`;
    el.querySelector('#addFormulaBtn')?.addEventListener('click', () => {
      openMdCrudModal('Tambah Formula', `
        <div class="form-group"><label class="form-label">ID *</label><input class="form-input" id="f_id" placeholder="FORM-005"></div>
        <div class="form-group"><label class="form-label">Nama *</label><input class="form-input" id="f_name" placeholder="Postpaid Standard"></div>
        <div class="form-group"><label class="form-label">Ekspresi *</label><input class="form-input" id="f_expr" placeholder="eligible * rate_eligible + excess * rate_excess"></div>
        <div class="form-group"><label class="form-label">Deskripsi</label><textarea class="form-input" id="f_desc" rows="2"></textarea></div>`, async () => {
        const body = { id: document.getElementById('f_id').value.trim(), name: document.getElementById('f_name').value.trim(), expr: document.getElementById('f_expr').value.trim(), description: document.getElementById('f_desc').value.trim() };
        try { await api('/formulas', { method:'POST', body: JSON.stringify(body) }); await mdCrudRefresh(); } catch(e) { alert('Error: ' + (e.body?.error || e.message)); }
      });
    });
    el.querySelectorAll('[data-edit-f]').forEach(btn => {
      btn.addEventListener('click', () => {
        const fid = btn.dataset.editF;
        const f = md.formulas.find(x => x.id === fid);
        if (!f) return;
        openMdCrudModal(`Edit Formula: ${f.id}`, `
          <div class="form-group"><label class="form-label">Nama</label><input class="form-input" id="f_name" value="${esc(f.name)}"></div>
          <div class="form-group"><label class="form-label">Ekspresi</label><input class="form-input" id="f_expr" value="${esc(f.expr)}"></div>
          <div class="form-group"><label class="form-label">Deskripsi</label><textarea class="form-input" id="f_desc" rows="2">${esc(f.description||'')}</textarea></div>`, async () => {
          const body = { name: document.getElementById('f_name').value.trim(), expr: document.getElementById('f_expr').value.trim(), description: document.getElementById('f_desc').value.trim() };
          try { await api(`/formulas/${fid}`, { method:'PATCH', body: JSON.stringify(body) }); await mdCrudRefresh(); } catch(e) { alert('Error: ' + (e.body?.error || e.message)); }
        });
      });
    });
    el.querySelectorAll('[data-del-f]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm(`Hapus formula ${btn.dataset.delF}?`)) return;
        try { await api(`/formulas/${btn.dataset.delF}`, { method:'DELETE', body:'{}' }); await mdCrudRefresh(); } catch(e) { alert('Gagal: ' + (e.body?.error || e.message)); }
      });
    });

  } else if (tab === 'rules') {
    el.innerHTML = `<div class="card">
      <div class="md-table-header"><span class="md-table-header-title">Billing Rules</span><button class="btn btn-primary btn-sm" id="addRuleBtn">+ Tambah Rule</button></div>
      <table>
        <thead><tr><th>Rule ID</th><th>Kontrak</th><th>Priority</th><th>Formula</th><th>Price Version</th><th>Berlaku</th><th>Aksi</th></tr></thead>
        <tbody>${md.billingRules.map(r => `<tr>
          <td class="td-mono">${esc(r.id)}</td>
          <td class="td-mono">${esc(r.contract_id)}</td>
          <td style="text-align:center"><b>${r.priority}</b></td>
          <td class="td-mono td-muted">${esc(r.formula_id)}</td>
          <td class="td-mono">${esc(r.price_version_id)}</td>
          <td class="td-mono td-muted" style="font-size:11px">${esc(r.effective_from)} – ${esc(r.effective_to || 'sekarang')}</td>
          <td style="white-space:nowrap">
            <button class="btn-icon btn-icon-edit" data-edit-r="${esc(r.id)}">✏ Edit</button>
            <button class="btn-icon btn-icon-del" data-del-r="${esc(r.id)}">🗑 Hapus</button>
          </td>
        </tr>`).join('')}</tbody>
      </table></div>`;
    el.querySelector('#addRuleBtn')?.addEventListener('click', () => {
      const ctrOpts = md.contracts.map(c => `<option value="${c.id}">${c.id}</option>`).join('');
      const fOpts = md.formulas.map(f => `<option value="${f.id}">${f.id} – ${f.name}</option>`).join('');
      const pvOpts = md.priceVersions.map(p => `<option value="${p.id}">${p.id}</option>`).join('');
      openMdCrudModal('Tambah Billing Rule', `
        <div class="btn-form-grid">
          <div class="form-group"><label class="form-label">ID Rule *</label><input class="form-input" id="f_id" placeholder="BR-701"></div>
          <div class="form-group"><label class="form-label">Priority *</label><input type="number" class="form-input" id="f_prio" value="1"></div>
          <div class="form-group"><label class="form-label">Kontrak *</label><select class="form-select" id="f_ctr"><option value="">— Pilih —</option>${ctrOpts}</select></div>
          <div class="form-group"><label class="form-label">Formula *</label><select class="form-select" id="f_formula"><option value="">— Pilih —</option>${fOpts}</select></div>
          <div class="form-group"><label class="form-label">Price Version *</label><select class="form-select" id="f_pv"><option value="">— Pilih —</option>${pvOpts}</select></div>
          <div class="form-group"><label class="form-label">Berlaku Dari *</label><input type="date" class="form-input" id="f_from"></div>
          <div class="form-group"><label class="form-label">Berlaku Sampai</label><input type="date" class="form-input" id="f_to"></div>
        </div>`, async () => {
        const body = { id: document.getElementById('f_id').value.trim(), contract_id: document.getElementById('f_ctr').value, priority: Number(document.getElementById('f_prio').value), formula_id: document.getElementById('f_formula').value, price_version_id: document.getElementById('f_pv').value, effective_from: document.getElementById('f_from').value, effective_to: document.getElementById('f_to').value||null };
        try { await api('/billing-rules', { method:'POST', body: JSON.stringify(body) }); await mdCrudRefresh(); } catch(e) { alert('Error: ' + (e.body?.error || e.message)); }
      });
    });
    el.querySelectorAll('[data-edit-r]').forEach(btn => {
      btn.addEventListener('click', () => {
        const rid = btn.dataset.editR;
        const r = md.billingRules.find(x => x.id === rid);
        if (!r) return;
        const pvOpts = md.priceVersions.map(p => `<option value="${p.id}" ${r.price_version_id===p.id?'selected':''}>${p.id}</option>`).join('');
        const fOpts = md.formulas.map(f => `<option value="${f.id}" ${r.formula_id===f.id?'selected':''}>${f.id} – ${f.name}</option>`).join('');
        openMdCrudModal(`Edit Rule: ${r.id}`, `
          <div class="btn-form-grid">
            <div class="form-group"><label class="form-label">Priority</label><input type="number" class="form-input" id="f_prio" value="${r.priority}"></div>
            <div class="form-group"><label class="form-label">Formula</label><select class="form-select" id="f_formula">${fOpts}</select></div>
            <div class="form-group"><label class="form-label">Price Version</label><select class="form-select" id="f_pv">${pvOpts}</select></div>
            <div class="form-group"><label class="form-label">Berlaku Dari</label><input type="date" class="form-input" id="f_from" value="${r.effective_from}"></div>
            <div class="form-group"><label class="form-label">Berlaku Sampai</label><input type="date" class="form-input" id="f_to" value="${r.effective_to||''}"></div>
          </div>`, async () => {
          const body = { priority: Number(document.getElementById('f_prio').value), formula_id: document.getElementById('f_formula').value, price_version_id: document.getElementById('f_pv').value, effective_from: document.getElementById('f_from').value, effective_to: document.getElementById('f_to').value||null };
          try { await api(`/billing-rules/${rid}`, { method:'PATCH', body: JSON.stringify(body) }); await mdCrudRefresh(); } catch(e) { alert('Error: ' + (e.body?.error || e.message)); }
        });
      });
    });
    el.querySelectorAll('[data-del-r]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm(`Hapus billing rule ${btn.dataset.delR}?`)) return;
        try { await api(`/billing-rules/${btn.dataset.delR}`, { method:'DELETE', body:'{}' }); await mdCrudRefresh(); } catch(e) { alert('Gagal: ' + (e.body?.error || e.message)); }
      });
    });

  } else if (tab === 'regulations') {
    el.innerHTML = `<div class="card">
      <div class="md-table-header">
        <span class="md-table-header-title">Regulasi / Permen & Kepmen ESDM</span>
        <button class="btn btn-primary btn-sm" id="addRegBtn">+ Tambah Regulasi</button>
      </div>
      <table>
        <thead><tr><th>ID</th><th>Nama</th><th>Tipe</th><th>Status</th><th>Berlaku</th><th>HGBT Cap</th><th>Aksi</th></tr></thead>
        <tbody>${md.regulations.map(r => `<tr>
          <td class="td-mono">${esc(r.id)}</td>
          <td><b>${esc(r.name)}</b>${r.notes ? `<div style="font-size:11px;color:var(--ink-faint);margin-top:2px">${esc(r.notes)}</div>` : ''}</td>
          <td>${tag('muted', (r.type||'').toUpperCase())}</td>
          <td>${r.status === 'active' ? tag('ok','Aktif') : tag('danger','Dicabut')}</td>
          <td class="td-mono td-muted" style="font-size:11px">${esc(r.effective_from)} – ${esc(r.effective_to || 'sekarang')}</td>
          <td class="td-mono">${r.hgbt_cap != null ? `<b>USD ${fmtNum(r.hgbt_cap)}</b>` : '—'}</td>
          <td style="white-space:nowrap">
            <button class="btn-icon btn-icon-edit" data-edit-reg="${esc(r.id)}">✏ Edit</button>
            <button class="btn-icon btn-icon-del" data-del-reg="${esc(r.id)}">🗑 Hapus</button>
          </td>
        </tr>`).join('')}</tbody>
      </table></div>`;

    el.querySelector('#addRegBtn')?.addEventListener('click', () => {
      openMdCrudModal('Tambah Regulasi', `
        <div class="btn-form-grid">
          <div class="form-group"><label class="form-label">ID Regulasi *</label><input class="form-input" id="f_id" placeholder="REG-999-2026"></div>
          <div class="form-group"><label class="form-label">Tipe *</label><select class="form-select" id="f_type"><option value="permen">Permen</option><option value="kepmen">Kepmen</option></select></div>
          <div class="form-group"><label class="form-label">Nomor</label><input class="form-input" id="f_num" placeholder="No. 15/2022"></div>
          <div class="form-group"><label class="form-label">Nama *</label><input class="form-input" id="f_name" placeholder="Permen ESDM 15/2022"></div>
          <div class="form-group"><label class="form-label">Status *</label><select class="form-select" id="f_status"><option value="active">Aktif</option><option value="revoked">Dicabut</option></select></div>
          <div class="form-group"><label class="form-label">HGBT Cap (USD/MMBTU)</label><input type="number" class="form-input" id="f_cap" step="0.01" placeholder="6.00"></div>
          <div class="form-group"><label class="form-label">Berlaku Dari *</label><input type="date" class="form-input" id="f_from"></div>
          <div class="form-group"><label class="form-label">Berlaku Sampai</label><input type="date" class="form-input" id="f_to"></div>
          <div class="form-group"><label class="form-label">Dicabut Oleh (ID)</label><input class="form-input" id="f_revby" placeholder="REG-..."></div>
          <div class="form-group"><label class="form-label">Turunan dari (ID)</label><input class="form-input" id="f_parent" placeholder="REG-..."></div>
        </div>
        <div class="form-group"><label class="form-label">Catatan</label><textarea class="form-input" id="f_notes" rows="2"></textarea></div>`,
        async () => {
          const body = { id: document.getElementById('f_id').value.trim(), type: document.getElementById('f_type').value, number: document.getElementById('f_num').value.trim()||null, name: document.getElementById('f_name').value.trim(), status: document.getElementById('f_status').value, hgbt_cap: document.getElementById('f_cap').value ? Number(document.getElementById('f_cap').value) : null, effective_from: document.getElementById('f_from').value, effective_to: document.getElementById('f_to').value||null, revoked_by: document.getElementById('f_revby').value.trim()||null, parent_id: document.getElementById('f_parent').value.trim()||null, notes: document.getElementById('f_notes').value.trim()||null };
          try { await api('/regulations', { method:'POST', body: JSON.stringify(body) }); await mdCrudRefresh(); } catch(e) { alert('Error: ' + (e.body?.error || e.message)); }
        });
    });

    el.querySelectorAll('[data-edit-reg]').forEach(btn => {
      btn.addEventListener('click', () => {
        const rid = btn.dataset.editReg;
        const r = md.regulations.find(x => x.id === rid);
        if (!r) return;
        openMdCrudModal(`Edit Regulasi: ${r.id}`, `
          <div class="btn-form-grid">
            <div class="form-group"><label class="form-label">Tipe</label><select class="form-select" id="f_type"><option value="permen" ${r.type==='permen'?'selected':''}>Permen</option><option value="kepmen" ${r.type==='kepmen'?'selected':''}>Kepmen</option></select></div>
            <div class="form-group"><label class="form-label">Nomor</label><input class="form-input" id="f_num" value="${esc(r.number||'')}"></div>
            <div class="form-group"><label class="form-label">Nama</label><input class="form-input" id="f_name" value="${esc(r.name)}"></div>
            <div class="form-group"><label class="form-label">Status</label><select class="form-select" id="f_status"><option value="active" ${r.status==='active'?'selected':''}>Aktif</option><option value="revoked" ${r.status==='revoked'?'selected':''}>Dicabut</option></select></div>
            <div class="form-group"><label class="form-label">HGBT Cap (USD/MMBTU)</label><input type="number" class="form-input" id="f_cap" step="0.01" value="${r.hgbt_cap??''}"></div>
            <div class="form-group"><label class="form-label">Berlaku Dari</label><input type="date" class="form-input" id="f_from" value="${r.effective_from}"></div>
            <div class="form-group"><label class="form-label">Berlaku Sampai</label><input type="date" class="form-input" id="f_to" value="${r.effective_to||''}"></div>
            <div class="form-group"><label class="form-label">Dicabut Oleh (ID)</label><input class="form-input" id="f_revby" value="${esc(r.revoked_by||'')}"></div>
            <div class="form-group"><label class="form-label">Turunan dari (ID)</label><input class="form-input" id="f_parent" value="${esc(r.parent_id||'')}"></div>
          </div>
          <div class="form-group"><label class="form-label">Catatan</label><textarea class="form-input" id="f_notes" rows="2">${esc(r.notes||'')}</textarea></div>`,
          async () => {
            const body = { type: document.getElementById('f_type').value, number: document.getElementById('f_num').value.trim()||null, name: document.getElementById('f_name').value.trim(), status: document.getElementById('f_status').value, hgbt_cap: document.getElementById('f_cap').value ? Number(document.getElementById('f_cap').value) : null, effective_from: document.getElementById('f_from').value, effective_to: document.getElementById('f_to').value||null, revoked_by: document.getElementById('f_revby').value.trim()||null, parent_id: document.getElementById('f_parent').value.trim()||null, notes: document.getElementById('f_notes').value.trim()||null };
            try { await api(`/regulations/${rid}`, { method:'PATCH', body: JSON.stringify(body) }); await mdCrudRefresh(); } catch(e) { alert('Error: ' + (e.body?.error || e.message)); }
          });
      });
    });
    el.querySelectorAll('[data-del-reg]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm(`Hapus regulasi ${btn.dataset.delReg}?`)) return;
        try { await api(`/regulations/${btn.dataset.delReg}`, { method:'DELETE', body:'{}' }); await mdCrudRefresh(); } catch(e) { alert('Gagal: ' + (e.body?.error || e.message)); }
      });
    });
  }
}


// ─────────────────────────────────────────
//  JISDOR VIEW
// ─────────────────────────────────────────
async function renderJisdor() {
  const rows = await get('/jisdor');
  state.jisdor = rows;

  const tableRows = rows.map((j, i) => `
    <tr class="${i === 0 ? 'jisdor-highlight' : ''}">
      <td class="td-mono">${esc(j.rate_date)}</td>
      <td class="td-mono" style="text-align:right;font-weight:${i===0?700:400}">IDR ${fmtInt(j.idr_per_usd)}</td>
      <td style="font-size:12px;color:var(--ink-faint)">${esc(j.source)}</td>
    </tr>`).join('');

  setContent(`
    <div class="callout callout-info" style="margin-bottom:16px">
      <div class="callout-icon">↕</div>
      <div class="callout-body">
        <b>JISDOR (Jakarta Interbank Spot Dollar Rate)</b> adalah kurs referensi USD/IDR yang diterbitkan Bank Indonesia setiap hari kerja.
        Nilai ini digunakan sebagai dasar konversi invoice dari USD ke IDR pada tanggal pembuatan eDoc. PPN 11% dihitung di atas nilai IDR.
      </div>
    </div>
    <div class="card">
      <div class="card-header">
        <div class="card-title">Riwayat Kurs JISDOR</div>
        <div style="font-size:12px;color:var(--ink-faint)">Baris kuning = rate terbaru (digunakan default)</div>
      </div>
      <table>
        <thead><tr><th>Tanggal</th><th style="text-align:right">IDR / USD</th><th>Sumber</th></tr></thead>
        <tbody>${tableRows}</tbody>
      </table>
    </div>
    <div class="card" style="margin-top:16px">
      <div class="card-header"><div class="card-title">Simulasi Konversi IDR</div></div>
      <div style="padding:16px 20px">
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:12px">
          <div class="form-group" style="margin:0">
            <label class="form-label">Amount (USD)</label>
            <input type="number" class="form-input" id="simUsd" value="56000" step="100">
          </div>
          <div class="form-group" style="margin:0">
            <label class="form-label">Kurs JISDOR (IDR/USD)</label>
            <input type="number" class="form-input" id="simRate" value="${rows[0]?.idr_per_usd || 16250}">
          </div>
          <div class="form-group" style="margin:0">
            <label class="form-label">PPN (%)</label>
            <input type="number" class="form-input" id="simPpn" value="11">
          </div>
        </div>
        <button class="btn btn-primary btn-sm" id="simConvertBtn">Hitung</button>
        <div id="simResult" style="margin-top:12px"></div>
      </div>
    </div>
  `);

  document.getElementById('simConvertBtn').addEventListener('click', () => {
    const usd = parseFloat(document.getElementById('simUsd').value) || 0;
    const rate = parseFloat(document.getElementById('simRate').value) || 1;
    const ppn = parseFloat(document.getElementById('simPpn').value) || 11;
    const baseIdr = usd * rate;
    const ppnAmt = baseIdr * ppn / 100;
    const total = baseIdr + ppnAmt;
    document.getElementById('simResult').innerHTML = `
      <div class="kv-grid kv-grid-3" style="background:var(--surface-soft);border:1px solid var(--border);border-radius:8px;padding:12px 16px">
        <div class="kv-item"><div class="kv-label">Base IDR</div><div class="kv-value">${fmtIdr(baseIdr)}</div></div>
        <div class="kv-item"><div class="kv-label">PPN ${ppn}%</div><div class="kv-value">${fmtIdr(ppnAmt)}</div></div>
        <div class="kv-item"><div class="kv-label">Total IDR (incl. PPN)</div><div class="kv-value" style="color:var(--brand-light)">${fmtIdr(total)}</div></div>
      </div>`;
  });
}

// ─────────────────────────────────────────
//  Bootstrap
// ─────────────────────────────────────────
init();
