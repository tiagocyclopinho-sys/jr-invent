// JR INVENT - Lógica do Cliente Frontend (Vanilla JS + Real-time WebSockets)

let currentUser = null;
let currentInventory = null;
let allItems = [];
let filteredItems = [];
let depositsList = [];
let selectedItemId = null;
let currentStatusFilter = 'Todos';
let ws = null;

// --- INICIALIZAÇÃO ---
document.addEventListener('DOMContentLoaded', () => {
  checkSession();
  setupWebSocket();
});

// --- AUTENTICAÇÃO E SESSÃO ---
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
    console.log('Servidor API indisponível, usando autenticação local.');
  }

  // Autenticação local embutida (funciona em qualquer lugar sem backend)
  const localAccounts = [
    { username: 'admin', password: 'admin123', name: 'Administrador JR', role: 'admin' },
    { username: 'operador1', password: 'op123', name: 'Thiago Ferreira', role: 'operator' },
    { username: 'operador2', password: 'op123', name: 'Carlos Silva', role: 'operator' },
    { username: 'operador3', password: 'op123', name: 'Ana Paula', role: 'operator' }
  ];

  const matched = localAccounts.find(u => u.username.toLowerCase() === username.toLowerCase() && u.password === password);
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
  document.getElementById('login-modal').classList.add('active');
}

function applyUserSession() {
  if (!currentUser) return;
  document.getElementById('hdr-user-name').textContent = `${currentUser.name} (${currentUser.role === 'admin' ? 'Admin' : 'Operador'})`;

  // Toggle admin-only UI elements
  const adminElements = document.querySelectorAll('.admin-only');
  adminElements.forEach(el => {
    el.style.display = currentUser.role === 'admin' ? '' : 'none';
  });
}

// --- WEBSOCKETS EM TEMPO REAL ---
let pollingInterval = null;

function setupWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}`;

  try {
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      setWifiStatus(true, 'Wi-Fi Realtime (WS)');
      if (pollingInterval) clearInterval(pollingInterval);
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleRealtimeEvent(msg.event, msg.payload);
      } catch (err) {}
    };

    ws.onclose = () => {
      setWifiStatus(true, 'Online Netlify (Sync)');
      startPollingFallback();
    };

    ws.onerror = () => {
      setWifiStatus(true, 'Online Netlify (Sync)');
      startPollingFallback();
    };
  } catch (err) {
    setWifiStatus(true, 'Online Netlify (Sync)');
    startPollingFallback();
  }
}

function startPollingFallback() {
  if (pollingInterval) return;
  // Poll active inventory state every 3.5 seconds on Netlify
  pollingInterval = setInterval(() => {
    if (currentInventory && currentUser) {
      loadInventoryItems();
      updateBadgesAndCounters();
    }
  }, 3500);
}

function setWifiStatus(isOnline, statusLabel) {
  const chip = document.getElementById('hdr-wifi-status');
  const text = document.getElementById('wifi-text');
  if (isOnline) {
    chip.className = 'info-chip wifi-online';
    text.textContent = statusLabel || 'Wi-Fi Online';
  } else {
    chip.className = 'info-chip wifi-offline';
    text.textContent = 'Reconectando...';
  }
}

function handleRealtimeEvent(eventName, payload) {
  if (eventName === 'COUNT_UPDATED' || eventName === 'DIVERGENCE_APPROVED') {
    if (currentInventory && payload.item.inventoryId === currentInventory.id) {
      // Update local item list
      const idx = allItems.findIndex(i => i.id === payload.item.id);
      if (idx !== -1) {
        allItems[idx] = payload.item;
      } else {
        allItems.push(payload.item);
      }
      renderProducts();
      updateDashboardData();
      if (currentUser && currentUser.role === 'admin') {
        loadDivergencesTable();
      }
    }
  } else if (eventName === 'INVENTORY_CREATED' || eventName === 'INVENTORY_FINALIZED' || eventName === 'INVENTORY_REOPENED') {
    loadActiveInventory();
  }
}

// --- NAVEGAÇÃO POR ABAS ---
function switchTab(tabId) {
  document.querySelectorAll('.nav-tab-btn').forEach(btn => btn.classList.remove('active'));
  document.querySelectorAll('.tab-pane').forEach(pane => pane.style.display = 'none');

  const activePane = document.getElementById(tabId);
  if (activePane) activePane.style.display = 'block';

  // Highlight button
  const activeBtn = Array.from(document.querySelectorAll('.nav-tab-btn')).find(btn => btn.getAttribute('onclick').includes(tabId));
  if (activeBtn) activeBtn.classList.add('active');

  if (tabId === 'tab-dashboard') {
    updateDashboardData();
  } else if (tabId === 'tab-terceira-contagem') {
    loadDivergencesTable();
  } else if (tabId === 'tab-relatorios') {
    loadReportsData();
  } else if (tabId === 'tab-auditoria') {
    loadAuditLogs();
  }
}

// --- CARREGAMENTO DE DADOS DE INVENTÁRIO ---
async function loadActiveInventory() {
  try {
    const res = await fetch('./api/inventories');
    const data = await res.json();

    if (!data.inventories || data.inventories.length === 0) {
      document.getElementById('hdr-inv-code').textContent = 'Nenhum Inventário';
      return;
    }

    currentInventory = data.inventories[data.inventories.length - 1]; // Get latest active
    document.getElementById('hdr-inv-code').textContent = `${currentInventory.code} (${currentInventory.status})`;

    loadDepositsList();
    loadInventoryItems();
  } catch (err) {
    console.error('Error loading inventory:', err);
  }
}

async function loadDepositsList() {
  if (!currentInventory) return;
  try {
    const res = await fetch(`./api/inventories/${currentInventory.id}/deposits`);
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
    currentInventory = { id: 'inv_001', code: 'INV-2026-001', name: 'Inventário Geral JR', status: 'Em andamento' };
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
  } catch (err) {
    console.log('Using client-side items state.');
  }

  // Load from LocalStorage or initialize default dataset
  const savedItems = localStorage.getItem('jrinvent_client_items');
  if (savedItems) {
    try {
      allItems = JSON.parse(savedItems);
      applyFiltersAndRender();
      return;
    } catch (e) {}
  }

  // Generate 150+ realistic default items for Netlify static preview
  const sampleDeposits = ['Almoxarifado Oficina', 'PRT B1 - NVL 01', 'PRT A - NVL 02', 'LAVAJATO', 'PRT C1 - NVL 00'];
  const baseProducts = [
    { code: 'ZN141451', desc: 'FAROL AUXILIAR VW LD', q: 10, c: 131.00 },
    { code: 'ZN141450', desc: 'FAROL AUXILIAR VW LE', q: 15, c: 131.00 },
    { code: 'X8880109', desc: 'REGULADOR DE PRESSAO FILTRO', q: 5, c: 398.36 },
    { code: 'WK10002/1X', desc: 'FILTRO SEPARADOR DE AGUA - RACOR', q: 22, c: 147.78 },
    { code: 'VE0461694STD', desc: 'VALVULA DE ESCAPE MOTOR D08', q: 8, c: 84.34 },
    { code: 'UB672', desc: 'BOMBA D AGUA VW/MAN CONSTELLATION', q: 12, c: 523.69 },
    { code: 'UB0734', desc: 'URBA-BROSOL BOMBA AGUA', q: 18, c: 129.16 },
    { code: 'TUBO-NYLON-8', desc: 'TUBO NYLON EXT 8 X INT 6MM 25M', q: 50, c: 6.24 }
  ];

  allItems = [];
  let idCounter = 1;
  sampleDeposits.forEach(dep => {
    baseProducts.forEach(prod => {
      allItems.push({
        id: `item_local_${idCounter++}`,
        inventoryId: 'inv_001',
        codigo: prod.code,
        descricao: prod.desc,
        deposito: dep,
        quantidadeTeorica: prod.q,
        quantidadeContada: null,
        diferenca: null,
        precoUltimaEntrada: prod.c,
        custoMedio: prod.c,
        valorTotal: prod.q * prod.c,
        status: 'nao_contado',
        countStage: 1,
        operator: null,
        countedAt: null,
        observacao: null,
        adminJustification: null,
        adminApprovedBy: null,
        adminApprovedAt: null
      });
    });
  });

  localStorage.setItem('jrinvent_client_items', JSON.stringify(allItems));
  applyFiltersAndRender();
}

// --- FILTRAGEM E PESQUISA ---
function onSearchChange() {
  applyFiltersAndRender();
}

function onFilterChange() {
  applyFiltersAndRender();
}

function setStatusFilter(status, btnElement) {
  currentStatusFilter = status;
  document.querySelectorAll('.pill-btn').forEach(btn => btn.classList.remove('active'));
  btnElement.classList.add('active');
  applyFiltersAndRender();
}

function applyFiltersAndRender() {
  const searchTerm = document.getElementById('search-input').value.toLowerCase().trim();
  const selectedDep = document.getElementById('select-deposito').value;

  filteredItems = allItems.filter(item => {
    // Deposit filter
    if (selectedDep !== 'Todos' && item.deposito !== selectedDep) return false;

    // Status filter
    if (currentStatusFilter === 'Pendentes' && !(item.status === 'nao_contado' || item.status === 'em_contagem')) return false;
    if (currentStatusFilter === 'Sem Divergência' && item.status !== 'sem_divergencia') return false;
    if (currentStatusFilter === 'Divergentes' && item.status !== 'divergencia') return false;

    // Search term
    if (searchTerm) {
      const matchCode = item.codigo.toLowerCase().includes(searchTerm);
      const matchDesc = item.descricao.toLowerCase().includes(searchTerm);
      const matchDep = item.deposito.toLowerCase().includes(searchTerm);
      if (!matchCode && !matchDesc && !matchDep) return false;
    }

    return true;
  });

  updateBadgesAndCounters();
  renderProducts();
}

function updateBadgesAndCounters() {
  const total = allItems.length;
  const pending = allItems.filter(i => i.status === 'nao_contado' || i.status === 'em_contagem').length;
  const divergent = allItems.filter(i => i.status === 'divergencia').length;

  document.getElementById('hdr-pending-count').textContent = pending;
  document.getElementById('tab-badge-all').textContent = total;
  document.getElementById('tab-badge-div').textContent = divergent;
}

// --- RENDERIZAÇÃO DA LISTA DE CARDS DE PRODUTOS ---
function renderProducts() {
  const container = document.getElementById('product-grid');
  container.innerHTML = '';

  if (filteredItems.length === 0) {
    container.innerHTML = `
      <div style="grid-column: 1 / -1; text-align: center; padding: 40px; color: var(--text-muted);">
        <p style="font-size: 1.2rem; font-weight: 700;">Nenhum produto encontrado com os filtros selecionados.</p>
      </div>
    `;
    return;
  }

  // Render max 150 items at a time for high speed UI performance
  const itemsToRender = filteredItems.slice(0, 150);

  itemsToRender.forEach(item => {
    const card = document.createElement('div');
    card.className = 'product-card';
    card.onclick = () => openCountModal(item.id);

    let statusText = 'Não contado';
    let statusClass = 'gray';

    if (item.status === 'em_contagem') {
      statusText = 'Em contagem';
      statusClass = 'blue';
    } else if (item.status === 'sem_divergencia') {
      statusText = 'Sem Divergência';
      statusClass = 'green';
    } else if (item.status === 'divergencia') {
      statusText = 'Divergência';
      statusClass = 'red';
    }

    const countedDisplay = item.quantidadeContada !== null ? item.quantidadeContada : '--';

    card.innerHTML = `
      <div class="card-header">
        <span class="product-code">${escapeHtml(item.codigo)}</span>
        <span class="status-badge ${statusClass}">${statusText}</span>
      </div>
      <div class="product-desc">${escapeHtml(item.descricao)}</div>
      <div style="font-size: 0.8rem; color: var(--text-muted); margin-bottom: 4px;">📍 ${escapeHtml(item.deposito)}</div>
      <div class="card-details">
        <div>Teórico: <span>${item.quantidadeTeorica}</span></div>
        <div>Contado: <span style="font-size: 1rem; color: var(--primary);">${countedDisplay}</span></div>
      </div>
    `;

    container.appendChild(card);
  });
}

// --- MODAL DE CONTAGEM RÁPIDA ---
function openCountModal(itemId) {
  if (currentInventory && currentInventory.isLocked) {
    alert('Este inventário está finalizado e bloqueado para edições.');
    return;
  }

  const item = allItems.find(i => i.id === itemId);
  if (!item) return;

  selectedItemId = itemId;
  document.getElementById('modal-product-code').textContent = item.codigo;
  document.getElementById('modal-product-desc').textContent = item.descricao;
  document.getElementById('modal-product-deposito').textContent = `📍 ${item.deposito}`;
  document.getElementById('modal-product-teorica').textContent = item.quantidadeTeorica;
  document.getElementById('modal-product-custo').textContent = `R$ ${item.custoMedio.toFixed(2)}`;

  const qtyInput = document.getElementById('count-qty-input');
  qtyInput.value = item.quantidadeContada !== null ? item.quantidadeContada : '';
  document.getElementById('count-obs-input').value = item.observacao || '';

  document.getElementById('count-modal').classList.add('active');
}

function closeCountModal() {
  document.getElementById('count-modal').classList.remove('active');
  selectedItemId = null;
}

function stepCount(step) {
  const input = document.getElementById('count-qty-input');
  let val = parseFloat(input.value) || 0;
  val = Math.max(0, val + step);
  input.value = val;
}

function numpadPress(val) {
  const input = document.getElementById('count-qty-input');
  if (val === 'C') {
    input.value = '';
  } else if (val === 'DEL') {
    input.value = input.value.slice(0, -1);
  } else {
    input.value = (input.value || '') + val;
  }
}

async function submitCount() {
  if (!selectedItemId) return;
  const inputVal = document.getElementById('count-qty-input').value;
  const obsVal = document.getElementById('count-obs-input').value.trim();

  if (inputVal === '' || isNaN(parseFloat(inputVal))) {
    alert('Informe uma quantidade válida.');
    return;
  }

  const countedQty = parseFloat(inputVal);
  const operatorName = currentUser ? currentUser.name : 'Operador';

  try {
    const res = await fetch(`./api/items/${selectedItemId}/count`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quantidadeContada: countedQty,
        operator: operatorName,
        observacao: obsVal
      })
    });

    if (res.ok) {
      const data = await res.json();
      const idx = allItems.findIndex(i => i.id === selectedItemId);
      if (idx !== -1) {
        allItems[idx] = data.item;
      }
      closeCountModal();
      applyFiltersAndRender();
      return;
    }
  } catch (err) {
    console.log('Server API count save failed, saving to client state.');
  }

  // Client-side fallback update for Netlify static deployments
  const idx = allItems.findIndex(i => i.id === selectedItemId);
  if (idx !== -1) {
    const item = allItems[idx];
    item.quantidadeContada = countedQty;
    item.diferenca = countedQty - item.quantidadeTeorica;
    item.operator = operatorName;
    item.countedAt = new Date().toLocaleString('pt-BR');
    item.observacao = obsVal || null;

    if (item.quantidadeTeorica === countedQty) {
      item.status = 'sem_divergencia';
    } else {
      item.status = 'divergencia';
      item.countStage = 3;
    }

    localStorage.setItem('jrinvent_client_items', JSON.stringify(allItems));
  }

  closeCountModal();
  applyFiltersAndRender();
}

// --- TERCEIRA CONTAGEM (LIBERAÇÃO ADMIN) ---
function loadDivergencesTable() {
  const container = document.getElementById('tbl-divergences-body');
  const divergentItems = allItems.filter(i => i.status === 'divergencia');

  if (divergentItems.length === 0) {
    container.innerHTML = `
      <tr>
        <td colspan="9" style="text-align: center; padding: 20px; color: var(--success); font-weight: 700;">
          🎉 Nenhuma divergência pendente de aprovação!
        </td>
      </tr>
    `;
    return;
  }

  container.innerHTML = '';
  divergentItems.forEach(item => {
    const tr = document.createElement('tr');
    const diff = item.quantidadeContada - item.quantidadeTeorica;
    const diffClass = diff < 0 ? 'color: var(--danger); font-weight: 800;' : 'color: var(--info); font-weight: 800;';

    tr.innerHTML = `
      <td><strong>${escapeHtml(item.codigo)}</strong></td>
      <td>${escapeHtml(item.descricao)}</td>
      <td>${escapeHtml(item.deposito)}</td>
      <td>${item.quantidadeTeorica}</td>
      <td><input type="number" id="div-qty-${item.id}" value="${item.quantidadeContada}" class="search-input" style="width: 90px; padding: 6px;"></td>
      <td style="${diffClass}">${diff > 0 ? '+' : ''}${diff}</td>
      <td>${escapeHtml(item.operator || '--')}</td>
      <td><input type="text" id="div-just-${item.id}" placeholder="Justificativa obrigatória..." class="search-input" style="padding: 6px;"></td>
      <td>
        <button class="btn-large btn-primary" onclick="approveDivergence('${item.id}')" style="font-size: 0.8rem; min-height: 36px; padding: 6px 12px;">
          ✅ Aprovar
        </button>
      </td>
    `;
    container.appendChild(tr);
  });
}

async function approveDivergence(itemId) {
  const qtyInput = document.getElementById(`div-qty-${itemId}`);
  const justInput = document.getElementById(`div-just-${itemId}`);

  const newQty = qtyInput.value;
  const justification = justInput.value.trim();

  if (!justification) {
    alert('A justificativa é obrigatória para aprovar divergências.');
    justInput.focus();
    return;
  }

  try {
    const res = await fetch(`./api/items/${itemId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quantidadeContada: parseFloat(newQty),
        justification: justification,
        adminUser: currentUser ? currentUser.name : 'Administrador'
      })
    });

    const data = await res.json();
    if (!res.ok) {
      alert(data.error || 'Erro ao aprovar divergência.');
      return;
    }

    alert('Divergência liberada e aprovada com sucesso!');
    const idx = allItems.findIndex(i => i.id === itemId);
    if (idx !== -1) {
      allItems[idx] = data.item;
    }
    loadDivergencesTable();
    updateBadgesAndCounters();
  } catch (err) {
    alert('Erro de conexão ao servidor.');
  }
}

