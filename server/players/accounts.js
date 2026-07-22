'use strict';
/* ==========================================================================
   players/accounts.js — account identity & authentication.

   Custom, dependency-free auth built on node:crypto — a deliberate fit for
   this zero-dependency codebase (no Clerk/Auth.js/Supabase SDK, which would
   clash with the vanilla client and add a heavy dependency for what is a
   small, well-understood surface). Security properties:

     • Passwords hashed with scrypt + a per-account random salt.
     • Constant-time verification (timingSafeEqual).
     • Stateless session tokens (via players/tokens.js): tokens carry {aid, sv}
       where `sv` is the account's tokenVersion, so a password reset / "log out
       everywhere" bumps the version and invalidates every previously-issued
       token. No server-side session table needed. Signed with AUTH_SECRET.
     • Login attempts are rate-limited per username.
     • Guest accounts (no password) let players get in instantly but still get
       a persistent identity + owned worlds via their saved token.

   Accounts persist through the storage backend (file or Postgres), so this
   module is backend-agnostic.
   ========================================================================== */
const crypto = require('crypto');

function createAuth(config, store, mailer, tokens) {
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
  // All tokens go through the shared signer (players/tokens.js). A session
  // token carries {aid, sv}: `sv` is the account's tokenVersion, so bumping the
  // version (password reset / "log out everywhere") invalidates every token
  // already issued. Reset/verify tokens are the same primitive scoped by
  // purpose; a reset token also binds `pv` (a hash of the current password) so
  // it stops working the instant the password changes — single-use, no state.
  function sessionToken(acct) { return tokens.sign('session', { aid: acct.id, sv: acct.tokenVersion || 0 }, TTL_MS); }
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
      passwordHash: hashPassword(password), guest: false, tokenVersion: 0, createdAt: Date.now(),
    };
    const created = await store.createAccount(acct);
    if (!created) return { error: 'username already taken' };
    return { account: publicAcct(created), token: sessionToken(created) };
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
    return { account: publicAcct(acct), token: sessionToken(acct) };
  }

  async function guest({ username, color }) {
    // guests get a unique display name (append a short suffix if taken)
    let base = validUsername(username) ? username : 'Guest';
    let name = base, tries = 0;
    while (await store.getAccountByName(name)) { name = `${base}_${crypto.randomBytes(2).toString('hex')}`; if (++tries > 5) break; }
    const acct = {
      id: crypto.randomBytes(12).toString('hex'),
      username: name, color: validColor(color), passwordHash: null, guest: true, tokenVersion: 0, createdAt: Date.now(),
    };
    const created = await store.createAccount(acct);
    if (!created) return { error: 'could not create guest' };
    return { account: publicAcct(created), token: sessionToken(created) };
  }

  async function fromToken(token) {
    const d = tokens.verify('session', token);
    if (!d) return null;
    const acct = await store.getAccount(d.aid);
    if (!acct || (acct.tokenVersion || 0) !== d.sv) return null;   // stale version → session invalidated
    return publicAcct(acct);
  }

  // Underlying primitive for password-reset invalidation and a future
  // "log out everywhere": bumping tokenVersion voids all existing sessions.
  async function invalidateSessions(accountId) {
    const acct = await store.getAccount(accountId).catch(() => null);
    if (!acct) return { error: 'account not found' };
    await store.updateAccount(accountId, { tokenVersion: (acct.tokenVersion || 0) + 1 });
    return { ok: true };
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
      const token = tokens.sign('reset', { aid: acct.id, pv: pvOf(acct) }, RESET_TTL_MS);
      await sendMail(acct.email, 'Reset your Gearworks password', resetBody(token)).catch(() => {});
    }
    return { ok: true };
  }

  async function resetPassword({ token, password }) {
    const data = tokens.verify('reset', token);
    if (!data) return { error: 'this reset link is invalid or has expired' };
    if (!validPassword(password)) return { error: 'password must be at least 8 characters' };
    const acct = await store.getAccount(data.aid).catch(() => null);
    if (!acct) return { error: 'account not found' };
    if (data.pv !== pvOf(acct)) return { error: 'this reset link has already been used' };   // single-use
    // set the new password AND bump tokenVersion so every existing login session
    // is invalidated (a reset should sign the account out everywhere).
    await store.updateAccount(acct.id, { passwordHash: hashPassword(password), tokenVersion: (acct.tokenVersion || 0) + 1 });
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
    const token = tokens.sign('verify', { aid: account.id }, RESET_TTL_MS);
    await sendMail(e, 'Verify your Gearworks email', verifyBody(token)).catch(() => {});
    return { ok: true, account: publicAcct(acct) };
  }

  async function verifyEmail({ token }) {
    const data = tokens.verify('verify', token);
    if (!data) return { error: 'this verification link is invalid or has expired' };
    const updated = await store.updateAccount(data.aid, { emailVerified: true });
    const acct = updated || await store.getAccount(data.aid).catch(() => null);
    if (!acct) return { error: 'account not found' };
    return { ok: true, account: publicAcct(acct) };
  }

  function publicAcct(a) { return { id: a.id, username: a.username, color: a.color, guest: !!a.guest, email: a.email || null, emailVerified: !!a.emailVerified }; }

  return { register, login, guest, fromToken, publicAcct, invalidateSessions,
    requestReset, resetPassword, setEmail, verifyEmail };
}

module.exports = { createAuth };
