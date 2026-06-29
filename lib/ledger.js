// lib/ledger.js
// Collapse the raw activity feed into one record per ASSET (= one outcome token
// = one "ticket"), reconstructing cost basis, proceeds, and realized P&L.
//
// When Polymarket position data is available (open + closed-positions APIs),
// P&L fields are taken from Polymarket as the source of truth.

const EPS = 1e-6;
const SPLIT_COST_PER_SHARE = 0.5; // Polymarket avgPrice for split-minted shares

function usdcOf(ev) {
  if (ev.usdcSize != null && Number.isFinite(Number(ev.usdcSize))) return Number(ev.usdcSize);
  const size = Number(ev.size) || 0;
  const price = ev.price != null ? Number(ev.price) : null;
  return price != null ? size * price : size;
}

function emptyTicket(ev) {
  return {
    asset: ev.asset,
    conditionId: ev.conditionId,
    title: ev.title || '',
    slug: ev.slug || '',
    eventSlug: ev.eventSlug || '',
    outcome: ev.outcome ?? null,
    outcomeIndex: ev.outcomeIndex ?? null,
    boughtShares: 0,
    boughtUsdc: 0,
    soldShares: 0,
    soldUsdc: 0,
    redeemedShares: 0,
    redeemedUsdc: 0,
    splitUsdc: 0,
    mergeUsdc: 0,
    rewardUsdc: 0,
    conversionCount: 0,
    firstTs: ev.timestamp ?? null,
    lastTs: ev.timestamp ?? null,
    nEvents: 0,
    fromPositionOnly: false,
    pnlSource: 'activity',
  };
}

function deriveActivityFields(t) {
  t.vwapEntry = t.boughtShares > EPS ? t.boughtUsdc / t.boughtShares : null;
  t.netShares = t.boughtShares - t.soldShares - t.redeemedShares;
  t.disposedShares = t.soldShares + t.redeemedShares;
  t.realizedProceeds = t.soldUsdc + t.redeemedUsdc + t.mergeUsdc;
  t.costPaid = t.boughtUsdc + t.splitUsdc;
  t.disposedCostBasis = t.vwapEntry != null ? t.vwapEntry * t.disposedShares : 0;
  t.realizedPnl = t.realizedProceeds - t.disposedCostBasis;
  t.residualCostBasis = t.costPaid - t.disposedCostBasis;
}

/**
 * Allocate split inventory cost ($0.50/share) when buys are absent.
 * @param {Map<string, Ticket>} tickets
 * @param {Map<string, number>} conditionSplitShares  conditionId -> total split size (pairs)
 */
function applySplitCostFallback(tickets, conditionSplitShares) {
  for (const t of tickets.values()) {
    if (t.boughtShares > EPS || t.disposedShares <= EPS) continue;
    const splitShares = conditionSplitShares.get(t.conditionId) || 0;
    if (splitShares <= EPS) continue;
    t.disposedCostBasis = Math.min(t.disposedShares, splitShares) * SPLIT_COST_PER_SHARE;
    t.realizedPnl = t.realizedProceeds - t.disposedCostBasis;
    t.residualCostBasis = t.costPaid - t.disposedCostBasis;
    if (t.disposedShares > EPS) {
      t.vwapEntry = t.disposedCostBasis / t.disposedShares;
      t.costPaid = Math.max(t.costPaid, t.disposedCostBasis + t.residualCostBasis);
    }
  }
}

/**
 * @param {Array} activity   raw events from fetchAllActivity
 * @returns {Map<string, Ticket>} keyed by asset (token id)
 */
