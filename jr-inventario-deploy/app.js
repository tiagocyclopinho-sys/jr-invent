// JR INVENT - Lógica Frontend (Vanilla JS + WebSockets)

let currentUser = null;
let currentInventory = null;
let allItems = [];
let filteredItems = [];
let depositsList = [];
let selectedItemId = null;
let currentStatusFilter = 'Todos';
let ws = null;
let pollingInterval = null;

// --- INICIALIZAÇÃO ---
document.addEventListener('DOMContentLoaded', () => {
  checkSession();
  setupWebSocket();
});

// ===================== DRAWER MENU LATERAL =====================
function toggleDrawer() {
  const drawer = document.getElementById('side-drawer');
  const backdrop = document.getElementById('drawer-backdrop');
  const isOpen = drawer.classList.contains('open');
  if (isOpen) {
    closeDrawer();
  } else {
    drawer.classList.add('open');
    backdrop.classList.add('open');
  }
}

function closeDrawer() {
  document.getElementById('side-drawer').classList.remove('open');
  document.getElementById('drawer-backdrop').classList.remove('open');
}

function selectMenuItem(tabId, clickedBtn) {
  closeDrawer();
  switchTab(tabId);

  document.querySelectorAll('.drawer-item').forEach(btn => btn.classList.remove('active'));
  if (clickedBtn) clickedBtn.classList.add('active');
}

// ===================== AUTENTICAÇÃO =====================
function checkSession() {
  const saved = localStorage.getItem('jrinvent_user');
  if (saved) {
    try {
      currentUser = JSON.parse(saved);
      applyUserSession();
      loadActiveInventory();
      return;
    } catch (e) {}
  }
  document.getElementById('login-modal').classList.add('active');
}

function quickLogin(username, password) {
  document.getElementById('login-username').value = username;
  document.getElementById('login-password').value = password;
  performLogin(username, password);
}

document.getElementById('login-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;
  performLogin(username, password);
});

async function performLogin(username, password) {
  if (!username || !password) {
    alert('Por favor, preencha usuário e senha.');
    return;
  }

  try {
    const res = await fetch('./api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });

    if (res.ok) {
      const data = await res.json();
      if (data.user) {
        currentUser = data.user;
        localStorage.setItem('jrinvent_user', JSON.stringify(currentUser));
        document.getElementById('login-modal').classList.remove('active');
        applyUserSession();
        loadActiveInventory();
        return;
      }
    }
  } catch (err) {
    console.log('API indisponível, usando autenticação local.');
  }

  // Autenticação local embutida
  const localAccounts = [
    { username: 'admin',    password: 'admin123', name: 'Administrador JR', role: 'admin' },
    { username: 'operador1', password: 'op123',   name: 'Thiago Ferreira',  role: 'operator' },
    { username: 'operador2', password: 'op123',   name: 'Carlos Silva',     role: 'operator' },
    { username: 'operador3', password: 'op123',   name: 'Ana Paula',        role: 'operator' }
  ];

  const matched = localAccounts.find(u =>
    u.username.toLowerCase() === username.toLowerCase() && u.password === password
  );

  if (matched) {
    currentUser = { id: `usr_${Date.now()}`, username: matched.username, name: matched.name, role: matched.role };
    localStorage.setItem('jrinvent_user', JSON.stringify(currentUser));
    document.getElementById('login-modal').classList.remove('active');
    applyUserSession();
    loadActiveInventory();
  } else {
    alert('Usuário ou senha incorretos.');
  }
}

function logout() {
  if (currentUser) {
    fetch('./api/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: currentUser.username, role: currentUser.role })
    }).catch(() => {});
  }
  currentUser = null;
  localStorage.removeItem('jrinvent_user');
  closeDrawer();
  document.getElementById('login-modal').classList.add('active');
}

