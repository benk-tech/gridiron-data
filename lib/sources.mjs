// All network fetching for one collector run. Produces the `inputs` object that lib/build.mjs turns into a snapshot.
// Hosts are fetched in separate chains so no host sees a large burst:
//   Kalshi (api.elections, fallback external-api): core series -> team totals -> props series -> fees -> collections
//   ESPN site.api: scoreboards -> league injuries feed (+ depth charts every 6 h) -> CFB weekly QB check
//   ESPN core api: DK propBets (inside the props step, after the scoreboards)
//   GitHub releases: nflverse (HEAD per asset, GET only on a new ETag), sportsdataverse CFB csv (daily)
// Each chain runs at most 2 to 4 requests in flight with short pauses.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createHttp, mapLimit, errorText, pacedFetch } from './http.mjs';
import {
  CORE_SERIES_LIST, createKalshiClient, fetchSeriesMarkets, fetchSeriesInfo, fetchOpenCollections,
} from './kalshi.mjs';
import { fetchScoreboards, parseScoreboardEvents, summaryUrl, iso } from './espn.mjs';
import { WINDOW, LEAGUE_KEYS } from './build.mjs';
import { fetchPropInputs, PROP_SERIES_LIST } from './props.mjs';
import { fetchTeamTotalInputs, TEAM_TOTAL_SERIES } from './teamtotals.mjs';
import { fetchInjuryInputs } from './injuries.mjs';
import { fetchNflverseInputs } from './nflverse.mjs';
import { fetchCfbInputs } from './cfb.mjs';

const DAY = 86400e3;
/** Optional parts of a run (all on by default). The core (Kalshi game/spread/total, ESPN boards, fees, combos) always runs. */
export const PART_KEYS = ['props', 'teamTotals', 'injuries', 'nflverse', 'cfb'];
export const TEAM_TOTAL_SERIES_LIST = Object.values(TEAM_TOTAL_SERIES);

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; }
}

async function writeJson(path, data) {
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(data));
  } catch { /* cache is best effort */ }
}

/**
 * Fee info (GET /series/{t}) for every series in the run, cached on disk by UTC date. Only series missing from the
 * day's file are fetched, so adding series (or one failed lookup) costs only those requests on the next run.
 */
export async function seriesInfo(kalshi, { now, cacheDir, series = CORE_SERIES_LIST, log = () => {} }) {
  const day = new Date(now).toISOString().slice(0, 10);
  const path = cacheDir ? join(cacheDir, `kalshi-series-${day}.json`) : null;
  const cached = path ? await readJson(path) : null;
  const data = { ...(cached?.data || {}) };
  const missing = series.filter((s) => !data[s]);
  if (!missing.length) {
    log(`fees: using cache ${day}`);
    return { fetchedAt: cached?.fetchedAt ?? null, errors: [], data, cached: true, requests: 0 };
  }
  const fetchedAt = iso(Date.now());
  const errors = [];
  let got = 0;
  await mapLimit(missing, 2, async (s) => {
    try { data[s] = await fetchSeriesInfo(kalshi, s); got++; } catch (e) { errors.push(`series ${s}: ${errorText(e)}`); }
  });
  if (path && got) await writeJson(path, { fetchedAt: cached?.fetchedAt ?? fetchedAt, data });
  return { fetchedAt: cached?.fetchedAt ?? fetchedAt, errors, data, cached: false, requests: missing.length };
}

/** Upcoming games from the ESPN boards in the snapshot window, in the minimal Game shape the prop fetchers need. */
export function targetGames(scoreboards, now) {
  const out = [];
  for (const league of LEAGUE_KEYS) {
    for (const ev of parseScoreboardEvents(scoreboards?.[league] || [], league)) {
      if (ev.state !== 'pre' && ev.state !== 'in') continue;
      if (!(ev.kickoffMs >= now - WINDOW.behindMs && ev.kickoffMs <= now + WINDOW.aheadMs)) continue;
      const team = (c) => ({ abbr: c?.team?.abbreviation ?? null, espnId: c?.team?.id != null ? String(c.team.id) : null, kalshiCode: null });
      out.push({ id: `${league}-${ev.id}`, league, espnId: ev.id, kickoff: ev.kickoff, state: ev.state,
        home: team(ev.homeComp), away: team(ev.awayComp), kalshi: { gameEvent: null } });
    }
  }
  return out;
}

const sinceMs = (t) => Date.now() - t;

