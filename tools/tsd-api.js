// TSD API (D42 Remaster P1). Read-only indexer + HTTP API + SSE for CMKT circuit listings and sales.
// Public chain data only: no keys, no txs, no user data. The site must keep working without it (falls back to direct RPC).
// Usage: node tsd-api.js [--once] [--port=8787] [--state=<dir>]     (pm2: pm2 start tools/tsd-api.js --name tsd-api)
//   --once  bootstrap/catch up, print a summary, exit (no HTTP)
// Env: API_PORT (8787), API_HOST (127.0.0.1, nginx in front), API_DIR (tools/api-data), RPC_URLS (comma list),
//      ALLOW_ORIGIN (*), WATCH_DIR (watchtower status.json dir, default tools/watch-data), TRADE_DAYS (7), POLL_MS (3000)
// Endpoints (GET): /health /listings (mining processors; ?all=1 every CMKT listing; items[].src=cmkt, ext[] = other-market asks, D52) /trades?hours=24 /stats /config.json /stream (SSE: snapshot, head, delta, ping)
// Indexing: every POLL_MS read logs up to head-CONF (reorg margin), CMKT Listed/Sold/Delisted/PriceChanged + circuit Transfer
// mark listings dirty, dirty ones are re-read with eth_call at that block (chain = source of truth, events only trigger reads).
// Full re-read every FULL_S. Reorg: stored block hash mismatch => rewind REWIND blocks and re-read everything.
// Persistence: one JSON file (atomic rename). P2 bids: SQLite order store in tsd-bids.js (bids.db in API_DIR), Seaport logs come from the same cycle.
// Bids: GET /bids[?cp=&tid=|?offerer=] /free?wallet= (free offers left)  POST /bids /bids/refresh. POST /bids only when BIDS_ENABLED=1 (kill switch, default off).
// LITE=1: skip CMKT listings/trades (anvil E2E only).
const fs = require('fs'), path = require('path'), http = require('http'), zlib = require('zlib');
const { ethers } = require('ethers');
const B = require('./tsd-bids.js'), X = require('./tsd-ext.js'), G = require('./tsd-agg.js');

const CMKT = '0x6feebbebc07bcb90bd1ac8b0cf9baa4f0ff2b46f', MC = '0xca11bde05977b3631167028862be2a173976ca11',
  MINING = '0x7e2e0dc66a3bd9103e69b766afa62d9f7b697b46',
  CORE = ['0xb1024b89886b9a34aa4ff5f31c411d708b20a14c', '0x1f5cb4aeae1807bf60c3b9c0d8adbcc14e91f12c'],
  T_TR = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
  T_LI = '0x723f73331eaee88eec7fc68ef60ab6ed15e4b90d0472b55eb92fa43910bab6dd', T_SO = '0x2938a0a3a4a7c19c3a1fe6ef25340b7acd26dfac11de87836084d42fccc18656',
  T_CL = '0x0508a8b4117d9a7b3d8f5895f6413e61b4f9a2df35afbfb41e78d0ecfff1843f',
  T_DE = '0xd42ab404868acd93610bdba51d0b4ae458bc5b37febb299ae73fe44060fa9882', T_PC = '0x8aa4fa52648a6d15edce8a179c792c86f3719d0cc3c572cf90f91948f0f2cb68';
// curated listing (tools/listed.json, shared with the site via /listings + /config.json): CPUS = every enabled BNB CPU (market, listings, trades); MINERS = those that mine BEM (rigs, other-market asks, bids)
let LISTED = []; try { LISTED = JSON.parse(fs.readFileSync(path.join(__dirname, 'listed.json'), 'utf8')).cpus.filter(c => c.on && c.chain === 56 && /^0x[0-9a-f]{40}$/.test(c.address)).map(c => ({ cp: c.address, name: String(c.name || ''), mining: !!c.mining, cert: !!c.cert, at: c.listedAt || null })); } catch (e) { console.error('listed.json', e.message); }
const CPUS = [...new Set([...CORE, ...LISTED.map(c => c.cp)])], MINERS = [...new Set([...CORE, ...LISTED.filter(c => c.mining).map(c => c.cp)])];
const CONF = 2, REWIND = 30, FULL_S = 600, MAX_STEP = 5000, BT = 0.45, VERSION = 'p7-2026-10-26';

try { for (const l of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) { const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2]; } } catch (e) {}
const argv = process.argv.slice(2), has = f => argv.includes(f), argOf = k => (argv.find(a => a.startsWith(k + '=')) || '').slice(k.length + 1);
const E = process.env;
const DIR = argOf('--state') || E.API_DIR || path.join(__dirname, 'api-data');
const WATCH_DIR = E.WATCH_DIR || path.join(__dirname, 'watch-data');
const PORT = Number(argOf('--port') || E.API_PORT || 8787), HOST = E.API_HOST || '127.0.0.1';
const RPCS = (E.RPC_URLS || 'https://tapeout.net/rpc,https://bsc-rpc.publicnode.com,https://bsc-dataseed.binance.org').split(',').map(s => s.trim()).filter(Boolean);
const MC_Z = Number(E.MC_Z || 200), MC_PAR = Number(E.MC_PAR || 3); // tapeout.net: 200x3 ~2-5x faster than 500x1; more in flight -> timeouts
const TRADE_DAYS = Number(E.TRADE_DAYS || 7), POLL_MS = Number(E.POLL_MS || 3000), ALLOW_ORIGIN = E.ALLOW_ORIGIN || '*', LITE = E.LITE === '1';

// ---- chain helpers (same decoding as app/index.html) ----
const W = n => BigInt(n).toString(16).padStart(64, '0'), hx = n => '0x' + n.toString(16);
const wd = (h, i) => BigInt('0x' + (String(h).replace(/^0x/, '').substr(i * 64, 64) || '0'));
const nw = (h, i, d = 0) => Number(wd(h, i)) / 10 ** d;
const ad = (h, i) => '0x' + String(h).replace(/^0x/, '').substr(i * 64 + 24, 40).toLowerCase();
const tad = x => '0x' + String(x).slice(26).toLowerCase();
const ZERO = '0x' + '0'.repeat(40);
let rid = 0;
// run fn over items with at most n in flight; results keep input order
async function pool(items, n, fn) { const out = new Array(items.length); let i = 0; await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } })); return out; }
async function post(url, method, params, ms = 10000) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rid, method, params }), signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw Error('http ' + r.status);
  const j = await r.json(); if (j.error) throw Error(j.error.message || 'rpc error'); return j.result;
}
async function rpc(method, params, urls = RPCS) { let e; for (const u of urls) for (let k = 0; k < 2; k++) try { return await post(u, method, params); } catch (x) { e = x; } throw e; }
// getLogs: big ranges only on RPCS[0]; a failing chunk is split until <=MAX_STEP, then tried on every RPC
async function logs(f, from, to, span = 50000) {
  const st = []; for (let a = from; a <= to; a += span) st.push(a);
  const parts = await pool(st, 4, async a => {
    const b = Math.min(to, a + span - 1), p = [{ ...f, fromBlock: hx(a), toBlock: hx(b) }];
    try { const r = await post(RPCS[0], 'eth_getLogs', p, 20000); if (!Array.isArray(r)) throw Error('bad logs'); return r; }
    catch (e) { return b - a + 1 > MAX_STEP ? logs(f, a, b, Math.ceil((b - a + 1) / 2)) : rpc('eth_getLogs', p); }
  });
  return parts.flat();
}
const I3 = new ethers.Interface(['function aggregate3((address target,bool allowFailure,bytes callData)[] calls) view returns ((bool success,bytes returnData)[])']);
async function mc(calls, tag = 'latest', z = MC_Z) {
  const st = []; for (let i = 0; i < calls.length; i += z) st.push(i);
  const parts = await pool(st, MC_PAR, async i => {
    const data = I3.encodeFunctionData('aggregate3', [calls.slice(i, i + z).map(([t, d]) => [t, true, d])]);
    const r = await rpc('eth_call', [{ to: MC, data }, tag]);
    return I3.decodeFunctionResult('aggregate3', r)[0].map(x => x.success && x.returnData !== '0x' ? x.returnData : null);
  });
  return parts.flat();
}
async function block(n) { const b = await rpc('eth_getBlockByNumber', [hx(n), false]); if (!b) throw Error('no block ' + n); return { n, hash: b.hash, ts: parseInt(b.timestamp, 16) }; }

