import {
  getActiveInventory,
  listInventories,
  startInventory,
  joinAsAuditor,
  subscribeToItems,
  subscribeToAuditorJoins,
  saveCount,
  addAdhocItem,
  approveDivergence,
  finalizeInventory,
  reopenInventory,
  addAuditLog,
  subscribeToAuditLogs,
  getDashboardMetrics,
  findDuplicateCandidates,
  mergeItems
} from "./data-service.js";

import { parseExcelFile } from "./excel_cleaner.js";

// ===================== ESTADO GLOBAL DA APLICAÇÃO =====================
let currentUser = null;          // { name, role, inventoryId, adminPassword }
let currentInventory = null;     // Documento completo do inventário ativo
let allItems = [];               // Coleção completa em tempo real sincronizada pelo Firestore
let filteredItems = [];          // Itens filtrados por busca, depósito e status
let renderedCount = 60;          // Paginação incremental para renderização suave
const RENDER_BATCH_SIZE = 60;
let currentStatusFilter = "Todos";
let selectedItemId = null;
let selectedItemExpectedVersion = 1;

let duplicateCandidates = [];
let dismissedPairIds = new Set();
let isManualMergeMode = false;
let manualMergeSelectedIds = [];
let currentMergePair = null;      // { itemA, itemB, survivorId }

let unsubscribeItems = null;
let unsubscribeJoins = null;
let unsubscribeAudit = null;
let pendingParsedExcel = null;
let historyInventoriesCache = [];

// ===================== INICIALIZAÇÃO =====================
document.addEventListener("DOMContentLoaded", () => {
  init();
  setupEventListeners();
});

async function init() {
  const saved = localStorage.getItem("jrinvent_session");
  if (saved) {
    try {
      currentUser = JSON.parse(saved);
    } catch (e) {
      localStorage.removeItem("jrinvent_session");
    }
  }

  try {
    const activeInv = await getActiveInventory();

    if (currentUser && activeInv && currentUser.inventoryId === activeInv.id) {
      currentInventory = activeInv;
      applyUserSession();
      bindInventorySubscriptions(activeInv.id);
      return;
    }

    // Se houver inventário ativo mas o usuário não tiver sessão válida para ele
    if (activeInv && !activeInv.isLocked) {
      currentInventory = activeInv;
      showAuditorJoinView(activeInv);
    } else {
      showStartInventoryView();
    }
  } catch (err) {
    console.error("Erro na inicialização:", err);
    showStartInventoryView();
  }
}

function setupEventListeners() {
  // Form Auditor Join
  const formAuditor = document.getElementById("form-auditor-join");
  if (formAuditor) {
    formAuditor.addEventListener("submit", async (e) => {
      e.preventDefault();
      const name = document.getElementById("auditor-name-input").value.trim();
      if (!name) return;

      if (!currentInventory) {
        alert("Nenhum inventário ativo encontrado.");
        return;
      }

      currentUser = {
        name: name,
        role: "operator",
        inventoryId: currentInventory.id
      };
      localStorage.setItem("jrinvent_session", JSON.stringify(currentUser));

      try {
        await joinAsAuditor({ name: name, inventoryId: currentInventory.id });
      } catch (err) {
        console.warn("Entrada gravada em cache offline.");
      }

      document.getElementById("start-modal").classList.remove("active");
      applyUserSession();
      bindInventorySubscriptions(currentInventory.id);
    });
  }

  // Form Admin Start
  const formAdmin = document.getElementById("form-admin-start");
  if (formAdmin) {
    formAdmin.addEventListener("submit", async (e) => {
      e.preventDefault();
      const adminName = document.getElementById("admin-name-input").value.trim();
      const adminPassword = document.getElementById("admin-password-input").value.trim();
      const invName = document.getElementById("admin-inv-name-input").value.trim();
      const fileInput = document.getElementById("admin-excel-file");

      if (!adminName || !adminPassword) {
        alert("Preencha o nome do administrador e a senha de atestado.");
        return;
      }

      if (fileInput.files && fileInput.files.length > 0) {
        try {
          const parsed = await parseExcelFile(fileInput.files[0]);
          pendingParsedExcel = {
            adminName,
            adminPassword,
            inventoryName: invName,
            items: parsed.items,
            summary: parsed.summary
          };
          openImportPreviewModal(parsed.summary);
        } catch (err) {
          alert("Erro ao ler a planilha: " + err.message);
        }
      } else {
        // Criar sem itens importados
        try {
          const newInv = await startInventory({
            adminName,
            adminPassword,
            inventoryName: invName,
            items: []
          });
          currentUser = {
            name: adminName,
            role: "admin",
            inventoryId: newInv.id,
            adminPassword: adminPassword
          };
          currentInventory = newInv;
          localStorage.setItem("jrinvent_session", JSON.stringify(currentUser));
          document.getElementById("start-modal").classList.remove("active");
          applyUserSession();
          bindInventorySubscriptions(newInv.id);
        } catch (err) {
          if (err.message === "INVENTARIO_JA_ATIVO") {
            const activeCode = err.activeInventory?.code || "já em andamento";
            alert(`⚠️ Já existe um inventário em andamento (${activeCode})!\n\nSe você é o responsável por este inventário, utilize a opção "Sou o Administrador deste inventário" na tela inicial para retomar o acesso.`);
            if (err.activeInventory) {
              currentInventory = err.activeInventory;
            }
            showAuditorJoinView(err.activeInventory);
          } else {
            alert("Erro ao iniciar inventário: " + err.message);
          }
        }
      }
    });
  }

  // Observador de rolagem infinita para paginação incremental
  const loadMoreContainer = document.getElementById("load-more-container");
  if (loadMoreContainer && "IntersectionObserver" in window) {
    const observer = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && loadMoreContainer.style.display !== "none") {
        window.loadMoreItems();
      }
    }, { rootMargin: "250px" });
    observer.observe(loadMoreContainer);
  }
}

// ===================== TELAS DE IDENTIFICAÇÃO =====================
window.showAuditorJoinView = function(inv) {
  const modal = document.getElementById("start-modal");
  const viewAuditor = document.getElementById("view-auditor-join");
  const viewAdmin = document.getElementById("view-admin-start");
  const viewHistory = document.getElementById("view-history");
  const backBtn = document.getElementById("btn-back-to-join-container");

  const targetInv = inv || currentInventory;
  if (targetInv) {
    document.getElementById("join-inv-title").textContent = `${targetInv.code} - ${targetInv.name || "Inventário"}`;
    document.getElementById("join-inv-responsible").textContent = `Responsável: ${targetInv.responsible || "Administrador"}`;
  }

  viewAuditor.style.display = "block";
  viewAdmin.style.display = "none";
  if (viewHistory) viewHistory.style.display = "none";
  if (backBtn) backBtn.style.display = "none";
  modal.classList.add("active");
};
window.showJoinAsAuditorForm = window.showAuditorJoinView;

window.handleAdminReentry = async function() {
  if (!currentInventory) {
    alert("Nenhum inventário ativo encontrado.");
    return;
  }

  const pass = prompt("Informe a senha de atestado do Administrador:");
  if (pass === null) return;
  const trimmedPass = (pass || "").trim();

  if (!trimmedPass || (currentInventory.adminPassword && trimmedPass !== String(currentInventory.adminPassword).trim())) {
    alert("Senha incorreta.");
    return;
  }

  const name = prompt("Informe seu nome completo para registro:", currentInventory.responsible || "");
  if (name === null) return;
  const trimmedName = (name || "").trim();
  if (!trimmedName) {
    alert("Informe seu nome para prosseguir.");
    return;
  }

  currentUser = {
    name: trimmedName,
    role: "admin",
    inventoryId: currentInventory.id,
    adminPassword: trimmedPass
  };
  localStorage.setItem("jrinvent_session", JSON.stringify(currentUser));

  try {
    await addAuditLog(currentInventory.id, {
      user: currentUser.name,
      role: "admin",
      action: "Reentrada de Administrador",
      details: `${currentUser.name} reentrou como Administrador do inventário ${currentInventory.code}.`
    });
  } catch (err) {
    console.warn("Log de reentrada gravado offline:", err);
  }

  document.getElementById("start-modal").classList.remove("active");
  applyUserSession();
  bindInventorySubscriptions(currentInventory.id);
  showToast(`🔑 Bem-vindo de volta, Administrador ${currentUser.name}!`);
};

window.showStartInventoryView = function() {
  const modal = document.getElementById("start-modal");
  const viewAuditor = document.getElementById("view-auditor-join");
  const viewAdmin = document.getElementById("view-admin-start");
  const viewHistory = document.getElementById("view-history");
  const backBtn = document.getElementById("btn-back-to-join-container");

  viewAuditor.style.display = "none";
  viewAdmin.style.display = "block";
  if (viewHistory) viewHistory.style.display = "none";
  if (backBtn && currentInventory) backBtn.style.display = "block";
  modal.classList.add("active");
};
window.showStartInventoryForm = window.showStartInventoryView;