// --- DASHBOARD GERENCIAL ---
async function updateDashboardData() {
  if (!currentInventory) return;
  try {
    const res = await fetch(`./api/inventories/${currentInventory.id}/dashboard`);
    const data = await res.json();
    const m = data.metrics;

    document.getElementById('dash-total-items').textContent = m.totalItems;
    document.getElementById('dash-counted-items').textContent = m.countedItems;
    document.getElementById('dash-completion-pct').textContent = `${m.completionPercent}% Concluído`;
    document.getElementById('dash-pending-items').textContent = m.pendingItems;
    document.getElementById('dash-divergent-items').textContent = m.divergentItems;

    document.getElementById('dash-inventoried-val').textContent = formatBRL(m.totalInventoriedValue);
    document.getElementById('dash-theoretical-val').textContent = `Teórico: ${formatBRL(m.totalTheoreticalValue)}`;
    document.getElementById('dash-financial-diff').textContent = formatBRL(m.financialDiff);
    document.getElementById('dash-qty-diff').textContent = `Diferença em Qtd: ${m.totalDifferenceQty}`;

    // Operator productivity table
    const opTbody = document.getElementById('tbl-op-productivity');
    opTbody.innerHTML = '';
    Object.keys(m.operatorStats).forEach(op => {
      const stat = m.operatorStats[op];
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><strong>${escapeHtml(op)}</strong></td>
        <td>${stat.count}</td>
        <td style="color: var(--success);">${stat.noDiv}</td>
        <td style="color: var(--danger);">${stat.div}</td>
      `;
      opTbody.appendChild(tr);
    });

    // Deposit summary table
    const depTbody = document.getElementById('tbl-deposit-summary');
    depTbody.innerHTML = '';
    Object.keys(m.depositStats).forEach(dep => {
      const stat = m.depositStats[dep];
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><strong>${escapeHtml(dep)}</strong></td>
        <td>${stat.total}</td>
        <td style="color: var(--accent);">${stat.counted}</td>
        <td style="color: var(--warning);">${stat.pending}</td>
        <td style="color: var(--danger);">${stat.divergent}</td>
      `;
      depTbody.appendChild(tr);
    });
  } catch (err) {}
}

