# poly-ledger

Reconstruct a Polymarket proxy wallet's full realized ledger and compute its **convexity distribution** — hit rate, payoff multiples, and expectancy broken down by entry-price bucket.

Built for deep-OTM longshot books: each outcome token is treated as one ticket, cost basis and proceeds are reconstructed from the raw activity feed, and P&amp;L is rolled up into cent-bucket statistics you can audit offline.

## Requirements

- [Node.js](https://nodejs.org/) 18 or later
- No npm dependencies (stdlib only)

## Quick start

```bash
cp .env.example .env
# Edit .env and set WALLET_ADDRESS to your Polymarket proxy wallet (0x + 40 hex chars)

node index.js
# or
npm start
```

You can also pass the wallet on the command line; it overrides `WALLET_ADDRESS` when both are set:

```bash
node index.js 0xYourWalletAddressHere
```

## What it does

1. **Pull** — Fetches the complete activity ledger and current positions from the [Polymarket Data API](https://data-api.polymarket.com).
2. **Resolve** — Looks up market outcomes via the [Gamma API](https://gamma-api.polymarket.com) for tickets that were held to resolution.
3. **Reconstruct** — Collapses raw events (`TRADE`, `REDEEM`, `SPLIT`, `MERGE`, `REWARD`, `CONVERSION`) into one record per outcome token, with VWAP entry, proceeds, realized P&amp;L, and status.
4. **Analyze** — Prints a portfolio rollup and convexity distribution table; writes CSV and JSON artifacts for further analysis.
5. **Reconcile** — Cross-checks reconstructed realized P&amp;L against `positions.realizedPnl` so field mismatches surface early.

## CLI reference

```
node index.js [wallet] [options]
```

| Option | Description |
|--------|-------------|
| `wallet` | Proxy wallet address (`0x…`). Falls back to `WALLET_ADDRESS` in `.env`. |
| `--out <dir>` | Output directory (default: `./out`) |
| `--no-gamma` | Skip Gamma resolution lookup |
| `--include-open` | Also print convexity distribution including open positions at mark-to-market |
| `--offline <file>` | Re-run analysis from a saved `activity.json` (no API calls) |
| `--positions <file>` | Positions dump to pair with `--offline` (default: empty) |

### Offline mode

Live runs write raw API dumps so you can re-analyze without hitting the network:

```bash
node index.js --offline ./out/activity.json --positions ./out/positions.json
```

If `resolution.json` exists in the output directory, it is loaded automatically.

## Output artifacts

All files are written to `--out` (default `./out/`):

| File | Description |
|------|-------------|
| `activity.json` | Raw activity feed from the Data API |
| `positions.json` | Current positions snapshot |
| `resolution.json` | Cached Gamma market resolutions |
| `ledger.csv` | One row per ticket (cost, proceeds, P&amp;L, status) |
| `convexity_resolved.csv` | Distribution table for resolved tickets only |
| `convexity_allin.csv` | Distribution including open MTM (only with `--include-open`) |
| `summary.json` | Machine-readable rollup of portfolio and distribution stats |

## Convexity buckets

Tickets are grouped by VWAP entry price (in cents):

`<=1c` · `1-2c` · `2-3c` · `3-5c` · `5-10c` · `10-25c` · `25-50c` · `50-75c` · `75-100c`

Per bucket, the tool reports ticket count, hit rate, in-the-money rate, cost, return, P&amp;L, ROI, expectancy per ticket, and payoff-multiple percentiles (median, p90, max).

## Testing

The self-test runs entirely offline with synthetic activity data — no network access required:

```bash
npm test
```

## Project layout

```
index.js          CLI entry point
lib/
  api.js          Polymarket Data + Gamma API client
  ledger.js       Activity → ticket reconstruction and classification
  convexity.js    Bucketed distribution and portfolio rollup
  report.js       Console tables and CSV/JSON writers
  env.js          .env loader
test/
  selftest.js     Offline validation of ledger and convexity math
```

## License

MIT