// ===================== INVENTÁRIOS ANTERIORES (REACESSO SEM CRIAR NOVO) =====================
// Permite ao Administrador reacessar um inventário já existente (inclusive finalizado)
// sem precisar iniciar um novo ciclo — por exemplo, para tirar outra via do relatório
// ou corrigir/editar um inventário que já foi encerrado.
window.showInventoryHistoryView = async function() {
  const modal = document.getElementById("start-modal");
  const viewAuditor = document.getElementById("view-auditor-join");
  const viewAdmin = document.getElementById("view-admin-start");
  const viewHistory = document.getElementById("view-history");

  if (viewAuditor) viewAuditor.style.display = "none";
  if (viewAdmin) viewAdmin.style.display = "none";
  if (viewHistory) viewHistory.style.display = "block";
  modal.classList.add("active");

  const listEl = document.getElementById("history-inv-list");
  if (listEl) {
    listEl.innerHTML = `<p style="text-align:center; color:var(--text-muted); font-size:0.85rem; padding:16px 0;">Carregando inventários...</p>`;
  }

  try {
    historyInventoriesCache = await listInventories();
    renderHistoryList();
  } catch (err) {
    if (listEl) {
      listEl.innerHTML = `<p style="text-align:center; color:var(--danger); font-size:0.85rem;">Erro ao carregar inventários: ${escapeHtml(err.message)}</p>`;
    }
  }
};

window.closeHistoryView = function() {
  const viewHistory = document.getElementById("view-history");
  if (viewHistory) viewHistory.style.display = "none";

  if (currentInventory && currentUser) {
    document.getElementById("start-modal").classList.remove("active");
  } else if (currentInventory) {
    showAuditorJoinView(currentInventory);
  } else {
    showStartInventoryView();
  }
};

window.renderHistoryList = function() {
  const q = (document.getElementById("history-search-input")?.value || "").toLowerCase().trim();
  const listEl = document.getElementById("history-inv-list");
  if (!listEl) return;

  const filtered = historyInventoriesCache.filter(inv => {
    if (!q) return true;
    return (inv.code || "").toLowerCase().includes(q)
      || (inv.name || "").toLowerCase().includes(q)
      || (inv.responsible || "").toLowerCase().includes(q);
  });

  if (filtered.length === 0) {
    listEl.innerHTML = `<p style="text-align:center; color:var(--text-muted); font-size:0.85rem; padding:20px 0;">Nenhum inventário encontrado.</p>`;
    return;
  }

  listEl.innerHTML = "";
  filtered.forEach(inv => {
    const isFinal = inv.status === "Finalizado";
    const statusColor = isFinal ? "var(--text-muted)" : "var(--success)";
    const dateStr = inv.startDate ? new Date(inv.startDate).toLocaleDateString("pt-BR") : "--";

    const card = document.createElement("div");
    card.className = "mobile-list-card";
    card.style.cursor = "pointer";
    card.onclick = () => window.selectHistoricalInventory(inv.id);
    card.innerHTML = `
      <div class="row" style="justify-content: space-between;">
        <strong style="font-size:0.92rem; color:var(--primary);">${escapeHtml(inv.code)}</strong>
        <span style="font-size:0.72rem; font-weight:700; color:${statusColor};">${escapeHtml(inv.status || "--")}</span>
      </div>
      <div style="font-size:0.8rem; color:var(--text-main); margin-top:2px;">${escapeHtml(inv.name || "Sem nome")}</div>
      <div style="font-size:0.75rem; color:var(--text-muted); margin-top:2px;">👤 ${escapeHtml(inv.responsible || "--")} · 📅 ${dateStr} · 📦 ${inv.itemsCount ?? "--"} itens</div>
    `;
    listEl.appendChild(card);
  });
};

window.selectHistoricalInventory = async function(invId) {
  const inv = historyInventoriesCache.find(i => i.id === invId);
  if (!inv) return;

  const pass = prompt(`Informe a senha de atestado do Administrador para acessar o inventário ${inv.code}:`);
  if (pass === null) return;
  const trimmedPass = (pass || "").trim();
  if (!trimmedPass || (inv.adminPassword && trimmedPass !== String(inv.adminPassword).trim())) {
    alert("Senha incorreta.");
    return;
  }

  const name = prompt("Informe seu nome completo para registro:", (currentUser && currentUser.name) || inv.responsible || "");
  if (name === null) return;
  const trimmedName = (name || "").trim();
  if (!trimmedName) {
    alert("Informe seu nome para prosseguir.");
    return;
  }

  if (unsubscribeItems) { unsubscribeItems(); unsubscribeItems = null; }
  if (unsubscribeJoins) { unsubscribeJoins(); unsubscribeJoins = null; }
  if (unsubscribeAudit) { unsubscribeAudit(); unsubscribeAudit = null; }

  currentUser = {
    name: trimmedName,
    role: "admin",
    inventoryId: inv.id,
    adminPassword: trimmedPass
  };
  localStorage.setItem("jrinvent_session", JSON.stringify(currentUser));
  currentInventory = inv;

  try {
    await addAuditLog(inv.id, {
      user: trimmedName,
      role: "admin",
      action: "Acesso a Inventário Anterior",
      details: `${trimmedName} reacessou o inventário ${inv.code} (status: ${inv.status}) pela tela de Inventários Anteriores, sem criar um novo inventário.`
    });
  } catch (err) {
    console.warn("Log de acesso ao histórico gravado offline:", err);
  }

  document.getElementById("start-modal").classList.remove("active");
  applyUserSession();
  bindInventorySubscriptions(inv.id);
  showToast(`📂 Inventário ${inv.code} carregado com sucesso!`);
  selectMenuItem("tab-relatorios", null);
};

function applyUserSession() {
  if (!currentUser) return;
  const nameEl = document.getElementById("drawer-user-name");
  if (nameEl) {
    nameEl.textContent = `${currentUser.name} (${currentUser.role === "admin" ? "Admin" : "Auditor"})`;
  }

  // Oculta/exibe abas restritas de administrador
  document.querySelectorAll(".admin-only").forEach(el => {
    el.style.display = currentUser.role === "admin" ? "" : "none";
  });

  updateHeaderInventoryInfo();
}

function updateHeaderInventoryInfo() {
  if (!currentInventory) return;
  const codeEl = document.getElementById("hdr-inv-code");
  const statusEl = document.getElementById("lbl-inv-status");
  if (codeEl) codeEl.textContent = currentInventory.code;
  if (statusEl) {
    const scopeStr = (currentInventory.scopeFilter && currentInventory.scopeFilter !== "Geral")
      ? ` · Escopo: ${currentInventory.scopeFilter}`
      : "";
    statusEl.textContent = `${currentInventory.code} · ${currentInventory.status}${scopeStr}`;
  }
}

window.logout = function() {
  if (confirm("Deseja trocar de operador ou sair da sessão atual?")) {
    if (unsubscribeItems) { unsubscribeItems(); unsubscribeItems = null; }
    if (unsubscribeJoins) { unsubscribeJoins(); unsubscribeJoins = null; }
    if (unsubscribeAudit) { unsubscribeAudit(); unsubscribeAudit = null; }

    currentUser = null;
    localStorage.removeItem("jrinvent_session");
    closeDrawer();
    init();
  }
};

// ===================== SINCRONIZAÇÃO EM TEMPO REAL =====================
function bindInventorySubscriptions(inventoryId) {
  if (unsubscribeItems) unsubscribeItems();
  if (unsubscribeJoins) unsubscribeJoins();

  // Assinatura da subcoleção de itens
  unsubscribeItems = subscribeToItems(inventoryId, (items, metadata) => {
    allItems = items;
    updateDepositsDropdown();
    applyFiltersAndRender();
    updateWifiSyncStatus(metadata);
  });

  // Notificação para o Admin quando auditores entram
  if (currentUser && currentUser.role === "admin") {
    unsubscribeJoins = subscribeToAuditorJoins(inventoryId, (joinData) => {
      showToast(`🟢 ${joinData.user} entrou no inventário`);
      if (navigator.vibrate) navigator.vibrate([80, 50, 80]);
    });
  }
}

function updateWifiSyncStatus(metadata) {
  const chip = document.getElementById("hdr-wifi-status");
  const text = document.getElementById("wifi-text");
  if (!chip || !text) return;

  const isFromCache = metadata ? metadata.fromCache : false;
  if (isFromCache) {
    chip.className = "info-chip wifi-offline";
    text.textContent = "Offline (Cache)";
  } else {
    chip.className = "info-chip wifi-online";
    text.textContent = "Sincronizado";
  }
}

