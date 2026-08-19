// JR INVENT - Camada Única de Dados (Firebase Firestore)
// Este módulo concentra todas as chamadas ao Firestore, viabilizando persistência offline nativa
// e centralizando a lógica de banco de dados do aplicativo.

import { db } from "./firebase-config.js";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  addDoc,
  query,
  where,
  orderBy,
  limit,
  onSnapshot,
  runTransaction,
  writeBatch,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

// Mapa de cancelamento de assinaturas ativas de itens
const activeItemSubscriptions = new Map();

/**
 * Retorna o inventário ativo a partir do singleton meta/activeInventory
 */
export async function getActiveInventory() {
  try {
    const activeMetaRef = doc(db, "meta", "activeInventory");
    const metaSnap = await getDoc(activeMetaRef);

    if (metaSnap.exists()) {
      const activeId = metaSnap.data()?.inventoryId;
      if (activeId) {
        const invRef = doc(db, "inventories", activeId);
        const invSnap = await getDoc(invRef);
        if (invSnap.exists()) {
          return { id: invSnap.id, ...invSnap.data() };
        }
      }
    }
    return null;
  } catch (err) {
    console.error("Erro ao buscar inventário ativo no Firestore:", err);
    return null;
  }
}

/**
 * Cria um novo inventário e insere itens em lotes (writeBatch de até 500 operações)
 * Usa transação atômica para checar a trava meta/activeInventory contra inventários duplicados
 */
export async function startInventory({ adminName, adminPassword, inventoryName, scopeFilter = "Geral", excelFile, items = [] }) {
  const invCol = collection(db, "inventories");
  const newInvRef = doc(invCol);
  const activeMetaRef = doc(db, "meta", "activeInventory");
  const now = new Date();
  const year = now.getFullYear();
  const code = `INV-${year}-${String(Date.now()).slice(-4)}`;

  const inventoryData = {
    code: code,
    name: inventoryName || `Inventário ${code}`,
    responsible: adminName || "Administrador",
    adminPassword: String(adminPassword || "1234"),
    status: "Em andamento",
    isLocked: false,
    scopeFilter: scopeFilter,
    itemsCount: items.length,
    startDate: now.toISOString(),
    createdAt: serverTimestamp()
  };

  await runTransaction(db, async (tx) => {
    const metaSnap = await tx.get(activeMetaRef);
    if (metaSnap.exists()) {
      const activeId = metaSnap.data()?.inventoryId;
      if (activeId) {
        const activeInvSnap = await tx.get(doc(db, "inventories", activeId));
        if (activeInvSnap.exists() && activeInvSnap.data()?.status === "Em andamento") {
          const err = new Error("INVENTARIO_JA_ATIVO");
          err.activeInventory = { id: activeInvSnap.id, ...activeInvSnap.data() };
          throw err;
        }
      }
    }

    tx.set(newInvRef, inventoryData);
    tx.set(activeMetaRef, { inventoryId: newInvRef.id }, { merge: true });
  });

  // Inserção em lotes de 500 itens (limite máximo do Firestore writeBatch)
  const batchSize = 500;
  for (let i = 0; i < items.length; i += batchSize) {
    const chunk = items.slice(i, i + batchSize);
    const batch = writeBatch(db);

    chunk.forEach((item, chunkIdx) => {
      const itemId = `item_${i + chunkIdx + 1}`;
      const itemRef = doc(db, `inventories/${newInvRef.id}/items/${itemId}`);
      batch.set(itemRef, {
        codigo: String(item.codigo || "").trim(),
        descricao: String(item.descricao || "").trim(),
        deposito: String(item.deposito || "Almoxarifado Principal").trim(),
        quantidadeTeorica: Number(item.quantidadeTeorica || 0),
        quantidadeContada: null,
        diferenca: null,
        precoUltimaEntrada: Number(item.precoUltimaEntrada || 0),
        custoMedio: Number(item.custoMedio || 0),
        valorTotal: Number(item.valorTotal || (item.quantidadeTeorica * item.custoMedio) || 0),
        status: "nao_contado",
        countStage: 1,
        operator: null,
        countedAt: null,
        observacao: null,
        naoEncontrado: false,
        itemAvulso: false,
        adminJustification: null,
        adminApprovedBy: null,
        adminApprovedAt: null,
        version: 1
      });
    });

    await batch.commit();
  }

  // Registra log de auditoria
  await addAuditLog(newInvRef.id, {
    user: adminName || "Administrador",
    role: "admin",
    action: "Inventário Criado",
    details: `Inventário ${code} criado com ${items.length} itens importados.`
  });

  return { id: newInvRef.id, ...inventoryData };
}