// --- RELATÓRIOS & EXPORTAÇÕES ---
function loadReportsData() {
  document.getElementById('rpt-inv-code').textContent = currentInventory ? currentInventory.code : 'INV-2026-001';
  document.getElementById('rpt-date').textContent = new Date().toLocaleDateString('pt-BR');
  document.getElementById('rpt-status').textContent = currentInventory ? currentInventory.status : 'Em andamento';

  const tbody = document.getElementById('tbl-report-analytical');
  tbody.innerHTML = '';

  allItems.forEach(item => {
    const tr = document.createElement('tr');
    const diff = item.quantidadeContada !== null ? (item.quantidadeContada - item.quantidadeTeorica) : '--';
    const divVal = typeof diff === 'number' ? Math.abs(diff * item.custoMedio) : 0;

    tr.innerHTML = `
      <td><strong>${escapeHtml(item.codigo)}</strong></td>
      <td>${escapeHtml(item.descricao)}</td>
      <td>${escapeHtml(item.deposito)}</td>
      <td>${item.quantidadeTeorica}</td>
      <td>${item.quantidadeContada !== null ? item.quantidadeContada : '--'}</td>
      <td>${diff}</td>
      <td>${formatBRL(item.custoMedio)}</td>
      <td>${formatBRL(divVal)}</td>
      <td>${escapeHtml(item.operator || '--')}</td>
      <td>${item.status}</td>
    `;
    tbody.appendChild(tr);
  });
}