// ===================== DRAWER LATERAL E NAVEGAÇÃO =====================
window.toggleDrawer = function() {
  const drawer = document.getElementById("side-drawer");
  const backdrop = document.getElementById("drawer-backdrop");
  drawer.classList.toggle("open");
  backdrop.classList.toggle("open");
};

window.closeDrawer = function() {
  document.getElementById("side-drawer").classList.remove("open");
  document.getElementById("drawer-backdrop").classList.remove("open");
};

window.selectMenuItem = function(tabId, clickedBtn) {
  closeDrawer();
  switchTab(tabId);
  document.querySelectorAll(".drawer-item").forEach(btn => btn.classList.remove("active"));
  if (clickedBtn) clickedBtn.classList.add("active");
};

window.switchTab = function(tabId) {
  document.querySelectorAll(".tab-pane").forEach(p => p.style.display = "none");
  const pane = document.getElementById(tabId);
  if (pane) pane.style.display = "block";

  if (tabId === "tab-dashboard") refreshDashboard();
  if (tabId === "tab-terceira-contagem") renderDivergencesCards();
  if (tabId === "tab-duplicados") loadDuplicateCandidates();
  if (tabId === "tab-relatorios") renderReportsData();
  if (tabId === "tab-auditoria") setupAuditSubscription();
};

// ===================== FILTROS E BUSCA =====================
window.onSearchChange = function() {
  renderedCount = RENDER_BATCH_SIZE;
  applyFiltersAndRender();
};

window.onFilterChange = function() {
  const dep = document.getElementById("select-deposito").value;
  const lbl = document.getElementById("lbl-current-deposito");
  if (lbl) lbl.textContent = dep === "Todos" ? "Todos" : dep;
  renderedCount = RENDER_BATCH_SIZE;
  applyFiltersAndRender();
};

window.setStatusFilter = function(status, btn) {
  currentStatusFilter = status;
  document.querySelectorAll(".pill-btn").forEach(b => b.classList.remove("active"));
  if (btn) btn.classList.add("active");
  renderedCount = RENDER_BATCH_SIZE;
  applyFiltersAndRender();
};

function updateDepositsDropdown() {
  const select = document.getElementById("select-deposito");
  if (!select) return;
  const currentVal = select.value;
  const activeItems = allItems.filter(i => !i.mesclado);
  const depositsSet = new Set(activeItems.map(i => i.deposito || "Almoxarifado Principal"));
  const sorted = Array.from(depositsSet).sort();

  select.innerHTML = '<option value="Todos">🏬 Todos os Depósitos</option>';
  sorted.forEach(dep => {
    const opt = document.createElement("option");
    opt.value = dep;
    opt.textContent = `📍 ${dep}`;
    if (dep === currentVal) opt.selected = true;
    select.appendChild(opt);
  });
}

function applyFiltersAndRender() {
  const q = (document.getElementById("search-input")?.value || "").toLowerCase().trim();
  const dep = document.getElementById("select-deposito")?.value || "Todos";

  // Filtra itens mesclados (mesclado === true) para que nunca apareçam na contagem
  filteredItems = allItems.filter(item => {
    if (item.mesclado) return false;
    if (dep !== "Todos" && item.deposito !== dep) return false;

    if (currentStatusFilter === "Pendentes" && item.status !== "nao_contado") return false;
    if (currentStatusFilter === "Sem Divergência" && item.status !== "sem_divergencia") return false;
    if (currentStatusFilter === "Divergentes" && item.status !== "divergencia") return false;

    if (q) {
      const c = (item.codigo || "").toLowerCase().includes(q);
      const d = (item.descricao || "").toLowerCase().includes(q);
      const s = (item.deposito || "").toLowerCase().includes(q);
      if (!c && !d && !s) return false;
    }
    return true;
  });

  updateBadgesAndCounters();
  renderProducts();
}

function updateBadgesAndCounters() {
  const activeItems = allItems.filter(i => !i.mesclado);
  const total = activeItems.length;
  const pending = activeItems.filter(i => i.status === "nao_contado").length;
  const diverg = activeItems.filter(i => i.status === "divergencia").length;

  const pendingEl = document.getElementById("hdr-pending-count");
  if (pendingEl) pendingEl.textContent = pending;

  const badgeAll = document.getElementById("tab-badge-all");
  const badgeDiv = document.getElementById("tab-badge-div");
  if (badgeAll) badgeAll.textContent = total;
  if (badgeDiv) badgeDiv.textContent = diverg;

  const badgeDup = document.getElementById("tab-badge-duplicates");
  if (badgeDup) {
    const activeCandidates = duplicateCandidates.filter(c => 
      !dismissedPairIds.has(c.pairId) && !c.itemA.mesclado && !c.itemB.mesclado
    );
    badgeDup.textContent = activeCandidates.length;
  }
}

// ===================== RENDERIZAÇÃO DE PRODUTOS (CONTAGEM CEGA + PAGINAÇÃO) =====================
function renderProducts() {
  const container = document.getElementById("product-grid");
  if (!container) return;
  container.innerHTML = "";

  if (filteredItems.length === 0) {
    container.innerHTML = `
      <div style="grid-column:1/-1; text-align:center; padding:40px; color:var(--text-muted);">
        <p style="font-size:1.1rem; font-weight:700;">Nenhum produto encontrado.</p>
      </div>`;
    toggleLoadMoreBtn(0);
    return;
  }

  const limit = Math.min(filteredItems.length, renderedCount);

  for (let i = 0; i < limit; i++) {
    const item = filteredItems[i];
    const isSelectedForMerge = isManualMergeMode && manualMergeSelectedIds.includes(item.id);

    const card = document.createElement("div");
    card.className = `product-card ${isManualMergeMode ? "merge-selectable" : ""} ${isSelectedForMerge ? "merge-selected" : ""}`;
    
    if (isManualMergeMode) {
      card.onclick = (e) => {
        e.stopPropagation();
        selectItemForMerge(item.id);
      };
    } else {
      card.onclick = () => openCountModal(item.id);
    }

    const statusMap = {
      nao_contado:     { label: "Não contado",    cls: "gray" },
      em_contagem:     { label: "Em contagem",    cls: "blue" },
      sem_divergencia: { label: "Contado",        cls: "green" },
      divergencia:     { label: "Divergência",    cls: "red" }
    };
    const st = statusMap[item.status] || statusMap["nao_contado"];

    let badgesHtml = `<span class="status-badge ${st.cls}">${st.label}</span>`;
    if (item.naoEncontrado) {
      badgesHtml += ` <span class="badge-nonlocated">❌ Não localizado</span>`;
    }
    if (item.itemAvulso) {
      badgesHtml += ` <span class="badge-adhoc">➕ Não cadastrado</span>`;
    }
    if (item._pendingSync) {
      badgesHtml += ` <span class="sync-pending-badge" title="Pendente de envio para o servidor">⏳ Pendente de envio</span>`;
    }

    let checkboxHtml = "";
    if (isManualMergeMode) {
      checkboxHtml = `<input type="checkbox" class="item-select-checkbox" ${isSelectedForMerge ? "checked" : ""} onclick="event.stopPropagation(); selectItemForMerge('${item.id}')">`;
    }

    // CONTAGEM CEGA: Não exibe o saldo teórico nem custo na grade de contagem
    card.innerHTML = `
      ${checkboxHtml}
      <div class="card-header">
        <span class="product-code">${escapeHtml(item.codigo)}</span>
        <div style="display:flex; gap:4px; flex-wrap:wrap; justify-content:flex-end;">
          ${badgesHtml}
        </div>
      </div>
      <div class="product-desc">${escapeHtml(item.descricao)}</div>
      <div style="font-size:0.75rem; color:var(--text-muted); margin-bottom:6px;">📍 ${escapeHtml(item.deposito)}</div>
      <div class="card-details">
        <div>Contado: <strong style="color:var(--primary); font-size:1rem;">${item.quantidadeContada !== null ? item.quantidadeContada : "--"}</strong></div>
        <div style="font-size:0.75rem; color:var(--text-muted);">${item.operator ? `Por: ${escapeHtml(item.operator)}` : ""}</div>
      </div>`;

    container.appendChild(card);
  }

  toggleLoadMoreBtn(filteredItems.length - limit);
}

function toggleLoadMoreBtn(remaining) {
  const loadMoreContainer = document.getElementById("load-more-container");
  const loadMoreCount = document.getElementById("load-more-count");
  if (!loadMoreContainer) return;

  if (remaining > 0) {
    loadMoreContainer.style.display = "block";
    if (loadMoreCount) loadMoreCount.textContent = remaining;
  } else {
    loadMoreContainer.style.display = "none";
  }
}

window.loadMoreItems = function() {
  renderedCount += RENDER_BATCH_SIZE;
  renderProducts();
};

