// lib/report.js
import { writeFileSync } from 'node:fs';

const fmtUsd = (v) => (v == null ? '' : (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 2 }));
const fmtPct = (v) => (v == null ? '—' : (v * 100).toFixed(1) + '%');
const fmtNum = (v, d = 2) => (v == null ? '—' : Number(v).toFixed(d));

function table(headers, rows) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i] ?? '').length)));
  const line = (cells) => cells.map((c, i) => String(c ?? '').padStart(widths[i])).join('  ');
  const sep = widths.map((w) => '─'.repeat(w)).join('  ');
  return [line(headers), sep, ...rows.map(line)].join('\n');
}

export function printPortfolio(s) {
  console.log('\n=== PORTFOLIO ROLLUP ===');
  console.log(`tickets (unique outcome tokens) : ${s.tickets}`);
  console.log(`  resolved                      : ${s.nResolved}   open: ${s.nOpen}`);
  console.log(`resolved hit rate (profitable)  : ${fmtPct(s.hitRate)}`);
  console.log(`total cost paid                 : ${fmtUsd(s.totalCost)}`);
  console.log(`realized proceeds P&L           : ${fmtUsd(s.realizedPnl)}`);
  console.log(`unrealized mark (open tail)      : ${fmtUsd(s.unrealizedMark)}`);
  console.log(`total P&L (realized + mark)      : ${fmtUsd(s.totalPnl)}`);
  console.log(`liquidity rewards (excl. above)  : ${fmtUsd(s.rewards)}`);
  console.log(`pooled ROI on $ staked           : ${fmtPct(s.pooledRoi)}`);
}

export function printDistribution(dist, title) {
  console.log(`\n=== CONVEXITY DISTRIBUTION — ${title} ===`);
  const headers = ['bucket', 'n', 'res', 'hit%', 'itm%', 'cost', 'return', 'pnl', 'roi%', 'E[$]/tkt', 'medX', 'p90X', 'maxX'];
  const rows = dist.map((d) => [
    d.bucket,
    d.n,
    d.nResolved,
    fmtPct(d.hitRate),
    fmtPct(d.itmRate),
    fmtUsd(d.cost),
    fmtUsd(d.return),
    fmtUsd(d.pnl),
    fmtPct(d.roi),
    fmtUsd(d.expectancyPerTicket),
    fmtNum(d.medianMultiple, 1),
    fmtNum(d.p90Multiple, 1),
    fmtNum(d.maxMultiple, 1),
  ]);
  console.log(table(headers, rows));
}

export function printReconciliation(rec) {
  console.log('\n=== RECONCILIATION vs positions.realizedPnl ===');
  console.log(`overlapping assets: ${rec.n}   max abs diff: ${fmtUsd(rec.maxAbs)}`);
  if (rec.maxAbs > 1) {
    console.log('  (diff > $1 — eyeball a raw REDEEM event; the usdc-field assumption may need a tweak)');
    for (const r of rec.rows.slice(0, 5)) {
      console.log(`   ${fmtUsd(r.diff).padStart(12)}  ${r.title.slice(0, 50)}`);
    }
  } else {
    console.log('  reconstruction matches Polymarket within $1 ✓');
  }
}

function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export function writeLedgerCsv(path, tickets) {
  const cols = [
    'asset', 'conditionId', 'title', 'outcome', 'status', 'won',
    'boughtShares', 'boughtUsdc', 'vwapEntry', 'soldUsdc', 'redeemedUsdc',
    'netShares', 'markPrice', 'markValue', 'costPaid', 'realizedPnl',
    'totalReturn', 'totalPnl', 'multiple', 'firstTs', 'lastTs', 'nEvents',
  ];
  const lines = [cols.join(',')];
  for (const t of tickets.values()) {
    lines.push(cols.map((c) => csvEscape(t[c])).join(','));
  }
  writeFileSync(path, lines.join('\n') + '\n');
}

export function writeDistributionCsv(path, dist) {
  const cols = ['bucket', 'n', 'nResolved', 'hitRate', 'itmRate', 'cost', 'return', 'pnl', 'roi', 'expectancyPerTicket', 'meanMultiple', 'medianMultiple', 'p90Multiple', 'maxMultiple'];
  const lines = [cols.join(',')];
  for (const d of dist) lines.push(cols.map((c) => csvEscape(d[c])).join(','));
  writeFileSync(path, lines.join('\n') + '\n');
}
