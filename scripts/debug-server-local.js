// Spin up server.js locally with SF CLI auth (no credentials in env needed),
// then hit /api/executive-data?fy=FY26 and print the response.
//
// Run: node scripts/debug-server-local.js [FY]
const { execSync } = require('child_process');
const path = require('path');

const FY = process.argv[2] || 'FY26';
const ALIAS = process.env.SF_ALIAS || 'yspolter-admin';

const out = execSync(`sf org display -o ${ALIAS} --json`, { encoding: 'utf8' });
const j = JSON.parse(out);
const accessToken = j.result.accessToken;
const instanceUrl = j.result.instanceUrl;
console.log(`[debug] using ${ALIAS} -> ${instanceUrl}`);

// Monkey-patch jsforce so getSfConnection returns a CLI-authed connection
// regardless of which auth path the code takes (SOAP login or OAuth).
const jsforce = require('jsforce');
const origConnection = jsforce.Connection;
jsforce.Connection = function ConnectionShim(opts) {
  const conn = new origConnection({ accessToken, instanceUrl });
  conn.login = async () => ({ id: '/fake/id', organizationId: 'fake' });
  return conn;
};

process.env.PORT = process.env.PORT || '3939';
process.env.SF_USERNAME = process.env.SF_USERNAME || 'cli-stub';
process.env.SF_PASSWORD = process.env.SF_PASSWORD || 'cli-stub';
process.env.SF_SECURITY_TOKEN = process.env.SF_SECURITY_TOKEN || 'cli-stub';

require(path.resolve(__dirname, '..', 'server.js'));

setTimeout(async () => {
  const url = `http://127.0.0.1:${process.env.PORT}/api/executive-data?fy=${FY}`;
  console.log(`\n[debug] GET ${url}`);
  try {
    const res = await fetch(url);
    const body = await res.text();
    console.log(`[debug] HTTP ${res.status}`);
    console.log(body.slice(0, 4000));
  } catch (e) {
    console.error('[debug] request error:', e.message);
  }
  process.exit(0);
}, 800);