// ===================== MODAL DE CONTAGEM CEGA =====================
window.openCountModal = function(itemId) {
  if (currentInventory && currentInventory.isLocked) {
    // Operadores continuam bloqueados. O Administrador pode reabrir a edição pontual
    // de um item mesmo com o inventário finalizado (ex.: corrigir um relatório já encerrado).
    if (!currentUser || currentUser.role !== "admin") {
      alert("Este inventário está finalizado e bloqueado para edições.");
      return;
    }
    if (!confirm("Este inventário já está FINALIZADO. Deseja realmente editar a contagem deste item mesmo assim? A alteração ficará registrada na auditoria.")) {
      return;
    }
  }

  const item = allItems.find(i => i.id === itemId);
  if (!item) return;

  selectedItemId = itemId;
  selectedItemExpectedVersion = item.version || 1;

  document.getElementById("modal-product-code").textContent = item.codigo;
  document.getElementById("modal-product-desc").textContent = item.descricao;
  document.getElementById("modal-product-deposito").textContent = `📍 ${item.deposito}`;
  document.getElementById("count-qty-input").value = item.quantidadeContada !== null ? item.quantidadeContada : "";
  document.getElementById("count-obs-input").value = item.observacao || "";

  document.getElementById("count-modal").classList.add("active");
  setTimeout(() => {
    const input = document.getElementById("count-qty-input");
    if (input) input.focus();
  }, 100);
};

window.closeCountModal = function() {
  document.getElementById("count-modal").classList.remove("active");
  selectedItemId = null;
};

window.stepCount = function(step) {
  const input = document.getElementById("count-qty-input");
  const cur = parseFloat(input.value) || 0;
  input.value = Math.max(0, cur + step);
};

window.numpadPress = function(val) {
  const input = document.getElementById("count-qty-input");
  if (val === "C") input.value = "";
  else if (val === "DEL") input.value = input.value.slice(0, -1);
  else input.value = (input.value || "") + val;
};

// Salvar contagem física com controle de concorrência e avanço automático
window.submitCount = async function() {
  if (!selectedItemId || !currentInventory) return;
  const inputVal = document.getElementById("count-qty-input").value;
  const obsVal = document.getElementById("count-obs-input").value.trim();

  if (inputVal === "" || isNaN(parseFloat(inputVal))) {
    alert("Informe uma quantidade contada válida.");
    return;
  }

  const countedQty = parseFloat(inputVal);
  const operatorName = currentUser ? currentUser.name : "Auditor";
  const currentSavedItemId = selectedItemId;

  try {
    await saveCount(currentInventory.id, currentSavedItemId, {
      quantidadeContada: countedQty,
      operator: operatorName,
      observacao: obsVal,
      expectedVersion: selectedItemExpectedVersion,
      naoEncontrado: false
    });

    // Feedback tátil
    if (navigator.vibrate) navigator.vibrate(80);

    if (currentInventory.isLocked) {
      addAuditLog(currentInventory.id, {
        user: operatorName,
        role: currentUser ? currentUser.role : "admin",
        action: "Edição em Inventário Finalizado",
        details: `Contagem do item ${currentSavedItemId} foi alterada após a finalização do inventário.`
      }).catch(() => {});
    }

    // Volta para a tela inicial de contagem do depósito, sem avançar automaticamente
    // (os itens podem não estar dispostos fisicamente em sequência no depósito)
    closeCountModal();
    showToast("✅ Contagem registrada com sucesso!");
  } catch (err) {
    if (err.message === "CONFLITO") {
      alert("⚠️ Atenção: Outro auditor atualizou este item enquanto seu modal estava aberto. O valor foi recarregado para sua conferência.");
      const updated = err.currentItem;
      if (updated) {
        selectedItemExpectedVersion = updated.version;
        document.getElementById("count-qty-input").value = updated.quantidadeContada ?? "";
      }
    } else {
      alert("Erro ao gravar contagem: " + err.message);
    }
  }
};

// Salvar como não localizado no depósito
window.submitNonLocated = async function() {
  if (!selectedItemId || !currentInventory) return;
  const obsVal = document.getElementById("count-obs-input").value.trim();
  const operatorName = currentUser ? currentUser.name : "Auditor";
  const currentSavedItemId = selectedItemId;

  if (confirm("Confirmar que este produto não foi localizado no depósito?")) {
    try {
      await saveCount(currentInventory.id, currentSavedItemId, {
        quantidadeContada: 0,
        operator: operatorName,
        observacao: obsVal || "Item não localizado no depósito",
        expectedVersion: selectedItemExpectedVersion,
        naoEncontrado: true
      });

      if (navigator.vibrate) navigator.vibrate(80);

      if (currentInventory.isLocked) {
        addAuditLog(currentInventory.id, {
          user: operatorName,
          role: currentUser ? currentUser.role : "admin",
          action: "Edição em Inventário Finalizado",
          details: `Item ${currentSavedItemId} foi marcado como não localizado após a finalização do inventário.`
        }).catch(() => {});
      }

      // Volta para a tela inicial de contagem do depósito, sem avançar automaticamente
      closeCountModal();
      showToast("✅ Item registrado como não localizado.");
    } catch (err) {
      alert("Erro ao gravar item como não localizado: " + err.message);
    }
  }
};

// ===================== ITEM NÃO CADASTRADO (FORA DA PLANILHA) =====================
window.openAdhocItemModal = function() {
  document.getElementById("adhoc-code-input").value = "";
  document.getElementById("adhoc-desc-input").value = "";
  document.getElementById("adhoc-deposito-input").value = document.getElementById("select-deposito")?.value !== "Todos" ? document.getElementById("select-deposito").value : "";
  document.getElementById("adhoc-qty-input").value = "1";
  document.getElementById("adhoc-item-modal").classList.add("active");
};

window.closeAdhocItemModal = function() {
  document.getElementById("adhoc-item-modal").classList.remove("active");
};

function findSimilarItem(items, { codigo, descricao, deposito }) {
  const codeNorm = (codigo || "").toLowerCase().trim();
  const descNorm = (descricao || "").toLowerCase().trim();
  const depNorm = (deposito || "").toLowerCase().trim();

  // 1. Busca por código idêntico
  if (codeNorm && codeNorm !== "avulso" && !codeNorm.startsWith("avulso-")) {
    const byCode = items.find(i => (i.codigo || "").toLowerCase().trim() === codeNorm);
    if (byCode) return byCode;
  }

  // 2. Busca por descrição no mesmo depósito
  if (descNorm.length >= 3) {
    const exactDescDep = items.find(i => 
      (i.descricao || "").toLowerCase().trim() === descNorm &&
      (i.deposito || "").toLowerCase().trim() === depNorm
    );
    if (exactDescDep) return exactDescDep;

    const partialDescDep = items.find(i => {
      const iDesc = (i.descricao || "").toLowerCase().trim();
      const iDep = (i.deposito || "").toLowerCase().trim();
      return iDep === depNorm && (iDesc.includes(descNorm) || descNorm.includes(iDesc));
    });
    if (partialDescDep) return partialDescDep;

    const exactDescAny = items.find(i => (i.descricao || "").toLowerCase().trim() === descNorm);
    if (exactDescAny) return exactDescAny;
  }

  return null;
}

window.submitAdhocItem = async function() {
  if (!currentInventory) return;
  const codigo = document.getElementById("adhoc-code-input").value.trim();
  const desc = document.getElementById("adhoc-desc-input").value.trim();
  const dep = document.getElementById("adhoc-deposito-input").value.trim();
  const qty = parseFloat(document.getElementById("adhoc-qty-input").value);

  if (!desc || !dep || isNaN(qty) || qty <= 0) {
    alert("Preencha descrição, depósito e uma quantidade válida.");
    return;
  }

  // Prevenção de duplicidade: verificação prévia antes de criar
  const similar = findSimilarItem(allItems, { codigo, descricao: desc, deposito: dep });
  if (similar) {
    const confirmMsg = `Já existe um item parecido: [${similar.codigo} - ${similar.descricao} (${similar.deposito})] — confirma que quer criar um novo mesmo assim?`;
    if (!confirm(confirmMsg)) {
      return;
    }
  }

  try {
    await addAdhocItem(currentInventory.id, {
      codigo: codigo,
      descricao: desc,
      deposito: dep,
      quantidadeContada: qty,
      operator: currentUser ? currentUser.name : "Auditor"
    });

    if (navigator.vibrate) navigator.vibrate(80);
    closeAdhocItemModal();
    showToast("➕ Item não cadastrado registrado com sucesso!");
  } catch (err) {
    alert("Erro ao adicionar item: " + err.message);
  }
};

