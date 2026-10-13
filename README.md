# gridiron-data

Scheduled collector for public NFL and college football market and odds data.

It reads public, unauthenticated endpoints only:

- Kalshi trade API (`/markets`, `/series/{ticker}`, `/multivariate_event_collections`) for the NFL and FBS game, spread, total and team-total markets, plus the NFL player-prop ladders (15 series).
- ESPN site API scoreboards (DraftKings lines, current and opening), the NFL league injuries feed and team depth charts, and game summaries (only as a fallback when the injuries feed fails, and for the weekly college QB check).
- ESPN core API DraftKings prop lines (`propBets`) for NFL games kicking off within 48 hours.
- nflverse release files (play by play, weekly player stats, weekly rosters, PFR defensive stats) and the sportsdataverse college defense file, plus ESPN college team stats.
- Pinnacle's public guest odds feed (`guest.api.arcadia.pinnacle.com/0.1/leagues/{889,880}/matchups` and `/markets/straight`, no key) as a second price source for the game lines. It is unofficial and undocumented, so it is optional: any failure leaves it out of the snapshot and nothing else changes.
- Reference quotes from three other exchanges for the same game lines, no key: the Polymarket US public gateway (`gateway.polymarket.us/v2/leagues/{nfl,cfb}/events`), Gemini Predictions (`api.gemini.com/v1/prediction-markets/events`) and SX Bet (`api.sx.bet/markets/active` and `/orderbook-v3/snapshot`, an offshore exchange, NFL moneylines only). Only Kalshi is ever bet; these are reference prices (votes) for the site. Each is optional: a failure leaves that venue out and nothing else changes.
- Kalshi trades before kickoff (`/markets/trades`) for the tracked picks the site asks about, to report the kickoff close.
- For the site's power ratings, line free data only: the nflverse schedule and results file (`nfldata/data/games.csv`) and four sportsdataverse college files (`cfb_schedules`, `espn_cfb_team_box`, `espn_cfb_adv_team_gamelog`, `cfb_paper_index_games`), plus the nflverse play by play already listed above. See "Rating inputs" below.

Each run turns those responses into one compact JSON snapshot (format v1), gzips it, and sends it to a private site with a signed request. Nothing in this repository computes picks, prices or ratings, and it holds no fitted model weights.

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
| `--cache-dir DIR` | daily data: fee info, nflverse files, depth charts (6 hours), college stats, the rating input reductions (`ratinginputs/`); default `.cache`, `''` for none |
| `--state-dir DIR` | run-to-run state: `history.json` (DraftKings lines and Kalshi implied centers of the last 48 hours, for line moves), `closes/` (closing lines waiting for their day to end), nflverse and rating input check stamps, `pinnacle.json`, `gemini.json` and `sx.json` (the last pull of each, reused for 15 minutes), `clv-closes.json` (Kalshi kickoff closes waiting for their market to settle). Without it every run is a first run. |
| `--closes-dir DIR` | where finished days of closing lines are copied (default `closes/` here) |
| `--skip LIST` | skip optional parts: `props`, `teamTotals`, `injuries`, `nflverse`, `cfb`, `pinnacle`, `polyus`, `gemini`, `sx`, `ratinginputs` (`--skip-injuries` also works) |
| `--kalshi-gap-ms N` | minimum gap between Kalshi requests, default 250 (Kalshi answers HTTP 429 to bursts on `/markets`) |
| `--save-inputs FILE.json.gz` | keep the raw fetched inputs; `node scripts/build-fixture.mjs FILE.json.gz out.json` rebuilds the same snapshot offline |
| `--now ISO` | run as if the clock read this time (game window, `generatedAt`, line history, closes); for tests and fixture rebuilds. Request signatures and time budgets always use the real clock. |
| `--quiet` | no log lines |

`--post` and `--settle` read `INGEST_URL` and `INGEST_KEY` from the environment (GitHub repository secrets). Neither value is ever printed.

