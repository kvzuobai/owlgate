// X Layer orders in tsd-bids.js (spec-xlayer-market B/C): templates accepted / rejected by parse(), order hash == Seaport.getOrderHash on 196,
// check() against the live X Layer chain (read-only eth_call), BSC template unchanged. No tx, throwaway keys only.
// Run: node tools/verify-xl-bids.js
const os = require('os'), path = require('path');
const { ethers } = require('./node_modules/ethers');
const B = require('./tsd-bids.js');
const XR = 'https://rpc.xlayer.tech', MC = '0xca11bde05977b3631167028862be2a173976ca11', SP = B.SEAPORT, FEE_TO = '0x58f341ebf80ab52d7650750119e8641cfbc8c018';
const CPU = '0xb1024b89886b9a34aa4ff5f31c411d708b20a14c', Z = '0x' + '0'.repeat(40), Z32 = '0x' + '0'.repeat(64);
let pass = 0, fail = 0; const ok = (n, c, d = '') => { c ? pass++ : fail++; console.log((c ? '  PASS ' : '  FAIL ') + n + (d ? '  [' + d + ']' : '')); };
const rpc = async (method, params) => { const r = await (await fetch(XR, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json(); if (r.error) throw Error(r.error.message); return r.result; };
const I3 = new ethers.Interface(['function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] returnData)']);
const mc = async calls => I3.decodeFunctionResult('aggregate3', await rpc('eth_call', [{ to: MC, data: I3.encodeFunctionData('aggregate3', [calls.map(([t, d]) => [t, true, d])]) }, 'latest']))[0].map(x => x.success && x.returnData !== '0x' ? x.returnData : null);
const OI = '(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount)', CI = '(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount,address recipient)';
const SPI = new ethers.Interface([`function getOrderHash((address offerer,address zone,${OI}[] offer,${CI}[] consideration,uint8 orderType,uint256 startTime,uint256 endTime,bytes32 zoneHash,uint256 salt,bytes32 conduitKey,uint256 counter) order) view returns (bytes32)`]);

(async () => {
  B.init({ dir: path.join(os.tmpdir(), 'og-xlb-' + Date.now()), cpus: [CPU], env: { BIDS_ENABLED: '1' }, feeTo: FEE_TO, rpc: null, mc: null, logs: null, head: () => ({ block: 0, ts: 0 }), xl: { rpc, mc } });
  const w = ethers.Wallet.createRandom(), a = w.address.toLowerCase(), now = Math.floor(Date.now() / 1e3), P = 2n * 10n ** 18n, F = P * 75n / 10000n, s = String;
  const tid = BigInt(await rpc('eth_call', [{ to: B.VOUCH, data: '0x4f6ccce7' + '0'.repeat(64) }, 'latest'])).toString(); // tokenByIndex(0)
  const base = { offerer: a, zone: Z, orderType: '0', startTime: s(now - 60), endTime: s(now + 86400), zoneHash: Z32, salt: '12345', conduitKey: Z32, counter: '0' };
  const it = (t, tok, id, amt, r) => ({ itemType: s(t), token: tok, identifierOrCriteria: s(id), startAmount: s(amt), endAmount: s(amt), ...(r ? { recipient: r } : {}) });
  const mk = { // the four templates the site signs
    bsc: () => ({ ...base, offer: [it(1, B.WBNB, 0, P)], consideration: [it(2, CPU, 7, 1, a), it(1, B.WBNB, 0, F, FEE_TO)] }),
    offer: () => ({ ...base, offer: [it(1, B.WOKB, 0, P)], consideration: [it(2, B.VOUCH, tid, 1, a), it(1, B.WOKB, 0, F, FEE_TO)] }),
    coll: () => ({ ...base, offer: [it(1, B.WOKB, 0, P)], consideration: [it(4, B.VOUCH, 0, 1, a), it(1, B.WOKB, 0, F, FEE_TO)] }),
    list: () => ({ ...base, offer: [it(2, B.VOUCH, tid, 1)], consideration: [it(0, Z, 0, P - F, a), it(0, Z, 0, F, FEE_TO)] }),
    listFree: () => ({ ...base, offer: [it(2, B.VOUCH, tid, 1)], consideration: [it(0, Z, 0, P, a)] }),
  };
  const sign = async (o, chainId) => w.signTypedData({ ...B.DOMAIN, chainId }, B.TYPES, o);
  const body = async (o, chain) => ({ order: o, signature: await sign(o, chain || 56), ...(chain ? { chain } : {}) });

  console.log('parse: accepted templates');
  const r0 = B.parse(await body(mk.bsc()));
  ok('BSC offer (no chain field) still accepted', !r0.err && r0.chain === 56 && r0.kind === 'offer', r0.err);
  for (const k of ['offer', 'coll', 'list', 'listFree']) {
    const r = B.parse(await body(mk[k](), 196));
    ok(`196 ${k}: kind ${r.kind}, price ${r.price}`, !r.err && r.chain === 196 && r.kind === (k === 'listFree' ? 'list' : k) && r.price === P && r.fee === (k === 'listFree' ? 0n : F), r.err);
    if (r.err) continue;
    const h = await rpc('eth_call', [{ to: SP, data: SPI.encodeFunctionData('getOrderHash', [r.o]) }, 'latest']);
    ok(`196 ${k}: hash == Seaport.getOrderHash on X Layer`, h.toLowerCase() === r.hash.toLowerCase());
  }

  console.log('parse: rejected');
  const bad = async (n, o, chain, sigChain, want) => { const r = B.parse({ order: o, signature: await sign(o, sigChain), ...(chain ? { chain } : {}) }); ok(n + ' -> ' + r.err, r.err === want); };
  await bad('196 offer signed for chain 56', mk.offer(), 196, 56, 'signature');
  await bad('voucher offer sent as BSC', mk.offer(), null, 56, 'template');
  await bad('listing sent as BSC', mk.list(), null, 56, 'template');
  await bad('chain 1', mk.offer(), 1, 1, 'chain');
  await bad('chain as string', mk.offer(), '196', 196, 'chain');
  const c1 = mk.coll(); c1.consideration[0].identifierOrCriteria = '99'; await bad('collection offer with a criteria root', c1, 196, 196, 'token');
  const c2 = mk.offer(); c2.consideration[1].startAmount = c2.consideration[1].endAmount = s(F - 1n); await bad('offer fee too low', c2, 196, 196, 'fee');
  const l1 = mk.list(); l1.consideration[1].startAmount = l1.consideration[1].endAmount = s(F / 2n); // (F-1 is a valid listing at price P-1: floor) await bad('listing fee too low', l1, 196, 196, 'fee');
  const l2 = mk.list(); l2.consideration[1].recipient = a; await bad('listing fee to someone else', l2, 196, 196, 'fee');
  const l3 = mk.list(); l3.consideration[0].recipient = FEE_TO; await bad('listing paying someone else', l3, 196, 196, 'template');
  const l4 = mk.list(); l4.consideration[0].token = B.WOKB; l4.consideration[0].itemType = '1'; await bad('listing for WOKB (not native)', l4, 196, 196, 'template');
  const l5 = mk.list(); l5.offer[0].token = CPU; await bad('listing another NFT', l5, 196, 196, 'token');
  const l6 = mk.list(); l6.offer[0].startAmount = l6.offer[0].endAmount = '2'; await bad('listing amount 2', l6, 196, 196, 'token');
  const o3 = mk.offer(); o3.offer[0].token = B.WBNB; await bad('X Layer offer in WBNB', o3, 196, 196, 'template');

  console.log('check: live X Layer reads');
  const row = (k, o) => { const r = B.parse({ order: o, signature: '0x' + '1'.repeat(130), chain: 196 }); return r; }; // template only, signature unused by check
  const pr = async k => { const r = B.parse(await body(mk[k](), 196)); return { hash: r.hash, offerer: r.offerer, cp: r.cp, tid: r.tid, price: s(r.price), end_t: r.end, counter: r.counter, chain: 196, kind: r.kind }; };
  const rows = [await pr('list'), await pr('offer'), await pr('coll')];
  const res = await B.check(rows);
  ok('listing by a non-holder -> inactive moved', res[0] && res[0].status === 'inactive' && res[0].reason === 'moved', JSON.stringify(res[0]));
  ok('offer without WOKB -> inactive balance', res[1] && res[1].status === 'inactive' && res[1].reason === 'balance', JSON.stringify(res[1]));
  ok('collection offer without WOKB -> inactive balance', res[2] && res[2].status === 'inactive' && res[2].reason === 'balance', JSON.stringify(res[2]));
  const holder = '0x' + (await rpc('eth_call', [{ to: B.VOUCH, data: '0x6352211e' + BigInt(tid).toString(16).padStart(64, '0') }, 'latest'])).slice(26);
  const hr = { ...rows[0], offerer: holder.toLowerCase() }, ctr = BigInt(await rpc('eth_call', [{ to: SP, data: '0xf07ec373' + holder.slice(2).padStart(64, '0') }, 'latest']));
  const [x] = await B.check([{ ...hr, counter: s(ctr) }]);
  ok('listing by the real holder, no Seaport approval -> inactive approval', x && x.status === 'inactive' && x.reason === 'approval', JSON.stringify(x));
  const [y] = await B.check([{ ...hr, counter: s(ctr + 1n) }]);
  ok('stale counter -> cancelled counter', y && y.status === 'cancelled' && y.reason === 'counter', JSON.stringify(y));
  B.init({ dir: path.join(os.tmpdir(), 'og-xlb2-' + Date.now()), cpus: [CPU], env: { BIDS_ENABLED: '1' }, feeTo: FEE_TO, rpc: null, mc: null, logs: null, head: () => ({ block: 0, ts: 0 }), xl: { rpc, mc: async () => { throw Error('down'); } } });
  const z = await B.check([rows[0]]);
  ok('X Layer RPC down -> row unread (null), no throw', z.length === 1 && z[0] == null);
  console.log(`\nxl-bids: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
