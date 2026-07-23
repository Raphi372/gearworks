'use strict';
/* ==========================================================================
   server/stats.js — periodic time-series sampler for the account metagame.

   Every STAT_SAMPLE_MIN minutes, each account currently active in a live room
   gets one data point per metric (net worth, buildings, tech, xp, level),
   recorded via the store's bounded `recordStats`. The metrics come from the
   same derived progression aggregate the lobby serves — no new source of
   truth. STAT_SAMPLE_MIN=0 (or a store without recordStats) disables it.

   `sampleOnce()` is exported so the sampler can be driven directly (tests, or
   a seed-on-first-view) without waiting on the wall-clock interval.
   ========================================================================== */
const Progression = require('../shared/progression.js');

function createStatSampler(config, registry, store) {
  const log = config.log;
  let timer = null;

  // distinct authenticated account ids across all live rooms' members
  function activeAccounts() {
    const ids = new Set();
    for (const r of registry.all()) {
      if (r.members) for (const aid of r.members.keys()) if (aid) ids.add(aid);
    }
    return Array.from(ids);
  }

  async function sampleAccount(aid) {
    if (!store.progression || !store.recordStats) return;
    const p = await store.progression(aid).catch(() => null);
    if (p) await store.recordStats(aid, Progression.metrics(p)).catch((e) => log.error(`stat record ${aid}: ${e.message}`));
  }

  async function sampleOnce() {
    const ids = activeAccounts();
    for (const aid of ids) await sampleAccount(aid);
    return ids.length;
  }

  function start() {
    const min = config.STAT_SAMPLE_MIN | 0;
    if (min <= 0 || !store.recordStats) { log('stats sampler disabled'); return; }
    timer = setInterval(() => { sampleOnce().catch((e) => log.error(`stat sample failed: ${e.message}`)); }, min * 60 * 1000);
    if (timer.unref) timer.unref();     // never keep the process alive for a sample
    log(`stats sampler active`, { everyMin: min });
  }

  function stop() { if (timer) clearInterval(timer); timer = null; }

  return { sampleOnce, sampleAccount, activeAccounts, start, stop };
}

module.exports = { createStatSampler };
