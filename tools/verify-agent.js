// Agent gate (og-agent.js, spec-xlayer-market D) end to end on an anvil fork of X Layer: a wallet that only follows the returned steps
// (send tx / sign typed data / POST) lists, buys, offers, accepts (basic + collection via match), cancels. Real bids store + route, real Seaport.
// No mainnet tx; anvil test keys only. Usage: node tools/verify-agent.js   (needs anvil in PATH)
const os = require('os'), path = require('path'), http = require('http'), { spawn } = require('child_process');
const { ethers } = require('./node_modules/ethers');
const B = require('./tsd-bids.js'), A = require('./og-agent.js');
const FORK = process.env.XL_FORK_URL || 'https://rpc.xlayer.tech', AP = 19945 + Math.floor(Math.random() * 400), RPC = `http://127.0.0.1:${AP}`;
const K0 = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', K1 = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const FEE_TO = '0x58f341ebf80ab52d7650750119e8641cfbc8c018', MC = '0xca11bde05977b3631167028862be2a173976ca11', VO = B.VOUCH, WO = B.WOKB, SP = B.SEAPORT;
let pass = 0, fail = 0; const ok = (n, c, d = '') => { c ? pass++ : fail++; console.log((c ? '  PASS ' : '  FAIL ') + n + (d ? '  [' + d + ']' : '')); };
const sleep = ms => new Promise(r => setTimeout(r, ms)), W = n => BigInt(n).toString(16).padStart(64, '0');
const I3 = new ethers.Interface(['function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] returnData)']);

