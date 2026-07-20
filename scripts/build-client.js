#!/usr/bin/env node
'use strict';
/* ==========================================================================
   scripts/build-client.js — assemble the static client for Cloudflare Pages.

   Produces dist/ containing exactly what the browser needs (index.html +
   shared/ + client/ + docs/) plus the edge config (_headers, _redirects,
   404.html) from public/. No bundler: the client is dependency-free ES5/HTML,
   so "build" is a deterministic copy — fast, cache-friendly, nothing to break.
   ========================================================================== */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'dist');

function rmrf(p) { fs.rmSync(p, { recursive: true, force: true }); }
function copy(src, dst) {
  const s = fs.statSync(src);
  if (s.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const f of fs.readdirSync(src)) copy(path.join(src, f), path.join(dst, f));
  } else {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
}

rmrf(OUT);
fs.mkdirSync(OUT, { recursive: true });

// game client
for (const item of ['index.html', 'shared', 'client', 'docs']) {
  copy(path.join(ROOT, item), path.join(OUT, item));
}
// edge config (flattened to the publish root)
for (const item of fs.readdirSync(path.join(ROOT, 'public'))) {
  copy(path.join(ROOT, 'public', item), path.join(OUT, item));
}

const count = (function walk(p) {
  let n = 0;
  for (const f of fs.readdirSync(p)) {
    const fp = path.join(p, f);
    n += fs.statSync(fp).isDirectory() ? walk(fp) : 1;
  }
  return n;
})(OUT);

console.log(`built client -> dist/ (${count} files)`);
