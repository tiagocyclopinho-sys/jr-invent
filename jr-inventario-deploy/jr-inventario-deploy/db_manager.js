const fs = require('fs');
const path = require('path');
const { cleanAndParseExcel } = require('./excel_cleaner');

const DB_FILE = path.join(__dirname, 'data', 'db.json');

// Ensure data folder exists
if (!fs.existsSync(path.join(__dirname, 'data'))) {
  fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
}

function getDefaultData() {
  return {
    users: [
      { id: 'usr_admin', username: 'admin', passwordHash: 'admin123', name: 'Administrador JR', role: 'admin' },
      { id: 'usr_op1', username: 'operador1', passwordHash: 'op123', name: 'Thiago Ferreira', role: 'operator' },
      { id: 'usr_op2', username: 'operador2', passwordHash: 'op123', name: 'Carlos Silva', role: 'operator' },
      { id: 'usr_op3', username: 'operador3', passwordHash: 'op123', name: 'Ana Paula', role: 'operator' }
    ],
    inventories: [],
    items: [],
    counts: [],
    auditLogs: []
  };
}

class DatabaseManager {
  constructor() {
    this.data = getDefaultData();
    this.load();
    this.initDefaultInventoryIfEmpty();
  }

  load() {
    try {
      if (fs.existsSync(DB_FILE)) {
        const raw = fs.readFileSync(DB_FILE, 'utf8');
        this.data = JSON.parse(raw);
      } else {
        this.save();
      }
    } catch (err) {
      console.error('Error loading DB, creating default:', err.message);
      this.data = getDefaultData();
      this.save();
    }
  }

  save() {
    try {
      const tempPath = DB_FILE + '.tmp';
      fs.writeFileSync(tempPath, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tempPath, DB_FILE);
    } catch (err) {
      console.error('Error saving DB:', err.message);
    }
  }

  initDefaultInventoryIfEmpty() {
    if (this.data.inventories.length > 0) return;

    // Check if initial excel file exists
    const excelPath = path.join(__dirname, 'Estoque  Saldo dos itens em estoque por deposito  04082026.xlsx');
    let importedItems = [];

    if (fs.existsSync(excelPath)) {
      try {
        console.log('Seeding database from initial Excel file...');
        const buffer = fs.readFileSync(excelPath);
        importedItems = cleanAndParseExcel(buffer);
        console.log(`Parsed ${importedItems.length} items from Excel.`);
      } catch (err) {
        console.error('Error parsing initial Excel:', err.message);
      }
    }

    const inventoryId = 'inv_001';
    const now = new Date().toISOString();

    const newInventory = {
      id: inventoryId,
      code: 'INV-2026-001',
      name: 'Inventário Geral de Estreia - Almoxarifado JR',
      startDate: now.split('T')[0],
      endDate: null,
      responsible: 'Administrador JR',
      status: 'Em andamento',
      isLocked: false,
      scopeFilter: 'Geral',
      itemsCount: importedItems.length,
      createdAt: now
    };

    const dbItems = importedItems.map((item, index) => ({
      id: `item_${inventoryId}_${index + 1}`,
      inventoryId: inventoryId,
      codigo: item.codigo,
      descricao: item.descricao,
      deposito: item.deposito,
      quantidadeTeorica: item.quantidadeTeorica,
      quantidadeContada: null,
      diferenca: null,
      precoUltimaEntrada: item.precoUltimaEntrada,
      custoMedio: item.custoMedio,
      valorTotal: item.valorTotal,
      status: 'nao_contado', // 'nao_contado' | 'em_contagem' | 'sem_divergencia' | 'divergencia'
      countStage: 1, // Stage 1 = Theoretical, 2 = Operator count, 3 = Divergence review
      operator: null,
      countedAt: null,
      observacao: null,
      adminJustification: null,
      adminApprovedBy: null,
      adminApprovedAt: null,
      version: 1
    }));

    this.data.inventories.push(newInventory);
    this.data.items.push(...dbItems);
    this.addAuditLog('System', 'admin', 'Importação Inicial', `Inventário INV-2026-001 criado com ${dbItems.length} itens.`);
    this.save();
  }