let anvil, srv;
(async () => {
  anvil = spawn('anvil', ['--fork-url', FORK, '--port', String(AP), '--silent', '--chain-id', '196'], { stdio: 'ignore' });
  const pv = new ethers.JsonRpcProvider(RPC, 196, { staticNetwork: true });
  for (let i = 0; ; i++) { try { await pv.getBlockNumber(); break; } catch (e) { if (i > 60) throw Error('anvil did not start'); await sleep(500); } }
  const xrpc = (m, p) => pv.send(m, p);
  const xmc = async calls => I3.decodeFunctionResult('aggregate3', await xrpc('eth_call', [{ to: MC, data: I3.encodeFunctionData('aggregate3', [calls.map(([t, d]) => [t, true, d])]) }, 'latest']))[0].map(x => x.success && x.returnData !== '0x' ? x.returnData : null);
  B.init({ dir: path.join(os.tmpdir(), 'og-ag-' + Date.now()), cpus: [], env: { BIDS_ENABLED: '1' }, feeTo: FEE_TO, rpc: null, mc: null, logs: null, head: () => ({ block: 0, ts: 0 }), xl: { rpc: xrpc, mc: xmc } });
  const send = (res, code, b) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(b, (k, v) => typeof v === 'bigint' ? String(v) : v)); };
  const sel = new ethers.Wallet(K0, pv), buy = new ethers.Wallet(K1, pv), sa = sel.address.toLowerCase(), ba = buy.address.toLowerCase();
  const tok = async i => BigInt(await pv.call({ to: VO, data: '0x4f6ccce7' + W(i) })), owner = async id => ('0x' + (await pv.call({ to: VO, data: '0x6352211e' + W(id) })).slice(26)).toLowerCase();
  const T = [await tok(0), await tok(1), await tok(2), await tok(3)];
  const XL = { items: T.map(v => ({ v: Number(v), holder: sa, cp: '0xb1024b89886b9a34aa4ff5f31c411d708b20a14c', id: 1, power: 100, st: 1, vw: 1000, uw: 0, pend: 1 })), redeemOkb: 0.01 };
  const route = A({ B, xl: async () => XL, xrpc, xmc, mc: async calls => calls.map(() => '0x' + W(10n ** 8n)), bemUsd: () => 0.5, feeTo: FEE_TO, api: 'http://local', enabled: () => true });
  srv = http.createServer((req, res) => { const u = new URL(req.url, 'http://x'); if (route(u.pathname, u, res, send)) return; B.route(req, res, u.pathname, u, send, '1', false).then(h => { if (!h) send(res, 404, {}); }); });
  await new Promise(r => srv.listen(0, '127.0.0.1', r)); const base = 'http://127.0.0.1:' + srv.address().port;
  const get = async q => { const r = await fetch(base + q); return [r.status, await r.json()]; };
  // the "agent": follow the steps exactly as returned
  async function run(w, j) {
    let sig = null;
    for (const s of j.steps) {
      if (s.kind === 'tx') { const r = await (await w.sendTransaction({ to: s.to, data: s.data, value: BigInt(s.value) })).wait(); if (r.status !== 1) throw Error('tx failed: ' + s.label); }
      else if (s.kind === 'sign') { const ty = { ...s.typedData.types }; delete ty.EIP712Domain; sig = await w.signTypedData(s.typedData.domain, ty, s.typedData.message); }
      else if (s.kind === 'post') { const r = await fetch(base + '/bids', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...s.body, signature: sig }) }); const b = await r.json(); if (r.status !== 201) throw Error('post: ' + JSON.stringify(b)); return b.hash; }
    }
    return true;
  }
  for (const id of T) { const h = await owner(id); await pv.send('anvil_impersonateAccount', [h]); await pv.send('anvil_setBalance', [h, '0x56bc75e2d63100000']);
    await pv.send('eth_sendTransaction', [{ from: h, to: VO, data: '0x23b872dd' + W(h) + W(sa) + W(id) }]); }
  ok('seller holds 4 vouchers', (await Promise.all(T.map(owner))).every(x => x === sa));
  const P = '1.5', Pw = ethers.parseEther(P);

  console.log('list -> buy');
  let [c, j] = await get(`/xl/order/build?kind=list&from=${sa}&v=${T[0]}&price=${P}&days=1`);
  ok('build list: approve + sign + post', c === 200 && j.steps.map(s => s.kind).join() === 'tx,sign,post', c + ' ' + JSON.stringify(j).slice(0, 120));
  const lh = await run(sel, j); ok('listing published', /^0x[0-9a-f]{64}$/.test(lh));
  [c, j] = await get('/xl/market');
  const m0 = j.vouchers && j.vouchers.find(x => String(x.voucher) === String(T[0]));
  ok('market shows the ask + payback', c === 200 && m0 && m0.ask && m0.ask.hash === lh && m0.paybackDays > 0, JSON.stringify(m0 && m0.ask) + ' pb ' + (m0 && m0.paybackDays));
  ok('market has OKB price from the TWAP', j.prices && j.prices.okbUsd > 1, String(j.prices && j.prices.okbUsd));
  [c, j] = await get(`/xl/tx/buy?hash=${lh}&from=${sa}`); ok('buy own listing refused', c === 400);
  const s0 = await pv.getBalance(sa);
  [c, j] = await get(`/xl/tx/buy?hash=${lh}&from=${ba}`); ok('buy: one tx, dry run ok', c === 200 && j.steps.length === 1 && j.dryRun === 'ok' && BigInt(j.steps[0].value) === Pw);
  await run(buy, j); ok('voucher -> buyer, seller got the price minus the 0.75% fee', (await owner(T[0])) === ba && (await pv.getBalance(sa)) - s0 === Pw - Pw * 75n / 10000n);
  [c, j] = await get(`/xl/tx/buy?hash=${lh}&from=${ba}`); ok('second buy of the same listing: dry run blocks it', c === 409, c + ' ' + (j.error || ''));

  console.log('offer -> sell (basic)');
  [c, j] = await get(`/xl/order/build?kind=offer&from=${ba}&v=${T[1]}&price=${P}&days=3`);
  ok('build offer: wrap + approve + sign + post', c === 200 && j.steps.map(s => s.kind).join() === 'tx,tx,sign,post', j.steps && j.steps.map(s => s.label).join(' | '));
  const oh = await run(buy, j); ok('offer published', /^0x/.test(oh || ''));
  [c, j] = await get(`/xl/tx/sell?v=${T[1]}&from=${ba}`); ok('sell by non-holder refused', c === 403);
  [c, j] = await get(`/xl/tx/sell?v=${T[1]}&from=${sa}`);
  ok('sell: approve + accept, best offer picked', c === 200 && j.steps.length === 2 && j.summary.offer === oh, JSON.stringify(j.summary || j));
  const w0 = BigInt(await pv.call({ to: WO, data: '0x70a08231' + W(sa) }));
  await run(sel, j); ok('voucher -> bidder, seller got WOKB minus the 0.75% fee', (await owner(T[1])) === ba && BigInt(await pv.call({ to: WO, data: '0x70a08231' + W(sa) })) - w0 === Pw - Pw * 75n / 10000n);

  console.log('collection offer -> sell (match)');
  [c, j] = await get(`/xl/order/build?kind=coll&from=${ba}&price=1&days=1`); ok('build collection offer', c === 200 && j.summary.voucher === 'any', JSON.stringify(j.summary || j));
  { const [c2, j2] = await get(`/xl/order/build?kind=coll&from=${ethers.Wallet.createRandom().address}&price=0.01&days=1`); ok('unfunded wallet: 200 with steps, ready false, blocker', c2 === 200 && j2.ready === false && j2.blockers.length === 1 && j2.steps.some(s => s.kind === 'sign'), (j2.blockers || [j2.error]).join()); }
  { const [c2, j2] = await get(`/xl/market`); const c = c2, j = j2; ok('market top = highest bemPerDay, usdPerDay set', c === 200 && (!j.top || j.top.voucher === j.vouchers[0].voucher && j.vouchers.every((v, i) => !i || (v.bemPerDay || 0) <= (j.vouchers[i - 1].bemPerDay || 0))), JSON.stringify(j.top)); }
  const ch = await run(buy, j);
  [c, j] = await get(`/xl/tx/sell?v=${T[2]}&from=${sa}&hash=${ch}`); ok('sell into the collection offer (approve + match)', c === 200 && j.summary.kind === 'coll' && j.steps.length === 2, JSON.stringify(j).slice(0, 160));
  await run(sel, j); ok('voucher #' + T[2] + ' -> bidder', (await owner(T[2])) === ba);
  await B.tick(true); const st = B.one(ch); ok('store sees the collection offer filled', st && st.status === 'filled', st && st.status);

  console.log('cancel');
  [c, j] = await get(`/xl/order/build?kind=list&from=${sa}&v=${T[3]}&price=2`); const ch2 = await run(sel, j);
  [c, j] = await get(`/xl/tx/cancel?hash=${ch2}&from=${ba}`); ok('cancel by someone else refused', c === 404);
  [c, j] = await get(`/xl/tx/cancel?hash=${ch2}&from=${sa}`); await run(sel, j);
  await B.tick(true); ok('store sees the listing cancelled', B.one(ch2).status === 'cancelled', B.one(ch2).status);
  [c, j] = await get(`/xl/tx/buy?hash=${ch2}&from=${ba}`); ok('buy of a cancelled listing refused', c === 409);
  [c, j] = await get(`/xl/order/build?kind=list&from=${sa}&v=${T[3]}&price=0.001`); ok('price below 0.01 refused', c === 400);
  console.log(`\nagent: ${pass} passed, ${fail} failed`);
})().catch(e => { console.error(e); fail++; }).finally(() => { if (srv) srv.close(); if (anvil) anvil.kill(); setTimeout(() => process.exit(fail ? 1 : 0), 200); });
