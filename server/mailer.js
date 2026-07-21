'use strict';
/* ==========================================================================
   mailer.js — transactional email for account recovery. Zero-dependency and
   pluggable, mirroring monitoring.js. Providers (config.MAIL_PROVIDER):

     • resend  — POST the Resend HTTP API (no SMTP, no dependency). Needs
                 MAIL_API_KEY and MAIL_FROM.
     • capture — append each message to MAIL_CAPTURE_FILE as JSONL (tests).
     • log     — (default) no external send; in non-prod it logs the body so a
                 developer can complete a flow locally without a provider.

   send() never throws and never blocks the caller on failure — recovery email
   is best-effort; the flow degrades to "check with an admin" rather than error.
   Tokens are never logged in production.
   ========================================================================== */
function createMailer(config) {
  const { log } = config;
  const provider = config.MAIL_PROVIDER;
  const from = config.MAIL_FROM;

  async function send({ to, subject, text }) {
    if (!to) return false;

    if (provider === 'resend') {
      if (!config.MAIL_API_KEY) { log.warn('mail: MAIL_PROVIDER=resend but MAIL_API_KEY is unset — not sending'); return false; }
      try {
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + config.MAIL_API_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from, to: [to], subject, text }),
        });
        if (!res.ok) { log.error('mail: resend responded ' + res.status); return false; }
        return true;
      } catch (e) { log.error('mail: resend send failed: ' + e.message); return false; }
    }

    if (provider === 'capture') {
      try {
        require('fs').appendFileSync(config.MAIL_CAPTURE_FILE, JSON.stringify({ to, subject, text, at: Date.now() }) + '\n');
        return true;
      } catch (e) { log.error('mail: capture failed: ' + e.message); return false; }
    }

    // 'log' — never send. Avoid logging the token/body in production.
    if (config.isProd) log(`mail (no provider configured): to=${to} subject="${subject}"`);
    else log(`mail (dev log) to=${to} subject="${subject}"\n${text}`);
    return true;
  }

  return { send, provider };
}

module.exports = { createMailer };
