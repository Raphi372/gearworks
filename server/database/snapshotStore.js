'use strict';
/* ==========================================================================
   database/snapshotStore.js — where a room's authoritative snapshot BLOB lives.

   Separating the (large, hot) snapshot from its (small) metadata is what lets
   metadata sit in a shared database while snapshots live in shared blob storage,
   so ANY instance can load ANY room on placement — the last piece of a true
   multi-instance data plane (docs/FUTURE_ARCHITECTURE.md §2.3/§3.4).

   `World.snapshot` stays the authoritative record ([DB-6]); it may simply live
   outside the metadata row, addressed by a small `snapshotRef`.

   Backends behind one contract ({ external, put, get, del }):
     • 'inline' (default) — the snapshot stays embedded in the room save, exactly
       as today (external=false). The $0 single box never leaves this mode.
     • 'fs'               — the snapshot is written to a separate directory
       (optionally a shared/network mount) as <code>.snap.json; the room save
       keeps only a `snapshotRef` pointer. This proves the externalized-blob
       split with zero cloud infra and is genuinely useful on a shared volume.

   The object-storage ('s3' / Cloudflare R2) backend implements the SAME contract
   with a zero-dependency SigV4 PUT/GET/DELETE over Node's http(s) — like
   server/mailer.js's HTTP approach ([A-7], [DB-3]). Object storage is network
   I/O, so its put/get are ASYNC (`async:true`); the store awaits them. Because
   the file backend's save path is synchronous (SIGTERM flush), 's3' is paired
   with STORAGE=postgres, whose write path is already an async queue.
   ========================================================================== */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function createSnapshotStore(config) {
  const mode = ['fs', 's3'].includes(config.SNAPSHOT_STORE) ? config.SNAPSHOT_STORE : 'inline';
  if (mode === 'inline') {
    return { mode, external: false, async: false, put() { return null; }, get() { return null; }, del() {} };
  }
  if (mode === 's3') return createS3Store(config);

  const dir = config.SNAPSHOT_DIR || path.join(config.SAVE_DIR || 'saves', 'snapshots');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* created lazily */ }
  const key = (code) => `${code}.snap.json`;
  const at = (ref) => path.join(dir, path.basename(String(ref)));
  config.log(`snapshots: fs backend (${dir})`);
  return {
    mode, external: true, async: false,
    // write the blob; return the ref stored alongside the room's metadata.
    put(code, snapshot) { fs.writeFileSync(at(key(code)), JSON.stringify(snapshot)); return key(code); },
    get(ref) { try { return JSON.parse(fs.readFileSync(at(ref), 'utf8')); } catch (e) { return null; } },
    del(code) { try { fs.unlinkSync(at(key(code))); } catch (e) { /* already gone */ } },
  };
}

/* --------- object storage (AWS S3 / Cloudflare R2), zero-dependency --------- */
function createS3Store(config) {
  const endpoint = String(config.SNAPSHOT_S3_ENDPOINT || '').replace(/\/$/, '');
  const bucket = config.SNAPSHOT_S3_BUCKET;
  const region = config.SNAPSHOT_S3_REGION || 'auto';
  const access = config.SNAPSHOT_S3_ACCESS_KEY;
  const secret = config.SNAPSHOT_S3_SECRET_KEY;
  const prefix = config.SNAPSHOT_S3_PREFIX || '';
  if (!endpoint || !bucket || !access || !secret) {
    throw new Error('SNAPSHOT_STORE=s3 requires SNAPSHOT_S3_ENDPOINT, _BUCKET, _ACCESS_KEY and _SECRET_KEY');
  }
  const u = new URL(endpoint);
  const transport = u.protocol === 'http:' ? require('http') : require('https');
  const host = u.host;
  const key = (code) => `${prefix}${code}.snap.json`;
  const sha256hex = (b) => crypto.createHash('sha256').update(b).digest('hex');
  const hmac = (k, s) => crypto.createHmac('sha256', k).update(s).digest();
  config.log(`snapshots: s3 backend (${host}/${bucket})`);

  // one SigV4-signed request. Path-style addressing: /<bucket>/<key>.
  function request(method, objectKey, body) {
    return new Promise((resolve, reject) => {
      const now = new Date();
      const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');   // YYYYMMDDTHHMMSSZ
      const dateStamp = amzDate.slice(0, 8);
      const payload = body || Buffer.alloc(0);
      const payloadHash = sha256hex(payload);
      const canonicalUri = '/' + encodeURIComponent(bucket) + '/' + objectKey.split('/').map(encodeURIComponent).join('/');
      const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
      const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
      const canonicalRequest = [method, canonicalUri, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
      const scope = `${dateStamp}/${region}/s3/aws4_request`;
      const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(Buffer.from(canonicalRequest))].join('\n');
      const kDate = hmac('AWS4' + secret, dateStamp);
      const signingKey = hmac(hmac(hmac(kDate, region), 's3'), 'aws4_request');
      const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');
      const authorization = `AWS4-HMAC-SHA256 Credential=${access}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
      const req = transport.request({
        method, host: u.hostname, port: u.port || undefined, path: canonicalUri,
        headers: { Host: host, 'x-amz-date': amzDate, 'x-amz-content-sha256': payloadHash,
          Authorization: authorization, 'Content-Length': payload.length },
      }, (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
      });
      req.on('error', reject);
      if (payload.length) req.write(payload);
      req.end();
    });
  }

  return {
    mode: 's3', external: true, async: true,
    async put(code, snapshot) {
      const objectKey = key(code);
      const res = await request('PUT', objectKey, Buffer.from(JSON.stringify(snapshot)));
      if (res.status < 200 || res.status >= 300) throw new Error(`s3 put ${objectKey} → ${res.status}`);
      return objectKey;
    },
    async get(ref) {
      const res = await request('GET', String(ref), null).catch(() => null);
      if (!res || res.status === 404) return null;
      if (res.status < 200 || res.status >= 300) return null;
      try { return JSON.parse(res.body.toString('utf8')); } catch (e) { return null; }
    },
    async del(code) { await request('DELETE', key(code), null).catch(() => {}); },
  };
}

module.exports = { createSnapshotStore };
