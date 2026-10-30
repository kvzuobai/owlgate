// OwlGate agent gate (spec-xlayer-market D): read + unsigned-tx endpoints on the X Layer voucher market for AI agents and agent wallets
// (Binance Agentic Wallet, OKX agents, any EOA). We never hold keys or funds: every endpoint returns public data or UNSIGNED steps that the
// caller's own wallet signs within its own limits. Step kinds: {kind:'tx', chainId, to, data, value} | {kind:'sign', typedData} | {kind:'post', url, body}.
// Fills are dry-run with eth_call from the caller before we answer (409 if it would revert). Orders come from the bids store (tsd-bids.js, which
// accepted them only if they match our templates). Same encoders as the site, checked by tools/verify-agent.js on an anvil fork of X Layer.
const crypto = require('crypto');
const { ethers } = require('ethers');

const SP = '0x0000000000000068f116a894984e2db1123eb395', WOKB = '0xe538905cf8410324e03a5a23c1c177a474d59b2b', VOUCH = '0x9cfc959cd42b2e1d39a0d850c528210e818ae520';
const POOL = '0xe3be6a0137f1b0602fc1a4841686f43b340a5082'; // Uniswap v3 USDT0/WOKB 0.05% on X Layer (token0 USDT0 6 dec, token1 WOKB 18): OKB price = 30 min TWAP
const MINING = '0x7e2e0dc66a3bd9103e69b766afa62d9f7b697b46', Z32 = '0x' + '0'.repeat(64), ZERO = '0x' + '0'.repeat(40), CHAIN = 196, FEE_BPS = 75n;
const OI = '(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount)', CI = '(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount,address recipient)';
const OP = `(address offerer,address zone,${OI}[] offer,${CI}[] consideration,uint8 orderType,uint256 startTime,uint256 endTime,bytes32 zoneHash,uint256 salt,bytes32 conduitKey,uint256 totalOriginalConsiderationItems)`;
const OC = `(address offerer,address zone,${OI}[] offer,${CI}[] consideration,uint8 orderType,uint256 startTime,uint256 endTime,bytes32 zoneHash,uint256 salt,bytes32 conduitKey,uint256 counter)`;
const BP = '(address considerationToken,uint256 considerationIdentifier,uint256 considerationAmount,address offerer,address zone,address offerToken,uint256 offerIdentifier,uint256 offerAmount,uint8 basicOrderType,uint256 startTime,uint256 endTime,bytes32 zoneHash,uint256 salt,bytes32 offererConduitKey,bytes32 fulfillerConduitKey,uint256 totalOriginalAdditionalRecipients,(uint256 amount,address recipient)[] additionalRecipients,bytes signature)';
const SPI = new ethers.Interface([`function fulfillBasicOrder(${BP} parameters) payable returns (bool)`, `function cancel(${OC}[] orders) returns (bool)`, 'function incrementCounter() returns (uint256)', 'function getCounter(address) view returns (uint256)',
  `function matchAdvancedOrders((${OP} parameters,uint120 numerator,uint120 denominator,bytes signature,bytes extraData)[] orders,(uint256 orderIndex,uint8 side,uint256 index,uint256 identifier,bytes32[] criteriaProof)[] criteriaResolvers,((uint256 orderIndex,uint256 itemIndex)[] offerComponents,(uint256 orderIndex,uint256 itemIndex)[] considerationComponents)[] fulfillments,address recipient) payable returns (tuple(tuple(uint8,address,uint256,uint256,address),address,bytes32)[])`]);
const TI = new ethers.Interface(['function approve(address,uint256)', 'function deposit() payable', 'function ownerOf(uint256) view returns (address)', 'function getApproved(uint256) view returns (address)',
  'function isApprovedForAll(address,address) view returns (bool)', 'function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)', 'function observe(uint32[]) view returns (int56[],uint160[])']);
const DOMAIN_T = [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }];
const isA = s => /^0x[0-9a-fA-F]{40}$/.test(s || ''), lc = s => String(s).toLowerCase(), tad = h => h ? '0x' + String(h).slice(26).toLowerCase() : null;
const big = h => h ? BigInt(String(h).slice(0, 66)) : 0n, ok = n => Number(n) / 1e18, cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;

