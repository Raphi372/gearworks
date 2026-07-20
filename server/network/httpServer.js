'use strict';
/* ==========================================================================
   network/httpServer.js — HTTP surface: health, static files, WS upgrade.

   In production the CLIENT is served by Cloudflare Pages (see client/_headers)
   and this process only needs /health + the WebSocket upgrade. But the same
   binary also serves the client statically for local dev and single-box
   self-hosting, so we apply the same hardened security headers here that the
   CDN applies at the edge.
   ========================================================================== */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { wsAccept } = require('./websocket');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
  '.md': 'text/markdown', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

// Content Security Policy tuned for the game: external scripts only (no inline
// script), inline styles allowed (the client sets element styles + ships a
// <style> block), data: favicon, and WebSocket to any host the player enters.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self' ws: wss:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

function securityHeaders() {
  return {
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'geolocation=(), microphone=(), camera=(), payment=(), usb=()',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    'Cross-Origin-Opener-Policy': 'same-origin',
  };
}

function createHttpServer(config, { getStats, onUpgrade }) {
  const { ROOT, log } = config;
  const startedAt = Date.now();

  const server = http.createServer((req, res) => {
    let p = decodeURIComponent((req.url || '/').split('?')[0]);
    if (p === '/') p = '/index.html';

    if (p === '/health' || p === '/healthz') {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': config.ALLOW_ORIGIN,
        'Cache-Control': 'no-store',
      });
      return res.end(JSON.stringify(Object.assign(
        { ok: true, uptime: Math.round((Date.now() - startedAt) / 1000), proto: config.PROTO, version: config.VERSION },
        getStats ? getStats() : {})));
    }
    if (p === '/favicon.ico') { res.writeHead(204); return res.end(); }

    const file = path.normalize(path.join(ROOT, p));
    if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end('forbidden'); }   // path-traversal guard
    const rel = path.relative(ROOT, file);
    if (!/^(index\.html|shared[\/\\]|client[\/\\]|docs[\/\\])/.test(rel)) { res.writeHead(404); return res.end('not found'); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, Object.assign({
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': rel === 'index.html' ? 'no-cache' : 'public, max-age=3600',
      }, securityHeaders()));
      res.end(data);
    });
  });

  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') { socket.destroy(); return; }
    socket.write('HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${wsAccept(key)}\r\n\r\n`);
    socket.setNoDelay(true);
    onUpgrade(socket);
  });

  return server;
}

module.exports = { createHttpServer, securityHeaders, CSP };
