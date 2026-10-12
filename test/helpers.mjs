// Fixture loaders shared by the tests (offline only).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
export const rd = (...p) => JSON.parse(readFileSync(join(FIX, ...p), 'utf8'));
export const CORE = ['KXNFLGAME', 'KXNFLSPREAD', 'KXNFLTOTAL', 'KXNCAAFGAME', 'KXNCAAFSPREAD', 'KXNCAAFTOTAL'];

// The 2026-10-11 ~22:51Z research capture: NFL week 6 + CFB week 7 (groups=80) and all open core markets.
export const RESEARCH_NOW = '2026-10-11T22:51:00Z';
export function researchInputs({ withSeries = true, withCombos = true } = {}) {
  const markets = {};
  for (const s of CORE) markets[s] = rd('research-20261011', `kalshi_${s}.json`).markets;
  const t = RESEARCH_NOW;
  return {
    kalshi: { fetchedAt: t, requests: 7, errors: [], markets },
    ...(withSeries ? { series: { fetchedAt: t, errors: [], data: rd('research-20261011', 'series.json') } } : {}),
    ...(withCombos ? { combos: { fetchedAt: t, errors: [], collections: rd('research-20261011', 'collections.json') } } : {}),
    espn: { fetchedAt: t, errors: [], scoreboards: { nfl: [rd('research-20261011', 'espn_nfl_w6.json')], cfb: [rd('research-20261011', 'espn_cfb_w7.json')] } },
  };
}

// BAL@ATL capture at 2026-10-11T23:49Z (trimmed copy of gridiron-picks/test/fixtures/raw-20261011-balatl).
export const BALATL_NOW = readFileSync(join(FIX, 'balatl-20261011', 'fetched_at.txt'), 'utf8').trim();
export function balatlInputs() {
  const markets = {};
  for (const s of ['KXNFLGAME', 'KXNFLSPREAD', 'KXNFLTOTAL']) markets[s] = rd('balatl-20261011', `kalshi_${s}.json`).markets;
  const t = BALATL_NOW;
  return {
    kalshi: { fetchedAt: t, requests: 3, errors: [], markets: { ...markets, KXNCAAFGAME: [], KXNCAAFSPREAD: [], KXNCAAFTOTAL: [] } },
    espn: { fetchedAt: t, errors: [], scoreboards: { nfl: [rd('balatl-20261011', 'espn_scoreboard.json')], cfb: [] } },
    injuries: { fetchedAt: t, errors: [], leagues: ['nfl'], summaries: { 401872993: rd('balatl-20261011', 'espn_summary.json') } },
  };
}