/**
 * Registra entrada de auditor para notificação em tempo real do Admin
 */
export async function joinAsAuditor({ name, inventoryId }) {
  await addAuditLog(inventoryId, {
    user: name || "Auditor",
    role: "operator",
    action: "Entrada de Auditor",
    details: `${name} entrou no inventário para contagem física.`
  });
}

/**
 * Assinatura em tempo real dos itens do inventário com indicador de pendência offline
 * Retorna e armazena a função de cancelamento da assinatura.
 */
export function subscribeToItems(inventoryId, onChange) {
  // Se já houver assinatura prévia para este inventário, cancela antes de criar nova
  unsubscribeFromItems(inventoryId);

  const itemsCol = collection(db, `inventories/${inventoryId}/items`);
  const unsubscribe = onSnapshot(itemsCol, { includeMetadataChanges: true }, (snapshot) => {
    const items = snapshot.docs.map(d => ({
      id: d.id,
      ...d.data(),
      _pendingSync: d.metadata.hasPendingWrites
    }));
    onChange(items, snapshot.metadata);
  }, (err) => {
    console.error("Erro na assinatura de itens:", err);
  });

  activeItemSubscriptions.set(inventoryId, unsubscribe);
  return unsubscribe;
}

/**
 * Cancela a assinatura em tempo real dos itens de um inventário
 */
export function unsubscribeFromItems(inventoryId) {
  if (activeItemSubscriptions.has(inventoryId)) {
    const unsub = activeItemSubscriptions.get(inventoryId);
    if (typeof unsub === "function") {
      unsub();
    }
    activeItemSubscriptions.delete(inventoryId);
  }
}

/**
 * Assinatura em tempo real para avisar o Admin quando novos auditores entram.
 * Ignora o snapshot inicial com dados históricos já existentes.
 */
export function subscribeToAuditorJoins(inventoryId, onJoin) {
  let firstSnapshot = true;
  const q = query(
    collection(db, `inventories/${inventoryId}/auditLogs`),
    where("action", "==", "Entrada de Auditor")
  );

  return onSnapshot(q, (snapshot) => {
    if (firstSnapshot) {
      firstSnapshot = false; // Ignora logs que já existiam antes de assinar
      return;
    }
    snapshot.docChanges().forEach((change) => {
      if (change.type === "added") {
        onJoin(change.doc.data());
      }
    });
  }, (err) => {
    console.error("Erro na assinatura de entrada de auditores:", err);
  });
}

/**
 * Salva contagem com transação atômica (prevenção de conflito de escrita simultânea)
 * Suporta contagem normal e flag de item não encontrado fisicamente.
 */
