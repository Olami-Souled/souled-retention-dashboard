#!/usr/bin/env node
/**
 * refresh-meta-spend.js — regenerate data/meta_spend.json from the direct Meta
 * Marketing API (replaces the old Windsor.ai MCP / manual refresh).
 *
 * Pulls daily account-level spend for the Souled ad account and rewrites the
 * spend_by_day map, preserving the file's existing shape. Requires
 * FACEBOOK_ADS_TOKEN (permanent System User token, ads_read) and optionally
 * FACEBOOK_AD_ACCOUNT_ID (defaults to act_548376353109705).
 *
 * Usage: node scripts/refresh-meta-spend.js [--since YYYY-MM-DD]
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const GRAPH = 'v25.0';
const TOKEN = process.env.FACEBOOK_ADS_TOKEN;
let ACCT = process.env.FACEBOOK_AD_ACCOUNT_ID || 'act_548376353109705';
if (!ACCT.startsWith('act_')) ACCT = 'act_' + ACCT;
const FILE = path.join(__dirname, '..', 'data', 'meta_spend.json');
const DEFAULT_SINCE = '2024-09-01';

function todayISO() { return new Date().toISOString().slice(0, 10); }

async function fetchJson(url) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const resp = await fetch(url);
    if (resp.ok) return resp.json();
    const body = await resp.json().catch(() => ({}));
    const err = body.error || {};
    const transient = [429, 500, 502, 503].includes(resp.status)
      || [1, 2, 4, 17, 32, 613].includes(err.code)
      || [1504022, 1504044].includes(err.error_subcode)
      || err.is_transient;
    if (!transient) throw new Error(`Meta API ${resp.status}: ${JSON.stringify(err)}`);
    const backoff = 10000 * 2 ** (attempt - 1);
    console.warn(`  attempt ${attempt} transient (${resp.status}); retry in ${backoff / 1000}s`);
    await new Promise((r) => setTimeout(r, backoff));
  }
  throw new Error('Meta API: exhausted retries');
}

async function fetchDailySpend(since, until) {
  const params = new URLSearchParams({
    level: 'account',
    fields: 'spend',
    time_range: JSON.stringify({ since, until }),
    time_increment: '1',
    limit: '500',
    access_token: TOKEN,
  });
  let url = `https://graph.facebook.com/${GRAPH}/${ACCT}/insights?${params}`;
  const byDay = {};
  while (url) {
    const page = await fetchJson(url);
    for (const row of page.data || []) {
      byDay[row.date_start] = Number(row.spend || 0);
    }
    url = (page.paging || {}).next || null;
  }
  return byDay;
}

async function main() {
  if (!TOKEN) throw new Error('FACEBOOK_ADS_TOKEN not set');
  const argSince = process.argv.includes('--since')
    ? process.argv[process.argv.indexOf('--since') + 1] : null;

  let existing = {};
  try { existing = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { /* fresh */ }
  const prior = existing.spend_by_day || {};
  const since = argSince || existing.earliest || DEFAULT_SINCE;
  const until = todayISO();

  console.log(`Fetching daily Meta spend ${since} -> ${until} for ${ACCT} (direct API)...`);
  const fresh = await fetchDailySpend(since, until);
  // Merge: fresh values win for overlapping days, keep any older history.
  const merged = { ...prior, ...fresh };
  const days = Object.keys(merged).sort();

  const out = {
    _note: 'Daily Meta spend on Souled Facebook account 548376353109705. Refresh via scripts/refresh-meta-spend.js (direct Meta Marketing API; requires FACEBOOK_ADS_TOKEN).',
    _source: 'Meta Marketing API (direct)',
    account_id: '548376353109705',
    fetched_at: todayISO(),
    earliest: days[0],
    latest: days[days.length - 1],
    spend_by_day: Object.fromEntries(days.map((d) => [d, merged[d]])),
  };
  fs.writeFileSync(FILE, JSON.stringify(out, null, 1));
  const total = days.reduce((s, d) => s + merged[d], 0);
  console.log(`  Wrote ${days.length} days (${out.earliest} -> ${out.latest}), total spend $${total.toLocaleString()}`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
