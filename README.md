# gridiron-data

Scheduled collector for public NFL and college football market and odds data.

It reads public, unauthenticated endpoints only:

- Kalshi trade API (`/markets`, `/series/{ticker}`, `/multivariate_event_collections`) for the NFL and FBS game, spread, total and team-total markets, plus the NFL player-prop ladders (15 series).
- ESPN site API scoreboards (DraftKings lines, current and opening), the NFL league injuries feed and team depth charts, and game summaries (only as a fallback when the injuries feed fails, and for the weekly college QB check).
- ESPN core API DraftKings prop lines (`propBets`) for NFL games kicking off within 48 hours.
- nflverse release files (play by play, weekly player stats, weekly rosters, PFR defensive stats) and the sportsdataverse college defense file, plus ESPN college team stats.
- Pinnacle's public guest odds feed (`guest.api.arcadia.pinnacle.com/0.1/leagues/{889,880}/matchups` and `/markets/straight`, no key) as a second price source for the game lines. It is unofficial and undocumented, so it is optional: any failure leaves it out of the snapshot and nothing else changes.
- Kalshi trades before kickoff (`/markets/trades`) for the tracked picks the site asks about, to report the kickoff close.

Each run turns those responses into one compact JSON snapshot (format v1), gzips it, and sends it to a private site with a signed request. Nothing in this repository computes picks or prices.

## Usage

Node 22 or newer, no dependencies.

```
node collect.mjs --out snapshot.json                                  # fetch, build, write the snapshot
node collect.mjs --post --settle --cache-dir cache --state-dir state  # what the scheduled workflow runs
npm test                                                              # offline tests (node --test test/*.test.mjs)
```

The offline tests run in `.github/workflows/test.yml` on every push and pull request. The scheduled `collect.yml` does not run them, so a failing test can never stop the collector from posting.

Options:

| Option | Meaning |
|---|---|
| `--cache-dir DIR` | daily data: fee info, nflverse files, depth charts (6 hours), college stats; default `.cache`, `''` for none |
| `--state-dir DIR` | run-to-run state: `history.json` (DraftKings lines of the last 48 hours, for line moves), `closes/` (closing lines waiting for their day to end), nflverse check stamps, `pinnacle.json` (the last Pinnacle pull, reused for 15 minutes), `clv-closes.json` (Kalshi kickoff closes waiting for their market to settle). Without it every run is a first run. |
| `--closes-dir DIR` | where finished days of closing lines are copied (default `closes/` here) |
| `--skip LIST` | skip optional parts: `props`, `teamTotals`, `injuries`, `nflverse`, `cfb`, `pinnacle` (`--skip-injuries` also works) |
| `--kalshi-gap-ms N` | minimum gap between Kalshi requests, default 250 (Kalshi answers HTTP 429 to bursts on `/markets`) |
| `--save-inputs FILE.json.gz` | keep the raw fetched inputs; `node scripts/build-fixture.mjs FILE.json.gz out.json` rebuilds the same snapshot offline |
| `--now ISO` | run as if the clock read this time (game window, `generatedAt`, line history, closes); for tests and fixture rebuilds. Request signatures and time budgets always use the real clock. |
| `--quiet` | no log lines |

`--post` and `--settle` read `INGEST_URL` and `INGEST_KEY` from the environment (GitHub repository secrets). Neither value is ever printed.

Exit code is 1 when nothing usable came back, when the POST to the site fails, or on bad usage. Nothing usable means the Kalshi core series and the ESPN scoreboards both failed, or the run found no games at all while the previous run (`state/history.json`, at most 6 hours old) listed 10 or more upcoming games, which is what an ESPN outage that answers HTTP 200 with empty lists looks like. Then no snapshot is sent, the last good one stays up, and the run-to-run state is not saved. After 6 hours the empty snapshot is posted, with ESPN marked down. A partial failure of one source is recorded in `snapshot.sources.<name>.errors` and the run still succeeds.

