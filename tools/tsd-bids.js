// TSD bids (D42 P2 / D44): order store for signed Seaport 1.6 WBNB offers on ONE circuit token (no collection bids).
// Non-custodial: we store only public signed orders; Seaport enforces them. The site builds every tx itself from the order.
// Order template (anything else is rejected): offer = WBNB price; consideration[0] = circuit ERC721 (cp,tid) -> offerer,
// consideration[1] = WBNB fee (price*75/10000, floor) -> FEE_TO. FULL_OPEN, no zone, no conduit.
// Free offers (founder 2026-10-27; set to 0 on 2026-10-29: big sweeps made free slots cost too much): each offerer's first FREE_N offers carry NO fee item (consideration = NFT only).
// A slot is used by an open, inactive or filled free offer; cancelled / expired ones give it back. From then on the 0.75% fee item is required.
// Seller accepts with fulfillBasicOrder (route ERC721_TO_ERC20, type 16): fee comes out of the offer, seller nets price - fee
// and needs only the per-token NFT approval (fork test SeaportFork test_7).
// Kill switch: POST only when BIDS_ENABLED=1 and the watchtower is not paused. Reads, fills, cancels keep being tracked.
// X Layer (chain 196, spec-xlayer-market B, fork test XLSeaportFork): same Seaport 1.6 address, Rig Bridge vouchers, WOKB, three kinds:
//   offer = WOKB offer on one voucher (template above, WOKB/voucher), coll = same with consideration[0] itemType 4 + criteria 0 (any voucher,
//   accepted via matchAdvancedOrders), list = offer voucher, consideration native OKB (price - fee) -> seller [+ OKB fee -> FEE_TO] (bought via
//   fulfillBasicOrder ETH_TO_ERC721). Same fee terms; the FREE_N fee-free slots are shared by all kinds and chains. 196 has no log feed here:
//   fills/cancels/counter are found by the REVAL_MS re-check (getOrderStatus, counter) and /bids/refresh.
const path = require('path'), fs = require('fs');
const { ethers } = require('ethers');

const SEAPORT = '0x0000000000000068f116a894984e2db1123eb395', WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', ZERO = '0x' + '0'.repeat(40), Z32 = '0x' + '0'.repeat(64);
const WOKB = '0xe538905cf8410324e03a5a23c1c177a474d59b2b', VOUCH = '0x9cfc959cd42b2e1d39a0d850c528210e818ae520';
const TCT1 = '0x0e91460d6823c711643e650a9a4c0cc21de41614', XL_TOKS = [VOUCH, TCT1]; // s61: TapeCode-Test1 (TapeOut founder's collection) on the same Seaport book, same fee
const T_OF = '0x9d9af8e38d66c62e2c12f0225249fd9d721c54b83f48d9352c97c6cacdcb6f31', T_OC = '0x6bacc01dbe442496068f7d234edd811f1a5f833243e0aec824f86ab861f3c90d',
  T_CI = '0x721c20121297512b72821b97f5326877ea8ecf4bb9948fea5bfcb6453074d37f', T_TR = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const FEE_BPS = 75n, FREE_N = 0, MAX_OPEN = 20, EXP_MIN = 600, EXP_MAX = 7 * 86400, REVAL_MS = 60000, MAX_WEI = 500n * 10n ** 18n;
