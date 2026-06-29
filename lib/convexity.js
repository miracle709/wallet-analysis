// lib/convexity.js
// Compute the convexity distribution: per entry-price bucket, the hit rate,
// payoff-multiple distribution, expectancy, and contribution to total P&L.

const EPS = 1e-6;

// Entry-price buckets in CENTS. Tuned for a deep-OTM longshot book.
export const DEFAULT_BUCKETS = [
  { label: '<=1c', lo: 0, hi: 1 },
  { label: '1-2c', lo: 1, hi: 2 },
  { label: '2-3c', lo: 2, hi: 3 },
  { label: '3-5c', lo: 3, hi: 5 },
  { label: '5-10c', lo: 5, hi: 10 },
  { label: '10-25c', lo: 10, hi: 25 },
  { label: '25-50c', lo: 25, hi: 50 },
  { label: '50-75c', lo: 50, hi: 75 },
  { label: '75-100c', lo: 75, hi: 100 },
];

function bucketFor(entryCents, buckets) {
  for (const b of buckets) {
    if ((entryCents > b.lo || (b.lo === 0 && entryCents >= 0)) && entryCents <= b.hi) return b.label;
  }
  return 'other';
}

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  return sorted[base + 1] != null ? sorted[base] + rest * (sorted[base + 1] - sorted[base]) : sorted[base];
}

/**
 * @param {Iterable} tickets   classified tickets
 * @param {Object} opts
 * @param {boolean} opts.resolvedOnly  if true, only resolved tickets count (pure realized view)
 * @param {Array}   opts.buckets
 */
export function convexityDistribution(tickets, { resolvedOnly = true, buckets = DEFAULT_BUCKETS } = {}) {
  const rows = new Map();
  const init = () => ({
    n: 0,
    nResolved: 0,
    nWon: 0,
    nInTheMoney: 0,
    cost: 0,
    ret: 0,
    multiples: [],
    pnl: 0,
  });

  let universe = [...tickets.values()].filter(
    (t) => t.vwapEntry != null && (t.costPaid > EPS || t.pnlSource === 'polymarket')
  );
  if (resolvedOnly) universe = universe.filter((t) => t.resolved);

  for (const t of universe) {
    const entryCents = t.vwapEntry * 100;
    const key = bucketFor(entryCents, buckets);
    if (!rows.has(key)) rows.set(key, init());
    const r = rows.get(key);

    r.n += 1;
    r.cost += t.costPaid;
    r.ret += t.totalReturn;
    r.pnl += t.totalPnl;
    if (t.multiple != null) r.multiples.push(t.multiple);
    if (t.resolved) {
      r.nResolved += 1;
      if (t.won) r.nWon += 1;
      if (t.resolvedPrice != null ? t.resolvedPrice >= 0.5 : t.markPrice === 1) r.nInTheMoney += 1;
    }
  }

  const out = [];
  for (const b of buckets) {
    const r = rows.get(b.label);
    if (!r) continue;
    out.push(finalize(b.label, r));
  }
  if (rows.has('other')) out.push(finalize('other', rows.get('other')));
  return out;
}

function finalize(label, r) {
  const sorted = [...r.multiples].sort((a, b) => a - b);
  return {
    bucket: label,
    n: r.n,
    nResolved: r.nResolved,
    hitRate: r.nResolved ? r.nWon / r.nResolved : null,
    itmRate: r.nResolved ? r.nInTheMoney / r.nResolved : null,
    cost: r.cost,
    return: r.ret,
    pnl: r.pnl,
    roi: r.cost > EPS ? r.ret / r.cost - 1 : null,
    expectancyPerTicket: r.n ? r.pnl / r.n : null,
    meanMultiple: sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : null,
    medianMultiple: quantile(sorted, 0.5),
    p90Multiple: quantile(sorted, 0.9),
    maxMultiple: sorted.length ? sorted[sorted.length - 1] : null,
  };
}

/**
 * Portfolio-level rollup across all tickets (no bucketing).
 * @param {Map} tickets
 * @param {Object} opts
 * @param {string} opts.scope  'all_positions' (default) or 'activity'
 */
export function portfolioSummary(tickets, { scope = 'all_positions' } = {}) {
  let cost = 0,
    ret = 0,
    realizedPnl = 0,
    unrealizedPnl = 0,
    positionsValue = 0,
    n = 0,
    nResolved = 0,
    nOpen = 0,
    nWon = 0,
    nProfitable = 0,
    rewards = 0;

  for (const t of tickets.values()) {
    if (scope === 'activity' && t.fromPositionOnly) continue;

    n += 1;
    cost += t.costPaid || 0;
    ret += t.totalReturn || 0;
    realizedPnl += t.realizedPnl || 0;
    unrealizedPnl += t.unrealizedPnl || 0;
    rewards += t.rewardUsdc || 0;

    if (t.status === 'OPEN_LIVE' || t.status === 'OPEN_UNKNOWN') {
      nOpen += 1;
      positionsValue += t.markValue || 0;
    } else {
      nResolved += 1;
    }

    const pnl = t.totalPnl != null ? t.totalPnl : (t.totalReturn || 0) - (t.costPaid || 0);
    if (pnl > EPS) nProfitable += 1;
    if (t.resolved && t.won) nWon += 1;
  }

  const totalPnl = realizedPnl + unrealizedPnl;

  return {
    pnlSource: tickets.size && [...tickets.values()].some((t) => t.pnlSource === 'polymarket') ? 'polymarket' : 'activity',
    scope,
    tickets: n,
    nResolved,
    nOpen,
    hitRate: n ? nProfitable / n : null,
    resolvedHitRate: nResolved ? nWon / nResolved : null,
    totalCost: cost,
    totalReturn: ret,
    realizedPnl,
    unrealizedPnl,
    unrealizedMark: positionsValue,
    positionsValue,
    totalPnl,
    rewards,
    pooledRoi: cost > EPS ? totalPnl / cost : null,
  };
}