A source is also marked down (`ok: false`, with the reason in its errors) when its data arrived but cannot be right: ESPN scoreboard events that cannot be read, a current regular season or postseason week with no games, at least 5 games (and half) of the previous run's upcoming games missing, Kalshi markets or prop rungs with no price at all, no Kalshi game matching any ESPN game, or an injuries feed with nobody on it while NFL games are in the window. The site shows those sources as down instead of an empty slate.

Every run has time budgets, so a host that accepts a connection and then stalls cannot hold the job past its 4 minute timeout: 100 seconds for all fetching, plus a shorter budget for each optional part (Pinnacle 25 s, team totals 30 s, injuries 45 s, props and college data 60 s, nflverse 75 s), all counted from the start of the run, and 30 seconds for the settle handshake. A spent budget stops that part's open requests, sends no new ones, and records `<part> time budget (N s) spent` in its errors; the snapshot is then built and posted with whatever arrived. DraftKings prop line requests use a 10 second timeout and no retry.

A normal 5 minute run sends about 35 requests: Kalshi core, team totals and props (about 25, paced), ESPN scoreboards (4), the injuries feed (1) and DraftKings prop lines (2 per NFL game inside 48 hours). Every third run or so also pulls Pinnacle (4 requests, at most once per 15 minutes, since its CDN caches for 905 seconds anyway), and the settle step looks up at most 40 Kalshi kickoff closes per run (about 20 to 60 a week in all). Fee info, depth charts, nflverse and college data come from the cache; nflverse is checked with a HEAD request at most every 30 minutes and downloaded only when its ETag changes. A file that is missing upstream and has no cached copy (the new season's nflverse files from the March 1 rollover until September, or the new college season's file before late August) is asked for again only after 6 hours (30 minutes or 1 hour after other errors), with one HEAD request and no download; until then the source keeps reporting the error.

## Layout

```
collect.mjs          CLI entry
lib/http.mjs         fetch with timeout, retry, request counting, Kalshi pacing
lib/kalshi.mjs       paginated market fetch with host fallback, trimming, team and strike resolution
lib/espn.mjs         scoreboards (current week and next week), odds parsing, injuries from game summaries
lib/match.mjs        Kalshi to ESPN game matcher (Eastern calendar date +/- 1 day, team names and code aliases)
lib/glue.mjs         one team code map (nflverse, ESPN, Kalshi), Kalshi game code, name key, ID bridge
lib/props.mjs        Kalshi prop ladders joined to ESPN players and DraftKings prop lines
lib/teamtotals.mjs   Kalshi team-total markets and DraftKings team totals
lib/injuries.mjs     NFL injuries graded per game from the league feed and depth charts, injury angles
lib/nflverse.mjs     NFL defense ratings (run, pass, front, secondary) and player stats from nflverse
lib/cfb.mjs          college defense ratings and the weekly college QB check
lib/csv.mjs          quote-aware CSV parser
lib/moves.mjs        line history and line moves between runs
lib/pinnacle.mjs     Pinnacle guest feed: pull every 15 minutes, trim, match to ESPN games, refs.pinnacle
lib/clv.mjs          Kalshi kickoff close (VWAP of the last 200 pregame trades) for the settle handshake
lib/closes.mjs       closing lines archive (state/closes, then closes/ once a day is over)
lib/build.mjs        pure buildSnapshot(inputs, { now }) / buildRun used by the CLI and the tests
lib/sources.mjs      all network fetching for one run
lib/schema.mjs       snapshot shape checks
lib/ingest.mjs       gzip, sha256, HMAC signature, POST, pending/settle handshake (with kickoff closes)
closes/              closing DraftKings lines by Eastern date (written by the workflow)
scripts/             fixture tools (trim saved captures, build a snapshot from a raw capture folder)
test/                node --test, offline fixtures only (no test touches the network)
```

## Request signing

Every request to the site carries:

```
ts   = unix seconds (string)
hash = hex(sha256(body bytes))          the exact bytes sent; empty body for GET
sig  = hex(HMAC-SHA256(key, method + "\n" + path + "\n" + ts + "\n" + hash))
X-GP-Timestamp: ts
X-GP-Signature: sig
```

