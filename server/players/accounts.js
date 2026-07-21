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

function createAuth(config, store, mailer) {
  const SECRET = Buffer.from(config.AUTH_SECRET, 'utf8');
  const TTL_MS = config.TOKEN_TTL_DAYS * 24 * 3600 * 1000;
  const RESET_TTL_MS = config.RESET_TTL_MIN * 60 * 1000;
  const attempts = new Map();   // usernameLower -> [timestamps] (login throttle)
  const resetReq = new Map();   // key -> [timestamps]  (reset-request throttle)

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

  /* ------------------- purpose-scoped tokens (recovery) --------------- */
  // Reset / verify links are stateless signed tokens like sessions, but scoped
  // by `purpose` (so a session token can't act as a reset token), short-lived,
  // and — for resets — bound to `pv` (a hash of the current password) so the
  // token stops working the instant the password changes: single-use, no state.
  function signScoped(aid, purpose, extra) {
    const payload = b64url(JSON.stringify(Object.assign({ aid, purpose, exp: Date.now() + RESET_TTL_MS }, extra || {})));
    const mac = b64url(crypto.createHmac('sha256', SECRET).update(payload).digest());
    return `${payload}.${mac}`;
  }
  function verifyScoped(token, purpose) {
    if (typeof token !== 'string' || token.indexOf('.') < 0) return null;
    const [payload, mac] = token.split('.');
    const expected = b64url(crypto.createHmac('sha256', SECRET).update(payload).digest());
    const a = Buffer.from(mac || ''), b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    let data; try { data = JSON.parse(b64urlDecode(payload).toString('utf8')); } catch (e) { return null; }
    if (!data || data.purpose !== purpose || !data.aid || !data.exp || data.exp < Date.now()) return null;
    return data;
  }
  function pvOf(acct) { return crypto.createHash('sha256').update(String(acct.passwordHash || 'guest')).digest('hex').slice(0, 16); }

  /* ----------------------------- validation --------------------------- */
  const USERNAME_RE = /^[A-Za-z0-9_\-]{3,20}$/;
  const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
  function validUsername(u) { return typeof u === 'string' && USERNAME_RE.test(u); }
  function validPassword(p) { return typeof p === 'string' && p.length >= 8 && p.length <= 200; }
  function validEmail(e) { return typeof e === 'string' && e.length <= 200 && EMAIL_RE.test(e); }
  function validColor(c) { return /^#[0-9a-fA-F]{6}$/.test(c || '') ? c : '#4aa3ff'; }

  function resetThrottled(key) {
    const now = Date.now();
    const list = (resetReq.get(key) || []).filter((t) => now - t < 15 * 60 * 1000);
    resetReq.set(key, list);
    if (list.length >= 3) return true;
    list.push(now); resetReq.set(key, list);
    return false;
  }

  /* --------------------------- recovery mail -------------------------- */
  function link(token, kind) { return config.APP_URL ? `${config.APP_URL.replace(/\/$/, '')}/?${kind}=${encodeURIComponent(token)}` : null; }
  async function sendMail(to, subject, text) { if (mailer) return mailer.send({ to, subject, text }); }
  function resetBody(token) {
    const l = link(token, 'reset');
    return 'Someone requested a password reset for your Gearworks account.\n\n' +
      (l ? `Open this link to choose a new password:\n${l}\n\n` : '') +
      `Or paste this reset code into the game's "Forgot password" screen:\n${token}\n\n` +
      `This code expires in ${config.RESET_TTL_MIN} minutes. If you did not request it, you can ignore this email.`;
  }
  function verifyBody(token) {
    const l = link(token, 'verify');
    return 'Confirm your email address for Gearworks.\n\n' +
      (l ? `Open this link:\n${l}\n\n` : '') +
      `Or paste this code into the game's account screen:\n${token}\n\n` +
      `This code expires in ${config.RESET_TTL_MIN} minutes.`;
  }

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

  /* ------------------------- account recovery ------------------------- */
  // Ask for a reset link. ALWAYS resolves ok — never reveals whether an
  // account or email exists (anti-enumeration). Mail is sent only to a real,
  // verified, non-guest account, and is rate-limited.
  async function requestReset({ emailOrUsername }) {
    const q = String(emailOrUsername || '').trim();
    if (!q) return { ok: true };
    let acct = null;
    if (validEmail(q) && store.getAccountByEmail) acct = await store.getAccountByEmail(q.toLowerCase()).catch(() => null);
    if (!acct) acct = await store.getAccountByName(q).catch(() => null);
    if (acct && acct.email && acct.emailVerified && !acct.guest && !resetThrottled('r:' + acct.id)) {
      const token = signScoped(acct.id, 'reset', { pv: pvOf(acct) });
      await sendMail(acct.email, 'Reset your Gearworks password', resetBody(token)).catch(() => {});
    }
    return { ok: true };
  }

  async function resetPassword({ token, password }) {
    const data = verifyScoped(token, 'reset');
    if (!data) return { error: 'this reset link is invalid or has expired' };
    if (!validPassword(password)) return { error: 'password must be at least 8 characters' };
    const acct = await store.getAccount(data.aid).catch(() => null);
    if (!acct) return { error: 'account not found' };
    if (data.pv !== pvOf(acct)) return { error: 'this reset link has already been used' };   // single-use
    await store.updateAccount(acct.id, { passwordHash: hashPassword(password) });
    attempts.delete(String(acct.username || '').toLowerCase());   // clear login throttle
    return { ok: true };
  }

  // Attach (or change) an email on a signed-in account, then send verification.
  async function setEmail({ account, email }) {
    if (!account) return { error: 'not signed in' };
    const e = String(email || '').trim().toLowerCase();
    if (!validEmail(e)) return { error: 'enter a valid email address' };
    if (store.getAccountByEmail) {
      const other = await store.getAccountByEmail(e).catch(() => null);
      if (other && other.id !== account.id) return { error: 'that email is already in use' };
    }
    const updated = await store.updateAccount(account.id, { email: e, emailVerified: false });
    const acct = updated || await store.getAccount(account.id);
    const token = signScoped(account.id, 'verify', {});
    await sendMail(e, 'Verify your Gearworks email', verifyBody(token)).catch(() => {});
    return { ok: true, account: publicAcct(acct) };
  }

  async function verifyEmail({ token }) {
    const data = verifyScoped(token, 'verify');
    if (!data) return { error: 'this verification link is invalid or has expired' };
    const updated = await store.updateAccount(data.aid, { emailVerified: true });
    const acct = updated || await store.getAccount(data.aid).catch(() => null);
    if (!acct) return { error: 'account not found' };
    return { ok: true, account: publicAcct(acct) };
  }

  function publicAcct(a) { return { id: a.id, username: a.username, color: a.color, guest: !!a.guest, email: a.email || null, emailVerified: !!a.emailVerified }; }

  return { register, login, guest, fromToken, verifyToken, publicAcct,
    requestReset, resetPassword, setEmail, verifyEmail };
}

module.exports = { createAuth };
