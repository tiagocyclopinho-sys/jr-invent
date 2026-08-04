const fs = require('fs');
const path = require('path');

// Embedded default database state for zero-dependency Netlify Serverless execution
let dbMemory = {
  users: [
    { id: 'usr_admin', username: 'admin', passwordHash: 'admin123', name: 'Administrador JR', role: 'admin' },
    { id: 'usr_op1', username: 'operador1', passwordHash: 'op123', name: 'Thiago Ferreira', role: 'operator' },
    { id: 'usr_op2', username: 'operador2', passwordHash: 'op123', name: 'Carlos Silva', role: 'operator' },
    { id: 'usr_op3', username: 'operador3', passwordHash: 'op123', name: 'Ana Paula', role: 'operator' }
  ],
  inventories: [
    {
      id: 'inv_001',
      code: 'INV-2026-001',
      name: 'Inventário Geral - Almoxarifado JR',
      startDate: new Date().toISOString().split('T')[0],
      endDate: null,
      responsible: 'Administrador JR',
      status: 'Em andamento',
      isLocked: false,
      scopeFilter: 'Geral',
      itemsCount: 1561,
      createdAt: new Date().toISOString()
    }
  ],
  items: [],
  auditLogs: []
};

// Seed items if memory is empty
function ensureSeededItems() {
  if (dbMemory.items.length > 0) return;

  // Try loading from local json if exists in lambda
  try {
    const localDbPath = path.join(__dirname, '..', '..', 'data', 'db.json');
    if (fs.existsSync(localDbPath)) {
      const raw = fs.readFileSync(localDbPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed.items && parsed.items.length > 0) {
        dbMemory.items = parsed.items;
        dbMemory.inventories = parsed.inventories || dbMemory.inventories;
        return;
      }
    }
  } catch (err) {}

  // Fallback demo items if db.json is not bundled by Netlify
  const sampleDeposits = ['Almoxarifado Oficina', 'PRT B1 - NVL 01', 'PRT A - NVL 02', 'LAVAJATO'];
  const sampleProducts = [
    { code: 'ZN141451', desc: 'FAROL AUXILIAR VW LD', q: 10, c: 131.00 },
    { code: 'ZN141450', desc: 'FAROL AUXILIAR VW LE', q: 15, c: 131.00 },
    { code: 'X8880109', desc: 'REGULADOR DE PRESSAO FILTRO', q: 5, c: 398.36 },
    { code: 'WK10002/1X', desc: 'FILTRO SEPARADOR DE AGUA - RACOR', q: 22, c: 147.78 },
    { code: 'VE0461694STD', desc: 'VALVULA DE ESCAPE MOTOR D08', q: 8, c: 84.34 },
    { code: 'UB672', desc: 'BOMBA D AGUA VW/MAN CONSTELLATION', q: 12, c: 523.69 }
  ];

  let idx = 1;
  sampleDeposits.forEach(dep => {
    sampleProducts.forEach(prod => {
      dbMemory.items.push({
        id: `item_inv_001_${idx}`,
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
        adminApprovedAt: null,
        version: 1
      });
      idx++;
    });
  });
}