function applyUserSession() {
  if (!currentUser) return;
  const nameEl = document.getElementById('drawer-user-name');
  if (nameEl) nameEl.textContent = `${currentUser.name} (${currentUser.role === 'admin' ? 'Admin' : 'Operador'})`;

  // Exibe/oculta elementos exclusivos de admin
  document.querySelectorAll('.admin-only').forEach(el => {
    el.style.display = currentUser.role === 'admin' ? '' : 'none';
  });
}

// ===================== WEBSOCKETS =====================
function setupWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}`;

  try {
    ws = new WebSocket(wsUrl);

    ws.onopen  = () => setWifiStatus(true, 'Wi-Fi Online');
    ws.onclose = () => { setWifiStatus(true, 'Online'); startPolling(); };
    ws.onerror = () => { setWifiStatus(true, 'Online'); startPolling(); };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleRealtimeEvent(msg.event, msg.payload);
      } catch (e) {}
    };
  } catch (err) {
    setWifiStatus(true, 'Online');
    startPolling();
  }
}

function startPolling() {
  if (pollingInterval) return;
  pollingInterval = setInterval(() => {
    if (currentInventory && currentUser) {
      loadInventoryItems();
      updateBadgesAndCounters();
    }
  }, 4000);
}

function setWifiStatus(isOnline, label) {
  const chip = document.getElementById('hdr-wifi-status');
  const text = document.getElementById('wifi-text');
  chip.className = `info-chip ${isOnline ? 'wifi-online' : 'wifi-offline'}`;
  text.textContent = label || (isOnline ? 'Online' : 'Offline');
}

function handleRealtimeEvent(eventName, payload) {
  if (eventName === 'COUNT_UPDATED' || eventName === 'DIVERGENCE_APPROVED') {
    if (currentInventory && payload.item && payload.item.inventoryId === currentInventory.id) {
      const idx = allItems.findIndex(i => i.id === payload.item.id);
      if (idx !== -1) allItems[idx] = payload.item;
      else allItems.push(payload.item);
      renderProducts();
      updateDashboardData();
      if (currentUser && currentUser.role === 'admin') loadDivergencesCards();
    }
  } else if (['INVENTORY_CREATED', 'INVENTORY_FINALIZED', 'INVENTORY_REOPENED'].includes(eventName)) {
    loadActiveInventory();
  }
}

// ===================== NAVEGAÇÃO POR ABAS =====================
function switchTab(tabId) {
  document.querySelectorAll('.tab-pane').forEach(p => p.style.display = 'none');
  const pane = document.getElementById(tabId);
  if (pane) pane.style.display = 'block';

  if (tabId === 'tab-dashboard')          updateDashboardData();
  if (tabId === 'tab-terceira-contagem')  loadDivergencesCards();
  if (tabId === 'tab-relatorios')         loadReportsData();
  if (tabId === 'tab-auditoria')          loadAuditLogs();
}

// ===================== CARREGAMENTO DE DADOS =====================
async function loadActiveInventory() {
  try {
    const res = await fetch('./api/inventories');
    if (res.ok) {
      const data = await res.json();
      if (data.inventories && data.inventories.length > 0) {
        currentInventory = data.inventories[data.inventories.length - 1];
        const codeEl = document.getElementById('hdr-inv-code');
        const statusEl = document.getElementById('lbl-inv-status');
        if (codeEl) codeEl.textContent = currentInventory.code;
        if (statusEl) statusEl.textContent = `${currentInventory.code} · ${currentInventory.status}`;

        loadDepositsList();
        loadInventoryItems();
        return;
      }
    }
  } catch (err) {}

  // Fallback sem backend
  currentInventory = { id: 'inv_001', code: 'INV-2026-001', name: 'Inventário Geral JR', status: 'Em andamento', isLocked: false };
  document.getElementById('hdr-inv-code').textContent = currentInventory.code;
  loadInventoryItems();
}

async function loadDepositsList() {
  if (!currentInventory) return;
  try {
    const res = await fetch(`./api/inventories/${currentInventory.id}/deposits`);
    if (!res.ok) return;
    const data = await res.json();
    depositsList = data.deposits || [];

    const select = document.getElementById('select-deposito');
    select.innerHTML = '<option value="Todos">🏬 Todos os Depósitos</option>';
    depositsList.forEach(dep => {
      const opt = document.createElement('option');
      opt.value = dep;
      opt.textContent = `📍 ${dep}`;
      select.appendChild(opt);
    });
  } catch (err) {}
}

async function loadInventoryItems() {
  if (!currentInventory) {
    currentInventory = { id: 'inv_001', code: 'INV-2026-001', status: 'Em andamento', isLocked: false };
  }

  try {
    const res = await fetch(`./api/inventories/${currentInventory.id}/items`);
    if (res.ok) {
      const data = await res.json();
      if (data.items && data.items.length > 0) {
        allItems = data.items;
        applyFiltersAndRender();
        return;
      }
    }
  } catch (err) {}

  // Carrega do LocalStorage
  const saved = localStorage.getItem('jrinvent_client_items');
  if (saved) {
    try {
      allItems = JSON.parse(saved);
      applyFiltersAndRender();
      return;
    } catch (e) {}
  }

  // Dados de demonstração embutidos
  const sampleDeposits = ['Almoxarifado Oficina', 'PRT B1 - NVL 01', 'PRT A - NVL 02', 'LAVAJATO', 'PRT C1 - NVL 00'];
  const baseProducts = [
    { code: 'ZN141451',    desc: 'FAROL AUXILIAR VW LD',                  q: 10, c: 131.00 },
    { code: 'ZN141450',    desc: 'FAROL AUXILIAR VW LE',                  q: 15, c: 131.00 },
    { code: 'X8880109',    desc: 'REGULADOR DE PRESSAO FILTRO',            q:  5, c: 398.36 },
    { code: 'WK10002/1X',  desc: 'FILTRO SEPARADOR DE AGUA - RACOR',      q: 22, c: 147.78 },
    { code: 'VE0461694STD',desc: 'VALVULA DE ESCAPE MOTOR D08',            q:  8, c:  84.34 },
    { code: 'UB672',       desc: 'BOMBA D AGUA VW/MAN CONSTELLATION',     q: 12, c: 523.69 },
    { code: 'UB0734',      desc: 'URBA-BROSOL BOMBA AGUA',                q: 18, c: 129.16 },
    { code: 'TUBO-NYLON-8',desc: 'TUBO NYLON EXT 8 X INT 6MM 25M',       q: 50, c:   6.24 }
  ];

  allItems = [];
  let idx = 1;
  sampleDeposits.forEach(dep => {
    baseProducts.forEach(prod => {
      allItems.push({
        id: `item_local_${idx++}`,
        inventoryId: 'inv_001',
        codigo: prod.code, descricao: prod.desc, deposito: dep,
        quantidadeTeorica: prod.q, quantidadeContada: null, diferenca: null,
        precoUltimaEntrada: prod.c, custoMedio: prod.c, valorTotal: prod.q * prod.c,
        status: 'nao_contado', countStage: 1,
        operator: null, countedAt: null, observacao: null,
        adminJustification: null, adminApprovedBy: null, adminApprovedAt: null
      });
    });
  });

  localStorage.setItem('jrinvent_client_items', JSON.stringify(allItems));
  applyFiltersAndRender();
}

// ===================== FILTROS =====================
function onSearchChange() { applyFiltersAndRender(); }
function onFilterChange() {
  const dep = document.getElementById('select-deposito').value;
  const lbl = document.getElementById('lbl-current-deposito');
  if (lbl) lbl.textContent = dep === 'Todos' ? 'Todos' : dep;
  applyFiltersAndRender();
}

function setStatusFilter(status, btn) {
  currentStatusFilter = status;
  document.querySelectorAll('.pill-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  applyFiltersAndRender();
}

function applyFiltersAndRender() {
  const q    = document.getElementById('search-input').value.toLowerCase().trim();
  const dep  = document.getElementById('select-deposito').value;

  filteredItems = allItems.filter(item => {
    if (dep !== 'Todos' && item.deposito !== dep) return false;

    if (currentStatusFilter === 'Pendentes'      && !(item.status === 'nao_contado' || item.status === 'em_contagem')) return false;
    if (currentStatusFilter === 'Sem Divergência' && item.status !== 'sem_divergencia') return false;
    if (currentStatusFilter === 'Divergentes'    && item.status !== 'divergencia') return false;

    if (q) {
      const c = item.codigo.toLowerCase().includes(q);
      const d = item.descricao.toLowerCase().includes(q);
      const s = item.deposito.toLowerCase().includes(q);
      if (!c && !d && !s) return false;
    }
    return true;
  });

  updateBadgesAndCounters();
  renderProducts();
}

function updateBadgesAndCounters() {
  const total    = allItems.length;
  const pending  = allItems.filter(i => i.status === 'nao_contado' || i.status === 'em_contagem').length;
  const diverg   = allItems.filter(i => i.status === 'divergencia').length;

  document.getElementById('hdr-pending-count').textContent = pending;

  const badgeAll = document.getElementById('tab-badge-all');
  const badgeDiv = document.getElementById('tab-badge-div');
  if (badgeAll) badgeAll.textContent = total;
  if (badgeDiv) badgeDiv.textContent = diverg;
}

// ===================== RENDERIZAÇÃO DE CARDS =====================
function renderProducts() {
  const container = document.getElementById('product-grid');
  container.innerHTML = '';

  if (filteredItems.length === 0) {
    container.innerHTML = `
      <div style="grid-column:1/-1; text-align:center; padding:40px; color:var(--text-muted);">
        <p style="font-size:1.1rem; font-weight:700;">Nenhum produto encontrado.</p>
      </div>`;
    return;
  }

  const limit = Math.min(filteredItems.length, 150);
  for (let i = 0; i < limit; i++) {
    const item = filteredItems[i];
    const card = document.createElement('div');
    card.className = 'product-card';
    card.onclick   = () => openCountModal(item.id);

    const statusMap = {
      nao_contado:     { label: 'Não contado',    cls: 'gray'  },
      em_contagem:     { label: 'Em contagem',     cls: 'blue'  },
      sem_divergencia: { label: 'Sem Divergência', cls: 'green' },
      divergencia:     { label: 'Divergência',     cls: 'red'   }
    };
    const st = statusMap[item.status] || statusMap['nao_contado'];

    card.innerHTML = `
      <div class="card-header">
        <span class="product-code">${escapeHtml(item.codigo)}</span>
        <span class="status-badge ${st.cls}">${st.label}</span>
      </div>
      <div class="product-desc">${escapeHtml(item.descricao)}</div>
      <div style="font-size:0.75rem; color:var(--text-muted); margin-bottom:6px;">📍 ${escapeHtml(item.deposito)}</div>
      <div class="card-details">
        <div>Teórico: <span>${item.quantidadeTeorica}</span></div>
        <div>Contado: <span style="color:var(--primary);">${item.quantidadeContada !== null ? item.quantidadeContada : '--'}</span></div>
      </div>`;
    container.appendChild(card);
  }
}

// ===================== MODAL DE CONTAGEM =====================
function openCountModal(itemId) {
  if (currentInventory && currentInventory.isLocked) {
    alert('Este inventário está finalizado e bloqueado para edições.');
    return;
  }
  const item = allItems.find(i => i.id === itemId);
  if (!item) return;

  selectedItemId = itemId;
  document.getElementById('modal-product-code').textContent    = item.codigo;
  document.getElementById('modal-product-desc').textContent    = item.descricao;
  document.getElementById('modal-product-deposito').textContent = `📍 ${item.deposito}`;
  document.getElementById('modal-product-teorica').textContent  = item.quantidadeTeorica;
  document.getElementById('modal-product-custo').textContent    = `R$ ${(item.custoMedio || 0).toFixed(2)}`;
  document.getElementById('count-qty-input').value  = item.quantidadeContada !== null ? item.quantidadeContada : '';
  document.getElementById('count-obs-input').value  = item.observacao || '';

  document.getElementById('count-modal').classList.add('active');
}

function closeCountModal() {
  document.getElementById('count-modal').classList.remove('active');
  selectedItemId = null;
}

function stepCount(step) {
  const input = document.getElementById('count-qty-input');
  input.value = Math.max(0, (parseFloat(input.value) || 0) + step);
}

function numpadPress(val) {
  const input = document.getElementById('count-qty-input');
  if (val === 'C')   input.value = '';
  else if (val === 'DEL') input.value = input.value.slice(0, -1);
  else input.value = (input.value || '') + val;
}

async function submitCount() {
  if (!selectedItemId) return;
  const inputVal = document.getElementById('count-qty-input').value;
  const obsVal   = document.getElementById('count-obs-input').value.trim();

  if (inputVal === '' || isNaN(parseFloat(inputVal))) {
    alert('Informe uma quantidade válida.');
    return;
  }

  const countedQty   = parseFloat(inputVal);
  const operatorName = currentUser ? currentUser.name : 'Operador';

  try {
    const res = await fetch(`./api/items/${selectedItemId}/count`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quantidadeContada: countedQty, operator: operatorName, observacao: obsVal })
    });

    if (res.ok) {
      const data = await res.json();
      const idx = allItems.findIndex(i => i.id === selectedItemId);
      if (idx !== -1) allItems[idx] = data.item;
      closeCountModal();
      applyFiltersAndRender();
      return;
    }
  } catch (err) {}

  // Fallback local
  const idx = allItems.findIndex(i => i.id === selectedItemId);
  if (idx !== -1) {
    const item = allItems[idx];
    item.quantidadeContada = countedQty;
    item.diferenca = countedQty - item.quantidadeTeorica;
    item.operator  = operatorName;
    item.countedAt = new Date().toLocaleString('pt-BR');
    item.observacao = obsVal || null;
    item.status = item.quantidadeTeorica === countedQty ? 'sem_divergencia' : 'divergencia';
    if (item.status === 'divergencia') item.countStage = 3;
    localStorage.setItem('jrinvent_client_items', JSON.stringify(allItems));
  }

  closeCountModal();
  applyFiltersAndRender();
}

// ===================== TERCEIRA CONTAGEM (CARDS MOBILE) =====================
function loadDivergencesCards() {
  const container = document.getElementById('divergences-mobile-list');
  const divItems  = allItems.filter(i => i.status === 'divergencia');

  if (divItems.length === 0) {
    container.innerHTML = `
      <div style="text-align:center; padding:40px; color:var(--success);">
        <p style="font-size:1.1rem; font-weight:700;">🎉 Nenhuma divergência pendente!</p>
      </div>`;
    return;
  }

  container.innerHTML = '';
  divItems.forEach(item => {
    const diff = item.quantidadeContada - item.quantidadeTeorica;
    const diffColor = diff < 0 ? 'var(--danger)' : 'var(--info)';

    const card = document.createElement('div');
    card.className = 'mobile-list-card card-diverge';
    card.innerHTML = `
      <div class="row">
        <strong>${escapeHtml(item.codigo)}</strong>
        <span class="badge badge-danger">Divergência</span>
      </div>
      <div style="font-size:0.85rem; margin-bottom:8px; color:var(--text-muted);">${escapeHtml(item.descricao)}</div>
      <div style="font-size:0.82rem; margin-bottom:4px; color:var(--text-muted);">📍 ${escapeHtml(item.deposito)}</div>
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-bottom:10px;">
        <div style="font-size:0.82rem;">Teórico: <strong>${item.quantidadeTeorica}</strong></div>
        <div style="font-size:0.82rem; color:${diffColor};">Diferença: <strong>${diff > 0 ? '+' : ''}${diff}</strong></div>
      </div>
      <div style="margin-bottom:8px;">
        <label style="font-size:0.75rem; font-weight:700; display:block; margin-bottom:3px;">Qtd Aprovada</label>
        <input type="number" id="div-qty-${item.id}" value="${item.quantidadeContada}" class="search-input" style="padding:8px;">
      </div>
      <div style="margin-bottom:10px;">
        <label style="font-size:0.75rem; font-weight:700; display:block; margin-bottom:3px;">Justificativa (obrigatória)</label>
        <input type="text" id="div-just-${item.id}" placeholder="Insira a justificativa..." class="search-input" style="padding:8px;">
      </div>
      <button class="btn-large btn-primary" onclick="approveDivergence('${item.id}')" style="width:100%; min-height:42px; font-size:0.9rem;">
        ✅ Aprovar Divergência
      </button>`;
    container.appendChild(card);
  });
}

async function approveDivergence(itemId) {
  const qty  = document.getElementById(`div-qty-${itemId}`).value;
  const just = document.getElementById(`div-just-${itemId}`).value.trim();

  if (!just) {
    alert('A justificativa é obrigatória para aprovar divergências.');
    return;
  }

  try {
    const res = await fetch(`./api/items/${itemId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quantidadeContada: parseFloat(qty),
        justification: just,
        adminUser: currentUser ? currentUser.name : 'Administrador'
      })
    });

    if (res.ok) {
      const data = await res.json();
      alert('Divergência liberada e aprovada!');
      const idx = allItems.findIndex(i => i.id === itemId);
      if (idx !== -1) allItems[idx] = data.item;
      loadDivergencesCards();
      updateBadgesAndCounters();
      return;
    }
  } catch (err) {}

  // Fallback local
  const idx = allItems.findIndex(i => i.id === itemId);
  if (idx !== -1) {
    const item = allItems[idx];
    item.quantidadeContada = parseFloat(qty);
    item.diferenca = item.quantidadeContada - item.quantidadeTeorica;
    item.status = 'sem_divergencia';
    item.adminJustification = just;
    item.adminApprovedBy = currentUser ? currentUser.name : 'Admin';
    localStorage.setItem('jrinvent_client_items', JSON.stringify(allItems));
  }
  alert('Divergência aprovada (modo local)!');
  loadDivergencesCards();
  updateBadgesAndCounters();
}

