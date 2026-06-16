// Authoritative Bomberman server: HTTP static host + WebSocket game endpoint.
//
// In production (`npm start`) Vite builds the client into ../dist and this one
// process serves both the static bundle and the realtime game socket, so the
// whole thing deploys as a single Node service. In development the client is
// served by Vite on its own port; this process still exposes the ws endpoint
// and `GET /` returns a friendly hint instead of a blank 404.

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { WebSocketServer } from 'ws';

import { decode } from '../shared/protocol.js';
import { attach, handleMessage, handleClose } from './rooms.js';

const PORT = process.env.PORT || 8080;

// ../dist relative to this file (server/ -> repo root -> dist).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.resolve(__dirname, '..', 'dist');

// Minimal content-type table; the client is just html/js/css plus a few assets.
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

function contentType(filePath) {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

// Does the built client exist? Cached after the first lookup.
let distReadyPromise = null;
function distReady() {
  if (!distReadyPromise) {
    distReadyPromise = stat(path.join(DIST_DIR, 'index.html'))
      .then(() => true)
      .catch(() => false);
  }
  return distReadyPromise;
}

// Resolve a request URL to a safe absolute path inside DIST_DIR, or null if the
// request tries to escape the directory (path traversal guard).
function resolveSafe(urlPath) {
  // Decode %xx, strip query/hash, normalise.
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(urlPath, 'http://x').pathname);
  } catch {
    return null;
  }
  if (pathname === '/') pathname = '/index.html';
  const resolved = path.resolve(DIST_DIR, '.' + pathname);
  // Must stay within DIST_DIR.
  if (resolved !== DIST_DIR && !resolved.startsWith(DIST_DIR + path.sep)) {
    return null;
  }
  return resolved;
}

async function serveFile(res, filePath, status = 200) {
  const body = await readFile(filePath);
  res.writeHead(status, {
    'Content-Type': contentType(filePath),
    'Content-Length': body.length,
  });
  res.end(body);
}

// Helpful page when no build exists (dev mode hitting this server directly).
function sendDevHint(res) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(
    `<!doctype html><html><head><meta charset="utf-8"><title>Bomberman server</title></head>` +
    `<body style="font-family:system-ui;max-width:40rem;margin:4rem auto;line-height:1.5">` +
    `<h1>Bomberman WebSocket server</h1>` +
    `<p>The realtime game endpoint is running on this port.</p>` +
    `<p>No production build was found in <code>../dist</code>. ` +
    `In development, open the Vite client at ` +
    `<a href="http://localhost:5173">http://localhost:5173</a> ` +
    `(run <code>npm run dev</code>), or build the client with <code>npm run build</code> ` +
    `and reload this page for the bundled app.</p>` +
    `</body></html>`,
  );
}

const server = http.createServer(async (req, res) => {
  try {
    // Only GET/HEAD are served; everything else is a 405.
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Method Not Allowed');
      return;
    }

    const built = await distReady();
    if (!built) {
      // No bundle: serve the dev hint for any route.
      sendDevHint(res);
      return;
    }

    const filePath = resolveSafe(req.url || '/');
    if (filePath === null) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Bad Request');
      return;
    }

    // Try the exact file first.
    try {
      const info = await stat(filePath);
      if (info.isFile()) {
        await serveFile(res, filePath);
        return;
      }
    } catch {
      // fall through to SPA handling
    }

    // SPA fallback: a route that looks like a file (has an extension) but does
    // not exist is a genuine 404; anything else falls back to index.html so the
    // client-side router can take over.
    if (path.extname(filePath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    await serveFile(res, path.join(DIST_DIR, 'index.html'));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Internal Server Error');
    // eslint-disable-next-line no-console
    console.error('[http] request failed:', err);
  }
});

// ---- WebSocket game endpoint -------------------------------------------------

const wss = new WebSocketServer({ server });

wss.on('connection', (socket) => {
  attach(socket);

  socket.on('message', (data) => {
    // ws delivers a Buffer; decode() returns null for malformed JSON.
    const msg = decode(data.toString());
    if (msg === null) return; // ignore garbage silently
    try {
      handleMessage(socket, msg);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[ws] message handler error:', err);
    }
  });

  socket.on('close', () => handleClose(socket));
  socket.on('error', () => handleClose(socket));
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Bomberman server listening on http://localhost:${PORT}  (ws on same port)`);
});
