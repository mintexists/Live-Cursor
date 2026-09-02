const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const Y = require('yjs');
const { setupWSConnection, docs: yWSdocs, getYDoc } = require('y-websocket/bin/utils');

const port = process.env.PORT || 4444;
const dbDir = process.env.DB_DIR || path.join(__dirname, 'data');
const AUTH_TOKEN = process.env.AUTH_TOKEN || 'default-pass';

// Create storage directories
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}
const roomsDir = path.join(dbDir, 'rooms');
if (!fs.existsSync(roomsDir)) {
  fs.mkdirSync(roomsDir, { recursive: true });
}
const configDir = path.join(dbDir, 'config');
if (!fs.existsSync(configDir)) {
  fs.mkdirSync(configDir, { recursive: true });
}

// Map of active documents
const docs = new Map();
const saveTimeouts = new Map();

// Room IDs have the form "<encoded workspace>/<encoded relative path>".
// The separator is a literal '/'; encodeURIComponent never emits '/', so the
// first segment is always the workspace. Room IDs are kept percent-encoded so
// WebSocket and HTTP paths reference the exact same room.
function roomWorkspace(roomId) {
  const first = String(roomId || '').split('/')[0];
  return decodeURIComponent(first || 'default');
}

// Persist rooms as "<sha1(workspace)>-<sha1(roomId)>.bin" so filenames are
// bounded, collision-free, and filterable by workspace.
function getRoomPath(roomId) {
  const ws = roomWorkspace(roomId);
  const name = `${crypto.createHash('sha1').update(ws).digest('hex')}-${crypto.createHash('sha1').update(String(roomId)).digest('hex')}`;
  return path.join(roomsDir, name + '.bin');
}

// Load document state from disk database
function loadDoc(roomId, doc) {
  const p = getRoomPath(roomId);
  if (fs.existsSync(p)) {
    try {
      const data = fs.readFileSync(p);
      Y.applyUpdate(doc, new Uint8Array(data));
      console.log(`[Database] Loaded persistent state for room: ${roomId}`);
    } catch (e) {
      console.error(`[Database] Failed to load room "${roomId}"`, e);
    }
  } else {
    console.log(`[Database] Room "${roomId}" not found in database. Initializing empty.`);
  }
}

// Save document state to disk database
function saveDoc(roomId, doc) {
  const p = getRoomPath(roomId);
  try {
    const state = Y.encodeStateAsUpdate(doc);
    fs.writeFileSync(p, Buffer.from(state.buffer, state.byteOffset, state.byteLength));
    console.log(`[Database] Saved state for room: ${roomId}`);
  } catch (e) {
    console.error(`[Database] Failed to save room "${roomId}"`, e);
  }
}

// Minimal common-prefix/common-suffix reconcile (mirrors the client's reconcile.ts).
// Preserves CRDT history instead of destroying it with delete-all.
function reconcileYText(ytext, newText) {
  const oldText = ytext.toString();
  if (oldText === newText) return;

  let start = 0;
  while (
    start < oldText.length &&
    start < newText.length &&
    oldText.charAt(start) === newText.charAt(start)
  ) {
    start++;
  }

  let oldEnd = oldText.length;
  let newEnd = newText.length;
  while (
    oldEnd > start &&
    newEnd > start &&
    oldText.charAt(oldEnd - 1) === newText.charAt(newEnd - 1)
  ) {
    oldEnd--;
    newEnd--;
  }

  ytext.doc.transact(() => {
    if (oldEnd > start) {
      ytext.delete(start, oldEnd - start);
    }
    if (newEnd > start) {
      ytext.insert(start, newText.substring(start, newEnd));
    }
  });
}

// Helper for parsing query params
function getQueryParams(reqUrl) {
  const urlObj = new URL(reqUrl, `http://localhost`);
  return Object.fromEntries(urlObj.searchParams.entries());
}

function isAuthorized(req, params) {
  const header = req.headers['authorization'] || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
  return (bearer.length > 0 && bearer === AUTH_TOKEN) ||
    (params.pass && params.pass === AUTH_TOKEN);
}

function sendUnauthorized(res) {
  console.warn('[HTTP] 401 Unauthorized request rejected');
  res.writeHead(401);
  res.end('Unauthorized');
}

function isValidRelPath(relPath) {
  return typeof relPath === 'string' &&
    relPath.length > 0 &&
    !relPath.includes('..') &&
    !relPath.startsWith('/') &&
    !relPath.startsWith('\\');
}

