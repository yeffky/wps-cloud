import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream, readFileSync } from 'node:fs';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
loadDotEnv(path.join(projectRoot, '.env'));

const host = process.env.WPS_CLOUD_HOST || '127.0.0.1';
const port = Number(process.env.WPS_CLOUD_PORT || 8787);
const dataDir = path.resolve(projectRoot, process.env.WPS_CLOUD_DATA_DIR || './data');
const blobsDir = path.join(dataDir, 'blobs');
const metadataPath = path.join(dataDir, 'index.json');
const apiToken = process.env.WPS_CLOUD_TOKEN || '';
const signingKey = process.env.WPS_CLOUD_SIGNING_KEY || '';
const maxUploadBytes = Number(process.env.WPS_CLOUD_MAX_UPLOAD_BYTES || 209715200);
const locks = new Map();

if (!apiToken || !signingKey || apiToken.startsWith('replace-') || signingKey.startsWith('replace-')) {
  console.error('Set WPS_CLOUD_TOKEN and WPS_CLOUD_SIGNING_KEY in .env before starting.');
  process.exit(1);
}

await mkdir(blobsDir, { recursive: true });
if (!(await exists(metadataPath))) await writeJsonAtomic(metadataPath, { files: {}, bindings: {} });

const server = http.createServer(async (req, res) => {
  addCorsHeaders(res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }

  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/addin/')) {
      await serveAddin(url.pathname, res);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/health') {
      sendJson(res, 200, { ok: true, service: 'wps-personal-cloud' });
      return;
    }

    if (url.pathname.startsWith('/api/') && url.pathname !== '/api/upload' && url.pathname !== '/api/download') {
      requireBearer(req);
    }

    if (req.method === 'GET' && url.pathname === '/api/files') {
      const { files } = await readMetadata();
      const parentId = url.searchParams.get('parentId') || 'root';
      const items = Object.values(files)
        .filter((item) => item.parentId === parentId && item.version > 0)
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
      sendJson(res, 200, { items });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/sync-ticket') {
      const body = await readJson(req, 64 * 1024);
      const name = safeDisplayName(body.name);
      const pathHash = requireString(body.pathHash, 'pathHash', 128);
      const machineId = requireString(body.machineId, 'machineId', 80);
      const parentId = requireString(body.parentId || 'root', 'parentId', 128);
      const mappingKey = `${machineId}:${pathHash}`;
      const expectedVersion = body.expectedVersion === undefined ? 0 : Number(body.expectedVersion);
      if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw new HttpError(400, 'invalid_version', 'Invalid expectedVersion');
      const requestedFileId = typeof body.fileId === 'string' && body.fileId ? body.fileId : '';
      const result = await withLock('metadata', async () => {
        const metadata = await readMetadata();
        let fileId = metadata.bindings[mappingKey];
        if (!fileId) {
          fileId = requestedFileId || randomUUID();
          if (requestedFileId && !metadata.files[fileId]) {
            throw new HttpError(404, 'file_not_found', 'The linked cloud file no longer exists');
          }
          metadata.bindings[mappingKey] = fileId;
          if (!metadata.files[fileId]) {
            metadata.files[fileId] = {
              id: fileId,
              name,
              parentId,
              version: 0,
              size: 0,
              createdAt: new Date().toISOString(),
              modifiedAt: new Date().toISOString(),
              versions: [],
            };
          }
          await writeMetadata(metadata);
        }
        if (requestedFileId && requestedFileId !== fileId) {
          throw new HttpError(409, 'mapping_conflict', 'This local file is already linked to a different cloud file');
        }
        const file = metadata.files[fileId];
        if (expectedVersion !== file.version) {
          throw new HttpError(409, 'version_conflict', 'Cloud file changed since the last local sync', { latestVersion: file.version });
        }
        const ticket = signTicket({
          op: 'upload', fileId, mappingKey, name, parentId,
          expectedVersion: file.version, exp: Date.now() + 2 * 60 * 1000,
        });
        return { fileId, expectedVersion: file.version, uploadPath: `/api/upload?ticket=${encodeURIComponent(ticket)}` };
      });
      sendJson(res, 200, result);
      return;
    }

    const fileMatch = url.pathname.match(/^\/api\/files\/([a-f0-9-]+)$/i);
    if (req.method === 'GET' && fileMatch) {
      const metadata = await readMetadata();
      const file = metadata.files[fileMatch[1]];
      if (!file || file.version < 1) throw new HttpError(404, 'file_not_found', 'File not found');
      if (await ensureCurrentFileHash(file)) await writeMetadata(metadata);
      sendJson(res, 200, publicFile(file));
      return;
    }

    const downloadTicketMatch = url.pathname.match(/^\/api\/files\/([a-f0-9-]+)\/download-ticket$/i);
    if (req.method === 'GET' && downloadTicketMatch) {
      const metadata = await readMetadata();
      const file = metadata.files[downloadTicketMatch[1]];
      if (!file || file.version < 1) throw new HttpError(404, 'file_not_found', 'File not found');
      const ticket = signTicket({ op: 'download', fileId: file.id, version: file.version, exp: Date.now() + 2 * 60 * 1000 });
      sendJson(res, 200, {
        downloadPath: `/api/download?ticket=${encodeURIComponent(ticket)}`,
        fileId: file.id,
        name: file.name,
        version: file.version,
        size: file.size,
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/upload') {
      const ticket = verifyTicket(url.searchParams.get('ticket'), 'upload');
      const { buffer, filename } = await readMultipartFile(req, maxUploadBytes);
      if (filename && safeDisplayName(filename) !== ticket.name) {
        throw new HttpError(400, 'filename_mismatch', 'Uploaded filename does not match the signed ticket');
      }
      await withLock('metadata', async () => {
        const metadata = await readMetadata();
        const file = metadata.files[ticket.fileId];
        if (!file || file.version !== ticket.expectedVersion) {
          throw new HttpError(409, 'version_conflict', 'Cloud file changed since this upload began', { latestVersion: file?.version ?? null });
        }
        const version = file.version + 1;
        const blobName = `${ticket.fileId}.${version}.${randomUUID()}.blob`;
        const blobPath = path.join(blobsDir, blobName);
        await writeFile(blobPath, buffer, { flag: 'wx' });
        const now = new Date().toISOString();
        const contentHash = createHash('sha256').update(buffer).digest('hex');
        file.name = ticket.name;
        file.parentId = ticket.parentId;
        file.version = version;
        file.size = buffer.length;
        file.sha256 = contentHash;
        file.modifiedAt = now;
        file.versions.push({ version, blobName, size: buffer.length, sha256: contentHash, createdAt: now });
        metadata.bindings[ticket.mappingKey] = ticket.fileId;
        await writeMetadata(metadata);
      });
      res.writeHead(201, { 'Content-Type': 'text/plain; charset=utf-8' }).end('uploaded');
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/download') {
      const ticket = verifyTicket(url.searchParams.get('ticket'), 'download');
      const metadata = await readMetadata();
      const file = metadata.files[ticket.fileId];
      const version = file?.versions.find((item) => item.version === ticket.version);
      if (!file || !version) throw new HttpError(404, 'version_not_found', 'File version not found');
      const blobPath = path.join(blobsDir, version.blobName);
      const info = await stat(blobPath);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': info.size,
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
        'Cache-Control': 'private, no-store',
      });
      createReadStream(blobPath).pipe(res);
      return;
    }

    sendJson(res, 404, { error: 'not_found', message: 'Route not found' });
  } catch (error) {
    if (res.headersSent) {
      res.destroy(error);
      return;
    }
    const status = error instanceof HttpError ? error.status : 500;
    sendJson(res, status, {
      error: error.code || 'internal_error',
      message: status === 500 ? 'Internal server error' : error.message,
      ...(error.details ? { details: error.details } : {}),
    });
    if (status === 500) console.error(error);
  }
});