export function buildTickets(activity) {
  const tickets = new Map();
  const conditionSplitShares = new Map();

  const ensure = (ev) => {
    let t = tickets.get(ev.asset);
    if (!t) {
      t = emptyTicket(ev);
      tickets.set(ev.asset, t);
    }
    return t;
  };

  for (const ev of activity) {
    if (!ev) continue;
    const type = (ev.type || 'TRADE').toUpperCase();
    const usdc = usdcOf(ev);
    const size = Number(ev.size) || 0;

    if (!ev.asset) {
      if (type === 'SPLIT' && ev.conditionId) {
        conditionSplitShares.set(
          ev.conditionId,
          (conditionSplitShares.get(ev.conditionId) || 0) + size
        );
      } else if (type === 'MERGE' && ev.conditionId) {
        conditionSplitShares.set(
          ev.conditionId,
          (conditionSplitShares.get(ev.conditionId) || 0) - size
        );
      }
      continue;
    }

    const t = ensure(ev);
    const side = (ev.side || '').toUpperCase();

    if (type === 'TRADE' && side === 'BUY') {
      t.boughtShares += size;
      t.boughtUsdc += usdc;
    } else if (type === 'TRADE' && side === 'SELL') {
      t.soldShares += size;
      t.soldUsdc += usdc;
    } else if (type === 'REDEEM') {
      t.redeemedShares += size;
      t.redeemedUsdc += usdc;
    } else if (type === 'SPLIT') {
      t.splitUsdc += usdc;
      if (ev.conditionId) {
        conditionSplitShares.set(
          ev.conditionId,
          (conditionSplitShares.get(ev.conditionId) || 0) + size
        );
      }
    } else if (type === 'MERGE') {
      t.mergeUsdc += usdc;
      if (ev.conditionId) {
        conditionSplitShares.set(
          ev.conditionId,
          (conditionSplitShares.get(ev.conditionId) || 0) - size
        );
      }
    } else if (type === 'REWARD') {
      t.rewardUsdc += usdc;
    } else if (type === 'CONVERSION') {
      t.conversionCount += 1;
    }

    t.nEvents += 1;
    if (ev.timestamp != null) {
      t.firstTs = t.firstTs == null ? ev.timestamp : Math.min(t.firstTs, ev.timestamp);
      t.lastTs = t.lastTs == null ? ev.timestamp : Math.max(t.lastTs, ev.timestamp);
    }
  }

  for (const t of tickets.values()) deriveActivityFields(t);
  applySplitCostFallback(tickets, conditionSplitShares);

  return tickets;
}

/**
 * @param {Array} open
 * @param {Array} closed
 * @returns {Map<string, { source: 'open'|'closed', pos: object }>}
 */
export function buildPositionIndex(open = [], closed = []) {
  const index = new Map();
  for (const p of open) {
    if (p?.asset) index.set(p.asset, { source: 'open', pos: p });
  }
  for (const p of closed) {
    if (p?.asset) index.set(p.asset, { source: 'closed', pos: p });
  }
  return index;
}

/**
 * Ticket stubs for Polymarket positions with no activity rows.
 */
export function buildTicketsFromPositions(open = [], closed = []) {
  const tickets = new Map();
  for (const p of [...open, ...closed]) {
    if (!p?.asset || tickets.has(p.asset)) continue;
    tickets.set(p.asset, {
      ...emptyTicket({
        asset: p.asset,
        conditionId: p.conditionId,
        title: p.title,
        slug: p.slug,
        eventSlug: p.eventSlug,
        outcome: p.outcome,
        outcomeIndex: p.outcomeIndex,
        timestamp: null,
      }),
      fromPositionOnly: true,
    });
  }
  return tickets;
}

/**
 * Union activity tickets with position-only stubs (activity metadata wins).
 */
export function mergeTickets(activityTickets, positionTickets) {
  const merged = new Map(activityTickets);
  for (const [asset, t] of positionTickets) {
    if (!merged.has(asset)) merged.set(asset, t);
  }
  return merged;
}

function closedStatus(totalPnl) {
  if (totalPnl > EPS) return 'WON_REALIZED';
  if (totalPnl < -EPS) return 'LOST_REALIZED';
  return 'EXITED_FLAT';
}

/**
 * Overwrite ticket economics from Polymarket position APIs.
 */
export function applyPolymarketPnL(tickets, positionIndex) {
  if (!positionIndex?.size) return tickets;

  for (const t of tickets.values()) {
    const entry = positionIndex.get(t.asset);
    if (!entry) continue;
    const p = entry.pos;
    const isOpen = entry.source === 'open';

    t.pnlSource = 'polymarket';
    t.posSource = entry.source;
    t.vwapEntry = Number(p.avgPrice);
    t.realizedPnl = Number(p.realizedPnl) || 0;
    t.posRealizedPnl = t.realizedPnl;

    if (isOpen) {
      t.costPaid = Number(p.initialValue) || 0;
      t.unrealizedPnl = Number(p.cashPnl) || 0;
      t.markValue = Number(p.currentValue) || 0;
      t.markPrice = p.curPrice != null ? Number(p.curPrice) : null;
      t.curPrice = t.markPrice;
      t.netShares = Number(p.size) || 0;
      t.totalPnl = t.realizedPnl + t.unrealizedPnl;
      t.totalReturn = t.realizedPnl + t.markValue;
      t.status = 'OPEN_LIVE';
      t.resolved = false;
      t.won = null;
    } else {
      t.costPaid = (Number(p.totalBought) || 0) * (Number(p.avgPrice) || 0);
      t.unrealizedPnl = 0;
      t.markValue = 0;
      t.markPrice = 0;
      t.curPrice = p.curPrice != null ? Number(p.curPrice) : null;
      t.netShares = 0;
      t.totalPnl = t.realizedPnl;
      t.totalReturn = t.realizedPnl;
      t.status = closedStatus(t.totalPnl);
      t.resolved = true;
      t.won = t.totalPnl > EPS;
    }

    t.multiple = t.costPaid > EPS ? t.totalReturn / t.costPaid : null;
  }

  return tickets;
}

