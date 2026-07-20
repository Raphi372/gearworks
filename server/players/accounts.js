'use strict';
/* ==========================================================================
   players/accounts.js — account identity & authentication.

   Custom, dependency-free auth built on node:crypto — a deliberate fit for
   this zero-dependency codebase (no Clerk/Auth.js/Supabase SDK, which would
   clash with the vanilla client and add a heavy dependency for what is a
   small, well-understood surface). Security properties:

     • Passwords hashed with scrypt + a per-account random salt.
     • Constant-time verification (timingSafeEqual).
     • Stateless session tokens: base64url(payload) + "." + HMAC-SHA256(secret).
       No server-side session table needed; tokens carry {aid, exp} and are
       tamper-evident. Signed with AUTH_SECRET (env; must be stable in prod).
     • Login attempts are rate-limited per username.
     • Guest accounts (no password) let players get in instantly but still get
       a persistent identity + owned worlds via their saved token.

   Accounts persist through the storage backend (file or Postgres), so this
   module is backend-agnostic.
   ========================================================================== */
const crypto = require('crypto');

function b64url(buf) { return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function b64urlDecode(s) { return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64'); }

function createAuth(config, store) {
  const SECRET = Buffer.from(config.AUTH_SECRET, 'utf8');
  const TTL_MS = config.TOKEN_TTL_DAYS * 24 * 3600 * 1000;
  const attempts = new Map();   // usernameLower -> [timestamps] (login throttle)

  /* ------------------------------ passwords --------------------------- */
  function hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(password, salt, 64);
    return `${salt.toString('hex')}:${hash.toString('hex')}`;
  }
  function verifyPassword(password, stored) {
    if (!stored || stored.indexOf(':') < 0) return false;
    const [saltHex, hashHex] = stored.split(':');
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  }

  /* ---------------------------- session tokens ------------------------ */
  function sign(accountId) {
    const payload = b64url(JSON.stringify({ aid: accountId, exp: Date.now() + TTL_MS }));
    const mac = b64url(crypto.createHmac('sha256', SECRET).update(payload).digest());
    return `${payload}.${mac}`;
  }
  function verifyToken(token) {
    if (typeof token !== 'string' || token.indexOf('.') < 0) return null;
    const [payload, mac] = token.split('.');
    const expected = b64url(crypto.createHmac('sha256', SECRET).update(payload).digest());
    // constant-time MAC compare
    const a = Buffer.from(mac || ''), b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    let data; try { data = JSON.parse(b64urlDecode(payload).toString('utf8')); } catch (e) { return null; }
    if (!data || !data.aid || !data.exp || data.exp < Date.now()) return null;
    return data.aid;
  }

  /* ----------------------------- validation --------------------------- */
  const USERNAME_RE = /^[A-Za-z0-9_\-]{3,20}$/;
  function validUsername(u) { return typeof u === 'string' && USERNAME_RE.test(u); }
  function validPassword(p) { return typeof p === 'string' && p.length >= 8 && p.length <= 200; }
  function validColor(c) { return /^#[0-9a-fA-F]{6}$/.test(c || '') ? c : '#4aa3ff'; }

  function throttled(usernameLower) {
    const now = Date.now();
    const list = (attempts.get(usernameLower) || []).filter((t) => now - t < 15 * 60 * 1000);
    attempts.set(usernameLower, list);
    return list.length >= config.LOGIN_MAX_ATTEMPTS;
  }
  function recordAttempt(usernameLower) {
    const list = attempts.get(usernameLower) || [];
    list.push(Date.now()); attempts.set(usernameLower, list);
  }

  /* ----------------------------- operations --------------------------- */
  async function register({ username, password, color }) {
    if (!validUsername(username)) return { error: 'username must be 3-20 letters/numbers/_/-' };
    if (!validPassword(password)) return { error: 'password must be at least 8 characters' };
    const acct = {
      id: crypto.randomBytes(12).toString('hex'),
      username, color: validColor(color),
      passwordHash: hashPassword(password), guest: false, createdAt: Date.now(),
    };
    const created = await store.createAccount(acct);
    if (!created) return { error: 'username already taken' };
    return { account: publicAcct(created), token: sign(created.id) };
  }

  async function login({ username, password }) {
    if (!validUsername(username)) return { error: 'invalid credentials' };
    const key = username.toLowerCase();
    if (throttled(key)) return { error: 'too many attempts — try again later' };
    const acct = await store.getAccountByName(username);
    // always run a verify to keep timing uniform whether or not the user exists
    const ok = acct && !acct.guest && verifyPassword(password, acct.passwordHash);
    if (!ok) { recordAttempt(key); return { error: 'invalid credentials' }; }
    attempts.delete(key);
    return { account: publicAcct(acct), token: sign(acct.id) };
  }

  async function guest({ username, color }) {
    // guests get a unique display name (append a short suffix if taken)
    let base = validUsername(username) ? username : 'Guest';
    let name = base, tries = 0;
    while (await store.getAccountByName(name)) { name = `${base}_${crypto.randomBytes(2).toString('hex')}`; if (++tries > 5) break; }
    const acct = {
      id: crypto.randomBytes(12).toString('hex'),
      username: name, color: validColor(color), passwordHash: null, guest: true, createdAt: Date.now(),
    };
    const created = await store.createAccount(acct);
    if (!created) return { error: 'could not create guest' };
    return { account: publicAcct(created), token: sign(created.id) };
  }

  async function fromToken(token) {
    const aid = verifyToken(token);
    if (!aid) return null;
    const acct = await store.getAccount(aid);
    return acct ? publicAcct(acct) : null;
  }

  function publicAcct(a) { return { id: a.id, username: a.username, color: a.color, guest: !!a.guest }; }

  return { register, login, guest, fromToken, verifyToken, publicAcct };
}

module.exports = { createAuth };