server.listen(port, host, () => {
  console.log(`WPS Personal Cloud listening at http://${host}:${port}`);
  console.log(`File data directory: ${dataDir}`);
});

function loadDotEnv(filePath) {
  try {
    const text = readFileSync(filePath, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!match || match[1] in process.env) continue;
      process.env[match[1]] = match[2].replace(/^(["'])(.*)\1$/, '$2');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function addCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Max-Age', '600');
}

function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
  res.end(body);
}

function requireBearer(req) {
  const header = req.headers.authorization || '';
  const candidate = header.startsWith('Bearer ') ? header.slice(7) : '';
  const left = Buffer.from(candidate);
  const right = Buffer.from(apiToken);
  if (left.length !== right.length || !timingSafeEqual(left, right)) throw new HttpError(401, 'unauthorized', 'Valid Bearer token required');
}

async function readJson(req, limit) {
  const body = await readRequestBody(req, limit);
  try { return JSON.parse(body.toString('utf8')); }
  catch { throw new HttpError(400, 'invalid_json', 'Request body must be JSON'); }
}

async function readRequestBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'too_large', 'Request body exceeds the configured limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

async function readMultipartFile(req, maxBytes) {
  const type = req.headers['content-type'] || '';
  const boundary = type.match(/boundary=(?:"([^"]+)"|([^;\s]+))/i)?.slice(1).find(Boolean);
  if (!type.toLowerCase().startsWith('multipart/form-data') || !boundary) {
    throw new HttpError(415, 'multipart_required', 'Expected multipart/form-data upload');
  }
  const body = await readRequestBody(req, maxBytes + 1024 * 1024);
  const separator = Buffer.from(`--${boundary}`);
  let cursor = body.indexOf(separator);
  while (cursor >= 0) {
    const headerStart = cursor + separator.length + 2;
    const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'), headerStart);
    if (headerEnd < 0) break;
    const headers = body.subarray(headerStart, headerEnd).toString('utf8');
    const contentStart = headerEnd + 4;
    const nextBoundary = body.indexOf(Buffer.from(`\r\n--${boundary}`), contentStart);
    if (nextBoundary < 0) break;
    const disposition = headers.match(/content-disposition:\s*form-data;([^\r\n]+)/i)?.[1] || '';
    const fieldName = disposition.match(/name="([^"]+)"/i)?.[1];
    const filename = disposition.match(/filename="([^"]*)"/i)?.[1] || '';
    if (fieldName === 'file') {
      const buffer = body.subarray(contentStart, nextBoundary);
      if (buffer.length > maxBytes) throw new HttpError(413, 'too_large', 'Uploaded file exceeds the configured limit');
      return { buffer, filename: filename ? decodeURIComponentSafe(filename) : '' };
    }
    cursor = body.indexOf(separator, nextBoundary + 2);
  }
  throw new HttpError(400, 'file_field_required', 'Multipart field "file" is required');
}

function signTicket(payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', signingKey).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

function verifyTicket(value, expectedOperation) {
  if (!value || value.length > 4096) throw new HttpError(401, 'invalid_ticket', 'Missing or invalid upload ticket');
  const [encoded, provided] = value.split('.');
  const expected = createHmac('sha256', signingKey).update(encoded || '').digest();
  let actual;
  try { actual = Buffer.from(provided || '', 'base64url'); } catch { actual = Buffer.alloc(0); }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new HttpError(401, 'invalid_ticket', 'Invalid upload ticket signature');
  let payload;
  try { payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); }
  catch { throw new HttpError(401, 'invalid_ticket', 'Invalid upload ticket payload'); }
  if (payload.op !== expectedOperation || !Number.isFinite(payload.exp) || payload.exp < Date.now()) {
    throw new HttpError(401, 'expired_ticket', 'Upload ticket has expired');
  }
  return payload;
}

function safeDisplayName(value) {
  const name = requireString(value, 'name', 255).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim();
  if (!name || name === '.' || name === '..') throw new HttpError(400, 'invalid_name', 'Invalid file name');
  return name;
}

function requireString(value, name, maxLength) {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new HttpError(400, 'invalid_field', `Invalid ${name}`);
  }
  return value.trim();
}

