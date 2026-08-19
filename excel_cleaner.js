// JR INVENT - Processamento de Planilhas Excel com SheetJS e Detecção Inteligente de Colunas

/**
 * Normaliza uma string removendo acentos e caracteres especiais para comparação flexível
 */
function normalizeHeaderStr(str) {
  if (!str) return "";
  return String(str)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

/**
 * Processa linhas brutas (array de arrays) extraídas pelo SheetJS
 * Realiza detecção dinâmica de colunas por nome de cabeçalho, forward-fill de depósito e separação código/descrição.
 */
export function cleanAndParseRows(rows) {
  if (!rows || !Array.isArray(rows) || rows.length === 0) {
    throw new Error("A planilha está vazia ou em formato inválido.");
  }

  // 1. Localizar linha de cabeçalho e mapear índices de colunas
  let headerRowIndex = -1;
  let colIndices = {
    deposito: -1,
    item: -1,
    codigo: -1,
    descricao: -1,
    saldo: -1,
    precoEntrada: -1,
    custoMedio: -1,
    valorTotal: -1
  };

  // Varrer até 15 primeiras linhas procurando o cabeçalho
  for (let r = 0; r < Math.min(rows.length, 15); r++) {
    const row = rows[r];
    if (!Array.isArray(row)) continue;

    const rowStrings = row.map(cell => normalizeHeaderStr(cell));

    const hasDep = rowStrings.some(s => s.includes("deposito") || s.includes("almox") || s.includes("galpao") || s.includes("setor") || s.includes("local"));
    const hasItem = rowStrings.some(s => s.includes("item") || s.includes("codigo") || s.includes("cod") || s.includes("descri") || s.includes("produto") || s.includes("material"));
    const hasSaldo = rowStrings.some(s => s.includes("saldo") || s.includes("qtd") || s.includes("quant") || s.includes("estoque"));

    if ((hasDep && hasItem) || (hasItem && hasSaldo) || (hasDep && hasSaldo)) {
      headerRowIndex = r;
      // Mapeia colunas encontradas
      rowStrings.forEach((str, idx) => {
        if (str.includes("deposito") || str.includes("almox") || str.includes("galpao") || str.includes("setor") || str.includes("local")) {
          if (colIndices.deposito === -1) colIndices.deposito = idx;
        } else if (str === "codigo" || str === "cod" || str.startsWith("cod.") || str.includes("codigo") || str.includes("referencia")) {
          if (colIndices.codigo === -1) colIndices.codigo = idx;
        } else if (str.includes("descricao") || str.includes("descr") || str.includes("produto") || str.includes("material")) {
          if (colIndices.descricao === -1) colIndices.descricao = idx;
        } else if (str === "item" || str.startsWith("item ")) {
          if (colIndices.item === -1) colIndices.item = idx;
        } else if (str.includes("saldo") || str.includes("qtd") || str.includes("quant") || str.includes("estoque")) {
          if (colIndices.saldo === -1) colIndices.saldo = idx;
        } else if (str.includes("ultima entrada") || str.includes("pr. entr") || str.includes("pr.entr") || str.includes("vl unit") || str.includes("preco")) {
          if (colIndices.precoEntrada === -1) colIndices.precoEntrada = idx;
        } else if (str.includes("custo medio") || str.includes("custo") || str === "cm") {
          if (colIndices.custoMedio === -1) colIndices.custoMedio = idx;
        } else if (str.includes("total") || str.includes("vlr total") || str.includes("valor total") || str === "vlr" || str === "valor") {
          if (colIndices.valorTotal === -1) colIndices.valorTotal = idx;
        }
      });
      break;
    }
  }

  // Fallback para posições padrão se o cabeçalho não foi encontrado de forma explícita
  if (headerRowIndex === -1) {
    headerRowIndex = 0;
    colIndices = {
      deposito: 0,
      item: 1,
      codigo: -1,
      descricao: -1,
      saldo: 2,
      precoEntrada: 3,
      custoMedio: 4,
      valorTotal: 5
    };
  } else {
    // Se colunas específicas não foram encontradas, define padrões relativos
    if (colIndices.deposito === -1) colIndices.deposito = 0;
    if (colIndices.item === -1 && colIndices.codigo === -1) colIndices.item = 1;
    if (colIndices.saldo === -1) colIndices.saldo = 2;
    if (colIndices.precoEntrada === -1) colIndices.precoEntrada = 3;
    if (colIndices.custoMedio === -1) colIndices.custoMedio = 4;
    if (colIndices.valorTotal === -1) colIndices.valorTotal = 5;
  }

  // 2. Extrair dados com forward-fill e tratamento
  const items = [];
  let currentDeposito = "";
  const distinctDepositsSet = new Set();
  const depositStatsMap = new Map(); // depName -> { count: 0, totalTheoreticalValue: 0, warningCount: 0 }
  let warningCount = 0;

  for (let r = headerRowIndex + 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || !Array.isArray(row) || row.length === 0) continue;

    const rawDep = colIndices.deposito !== -1 ? String(row[colIndices.deposito] || "").trim() : "";
    let rawItem = colIndices.item !== -1 ? String(row[colIndices.item] || "").trim() : "";
    let rawCod = colIndices.codigo !== -1 ? String(row[colIndices.codigo] || "").trim() : "";
    let rawDesc = colIndices.descricao !== -1 ? String(row[colIndices.descricao] || "").trim() : "";

    const rawSaldo = colIndices.saldo !== -1 ? row[colIndices.saldo] : 0;
    const rawPrecoEntr = colIndices.precoEntrada !== -1 ? row[colIndices.precoEntrada] : 0;
    const rawCustoMed = colIndices.custoMedio !== -1 ? row[colIndices.custoMedio] : 0;
    const rawTotal = colIndices.valorTotal !== -1 ? row[colIndices.valorTotal] : 0;

    // Ignora linha se vazia
    if (!rawDep && !rawItem && !rawCod && !rawDesc && (rawSaldo === undefined || rawSaldo === "")) continue;

    // Ignora linhas de totalização
    const lowerDep = rawDep.toLowerCase();
    const lowerItem = rawItem.toLowerCase();
    const lowerCod = rawCod.toLowerCase();
    if (lowerDep.startsWith("total") || lowerItem.startsWith("total") || lowerCod.startsWith("total")) {
      continue;
    }

    // Forward fill no depósito
    if (rawDep && !lowerDep.startsWith("total")) {
      currentDeposito = rawDep;
    }
    const finalDeposito = currentDeposito || "Almoxarifado Principal";
    distinctDepositsSet.add(finalDeposito);

    if (!depositStatsMap.has(finalDeposito)) {
      depositStatsMap.set(finalDeposito, { count: 0, totalTheoreticalValue: 0, warningCount: 0 });
    }
    const depStat = depositStatsMap.get(finalDeposito);

    // Separar código e descrição se vieram em uma única coluna
    let codigo = rawCod;
    let descricao = rawDesc;
    let isWarning = false;

    if (!codigo && !descricao && rawItem) {
      if (rawItem.includes(" - ")) {
        const parts = rawItem.split(" - ");
        codigo = parts[0].trim();
        descricao = parts.slice(1).join(" - ").trim();
      } else if (rawItem.includes(" ")) {
        const spaceIdx = rawItem.indexOf(" ");
        codigo = rawItem.substring(0, spaceIdx).trim();
        descricao = rawItem.substring(spaceIdx + 1).trim();
      } else {
        codigo = rawItem;
        descricao = rawItem;
      }
    } else if (codigo && !descricao) {
      descricao = codigo;
    } else if (!codigo && descricao) {
      codigo = descricao.slice(0, 15);
    }

    if (!codigo && !descricao) {
      warningCount++;
      depStat.warningCount++;
      isWarning = true;
      codigo = `ITEM-${r + 1}`;
      descricao = `Item sem descrição linha ${r + 1}`;
    }

    const qtdTeorica = parseNumericValue(rawSaldo);
    const precoUltimaEntrada = parseNumericValue(rawPrecoEntr);
    const custoMedio = parseNumericValue(rawCustoMed);
    let valorTotal = parseNumericValue(rawTotal);
    if (!valorTotal && qtdTeorica && custoMedio) {
      valorTotal = qtdTeorica * custoMedio;
    }

    depStat.count++;
    depStat.totalTheoreticalValue += valorTotal || 0;

    items.push({
      deposito: finalDeposito,
      codigo: codigo,
      descricao: descricao,
      quantidadeTeorica: qtdTeorica,
      precoUltimaEntrada: precoUltimaEntrada,
      custoMedio: custoMedio,
      valorTotal: valorTotal,
      isWarning: isWarning
    });
  }

  // Prevenção de duplicidade: Identifica códigos repetidos na própria planilha importada
  const codeTracker = new Map();
  items.forEach(item => {
    const codeNorm = String(item.codigo || "").toLowerCase().replace(/\s+/g, "").trim();
    if (codeNorm && !codeNorm.startsWith("item-")) {
      if (!codeTracker.has(codeNorm)) {
        codeTracker.set(codeNorm, { count: 0, originalCode: item.codigo, deposits: new Set() });
      }
      const entry = codeTracker.get(codeNorm);
      entry.count++;
      entry.deposits.add(item.deposito);
    }
  });

  const duplicateCodes = [];
  let totalDuplicateRows = 0;
  for (const [codeKey, entry] of codeTracker.entries()) {
    if (entry.count > 1) {
      duplicateCodes.push({
        code: entry.originalCode,
        occurrences: entry.count,
        deposits: Array.from(entry.deposits)
      });
      totalDuplicateRows += entry.count;
    }
  }

  const distinctDeposits = Array.from(distinctDepositsSet);
  const depositDetails = distinctDeposits.map(depName => {
    const stat = depositStatsMap.get(depName) || { count: 0, totalTheoreticalValue: 0, warningCount: 0 };
    return {
      name: depName,
      count: stat.count,
      totalTheoreticalValue: stat.totalTheoreticalValue,
      warningCount: stat.warningCount
    };
  });

  return {
    items: items,
    summary: {
      totalItems: items.length,
      distinctDeposits: distinctDeposits,
      depositsCount: distinctDeposits.length,
      depositDetails: depositDetails,
      warningCount: warningCount,
      totalTheoreticalValue: items.reduce((acc, i) => acc + (i.valorTotal || 0), 0),
      duplicates: {
        hasDuplicates: duplicateCodes.length > 0,
        duplicateCodesCount: duplicateCodes.length,
        duplicateRowsCount: totalDuplicateRows,
        duplicateCodes: duplicateCodes
      }
    }
  };
}

// Alias retrocompatível
export const cleanAndParseExcel = cleanAndParseRows;

/**
 * Lê um arquivo Excel (.xlsx / .xls) usando SheetJS e repassa para cleanAndParseRows
 */
export async function parseExcelFile(file) {
  if (typeof XLSX === "undefined") {
    throw new Error("A biblioteca SheetJS (XLSX) não foi carregada no navegador.");
  }
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: "array" });
  if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
    throw new Error("Nenhuma planilha encontrada no arquivo Excel.");
  }
  const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(firstSheet, { header: 1 });
  return cleanAndParseRows(rows);
}

function parseNumericValue(val) {
  if (val === null || val === undefined || val === "") return 0;
  if (typeof val === "number") return isNaN(val) ? 0 : val;
  const str = String(val).replace(/R\$\s?/g, "").replace(/\s/g, "").replace(/\./g, "").replace(",", ".");
  const num = parseFloat(str);
  return isNaN(num) ? 0 : num;
}
