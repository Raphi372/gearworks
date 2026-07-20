/* ==========================================================================
   PM2 process definition for self-hosting the Gearworks game server for free
   (e.g. on a Mac behind a Cloudflare Tunnel). See docs/FREE_DEPLOYMENT_GUIDE.md.

   PM2 gives us, at $0:
     • auto-restart on crash (autorestart + exponential backoff)
     • crash-loop protection (min_uptime / max_restarts)
     • memory guard (restart if the process leaks past a ceiling)
     • log capture to ./logs (rotate with `pm2 install pm2-logrotate`)
     • boot persistence (`pm2 startup` + `pm2 save`)

   Run:   pm2 start ecosystem.config.js
   Logs:  pm2 logs gearworks
   Stop:  pm2 stop gearworks

   Secrets (AUTH_SECRET, DATABASE_URL, …) are read from the gitignored .env
   file by server/config.js — do NOT put secrets in this committed file.
   ========================================================================== */
module.exports = {
  apps: [
    {
      name: 'gearworks',
      script: 'server/server.js',
      cwd: __dirname,

      // One process owns all room state in memory, so run a single fork.
      instances: 1,
      exec_mode: 'fork',

      // Resilience.
      autorestart: true,
      max_restarts: 15,          // give up only after a genuine crash loop
      min_uptime: '15s',         // a restart faster than this counts toward the loop
      restart_delay: 2000,       // wait 2s between restarts (backoff-friendly)
      max_memory_restart: '450M',// recycle if memory ever runs away

      // Let graceful shutdown finish saving every room before PM2 hard-kills.
      kill_timeout: 6000,

      // Non-secret defaults. Bind to loopback: only the Cloudflare Tunnel
      // (running on the same machine) needs to reach the server, so it is not
      // exposed to your LAN. Override any of these in .env.
      env: {
        NODE_ENV: 'production',
        PORT: 8080,
        HOST: '127.0.0.1',
        STORAGE: 'file',
        SAVE_DIR: './saves',
      },

      // Logs (timestamped, stdout+stderr merged).
      out_file: './logs/gearworks-out.log',
      error_file: './logs/gearworks-err.log',
      merge_logs: true,
      time: true,
    },
  ],
};
