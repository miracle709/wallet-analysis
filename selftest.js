// test/selftest.js — validates the reconstruction + convexity math offline,
// since the container can't reach Polymarket's API domains.
import { buildTickets, classifyTickets, reconciliation } from '../lib/ledger.js';
import { convexityDistribution, portfolioSummary } from '../lib/convexity.js';

let failures = 0;
function check(name, cond, got, want) {
  const ok = cond;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `   got=${got} want=${want}`}`);
}
const near = (a, b, tol = 1e-2) => a != null && Math.abs(a - b) <= tol;

// ---- synthetic activity feed -------------------------------------------------
// A: deep-OTM winner, redeemed at $1   (0.8c, 100 sh -> $100)
// B: resolved-NO dead ticket, never sold (0.8c, 10000 sh -> $0)   [survivorship loss]
// C: field re-rate, sold into hype     (1.7c, 700 sh -> sold @10c = $70)
// D: Erdan-shaped oversized loss        (3.6c, 29321 sh -> dumped @0.7c)
// E: open live tail                     (2.0c, 200 sh, curPrice 5c)
// F: partial sell, still holding        (10c, 1000 sh, sold 500 @30c, curPrice 30c)
const A = { asset: 'A', conditionId: 'cA', title: 'Khamenei out', outcome: 'Yes', outcomeIndex: 0 };
const B = { asset: 'B', conditionId: 'cB', title: 'Erdan Israel PM', outcome: 'Yes', outcomeIndex: 0 };
const C = { asset: 'C', conditionId: 'cC', title: 'France WC', outcome: 'Yes', outcomeIndex: 0 };
const D = { asset: 'D', conditionId: 'cD', title: 'Big oversized', outcome: 'Yes', outcomeIndex: 0 };
const E = { asset: 'E', conditionId: 'cE', title: 'Open tail', outcome: 'Yes', outcomeIndex: 0 };
const F = { asset: 'F', conditionId: 'cF', title: 'Partial', outcome: 'Yes', outcomeIndex: 0 };

const ev = (m, type, side, size, price, ts) => ({ ...m, type, side, size, price, timestamp: ts });

const activity = [
  ev(A, 'TRADE', 'BUY', 100, 0.008, 100),
  ev(A, 'REDEEM', null, 100, 1, 200), // winning shares pay $1

  ev(B, 'TRADE', 'BUY', 10000, 0.008, 110), // never sold -> dead

  ev(C, 'TRADE', 'BUY', 700, 0.017, 120),
  ev(C, 'TRADE', 'SELL', 700, 0.10, 220),

  ev(D, 'TRADE', 'BUY', 29321, 0.036, 130),
  ev(D, 'TRADE', 'SELL', 29321, 0.007, 230),

  ev(E, 'TRADE', 'BUY', 200, 0.02, 140),

  ev(F, 'TRADE', 'BUY', 1000, 0.10, 150),
  ev(F, 'TRADE', 'SELL', 500, 0.30, 250),
];

const resolution = new Map([
  ['cA', { closed: true, outcomePrices: [1, 0] }], // YES won
  ['cB', { closed: true, outcomePrices: [0, 1] }], // YES lost -> dead ticket
  // cC, cD exited before/at resolution; cE, cF open -> not in map
]);

const positions = [
  { asset: 'B', realizedPnl: 0, curPrice: 0, size: 10000 },
  { asset: 'E', realizedPnl: 0, curPrice: 0.05, size: 200 },
  { asset: 'F', realizedPnl: 100, curPrice: 0.30, size: 500 },
];

// ---- run pipeline ------------------------------------------------------------
const tickets = buildTickets(activity);
classifyTickets(tickets, resolution, positions);

const T = (k) => tickets.get(k);

console.log('--- per-ticket sanity ---');
check('A status WON_REALIZED', T('A').status === 'WON_REALIZED', T('A').status, 'WON_REALIZED');
check('A multiple ~125', near(T('A').multiple, 125, 0.1), T('A').multiple, 125);
check('B status LOST_REALIZED', T('B').status === 'LOST_REALIZED', T('B').status, 'LOST_REALIZED');
check('B realizedPnl ~0 (disposed basis)', near(T('B').realizedPnl, 0), T('B').realizedPnl, 0);
check('B totalPnl ~-80 (true loss)', near(T('B').totalPnl, -80), T('B').totalPnl, -80);
check('C status WON_REALIZED', T('C').status === 'WON_REALIZED', T('C').status, 'WON_REALIZED');
check('C multiple ~5.88', near(T('C').multiple, 5.882, 0.01), T('C').multiple, 5.882);
check('D status LOST_REALIZED', T('D').status === 'LOST_REALIZED', T('D').status, 'LOST_REALIZED');
check('D totalPnl ~-850.31', near(T('D').totalPnl, -850.309, 0.05), T('D').totalPnl, -850.309);
check('E status OPEN_LIVE', T('E').status === 'OPEN_LIVE', T('E').status, 'OPEN_LIVE');
check('F status OPEN_LIVE', T('F').status === 'OPEN_LIVE', T('F').status, 'OPEN_LIVE');
check('F realizedPnl ~100', near(T('F').realizedPnl, 100), T('F').realizedPnl, 100);

console.log('\n--- reconciliation vs positions.realizedPnl ---');
const rec = reconciliation(tickets);
check('recon maxAbs < $0.01', rec.maxAbs < 0.01, rec.maxAbs, 0);

console.log('\n--- convexity distribution (resolved only) ---');
const dist = convexityDistribution(tickets, { resolvedOnly: true });
const byBucket = Object.fromEntries(dist.map((d) => [d.bucket, d]));

const b1 = byBucket['<=1c'];
check('<=1c n=2', b1?.n === 2, b1?.n, 2);
check('<=1c hitRate=50%', near(b1?.hitRate, 0.5), b1?.hitRate, 0.5);
check('<=1c pnl ~19.20', near(b1?.pnl, 19.2, 0.05), b1?.pnl, 19.2);
check('<=1c maxMultiple ~125', near(b1?.maxMultiple, 125, 0.1), b1?.maxMultiple, 125);

const b2 = byBucket['1-2c'];
check('1-2c n=1', b2?.n === 1, b2?.n, 1);
check('1-2c hitRate=100%', near(b2?.hitRate, 1.0), b2?.hitRate, 1.0);
check('1-2c pnl ~58.10', near(b2?.pnl, 58.1, 0.05), b2?.pnl, 58.1);

const b3 = byBucket['3-5c'];
check('3-5c n=1', b3?.n === 1, b3?.n, 1);
check('3-5c hitRate=0%', near(b3?.hitRate, 0.0), b3?.hitRate, 0.0);
check('3-5c pnl ~-850.31', near(b3?.pnl, -850.309, 0.05), b3?.pnl, -850.309);

// open tickets E,F must NOT appear in resolved-only view
const resolvedCount = dist.reduce((a, d) => a + d.n, 0);
check('resolved-only excludes open (count=4)', resolvedCount === 4, resolvedCount, 4);

console.log('\n--- portfolio rollup ---');
const s = portfolioSummary(tickets);
check('portfolio tickets=6', s.tickets === 6, s.tickets, 6);
check('portfolio nResolved=4', s.nResolved === 4, s.nResolved, 4);
check('portfolio totalPnl ~-567.01', near(s.totalPnl, -567.009, 0.05), s.totalPnl, -567.009);

console.log(`\n${failures === 0 ? '✅ ALL CHECKS PASSED' : `❌ ${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
