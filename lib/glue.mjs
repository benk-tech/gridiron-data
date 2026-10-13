// glue.mjs (from research critic_glue.mjs)  (Node 22+, no deps; the pure parts also run in the browser)
// Glue the five round-2 modules were missing: ONE team-code map, ONE Kalshi game code, ONE name key,
// the ESPN <-> gsis <-> pfr id bridge, and the "front / secondary" matchup metrics the site asked for
// (RB vs a good D-line, WR vs a bad secondary) that defense.mjs does not compute.
// Tested 2026-10-12 00:2xZ by critic_test.mjs on live nflverse + ESPN depth + Kalshi/ESPN props data.

// ---------- 1) team codes: nflverse is canonical ----------
// nflverse: LA, WAS, JAX.   ESPN: LAR, WSH, JAX.   Kalshi: LAR, WAS, JAC.   (all verified live)
const NV_TO_ESPN = { LA: 'LAR', WAS: 'WSH' };
const NV_TO_KALSHI = { LA: 'LAR', JAX: 'JAC' };
const ANY_TO_NV = { LAR: 'LA', WSH: 'WAS', JAC: 'JAX', STL: 'LA', SD: 'LAC', OAK: 'LV' };
export const nv = (abbr) => ANY_TO_NV[abbr] || abbr;               // any source -> nflverse
export const toEspn = (abbr) => NV_TO_ESPN[nv(abbr)] || nv(abbr);
export const toKalshi = (abbr) => NV_TO_KALSHI[nv(abbr)] || nv(abbr);

// ---------- 2) Kalshi game code: YYMONDD + AWAY + HOME, US-Eastern calendar date ----------
// Uses formatToParts (no Date re-parse of a locale string, so it is correct in any host time zone).
const ET = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: '2-digit', month: 'short', day: '2-digit' });
export function kalshiGameCode(kickoffIso, awayAny, homeAny) {
  const p = Object.fromEntries(ET.formatToParts(new Date(kickoffIso)).map((x) => [x.type, x.value]));
  return `${p.year}${p.month.toUpperCase()}${p.day}${toKalshi(awayAny)}${toKalshi(homeAny)}`;
}

// ---------- 3) one name key (Kalshi ticker style): first initial + last-name letters, suffixes dropped ----------
const SUFFIX = new Set(['JR', 'SR', 'II', 'III', 'IV', 'V']);
const letters = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z]/g, '');
export function nameKey(full) {
  const t = String(full || '').trim().split(/\s+/).filter(Boolean);
  while (t.length > 2 && SUFFIX.has(letters(t[t.length - 1]))) t.pop();
  return t.length < 2 ? letters(t[0] || '') : letters(t[0]).slice(0, 1) + letters(t.slice(1).join(''));
}

// ---------- 4) id bridge from nflverse roster_weekly (quoted CSV: headshot_url contains commas) ----------
// Latest row per gsis_id. Joins: ESPN athlete id (injuries, depth, propBets, roster) <-> gsis (stats_player_week)
// <-> pfr_id (snap_counts, pfr_advstats) and gives jersey + team for Kalshi ticker tokens.
export function buildIdBridge({ head, rows }) {
  const c = Object.fromEntries(['gsis_id', 'espn_id', 'pfr_id', 'team', 'jersey_number', 'full_name', 'position', 'week', 'status'].map((n) => [n, head.indexOf(n)]));
  const latest = new Map();
  for (const r of rows) { const g = r[c.gsis_id]; if (g && (!latest.has(g) || +r[c.week] > +latest.get(g)[c.week])) latest.set(g, r); }
  const byEspn = new Map(), byGsis = new Map(), byPfr = new Map();
  for (const r of latest.values()) {
    const p = { gsis: r[c.gsis_id], espn: r[c.espn_id] || null, pfr: r[c.pfr_id] || null, team: r[c.team], jersey: r[c.jersey_number] || null,
      name: r[c.full_name], pos: r[c.position], status: r[c.status], week: +r[c.week] };
    byGsis.set(p.gsis, p); if (p.espn) byEspn.set(p.espn, p); if (p.pfr) byPfr.set(p.pfr, p);
  }
  return { byEspn, byGsis, byPfr };
}

