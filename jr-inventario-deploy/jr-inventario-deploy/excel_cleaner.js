const fs = require('fs');
const zlib = require('zlib');

/**
 * Minimal ZIP Unpacker using Node built-in zlib for reading .xlsx files
 */
function unzipXlsx(buffer) {
  const files = {};
  let offset = 0;

  while (offset < buffer.length - 4) {
    const sig = buffer.readUInt32LE(offset);
    if (sig !== 0x04034b50) break; // Local file header signature

    const flags = buffer.readUInt16LE(offset + 6);
    const compression = buffer.readUInt16LE(offset + 8);
    const compSize = buffer.readUInt32LE(offset + 18);
    const uncompSize = buffer.readUInt32LE(offset + 22);
    const nameLen = buffer.readUInt16LE(offset + 26);
    const extraLen = buffer.readUInt16LE(offset + 28);

    const fileName = buffer.toString('utf8', offset + 30, offset + 30 + nameLen);
    const dataStart = offset + 30 + nameLen + extraLen;
    const fileData = buffer.slice(dataStart, dataStart + compSize);

    if (compression === 0) {
      files[fileName] = fileData;
    } else if (compression === 8) {
      try {
        files[fileName] = zlib.inflateRawSync(fileData);
      } catch (err) {
        // Fallback for compressed chunk
        files[fileName] = fileData;
      }
    }

    offset = dataStart + compSize;
    // Account for data descriptor if present (flag bit 3)
    if (flags & 0x08) {
      const nextSigIdx = buffer.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]), offset);
      if (nextSigIdx !== -1) {
        offset = nextSigIdx;
      } else {
        break;
      }
    }
  }

  return files;
}

/**
 * Parses XML string into simple cell structure
 */
function parseSheetXml(xmlStr, sharedStrings) {
  const rows = [];
  const rowMatches = xmlStr.match(/<row\s+[^>]*>([\s\S]*?)<\/row>/g) || [];

  for (const rowXml of rowMatches) {
    const rMatch = rowXml.match(/r="(\d+)"/);
    const rowNum = rMatch ? parseInt(rMatch[1], 10) : rows.length + 1;
    const cells = {};

    const cellMatches = rowXml.match(/<c\s+[^>]*>([\s\S]*?)<\/c>/g) || [];
    for (const cellXml of cellMatches) {
      const refMatch = cellXml.match(/r="([A-Z]+)\d+"/);
      if (!refMatch) continue;
      const col = refMatch[1];
      const tMatch = cellXml.match(/t="([^"]+)"/);
      const isShared = tMatch && tMatch[1] === 's';
      const isInline = tMatch && tMatch[1] === 'inlineStr';

      let val = '';
      if (isInline) {
        const tVal = cellXml.match(/<t[^>]*>([\s\S]*?)<\/t>/);
        val = tVal ? tVal[1] : '';
      } else {
        const vMatch = cellXml.match(/<v>([\s\S]*?)<\/v>/);
        if (vMatch) {
          val = vMatch[1];
          if (isShared) {
            const idx = parseInt(val, 10);
            val = sharedStrings[idx] !== undefined ? sharedStrings[idx] : val;
          }
        }
      }

      // Clean XML entities
      val = val.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
      cells[col] = val.trim();
    }
    rows.push({ rowNum, cells });
  }

  return rows;
}

function parseSharedStrings(xmlStr) {
  const strings = [];
  if (!xmlStr) return strings;

  const siMatches = xmlStr.match(/<si>([\s\S]*?)<\/si>/g) || [];
  for (const si of siMatches) {
    const tMatches = si.match(/<t[^>]*>([\s\S]*?)<\/t>/g) || [];
    let text = '';
    for (const t of tMatches) {
      const clean = t.replace(/<[^>]+>/g, '');
      text += clean;
    }
    strings.push(
      text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    );
  }
  return strings;
}

/**
 * Main Data Cleaning Function
 * - Enforces Forward Fill (ffill) on Depósito (Col A)
 * - Splits Item into Código and Descrição (Col B)
 * - Parses Saldo, Custo Médio, Valor Total
 */
function cleanAndParseExcel(fileBuffer) {
  const unzipped = unzipXlsx(fileBuffer);

  const sharedXmlKey = Object.keys(unzipped).find(k => k.endsWith('sharedStrings.xml'));
  const sheetXmlKey = Object.keys(unzipped).find(k => k.endsWith('sheet1.xml') || k.includes('sheet'));

  if (!sheetXmlKey) {
    throw new Error('Planilha não encontrada no arquivo Excel.');
  }

  const sharedStrings = sharedXmlKey ? parseSharedStrings(unzipped[sharedXmlKey].toString('utf8')) : [];
  const rows = parseSheetXml(unzipped[sheetXmlKey].toString('utf8'), sharedStrings);

  if (rows.length === 0) {
    throw new Error('A planilha está vazia.');
  }

  const processedItems = [];
  let currentDeposito = '';
  let skippedHeader = false;

  for (const row of rows) {
    const cells = row.cells;
    const colA = cells['A'] || '';
    const colB = cells['B'] || '';
    const colC = cells['C'] || '0';
    const colD = cells['D'] || '0';
    const colE = cells['E'] || '0';
    const colF = cells['F'] || '0';

    // Header detection
    if (!skippedHeader) {
      if (colA.toLowerCase().includes('depósito') || colB.toLowerCase().includes('item') || colB.toLowerCase().includes('código')) {
        skippedHeader = true;
        continue;
      }
    }

    if (!colB && !colA) continue; // Empty row

    // Forward fill logic for Depósito
    if (colA && colA.trim() !== '' && colA.toLowerCase() !== 'total') {
      currentDeposito = colA.trim();
    }

    // Skip total rows
    if (colA.toLowerCase() === 'total' || colB.toLowerCase().startsWith('total')) {
      continue;
    }

    const depósito = currentDeposito || 'Almoxarifado Principal';

    // Extract Código and Nome do Produto from Col B
    let codigo = colB;
    let descricao = colB;

    if (colB.includes(' - ')) {
      const parts = colB.split(' - ');
      codigo = parts[0].trim();
      descricao = parts.slice(1).join(' - ').trim();
    } else if (colB.includes(' ')) {
      const spaceIdx = colB.indexOf(' ');
      codigo = colB.substring(0, spaceIdx).trim();
      descricao = colB.substring(spaceIdx + 1).trim();
    }

    const qtdTeorica = parseFloat(colC.replace(',', '.')) || 0;
    const precoUltimaEntrada = parseFloat(colD.replace(',', '.')) || 0;
    const custoMedio = parseFloat(colE.replace(',', '.')) || 0;
    const valorTotal = parseFloat(colF.replace(',', '.')) || (qtdTeorica * custoMedio);

    processedItems.push({
      deposito: depósito,
      codigo: codigo,
      descricao: descricao,
      quantidadeTeorica: qtdTeorica,
      precoUltimaEntrada: precoUltimaEntrada,
      custoMedio: custoMedio,
      valorTotal: valorTotal
    });
  }

  return processedItems;
}

module.exports = { cleanAndParseExcel, unzipXlsx };
