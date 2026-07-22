'use strict';
/* Unit: the client build injects runtime config (BACKEND_URL / DISCOVERY_URL)
   into dist/client/config.js, and ships neutral empties when unset. */
const { test, after } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
function build(env) {
  execFileSync(process.execPath, ['scripts/build-client.js'], {
    cwd: ROOT, env: Object.assign({}, process.env, { BACKEND_URL: '', DISCOVERY_URL: '' }, env), stdio: 'ignore',
  });
  return fs.readFileSync(path.join(ROOT, 'dist', 'client', 'config.js'), 'utf8');
}
after(() => { try { fs.rmSync(path.join(ROOT, 'dist'), { recursive: true, force: true }); } catch (e) {} });

test('BACKEND_URL is injected as a ws(s) default server', () => {
  const c = build({ BACKEND_URL: 'https://play.example.com' });
  assert.match(c, /GEARWORKS_DEFAULT_SERVER = "wss:\/\/play\.example\.com"/);
});

test('DISCOVERY_URL is injected verbatim', () => {
  const c = build({ DISCOVERY_URL: 'https://gist.githubusercontent.com/u/abc/raw/server.txt' });
  assert.match(c, /GEARWORKS_DISCOVERY_URL = "https:\/\/gist\.githubusercontent\.com\/u\/abc\/raw\/server\.txt"/);
});

test('a neutral build ships both values empty', () => {
  const c = build({});
  assert.match(c, /GEARWORKS_DEFAULT_SERVER = ""/);
  assert.match(c, /GEARWORKS_DISCOVERY_URL = ""/);
});