// Read listings at block tag. Returns {lid: rec|null}; null = no longer active. Mining weights only for the two mining processors.
async function readListings(ids, tag) {
  const out = {}; if (!ids.length) return out;
  const r = await mc(ids.map(id => [CMKT, '0xde74e57b' + W(id)]), tag);
  const L = [];
  ids.forEach((id, k) => {
    const h = r[k]; if (!h || ad(h, 0) === ZERO) { out[id] = null; return; }
    const pw = wd(h, 2);
    L.push(out[id] = { lid: Number(id), se: ad(h, 0), cp: ad(h, 1), pxWei: pw.toString(), px: Number(pw) / 1e18, tid: wd(h, 4).toString(), ok: null, act: false, vw: 0, uw: 0 });
  });
  const M = L.filter(x => CPUS.includes(x.cp)), n = M.length;
  if (n) {
    const o = await mc([...M.map(x => [x.cp, '0x6352211e' + W(x.tid)]), ...M.map(x => [MINING, '0x10eafa00' + W(x.cp) + W(x.tid)])], tag);
    // CMKT checks the approval at buy time (no escrow): a seller who revoked it leaves a listing that reverts (audit s35: 4 of 324)
    const ap = await mc(M.flatMap(x => [[x.cp, '0x081812fc' + W(x.tid)], [x.cp, '0xe985e9c5' + W(x.se) + W(CMKT)]]), tag);
    const g = await mc(M.map((x, k) => [MINING, '0x0527edc2' + (o[n + k] ? o[n + k].slice(2) : W(0))]), tag);
    M.forEach((x, k) => { x.ok = !!o[k] && ad(o[k], 0) === x.se && ((!!ap[2 * k] && ad(ap[2 * k], 0) === CMKT) || (!!ap[2 * k + 1] && wd(ap[2 * k + 1], 0) === 1n)); const m = g[k], a = !!m && nw(m, 9) === 1; x.act = a; x.vw = a ? nw(m, 19) : 0; x.uw = a ? nw(m, 20) : 0; });
  }
  return out;
}
// mining status/weights for other-market asks (D52), same reads as readListings
async function readMine(M) {
  const n = M.length; if (!n) return;
  const o = await mc(M.map(x => [MINING, '0x10eafa00' + W(x.cp) + W(x.tid)]));
  const g = await mc(M.map((x, k) => [MINING, '0x0527edc2' + (o[k] ? o[k].slice(2) : W(0))]));
  M.forEach((x, k) => { const m = g[k], a = !!m && nw(m, 9) === 1; x.act = a; x.vw = a ? nw(m, 19) : 0; x.uw = a ? nw(m, 20) : 0; });
}
const readTu = async tag => nw(await rpc('eth_call', [{ to: MINING, data: '0x63967742' }, tag]), 0);
const readNext = async tag => nw(await rpc('eth_call', [{ to: CMKT, data: '0xaaccf1ec' }, tag]), 0);
const soldRec = (l, se) => ({ lid: Number(BigInt(l.topics[1])), b: parseInt(l.blockNumber, 16), tx: l.transactionHash, li: parseInt(l.logIndex, 16), by: tad(l.topics[2]), cp: tad(l.topics[3]), tid: wd(l.data, 0).toString(), v: Number(wd(l.data, 1) + wd(l.data, 2)) / 1e18, se: se || null, ts: l.blockTimestamp ? parseInt(l.blockTimestamp, 16) : null }); // ts from the log when the RPC gives it, else stampTrades