Exit code is 1 when nothing usable came back, when the POST to the site fails, or on bad usage. Nothing usable means the Kalshi core series and the ESPN scoreboards both failed, or the run found no games at all while the previous run (`state/history.json`, at most 6 hours old) listed 10 or more upcoming games, which is what an ESPN outage that answers HTTP 200 with empty lists looks like. Then no snapshot is sent, the last good one stays up, and the run-to-run state is not saved. After 6 hours the empty snapshot is posted, with ESPN marked down. A partial failure of one source is recorded in `snapshot.sources.<name>.errors` and the run still succeeds.

A source is also marked down (`ok: false`, with the reason in its errors) when its data arrived but cannot be right: ESPN scoreboard events that cannot be read, a current regular season or postseason week with no games, at least 5 games (and half) of the previous run's upcoming games missing, Kalshi markets or prop rungs with no price at all, no Kalshi game matching any ESPN game, or an injuries feed with nobody on it while NFL games are in the window. The site shows those sources as down instead of an empty slate.

Every run has time budgets, so a host that accepts a connection and then stalls cannot hold the job past its 4 minute timeout: 100 seconds for all fetching, plus a shorter budget for each optional part (Pinnacle 25 s, Gemini and SX Bet 30 s each, team totals 30 s, Polymarket US 40 s, injuries 45 s, props, college data and rating inputs 60 s, nflverse 75 s), all counted from the start of the run, and 30 seconds for the settle handshake. A spent budget stops that part's open requests, sends no new ones, and records `<part> time budget (N s) spent` in its errors; the snapshot is then built and posted with whatever arrived. DraftKings prop line requests use a 10 second timeout and no retry.

