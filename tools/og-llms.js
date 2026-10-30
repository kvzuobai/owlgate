// Rewrites the "## Live snapshot" section of llms.txt from /xl/market, so an AI agent that only reads llms.txt (ChatGPT does not open
// links inside it) still gets today's numbers. Cron on the VPS every 5 min:  */5 * * * * node /root/tsd/tools/og-llms.js >/dev/null 2>&1
// Usage: node tools/og-llms.js [llms.txt path] [api base]. On any fetch error the file is left as it is.
const fs = require('fs');
const FILE = process.argv[2] || '/var/www/owlgate/llms.txt', API = process.argv[3] || 'https://api.owlgate.xyz';
const n = (x, d) => x == null ? 'n/a' : (+x).toFixed(d).replace(/\.?0+$/, '');

(async () => {
  const m = await (await fetch(API + '/xl/market', { signal: AbortSignal.timeout(20000) })).json();
  if (!m.ok || !Array.isArray(m.vouchers)) throw Error('bad market answer');
  const p = m.prices || {}, vs = m.vouchers.filter(v => v.bemPerDay != null), t = new Date(m.t).toISOString().slice(0, 16).replace('T', ' ');
  const row = v => `| #${v.voucher} | ${v.rig.power} | ${n(v.bemPerDay, 4)} | ${v.usdPerDay == null ? 'n/a' : '$' + v.usdPerDay.toFixed(2)} | ${v.ask ? n(v.ask.priceOkb, 4) + ' OKB' : 'none'} | ${v.bestOffer ? n(v.bestOffer.priceWokb, 4) + ' WOKB' : 'none'} |`;
  const asks = m.vouchers.filter(v => v.ask).sort((a, b) => a.ask.priceOkb - b.ask.priceOkb), co = (m.collectionOffers || [])[0], top = vs[0];
  const live = [
    '## Live snapshot', '',
    `Updated ${t} UTC from [https://api.owlgate.xyz/xl/market](https://api.owlgate.xyz/xl/market), rewritten every 5 minutes. For newer numbers open that link.`, '',
    top ? `- Most BEM per day: voucher #${top.voucher}, ${n(top.bemPerDay, 4)} BEM/day, worth about $${top.usdPerDay == null ? 'n/a' : top.usdPerDay.toFixed(2)}/day gross (BEM $${n(p.bemUsd, 4)}). Estimate at today's BEM price and total mining power; it changes daily.` : '- Mining estimates unavailable right now.',
    '- These are the X Layer vouchers. Numbers like "TapeOut #17757" on other markets are BNB Chain rig IDs, not voucher numbers; use this list for X Layer.',
    `- Prices: BEM $${n(p.bemUsd, 4)} (${p.bemSource || 'n/a'}); OKB $${n(p.okbUsd, 2)} (${p.okbSource || 'n/a'}).`,
    `- Vouchers: ${m.vouchers.length}; listed for sale: ${asks.length}${asks[0] ? `, cheapest #${asks[0].voucher} at ${n(asks[0].ask.priceOkb, 4)} OKB` : ''}; best collection offer: ${co ? n(co.priceWokb, 4) + ' WOKB' : 'none'}.`, '',
    '| Voucher | Power | BEM/day | USD/day (gross) | Ask | Best offer |', '|---|---|---|---|---|---|', ...vs.slice(0, 10).map(row), ''].join('\n');
  const raw = fs.readFileSync(FILE, 'utf8'), crlf = raw.includes('\r\n'), s = raw.replace(/\r\n/g, '\n');
  const a = s.indexOf('## Live snapshot\n'); if (a < 0) throw Error('no "## Live snapshot" section');
  const b = s.indexOf('\n## ', a + 5), out = s.slice(0, a) + live + (b < 0 ? '' : s.slice(b));
  fs.writeFileSync(FILE + '.tmp', crlf ? out.replace(/\n/g, '\r\n') : out); fs.renameSync(FILE + '.tmp', FILE);
})().catch(e => { console.error('og-llms:', e.message); process.exit(1); });