function publicFile(file) {
  return {
    id: file.id, name: file.name, parentId: file.parentId, version: file.version,
    size: file.size, sha256: file.sha256, createdAt: file.createdAt, modifiedAt: file.modifiedAt,
  };
}

async function ensureCurrentFileHash(file) {
  if (typeof file.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(file.sha256)) return false;
  const version = file.versions.find((item) => item.version === file.version);
  if (!version) throw new HttpError(500, 'version_metadata_missing', 'Current file version metadata is missing');
  const content = await readFile(path.join(blobsDir, version.blobName));
  const contentHash = createHash('sha256').update(content).digest('hex');
  version.sha256 = contentHash;
  file.sha256 = contentHash;
  return true;
}

async function readMetadata() {
  try { return JSON.parse(await readFile(metadataPath, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return { files: {}, bindings: {} };
    throw error;
  }
}

async function writeMetadata(metadata) {
  await writeJsonAtomic(metadataPath, metadata);
}

async function writeJsonAtomic(filePath, value) {
  const temp = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2), { flag: 'wx' });
  await rename(temp, filePath);
}

async function exists(filePath) {
  try { await stat(filePath); return true; } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function withLock(key, action) {
  const previous = locks.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  const queued = previous.then(() => current);
  locks.set(key, queued);
  await previous;
  try { return await action(); }
  finally {
    release();
    if (locks.get(key) === queued) locks.delete(key);
  }
}

async function serveAddin(pathname, res) {
  const relative = decodeURIComponent(pathname.slice('/addin/'.length) || 'index.html');
  const addinRoot = path.join(projectRoot, 'client', 'addin');
  const filePath = path.resolve(addinRoot, relative);
  if (!filePath.startsWith(`${addinRoot}${path.sep}`) && filePath !== path.join(addinRoot, 'index.html')) {
    throw new HttpError(403, 'forbidden', 'Invalid add-in asset path');
  }
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.xml': 'application/xml; charset=utf-8' };
  const content = await readFile(filePath);
  res.writeHead(200, { 'Content-Type': types[path.extname(filePath)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  res.end(content);
}

function decodeURIComponentSafe(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}

class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