// ---------- 5) front / secondary metrics (adds what defense.mjs lacks) ----------
// From pbp: stuff rate (designed runs gaining <= 0), explosive run rate (>= 10 yds), explosive pass rate (dropbacks >= 20 yds).
// From nflverse pfr_advstats advstats_week_def: team pressures per dropback, and per-defender coverage
// (targets, yards allowed per target) so a named starting CB can be graded.
export function buildFrontSecondary({ pbp, pfrDef, bridge }) {
  // PFR advanced stats lag pbp (seen live: PFR file through Sunday 11:02Z, pbp through Sunday's late games), so the
  // pressure-rate denominator only counts pbp dropbacks from games the PFR file already covers.
  const fc = Object.fromEntries(['game_id', 'game_type', 'team', 'pfr_player_id', 'pfr_player_name', 'def_targets', 'def_yards_allowed', 'def_completions_allowed', 'def_pressures', 'def_receiving_td_allowed'].map((n) => [n, pfrDef.head.indexOf(n)]));
  const pfrGames = new Set(pfrDef.rows.map((r) => r[fc.game_id]));
  const pc = Object.fromEntries(['game_id', 'season_type', 'defteam', 'play_type', 'rush_attempt', 'qb_scramble', 'two_point_attempt', 'qb_dropback', 'yards_gained'].map((n) => [n, pbp.head.indexOf(n)]));
  const T = {};
  for (const r of pbp.rows) {
    if (r[pc.season_type] !== 'REG' || r[pc.two_point_attempt] === '1') continue;
    const d = r[pc.defteam], pt = r[pc.play_type]; if (!d || (pt !== 'run' && pt !== 'pass')) continue;
    const t = (T[d] ||= { runs: 0, stuffs: 0, xRun: 0, db: 0, xPass: 0, dbPfr: 0, prss: 0, cov: {} });
    const y = Number(r[pc.yards_gained]) || 0;
    if (pt === 'run' && r[pc.rush_attempt] === '1' && r[pc.qb_scramble] !== '1') { t.runs++; if (y <= 0) t.stuffs++; if (y >= 10) t.xRun++; }
    if (r[pc.qb_dropback] === '1') { t.db++; if (y >= 20) t.xPass++; if (pfrGames.has(r[pc.game_id])) t.dbPfr++; }
  }
  for (const r of pfrDef.rows) {
    if (r[fc.game_type] && r[fc.game_type] !== 'REG') continue;
    const t = T[r[fc.team]]; if (!t) continue;
    const n = (k) => Number(r[fc[k]]) || 0;
    t.prss += n('def_pressures');
    const id = r[fc.pfr_player_id];
    const v = (t.cov[id] ||= { pfr: id, name: r[fc.pfr_player_name], tgt: 0, yds: 0, cmp: 0, td: 0 });
    v.tgt += n('def_targets'); v.yds += n('def_yards_allowed'); v.cmp += n('def_completions_allowed'); v.td += n('def_receiving_td_allowed');
  }
  const out = {};
  for (const [team, t] of Object.entries(T)) {
    const cov = {};
    for (const v of Object.values(t.cov)) if (v.tgt) {
      const espn = bridge?.byPfr.get(v.pfr)?.espn || null;
      cov[espn || 'pfr:' + v.pfr] = { name: v.name, pfr: v.pfr, espn, tgt: v.tgt, ydsPerTgt: +(v.yds / v.tgt).toFixed(2), cmpPct: +(v.cmp / v.tgt).toFixed(3), td: v.td };
    }
    out[team] = { runs: t.runs, stuffRate: +(t.stuffs / t.runs).toFixed(3), xRunRate: +(t.xRun / t.runs).toFixed(3),
      dropbacks: t.db, xPassRate: +(t.xPass / t.db).toFixed(3), pressureRate: t.dbPfr ? +(t.prss / t.dbPfr).toFixed(3) : null, pfrDropbacks: t.dbPfr, coverage: cov };
  }
  // ranks: 1 = toughest (most stuffs, fewest explosives, most pressure)
  const rank = (get, hi) => { const k = Object.keys(out).sort((a, b) => hi ? get(out[b]) - get(out[a]) : get(out[a]) - get(out[b])); return Object.fromEntries(k.map((x, i) => [x, i + 1])); };
  const R = { stuff: rank((t) => t.stuffRate, true), xRun: rank((t) => t.xRunRate), xPass: rank((t) => t.xPassRate), pressure: rank((t) => t.pressureRate, true) };
  for (const [k, t] of Object.entries(out)) t.ranks = Object.fromEntries(Object.entries(R).map(([n, m]) => [n, m[k]]));
  return out;
}

