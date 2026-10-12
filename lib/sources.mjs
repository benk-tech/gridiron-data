// All network fetching for one collector run. Produces the `inputs` object that lib/build.mjs turns into a snapshot.
// Kalshi and ESPN are fetched concurrently (different hosts); each host sees at most 2 to 4 requests in flight.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createHttp, mapLimit, errorText } from './http.mjs';
import {
  CORE_SERIES_LIST, createKalshiClient, fetchSeriesMarkets, fetchSeriesInfo, fetchOpenCollections,
} from './kalshi.mjs';
import { fetchScoreboards, parseScoreboardEvents, summaryUrl, iso } from './espn.mjs';
import { WINDOW, LEAGUE_KEYS } from './build.mjs';

const DAY = 86400e3;

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; }
}

async function writeJson(path, data) {
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(data));
  } catch { /* cache is best effort */ }
}

/** Daily data (fees) cached on disk by UTC date; the Actions workflow persists the folder with actions/cache. */
async function seriesInfo(kalshi, { now, cacheDir, log }) {
  const day = new Date(now).toISOString().slice(0, 10);
  const path = cacheDir ? join(cacheDir, `kalshi-series-${day}.json`) : null;
  if (path) {
    const cached = await readJson(path);
    if (cached?.data && CORE_SERIES_LIST.every((s) => cached.data[s])) {
      log(`fees: using cache ${day}`);
      return { fetchedAt: cached.fetchedAt ?? null, errors: [], data: cached.data, cached: true };
    }
  }
  const fetchedAt = iso(Date.now());
  const data = {};
  const errors = [];
  await mapLimit(CORE_SERIES_LIST, 2, async (s) => {
    try { data[s] = await fetchSeriesInfo(kalshi, s); } catch (e) { errors.push(`series ${s}: ${errorText(e)}`); }
  });
  if (path && !errors.length) await writeJson(path, { fetchedAt, data });
  return { fetchedAt, errors, data };
}

/**
 * collectInputs({ now, fetchImpl, cacheDir, injuryLeagues, log }) -> inputs for buildSnapshot.
 * Never throws for upstream failures; each failure is recorded in that source's errors.
 */
export async function collectInputs({ now = Date.now(), fetchImpl = globalThis.fetch, cacheDir = null, injuryLeagues = ['nfl'], log = () => {} } = {}) {
  const kHttp = createHttp({ fetchImpl, retries: 0 }); // the fallback host is the retry
  const eHttp = createHttp({ fetchImpl, retries: 1 });
  const iHttp = createHttp({ fetchImpl, retries: 1 });
  const kalshi = createKalshiClient({ http: kHttp });
  // close_time = kickoff + 48 h, so the 9 day kickoff window needs close <= now + 11 d; one more day of slack.
  const maxCloseTs = Math.floor((now + 12 * DAY) / 1000);

  const kalshiPart = (async () => {
    const fetchedAt = iso(Date.now());
    const markets = {};
    const errors = [];
    await mapLimit(CORE_SERIES_LIST, 2, async (s) => {
      try { markets[s] = await fetchSeriesMarkets(kalshi, s, { maxCloseTs }); } catch (e) { errors.push(`${s}: ${errorText(e)}`); }
    });
    const series = await seriesInfo(kalshi, { now, cacheDir, log });
    let combos;
    const cFetchedAt = iso(Date.now());
    try { combos = { fetchedAt: cFetchedAt, errors: [], collections: await fetchOpenCollections(kalshi) }; } catch (e) { combos = { fetchedAt: cFetchedAt, errors: [`collections: ${errorText(e)}`], collections: [] }; }
    return { kalshi: { fetchedAt, requests: 0, errors, markets }, series, combos };
  })();

  const espnPart = (async () => {
    const fetchedAt = iso(Date.now());
    const scoreboards = {};
    const errors = [];
    for (const league of LEAGUE_KEYS) {
      const r = await fetchScoreboards(eHttp, league);
      scoreboards[league] = r.boards;
      errors.push(...r.errors);
    }
    const espn = { fetchedAt, requests: eHttp.stats.requests, errors, scoreboards };

    // Injuries from game summaries (1 request per game), only for leagues asked for and games inside the window.
    let injuries = null;
    if (injuryLeagues.length) {
      const iFetchedAt = iso(Date.now());
      const targets = [];
      for (const league of injuryLeagues) {
        for (const ev of parseScoreboardEvents(scoreboards[league] || [], league)) {
          if ((ev.state === 'pre' || ev.state === 'in') && ev.kickoffMs >= now - WINDOW.behindMs && ev.kickoffMs <= now + WINDOW.aheadMs) targets.push(ev);
        }
      }
      const summaries = {};
      const iErrors = [];
      await mapLimit(targets, 4, async (ev) => {
        try {
          const j = await iHttp.getJson(summaryUrl(ev.league, ev.id));
          summaries[ev.id] = { injuries: Array.isArray(j?.injuries) ? j.injuries : [] }; // keep only what the builder reads
        } catch (e) { iErrors.push(`summary ${ev.league} ${ev.id}: ${errorText(e)}`); }
      });
      injuries = { fetchedAt: iFetchedAt, requests: iHttp.stats.requests, errors: iErrors, leagues: [...injuryLeagues], summaries };
    }
    return { espn, injuries };
  })();

  const [k, e] = await Promise.all([kalshiPart, espnPart]);
  k.kalshi.requests = kHttp.stats.requests;
  return {
    kalshi: k.kalshi,
    series: k.series,
    combos: k.combos,
    espn: e.espn,
    ...(e.injuries ? { injuries: e.injuries } : {}),
    stats: { kalshiRequests: kHttp.stats.requests, espnRequests: eHttp.stats.requests + iHttp.stats.requests, kalshiBytes: kHttp.stats.bytes, espnBytes: eHttp.stats.bytes + iHttp.stats.bytes, kalshiHost: kalshi.hostUsed() },
  };
}
