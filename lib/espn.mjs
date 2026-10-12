// ESPN site API (free, no key): scoreboards with DraftKings lines, game summaries with injuries.
// Fetching helpers plus pure parsers. Never uses the research plain-normal ladder pricing (pricing is not done here).

export const ESPN_SITE = 'https://site.api.espn.com/apis/site/v2/sports/football';

export const LEAGUES = {
  nfl: { path: 'nfl', query: {} },
  cfb: { path: 'college-football', query: { groups: '80', limit: '300' } }, // groups=80 = FBS (includes FBS vs FCS)
};

export function scoreboardUrl(league, { seasonType, week } = {}) {
  const L = LEAGUES[league];
  if (!L) throw new Error(`unknown league ${league}`);
  const sp = new URLSearchParams();
  if (seasonType != null && week != null) {
    sp.set('seasontype', String(seasonType));
    sp.set('week', String(week));
  }
  for (const [k, v] of Object.entries(L.query)) sp.set(k, v);
  const qs = sp.toString();
  return `${ESPN_SITE}/${L.path}/scoreboard${qs ? `?${qs}` : ''}`;
}

export function summaryUrl(league, eventId) {
  return `${ESPN_SITE}/${LEAGUES[league].path}/summary?event=${encodeURIComponent(eventId)}`;
}

// Next calendar entry after (seasonType, week). Crosses into the postseason correctly.
// calendar: [{ value: '<seasonType>', entries: [{ value: '<week>', startDate }] }]
export function nextWeek(calendar, seasonType, week) {
  if (!Array.isArray(calendar)) return Number.isFinite(week) ? { seasonType, week: week + 1 } : null;
  const flat = [];
  for (const sec of calendar) {
    if (!sec || typeof sec !== 'object' || !Array.isArray(sec.entries)) continue;
    for (const e of sec.entries) flat.push({ seasonType: Number(sec.value), week: Number(e.value), start: Date.parse(e.startDate) });
  }
  flat.sort((a, b) => a.start - b.start);
  const i = flat.findIndex((x) => x.seasonType === seasonType && x.week === week);
  return i >= 0 && i + 1 < flat.length ? { seasonType: flat[i + 1].seasonType, week: flat[i + 1].week } : null;
}

/**
 * Default scoreboard (current week) plus the next calendar week: 2 requests per league.
 * Date ranges (?dates=A-B) return HTTP 400 as of 2026-10-11, so week numbers are the only option.
 * Returns { boards: [json...], errors: [string] }. A failed next-week fetch keeps the default board.
 */
export async function fetchScoreboards(http, league) {
  const boards = [];
  const errors = [];
  let cur;
  try {
    cur = await http.getJson(scoreboardUrl(league));
    boards.push(cur);
  } catch (e) {
    errors.push(`${league} scoreboard: ${e.message}`);
    return { boards, errors };
  }
  const seasonType = Number(cur?.season?.type ?? cur?.leagues?.[0]?.season?.type?.type);
  const week = Number(cur?.week?.number);
  const next = nextWeek(cur?.leagues?.[0]?.calendar, seasonType, week);
  if (next) {
    try {
      boards.push(await http.getJson(scoreboardUrl(league, next)));
    } catch (e) {
      errors.push(`${league} scoreboard week ${next.week}: ${e.message}`);
    }
  }
  return { boards, errors };
}

// ---------------------------------------------------------------- pure parsing