export async function saveCount(inventoryId, itemId, { quantidadeContada, operator, observacao, expectedVersion, naoEncontrado = false }) {
  const itemRef = doc(db, `inventories/${inventoryId}/items/${itemId}`);

  await runTransaction(db, async (tx) => {
    const snap = await tx.get(itemRef);
    if (!snap.exists()) throw new Error("Item não encontrado");

    const current = snap.data();
    if (expectedVersion !== undefined && current.version !== undefined && current.version !== expectedVersion) {
      const err = new Error("CONFLITO");
      err.currentItem = current;
      throw err;
    }

    let valorContado = Number(quantidadeContada) || 0;
    let diferenca = 0;
    let status = "sem_divergencia";
    let countStage = 2;

    if (naoEncontrado) {
      valorContado = 0;
      diferenca = 0 - (Number(current.quantidadeTeorica) || 0);
      status = (Number(current.quantidadeTeorica) || 0) > 0 ? "divergencia" : "sem_divergencia";
      countStage = status === "divergencia" ? 3 : 2;
    } else {
      diferenca = valorContado - (Number(current.quantidadeTeorica) || 0);
      status = diferenca !== 0 ? "divergencia" : "sem_divergencia";
      countStage = diferenca !== 0 ? 3 : 2;
    }

    tx.update(itemRef, {
      quantidadeContada: valorContado,
      diferenca: diferenca,
      operator: operator || "Operador",
      observacao: observacao || null,
      status: status,
      countStage: countStage,
      naoEncontrado: Boolean(naoEncontrado),
      countedAt: new Date().toISOString(),
      version: (current.version || 1) + 1
    });
  });

  // Log de auditoria (assíncrono e otimista)
  addAuditLog(inventoryId, {
    user: operator || "Operador",
    role: "operator",
    action: naoEncontrado ? "Item Não Localizado" : "Contagem Registrada",
    details: naoEncontrado 
      ? `Item marcado como não localizado no depósito. (Item ID: ${itemId})`
      : `Qtd contada: ${quantidadeContada}. ${observacao ? `Obs: ${observacao}` : ""}`
  }).catch(() => {});
}

/**
 * Adiciona um item avulso encontrado no físico mas que não constava na planilha
 */
export async function addAdhocItem(inventoryId, { codigo, descricao, deposito, quantidadeContada, operator }) {
  const itemsCol = collection(db, `inventories/${inventoryId}/items`);
  const newItemRef = doc(itemsCol);
  const valorContado = Number(quantidadeContada) || 0;
  const codigoFinal = (codigo && String(codigo).trim()) || `AVULSO-${String(Date.now()).slice(-4)}`;

  const itemData = {
    codigo: codigoFinal,
    descricao: (descricao && String(descricao).trim()) || "Item Avulso sem descrição",
    deposito: (deposito && String(deposito).trim()) || "Almoxarifado Principal",
    quantidadeTeorica: 0,
    quantidadeContada: valorContado,
    diferenca: valorContado,
    precoUltimaEntrada: 0,
    custoMedio: 0,
    valorTotal: 0,
    status: valorContado > 0 ? "divergencia" : "sem_divergencia",
    countStage: 3,
    itemAvulso: true,
    naoEncontrado: false,
    operator: operator || "Operador",
    countedAt: new Date().toISOString(),
    observacao: "Item físico não cadastrado na planilha original",
    adminJustification: null,
    adminApprovedBy: null,
    adminApprovedAt: null,
    version: 1
  };

  await setDoc(newItemRef, itemData);

  addAuditLog(inventoryId, {
    user: operator || "Operador",
    role: "operator",
    action: "Item Avulso Adicionado",
    details: `Adicionado item físico '${codigoFinal} - ${itemData.descricao}' (Qtd: ${valorContado})`
  }).catch(() => {});

  return { id: newItemRef.id, ...itemData };
}

/**
 * Liberação de divergência (Terceira Contagem / Atestado Administrativo)
 */
export async function approveDivergence(inventoryId, itemId, { quantidadeContada, justification, observacao, adminUser, adminPassword }) {
  const itemRef = doc(db, `inventories/${inventoryId}/items/${itemId}`);
  const snap = await getDoc(itemRef);
  if (!snap.exists()) throw new Error("Item não encontrado");

  const current = snap.data();
  const valorAprovado = Number(quantidadeContada);
  const novaDiferenca = valorAprovado - (Number(current.quantidadeTeorica) || 0);

  await updateDoc(itemRef, {
    quantidadeContada: valorAprovado,
    diferenca: novaDiferenca,
    observacao: observacao || current.observacao || null,
    status: "sem_divergencia",
    countStage: 3,
    adminJustification: justification || "Aprovado por conferência física",
    adminApprovedBy: adminUser || "Admin",
    adminApprovedAt: new Date().toISOString(),
    version: (current.version || 1) + 1
  });

  await addAuditLog(inventoryId, {
    user: adminUser || "Admin",
    role: "admin",
    action: "Divergência Aprovada",
    details: `Item ${current.codigo}: Qtd final aprovada ${valorAprovado}. Justificativa: ${justification || "Sem justificativa"}`
  });
}