// ===================== TERCEIRA CONTAGEM (DIVERGÊNCIAS - ADMIN) =====================
function renderDivergencesCards() {
  const container = document.getElementById("divergences-mobile-list");
  if (!container) return;

  // Apenas itens divergentes e que NÃO foram absorvidos por mesclagem
  const divItems = allItems.filter(i => i.status === "divergencia" && !i.mesclado);

  if (divItems.length === 0) {
    container.innerHTML = `
      <div style="text-align:center; padding:40px; color:var(--success);">
        <p style="font-size:1.1rem; font-weight:700;">🎉 Nenhuma divergência pendente!</p>
      </div>`;
    return;
  }

  container.innerHTML = "";
  divItems.forEach(item => {
    const diff = (item.quantidadeContada || 0) - (item.quantidadeTeorica || 0);
    const diffColor = diff < 0 ? "var(--danger)" : "var(--info)";

    let badgesHtml = `<span class="badge badge-danger">Divergência</span>`;
    if (item.naoEncontrado) {
      badgesHtml += ` <span class="badge-nonlocated">❌ Não localizado</span>`;
    }
    if (item.itemAvulso) {
      badgesHtml += ` <span class="badge-adhoc">➕ Não cadastrado</span>`;
    }

    const card = document.createElement("div");
    card.className = "mobile-list-card card-diverge";
    card.innerHTML = `
      <div class="row">
        <strong>${escapeHtml(item.codigo)}</strong>
        <div style="display:flex; gap:4px; flex-wrap:wrap; justify-content:flex-end;">
          ${badgesHtml}
        </div>
      </div>
      <div style="font-size:0.85rem; margin-bottom:8px; color:var(--text-muted);">${escapeHtml(item.descricao)}</div>
      <div style="font-size:0.82rem; margin-bottom:4px; color:var(--text-muted);">📍 ${escapeHtml(item.deposito)}</div>
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-bottom:10px; background:var(--bg-main); padding:8px; border-radius:6px;">
        <div style="font-size:0.82rem;">Teórico: <strong>${item.quantidadeTeorica}</strong></div>
        <div style="font-size:0.82rem; color:${diffColor};">Diferença: <strong>${diff > 0 ? "+" : ""}${diff}</strong></div>
      </div>
      <div style="margin-bottom:8px;">
        <label style="font-size:0.75rem; font-weight:700; display:block; margin-bottom:3px;">Qtd Final Reverificada</label>
        <input type="number" id="div-qty-${item.id}" value="${item.quantidadeContada ?? 0}" class="search-input" style="padding:8px;">
      </div>
      <div style="margin-bottom:10px;">
        <label style="font-size:0.75rem; font-weight:700; display:block; margin-bottom:3px;">Senha de Atestado Admin</label>
        <input type="password" id="div-pass-${item.id}" placeholder="Senha do Admin..." class="search-input" style="padding:8px;">
      </div>
      <button class="btn-large btn-primary" onclick="handleApproveDivergence('${item.id}')" style="width:100%; min-height:42px; font-size:0.9rem;">
        ✅ Reverificar e Liberar Divergência
      </button>`;
    container.appendChild(card);
  });
}

window.handleApproveDivergence = async function(itemId) {
  if (!currentInventory) return;
  const qtyInput = document.getElementById(`div-qty-${itemId}`);
  const passInput = document.getElementById(`div-pass-${itemId}`);

  const qty = parseFloat(qtyInput.value);
  const pass = passInput.value.trim();

  if (isNaN(qty)) { alert("Informe a quantidade reverificada."); return; }
  if (!pass) { alert("Insira a senha de atestado do Administrador."); return; }

  // Comparação local com a senha do inventário ativo carregado
  if (currentInventory.adminPassword && pass !== String(currentInventory.adminPassword).trim()) {
    alert("Senha de atestado incorreta.");
    return;
  }

  try {
    // A validação da senha de atestado, junto com a quantidade final informada,
    // já caracteriza a reverificação — não é mais exigida uma justificativa manual.
    await approveDivergence(currentInventory.id, itemId, {
      quantidadeContada: qty,
      justification: "Reverificado e atestado pelo Administrador mediante validação da senha de atestado.",
      adminUser: currentUser ? currentUser.name : (currentInventory.responsible || "Admin"),
      adminPassword: pass
    });

    showToast("✅ Item reverificado e divergência liberada!");
    renderDivergencesCards();
  } catch (err) {
    alert("Erro ao aprovar divergência: " + err.message);
  }
};

// ===================== ITENS DUPLICADOS (DETECÇÃO E MESCLAGEM) =====================
window.loadDuplicateCandidates = async function() {
  if (!currentInventory) return;
  const container = document.getElementById("duplicates-mobile-list");
  if (!container) return;

  container.innerHTML = `
    <div style="text-align:center; padding:30px; color:var(--text-muted);">
      <p>🔍 Analisando itens do inventário para sugerir duplicidades...</p>
    </div>`;

  try {
    duplicateCandidates = await findDuplicateCandidates(currentInventory.id);
    updateBadgesAndCounters();
    renderDuplicateCards(duplicateCandidates);
  } catch (err) {
    container.innerHTML = `<div style="text-align:center; padding:30px; color:var(--danger);"><p>Erro ao buscar duplicados: ${escapeHtml(err.message)}</p></div>`;
  }
};