function getConfigWorkspacePath(workspace) {
  const safeWorkspace = encodeURIComponent(workspace || 'default').replace(/%20/g, '_');
  const wsDir = path.join(configDir, safeWorkspace);
  if (!fs.existsSync(wsDir)) {
    fs.mkdirSync(wsDir, { recursive: true });
  }
  return wsDir;
}

function roomNameFor(workspace, relPath) {
  return `${encodeURIComponent(workspace || 'default')}/${encodeURIComponent(relPath)}`;
}

// Load or create the shared doc for a room (reused by HTTP and WebSocket paths).
// Uses y-websocket's getYDoc so the WebSocket path and the HTTP API reference
// the exact same WSSharedDoc instance.
function getRoomDoc(roomName) {
  let doc = docs.get(roomName);
  if (!doc) {
    doc = getYDoc(roomName);
    loadDoc(roomName, doc);
    docs.set(roomName, doc);

    doc.on('update', () => {
      let timeout = saveTimeouts.get(roomName);
      if (timeout) clearTimeout(timeout);
      timeout = setTimeout(() => {
        saveDoc(roomName, doc);
        saveTimeouts.delete(roomName);
      }, 500); // Debounce saves by 500ms for near-instant propagation
      saveTimeouts.set(roomName, timeout);
    });
  }
  return doc;
}

