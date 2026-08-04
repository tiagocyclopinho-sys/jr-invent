const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db_manager');

const PORT = process.env.PORT || 3000;

// --- Simple WebSocket Server in pure Node ---
const wsClients = new Set();

function setupWebSocketServer(server) {
  server.on('upgrade', (req, socket, head) => {
    if (req.headers['upgrade'] !== 'websocket') {
      socket.destroy();
      return;
    }

    const key = req.headers['sec-websocket-key'];
    const acceptKey = crypto
      .createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');

    const headers = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptKey}`
    ];

    socket.write(headers.join('\r\n') + '\r\n\r\n');
    wsClients.add(socket);

    socket.on('close', () => {
      wsClients.delete(socket);
    });

    socket.on('error', () => {
      wsClients.delete(socket);
    });

    socket.on('data', (buffer) => {
      // Handle ping or client messages if needed
      if (buffer[0] === 0x88) { // Close frame
        socket.end();
        wsClients.delete(socket);
      }
    });
  });
}

function broadcast(event, payload) {
  const json = JSON.stringify({ event, payload, timestamp: new Date().toISOString() });
  const data = Buffer.from(json, 'utf8');

  // Build WebSocket frame (text, unmasked from server)
  const length = data.length;
  let header;

  if (length <= 125) {
    header = Buffer.from([0x81, length]);
  } else if (length <= 65535) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }

  const frame = Buffer.concat([header, data]);

  for (const client of wsClients) {
    if (client.writable) {
      client.write(frame);
    }
  }
}

// --- Body Parser Helper ---
function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(new Error('Formato JSON inválido'));
      }
    });
  });
}

function parseRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

// --- HTTP Request Handler ---
const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;
  const method = req.method;

  // CORS Headers for network access
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    // --- API ROUTES ---
    if (pathname === '/api/login' && method === 'POST') {
      const body = await parseJsonBody(req);
      const user = db.authenticate(body.username, body.password);
      if (!user) {
        res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Usuário ou senha incorretos' }));
        return;
      }
      db.addAuditLog(user.name, user.role, 'Login', `Usuário ${user.username} realizou login no aplicativo.`);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: true, user }));
      return;
    }

    if (pathname === '/api/logout' && method === 'POST') {
      const body = await parseJsonBody(req);
      db.addAuditLog(body.username || 'Operador', body.role || 'user', 'Logout', 'Sessão encerrada.');
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: true }));
      return;
    }

    if (pathname === '/api/inventories' && method === 'GET') {
      const list = db.getInventories();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ inventories: list }));
      return;
    }

    if (pathname === '/api/inventories' && method === 'POST') {
      const body = await parseJsonBody(req);
      const newInv = db.createInventory(body.name, body.responsible, body.scopeFilter);
      broadcast('INVENTORY_CREATED', newInv);
      res.writeHead(201, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ inventory: newInv }));
      return;
    }

    if (pathname.match(/^\/api\/inventories\/([^/]+)\/finalize$/) && method === 'POST') {
      const invId = pathname.split('/')[3];
      const body = await parseJsonBody(req);
      const inv = db.finalizeInventory(invId, body.username || 'Admin');
      broadcast('INVENTORY_FINALIZED', inv);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ inventory: inv }));
      return;
    }

    if (pathname.match(/^\/api\/inventories\/([^/]+)\/reopen$/) && method === 'POST') {
      const invId = pathname.split('/')[3];
      const body = await parseJsonBody(req);
      const inv = db.reopenInventory(invId, body.username, body.password);
      broadcast('INVENTORY_REOPENED', inv);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ inventory: inv }));
      return;
    }

    if (pathname.match(/^\/api\/inventories\/([^/]+)\/items$/) && method === 'GET') {
      const invId = pathname.split('/')[3];
      const deposito = parsedUrl.searchParams.get('deposito') || 'Todos';
      const status = parsedUrl.searchParams.get('status') || 'Todos';
      const search = parsedUrl.searchParams.get('search') || '';

      const items = db.getItemsByInventory(invId, { deposito, status, search });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ items, count: items.length }));
      return;
    }

    if (pathname.match(/^\/api\/inventories\/([^/]+)\/deposits$/) && method === 'GET') {
      const invId = pathname.split('/')[3];
      const deposits = db.getDepositsList(invId);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ deposits }));
      return;
    }

    if (pathname.match(/^\/api\/items\/([^/]+)\/count$/) && method === 'POST') {
      const itemId = pathname.split('/')[3];
      const body = await parseJsonBody(req);
      const updatedItem = db.saveCount(itemId, body.quantidadeContada, body.operator, body.observacao);

      broadcast('COUNT_UPDATED', {
        item: updatedItem,
        operator: body.operator,
        inventoryId: updatedItem.inventoryId
      });

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: true, item: updatedItem }));
      return;
    }

    if (pathname.match(/^\/api\/items\/([^/]+)\/approve$/) && method === 'POST') {
      const itemId = pathname.split('/')[3];
      const body = await parseJsonBody(req);
      const approvedItem = db.approveDivergence(
        itemId,
        body.quantidadeContada,
        body.justification,
        body.observacao,
        body.adminUser || 'Admin'
      );

      broadcast('DIVERGENCE_APPROVED', {
        item: approvedItem,
        adminUser: body.adminUser
      });

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: true, item: approvedItem }));
      return;
    }

    if (pathname.match(/^\/api\/inventories\/([^/]+)\/dashboard$/) && method === 'GET') {
      const invId = pathname.split('/')[3];
      const metrics = db.getDashboardMetrics(invId);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ metrics }));
      return;
    }

    if (pathname === '/api/audit' && method === 'GET') {
      const user = parsedUrl.searchParams.get('user') || '';
      const action = parsedUrl.searchParams.get('action') || '';
      const logs = db.getAuditLogs(user, action);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ logs }));
      return;
    }

    if (pathname === '/api/upload-excel' && method === 'POST') {
      const rawBuffer = await parseRawBody(req);
      const name = parsedUrl.searchParams.get('name') || 'Inventário Importado';
      const responsible = parsedUrl.searchParams.get('responsible') || 'Administrador';
      const scopeFilter = parsedUrl.searchParams.get('scopeFilter') || 'Geral';

      const newInv = db.createInventory(name, responsible, scopeFilter, rawBuffer);
      broadcast('INVENTORY_CREATED', newInv);

      res.writeHead(201, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: true, inventory: newInv }));
      return;
    }

    // --- STATIC FILES SERVING ---
    let filePath = path.join(__dirname, pathname === '/' ? 'index.html' : pathname);

    // Basic sanitization against directory traversal
    if (!filePath.startsWith(__dirname)) {
      res.writeHead(403);
      res.end('Acesso Negado');
      return;
    }

    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(__dirname, 'index.html');
    }

    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.ico': 'image/x-icon',
      '.svg': 'image/svg+xml'
    };

    const contentType = mimeTypes[ext] || 'application/octet-stream';
    const content = fs.readFileSync(filePath);

    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache'
    });
    res.end(content);

  } catch (err) {
    console.error('API Error:', err);
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: err.message || 'Erro interno no servidor' }));
  }
});

setupWebSocketServer(server);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`====================================================`);
  console.log(` JR INVENT - Sistema de Inventário Físico`);
  console.log(` Servidor rodando em http://localhost:${PORT}`);
  console.log(` Suporte a Coletores/Smartphones Android na Wi-Fi local`);
  console.log(`====================================================`);
});