  // --- Auth & Users ---
  authenticate(username, password) {
    const user = this.data.users.find(u => u.username.toLowerCase() === username.toLowerCase() && u.passwordHash === password);
    if (!user) return null;
    return { id: user.id, username: user.username, name: user.name, role: user.role };
  }

  getUsers() {
    return this.data.users.map(u => ({ id: u.id, username: u.username, name: u.name, role: u.role }));
  }

  addUser(username, password, name, role) {
    if (this.data.users.some(u => u.username.toLowerCase() === username.toLowerCase())) {
      throw new Error('Usuário já existente.');
    }
    const newUser = { id: `usr_${Date.now()}`, username, passwordHash: password, name, role };
    this.data.users.push(newUser);
    this.save();
    return newUser;
  }

  // --- Inventories ---
  getInventories() {
    return this.data.inventories;
  }

  getInventoryById(id) {
    return this.data.inventories.find(i => i.id === id);
  }

  createInventory(name, responsible, scopeFilter, rawExcelBuffer = null) {
    let importedItems = [];
    if (rawExcelBuffer) {
      importedItems = cleanAndParseExcel(rawExcelBuffer);
    }

    const seqNum = this.data.inventories.length + 1;
    const code = `INV-2026-${String(seqNum).padStart(3, '0')}`;
    const inventoryId = `inv_${Date.now()}`;
    const now = new Date().toISOString();

    const newInventory = {
      id: inventoryId,
      code: code,
      name: name || `Inventário ${code}`,
      startDate: now.split('T')[0],
      endDate: null,
      responsible: responsible || 'Administrador',
      status: 'Em andamento',
      isLocked: false,
      scopeFilter: scopeFilter || 'Geral',
      itemsCount: importedItems.length,
      createdAt: now
    };

    const dbItems = importedItems.map((item, index) => ({
      id: `item_${inventoryId}_${index + 1}`,
      inventoryId: inventoryId,
      codigo: item.codigo,
      descricao: item.descricao,
      deposito: item.deposito,
      quantidadeTeorica: item.quantidadeTeorica,
      quantidadeContada: null,
      diferenca: null,
      precoUltimaEntrada: item.precoUltimaEntrada,
      custoMedio: item.custoMedio,
      valorTotal: item.valorTotal,
      status: 'nao_contado',
      countStage: 1,
      operator: null,
      countedAt: null,
      observacao: null,
      adminJustification: null,
      adminApprovedBy: null,
      adminApprovedAt: null,
      version: 1
    }));

    this.data.inventories.push(newInventory);
    this.data.items.push(...dbItems);
    this.addAuditLog(responsible, 'admin', 'Abertura de Inventário', `Novo inventário ${code} criado com ${dbItems.length} itens.`);
    this.save();
    return newInventory;
  }

  finalizeInventory(inventoryId, username) {
    const inv = this.getInventoryById(inventoryId);
    if (!inv) throw new Error('Inventário não encontrado.');

    inv.status = 'Finalizado';
    inv.isLocked = true;
    inv.endDate = new Date().toISOString().split('T')[0];

    this.addAuditLog(username, 'admin', 'Encerramento de Inventário', `Inventário ${inv.code} finalizado e bloqueado.`);
    this.save();
    return inv;
  }

  reopenInventory(inventoryId, username, password) {
    const admin = this.data.users.find(u => u.role === 'admin' && u.passwordHash === password);
    if (!admin) {
      throw new Error('Senha administrativa incorreta.');
    }

    const inv = this.getInventoryById(inventoryId);
    if (!inv) throw new Error('Inventário não encontrado.');

    inv.status = 'Em andamento';
    inv.isLocked = false;

    this.addAuditLog(username, 'admin', 'Reabertura de Inventário', `Inventário ${inv.code} reaberto mediante autenticação administrativa.`);
    this.save();
    return inv;
  }

