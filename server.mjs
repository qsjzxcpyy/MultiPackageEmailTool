import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { buildEmailBodyForPreview, run } from './multi_package_email.mjs';

export const APP_VERSION = '20260923-collapse-order-lists';
export function resolvePort({ argv = [], envPort = process.env.PORT } = {}) {
  const portIndex = argv.indexOf('--port');
  const requestedValue = portIndex >= 0 ? argv[portIndex + 1] : (envPort ?? 8787);
  const port = Number(requestedValue);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : 8787;
}
const DEFAULT_MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const MAX_ERP_FILES = 2;
const MULTIPART_OVERHEAD_BYTES = 1024 * 1024;
const XLSX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const STATIC_FILES = new Map([
  ['/', { file: 'index.html', contentType: 'text/html; charset=utf-8' }],
  ['/app.js', { file: 'app.js', contentType: 'text/javascript; charset=utf-8' }],
  ['/styles.css', { file: 'styles.css', contentType: 'text/css; charset=utf-8' }],
]);

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function sendJson(response, status, body) {
  const data = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
  });
  response.end(data);
}

export function formatErrorMessage(error) {
  const message = error instanceof Error ? error.message.trim() : '';
  return message || 'The workbook could not be processed.';
}

function sendError(response, error) {
  const status = error instanceof HttpError ? error.status : 500;
  const code = error instanceof HttpError ? error.code : 'PROCESSING_FAILED';
  const message = error instanceof HttpError
    ? error.message
    : formatErrorMessage(error);
  sendJson(response, status, { error: { code, message } });
}

function uploadFilename(request) {
  const filename = String(request.headers['x-filename'] ?? '').trim();
  if (!filename || path.extname(filename).toLowerCase() !== '.xlsx') {
    throw new HttpError(415, 'UNSUPPORTED_FILE_TYPE', 'Only .xlsx files are supported.');
  }
  return filename;
}

async function readUpload(request, maxUploadBytes) {
  const contentLength = Number(request.headers['content-length']);
  if (Number.isFinite(contentLength) && contentLength > maxUploadBytes) {
    throw new HttpError(
      413,
      'UPLOAD_TOO_LARGE',
      `The uploaded file exceeds the ${maxUploadBytes} byte limit.`,
    );
  }

  let size = 0;
  let tooLarge = false;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxUploadBytes) {
      tooLarge = true;
    } else {
      chunks.push(chunk);
    }
  }
  if (tooLarge) {
    throw new HttpError(
      413,
      'UPLOAD_TOO_LARGE',
      `The uploaded file exceeds the ${maxUploadBytes} byte limit.`,
    );
  }
  return Buffer.concat(chunks);
}

function validateUploadFilename(filename) {
  const normalizedFilename = String(filename ?? '').trim();
  if (!normalizedFilename || path.extname(normalizedFilename).toLowerCase() !== '.xlsx') {
    throw new HttpError(415, 'UNSUPPORTED_FILE_TYPE', 'Only .xlsx files are supported.');
  }
  return normalizedFilename;
}

function multipartBoundary(contentType) {
  const match = String(contentType ?? '').match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  const boundary = (match?.[1] ?? match?.[2] ?? '').trim();
  if (!boundary) {
    throw new HttpError(400, 'INVALID_MULTIPART_UPLOAD', 'The ERP file upload is missing its multipart boundary.');
  }
  return boundary;
}

