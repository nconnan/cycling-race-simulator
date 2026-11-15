#!/usr/bin/env node
/*
 * Sporthive (MYLAPS) sync: refreshes js/history-data.js with the club's latest race results.
 *
 * Reads each organisation's events from MYLAPS' public event-results service, downloads the
 * results CSV of any race session not already in the history, and keeps per grade only the
 * finishing speed summary (no riders' names). Uses the app's own results reader (js/core.js).
 *
 * Usage:  node tools/sporthive-sync.js [--cache <dir>] [--full] [--dry-run]
 *   --cache <dir>  read/write downloaded CSVs in <dir> (saves requests when rebuilding)
 *   --full         rebuild every race, not just new ones
 *   --dry-run      report what would change without writing
 * Settings: tools/sporthive.config.json
 * Exit code 0 = up to date or updated; 1 = the service could not be read (history left as it was).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const C = require('../js/core.js');

const ROOT = path.join(__dirname, '..');
const API = 'https://eventresults-api.speedhive.com/api/v0.2.3/eventresults';
const OUT = path.join(ROOT, 'js', 'history-data.js');
const HEADERS = { 'User-Agent': 'cycling-race-simulator-sync (club race planning)' };

// ---------- Pure parts (tested) ----------

// One history record from a session's results CSV, or null if it isn't a usable lap race.
function raceRecord(csvText, event, sessionId, orgId) {
  let res;
  try { res = C.readResults(csvText); } catch (e) { return null; }
  const loc = event.location || {};
  const locKm = +loc.length > 0 ? +loc.length * (loc.lengthUnit === 'mi' ? 1.609344 : 1) : null;
  const lapKm = res.lapKm || locKm;
  if (!lapKm) return null;
  const g = [];
  for (const grp of res.groups) {
    const st = C.speedStats(grp.riders, 0, lapKm);
    if (!st.n) continue;
    g.push([grp.label, grp.fullLaps, st.n, Math.round(st.median * 10) / 10, st.range, grp.shortCount]);
  }
  if (!g.length) return null;
  if (Math.max(...g.map(x => x[1] || 0)) <= 1) return null; // single-lap (road/TT) races aren't used
  return { id: String(sessionId), o: orgId !== undefined ? Number(orgId) : undefined, d: event.startDate, c: (loc.name || 'Unknown course').trim(), e: String(event.name || '').trim(), l: lapKm, g };
}

function readHistory(file) {
  if (!fs.existsSync(file)) return null;
  const src = fs.readFileSync(file, 'utf8');
  const sandbox = {};
  new Function('window', src)(sandbox);
  return sandbox.BUILTIN_HISTORY || null;
}

function writeHistory(file, h) {
  const js = `/* Built-in speed history: ${h.source}.\n   Refreshed by tools/sporthive-sync.js (weekly on GitHub). Per race: session id, date, course, event, lap km,\n   and per grade [label, laps, riders, median km/h, ± km/h, lapped/pulled]. Finishing speeds only; no riders' names. */\nwindow.BUILTIN_HISTORY = ${JSON.stringify(h)};\n`;
  fs.writeFileSync(file, js);
}

// ---------- Network ----------

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Retries busy or failed requests patiently: 3, 8, 20, 45 s (MYLAPS sometimes answers 503 under load).
async function get(url, kind = 'json') {
  let last;
  const waits = [3000, 8000, 20000, 45000];
  for (let attempt = 0; attempt <= waits.length; attempt++) {
    try {
      const res = await fetch(url, { headers: { ...HEADERS, Accept: kind === 'json' ? 'application/json' : 'text/csv' } });
      if (res.ok) return kind === 'json' ? res.json() : res.text();
      last = new Error(`${res.status} ${res.statusText} for ${url}`);
      if (res.status === 404 || res.status === 403) break;
    } catch (e) { last = e; }
    if (attempt < waits.length) await sleep(waits[attempt]);
  }
  throw last;
}

async function sessionCsv(id, cacheDir) {
  const cached = cacheDir && path.join(cacheDir, `csv-${id}.csv`);
  if (cached && fs.existsSync(cached) && fs.statSync(cached).size > 0) return fs.readFileSync(cached, 'utf8');
  const text = await get(`${API}/sessions/${id}/csv`, 'csv');
  if (cached) fs.writeFileSync(cached, text);
  await sleep(150);
  return text;
}

function raceSessions(sessionsDoc) {
  const out = [...(sessionsDoc.sessions || [])];
  const walk = g => { (g.sessions || []).forEach(s => out.push(s)); (g.subGroups || []).forEach(walk); };
  (sessionsDoc.groups || []).forEach(walk);
  return out.filter(s => s.type === 'race');
}

// ---------- Main ----------

async function main() {
  const args = process.argv.slice(2);
  const opt = k => args.includes(k);
  const cacheDir = args.includes('--cache') ? args[args.indexOf('--cache') + 1] : null;
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'sporthive.config.json'), 'utf8'));
  const old = readHistory(OUT);
  const known = new Map(opt('--full') || !old ? [] : old.races.filter(r => r.id).map(r => [r.id, r]));
  const checked = new Set(opt('--full') || !old ? [] : (old.checked || []).map(String));
  // Events already read in full; only events from the last few weeks are read again
  // (results are sometimes published or corrected a little late).
  const doneEvents = new Set(opt('--full') || !old ? [] : (old.events || []).map(String));
  const recentFrom = new Date(Date.now() - 21 * 864e5).toISOString().slice(0, 10);
  const keptByEvent = new Map();
  if (old) for (const r of old.races) if (r.ev) (keptByEvent.get(String(r.ev)) || keptByEvent.set(String(r.ev), []).get(String(r.ev))).push(r);
  let requests = 0;

  const races = [], newIds = [];
  for (const org of cfg.organisations) {
    const events = [];
    for (let offset = 0; ; offset += 100) {
      if (offset) await sleep(1500);
      const page = await get(`${API}/organizations/${org.id}/events?count=100&offset=${offset}`);
      requests++;
      events.push(...page);
      if (page.length < 100) break;
    }
    for (const ev of events) {
      if (cfg.since && ev.startDate < cfg.since) continue;
      if (doneEvents.has(String(ev.id)) && ev.startDate < recentFrom) {
        (keptByEvent.get(String(ev.id)) || []).forEach(r => races.push({ ...r, o: org.id }));
        continue;
      }
      requests++;
      let sessions;
      try { sessions = raceSessions(await get(`${API}/events/${ev.id}/sessions`)); }
      catch (e) { console.warn(`skip event ${ev.id}: ${e.message}`); continue; }
      for (const s of sessions) {
        const id = String(s.id);
        if (known.has(id)) { races.push({ ...known.get(id), o: org.id, ev: ev.id }); continue; }
        if (checked.has(id)) continue;
        let csv;
        try { requests++; csv = await sessionCsv(id, cacheDir); } catch (e) { console.warn(`skip session ${id}: ${e.message}`); continue; }
        checked.add(id);
        const rec = raceRecord(csv, ev, id, org.id);
        if (rec) rec.ev = ev.id;
        if (rec) { races.push(rec); newIds.push(id); }
      }
      doneEvents.add(String(ev.id));
      if (!known.size) await sleep(100);
    }
  }

  races.sort((a, b) => b.d.localeCompare(a.d) || Number(a.id) - Number(b.id));
  // Some races are published twice (same day, course and results): keep the first copy only
  const byId = [...new Map(races.map(r => [r.id, r])).values()];
  const seen = new Set(), uniq = [];
  for (const r of byId) {
    const key = `${r.d}|${r.c}|${JSON.stringify(r.g)}`;
    if (seen.has(key)) { checked.add(r.id); continue; }
    seen.add(key);
    uniq.push(r);
  }
  const today = new Date().toISOString().slice(0, 10);
  const clubs = cfg.organisations.map(o => {
    const rs = uniq.filter(r => r.o === o.id);
    return { id: o.id, name: o.name, races: rs.length, from: rs.length ? rs[rs.length - 1].d : null, to: rs.length ? rs[0].d : null };
  });
  const h = {
    source: `${cfg.organisations.map(o => o.name).join(', ')} results on Sporthive (MYLAPS)`,
    club: cfg.organisations[0].name,
    clubs,
    fetched: today,
    races: uniq,
    checked: [...checked].filter(id => !uniq.some(r => r.id === id)).sort(),
    events: [...doneEvents].sort()
  };
  const changed = !old || newIds.length > 0 || uniq.length !== old.races.length || JSON.stringify(old.clubs) !== JSON.stringify(clubs);
  console.log(`${uniq.length} races (${newIds.length} new${newIds.length ? ': ' + newIds.join(', ') : ''}); ${requests} requests to Sporthive.`);
  if (opt('--dry-run')) return;
  if (changed) writeHistory(OUT, h);
  // Tell GitHub Actions whether anything new arrived
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `new_races=${newIds.length}\n`);
}

if (require.main === module) {
  main().catch(e => { console.error(`Sporthive sync failed: ${e.message}. History left unchanged.`); process.exit(1); });
}
module.exports = { raceRecord, readHistory, raceSessions };