// ===================== DASHBOARD =====================
async function updateDashboardData() {
  if (!currentInventory) return;

  let metrics;
  try {
    const res = await fetch(`./api/inventories/${currentInventory.id}/dashboard`);
    if (res.ok) {
      const d = await res.json();
      metrics = d.metrics;
    }
  } catch (err) {}

  // Calcula local se API falhar
  if (!metrics) {
    const items = allItems;
    const counted  = items.filter(i => i.status !== 'nao_contado').length;
    const divergent = items.filter(i => i.status === 'divergencia').length;
    const theorVal = items.reduce((s, i) => s + (i.valorTotal || 0), 0);
    const inventVal = items.reduce((s, i) => s + ((i.quantidadeContada || 0) * (i.custoMedio || 0)), 0);
    metrics = {
      totalItems: items.length,
      countedItems: counted,
      pendingItems: items.length - counted,
      divergentItems: divergent,
      completionPercent: items.length > 0 ? ((counted / items.length) * 100).toFixed(1) : '0.0',
      totalTheoreticalValue: theorVal,
      totalInventoriedValue: inventVal,
      financialDiff: inventVal - theorVal,
      totalDifferenceQty: items.reduce((s, i) => s + (i.diferenca || 0), 0),
      operatorStats: buildOperatorStats(items),
      depositStats: buildDepositStats(items)
    };
  }

  document.getElementById('dash-total-items').textContent   = metrics.totalItems;
  document.getElementById('dash-counted-items').textContent  = metrics.countedItems;
  document.getElementById('dash-completion-pct').textContent = `${metrics.completionPercent}% Concluído`;
  document.getElementById('dash-pending-items').textContent  = metrics.pendingItems;
  document.getElementById('dash-divergent-items').textContent= metrics.divergentItems;
  document.getElementById('dash-inventoried-val').textContent= formatBRL(metrics.totalInventoriedValue);
  document.getElementById('dash-theoretical-val').textContent= `Teórico: ${formatBRL(metrics.totalTheoreticalValue)}`;
  document.getElementById('dash-financial-diff').textContent = formatBRL(metrics.financialDiff);
  document.getElementById('dash-qty-diff').textContent       = `Diferença em Qtd: ${metrics.totalDifferenceQty}`;

  // Operadores
  const opTbody = document.getElementById('tbl-op-productivity');
  opTbody.innerHTML = '';
  Object.entries(metrics.operatorStats || {}).forEach(([op, stat]) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><strong>${escapeHtml(op)}</strong></td><td>${stat.count}</td>
      <td style="color:var(--success);">${stat.noDiv}</td><td style="color:var(--danger);">${stat.div}</td>`;
    opTbody.appendChild(tr);
  });

  // Depósitos
  const depTbody = document.getElementById('tbl-deposit-summary');
  depTbody.innerHTML = '';
  Object.entries(metrics.depositStats || {}).forEach(([dep, stat]) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><strong>${escapeHtml(dep)}</strong></td><td>${stat.total}</td>
      <td style="color:var(--accent);">${stat.counted}</td>
      <td style="color:var(--warning);">${stat.pending}</td>
      <td style="color:var(--danger);">${stat.divergent}</td>`;
    depTbody.appendChild(tr);
  });
}

