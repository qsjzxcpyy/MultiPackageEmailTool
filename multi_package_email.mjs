import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileBlob, SpreadsheetFile, Workbook } from '@oai/artifact-tool';
import JSZip from 'jszip';
import { js2xml, xml2js } from 'xml-js';

export const SENDER_EMAIL_BY_SOURCE = Object.freeze({
  VYNELITO_US: '13288070760@163.com',
  ZEIINPA_US: '3777612514@qq.com',
  XOCN_US: '15889560452@163.com',
  THRYVIX_US_US: '17322503251@163.com',
});

const SHIPMENT_HEADERS = {
  order: 'Shipment ID',
  carrier: ['Carrier', 'Carrier Name'],
  tracking: 'Tracking Number',
  seller: 'Seller',
  shipFrom: 'Ship From',
};

export const OUTPUT_HEADERS = ['订单号', '来源', '物流类型', '物流单号', '邮件内容'];

const TEMPLATE_FILENAME = 'Drop Shipping Order List20260825003315.xlsx';
const FINAL_TEMPLATE_FILENAME = '发邮件8.17-1.xlsx';

export const ALLOWED_SOURCES = Object.freeze([
  'THRYVIX_US_US',
  'XOCN_US',
  'VYNELITO_US',
  'ZEIINPA_US',
]);
const ALLOWED_SOURCE_SET = new Set(ALLOWED_SOURCES);

const ERP_HEADERS = {
  order: 'refrence_no',
  email: 'consignee_email',
};

function text(value) {
  return String(value ?? '').trim();
}