function parseMultipartFiles(body, boundary, maxFiles, maxFileBytes) {
  const boundaryMarker = Buffer.from(`--${boundary}`);
  const headerSeparator = Buffer.from('\r\n\r\n');
  const lineBreak = Buffer.from('\r\n');
  const files = [];
  let cursor = 0;

  while (cursor < body.length) {
    const boundaryStart = body.indexOf(boundaryMarker, cursor);
    if (boundaryStart < 0) break;
    const afterBoundary = boundaryStart + boundaryMarker.length;
    if (body.subarray(afterBoundary, afterBoundary + 2).toString() === '--') break;
    if (!body.subarray(afterBoundary, afterBoundary + 2).equals(lineBreak)) {
      throw new HttpError(400, 'INVALID_MULTIPART_UPLOAD', 'The ERP file upload has an invalid multipart part.');
    }

    const headerStart = afterBoundary + 2;
    const headerEnd = body.indexOf(headerSeparator, headerStart);
    if (headerEnd < 0) {
      throw new HttpError(400, 'INVALID_MULTIPART_UPLOAD', 'The ERP file upload has incomplete part headers.');
    }
    const headers = body.subarray(headerStart, headerEnd).toString('utf8').split('\r\n');
    const disposition = headers.find((header) => /^content-disposition:/i.test(header)) ?? '';
    const fieldName = disposition.match(/\bname="([^"]+)"/i)?.[1] ?? '';
    const filename = disposition.match(/\bfilename="([^"]*)"/i)?.[1]
      ?? disposition.match(/\bfilename=([^;\s]+)/i)?.[1]
      ?? '';
    const nextBoundary = body.indexOf(boundaryMarker, headerEnd + headerSeparator.length);
    if (nextBoundary < 0) {
      throw new HttpError(400, 'INVALID_MULTIPART_UPLOAD', 'The ERP file upload is missing its closing boundary.');
    }

    let fileEnd = nextBoundary;
    if (body.subarray(fileEnd - 2, fileEnd).equals(lineBreak)) fileEnd -= 2;
    if (fieldName === 'files' && filename) {
      if (files.length >= maxFiles) {
        throw new HttpError(400, 'TOO_MANY_ERP_FILES', `You can upload at most ${maxFiles} ERP files.`);
      }
      const safeFilename = validateUploadFilename(filename);
      const fileData = Buffer.from(body.subarray(headerEnd + headerSeparator.length, fileEnd));
      if (fileData.length > maxFileBytes) {
        throw new HttpError(
          413,
          'UPLOAD_TOO_LARGE',
          `The uploaded file exceeds the ${maxFileBytes} byte limit.`,
        );
      }
      files.push({ filename: safeFilename, data: fileData });
    }
    cursor = nextBoundary;
  }

  if (!files.length) {
    throw new HttpError(400, 'NO_ERP_FILES', 'Upload at least one ERP .xlsx file.');
  }
  return files;
}

async function readErpUploads(request, maxUploadBytes) {
  const contentType = String(request.headers['content-type'] ?? '');
  if (/^multipart\/form-data\b/i.test(contentType)) {
    const body = await readUpload(
      request,
      maxUploadBytes * MAX_ERP_FILES + MULTIPART_OVERHEAD_BYTES,
    );
    return parseMultipartFiles(body, multipartBoundary(contentType), MAX_ERP_FILES, maxUploadBytes);
  }
  return [{
    filename: validateUploadFilename(request.headers['x-filename']),
    data: await readUpload(request, maxUploadBytes),
  }];
}

function toCloudPreview(orders) {
  return orders.map((order) => ({
    order: order.order,
    carrier: order.carrier,
    source: order.shipFrom ?? '',
    packageCount: order.trackingNumbers.length,
    trackingNumbers: order.trackingNumbers,
    emailBody: buildEmailBodyForPreview(order),
  }));
}

function cloudStats(orders) {
  return {
    multiPackageOrders: orders.length,
    twoPackageOrders: orders.filter((order) => order.trackingNumbers.length === 2).length,
    threePackageOrders: orders.filter((order) => order.trackingNumbers.length === 3).length,
    totalTrackingNumbers: orders.reduce((total, order) => total + order.trackingNumbers.length, 0),
  };
}

