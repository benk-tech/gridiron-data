// Kalshi <-> ESPN game matcher. Port of the research matcher (tested 14/14 NFL week 6, 62/62 FBS week 7 on 2026-10-11)
// with the critic's rules: ET calendar date +/- 1 day, name + code aliases, NO kickoff-time window
// (Kalshi CFB kickoffs are placeholders 16 to 26.5 h early on about half the games).

const ET_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });

// ISO / ms -> 'YYYY-MM-DD' in US/Eastern (DST-safe; Kalshi date codes are Eastern dates).
export function etDate(t) {
  return ET_DATE.format(new Date(typeof t === 'number' ? t : Date.parse(t)));
}

// Strip accents and punctuation; 'St.' -> 'state'; '&' -> 'and'.
export function norm(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\bst\.?(?=\s|$)/g, 'state')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Kalshi name -> ESPN name where they genuinely differ (seen live 2026-10-11).
export const NAME_ALIAS = {
  'miami fl': 'miami',
  'louisiana monroe': 'ul monroe',
  umass: 'massachusetts',
  'appalachian state': 'app state',
};

// Kalshi code -> ESPN abbreviation where they differ (seen live 2026-10-11).
export const CODE_ALIAS = {
  NFL: { JAC: 'JAX', WAS: 'WSH' },
  CFB: {
    MTU: 'MTSU', JVST: 'JXST', MOSU: 'MOST', CHAR: 'CLT', TXAM: 'TA&M', MIZZ: 'MIZ',
    MOH: 'M-OH', NW: 'NU', ULL: 'UL', OKLA: 'OU', CCAR: 'CCU', IND: 'IU',
  },
};

const L = (league) => String(league || '').toUpperCase();

function teamKeys(t) {
  return new Set([t.location, t.displayName, t.shortDisplayName, t.abbreviation, t.nickname].filter(Boolean).map(norm));
}

function bigrams(s) {
  const o = [];
  for (let i = 0; i < s.length - 1; i++) o.push(s.slice(i, i + 2));
  return o;
}

export function dice(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const A = bigrams(a), B = bigrams(b);
  if (!A.length || !B.length) return 0;
  const m = new Map();
  for (const x of A) m.set(x, (m.get(x) || 0) + 1);
  let hit = 0;
  for (const x of B) {
    const c = m.get(x);
    if (c) { hit++; m.set(x, c - 1); }
  }
  return (2 * hit) / (A.length + B.length);
}

/**
 * Score in [0, 1] that Kalshi side { code, name } is ESPN team t. A side may also carry alt: [other names] (venues that
 * give a school name and a full name, or a truncated label): the best of the names counts.
 */
export function teamScore(k, t, league) {
  if (Array.isArray(k?.alt) && k.alt.length) {
    let best = teamScore({ code: k.code, name: k.name }, t, league);
    for (const name of k.alt) if (name) best = Math.max(best, teamScore({ code: '', name }, t, league));
    return best;
  }
  const n = norm(k.name);
  const n2 = NAME_ALIAS[n] || n;
  const keys = teamKeys(t);
  if (n && (keys.has(n) || keys.has(n2))) return 1; // NFL yes_sub_title can be truncated ('Los Angeles C'), so codes back it up
  const code = (CODE_ALIAS[L(league)] || {})[k.code] || k.code;
  if (code && code === String(t.abbreviation || '').toUpperCase()) return 0.97;
  let best = 0;
  for (const key of keys) best = Math.max(best, dice(n2, key));
  return best * 0.9;
}

export const MATCH_THRESHOLD = 0.75;

/**
 * matchGames(kalshiGames, espnEvents, league)
 *  kalshiGames: [{ eventTicker, dateKey, away: { code, name }, home: { code, name } }]
 *  espnEvents:  ESPN scoreboard events[] (raw)
 * Returns { matches: Map<eventTicker, { espnEvent, score, flipped }>, unmatchedKalshi: [kg], unmatchedEspn: [event] }.
 * flipped = Kalshi's away team is ESPN's home team (neutral sites).
 */
export function matchGames(kalshiGames, espnEvents, league) {
  const espn = [];
  for (const e of espnEvents || []) {
    const c = e?.competitions?.[0];
    const home = c?.competitors?.find((x) => x.homeAway === 'home')?.team;
    const away = c?.competitors?.find((x) => x.homeAway === 'away')?.team;
    const date = c?.date || e?.date;
    if (!home || !away || !date || !Number.isFinite(Date.parse(date))) continue;
    espn.push({ e, etDate: etDate(date), home, away, used: false });
  }
  const cands = [];
  for (const k of kalshiGames) {
    for (const g of espn) {
      const dd = Math.abs(Date.parse(k.dateKey) - Date.parse(g.etDate)) / 86400e3;
      if (dd > 1) continue;
      const straight = Math.min(teamScore(k.away, g.away, league), teamScore(k.home, g.home, league));
      const flipped = Math.min(teamScore(k.away, g.home, league), teamScore(k.home, g.away, league));
      const score = Math.max(straight, flipped) - dd * 0.01;
      if (score >= MATCH_THRESHOLD) cands.push({ k, g, score, flipped: flipped > straight });
    }
  }
  // Best score first; ties broken deterministically by ticker and ESPN id.
  cands.sort((a, b) => b.score - a.score || (a.k.eventTicker < b.k.eventTicker ? -1 : a.k.eventTicker > b.k.eventTicker ? 1 : 0) || String(a.g.e.id).localeCompare(String(b.g.e.id)));
  const matches = new Map();
  const usedK = new Set();
  for (const c of cands) {
    if (usedK.has(c.k.eventTicker) || c.g.used) continue;
    usedK.add(c.k.eventTicker);
    c.g.used = true;
    matches.set(c.k.eventTicker, { espnEvent: c.g.e, score: Math.round(c.score * 1000) / 1000, flipped: c.flipped });
  }
  return {
    matches,
    unmatchedKalshi: kalshiGames.filter((k) => !usedK.has(k.eventTicker)),
    unmatchedEspn: espn.filter((g) => !g.used).map((g) => g.e),
  };
}