// Create standard HTTP server
const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = urlObj.pathname;

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    return res.end();
  }

  const params = getQueryParams(req.url);
  console.log(`[HTTP] ${req.method} ${pathname}`);

  // --- GET /api/manifest ---
  if (pathname === '/api/manifest' && req.method === 'GET') {
    if (!isAuthorized(req, params)) return sendUnauthorized(res);
    const wsDir = getConfigWorkspacePath(params.workspace);
    const manifest = {};

    try {
      const scanDir = async (dir) => {
        const entries = await fsp.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            await scanDir(fullPath);
          } else {
            const stat = await fsp.stat(fullPath);
            const relPath = path.relative(wsDir, fullPath).replace(/\\/g, '/');
            manifest[relPath] = {
              size: stat.size,
              mtime: stat.mtimeMs,
              device: 'Server'
            };
          }
        }
      };

      await scanDir(wsDir);
      console.log(`[HTTP] 200 OK /api/manifest - Scanned ${Object.keys(manifest).length} files for workspace: ${params.workspace}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(manifest));
    } catch (e) {
      console.error(`[HTTP] 500 Error /api/manifest: ${e.message}`);
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // --- POST /api/upload ---
  if (pathname === '/api/upload' && req.method === 'POST') {
    if (!isAuthorized(req, params)) return sendUnauthorized(res);
    const wsDir = getConfigWorkspacePath(params.workspace);
    const relPath = params.path;

    if (!isValidRelPath(relPath)) {
      console.warn(`[HTTP] 400 Bad Request /api/upload - Invalid path: ${relPath}`);
      res.writeHead(400);
      return res.end('Invalid path');
    }

    const fullPath = path.join(wsDir, relPath);
    const targetDir = path.dirname(fullPath);

    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);

    try {
      if (!fs.existsSync(targetDir)) {
        await fsp.mkdir(targetDir, { recursive: true });
      }
      await fsp.writeFile(fullPath, buffer);

      // Set the file's mtime to what the client sent, if provided
      if (params.mtime) {
        const mtime = parseInt(params.mtime) / 1000;
        try {
          await fsp.utimes(fullPath, mtime, mtime);
        } catch (e) {}
      }

      // If it's a markdown file, reconcile the Yjs room state to match this new text
      if (relPath.endsWith('.md')) {
        const text = buffer.toString('utf-8');
        const roomName = roomNameFor(params.workspace, relPath);
        const doc = getRoomDoc(roomName);

        const ytext = doc.getText('content');
        if (ytext.toString() !== text) {
          reconcileYText(ytext, text);
          saveDoc(roomName, doc);
          console.log(`[Database] Updated Yjs state for ${roomName} from uploaded file`);
        }
      }

      console.log(`[HTTP] 200 OK /api/upload - Path: ${relPath} for workspace: ${params.workspace}`);
      res.writeHead(200);
      res.end('Uploaded');
    } catch (err) {
      console.error(`[HTTP] 500 Error /api/upload:`, err);
      res.writeHead(500);
      res.end(`Upload failed: ${err.message}`);
    }
    return;
  }

  // --- GET /api/download ---
  if (pathname === '/api/download' && req.method === 'GET') {
    if (!isAuthorized(req, params)) return sendUnauthorized(res);
    const wsDir = getConfigWorkspacePath(params.workspace);
    const relPath = params.path;

    if (!isValidRelPath(relPath)) {
      console.warn(`[HTTP] 400 Bad Request /api/download - Invalid path: ${relPath}`);
      res.writeHead(400);
      return res.end('Invalid path');
    }

    const fullPath = path.join(wsDir, relPath);
    if (!fs.existsSync(fullPath)) {
      console.warn(`[HTTP] 404 Not Found /api/download - Path: ${relPath}`);
      res.writeHead(404);
      return res.end('File not found');
    }

    console.log(`[HTTP] 200 OK /api/download - Path: ${relPath} for workspace: ${params.workspace}`);
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    fs.createReadStream(fullPath).pipe(res);
    return;
  }

  // --- DELETE /api/delete ---
  if (pathname === '/api/delete' && req.method === 'DELETE') {
    if (!isAuthorized(req, params)) return sendUnauthorized(res);
    const wsDir = getConfigWorkspacePath(params.workspace);
    const relPath = params.path;

    if (!isValidRelPath(relPath)) {
      console.warn(`[HTTP] 400 Bad Request /api/delete - Invalid path: ${relPath}`);
      res.writeHead(400);
      return res.end('Invalid path');
    }

    const fullPath = path.join(wsDir, relPath);
    console.log(`[HTTP] DELETE /api/delete - Path: ${relPath} for workspace: ${params.workspace}`);

    const roomName = roomNameFor(params.workspace, relPath);
    const roomPath = getRoomPath(roomName);

    if (fs.existsSync(roomPath)) {
      try {
        await fsp.unlink(roomPath);
        console.log(`[Database] Deleted room state for: ${roomName}`);
      } catch (e) {
        console.error(`[Database] Failed to delete room state:`, e);
      }
    }

    if (fs.existsSync(fullPath)) {
      try {
        await fsp.unlink(fullPath);
        console.log(`[HTTP] 200 OK /api/delete - Path: ${relPath} for workspace: ${params.workspace}`);
        res.writeHead(200);
        res.end('Deleted');
      } catch (e) {
        console.error(`[HTTP] 500 Error /api/delete: ${e.message}`);
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      }
    } else {
      console.log(`[HTTP] 200 OK /api/delete (Already missing) - Path: ${relPath}`);
      res.writeHead(200);
      res.end('Already deleted');
    }
    return;
  }

  // --- GET /api/room-state ---
  if (pathname === '/api/room-state' && req.method === 'GET') {
    if (!isAuthorized(req, params)) return sendUnauthorized(res);
    const relPath = params.path;
    if (!isValidRelPath(relPath)) {
      res.writeHead(400);
      return res.end('Missing or invalid path');
    }
    const roomName = roomNameFor(params.workspace, relPath);
    const p = getRoomPath(roomName);

    console.log(`[HTTP] GET /api/room-state - Path: ${relPath} for workspace: ${params.workspace}`);

    if (fs.existsSync(p)) {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      fs.createReadStream(p).pipe(res);
    } else {
      res.writeHead(404);
      res.end('No room state');
    }
    return;
  }

  // --- POST /api/room-state ---
  if (pathname === '/api/room-state' && req.method === 'POST') {
    if (!isAuthorized(req, params)) return sendUnauthorized(res);
    const wsDir = getConfigWorkspacePath(params.workspace);
    const relPath = params.path;

    if (!isValidRelPath(relPath)) {
      console.warn(`[HTTP] 400 Bad Request /api/room-state - Invalid path: ${relPath}`);
      res.writeHead(400);
      return res.end('Invalid path');
    }

    const roomName = roomNameFor(params.workspace, relPath);
    console.log(`[HTTP] POST /api/room-state - Path: ${relPath} for workspace: ${params.workspace}`);

    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const update = Buffer.concat(chunks);

    const doc = getRoomDoc(roomName);

    try {
      Y.applyUpdate(doc, new Uint8Array(update));
      saveDoc(roomName, doc);

      // Retrieve text
      const mergedText = doc.getText('content').toString();

      // Also write plain text file to configuration folder so they are synced side-by-side
      const fullPath = path.join(wsDir, relPath);
      const targetDir = path.dirname(fullPath);
      if (!fs.existsSync(targetDir)) {
        await fsp.mkdir(targetDir, { recursive: true });
      }
      await fsp.writeFile(fullPath, mergedText, 'utf-8');

      console.log(`[HTTP] 200 OK /api/room-state - Successfully merged CRDT for path: ${relPath}`);
      res.writeHead(200);
      res.end('Merged');
    } catch (err) {
      console.error(`[HTTP] 500 Error /api/room-state:`, err);
      res.writeHead(500);
      res.end(`Merge failed: ${err.message}`);
    }
    return;
  }

  // --- POST /api/reconstruct-db ---
  if (pathname === '/api/reconstruct-db' && req.method === 'POST') {
    if (!isAuthorized(req, params)) return sendUnauthorized(res);
    const workspace = params.workspace || 'default';
    const wsPrefix = `${encodeURIComponent(workspace)}/`;
    const filePrefix = `${crypto.createHash('sha1').update(workspace).digest('hex')}-`;
    console.log(`[HTTP] POST /api/reconstruct-db - Reconstructing database for workspace: ${workspace}`);

    try {
      // 1. Clear active docs for this workspace
      for (const [roomName, doc] of docs.entries()) {
        if (roomName.startsWith(wsPrefix)) {
          try {
            doc.destroy();
          } catch (e) {}
          docs.delete(roomName);
        }
      }

      // Clear pending save timeouts for this workspace
      for (const [roomName, timeout] of saveTimeouts.entries()) {
        if (roomName.startsWith(wsPrefix)) {
          try {
            clearTimeout(timeout);
          } catch (e) {}
          saveTimeouts.delete(roomName);
        }
      }

      // 2. Delete room binary files belonging to this workspace
      if (fs.existsSync(roomsDir)) {
        const files = await fsp.readdir(roomsDir);
        let removed = 0;
        for (const file of files) {
          if (file.endsWith('.bin') && file.startsWith(filePrefix)) {
            try {
              await fsp.unlink(path.join(roomsDir, file));
              removed++;
            } catch (e) {
              console.warn(`[Database] Failed to delete file ${file}:`, e);
            }
          }
        }
        console.log(`[Database] Cleared ${removed} room binary files for workspace: ${workspace}`);
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: 'Database room state cleared. Server memory reset.' }));
    } catch (e) {
      console.error(`[HTTP] 500 Error /api/reconstruct-db: ${e.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }

  console.log(`[HTTP] 200 OK / (default root status check page)`);
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Live Cursor Sync Server (WebSocket + DB) is running.');
});

