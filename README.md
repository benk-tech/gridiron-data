# gridiron-data

Scheduled collector for public NFL and college football market and odds data.

It reads public, unauthenticated endpoints only:

- Kalshi trade API (`/markets`, `/series/{ticker}`, `/multivariate_event_collections`) for the NFL and FBS game, spread and total markets.
- ESPN site API scoreboards (DraftKings lines, current and opening) and game summaries (injury reports).

Each run turns those responses into one compact JSON snapshot (format v1), gzips it, and sends it to a private site with a signed request. Nothing in this repository computes picks or prices.

## Usage

Node 22 or newer, no dependencies.

```
node collect.mjs --out snapshot.json      # fetch, build, write the snapshot
node collect.mjs --post --settle          # what the scheduled workflow runs
npm test                                  # offline tests (node --test test/*.test.mjs)
```

Options: `--cache-dir DIR` (daily cache for fee data, default `.cache`), `--skip-injuries`, `--quiet`.

`--post` and `--settle` read `INGEST_URL` and `INGEST_KEY` from the environment (GitHub repository secrets). Neither value is ever printed.

Exit code is 1 only when the Kalshi core series and the ESPN scoreboards both fail (no snapshot is sent), when the POST to the site fails, or on bad usage. A partial failure of one source is recorded in `snapshot.sources.<name>.errors` and the run still succeeds.

## Layout

```
collect.mjs        CLI entry
lib/http.mjs       fetch with timeout, retry, request counting
lib/kalshi.mjs     paginated market fetch with host fallback, trimming, team and strike resolution
lib/espn.mjs       scoreboards (current week and next week), odds parsing, injuries from game summaries
lib/match.mjs      Kalshi to ESPN game matcher (Eastern calendar date +/- 1 day, team names and code aliases)
lib/build.mjs      pure buildSnapshot(inputs, { now }) used by the CLI and the tests
lib/sources.mjs    all network fetching for one run
lib/schema.mjs     snapshot shape checks
lib/ingest.mjs     gzip, sha256, HMAC signature, POST, pending/settle handshake
scripts/           fixture tools (trim saved captures, build a snapshot from a raw capture folder)
test/              node --test, offline fixtures only
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

The HMAC key is the UTF-8 bytes of the `INGEST_KEY` string exactly as stored; the base64url text is not decoded first. `path` is the URL path without a query string, for example `/api/ingest`. The snapshot body is the gzip bytes with `Content-Type: application/octet-stream` and no `Content-Encoding` header.

## Data notes

- Kalshi prices and sizes arrive as decimal strings and are converted to numbers. The size available to buy NO is the YES bid size.
- Spread and total ladders are joined to the game by the teams part of the event ticker within one day, because college date codes often differ by a day between series.
- Spread market teams come from the team id on the market, checked against the ticker suffix; a disagreement drops the market and is logged.
- Kickoff times come from ESPN. Kalshi college kickoffs are often placeholders.
- ESPN "close" odds are the current line, not a closing line.
