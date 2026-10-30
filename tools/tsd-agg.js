// Server-side pre-compute for the site's Rank (miners/processors) and Market > Transistors tabs (speed: 54 / 51 browser RPC calls, ~33 s / ~10 s
// on first open, measured 19/10). Same chain reads and maths as app/index.html loadN / loadM_; the site keeps its own chain path as fallback
// and for Reload. Output carries no formatted text: on-chain names are raw strings (capped), the site escapes and formats them.
// Runs as its OWN process (pm2 tsd-agg: node tsd-agg.js), so its RPC work and memory never touch the API process (a soak with it inside
// tsd-api kept ~150 MB live heap and 600+ MB rss). It writes <API dir>/agg-rank.json and agg-tx.json (atomic); tsd-api only reads them (reader()).
// Rank refreshes every AGG_RANK_S (300), tx every AGG_TX_S (60) with incremental logs, circuits (agg-ci.json, /ci7d) every AGG_CI_S (120). Missing or old file -> API 503 -> site reads the chain.
const MINING = '0x7e2e0dc66a3bd9103e69b766afa62d9f7b697b46', P1 = '0x3098d7a051045000d68ec0360753a40c8cabea31', FACT = '0x68224f668083c29e9800be2a646d42d18cedf7e2', MARKET = '0xa6a80c1919a8326022d7c601a488888c13aa16e4',
  MC = '0xca11bde05977b3631167028862be2a173976ca11', LA = '0x000000000000000000000000000000000000beef',
  T_PL = '0xcc402b0b2e84e03a81c9a55a11a5a69d5384a8d29c888c6867ecbc8c9ecd51c8', T_FI = '0x8ba8eb46b242dd0e7d9a947ab90d7b1e2dc565ba3e3fc7b1e95de9dc60812a65',
  T_CA = '0x434f408152dd2123c65c37cf2f87c99b796232777a79d6e67484bcc946bd51c3',
  CMKT = '0x6feebbebc07bcb90bd1ac8b0cf9baa4f0ff2b46f', T_LI = '0x723f73331eaee88eec7fc68ef60ab6ed15e4b90d0472b55eb92fa43910bab6dd', T_SO = '0x2938a0a3a4a7c19c3a1fe6ef25340b7acd26dfac11de87836084d42fccc18656',
  T_DE = '0xd42ab404868acd93610bdba51d0b4ae458bc5b37febb299ae73fe44060fa9882', T_PC = '0x8aa4fa52648a6d15edce8a179c792c86f3719d0cc3c572cf90f91948f0f2cb68', T_TR = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const LC = '0x60003560601b6080526020356104005b8160403511156100c557816094526034608020630527edc260e01b6000526004526000600060246000737e2e0dc66a3bd9103e69b766afa62d9f7b697b465afa506102803d106100bb5760806101206101003e60206102606101803e61010051156100bb576101205160601b6101805163ffffffff1660401b1761014051620fffff16602c1b1761016051620fffff1660181b1761010051600f1660141b1782620fffff161781526020015b906001019061000f565b6104009003610400f3'; // lens runtime bytecode, identical to LC in app/index.html (verify-agg.js checks it)
const W = n => BigInt(n).toString(16).padStart(64, '0'), hx = n => '0x' + n.toString(16);
const wd = (h, i) => BigInt('0x' + (String(h).replace(/^0x/, '').substr(i * 64, 64) || '0'));
const nw = (h, i, d = 0) => Number(wd(h, i)) / 10 ** d;
const ad = (h, i) => '0x' + String(h).replace(/^0x/, '').substr(i * 64 + 24, 40).toLowerCase();
const tad = x => '0x' + String(x).slice(26).toLowerCase();
const str = (h, o) => { try { const x = h.slice(2); o = o ?? Number(wd(h, 0)); const n = Number(wd(h, o / 32)); return Buffer.from(x.substr((o + 32) * 2, n * 2), 'hex').toString('utf8').slice(0, 64); } catch (e) { return ''; } };
const med = a => { const s = a.filter(x => x != null && isFinite(x)).sort((x, y) => x - y); return s.length ? s[s.length >> 1] : null; };
const tick = () => new Promise(z => setImmediate(z));
async function pool(items, n, fn) { const out = new Array(items.length); let i = 0; await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } })); return out; }