const TYPES = {
  OrderComponents: [{ name: 'offerer', type: 'address' }, { name: 'zone', type: 'address' }, { name: 'offer', type: 'OfferItem[]' }, { name: 'consideration', type: 'ConsiderationItem[]' }, { name: 'orderType', type: 'uint8' }, { name: 'startTime', type: 'uint256' }, { name: 'endTime', type: 'uint256' }, { name: 'zoneHash', type: 'bytes32' }, { name: 'salt', type: 'uint256' }, { name: 'conduitKey', type: 'bytes32' }, { name: 'counter', type: 'uint256' }],
  OfferItem: [{ name: 'itemType', type: 'uint8' }, { name: 'token', type: 'address' }, { name: 'identifierOrCriteria', type: 'uint256' }, { name: 'startAmount', type: 'uint256' }, { name: 'endAmount', type: 'uint256' }],
  ConsiderationItem: [{ name: 'itemType', type: 'uint8' }, { name: 'token', type: 'address' }, { name: 'identifierOrCriteria', type: 'uint256' }, { name: 'startAmount', type: 'uint256' }, { name: 'endAmount', type: 'uint256' }, { name: 'recipient', type: 'address' }],
};
const DOMAIN = { name: 'Seaport', version: '1.6', chainId: 56, verifyingContract: SEAPORT }, DOM = { 56: DOMAIN, 196: { ...DOMAIN, chainId: 196 } };
const W = n => BigInt(n).toString(16).padStart(64, '0'), wd = (h, i) => BigInt('0x' + (String(h).replace(/^0x/, '').substr(i * 64, 64) || '0'));
const tad = x => '0x' + String(x).slice(26).toLowerCase(), lc = s => String(s).toLowerCase();
const isU = s => typeof s === 'string' && /^\d{1,78}$/.test(s), isA = s => typeof s === 'string' && /^0x[0-9a-fA-F]{40}$/.test(s);