function canonicalCarrier(value) {
  const carrier = text(value).toLowerCase();
  if (carrier === 'fedex') return 'Fedex';
  if (carrier === 'ups') return 'UPS';
  return text(value);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function splitTrackingNumbers(value) {
  return text(value)
    .split(/\r?\n/)
    .map((tracking) => tracking.trim())
    .filter(Boolean);
}

export function filterAllowedSourceRows(rows) {
  return rows.filter((row) => ALLOWED_SOURCE_SET.has(text(row.shipFrom)));
}

export function aggregateMultiPackageOrders(rows) {
  const grouped = new Map();

  for (const row of rows) {
    const order = text(row.order);
    if (!order) continue;

    if (!grouped.has(order)) {
      grouped.set(order, {
        carriers: [],
        sellers: [],
        shipFroms: [],
        trackingNumbers: [],
        trackingGroups: [],
        issues: [],
      });
    }
    const group = grouped.get(order);
    const carrier = canonicalCarrier(row.carrier);
    if (carrier && !group.carriers.includes(carrier)) group.carriers.push(carrier);
    const seller = text(row.seller);
    if (seller && !group.sellers.includes(seller)) group.sellers.push(seller);
    const shipFrom = text(row.shipFrom);
    if (shipFrom && !group.shipFroms.includes(shipFrom)) group.shipFroms.push(shipFrom);
    const trackingNumbers = splitTrackingNumbers(row.tracking);
    if (!trackingNumbers.length) {
      if (!group.issues.includes('MISSING_TRACKING_NUMBER')) {
        group.issues.push('MISSING_TRACKING_NUMBER');
      }
      continue;
    }
    let trackingGroup = group.trackingGroups.find((item) => item.carrier === carrier);
    if (!trackingGroup) {
      trackingGroup = { carrier, trackingNumbers: [] };
      group.trackingGroups.push(trackingGroup);
    }
    for (const tracking of trackingNumbers) {
      if (!group.trackingNumbers.includes(tracking)) group.trackingNumbers.push(tracking);
      if (!trackingGroup.trackingNumbers.includes(tracking)) {
        trackingGroup.trackingNumbers.push(tracking);
      }
    }
  }

  return [...grouped.entries()]
    .map(([order, group]) => {
    const result = {
      order,
      carrier: group.carriers.join(' / '),
      trackingNumbers: group.trackingNumbers,
      trackingGroups: group.trackingGroups.map((trackingGroup) => ({
        carrier: trackingGroup.carrier,
        trackingNumbers: [...trackingGroup.trackingNumbers],
      })),
      issues: [...group.issues],
      };
      if (group.sellers.length) result.seller = group.sellers.join(' / ');
      if (group.shipFroms.length) result.shipFrom = group.shipFroms.join(' / ');
      return result;
    })
    .filter((order) => order.trackingNumbers.length >= 2);
}

export function buildEmailBody({ order, carrier, trackingNumbers, trackingGroups }) {
  const groups = Array.isArray(trackingGroups) && trackingGroups.length
    ? trackingGroups
    : [{ carrier, trackingNumbers }];
  const normalizedGroups = groups.map((group) => ({
    carrier: canonicalCarrier(group.carrier),
    trackingNumbers: Array.isArray(group.trackingNumbers)
      ? group.trackingNumbers.map((tracking) => text(tracking)).filter(Boolean)
      : [],
  }));
  const totalTrackingNumbers = normalizedGroups.reduce(
    (total, group) => total + group.trackingNumbers.length,
    0,
  );
  if (!order || normalizedGroups.some((group) => !['Fedex', 'UPS'].includes(group.carrier))) {
    throw new Error(`Unsupported carrier for order ${order}: ${carrier}`);
  }
  if (totalTrackingNumbers < 2) {
    throw new Error(`Order ${order} does not have at least two tracking numbers`);
  }

  const lines = [`Hi! Your order  ${order} will be delivered in multiple different packages.`];
  for (const group of normalizedGroups) {
    lines.push(`${group.carrier} tracking numbers are:`, ...group.trackingNumbers);
  }
  lines.push(
    'Please wait for all the packages to arrive (may arrive separately)',
    'Warmest Regards',
    'Quentin',
  );
  return lines.join('\n');
}

export function buildEmailBodyForPreview(order) {
  try {
    return buildEmailBody(order);
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'the carrier or tracking data is invalid';
    return `Manual review required: ${reason}`;
  }
}

function canBuildEmailBody(order) {
  try {
    buildEmailBody(order);
    return true;
  } catch {
    return false;
  }
}

export function buildErpOrderList(orders) {
  return unique(orders.map((order) => text(order.order)))
    .map((order) => ({ 订单号: order }));
}

export function matchOrdersToEmails(orders, erpRows) {
  const emailByOrder = new Map();
  for (const row of erpRows) {
    const order = text(row.order);
    if (!order) continue;
    if (!emailByOrder.has(order)) emailByOrder.set(order, []);
    const email = text(row.email).toLowerCase();
    if (email && !emailByOrder.get(order).includes(email)) {
      emailByOrder.get(order).push(email);
    }
  }

  const sendable = [];
  const review = [];
  for (const order of orders) {
    const emails = emailByOrder.get(order.order) ?? [];
    const senderEmail = SENDER_EMAIL_BY_SOURCE[text(order.shipFrom)] ?? '';
    let reason = '';
    if (order.issues?.length) {
      reason = order.issues[0];
    } else if (!canBuildEmailBody(order)) {
      reason = 'CARRIER_CONFLICT_OR_UNSUPPORTED';
    } else if (!senderEmail) {
      reason = 'SOURCE_SENDER_NOT_CONFIGURED';
    } else if (emails.length === 0) {
      reason = emailByOrder.has(order.order) ? 'MISSING_EMAIL' : 'ORDER_NOT_FOUND_IN_ERP';
    } else if (emails.length > 1) {
      reason = 'MULTIPLE_EMAILS';
    }

    if (reason) {
      review.push({
        订单号: order.order,
        来源: text(order.shipFrom),
        承运商: order.carrier,
        物流号列表: order.trackingNumbers.join('\n'),
        原因: reason,
        ERP邮箱: emails.join('\n'),
      });
      continue;
    }

    sendable.push({
      收件邮箱: emails[0],
      邮件内容: buildEmailBody(order),
      发件邮箱: senderEmail,
      来源: text(order.shipFrom),
      订单号: order.order,
    });
  }

  return { sendable, review };
}

function columnNumberToName(number) {
  let name = '';
  let current = number;
  while (current > 0) {
    const remainder = (current - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    current = Math.floor((current - 1) / 26);
  }
  return name;
}

function requireHeaderIndexes(headers, required, fileLabel) {
  const indexes = {};
  for (const [key, header] of Object.entries(required)) {
    const candidates = Array.isArray(header) ? header : [header];
    const index = headers.findIndex((value) => candidates.includes(text(value)));
    if (index < 0) throw new Error(`${fileLabel} is missing required column: ${header}`);
    indexes[key] = index;
  }
  return indexes;
}

async function readSheetValues(filePath, sheetName) {
  const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(filePath));
  const worksheet = workbook.worksheets.getItemOrNullObject(sheetName);
  if (worksheet.isNullObject) throw new Error(`${filePath} is missing sheet: ${sheetName}`);
  return worksheet.getUsedRange().values;
}

async function readShipmentOrders(filePath) {
  const values = await readSheetValues(filePath, 'Shipment');
  const headers = values[0] ?? [];
  const indexes = requireHeaderIndexes(headers, SHIPMENT_HEADERS, filePath);
  const rows = values.slice(1).map((row) => ({
    order: row[indexes.order],
    carrier: row[indexes.carrier],
    tracking: row[indexes.tracking],
    seller: row[indexes.seller],
    shipFrom: row[indexes.shipFrom],
  }));
  return aggregateMultiPackageOrders(filterAllowedSourceRows(rows));
}

async function readErpRows(filePath) {
  const values = await readSheetValues(filePath, 'Export orders');
  const headers = values[0] ?? [];
  const indexes = requireHeaderIndexes(headers, ERP_HEADERS, filePath);
  return values.slice(1).map((row) => ({
    order: row[indexes.order],
    email: row[indexes.email],
  }));
}

function rowsToMatrix(headers, rows) {
  return [headers, ...rows.map((row) => headers.map((header) => row[header] ?? ''))];
}

export function buildCloudResultRows(orders) {
  const reference = orders.map((order) => [
    order.order,
    order.shipFrom ?? '',
    order.carrier,
    order.trackingNumbers.join('\n'),
    buildEmailBodyForPreview(order),
  ]);
  const emailTemplates = orders.map((order) => ({
    order: order.order,
    carrier: order.carrier,
    source: order.shipFrom ?? '',
    trackingNumbers: order.trackingNumbers,
    emailBody: buildEmailBodyForPreview(order),
  }));
  return { reference, emailTemplates };
}

async function writeWorkbook(filePath, sheets) {
  const workbook = Workbook.create();
  for (const sheet of sheets) {
    const worksheet = workbook.worksheets.add(sheet.name);
    const rowCount = Math.max(sheet.matrix.length, 1);
    const columnCount = Math.max(sheet.matrix[0]?.length ?? 1, 1);
    const range = worksheet.getRange(
      `A1:${columnNumberToName(columnCount)}${rowCount}`,
    );
    range.values = sheet.matrix;
    range.format.font.name = sheet.fontName ?? 'Arial';
    range.format.font.size = sheet.fontSize ?? 10;
    range.format.wrapText = true;
    worksheet.getRange(`A1:${columnNumberToName(columnCount)}1`).format.font.bold = true;
    if (sheet.headerRowHeight) worksheet.getRange('A1').format.rowHeight = sheet.headerRowHeight;
    if (sheet.columnWidths) {
      for (let index = 0; index < sheet.columnWidths.length; index += 1) {
        const column = columnNumberToName(index + 1);
        worksheet.getRange(`${column}1:${column}${rowCount}`).format.columnWidth = sheet.columnWidths[index];
      }
    }
    worksheet.tables.add(range.address, true);
    if (!sheet.columnWidths) range.format.autofitColumns();
  }
  const blob = await SpreadsheetFile.exportXlsx(workbook);
  await fs.writeFile(filePath, blob.data);
}

async function writeCloudResultWorkbook(filePath, orders, templatePath) {
  const result = buildCloudResultRows(orders);
  const workbookBuffer = await fs.readFile(templatePath);
  const zip = await JSZip.loadAsync(workbookBuffer);
  const worksheetPath = await findWorksheetPath(zip, 'Shipment');
  const worksheetFile = zip.file(worksheetPath);
  if (!worksheetFile) throw new Error(`${templatePath} is missing worksheet XML for Shipment.`);

  const worksheetXml = await worksheetFile.async('string');
  const worksheetDocument = xml2js(worksheetXml, { compact: false, nativeType: false });
  rewriteShipmentWorksheet(worksheetDocument, [OUTPUT_HEADERS, ...result.reference]);
  zip.file(worksheetPath, js2xml(worksheetDocument, { compact: false, spaces: 0 }));
  await fs.writeFile(filePath, await zip.generateAsync({ type: 'nodebuffer' }));
}

function clearCellContent(cell, reference) {
  cell.attributes = { ...(cell.attributes ?? {}), r: reference };
  delete cell.attributes.t;
  cell.elements = [];
}

function rewriteFinalEmailWorksheet(document, sendableRows) {
  const worksheet = document.elements[0];
  const sheetData = childElement(worksheet, 'sheetData');
  if (!sheetData) throw new Error('The final email template is missing sheet data.');

  const existingRows = new Map(
    (sheetData.elements ?? [])
      .filter((element) => element.type === 'element' && element.name === 'row')
      .map((row) => [Number(row.attributes?.r), row]),
  );
  const dataRows = [...existingRows.entries()]
    .filter(([rowNumber, row]) => rowNumber >= 2 && [1, 2, 3].some((columnNumber) => (
      (row.elements ?? []).some((cell) => (
        cell.type === 'element'
        && cell.name === 'c'
        && columnNumberFromReference(cell.attributes?.r) === columnNumber
      ))
    )))
    .map(([rowNumber]) => rowNumber);
  if (!dataRows.length) {
    throw new Error('The final email template is missing data rows.');
  }

  const firstDataRow = existingRows.get(dataRows[0]);
  const templateCells = new Map(
    (firstDataRow?.elements ?? [])
      .filter((element) => element.type === 'element' && element.name === 'c')
      .map((cell) => [columnNumberFromReference(cell.attributes?.r), cell]),
  );
  const lastTemplateRow = existingRows.get(dataRows.at(-1));
  for (let index = dataRows.length; index < sendableRows.length; index += 1) {
    const rowNumber = dataRows.at(-1) + 1;
    const row = cloneXmlNode(lastTemplateRow);
    row.attributes = { ...(row.attributes ?? {}), r: String(rowNumber) };
    existingRows.set(rowNumber, row);
    sheetData.elements.push(row);
    dataRows.push(rowNumber);
  }

  for (const [index, rowNumber] of dataRows.entries()) {
    const row = existingRows.get(rowNumber);
    const existingCells = new Map(
      (row.elements ?? [])
        .filter((element) => element.type === 'element' && element.name === 'c')
        .map((cell) => [columnNumberFromReference(cell.attributes?.r), cell]),
    );
    const output = sendableRows[index];
    const values = output
      ? [output.收件邮箱, output.邮件内容, output.发件邮箱]
      : ['', '', ''];
    for (let columnIndex = 0; columnIndex < 3; columnIndex += 1) {
      const columnNumber = columnIndex + 1;
      const cell = existingCells.get(columnNumber)
        ?? (output ? cloneXmlNode(templateCells.get(columnNumber)) : null);
      if (!cell) continue;
      const reference = `${columnNumberToName(columnNumber)}${rowNumber}`;
      if (values[columnIndex]) setInlineString(cell, reference, values[columnIndex]);
      else clearCellContent(cell, reference);
      existingCells.set(columnNumber, cell);
    }
    if (output) {
      row.attributes = { ...(row.attributes ?? {}), spans: '1:3' };
    }
    row.elements = [...existingCells.values()].sort((left, right) => (
      columnNumberFromReference(left.attributes?.r) - columnNumberFromReference(right.attributes?.r)
    ));
  }

  const dimension = childElement(worksheet, 'dimension');
  if (dimension) {
    const dimensionRef = String(dimension.attributes?.ref ?? 'A1:C1');
    const endColumn = dimensionRef.match(/:([A-Z]+)\d+$/)?.[1] ?? 'C';
    const dimensionEndRow = Number(dimensionRef.match(/\d+$/)?.[0] ?? 1);
    const endRow = Math.max(dimensionEndRow, dataRows.at(-1));
    dimension.attributes = { ...(dimension.attributes ?? {}), ref: `A1:${endColumn}${endRow}` };
  }
}

async function writeFinalTemplateWorkbook(filePath, sendableRows, templatePath) {
  const workbookBuffer = await fs.readFile(templatePath);
  const zip = await JSZip.loadAsync(workbookBuffer);
  const worksheetPath = await findWorksheetPath(zip, 'Sheet1');
  const worksheetFile = zip.file(worksheetPath);
  if (!worksheetFile) throw new Error(`${templatePath} is missing worksheet XML for Sheet1.`);

  const worksheetXml = await worksheetFile.async('string');
  const worksheetDocument = xml2js(worksheetXml, { compact: false, nativeType: false });
  rewriteFinalEmailWorksheet(worksheetDocument, sendableRows);
  zip.file(worksheetPath, js2xml(worksheetDocument, { compact: false, spaces: 0 }));
  await fs.writeFile(filePath, await zip.generateAsync({ type: 'nodebuffer' }));
}

function childElement(element, name) {
  return (element.elements ?? []).find((child) => child.type === 'element' && child.name === name);
}

function findWorksheetPath(zip, sheetName) {
  const workbookXml = zip.file('xl/workbook.xml');
  const relationshipsXml = zip.file('xl/_rels/workbook.xml.rels');
  if (!workbookXml || !relationshipsXml) throw new Error('The workbook is missing its sheet relationships.');

  return Promise.all([workbookXml.async('string'), relationshipsXml.async('string')]).then(([workbookText, relationshipsText]) => {
    const workbookRoot = xml2js(workbookText, { compact: false, nativeType: false }).elements[0];
    const relationshipsRoot = xml2js(relationshipsText, { compact: false, nativeType: false }).elements[0];
    const sheets = childElement(workbookRoot, 'sheets');
    const sheet = sheets?.elements?.find((element) => element.attributes?.name === sheetName);
    const relationshipId = sheet?.attributes?.['r:id'];
    const relationship = relationshipsRoot.elements?.find((element) => element.attributes?.Id === relationshipId);
    if (!relationship?.attributes?.Target) throw new Error(`The workbook is missing sheet: ${sheetName}`);
    return path.posix.normalize(path.posix.join('xl', relationship.attributes.Target));
  });
}

function cloneXmlNode(node) {
  return structuredClone(node);
}

function columnNumberFromReference(reference) {
  const letters = String(reference).match(/^[A-Z]+/)?.[0] ?? '';
  return [...letters].reduce((number, letter) => number * 26 + letter.charCodeAt(0) - 64, 0);
}

function setInlineString(cell, reference, value) {
  cell.attributes = { ...(cell.attributes ?? {}), r: reference, t: 'inlineStr' };
  cell.elements = [{
    type: 'element',
    name: 'is',
    elements: [{
      type: 'element',
      name: 't',
      attributes: { 'xml:space': 'preserve' },
      elements: [{ type: 'text', text: String(value ?? '') }],
    }],
  }];
}

function rewriteShipmentWorksheet(document, matrix) {
  const worksheet = document.elements[0];
  const sheetData = childElement(worksheet, 'sheetData');
  if (!sheetData) throw new Error('The Shipment worksheet is missing sheet data.');

  const existingRows = new Map(
    (sheetData.elements ?? [])
      .filter((element) => element.type === 'element' && element.name === 'row')
      .map((row) => [Number(row.attributes?.r), row]),
  );
  const templateRow = existingRows.get(2);
  if (!templateRow) throw new Error('The Shipment template is missing a data row.');

  const outputRows = matrix.map((values, rowIndex) => {
    const rowNumber = rowIndex + 1;
    const row = cloneXmlNode(existingRows.get(rowNumber) ?? templateRow);
    row.attributes = { ...(row.attributes ?? {}), r: String(rowNumber), spans: '1:5' };
    const existingCells = new Map(
      (row.elements ?? [])
        .filter((element) => element.type === 'element' && element.name === 'c')
        .map((cell) => [columnNumberFromReference(cell.attributes?.r), cell]),
    );
    const templateCells = new Map(
      (templateRow.elements ?? [])
        .filter((element) => element.type === 'element' && element.name === 'c')
        .map((cell) => [columnNumberFromReference(cell.attributes?.r), cell]),
    );
    const cells = values.map((value, columnIndex) => {
      const columnNumber = columnIndex + 1;
      const cell = existingCells.get(columnNumber)
        ?? cloneXmlNode(templateCells.get(columnNumber) ?? { type: 'element', name: 'c', attributes: {} });
      setInlineString(cell, `${columnNumberToName(columnNumber)}${rowNumber}`, value);
      return cell;
    });
    row.elements = cells;
    return row;
  });
  sheetData.elements = outputRows;

  const dimension = childElement(worksheet, 'dimension');
  if (dimension) dimension.attributes = { ...(dimension.attributes ?? {}), ref: `A1:E${matrix.length}` };

  const cols = childElement(worksheet, 'cols');
  if (cols) {
    cols.elements = (cols.elements ?? [])
      .filter((column) => column.type === 'element' && Number(column.attributes?.min) <= 5)
      .map((column) => ({
        ...column,
        attributes: {
          ...column.attributes,
          max: String(Math.min(Number(column.attributes?.max ?? column.attributes?.min), 5)),
        },
      }));
  }

  const mergeCells = worksheet.elements?.findIndex(
    (element) => element.type === 'element' && element.name === 'mergeCells',
  );
  if (mergeCells >= 0) worksheet.elements.splice(mergeCells, 1);
}

function parseArgs(argv) {
  const args = { source: 'Drop Shipping Order List20260825203710.xlsx', erp: '', outDir: '.', template: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--source') args.source = argv[++index];
    else if (arg === '--erp') args.erp = argv[++index];
    else if (arg === '--out-dir') args.outDir = argv[++index];
    else if (arg === '--template') args.template = argv[++index];
    else if (arg === '--final-template') args.finalTemplate = argv[++index];
    else if (arg === '--help') args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function pendingRows(orders) {
  return orders.map((order) => ({
    订单号: order.order,
    承运商: order.carrier,
    包裹数: order.trackingNumbers.length,
    物流号列表: order.trackingNumbers.join('\n'),
    邮件内容: buildEmailBodyForPreview(order),
  }));
}

export async function run(options = {}) {
  const sourcePath = path.resolve(options.source ?? 'Drop Shipping Order List20260825203710.xlsx');
  const outDir = path.resolve(options.outDir ?? '.');
  await fs.mkdir(outDir, { recursive: true });
  const orders = await readShipmentOrders(sourcePath);
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const templateCandidates = [
    options.template ? path.resolve(options.template) : '',
    path.join(moduleDir, TEMPLATE_FILENAME),
    path.join(moduleDir, '8月25多包裹', TEMPLATE_FILENAME),
    sourcePath,
  ].filter(Boolean);
  let templatePath = sourcePath;
  for (const candidate of templateCandidates) {
    try {
      await fs.access(candidate);
      templatePath = candidate;
      break;
    } catch {
      // Try the next portable or source-local template.
    }
  }

  const pendingPath = path.join(outDir, '多包裹订单待下载清单.xlsx');
  const erpOrderListPath = path.join(outDir, 'ERP下载订单号.xlsx');
  await writeWorkbook(pendingPath, [{
    name: '待下载订单',
    matrix: rowsToMatrix(['订单号', '承运商', '包裹数', '物流号列表', '邮件内容'], pendingRows(orders)),
  }]);
  await writeCloudResultWorkbook(erpOrderListPath, orders, templatePath);

  const result = { orders, pendingPath, erpOrderListPath, sendable: [], review: [] };
  const erpSources = Array.isArray(options.erp) ? options.erp : (options.erp ? [options.erp] : []);
  if (erpSources.length) {
    const erpRows = [];
    for (const erpSource of erpSources) {
      erpRows.push(...await readErpRows(path.resolve(erpSource)));
    }
    const matched = matchOrdersToEmails(orders, erpRows);
    result.sendable = matched.sendable;
    result.review = matched.review;

    const finalPath = path.join(outDir, '发邮件最终数据_多包裹.xlsx');
    const reviewPath = path.join(outDir, '多包裹订单人工复核.xlsx');
    const finalTemplateCandidates = [
      options.finalTemplate ? path.resolve(options.finalTemplate) : '',
      path.join(moduleDir, FINAL_TEMPLATE_FILENAME),
    ].filter(Boolean);
    let finalTemplatePath = '';
    for (const candidate of finalTemplateCandidates) {
      try {
        await fs.access(candidate);
        finalTemplatePath = candidate;
        break;
      } catch {
        // Try the next portable final email template.
      }
    }
    if (!finalTemplatePath) {
      throw new Error(`Missing final email template: ${FINAL_TEMPLATE_FILENAME}`);
    }
    await writeFinalTemplateWorkbook(finalPath, matched.sendable, finalTemplatePath);
    await writeWorkbook(reviewPath, [{
      name: '人工复核',
      matrix: rowsToMatrix(['订单号', '承运商', '物流号列表', '原因', 'ERP邮箱'], matched.review),
    }]);
    result.finalPath = finalPath;
    result.reviewPath = reviewPath;
  }
  return result;
}

if (path.resolve(process.argv[1] ?? '') === path.resolve(fileURLToPath(import.meta.url))) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('用法: node multi_package_email.mjs [--source 云仓文件.xlsx] [--template 格式模板.xlsx] [--erp ERP文件.xlsx] [--out-dir 输出目录]');
    process.exit(0);
  }
  const result = await run(args);
  console.log(JSON.stringify({
    multiPackageOrders: result.orders.length,
    twoPackageOrders: result.orders.filter((order) => order.trackingNumbers.length === 2).length,
    threePackageOrders: result.orders.filter((order) => order.trackingNumbers.length === 3).length,
    sendableRows: result.sendable.length,
    reviewRows: result.review.length,
    pendingPath: result.pendingPath,
    erpOrderListPath: result.erpOrderListPath,
    finalPath: result.finalPath ?? null,
    reviewPath: result.reviewPath ?? null,
  }, null, 2));
}