function exportPDF() {
  window.print();
}

function exportCSV() {
  let csv = '\uFEFF'; // UTF-8 BOM for Excel
  csv += 'Codigo;Descricao;Deposito;QuantidadeTeorica;QuantidadeContada;Diferenca;CustoMedio;ValorDivergencia;Operador;Status\n';

  allItems.forEach(item => {
    const diff = item.quantidadeContada !== null ? (item.quantidadeContada - item.quantidadeTeorica) : '';
    const divVal = typeof diff === 'number' ? Math.abs(diff * item.custoMedio) : 0;
    csv += `"${item.codigo}";"${item.descricao}";"${item.deposito}";${item.quantidadeTeorica};${item.quantidadeContada !== null ? item.quantidadeContada : ''};${diff};${item.custoMedio};${divVal};"${item.operator || ''}";"${item.status}"\n`;
  });

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.setAttribute('download', `Inventario_${currentInventory ? currentInventory.code : 'JR_INVENT'}_Analitico.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

// --- AUDITORIA ---
async function loadAuditLogs() {
  try {
    const res = await fetch('./api/audit');
    const data = await res.json();
    const tbody = document.getElementById('tbl-audit-body');
    tbody.innerHTML = '';

    (data.logs || []).forEach(log => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${log.date} ${log.time}</td>
        <td><strong>${escapeHtml(log.user)}</strong></td>
        <td><span class="brand-badge">${log.role}</span></td>
        <td><strong>${escapeHtml(log.action)}</strong></td>
        <td>${escapeHtml(log.details)}</td>
      `;
      tbody.appendChild(tr);
    });
  } catch (err) {}
}