function renderDuplicateCards(candidates) {
  const container = document.getElementById("duplicates-mobile-list");
  if (!container) return;

  const validCandidates = candidates.filter(c => {
    if (dismissedPairIds.has(c.pairId)) return false;
    // Checa se algum item do par já foi mesclado
    const itemA = allItems.find(i => i.id === c.itemA.id);
    const itemB = allItems.find(i => i.id === c.itemB.id);
    if (itemA?.mesclado || itemB?.mesclado) return false;
    return true;
  });

  if (validCandidates.length === 0) {
    container.innerHTML = `
      <div style="text-align:center; padding:40px; color:var(--success);">
        <p style="font-size:1.1rem; font-weight:700;">🎉 Nenhuma duplicidade suspeita encontrada!</p>
        <p style="font-size:0.85rem; color:var(--text-muted); margin-top:4px;">Todos os itens ativos possuem códigos e descrições distintos.</p>
      </div>`;
    return;
  }

  container.innerHTML = "";
  validCandidates.forEach(cand => {
    // Busca dados em tempo real mais recentes do array sincronizado
    const itemA = allItems.find(i => i.id === cand.itemA.id) || cand.itemA;
    const itemB = allItems.find(i => i.id === cand.itemB.id) || cand.itemB;

    const countA = itemA.quantidadeContada !== null ? itemA.quantidadeContada : "--";
    const countB = itemB.quantidadeContada !== null ? itemB.quantidadeContada : "--";

    const card = document.createElement("div");
    card.className = "duplicate-pair-card";
    card.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 6px;">
        <span class="duplicate-reason-badge">⚠️ ${escapeHtml(cand.reason)}</span>
        <span style="font-size: 0.75rem; color: var(--text-muted);">📍 ${escapeHtml(cand.deposito)}</span>
      </div>

      <div class="pair-comparison-grid">
        <!-- ITEM A -->
        <div class="pair-item-box">
          <div class="item-tag">Opção 1 ${itemA.itemAvulso ? "(Item Avulso)" : "(Planilha)"}</div>
          <div class="item-code">${escapeHtml(itemA.codigo)}</div>
          <div class="item-desc">${escapeHtml(itemA.descricao)}</div>
          <div style="font-size:0.75rem; color:var(--text-muted);">📍 ${escapeHtml(itemA.deposito)}</div>
          <div class="pair-metrics-row">
            <span>Teórico: <strong>${itemA.quantidadeTeorica ?? 0}</strong></span>
            <span>Contado: <strong style="color:var(--primary); font-size:0.95rem;">${countA}</strong></span>
          </div>
        </div>

        <!-- ITEM B -->
        <div class="pair-item-box">
          <div class="item-tag">Opção 2 ${itemB.itemAvulso ? "(Item Avulso)" : "(Planilha)"}</div>
          <div class="item-code">${escapeHtml(itemB.codigo)}</div>
          <div class="item-desc">${escapeHtml(itemB.descricao)}</div>
          <div style="font-size:0.75rem; color:var(--text-muted);">📍 ${escapeHtml(itemB.deposito)}</div>
          <div class="pair-metrics-row">
            <span>Teórico: <strong>${itemB.quantidadeTeorica ?? 0}</strong></span>
            <span>Contado: <strong style="color:var(--primary); font-size:0.95rem;">${countB}</strong></span>
          </div>
        </div>
      </div>

      <div style="display: flex; gap: 8px; margin-top: 4px;">
        <button class="btn-large btn-secondary" onclick="dismissDuplicateCandidate('${cand.pairId}')" style="flex: 1; font-size: 0.85rem; min-height: 40px;">
          ❌ Descartar sugestão
        </button>
        <button class="btn-large btn-primary" onclick="openMergeModalByIds('${itemA.id}', '${itemB.id}')" style="flex: 1.5; font-size: 0.9rem; min-height: 40px;">
          🔀 Mesclar itens
        </button>
      </div>`;

    container.appendChild(card);
  });
}

window.dismissDuplicateCandidate = function(pairId) {
  dismissedPairIds.add(pairId);
  updateBadgesAndCounters();
  renderDuplicateCards(duplicateCandidates);
  showToast("Sugestão de duplicidade descartada.");
};

// ===================== MESCLAGEM MANUAL E MODAL =====================
window.toggleManualMergeMode = function() {
  isManualMergeMode = !isManualMergeMode;
  manualMergeSelectedIds = [];

  const bar = document.getElementById("manual-merge-bar");
  const btnToggle = document.getElementById("btn-toggle-merge");

  if (isManualMergeMode) {
    if (bar) bar.style.display = "flex";
    if (btnToggle) {
      btnToggle.textContent = "✖️ Cancelar Mesclagem";
      btnToggle.className = "btn-large btn-danger admin-only";
    }
    showToast("Toque em 2 itens da lista para mesclar.");
  } else {
    if (bar) bar.style.display = "none";
    if (btnToggle) {
      btnToggle.textContent = "🔗 Mesclar";
      btnToggle.className = "btn-large btn-secondary admin-only";
    }
  }

  updateManualMergeBar();
  renderProducts();
};

window.cancelManualMergeMode = function() {
  isManualMergeMode = false;
  manualMergeSelectedIds = [];
  const bar = document.getElementById("manual-merge-bar");
  const btnToggle = document.getElementById("btn-toggle-merge");
  if (bar) bar.style.display = "none";
  if (btnToggle) {
    btnToggle.textContent = "🔗 Mesclar";
    btnToggle.className = "btn-large btn-secondary admin-only";
  }
  renderProducts();
};

window.selectItemForMerge = function(itemId) {
  if (!isManualMergeMode) return;

  const idx = manualMergeSelectedIds.indexOf(itemId);
  if (idx > -1) {
    manualMergeSelectedIds.splice(idx, 1);
  } else {
    if (manualMergeSelectedIds.length >= 2) {
      // Já tem 2, substitui o segundo
      manualMergeSelectedIds[1] = itemId;
    } else {
      manualMergeSelectedIds.push(itemId);
    }
  }

  updateManualMergeBar();
  renderProducts();
};

function updateManualMergeBar() {
  const countEl = document.getElementById("manual-merge-selected-count");
  const proceedBtn = document.getElementById("btn-proceed-manual-merge");
  if (countEl) countEl.textContent = manualMergeSelectedIds.length;
  if (proceedBtn) proceedBtn.disabled = manualMergeSelectedIds.length !== 2;
}

window.proceedWithManualMerge = function() {
  if (manualMergeSelectedIds.length !== 2) return;
  const [idA, idB] = manualMergeSelectedIds;
  cancelManualMergeMode();
  openMergeModalByIds(idA, idB);
};

window.openMergeModalByIds = function(idA, idB) {
  const itemA = allItems.find(i => i.id === idA);
  const itemB = allItems.find(i => i.id === idB);

  if (!itemA || !itemB) {
    alert("Um dos itens não foi localizado.");
    return;
  }

  // Define sobrevivente padrão: se um for avulso e o outro planilha, o da planilha sobrevive
  let defaultSurvivorId = itemA.id;
  if (itemA.itemAvulso && !itemB.itemAvulso) {
    defaultSurvivorId = itemB.id;
  }

  currentMergePair = {
    itemA: itemA,
    itemB: itemB,
    survivorId: defaultSurvivorId
  };

  renderMergeModalContent();
  document.getElementById("merge-modal").classList.add("active");
};

function renderMergeModalContent() {
  if (!currentMergePair) return;
  const { itemA, itemB, survivorId } = currentMergePair;

  const optionsContainer = document.getElementById("merge-survivor-options");
  if (!optionsContainer) return;

  const countA = itemA.quantidadeContada !== null ? Number(itemA.quantidadeContada) : 0;
  const countB = itemB.quantidadeContada !== null ? Number(itemB.quantidadeContada) : 0;
  const hasCount = itemA.quantidadeContada !== null || itemB.quantidadeContada !== null;
  const sumCount = hasCount ? (countA + countB) : 0;

  optionsContainer.innerHTML = `
    <!-- OPÇÃO ITEM A -->
    <div class="survivor-card-option ${survivorId === itemA.id ? "selected" : ""}" onclick="selectSurvivor('${itemA.id}')">
      <span class="survivor-badge-pill">✅ SOBREVIVENTE ESCOLHIDO</span>
      <div style="font-weight: 800; color: var(--primary); font-size: 0.95rem;">${escapeHtml(itemA.codigo)} - ${escapeHtml(itemA.descricao)}</div>
      <div style="font-size: 0.78rem; color: var(--text-muted);">
        Depósito: <strong>${escapeHtml(itemA.deposito)}</strong> · Teórico: <strong>${itemA.quantidadeTeorica ?? 0}</strong> · Contado atual: <strong>${itemA.quantidadeContada !== null ? itemA.quantidadeContada : "--"}</strong>
      </div>
    </div>

    <!-- OPÇÃO ITEM B -->
    <div class="survivor-card-option ${survivorId === itemB.id ? "selected" : ""}" onclick="selectSurvivor('${itemB.id}')">
      <span class="survivor-badge-pill">✅ SOBREVIVENTE ESCOLHIDO</span>
      <div style="font-weight: 800; color: var(--primary); font-size: 0.95rem;">${escapeHtml(itemB.codigo)} - ${escapeHtml(itemB.descricao)}</div>
      <div style="font-size: 0.78rem; color: var(--text-muted);">
        Depósito: <strong>${escapeHtml(itemB.deposito)}</strong> · Teórico: <strong>${itemB.quantidadeTeorica ?? 0}</strong> · Contado atual: <strong>${itemB.quantidadeContada !== null ? itemB.quantidadeContada : "--"}</strong>
      </div>
    </div>`;

  // Exibe a soma calculada das quantidades contadas
  document.getElementById("merge-sum-value").textContent = hasCount ? sumCount : "Nenhum contado";
  document.getElementById("merge-sum-breakdown").textContent = hasCount
    ? `${itemA.codigo} (${countA}) + ${itemB.codigo} (${countB}) = ${sumCount}`
    : "Ambos os itens estão pendentes de contagem";

  const passInput = document.getElementById("merge-admin-password");
  if (passInput) passInput.value = "";
}

window.selectSurvivor = function(survivorId) {
  if (!currentMergePair) return;
  currentMergePair.survivorId = survivorId;
  renderMergeModalContent();
};

window.closeMergeModal = function() {
  document.getElementById("merge-modal").classList.remove("active");
  currentMergePair = null;
};

window.submitMergeConfirmation = async function() {
  if (!currentMergePair || !currentInventory) return;
  const passInput = document.getElementById("merge-admin-password");
  const adminPassword = passInput?.value?.trim();

  if (!adminPassword) {
    alert("Informe a senha de atestado do Administrador.");
    return;
  }

  // Comparação local com a senha do inventário ativo carregado
  if (currentInventory.adminPassword && adminPassword !== String(currentInventory.adminPassword).trim()) {
    alert("Senha de atestado incorreta.");
    return;
  }

  const { itemA, itemB, survivorId } = currentMergePair;
  const mergedId = survivorId === itemA.id ? itemB.id : itemA.id;
  const survivorItem = survivorId === itemA.id ? itemA : itemB;
  const mergedItem = survivorId === itemA.id ? itemB : itemA;

  const btn = document.getElementById("btn-confirm-merge");
  btn.disabled = true;
  btn.textContent = "⏳ Mesclando itens...";

  try {
    await mergeItems(currentInventory.id, {
      survivorItemId: survivorId,
      mergedItemId: mergedId,
      adminUser: currentUser ? currentUser.name : (currentInventory.responsible || "Admin"),
      adminPassword: adminPassword
    });

    if (navigator.vibrate) navigator.vibrate(80);
    showToast(`🔀 Item '${mergedItem.codigo}' absorvido em '${survivorItem.codigo}' com sucesso!`);
    closeMergeModal();

    // Recarrega candidatos a duplicados
    loadDuplicateCandidates();
  } catch (err) {
    alert("Erro ao mesclar itens: " + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "✅ Confirmar Mesclagem";
  }
};

// ===================== DASHBOARD (LEITURA INDEPENDENTE) =====================
window.refreshDashboard = async function() {
  if (!currentInventory) return;
  try {
    const metrics = await getDashboardMetrics(currentInventory.id);

    document.getElementById("dash-total-items").textContent = metrics.totalItems;
    document.getElementById("dash-counted-items").textContent = metrics.countedItems;
    document.getElementById("dash-completion-pct").textContent = `${metrics.completionPercent}% Concluído`;
    document.getElementById("dash-pending-items").textContent = metrics.pendingItems;
    document.getElementById("dash-divergent-items").textContent = metrics.divergentItems;
    document.getElementById("dash-inventoried-val").textContent = formatBRL(metrics.totalInventoriedValue);
    document.getElementById("dash-theoretical-val").textContent = `Teórico: ${formatBRL(metrics.totalTheoreticalValue)}`;
    document.getElementById("dash-financial-diff").textContent = formatBRL(metrics.financialDiff);
    document.getElementById("dash-qty-diff").textContent = `Diferença em Qtd: ${metrics.totalDifferenceQty}`;

    // Operadores
    const opTbody = document.getElementById("tbl-op-productivity");
    if (opTbody) {
      opTbody.innerHTML = "";
      Object.entries(metrics.operatorStats || {}).forEach(([op, stat]) => {
        const tr = document.createElement("tr");
        tr.innerHTML = `<td><strong>${escapeHtml(op)}</strong></td><td>${stat.count}</td>
          <td style="color:var(--success);">${stat.noDiv}</td><td style="color:var(--danger);">${stat.div}</td>`;
        opTbody.appendChild(tr);
      });
    }

    // Depósitos
    const depTbody = document.getElementById("tbl-deposit-summary");
    if (depTbody) {
      depTbody.innerHTML = "";
      Object.entries(metrics.depositStats || {}).forEach(([dep, stat]) => {
        const tr = document.createElement("tr");
        tr.innerHTML = `<td><strong>${escapeHtml(dep)}</strong></td><td>${stat.total}</td>
          <td style="color:var(--accent);">${stat.counted}</td>
          <td style="color:var(--warning);">${stat.pending}</td>
          <td style="color:var(--danger);">${stat.divergent}</td>`;
        depTbody.appendChild(tr);
      });
    }
  } catch (err) {
    console.error("Erro ao carregar métricas do dashboard:", err);
  }
};

// ===================== RELATÓRIOS & EXPORTAÇÃO =====================
function renderReportsData() {
  const codeEl = document.getElementById("rpt-inv-code");
  const scopeEl = document.getElementById("rpt-inv-scope");
  const dateEl = document.getElementById("rpt-date");
  if (codeEl) codeEl.textContent = currentInventory ? currentInventory.code : "--";
  if (scopeEl) scopeEl.textContent = currentInventory ? (currentInventory.scopeFilter || "Geral") : "Geral";
  if (dateEl) dateEl.textContent = new Date().toLocaleDateString("pt-BR");

  const tbody = document.getElementById("tbl-report-analytical");
  if (!tbody) return;
  tbody.innerHTML = "";

  const activeItems = allItems.filter(i => !i.mesclado);

  activeItems.forEach(item => {
    const diff = item.quantidadeContada !== null ? (item.quantidadeContada - item.quantidadeTeorica) : "--";
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><strong>${escapeHtml(item.codigo)}</strong></td>
      <td>${escapeHtml(item.descricao)}</td>
      <td>${escapeHtml(item.deposito)}</td>
      <td>${item.quantidadeTeorica}</td>
      <td>${item.quantidadeContada !== null ? item.quantidadeContada : "--"}</td>
      <td>${diff}</td>
      <td><span class="badge ${item.status === 'sem_divergencia' ? 'badge-success' : item.status === 'divergencia' ? 'badge-danger' : ''}">${item.status}</span></td>`;
    tbody.appendChild(tr);
  });
}