The HMAC key is the UTF-8 bytes of the `INGEST_KEY` string exactly as stored; the base64url text is not decoded first. `path` is the URL path without a query string, for example `/api/ingest`. The snapshot body is the gzip bytes with `Content-Type: application/octet-stream` and no `Content-Encoding` header. The snapshot POST also sends `X-GP-Generated: <snapshot.generatedAt>`, unsigned, so the site never has to parse the body; the site accepts it only within 15 minutes before to 1 minute after the signed timestamp and otherwise records the post time.

## Data notes

- Kalshi prices and sizes arrive as decimal strings and are converted to numbers. The size available to buy NO is the YES bid size.
- Spread, total and team-total ladders are joined to the game by the teams part of the event ticker within one day, because college date codes often differ by a day between series.
- Spread market teams come from the team id on the market, checked against the ticker suffix; a disagreement drops the market and is logged.
- Kickoff times come from ESPN. Kalshi college kickoffs are often placeholders.
- ESPN "close" odds are the current line, not a closing line. The closing line archive records the last pregame line the collector saw before ESPN marked the game as started.
- DraftKings prop lines come without prices. ESPN's `lastUpdated` on them runs about 3 hours fast, so line moves use the collector's own clock.
- The DraftKings team total line is read as the middle of DraftKings' alternate team-total ladder and kept only when it is within 2 points of the total and spread's implied value.
- College team labels use the school name (`shortName` is ESPN's `location`, for example "Western Kentucky").
- The snapshot holds no ages relative to the run time; the same inputs always build the same snapshot.

## Pinnacle prices (`games[i].refs.pinnacle`)

Pulled at most once per 15 minutes (`state/pinnacle.json` keeps the last pull, failed or not, and runs in between reuse it). Pinnacle games are matched to ESPN games with the same matcher as Kalshi (Eastern date within a day, both teams), after a small name table for the schools Pinnacle names differently (Miami Florida, Mississippi, UL Lafayette, Sam Houston State, Hawaii, Miami Ohio, Middle Tennessee State), and only on a match score of 0.9 or more. Pinnacle games in the window that matched nothing are listed in `unmatched.pinnacle`. Only pregame games get a block, always in ESPN's home and away order:

```js
refs: { pinnacle: {
  fetchedAt, lastModified,      // when the collector pulled the league; the CDN's Last-Modified of the prices (ISO)
  offBoard,                     // true: Pinnacle lists the game without an open full game price (taken off the board)
  odds: { ml: { home, away }, spread: { home, homeOdds, awayOdds }, total: { line, overOdds, underOdds } },   // American odds, null when absent
  alts: [{ type: 'spread' | 'total', points, a, b }],   // alternate lines within 10 points of the main line
                                                        // spread: points = home line, a = home, b = away; total: a = over, b = under
  periods: { h1, q1 },          // NFL only, when priced: first half and first quarter, each { ml, spread, total, alts }
} }
```

`sources.pinnacle` = `{ ok, fetchedAt, cached, requests, matched, matchedByLeague, errors }` (`matched` counts games with a block, off the board included). A failed league, a block (HTTP 403), a format change or a crash in the builder leaves the blocks out and sets `ok: false`; the rest of the snapshot is built exactly as without Pinnacle.

## Kickoff closes (settle handshake)

The site's pending list may hold `{ ticker, kickoff }` objects as well as plain ticker strings. For each listed ticker whose kickoff has passed, the settle step asks Kalshi for `/markets/trades?ticker=T&max_ts=<kickoff>&limit=200` (paced with the run's other Kalshi requests) and posts the count-weighted average yes price of those last 200 pregame trades as `closeYes` (dollars) next to `result`. At most 40 lookups per run, settled markets first; a close is kept in `state/clv-closes.json` once known, and a settled result whose close is still missing is not posted yet, so it comes back on a later run. A market with no pregame trades, a lookup Kalshi refuses (400 or 404), three failed lookups, or a kickoff more than 12 hours ago sends the result with `closeYes: null` instead of waiting longer. Plain ticker strings settle exactly as before, without `closeYes`.