// --- IMPORTAÇÃO E GESTÃO ---
async function uploadNewExcel() {
  const fileInput = document.getElementById('file-excel-input');
  if (!fileInput.files || fileInput.files.length === 0) {
    alert('Selecione uma planilha Excel (.xlsx).');
    return;
  }

  const file = fileInput.files[0];
  try {
    const arrayBuffer = await file.arrayBuffer();
    const res = await fetch(`./api/upload-excel?name=${encodeURIComponent('Novo Inventário Excel')}&responsible=${encodeURIComponent(currentUser.name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: arrayBuffer
    });

    const data = await res.json();
    if (!res.ok) {
      alert(data.error || 'Erro ao importar planilha.');
      return;
    }

    alert('Planilha importada com sucesso! O algoritmo de limpeza formatou o depósito e iniciou a 1ª Contagem.');
    loadActiveInventory();
    switchTab('tab-contagem');
  } catch (err) {
    alert('Erro ao processar o arquivo.');
  }
}

async function confirmFinalizeInventory() {
  if (!currentInventory) return;
  if (!confirm('Deseja realmente finalizar este inventário? O inventário será bloqueado para novas contagens de operadores.')) {
    return;
  }

  try {
    const res = await fetch(`./api/inventories/${currentInventory.id}/finalize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: currentUser.name })
    });

    const data = await res.json();
    if (!res.ok) {
      alert(data.error || 'Erro ao finalizar.');
      return;
    }

    alert('Inventário finalizado e bloqueado com sucesso!');
    loadActiveInventory();
  } catch (err) {
    alert('Erro de comunicação.');
  }
}

function openReopenModal() {
  document.getElementById('reopen-modal').classList.add('active');
}

function closeReopenModal() {
  document.getElementById('reopen-modal').classList.remove('active');
}

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
    if (!res.ok) {
      alert(data.error || 'Senha incorreta.');
      return;
    }

    alert('Inventário reaberto com sucesso!');
    closeReopenModal();
    loadActiveInventory();
  } catch (err) {
    alert('Erro de conexão.');
  }
}

// --- UTILS ---
function formatBRL(val) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(val || 0);
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