A normal 5 minute run sends about 35 requests: Kalshi core, team totals and props (about 25, paced), ESPN scoreboards (4), the injuries feed (1) and DraftKings prop lines (2 per NFL game inside 48 hours). Polymarket US adds 4 requests every run (one page at a time; about 1.7 MB compressed, 65 MB of JSON, parsed page by page). Every third run or so also pulls Pinnacle (4 requests, at most once per 15 minutes, since its CDN caches for 905 seconds anyway), Gemini (1 request, about 7 MB) and SX Bet (1 list request plus about 15 book requests, 2 at a time), and the settle step looks up at most 40 Kalshi kickoff closes per run (about 20 to 60 a week in all). Fee info, depth charts, nflverse and college data come from the cache; nflverse is checked with a HEAD request at most every 30 minutes and downloaded only when its ETag changes; the rating inputs add a HEAD for games.csv at most every 30 minutes and one for each of the four college files at most every 3 hours, each downloaded only on a new ETag. A file that is missing upstream and has no cached copy (the new season's nflverse files from the March 1 rollover until September, or the new college season's file before late August) is asked for again only after 6 hours (30 minutes or 1 hour after other errors), with one HEAD request and no download; until then the source keeps reporting the error.

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
lib/ratinginputs.mjs line free rating inputs (snapshot.ratingInputs): play by play sums, schedules, starters, college box efficiency
lib/csv.mjs          quote-aware CSV parser
lib/moves.mjs        line history (DraftKings lines, Kalshi implied centers, Kalshi's folded book) and moves between runs
lib/pinnacle.mjs     Pinnacle guest feed: pull every 15 minutes, trim, match to ESPN games, refs.pinnacle
lib/venues/          exchange reference venues (refs.venues): common.mjs (quote shape, keys, GET, 15 minute state),
                     polyus.mjs (Polymarket US, every run), gemini.mjs and sxbet.mjs (every 15 minutes), index.mjs
                     (registry, matching to ESPN games, trimming to the Kalshi keys, format checks)
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

## Kalshi line history (`games[i].kalshiMoves`)

Every run also records where Kalshi's own markets put each pregame game, next to the DraftKings lines in `state/history.json`, so the site can see how long Kalshi takes to follow a DraftKings move. It uses only the markets already in the snapshot (no extra requests) and the same method as the site engine (`angles.js kalshiCenters`): a market counts only when it is active and its YES ask minus YES bid is at most 10 cents, and its price is the middle of the two.

- `ml`: the home team's win chance, the middle price of the home GAME market (or 1 minus the away one), 3 decimals. The DraftKings `ml` move is the same number with the vig removed.
- `spread`: the home line where the spread ladder crosses 50% (home rungs at their strike, away rungs flipped), straight line between neighboring rungs, 1 decimal. Negative means the home team is favored, the same sign as `odds.spread.home`.
- `total`: the total where the total ladder crosses 50%, 1 decimal.

Prices in the middle of a quote wiggle from run to run without any trading, so a new point is kept only when the value has moved at least 1 cent (`ml`) or more than a quarter point (`spread`, `total`, so 0.3 or more on the 0.1 grid) from the last kept point. A market that cannot give a value in a run (quote too wide, ladder pulled, no 50% crossing) adds nothing, and the next real change still starts from the last kept value. Nothing is recorded after kickoff. Points older than 48 hours are dropped like the DraftKings lines, keeping the newest older one as the starting point.

```js
kalshiMoves: [{ market: 'ml' | 'spread' | 'total', from, to, at }]   // every game has the array (empty when nothing moved); at = collector time
```

Same shape and order as `games[i].moves` (oldest first, then ml, spread, total). The snapshot carries at most the newest 20 moves per market per game; the history keeps up to 200 points per market. `sources.moves.kalshiGames` counts the games with Kalshi points on record. A history file from before this change loads as is and starts its Kalshi points on the next run.

These centers say when a whole line moved. They do not say that one contract held still: a single ladder rung, or the away team's winner market on its own, can reprice without moving a center, and a first run has an empty list for every game. That is what the previous run's book below is for.

## Kalshi's book on the previous run (`games[i].kalshi.prevQuotes`)

The site calls a Kalshi price a cross market bet only when it held for one run (a price that just changed may be Kalshi reacting to news first). So every run also keeps Kalshi's book for each pregame game in `state/history.json` (`book` and `bookAt` on the game), and the next run puts it on the snapshot:

```js
kalshi: {
  ...,
  prevQuotes: { 'ml:home': { bid, ask }, 'sp:away:3.5': { bid, ask }, 'tot:44.5': { bid, ask } },   // the previous run's book
  prevAt: '2026-10-11T22:51:00Z',                                                               // that run's time
}
```

The book uses the same contract keys as the exchange quotes below and the same fold as the site (`foldKalshiBook`; a test checks it against the site engine on its fixtures): YES of `'ml:home'` is YES on the home winner market or NO on the away one, whichever is cheaper, so ask = min(home YES ask, away NO ask) and bid = 1 - min(home NO ask, away YES ask); a NO ask is `noAsk`, else 1 - `yesBid`; a size of 0 or less is no offer; only active markets; spread and total rungs are their own market (half point strikes only); a key needs both sides. Both fields are there only when the previous run is in the history and is 0 to 60 minutes old, that run recorded this game's book, and the game is still pregame, and only for keys both runs quote. A first run, a lost or expired Actions cache, a history over an hour old, or a game new to the board has no `prevQuotes`, never an empty stand-in. `sources.moves.prevBooks` counts the games that got one. No extra requests; about 15 KB more per gzipped snapshot on a full slate.

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

## Exchange reference quotes (`games[i].refs.venues`)

Only Kalshi is ever bet. Polymarket US, Gemini Predictions and SX Bet are read as reference prices (votes) for the site's cross market check; none of them is a betting target here. Polymarket US is pulled every run; Gemini and SX Bet at most once per 15 minutes (`state/gemini.json`, `state/sx.json` keep the last pull, failed or not, and runs in between reuse it with its original `fetchedAt`). Venue games are matched to ESPN games with the same matcher as Kalshi and Pinnacle (Eastern date within a day, both teams, score 0.9 or more), after a shared name table (Pinnacle's, plus NM State, LA Tech and Hawaii) and, for Gemini, both its full team name and its short label. Only pregame games get a block, always in ESPN's home and away order, and only for the contracts the game's Kalshi markets list (plus the moneyline):

```js
refs: { venues: {
  polyus: { fetchedAt, quotes: { 'ml:home': Quote, 'sp:away:3.5': Quote, 'tot:44.5': Quote, ... } },
  gemini: { fetchedAt, quotes },
  sx:     { fetchedAt, quotes },   // NFL moneyline only
} }
// keys: 'ml:home' = P(home wins); 'sp:home:3.5' / 'sp:away:3.5' = P(that team wins by more than 3.5); 'tot:44.5' = P(over 44.5)
// half point strikes only. Quote = { bid, ask, bidSize, askSize, sizeUnit } for YES of the key (NO is bought at 1 - bid)
// two sided and uncrossed only. Sizes are contracts at the best price (SX Bet: taker stake / price) or null with
// sizeUnit null (the Polymarket US events payload and the Gemini REST snapshot carry prices only).
```