function buildOperatorStats(items) {
  const stats = {};
  items.filter(i => i.operator).forEach(i => {
    if (!stats[i.operator]) stats[i.operator] = { count: 0, noDiv: 0, div: 0 };
    stats[i.operator].count++;
    if (i.status === 'divergencia') stats[i.operator].div++;
    else stats[i.operator].noDiv++;
  });
  return stats;
}

function buildDepositStats(items) {
  const stats = {};
  items.forEach(i => {
    if (!stats[i.deposito]) stats[i.deposito] = { total: 0, counted: 0, pending: 0, divergent: 0 };
    stats[i.deposito].total++;
    if (i.status === 'nao_contado' || i.status === 'em_contagem') stats[i.deposito].pending++;
    else {
      stats[i.deposito].counted++;
      if (i.status === 'divergencia') stats[i.deposito].divergent++;
    }
  });
  return stats;
}

// ===================== RELATÓRIOS =====================
function loadReportsData() {
  document.getElementById('rpt-inv-code').textContent = currentInventory ? currentInventory.code : 'INV-2026-001';
  document.getElementById('rpt-date').textContent = new Date().toLocaleDateString('pt-BR');

  const tbody = document.getElementById('tbl-report-analytical');
  tbody.innerHTML = '';

  allItems.forEach(item => {
    const diff    = item.quantidadeContada !== null ? (item.quantidadeContada - item.quantidadeTeorica) : '--';
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${escapeHtml(item.codigo)}</strong></td>
      <td>${escapeHtml(item.descricao)}</td>
      <td>${escapeHtml(item.deposito)}</td>
      <td>${item.quantidadeTeorica}</td>
      <td>${item.quantidadeContada !== null ? item.quantidadeContada : '--'}</td>
      <td>${diff}</td>
      <td><span class="badge ${item.status === 'sem_divergencia' ? 'badge-success' : item.status === 'divergencia' ? 'badge-danger' : ''}">${item.status}</span></td>`;
    tbody.appendChild(tr);
  });
}

function exportPDF() { window.print(); }

function exportCSV() {
  let csv = '\uFEFF';
  csv += 'Codigo;Descricao;Deposito;QtdTeorica;QtdContada;Diferenca;CustoMedio;ValorDivergencia;Operador;Status\n';

  allItems.forEach(item => {
    const diff   = item.quantidadeContada !== null ? (item.quantidadeContada - item.quantidadeTeorica) : '';
    const divVal = typeof diff === 'number' ? Math.abs(diff * item.custoMedio) : 0;
    csv += `"${item.codigo}";"${item.descricao}";"${item.deposito}";${item.quantidadeTeorica};${item.quantidadeContada ?? ''};${diff};${item.custoMedio};${divVal};"${item.operator || ''}";"${item.status}"\n`;
  });

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href  = url;
  link.setAttribute('download', `Inventario_${currentInventory ? currentInventory.code : 'JR'}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

// ===================== AUDITORIA =====================
async function loadAuditLogs() {
  const container = document.getElementById('audit-mobile-list');

  try {
    const res = await fetch('./api/audit');
    if (res.ok) {
      const data = await res.json();
      container.innerHTML = '';
      (data.logs || []).forEach(log => {
        const card = document.createElement('div');
        card.className = 'audit-log-card';
        card.innerHTML = `
          <div class="log-action">${escapeHtml(log.action)}</div>
          <div class="log-meta">${log.date} ${log.time} · <strong>${escapeHtml(log.user)}</strong> (${log.role})</div>
          <div class="log-detail">${escapeHtml(log.details)}</div>`;
        container.appendChild(card);
      });
      return;
    }
  } catch (err) {}

  container.innerHTML = `<div style="text-align:center; padding:30px; color:var(--text-muted);">
    <p>Nenhum registro de auditoria disponível no modo offline.</p></div>`;
}

// ===================== IMPORTAÇÃO & GESTÃO =====================
async function uploadNewExcel() {
  const fileInput = document.getElementById('file-excel-input');
  if (!fileInput.files || fileInput.files.length === 0) {
    alert('Selecione uma planilha Excel (.xlsx).');
    return;
  }
  const file = fileInput.files[0];
  try {
    const arrayBuffer = await file.arrayBuffer();
    const res = await fetch(
      `./api/upload-excel?name=${encodeURIComponent('Novo Inventário')}&responsible=${encodeURIComponent(currentUser.name)}`,
      { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: arrayBuffer }
    );
    const data = await res.json();
    if (!res.ok) { alert(data.error || 'Erro ao importar.'); return; }
    alert('Planilha importada com sucesso!');
    loadActiveInventory();
    selectMenuItem('tab-contagem', null);
  } catch (err) {
    alert('Erro ao processar o arquivo.');
  }
}

async function confirmFinalizeInventory() {
  if (!currentInventory) return;
  if (!confirm('Deseja realmente finalizar este inventário? O inventário será bloqueado.')) return;

  try {
    const res = await fetch(`./api/inventories/${currentInventory.id}/finalize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: currentUser.name })
    });
    if (res.ok) { alert('Inventário finalizado e bloqueado!'); loadActiveInventory(); return; }
  } catch (err) {}
  alert('Erro de comunicação.');
}

function openReopenModal() { document.getElementById('reopen-modal').classList.add('active'); }
function closeReopenModal() { document.getElementById('reopen-modal').classList.remove('active'); }

async function submitReopenInventory() {
  if (!currentInventory) return;
  const pass = document.getElementById('reopen-password-input').value;

  try {
    const res = await fetch(`./api/inventories/${currentInventory.id}/reopen`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: currentUser.name, password: pass })
    });
    const data = await res.json();
    if (!res.ok) { alert(data.error || 'Senha incorreta.'); return; }
    alert('Inventário reaberto!');
    closeReopenModal();
    loadActiveInventory();
  } catch (err) {
    alert('Erro de conexão.');
  }
}

// ===================== UTILIDADES =====================
function formatBRL(val) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(val || 0);
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