// ---- state ----
const rd = f => { try { return JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch (e) { return null; } };
const wr = (f, o) => { fs.mkdirSync(DIR, { recursive: true }); const t = path.join(DIR, f + '.tmp'); fs.writeFileSync(t, JSON.stringify(o)); fs.renameSync(t, path.join(DIR, f)); };
let S = null; // {v,cursor,hash,ts,nextId,tu,listings{lid:rec},trades[],fullAt}
const LAG = require('perf_hooks').monitorEventLoopDelay({ resolution: 20 }); LAG.enable(); let lag0 = 0; setInterval(() => { lag0 = LAG.percentile(99); LAG.reset(); }, 60000).unref(); // load metric for /health (last ~1-2 min)
const meta = { startedAt: new Date().toISOString(), lastErr: null, lastErrAt: null, cycles: 0, rewinds: 0 };
const subs = new Set();
function emit(ev, data) { const s = `event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`; for (const c of subs) try { c.write(s); } catch (e) {} }
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
async function stampTrades(T) { const bs = [...new Set(T.filter(t => !t.ts).map(t => t.b))]; const m = {}; await pool(bs, 4, async b => { m[b] = (await block(b)).ts; }); for (const t of T) if (!t.ts) t.ts = m[t.b]; }
function prune() { const lim = (S.ts || Date.now() / 1e3) - TRADE_DAYS * 86400; S.trades = S.trades.filter(t => t.ts >= lim); }

async function bootstrap(tgt) {
  const nx = await readNext(hx(tgt)), ids = LITE ? [] : Array.from({ length: Math.max(0, nx - 1) }, (_, i) => i + 1), L = {};
  const span = Math.ceil(TRADE_DAYS * 86400 / BT * 1.1), se = {};
  const [rl, lg] = await Promise.all([readListings(ids, hx(tgt)), LITE ? [] : logs({ address: CMKT, topics: [[T_LI, T_SO]] }, Math.max(1, tgt - span), tgt)]);
  for (const [id, x] of Object.entries(rl)) if (x) L[id] = x;
  const T = [];
  for (const l of lg) { const id = Number(BigInt(l.topics[1])); if (l.topics[0] === T_LI) se[id] = tad(l.topics[2]); else T.push(soldRec(l, se[id] || null)); }
  const b = await block(tgt);
  const N = { v: 1, cursor: tgt, hash: b.hash, ts: b.ts, nextId: nx, tu: await readTu(hx(tgt)), listings: L, trades: [], fullAt: Date.now() };
  await stampTrades(T); N.trades = T.sort((x, y) => y.b - x.b || y.li - x.li);
  S = N; prune(); // S is set only when complete: /health and /listings stay 503 until boot is done
  wr('state.json', S);
  return { listings: Object.keys(L).length, trades: S.trades.length };
}

async function cycle() {
  const head = parseInt(await rpc('eth_blockNumber', []), 16), tgt = head - CONF;
  if (!S) { const r = await bootstrap(tgt); emit('snapshot', snapshot()); return { boot: r, block: tgt }; }
  if (S.hash) { const b = await block(S.cursor); if (b.hash !== S.hash) { // reorg: drop recent trades, rewind, re-read everything
    meta.rewinds++; S.trades = S.trades.filter(t => t.b <= S.cursor - REWIND); S.cursor -= REWIND; S.hash = null; S.fullAt = 0; FR.gen++; } }
  if (tgt <= S.cursor) return { idle: true, block: S.cursor };
  // state is read at tgt (recent): RPC nodes prune old state ('missing trie node'), so catching up after downtime must not eth_call at old blocks
  const from = S.cursor + 1, to = Math.min(tgt, from + MAX_STEP - 1), tag = hx(tgt);
  const [cl, tl, sl] = await Promise.all([LITE ? [] : logs({ address: CMKT, topics: [[T_LI, T_SO, T_DE, T_PC]] }, from, to), LITE ? [] : logs({ address: CPUS, topics: [T_TR] }, from, to),
    B.ok() ? logs({ address: B.SEAPORT, topics: [[B.T_OF, B.T_OC, B.T_CI]] }, from, to) : []]);
  const dirty = new Set(), nt = [], full = Date.now() - S.fullAt > FULL_S * 1000 && !FR.running; // the full re-read runs beside the poll (fullPass), never inside it
  for (const l of cl) { const id = Number(BigInt(l.topics[1])); dirty.add(id); if (l.topics[0] === T_SO) nt.push(soldRec(l, S.listings[id] && S.listings[id].se)); }
  if (tl.length) { const k = new Set(tl.filter(l => l.topics.length === 4).map(l => l.address.toLowerCase() + ':' + BigInt(l.topics[3]))); for (const x of Object.values(S.listings)) if (k.has(x.cp + ':' + x.tid)) dirty.add(x.lid); }
  const nx = await readNext(tag); if (!LITE) for (let i = S.nextId; i < nx; i++) dirty.add(i);
  const got = await readListings([...dirty], tag), up = [], rm = [];
  if (FR.running) for (const id of dirty) FR.touched.set(id, tgt); // newer than any chunk read earlier: fullPass must not overwrite these
  for (const [id, x] of Object.entries(got)) {
    const o = S.listings[id];
    if (!x) { if (o) { delete S.listings[id]; rm.push(Number(id)); } }
    else if (!o || !same(o, x)) { S.listings[id] = x; up.push(x); }
  }
  const b = await block(to);
  Object.assign(S, { cursor: to, hash: b.hash, ts: b.ts, nextId: Math.max(S.nextId, nx) });
  if (nt.length) { await stampTrades(nt); const seen = new Set(S.trades.map(t => t.tx + ':' + t.li)); S.trades = nt.filter(t => !seen.has(t.tx + ':' + t.li)).sort((x, y) => y.b - x.b || y.li - x.li).concat(S.trades); }
  prune();
  if (up.length || rm.length || nt.length) wr('state.json', S);
  if (full) fullPass().catch(e => { meta.lastErr = 'full re-read: ' + String(e.message).slice(0, 160); meta.lastErrAt = new Date().toISOString(); });
  emit('head', { block: S.cursor, ts: S.ts });
  const bx = B.ok() ? await B.onLogs(sl.sort((x, y) => parseInt(x.blockNumber, 16) - parseInt(y.blockNumber, 16) || parseInt(x.logIndex, 16) - parseInt(y.logIndex, 16))) : 0; // B.tick runs on its own timer (bidsLoop)
  if (up.length || rm.length || nt.length) emit('delta', { block: S.cursor, ts: S.ts, tu: S.tu, upserts: up.filter(x => CPUS.includes(x.cp)), removes: rm, trades: nt });
  return { block: to, head, up: up.length, rm: rm.length, trades: nt.length, full, bids: bx };
}

// Full re-read of every stored listing (catches changes that emit no event: mining state, owner, weights). Runs BESIDE the poll loop, in chunks of
// FULL_CHUNK ids with a yield and a short pause between chunks, so the head never falls behind (it used to block the cycle ~50 s and spike the event loop).
// Each chunk is read at the poll's current block; a result is applied only if the poll did not read the same listing at that block or later (FR.touched), so newer data never loses.
const FR = { running: false, gen: 0, touched: new Map(), lastMs: null }, FULL_CHUNK = Number(E.FULL_CHUNK || 300), FULL_PAUSE = Number(E.FULL_PAUSE_MS || 150);
const yieldLoop = () => new Promise(z => setImmediate(z));
async function fullPass(read = readListings, rtu = readTu) {
  if (!S || FR.running) return null;
  FR.running = true; FR.touched.clear(); const gen = ++FR.gen, t0 = Date.now(); let n = 0, ch = 0, upN = 0, rmN = 0;
  try {
    const ids = Object.keys(S.listings).map(Number);
    for (let i = 0; i < ids.length; i += FULL_CHUNK) {
      if (gen !== FR.gen) return null; // reorg / restart: a new pass will be scheduled
      const blk = S.cursor, got = await read(ids.slice(i, i + FULL_CHUNK), hx(blk));
      if (gen !== FR.gen) return null;
      const up = [], rm = [];
      for (const [id, x] of Object.entries(got)) {
        if ((FR.touched.get(Number(id)) || 0) >= blk) continue;
        const o = S.listings[id];
        if (!x) { if (o) { delete S.listings[id]; rm.push(Number(id)); } }
        else if (o && !same(o, x)) { S.listings[id] = x; up.push(x); } // o missing = removed meanwhile by the poll: leave it
      }
      n += Object.keys(got).length; ch++; upN += up.length; rmN += rm.length;
      if (up.length || rm.length) emit('delta', { block: S.cursor, ts: S.ts, tu: S.tu, upserts: up.filter(x => CPUS.includes(x.cp)), removes: rm, trades: [] });
      await yieldLoop(); await new Promise(z => setTimeout(z, FULL_PAUSE));
    }
    if (gen !== FR.gen) return null;
    S.tu = await rtu(hx(S.cursor)); S.fullAt = Date.now(); FR.lastMs = Date.now() - t0;
    wr('state.json', S);
    return { ids: n, chunks: ch, up: upN, rm: rmN, ms: FR.lastMs };
  } finally { FR.running = false; FR.touched.clear(); } // one pass at a time, so the aborted pass is always the one holding the flag
}

// ---- read models ----
function health() {
  const age = S ? Math.max(0, Math.round(Date.now() / 1e3 - S.ts)) : null;
  return { ok: !!S, version: VERSION, block: S ? S.cursor : null, ts: S ? S.ts : null, ageS: age, state: age == null ? 'stale' : age <= 20 ? 'live' : age <= 120 ? 'delayed' : 'stale',
    lastErr: meta.lastErr, lastErrAt: meta.lastErrAt, cycles: meta.cycles, rewinds: meta.rewinds, startedAt: meta.startedAt, clients: subs.size, ...(EXT ? EXT.info() : { extState: 'off' }), ...(AGG ? AGG.info() : {}), fullReadMs: FR.lastMs, fullReading: FR.running, rssMB: Math.round(process.memoryUsage().rss / 1048576), lagP99Ms: Math.round(Math.max(lag0, LAG.percentile(99)) / 1e6) };
}
const listings = (all = false) => Object.values(S.listings).filter(x => all || CPUS.includes(x.cp)).sort((x, y) => x.lid - y.lid);
function trades(hours) { const lim = S.ts - hours * 3600; return S.trades.filter(t => t.ts >= lim); }
function stats() {
  const t = trades(24), m = listings().filter(x => x.ok && x.act);
  return { block: S.cursor, ts: S.ts, sales24: t.length, vol24: +t.reduce((s, x) => s + x.v, 0).toFixed(6), listings: Object.keys(S.listings).length, miningListed: m.length, floor: m.length ? Math.min(...m.map(x => x.px)) : null };
}
const snapshot = () => ({ ...health(), tu: S.tu, items: listings(), trades: trades(24) });
let wc = { t: 0, v: null };
function watch() { if (Date.now() - wc.t > 10000) { let s = null; try { s = JSON.parse(fs.readFileSync(path.join(WATCH_DIR, 'status.json'), 'utf8')); } catch (e) {} wc = { t: Date.now(), v: s }; } return wc.v; }
// Remote flags can only DISABLE shipped features (kill switch), never load code.
function config() { const w = watch(); return { ...B.cfg(!!(w && w.paused)), pauseSigning: !!(w && w.paused), watch: w ? { paused: !!w.paused, reason: w.reason || null, checkedAt: w.checkedAt || null, feeBps: w.cmkt ? w.cmkt.feeBps : null } : null }; }

// ---- funnel counters per campaign slug (D45): counts only, no IP / wallet / cookie stored. GET /ev?s=<slug>&e=v|k|w|t (visit, check, wallet, tx), GET /funnel ----
const EVF = path.join(DIR, 'funnel.json'), EV = (() => { try { return JSON.parse(fs.readFileSync(EVF, 'utf8')); } catch (e) { return {}; } })(); let evDirty = false;
// per-day split (OwlGate D1): EVD[yyyymmdd][slug] = {v,w,b,g,..., r_n|r_d0|r_d1|r_w|r_m}; 60 days kept. e: g = Telegram bot link tap, b = buy/sweep tx sent; drop-offs: a = buy attempt (wallet connected), c = chain switch failed, n = not enough BNB, x = cancelled (confirm or wallet), f = wallet/tx error. r = returning bucket from the browser (no ID)
const EVDF = path.join(DIR, 'funnel-day.json'), EVD = (() => { try { return JSON.parse(fs.readFileSync(EVDF, 'utf8')); } catch (e) { return {}; } })();
const BOT_UA = /bot|crawl|spider|slurp|curl|wget|python|node|headless|go-http|axios|preview|lighthouse|scan/i;
const evSave = (f, o) => { fs.writeFileSync(f + '.tmp', JSON.stringify(o)); fs.renameSync(f + '.tmp', f); };
setInterval(() => { if (!evDirty) return; evDirty = false; try { fs.mkdirSync(DIR, { recursive: true }); evSave(EVF, EV); evSave(EVDF, EVD); } catch (e) {} }, 30000).unref();
function evCount(u, ua) {
  const s = String(u.searchParams.get('s') || 'direct'), e = u.searchParams.get('e'), rb = u.searchParams.get('r');
  if (!/^[a-z0-9_]{1,40}$/.test(s) || !/^[vkwtgbacnxf]$/.test(String(e)) || (rb && !/^(n|d0|d1|w|m)$/.test(rb))) return false;
  if (!ua || BOT_UA.test(ua)) return true; // ack, never count bots
  if (EV[s] || Object.keys(EV).length < 500) { const r = EV[s] || (EV[s] = { v: 0, k: 0, w: 0, t: 0, first: Date.now() }); r[e] = (r[e] || 0) + 1; r.last = Date.now(); }
  const d = new Date().toISOString().slice(0, 10).replace(/-/g, ''), D = EVD[d] || (EVD[d] = {});
  if (!EVD[d][s] && Object.keys(D).length >= 500) return true;
  const x = D[s] || (D[s] = {}); x[e] = (x[e] || 0) + 1; if (rb && e === 'v') x['r_' + rb] = (x['r_' + rb] || 0) + 1;
  for (const k of Object.keys(EVD).sort().slice(0, -60)) delete EVD[k];
  evDirty = true; return true;
}
// referral log (founder 2026-10-29): the site sends /ref?r=<referrer>&tx=<buy tx> after a buy/sweep; tools/ref-payout.js verifies on-chain and computes the payout
const REFF = path.join(DIR, 'refs.json'), REFS = (() => { try { return JSON.parse(fs.readFileSync(REFF, 'utf8')); } catch (e) { return []; } })(), REFT = new Set(REFS.map(x => x.tx));
setInterval(() => { if (!REFS.dirty) return; REFS.dirty = false; try { fs.mkdirSync(DIR, { recursive: true }); evSave(REFF, REFS); } catch (e) {} }, 30000).unref();
function refLog(u) {
  const r = String(u.searchParams.get('r') || '').toLowerCase(), tx = String(u.searchParams.get('tx') || '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(r) || !/^0x[0-9a-f]{64}$/.test(tx)) return false;
  if (!REFT.has(tx) && REFS.length < 100000) { REFT.add(tx); REFS.push({ r, tx, t: Date.now() }); REFS.dirty = true; }
  return true;
}
let RST = null, RSTAT = 0; // ref-stats.json is written by tools/ref-pay.js (pm2 og-refpay); re-read at most once a minute
function refStats(u) {
  const r = String(u.searchParams.get('r') || '').toLowerCase(); if (!/^0x[0-9a-f]{40}$/.test(r)) return null;
  if (Date.now() - RSTAT > 60000) { RSTAT = Date.now(); try { RST = JSON.parse(fs.readFileSync(path.join(DIR, 'ref-stats.json'), 'utf8')); } catch (e) {} }
  const o = RST && RST.refs[r];
  return { wallet: r, buys: 0, earned: '0.0', paid: '0.0', pending: '0.0', rate: 20, partnerUntil: null, last: null, ...(o || {}), min: RST ? RST.min : '0.002', schedule: 'daily 00:00 UTC', checkedAt: RST ? RST.t : null };
}
// short referral codes (founder 2026-10-30): owlgate.xyz/?r=<code> instead of the full wallet; the code is derived from the wallet (same wallet = same code),
// stored once so the site can turn it back into the wallet. Payouts still key on the wallet; old ?r=0x… links keep working.
const RCF = path.join(DIR, 'refcodes.json'), RC = (() => { try { return JSON.parse(fs.readFileSync(RCF, 'utf8')); } catch (e) { return {}; } })(), RCA = new Map(Object.entries(RC).map(([c, a]) => [a, c]));
function refCode(u) {
  const a = String(u.searchParams.get('a') || '').toLowerCase(), c = String(u.searchParams.get('c') || '').toLowerCase();
  if (/^[a-z0-9]{6,12}$/.test(c)) return RC[c] ? { code: c, wallet: RC[c] } : null;
  if (!/^0x[0-9a-f]{40}$/.test(a)) return null;
  if (RCA.has(a)) return { code: RCA.get(a), wallet: a };
  if (RCA.size >= 200000) return null;
  const h = BigInt('0x' + require('crypto').createHash('sha256').update(a).digest('hex')).toString(36);
  let k = 6; while (RC[h.slice(0, k)]) k++; // collision: one char longer
  const code = h.slice(0, k); RC[code] = a; RCA.set(a, code);
  try { fs.mkdirSync(DIR, { recursive: true }); evSave(RCF, RC); } catch (e) {}
  return { code, wallet: a };
}
function funnel(u) { const day = String(u.searchParams.get('day') || ''), ks = Object.keys(EVD).sort(); const days = {}; for (const k of /^\d{8}$/.test(day) ? [day] : ks.slice(-14)) if (EVD[k]) days[k] = EVD[k]; return { slugs: EV, days }; }

// ---- HTTP ----
const hits = new Map(), perIp = new Map(), MAX_SSE = 1000, IP_SSE = 8, RATE = 600; // load-api.js: 500 users -> ~110 MB, p95 < 30 ms; RATE per IP/min sized for ~50 users behind one mobile NAT
const ipOf = req => { const r = req.socket.remoteAddress || ''; const f = req.headers['x-forwarded-for']; return (/^(::ffff:)?127\.0\.0\.1$|^::1$/.test(r) && f) ? String(f).split(',')[0].trim() : r; };
function limited(ip) { const now = Date.now(), h = hits.get(ip) || { t: now, n: 0 }; if (now - h.t > 60000) { h.t = now; h.n = 0; } h.n++; hits.set(ip, h); return h.n > RATE; }
setInterval(() => { const now = Date.now(); for (const [k, h] of hits) if (now - h.t > 120000) hits.delete(k); }, 60000).unref();
function send(res, code, obj) {
  let body = JSON.stringify(obj); const gz = body.length > 1024 && /gzip/.test(String(res.req && res.req.headers['accept-encoding'] || ''));
  if (gz) body = zlib.gzipSync(body); // long RTT to the VPS: 67 KB listings -> ~10 KB
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'access-control-allow-origin': ALLOW_ORIGIN, vary: 'accept-encoding', ...(gz ? { 'content-encoding': 'gzip' } : {}), ...(S ? { 'x-as-of-block': String(S.cursor) } : {}) });
  res.end(body);
}
function sendPre(res, x) { // pre-serialized body + gzip (tsd-agg reader)
  const gz = /gzip/.test(String(res.req && res.req.headers['accept-encoding'] || ''));
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'access-control-allow-origin': ALLOW_ORIGIN, vary: 'accept-encoding', ...(gz ? { 'content-encoding': 'gzip' } : {}) });
  res.end(gz ? x.gz : x.body);
}
// ---- /rig?a=<wallet> (D53, bot "My Rigs"): official-processor circuits a wallet owns, with mining state, pending BEM now and 1 / 7 / 14 days ago.
// Owner list from the tsd-agg owner index, then verified on chain (ownerOf) and read through Multicall3. 60 s cache per wallet, max 3 at once, max 60 circuits.
const RIG = { c: new Map(), cz: new Map(), cp: new Map(), busy: 0, bt: null }, RIG_MAX = 60;
function rigCl(addr, head, bt) { // Claim events (topic2 = claimer) -> BEM claimed in the last 1 d / 7 d / the 7 d before. tapeout.net/rpc allows 50,000 blocks per read
  if (RIG.cp.has(addr)) return RIG.cp.get(addr); if (RIG.cp.size >= 3) return Promise.resolve(null);
  const from = head - Math.round(14 * 86400 / bt) - 10, F = { address: MINING, topics: [T_CL, null, '0x' + W(BigInt(addr))] };
  const p = (async () => {
    let L; try { L = await logs(F, from, head, 49000); } catch (e) { await new Promise(z => setTimeout(z, 2000)); L = await logs(F, from, head, 49000); } // 'limit exceeded' is often a rate limit: one retry
    const z = { d1: 0, d7: 0, p7: 0, n: L.length };
    for (const l of L) { const ago = (head - parseInt(l.blockNumber, 16)) * bt, v = Number(BigInt(l.data.slice(0, 66))) / 1e8; if (ago < 86400) z.d1 += v; if (ago < 7 * 86400) z.d7 += v; else if (ago < 14 * 86400) z.p7 += v; }
    RIG.cz.set(addr, { at: Date.now(), z }); if (RIG.cz.size > 300) RIG.cz.delete(RIG.cz.keys().next().value); return z;
  })().catch(e => { console.error('rig claims', e.message); return null; }).finally(() => RIG.cp.delete(addr));
  RIG.cp.set(addr, p); return p;
}
async function rigBt() { // fresh head block + seconds per block (from the last 2000 blocks, cached 10 min)
  const h = S && S.ts && S.cursor > 1e6 && Date.now() / 1000 - S.ts < 20 ? S.cursor : parseInt(await rpc('eth_blockNumber', []), 16); // the live indexer head saves one RPC round trip
  if (!RIG.bt || Date.now() - RIG.bt.at > 6e5) { const a = await block(h), b = await block(h - 2000); RIG.bt = { at: Date.now(), bt: (a.ts - b.ts) / 2000 }; }
  return { n: h, bt: RIG.bt.bt };
}
async function rig(addr) {
  const ix = AGG && AGG.own ? AGG.own(addr) : null; if (!ix) return { code: 503, body: { error: 'owner index not ready' } };
  const c = RIG.c.get(addr); if (c && Date.now() - c.at < 60000) return { code: 200, body: c.j };
  if (RIG.busy >= 3) return { code: 503, body: { error: 'busy' } };
  RIG.busy++;
  try {
    const all = ix.items.map(([ci, id, st]) => ({ cp: ix.cs[ci], id, st })).filter(x => MINERS.includes(x.cp)).sort((a, b) => (b.st === 1) - (a.st === 1) || a.id - b.id), capped = all.length > RIG_MAX, L = all.slice(0, RIG_MAX);
    const bt = await rigBt(), head = bt.n, tg = d => '0x' + (head - Math.round(d * 86400 / bt.bt)).toString(16), out = { ok: true, t: Date.now(), block: head, bt: bt.bt, capped, n: all.length, items: [] };
    if (L.length) {
      const r = await mc(L.flatMap(x => [[x.cp, '0x6352211e' + W(x.id)], [MINING, '0x10eafa00' + W(x.cp) + W(x.id)]])), own = [];
      L.forEach((x, k) => { const o = r[2 * k], key = r[2 * k + 1]; if (o && key && ad(o, 0) === addr) own.push({ ...x, key }); });
      const q = tag => mc(own.map(x => [MINING, '0x1808eeb8' + x.key.slice(2)]), tag).catch(() => own.map(() => null));
      const [g, p0, p1, p7, p14] = await Promise.all([mc(own.map(x => [MINING, '0x0527edc2' + x.key.slice(2)])), q('latest'), q(tg(1)), q(tg(7)), q(tg(14))]);
      const bem = h => h ? Number(BigInt('0x' + h.slice(2, 66))) / 1e8 : null, nwd = (h, i) => h && h.length >= 2 + 64 * (i + 1) ? Number(BigInt('0x' + h.substr(2 + i * 64, 64))) : 0;
      // BEM claimed by this wallet in the last 1 d / 7 d / the 7 d before (Claim event, topic2 = claimer), so "earned" = change of pending + claimed in the window. null = log read failed
      // claims of the last 14 d: ~2.7 M blocks at 0.45 s, 55 log reads. Run in the background (one per wallet, max 3 at once) and wait at most 1.5 s;
      // if it is not done, answer with the last good totals (<10 min) or null; the site re-asks after 12 s and gets the finished totals from RIG.cz
      const cz = RIG.cz.get(addr);
      if (cz && Date.now() - cz.at < 60000) out.claimed = cz.z;
      else {
        const z = await Promise.race([rigCl(addr, head, bt.bt), new Promise(r => setTimeout(() => r(undefined), 1500))]);
        if (z) out.claimed = z; else { const o = RIG.c.get(addr), oz = RIG.cz.get(addr); out.claimed = oz && Date.now() - oz.at < 6e5 ? oz.z : o && o.j.claimed && Date.now() - o.at < 6e5 ? o.j.claimed : null; }
      }
      own.forEach((x, k) => { if (!g[k]) return; out.items.push({ cp: x.cp, id: x.id, st: nwd(g[k], 9), vw: nwd(g[k], 19), uw: nwd(g[k], 20), pend: bem(p0[k]), p1: bem(p1[k]), p7: bem(p7[k]), p14: bem(p14[k]) }); });
    }
    if (RIG.c.size > 200) RIG.c.delete(RIG.c.keys().next().value);
    const full = out.claimed && out.items.every(x => x.pend != null && x.p1 != null && x.p7 != null); // an incomplete read (RPC hiccup) is cached for 10 s only, so the next load retries
    RIG.c.set(addr, { at: full ? Date.now() : Date.now() - 50000, j: out }); return { code: 200, body: out };
  } finally { RIG.busy--; }
}
// ---- /xl (X Layer hackathon, spec-xlayer-market): Rig Bridge vouchers on X Layer (ERC721Enumerable "TapeOut Rig", UUPS proxy) + the rig each one
// stands for on BNB (vault.rigs on the voucher -> circuits, circuitId, power) with mining state and pending BEM. 60 s cache, one read at a time.
const XRPCS = (E.XRPC_URLS || 'https://rpc.xlayer.tech,https://xlayerrpc.okx.com,https://xlayer.drpc.org').split(','),
  VOUCH = '0x9cfc959cd42b2e1d39a0d850c528210e818ae520', XL = { c: null, p: null }, XL_MAX = 200;