  // --- Items & Counting ---
  getItemsByInventory(inventoryId, filters = {}) {
    let items = this.data.items.filter(i => i.inventoryId === inventoryId);

    if (filters.deposito && filters.deposito !== 'Todos') {
      items = items.filter(i => i.deposito === filters.deposito);
    }

    if (filters.status && filters.status !== 'Todos') {
      if (filters.status === 'Pendentes') {
        items = items.filter(i => i.status === 'nao_contado' || i.status === 'em_contagem');
      } else if (filters.status === 'Contados') {
        items = items.filter(i => i.status === 'sem_divergencia' || i.status === 'divergencia');
      } else if (filters.status === 'Divergentes') {
        items = items.filter(i => i.status === 'divergencia');
      } else if (filters.status === 'Sem Divergência') {
        items = items.filter(i => i.status === 'sem_divergencia');
      }
    }

    if (filters.search) {
      const q = filters.search.toLowerCase().trim();
      items = items.filter(i => i.codigo.toLowerCase().includes(q) || i.descricao.toLowerCase().includes(q) || i.deposito.toLowerCase().includes(q));
    }

    return items;
  }

  getDepositsList(inventoryId) {
    const items = this.data.items.filter(i => i.inventoryId === inventoryId);
    const set = new Set(items.map(i => i.deposito));
    return Array.from(set).sort();
  }

