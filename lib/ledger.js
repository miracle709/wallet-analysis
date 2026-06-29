// lib/ledger.js
// Collapse the raw activity feed into one record per ASSET (= one outcome token
// = one "ticket"), reconstructing cost basis, proceeds, and realized P&L.
//
// Activity types and how each moves cash for the wallet:
//   TRADE  side=BUY   -> shares in,  USDC out  (cost)     usdc = size*price
//   TRADE  side=SELL  -> shares out, USDC in   (proceeds) usdc = size*price
//   REDEEM            -> shares out, USDC in   (proceeds) winning shares pay $1 each
//   SPLIT             -> USDC out, mints 1 YES + 1 NO     (collateral locked)
//   MERGE             -> USDC in,  burns 1 YES + 1 NO     (collateral freed)
//   REWARD            -> USDC in   (liquidity rewards; not position P&L)
//   CONVERSION        -> NO -> {YES...}+pUSD restructure  (rare; logged, flagged)
//
// REDEEM field note: the public docs sample only shows TRADE shape in full.
// For REDEEM we take usdcSize if present, else size*price (price=1 on a win,
// 0 on a loss). We cross-check the reconstructed realized P&L against
// positions.realizedPnl for overlapping assets so any field mismatch surfaces.

const EPS = 1e-6;

function usdcOf(ev) {
  if (ev.usdcSize != null && Number.isFinite(Number(ev.usdcSize))) return Number(ev.usdcSize);
  const size = Number(ev.size) || 0;
  const price = ev.price != null ? Number(ev.price) : null;
  return price != null ? size * price : size; // redeem with no price -> $1/share
}

/**
 * @param {Array} activity   raw events from fetchAllActivity
 * @returns {Map<string, Ticket>} keyed by asset (token id)
 */
export function buildTickets(activity) {
  const tickets = new Map();

  const ensure = (ev) => {
    let t = tickets.get(ev.asset);
    if (!t) {
      t = {
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
      };
      tickets.set(ev.asset, t);
    }
    return t;
  };

  for (const ev of activity) {
    if (!ev || !ev.asset) continue; // splits/conversions sometimes lack a single asset; handled below
    const t = ensure(ev);
    const type = (ev.type || 'TRADE').toUpperCase();
    const side = (ev.side || '').toUpperCase();
    const size = Number(ev.size) || 0;
    const usdc = usdcOf(ev);

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
    } else if (type === 'MERGE') {
      t.mergeUsdc += usdc;
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

  // derived fields
  for (const t of tickets.values()) {
    t.vwapEntry = t.boughtShares > EPS ? t.boughtUsdc / t.boughtShares : null; // avg buy price (0..1)
    t.netShares = t.boughtShares - t.soldShares - t.redeemedShares;
    t.disposedShares = t.soldShares + t.redeemedShares;
    t.realizedProceeds = t.soldUsdc + t.redeemedUsdc + t.mergeUsdc; // cash that came back
    t.costPaid = t.boughtUsdc + t.splitUsdc; // all cash paid in (excl. rewards)
    // cost basis of shares that have LEFT the book (disposed via sell/redeem)
    t.disposedCostBasis = t.vwapEntry != null ? t.vwapEntry * t.disposedShares : 0;
    // trading-sense realized P&L — matches Polymarket positions.realizedPnl
    t.realizedPnl = t.realizedProceeds - t.disposedCostBasis;
    // cost still tied up in shares we still hold
    t.residualCostBasis = t.costPaid - t.disposedCostBasis;
  }

  return tickets;
}

/**
 * Classify each ticket using resolution metadata + current positions.
 * Mutates tickets in place, adding: status, won, resolvedPrice, markPrice,
 * markValue, totalReturn, totalPnl, multiple.
 *
 * status: WON_REALIZED | LOST_REALIZED | EXITED_FLAT | OPEN_LIVE | OPEN_UNKNOWN
 *
 * @param {Map} tickets
 * @param {Map} resolution  Map<conditionId, {closed, outcomePrices, ...}>
 * @param {Array} positions raw positions (for live mark + realizedPnl cross-check)
 */
export function classifyTickets(tickets, resolution, positions = []) {
  const posByAsset = new Map();
  for (const p of positions) posByAsset.set(p.asset, p);

  for (const t of tickets.values()) {
    const pos = posByAsset.get(t.asset);
    t.posRealizedPnl = pos ? Number(pos.realizedPnl) : null;
    t.curPrice = pos ? Number(pos.curPrice) : null;

    const res = resolution.get(t.conditionId);
    let resolvedPrice = null; // resolution price for THIS outcome (0 or 1) if known
    if (res && res.closed && Array.isArray(res.outcomePrices) && t.outcomeIndex != null) {
      const rp = res.outcomePrices[t.outcomeIndex];
      if (Number.isFinite(rp)) resolvedPrice = rp;
    }
    t.resolvedPrice = resolvedPrice;

    const stillHolding = t.netShares > 1e-3;

    if (!stillHolding) {
      // fully exited via sell/redeem -> final
      t.markPrice = 0;
      t.markValue = 0;
    } else if (resolvedPrice != null) {
      // resolved while still holding -> deterministic mark (0 or 1)
      if (resolvedPrice >= 0.5) {
        t.markPrice = 1; // winning shares worth $1 (redeemable)
        t.markValue = t.netShares * 1;
      } else {
        t.markPrice = 0; // resolved against -> dead ticket (the survivorship loss)
        t.markValue = 0;
      }
    } else if (t.curPrice != null) {
      // open & unresolved -> live mark
      t.markPrice = t.curPrice;
      t.markValue = t.netShares * t.curPrice;
    } else {
      t.markPrice = null;
      t.markValue = 0;
    }

    // total economics (realized cash + current value of any residual shares)
    t.totalReturn = t.realizedProceeds + t.markValue;
    t.totalPnl = t.totalReturn - t.costPaid; // == realizedPnl + unrealizedPnl
    t.unrealizedPnl = t.markValue - t.residualCostBasis;
    t.multiple = t.costPaid > EPS ? t.totalReturn / t.costPaid : null;

    // status + resolved flag
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
 * Cross-check reconstructed realized P&L vs Polymarket's positions.realizedPnl
 * for assets present in both. Large mismatches usually mean the REDEEM usdc
 * field assumption is wrong — worth eyeballing a raw REDEEM event if so.
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