let db = null, X = null, lastReval = 0, onChange = () => {};
const st = {}; // prepared statements
// opts: {dir, rpc, mc, logs, cpus, feeTo, env, head:()=>({block,ts}), emit}
function init(opts) {
  X = opts; onChange = opts.emit || onChange;
  X.feeTo = lc(opts.feeTo || '0x58f341ebf80ab52d7650750119e8641cfbc8c018'); // founder fee wallet (same as TsdRouter feeRecipient)
  try {
    const { DatabaseSync } = require('node:sqlite'); // Node >= 22.13 (built in, no npm dep)
    fs.mkdirSync(opts.dir, { recursive: true });
    db = new DatabaseSync(path.join(opts.dir, 'bids.db'));
    db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS orders(hash TEXT PRIMARY KEY, offerer TEXT, cp TEXT, tid TEXT, price TEXT, px REAL, fee TEXT, start_t INTEGER, end_t INTEGER,
        counter TEXT, o TEXT, sig TEXT, status TEXT, reason TEXT, created INTEGER, cblock INTEGER, updated INTEGER, fill_tx TEXT, fill_block INTEGER, seller TEXT);
      CREATE INDEX IF NOT EXISTS o_tok ON orders(cp, tid, status); CREATE INDEX IF NOT EXISTS o_off ON orders(offerer, status); CREATE INDEX IF NOT EXISTS o_st ON orders(status);`);
    for (const c of ['chain INTEGER NOT NULL DEFAULT 56', "kind TEXT NOT NULL DEFAULT 'offer'"]) try { db.exec('ALTER TABLE orders ADD COLUMN ' + c); } catch (e) {} // s38 X Layer (exists already: ignore)
    db.exec('CREATE INDEX IF NOT EXISTS o_ch ON orders(chain, status)');
    const P = (k, q) => { st[k] = db.prepare(q); };
    P('ins', 'INSERT INTO orders(hash,offerer,cp,tid,price,px,fee,start_t,end_t,counter,o,sig,status,reason,created,cblock,updated,chain,kind) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    P('get', 'SELECT * FROM orders WHERE hash=?');
    P('setSt', 'UPDATE orders SET status=?, reason=?, updated=? WHERE hash=?');
    P('fill', "UPDATE orders SET status='filled', reason=NULL, updated=?, fill_tx=?, fill_block=?, seller=? WHERE hash=?");
    P('live', "SELECT * FROM orders WHERE status IN ('open','inactive')");
    P('tok', "SELECT * FROM orders WHERE cp=? AND tid=? AND status='open' AND kind='offer' ORDER BY px DESC, created ASC LIMIT 50");
    P('chn', "SELECT * FROM orders WHERE chain=? AND status='open' ORDER BY created DESC LIMIT 300");
    P('off', 'SELECT * FROM orders WHERE offerer=? ORDER BY created DESC LIMIT 50');
    P('nOpen', "SELECT COUNT(*) n FROM orders WHERE offerer=? AND status IN ('open','inactive')");
    P('top', "SELECT cp, tid, MAX(px) px, COUNT(*) n FROM orders WHERE status='open' AND chain=56 GROUP BY cp, tid ORDER BY px DESC LIMIT 50");
    P('cnt', "SELECT COUNT(*) n FROM orders WHERE status='open' AND chain=56");
    P('exp', "UPDATE orders SET status='expired', reason=NULL, updated=? WHERE status IN ('open','inactive') AND end_t<=?");
    P('nFree', "SELECT COUNT(*) n FROM orders WHERE offerer=? AND fee='0' AND status IN ('open','inactive','filled')");
  } catch (e) { db = null; console.error('bids store unavailable (needs Node >= 22.13 with node:sqlite):', e.message); }
  return !!db;
}
const ok = () => !!db;
const nowS = () => Math.floor(Date.now() / 1e3);
const enabled = paused => !!db && X.env.BIDS_ENABLED === '1' && !paused;
const cfg = paused => ({ bidsEnabled: enabled(paused), bidFeeBps: Number(FEE_BPS), bidFeeTo: X ? X.feeTo : null, freeN: FREE_N, seaport: SEAPORT, wbnb: WBNB,
  xl: { on: !!(X && X.xl), chain: 196, wokb: WOKB, voucher: VOUCH, tokens: XL_TOKS } });

// ---- order template check + EIP-712 hash + signer ----
function parse(body, now = nowS()) {
  const o = body && body.order, sig = body && body.signature;
  if (!o || typeof o !== 'object' || typeof sig !== 'string' || !/^0x[0-9a-fA-F]{128}([0-9a-fA-F]{2})?$/.test(sig)) return { err: 'shape' };
  const keys = TYPES.OrderComponents.map(x => x.name);
  if (Object.keys(o).sort().join() !== [...keys].sort().join()) return { err: 'shape' };
  if (!isA(o.offerer) || lc(o.zone) !== ZERO || lc(o.zoneHash) !== Z32 || lc(o.conduitKey) !== Z32 || Number(o.orderType) !== 0 || String(o.orderType) !== '0') return { err: 'template' };
  if (![o.startTime, o.endTime, o.salt, o.counter].every(isU)) return { err: 'shape' };
  const chain = body.chain == null ? 56 : body.chain; // absent = BSC (the BSC site never sends it)
  if (chain !== 56 && chain !== 196) return { err: 'chain' };
  if (chain === 196 && !X.xl) return { err: 'chain' };
  if (!Array.isArray(o.offer) || o.offer.length !== 1 || !Array.isArray(o.consideration) || ![1, 2].includes(o.consideration.length)) return { err: 'template' };
  const of = o.offer[0], c0 = o.consideration[0], c1 = o.consideration[1], free = !c1, off = lc(o.offerer);
  const okItem = (x, n) => x && typeof x === 'object' && Object.keys(x).length === n && [x.identifierOrCriteria, x.startAmount, x.endAmount].every(isU) && isA(x.token) && (n === 5 || isA(x.recipient));
  if (!okItem(of, 5) || !okItem(c0, 6) || (!free && !okItem(c1, 6))) return { err: 'shape' };
  const min = BigInt(X.env.BID_MIN_WEI || 10n ** 16n), it = x => String(x.itemType);
  let kind, cp, tid, price, fee;
  if (chain === 196 && it(of) === '2') { // listing: voucher for native OKB
    kind = 'list'; cp = lc(of.token); tid = of.identifierOrCriteria;
    if (!XL_TOKS.includes(cp) || of.startAmount !== '1' || of.endAmount !== '1') return { err: 'token' };
    const nat = x => it(x) === '0' && lc(x.token) === ZERO && x.identifierOrCriteria === '0' && x.startAmount === x.endAmount;
    if (!nat(c0) || lc(c0.recipient) !== off) return { err: 'template' };
    price = BigInt(c0.startAmount) + (free ? 0n : BigInt(c1.startAmount)); fee = free ? 0n : price * FEE_BPS / 10000n;
    if (!free && (!nat(c1) || lc(c1.recipient) !== X.feeTo || BigInt(c1.startAmount) !== fee)) return { err: 'fee' };
  } else { // offer: wrapped native for one token (or, on 196, any voucher)
    const w = chain === 196 ? WOKB : WBNB;
    if (it(of) !== '1' || lc(of.token) !== w || of.identifierOrCriteria !== '0' || of.startAmount !== of.endAmount) return { err: 'template' };
    cp = lc(c0.token); tid = c0.identifierOrCriteria; kind = chain === 196 && it(c0) === '4' ? 'coll' : 'offer';
    const toks = chain === 196 ? XL_TOKS : X.cpus;
    if ((kind === 'coll' ? tid !== '0' : it(c0) !== '2') || !toks.includes(cp) || c0.startAmount !== '1' || c0.endAmount !== '1' || lc(c0.recipient) !== off) return { err: 'token' };
    price = BigInt(of.startAmount); fee = free ? 0n : price * FEE_BPS / 10000n;
    if (!free && (it(c1) !== '1' || lc(c1.token) !== w || c1.identifierOrCriteria !== '0' || c1.startAmount !== c1.endAmount || lc(c1.recipient) !== X.feeTo || BigInt(c1.startAmount) !== fee)) return { err: 'fee' };
  }
  if (price < min || price > MAX_WEI) return { err: 'price' };
  const start = Number(o.startTime), end = Number(o.endTime);
  if (start > now + 120 || end <= start || end - now < EXP_MIN || end - now > EXP_MAX + 600) return { err: 'expiry' };
  const n = x => ({ ...x, itemType: Number(x.itemType) }), v = { ...o, orderType: 0, offer: [n(of)], consideration: o.consideration.map(n) };
  let hash, who;
  try { hash = ethers.TypedDataEncoder.hashStruct('OrderComponents', TYPES, v); who = lc(ethers.verifyTypedData(DOM[chain], TYPES, v, sig)); } catch (e) { return { err: 'signature' }; }
  if (who !== off) return { err: 'signature' };
  return { hash, offerer: off, cp, tid, price, fee, start, end, counter: o.counter, o: v, sig, chain, kind };
}

// ---- chain truth for a set of orders: counter, Seaport status, then offers: balance/allowance of the wrapped native + token owner;
// listings: the seller still holds the voucher and Seaport may move it ----
const chainOf = r => r.chain || 56, kindOf = r => r.kind || 'offer';
function calls(r) {
  const w = chainOf(r) === 196 ? WOKB : WBNB, k = kindOf(r), c = [[SEAPORT, '0xf07ec373' + W(r.offerer)], [SEAPORT, '0x46423aa7' + r.hash.slice(2)]];
  if (k === 'list') return c.concat([[r.cp, '0x6352211e' + W(r.tid)], [r.cp, '0x081812fc' + W(r.tid)], [r.cp, '0xe985e9c5' + W(r.offerer) + W(SEAPORT)]]); // ownerOf, getApproved, isApprovedForAll
  return c.concat([[w, '0x70a08231' + W(r.offerer)], [w, '0xdd62ed3e' + W(r.offerer) + W(SEAPORT)]], k === 'coll' ? [] : [[r.cp, '0x6352211e' + W(r.tid)]]);
}
function judge(r, g, now) {
  const [ctr, sts, a, b, c] = g, p = BigInt(r.price);
  if (sts && wd(sts, 1) !== 0n) return { status: 'cancelled', reason: 'cancel' };
  if (sts && wd(sts, 2) !== 0n) return { status: 'filled', reason: 'chain' };
  if (!ctr || wd(ctr, 0) !== BigInt(r.counter)) return { status: 'cancelled', reason: 'counter' };
  if (r.end_t <= now) return { status: 'expired', reason: null };
  if (kindOf(r) === 'list') {
    if (!a) return { status: 'inactive', reason: 'token' };
    if (tad(a) !== r.offerer) return { status: 'inactive', reason: 'moved' };
    if (!(b && tad(b) === SEAPORT) && !(c && wd(c, 0) !== 0n)) return { status: 'inactive', reason: 'approval' };
    return { status: 'open', reason: null };
  }
  if (kindOf(r) === 'offer') { if (!c) return { status: 'inactive', reason: 'token' }; if (tad(c) === r.offerer) return { status: 'inactive', reason: 'own' }; }
  if (!a || wd(a, 0) < p) return { status: 'inactive', reason: 'balance' };
  if (!b || wd(b, 0) < p) return { status: 'inactive', reason: 'allowance' };
  return { status: 'open', reason: null };
}
async function check(rows, now = nowS()) {
  if (!rows.length) return [];
  const out = new Array(rows.length);
  for (const ch of [56, 196]) {
    const ix = rows.map((r, i) => i).filter(i => chainOf(rows[i]) === ch); if (!ix.length) continue;
    const cs = ix.map(i => calls(rows[i])); let g;
    if (ch === 56) g = await X.mc(cs.flat());
    else try { g = await X.xl.mc(cs.flat()); } catch (e) { continue; } // X Layer RPC down: those rows stay null (unchanged), BSC is not held up
    let k = 0; ix.forEach((i, j) => { out[i] = judge(rows[i], g.slice(k, k + cs[j].length), now); k += cs[j].length; });
  }
  return out; // null = not read
}

// ---- fills ----
// counterparty of the fill (column "seller"): the NFT sender for offers, the buyer (NFT receiver) for listings
const rpcOf = r => chainOf(r) === 196 ? X.xl.rpc : X.rpc;
async function sellerOf(r, txh, recipient) {
  try {
    const rc = await rpcOf(r)('eth_getTransactionReceipt', [txh]), k = kindOf(r);
    const l = (rc && rc.logs || []).find(x => lc(x.address) === r.cp && x.topics[0] === T_TR && x.topics.length === 4 && (k === 'coll' ? tad(x.topics[2]) === r.offerer : BigInt(x.topics[3]) === BigInt(r.tid)));
    if (l) return tad(l.topics[k === 'list' ? 2 : 1]);
  } catch (e) {}
  return recipient || null;
}
async function recordFill(r, txh, block, recipient) {
  const seller = await sellerOf(r, txh, recipient), t = nowS();
  st.fill.run(t, txh, block, seller, r.hash);
  return seller;
}
// filled seen only via getOrderStatus (missed event, e.g. after a reorg rewind or downtime): find the fill log
async function findFill(r) {
  try {
    const R = rpcOf(r), head = parseInt(await R('eth_blockNumber', []), 16), q = { address: SEAPORT, topics: [T_OF, '0x' + W(r.offerer)] }, hx = n => '0x' + n.toString(16);
    const L = chainOf(r) === 196 ? await R('eth_getLogs', [{ ...q, fromBlock: hx(Math.max(1, head - 5000)), toBlock: hx(head) }]) // recent fills only (refresh right after the tx)
      : await X.logs(q, Math.max(1, (r.cblock || head) - 10), head);
    const l = L.find(x => lc('0x' + x.data.slice(2, 66)) === r.hash);
    if (l) return recordFill(r, l.transactionHash, parseInt(l.blockNumber, 16), tad('0x' + x64(l.data, 1)));
  } catch (e) {}
  st.fill.run(nowS(), null, null, null, r.hash); return null;
}
const x64 = (d, i) => String(d).replace(/^0x/, '').substr(i * 64, 64);

// Seaport logs from the indexer cycle (already reorg-safe: up to head-CONF)
async function onLogs(L) {
  if (!db || !L.length) return 0;
  let ch = 0;
  for (const l of L) {
    const k = l.topics[0];
    if (k === T_OF || k === T_OC) {
      const h = lc('0x' + x64(l.data, 0)), r = st.get.get(h); if (!r || chainOf(r) !== 56 || (r.status === 'filled' && r.fill_tx)) continue; // BSC log feed: BSC orders only; // filled via getOrderStatus but log not seen yet: record now
      if (k === T_OF) await recordFill(r, l.transactionHash, parseInt(l.blockNumber, 16), tad('0x' + x64(l.data, 1)));
      else st.setSt.run('cancelled', 'cancel', nowS(), h);
      ch++;
    } else if (k === T_CI && l.topics[1]) {
      const off = tad(l.topics[1]), nc = wd(l.data, 0);
      for (const r of st.off.all(off)) if (chainOf(r) === 56 && (r.status === 'open' || r.status === 'inactive') && BigInt(r.counter) < nc) { st.setSt.run('cancelled', 'counter', nowS(), r.hash); ch++; }
    }
  }
  if (ch) onChange();
  return ch;
}
// every indexer cycle: expire; every REVAL_MS (or force): re-check all open/inactive orders against the chain
async function tick(force = false) {
  if (!db) return 0;
  const t = nowS(); let ch = Number(st.exp.run(t, t).changes || 0);
  if (force || Date.now() - lastReval > REVAL_MS) {
    lastReval = Date.now(); const rows = st.live.all();
    for (let i = 0; i < rows.length; i += 100) {
      const part = rows.slice(i, i + 100), res = await check(part, t);
      for (let k = 0; k < part.length; k++) {
        const r = part[k], x = res[k]; if (!x || (x.status === r.status && x.reason === r.reason)) continue;
        if (x.status === 'filled') await findFill(r); else st.setSt.run(x.status, x.reason, t, r.hash);
        ch++;
      }
    }
  }
  if (ch) onChange();
  return ch;
}

// ---- read models ----
const pub = r => ({ hash: r.hash, offerer: r.offerer, cp: r.cp, tid: r.tid, price: r.price, px: r.px, fee: r.fee, start: r.start_t, end: r.end_t, status: r.status, reason: r.reason, created: r.created, fillTx: r.fill_tx || null, seller: r.seller || null, chain: chainOf(r), kind: kindOf(r), order: JSON.parse(r.o), signature: r.sig });
const top = () => ({ count: st.cnt.get().n, items: st.top.all().map(x => ({ cp: x.cp, tid: x.tid, px: x.px, n: x.n })) });
function free(w) { const used = Math.min(FREE_N, st.nFree.get(lc(w)).n); return { wallet: lc(w), used, max: FREE_N, left: FREE_N - used }; }

// ---- HTTP (called by tsd-api handler; returns true when handled) ----
const posts = new Map();
setInterval(() => { const n = Date.now(); for (const [k, h] of posts) if (n - h.t > 120000) posts.delete(k); }, 60000).unref();
function postLimited(ip) { const n = Date.now(), h = posts.get(ip) || { t: n, n: 0 }; if (n - h.t > 60000) { h.t = n; h.n = 0; } h.n++; posts.set(ip, h); return h.n > 20; }
function body(req) {
  return new Promise((res, rej) => { let s = ''; req.setEncoding('utf8'); req.on('data', d => { s += d; if (s.length > 8192) { rej(Object.assign(Error('too large'), { code: 413 })); req.destroy(); } }); req.on('end', () => { try { res(JSON.parse(s)); } catch (e) { rej(Object.assign(Error('bad json'), { code: 400 })); } }); req.on('error', rej); });
}
async function route(req, res, p, u, send, ip, paused) {
  if (p !== '/bids' && p !== '/bids/refresh' && p !== '/free') return false;
  if (!db) { send(res, 503, { error: 'bids store unavailable' }); return true; }
  if (req.method === 'GET') {
    if (p === '/free') { const w = u.searchParams.get('wallet'); if (!isA(w)) send(res, 400, { error: 'wallet' }); else send(res, 200, free(w)); return true; }
    if (p !== '/bids') { send(res, 405, { error: 'POST only' }); return true; }
    const cp = u.searchParams.get('cp'), tid = u.searchParams.get('tid'), off = u.searchParams.get('offerer'), chn = u.searchParams.get('chain');
    if (chn) { if (chn !== '56' && chn !== '196') send(res, 400, { error: 'chain' }); else send(res, 200, { ...cfg(paused), items: st.chn.all(Number(chn)).map(pub) }); return true; } // whole open book of one chain (X Layer market)
    if (cp || tid) { if (!isA(cp) || !isU(tid)) send(res, 400, { error: 'cp/tid' }); else send(res, 200, { ...cfg(paused), items: st.tok.all(lc(cp), tid).map(pub) }); return true; }
    if (off) { if (!isA(off)) send(res, 400, { error: 'offerer' }); else send(res, 200, { ...cfg(paused), items: st.off.all(lc(off)).map(pub) }); return true; }
    send(res, 200, { ...cfg(paused), ...top() }); return true;
  }
  if (req.method !== 'POST') { send(res, 405, { error: 'GET/POST only' }); return true; }
  if (postLimited(ip)) { send(res, 429, { error: 'rate limit' }); return true; }
  let b; try { b = await body(req); } catch (e) { send(res, e.code || 400, { error: e.message }); return true; }
  if (p === '/bids/refresh') {
    const h = b && typeof b.hash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(b.hash) ? lc(b.hash) : null, r = h && st.get.get(h);
    if (!r) { send(res, 404, { error: 'unknown order' }); return true; }
    if (r.status === 'open' || r.status === 'inactive') {
      try { const [x] = await check([r]); if (!x) throw Error('unread'); if (x.status === 'filled') await findFill(r); else if (x.status !== r.status || x.reason !== r.reason) st.setSt.run(x.status, x.reason, nowS(), h); onChange(); }
      catch (e) { send(res, 502, { error: 'chain read failed' }); return true; }
    }
    send(res, 200, pub(st.get.get(h))); return true;
  }
  if (!enabled(paused)) { send(res, 403, { error: 'bids disabled' }); return true; }
  const v = parse(b); if (v.err) { send(res, 400, { error: v.err }); return true; }
  if (st.get.get(v.hash)) { send(res, 409, { error: 'duplicate', hash: v.hash }); return true; }
  if (st.nOpen.get(v.offerer).n >= MAX_OPEN) { send(res, 429, { error: 'too many open bids', max: MAX_OPEN }); return true; }
  const row = { hash: v.hash, offerer: v.offerer, cp: v.cp, tid: v.tid, price: v.price.toString(), end_t: v.end, counter: v.counter, chain: v.chain, kind: v.kind };
  let x; try { [x] = await check([row]); if (!x) throw Error('unread'); } catch (e) { send(res, 502, { error: 'chain read failed' }); return true; }
  if (x.status !== 'open') { send(res, 400, { error: x.reason || x.status }); return true; }
  if (v.fee === 0n && free(v.offerer).left <= 0) { send(res, 400, { error: 'free offers used, sign with the 0.75% fee', max: FREE_N }); return true; } // checked right before the insert (no await in between)
  const t = nowS();
  st.ins.run(v.hash, v.offerer, v.cp, v.tid, row.price, Number(v.price) / 1e18, v.fee.toString(), v.start, v.end, v.counter, JSON.stringify(v.o), v.sig, 'open', null, t, v.chain === 56 ? X.head().block || 0 : 0, t, v.chain, v.kind);
  onChange();
  send(res, 201, { hash: v.hash, status: 'open' }); return true;
}

const book = ch => db ? st.chn.all(ch).map(pub) : [], one = h => { const r = db && st.get.get(lc(h)); return r ? pub(r) : null; }; // agent gate (og-agent.js)
module.exports = { init, ok, enabled, cfg, parse, check, onLogs, tick, route, free, recordFill, top, book, one, TYPES, DOMAIN, DOM, SEAPORT, WBNB, WOKB, VOUCH, TCT1, XL_TOKS, T_OF, T_OC, T_CI, FEE_BPS, FREE_N, _db: () => db };