// '-135' -> -135, '+114' -> 114, 'EVEN' -> 100, 'OFF' / '' / null -> null
export function parseAmerican(s) {
  if (s == null) return null;
  if (typeof s === 'number') return Number.isFinite(s) && Math.abs(s) >= 100 ? s : null;
  const t = String(s).trim().toUpperCase();
  if (t === 'EVEN' || t === 'EV') return 100;
  if (!/^[+-]?\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Math.abs(n) < 100 ? null : n;
}

// '+2.5' -> 2.5, 'o41.5' -> 41.5, 'u41.5' -> 41.5, 'PK' -> 0, junk -> null
export function parseLine(s) {
  if (s == null) return null;
  if (typeof s === 'number') return Number.isFinite(s) ? s : null;
  const t = String(s).trim().toLowerCase().replace(/^[ou]/, '');
  if (t === 'pk' || t === 'pick' || t === "pick'em" || t === 'even') return 0;
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

// Any ESPN date ('2026-10-12T00:20Z') -> '2026-10-12T00:20:00Z'. Unparseable -> null.
export function iso(t) {
  if (t == null || t === '') return null;
  const ms = typeof t === 'number' ? t : Date.parse(t);
  return Number.isFinite(ms) ? new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z') : null;
}

const neg = (x) => (x == null ? null : x === 0 ? 0 : -x);

/**
 * competitions[0] -> SPEC Odds or null. Uses the DraftKings provider (id '100'); never a 'Live Odds' provider.
 * ESPN 'close' fields are the CURRENT line (they move pregame); 'open' fields are the opening line.
 */
export function parseOdds(comp, fetchedAt) {
  const arr = Array.isArray(comp?.odds) ? comp.odds : [];
  const o = arr.find((x) => String(x?.provider?.id) === '100') || arr.find((x) => x && !/live/i.test(x?.provider?.name || '')) || null;
  if (!o) return null;
  const A = parseAmerican, Ln = parseLine;
  const ml = o.moneyline, ps = o.pointSpread, tt = o.total;

  const mlHome = A(ml?.home?.close?.odds), mlAway = A(ml?.away?.close?.odds);
  const mlOut = mlHome == null && mlAway == null ? null : {
    home: mlHome, away: mlAway, homeOpen: A(ml?.home?.open?.odds), awayOpen: A(ml?.away?.open?.odds),
  };

  const homeLine = Ln(ps?.home?.close?.line) ?? neg(Ln(ps?.away?.close?.line)) ?? (typeof o.spread === 'number' ? o.spread : null);
  const spreadOut = homeLine == null ? null : {
    home: homeLine,
    homeOdds: A(ps?.home?.close?.odds),
    awayOdds: A(ps?.away?.close?.odds),
    homeOpen: Ln(ps?.home?.open?.line) ?? neg(Ln(ps?.away?.open?.line)),
    homeOddsOpen: A(ps?.home?.open?.odds),
    awayOddsOpen: A(ps?.away?.open?.odds),
  };

  const line = Ln(tt?.over?.close?.line) ?? Ln(tt?.under?.close?.line) ?? (typeof o.overUnder === 'number' ? o.overUnder : null);
  const totalOut = line == null ? null : {
    line,
    overOdds: A(tt?.over?.close?.odds),
    underOdds: A(tt?.under?.close?.odds),
    lineOpen: Ln(tt?.over?.open?.line) ?? Ln(tt?.under?.open?.line),
    overOddsOpen: A(tt?.over?.open?.odds),
    underOddsOpen: A(tt?.under?.open?.odds),
  };

  if (!mlOut && !spreadOut && !totalOut) return null;
  return { provider: o.provider?.name || o.provider?.displayName || 'DraftKings', fetchedAt: fetchedAt ?? null, ml: mlOut, spread: spreadOut, total: totalOut };
}

/** competitor -> SPEC Team (kalshiCode filled by the builder). */
export function parseTeam(competitor) {
  const t = competitor?.team || {};
  const recs = Array.isArray(competitor?.records) ? competitor.records : [];
  const rec = recs.find((r) => r?.type === 'total') || recs.find((r) => r?.name === 'overall') || null;
  return {
    abbr: t.abbreviation ?? null,
    name: t.displayName ?? null,
    shortName: t.shortDisplayName ?? null,
    espnId: t.id != null ? String(t.id) : null,
    kalshiCode: null,
    logo: t.logo ?? null,
    record: rec?.summary ?? null,
  };
}

/** Scoreboard weather (cheap, no extra request). Wind is not in the scoreboard, so windMph stays null. */
export function parseWeather(ev, comp) {
  const w = ev?.weather;
  const indoor = comp?.venue?.indoor;
  if (!w && indoor == null) return null;
  const temp = w?.temperature;
  return {
    tempF: typeof temp === 'number' ? temp : temp != null && Number.isFinite(Number(temp)) ? Number(temp) : null,
    condition: w?.displayValue ?? null,
    windMph: null,
    indoor: indoor == null ? null : !!indoor,
  };
}

/**
 * Normalise scoreboard events for one league. Dedupes by event id (first board wins).
 * Each item: { id, league, season, seasonType, week, kickoff, kickoffMs, state, neutral,
 *              homeComp, awayComp, comp, raw }
 */
export function parseScoreboardEvents(boards, league) {
  const seen = new Set();
  const out = [];
  for (const b of boards || []) {
    for (const ev of b?.events || []) {
      const id = ev?.id != null ? String(ev.id) : null;
      if (!id || seen.has(id)) continue;
      const comp = ev?.competitions?.[0];
      const homeComp = comp?.competitors?.find((c) => c.homeAway === 'home');
      const awayComp = comp?.competitors?.find((c) => c.homeAway === 'away');
      const kickoff = iso(comp?.date || ev?.date);
      if (!comp || !homeComp || !awayComp || !kickoff) continue;
      seen.add(id);
      out.push({
        id,
        league,
        season: Number(ev.season?.year ?? b?.season?.year) || null,
        seasonType: Number(ev.season?.type ?? b?.season?.type) || null,
        week: Number(ev.week?.number ?? b?.week?.number) || null,
        kickoff,
        kickoffMs: Date.parse(kickoff),
        state: ev.status?.type?.state ?? comp.status?.type?.state ?? null,
        neutral: !!comp.neutralSite,
        homeComp,
        awayComp,
        comp,
        raw: ev,
      });
    }
  }
  return out;
}

const STATUS_MAP = [
  [/^injured reserve|^ir$/i, 'IR'],
  [/physically unable|^pup$/i, 'PUP'],
];
function normStatus(s) {
  const t = String(s || '').trim();
  for (const [re, v] of STATUS_MAP) if (re.test(t)) return v;
  return t || null;
}

function injuryDetail(d) {
  if (!d || typeof d !== 'object') return null;
  const parts = [d.type, d.detail].filter((x) => x && !/^not specified$/i.test(String(x)));
  return parts.length ? [...new Set(parts)].join(', ') : null;
}

/**
 * Game summary -> Map<espnTeamId, [Injury]>. starter and depthRank stay null until depth charts are wired in (phase B).
 * Note: ESPN 'Out' includes coach's-decision inactives (for example a backup QB), so `detail` is passed through.
 */
export function parseSummaryInjuries(summary) {
  const out = new Map();
  for (const t of Array.isArray(summary?.injuries) ? summary.injuries : []) {
    const teamId = t?.team?.id != null ? String(t.team.id) : null;
    if (!teamId) continue;
    const list = [];
    for (const x of Array.isArray(t.injuries) ? t.injuries : []) {
      const a = x?.athlete || {};
      list.push({
        espnId: a.id != null ? String(a.id) : null,
        name: a.displayName || a.fullName || null,
        pos: a.position?.abbreviation || null,
        status: normStatus(x.status || x.type?.description),
        detail: injuryDetail(x.details),
        starter: null,
        depthRank: null,
        updated: iso(x.date),
      });
    }
    out.set(teamId, list);
  }
  return out;
}
