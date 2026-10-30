// OwlGate alert bot — Telegram, no dependencies (Node 18+). Run: node tsd-bot.js
// Alerts: (1) cheap miner listed on the circuit market (payback ≤ user limit), (2) big BEM sell on the main pools.
// Payment: user sends a unique BEM amount to TREASURY; the bot sees the Transfer on-chain and extends the subscription.
'use strict';
const fs=require('fs'),path=require('path');
// ---- config (.env next to this file) ----
try{for(const l of fs.readFileSync(path.join(__dirname,'.env'),'utf8').split(/\r?\n/)){const m=l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);if(m&&!(m[1] in process.env))process.env[m[1]]=m[2].replace(/(^|\s+)#.*$/,"")}}catch(e){}
const E=process.env,TOKEN=E.BOT_TOKEN,TREASURY=(E.TREASURY||'').toLowerCase(),PRICE=Math.round(Number(E.PRICE_BEM||0.25)*1e4)/1e4,TRIAL_MS=Number(E.TRIAL_HOURS||24)*36e5,
 PERIOD=Number(E.PERIOD_DAYS||30),BURN_PCT=Number(E.BURN_PCT||5),ADMIN=String(E.ADMIN_ID||''),DB=path.join(__dirname,E.DATA_FILE||'bot-data.json'),TSD='https://owlgate.xyz/';
const DRY=E.DRY==='1';// DRY=1: no Telegram, alerts printed to console, BACKFILL=<blocks> replays recent history
if(!DRY&&!TOKEN||!/^0x[0-9a-f]{40}$/.test(TREASURY)){console.error('Set BOT_TOKEN and TREASURY in bot/.env (see .env.example)');process.exit(1)}

// ---- chain ----
const RPCS=['https://tapeout.net/rpc','https://bsc-rpc.publicnode.com','https://bsc-dataseed.binance.org']; const LOGS=RPCS.slice(0,2);// getLogs: tapeout.net, fallback publicnode (binance dataseed rejects getLogs)
const MINING='0x7E2E0DC66a3bD9103E69b766afA62d9f7b697b46',CMKT='0x6feEbbEbC07BcB90bd1Ac8b0CF9BaA4f0fF2B46f',BEM='0x5ce033B2bFCa3Af30b3e8C8457DeaF776A8b695a',
 P1='0x3098D7A051045000d68eC0360753A40C8cABEa31',P2='0x2f5ec19ab0583D3FCd9bcbcD9AB416d2858EeA38',P3='0x28B12792F9D81Bd529Bc5572434E861C9EDbBBC2',PB='0x16b9a82891338f9bA80E2D6970FddA79D1eb0daE',
 DEAD='0x000000000000000000000000000000000000dead',
 T_TR='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',T_LI='0x723f73331eaee88eec7fc68ef60ab6ed15e4b90d0472b55eb92fa43910bab6dd',
 T_SW='0x19b47279256b2a23a1665c810c8d55a1758940ee09377d4f8d26497a3577dc83',T_SO='0x2938a0a3a4a7c19c3a1fe6ef25340b7acd26dfac11de87836084d42fccc18656';
const CPUS={'0xb1024b89886b9a34aa4ff5f31c411d708b20a14c':'TapeOut','0x1f5cb4aeae1807bf60c3b9c0d8adbcc14e91f12c':'Behemoth'};// official processors only
const POOL={[P1.toLowerCase()]:0,[P2.toLowerCase()]:0,[P3.toLowerCase()]:1};// 0: token0 USDT, 1: token0 BEM / token1 WBNB
let rid=0;const sleep=ms=>new Promise(r=>setTimeout(r,ms)),hx=n=>'0x'+n.toString(16),W=n=>BigInt(n).toString(16).padStart(64,'0');
const wd=(h,i)=>BigInt('0x'+(h.replace(/^0x/,'').substr(i*64,64)||'0')),nw=(h,i,d=0)=>Number(wd(h,i))/10**d,sgn=x=>BigInt.asIntN(256,x);
const tad=x=>'0x'+String(x).slice(26).toLowerCase();
async function post(u,m,p){const r=await fetch(u,{signal:AbortSignal.timeout(20000),method:'POST',headers:{'content-type':'text/plain'},body:JSON.stringify({jsonrpc:'2.0',id:++rid,method:m,params:p})});
 const j=await r.json();if(j.error){const e=Error(j.error.message);e.rpc=1;throw e}return j.result}
async function rpc(m,p,urls=RPCS,n=3){let err;for(const u of urls)for(let k=0;k<n;k++){try{return await post(u,m,p)}catch(e){err=e;if(e.rpc)break;await sleep(700*(k+1))}}throw err}
const call=(to,data,tag='latest')=>rpc('eth_call',[{to,data},tag],tag==='latest'?RPCS:[RPCS[0]]);
const blk=async n=>{const b=await rpc('eth_getBlockByNumber',[typeof n==='number'?hx(n):n,false]);return{n:parseInt(b.number,16),ts:parseInt(b.timestamp,16)}};

// protocol snapshot, refreshed every 10 min (same formulas as OwlGate Check)
let P=null;
async function loadP(){const h=await blk('latest'),h2=await blk(h.n-2000),bt=(h.ts-h2.ts)/2000;
 const[s0,rb,rt,tv,tu]=await Promise.all([call(P1,'0x3850c7bd'),call(PB,'0x0902f1ac'),call(MINING,'0xf9f8bdb7'),call(MINING,'0xef6aff46'),call(MINING,'0x63967742').catch(()=>null)]);
 let tv7=null;try{tv7=nw(await call(MINING,'0xef6aff46',hx(h.n-Math.round(7*86400/bt))),0)}catch(e){}
 const sp=nw(s0,0)/2**96,bemUsd=1/(sp*sp*1e10),bnbUsd=nw(rb,0)/nw(rb,1);
 P={at:Date.now(),bt,bemUsd,bnbUsd,bemBnb:bemUsd/bnbUsd,day:nw(rt,0,8)*86400,tv:nw(tv,0),tu:tu?nw(tu,0):0,g:tv7?nw(tv,0)/tv7-1:0}}
// BEM/day of a rig: 99% of emission by verified weight + 1% by unverified weight (same as /check, the digest and the site)
const dOf=(vw,uw)=>(vw>0?.99*P.day*vw/P.tv:0)+(uw>0&&P.tu?.01*P.day*uw/P.tu:0);
function payback(cost,inc,g){if(!cost||!inc)return null;let s=0;for(let d=1;d<=1095;d++){s+=inc/Math.pow(1+Math.max(g,0),d/7);if(s>=cost)return d}return Infinity}

// ---- storage ----
let S={b:0,u:{},inv:{},paid:[],burn:0};try{S={...S,...JSON.parse(fs.readFileSync(DB,'utf8'))}}catch(e){}
const save=()=>{fs.writeFileSync(DB+'.tmp',JSON.stringify(S));fs.renameSync(DB+'.tmp',DB)};
const DAY=864e5,now=()=>Date.now();
const U=(id,lc)=>S.u[id]||(S.u[id]={lang:/^zh/.test(lc||'')?'zh':'en',exp:0,trial:1,on:1,pb:120,usd:2000,warn:2,since:now()});
const live=u=>u.on&&!u.blocked&&u.exp>now();

// ---- texts (EN + 简体中文 only) ----
const TX={en:{
 hi:'<b>OwlGate</b> — Check a rig. Independent, non-custodial tools for TapeOut / $BEM (check, buy, list, alerts; you always sign in your own wallet): <a href="https://owlgate.xyz/">owlgate.xyz</a>\n\nStart here (free):\n• /check 17628 — payback estimate for a circuit\n• /watch 0x… — digest of your wallet\n• /snipe add behemoth 60 0.5 p50 — snipe alert (payback, price, power) + OwlGate buy link; you sign in your own wallet\n\nPaid alerts (cheap listings, big BEM sells): 24 h free trial after you prove wallet ownership with /trial, then /pay.\n/help — all commands. Not financial advice.',
 hiK:'Tester? Tell us what you think with /feedback. It lists 4 short questions.',
 help:'/check 17628 — payback estimate for a circuit (free)\n/listings — cheapest circuits for sale now (free)\n/trial — start the 24 h trial of paid alerts (wallet proof)\n/status — subscription and settings\n/pay — pay with BEM ({p} BEM / {n} days)\n/payback 90 — max payback days for listing alerts\n/sell 2000 — min USD for sell alerts (0 = off)\n/off · /on — pause or resume\n/burn — treasury and burn totals\n/watch 0x… · /mywatch · /unwatch 0x… — digest of your wallet (free)\n/digest daily|weekly|off|now\n/trades on|off — real-time buys, sells, listings of watched wallets (free)\n/dealalert behemoth 60 — alert for listings under your payback days (free)\n/snipe add behemoth 60 0.5 p50 — snipe alerts: payback, price, power; alert with an OwlGate buy link, you sign (free)\n/snipe xl 60 2 p50 — the same for X Layer voucher listings (price in OKB)\n/feedback text\n/lang en|zh\n\nPayback uses the same model as OwlGate (with dilution). Not financial advice.',
 st:'Plan: <b>{pl}</b> · until <b>{e}</b> ({l} days left)\nAlerts: {on}\nListing alert if payback ≤ <b>{pb}</b> days\nSell alert if ≥ <b>${usd}</b>',
 trial:'free trial',nostart:'trial not started (/trial)',paidP:'paid',exp:'expired',onY:'on',onN:'paused',
 pay:'Send <b>exactly</b>\n<code>{a}</code> BEM\nto treasury (BNB Chain):\n<code>{t}</code>\n\nThe last 4 digits identify you. Pay within 48 h from any wallet. For 3 periods send <code>{a3}</code> (same last 4 digits).\nYour plan extends by {n} days when the transfer is seen (≈1 min).\n\n{bp}% of every payment is burned — check /burn.',
 got:'✅ Payment received: {a} BEM. Plan active until <b>{e}</b>. Thank you!',
 w2:'⏳ Your OwlGate alerts end in 2 days ({e}). /pay to keep them.',
 w2t:'⏳ Your free OwlGate trial ends in about 3 hours ({e} UTC). Your listing alert limit is {pb} days (/payback to change). /pay to keep alerts ({p} BEM / {n} days). Model estimate, not advice.',w0:'Your OwlGate alerts have ended. /pay to turn them back on.',
 set:'Saved.',bad:'Usage: {c}',off:'Paused. /on to resume.',on:'Resumed.',needPay:'Paid alerts are not active. /trial (24 h free, wallet proof) or /pay.',
 burn:'Treasury <code>{t}</code>\nReceived: <b>{r}</b> BEM from {n} payments\nBurned from treasury: <b>{b}</b> BEM ({p} of received)',
 li:'🟢 <b>Listed below your payback limit</b>\n{c} #{id} · <b>{px} BNB</b> (${u})\nEst. payback ≈ <b>{pb} days</b> (with dilution) · {d} BEM/day\nWeight {w} · {s} of verified pool\nModel estimate, not advice.\n<a href="{tsd}">Buy on OwlGate</a> · <a href="https://bscscan.com/tx/{tx}">tx</a>',
 lix:'🟢 <b>Listed below your payback limit</b> (another market)\n{c} #{id} · <b>{px} BNB</b> incl. buyer fee (${u})\nEst. payback ≈ <b>{pb} days</b> (with dilution) · {d} BEM/day\nWeight {w} · {s} of verified pool\nModel estimate, not advice. Not buyable in OwlGate.\n<a href="{tsd}">Check in OwlGate</a>',
 sell:'🔴 <b>Big BEM sell</b>: {x} BEM ≈ <b>${u}</b>\nprice ${p} · <a href="https://bscscan.com/tx/{tx}">tx</a>'},
zh:{
 hi:'<b>OwlGate</b> — 查询矿机。面向 TapeOut / $BEM 的独立非托管工具（检查、购买、挂单、提醒；始终由你在自己的钱包签名）：<a href="https://owlgate.xyz/">owlgate.xyz</a>\n\n从这里开始（免费）：\n• /check 17628 — 电路回本估算\n• /watch 0x… — 钱包简报\n• /snipe add behemoth 60 0.5 p50 — 狙击提醒（回本、价格、算力）+ OwlGate 购买链接；由你在自己的钱包签名\n\n付费提醒（低价上架、大额卖出 BEM）：用 /trial 证明钱包归你后，免费试用 24 小时，之后 /pay。\n/help — 全部命令。不构成投资建议。',
 hiK:'测试用户？欢迎用 /feedback 告诉我们你的想法，里面有 4 个简短问题。',
 help:'/check 17628 — 电路回本估算（免费）\n/listings — 当前在售最划算的电路（免费）\n/trial — 开始 24 小时付费提醒试用（需钱包证明）\n/status — 订阅与设置\n/pay — 用 BEM 付费（{p} BEM / {n} 天）\n/payback 90 — 上架提醒的最长回本天数\n/sell 2000 — 卖出提醒最小金额（美元，0 = 关闭）\n/off · /on — 暂停或恢复\n/burn — 金库与销毁统计\n/watch 0x… · /mywatch · /unwatch 0x… — 钱包简报（免费）\n/digest daily|weekly|off|now\n/trades on|off — 关注钱包的实时买入、卖出、挂单（免费）\n/dealalert behemoth 60 — 低于你回本天数的挂单提醒（免费）\n/snipe add behemoth 60 0.5 p50 — 狙击提醒：回本、价格、算力；附 OwlGate 购买链接，由你签名（免费）\n/snipe xl 60 2 p50 — X Layer 凭证挂单的同类提醒（价格以 OKB 计）\n/feedback 内容\n/lang en|zh\n\n回本按 OwlGate 同一模型（含稀释）。不构成投资建议。',
 st:'方案：<b>{pl}</b> · 到期 <b>{e}</b>（剩 {l} 天）\n提醒：{on}\n回本 ≤ <b>{pb}</b> 天才提醒上架\n卖出 ≥ <b>${usd}</b> 才提醒',
 trial:'免费试用',nostart:'试用未开始（/trial）',paidP:'已付费',exp:'已到期',onY:'开启',onN:'已暂停',
 pay:'请<b>精确</b>转账\n<code>{a}</code> BEM\n到金库（BNB Chain）：\n<code>{t}</code>\n\n末 4 位数字用于识别你。请在 48 小时内用任意钱包付款。购买 3 期请转 <code>{a3}</code>（末 4 位相同）。\n链上确认后（约 1 分钟）自动延长 {n} 天。\n\n每笔付款的 {bp}% 将被销毁 — 见 /burn。',
 got:'✅ 已收到 {a} BEM。方案有效至 <b>{e}</b>。谢谢！',
 w2:'⏳ 你的 OwlGate 提醒将在 2 天后到期（{e}）。/pay 续费。',
 w2t:'⏳ 你的 OwlGate 免费试用将在约 3 小时后结束（{e} UTC）。上架提醒的回本上限为 {pb} 天（/payback 可修改）。/pay 续费保持提醒（{p} BEM / {n} 天）。模型估算，不构成建议。',w0:'你的 OwlGate 提醒已到期。/pay 重新开启。',
 set:'已保存。',bad:'用法：{c}',off:'已暂停。/on 恢复。',on:'已恢复。',needPay:'付费提醒未开启。/trial（24 小时免费，需钱包证明）或 /pay。',
 burn:'金库 <code>{t}</code>\n已收到：<b>{r}</b> BEM，共 {n} 笔\n金库已销毁：<b>{b}</b> BEM（占收入 {p}）',
 li:'🟢 <b>低于你的回本上限的上架</b>\n{c} #{id} · <b>{px} BNB</b>（${u}）\n预计回本约 <b>{pb} 天</b>（含稀释）· {d} BEM/天\n算力 {w} · 占已验证池 {s}\n模型估算，不构成建议。\n<a href="{tsd}">在 OwlGate 购买</a> · <a href="https://bscscan.com/tx/{tx}">交易</a>',
 lix:'🟢 <b>低于你的回本上限的上架</b>（其他市场）\n{c} #{id} · <b>{px} BNB</b>（含买方手续费，${u}）\n预计回本约 <b>{pb} 天</b>（含稀释）· {d} BEM/天\n算力 {w} · 占已验证池 {s}\n模型估算，不构成建议。无法在 OwlGate 购买。\n<a href="{tsd}">在 OwlGate 检查</a>',
 sell:'🔴 <b>大额卖出 BEM</b>：{x} BEM ≈ <b>${u}</b>\n价格 ${p} · <a href="https://bscscan.com/tx/{tx}">交易</a>'}};
// parse_mode is HTML: every substituted value is escaped (only the prebuilt OwlGate link, made from numbers, is passed raw)
const eh=s=>String(s).replace(/[&<>"']/g,c=>'&#'+c.charCodeAt(0)+';');
const t=(u,k,o={})=>TX[u.lang][k].replace(/\{(\w+)\}/g,(_,x)=>x in o?(x==='tsd'?o[x]:eh(o[x])):'{'+x+'}');
const f=(x,d=2)=>x==null||!isFinite(x)?'—':x.toLocaleString('en-US',{maximumFractionDigits:d});
const dt=ms=>new Date(ms).toISOString().slice(0,10);

// ---- telegram ----
const TG=(m,p)=>fetch(`https://api.telegram.org/bot${TOKEN}/${m}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(p),signal:AbortSignal.timeout(65000)}).then(r=>r.json());
async function send(id,text,kb){const r=await TG('sendMessage',{chat_id:id,text,parse_mode:'HTML',disable_web_page_preview:true,...(kb?{reply_markup:{inline_keyboard:kb}}:{})}).catch(e=>({ok:false,description:e.message}));
 if(!r.ok&&r.error_code===403&&S.u[id]){S.u[id].blocked=1;save()}if(!r.ok&&r.error_code===429)await sleep((r.parameters?.retry_after||1)*1000);return r.ok}
async function fan(pred,mk){if(DRY){const d={lang:'en',pb:Number(E.DRY_PB||365),usd:Number(E.DRY_USD||2000)};if(pred(d))console.log('\n[ALERT]\n'+mk({lang:'en'}).replace(/<[^>]+>/g,''));return}for(const[id,u]of Object.entries(S.u))if(live(u)&&pred(u)){await send(id,mk(u));if(!u.act){u.act=now();save()}await sleep(60)}}

function invoice(id){for(const[c,v]of Object.entries(S.inv))if(v.id===id&&v.until>now())return c;
 let c;do{c=String(1+Math.floor(Math.random()*9999))}while(S.inv[c]&&S.inv[c].until>now());S.inv[c]={id,until:now()+2*DAY};save();return c}
// amount = n × PRICE + code × 1e-8 (BEM has 8 decimals; the last 4 digits identify the invoice)
const UNIT=BigInt(Math.round(PRICE*1e4))*10000n,amt=(c,n=1)=>{const r=UNIT*BigInt(n)+BigInt(c),z=r.toString().padStart(9,'0');return z.slice(0,-8)+'.'+z.slice(-8)};

async function onMsg(m){const id=String(m.chat.id),isNew=!S.u[id],u=U(id,m.from?.language_code),[cmd,arg,arg2]=(m.text||'').trim().split(/\s+/);u.blocked=0;if(m.from?.username)u.un=m.from.username.toLowerCase();
 if(isNew&&ADMIN&&id!==ADMIN)send(ADMIN,`new user ${id}${u.un?' @'+eh(u.un):''} · ${eh(u.lang)} · trial not started (needs wallet proof) · total ${Object.keys(S.u).length}`);
 const c=cmd.split('@')[0].toLowerCase();let r;
 if(isNew&&c==='/start'&&/^[\w-]{1,32}$/.test(arg||''))u.src=arg.toLowerCase();if(isNew)save();
 if(c==='/start'&&/^w_0x[0-9a-fA-F]{40}$/.test(arg||'')){if(isNew)await send(id,t(u,'hi'));r=await watchCmd('/watch',arg.slice(2),'',u,id,m)} // site Follow: t.me/<bot>?start=w_0x…
 else if(c==='/start')r=t(u,'hi')+(/^kol_/.test((arg||'').toLowerCase())?'\n\n'+t(u,'hiK'):'')+(isNew?'':'\n\n'+t(u,'st',stO(u)))+(arg==='trial'?'\n\n'+trialCmd('/trial','','',u,id):arg==='rule'?'\n\n'+wt(u,'rUse',{m:RMAX}):'');// site buttons: t.me/<bot>?start=trial|rule
 else if(c==='/help')r=t(u,'help',{p:PRICE,n:PERIOD});
 else if(c==='/status')r=t(u,'st',stO(u));
 else if(c==='/pay'){const k=invoice(id);r=t(u,'pay',{a:amt(k),a3:amt(k,3),t:TREASURY,n:PERIOD,bp:BURN_PCT})}
 else if(c==='/payback'){const v=parseInt(arg);if(v>0&&v<=1095){u.pb=v;r=t(u,'set')}else r=t(u,'bad',{c:'/payback 90'})}
 else if(c==='/sell'){const v=Number(arg);if(v>=0){u.usd=v;r=t(u,'set')}else r=t(u,'bad',{c:'/sell 2000'})}
 else if(c==='/off'){u.on=0;r=t(u,'off')}else if(c==='/on'){u.on=1;r=u.exp>now()?t(u,'on'):t(u,'needPay')}
 else if(c==='/lang'){if(arg==='en'||arg==='zh'){u.lang=arg;r=t(u,'set')}else r=t(u,'bad',{c:'/lang en | /lang zh'})}
 else if(c==='/burn')r=await burnTxt(u);
 else if(c==='/trial'||c==='/verify')r=trialCmd(c,arg,arg2,u,id);
 else if(c==='/rule'||c==='/snipe')r=ruleCmd(u,m);
 else if(c==='/rulestats'&&id===ADMIN)r=await ruleStats();
 else if(WCMD.has(c))r=await watchCmd(c,arg,arg2,u,id,m);
 else if(c==='/stats'&&id===ADMIN){const a=Object.values(S.u);r=`users ${a.length} · live ${a.filter(live).length} · trial ${a.filter(x=>x.trial&&live(x)).length} · paid ${a.filter(x=>!x.trial&&live(x)).length} · payments ${S.paid.length}`;const nu=h=>a.filter(x=>x.since>now()-h*3600000).length,bs={};a.forEach(x=>{const k=x.src||'(none)';bs[k]=(bs[k]||0)+1});r+=`
new 24h ${nu(24)} · 7d ${nu(168)}
by source (started/activated/paid): `+(Object.entries(bs).sort((p,q)=>q[1]-p[1]).map(e=>{const m=a.filter(x=>(x.src||'(none)')===e[0]);return e[0]+' '+e[1]+'/'+m.filter(x=>x.act).length+'/'+m.filter(x=>!x.trial).length}).join(' · '))+`
by group: `+(Object.entries(Object.entries(bs).reduce((g,e)=>{const m=/^([a-z]+_)/.exec(e[0]),k=m?m[1]+'*':e[0];g[k]=(g[k]||0)+e[1];return g},{})).sort((p,q)=>q[1]-p[1]).map(e=>e[0]+' '+e[1]).join(' · '))+gStats()+wStats()}
 // /grant <@username|chatId> <days|life>: founder = life, core team = 60 (target must /start first)
 else if(c==='/grant'&&id===ADMIN){const k=(arg||'').replace(/^@/,'').toLowerCase(),gid=S.u[k]?k:Object.keys(S.u).find(x=>S.u[x].un===k),d=arg2==='life'?36500:parseInt(arg2);
  if(!gid||!(d>0))r='usage: /grant @username 60 | /grant @username life (user must /start first)';
  else{const g=S.u[gid];g.exp=now()+d*DAY;g.trial=arg2==='life'?0:1;g.on=1;r=`granted ${gid}${g.un?' @'+g.un:''} until ${dt(g.exp)}`}}
 else if(c==='/unpay'&&id===ADMIN){const k=(arg||'').toLowerCase();
  if(k.length<10)r='payments:\n'+(S.paid.map(x=>`${x.tx.slice(0,12)} ${x.a} BEM ${x.from.slice(0,8)}… ${x.id||'unmatched'} ${dt(x.at)}`).join('\n')||'none')+'\n\nusage: /unpay 0xfd5ea069b9 (removes it from /burn totals only; does not change any subscription)';
  else{const b=S.paid.length;S.paid=S.paid.filter(x=>!x.tx.startsWith(k));r=`removed ${b-S.paid.length} payment(s) from stats`}}
 else if(c==='/broadcast'&&id===ADMIN){const tx=(m.text||'').replace(/^\S+\s*/,''),to=Object.keys(S.u).filter(k=>!S.u[k].blocked);
  if(tx==='ok'&&S.bc){let n=0;for(const k of to){if(await send(k,S.bc[S.u[k].lang==='zh'?'zh':'en']))n++;await sleep(60)}r='broadcast sent '+n+'/'+to.length;S.bc=null}
  else if(!tx||tx==='ok')r='usage: /broadcast EN text, a line ---, ZH text (HTML allowed). Sends you a preview; then /broadcast ok sends to all non-blocked users.';
  else{const[en,zh]=tx.split(/\r?\n-{3,}\r?\n/);S.bc={en:en.trim(),zh:(zh||en).trim()};const ok=await send(id,S.bc.en)&&await send(id,S.bc.zh);
   if(!ok)S.bc=null;r=ok?'preview above (EN, ZH). /broadcast ok → send to '+to.length+' users':'preview failed (bad HTML?), nothing saved'}}
 else r=t(u,'help',{p:PRICE,n:PERIOD});
 save();if(r)await send(id,r)}
const stO=u=>({pl:!u.exp?t(u,'nostart'):u.exp<=now()?t(u,'exp'):u.trial?t(u,'trial'):t(u,'paidP'),e:u.exp?dt(u.exp):'—',l:Math.max(0,Math.ceil((u.exp-now())/DAY)),on:t(u,u.on?'onY':'onN'),pb:u.pb,usd:f(u.usd,0)});
async function burnTxt(u){const r=S.paid.reduce((s,x)=>s+x.a,0),b=S.burn;
 return t(u,'burn',{t:TREASURY,r:f(r,4),n:S.paid.length,b:f(b,4),p:r?f(b/r*100,1)+'%':'—'})}
async function tgLoop(){let off=0;for(;;){try{const r=await TG('getUpdates',{offset:off,timeout:50,allowed_updates:['message','callback_query']});
 if(r.ok)for(const x of r.result){off=x.update_id+1;if(x.callback_query){onCb(x.callback_query).catch(e=>console.error('cb',e.message));continue}{const m=x.message;if(m?.text&&m.chat){if(m.chat.type==='private'){if(!await gMsg(m))await onMsg(m).catch(e=>console.error('msg',e.message))}else gMsg(m).catch(e=>console.error('g',e.message))}}}else await sleep(5000)}catch(e){await sleep(5000)}}}

// ---- D45: /check in groups. Explicit commands only (never reads other messages), no referral links, rate limited,
//      per-chat on/off by admins, per-chat measurement by hashed slug (no chat/user id stored in clear). ----
const crypto=require('crypto');
S.g=S.g||{};S.salt=S.salt||crypto.randomBytes(12).toString('hex');
let BOTNAME='';const hh=k=>crypto.createHash('sha256').update(S.salt+'|'+k).digest('hex').slice(0,10);
const CPA=Object.keys(CPUS),PROC={tapeout:0,to:0,'0':0,behemoth:1,bh:1,'1':1},FACT_AL={'/check':null,'/查':'zh','/jiancha':'zh','/check_zh':'zh','/check_en':'en'},ADMC=['/tsd_off','/tsd_on','/tsd_lang'];
const tmo=(p,ms)=>{let h;return Promise.race([p,new Promise((_,r)=>{h=setTimeout(()=>r(Error('timeout')),ms);h.unref&&h.unref()})]).finally(()=>clearTimeout(h))};
function parseCmd(text,bot){if(typeof text!=='string'||text.length>200||text[0]!=='/')return null;
 const p=text.trim().split(/\s+/),h=p[0].split('@');if(h.length>2)return null;if(h[1]&&bot&&h[1].toLowerCase()!==bot.toLowerCase())return null;
 return{c:h[0].toLowerCase(),a:p.slice(1,6)}}
function parseCheck(a,al){let lang=al||null,cp=0,addr=null,id=null,bare=false,m;const rest=[];
 for(const w0 of a){const w=w0.toLowerCase();if(w==='zh'||w==='cn'||w==='中文'||w==='简体')lang='zh';else if(w==='en')lang='en';else rest.push(w)}
 if(rest.length===1&&(m=rest[0].match(/^(0x[0-9a-f]{40})[:#](\d{1,9})$/)))addr=m[1],id=m[2];
 else if(rest.length===1&&/^#?\d{1,9}$/.test(rest[0]))id=rest[0].replace('#',''),bare=true;
 else if(rest.length===2&&/^#?\d{1,9}$/.test(rest[1])){id=rest[1].replace('#','');
  if(/^0x[0-9a-f]{40}$/.test(rest[0]))addr=rest[0];else if(Object.hasOwn(PROC,rest[0]))cp=PROC[rest[0]];else return{err:1,lang}}
 else return{err:1,lang};
 if(addr){const k=CPA.indexOf(addr);if(k>=0){cp=k;addr=null}}
 return{lang,cp,addr,id:String(BigInt(id)),bare}}
// rate limit: per chat and per user, 1 / 10 s each, 30 / hour per chat, 20 / hour per user. Rejected calls are not recorded.
const RL={c:new Map(),u:new Map()};
// private chats (pv): 1 / 3 s, 60 / hour. On reject RL.why = 1 (too fast) or 2 (hourly cap, RL.wait = minutes until a slot frees).
function allow(ch,us,t=now(),pv=false){const gap=pv?3e3:1e4;RL.why=0;const lim=(m,k,hr)=>{if(m.size>5000)for(const[q,v]of m)if(!v.length||t-v[v.length-1]>36e5)m.delete(q);
  const a=(m.get(k)||[]).filter(x=>t-x<36e5);m.set(k,a);if(a.length>=hr){RL.why=2;RL.wait=Math.max(1,Math.ceil((a[a.length-hr]+36e5-t)/6e4));return false}
  if(a.length&&t-a[a.length-1]<gap){RL.why=1;return false}return true};
 if(!lim(RL.c,ch,pv?60:30)||!lim(RL.u,us,pv?60:20))return false;RL.c.get(ch).push(t);RL.u.get(us).push(t);return true}
const GT={en:{
 use:'Usage: <code>/check 17628</code> · <code>/check behemoth 17628</code> · <code>/check 0x…:17628</code>. Add <code>zh</code> for Chinese.',
 slow:'Too fast, please wait a few seconds.',hour:'Hourly limit reached. Try again in about {m} min.',busy:'Chain data is unavailable right now, try again later.',none:'{c} #{id} does not exist.',
 unoff:'<code>{a}</code> is not an official processor (TapeOut / Behemoth). Circuits there cannot mine $BEM. Check the address carefully.',
 st:{0:'idle (not mining)',1:'mining',2:'revoked (cannot mine)',3:'cooling down (not mining)'},
 pool:{v:'Pool: verified (99% of emission)',u:'Pool: unverified (shares only 1%)',n:'Pool: none (not earning now)'},
 own:'Owner',ls:'Listed: <b>{px} BNB</b> (~${u})',nol:'Not listed on the circuit market.',lsx:'Listed on another market: <b>{px} BNB</b> incl. buyer fee (~${u}). Not buyable in OwlGate.',
 pb:'Est. payback: about <b>{d} days</b> (with dilution, ~{b} BEM/day)',pbL:'Est. payback: over 1095 days (with dilution)',pbN:'Est. payback: n/a (needs a listing and a verified, mining circuit)',
 pend:'⚠ {b} BEM unclaimed. It goes to whoever holds the circuit when claimed; the seller can claim it before you buy, so do not pay for it.',
 ft:'Estimate, not advice. Independent non-custodial tool, not official TapeOut.',lk:'Open on OwlGate',hint:'Processor defaults to TapeOut. For Behemoth: /check behemoth {id}',
 intro:'<b>OwlGate /check</b>: payback estimate for one rig.\nEvery circuit has a number (its ID, e.g. #17628). Send <code>/check 17628</code>, or tap a command below.',
 top:'Shortest est. payback for sale now:',topI:'{cmd} · {c} · {px} BNB · ~{d} days',topIx:'{cmd} · {c} · {px} BNB · ~{d} days · other market',all:'All circuits for sale: {a}',mk:'OwlGate Market',
 off:'OwlGate /check is now off in this chat. Admins: /tsd_on to turn it on.',on:'OwlGate /check is now on in this chat.',lg:'Chat language set to English.'},
 zh:{use:'用法：<code>/check 17628</code> · <code>/check behemoth 17628</code> · <code>/check 0x…:17628</code>。加 <code>en</code> 切换英文。',
 slow:'太快了，请稍等几秒。',hour:'已达每小时上限，请约 {m} 分钟后再试。',busy:'暂时无法读取链上数据，请稍后再试。',none:'{c} #{id} 不存在。',
 unoff:'<code>{a}</code> 不是官方处理器（TapeOut / Behemoth）。该处理器上的电路不能挖 $BEM。请仔细核对地址。',
 st:{0:'闲置（未在挖矿）',1:'挖矿中',2:'已撤销（不能挖矿）',3:'冷静期（未在挖矿）'},
 pool:{v:'矿池：已验证（占 99% 排放）',u:'矿池：未验证（仅分 1%）',n:'矿池：无（当前无收益）'},
 own:'持有人',ls:'挂单：<b>{px} BNB</b>（约 ${u}）',nol:'未在电路市场挂单。',lsx:'在其他市场挂单：<b>{px} BNB</b>（含买方手续费，约 ${u}）。无法在 OwlGate 购买。',
 pb:'预估回本：约 <b>{d} 天</b>（含稀释，约 {b} BEM/天）',pbL:'预估回本：超过 1095 天（含稀释）',pbN:'预估回本：无（需要有挂单，且电路已验证并在挖矿）',
 pend:'⚠ {b} BEM 未领取。领取时归持有人所有；卖家可在你购买前领走，不要为此付钱。',
 ft:'估算，不构成建议。独立非托管工具，非 TapeOut 官方。',lk:'在 OwlGate 打开',hint:'处理器默认为 TapeOut。Behemoth 请用：/check behemoth {id}',
 intro:'<b>OwlGate /check</b>：估算单台矿机的回本时间。\n每个电路都有编号（ID，例如 #17628）。发送 <code>/check 17628</code>，或点击下方命令。',
 top:'当前在售、预估回本最快：',topI:'{cmd} · {c} · {px} BNB · 约 {d} 天',topIx:'{cmd} · {c} · {px} BNB · 约 {d} 天 · 其他市场',all:'全部在售电路：{a}',mk:'OwlGate 市场',
 off:'本群已关闭 OwlGate /check。管理员发送 /tsd_on 可重新开启。',on:'本群已开启 OwlGate /check。',lg:'本群语言已设为简体中文。'}};
const gt=(l,k,o={})=>String(GT[l][k]).replace(/\{(\w+)\}/g,(_,x)=>x in o?eh(o[x]):'{'+x+'}');
const rd=(to,data)=>rpc('eth_call',[{to,data},'latest'],RPCS,1),rdq=async(to,data)=>{try{return await rd(to,data)}catch(e){if(e.rpc)return null;throw e}};// null = revert
const wrd=(h,i)=>'0x'+h.slice(2+i*64,2+i*64+64);
async function readCircuit(cp,id){const a=CPA[cp],I=BigInt(id);
 if(!P||now()-P.at>6e5)await loadP();const lsP=apiLs().catch(()=>null);
 const[o,key,l,tu]=await Promise.all([rdq(a,'0x6352211e'+W(I)),rdq(MINING,'0x10eafa00'+W(a)+W(I)),rdq(CMKT,'0x6816b596'+W(a)+W(I)),rdq(MINING,'0x63967742')]);
 if(!o||o.length<66)return null;const own=tad(wrd(o,0)),R={cp,id,own,st:0,vw:0,uw:0,pend:0,px:null};
 if(l&&l.length>=2+192&&wd(l,1)!==0n&&tad(wrd(l,1))===own)R.px=nw(l,2,18);
 if(key&&key.length>=66){const[g,pd]=await Promise.all([rdq(MINING,'0x0527edc2'+key.slice(2)),rdq(MINING,'0x1808eeb8'+key.slice(2))]);
  if(g&&g.length>=2+64*21){R.st=nw(g,9);if(R.st===1){R.vw=nw(g,19);R.uw=nw(g,20)}}if(pd)R.pend=nw(pd,0,8)}
 const T=tu?nw(tu,0):0;R.day=(R.vw>0?.99*P.day*R.vw/P.tv:0)+(R.uw>0&&T?.01*P.day*R.uw/T:0);
 const xs=extOf(await lsP).find(x=>String(x.cp).toLowerCase()===a.toLowerCase()&&String(x.tid)===String(id)),xc=xs?Number(xs.cost):0;
 if(xc>0&&isFinite(xc)&&(R.px==null||xc<R.px))R.xpx=xc;const c=R.xpx||R.px;
 R.pb=c&&R.day?payback(c,R.day*P.bemBnb,P.g):null;return R}
// top listings for bare /check, from the OwlGate API (same model as alerts: verified pool only); cached 60 s, [] on failure
const API=(E.TSD_API||'https://api.owlgate.xyz').replace(/\/+$/,'');let TOP={at:0,v:[]},LS={at:0,j:null};
// API /listings shared by /check, the top list and other-market alerts; 10 s cache, null on failure. ext = other-market asks (D52), used only while the API says live
async function apiLs(){if(now()-LS.at<1e4)return LS.j;let j=null;try{j=await tmo(fetch(API+'/listings',{signal:AbortSignal.timeout(8000)}).then(x=>x.json()),9000)}catch(e){}
 LS={at:now(),j:j&&Array.isArray(j.items)?j:null};return LS.j}
const extOf=j=>j&&j.extState==='live'&&Array.isArray(j.ext)?j.ext:[];
async function topList(){if(now()-TOP.at<6e4)return TOP.v;
 try{if(!P||now()-P.at>6e5)await loadP();const r=await apiLs(),v=[];if(!r)throw Error('api');
  for(const x of [...r.items,...extOf(r).map(y=>({...y,x:1}))]){const cp=CPA.indexOf(String(x.cp).toLowerCase()),px=Number(x.x?x.cost:x.px),vw=Number(x.vw);
   if(cp<0||!x.ok||!x.act||!(vw>0)||!(px>0)||!/^\d{1,9}$/.test(String(x.tid)))continue;
   const pb=payback(px,dOf(vw,Number(x.uw)||0)*P.bemBnb,P.g);if(pb!=null&&pb!==Infinity)v.push({cp,id:String(x.tid),px,pb,x:!!x.x})}
  const u=new Set();TOP={at:now(),v:v.sort((a,b)=>a.pb-b.pb||a.px-b.px).filter(y=>!u.has(y.cp+':'+y.id)&&u.add(y.cp+':'+y.id)).slice(0,3)}}catch(e){TOP={at:now()-4e4,v:[]}}
 return TOP.v}
async function fmtIntro(l,slug){const L=[gt(l,'intro')],t=await topList();
 if(t.length){L.push('',gt(l,'top'));for(const x of t)L.push(gt(l,x.x?'topIx':'topI',{cmd:'/check_'+(x.cp?'bh_':'')+x.id,c:CPUS[CPA[x.cp]],px:f(x.px,4),d:x.pb}))}
 L.push('',GT[l].all.replace('{a}',`<a href="${TSD}?s=${slug}">${eh(GT[l].mk)}</a>`),gt(l,'ft'));return L.join('\n')}
const shA=a=>a.slice(0,6)+'…'+a.slice(-4);
const tsdLink=(id,cp,l,slug)=>TSD+'#k='+id+'&amp;c='+cp+'&amp;l='+l+'&amp;s='+slug;// every part is digits, en|zh or a hex slug
function fmtCheck(R,lang,slug,bare){const l=lang,nm=CPUS[CPA[R.cp]],pool=R.st===1&&R.vw>0?'v':R.st===1&&R.uw>0?'u':'n',L=[];
 L.push(`<b>${eh(nm)} #${eh(R.id)}</b> · ${eh(GT[l].st[R.st]||GT[l].st[0])}`,`${gt(l,'own')}: <code>${eh(shA(R.own))}</code>`,eh(GT[l].pool[pool]));
 if(R.px!=null)L.push(gt(l,'ls',{px:f(R.px,4),u:f(R.px*P.bnbUsd,0)}));if(R.xpx)L.push(gt(l,'lsx',{px:f(R.xpx,4),u:f(R.xpx*P.bnbUsd,0)}));if(R.px==null&&!R.xpx)L.push(gt(l,'nol'));
 L.push(R.pb==null?gt(l,'pbN'):R.pb===Infinity?gt(l,'pbL'):gt(l,'pb',{d:R.pb,b:f(R.day,2)}));
 if(R.pend>0)L.push(gt(l,'pend',{b:f(R.pend,4)}));
 L.push('',gt(l,'ft'),`<a href="${tsdLink(R.id,R.cp,l,slug)}">${eh(GT[l].lk)}</a>`);if(bare)L.push(gt(l,'hint',{id:R.id}));return L.join('\n')}
async function isAdm(m){if(m.chat.type==='private')return false;if(m.sender_chat&&String(m.sender_chat.id)===String(m.chat.id))return true;if(!m.from)return false;if(String(m.from.id)===ADMIN)return true;
 const r=await tmo(TG('getChatMember',{chat_id:m.chat.id,user_id:m.from.id}),10000).catch(()=>null);return!!(r&&r.ok&&r.result&&['creator','administrator'].includes(r.result.status))}
const greply=(m,text)=>tmo(TG('sendMessage',{chat_id:m.chat.id,text,parse_mode:'HTML',disable_web_page_preview:true,reply_parameters:{message_id:m.message_id,allow_sending_without_reply:true}}),15000).catch(e=>null);
function grec(ch,priv,uid){const g=S.g[ch]||(S.g[ch]={t:priv?'p':'g',n:0,u:{},f:now(),last:0});g.n++;g.last=now();if(Object.keys(g.u).length<5000)g.u[hh(uid)]=1;save();return g}
let ginf=0;
// returns true when the message was a OwlGate group/check command (handled or deliberately ignored)
async function gMsg(m){const q=parseCmd(m&&m.text,BOTNAME);if(!q)return false;
 {const k=q.c.match(/^\/check_(bh_)?(\d{1,9})$/);if(k){q.c='/check';q.a=[...(k[1]?['behemoth']:[]),k[2],...q.a.filter(w=>/^(en|zh)$/i.test(w))]}}if(q.c==='/listings'&&m.chat&&m.chat.type==='private'){q.c='/check';q.a=q.a.filter(w=>/^(en|zh)$/i.test(w))}const isC=Object.hasOwn(FACT_AL,q.c),isA=ADMC.includes(q.c);if(!isC&&!isA)return false;
 const ty=m.chat&&m.chat.type,priv=ty==='private';if(priv&&!isC)return false;if(!priv&&ty!=='group'&&ty!=='supergroup')return true;if(m.from&&m.from.is_bot)return true;
 if(ginf>=8)return true;ginf++;
 try{const cid=String(m.chat.id),ch=hh('c'+cid),uid=m.from?'u'+m.from.id:m.sender_chat?'s'+m.sender_chat.id:'a'+cid,g0=S.g[ch],cl=g0&&g0.lang||(priv?(S.u[cid]&&S.u[cid].lang)||(/^zh/.test(m.from&&m.from.language_code||'')?'zh':'en'):'en');
  if(isA){if(!allow('A'+ch+'|'+uid,'A'+uid))return true;if(!await isAdm(m))return true;
   const g=g0||(S.g[ch]={t:'g',n:0,u:{},f:now(),last:0});
   if(q.c==='/tsd_off'){g.off=1;save();await greply(m,gt(cl,'off'))}
   else if(q.c==='/tsd_on'){delete g.off;save();await greply(m,gt(cl,'on'))}
   else{const l=(q.a[0]||'').toLowerCase();if(l==='en'||l==='zh'){g.lang=l;save();await greply(m,gt(l,'lg'))}}
   return true}
  if(!priv&&g0&&g0.off)return true;
  const p=parseCheck(q.a,FACT_AL[q.c]),l=p.lang||cl,slug='tg_'+ch,bareI=p.err&&!q.a.some(w=>!/^(en|zh|cn|中文|简体)$/i.test(w));
  if(!(priv&&bareI)&&!allow(ch,uid,now(),priv)){if(priv)await greply(m,RL.why===2?gt(l,'hour',{m:RL.wait}):gt(l,'slow'));return true}// private intro is free
  if(bareI){await greply(m,await fmtIntro(l,slug));return true}// bare /check: explain + top picks
  if(p.err){await greply(m,gt(l,'use'));return true}
  grec(ch,priv,uid);
  if(p.addr){await greply(m,gt(l,'unoff',{a:p.addr})+'\n\n'+gt(l,'ft'));return true}
  let R;try{R=await tmo(readCircuit(p.cp,p.id),14000)}catch(e){await greply(m,gt(l,'busy'));return true}
  if(!R){await greply(m,gt(l,'none',{c:CPUS[CPA[p.cp]],id:p.id}));return true}
  await greply(m,fmtCheck(R,l,slug,p.bare));return true}
 catch(e){console.error('g',e.message);return true}finally{ginf--}}
function gStats(){const e=Object.entries(S.g);if(!e.length)return'\ngroup /check: none yet';const a=e.map(x=>x[1]),d=now()-DAY;
 return`\ngroup /check: chats ${a.length} (groups ${a.filter(x=>x.t==='g').length}) · off ${a.filter(x=>x.off).length} · checks ${a.reduce((s,x)=>s+x.n,0)} · active 24h ${a.filter(x=>x.last>d).length}\n`+
  e.sort((p,q)=>q[1].n-p[1].n).slice(0,8).map(([k,x])=>`tg_${k} ${x.t} checks ${x.n} users ${Object.keys(x.u).length} last ${x.last?dt(x.last):'-'}${x.off?' OFF':''}`).join('\n')}

// ---- D53: "My Rigs" (/watch, digest, deal alert, risk alert, /feedback). FREE (D44): no plan needed. Read-only: only a public wallet address is stored.
// Data: API /rig (owner index + Multicall3 reads: mining state, pending BEM now / 1 d / 7 d / 14 d ago) + the same payback model and listings as /check.
// Earned BEM = change of on-chain pending BEM; a circuit that was claimed inside the window gives only a lower bound ("at least"). Everything else is labelled estimate.
const WMAX=3,DEAL_HR=4,DEAL_DAY=12,RISK_DROP=.30,RISK_X=1.5,RISK_MIN=30,RISK_CD=DAY,RISK_EVERY=6*36e5,WBAND=.5,FB_DAY=5;
const isW=a=>/^0x[0-9a-fA-F]{40}$/.test(a||'');
const WT={en:{
 use:'Usage: /watch 0x… (a BSC wallet address, 42 characters). Only the public address is used. OwlGate never asks for your private key or seed phrase.',
 add:'Watching <code>{w}</code> ({n}/{m}). Digest: {dg}. Change it with /digest daily | weekly | off. Its buys, sells and listings arrive in real time (/trades off). First digest below.',dup:'You already watch this wallet.',full:'You already watch {m} wallets. /unwatch one first.',
 rm:'Stopped watching <code>{w}</code>.',nf:'That wallet is not in your list. /mywatch',none:'You watch no wallets yet. /watch 0x… to start (free).',
 list:'Watching ({n}/{m}):\n{l}\nDigest: {dg} · Deal alert: {da} · Trades: {tr}\n/unwatch 0x… removes one · /digest now · /dealalert · /feedback',
 dgd:'daily',dgw:'weekly',dgo:'off',dgSet:'Digest: {dg}.',dgUse:'Usage: /digest daily | weekly | off | now',noW:'Watch a wallet first: /watch 0x…',
 daOn:'on: {l}',daOff:'off',daSet:'Deal alert on: {c} payback ≤ <b>{pb}</b> days. Free, at most {h} per hour. /dealalert off to stop.',daOffM:'Deal alert off.',
 daUse:'Usage: /dealalert behemoth 60 · /dealalert tapeout 90 · /dealalert 60 (both) · /dealalert off\nNow: {da}',
 slow:'Too fast, please wait a few seconds.',busy:'Chain data is unavailable right now. The digest will arrive on schedule.',
 dgT:'<b>OwlGate digest</b> · <code>{w}</code>',dgNone:'No TapeOut / Behemoth circuits found for this wallet now (the owner list refreshes about every 5 min).',
 dgN:'{k} of {n} circuits mining · about <b>{d} BEM/day</b> at today\'s rate (estimate)',dgCap:'Showing the first {m} circuits only.',
 dgE:'Earned, measured on chain: last 24 h <b>{a}</b> BEM · this week <b>{b}</b> BEM vs last week <b>{c}</b> BEM{ch}',dgLb:'\n(at least: some circuits were claimed in these periods, or history was unavailable)',
 dgU:'Unclaimed now: <b>{b}</b> BEM (~{n} BNB)',
 dgP:'Remaining payback from today (estimate): about <b>{d} days</b>, using the median listed price of {n} comparable circuits ({px} BNB)',dgPL:'Remaining payback from today (estimate): over 1095 days at that price',dgPn:'Remaining payback: not enough comparable listings now.',
 hv:'<b>Hold vs offer (estimate)</b> · {c} #{id}',hv1:'Reference {px} BNB (listing, median of {n}) = about {d} days of mining at today\'s rate (with dilution).',hv1L:'Reference {px} BNB (listing, median of {n}) = over 1095 days of mining at today\'s rate (with dilution).',
 hv2:'Mining 90 days at today\'s rate is worth about {v} BNB (range {lo}-{hi}).',hv3:'Rates change daily. Estimate, not advice. OwlGate does not tell you to hold or sell.',hvN:'<b>Hold vs offer (estimate)</b>: not enough comparable listings to compare (need 2).',
 ask:'Best ask on the circuit market (comparable weight): <b>{px} BNB</b> · {c} #{id}',askN:'No comparable listing on the circuit market now.',askX:'Also listed on another market: <b>{px} BNB</b> incl. buyer fee. Not buyable in OwlGate.',
 ft:'Estimate, not advice. Independent non-custodial tool, not official TapeOut.',
 rk:'⚠ <b>Rig check</b> · <code>{w}</code>\n{l}\nEstimate from on-chain data, not advice. /mywatch',rkSt:'Stopped mining: {ids}',rkDr:'Estimated BEM/day fell {p}% (from {a} to {b}).',rkPb:'Remaining payback is now {n} (was about {o} days).',rkOver:'over 1095 days',
 fbOk:'Thank you, saved and sent to the team.\n\nThree questions, answer any with /feedback and your text:\n1. What do you use OwlGate for?\n2. What brings you back?\n3. What is missing?\n4. Would you pay a monthly fee in BEM for instant deal alerts (free alerts are a few minutes slower)? If yes, how much per month? Answer with /feedback pay yes 5 or /feedback pay no',
 fbUse:'Usage: /feedback your text. Three questions to answer:\n1. What do you use OwlGate for?\n2. What brings you back?\n3. What is missing?\n4. Would you pay a monthly fee in BEM for instant deal alerts (free alerts are a few minutes slower)? If yes, how much per month? Answer with /feedback pay yes 5 or /feedback pay no',fbPay:'Thank you, your answer is saved: {a}.',fbMax:'Feedback limit reached for today, thank you.',
 tdB:'🟦 <b>Watched wallet bought</b> · <code>{w}</code>\n{c} #{id} · <b>{px} BNB</b> (${u}) incl. fee\n<a href="https://bscscan.com/tx/{tx}">tx</a> · /trades off to stop',
 tdS:'🟥 <b>Watched wallet sold</b> · <code>{w}</code>\n{c} #{id} · <b>{px} BNB</b> (${u}) incl. fee\n<a href="https://bscscan.com/tx/{tx}">tx</a> · /trades off to stop',
 tdL:'🟨 <b>Watched wallet listed</b> · <code>{w}</code>\n{c} #{id} · <b>{px} BNB</b> (${u})\n<a href="https://bscscan.com/tx/{tx}">tx</a> · /trades off to stop',
 trOn:'on',trOff:'off',trSet:'Trade alerts for watched wallets: {s}. Buys, sells and listings on the circuit market, sent within about 15 s, at most {h} per hour.',trUse:'Usage: /trades on | off\nNow: {s}'},
zh:{
 use:'用法：/watch 0x…（BSC 钱包地址，42 位字符）。只使用公开地址。OwlGate 绝不会索要私钥或助记词。',
 add:'已关注 <code>{w}</code>（{n}/{m}）。简报：{dg}。可用 /digest daily | weekly | off 修改。它的买入、卖出和挂单会实时提醒（/trades off 关闭）。首份简报见下方。',dup:'你已经在关注这个钱包。',full:'你已关注 {m} 个钱包。请先 /unwatch 一个。',
 rm:'已取消关注 <code>{w}</code>。',nf:'列表中没有这个钱包。/mywatch',none:'你还没有关注钱包。/watch 0x… 开始（免费）。',
 list:'已关注（{n}/{m}）：\n{l}\n简报：{dg} · 捡漏提醒：{da} · 交易：{tr}\n/unwatch 0x… 取消 · /digest now · /dealalert · /feedback',
 dgd:'每日',dgw:'每周',dgo:'关闭',dgSet:'简报：{dg}。',dgUse:'用法：/digest daily | weekly | off | now',noW:'请先关注钱包：/watch 0x…',
 daOn:'开启：{l}',daOff:'关闭',daSet:'捡漏提醒已开启：{c} 回本 ≤ <b>{pb}</b> 天。免费，每小时最多 {h} 条。/dealalert off 关闭。',daOffM:'捡漏提醒已关闭。',
 daUse:'用法：/dealalert behemoth 60 · /dealalert tapeout 90 · /dealalert 60（两个处理器）· /dealalert off\n当前：{da}',
 slow:'太快了，请稍等几秒。',busy:'暂时无法读取链上数据。简报会按时送达。',
 dgT:'<b>OwlGate 简报</b> · <code>{w}</code>',dgNone:'该钱包目前没有 TapeOut / Behemoth 电路（持有人列表约每 5 分钟刷新）。',
 dgN:'{n} 个电路中 {k} 个在挖矿 · 按今日速率约 <b>{d} BEM/天</b>（估算）',dgCap:'仅显示前 {m} 个电路。',
 dgE:'链上实测收益：近 24 小时 <b>{a}</b> BEM · 本周 <b>{b}</b> BEM，上周 <b>{c}</b> BEM{ch}',dgLb:'\n（至少：这些时段内部分电路被领取过，或历史数据不可用）',
 dgU:'当前未领取：<b>{b}</b> BEM（约 {n} BNB）',
 dgP:'从今天起的剩余回本（估算）：约 <b>{d} 天</b>，按 {n} 个可比电路的挂单中位价（{px} BNB）',dgPL:'从今天起的剩余回本（估算）：按该价格超过 1095 天',dgPn:'剩余回本：目前可比挂单不足。',
 hv:'<b>持有 vs 出价（估算）</b> · {c} #{id}',hv1:'参考价 {px} BNB（挂单，{n} 个的中位数）约等于按今日速率挖 {d} 天（含稀释）。',hv1L:'参考价 {px} BNB（挂单，{n} 个的中位数）约等于按今日速率挖超过 1095 天（含稀释）。',
 hv2:'按今日速率挖 90 天约值 {v} BNB（区间 {lo}-{hi}）。',hv3:'速率每天变化。估算，不构成建议。OwlGate 不会告诉你持有还是卖出。',hvN:'<b>持有 vs 出价（估算）</b>：可比挂单不足，无法比较（至少需要 2 个）。',
 ask:'电路市场最低挂单（算力相近）：<b>{px} BNB</b> · {c} #{id}',askN:'目前电路市场没有算力相近的挂单。',askX:'另有其他市场挂单：<b>{px} BNB</b>（含买方手续费）。无法在 OwlGate 购买。',
 ft:'估算，不构成建议。独立非托管工具，非 TapeOut 官方。',
 rk:'⚠ <b>矿机检查</b> · <code>{w}</code>\n{l}\n基于链上数据的估算，不构成建议。/mywatch',rkSt:'已停止挖矿：{ids}',rkDr:'预估 BEM/天 下降 {p}%（{a} → {b}）。',rkPb:'剩余回本现为 {n}（之前约 {o} 天）。',rkOver:'超过 1095 天',
 fbOk:'谢谢，已保存并转给团队。\n\n三个问题，任选回答，用 /feedback 加你的内容：\n1. 你用 OwlGate 来做什么？\n2. 什么会让你回来？\n3. 还缺什么？\n4. 如果即时捡漏提醒（免费版会晚几分钟）按月用 BEM 付费，你愿意吗？愿意的话每月多少？请用 /feedback pay yes 5 或 /feedback pay no 回答',
 fbUse:'用法：/feedback 你的内容。三个问题：\n1. 你用 OwlGate 来做什么？\n2. 什么会让你回来？\n3. 还缺什么？\n4. 如果即时捡漏提醒（免费版会晚几分钟）按月用 BEM 付费，你愿意吗？愿意的话每月多少？请用 /feedback pay yes 5 或 /feedback pay no 回答',fbPay:'谢谢，已记录你的回答：{a}。',fbMax:'今天的反馈次数已达上限，谢谢。',
 tdB:'🟦 <b>关注的钱包买入</b> · <code>{w}</code>\n{c} #{id} · <b>{px} BNB</b>（${u}，含手续费）\n<a href="https://bscscan.com/tx/{tx}">交易</a> · /trades off 关闭',
 tdS:'🟥 <b>关注的钱包卖出</b> · <code>{w}</code>\n{c} #{id} · <b>{px} BNB</b>（${u}，含手续费）\n<a href="https://bscscan.com/tx/{tx}">交易</a> · /trades off 关闭',
 tdL:'🟨 <b>关注的钱包挂单</b> · <code>{w}</code>\n{c} #{id} · <b>{px} BNB</b>（${u}）\n<a href="https://bscscan.com/tx/{tx}">交易</a> · /trades off 关闭',
 trOn:'开启',trOff:'关闭',trSet:'关注钱包的交易提醒：{s}。电路市场的买入、卖出和挂单，约 15 秒内发送，每小时最多 {h} 条。',trUse:'用法：/trades on | off\n当前：{s}'}};
// values are escaped; {raw:'…'} is passed through (only used for text built from validated hex / our own tags)
const wt=(u,k,o={})=>String(WT[u.lang][k]).replace(/\{(\w+)\}/g,(_,x)=>x in o?(o[x]&&o[x].raw!=null?o[x].raw:eh(o[x])):'{'+x+'}');
const CPN=['TapeOut','Behemoth'],cpi=a=>CPA.indexOf(String(a).toLowerCase());
const dgName=u=>wt(u,{d:'dgd',w:'dgw'}[u.dg]||'dgo');
const daText=u=>{const e=Object.entries(u.da||{});return e.length?wt(u,'daOn',{l:e.map(([k,v])=>CPN[k]+' ≤ '+v).join(', ')}):wt(u,'daOff')};
let RC=new Map();// wallet -> {at,j} (API /rig answer), 10 min, shared by users
async function apiRig(a){const c=RC.get(a);if(c&&now()-c.at<6e5)return c.j;let j=null;
 try{j=await tmo(fetch(API+'/rig?a='+a,{signal:AbortSignal.timeout(32000)}).then(x=>x.ok?x.json():null),34000)}catch(e){}
 if(!j||!j.ok||!Array.isArray(j.items))return null;if(RC.size>100)RC.delete(RC.keys().next().value);RC.set(a,{at:now(),j});return j}
const med=a=>{const s=a.slice().sort((x,y)=>x-y);return s.length?s[s.length>>1]:null};
const hold=(inc,g,D,pm)=>{let s=0;for(let d=1;d<=D;d++)s+=inc*pm/Math.pow(1+Math.max(g,0),d/7);return s};
// everything the digest and the risk check need for one wallet; null when chain/API data is unavailable
async function rigStats(a){const j=await apiRig(a);if(!j)return null;if(!P||now()-P.at>6e5)await loadP();const ls=await apiLs(),TU=ls&&Number(ls.tu)||0;
 const its=j.items.filter(x=>cpi(x.cp)>=0).map(x=>({...x,cp:String(x.cp).toLowerCase(),day:x.st===1?(x.vw>0?.99*P.day*x.vw/P.tv:0)+(x.uw>0&&TU?.01*P.day*x.uw/TU:0):0}));
 const dl=(f0,f1)=>{let v=0,lb=0,n=0;for(const x of its){const p=f0(x),q=f1(x);if(p==null||q==null){lb=1;continue}n++;if(p>=q)v+=p-q;else{v+=p;lb=1}}return n?{v,lb}:null};
 const R={a,its,n:j.n==null?its.length:j.n,capped:!!j.capped,k:its.filter(x=>x.st===1).length,day:its.reduce((s,x)=>s+x.day,0),pend:its.reduce((s,x)=>s+(x.pend||0),0),
  e1:dl(x=>x.pend,x=>x.p1),e7:dl(x=>x.pend,x=>x.p7),ep:dl(x=>x.p7,x=>x.p14),lead:null,ref:null,pbRem:null,best:null,ext:null};
 if(j.claimed&&typeof j.claimed==='object'){// exact: change of pending + BEM claimed inside the window (Claim events of this wallet); circuits bought or sold in the window are not tracked
  const sm=k=>{let v=0;for(const x of its){if(x[k]==null)return null;v+=x[k]}return v},C=j.claimed,pn=sm('pend'),p1=sm('p1'),p7=sm('p7'),p14=sm('p14');
  R.e1=pn!=null&&p1!=null?{v:Math.max(0,pn-p1+(C.d1||0)),lb:0}:null;R.e7=pn!=null&&p7!=null?{v:Math.max(0,pn-p7+(C.d7||0)),lb:0}:null;R.ep=p7!=null&&p14!=null?{v:Math.max(0,p7-p14+(C.p7||0)),lb:0}:null}
 const lead=its.filter(x=>x.st===1&&x.vw>0).sort((x,y)=>y.vw-x.vw)[0];
 if(lead&&ls&&Array.isArray(ls.items)){R.lead=lead;const near=x=>String(x.cp).toLowerCase()===lead.cp&&x.ok&&x.act&&Number(x.vw)>=lead.vw*(1-WBAND)&&Number(x.vw)<=lead.vw*(1+WBAND)&&String(x.tid)!==String(lead.id);
  const cm=ls.items.filter(x=>near(x)&&Number(x.px)>0).map(x=>({tid:String(x.tid),px:Number(x.px)})).sort((x,y)=>x.px-y.px);
  if(cm.length)R.best=cm[0];
  if(cm.length>=2){R.ref={px:med(cm.map(x=>x.px)),n:cm.length};R.pbRem=payback(R.ref.px,lead.day*P.bemBnb,P.g)}
  const ex=extOf(ls).filter(x=>near({...x,px:x.cost})&&Number(x.cost)>0).map(x=>Number(x.cost)).sort((x,y)=>x-y);if(ex.length)R.ext=ex[0]}
 return R}
function fmtDigest(u,R){const L=[wt(u,'dgT',{w:shA(R.a)})];
 if(!R.its.length){L.push(wt(u,'dgNone'),'',wt(u,'ft'));return L.join('\n')}
 L.push(wt(u,'dgN',{k:R.k,n:R.n,d:f(R.day,2)}));if(R.capped)L.push(wt(u,'dgCap',{m:R.its.length}));
 const E3=[R.e1,R.e7,R.ep],fe=e=>e?f(e.v,2):'—',lbF=E3.some(e=>!e||e.lb),pc=R.e7&&R.ep&&R.ep.v>0?' ('+(R.e7.v>=R.ep.v?'+':'')+f((R.e7.v/R.ep.v-1)*100,0)+'%)':'';
 L.push(wt(u,'dgE',{a:fe(R.e1),b:fe(R.e7),c:fe(R.ep),ch:pc})+(lbF?wt(u,'dgLb'):''),wt(u,'dgU',{b:f(R.pend,4),n:f(R.pend*P.bemBnb,4)}),'');
 if(R.ref){const l=R.lead,inc=l.day*P.bemBnb,g=P.g,gl=Math.max(g,0)*1.5,gh=Math.max(g,0)*.5;
  L.push(R.pbRem===Infinity?wt(u,'dgPL'):wt(u,'dgP',{d:R.pbRem,n:R.ref.n,px:f(R.ref.px,4)}),'');
  L.push(wt(u,'hv',{c:CPN[cpi(l.cp)],id:l.id}),R.pbRem===Infinity?wt(u,'hv1L',{px:f(R.ref.px,4),n:R.ref.n}):wt(u,'hv1',{px:f(R.ref.px,4),n:R.ref.n,d:R.pbRem}),
   wt(u,'hv2',{v:f(hold(inc,g,90,1),3),lo:f(hold(inc,gl,90,.7),3),hi:f(hold(inc,gh,90,1.3),3)}),wt(u,'hv3'),'')}
 else L.push(wt(u,'dgPn'),wt(u,'hvN'),'');
 if(R.best)L.push(wt(u,'ask',{px:f(R.best.px,4),c:CPN[cpi(R.lead.cp)],id:R.best.tid}));else if(R.lead)L.push(wt(u,'askN'));
 if(R.ext)L.push(wt(u,'askX',{px:f(R.ext,4)}));
 L.push('',wt(u,'ft'));return L.join('\n')}
// risk rules (documented in ops/inbox/eng-2026-10-20-watch-digest.md): compared with the wallet's snapshot (6 h to 48 h old), at most 1 alert per wallet per 24 h
const rk=x=>x.cp.slice(2,8)+':'+x.id,snap=R=>({t:now(),day:R.day,pb:R.pbRem,m:R.its.filter(x=>x.st===1).map(rk).slice(0,100)});
function riskOf(s,R){const L=[];if(!s)return L;const cur=new Set(R.its.filter(x=>x.st===1).map(rk)),own=new Set(R.its.map(rk)),stop=s.m.filter(x=>own.has(x)&&!cur.has(x));
 if(stop.length)L.push({k:'St',ids:R.its.filter(x=>stop.includes(rk(x))).map(x=>CPN[cpi(x.cp)]+' #'+x.id).slice(0,8).join(', ')});
 if(s.day>0&&R.day<=s.day*(1-RISK_DROP))L.push({k:'Dr',p:Math.round((1-R.day/s.day)*100),a:f(s.day,2),b:f(R.day,2)});
 if(s.pb!=null&&isFinite(s.pb)&&R.pbRem!=null&&(R.pbRem===Infinity||(R.pbRem>=s.pb*RISK_X&&R.pbRem-s.pb>=RISK_MIN)))L.push({k:'Pb',o:s.pb,n:R.pbRem});return L}
const rkMsg=(u,a,L)=>wt(u,'rk',{w:shA(a),l:{raw:L.map(x=>x.k==='St'?wt(u,'rkSt',{ids:x.ids}):x.k==='Dr'?wt(u,'rkDr',x):wt(u,'rkPb',{n:x.n===Infinity?WT[u.lang].rkOver:'~'+x.n+(u.lang==='zh'?' 天':' days'),o:x.o})).join('\n')}});
const wOn=u=>u.w&&u.w.length&&u.dg!=='off'&&!u.blocked;
async function sendDigest(id,u,a,sched){const R=await rigStats(a);if(!R)return false;const ok=await send(id,fmtDigest(u,R));
 if(sched){if(ok){(u.dl=u.dl||[]).push(now());if(u.dl.length>60)u.dl.shift();u.dfail=0}else u.dfail=(u.dfail||0)+1}return ok}
async function watchTick(){for(const[id,u]of Object.entries(S.u)){try{if(!u.w||!u.w.length||u.blocked||u.on===0)continue;
  if(u.dg!=='off'&&now()>=(u.dn||0)+(u.dg==='d'?DAY:7*DAY)){let any=false;for(const w of u.w)if(await sendDigest(id,u,w.a,true))any=true;if(any){u.dn=now();save()}}
  for(const w of u.w){if(w.s&&now()-w.s.t<RISK_EVERY)continue;const R=await rigStats(w.a);if(!R)continue;
   const L=riskOf(w.s,R);if(L.length&&now()-(w.ra||0)>=RISK_CD){if(await send(id,rkMsg(u,w.a,L))){w.ra=now();w.s=snap(R);(S.wr=S.wr||{n:0}).n++}save();continue}
   if(!w.s||now()-w.s.t>=2*DAY){w.s=snap(R);save()}}
  if(u.wf){const age=now()-u.wf;if(!('r1' in u)&&age>=DAY){u.r1=wOn(u)&&!u.dfail?1:0;save()}if(!('r7' in u)&&age>=7*DAY+2*36e5){u.r7=wOn(u)&&!u.dfail&&u.dl&&u.dl.length?1:0;save()}}
 }catch(e){console.error('watch',e.message)}await sleep(200)}}
// deal alert (free, own payback limit per processor): same listing events as the normal alert; skips users who already got the normal one; 4 / hour, 12 / day
async function dealFan(ci,pb,key,mk){if(DRY)return;for(const[id,u]of Object.entries(S.u)){const lim=u.da&&u.da[ci];if(!lim||pb>lim||u.blocked||u.on===0)continue;
 if(live(u)&&pb<=u.pb)continue;
 u.dk=u.dk||[];if(u.dk.includes(key))continue;const h=u.dh=(u.dh||[]).filter(x=>now()-x<DAY);if(h.filter(x=>now()-x<36e5).length>=DEAL_HR||h.length>=DEAL_DAY)continue;
 if(await send(id,mk(u))){h.push(now());u.dk.push(key);if(u.dk.length>30)u.dk.shift();(S.wd=S.wd||{n:0}).n++;save()}await sleep(60)}}
// real-time trades of watched wallets (free, default on, /trades off): circuit market Listed / Sold where a watched wallet is seller or buyer.
// Sold: topics[2] buyer, data price + fee; seller = `from` of the NFT Transfer in the receipt (same as tsd-agg). 10 / hour per user.
const TRADE_HR=10;
const trText=u=>wt(u,u.ta===0?'trOff':'trOn');
async function tradeFan(l){if(DRY||!l.topics[3])return;const so=l.topics[0]===T_SO,cp=tad(l.topics[3]),tid=wd(l.data,0).toString(),key=l.transactionHash+':'+l.logIndex;
 const WM=new Map();for(const[id,u]of Object.entries(S.u))if(!u.blocked&&u.on!==0&&u.ta!==0)for(const w of u.w||[]){if(!WM.has(w.a))WM.set(w.a,[]);WM.get(w.a).push(id)}
 if(!WM.size)return;let by=null,se=null,px;
 if(so){by=tad(l.topics[2]);px=Number(wd(l.data,1)+wd(l.data,2))/1e18;
  try{const r=await rpc('eth_getTransactionReceipt',[l.transactionHash]),x=(r&&r.logs||[]).filter(y=>y.topics[0]===T_TR&&y.topics.length>=4&&y.address.toLowerCase()===cp&&BigInt(y.topics[3]).toString()===tid);
   if(x.length){se=tad(x[0].topics[1]);by=tad(x[x.length-1].topics[2])}}catch(e){console.error('trade rcpt',e.message)}}// sweep contracts: final receiver, not the router
 else{se=tad(l.topics[2]);px=nw(l.data,1,18)}
 const hit=[[by,'tdB'],[se,so?'tdS':'tdL']].filter(([a])=>a&&WM.has(a));if(!hit.length)return;
 if(!P)await loadP();const c=CPUS[cp]||shA(cp);
 for(const[a,k]of hit)for(const id of WM.get(a)){const u=S.u[id];u.tk=u.tk||[];if(u.tk.includes(key+a))continue;
  const h=u.th=(u.th||[]).filter(x=>now()-x<36e5);if(h.length>=TRADE_HR)continue;
  if(await send(id,wt(u,k,{w:{raw:shA(a)},c,id:tid,px:f(px,4),u:f(px*P.bnbUsd,0),tx:{raw:l.transactionHash}}))){h.push(now());u.tk.push(key+a);if(u.tk.length>30)u.tk.shift();(S.wtd=S.wtd||{n:0}).n++;save()}await sleep(60)}}
const WCMD=new Set(['/watch','/unwatch','/mywatch','/digest','/dealalert','/feedback','/trades']);
async function watchCmd(c,arg,arg2,u,id,m){const A=(arg||'').toLowerCase();
 if(c==='/mywatch'){if(!(u.w||[]).length)return wt(u,'none');return wt(u,'list',{n:u.w.length,m:WMAX,l:{raw:u.w.map((w,i)=>(i+1)+'. <code>'+w.a+'</code>').join('\n')},dg:dgName(u),da:daText(u),tr:trText(u)})}
 if(c==='/trades'){if(A==='on'||A==='off'){u.ta=A==='on'?1:0;return wt(u,'trSet',{s:trText(u),h:TRADE_HR})}return wt(u,'trUse',{s:trText(u)})}
 if(c==='/watch'){if(!isW(arg))return wt(u,'use');if(!allow('w'+id,'w'+id,now(),true))return wt(u,'slow');u.w=u.w||[];
  if(u.w.some(w=>w.a===A))return wt(u,'dup');if(u.w.length>=WMAX)return wt(u,'full',{m:WMAX});
  u.w.push({a:A,c:now()});u.wf=u.wf||now();u.dg=!u.dg||u.dg==='off'?'w':u.dg;u.dn=u.w.length>1&&u.dn?u.dn:now();save();
  await send(id,wt(u,'add',{w:{raw:A},n:u.w.length,m:WMAX,dg:dgName(u)}));
  if(!await sendDigest(id,u,A,false))return wt(u,'busy');return null}
 if(c==='/unwatch'){const k=/^[1-3]$/.test(A)?(u.w||[])[Number(A)-1]&&u.w[Number(A)-1].a:A;const i=(u.w||[]).findIndex(w=>w.a===k);if(!isW(k)||i<0)return wt(u,'nf');u.w.splice(i,1);return wt(u,'rm',{w:{raw:k}})}
 if(c==='/digest'){if(A==='now'){if(!(u.w||[]).length)return wt(u,'noW');if(!allow('w'+id,'w'+id,now(),true))return wt(u,'slow');let ok=true;for(const w of u.w)ok=await sendDigest(id,u,w.a,false)&&ok;return ok?null:wt(u,'busy')}
  const v={daily:'d',weekly:'w',off:'off'}[A];if(!v)return wt(u,'dgUse');u.dg=v;if(v!=='off')u.dn=now();return wt(u,'dgSet',{dg:dgName(u)})+((u.w||[]).length||v==='off'?'':'\n'+wt(u,'noW'))}
 if(c==='/dealalert'){if(A==='off'){u.da={};return wt(u,'daOffM')}const num=x=>{const v=parseInt(x);return /^\d+$/.test(x||'')&&v>0&&v<=1095?v:0};
  if(!A)return wt(u,'daUse',{da:daText(u)});let cps,v;
  if(Object.hasOwn(PROC,A)){cps=[PROC[A]];v=num(arg2)}else{cps=[0,1];v=num(A)}
  if(!v)return wt(u,'daUse',{da:daText(u)});u.da=u.da||{};for(const k of cps)u.da[k]=v;return wt(u,'daSet',{c:cps.map(k=>CPN[k]).join(' + '),pb:v,h:DEAL_HR})}
 if(c==='/feedback'){const tx=(m.text||'').replace(/^\S+\s*/,'').trim().slice(0,1000);if(tx.length<3)return wt(u,'fbUse');
  const d=u.fb=(u.fb||[]).filter(x=>now()-x<DAY);if(d.length>=FB_DAY)return wt(u,'fbMax');d.push(now());
  const pm=tx.match(/^(?:pay|4)\s*[:：]?\s*(yes|y|no|n|是|愿意|否|不愿意|不)\s*(.*)$/i);
  if(pm){const yes=/^(yes|y|是|愿意)$/i.test(pm[1]),am=(pm[2].match(/\d+(?:\.\d+)?/)||[])[0];u.pay={a:yes?'yes':'no',amt:yes&&am?Number(am):null,at:now()};
   (S.fbk=S.fbk||[]).push({id,un:u.un||null,lang:u.lang,at:now(),q:'pay',pay:u.pay.a,amt:u.pay.amt,t:tx});if(S.fbk.length>500)S.fbk.shift();save();
   if(ADMIN&&id!==ADMIN)send(ADMIN,`feedback PAY from ${id}${u.un?' @'+eh(u.un):''}: ${u.pay.a}${u.pay.amt!=null?' '+u.pay.amt+' BEM/month':''}`);
   return wt(u,'fbPay',{a:u.pay.a+(u.pay.amt!=null?' ('+u.pay.amt+' BEM)':'')})}
  (S.fbk=S.fbk||[]).push({id,un:u.un||null,lang:u.lang,at:now(),t:tx});if(S.fbk.length>500)S.fbk.shift();save();
  if(ADMIN&&id!==ADMIN)send(ADMIN,`feedback #${S.fbk.length} from ${id}${u.un?' @'+eh(u.un):''} · ${eh(u.lang)}\n${eh(tx)}`);return wt(u,'fbOk')}}
function wStats(){const a=Object.values(S.u),wl=a.filter(x=>x.w&&x.w.length),act=a.filter(wOn),r=k=>{const d=a.filter(x=>k in x),y=d.filter(x=>x[k]).length;return d.length?`${y}/${d.length} (${Math.round(y/d.length*100)}%)`:'n/a'};
 return`\nmy rigs: watched wallets ${a.reduce((s,x)=>s+((x.w&&x.w.length)||0),0)} · users watching ${wl.length} · active digest ${act.length} (daily ${act.filter(x=>x.dg==='d').length}, weekly ${act.filter(x=>x.dg!=='d').length}) · digests delivered ${a.reduce((s,x)=>s+((x.dl&&x.dl.length)||0),0)} · risk alerts ${(S.wr&&S.wr.n)||0} · deal alerts ${(S.wd&&S.wd.n)||0} · trade alerts ${(S.wtd&&S.wtd.n)||0}\n`+
  `deal alert users ${a.filter(x=>x.da&&Object.keys(x.da).length).length} · retention D1 ${r('r1')} · D7 ${r('r7')} (still subscribed + digest delivered) · feedback ${(S.fbk||[]).length} · pay-for-instant-alerts: yes ${a.filter(x=>x.pay&&x.pay.a==='yes').length} / no ${a.filter(x=>x.pay&&x.pay.a==='no').length}`}

// ---- D54-A: /rule — buy rules the USER writes. The bot only sends an alert with a prefilled link; the user signs in their own wallet (TsdRouter). No keys, no funds, no advice. ----
// Only circuit-market (CMKT) listings can match (other-market asks are not buyable in OwlGate). Max 5 rules per user; same rate limit as deal alerts (4 / hour, 12 / day) and per-listing dedupe.
const RMAX=5,FEE_TXT=E.FEE_TXT||'1.00%';
Object.assign(WT.en,{
 rUse:'Snipe alerts: the bot alerts you within seconds when a new listing matches; you decide and sign in your own wallet.\n/snipe add behemoth 60 0.5 p50 — payback ≤ 60 days, price ≤ 0.5 BNB, power ≥ 50\nAny mix works: /snipe add any p100 · /snipe add tapeout 0.05\n/snipe list · /snipe del 1 · /snipe del all  (/rule works too)\nMax {m}. Free.',
 rAdd:'Rule #{n} saved: {c}{f}. I only alert you; I never buy for you and never hold keys or funds.',rPx:', price ≤ <b>{px}</b> BNB',rPb:', payback ≤ <b>{pb}</b> days',rPw:', power ≥ <b>{pw}</b>',
 rFull:'You already have {m} rules. /snipe del 1 first.',rBad:'Usage: /snipe add tapeout|behemoth|any [payback days 1-1095] [max price e.g. 0.5] [min power e.g. p50] (at least one)',
 rList:'Your rules ({n}/{m}):\n{l}',rNone:'No rules yet. /snipe add behemoth 60 0.5 p50',rDel:'Rule removed.',rDelA:'All rules removed.',rNf:'No such rule. /snipe list',
 rl:'🔔 <b>Your snipe #{n} matched</b>\n{c} #{id} · <b>{px} BNB</b> (${u}) · power {w}\nEst. payback ≈ <b>{pb} days</b> (with dilution) · {d} BEM/day\nYour rule: {rc}{rf}\nOwlGate fee {fee} is added on top; the exact total shows in your wallet. You sign in your own wallet; OwlGate never holds your keys or funds. Test with small amounts only. Model estimate, not advice.\n<a href="{tsd}">Buy it on OwlGate</a>'});
Object.assign(WT.zh,{
 rUse:'狙击提醒：新挂单符合你的条件时，机器人几秒内提醒你；由你决定，并在自己的钱包签名。\n/snipe add behemoth 60 0.5 p50 — 回本 ≤ 60 天、价格 ≤ 0.5 BNB、算力 ≥ 50\n可任意组合：/snipe add any p100 · /snipe add tapeout 0.05\n/snipe list · /snipe del 1 · /snipe del all（/rule 也可用）\n最多 {m} 条。免费。',
 rAdd:'规则 #{n} 已保存：{c}{f}。我只提醒你，不会替你购买，也不持有私钥或资金。',rPx:'，价格 ≤ <b>{px}</b> BNB',rPb:'，回本 ≤ <b>{pb}</b> 天',rPw:'，算力 ≥ <b>{pw}</b>',
 rFull:'你已有 {m} 条规则。请先 /snipe del 1。',rBad:'用法：/snipe add tapeout|behemoth|any [回本天数 1-1095] [最高价格，如 0.5] [最低算力，如 p50]（至少一项）',
 rList:'你的规则（{n}/{m}）：\n{l}',rNone:'还没有规则。/snipe add behemoth 60 0.5 p50',rDel:'规则已删除。',rDelA:'已删除全部规则。',rNf:'没有这条规则。/snipe list',
 rl:'🔔 <b>你的狙击规则 #{n} 已匹配</b>\n{c} #{id} · <b>{px} BNB</b>（${u}）· 算力 {w}\n预计回本约 <b>{pb} 天</b>（含稀释）· {d} BEM/天\n你的规则：{rc}{rf}\n另加 OwlGate 手续费 {fee}，确切总额以钱包显示为准。由你在自己的钱包签名；OwlGate 不持有你的私钥或资金。请只用小额测试。模型估算，不构成建议。\n<a href="{tsd}">在 OwlGate 购买</a>'});
// E2: /snipe xl — X Layer voucher listings (OwlGate Seaport market, read from API /xl/market). Price in OKB; buyer pays the listed price, the seller pays the fee.
Object.assign(WT.en,{rxD:'{d} days',rxUse:'\nX Layer vouchers: /snipe xl 60 2 p50 — payback ≤ 60 days, price ≤ 2 OKB, power ≥ 50',rPxO:', price ≤ <b>{px}</b> OKB',
 rxBad:'Usage: /snipe xl [payback days 1-1095] [max price in OKB e.g. 2] [min power e.g. p50] (at least one)',
 rlx:'🔔 <b>Your snipe #{n} matched</b> (X Layer)\nVoucher #{v} · {c} rig #{id} · <b>{px} OKB</b>{u} · power {w}\nEst. payback ≈ <b>{pb}</b> · {d} BEM/day (today\'s BEM price and total power)\nYour rule: X Layer{rf}\nYou pay the listed price; the seller pays the OwlGate fee. You sign in your own wallet; OwlGate never holds your keys or funds. Test with small amounts only. Model estimate, not advice.\n<a href="{tsd}">Open the X Layer market on OwlGate</a>'});
Object.assign(WT.zh,{rxD:'{d} 天',rxUse:'\nX Layer 凭证：/snipe xl 60 2 p50 — 回本 ≤ 60 天、价格 ≤ 2 OKB、算力 ≥ 50',rPxO:'，价格 ≤ <b>{px}</b> OKB',
 rxBad:'用法：/snipe xl [回本天数 1-1095] [最高价格（OKB），如 2] [最低算力，如 p50]（至少一项）',
 rlx:'🔔 <b>你的狙击规则 #{n} 已匹配</b>（X Layer）\n凭证 #{v} · {c} 矿机 #{id} · <b>{px} OKB</b>{u} · 算力 {w}\n预计回本约 <b>{pb}</b> · {d} BEM/天（按今日 BEM 价格与总算力）\n你的规则：X Layer{rf}\n你支付挂单价格；手续费由卖家支付。由你在自己的钱包签名；OwlGate 不持有你的私钥或资金。请只用小额测试。模型估算，不构成建议。\n<a href="{tsd}">在 OwlGate 打开 X Layer 市场</a>'});
const rcName=r=>r.xl?'X Layer':r.cp<0?'any':CPN[r.cp],OG='https://owlgate.xyz/';
// filters of a rule as text: pb / px / pw are each optional (0 = no limit); html=false for the plain list
const rDesc=(u,r,html=true)=>{const s=(r.pb?wt(u,'rPb',{pb:r.pb}):'')+(r.px?wt(u,r.xl?'rPxO':'rPx',{px:r.px}):'')+(r.pw?wt(u,'rPw',{pw:r.pw}):'');return html?s:s.replace(/<\/?b>/g,'')};
function ruleCmd(u,m){const p=(m.text||'').trim().split(/\s+/).slice(1),sub=(p[0]||'').toLowerCase(),rs=u.rl=u.rl||[];
 if(!sub)return wt(u,'rUse',{m:RMAX})+wt(u,'rxUse');
 if(sub==='list')return rs.length?wt(u,'rList',{n:rs.length,m:RMAX,l:{raw:rs.map((r,i)=>(i+1)+'. '+rcName(r)+rDesc(u,r,false).replace(/^[,，]\s*/,' · ').replace(/[,，]\s*/g,' · ')).join('\n')}}):wt(u,'rNone');
 if(sub==='del'){const a=(p[1]||'').toLowerCase();if(a==='all'){u.rl=[];return wt(u,'rDelA')}const i=/^[1-9]$/.test(a)?Number(a)-1:-1;if(i<0||i>=rs.length)return wt(u,'rNf');rs.splice(i,1);return wt(u,'rDel')}
 if(sub==='add'||sub==='xl'){const xl=sub==='xl',cpn=(p[1]||'').toLowerCase(),cp=xl?-1:cpn==='any'?-1:Object.hasOwn(PROC,cpn)?PROC[cpn]:null,fs=p.slice(xl?1:2),un=xl?'okb':'bnb';
  // filters in any order: integer = payback days (60 or 60d), decimal or "bnb"/"okb" suffix = max price, p50 / power50 / >=50 = min power; each at most once
  let pb=0,px=0,pw=0,bad=fs.length<1||fs.length>3;
  for(const s of fs){const v=s.toLowerCase();let x;
   if((x=v.match(/^(?:p|power|>=|≥)(\d{1,6})$/))){if(pw)bad=true;pw=Number(x[1]);if(!(pw>=1))bad=true}
   else if(xl&&pb&&!px&&/^\d{1,3}$/.test(v)){px=Number(v);if(!(px>0))bad=true} // xl: OKB prices are often whole numbers, so the 2nd bare integer = max price (/snipe xl 60 2 p50)
   else if(/^\d{1,4}d?$/.test(v)){if(pb)bad=true;pb=parseInt(v);if(!(pb>=1&&pb<=1095))bad=true}
   else if((x=v.match(new RegExp('^(\\d{0,3}\\.\\d{1,8}|\\d{1,4})'+un+'$|^(\\d{0,3}\\.\\d{1,8})$')))){if(px)bad=true;px=Number(x[1]||x[2]);if(!(px>0&&px<=1000))bad=true}
   else bad=true}
  if(cp==null||bad||!(pb||px||pw))return wt(u,xl?'rxBad':'rBad');if(rs.length>=RMAX)return wt(u,'rFull',{m:RMAX});
  u.rn=(u.rn||0)+1;const r={id:u.rn,cp,pb,px,pw,at:now()};if(xl)r.xl=1;rs.push(r);(S.rs=S.rs||{made:0,sent:0}).made++;
  return wt(u,'rAdd',{n:rs.length,c:rcName(r),f:{raw:rDesc(u,r)}})}
 return wt(u,'rUse',{m:RMAX})}
// listing event -> users whose rule matches. info = {ci, id, px, pb, d}. Returns number sent.
async function ruleFan(info){if(DRY)return 0;let n=0;for(const[uid,u]of Object.entries(S.u)){if(!u.rl||!u.rl.length||u.blocked||u.on===0)continue;
  const i=u.rl.findIndex(r=>!r.xl&&!(r.mu>now())&&(r.cp<0||r.cp===info.ci)&&(!r.pb||info.pb<=r.pb)&&(!r.px||info.px<=r.px)&&(!r.pw||(info.w||0)>=r.pw));if(i<0)continue;const r=u.rl[i],key='r:'+info.ci+':'+info.id+':'+info.px;
  u.dk=u.dk||[];if(u.dk.includes(key))continue;const h=u.dh=(u.dh||[]).filter(x=>now()-x<DAY);if(h.filter(x=>now()-x<36e5).length>=DEAL_HR||h.length>=DEAL_DAY)continue;
  const link=OG+'#buy='+info.id+'&amp;c='+info.ci+'&amp;s=tg_rule'; // OwlGate shows a Buy card for this listing (dlBuy in app/owlgate/index.html)
  const msg=wt(u,'rl',{n:i+1,c:CPN[info.ci],id:info.id,px:f(info.px,4),u:f(info.px*P.bnbUsd,0),w:info.w==null?'—':f(info.w,0),pb:info.pb,d:f(info.d,2),rc:rcName(r),rf:{raw:rDesc(u,r,false)},fee:FEE_TXT,tsd:{raw:link}});
  if(await send(uid,msg,alKb(u,link.replace(/&amp;/g,'&'),info.ci,info.id,r.id))){h.push(now());u.dk.push(key);if(info.dkey)u.dk.push(info.dkey);while(u.dk.length>30)u.dk.shift();(S.rs=S.rs||{made:0,sent:0}).sent++;n++;save()}await sleep(60)}return n}
// X Layer: v = one voucher of /xl/market with a live ask. Same dedupe (per ask hash) and rate limit as BNB rules. paybackDays null -> a payback filter cannot match.
async function xlFan(v,okbUsd){if(DRY)return 0;let n=0;const a=v.ask,px=Number(a.priceOkb),pb=v.paybackDays,w=v.rig.power,key='x:'+a.hash;
 for(const[uid,u]of Object.entries(S.u)){if(!u.rl||!u.rl.length||u.blocked||u.on===0)continue;
  const i=u.rl.findIndex(r=>r.xl&&!(r.mu>now())&&(!r.pb||(pb!=null&&pb<=r.pb))&&(!r.px||px<=r.px)&&(!r.pw||(w||0)>=r.pw));if(i<0)continue;
  u.dk=u.dk||[];if(u.dk.includes(key))continue;const h=u.dh=(u.dh||[]).filter(x=>now()-x<DAY);if(h.filter(x=>now()-x<36e5).length>=DEAL_HR||h.length>=DEAL_DAY)continue;
  const msg=wt(u,'rlx',{n:i+1,v:v.voucher,c:CPUS[String(v.rig.cpu).toLowerCase()]||'?',id:v.rig.id,px:f(px,4),u:{raw:okbUsd?' ($'+f(px*okbUsd,0)+')':''},w:f(w,0),
   pb:{raw:pb==null?'—':wt(u,'rxD',{d:pb})},d:v.bemPerDay==null?'—':f(v.bemPerDay,2),rf:{raw:rDesc(u,u.rl[i],false)},tsd:{raw:OG+'xl#buy='+v.voucher}});
  if(await send(uid,msg,alKb(u,OG+'xl#buy='+v.voucher,CPA.indexOf(String(v.rig.cpu).toLowerCase()),v.rig.id,u.rl[i].id))){h.push(now());u.dk.push(key);while(u.dk.length>30)u.dk.shift();(S.rs=S.rs||{made:0,sent:0}).sent++;n++;save()}await sleep(60)}return n}
// "New on OwlGate" public channel (step 2.1, list once -> shown everywhere): every new listing of a mining rig is posted to OG_CHANNEL (@name or -100id; the bot must be
// an admin there). EN only, Buy button with slug tg_ch, at most OG_CHANNEL_HR posts per hour (default 12, S.ch). OG_CHANNEL unset = off.
const CHT=x=>`🆕 <b>New on OwlGate</b> · ${x.net}\n${x.it} · <b>${x.px}</b>${x.u} · power ${x.w}\nEst. payback ≈ <b>${x.pb}</b> · ${x.d} BEM/day\nEstimate, not advice.`;
async function chPost(x,url,txt,btn){const ch=E.OG_CHANNEL;if(!ch||DRY)return false;const h=S.ch=(S.ch||[]).filter(t=>now()-t<36e5);if(h.length>=Number(E.OG_CHANNEL_HR||12))return false;
 const ok=await send(ch,txt||CHT(x),[[{text:btn||'Buy on OwlGate',url}]]);if(ok){h.push(now());save()}return ok}
// alert buttons: Buy (opens the OwlGate Buy card; sold or repriced listings show "no longer listed" there), Check (= /check of the rig), Mute 24 h (this rule only)
const KB={en:{b:'Buy on OwlGate',k:'Check rig',m:'Mute 24 h',mu:'Snipe #{n} muted for 24 h. /snipe list',gone:'This snipe no longer exists. /snipe list'},
 zh:{b:'在 OwlGate 购买',k:'检查矿机',m:'静音 24 小时',mu:'狙击规则 #{n} 已静音 24 小时。/snipe list',gone:'该狙击规则已不存在。/snipe list'}};
const kbT=(u,k)=>(KB[u.lang]||KB.en)[k];
const alKb=(u,url,ci,id,rid)=>[[{text:kbT(u,'b'),url}],[...(ci>=0&&id!=null?[{text:kbT(u,'k'),callback_data:'ck:'+ci+':'+id}]:[]),{text:kbT(u,'m'),callback_data:'mu:'+rid}]];
async function onCb(q){const d=String(q.data||''),m=q.message,id=m&&String(m.chat.id),u=id&&S.u[id];let tx='';
 try{let k;if(u&&(k=d.match(/^mu:(\d{1,6})$/))){const i=(u.rl||[]).findIndex(r=>r.id===Number(k[1]));if(i<0)tx=kbT(u,'gone');else{u.rl[i].mu=now()+DAY;save();tx=kbT(u,'mu').replace('{n}',i+1)}}
  else if(u&&d==='om'){u.om=now()+DAY;save();tx=oT(u,'mu')}
  else if(u&&d==='sm'){u.sm=now()+7*DAY;save();tx=sT(u,'mm')}
  else if(m&&(k=d.match(/^ck:([01]):(\d{1,9})$/))){await TG('answerCallbackQuery',{callback_query_id:q.id}).catch(()=>{});
   await gMsg({chat:m.chat,from:q.from,message_id:m.message_id,text:'/check '+(k[1]==='1'?'behemoth ':'')+k[2]});return}}catch(e){console.error('cb',e.message)}
 await TG('answerCallbackQuery',{callback_query_id:q.id,text:tx,show_alert:!!tx}).catch(()=>{})}
// ---- offer above floor (free, for /watch holders): a new OwlGate offer on a rig or voucher a watched wallet holds, whose net price (after the 0.75% fee
// the seller pays) is above the floor = cheapest listing of a MINING rig (non-mining listings are never a floor). X Layer collection offers count for every voucher held.
// New offers only: open bids seen on the first read (S.ob persists) are not alerted. Buttons: Sell to offer (OwlGate page with the Sell button, you sign), Check, Mute 24 h (all offer alerts).
const OT={en:{t:'💰 <b>Offer above floor on your {k}</b>\n{c} #{id}{v} · wallet {w}\nOffer <b>{px} {u}</b> · you receive ≈ <b>{net} {u}</b> after the 0.75% OwlGate fee\nFloor (cheapest mining listing): {fl}\nOffer ends in {e}. You sign in your own wallet. Estimate, not advice.',
  rig:'rig',vo:'voucher',any:'any voucher',nofl:'no mining listing now',s:'Sell to offer',mu:'Offer alerts muted for 24 h.'},
 zh:{t:'💰 <b>你的{k}收到高于地板价的出价</b>\n{c} #{id}{v} · 钱包 {w}\n出价 <b>{px} {u}</b> · 扣除 0.75% OwlGate 手续费后你约收到 <b>{net} {u}</b>\n地板价（在挖矿挂单最低价）：{fl}\n出价剩余 {e}。由你在自己的钱包签名。估算，不构成建议。',
  rig:'矿机',vo:'凭证',any:'任意凭证',nofl:'当前无在挖矿挂单',s:'接受出价出售',mu:'出价提醒已静音 24 小时。'}};
const oT=(u,k)=>(OT[u.lang]||OT.en)[k],lc=x=>String(x||'').toLowerCase(),oLeft=s=>s>=86400?Math.floor(s/86400)+'d':s>=3600?Math.floor(s/3600)+'h':Math.max(1,Math.floor(s/60))+'m',wei18=x=>{try{return Number(BigInt(String(x)))/1e18}catch(e){return NaN}};
async function offTick(){let b56=null,b196=null,xm=null;const g=p=>tmo(fetch(API+p,{signal:AbortSignal.timeout(15000)}).then(x=>x.ok?x.json():null),16000).catch(()=>null);
 [b56,b196]=await Promise.all([g('/bids?chain=56'),g('/bids?chain=196')]);if(!b56||!b196||!Array.isArray(b56.items)||!Array.isArray(b196.items))return 0;
 const bids=[...b56.items,...b196.items].filter(x=>x&&x.status==='open'&&(x.kind==='offer'||x.kind==='coll')&&(x.chain!==196||lc(x.cp)==='0x9cfc959cd42b2e1d39a0d850c528210e818ae520')&&/^0x[0-9a-f]{64}$/i.test(x.hash)),seed=!S.ob,seen=new Set(S.ob||[]),nw=bids.filter(x=>!seen.has(x.hash));
 for(const x of bids)seen.add(x.hash);S.ob=[...seen].slice(-500);save();if(seed||!nw.length||DRY)return 0;
 const ls=await apiLs(),fl56=ci=>{const a=((ls&&ls.items)||[]).filter(x=>x.ok!==false&&x.act&&lc(x.cp)===CPA[ci]).map(x=>Number(x.px)).filter(x=>x>0);return a.length?Math.min(...a):null};
 if(nw.some(x=>x.chain===196))xm=await g('/xl/market');const vs=(xm&&xm.vouchers)||[],fl196=(()=>{const a=vs.filter(v=>v.ask&&v.rig&&v.rig.mining).map(v=>Number(v.ask.priceOkb)).filter(x=>x>0);return a.length?Math.min(...a):null})();
 let n=0;for(const[uid,u]of Object.entries(S.u)){if(!u.w||!u.w.length||u.blocked||u.on===0||u.om>now())continue;
  for(const w of u.w){const A=lc(w.a);let rigs=null;
   for(const x of nw){const net=wei18(x.price)-wei18(x.fee||0),key='o:'+x.hash+':'+A;if(!(net>0)||(u.dk||[]).includes(key))continue;let it=null,fl,unit;
    if(x.chain===196){unit='OKB';fl=fl196;const mine=vs.filter(v=>lc(v.holder)===A&&(x.kind==='coll'||String(v.voucher)===String(x.tid)));if(!mine.length)continue;
     const v=mine.sort((a,b)=>(b.bemPerDay||0)-(a.bemPerDay||0))[0];it={k:'vo',ci:CPA.indexOf(lc(v.rig.cpu)),id:v.rig.id,v:' · '+(x.kind==='coll'?oT(u,'any')+' (#'+v.voucher+')':oT(u,'vo')+' #'+v.voucher),url:OG+'xl'}}
    else{unit='BNB';const ci=CPA.indexOf(lc(x.cp));if(ci<0)continue;if(!rigs){const j=await apiRig(A);rigs=(j&&j.items)||[]}if(!rigs.some(r=>lc(r.cp)===lc(x.cp)&&String(r.id)===String(x.tid)))continue;
     fl=fl56(ci);it={k:'rig',ci,id:x.tid,v:'',url:OG+'portfolio'}}
    if(fl!=null&&!(net>fl))continue; // at or below the mining floor: listing would earn more, no alert
    const msg=(OT[u.lang]||OT.en).t.replace(/\{(\w+)\}/g,(m,k)=>({k:oT(u,it.k),c:CPN[it.ci]||'?',id:it.id,v:it.v,w:A.slice(0,6)+'…'+A.slice(-4),px:f(wei18(x.price),4),net:f(net,4),u:unit,
     fl:fl==null?oT(u,'nofl'):f(fl,4)+' '+unit,e:oLeft(Math.max(0,Number(x.end)*1000-now())/1000)})[k]??m);
    const kb=[[{text:oT(u,'s'),url:it.url}],[...(it.ci>=0?[{text:kbT(u,'k'),callback_data:'ck:'+it.ci+':'+it.id}]:[]),{text:kbT(u,'m'),callback_data:'om'}]];
    if(await send(uid,msg,kb)){(u.dk=u.dk||[]).push(key);while(u.dk.length>30)u.dk.shift();n++;save()}await sleep(60)}}}
 return n}
// ---- step 2.2 seller tips (free, /watch holders): buyer demand from OTHER users' snipe rules (not muted), shown to the seller.
// BNB: a watched wallet's live TapeOut-market listing matched by N BNB rules -> button opens it on OwlGate (shareable link).
// X Layer: a watched wallet's unlisted MINING voucher that fits N xl rules (payback/power; their highest max price shown) -> List on OwlGate (/xl).
// Once per listing price / voucher (u.sk), at most 1 tip per user per 24 h (u.sa), Mute 7 d button (sm -> u.sm). Runs in the 30 min loop.
const ST={en:{b:'👀 <b>{n} buyer{s} on OwlGate {are} looking for a rig like yours</b>\nYour listing: {c} #{id} · {px} BNB · est. payback ≈ {pb} days\nIt matches their snipe rules (CPU, payback, price, power). Your listing is live on OwlGate; share the link below with buyers.',
 x:'👀 <b>{n} buyer{s} on OwlGate {are} looking for a voucher like yours</b>\nVoucher #{v} · {c} rig #{id} · power {w} · est. payback ≈ {pb}\nHighest max price in their snipe rules: {mx}\nList it on OwlGate and buyers whose rule matches get an alert within a minute. You sign in your own wallet.',
 any:'no limit',d:'{d} days',vb:'View on OwlGate',lx:'List on OwlGate',mu:'Mute 7 d',mm:'Seller tips muted for 7 days.'},
 zh:{b:'👀 <b>OwlGate 上有 {n} 位买家在找类似你的矿机</b>\n你的挂单：{c} #{id} · {px} BNB · 预计回本 ≈ {pb} 天\n它符合他们的狙击规则（处理器、回本、价格、算力）。你的挂单已在 OwlGate 上展示，可把下方链接分享给买家。',
 x:'👀 <b>OwlGate 上有 {n} 位买家在找类似你的凭证</b>\n凭证 #{v} · {c} 矿机 #{id} · 算力 {w} · 预计回本 ≈ {pb}\n他们狙击规则中的最高限价：{mx}\n在 OwlGate 挂单后，规则匹配的买家会在一分钟内收到提醒。由你在自己的钱包签名。',
 any:'不限',d:'{d} 天',vb:'在 OwlGate 查看',lx:'在 OwlGate 挂单',mu:'静音 7 天',mm:'卖家提示已静音 7 天。'}};
const sT=(u,k)=>(ST[u.lang]||ST.en)[k],sF=(u,k,o)=>sT(u,k).replace(/\{(\w+)\}/g,(m,k)=>o[k]??m);
async function sellTick(){if(DRY)return 0;const ls=await apiLs();let xm=null;try{xm=await tmo(fetch(API+'/xl/market',{signal:AbortSignal.timeout(15000)}).then(x=>x.ok?x.json():null),16000)}catch(e){}
 const L=((ls&&ls.items)||[]).filter(x=>x.ok!==false&&x.act&&x.se&&CPA.includes(lc(x.cp))),V=((xm&&xm.ok&&xm.vouchers)||[]).filter(v=>!v.ask&&v.rig&&v.rig.mining&&v.holder);if(!L.length&&!V.length)return 0;
 const RS=[];for(const[uid,u]of Object.entries(S.u))if(!u.blocked&&u.on!==0)for(const r of u.rl||[])if(!(r.mu>now()))RS.push({uid,r});let n=0;
 for(const[uid,u]of Object.entries(S.u)){if(!u.w||!u.w.length||u.blocked||u.on===0||u.sm>now()||now()-(u.sa||0)<DAY)continue;const sk=u.sk=u.sk||[],rs=RS.filter(x=>x.uid!==uid).map(x=>x.r);let msg=null,kb=null,key;
  for(const w of u.w){const A=lc(w.a);
   for(const x of L){if(msg)break;if(lc(x.se)!==A)continue;const ci=CPA.indexOf(lc(x.cp)),px=Number(x.px),vw=Number(x.vw)||0,pb=payback(px,dOf(vw,Number(x.uw)||0)*P.bemBnb,P.g);key='sb:'+ci+':'+x.tid+':'+px;
    if(pb==null||pb===Infinity||sk.includes(key))continue;const m=rs.filter(r=>!r.xl&&(r.cp<0||r.cp===ci)&&(!r.pb||pb<=r.pb)&&(!r.px||px<=r.px)&&(!r.pw||vw>=r.pw)).length;if(!m)continue;
    msg=sF(u,'b',{n:m,s:m>1?'s':'',are:m>1?'are':'is',c:CPN[ci],id:x.tid,px:f(px,4),pb});kb=[[{text:sT(u,'vb'),url:OG+'#buy='+x.tid+'&c='+ci+'&s=tg_sell'}],[{text:kbT(u,'k'),callback_data:'ck:'+ci+':'+x.tid},{text:sT(u,'mu'),callback_data:'sm'}]]}
   for(const v of V){if(msg)break;if(lc(v.holder)!==A)continue;const pb=v.paybackDays,w2=Number(v.rig.power)||0,ci=CPA.indexOf(lc(v.rig.cpu));key='sx:'+v.voucher;if(sk.includes(key))continue;
    const m=rs.filter(r=>r.xl&&(!r.pb||(pb!=null&&pb<=r.pb))&&(!r.pw||w2>=r.pw));if(!m.length)continue;const mx=m.some(r=>!r.px)?sT(u,'any'):f(Math.max(...m.map(r=>r.px)),4)+' OKB';
    msg=sF(u,'x',{n:m.length,s:m.length>1?'s':'',are:m.length>1?'are':'is',v:v.voucher,c:CPN[ci]||'?',id:v.rig.id,w:f(w2,0),pb:pb==null?'—':sF(u,'d',{d:pb}),mx});
    kb=[[{text:sT(u,'lx'),url:OG+'xl'}],[...(ci>=0?[{text:kbT(u,'k'),callback_data:'ck:'+ci+':'+v.rig.id}]:[]),{text:sT(u,'mu'),callback_data:'sm'}]]}
   if(msg)break}
  if(msg&&await send(uid,msg,kb)){sk.push(key);while(sk.length>50)sk.shift();u.sa=now();n++;save();await sleep(60)}}
 return n}
// poll /xl/market; asks seen on the first read (and after a restart, S.xa persists) are not alerted, only new ask hashes
async function xlTick(){let j=null;try{j=await tmo(fetch(API+'/xl/market',{signal:AbortSignal.timeout(15000)}).then(x=>x.ok?x.json():null),16000)}catch(e){}
 if(!j||!j.ok||!Array.isArray(j.vouchers))return 0;const asks=j.vouchers.filter(v=>v.ask&&v.ask.hash),seed=!S.xa,seen=new Set(S.xa||[]);let n=0;
 for(const v of asks)if(!seen.has(v.ask.hash)){seen.add(v.ask.hash);if(seed)continue;const ou=j.prices&&j.prices.okbUsd;n+=await xlFan(v,ou);
  if(v.rig&&v.rig.mining){const px=Number(v.ask.priceOkb);await chPost({net:'X Layer',it:'Voucher #'+v.voucher+' · '+(CPUS[String(v.rig.cpu).toLowerCase()]||'?')+' rig #'+v.rig.id,px:f(px,4)+' OKB',
   u:ou?' ($'+f(px*ou,0)+')':'',w:f(v.rig.power,0),pb:v.paybackDays==null?'—':v.paybackDays+' days',d:v.bemPerDay==null?'—':f(v.bemPerDay,2)},OG+'xl#buy='+v.voucher+'&s=tg_ch')}}
 S.xa=[...seen].slice(-500);save();await tcTick();return n}
// s61 TapeCode-Test1 (TapeOut founder's X Layer collection) on the OwlGate Seaport book: each new open list / offer -> one channel post (same hourly cap).
// No per-user alerts (no rig, no payback); first read and restarts seed S.tc, so only orders placed after that are posted.
const TC1='0x0e91460d6823c711643e650a9a4c0cc21de41614',TCT=x=>{const p=f(Number(x.price)/1e18,4);return `🆕 <b>New on OwlGate</b> · X Layer
`+(x.kind==='list'?`TapeCode-Test1 #${x.tid} listed · <b>${p} OKB</b>`:x.kind==='coll'?`Offer on any TapeCode-Test1 · <b>${p} WOKB</b>
Holders can sell one NFT into it.`:`Offer on TapeCode-Test1 #${x.tid} · <b>${p} WOKB</b>`)};
async function tcTick(){let b=null;try{b=await tmo(fetch(API+'/bids?chain=196',{signal:AbortSignal.timeout(15000)}).then(x=>x.ok?x.json():null),16000)}catch(e){}
 if(!b||!Array.isArray(b.items))return 0;const L=b.items.filter(x=>x&&x.status==='open'&&lc(x.cp)===TC1&&/^0x[0-9a-f]{64}$/i.test(x.hash)),seed=!S.tc,seen=new Set(S.tc||[]);let n=0;
 for(const x of L)if(!seen.has(x.hash)){seen.add(x.hash);if(seed||DRY)continue;if(await chPost(null,OG+'xl?s=tg_ch#xc',TCT(x),x.kind==='list'?'Buy on OwlGate':'Sell on OwlGate'))n++}
 S.tc=[...seen].slice(-500);save();return n}
async function ruleStats(){const a=Object.values(S.u),rs=S.rs||{made:0,sent:0};let fu='funnel n/a';
 try{const j=await tmo(fetch(API+'/funnel',{signal:AbortSignal.timeout(8000)}).then(x=>x.json()),9000),z=j&&j.slugs&&j.slugs.tg_rule;if(z)fu=`link opens ${z.v} · checks ${z.k} · wallets connected ${z.w} · buy txs sent ${z.t} (anonymous counters of slug tg_rule; a sent tx is not proof it confirmed)`;else fu='link opens 0 (no tg_rule visits yet)'}catch(e){}
 return`rules: created ${rs.made} · active ${a.reduce((s,x)=>s+((x.rl&&x.rl.length)||0),0)} (users ${a.filter(x=>x.rl&&x.rl.length).length}) · alerts sent ${rs.sent}\n`+fu}

// ---- D56: 24 h trial of PAID alerts, only after wallet ownership proof. Free features (/check /listings /watch digest /dealalert /rule /feedback) never need it.
// Flow: /trial -> one-time nonce link (15 min) -> site: personal_sign (no tx, no gas) -> user pastes "/verify <wallet> <signature>" -> ecrecover here -> wallet bound.
// One trial per wallet ever (S.tw). A watched address is NOT proof. Pure-JS keccak256 + secp256k1 recovery (bot has no dependencies); tested against ethers.
const M64=(1n<<64n)-1n,KRC=[0x1n,0x8082n,0x800000000000808an,0x8000000080008000n,0x808bn,0x80000001n,0x8000000080008081n,0x8000000000008009n,0x8an,0x88n,0x80008009n,0x8000000an,0x8000808bn,0x800000000000008bn,0x8000000000008089n,0x8000000000008003n,0x8000000000008002n,0x8000000000000080n,0x800an,0x800000008000000an,0x8000000080008081n,0x8000000000008080n,0x80000001n,0x8000000080008008n],
 KROT=[1,3,6,10,15,21,28,36,45,55,2,14,27,41,56,8,25,43,62,18,39,61,20,44],KPI=[10,7,11,17,18,3,5,16,8,21,24,4,15,23,19,13,12,2,20,14,22,9,6,1];
const rol64=(x,n)=>((x<<BigInt(n))|(x>>BigInt(64-n)))&M64;
function keccakF(s){for(let r=0;r<24;r++){const c=[];for(let x=0;x<5;x++)c[x]=s[x]^s[x+5]^s[x+10]^s[x+15]^s[x+20];
  for(let x=0;x<5;x++){const d=c[(x+4)%5]^rol64(c[(x+1)%5],1);for(let y=0;y<25;y+=5)s[y+x]^=d}
  let tt=s[1];for(let i=0;i<24;i++){const j=KPI[i],b=s[j];s[j]=rol64(tt,KROT[i]);tt=b}
  for(let y=0;y<25;y+=5){const a=s.slice(y,y+5);for(let x=0;x<5;x++)s[y+x]=a[x]^((~a[(x+1)%5]&M64)&a[(x+2)%5])}
  s[0]^=KRC[r]}}
function keccak256(buf){const rate=136,s=Array(25).fill(0n),p=Buffer.concat([buf,Buffer.alloc(rate-(buf.length%rate))]);p[buf.length]^=1;p[p.length-1]^=0x80;
 for(let o=0;o<p.length;o+=rate){for(let i=0;i<17;i++)s[i]^=p.readBigUInt64LE(o+i*8);keccakF(s)}
 const out=Buffer.alloc(32);for(let i=0;i<4;i++)out.writeBigUInt64LE(s[i],i*8);return out}
const SP=2n**256n-2n**32n-977n,SN=0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n,
 GP=[0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798n,0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8n];
const md=(a,m=SP)=>((a%m)+m)%m;
function minv(a,m){let r0=md(a,m),r1=m,s0=1n,s1=0n;while(r1){const q=r0/r1;[r0,r1]=[r1,r0-q*r1];[s0,s1]=[s1,s0-q*s1]}return md(s0,m)}
function mpow(b,e,m){let r=1n;b=md(b,m);while(e>0n){if(e&1n)r=r*b%m;b=b*b%m;e>>=1n}return r}
function padd(P,Q){if(!P)return Q;if(!Q)return P;const[x1,y1]=P,[x2,y2]=Q;let l;
 if(x1===x2){if(md(y1+y2)===0n)return null;l=md(3n*x1*x1*minv(2n*y1,SP))}else l=md((y2-y1)*minv(x2-x1,SP));
 const x3=md(l*l-x1-x2);return[x3,md(l*(x1-x3)-y1)]}
function pmul(k,P){let R=null,A=P;while(k>0n){if(k&1n)R=padd(R,A);A=padd(A,A);k>>=1n}return R}
// signer address (lowercase 0x…) of an Ethereum personal_sign signature over message string, or null
function recoverPS(message,sig){try{if(!/^0x[0-9a-fA-F]{130}$/.test(sig))return null;const m=Buffer.from(message,'utf8'),h=keccak256(Buffer.concat([Buffer.from('\x19Ethereum Signed Message:\n'+m.length),m])),
  r=BigInt('0x'+sig.slice(2,66)),s=BigInt('0x'+sig.slice(66,130));let v=parseInt(sig.slice(130),16);if(v>=27)v-=27;if(v!==0&&v!==1)return null;
  if(r<=0n||r>=SN||s<=0n||s>=SN||s>SN/2n)return null;// s in the lower half: no malleable twin
  const y2=md(r*r*r+7n);let y=mpow(y2,(SP+1n)/4n,SP);if(md(y*y)!==y2)return null;if(Number(y&1n)!==v)y=SP-y;
  const ri=minv(r,SN),z=BigInt('0x'+h.toString('hex')),Q=padd(pmul(md(s*ri,SN),[r,y]),pmul(md(-z*ri,SN),GP));if(!Q)return null;
  const pk=Buffer.alloc(64);pk.write(Q[0].toString(16).padStart(64,'0'),0,'hex');pk.write(Q[1].toString(16).padStart(64,'0'),32,'hex');return'0x'+keccak256(pk).slice(12).toString('hex')}catch(e){return null}}
const NONCE_MS=15*60000,VMAX=5,VTRY=5;
// the exact text the site asks the wallet to sign (app/index.html builds the same string)
const trialMsg=(wallet,tg,nonce,xSec)=>'OwlGate trial verification\nProve you own this wallet to start the 24 h trial of paid alerts. No transaction, no fee.\nWallet: '+wallet+'\nTelegram: '+tg+'\nNonce: '+nonce+'\nExpires: '+new Date(xSec*1000).toISOString().replace('.000Z','Z');
Object.assign(TX.en,{
 tLink:'Prove you own a wallet to start your <b>24 h free trial</b> of paid alerts (cheap listings + big BEM sells). Free features need no proof.\n1. Open (link valid 15 min): <a href="{tsd}">Verify wallet</a>\n2. Sign the message in your wallet. No transaction, no fee, no keys shared.\n3. Paste the /verify line the page shows back here.\nOne trial per wallet, ever.',
 tHave:'Your plan is already active until {e} UTC. /status',tPaid:'You already have a paid plan.',tRate:'Too many tries. Please wait a bit and try again.',
 tUse:'Usage: /verify 0xYourWallet 0xSignature (the page after /trial shows the exact line).',tNone:'No open verification. Send /trial for a new link.',
 tExp:'This verification link expired or was already used. Send /trial for a new one.',tBad:'The signature does not match that wallet. Open the link again and sign with the same wallet.',
 tUsed:'This wallet already used its free trial, so no new trial is started. Free features still work. /pay for paid alerts.',
 tDone:'Wallet verified. Your <b>24 h trial</b> of paid alerts runs until <b>{e} UTC</b>. After that: /pay.',tDoneK:'Wallet verified. Your current plan ({e} UTC) is unchanged.'});
Object.assign(TX.zh,{
 tLink:'证明你拥有一个钱包，即可开始 <b>24 小时免费试用</b> 付费提醒（低价上架 + 大额卖出 BEM）。免费功能无需证明。\n1. 打开（链接 15 分钟内有效）：<a href="{tsd}">验证钱包</a>\n2. 在钱包中签名。无需交易、无手续费、不泄露私钥。\n3. 把页面显示的 /verify 一行粘贴回这里。\n每个钱包只能试用一次。',
 tHave:'你的方案已生效，至 {e} UTC。/status',tPaid:'你已经是付费方案。',tRate:'尝试次数过多，请稍后再试。',
 tUse:'用法：/verify 0x你的钱包 0x签名（/trial 之后的页面会给出完整一行）。',tNone:'没有待验证的请求。发送 /trial 获取新链接。',
 tExp:'该验证链接已过期或已使用。发送 /trial 获取新链接。',tBad:'签名与该钱包不匹配。请重新打开链接，并用同一个钱包签名。',
 tUsed:'该钱包已经使用过免费试用，因此不会再开始新的试用。免费功能仍可使用。/pay 开通付费提醒。',
 tDone:'钱包已验证。付费提醒 <b>24 小时试用</b> 至 <b>{e} UTC</b>。之后请 /pay。',tDoneK:'钱包已验证。你当前的方案（{e} UTC）不变。'});
const utc=ms=>new Date(ms).toISOString().slice(0,16).replace('T',' ');
function trialCmd(c,arg,arg2,u,id){const n=now();S.vn=S.vn||{};S.tw=S.tw||{};
 for(const[k,v]of Object.entries(S.vn))if(v.x*1000<n-60000)delete S.vn[k];
 if(c==='/trial'){if(!u.trial&&u.exp>n)return t(u,'tPaid');if(u.exp>n&&u.trial&&u.wv)return t(u,'tHave',{e:utc(u.exp)});
  if(u.wv&&u.exp<=n)return t(u,'tUsed');
  const vl=u.vl=(u.vl||[]).filter(x=>n-x<36e5);if(vl.length>=VMAX||Object.keys(S.vn).length>5000)return t(u,'tRate');vl.push(n);
  for(const[k,v]of Object.entries(S.vn))if(v.id===id)delete S.vn[k];// one open nonce per user
  const nonce=crypto.randomBytes(12).toString('hex'),x=Math.floor((n+NONCE_MS)/1000);S.vn[nonce]={id,x,tries:0};
  return t(u,'tLink',{tsd:TSD+'#v='+nonce+'&amp;t='+id+'&amp;x='+x+'&amp;l='+u.lang+'&amp;s=tg_verify'})}
 // /verify <wallet> <signature>
 const w=(arg||'').toLowerCase(),sig=arg2||'';if(!/^0x[0-9a-f]{40}$/.test(w)||!/^0x[0-9a-fA-F]{130}$/.test(sig))return t(u,'tUse');
 const vv=u.vv=(u.vv||[]).filter(x=>n-x<36e5);if(vv.length>=10)return t(u,'tRate');vv.push(n);
 const hit=Object.entries(S.vn).find(([k,v])=>v.id===id);if(!hit)return t(u,'tNone');const[nonce,v]=hit;
 if(v.x*1000<n)return(delete S.vn[nonce],t(u,'tExp'));
 const who=recoverPS(trialMsg(w,id,nonce,v.x),sig);
 if(who!==w){if(++v.tries>=VTRY)delete S.vn[nonce];return t(u,'tBad')}
 delete S.vn[nonce];// single use
 if(S.tw[w]||u.wv)return t(u,'tUsed');// one trial per wallet AND per Telegram account
 S.tw[w]={id,at:n};u.wv=w;
 if(u.exp>n||!u.trial){return t(u,'tDoneK',{e:utc(u.exp)})}// legacy trial or paid plan keeps its expiry
 u.exp=n+TRIAL_MS;u.trial=1;u.warn=0;u.on=1;
 if(ADMIN&&id!==ADMIN)send(ADMIN,`trial started ${id}${u.un?' @'+eh(u.un):''} · wallet ${w.slice(0,8)}… · until ${utc(u.exp)} UTC`);
 return t(u,'tDone',{e:utc(u.exp)})}

// ---- chain watcher ----
async function onListing(l){const cp=tad(l.topics[3]);if(!CPUS[cp])return;const tid=wd(l.data,0),px=nw(l.data,1,18);
 const key=await call(MINING,'0x10eafa00'+W(cp)+W(tid)),g=await call(MINING,'0x0527edc2'+key.slice(2));
 if(nw(g,9)!==1)return;const vw=nw(g,19),uw=nw(g,20);if(!vw)return;// active, verified pool only
 const d=dOf(vw,uw),pb=payback(px,d*P.bemBnb,P.g);if(pb==null||pb===Infinity)return;
 console.log('listing',CPUS[cp],tid,px,pb);
 const mk=u=>t(u,'li',{c:CPUS[cp],id:tid.toString(),px:f(px,4),u:f(px*P.bnbUsd,0),pb,d:f(d,2),w:f(vw,0),s:f(vw/P.tv*100,3)+'%',tsd:TSD+'#buy='+tid+'&amp;c='+(CPUS[cp]==='Behemoth'?1:0)+'&amp;s=tg_alert',tx:l.transactionHash});await fan(u=>pb<=u.pb,mk);await ruleFan({ci:CPUS[cp]==='Behemoth'?1:0,id:tid.toString(),px,pb,d,w:vw,dkey:cp+':'+tid+':'+px});await chPost({net:'BNB Chain',it:CPUS[cp]+' #'+tid,px:f(px,4)+' BNB',u:' ($'+f(px*P.bnbUsd,0)+')',w:f(vw,0),pb:pb+' days',d:f(d,2)},TSD+'#buy='+tid+'&c='+(CPUS[cp]==='Behemoth'?1:0)+'&s=tg_ch');await dealFan(CPUS[cp]==='Behemoth'?1:0,pb,cp+':'+tid+':'+px,mk)}
// other-market asks have no chain event: diff the API list every chain loop (~15 s); the first live list only seeds. Max 5 alerts per run.
let XS=null,XA=0;
async function extAlerts(){const j=await apiLs();if(!j||j.extState!=='live')return;const cur=new Set();let n=0;
 for(const x of extOf(j)){const cp=String(x.cp).toLowerCase(),k=cp+':'+x.tid+':'+x.cost;cur.add(k);if(!XS||XS.has(k)||n>=5)continue;
  const vw=Number(x.vw),px=Number(x.cost);if(!CPUS[cp]||!x.act||!(vw>0)||!(px>0)||!/^\d{1,9}$/.test(String(x.tid)))continue;
  const d=dOf(vw,Number(x.uw)||0),pb=payback(px,d*P.bemBnb,P.g);if(pb==null||pb===Infinity)continue;n++;
  console.log('ext listing',CPUS[cp],x.tid,px,pb);
  const mk=u=>t(u,'lix',{c:CPUS[cp],id:String(x.tid),px:f(px,4),u:f(px*P.bnbUsd,0),pb,d:f(d,2),w:f(vw,0),s:f(vw/P.tv*100,3)+'%',tsd:TSD+'#buy='+x.tid+'&amp;c='+(CPUS[cp]==='Behemoth'?1:0)+'&amp;s=tg_alert'});await fan(u=>pb<=u.pb,mk);await dealFan(CPUS[cp]==='Behemoth'?1:0,pb,cp+':'+x.tid+':'+px,mk)}
 XS=cur}
// one alert per tx: net BEM sold across all its swaps, priced at the tx's own USD/BEM
async function onSwap(ls){let bem=0,usd=0;for(const l of ls){const q=POOL[l.address.toLowerCase()],a0=Number(sgn(wd(l.data,0))),a1=Number(sgn(wd(l.data,1)));
  bem+=(q?a0:a1)/1e8;usd-=q?a1/1e18*P.bnbUsd:a0/1e18}// pool deltas: bem>0 = sold into pool, usd>0 = paid out
 if(bem<=0||usd<=0)return;const px=usd/bem;
 if(px>P.bemUsd*1.2){console.log('skip sell into pump',f(bem,0),'BEM @',f(px,2),'ref',f(P.bemUsd,2),ls[0].transactionHash);return}// MEV backrun of a price-pushing buy
 await fan(u=>u.usd>0&&usd>=u.usd,u=>t(u,'sell',{x:f(bem,0),u:f(usd,0),p:f(px,6),tx:ls[0].transactionHash}))}
async function onPay(l){const raw=wd(l.data,0),c=String(raw%10000n),inv=S.inv[c];
 if(S.paid.some(x=>x.tx===l.transactionHash+l.logIndex))return;
 const a=Number(raw)/1e8;S.paid.push({tx:l.transactionHash+l.logIndex,a,from:tad(l.topics[1]),c,id:inv?.id||null,at:now()});
 const n=Number(raw/UNIT);if(!inv||inv.until<now()||n<1){save();console.log('unmatched payment',a,l.transactionHash);
  if(ADMIN)await send(ADMIN,`unmatched payment ${a} BEM from ${tad(l.topics[1])} · code ${c}${inv?' (invoice expired, user '+inv.id+')':' (no invoice)'}\ntx ${l.transactionHash}\nCredit with /grant, or hide a test with /unpay ${l.transactionHash.slice(0,12)}`);return}
 const u=S.u[inv.id];u.exp=Math.max(u.exp,now())+n*PERIOD*DAY;u.trial=0;u.warn=0;u.on=1;delete S.inv[c];save();await send(inv.id,t(u,'got',{a:f(a,4),e:dt(u.exp)}));
 if(ADMIN&&inv.id!==ADMIN)await send(ADMIN,`paid ${a} BEM · user ${inv.id}${u.un?' @'+eh(u.un):''} · until ${dt(u.exp)}\ntx ${eh(l.transactionHash)}`)}
async function reminders(){for(const[id,u]of Object.entries(S.u)){if(u.blocked)continue;const l=u.exp-now();
 if(l>0&&l<(u.trial?3*36e5:2*DAY)&&u.warn<1){if(u.trial&&!u.on)continue;u.warn=1;await send(id,t(u,u.trial?'w2t':'w2',{e:u.trial?utc(u.exp):dt(u.exp),pb:u.pb,p:PRICE,n:PERIOD}))}else if(l<=0&&u.warn<2){u.warn=2;await send(id,t(u,'w0'))}}save()}
async function chainLoop(){for(;;){try{if(!P||now()-P.at>6e5){await loadP();await reminders()}
 const hd=parseInt(await rpc('eth_blockNumber',[]),16);if(!S.b){S.b=hd-Number(E.BACKFILL||0);save()}
 const fr=S.b+1,to=Math.min(hd,fr+4999);
 if(fr<=to){const[a,p,bn]=await Promise.all([rpc('eth_getLogs',[{address:[CMKT,P1,P2,P3],topics:[[T_LI,T_SW,T_SO]],fromBlock:hx(fr),toBlock:hx(to)}],LOGS),
   rpc('eth_getLogs',[{address:BEM,topics:[T_TR,null,'0x'+W(TREASURY)],fromBlock:hx(fr),toBlock:hx(to)}],LOGS),
   rpc('eth_getLogs',[{address:BEM,topics:[T_TR,'0x'+W(TREASURY),['0x'+W(DEAD),'0x'+W(0)]],fromBlock:hx(fr),toBlock:hx(to)}],LOGS)]);
  S.burn+=bn.reduce((s,l)=>s+nw(l.data,0,8),0);
  for(const l of p)await onPay(l);
  const sw={};for(const l of a){if(l.address.toLowerCase()===CMKT.toLowerCase()&&(l.topics[0]===T_LI||l.topics[0]===T_SO))await tradeFan(l).catch(e=>console.error('trade',e.message));
   try{if(l.topics[0]===T_LI&&l.address.toLowerCase()===CMKT.toLowerCase())await onListing(l);else if(l.topics[0]===T_SW&&POOL[l.address.toLowerCase()]!==undefined)(sw[l.transactionHash]??=[]).push(l)}catch(e){console.error('log',e.message)}}
  for(const ls of Object.values(sw))await onSwap(ls).catch(e=>console.error('swap',e.message));
  S.b=to;save()}}catch(e){console.error('chain',e.message)}
 if(now()-XA>1e4){XA=now();await extAlerts().catch(e=>console.error('ext',e.message))}
 await sleep(15000)}}

if(E.TSD_TEST==='1'){module.exports={sellTick,chPost,offTick,tcTick,TCT,onCb,xlTick,xlFan,parseCmd,parseCheck,allow,RL,gMsg,gStats,fmtCheck,readCircuit,topList,fmtIntro,resetTop:()=>{TOP={at:0,v:[]};LS={at:0,j:null}},extAlerts,resetX:()=>{XS=null},setP:x=>{P=x},S,eh,setBot:x=>{BOTNAME=x},onMsg,watchCmd,rigStats,fmtDigest,riskOf,snap,watchTick,dealFan,wStats,rkMsg,ruleCmd,ruleFan,ruleStats,tradeFan,keccak256,recoverPS,trialMsg,trialCmd,reminders,resetW:()=>{RC=new Map()},WT};return}
console.log('OwlGate bot up · treasury',TREASURY,'· price',PRICE,'BEM /',PERIOD,'d · trial',TRIAL_MS/36e5,'h after wallet proof');
if(!DRY){const cm=l=>['status','pay','payback','sell','trial','listings','watch','mywatch','digest','trades','dealalert','snipe','rule','feedback','off','on','burn','lang','check','help'].map(c=>({command:c,description:(l==='zh'?{check:'检查电路（回本估算）',status:'订阅与设置',pay:'BEM 付费',trial:'24 小时试用（钱包证明）',listings:'在售电路',payback:'回本上限（天）',sell:'卖出提醒金额（美元）',off:'暂停',on:'恢复',burn:'金库与销毁',lang:'语言 en|zh',help:'帮助',watch:'关注钱包（免费简报）',mywatch:'我的关注',digest:'简报频率',trades:'关注钱包交易提醒',dealalert:'捡漏提醒',snipe:'狙击提醒（回本/价格/算力）',rule:'买入规则',feedback:'反馈'}:{check:'Check a circuit (payback estimate)',status:'Plan and settings',pay:'Pay with BEM',trial:'24 h trial (wallet proof)',listings:'Circuits for sale',payback:'Max payback days',sell:'Min USD for sell alerts',off:'Pause',on:'Resume',burn:'Treasury and burns',lang:'Language en|zh',help:'Help',watch:'Watch a wallet (free digest)',mywatch:'My watched wallets',digest:'Digest frequency',trades:'Trades of watched wallets',dealalert:'Deal alert',snipe:'Snipe alerts (payback, price, power)',rule:'Buy rules',feedback:'Send feedback'})[c]}));
 TG('getMe',{}).then(r=>{if(r.ok)BOTNAME=r.result.username||''}).catch(()=>{});
 const gc=l=>[['check',l==='zh'?'检查电路（回本估算）':'Check a circuit (payback estimate)'],['tsd_off',l==='zh'?'管理员：关闭本群 /check':'Admins: turn /check off here'],['tsd_on',l==='zh'?'管理员：开启本群 /check':'Admins: turn /check on here'],['tsd_lang',l==='zh'?'管理员：本群语言 en|zh':'Admins: chat language en|zh']].map(([command,description])=>({command,description}));
 for(const l of ['en','zh'])TG('setMyCommands',{commands:gc(l),scope:{type:'all_group_chats'},...(l==='zh'?{language_code:'zh'}:{})}).catch(()=>{});
 TG('setMyCommands',{commands:cm('en')}).catch(()=>{});TG('setMyCommands',{commands:cm('zh'),language_code:'zh'}).catch(()=>{});
 // profile texts (short = profile/share card, description = empty chat screen); set on every start so BotFather edits are not needed
 for(const[lc,sd,d]of[['','TapeOut rig alerts and checks · owlgate.xyz','OwlGate bot for TapeOut rigs.\n\n/check 17628 — payback estimate\n/snipe — alert when a listing matches your filters\n/watch 0x… — follow a wallet\n\nTrade on owlgate.xyz'],
  ['zh','TapeOut 矿机提醒与查询 · owlgate.xyz','OwlGate TapeOut 矿机机器人。\n\n/check 17628 — 回本估算\n/snipe — 挂单符合条件时提醒\n/watch 0x… — 关注钱包\n\n交易请到 owlgate.xyz']]){
  TG('setMyShortDescription',{short_description:sd,language_code:lc}).catch(()=>{});TG('setMyDescription',{description:d,language_code:lc}).catch(()=>{})}
 tgLoop()}chainLoop();(async()=>{await sleep(30000);for(;;){await xlTick().catch(e=>console.error('xlTick',e.message));await offTick().catch(e=>console.error('offTick',e.message));await sleep(60000)}})();(async()=>{await sleep(20000);for(;;){await watchTick().catch(e=>console.error('watchTick',e.message));await sellTick().catch(e=>console.error('sellTick',e.message));await sleep(30*60000)}})();