/**
 * collectInputs({ now, fetchImpl, cacheDir, stateDir, parts, injuryLeagues, pauseMs, kalshiGapMs, log }) -> inputs for buildSnapshot.
 * kalshiGapMs: minimum gap between Kalshi requests (default 250 ms; 0 when pauseMs is 0, for offline tests).
 * parts: { props, teamTotals, injuries, nflverse, cfb } booleans (default all true). injuryLeagues: [] is the old way
 * to turn injuries off. Never throws for upstream failures; each failure is recorded in that source's errors.
 * inputs.stats.bySource[name] = { requests, ms } for the logs.
 */
export async function collectInputs({
  now = Date.now(), fetchImpl = globalThis.fetch, cacheDir = null, stateDir = null, parts = {}, injuryLeagues = ['nfl'],
  pauseMs = undefined, kalshiGapMs = undefined, log = () => {},
} = {}) {
  const pause = pauseMs === undefined ? {} : { pauseMs }; // tests pass 0; the fetchers' own defaults otherwise
  // One pacer for every Kalshi request of the run (core, team totals, props, fees, collections): Kalshi rate-limits
  // /markets across both hosts. Other hosts pass through it untouched.
  const gap = kalshiGapMs ?? (pauseMs === 0 ? 0 : 250);
  fetchImpl = pacedFetch(fetchImpl, { minGapMs: gap, backoffMs: gap ? 1500 : 0 });
  const on = Object.fromEntries(PART_KEYS.map((k) => [k, parts[k] !== false]));
  if (!injuryLeagues.includes('nfl')) on.injuries = false;
  const kHttp = createHttp({ fetchImpl, retries: 0 }); // the fallback host is the retry
  const eHttp = createHttp({ fetchImpl, retries: 1 });
  const iHttp = createHttp({ fetchImpl, retries: 1 });
  const kalshi = createKalshiClient({ http: kHttp });
  // close_time = kickoff + 48 h, so the 9 day kickoff window needs close <= now + 11 d; one more day of slack.
  const maxCloseTs = Math.floor((now + 12 * DAY) / 1000);
  const bySource = {};
  const timed = async (name, fn) => {
    const t = Date.now();
    try { return await fn(); } finally { (bySource[name] ||= { requests: 0, ms: 0 }).ms = sinceMs(t); }
  };
  const count = (name, n) => { (bySource[name] ||= { requests: 0, ms: 0 }).requests += n || 0; };

  // ---- ESPN scoreboards (everything else keys off these games)
  const espnBoards = timed('espn', async () => {
    const fetchedAt = iso(Date.now());
    const scoreboards = {};
    const errors = [];
    for (const league of LEAGUE_KEYS) {
      const r = await fetchScoreboards(eHttp, league);
      scoreboards[league] = r.boards;
      errors.push(...r.errors);
    }
    count('espn', eHttp.stats.requests);
    return { fetchedAt, requests: eHttp.stats.requests, errors, scoreboards };
  });

  // ---- Kalshi chain
  const kalshiChain = (async () => {
    const core = await timed('kalshi', async () => {
      const fetchedAt = iso(Date.now());
      const markets = {};
      const errors = [];
      await mapLimit(CORE_SERIES_LIST, 2, async (s) => {
        try { markets[s] = await fetchSeriesMarkets(kalshi, s, { maxCloseTs }); } catch (e) { errors.push(`${s}: ${errorText(e)}`); }
      });
      return { fetchedAt, requests: kHttp.stats.requests, errors, markets };
    });
    count('kalshi', core.requests);

    const espn = await espnBoards;
    const games = targetGames(espn.scoreboards, now);

    let teamTotals = null;
    if (on.teamTotals) {
      teamTotals = await timed('teamTotals', () => fetchTeamTotalInputs({ games, fetchImpl, now, log, ...pause }));
      count('teamTotals', teamTotals.requests);
    }
    let props = null;
    if (on.props) {
      props = await timed('props', () => fetchPropInputs({ games, fetchImpl, now, log, ...pause }));
      count('props', props.requests);
    }

    const before = kHttp.stats.requests;
    const wantSeries = [...CORE_SERIES_LIST, ...(on.props ? PROP_SERIES_LIST : []), ...(on.teamTotals ? TEAM_TOTAL_SERIES_LIST : [])];
    const series = await timed('fees', () => seriesInfo(kalshi, { now, cacheDir, series: wantSeries, log }));
    count('fees', kHttp.stats.requests - before);

    const before2 = kHttp.stats.requests;
    const combos = await timed('combos', async () => {
      const fetchedAt = iso(Date.now());
      try { return { fetchedAt, errors: [], collections: await fetchOpenCollections(kalshi) }; } catch (e) { return { fetchedAt, errors: [`collections: ${errorText(e)}`], collections: [] }; }
    });
    count('combos', kHttp.stats.requests - before2);
    return { kalshi: core, series, combos, props, teamTotals };
  })();

  // ---- ESPN site chain: injuries feed (summaries only when the feed fails), then the CFB check
  const espnChain = (async () => {
    const espn = await espnBoards;
    let injuryFeed = null;
    let injuries = null;
    if (on.injuries) {
      injuryFeed = await timed('injuries', () => fetchInjuryInputs({ fetchImpl, now, cacheDir, log, ...pause, ...(pauseMs === 0 ? { retryDelayMs: 0 } : {}) }));
      count('injuries', injuryFeed.requests);
      if (!injuryFeed.league) {
        // Fallback: game summaries list up to 5 injuries per team (1 request per game in the window).
        injuries = await timed('summaries', async () => {
          const iFetchedAt = iso(Date.now());
          const targets = parseScoreboardEvents(espn.scoreboards.nfl || [], 'nfl')
            .filter((ev) => (ev.state === 'pre' || ev.state === 'in') && ev.kickoffMs >= now - WINDOW.behindMs && ev.kickoffMs <= now + WINDOW.aheadMs);
          const summaries = {};
          const iErrors = [];
          await mapLimit(targets, 4, async (ev) => {
            try {
              const j = await iHttp.getJson(summaryUrl(ev.league, ev.id));
              summaries[ev.id] = { injuries: Array.isArray(j?.injuries) ? j.injuries : [] }; // keep only what the builder reads
            } catch (e) { iErrors.push(`summary ${ev.league} ${ev.id}: ${errorText(e)}`); }
          });
          return { fetchedAt: iFetchedAt, requests: iHttp.stats.requests, errors: iErrors, leagues: ['nfl'], summaries };
        });
        count('summaries', injuries.requests);
      }
    }
    let cfb = null;
    if (on.cfb) {
      cfb = await timed('cfb', () => fetchCfbInputs({ fetchImpl, now, cacheDir, log, ...pause, ...(pauseMs === 0 ? { retryDelayMs: 0 } : {}) }));
      count('cfb', cfb.requests);
    }
    return { injuryFeed, injuries, cfb };
  })();

  // ---- GitHub: nflverse
  const nvChain = on.nflverse
    ? timed('nflverse', () => fetchNflverseInputs({ fetchImpl, now, cacheDir, checkPath: stateDir ? join(stateDir, 'nflverse-checks.json') : null, log, ...pause }))
      .then((r) => { count('nflverse', r.requests); return r; })
    : Promise.resolve(null);

  const [k, e, s, nflverse] = await Promise.all([kalshiChain, espnChain, espnBoards, nvChain]);
  // 429 retries happen below the per-client counters: list them as their own line so totals stay exact.
  if (fetchImpl.stats.retried429) bySource.kalshi429 = { requests: fetchImpl.stats.retried429, ms: 0 };
  k.kalshi.requests = kHttp.stats.requests; // core series + fee lookups + collections (props and team totals count their own)
  const sum = (...names) => names.reduce((a, n) => a + (bySource[n]?.requests || 0), 0);
  return {
    kalshi: k.kalshi,
    series: k.series,
    combos: k.combos,
    espn: s,
    ...(e.injuries ? { injuries: e.injuries } : {}),
    ...(e.injuryFeed ? { injuryFeed: e.injuryFeed } : {}),
    ...(k.props ? { props: k.props } : {}),
    ...(k.teamTotals ? { teamTotals: k.teamTotals } : {}),
    ...(nflverse ? { nflverse } : {}),
    ...(e.cfb ? { cfb: e.cfb } : {}),
    stats: {
      kalshiRequests: kHttp.stats.requests + (k.props?.stats?.kalshiRequests || 0) + (k.teamTotals?.requests || 0) + fetchImpl.stats.retried429,
      kalshiRetried429: fetchImpl.stats.retried429,
      espnRequests: eHttp.stats.requests + iHttp.stats.requests + (e.injuryFeed?.requests || 0) + (k.props?.stats?.espnRequests || 0),
      totalRequests: sum(...Object.keys(bySource)),
      kalshiBytes: kHttp.stats.bytes,
      espnBytes: eHttp.stats.bytes + iHttp.stats.bytes,
      kalshiHost: kalshi.hostUsed(),
      bySource,
    },
  };
}
