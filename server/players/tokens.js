'use strict';
/* ==========================================================================
   players/tokens.js — the single stateless-token signer for the whole server.

   Every token the system issues — account sessions, password-reset / email-
   verification links, and room reconnect tokens — is the same primitive:

       base64url(JSON payload) + "." + base64url(HMAC-SHA256(payload))

   signed with AUTH_SECRET. Each token is scoped by a `p` (purpose) field and
   carries an `exp`; verification is constant-time and checks purpose + expiry.
   Centralising this here keeps reconnect and auth tokens on one implementation
   (no duplicated signing logic) and gives a consistent security surface.
   ========================================================================== */
const crypto = require('crypto');

function b64url(buf) { return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function b64urlDecode(s) { return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64'); }

function createTokens(config) {
  const SECRET = Buffer.from(config.AUTH_SECRET, 'utf8');

  // sign(purpose, data, ttlMs) -> token. Fields of `data` are embedded verbatim.
  function sign(purpose, data, ttlMs) {
    const payload = b64url(JSON.stringify(Object.assign({}, data, { p: purpose, exp: Date.now() + ttlMs })));
    const mac = b64url(crypto.createHmac('sha256', SECRET).update(payload).digest());
    return payload + '.' + mac;
  }

  // verify(purpose, token) -> decoded payload (incl. embedded data) or null.
  // Rejects a tampered signature (constant-time), wrong purpose, or expiry.
  function verify(purpose, token) {
    if (typeof token !== 'string') return null;
    const i = token.indexOf('.');
    if (i < 0) return null;
    const payload = token.slice(0, i), mac = token.slice(i + 1);
    const expected = b64url(crypto.createHmac('sha256', SECRET).update(payload).digest());
    const a = Buffer.from(mac), b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    let d; try { d = JSON.parse(b64urlDecode(payload).toString('utf8')); } catch (e) { return null; }
    if (!d || d.p !== purpose || !d.exp || d.exp < Date.now()) return null;
    return d;
  }

  return { sign, verify };
}

module.exports = { createTokens, b64url, b64urlDecode };
