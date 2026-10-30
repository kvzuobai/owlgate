// OwlGate X Layer market (app/owlgate/index.html, spec-xlayer-market B): the SITE's own encoders, run on an anvil fork of X Layer (chain 196).
// Checks: order hash == Seaport.getOrderHash, calldata == ethers ABI encoding, the API (tsd-bids parse) accepts what the site signs, xmOk rejects a
// changed template, then real txs on the fork: list -> buy (OKB), offer -> accept (WOKB, basic), collection offer -> accept (matchAdvancedOrders), cancel.
// No mainnet tx; anvil test keys only. Usage: node tools/verify-og-xl.js   (needs anvil in PATH)
const fs = require('fs'), os = require('os'), path = require('path'), vm = require('vm'), { spawn } = require('child_process');
const { ethers } = require('./node_modules/ethers');
const B = require('./tsd-bids.js');
const FORK = process.env.XL_FORK_URL || 'https://rpc.xlayer.tech', AP = 19545 + Math.floor(Math.random() * 400), RPC = `http://127.0.0.1:${AP}`;
const K0 = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', K1 = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const FEE_TO = '0x58f341ebf80ab52d7650750119e8641cfbc8c018';
let pass = 0, fail = 0; const ok = (n, c, d = '') => { c ? pass++ : fail++; console.log((c ? '  PASS ' : '  FAIL ') + n + (d ? '  [' + d + ']' : '')); };
const sleep = ms => new Promise(r => setTimeout(r, ms)), W = n => BigInt(n).toString(16).padStart(64, '0');

const html = fs.readFileSync(path.join(__dirname, '../app/owlgate/index.html'), 'utf8');
const cut = (a, b) => { const i = html.indexOf(a), j = html.indexOf(b, i); if (i < 0 || j < i) throw Error('block not found: ' + a); return html.slice(i, j); };
const ctx = { W, out: null, crypto: require('crypto').webcrypto, fetch: () => { throw Error('no fetch'); } };
vm.createContext(ctx);
vm.runInContext(cut('const BID={', 'const wei=s=>') + cut('const XM={', 'async function xmLoad') + cut('const xmCmp=', 'function xmCells') + ';out={XM,xmMake,xmTyped,xmOk,xmBasic,xmMatchData,xmBid,bidCancelData,bidFee,BID}', ctx);
const S = ctx.out;

const OI = '(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount)', CI = '(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount,address recipient)';
const OP = `(address offerer,address zone,${OI}[] offer,${CI}[] consideration,uint8 orderType,uint256 startTime,uint256 endTime,bytes32 zoneHash,uint256 salt,bytes32 conduitKey,uint256 totalOriginalConsiderationItems)`;
const OC = `(address offerer,address zone,${OI}[] offer,${CI}[] consideration,uint8 orderType,uint256 startTime,uint256 endTime,bytes32 zoneHash,uint256 salt,bytes32 conduitKey,uint256 counter)`;
const BP = '(address considerationToken,uint256 considerationIdentifier,uint256 considerationAmount,address offerer,address zone,address offerToken,uint256 offerIdentifier,uint256 offerAmount,uint8 basicOrderType,uint256 startTime,uint256 endTime,bytes32 zoneHash,uint256 salt,bytes32 offererConduitKey,bytes32 fulfillerConduitKey,uint256 totalOriginalAdditionalRecipients,(uint256 amount,address recipient)[] additionalRecipients,bytes signature)';
const SPI = new ethers.Interface([`function getOrderHash(${OC} order) view returns (bytes32)`, `function fulfillBasicOrder(${BP} parameters) payable returns (bool)`,
  `function matchAdvancedOrders((${OP} parameters,uint120 numerator,uint120 denominator,bytes signature,bytes extraData)[] orders,(uint256 orderIndex,uint8 side,uint256 index,uint256 identifier,bytes32[] criteriaProof)[] criteriaResolvers,((uint256 orderIndex,uint256 itemIndex)[] offerComponents,(uint256 orderIndex,uint256 itemIndex)[] considerationComponents)[] fulfillments,address recipient) payable returns (tuple(tuple(uint8,address,uint256,uint256,address),address,bytes32)[])`,
  `function cancel(${OC}[] orders) returns (bool)`, 'function getOrderStatus(bytes32) view returns (bool,bool,uint256,uint256)']);