function init(o) {
  const { rpc, mc, logs, env = {}, dir = null } = o;
  const RANK_S = Number(env.AGG_RANK_S || 300), TX_S = Number(env.AGG_TX_S || 60), CH_S = Number(env.AGG_CHART_S || 30), CI_S = Number(env.AGG_CI_S || 120), on = env.AGG_ENABLED !== '0';
  const st = { rank: null, tx: null, chart: null, ci: null, rankErr: null, txErr: null, chartErr: null, ciErr: null, cg: [], cgTo: 0, cr: new Map(), cw: new Map(), cn: new Map(), pt: new Map(), born: 0, cpus: null, cpusAt: 0, lg: [], lgTo: 0, pl: new Map(), cd: new Map(), fr: new Map() };
  const bound = (m, n) => { if (m.size > n) for (const k of [...m.keys()].slice(0, m.size - n)) m.delete(k); };

  // ---- rank (= site loadN) ----
  async function cpus() { // processor list changes rarely: daily, like the site's localStorage cache
    if (st.cpus && Date.now() - st.cpusAt < 864e5) return st.cpus;
    const n = nw(await rpc('eth_call', [{ to: FACT, data: '0xa94da8a7' }, 'latest']), 0);
    const a = (await mc([...Array(n).keys()].map(i => [FACT, '0x4bc7cbbd' + W(i)]))).map(x => x && ad(x, 0)), m = await mc(a.map(x => [MINING, '0x0f03daba' + W(x || 0)]));
    const ok = a.filter((x, i) => x && m[i] && wd(m[i], 0) > 0n), r = await mc(ok.flatMap(x => [[x, '0x06fdde03'], [x, '0x6fbd1719']]));
    st.cpus = ok.map((a, i) => ({ a, nr: r[2 * i] ? str(r[2 * i]) : '', tr: r[2 * i + 1] ? ad(r[2 * i + 1], 0) : null })); st.cpusAt = Date.now(); return st.cpus;
  }
  async function rank() {
    const C = await cpus(), head = parseInt(await rpc('eth_blockNumber', []), 16);
    const r = await mc(C.flatMap(c => [[MINING, '0x0f03daba' + W(c.a)], [c.a, '0x61b8ce8c']])), cs = C.map((c, i) => ({ ...c, m: r[2 * i] ? nw(r[2 * i], 0) : 0, nx: r[2 * i + 1] ? nw(r[2 * i + 1], 0) : 0 })).filter(c => c.m > 0);
    const q = []; cs.forEach((c, ci) => { for (let b = 0; b < c.nx; b += 1000) q.push([ci, b, Math.min(b + 1000, c.nx)]); });
    const R = [];
    await pool(q, 3, async ([ci, a, b]) => {
      const h = await rpc('eth_call', [{ to: LA, data: '0x' + W(cs[ci].a) + W(a) + W(b), gas: '0x3b9aca00' }, 'latest', { [LA]: { code: LC } }]);
      if (!/^0x([0-9a-f]{64})*$/.test(h)) throw Error('lens shape');
      for (let k = 2; k < h.length; k += 64) { const x = BigInt('0x' + h.substr(k, 64)); R.push({ c: ci, id: Number(x & 0xfffffn), st: Number(x >> 20n & 15n), l: Number(x >> 24n & 0xfffffn), n: Number(x >> 44n & 0xfffffn), w: Number(x >> 64n & 0xffffffffn), o: '0x' + (x >> 96n).toString(16).padStart(40, '0') }); }
      await tick();
    });
    const A = R.filter(x => x.st === 1), own = {}; for (const x of A) { const o = own[x.o] || (own[x.o] = { a: x.o, n: 0, w: 0 }); o.n++; o.w += x.w; }
    await tick();
    cs.forEach((c, ci) => { const a = A.filter(x => x.c === ci); Object.assign(c, { k: a.length, u: new Set(a.map(x => x.o)).size, w: a.reduce((s, x) => s + x.w, 0), tn: a.reduce((s, x) => s + x.n, 0), tl: a.reduce((s, x) => s + x.l, 0), wpt: med(a.map(x => x.n + x.l ? x.w / (x.n + x.l) : null)) }); });
    // owner index for the bot's /rig (D53): written to its own file, never served whole. compact: owner -> [[processorIdx, id, state], ...]
    // owner = ownerOf for every token of the 2 mining CPUs (audit s35: the lens skips never-registered rigs and its owner is the mining record's,
    // which stays on the seller after a transfer, so buyers saw 0 rigs). State from the lens, 0 when not registered. Other processors: lens owner.
    const RIGC = ['0xb1024b89886b9a34aa4ff5f31c411d708b20a14c', '0x1f5cb4aeae1807bf60c3b9c0d8adbcc14e91f12c'], sm = new Map(R.map(x => [x.c + ':' + x.id, x.st])), oi = {}, full = new Set();
    for (let ci = 0; ci < cs.length; ci++) { if (!RIGC.includes(cs[ci].a)) continue;
      const ow = await mc([...Array(cs[ci].nx).keys()].map(id => [cs[ci].a, '0x6352211e' + W(id)])).catch(() => null); if (!ow) continue; full.add(ci);
      ow.forEach((h, id) => { if (!h) return; const o = ad(h, 0); (oi[o] || (oi[o] = [])).push([ci, id, sm.get(ci + ':' + id) || 0]); }); await tick(); }
    for (const x of R) if (!full.has(x.c)) (oi[x.o] || (oi[x.o] = [])).push([x.c, x.id, x.st]);
    st.own = { ok: true, block: head, t: Date.now(), cs: cs.map(c => c.a), o: oi };
    return { ok: true, block: head, t: Date.now(), cs, nA: A.length, tw: A.reduce((s, x) => s + x.w, 0), top: Object.values(own).sort((x, y) => y.w - x.w) };
  }

  // ---- overview chart (= site dkSeries): pool price + mining totals at 40 points per timeframe, archive reads (RPCS[0]).
  // Points sit on a fixed block grid (multiples of the step), so a refresh reads only the new grid points; the last point is 'latest'.
  const TFS = [['5m', 300], ['15m', 900], ['1h', 3600], ['4h', 14400], ['12h', 43200], ['1d', 86400], ['7d', 604800], ['all', 0]], CHN = 40;
  const px = h => { try { const sp = nw(h, 0) / 2 ** 96, v = 1 / (sp * sp * 1e10); return isFinite(v) && v > 0 ? +v.toPrecision(8) : null; } catch (e) { return null; } };
  const at = async b => { if (st.pt.has(b)) return st.pt.get(b); const r = await mc([[P1, '0x3850c7bd'], [MINING, '0x6d1da431'], [MINING, '0xef6aff46']], hx(b)); const v = [px(r[0]), r[1] ? nw(r[1], 0) : null, r[2] ? nw(r[2], 0) || null : null]; if (v[0] != null) st.pt.set(b, v); return v; };
  async function born(head) { // pool P1 creation block (binary search on slot0), once
    if (st.born) return st.born; let lo = 1, hi = head;
    while (hi - lo > 2000) { const m = Math.floor((lo + hi) / 2); let ok = false; try { const x = await rpc('eth_call', [{ to: P1, data: '0x3850c7bd' }, hx(m)]); ok = !!(x && x.length > 2 && /[1-9a-f]/.test(x.slice(2))); } catch (e) {} if (ok) hi = m; else lo = m; }
    return st.born = hi;
  }
  async function chart() {
    const hb = await rpc('eth_getBlockByNumber', ['latest', false]), head = parseInt(hb.number, 16), b2 = await rpc('eth_getBlockByNumber', [hx(head - 2000), false]);
    const bt = Math.round((parseInt(hb.timestamp, 16) - parseInt(b2.timestamp, 16)) / 2000 * 100) / 100, now = Date.now(), out = { ok: true, t: now, block: head, bt, tf: {} };
    const live = await mc([[P1, '0x3850c7bd'], [MINING, '0x6d1da431'], [MINING, '0xef6aff46']]), lv = [px(live[0]), live[1] ? nw(live[1], 0) : null, live[2] ? nw(live[2], 0) || null : null];
    for (const [k, sp] of TFS) {
      const span = sp ? Math.round(sp / bt) : head - await born(head), step = Math.max(1, Math.ceil(span / (CHN - 1) / (sp ? 1 : 1000)) * (sp ? 1 : 1000)), top = Math.floor(head / step) * step;
      const bs = [...Array(CHN - 1)].map((_, i) => top - (CHN - 2 - i) * step);
      const V = await pool(bs, 4, b => at(b).catch(() => [null, null, null]));
      bs.push(head); V.push(lv);
      out.tf[k] = { t: bs.map(b => now - Math.round((head - b) * bt * 1000)), p: V.map(v => v[0]), m: V.map(v => v[1]), w: V.map(v => v[2]) };
      await tick();
    }
    if (st.pt.size > 3000) for (const b of [...st.pt.keys()].sort((x, y) => x - y).slice(0, st.pt.size - 3000)) st.pt.delete(b);
    return out;
  }

  // ---- transistor market, last 7 days (= site loadM_ chain part; tok/PR/rows/agg stay on the site) ----
  async function realTk(X) { // fills whose seller is a contract: the real seller is the tx sender
    const as = [...new Set(X.map(x => x.se))].filter(a => !st.cd.has(a));
    await pool(as, 4, async a => { try { const c = await rpc('eth_getCode', [a, 'latest']); st.cd.set(a, c.length > 50 ? 1 : 0); } catch (e) {} });
    const hs = [...new Set(X.filter(x => st.cd.get(x.se) && x.tx && !st.fr.has(x.tx)).map(x => x.tx))];
    await pool(hs, 4, async h => { try { const t = await rpc('eth_getTransactionByHash', [h]); if (t && t.from) st.fr.set(h, t.from.toLowerCase()); } catch (e) {} });
    bound(st.cd, 20000); bound(st.fr, 20000);
    for (const x of X) if (st.cd.get(x.se) && st.fr.get(x.tx)) x.se = st.fr.get(x.tx);
  }
  async function tx7d() {
    const hb = await rpc('eth_getBlockByNumber', ['latest', false]), head = parseInt(hb.number, 16), b2 = await rpc('eth_getBlockByNumber', [hx(head - 2000), false]);
    const bt = (parseInt(hb.timestamp, 16) - parseInt(b2.timestamp, 16)) / 2000, n7 = Math.round(7 * 86400 / bt), n1 = head - Math.round(86400 / bt), lo = head - n7;
    const from = st.lgTo && st.lgTo >= lo ? st.lgTo + 1 : lo;
    if (from <= head) {
      const L = await logs({ address: MARKET, topics: [[T_PL, T_FI, T_CA]] }, from, head);
      if (from === lo) st.lg = [];
      for (const l of L) st.lg.push({ b: parseInt(l.blockNumber, 16), k: l.topics[0], t1: l.topics[1], t2: l.topics[2], t3: l.topics[3], data: l.data, tx: l.transactionHash });
      st.lgTo = head;
    }
    st.lg = st.lg.filter(l => l.b > lo); await tick();
    const pd = [0, 0], cn = [0, 0], F = [];
    for (const l of st.lg) {
      const d = l.b >= n1, id = BigInt(l.t1).toString();
      if (l.k === T_PL) { st.pl.set(id, { by: tad(l.t2), tr: tad(l.t3), tok: nw(l.data, 0) }); pd[0]++; if (d) pd[1]++; }
      else if (l.k === T_CA) { cn[0]++; if (d) cn[1]++; }
      else if (l.k === T_FI) F.push({ id, b: l.b, tx: l.tx, q: nw(l.data, 0), v: Number(wd(l.data, 1) + wd(l.data, 2)) / 1e18, se: tad(l.t2) });
    }
    await realTk(F);
    const miss = [...new Set(F.filter(x => !st.pl.has(x.id)).map(x => x.id))];
    if (miss.length) { const r = await mc(miss.map(i => [MARKET, '0x4423c5f1' + W(i)])); miss.forEach((i, k) => { const x = r[k]; if (x && wd(x, 0) > 0n) st.pl.set(i, { by: ad(x, 0), tr: ad(x, 1), tok: nw(x, 3) }); }); }
    bound(st.pl, 50000);
    for (const x of F) { const p = st.pl.get(x.id); if (p) { x.by = p.by; x.tk = p.tr + ':' + p.tok; } }
    const trs = [...new Set(F.filter(x => x.tk).map(x => x.tk.split(':')[0]))], tn = {};
    if (trs.length) { const c = (await mc(trs.map(a => [a, '0x5f48772d']))).map(x => x ? ad(x, 0) : null), r = await mc(c.map(x => [x || MC, '0x06fdde03'])); trs.forEach((a, i) => { tn[a] = { c: c[i], n: c[i] && r[i] ? str(r[i]) : '' }; }); }
    return { ok: true, block: head, bt, t: Date.now(), F, pd, cn, tn };
  }

  // ---- Market > Circuits (= site loadCi0 over 7 d): CMKT listings / sales / delists / price changes, incremental logs.
  // Real seller and buyer of a sale = first `from` / last `to` of the circuit's Transfer logs in the sale receipt (a receipt never changes: kept);
  // hashrate of each sold circuit read once per 6 h; processor names daily. The site cuts 1 d or 7 d out of this by block number.
  async function ci7d() {
    const hb = await rpc('eth_getBlockByNumber', ['latest', false]), head = parseInt(hb.number, 16), b2 = await rpc('eth_getBlockByNumber', [hx(head - 2000), false]);
    const bt = (parseInt(hb.timestamp, 16) - parseInt(b2.timestamp, 16)) / 2000, lo = head - Math.round(7 * 86400 / bt);
    const from = st.cgTo && st.cgTo >= lo ? st.cgTo + 1 : lo;
    if (from <= head) {
      const L = await logs({ address: CMKT, topics: [[T_LI, T_SO, T_DE, T_PC]] }, from, head);
      if (from === lo) st.cg = [];
      for (const l of L) st.cg.push({ b: parseInt(l.blockNumber, 16), k: l.topics[0], t1: l.topics[1], t2: l.topics[2], t3: l.topics[3], data: l.data, tx: l.transactionHash });
      st.cgTo = head;
    }
    st.cg = st.cg.filter(l => l.b > lo); await tick();
    const li = {}, S = [], E = { li: [], de: [], pc: [] };
    for (const l of st.cg) {
      const id = BigInt(l.t1).toString();
      if (l.k === T_LI) { E.li.push(l.b); li[id] = { se: tad(l.t2), b: l.b }; }
      else if (l.k === T_DE) E.de.push(l.b);
      else if (l.k === T_PC) E.pc.push(l.b);
      else if (l.k === T_SO) S.push({ id, b: l.b, tx: l.tx, by: tad(l.t2), cp: tad(l.t3), tid: wd(l.data, 0).toString(), v: Number(wd(l.data, 1) + wd(l.data, 2)) / 1e18, se: null });
    }
    for (const x of S) { const p = li[x.id]; if (p) { x.se = p.se; x.lb = p.b; } }
    const sk = x => x.tx + x.cp + x.tid;
    if (!st.cr.size && dir) try { // after a restart: receipts and hashrates from agg-cic.json (not served; 1,400 receipts take ~5 min to re-read)
      const o = JSON.parse(fs.readFileSync(path.join(dir, 'agg-cic.json'), 'utf8')); for (const [k, v] of o.cr || []) st.cr.set(k, v); for (const [k, v] of o.cw || []) st.cw.set(k, v);
    } catch (e) {}
    const need = [...new Set(S.filter(x => !st.cr.has(sk(x))).map(x => x.tx))];
    await pool(need, 6, async h => {
      try {
        const r = await rpc('eth_getTransactionReceipt', [h]); if (!r || !r.logs) return; const m = {};
        for (const l of r.logs) if (l.topics[0] === T_TR && l.topics.length >= 4) { const k = h + l.address.toLowerCase() + BigInt(l.topics[3]).toString(); (m[k] = m[k] || []).push(l); }
        for (const [k, a] of Object.entries(m)) { a.sort((p, q) => parseInt(p.logIndex, 16) - parseInt(q.logIndex, 16)); st.cr.set(k, [tad(a[0].topics[1]), tad(a[a.length - 1].topics[2])]); }
        for (const x of S) if (x.tx === h && !st.cr.has(sk(x))) st.cr.set(sk(x), null); // no Transfer for it: keep the event's buyer and the listing's seller
      } catch (e) {}
    });
    for (const x of S) { const r = st.cr.get(sk(x)); if (r) { x.se = r[0]; x.by = r[1]; } }
    // st.cw: [vw, read at, uw] per SALE, read at the sale block (audit s35: power read later drifted, e.g. a rig sold idle and registered after).
    // A past block never changes, so each sale is read once (archive eth_call via mc with a block tag).
    // Archive reads are slow (~0.25 s each on the only archive RPC), so at most CW_N per cycle, newest sales first: /ci7d must never wait on a
    // full refill (after a restart that was ~6 min of 503 -> site load hung, s35). Sales not read yet use the rig's power now (one batched read).
    const ck = x => x.cp + ':' + x.tid + ':' + x.b, now = Date.now(), CW_N = 150;
    const nw6 = [...new Set([...S].sort((p, q) => q.b - p.b).map(ck))].filter(k => !st.cw.has(k)).slice(0, CW_N);
    await pool(nw6, 3, async k => { // archive reads go to RPCS[0] (the only archive RPC); 6 in flight hit its rate limit
      const [cp, id, b] = k.split(':'), tag = hx(Number(b));
      try { const [key] = await mc([[MINING, '0x10eafa00' + W(cp) + W(BigInt(id))]], tag), [r] = await mc([[MINING, '0x0527edc2' + (key ? key.slice(2) : W(0))]], tag);
        if (!key || !r) return; // a failed read (null) is not an idle rig: leave it for the next cycle
        const a = nw(r, 9) === 1; st.cw.set(k, [a ? nw(r, 19) : 0, now, a ? nw(r, 20) : 0]); } catch (e) {} // retried next cycle
    });
    const rest = [...new Set(S.filter(x => !st.cw.has(ck(x))).map(x => x.cp + ':' + x.tid))], cur = new Map();
    if (rest.length) try {
      const pr = rest.map(k => k.split(':')), ks = await mc(pr.map(([cp, id]) => [MINING, '0x10eafa00' + W(cp) + W(BigInt(id))])), g = await mc(ks.map(k => [MINING, '0x0527edc2' + (k ? k.slice(2) : W(0))]));
      rest.forEach((k, i) => { const r = g[i]; if (!r) return; const a = nw(r, 9) === 1; cur.set(k, [a ? nw(r, 19) : 0, now, a ? nw(r, 20) : 0]); });
    } catch (e) {}
    for (const x of S) { const c = st.cw.get(ck(x)) || cur.get(x.cp + ':' + x.tid) || [0, 0, 0]; x.w = c[0]; x.u = c[2] || 0; }
    const cps = [...new Set(S.map(x => x.cp))].filter(a => !st.cn.has(a) || now - st.cn.get(a)[1] > 864e5);
    if (cps.length) { const r = await mc(cps.map(a => [a, '0x06fdde03'])); cps.forEach((a, i) => st.cn.set(a, [r[i] ? str(r[i]) : '', now])); }
    const nm = {}; for (const x of S) nm[x.cp] = (st.cn.get(x.cp) || [''])[0];
    bound(st.cr, 30000); bound(st.cw, 30000); bound(st.cn, 2000);
    if (dir && (need.length || nw6.length)) try { save(dir, 'cic', { cr: [...st.cr].filter(e => e[1]), cw: [...st.cw] }); } catch (e) {}
    return { ok: true, block: head, bt, t: Date.now(), S: S.map(x => ({ b: x.b, lb: x.lb, by: x.by, se: x.se, cp: x.cp, tid: x.tid, v: x.v, w: x.w, u: x.u })), E, nm };
  }

  async function run(name, fn, every) {
    for (;;) {
      const t0 = Date.now();
      // watchdog: a call that never settles used to freeze this loop silently for hours (27/10: chart + rank stale, no error logged)
      const lim = Math.max(every * 2, 180); let wd;
      try { st[name] = await Promise.race([fn(), new Promise((_, no) => { wd = setTimeout(() => no(Error('stuck > ' + lim + ' s')), lim * 1000); })]).finally(() => clearTimeout(wd)); st[name + 'Err'] = null; if (dir) { save(dir, name, st[name]); if (name === 'rank' && st.own) save(dir, 'own', st.own); } }
      catch (e) { st[name + 'Err'] = String(e.message).slice(0, 200); console.error(new Date().toISOString(), 'agg', name, 'failed (kept last):', st[name + 'Err']); }
      await new Promise(z => setTimeout(z, Math.max(5000, every * 1000 - (Date.now() - t0))));
    }
  }
  const fresh = (x, s) => x && Date.now() - x.t < s * 3000 ? x : null; // older than 3 refresh periods = not served (site reads the chain)
  return {
    start: () => { if (!on) return; run('rank', rank, RANK_S); run('tx', tx7d, TX_S); run('chart', chart, CH_S); run('ci', ci7d, CI_S); },
    rank: () => fresh(st.rank, RANK_S), tx: () => fresh(st.tx, TX_S), chart: () => fresh(st.chart, CH_S), ci: () => fresh(st.ci, CI_S),
    info: () => ({ aggRankAt: st.rank ? st.rank.t : null, aggTxAt: st.tx ? st.tx.t : null, aggErr: st.rankErr || st.txErr }),
    _rank: rank, _tx: tx7d, _chart: chart, _ci: ci7d, _st: st,
  };
}
const fs = require('fs'), path = require('path'), zlib = require('zlib');
function save(dir, name, o) { fs.mkdirSync(dir, { recursive: true }); const f = path.join(dir, 'agg-' + name + '.json'); fs.writeFileSync(f + '.tmp', JSON.stringify(o)); fs.renameSync(f + '.tmp', f); }
// API side: serve the files. Re-read only when mtime changes; body and gzip are built once per version. Too old (3 refresh periods) = not served.
function reader(dir, env = {}) {
  const per = { rank: Number(env.AGG_RANK_S || 300), tx: Number(env.AGG_TX_S || 60), chart: Number(env.AGG_CHART_S || 30), ci: Number(env.AGG_CI_S || 120) }, c = {};
  function get(name) {
    const f = path.join(dir, 'agg-' + name + '.json'); let m;
    try { m = fs.statSync(f).mtimeMs; } catch (e) { return null; }
    let x = c[name];
    if (!x || x.m !== m) { try { const body = fs.readFileSync(f, 'utf8'), o = JSON.parse(body); if (!o || !o.ok || !o.t) return null; x = c[name] = { m, t: o.t, body, gz: zlib.gzipSync(body) }; } catch (e) { return null; } }
    return Date.now() - x.t < (name === 'chart' ? 900000 : per[name] * 3000) ? x : null; // chart: one pass can take longer than 3 x 30 s; a BEM price up to 15 min old beats none
  }
  let oc = null; // owner index (agg-own.json): re-parsed only when the file changes; null when missing or older than 3 refresh periods
  function own(addr) {
    const f = path.join(dir, 'agg-own.json'); let m; try { m = fs.statSync(f).mtimeMs; } catch (e) { return null; }
    if (!oc || oc.m !== m) { try { const o = JSON.parse(fs.readFileSync(f, 'utf8')); if (!o || !o.ok || !o.o) return null; oc = { m, o }; } catch (e) { return null; } }
    if (Date.now() - oc.o.t > per.rank * 3000) return null;
    return { t: oc.o.t, block: oc.o.block, cs: oc.o.cs, items: oc.o.o[String(addr).toLowerCase()] || [] };
  }
  return { own, rank: () => get('rank'), tx: () => get('tx'), chart: () => get('chart'), ci: () => get('ci'), info: () => { const r = get('rank'), t = get('tx'); return { aggRankAt: r ? r.t : null, aggTxAt: t ? t.t : null }; } };
}
module.exports = { init, reader, save, LC };
if (require.main === module) { // pm2: tsd-agg. Same .env / API dir / RPCs as tsd-api (its chain helpers are reused; requiring it does not start the API)
  const A = require('./tsd-api.js'), dir = A.DIR;
  const g = init({ rpc: A._rpc, mc: A._mc, logs: A._logs, env: process.env, dir });
  console.log(new Date().toISOString(), 'tsd-agg writing to', dir); g.start();
}