/**
 * Classify each ticket using resolution metadata + current positions.
 * When pnlSource === 'polymarket', economics are preserved; resolution may
 * refine status on open tickets held through market close.
 */
export function classifyTickets(tickets, resolution, positions = []) {
  const posByAsset = new Map();
  for (const p of positions) posByAsset.set(p.asset, p);

  for (const t of tickets.values()) {
    const pos = posByAsset.get(t.asset);
    if (t.pnlSource !== 'polymarket') {
      t.posRealizedPnl = pos ? Number(pos.realizedPnl) : null;
      t.curPrice = pos ? Number(pos.curPrice) : null;
    } else if (pos && t.posRealizedPnl == null) {
      t.posRealizedPnl = Number(pos.realizedPnl);
    }

    const res = resolution.get(t.conditionId);
    let resolvedPrice = null;
    if (res && res.closed && Array.isArray(res.outcomePrices) && t.outcomeIndex != null) {
      const rp = res.outcomePrices[t.outcomeIndex];
      if (Number.isFinite(rp)) resolvedPrice = rp;
    }
    t.resolvedPrice = resolvedPrice;

    if (t.pnlSource === 'polymarket') {
      if (t.status === 'OPEN_LIVE' && resolvedPrice != null && t.netShares > EPS) {
        if (resolvedPrice >= 0.5) {
          t.markPrice = 1;
          t.markValue = t.netShares;
        } else {
          t.markPrice = 0;
          t.markValue = 0;
        }
        const heldCost = t.netShares * (t.vwapEntry ?? SPLIT_COST_PER_SHARE);
        t.unrealizedPnl = t.markValue - heldCost;
        t.totalPnl = t.realizedPnl + t.unrealizedPnl;
        t.totalReturn = t.realizedPnl + t.markValue;
        t.multiple = t.costPaid > EPS ? t.totalReturn / t.costPaid : null;
        t.status = resolvedPrice >= 0.5 ? 'WON_REALIZED' : 'LOST_REALIZED';
        t.resolved = true;
        t.won = t.totalPnl > EPS;
      }
      continue;
    }

    const stillHolding = t.netShares > EPS;

    if (!stillHolding) {
      t.markPrice = 0;
      t.markValue = 0;
    } else if (resolvedPrice != null) {
      if (resolvedPrice >= 0.5) {
        t.markPrice = 1;
        t.markValue = t.netShares * 1;
      } else {
        t.markPrice = 0;
        t.markValue = 0;
      }
    } else if (t.curPrice != null) {
      t.markPrice = t.curPrice;
      t.markValue = t.netShares * t.curPrice;
    } else {
      t.markPrice = null;
      t.markValue = 0;
    }

    t.totalReturn = t.realizedProceeds + t.markValue;
    t.totalPnl = t.totalReturn - t.costPaid;
    t.unrealizedPnl = t.markValue - t.residualCostBasis;
    t.multiple = t.costPaid > EPS ? t.totalReturn / t.costPaid : null;

    const marketResolved = resolvedPrice != null;
    if (!stillHolding) {
      t.status = t.totalPnl > EPS ? 'WON_REALIZED' : t.totalPnl < -EPS ? 'LOST_REALIZED' : 'EXITED_FLAT';
    } else if (marketResolved) {
      t.status = resolvedPrice >= 0.5 ? 'WON_REALIZED' : 'LOST_REALIZED';
    } else {
      t.status = t.curPrice != null ? 'OPEN_LIVE' : 'OPEN_UNKNOWN';
    }
    t.resolved = ['WON_REALIZED', 'LOST_REALIZED', 'EXITED_FLAT'].includes(t.status);
    t.won = t.resolved ? t.totalPnl > EPS : null;
  }

  return tickets;
}

/**
 * Cross-check reconstructed realized P&L vs Polymarket's positions.realizedPnl.
 */
export function reconciliation(tickets) {
  const rows = [];
  for (const t of tickets.values()) {
    if (t.posRealizedPnl == null) continue;
    const diff = t.realizedPnl - t.posRealizedPnl;
    rows.push({ asset: t.asset, title: t.title, mine: t.realizedPnl, polymarket: t.posRealizedPnl, diff });
  }
  rows.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
  const maxAbs = rows.length ? Math.abs(rows[0].diff) : 0;
  return { rows, maxAbs, n: rows.length };
}