/**
 * Encerra e bloqueia o inventário, liberando a trava meta/activeInventory
 */
export async function finalizeInventory(inventoryId, { adminUser, adminPassword }) {
  const invRef = doc(db, `inventories/${inventoryId}`);
  const activeMetaRef = doc(db, "meta", "activeInventory");

  await updateDoc(invRef, {
    status: "Finalizado",
    isLocked: true,
    endDate: new Date().toISOString()
  });

  // Limpa a trava no meta/activeInventory
  await setDoc(activeMetaRef, { inventoryId: null }, { merge: true });

  await addAuditLog(inventoryId, {
    user: adminUser || "Admin",
    role: "admin",
    action: "Inventário Finalizado",
    details: `Inventário encerrado e bloqueado para novas alterações por ${adminUser || "Admin"}.`
  });
}

/**
 * Reabre o inventário bloqueado após checar a trava meta/activeInventory contra outros inventários ativos
 */
export async function reopenInventory(inventoryId, { adminUser, adminPassword }) {
  const invRef = doc(db, `inventories/${inventoryId}`);
  const activeMetaRef = doc(db, "meta", "activeInventory");

  await runTransaction(db, async (tx) => {
    const metaSnap = await tx.get(activeMetaRef);
    if (metaSnap.exists()) {
      const activeId = metaSnap.data()?.inventoryId;
      if (activeId && activeId !== inventoryId) {
        const otherInvSnap = await tx.get(doc(db, "inventories", activeId));
        if (otherInvSnap.exists() && otherInvSnap.data()?.status === "Em andamento") {
          const err = new Error("INVENTARIO_JA_ATIVO");
          err.activeInventory = { id: otherInvSnap.id, ...otherInvSnap.data() };
          throw err;
        }
      }
    }

    tx.update(invRef, {
      status: "Em andamento",
      isLocked: false,
      reopenedAt: new Date().toISOString()
    });

    tx.set(activeMetaRef, { inventoryId: inventoryId }, { merge: true });
  });

  await addAuditLog(inventoryId, {
    user: adminUser || "Admin",
    role: "admin",
    action: "Inventário Reaberto",
    details: `Inventário reaberto para contagem física por ${adminUser || "Admin"}.`
  });
}

/**
 * Registra uma entrada na subcoleção auditLogs
 */
export async function addAuditLog(inventoryId, { user, role, action, details }) {
  try {
    const logsCol = collection(db, `inventories/${inventoryId}/auditLogs`);
    const now = new Date();
    await addDoc(logsCol, {
      user: user || "Sistema",
      role: role || "system",
      action: action || "Ação",
      details: details || "",
      date: now.toLocaleDateString("pt-BR"),
      time: now.toLocaleTimeString("pt-BR"),
      timestamp: Date.now(),
      createdAt: serverTimestamp()
    });
  } catch (e) {
    console.warn("Não foi possível gravar log de auditoria imediatamente (será enviado quando online):", e);
  }
}

/**
 * Busca estática do histórico de auditoria (leitura pontual via getDocs)
 */
