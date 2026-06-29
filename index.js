#!/usr/bin/env node
// index.js — rebuild a Polymarket wallet's realized ledger + convexity distribution.
//
// Usage:
//   node index.js [wallet] [--out ./out] [--no-gamma] [--include-open]
//   node index.js --offline ./out/activity.json [--positions ./out/positions.json]
//
// Wallet: pass as first arg, or set WALLET_ADDRESS in .env / environment.
// CLI arg overrides WALLET_ADDRESS when both are set.
//
// Live pull writes raw dumps so you can re-run analysis offline without re-hitting
// the API (and so the pull is auditable).

import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv } from './lib/env.js';
import { fetchAllActivity, fetchAllPositions, fetchResolution } from './lib/api.js';
import { buildTickets, classifyTickets, reconciliation } from './lib/ledger.js';
import { convexityDistribution, portfolioSummary } from './lib/convexity.js';
import {
  printPortfolio, printDistribution, printReconciliation,
  writeLedgerCsv, writeDistributionCsv,
} from './lib/report.js';

function parseArgs(argv) {
  const a = { _: [], out: './out', gamma: true, includeOpen: false, offline: null, positions: null };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--out') a.out = argv[++i];
    else if (t === '--no-gamma') a.gamma = false;
    else if (t === '--include-open') a.includeOpen = true;
    else if (t === '--offline') a.offline = argv[++i];
    else if (t === '--positions') a.positions = argv[++i];
    else a._.push(t);
  }
  return a;
}

async function main() {
  loadEnv();
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(args.out, { recursive: true });

  let activity, positions;

  if (args.offline) {
    console.log(`Loading activity from ${args.offline}`);
    activity = JSON.parse(readFileSync(args.offline, 'utf8'));
    positions = args.positions ? JSON.parse(readFileSync(args.positions, 'utf8')) : [];
  } else {
    const wallet = (args._[0] || process.env.WALLET_ADDRESS || '').toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(wallet)) {
      console.error(
        'Provide a wallet address:\n' +
        '  node index.js 0x...                    (CLI arg)\n' +
        '  WALLET_ADDRESS=0x... in .env           (env var)\n' +
        '  node index.js --offline activity.json  (offline mode)'
      );
      process.exit(1);
    }
    console.log(`Pulling full activity ledger for ${wallet} ...`);
    activity = await fetchAllActivity(wallet, {
      onPage: (total) => process.stdout.write(`\r  activity events: ${total}   `),
    });
    process.stdout.write('\n');
    console.log(`Pulling current positions ...`);
    positions = await fetchAllPositions(wallet, {
      onPage: (total) => process.stdout.write(`\r  positions: ${total}   `),
    });
    process.stdout.write('\n');

    writeFileSync(join(args.out, 'activity.json'), JSON.stringify(activity, null, 0));
    writeFileSync(join(args.out, 'positions.json'), JSON.stringify(positions, null, 0));
  }

  console.log(`\nReconstructing tickets from ${activity.length} events ...`);
  const tickets = buildTickets(activity);

  let resolution = new Map();
  if (args.gamma && !args.offline) {
    const conds = [...new Set([...tickets.values()].map((t) => t.conditionId))];
    console.log(`Resolving ${conds.length} markets via Gamma ...`);
    resolution = await fetchResolution(conds);
    writeFileSync(
      join(args.out, 'resolution.json'),
      JSON.stringify([...resolution.entries()], null, 0)
    );
  } else if (args.offline) {
    // try to reuse a sibling resolution dump if present
    try {
      const r = JSON.parse(readFileSync(join(args.out, 'resolution.json'), 'utf8'));
      resolution = new Map(r);
      console.log(`Loaded resolution for ${resolution.size} markets from cache.`);
    } catch {
      console.log('No cached resolution.json — open/dead tickets may be marked OPEN_UNKNOWN.');
    }
  }

  classifyTickets(tickets, resolution, positions);

  // --- reports ---
  const summary = portfolioSummary(tickets);
  printPortfolio(summary);

  const rec = reconciliation(tickets);
  if (rec.n) printReconciliation(rec);

  const realizedDist = convexityDistribution(tickets, { resolvedOnly: true });
  printDistribution(realizedDist, 'RESOLVED ONLY (pure realized)');

  let allInDist = null;
  if (args.includeOpen) {
    allInDist = convexityDistribution(tickets, { resolvedOnly: false });
    printDistribution(allInDist, 'ALL TICKETS (incl. open mark-to-market)');
  }

  // --- artifacts ---
  writeLedgerCsv(join(args.out, 'ledger.csv'), tickets);
  writeDistributionCsv(join(args.out, 'convexity_resolved.csv'), realizedDist);
  if (allInDist) writeDistributionCsv(join(args.out, 'convexity_allin.csv'), allInDist);
  writeFileSync(
    join(args.out, 'summary.json'),
    JSON.stringify({ summary, realizedDist, allInDist, reconciliation: rec }, null, 2)
  );

  console.log(`\nArtifacts written to ${args.out}/`);
  console.log('  activity.json / positions.json / resolution.json  (raw dumps)');
  console.log('  ledger.csv            (one row per ticket)');
  console.log('  convexity_resolved.csv / summary.json');
}

main().catch((e) => {
  console.error('\nFATAL:', e.stack || e.message);
  process.exit(1);
});
