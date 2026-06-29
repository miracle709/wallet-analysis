// lib/api.js
// Minimal, zero-dependency Polymarket API client.
// Endpoints confirmed against Polymarket Data API docs (data-api.polymarket.com)
// and Gamma API (gamma-api.polymarket.com).

const DATA_API = 'https://data-api.polymarket.com';
const GAMMA_API = 'https://gamma-api.polymarket.com';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * GET JSON with exponential backoff. Retries on 429/5xx and network errors.
 */
async function getJSON(url, { retries = 6, baseDelay = 600, label = '' } = {}) {
  let attempt = 0;
  for (;;) {
    try {
      const res = await fetch(url, {
        headers: { accept: 'application/json', 'user-agent': 'poly-ledger/1.0' },
      });
      if (res.status === 429 || res.status >= 500) {
        throw new Error(`HTTP ${res.status}`);
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw Object.assign(new Error(`HTTP ${res.status} ${body.slice(0, 200)}`), { fatal: true });
      }
      return await res.json();
    } catch (err) {
      attempt += 1;
      if (err.fatal || attempt > retries) throw err;
      const wait = baseDelay * 2 ** (attempt - 1) + Math.random() * 250;
      process.stderr.write(`  retry ${attempt}/${retries} ${label} after ${Math.round(wait)}ms (${err.message})\n`);
      await sleep(wait);
    }
  }
}

const MAX_ACTIVITY_OFFSET = 3000;

function activityKey(ev) {
  return `${ev.transactionHash ?? ''}|${ev.timestamp ?? ''}|${ev.asset ?? ''}|${ev.type ?? ''}|${ev.size ?? ''}`;
}

/**
 * Fetch the FULL on-chain activity ledger for a user.
 * Uses offset pagination within a time window; when offset would exceed the API
 * cap (3000), advances `start` to the last seen timestamp and continues.
 * Returns every TRADE / SPLIT / MERGE / REDEEM / REWARD / CONVERSION event.
 *
 * @param {string} user  proxy wallet address (0x...)
 */
export async function fetchAllActivity(user, { pageSize = 500, pageDelay = 250, onPage } = {}) {
  const all = [];
  const seen = new Set();
  let start = 1; // epoch lower bound; docs: pass 1 for full history
  let offset = 0;

  for (;;) {
    if (offset > MAX_ACTIVITY_OFFSET) {
      const last = all[all.length - 1];
      if (!last?.timestamp) break;
      start = last.timestamp;
      offset = 0;
    }

    const url =
      `${DATA_API}/activity?user=${user}` +
      `&limit=${pageSize}&offset=${offset}` +
      `&sortBy=TIMESTAMP&sortDirection=ASC` +
      `&start=${start}`;
    const page = await getJSON(url, { label: `activity@${start}@${offset}` });
    if (!Array.isArray(page) || page.length === 0) break;

    let added = 0;
    for (const ev of page) {
      const key = activityKey(ev);
      if (seen.has(key)) continue;
      seen.add(key);
      all.push(ev);
      added += 1;
    }
    if (onPage) onPage(all.length, page.length);

    if (page.length < pageSize) break;

    if (added === 0) {
      const last = page[page.length - 1];
      if (!last?.timestamp) break;
      start = last.timestamp + 1;
      offset = 0;
    } else {
      offset += pageSize;
    }

    await sleep(pageDelay);
  }
  return all;
}

/**
 * Fetch the FULL set of currently-held positions for a user (size > 0).
 * Carries Polymarket-computed realizedPnl / cashPnl / avgPrice / curPrice.
 * NOTE: survivorship-biased on its own — exited/dead tickets are absent.
 */
export async function fetchAllPositions(user, { pageSize = 500, pageDelay = 250, onPage } = {}) {
  const all = [];
  let offset = 0;
  for (;;) {
    const url =
      `${DATA_API}/positions?user=${user}` +
      `&limit=${pageSize}&offset=${offset}` +
      `&sortBy=CURRENT&sortDirection=DESC`;
    const page = await getJSON(url, { label: `positions@${offset}` });
    if (!Array.isArray(page) || page.length === 0) break;
    all.push(...page);
    if (onPage) onPage(all.length, page.length);
    if (page.length < pageSize) break;
    offset += pageSize;
    await sleep(pageDelay);
  }
  return all;
}

/**
 * Fetch closed positions for a user (fully exited markets with realized P&L).
 * Paginates until an empty page is returned.
 */
export async function fetchAllClosedPositions(user, { pageSize = 50, pageDelay = 250, onPage } = {}) {
  const all = [];
  let offset = 0;
  for (;;) {
    const url =
      `${DATA_API}/closed-positions?user=${user}` +
      `&limit=${pageSize}&offset=${offset}` +
      `&sortBy=REALIZEDPNL&sortDirection=DESC`;
    const page = await getJSON(url, { label: `closed-positions@${offset}` });
    if (!Array.isArray(page) || page.length === 0) break;
    all.push(...page);
    if (onPage) onPage(all.length, page.length);
    if (page.length < pageSize) break;
    offset += pageSize;
    await sleep(pageDelay);
  }
  return all;
}

/**
 * Resolve market metadata (closed flag + outcomePrices) for a set of conditionIds
 * via the Gamma API. Returns Map<conditionId, { closed, outcomePrices:number[], endDate }>.
 * Best-effort: failures are swallowed per-batch and left as "unknown".
 */
export async function fetchResolution(conditionIds, { batchSize = 20, pageDelay = 250 } = {}) {
  const out = new Map();
  const ids = [...new Set(conditionIds)].filter(Boolean);
  for (let i = 0; i < ids.length; i += batchSize) {
    const batch = ids.slice(i, i + batchSize);
    const qs = batch.map((id) => `condition_ids=${encodeURIComponent(id)}`).join('&');
    const url = `${GAMMA_API}/markets?${qs}&limit=${batchSize}`;
    let markets;
    try {
      markets = await getJSON(url, { label: `gamma@${i}` });
    } catch (err) {
      process.stderr.write(`  gamma batch ${i} failed: ${err.message}\n`);
      continue;
    }
    for (const m of markets || []) {
      const cond = m.conditionId || m.condition_id;
      if (!cond) continue;
      out.set(cond, {
        closed: Boolean(m.closed),
        outcomePrices: parseMaybeJsonArray(m.outcomePrices).map(Number),
        outcomes: parseMaybeJsonArray(m.outcomes),
        endDate: m.endDate || m.end_date || null,
      });
    }
    await sleep(pageDelay);
  }
  return out;
}

function parseMaybeJsonArray(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    try {
      const p = JSON.parse(v);
      return Array.isArray(p) ? p : [];
    } catch {
      return [];
    }
  }
  return [];
}