export async function getAuditLogs(inventoryId) {
  try {
    const logsCol = collection(db, `inventories/${inventoryId}/auditLogs`);
    const q = query(logsCol, orderBy("timestamp", "desc"));
    const snap = await getDocs(q);
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (err) {
    console.error("Erro ao buscar logs de auditoria:", err);
    return [];
  }
}

/**
 * Assinatura em tempo real da auditoria
 */
export function subscribeToAuditLogs(inventoryId, onLogs) {
  const logsCol = collection(db, `inventories/${inventoryId}/auditLogs`);
  const q = query(logsCol, orderBy("timestamp", "desc"), limit(100));
  return onSnapshot(q, (snapshot) => {
    const logs = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    onLogs(logs);
  }, (err) => {
    console.error("Erro na assinatura de auditoria:", err);
  });
}

/**
 * Leitura independente dos KPIs do Dashboard (getDocs pontual)
 * Mantém a tela de contagem dedicada à contagem sem recalcular KPIs a cada alteração.
 * Ignora itens mesclados (mesclado === true) para não duplicar valores.
 */
export async function getDashboardMetrics(inventoryId) {
  const itemsCol = collection(db, `inventories/${inventoryId}/items`);
  const snap = await getDocs(itemsCol);
  // Filtra itens ativos (não absorvidos por mesclagem)
  const items = snap.docs
    .map(d => ({ id: d.id, ...d.data() }))
    .filter(i => !i.mesclado);

  const totalItems = items.length;
  const counted = items.filter(i => i.status !== "nao_contado").length;
  const pending = items.filter(i => i.status === "nao_contado").length;
  const divergent = items.filter(i => i.status === "divergencia").length;
  const nonLocated = items.filter(i => i.naoEncontrado).length;

  const totalTheorVal = items.reduce((s, i) => s + (Number(i.valorTotal) || (Number(i.quantidadeTeorica || 0) * Number(i.custoMedio || 0)) || 0), 0);
  const totalInventVal = items.reduce((s, i) => s + ((Number(i.quantidadeContada) || 0) * (Number(i.custoMedio) || 0)), 0);

  const operatorStats = {};
  items.filter(i => i.operator).forEach(i => {
    if (!operatorStats[i.operator]) operatorStats[i.operator] = { count: 0, noDiv: 0, div: 0 };
    operatorStats[i.operator].count++;
    if (i.status === "divergencia") operatorStats[i.operator].div++;
    else operatorStats[i.operator].noDiv++;
  });

  const depositStats = {};
  items.forEach(i => {
    const dep = i.deposito || "Almoxarifado";
    if (!depositStats[dep]) depositStats[dep] = { total: 0, counted: 0, pending: 0, divergent: 0 };
    depositStats[dep].total++;
    if (i.status === "nao_contado") depositStats[dep].pending++;
    else {
      depositStats[dep].counted++;
      if (i.status === "divergencia") depositStats[dep].divergent++;
    }
  });

  return {
    totalItems,
    countedItems: counted,
    pendingItems: pending,
    divergentItems: divergent,
    nonLocatedItems: nonLocated,
    completionPercent: totalItems > 0 ? ((counted / totalItems) * 100).toFixed(1) : "0.0",
    totalTheoreticalValue: totalTheorVal,
    totalInventoriedValue: totalInventVal,
    financialDiff: totalInventVal - totalTheorVal,
    totalDifferenceQty: items.reduce((s, i) => s + (Number(i.diferenca) || 0), 0),
    operatorStats,
    depositStats
  };
}

/**
 * Normaliza texto para comparação de duplicidades (remove acentos, pontuação e espaços extras)
 */
function normalizeForComparison(str) {
  if (!str) return "";
  return String(str)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Normaliza código para comparação (remove espaços e maiúsculas)
 */
function normalizeCodeForComparison(str) {
  if (!str) return "";
  return String(str)
    .toLowerCase()
    .replace(/\s+/g, "")
    .trim();
}

/**
 * Calcula similaridade entre duas strings normalizadas (Dice Coefficient + Substring)
 */
function calculateTextSimilarity(strA, strB) {
  if (!strA || !strB) return 0;
  if (strA === strB) return 1.0;

  // Se uma contém a outra com tamanho relevante
  if (strA.includes(strB) || strB.includes(strA)) {
    const minLen = Math.min(strA.length, strB.length);
    const maxLen = Math.max(strA.length, strB.length);
    if (minLen >= 4 && minLen / maxLen >= 0.5) return 0.85;
  }

  // Coeficiente de Dice por bigramas
  const getBigrams = (s) => {
    const set = new Set();
    for (let i = 0; i < s.length - 1; i++) set.add(s.substring(i, i + 2));
    return set;
  };

  const bgA = getBigrams(strA);
  const bgB = getBigrams(strB);
  if (bgA.size === 0 || bgB.size === 0) return 0;

  let common = 0;
  for (const b of bgA) {
    if (bgB.has(b)) common++;
  }

  return (2 * common) / (bgA.size + bgB.size);
}

/**
 * Identifica itens duplicados potenciais no inventário (mesmo código ou mesma descrição no mesmo depósito)
 * Leitura própria (getDocs), mesmo padrão isolado do Dashboard.
 * Ignora itens já mesclados (mesclado === true).
 */
export async function findDuplicateCandidates(inventoryId) {
  try {
    const itemsCol = collection(db, `inventories/${inventoryId}/items`);
    const snap = await getDocs(itemsCol);
    const allItemsList = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(i => !i.mesclado);

    const candidates = [];
    const pairedKeys = new Set();

    // Agrupa por depósito para comparação focada
    const byDeposit = new Map();
    allItemsList.forEach(item => {
      const dep = normalizeForComparison(item.deposito || "Almoxarifado Principal");
      if (!byDeposit.has(dep)) byDeposit.set(dep, []);
      byDeposit.get(dep).push(item);
    });

    // 1. Varrer itens dentro do mesmo depósito
    for (const [depKey, depItems] of byDeposit.entries()) {
      for (let i = 0; i < depItems.length; i++) {
        for (let j = i + 1; j < depItems.length; j++) {
          const itemA = depItems[i];
          const itemB = depItems[j];

          const pairKey = [itemA.id, itemB.id].sort().join("___");
          if (pairedKeys.has(pairKey)) continue;

          const codeA = normalizeCodeForComparison(itemA.codigo);
          const codeB = normalizeCodeForComparison(itemB.codigo);

          const descA = normalizeForComparison(itemA.descricao);
          const descB = normalizeForComparison(itemB.descricao);

          let reason = null;
          let similarity = 0;

          // Regra 1: Código idêntico (ignorando maiúsculas e espaços)
          const isGenericCode = (c) => !c || c === "avulso" || c.startsWith("avulso-") || c.startsWith("item-");
          if (codeA && codeB && !isGenericCode(codeA) && !isGenericCode(codeB) && codeA === codeB) {
            reason = `Código idêntico no mesmo depósito (${itemA.codigo})`;
            similarity = 1.0;
          } 
          // Regra 2: Descrição idêntica ou altamente similar no mesmo depósito
          else if (descA && descB && descA.length >= 4 && descB.length >= 4) {
            const sim = calculateTextSimilarity(descA, descB);
            if (descA === descB) {
              reason = `Descrição idêntica no mesmo depósito`;
              similarity = 1.0;
            } else if (sim >= 0.75) {
              reason = `Descrição muito parecida (~${Math.round(sim * 100)}% similar)`;
              similarity = sim;
            }
          }

          if (reason) {
            pairedKeys.add(pairKey);
            candidates.push({
              pairId: pairKey,
              reason: reason,
              similarity: similarity,
              deposito: itemA.deposito,
              itemA: itemA,
              itemB: itemB
            });
          }
        }
      }
    }

    // 2. Varrer itens com códigos idênticos mesmo em depósitos diferentes (se não forem genéricos)
    for (let i = 0; i < allItemsList.length; i++) {
      for (let j = i + 1; j < allItemsList.length; j++) {
        const itemA = allItemsList[i];
        const itemB = allItemsList[j];

        const pairKey = [itemA.id, itemB.id].sort().join("___");
        if (pairedKeys.has(pairKey)) continue;

        const codeA = normalizeCodeForComparison(itemA.codigo);
        const codeB = normalizeCodeForComparison(itemB.codigo);
        const isGenericCode = (c) => !c || c === "avulso" || c.startsWith("avulso-") || c.startsWith("item-");

        if (codeA && codeB && !isGenericCode(codeA) && !isGenericCode(codeB) && codeA === codeB) {
          pairedKeys.add(pairKey);
          candidates.push({
            pairId: pairKey,
            reason: `Código idêntico em depósitos diferentes (${itemA.deposito} vs ${itemB.deposito})`,
            similarity: 1.0,
            deposito: `${itemA.deposito} / ${itemB.deposito}`,
            itemA: itemA,
            itemB: itemB
          });
        }
      }
    }

    // Ordena candidatos por maior similaridade
    candidates.sort((a, b) => (b.similarity || 0) - (a.similarity || 0));
    return candidates;
  } catch (err) {
    console.error("Erro ao buscar itens duplicados:", err);
    return [];
  }
}

/**
 * Mescla dois itens duplicados (unifica contagens no item sobrevivente e marca o item absorvido como mesclado)
 * O item absorvido NUNCA é excluído: recebe mesclado: true e mescladoEm: survivorItemId
 */
export async function mergeItems(inventoryId, { survivorItemId, mergedItemId, adminUser, adminPassword }) {
  const survivorRef = doc(db, `inventories/${inventoryId}/items/${survivorItemId}`);
  const mergedRef = doc(db, `inventories/${inventoryId}/items/${mergedItemId}`);

  let finalCountedValue = null;
  let survivorCode = "";
  let survivorDesc = "";
  let mergedCode = "";
  let mergedDesc = "";

  await runTransaction(db, async (tx) => {
    const survivorSnap = await tx.get(survivorRef);
    const mergedSnap = await tx.get(mergedRef);

    if (!survivorSnap.exists() || !mergedSnap.exists()) {
      throw new Error("Um dos itens não foi encontrado para mesclagem.");
    }

    const survivor = survivorSnap.data();
    const merged = mergedSnap.data();

    if (survivor.mesclado || merged.mesclado) {
      throw new Error("Um dos itens selecionados já foi absorvido em outra mesclagem.");
    }

    survivorCode = survivor.codigo || "";
    survivorDesc = survivor.descricao || "";
    mergedCode = merged.codigo || "";
    mergedDesc = merged.descricao || "";

    // 2. Soma as quantidades contadas físicas dos dois itens
    const survivorContada = survivor.quantidadeContada !== null && survivor.quantidadeContada !== undefined ? Number(survivor.quantidadeContada) : null;
    const mergedContada = merged.quantidadeContada !== null && merged.quantidadeContada !== undefined ? Number(merged.quantidadeContada) : null;

    const hasAnyCount = survivorContada !== null || mergedContada !== null;
    finalCountedValue = hasAnyCount ? ((survivorContada || 0) + (mergedContada || 0)) : null;

    const qtdTeorica = Number(survivor.quantidadeTeorica) || 0;
    const diferenca = finalCountedValue !== null ? (finalCountedValue - qtdTeorica) : null;
    const status = finalCountedValue === null ? "nao_contado" : (diferenca === 0 ? "sem_divergencia" : "divergencia");
    const countStage = status === "divergencia" ? 3 : (finalCountedValue !== null ? 2 : 1);

    // 3. Atualiza o item sobrevivente com a soma e histórico
    tx.update(survivorRef, {
      quantidadeContada: finalCountedValue,
      diferenca: diferenca,
      status: status,
      countStage: countStage,
      observacao: `[Mesclado com ${mergedCode} - ${mergedDesc}] ${survivor.observacao || ""}`.trim(),
      version: (survivor.version || 1) + 1
    });

    // 4. Marca o item absorvido como mesclado (NUNCA apaga do Firestore)
    tx.update(mergedRef, {
      mesclado: true,
      mescladoEm: survivorItemId,
      mescladoPor: adminUser || "Admin",
      mescladoEmData: new Date().toISOString(),
      version: (merged.version || 1) + 1
    });
  });

  // 5. Grava em auditLogs: action 'Mesclagem de Itens Duplicados' com atestado
  await addAuditLog(inventoryId, {
    user: adminUser || "Admin",
    role: "admin",
    action: "Mesclagem de Itens Duplicados",
    details: `Item absorvido '${mergedCode} - ${mergedDesc}' mesclado no sobrevivente '${survivorCode} - ${survivorDesc}'. Quantidade contada final unificada: ${finalCountedValue !== null ? finalCountedValue : "Pendente"}.`
  });

  return { survivorItemId, mergedItemId, finalCountedValue };
}