Orientation: the Polymarket US winner market's long side is the away team, and spread rungs are quoted for the long team (a positive line means the long team gets the points, so its YES is NO of the other team winning by more than the line); Gemini's two winner contracts are folded like Kalshi's two winner markets, its spread contracts are assigned to a team by their ticker prefix, and its ladder lines are read from the contract label ("Seattle wins by more than 3.5 points", "More than 44.5 points scored") because the moneyline-only request does not send the structured strike; SX Bet's team one is the home team (the matcher's flip covers any exception). On the 2026-10-12 capture every tight pair against Kalshi on the same contract was within 3 cents (Polymarket US 956 pairs, median 0.25 cents; Gemini 299, median 0; SX Bet 13, median 0.56).

`sources.polyus`, `sources.gemini`, `sources.sx` = `{ ok, fetchedAt, cached, requests, matched, matchedByLeague, errors }`, present only when the venue was fetched (absent with `--skip`). A failed league, a block or a crash in the builder leaves that venue's blocks out and sets `ok: false`; the rest of the snapshot is built exactly as without it. A format change sets `ok: false` too: each fetcher counts what it saw listed (`seen`, per league), and five or more listings with no game read, or five or more games with no quote of a kind the venue always lists (winner, spread and total on Polymarket US and Gemini; winner on SX Bet), is an error such as "nfl: 29 polyus listings seen but none could be read (format change?)". Whatever could still be read is kept. A league where no venue game matched any ESPN game is an error as before.

Request budget for the three venues: Polymarket US about 4 GETs every run (one page at a time); Gemini 1 GET (at most 3 pages) and SX Bet 1 list GET plus about 15 order book GETs (2 at a time), each at most once per 15 minutes; so about 10 requests per run on average and never more than about 24 in one run. A 4xx (a block) is never retried; a network error or a 5xx is retried once. These sources are optional, like Pinnacle: the site must list them in its optional sources so a venue being down never raises the "sources are down" banner. Unmatched venue games (mostly FCS) are logged, not stored.

Every endpoint above was checked from a residential IP; GitHub Actions runner IPs are untested.

## Rating inputs (`snapshot.ratingInputs`)

Raw, line free data reductions for the site's own power ratings. The ratings themselves, their fitted weights, priors and every rule that uses them live only in the private site; this part only reshapes public files. On by default; `--skip ratinginputs` leaves both the field and `sources.ratingInputs` out, and the rest of the snapshot is byte for byte the same.

```js
ratingInputs: {
  v: 1,
  nfl: {
    season, asOf,            // asOf: when the collector built these rows (the later of the pbp reduction and the games.csv download)
    etag, throughWeek,       // the play by play file's ETag; the last week in it
    games: [Game],           // every game of the season from games.csv, played and upcoming, in file order
    teamGames: [{ id, team, pass, rush, plays, drives }],   // per team-game sums: pass/rush = 3 wp buckets x [plays, EPA sum, successes]
    qbGames: [{ id, team, qb, name, b }],                   // per QB per team-game: b = 3 wp buckets x [dropbacks, EPA sum]
    starters: [{ team, qb, name, espnId, source, status, replaced, at }],   // projected starting QB per team (next game)
  },
  cfb: {
    season, asOf, files: { etags: { schedules, teamBox, advGamelog, paperIndex } },
    games: [CfbGame],        // every Division I vs Division I game of the season, in the schedule file's order
    eff: [{ id, ypp: [home, away], plays: [home, away], sr }],   // FBS involved box efficiency, full precision
    effMissing,              // finals with an FBS team and no efficiency row yet
  },
}
Game = { id, season, type, week, date, time, weekday, home, away, hs, as, result, total, neutral, homeRest, awayRest, div,
         roof, surface, temp, wind, homeQb, awayQb, homeQbName, awayQbName, espn, stadium }   // total = points scored
CfbGame = { id, season, week, st, date, neutral, confGame, h, a, hp, ap, done, hDiv, aDiv, hConf, aConf, hName, hAbbr, aName, aAbbr }
```

- **NFL play by play.** The nflverse play by play the collector already downloads is reduced once per ETag (about 0.2 s now, about 1 s by January) and the reduction is cached under that ETag. Kept plays: `play_type` pass or run, not deleted, not a no-play, not a two point try, kneel or spike, EPA present. Plays are bucketed by nflverse `wp`, the win probability WITHOUT the line: bucket 0 for 0.10 to 0.90 (or no wp), bucket 1 out to 0.03 or 0.97, bucket 2 beyond. `vegas_wp` is never read. EPA sums are rounded to 4 decimals. Team codes are nflverse franchise codes (LA, WAS, JAX, LV, LAC).
- **games.csv.** Only the columns listed in `NFL_GAME_COLS` are read; the spread, total and moneyline columns and their odds are skipped by the parser. `roof` stays as nflverse has it (blank for upcoming games at retractable roofs). `homeQb` and `awayQb` are nflverse's starters (the actual one once played).
- **Starters.** The ESPN depth chart QB1 (charts refreshed every 6 hours), or the next QB on the chart when QB1 is listed Out or Doubtful in the league injuries feed (`source: 'depth_injury'`, with the passed over QB in `replaced`). ESPN ids map to nflverse gsis ids through the roster_weekly bridge; `qb` is null when a new QB is not in it yet. Only teams with an unplayed game get a row. Without the injuries part there are no starters.
- **College.** The four sportsdataverse files are HEAD checked every 3 hours and downloaded only on a new ETag. A game is final when the schedule says so; until it does, a final on the ESPN scoreboards the run already reads (FBS boards) fills the score, and a final between two known teams that is missing from the file is added. FCS only finals cannot be filled that way yet (the FBS boards do not list them). An efficiency row exists when any of the three box score files has the game, even with only nulls.
- **Caching.** Only the reductions are cached (`cache/ratinginputs/`), never the raw files; the HEAD stamps and failed-file records live in `state/ratinginputs-checks.json`, so the daily cache changes only when data changes. A file that is missing upstream with nothing cached is asked for again after 6 hours (30 minutes after other errors). A failed HEAD or download keeps the cached copy, with a warning.
- **Line free by construction.** `lib/schema.mjs` reports any field anywhere inside `ratingInputs` named like a line (spread, total line, moneyline, odds, vegas, betting, matchup line), and the tests check the column lists and a games.csv sample whose line columns hold sentinel values.

`sources.ratingInputs` = `{ ok, fetchedAt, requests, nfl: { games, played, teamGames, qbGames, starters, throughWeek }, cfb: { games, finals, eff, effMissing, espnFilled, espnAdded, nonD1 }, warnings, errors }`. `ok` is true only with both leagues and no error. A league whose core file is missing is left out (`nfl` needs games.csv and the play by play reduction, `cfb` the schedule) and the reason is in `errors`; a crash in the builder leaves the whole field out. Size on 2026-10-13: 653 KB raw, 70 KB gzipped (NFL 20 KB, college 51 KB), growing to about 110 to 120 KB gzipped by the end of the season (the size test builds a synthetic full season: 121 KB).

## Kickoff closes (settle handshake)

The site's pending response is `{ tickers: [ticker], items: [{ ticker, kickoff }] }` (the same tickers in the same order); the collector reads `items` when it is there and falls back to `tickers` for an older site (either list may hold plain strings or `{ ticker, kickoff }` objects). For each listed ticker whose kickoff has passed, the settle step asks Kalshi for `/markets/trades?ticker=T&max_ts=<kickoff>&limit=200` (paced with the run's other Kalshi requests) and posts the count-weighted average yes price of those last 200 pregame trades as `closeYes` (dollars) next to `result`. At most 40 lookups per run, settled markets first; a close is kept in `state/clv-closes.json` once known, and a settled result whose close is still missing is not posted yet, so it comes back on a later run. A market with no pregame trades, three failed lookups (any error), or a result held for 12 hours since the collector first saw the ticker listed (since kickoff when there is no state dir) sends the result with `closeYes: null` instead of waiting longer. Plain ticker strings settle exactly as before, without `closeYes`.