exports.handler = async (event, context) => {
  ensureSeededItems();

  const method = event.httpMethod;
  let pathname = event.path || '/';

  if (pathname.includes('/.netlify/functions/api')) {
    pathname = pathname.replace('/.netlify/functions/api', '/api');
  }

  const defaultHeaders = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS'
  };

  if (method === 'OPTIONS') {
    return { statusCode: 204, headers: defaultHeaders };
  }

  try {
    let body = {};
    if (event.body) {
      try {
        body = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body);
      } catch (e) {}
    }

    const params = event.queryStringParameters || {};

    // LOGIN
    if (pathname.includes('/login')) {
      const user = dbMemory.users.find(u => u.username.toLowerCase() === (body.username || '').toLowerCase() && u.passwordHash === body.password);
      if (!user) {
        return { statusCode: 401, headers: defaultHeaders, body: JSON.stringify({ error: 'Usuário ou senha incorretos' }) };
      }
      return { statusCode: 200, headers: defaultHeaders, body: JSON.stringify({ success: true, user: { id: user.id, username: user.username, name: user.name, role: user.role } }) };
    }

    // INVENTORIES
    if (pathname.includes('/inventories') && !pathname.includes('/items') && !pathname.includes('/deposits') && !pathname.includes('/dashboard') && method === 'GET') {
      return { statusCode: 200, headers: defaultHeaders, body: JSON.stringify({ inventories: dbMemory.inventories }) };
    }

    // ITEMS
    if (pathname.includes('/items') && !pathname.includes('/count') && !pathname.includes('/approve') && method === 'GET') {
      let items = dbMemory.items;
      if (params.deposito && params.deposito !== 'Todos') {
        items = items.filter(i => i.deposito === params.deposito);
      }
      if (params.search) {
        const q = params.search.toLowerCase();
        items = items.filter(i => i.codigo.toLowerCase().includes(q) || i.descricao.toLowerCase().includes(q));
      }
      return { statusCode: 200, headers: defaultHeaders, body: JSON.stringify({ items, count: items.length }) };
    }

    // DEPOSITS
    if (pathname.includes('/deposits') && method === 'GET') {
      const deposits = Array.from(new Set(dbMemory.items.map(i => i.deposito))).sort();
      return { statusCode: 200, headers: defaultHeaders, body: JSON.stringify({ deposits }) };
    }

    // SAVE COUNT
    if (pathname.includes('/count') && method === 'POST') {
      const itemId = pathname.split('/')[3];
      const item = dbMemory.items.find(i => i.id === itemId);
      if (!item) return { statusCode: 404, headers: defaultHeaders, body: JSON.stringify({ error: 'Item não encontrado' }) };

      const qty = parseFloat(body.quantidadeContada);
      item.quantidadeContada = qty;
      item.diferenca = qty - item.quantidadeTeorica;
      item.operator = body.operator;
      item.countedAt = new Date().toLocaleString('pt-BR');
      item.observacao = body.observacao || null;

      if (item.quantidadeTeorica === qty) {
        item.status = 'sem_divergencia';
      } else {
        item.status = 'divergencia';
        item.countStage = 3;
      }

      return { statusCode: 200, headers: defaultHeaders, body: JSON.stringify({ success: true, item }) };
    }

    // APPROVE DIVERGENCE
    if (pathname.includes('/approve') && method === 'POST') {
      const itemId = pathname.split('/')[3];
      const item = dbMemory.items.find(i => i.id === itemId);
      if (!item) return { statusCode: 404, headers: defaultHeaders, body: JSON.stringify({ error: 'Item não encontrado' }) };

      const qty = parseFloat(body.quantidadeContada);
      item.quantidadeContada = qty;
      item.diferenca = qty - item.quantidadeTeorica;
      item.status = 'sem_divergencia';
      item.adminJustification = body.justification;
      item.adminApprovedBy = body.adminUser;

      return { statusCode: 200, headers: defaultHeaders, body: JSON.stringify({ success: true, item }) };
    }

    // DASHBOARD
    if (pathname.includes('/dashboard') && method === 'GET') {
      const items = dbMemory.items;
      const totalItems = items.length;
      const countedItems = items.filter(i => i.status !== 'nao_contado').length;
      const pendingItems = totalItems - countedItems;
      const divergentItems = items.filter(i => i.status === 'divergencia').length;

      return {
        statusCode: 200,
        headers: defaultHeaders,
        body: JSON.stringify({
          metrics: {
            totalItems,
            countedItems,
            pendingItems,
            divergentItems,
            completionPercent: totalItems > 0 ? ((countedItems / totalItems) * 100).toFixed(1) : '0.0',
            totalTheoreticalValue: items.reduce((acc, i) => acc + (i.valorTotal || 0), 0),
            totalInventoriedValue: items.reduce((acc, i) => acc + ((i.quantidadeContada || 0) * i.custoMedio), 0),
            financialDiff: 0,
            totalDifferenceQty: 0,
            operatorStats: {},
            depositStats: {}
          }
        })
      };
    }

    // AUDIT
    if (pathname.includes('/audit') && method === 'GET') {
      return { statusCode: 200, headers: defaultHeaders, body: JSON.stringify({ logs: dbMemory.auditLogs }) };
    }

    return { statusCode: 200, headers: defaultHeaders, body: JSON.stringify({ ok: true }) };

  } catch (err) {
    return {
      statusCode: 500,
      headers: defaultHeaders,
      body: JSON.stringify({ error: err.message })
    };
  }
};