let anvil;
(async () => {
  anvil = spawn('anvil', ['--fork-url', FORK, '--port', String(AP), '--silent', '--chain-id', '196'], { stdio: 'ignore' });
  const pv = new ethers.JsonRpcProvider(RPC, 196, { staticNetwork: true });
  for (let i = 0; ; i++) { try { await pv.getBlockNumber(); break; } catch (e) { if (i > 60) throw Error('anvil did not start'); await sleep(500); } }
  B.init({ dir: path.join(os.tmpdir(), 'og-xl-' + Date.now()), cpus: [], env: { BIDS_ENABLED: '1' }, feeTo: FEE_TO, rpc: null, mc: null, logs: null, head: () => ({ block: 0, ts: 0 }), xl: { rpc: null, mc: null } });
  const sel = new ethers.Wallet(K0, pv), buy = new ethers.Wallet(K1, pv), sa = sel.address.toLowerCase(), ba = buy.address.toLowerCase();
  const SP = S.BID.sp, VO = S.XM.vo, WO = S.XM.wo, call = (to, data) => pv.call({ to, data });
  const tok = i => call(VO, '0x4f6ccce7' + W(i)).then(BigInt), owner = async id => '0x' + (await call(VO, '0x6352211e' + W(id))).slice(26);
  const wokb = a => call(WO, '0x70a08231' + W(a)).then(BigInt), ctr = a => call(SP, '0xf07ec373' + W(a)).then(BigInt);
  const [t1, t2] = [await tok(0), await tok(1)];
  for (const id of [t1, t2]) { const h = await owner(id); await pv.send('anvil_impersonateAccount', [h]); await pv.send('anvil_setBalance', [h, '0x56bc75e2d63100000']);
    await pv.send('eth_sendTransaction', [{ from: h, to: VO, data: '0x23b872dd' + W(h) + W(sa) + W(id) }]); }
  ok('seller holds vouchers #' + t1 + ', #' + t2, (await owner(t1)).toLowerCase() === sa && (await owner(t2)).toLowerCase() === sa);
  const tx = async (w, to, data, value) => (await (await w.sendTransaction({ to, data, ...(value ? { value } : {}) })).wait()).status === 1;
  const sign = (w, o) => w.signTypedData(S.xmTyped(o).domain, B.TYPES, o);
  const now = async () => (await pv.getBlock('latest')).timestamp;
  const P = 2n * 10n ** 18n, F = S.bidFee(P);

  console.log('encoders');
  let ts = await now(), c0 = await ctr(sa);
  for (const [k, free] of [['list', false], ['list', true], ['offer', false], ['coll', false], ['coll', true]]) {
    const off = k === 'list' ? sa : ba, o = S.xmMake(k, off, k === 'coll' ? 0 : t1, P, ts - 60, ts + 86400, 99n, k === 'list' ? c0 : await ctr(ba), free);
    const h = await call(SP, SPI.encodeFunctionData('getOrderHash', [o]));
    ok(`${k}${free ? ' free' : ''}: typed-data hash == getOrderHash`, ethers.TypedDataEncoder.hashStruct('OrderComponents', B.TYPES, o) === h);
    const sig = await sign(k === 'list' ? sel : buy, o), r = B.parse({ order: o, signature: sig, chain: 196 });
    ok(`${k}${free ? ' free' : ''}: API parse accepts it as ${r.kind}`, !r.err && r.kind === k && r.price === P && r.hash === h, r.err);
    const item = { order: JSON.parse(JSON.stringify(o)), signature: sig, chain: 196, kind: k, hash: h, status: 'open' };
    ok(`${k}${free ? ' free' : ''}: xmOk rebuilds it`, !!S.xmOk(item));
    const bad = JSON.parse(JSON.stringify(item)); bad.order.consideration[bad.order.consideration.length - 1].recipient = '0x' + '1'.repeat(40);
    ok(`${k}${free ? ' free' : ''}: xmOk rejects a changed recipient`, S.xmOk(bad) === null);
    ok(`${k}${free ? ' free' : ''}: xmOk rejects chain 56`, S.xmOk({ ...item, chain: 56 }) === null);
  }
  { const o = S.xmMake('list', sa, t1, P, 1, 2, 3n, 0n, false), sig = '0x' + 'ab'.repeat(65), r = o.consideration.slice(1).map(x => [x.startAmount, x.recipient]);
    const ex = SPI.encodeFunctionData('fulfillBasicOrder', [[o.consideration[0].token, 0, o.consideration[0].startAmount, o.offerer, o.zone, VO, t1, 1, 0, 1, 2, o.zoneHash, 3, o.conduitKey, o.conduitKey, r.length, r, sig]]);
    ok('xmBasic(list, 0) == ethers fulfillBasicOrder', S.xmBasic(o, sig, 0) === ex);
    const m = S.xmMake('coll', ba, 0, P, 1, 2, 3n, 0n, false), par = { ...m, totalOriginalConsiderationItems: 2 }; delete par.counter;
    const own = [sa, ethers.ZeroAddress, [[2, VO, t2, 1, 1]], [], 0, 5, 6, ethers.ZeroHash, 7, ethers.ZeroHash, 0];
    const exm = SPI.encodeFunctionData('matchAdvancedOrders', [[[par, 1, 1, sig, '0x'], [own, 1, 1, '0x', '0x']], [[0, 1, 0, t2, []]], [[[[1, 0]], [[0, 0]]], [[[0, 0]], [[0, 1]]]], sa]);
    ok('xmMatchData == ethers matchAdvancedOrders', S.xmMatchData(m, sig, sa, t2, 5, 6, 7n) === exm); }

  console.log('fork: list -> buy with OKB');
  ok('seller approves voucher #' + t1, await tx(sel, VO, '0x095ea7b3' + W(SP) + W(t1)));
  ts = await now();
  const L = S.xmMake('list', sa, t1, P, ts - 60, ts + 86400, 1n, await ctr(sa), false), Ls = await sign(sel, L);
  const s0 = await pv.getBalance(sa), f0 = await pv.getBalance(FEE_TO);
  ok('buyer fulfils with exactly the price', await tx(buy, SP, S.xmBasic(L, Ls, 0), P));
  ok('voucher -> buyer', (await owner(t1)).toLowerCase() === ba);
  ok('seller nets price - 0.75%', (await pv.getBalance(sa)) - s0 === P - F, String((await pv.getBalance(sa)) - s0));
  ok('fee 0.75% in OKB to fee wallet', (await pv.getBalance(FEE_TO)) - f0 === F);

  console.log('fork: offer on one voucher -> accept (WOKB)');
  ok('buyer wraps + approves WOKB', await tx(buy, WO, '0xd0e30db0', 5n * 10n ** 18n) && await tx(buy, WO, '0x095ea7b3' + W(SP) + W(3n * P)));
  ok('seller approves voucher #' + t2, await tx(sel, VO, '0x095ea7b3' + W(SP) + W(t2)));
  ts = await now();
  const O = S.xmMake('offer', ba, t2, P, ts - 60, ts + 86400, 2n, await ctr(ba), false), Os = await sign(buy, O), w0 = await wokb(sa);
  ok('seller accepts (basic type 16)', await tx(sel, SP, S.xmBasic(O, Os, 16)));
  ok('voucher #' + t2 + ' -> buyer, seller +price-fee WOKB', (await owner(t2)).toLowerCase() === ba && (await wokb(sa)) - w0 === P - F);

  console.log('fork: collection offer -> accept via matchAdvancedOrders');
  for (const id of [t1, t2]) await pv.send('anvil_impersonateAccount', [ba]), await pv.send('eth_sendTransaction', [{ from: ba, to: VO, data: '0x23b872dd' + W(ba) + W(sa) + W(id) }]);
  ts = await now();
  const C = S.xmMake('coll', ba, 0, P, ts - 60, ts + 86400, 3n, await ctr(ba), false), Cs = await sign(buy, C);
  ok('seller approves voucher #' + t1, await tx(sel, VO, '0x095ea7b3' + W(SP) + W(t1)));
  const w1 = await wokb(sa), fw = await wokb(FEE_TO), md = S.xmMatchData(C, Cs, sa, t1, ts - 60, ts + 3600, 4n);
  let dry = true; try { await pv.call({ from: sa, to: SP, data: md }); } catch (e) { dry = false; }
  ok('dry run (eth_call) passes', dry);
  ok('seller accepts the collection offer', await tx(sel, SP, md));
  ok('voucher #' + t1 + ' -> bidder, seller +price-fee, fee wallet +fee', (await owner(t1)).toLowerCase() === ba && (await wokb(sa)) - w1 === P - F && (await wokb(FEE_TO)) - fw === F);
  let again = true; try { await pv.call({ from: sa, to: SP, data: S.xmMatchData(C, Cs, sa, t2, ts - 60, ts + 3600, 5n) }); } catch (e) { again = false; }
  ok('the same collection offer cannot fill a second voucher', !again);

  console.log('fork: cancel');
  ts = await now();
  const X = S.xmMake('coll', ba, 0, P, ts - 60, ts + 86400, 6n, await ctr(ba), true), Xs = await sign(buy, X);
  ok('bidder cancels (site calldata)', await tx(buy, SP, S.bidCancelData(X)));
  ok('seller approves voucher #' + t2, await tx(sel, VO, '0x095ea7b3' + W(SP) + W(t2)));
  let cx = true; try { await pv.call({ from: sa, to: SP, data: S.xmMatchData(X, Xs, sa, t2, ts - 60, ts + 3600, 7n) }); } catch (e) { cx = false; }
  ok('cancelled offer cannot be accepted', !cx);

  console.log('TapeCode-Test1 (s61): same book, same fee');
  const TC = S.XM.tc, towner = async id => '0x' + (await call(TC, '0x6352211e' + W(id))).slice(26), [u1, u2] = [2833n, 8096n];
  for (const id of [u1, u2]) { const h = await towner(id); await pv.send('anvil_impersonateAccount', [h]); await pv.send('anvil_setBalance', [h, '0x56bc75e2d63100000']);
    await pv.send('eth_sendTransaction', [{ from: h, to: TC, data: '0x23b872dd' + W(h) + W(sa) + W(id) }]); }
  ok('seller holds TapeCode-Test1 #' + u1 + ', #' + u2, (await towner(u1)).toLowerCase() === sa && (await towner(u2)).toLowerCase() === sa);
  ts = await now();
  for (const k of ['list', 'offer', 'coll']) {
    const o = S.xmMake(k, k === 'list' ? sa : ba, k === 'coll' ? 0 : u1, P, ts - 60, ts + 86400, 50n, await ctr(k === 'list' ? sa : ba), false, TC), h = await call(SP, SPI.encodeFunctionData('getOrderHash', [o]));
    const sig = await sign(k === 'list' ? sel : buy, o), r = B.parse({ order: o, signature: sig, chain: 196 }), x = S.xmOk({ order: JSON.parse(JSON.stringify(o)), signature: sig, chain: 196, kind: k, hash: h, status: 'open' });
    ok(`TC ${k}: API parse accepts, cp = TapeCode-Test1`, !r.err && r.kind === k && r.cp === TC && r.hash === h, r.err);
    ok(`TC ${k}: xmOk rebuilds it with tk = TapeCode-Test1`, !!x && x.tk === TC);
    if (k === 'coll') { S.XM.book = [x]; ok('TC coll offer is not a voucher offer (xmBid voucher book empty)', !S.xmBid('1', sa) && !!S.xmBid(String(u1), sa, TC)); S.XM.book = []; } }
  { const o = S.xmMake('list', sa, u1, P, ts - 60, ts + 86400, 51n, 0n, false, '0x' + '12'.repeat(20)); ok('API rejects any other NFT contract', B.parse({ order: o, signature: '0x' + 'ab'.repeat(65), chain: 196 }).err === 'token'); }
  ok('seller approves TC #' + u1, await tx(sel, TC, '0x095ea7b3' + W(SP) + W(u1)));
  ts = await now();
  const TL = S.xmMake('list', sa, u1, P, ts - 60, ts + 86400, 52n, await ctr(sa), false, TC), TLs = await sign(sel, TL), s1 = await pv.getBalance(sa), f1 = await pv.getBalance(FEE_TO);
  ok('TC: buyer fulfils listing with OKB', await tx(buy, SP, S.xmBasic(TL, TLs, 0), P));
  ok('TC #' + u1 + ' -> buyer, seller +price-fee, fee wallet +0.75%', (await towner(u1)).toLowerCase() === ba && (await pv.getBalance(sa)) - s1 === P - F && (await pv.getBalance(FEE_TO)) - f1 === F);
  ok('buyer wraps + approves WOKB again', await tx(buy, WO, '0xd0e30db0', 3n * 10n ** 18n) && await tx(buy, WO, '0x095ea7b3' + W(SP) + W(3n * P)));
  ts = await now();
  const TCo =S.xmMake('coll', ba, 0, P, ts - 60, ts + 86400, 53n, await ctr(ba), false, TC), TCs = await sign(buy, TCo);
  ok('seller approves TC #' + u2, await tx(sel, TC, '0x095ea7b3' + W(SP) + W(u2)));
  const w2 = await wokb(sa), fw2 = await wokb(FEE_TO), tmd = S.xmMatchData(TCo, TCs, sa, u2, ts - 60, ts + 3600, 54n, TC);
  ok('TC: seller accepts the collection offer', await tx(sel, SP, tmd));
  ok('TC #' + u2 + ' -> bidder, seller +price-fee WOKB, fee wallet +fee', (await towner(u2)).toLowerCase() === ba && (await wokb(sa)) - w2 === P - F && (await wokb(FEE_TO)) - fw2 === F);
  console.log(`\nog-xl: ${pass} passed, ${fail} failed`);
})().catch(e => { console.error(e); fail++; }).finally(() => { if (anvil) anvil.kill(); process.exit(fail ? 1 : 0); });