// Create WebSocket server
const wss = new WebSocketServer({ noServer: true });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  // Keep the room ID percent-encoded so it matches the HTTP API's room keys.
  // url.pathname always starts with '/', so strip it to get the raw room name.
  let roomName = url.pathname.replace(/^\/sync\/?/, '').replace(/^\//, '');

  if (url.searchParams.get('token') !== AUTH_TOKEN) {
    console.warn(`[+] Unauthorized websocket connection rejected for room: ${roomName}`);
    ws.close(4001, 'unauthorized');
    return;
  }

  console.log(`[+] Client connected to room: ${roomName}`);

  // Pre-load or retrieve the shared doc instance before connection setup so Yjs
  // has correct disk state BEFORE synchronization begins!
  const doc = getRoomDoc(roomName);

  // Bind connection to standard y-websocket protocol — this uses our pre-loaded doc
  setupWSConnection(ws, req, { docName: roomName });
});

server.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

server.listen(port, '0.0.0.0', () => {
  console.log('===================================================');
  console.log('      LIVE CURSOR PRIVATE SYNC & DATABASE SERVER     ');
  console.log('===================================================');
  console.log(`[*] Version: 1.3.18`);
  console.log(`[*] Port: ${port}`);
  console.log(`[*] Database Directory: ${dbDir}`);
  console.log(`[*] Listening on: 0.0.0.0:${port}`);
  console.log('===================================================');
});

// Flush pending saves on server termination
function flushAllDocs() {
  console.log('[Database] Flushing all documents to disk before shutdown...');
  for (const [roomName, doc] of docs.entries()) {
    saveDoc(roomName, doc);
  }
}
process.on('SIGTERM', () => {
  flushAllDocs();
  process.exit(0);
});
process.on('SIGINT', () => {
  flushAllDocs();
  process.exit(0);
});