  saveCount(itemId, countedQty, operatorName, observacao = '') {
    const item = this.data.items.find(i => i.id === itemId);
    if (!item) throw new Error('Item não encontrado.');

    const inv = this.getInventoryById(item.inventoryId);
    if (inv && inv.isLocked) {
      throw new Error('Inventário bloqueado para edições.');
    }

    const qty = parseFloat(countedQty);
    if (isNaN(qty) || qty < 0) {
      throw new Error('Quantidade contada inválida.');
    }

    const now = new Date();
    const formattedDate = now.toLocaleDateString('pt-BR');
    const formattedTime = now.toLocaleTimeString('pt-BR');

    item.quantidadeContada = qty;
    item.diferenca = qty - item.quantidadeTeorica;
    item.operator = operatorName;
    item.countedAt = `${formattedDate} ${formattedTime}`;
    item.observacao = observacao || null;
    item.countStage = 2; // Operator count stage executed
    item.version = (item.version || 1) + 1;

    // Rule: If Qtd Primeira (Theoretical) === Qtd Segunda (Counted) -> Approved automatically ("Sem Divergência")
    // Else -> Flagged as "Divergência" and automatically sent to Terceira Contagem
    if (item.quantidadeTeorica === qty) {
      item.status = 'sem_divergencia';
    } else {
      item.status = 'divergencia';
      item.countStage = 3; // Forwarded to 3rd count for admin approval
    }

    // Record count transaction entry
    this.data.counts.push({
      id: `cnt_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      itemId: item.id,
      inventoryId: item.inventoryId,
      quantidadeContada: qty,
      diferenca: item.diferenca,
      operator: operatorName,
      timestamp: `${formattedDate} ${formattedTime}`,
      stage: item.countStage,
      status: item.status
    });

    this.addAuditLog(operatorName, 'operator', 'Lançamento de Contagem', `Item [${item.codigo}] ${item.descricao}: Qtd Contada = ${qty} (${item.status}).`);
    this.save();
    return item;
  }

  // --- Admin 3rd Count Approval ---
  approveDivergence(itemId, newQty, justification, observacao, adminUser) {
    const item = this.data.items.find(i => i.id === itemId);
    if (!item) throw new Error('Item não encontrado.');

    const inv = this.getInventoryById(item.inventoryId);
    if (inv && inv.isLocked) {
      throw new Error('Inventário bloqueado.');
    }

    if (!justification || justification.trim() === '') {
      throw new Error('É obrigatório inserir uma justificativa para liberação da divergência.');
    }

    const qty = parseFloat(newQty);
    if (isNaN(qty) || qty < 0) {
      throw new Error('Quantidade informada inválida.');
    }

    const now = new Date();
    const formattedDate = now.toLocaleDateString('pt-BR');
    const formattedTime = now.toLocaleTimeString('pt-BR');

    item.quantidadeContada = qty;
    item.diferenca = qty - item.quantidadeTeorica;
    item.status = item.diferenca === 0 ? 'sem_divergencia' : 'sem_divergencia'; // Approved by admin
    item.adminJustification = justification;
    item.adminApprovedBy = adminUser;
    item.adminApprovedAt = `${formattedDate} ${formattedTime}`;
    if (observacao) item.observacao = observacao;

    this.addAuditLog(adminUser, 'admin', 'Aprovação de 3ª Contagem', `Item [${item.codigo}] ajustado/aprovado para ${qty}. Justificativa: ${justification}`);
    this.save();
    return item;
  }

  // --- Dashboard KPIs ---
  getDashboardMetrics(inventoryId) {
    const items = this.data.items.filter(i => i.inventoryId === inventoryId);
    const totalItems = items.length;

    let countedItems = 0;
    let pendingItems = 0;
    let divergentItems = 0;
    let noDivergenceItems = 0;

    let totalTheoreticalValue = 0;
    let totalInventoriedValue = 0;
    let totalDivergenceValue = 0;
    let totalDifferenceQty = 0;
    let totalAverageCostSum = 0;

    const operatorStats = {};
    const depositStats = {};

    items.forEach(item => {
      totalTheoreticalValue += item.valorTotal || (item.quantidadeTeorica * item.custoMedio);
      totalAverageCostSum += item.custoMedio || 0;

      // Deposit grouping
      if (!depositStats[item.deposito]) {
        depositStats[item.deposito] = { total: 0, counted: 0, pending: 0, divergent: 0, totalVal: 0, divVal: 0 };
      }
      depositStats[item.deposito].total++;
      depositStats[item.deposito].totalVal += item.valorTotal || 0;

      if (item.status === 'nao_contado' || item.status === 'em_contagem') {
        pendingItems++;
        depositStats[item.deposito].pending++;
      } else {
        countedItems++;
        depositStats[item.deposito].counted++;

        const countedVal = item.quantidadeContada * item.custoMedio;
        totalInventoriedValue += countedVal;

        const diffQty = item.quantidadeContada - item.quantidadeTeorica;
        totalDifferenceQty += diffQty;

        const diffVal = Math.abs(diffQty * item.custoMedio);

        if (item.status === 'divergencia') {
          divergentItems++;
          depositStats[item.deposito].divergent++;
          totalDivergenceValue += diffVal;
          depositStats[item.deposito].divVal += diffVal;
        } else {
          noDivergenceItems++;
        }

        // Operator stats
        if (item.operator) {
          if (!operatorStats[item.operator]) {
            operatorStats[item.operator] = { count: 0, noDiv: 0, div: 0 };
          }
          operatorStats[item.operator].count++;
          if (item.status === 'divergencia') operatorStats[item.operator].div++;
          else operatorStats[item.operator].noDiv++;
        }
      }
    });

    const completionPercent = totalItems > 0 ? ((countedItems / totalItems) * 100).toFixed(1) : '0.0';
    const financialDiff = totalInventoriedValue - totalTheoreticalValue;

    return {
      totalItems,
      countedItems,
      pendingItems,
      divergentItems,
      noDivergenceItems,
      completionPercent,
      totalTheoreticalValue,
      totalInventoriedValue,
      financialDiff,
      totalDivergenceValue,
      totalDifferenceQty,
      avgUnitCost: totalItems > 0 ? (totalAverageCostSum / totalItems) : 0,
      operatorStats,
      depositStats
    };
  }

  // --- Audit Logs ---
  addAuditLog(user, role, action, details) {
    const now = new Date();
    const dateStr = now.toLocaleDateString('pt-BR');
    const timeStr = now.toLocaleTimeString('pt-BR');

    this.data.auditLogs.unshift({
      id: `log_${Date.now()}_${Math.random().toString(36).substring(2, 5)}`,
      user: user || 'Anon',
      role: role || 'user',
      action: action,
      details: details,
      date: dateStr,
      time: timeStr,
      timestamp: now.toISOString()
    });

    // Keep up to 1000 logs
    if (this.data.auditLogs.length > 1000) {
      this.data.auditLogs = this.data.auditLogs.slice(0, 1000);
    }
  }

  getAuditLogs(filterUser = '', filterAction = '') {
    let logs = this.data.auditLogs;
    if (filterUser) {
      logs = logs.filter(l => l.user.toLowerCase().includes(filterUser.toLowerCase()));
    }
    if (filterAction) {
      logs = logs.filter(l => l.action.toLowerCase().includes(filterAction.toLowerCase()));
    }
    return logs;
  }
}

module.exports = new DatabaseManager();