window.exportPDF = function() { window.print(); };

window.exportCSV = function() {
  let csv = "\uFEFF";
  csv += "Codigo;Descricao;Deposito;QtdTeorica;QtdContada;Diferenca;CustoMedio;ValorDivergencia;Operador;Status;Observacao\n";

  const activeItems = allItems.filter(i => !i.mesclado);

  activeItems.forEach(item => {
    const diff = item.quantidadeContada !== null ? (item.quantidadeContada - item.quantidadeTeorica) : "";
    const divVal = typeof diff === "number" ? Math.abs(diff * (item.custoMedio || 0)) : 0;
    csv += `"${item.codigo}";"${item.descricao}";"${item.deposito}";${item.quantidadeTeorica};${item.quantidadeContada ?? ""};${diff};${item.custoMedio || 0};${divVal};"${item.operator || ""}";"${item.status}";"${item.observacao || ""}"\n`;
  });

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.setAttribute("download", `Inventario_${currentInventory ? currentInventory.code : "JR"}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
};

// ===================== CENTRAL DE AUDITORIA =====================
function setupAuditSubscription() {
  if (!currentInventory) return;
  if (unsubscribeAudit) unsubscribeAudit();

  unsubscribeAudit = subscribeToAuditLogs(currentInventory.id, (logs) => {
    const container = document.getElementById("audit-mobile-list");
    if (!container) return;
    container.innerHTML = "";

    if (logs.length === 0) {
      container.innerHTML = `<div style="text-align:center; padding:30px; color:var(--text-muted);"><p>Nenhum registro de auditoria.</p></div>`;
      return;
    }

    logs.forEach(log => {
      const card = document.createElement("div");
      card.className = "audit-log-card";
      card.innerHTML = `
        <div class="log-action">${escapeHtml(log.action)}</div>
        <div class="log-meta">${log.date} ${log.time} · <strong>${escapeHtml(log.user)}</strong> (${log.role})</div>
        <div class="log-detail">${escapeHtml(log.details)}</div>`;
      container.appendChild(card);
    });
  });
}

// ===================== CONFERÊNCIA E IMPORTAÇÃO EXCEL =====================
window.getCheckedDeposits = function() {
  const checkboxes = document.querySelectorAll("#import-deposits-list input[type='checkbox']");
  const selected = new Set();
  checkboxes.forEach(cb => {
    if (cb.checked) selected.add(cb.value);
  });
  return selected;
};

window.selectAllImportDeposits = function(checked) {
  const checkboxes = document.querySelectorAll("#import-deposits-list input[type='checkbox']");
  checkboxes.forEach(cb => {
    cb.checked = !!checked;
    const parent = cb.closest(".import-deposit-item");
    if (parent) {
      parent.classList.toggle("selected", !!checked);
    }
  });
  window.updateImportPreviewSelection();
};

window.onImportDepositToggle = function(checkbox) {
  const parent = checkbox.closest(".import-deposit-item");
  if (parent) {
    parent.classList.toggle("selected", checkbox.checked);
  }
  window.updateImportPreviewSelection();
};

window.updateImportPreviewSelection = function() {
  if (!pendingParsedExcel) return;
  const selected = window.getCheckedDeposits();
  const filtered = pendingParsedExcel.items.filter(i => selected.has(i.deposito));

  const totalTheor = filtered.reduce((acc, i) => acc + (i.valorTotal || 0), 0);
  const totalWarnings = filtered.filter(i => i.isWarning).length;

  const totalItemsEl = document.getElementById("prev-total-items");
  const totalDepositsEl = document.getElementById("prev-total-deposits");
  const theorValEl = document.getElementById("prev-theor-val");
  const warnTextEl = document.getElementById("prev-warnings-text");
  const confirmBtn = document.getElementById("btn-confirm-import");

  if (totalItemsEl) totalItemsEl.textContent = filtered.length;
  if (totalDepositsEl) totalDepositsEl.textContent = `${selected.size} de ${pendingParsedExcel.summary.depositsCount}`;
  if (theorValEl) theorValEl.textContent = formatBRL(totalTheor);

  if (warnTextEl) {
    if (totalWarnings > 0) {
      warnTextEl.textContent = `⚠️ ${totalWarnings} item(ns) sem código/descrição nos depósitos selecionados`;
      warnTextEl.style.color = "var(--warning)";
    } else {
      warnTextEl.textContent = `Depósitos selecionados: ${Array.from(selected).slice(0, 3).join(", ")}${selected.size > 3 ? "..." : ""}`;
      warnTextEl.style.color = "var(--text-muted)";
    }
  }

  if (confirmBtn) {
    confirmBtn.disabled = filtered.length === 0;
  }
};

function openImportPreviewModal(summary) {
  // Prevenção de duplicidades: Exibe alerta se houver códigos repetidos na planilha
  const dupWarning = document.getElementById("prev-duplicates-warning");
  const dupText = document.getElementById("prev-duplicates-text");
  if (dupWarning && dupText) {
    if (summary.duplicates && summary.duplicates.hasDuplicates) {
      dupWarning.style.display = "block";
      const sampleCodes = summary.duplicates.duplicateCodes
        .slice(0, 4)
        .map(d => `${d.code} (${d.occurrences}x)`)
        .join(", ");
      dupText.innerHTML = `Foram encontrados <strong>${summary.duplicates.duplicateCodesCount} códigos repetidos</strong> em ${summary.duplicates.duplicateRowsCount} linhas.<br>Exemplos: <em>${escapeHtml(sampleCodes)}${summary.duplicates.duplicateCodesCount > 4 ? "..." : ""}</em>. Confirme para importar ou revise o arquivo antes.`;
    } else {
      dupWarning.style.display = "none";
    }
  }

  // Renderiza checklist de depósitos com todos marcados por padrão
  const listContainer = document.getElementById("import-deposits-list");
  if (listContainer) {
    listContainer.innerHTML = "";
    const depositDetails = summary.depositDetails || summary.distinctDeposits.map(d => {
      const itemsInDep = pendingParsedExcel.items.filter(i => i.deposito === d);
      return {
        name: d,
        count: itemsInDep.length,
        totalTheoreticalValue: itemsInDep.reduce((acc, i) => acc + (i.valorTotal || 0), 0)
      };
    });

    depositDetails.forEach(dep => {
      const itemDiv = document.createElement("div");
      itemDiv.className = "import-deposit-item selected";
      itemDiv.innerHTML = `
        <label class="import-deposit-label">
          <input type="checkbox" class="import-deposit-checkbox" value="${escapeHtml(dep.name)}" checked onchange="onImportDepositToggle(this)">
          <span>${escapeHtml(dep.name)}</span>
        </label>
        <div class="import-deposit-meta">
          <span class="import-deposit-count">${dep.count} itens</span>
          <span>${formatBRL(dep.totalTheoreticalValue)}</span>
        </div>
      `;
      listContainer.appendChild(itemDiv);
    });
  }

  // Atualiza KPIs da tela de conferência com base na seleção inicial
  window.updateImportPreviewSelection();

  document.getElementById("import-preview-modal").classList.add("active");
}

window.closeImportPreviewModal = function() {
  document.getElementById("import-preview-modal").classList.remove("active");
  pendingParsedExcel = null;
};

window.confirmImportExecution = async function() {
  if (!pendingParsedExcel) return;

  const selected = window.getCheckedDeposits();
  const finalItems = pendingParsedExcel.items.filter(i => selected.has(i.deposito));

  if (finalItems.length === 0) {
    alert("Selecione ao menos um depósito com itens para importar.");
    return;
  }

  const isAllSelected = selected.size === pendingParsedExcel.summary.distinctDeposits.length;
  const scopeFilter = isAllSelected ? "Geral" : Array.from(selected).join(", ");

  const btn = document.getElementById("btn-confirm-import");
  btn.disabled = true;
  btn.textContent = "⏳ Gravando no banco...";

  // Aviso caso esteja sem conexão (fila offline do Firestore)
  if (!navigator.onLine) {
    showToast("⚠️ Sem conexão — a importação será enviada assim que a rede voltar.");
  }

  try {
    const newInv = await startInventory({
      adminName: pendingParsedExcel.adminName,
      adminPassword: pendingParsedExcel.adminPassword,
      inventoryName: pendingParsedExcel.inventoryName,
      scopeFilter: scopeFilter,
      items: finalItems
    });

    currentUser = {
      name: pendingParsedExcel.adminName,
      role: "admin",
      inventoryId: newInv.id,
      adminPassword: pendingParsedExcel.adminPassword
    };
    currentInventory = newInv;
    localStorage.setItem("jrinvent_session", JSON.stringify(currentUser));

    closeImportPreviewModal();
    document.getElementById("start-modal").classList.remove("active");
    applyUserSession();
    bindInventorySubscriptions(newInv.id);
    showToast(`🎉 Inventário iniciado com sucesso! (${finalItems.length} itens, Escopo: ${scopeFilter})`);
    selectMenuItem("tab-contagem", null);
  } catch (err) {
    if (err.message === "INVENTARIO_JA_ATIVO") {
      const activeCode = err.activeInventory?.code || "já em andamento";
      alert(`⚠️ Já existe um inventário em andamento (${activeCode})!\n\nSe você é o responsável por este inventário, utilize a opção "Sou o Administrador deste inventário" na tela inicial para retomar o acesso.`);
      closeImportPreviewModal();
      if (err.activeInventory) {
        currentInventory = err.activeInventory;
      }
      showAuditorJoinView(err.activeInventory);
    } else {
      alert("Erro ao gravar inventário: " + err.message);
    }
  } finally {
    btn.disabled = false;
    btn.textContent = "✅ Confirmar e Iniciar";
  }
};

window.handleManagementExcelUpload = async function() {
  const fileInput = document.getElementById("file-excel-management");
  if (!fileInput.files || fileInput.files.length === 0) {
    alert("Selecione um arquivo Excel (.xlsx).");
    return;
  }

  const pass = prompt("Informe a senha de atestado do Administrador para criar o novo inventário:");
  if (!pass) return;

  try {
    const parsed = await parseExcelFile(fileInput.files[0]);
    pendingParsedExcel = {
      adminName: currentUser ? currentUser.name : "Administrador",
      adminPassword: pass,
      inventoryName: `Inventário ${new Date().toLocaleDateString("pt-BR")}`,
      items: parsed.items,
      summary: parsed.summary
    };
    openImportPreviewModal(parsed.summary);
  } catch (err) {
    alert("Erro ao processar planilha: " + err.message);
  }
};

// ===================== FINALIZAÇÃO E REABERTURA =====================
window.confirmFinalizeInventory = async function() {
  if (!currentInventory) return;

  const uncounted = allItems.filter(i => i.status === "nao_contado" && !i.mesclado).length;
  let confirmMsg = "Deseja realmente finalizar este inventário? Ele será bloqueado para novas alterações.";
  if (uncounted > 0) {
    confirmMsg = `Ainda há ${uncounted} item(ns) nunca contados. Finalizar mesmo assim?`;
  }

  if (!confirm(confirmMsg)) return;

  const pass = prompt("Insira a senha de atestado do Administrador para confirmar a finalização:");
  if (pass === null) return;
  const trimmedPass = (pass || "").trim();
  if (!trimmedPass) {
    alert("A senha de atestado é necessária para finalizar.");
    return;
  }

  // Comparação local com a senha do inventário ativo carregado
  if (currentInventory.adminPassword && trimmedPass !== String(currentInventory.adminPassword).trim()) {
    alert("Senha de atestado incorreta.");
    return;
  }

  try {
    await finalizeInventory(currentInventory.id, {
      adminUser: currentUser ? currentUser.name : (currentInventory.responsible || "Admin"),
      adminPassword: trimmedPass
    });
    currentInventory.isLocked = true;
    currentInventory.status = "Finalizado";
    updateHeaderInventoryInfo();
    showToast("🔒 Inventário finalizado com sucesso!");
  } catch (err) {
    alert("Erro ao finalizar inventário: " + err.message);
  }
};

window.openReopenModal = function() {
  document.getElementById("reopen-password-input").value = "";
  document.getElementById("reopen-modal").classList.add("active");
};

window.closeReopenModal = function() {
  document.getElementById("reopen-modal").classList.remove("active");
};

window.submitReopenInventory = async function() {
  if (!currentInventory) return;
  const pass = document.getElementById("reopen-password-input").value.trim();

  if (!pass) {
    alert("Informe a senha de atestado do Administrador.");
    return;
  }

  // Comparação local com a senha do inventário ativo carregado
  if (currentInventory.adminPassword && pass !== String(currentInventory.adminPassword).trim()) {
    alert("Senha de atestado incorreta.");
    return;
  }

  try {
    await reopenInventory(currentInventory.id, {
      adminUser: currentUser ? currentUser.name : (currentInventory.responsible || "Admin"),
      adminPassword: pass
    });
    currentInventory.isLocked = false;
    currentInventory.status = "Em andamento";
    updateHeaderInventoryInfo();
    closeReopenModal();
    showToast("🔓 Inventário reaberto com sucesso!");
  } catch (err) {
    if (err.message === "INVENTARIO_JA_ATIVO") {
      const activeCode = err.activeInventory?.code || "já em andamento";
      alert(`⚠️ Não é possível reabrir este inventário porque já existe outro inventário em andamento (${activeCode})!\n\nFinalize o inventário ativo antes de reabrir um anterior.`);
    } else {
      alert("Erro ao reabrir inventário: " + err.message);
    }
  }
};

// ===================== UTILIDADES =====================
function formatBRL(val) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(val || 0);
}

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function showToast(msg) {
  const container = document.getElementById("toast-container");
  if (!container) return;

  const toast = document.createElement("div");
  toast.className = "toast-message";
  toast.innerHTML = `<span>${msg}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transition = "opacity 0.3s";
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}