// the X Layer templates (same as the site's xmMake and tsd-bids parse): list = voucher for native OKB, offer = WOKB on one voucher, coll = WOKB on any voucher
function template(k, off, tid, p, start, end, salt, counter, free, feeTo) {
  const s = String, fe = free ? 0n : p * FEE_BPS / 10000n; off = lc(off);
  const nat = (a, r) => ({ itemType: '0', token: ZERO, identifierOrCriteria: '0', startAmount: s(a), endAmount: s(a), recipient: r });
  const wo = (a, r) => ({ itemType: '1', token: WOKB, identifierOrCriteria: '0', startAmount: s(a), endAmount: s(a), ...(r ? { recipient: r } : {}) });
  const offer = k === 'list' ? [{ itemType: '2', token: VOUCH, identifierOrCriteria: s(tid), startAmount: '1', endAmount: '1' }] : [wo(p)];
  const consideration = k === 'list' ? [nat(p - fe, off)].concat(free ? [] : [nat(fe, feeTo)])
    : [{ itemType: k === 'coll' ? '4' : '2', token: VOUCH, identifierOrCriteria: k === 'coll' ? '0' : s(tid), startAmount: '1', endAmount: '1', recipient: off }].concat(free ? [] : [wo(fe, feeTo)]);
  return { offerer: off, zone: ZERO, offer, consideration, orderType: '0', startTime: s(start), endTime: s(end), zoneHash: Z32, salt: s(salt), conduitKey: Z32, counter: s(counter) };
}
// fulfillBasicOrder: ty 0 = buy a listing with OKB (value = price), ty 16 = accept a WOKB offer on one voucher (fee paid out of the offer)
function basic(o, sig, ty) {
  const c = o.consideration, f0 = o.offer[0];
  return SPI.encodeFunctionData('fulfillBasicOrder', [[c[0].token, c[0].identifierOrCriteria, c[0].startAmount, o.offerer, o.zone, f0.token, f0.identifierOrCriteria, f0.startAmount, ty,
    o.startTime, o.endTime, o.zoneHash, o.salt, Z32, Z32, c.length - 1, c.slice(1).map(x => [x.startAmount, x.recipient]), sig]]);
}
// collection offer: [bidder's signed order, the seller's own unsigned order (voucher, no consideration)]; voucher -> bidder, fee out of the WOKB offer,
// the unspent WOKB (price - fee) goes to the recipient = seller. The seller needs only the voucher approval (fork test XLSeaportFork test_3).
function match(o, sig, me, tid, st, en, salt) {
  const par = { ...o, totalOriginalConsiderationItems: o.consideration.length }; delete par.counter;
  const own = [me, ZERO, [[2, VOUCH, tid, 1, 1]], [], 0, st, en, Z32, salt, Z32, 0];
  const ff = [[[[1, 0]], [[0, 0]]]].concat(o.consideration.length > 1 ? [[[[0, 0]], [[0, 1]]]] : []);
  return SPI.encodeFunctionData('matchAdvancedOrders', [[[par, 1, 1, sig, '0x'], [own, 1, 1, '0x', '0x']], [[0, 1, 0, tid, []]], ff, me]);
}