function attachmentDisposition(filename) {
  const fallbackFilename = filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `attachment; filename="${fallbackFilename}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

async function sendStaticFile(response, rootDir, staticFile) {
  const filePath = path.join(rootDir, 'web', staticFile.file);
  try {
    const file = await fs.readFile(filePath);
    response.writeHead(200, {
      'Content-Type': staticFile.contentType,
      'Content-Length': file.length,
      'Cache-Control': 'no-store',
    });
    response.end(file);
  } catch (error) {
    if (error.code === 'ENOENT') {
      sendError(response, new HttpError(404, 'NOT_FOUND', 'The requested resource was not found.'));
      return;
    }
    throw error;
  }
}

export function createApp({ rootDir = '.', maxUploadBytes = DEFAULT_MAX_UPLOAD_BYTES, tempDir = os.tmpdir() } = {}) {
  const resolvedRootDir = path.resolve(rootDir);
  const resolvedTempDir = path.resolve(tempDir);
  const state = {
    stage: 'idle',
    runDir: null,
    cloudPath: null,
    downloads: new Map(),
  };

  async function clearRun() {
    const runDir = state.runDir;
    state.stage = 'idle';
    state.runDir = null;
    state.cloudPath = null;
    state.downloads.clear();
    if (runDir) await fs.rm(runDir, { recursive: true, force: true });
  }

  function registerDownloads(files) {
    state.downloads.clear();
    const downloads = {};
    for (const [name, filePath] of Object.entries(files)) {
      if (!filePath) continue;
      const id = randomUUID();
      state.downloads.set(id, { filePath, filename: path.basename(filePath) });
      downloads[name] = `/api/download/${id}`;
    }
    return downloads;
  }

  async function handleCloudUpload(request, response) {
    uploadFilename(request);
    const upload = await readUpload(request, maxUploadBytes);
    await clearRun();

    const runDir = await fs.mkdtemp(path.join(resolvedTempDir, 'multi-package-email-'));
    const cloudPath = path.join(runDir, 'cloud.xlsx');
    try {
      await fs.writeFile(cloudPath, upload);
      const result = await run({ source: cloudPath, outDir: runDir });
      state.stage = 'cloud';
      state.runDir = runDir;
      state.cloudPath = cloudPath;
      const downloads = registerDownloads({
        pending: result.pendingPath,
        erpOrderList: result.erpOrderListPath,
      });
      sendJson(response, 200, {
        stats: cloudStats(result.orders),
        preview: toCloudPreview(result.orders),
        downloads,
      });
    } catch (error) {
      await fs.rm(runDir, { recursive: true, force: true });
      throw error;
    }
  }

  async function handleErpUpload(request, response) {
    if (!state.cloudPath) {
      throw new HttpError(
        409,
        'CLOUD_UPLOAD_REQUIRED',
        'Upload a cloud warehouse file before uploading an ERP file.',
      );
    }
    const uploads = await readErpUploads(request, maxUploadBytes);
    const erpPaths = [];
    for (const [index, upload] of uploads.entries()) {
      const erpPath = path.join(state.runDir, `erp-${index + 1}.xlsx`);
      await fs.writeFile(erpPath, upload.data);
      erpPaths.push(erpPath);
    }
    const result = await run({ source: state.cloudPath, erp: erpPaths, outDir: state.runDir });
    state.stage = 'erp';
    const downloads = registerDownloads({
      pending: result.pendingPath,
      erpOrderList: result.erpOrderListPath,
      final: result.finalPath,
      review: result.reviewPath,
    });
    sendJson(response, 200, {
      stats: {
        ...cloudStats(result.orders),
        sendableRows: result.sendable.length,
        reviewRows: result.review.length,
      },
      sendable: result.sendable,
      review: result.review,
      downloads,
    });
  }

  async function handleDownload(response, id) {
    const download = state.downloads.get(id);
    if (!download) {
      throw new HttpError(404, 'DOWNLOAD_NOT_FOUND', 'The requested download was not found.');
    }
    try {
      const file = await fs.readFile(download.filePath);
      response.writeHead(200, {
        'Content-Type': XLSX_CONTENT_TYPE,
        'Content-Disposition': attachmentDisposition(download.filename),
        'Content-Length': file.length,
      });
      response.end(file);
    } catch (error) {
      if (error.code === 'ENOENT') {
        state.downloads.delete(id);
        throw new HttpError(404, 'DOWNLOAD_NOT_FOUND', 'The requested download was not found.');
      }
      throw error;
    }
  }

  let operationQueue = Promise.resolve();
  let cleanupPromise = Promise.resolve();
  function enqueue(operation) {
    const result = operationQueue.then(operation, operation);
    operationQueue = result.catch(() => {});
    return result;
  }

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (request.method === 'GET' && url.pathname === '/api/health') {
        sendJson(response, 200, { ok: true, stage: state.stage, version: APP_VERSION });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/cloud') {
        await enqueue(() => handleCloudUpload(request, response));
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/erp') {
        await enqueue(() => handleErpUpload(request, response));
        return;
      }
      if (request.method === 'GET' && url.pathname.startsWith('/api/download/')) {
        await handleDownload(response, url.pathname.slice('/api/download/'.length));
        return;
      }
      if (request.method === 'GET' && STATIC_FILES.has(url.pathname)) {
        await sendStaticFile(response, resolvedRootDir, STATIC_FILES.get(url.pathname));
        return;
      }
      throw new HttpError(404, 'NOT_FOUND', 'The requested resource was not found.');
    } catch (error) {
      if (!response.headersSent) sendError(response, error);
      else response.destroy();
    }
  });

  server.shutdown = async () => {
    if (server.listening) {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
    await operationQueue;
    await cleanupPromise;
    await clearRun();
  };

  server.on('close', () => {
    cleanupPromise = clearRun();
  });
  return server;
}

if (path.resolve(process.argv[1] ?? '') === path.resolve(fileURLToPath(import.meta.url))) {
  const port = resolvePort({ argv: process.argv.slice(2), envPort: process.env.PORT });
  const server = createApp({ rootDir: path.dirname(fileURLToPath(import.meta.url)) });
  server.listen(port, '127.0.0.1', () => {
    console.log(`Multi-package email app is running at http://127.0.0.1:${port}`);
  });
  const shutdown = async () => {
    try {
      await server.shutdown();
    } finally {
      process.exit(0);
    }
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