// ---------- 6) matchup tags for one prop (context only; the backtest found no standalone edge) ----------
// def    = defense.mjs nfl.defense[oppNv]  (ranks.run / ranks.pass = EPA ranks, 1 = toughest)
// fs     = buildFrontSecondary(...)[oppNv]
// depth  = injuries.mjs fetchDepth(...)[oppEspnTeamId]  (defense slots with ESPN ids + embedded injuries)
// Tiers use quarters of 32 (top 8 / bottom 8). A front or secondary is "tough" only when 2 of 3 metrics agree.
const RUSH = new Set(['KXNFLRSHYDS', 'KXNFLRSHATT', 'KXNFLRRYDS', 'KXNFLLONGRSH']);
const RECV = new Set(['KXNFLRECYDS', 'KXNFLREC', 'KXNFLLONGREC', 'KXNFLRRYDS']);
const PASS = new Set(['KXNFLPASSYDS', 'KXNFLPASSTDS', 'KXNFLPASSCOMP', 'KXNFLPASSATT', 'KXNFLPASSINT']);
const OUT = /^(out|injured reserve|doubtful)/i;
const SECONDARY = /^(lcb|rcb|cb\d?|nb|ss|fs|s\d?)$/;
// isOut(player) should come from injuries.mjs grade() (confirmed/likely for THIS game); the default reads the raw
// depth-embedded status, which wrongly carries a Sunday INACTIVE into next week.
export function matchupTags({ series, def, fs, depth, n = 32, isOut = (p) => OUT.test(p?.inj?.status || '') }) {
  const tags = [], notes = [];
  const tier = (ranks) => { const hi = ranks.filter((r) => r != null && r <= n / 4).length, lo = ranks.filter((r) => r != null && r > n - n / 4).length; return hi >= 2 ? 'tough' : lo >= 2 ? 'soft' : null; };
  if (RUSH.has(series) && def && fs) {
    const t = tier([def.ranks.run, fs.ranks.stuff, fs.ranks.xRun]);
    if (t) tags.push(`${t}-front`);
    notes.push(`front: EPA/rush #${def.ranks.run}, stuff rate ${(fs.stuffRate * 100).toFixed(1)}% (#${fs.ranks.stuff}), 10+ yd runs ${(fs.xRunRate * 100).toFixed(1)}% (#${fs.ranks.xRun})`);
    const frontOut = Object.entries(depth?.defense || {}).filter(([k, l]) => !SECONDARY.test(k) && isOut(l[0])).map(([k, l]) => `${l[0].name} (${k})`);
    if (frontOut.length >= 2) { tags.push('front-depleted'); notes.push(`front starters out: ${frontOut.join(', ')}`); }
  }
  if (RECV.has(series) && def && fs) {
    const t = tier([def.ranks.pass, fs.ranks.xPass, fs.ranks.pressure]);
    if (t) tags.push(`${t}-secondary`);
    notes.push(`pass D: EPA/db #${def.ranks.pass}, 20+ yd plays ${(fs.xPassRate * 100).toFixed(1)}% (#${fs.ranks.xPass}), pressure ${(fs.pressureRate * 100).toFixed(1)}% (#${fs.ranks.pressure})`);
    for (const slot of ['lcb', 'rcb', 'nb']) {
      const [s1, s2] = depth?.defense?.[slot] || []; if (!s1) continue;
      const cb = isOut(s1) ? s2 : s1;
      if (cb !== s1 && cb) { tags.push('backup-CB'); notes.push(`${slot.toUpperCase()} ${s1.name} out; ${cb.name} starts`); }
      const cv = cb && fs.coverage[cb.id];
      if (cv && cv.tgt >= 12 && cv.ydsPerTgt >= 9) { tags.push('weak-CB'); notes.push(`${slot.toUpperCase()} ${cv.name}: ${cv.ydsPerTgt} yds/tgt on ${cv.tgt} tgt`); }
      else if (cv && cv.tgt >= 12 && cv.ydsPerTgt <= 5.5) { tags.push('lockdown-CB'); notes.push(`${slot.toUpperCase()} ${cv.name}: ${cv.ydsPerTgt} yds/tgt on ${cv.tgt} tgt`); }
    }
  }
  if (PASS.has(series) && fs && def) {
    if (fs.ranks.pressure <= n / 4) tags.push('heavy-pressure');
    notes.push(`pressure ${(fs.pressureRate * 100).toFixed(1)}% of dropbacks (#${fs.ranks.pressure}), EPA/db #${def.ranks.pass}`);
  }
  return { tags: [...new Set(tags)], notes };
}

// ---------- 7) prop-line drift check (is ESPN "current" a true pregame close?) ----------
// a, b = { 'athleteId|typeId': { cur, open, lu } } captured before and after kickoff.
export function diffLines(a, b) {
  const changed = [], gone = [];
  for (const [k, v] of Object.entries(a)) { const w = b[k]; if (!w) gone.push(k); else if (w.cur !== v.cur) changed.push({ k, pre: v.cur, post: w.cur }); }
  return { common: Object.keys(a).filter((k) => b[k]).length, changed, gone: gone.length, added: Object.keys(b).filter((k) => !a[k]).length };
}