async function xmc(calls) { // Multicall3 has the same address on X Layer
  const out = []; for (let i = 0; i < calls.length; i += 100) {
    const data = I3.encodeFunctionData('aggregate3', [calls.slice(i, i + 100).map(([t, d]) => [t, true, d])]);
    out.push(...I3.decodeFunctionResult('aggregate3', await rpc('eth_call', [{ to: MC, data }, 'latest'], XRPCS))[0].map(x => x.success && x.returnData !== '0x' ? x.returnData : null)); }
  return out;
}
async function xl() {
  if (XL.c && Date.now() - XL.c.at < 60000) return XL.c.j; if (XL.p) return XL.p;
  XL.p = (async () => {
    const n = Math.min(XL_MAX, Number(BigInt(await rpc('eth_call', [{ to: VOUCH, data: '0x18160ddd' }, 'latest'], XRPCS))));
    const ids = (await xmc([...Array(n).keys()].map(i => [VOUCH, '0x4f6ccce7' + W(i)]))).filter(Boolean).map(h => BigInt(h));
    const r = await xmc(ids.flatMap(v => [[VOUCH, '0x6352211e' + W(v)], [VOUCH, '0x05244d77' + W(v)]]));
    const L = ids.map((v, k) => { const o = r[2 * k], g = r[2 * k + 1]; if (!o || !g) return null; const w = i => BigInt('0x' + g.substr(2 + i * 64, 64));
      return { v: Number(v), holder: ad(o, 0), cp: ad(g, 0), id: Number(w(2)), power: Number(w(3)), synced: Number(w(1)) }; }).filter(Boolean);
    const q = await xmc([[VOUCH, '0x12b0815f' + W(L.length ? L[0].v : 1)]]).catch(() => [null]); // quoteRedeem: OKB to send the redeem message
    const k = L.length ? await mc(L.map(x => [MINING, '0x10eafa00' + W(x.cp) + W(x.id)])) : [];
    const ok = L.map((x, i) => ({ ...x, key: k[i] })).filter(x => x.key), [g, p] = ok.length ? await Promise.all([mc(ok.map(x => [MINING, '0x0527edc2' + x.key.slice(2)])), mc(ok.map(x => [MINING, '0x1808eeb8' + x.key.slice(2)]))]) : [[], []];
    const nwd = (h, i) => h && h.length >= 2 + 64 * (i + 1) ? Number(BigInt('0x' + h.substr(2 + i * 64, 64))) : 0;
    const items = ok.map((x, i) => ({ v: x.v, holder: x.holder, cp: x.cp, id: x.id, power: x.power, synced: x.synced, st: nwd(g[i], 9), vw: nwd(g[i], 19), uw: nwd(g[i], 20), pend: p[i] ? Number(BigInt(p[i].slice(0, 66))) / 1e8 : null }));
    const j = { ok: true, t: Date.now(), chain: 196, voucher: VOUCH, proxy: 'ERC1967 UUPS', supply: n, redeemOkb: q[0] ? Number(BigInt(q[0].slice(0, 66))) / 1e18 : null, items };
    XL.c = { at: Date.now(), j }; return j;
  })().finally(() => { XL.p = null; });
  return XL.p;
}
// TapeCode-Test1 (X Layer, TapeOut founder's collection) trades on OKX NFT market, read from OKX's own web endpoints (no key), cached 60 s
const XC = { id: 20687112, ca: '0x0e91460d6823c711643e650a9a4c0cc21de41614', url: 'https://web3.okx.com/nft/collection/xlayer/tapecode-test1', c: null, p: null };
async function xc() {
  if (XC.c && Date.now() - XC.c.at < 60000) return XC.c.j; if (XC.p) return XC.p;
  const O = 'https://web3.okx.com/priapi/v1/nft/', h = { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0' };
  const get = async (r) => { const j = await r.json(); if (j.code !== 0) throw Error('okx ' + j.code); return j.data; };
  XC.p = (async () => {
    const [m, s] = await Promise.all([
      fetch(O + 'secondary/market', { method: 'POST', headers: h, body: JSON.stringify({ projectIn: [XC.id], sortBy: 'makeOrderUsd', stateIn: [], ownerAddressIn: [], nameSearch: '', priceRangeCurrency: '', priceRangeMax: '', priceRangeMin: '', pageNum: 1, pageSize: 24 }), signal: AbortSignal.timeout(15000) }).then(get),
      fetch(O + 'stats/collection/prices?inclOutlier=false&timeType=2&noWash=1&projectId=' + XC.id, { headers: h, signal: AbortSignal.timeout(15000) }).then(get)]);
    const n = x => x == null || x === '' ? null : Number(x), v = o => o && n(o.value);
    const items = (m.list || []).filter(x => x.sale && x.sale.price).map(x => ({ id: Number(x.tokenId), price: n(x.sale.price), cur: x.sale.currency, owner: x.ownerAddress, exp: x.sale.expiration || null, last: x.lastPrice ? n(x.lastPrice.price) : null }));
    const bo = (m.list || []).find(x => x.bestOffer && x.bestOffer.price);
    const j = { ok: true, t: Date.now(), chain: 196, name: 'TapeCode-Test1', contract: XC.ca, market: XC.url, floor: items.length ? items[0].price : v(s.floorPrice), bestOffer: bo ? n(bo.bestOffer.price) : null, bestOfferCur: bo ? bo.bestOffer.currency : null,
      d7: { sales: v(s.salesCount), volume: v(s.volume), avg: v(s.avgPrice) }, items };
    XC.c = { at: Date.now(), j }; return j;
  })().finally(() => { XC.p = null; });
  return XC.p;
}
// one wallet's TapeCode-Test1 NFTs (OKX index, up to 50; the site checks ownerOf on chain before any trade), cached 60 s per wallet
const XO = new Map();
async function xcOwn(a) {
  const c = XO.get(a); if (c && Date.now() - c.at < 60000) return c.j;
  const r = await fetch('https://web3.okx.com/priapi/v1/nft/secondary/market', { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000),
    body: JSON.stringify({ projectIn: [XC.id], sortBy: 'makeOrderUsd', stateIn: [], ownerAddressIn: [a], nameSearch: '', priceRangeCurrency: '', priceRangeMax: '', priceRangeMin: '', pageNum: 1, pageSize: 50 }) }).then(x => x.json());
  if (r.code !== 0) throw Error('okx ' + r.code);
  const j = { ok: true, t: Date.now(), owner: a, items: (r.data.list || []).filter(x => String(x.ownerAddress).toLowerCase() === a).map(x => ({ id: Number(x.tokenId), okxAsk: x.sale && x.sale.price ? Number(x.sale.price) : null })) };
  if (XO.size > 500) XO.clear(); XO.set(a, { at: Date.now(), j }); return j;
}
// agent gate (spec-xlayer-market D), built on first use. BEM USD = last 5m point of the pre-computed chart (same number the site shows).
let AG = null, BU = { t: 0, p: null };
function bemUsd() { const x = AGG && AGG.chart(); if (!x) return BU.p; /* keep the last good price while the chart refreshes */ if (x.t !== BU.t) { try { const tf = JSON.parse(x.body).tf, s = tf && (tf['5m'] || Object.values(tf)[0]); BU = { t: x.t, p: s && s.p && s.p.length ? s.p[s.p.length - 1] : BU.p }; } catch (e) { BU = { t: x.t, p: BU.p }; } } return BU.p; }
function agent() { return AG || (AG = { route: require('./og-agent.js')({ B, xl, xmc, mc, xrpc: (m, p) => rpc(m, p, XRPCS), bemUsd, feeTo: B.cfg(false).bidFeeTo, api: E.PUBLIC_API || 'https://api.owlgate.xyz', enabled: () => { const w = watch(); return B.enabled(!!(w && w.paused)); } }) }); }
function handler(req, res) {
  const u = new URL(req.url, 'http://x'), ip = ipOf(req);
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': ALLOW_ORIGIN, 'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '86400' }); return res.end(); }
  const p = u.pathname.replace(/\/+$/, '') || '/';
  if (/^\/(bids(\/refresh)?|free)$/.test(p)) { if (limited(ip)) return send(res, 429, { error: 'rate limit' }); const w = watch(); B.route(req, res, p, u, send, ip, !!(w && w.paused)).catch(e => { try { send(res, 500, { error: 'internal' }); } catch (x) {} console.error('bids route', e.message); }); return; }
  if (req.method !== 'GET') return send(res, 405, { error: 'GET only' });
  if (limited(ip)) return send(res, 429, { error: 'rate limit' });
  if (p === '/health') return send(res, S ? 200 : 503, health());
  if (p === '/config.json') return send(res, 200, { ...config(), listed: LISTED });
  if (p === '/rank' || p === '/tx7d' || p === '/chart' || p === '/ci7d') { const r = AGG && (p === '/rank' ? AGG.rank() : p === '/chart' ? AGG.chart() : p === '/ci7d' ? AGG.ci() : AGG.tx()); return r ? sendPre(res, r) : send(res, 503, { error: 'not ready' }); } // pre-computed site tabs, written by the tsd-agg process
  if (p === '/ev') return evCount(u, String(req.headers['user-agent'] || '')) ? send(res, 200, { ok: true }) : send(res, 400, { error: 'bad event' });
  if (p === '/funnel') return send(res, 200, funnel(u));
  if (p === '/ref/stats') { const s = refStats(u); return s ? send(res, 200, s) : send(res, 400, { error: 'bad wallet' }); }
  if (p === '/ref/code') { const c = refCode(u); return c ? send(res, 200, c) : send(res, 404, { error: 'unknown code' }); }
  if (p === '/ref') return refLog(u) ? send(res, 200, { ok: true }) : send(res, 400, { error: 'bad ref' });
  if (p.startsWith('/xl/') && agent().route(p, u, res, send)) return; // agent gate (og-agent.js): market read + unsigned tx steps
  if (p === '/xl') return xl().then(j => send(res, 200, j), e => { console.error('xl', e.message); send(res, 502, { error: 'chain read failed' }); });
  if (p === '/xc' && u.searchParams.get('owner')) { const a = String(u.searchParams.get('owner')).toLowerCase(); if (!/^0x[0-9a-f]{40}$/.test(a)) return send(res, 400, { error: 'bad wallet' }); return xcOwn(a).then(j => send(res, 200, j), e => { console.error('xc owner', e.message); send(res, 502, { error: 'okx read failed' }); }); }
  if (p === '/xc') return xc().then(j => send(res, 200, j), e => { console.error('xc', e.message); send(res, 502, { error: 'okx read failed' }); });
  if (p === '/rig') { const a = String(u.searchParams.get('a') || '').toLowerCase(); if (!/^0x[0-9a-f]{40}$/.test(a)) return send(res, 400, { error: 'bad wallet' }); return rig(a).then(r => send(res, r.code, r.body), e => { console.error('rig', e.message); send(res, 502, { error: 'chain read failed' }); }); }
  if (!S) return send(res, 503, { error: 'indexing, try again', ...health() });
  if (p === '/listings') { // ext: other-market asks, chain-verified, cost = price + buyer fee (D52). ?cp=&tid= = one circuit (site Check)
    const cp = String(u.searchParams.get('cp') || '').toLowerCase(), tid = String(u.searchParams.get('tid') || ''), one = /^0x[0-9a-f]{40}$/.test(cp) && /^\d{1,12}$/.test(tid), m = x => !one || (x.cp === cp && x.tid === tid);
    return send(res, 200, { ...health(), listed: LISTED, tu: S.tu, total: Object.keys(S.listings).length, items: listings(one || u.searchParams.get('all') === '1').filter(m).map(x => ({ ...x, src: 'cmkt', cost: x.px })), ext: EXT ? EXT.items().filter(m) : [] });
  }
  if (p === '/trades') { const h = Math.min(TRADE_DAYS * 24, Math.max(1, Number(u.searchParams.get('hours')) || 24)); return send(res, 200, { ...health(), hours: h, items: trades(h) }); }
  if (p === '/stats') return send(res, 200, { ...health(), ...stats() });
  if (p === '/stream') {
    const n = perIp.get(ip) || 0; if (subs.size >= MAX_SSE || n >= IP_SSE) return send(res, 429, { error: 'too many streams' });
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no', 'access-control-allow-origin': ALLOW_ORIGIN });
    res.write('retry: 3000\n\n'); res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot())}\n\n`);
    subs.add(res); perIp.set(ip, n + 1);
    req.on('close', () => { subs.delete(res); const m = (perIp.get(ip) || 1) - 1; if (m > 0) perIp.set(ip, m); else perIp.delete(ip); });
    return;
  }
  send(res, 404, { error: 'not found' });
}

// Watchdog: a cycle that never settles (seen 2026-10-29: cycles stuck for 30+ min, no error) froze the head and the bid re-checks.
// If no loop turn finishes within HANG_MS (bootstrap excluded: the first full read takes minutes), log and exit; pm2 restarts the process (state.json + bids SQLite are on disk).
const HANG_MS = Number(E.HANG_MS || 180000); let lastTurn = Date.now();
async function loop() {
  setInterval(() => { if ((S && Date.now() - lastTurn > HANG_MS) || (bidsBusy && Date.now() - bidsAt > HANG_MS)) { console.error(new Date().toISOString(), `watchdog: poll turn ${Math.round((Date.now() - lastTurn) / 1000)} s ago, bids tick busy ${bidsBusy ? Math.round((Date.now() - bidsAt) / 1000) + ' s' : 'no'}, exiting for pm2 restart`); process.exit(1); } }, 15000).unref();
  for (;;) {
    const t0 = Date.now(); lastTurn = t0;
    try { const r = await cycle(); meta.cycles++; if (r.boot || r.trades || r.rm || r.up > 5) console.log(new Date().toISOString(), JSON.stringify(r)); }
    catch (e) { meta.lastErr = String(e.message).slice(0, 200); meta.lastErrAt = new Date().toISOString(); console.error(meta.lastErrAt, 'cycle failed (state kept):', meta.lastErr); }
    lastTurn = Date.now();
    await new Promise(r => setTimeout(r, Math.max(500, POLL_MS - (Date.now() - t0))));
  }
}
// Bids: expire + re-check open orders on both chains on their own timer, so X Layer orders stay fresh even when the BSC poll is idle or failing
const BIDS_MS = Number(E.BIDS_MS || 10000); let bidsBusy = false, bidsAt = 0;
function bidsLoop() {
  setInterval(async () => {
    if (bidsBusy || !B.ok()) return; bidsBusy = true; bidsAt = Date.now();
    try { await B.tick(); } catch (e) { meta.lastErr = 'bids tick: ' + String(e.message).slice(0, 180); meta.lastErrAt = new Date().toISOString(); }
    finally { bidsBusy = false; }
  }, BIDS_MS).unref();
}
let EXT = null, AGG = null; // AGG: Rank / Market pre-compute (tsd-agg.js); AGG_ENABLED=0 turns it off
function initAgg() { if (LITE || E.AGG_ENABLED === '0') return null; return AGG = G.reader(DIR, E); } // the tsd-agg process writes, the API only reads
 // other-market asks (tsd-ext.js); EXT_ENABLED=0 turns it off
function initExt() { if (LITE || E.EXT_ENABLED === '0') return null; EXT = X.init({ post, rpcs: RPCS, cpus: MINERS, mining: readMine, env: E }); EXT.start(); return EXT; }
function initBids() { return B.init({ dir: DIR, rpc, mc, logs, cpus: MINERS, env: E, xl: { rpc: (m, p) => rpc(m, p, XRPCS), mc: xmc }, feeTo: E.BID_FEE_TO, head: () => ({ block: S ? S.cursor : 0, ts: S ? S.ts : 0 }), emit: () => emit('bids', B.top()) }); }
function start() {
  S = rd('state.json'); if (S && S.v !== 1) S = null; initBids();
  const srv = http.createServer(handler); srv.listen(PORT, HOST, () => console.log(`tsd-api ${VERSION} on ${HOST}:${PORT}, state ${DIR}, rpc ${RPCS[0]}`));
  setInterval(() => { for (const c of subs) try { c.write(': ping\n\n'); } catch (e) {} }, 15000).unref();
  loop(); bidsLoop(); initExt(); initAgg();
  return srv;
}
async function main() {
  if (has('--once')) { S = rd('state.json'); if (S && S.v !== 1) S = null; let r; do { r = await cycle(); console.log(JSON.stringify(r)); } while (!r.idle && !r.boot && r.block < r.head - CONF); console.log(JSON.stringify(stats())); return; }
  start();
}
module.exports = { LISTED, CPUS, _fullPass: fullPass, _fr: FR, readListings, readNext, soldRec, health, stats, handler, cycle, config, initBids, readMine, _setExt: x => { EXT = x; }, _setAgg: x => { AGG = x; }, _rpc: rpc, _mc: mc, _logs: logs, DIR, B, _state: () => S, _set: s => { S = s; }, CMKT, CPUS };
if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