// o: {B (tsd-bids), xl() (/xl vouchers), xrpc(method, params), xmc(calls), mc(calls) (BSC), bemUsd(), feeTo, enabled(), api (public base URL)}
module.exports = function agent(o) {
  const C = {}, cached = (k, ms, fn) => { const c = C[k]; if (c && Date.now() - c.at < ms) return c.p; const p = fn(); C[k] = { at: Date.now(), p }; p.catch(() => { if (C[k] && C[k].p === p) delete C[k]; }); return p; };
  const xq = (to, data) => o.xrpc('eth_call', [{ to, data }, 'latest']);
  const okbUsd = () => cached('okb', 60000, async () => { const [tc] = TI.decodeFunctionResult('observe', await xq(POOL, TI.encodeFunctionData('observe', [[1800, 0]])));
    return 1e12 / 1.0001 ** (Number(tc[1] - tc[0]) / 1800); });
  const mr = () => cached('mr', 60000, async () => { const g = await o.mc([[MINING, '0xf9f8bdb7'], [MINING, '0xef6aff46'], [MINING, '0x63967742']]); if (g.some(x => !x)) throw Error('mining read');
    return { day: Number(big(g[0])) / 1e8 * 86400, tv: Number(big(g[1])), tu: Number(big(g[2])) }; }); // rate (8 dec, per s), total voucher weight, total user weight
  const bemDay = (x, m) => !m || x.st !== 1 ? 0 : (x.vw && m.tv ? .99 * m.day * x.vw / m.tv : 0) + (x.uw && m.tu ? .01 * m.day * x.uw / m.tu : 0); // same split as the site
  const net = x => BigInt(x.price) - BigInt(x.fee), now = () => Math.floor(Date.now() / 1e3);
  const live = () => o.B.book(CHAIN).filter(x => x.status === 'open' && x.end > now() && x.cp === VOUCH); // vouchers only (the 196 book also holds TapeCode-Test1)
  const bestBid = (L, v, holder) => L.filter(y => y.offerer !== lc(holder) && (y.kind === 'coll' || (y.kind === 'offer' && y.tid === String(v)))).sort((a, b) => cmp(net(b), net(a)))[0];
  const tx = (label, to, data, value = 0n) => ({ kind: 'tx', label, chainId: CHAIN, to, data, value: '0x' + BigInt(value).toString(16) });
  const dry = async (from, s) => { try { await o.xrpc('eth_call', [{ from, to: s.to, data: s.data, value: s.value }, 'latest']); return null; } catch (e) { return String(e.message || e).slice(0, 160); } };
  const approved = async (owner, id) => { const [g, a] = await o.xmc([[VOUCH, TI.encodeFunctionData('getApproved', [id])], [VOUCH, TI.encodeFunctionData('isApprovedForAll', [owner, SP])]]); return tad(g) === SP || big(a) !== 0n; };
  const holderOf = async v => tad(await xq(VOUCH, TI.encodeFunctionData('ownerOf', [v])).catch(() => null));
  const wei = s => { s = String(s || ''); if (!/^\d{1,9}(\.\d{1,18})?$/.test(s)) return null; const p = ethers.parseEther(s); return p >= 10n ** 16n && p <= 500n * 10n ** 18n ? p : null; };

  function market() { return cached('mkt', 15000, async () => {
    const [j, m, ou] = await Promise.all([o.xl(), mr().catch(() => null), okbUsd().catch(() => null)]), bu = o.bemUsd(), L = live();
    const vouchers = j.items.map(x => { const v = String(x.v), h = lc(x.holder);
      const ask = L.filter(y => y.kind === 'list' && y.tid === v && y.offerer === h).sort((a, b) => cmp(BigInt(a.price), BigInt(b.price)))[0], bid = bestBid(L, v, h);
      const bd = bemDay(x, m), pb = ask && bd > 0 && ou && bu ? Math.round(ok(ask.price) * ou / (bd * bu)) : null;
      return { voucher: x.v, holder: h, rig: { chain: 56, cpu: x.cp, id: x.id, power: x.power, mining: x.st === 1 }, bemPerDay: m ? +bd.toFixed(4) : null, usdPerDay: m && bu ? +(bd * bu).toFixed(2) : null, unclaimedBem: x.pend,
        ask: ask ? { hash: ask.hash, priceOkb: ok(ask.price), priceWei: ask.price, seller: ask.offerer, expires: ask.end } : null,
        bestOffer: bid ? { hash: bid.hash, kind: bid.kind, priceWokb: ok(bid.price), sellerGetsWei: net(bid).toString(), bidder: bid.offerer, expires: bid.end } : null, paybackDays: pb }; })
      .sort((a, b) => (b.bemPerDay || 0) - (a.bemPerDay || 0) || b.rig.power - a.rig.power);
    const t0 = vouchers[0], top = t0 && t0.bemPerDay != null ? { voucher: t0.voucher, bemPerDay: t0.bemPerDay, usdPerDay: t0.usdPerDay, ask: t0.ask && t0.ask.priceOkb, bestOffer: t0.bestOffer && t0.bestOffer.priceWokb } : null;
    const coll = L.filter(x => x.kind === 'coll').sort((a, b) => cmp(net(b), net(a))).slice(0, 5).map(x => ({ hash: x.hash, priceWokb: ok(x.price), sellerGetsWei: net(x).toString(), bidder: x.offerer, expires: x.end }));
    return { ok: true, t: Date.now(), top, chain: CHAIN, seaport: SP, voucherContract: VOUCH, voucherProxy: 'ERC1967 UUPS, upgradeable by TapeOut', wokb: WOKB, redeemFeeOkb: j.redeemOkb,
      fee: { bps: Number(FEE_BPS), to: o.feeTo, freeOrdersPerWallet: o.B.FREE_N, paidBy: 'seller, deducted from the price' },
      prices: { okbUsd: ou, bemUsd: bu, okbSource: 'Uniswap v3 USDT0/WOKB 0.05% on X Layer, 30 min TWAP', bemSource: 'BEM pool on BNB Chain (OwlGate chart)' },
      note: "vouchers are sorted by bemPerDay, highest first; top = the first one. usdPerDay = bemPerDay x BEM USD, gross. bemPerDay and paybackDays are estimates at today's BEM price and total mining power; both change every day. paybackDays = ask in USD / (bemPerDay x BEM USD).",
      vouchers, collectionOffers: coll }; }); }

  async function buy(u) {
    const from = u.searchParams.get('from'), r = o.B.one(u.searchParams.get('hash') || '');
    if (!isA(from)) return [400, { error: 'from' }];
    if (!r || r.chain !== CHAIN || r.kind !== 'list' || r.cp !== VOUCH) return [404, { error: 'unknown listing' }];
    if (r.status !== 'open' || r.end <= now()) return [409, { error: 'listing not open', status: r.status, reason: r.reason }];
    if (lc(from) === r.offerer) return [400, { error: 'own listing' }];
    const s = tx(`Buy voucher #${r.tid} for ${ok(r.price)} OKB`, SP, basic(r.order, r.signature, 0), BigInt(r.price)), e = await dry(from, s);
    if (e) return [409, { error: 'dry run failed, do not send', detail: e }];
    return [200, { chainId: CHAIN, from: lc(from), steps: [s], dryRun: 'ok', summary: { voucher: r.tid, payOkb: ok(r.price), payWei: r.price, seller: r.offerer, sellerFeeOkb: ok(r.fee) } }];
  }
  async function sell(u) {
    const from = u.searchParams.get('from'), v = u.searchParams.get('v'), h = u.searchParams.get('hash');
    if (!isA(from) || !/^\d{1,9}$/.test(v || '')) return [400, { error: 'from/v' }];
    if (await holderOf(v) !== lc(from)) return [403, { error: 'from does not hold this voucher' }];
    let b;
    if (h) { b = o.B.one(h); if (!b || b.chain !== CHAIN || b.cp !== VOUCH || !(b.kind === 'coll' || (b.kind === 'offer' && b.tid === v)) || b.status !== 'open' || b.end <= now() || b.offerer === lc(from)) return [409, { error: 'offer not open for this voucher' }]; }
    else { b = bestBid(live(), v, from); if (!b) return [404, { error: 'no open offer for this voucher' }]; }
    const [bal, alw] = await o.xmc([[WOKB, TI.encodeFunctionData('balanceOf', [b.offerer])], [WOKB, TI.encodeFunctionData('allowance', [b.offerer, SP])]]);
    if (big(bal) < BigInt(b.price) || big(alw) < BigInt(b.price)) return [409, { error: 'bidder no longer funded' }];
    const ap = await approved(from, v), steps = [];
    if (!ap) steps.push(tx(`Approve voucher #${v} for Seaport (this voucher only)`, VOUCH, TI.encodeFunctionData('approve', [SP, v])));
    let data; if (b.kind === 'coll') { const ts = parseInt((await o.xrpc('eth_getBlockByNumber', ['latest', false])).timestamp, 16); data = match(b.order, b.signature, lc(from), v, ts - 60, ts + 3600, BigInt('0x' + crypto.randomBytes(16).toString('hex'))); }
    else data = basic(b.order, b.signature, 16);
    const fill = tx(`Accept ${ok(b.price)} WOKB for voucher #${v}`, SP, data); steps.push(fill);
    let dr = 'skipped: approval first; simulate the last step before sending it';
    if (ap) { const e = await dry(from, fill); if (e) return [409, { error: 'dry run failed, do not send', detail: e }]; dr = 'ok'; }
    return [200, { chainId: CHAIN, from: lc(from), steps, dryRun: dr, validFor: b.kind === 'coll' ? 'send the accept step within 1 hour' : null,
      summary: { voucher: v, offer: b.hash, kind: b.kind, bidder: b.offerer, priceWokb: ok(b.price), feeWokb: ok(b.fee), youReceiveWokb: ok(net(b)) } }];
  }
  async function cancel(u) {
    const from = u.searchParams.get('from'), all = u.searchParams.get('all') === '1';
    if (!isA(from)) return [400, { error: 'from' }];
    if (all) return [200, { chainId: CHAIN, from: lc(from), steps: [tx('Cancel ALL your Seaport orders on X Layer (incrementCounter)', SP, SPI.encodeFunctionData('incrementCounter', []))] }];
    const r = o.B.one(u.searchParams.get('hash') || '');
    if (!r || r.chain !== CHAIN || r.offerer !== lc(from)) return [404, { error: 'unknown order for this wallet' }];
    if (r.status !== 'open' && r.status !== 'inactive') return [409, { error: 'order not open', status: r.status }];
    return [200, { chainId: CHAIN, from: lc(from), steps: [tx(`Cancel ${r.kind} ${r.kind === 'coll' ? 'on any voucher' : 'on voucher #' + r.tid}`, SP, SPI.encodeFunctionData('cancel', [[r.order]]))] }];
  }
  async function build(u) {
    const q = k => u.searchParams.get(k), k = q('kind'), from = q('from'), v = k === 'coll' ? '0' : q('v'), p = wei(q('price')), days = Number(q('days') || 1);
    if (!['list', 'offer', 'coll'].includes(k)) return [400, { error: 'kind: list | offer | coll' }];
    if (!isA(from) || !/^\d{1,9}$/.test(v || '')) return [400, { error: 'from/v' }];
    if (!p) return [400, { error: 'price: 0.01 to 500 (OKB, decimal)' }];
    if (![1, 3, 7].includes(days)) return [400, { error: 'days: 1 | 3 | 7' }];
    const a = lc(from), [ctr, blk] = await Promise.all([xq(SP, SPI.encodeFunctionData('getCounter', [a])), o.xrpc('eth_getBlockByNumber', ['latest', false])]);
    const steps = [], blockers = [], fr = o.B.free(a).left > 0, fee = fr ? 0n : p * FEE_BPS / 10000n;
    if (k !== 'coll') { const h = await holderOf(v); if (!h) return [404, { error: 'voucher not found' }];
      if (k === 'list' && h !== a) return [403, { error: 'from does not hold this voucher' }]; if (k === 'offer' && h === a) return [400, { error: 'you hold this voucher' }]; }
    if (k === 'list') { if (!await approved(a, v)) steps.push(tx(`Approve voucher #${v} for Seaport (this voucher only)`, VOUCH, TI.encodeFunctionData('approve', [SP, v]))); }
    else {
      const [bal, alw] = await o.xmc([[WOKB, TI.encodeFunctionData('balanceOf', [a])], [WOKB, TI.encodeFunctionData('allowance', [a, SP])]]), nat = BigInt(await o.xrpc('eth_getBalance', [a, 'latest']));
      const need = o.B.book(CHAIN).filter(x => x.offerer === a && x.kind !== 'list').reduce((s, x) => s + BigInt(x.price), 0n) + p, wrap = big(bal) < p ? p - big(bal) : 0n;
      if (wrap > nat) blockers.push(`Wallet has ${ok(nat).toFixed(8).replace(/\.?0+$/, '')} OKB, needs ${ok(wrap)} OKB to wrap into WOKB for this offer. Fund the wallet, then build again. Do not send the steps until then.`);
      if (wrap) steps.push(tx(`Wrap ${ok(wrap)} OKB to WOKB`, WOKB, TI.encodeFunctionData('deposit', []), wrap));
      if (big(alw) < need) steps.push(tx(`Approve ${ok(need)} WOKB for Seaport (exact amount, covers your open offers)`, WOKB, TI.encodeFunctionData('approve', [SP, need])));
    }
    const t = now(), order = template(k, a, v, p, Math.min(t, parseInt(blk.timestamp, 16)) - 60, t + days * 86400, BigInt('0x' + crypto.randomBytes(16).toString('hex')), big(ctr), fr, o.feeTo);
    steps.push({ kind: 'sign', label: 'Sign the order (free, no gas) with eth_signTypedData_v4', typedData: { types: { EIP712Domain: DOMAIN_T, ...o.B.TYPES }, primaryType: 'OrderComponents', domain: o.B.DOM[CHAIN], message: order } });
    steps.push({ kind: 'post', label: 'Publish the signed order', method: 'POST', url: o.api + '/bids', body: { order, signature: '<signature from the sign step>', chain: CHAIN } });
    return [200, { chainId: CHAIN, from: a, ready: !blockers.length, blockers, steps, summary: { kind: k, voucher: k === 'coll' ? 'any' : v, priceOkb: ok(p), feeOkb: ok(fee), feeFree: fr, sellerGetsOkb: ok(p - fee), expires: Number(order.endTime),
      pays: k === 'list' ? 'buyer pays the price in OKB' : 'you pay the price in WOKB only if a holder accepts' } }];
  }

  const R = { '/xl/market': () => market().then(j => [200, j]), '/xl/tx/buy': buy, '/xl/tx/sell': sell, '/xl/tx/cancel': cancel, '/xl/order/build': build };
  return function route(p, u, res, send) {
    const f = R[p]; if (!f) return false;
    if (p !== '/xl/market' && p !== '/xl/tx/cancel' && !o.enabled()) { send(res, 403, { error: 'trading disabled' }); return true; }
    f(u).then(([c, b]) => send(res, c, b), e => { console.error('agent', p, e.message); send(res, 502, { error: 'chain read failed' }); });
    return true;
  };
};
module.exports._ = { template, basic, match, SPI, POOL };
