// D53 + D54-A test: /watch, digest, deal alert, risk alert, /feedback, /rule in bot/tsd-bot.js with stubbed Telegram + API + RPC. No token, no network.
// Run: node tools/test-watch.js
'use strict';
const fs=require('fs'),path=require('path');
const DBREL='../tools/.test-watch-data.json',DBF=path.join(__dirname,'.test-watch-data.json');try{fs.unlinkSync(DBF)}catch(e){}
Object.assign(process.env,{TSD_TEST:'1',BOT_TOKEN:'000:TEST',TREASURY:'0x'+'1'.repeat(40),ADMIN_ID:'999',DATA_FILE:DBREL});
const TO='0xb1024b89886b9a34aa4ff5f31c411d708b20a14c',BH='0x1f5cb4aeae1807bf60c3b9c0d8adbcc14e91f12c',WA='0x'+'ab'.repeat(20),WB='0x'+'cd'.repeat(20);
const sent=[],cfg={rigFail:false,ext:true};let apiHits=0;
global.fetch=async(url,o)=>{url=String(url);
 if(url.includes('api.telegram.org')){const m=url.split('/').pop(),b=JSON.parse(o.body);if(m==='sendMessage'){if(cfg.tgFail&&String(b.chat_id)===String(cfg.tgFail))return{json:async()=>({ok:false,error_code:500})};sent.push(b);return{json:async()=>({ok:true})}}return{json:async()=>({ok:true,result:{username:'tsdbot'}})}}
 if(/api\.owlgate\.xyz\/rig\?a=/.test(url)){apiHits++;if(cfg.rigFail)return{ok:false,json:async()=>({})};const a=url.split('a=')[1];
  if(a===WB)return{ok:true,json:async()=>({ok:true,items:[],n:0})};
  return{ok:true,json:async()=>({ok:true,block:1,n:3,capped:false,claimed:cfg.claims,items:cfg.items||[
   {cp:TO,id:1,st:1,vw:50,uw:0,pend:10,p1:8,p7:3,p14:1},{cp:TO,id:2,st:1,vw:30,uw:0,pend:5,p1:6,p7:1,p14:.5},{cp:BH,id:3,st:0,vw:0,uw:0,pend:0,p1:0,p7:0,p14:0}]})}}
 if(/api\.owlgate\.xyz\/listings$/.test(url))return{json:async()=>({tu:2000,items:[{cp:TO,tid:'500',px:.004,ok:true,act:true,vw:50,se:cfg.se},{cp:TO,tid:'600',px:.006,ok:true,act:true,vw:55},{cp:TO,tid:'700',px:.0001,ok:true,act:true,vw:5}],
  extState:cfg.ext?'live':'off',ext:cfg.ext?[{cp:TO,tid:'800',cost:.0035,vw:50,act:true,ok:true}]:[]})};
 if(/api\.owlgate\.xyz\/xl\/market$/.test(url))return cfg.xm?{ok:true,json:async()=>cfg.xm}:{ok:false,json:async()=>({})};
 if(/api\.owlgate\.xyz\/bids\?chain=(56|196)$/.test(url))return{ok:true,json:async()=>({items:(url.endsWith('196')?cfg.b196:cfg.b56)||[]})};
 if(/api\.owlgate\.xyz\/funnel$/.test(url))return{json:async()=>({slugs:{tg_rule:{v:7,k:5,w:3,t:1}}})};
 throw Error('UNEXPECTED NETWORK '+url)};
const B=require('../bot/tsd-bot.js');
B.setP({at:Date.now(),bt:3,bemUsd:5,bnbUsd:600,bemBnb:5/600,day:7199,tv:1e6,g:.01});B.setBot('TSDBot');
let pass=0,fail=0;const ok=(c,n)=>{if(c)pass++;else{fail++;console.log('FAIL',n)}};
const S=B.S,rl=()=>{B.RL.c.clear();B.RL.u.clear()},msg=(text,id=10,lc='en')=>(rl(),{message_id:1,text,chat:{id,type:'private'},from:{id,language_code:lc,username:'u'+id}});
const to=id=>sent.filter(x=>String(x.chat_id)===String(id)),last=id=>(to(id).slice(-1)[0]||{}).text||'';
const BAN=/buy now|sell now|should|guaranteed|profit|稳赚|建议卖出|建议持有|抄底|逃顶|firsto/i,VI=/[ăâđêôơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/i;
(async()=>{
 // --- /watch
 await B.onMsg(msg('/watch'));ok(/Usage: \/watch/.test(last(10)),'watch usage');
 await B.onMsg(msg('/watch 0x123'));ok(/Usage: \/watch/.test(last(10)),'watch bad address');
 await B.onMsg(msg('/watch 0x'+'g'.repeat(40)));ok(/Usage: \/watch/.test(last(10)),'watch non-hex');
 sent.length=0;await B.onMsg(msg('/watch '+WA.toUpperCase().replace('0X','0x')));
 ok(to(10).length===2&&/Watching/.test(to(10)[0].text)&&/OwlGate digest/.test(to(10)[1].text),'watch: confirm + first digest');
 const u=S.u['10'];ok(u.w.length===1&&u.w[0].a===WA&&u.dg==='w'&&u.wf>0,'stored lowercase, weekly default');
 B.resetW();sent.length=0;await B.onMsg(msg('/watch '+WA));ok(/already watch/.test(last(10)),'duplicate refused');
 await B.onMsg(msg('/watch 0x'+'11'.repeat(20)));await B.onMsg(msg('/watch 0x'+'22'.repeat(20)));
 B.resetW();sent.length=0;await B.onMsg(msg('/watch 0x'+'33'.repeat(20)));ok(u.w.length===3&&/already watch 3/.test(last(10)),'limit 3 wallets');
 sent.length=0;await B.onMsg(msg('/mywatch'));ok(/Watching \(3\/3\)/.test(last(10))&&last(10).includes(WA),'mywatch lists');
 sent.length=0;await B.onMsg(msg('/unwatch 3'));ok(u.w.length===2,'unwatch by number');await B.onMsg(msg('/unwatch '+'0x'+'11'.repeat(20)));ok(u.w.length===1,'unwatch by address');
 await B.onMsg(msg('/unwatch 0x'+'44'.repeat(20)));ok(/not in your list/.test(last(10)),'unwatch unknown');
 await B.onMsg(msg('/digest daily'));ok(u.dg==='d','digest daily');await B.onMsg(msg('/digest weekly'));ok(u.dg==='w','digest weekly');await B.onMsg(msg('/digest bogus'));ok(/Usage: \/digest/.test(last(10)),'digest usage');
 // --- digest content (numbers)
 B.resetW();const R=await B.rigStats(WA);
 ok(R.k===2&&R.n===3&&Math.abs(R.day-(.99*7199*80/1e6))<1e-9,'rig count + rate');
 ok(Math.abs(R.e1.v-7)<1e-9&&R.e1.lb===1,'24h earned: 2 + claimed circuit lower bound 5, flagged');
 ok(Math.abs(R.e7.v-11)<1e-9&&Math.abs(R.ep.v-2.5)<1e-9,'week 11 vs previous week 2.5');
 ok(R.pend===15&&R.lead.id===1&&R.ref.n===2&&R.best.tid==='500'&&R.ext===.0035,'unclaimed, lead, 2 comparables, best ask, other market');
 const tx=B.fmtDigest({lang:'en'},R);
 ok(/Earned, measured on chain/.test(tx)&&/at least/.test(tx)&&/Unclaimed now: <b>15\.0*/.test(tx)||/Unclaimed now: <b>15<\/b>/.test(tx),'EN digest earned + unclaimed + lower-bound note');
 ok(/Hold vs offer \(estimate\)/.test(tx)&&/Estimate, not advice/.test(tx)&&/does not tell you to hold or sell/.test(tx)&&/Remaining payback from today \(estimate\)/.test(tx),'hold-vs-offer + estimate labels');
 ok(/Best ask on the circuit market/.test(tx)&&/Also listed on another market/.test(tx)&&/Not buyable in OwlGate/.test(tx),'best ask + other market (D52)');
 ok(!BAN.test(tx)&&!/http/.test(tx.replace(/<[^>]+>/g,'')),'no banned words, no other-market name or link');
 const tz=B.fmtDigest({lang:'zh'},R);ok(/持有 vs 出价（估算）/.test(tz)&&/其他市场/.test(tz)&&/不构成建议/.test(tz)&&!BAN.test(tz)&&!VI.test(tz),'ZH digest labels, no Vietnamese');
 B.resetW();cfg.rigFail=false;const R0=await B.rigStats(WB);const t0=B.fmtDigest({lang:'en'},R0);ok(/No TapeOut \/ Behemoth circuits/.test(t0),'empty wallet message');
 cfg.claims={d1:2,d7:6,p7:1};B.resetW();const Rc=await B.rigStats(WA);cfg.claims=null;
 ok(Math.abs(Rc.e1.v-(15-(8+6+0))-2)<1e-9&&Rc.e1.lb===0,'with Claim events: 24h = change of pending + claimed (exact)');ok(Math.abs(Rc.e7.v-(15-4)-6)<1e-9&&Math.abs(Rc.ep.v-(4-1.5)-1)<1e-9,'7d and previous-week windows use claims inside each window');ok(!/at least/.test(B.fmtDigest({lang:'en'},Rc)),'no lower-bound note when claims are known');B.resetW();
 cfg.items=[{cp:TO,id:9,st:1,vw:50,uw:0,pend:1,p1:null,p7:null,p14:null}];B.resetW();const Rn=await B.rigStats('0x'+'ee'.repeat(20));ok(Rn.e1===null,'history unavailable -> n/a, not invented');ok(/—/.test(B.fmtDigest({lang:'en'},Rn))&&/at least/.test(B.fmtDigest({lang:'en'},Rn)),'n/a shown as dash with note');cfg.items=null;
 // thin market: <2 comparables hides the card
 const Rt={...R,ref:null,pbRem:null};ok(/not enough comparable/.test(B.fmtDigest({lang:'en'},Rt)),'<2 comparables -> no hold-vs-offer numbers');
 // API down
 cfg.rigFail=true;B.resetW();sent.length=0;await B.onMsg(msg('/digest now'));ok(/unavailable/.test(last(10)),'API down -> plain message');cfg.rigFail=false;
 // --- risk rules
 const mk=(o={})=>({...R,...o}),sn=B.snap(R);
 ok(B.riskOf(sn,R).length===0,'no change -> no risk');
 ok(B.riskOf({...sn,day:R.day/0.6},R).some(x=>x.k==='Dr'),'drop >=30% flagged');ok(!B.riskOf({...sn,day:R.day/0.8},R).some(x=>x.k==='Dr'),'drop 20% not flagged');
 ok(B.riskOf({...sn,m:[...sn.m,'b1024b:99']},{...R,its:[...R.its,{cp:TO,id:99,st:0,vw:0}]}).some(x=>x.k==='St'&&/#99/.test(x.ids)),'stopped mining flagged');
 ok(!B.riskOf({...sn,m:[...sn.m,'b1024b:99']},R).some(x=>x.k==='St'),'circuit that left the wallet is not "stopped"');
 ok(B.riskOf({...sn,pb:40},mk({pbRem:70})).some(x=>x.k==='Pb')&&!B.riskOf({...sn,pb:40},mk({pbRem:55})).some(x=>x.k==='Pb')&&!B.riskOf({...sn,pb:100},mk({pbRem:140})).some(x=>x.k==='Pb')&&B.riskOf({...sn,pb:50},mk({pbRem:Infinity})).some(x=>x.k==='Pb'),'payback x1.5 and +30 days; or beyond 1095');
 const rm=B.rkMsg({lang:'en'},WA,B.riskOf({...sn,day:R.day/0.5},R));ok(/Rig check/.test(rm)&&/not advice/.test(rm),'risk text');ok(/矿机检查/.test(B.rkMsg({lang:'zh'},WA,B.riskOf({...sn,day:R.day/0.5},R))),'risk ZH');
 // --- tick: scheduled digest, risk alert + cooldown, retention
 B.resetW();sent.length=0;const w=u.w[0];u.dg='w';u.dn=Date.now()-8*864e5;u.wf=Date.now()-8*864e5;w.s={...sn,t:Date.now()-7*36e5,day:R.day/0.5};
 await B.watchTick();const m10=to(10).map(x=>x.text);
 ok(m10.some(x=>/OwlGate digest/.test(x))&&m10.some(x=>/Rig check/.test(x))&&u.dl.length===1,'tick: weekly digest + risk alert delivered, delivery logged');
 ok(u.r1===1&&u.r7===1,'D1 and D7 retention recorded (subscribed + delivered)');
 sent.length=0;w.s={...sn,t:Date.now()-7*36e5,day:R.day/0.5};await B.watchTick();ok(!to(10).some(x=>/Rig check/.test(x.text)),'risk cooldown 24 h');
 sent.length=0;u.dn=Date.now();w.ra=0;w.s=null;await B.watchTick();ok(to(10).length===0&&w.s&&w.s.m.length===2,'first tick only takes a snapshot');
 const ws=B.wStats();ok(/watched wallets 1/.test(ws)&&/D1 1\/1/.test(ws)&&/D7 1\/1/.test(ws)&&/feedback 0/.test(ws),'metrics text: '+ws.replace(/\n/g,' | '));
 // --- deal alert
 const u2=B.S.u['20']||await(async()=>{await B.onMsg(msg('/start',20));return S.u['20']})();
 await B.onMsg(msg('/dealalert',20));ok(/Usage: \/dealalert/.test(last(20)),'dealalert usage');await B.onMsg(msg('/dealalert behemoth 60',20));ok(u2.da&&u2.da[1]===60&&u2.da[0]===undefined&&/payback ≤/.test(last(20)),'dealalert behemoth 60');
 await B.onMsg(msg('/dealalert behemoth abc',20));ok(/Usage/.test(last(20))&&u2.da[1]===60,'dealalert bad number keeps old');
 const mkD=u=>'DEAL '+u.lang;sent.length=0;u2.exp=0;// trial over: deal alerts are free anyway
 await B.dealFan(1,50,'k1',mkD);ok(to(20).length===1,'deal alert under threshold');await B.dealFan(1,50,'k1',mkD);ok(to(20).length===1,'deal alert deduped');
 await B.dealFan(1,70,'k2',mkD);ok(to(20).length===1,'above threshold: nothing');await B.dealFan(0,10,'k3',mkD);ok(to(20).length===1,'other processor: nothing');
 for(let i=0;i<6;i++)await B.dealFan(1,40,'x'+i,mkD);ok(to(20).length===1+3,'rate limit 4 per hour (got '+(to(20).length-1)+' more)');
 u2.dh=[];u2.dk=[];u2.exp=Date.now()+864e5;u2.pb=100;sent.length=0;await B.dealFan(1,50,'live',mkD);ok(to(20).length===0,'user already served by the normal alert is skipped');
 await B.onMsg(msg('/dealalert off',20));ok(Object.keys(u2.da).length===0,'dealalert off');
 // --- feedback
 sent.length=0;await B.onMsg(msg('/feedback',30));ok(/1\. What do you use OwlGate for\?/.test(last(30))&&/3\. What is missing\?/.test(last(30)),'feedback usage lists 3 questions');
 await B.onMsg(msg('/feedback I use it to check <b>circuits</b>',30));ok(/saved and sent/.test(last(30))&&/2\. What brings you back\?/.test(last(30)),'feedback reply with 3 questions');
 const fw=to(999).find(x=>/feedback #1/.test(x.text));ok(fw&&/&#60;b&#62;circuits/.test(fw.text)&&B.S.fbk.length===1&&B.S.fbk[0].t.includes('circuits'),'stored + forwarded to admin, escaped');
 for(let i=0;i<5;i++)await B.onMsg(msg('/feedback more '+i,30));ok(B.S.fbk.length===5&&/limit reached/.test(last(30)),'feedback 5 per day');
 await B.onMsg(msg('/feedback 很好用',31,'zh'));ok(/三个问题/.test(last(31)),'feedback ZH');
 ok(/feedback 6/.test(B.wStats()),'feedback count in metrics');
 ok(/4\. Would you pay a monthly fee in BEM for instant deal alerts/.test(last(30).length?B.WT.en.fbOk:'')&&/2\. What brings you back\?/.test(B.WT.en.fbOk)&&/什么会让你回来？/.test(B.WT.zh.fbOk)&&/4\. 如果即时捡漏提醒（免费版会晚几分钟）按月用 BEM 付费，你愿意吗？愿意的话每月多少？/.test(B.WT.zh.fbOk),'Q4 added EN+ZH, Q2 unchanged');
 S.u['30'].fb=[];await B.onMsg(msg('/feedback pay yes 5',30));ok(S.u['30'].pay.a==='yes'&&S.u['30'].pay.amt===5&&B.S.fbk.slice(-1)[0].pay==='yes','pay answer stored as separate field');
 S.u['31'].fb=[];await B.onMsg(msg('/feedback pay no',31,'zh'));ok(S.u['31'].pay.a==='no'&&/已记录/.test(last(31)),'pay no (ZH reply)');
 ok(/pay-for-instant-alerts: yes 1 \/ no 1/.test(B.wStats()),'yes/no counts in metrics');
 // --- /rule (D54-A)
 const R1=await(async()=>{await B.onMsg(msg('/start',40));return S.u['40']})();
 await B.onMsg(msg('/rule',40));ok(/\/snipe add/.test(last(40)),'rule usage');
 await B.onMsg(msg('/rule add behemoth 60 0.5',40));ok(R1.rl.length===1&&R1.rl[0].cp===1&&R1.rl[0].pb===60&&R1.rl[0].px===.5&&/never buy for you/.test(last(40)),'rule saved');
 for(const bad of ['/rule add foo 60','/rule add behemoth 0','/rule add behemoth 2000','/rule add behemoth 60 -1','/rule add behemoth 60 x','/rule add behemoth 60 0.5 9','/rule add behemoth'])await B.onMsg(msg(bad,40));ok(R1.rl.length===1,'bad rules rejected');
 await B.onMsg(msg('/rule add any 90',40));await B.onMsg(msg('/rule add tapeout 30 0.1',40));await B.onMsg(msg('/rule add tapeout 31',40));await B.onMsg(msg('/rule add tapeout 32',40));
 ok(R1.rl.length===5,'5 rules');await B.onMsg(msg('/rule add tapeout 33',40));ok(R1.rl.length===5&&/already have 5/.test(last(40)),'limit 5 rules');
 await B.onMsg(msg('/rule list',40));ok(/behemoth|Behemoth/.test(last(40))&&/price ≤ 0.5 BNB/.test(last(40)),'rule list');
 await B.onMsg(msg('/rule del 2',40));ok(R1.rl.length===4,'rule del 2');await B.onMsg(msg('/rule del 9',40));ok(/No such rule/.test(last(40)),'rule del unknown');
 R1.rl=[];await B.onMsg(msg('/rule add behemoth 60 0.5',40));R1.dh=[];R1.dk=[];sent.length=0;
 const info=(o={})=>({ci:1,id:'123',px:.4,pb:50,d:3.2,dkey:'bh:123:0.4',...o});
 ok(await B.ruleFan(info())===1,'rule matches');const rt=last(40);
 ok(/#1 matched/.test(rt)&&/OwlGate fee 1\.00%/.test(rt)&&/Test with small amounts only/.test(rt)&&/never holds your keys or funds/.test(rt)&&/not advice/.test(rt)&&!BAN.test(rt),'rule alert text: fee, small amounts, no keys, no advice');
 {const kb=(to(40).slice(-1)[0]||{}).reply_markup.inline_keyboard;ok(kb[0][0].url==='https://owlgate.xyz/#buy=123&c=1&s=tg_rule'&&kb[1][0].callback_data==='ck:1:123'&&/^mu:\d+$/.test(kb[1][1].callback_data),'rule alert buttons: Buy, Check, Mute');
  const rid=Number(kb[1][1].callback_data.slice(3)),cq=d=>({id:'q',data:d,from:{id:40},message:{chat:{id:40,type:'private'},message_id:7}});
  await B.onCb(cq('mu:'+rid));ok(R1.rl.find(r=>r.id===rid).mu>Date.now(),'Mute button pauses the rule 24 h');ok(await B.ruleFan(info({id:'190',dkey:'m1'}))===0,'muted rule: no alert');R1.rl.find(r=>r.id===rid).mu=0;
  sent.length=0;await B.onCb(cq('ck:1:123'));ok(sent.some(x=>String(x.chat_id)==='40'),'Check button runs /check');}
 const lk=((rt.match(/href="([^"]+)"/)||[])[1]||'').replace(/&amp;/g,'&');ok(/^https:\/\/owlgate\.xyz\/#buy=123&c=1&s=tg_rule$/.test(lk),'deep link params: '+lk);
 ok(await B.ruleFan(info())===0,'rule deduped');ok(R1.dk.includes('bh:123:0.4'),'deal-alert key also marked (no double alert)');
 ok(await B.ruleFan(info({id:'124',px:.6,dkey:'z'}))===0,'price above rule max: no alert');ok(await B.ruleFan(info({id:'125',pb:70,dkey:'y'}))===0,'payback above rule: no alert');ok(await B.ruleFan(info({ci:0,id:'126',dkey:'w'}))===0,'other processor: no alert');
 R1.rl.push({id:9,cp:-1,pb:100,px:0,at:0});R1.dh=[];ok(await B.ruleFan(info({ci:0,id:'127',px:5,dkey:'v'}))===1,'"any" rule without price limit');
 R1.on=0;ok(await B.ruleFan(info({id:'128',dkey:'u'}))===0,'/off pauses rules');R1.on=1;
 R1.dh=[];let c=0;for(let i=0;i<7;i++)c+=await B.ruleFan(info({id:'2'+i,dkey:'q'+i}));ok(c===4,'rule alerts rate-limited 4 per hour (got '+c+')');
 R1.dh=[];await B.onMsg(msg('/lang zh',40));R1.dk=[];sent.length=0;await B.ruleFan(info({id:'300',dkey:'zz'}));ok(/你的狙击规则 #1 已匹配/.test(last(40))&&/小额测试/.test(last(40))&&/不持有你的私钥或资金/.test(last(40))&&!VI.test(last(40)),'rule alert ZH');
 await B.onMsg(msg('/rule list',40));ok(/规则|Behemoth/.test(last(40)),'rule list ZH works');
 // --- /snipe (s37): alias of /rule + min power, payback optional, filters in any order
 await B.onMsg(msg('/lang en',40));R1.rl=[];
 await B.onMsg(msg('/snipe add any p100',40));ok(R1.rl.length===1&&R1.rl[0].cp===-1&&R1.rl[0].pw===100&&!R1.rl[0].pb&&!R1.rl[0].px&&/power ≥ <b>100<\/b>/.test(last(40)),'snipe: power only');
 await B.onMsg(msg('/snipe add tapeout 0.05',40));ok(R1.rl[1]&&R1.rl[1].px===.05&&!R1.rl[1].pb,'snipe: price only (decimal)');
 await B.onMsg(msg('/snipe add behemoth p50 1bnb 90d',40));ok(R1.rl[2]&&R1.rl[2].pw===50&&R1.rl[2].px===1&&R1.rl[2].pb===90,'snipe: any order, 1bnb, 90d');
 const nb=R1.rl.length;for(const bad of ['/snipe add any','/snipe add any p0','/snipe add any p10 p20','/snipe add any 60 70','/snipe add any 0.1 0.2','/snipe add any 2000d','/snipe add any p10 60 0.5 9','/snipe add any 0bnb'])await B.onMsg(msg(bad,40));
 ok(R1.rl.length===nb&&/at least one/.test(last(40)),'snipe: bad inputs rejected');
 await B.onMsg(msg('/snipe list',40));ok(/any · power ≥ 100/.test(last(40))&&/Behemoth · payback ≤ 90 days · price ≤ 1 BNB · power ≥ 50/.test(last(40)),'snipe list shows filters');
 R1.dh=[];R1.dk=[];sent.length=0;
 ok(await B.ruleFan(info({ci:0,id:'401',px:9,pb:900,w:150,dkey:'s1'}))===1&&/snipe #1 matched/.test(last(40))&&/power 150/.test(last(40)),'snipe: power 150 ≥ 100 matches, no payback limit');
 ok(await B.ruleFan(info({ci:0,id:'402',px:9,pb:900,w:99,dkey:'s2'}))===0,'snipe: power 99 < 100 no match');
 ok(await B.ruleFan(info({ci:1,id:'403',px:.9,pb:80,w:60,dkey:'s3'}))===1&&/snipe #3 matched/.test(last(40)),'snipe: all three filters match');
 ok(await B.ruleFan(info({ci:1,id:'404',px:.9,pb:80,w:40,dkey:'s4'}))===0,'snipe: power below rule 3, price above rule 2 (Behemoth): none');
 await B.onMsg(msg('/snipe del all',40));ok(R1.rl.length===0,'snipe del all');
 // --- E2: /snipe xl (X Layer voucher listings from /xl/market)
 await B.onMsg(msg('/snipe',40));ok(/\/snipe xl 60 2 p50/.test(last(40)),'snipe usage shows xl');
 await B.onMsg(msg('/snipe xl 60 2okb p50',40));ok(R1.rl.length===1&&R1.rl[0].xl===1&&R1.rl[0].pb===60&&R1.rl[0].px===2&&R1.rl[0].pw===50&&/X Layer/.test(last(40))&&/2<\/b> OKB/.test(last(40)),'snipe xl saved (OKB)');
 for(const bad of ['/snipe xl','/snipe xl 2bnb','/snipe xl p0','/snipe xl 60 2 3','/snipe xl 60 0','/snipe xl 1 2 p3 4'])await B.onMsg(msg(bad,40));ok(R1.rl.length===1&&/snipe xl/.test(last(40)),'snipe xl bad inputs rejected');
 await B.onMsg(msg('/snipe xl 60 2 p50',40));ok(R1.rl.length===2&&R1.rl[1].pb===60&&R1.rl[1].px===2&&R1.rl[1].pw===50,'snipe xl 60 2 p50 (usage example): 2nd integer = OKB price');
 await B.onMsg(msg('/snipe xl p50 3',40));ok(R1.rl.length===3&&R1.rl[2].pb===3&&!R1.rl[2].px,'snipe xl: a single integer stays payback days');R1.rl.splice(1);
 await B.onMsg(msg('/snipe add any 0.5',40));await B.onMsg(msg('/snipe list',40));ok(/X Layer · payback ≤ 60 days · price ≤ 2 OKB · power ≥ 50/.test(last(40)),'snipe list shows xl rule');
 R1.dh=[];R1.dk=[];sent.length=0;
 ok(await B.ruleFan(info({ci:1,id:'410',px:.1,pb:10,w:500,dkey:'x0'}))===1&&/#2 matched/.test(last(40)),'BNB listing never matches an xl rule');
 const xv=(h,o={})=>({voucher:7,rig:{chain:56,cpu:BH,id:321,power:80,mining:true},bemPerDay:4.5,paybackDays:30,ask:{hash:h,priceOkb:1.5},...o});
 cfg.xm={ok:true,prices:{okbUsd:50},vouchers:[xv('0xa1')]};delete S.xa;R1.dh=[];sent.length=0;
 ok(await B.xlTick()===0&&S.xa.includes('0xa1')&&!to(40).length,'xl first read seeds, no alert');
 cfg.xm.vouchers.push(xv('0xa2',{voucher:8}),xv('0xa3',{voucher:9,ask:{hash:'0xa3',priceOkb:3}}),xv('0xa4',{voucher:10,paybackDays:null,ask:{hash:'0xa4',priceOkb:1}}),xv('0xa5',{voucher:11,rig:{cpu:TO,id:5,power:40},ask:{hash:'0xa5',priceOkb:1}}),{voucher:12,rig:{cpu:TO,id:6,power:90},ask:null});
 ok(await B.xlTick()===1,'xl: only the new matching ask alerts (price, null payback, power filtered)');const xt=last(40);
 ok(/\(X Layer\)/.test(xt)&&/Voucher #8/.test(xt)&&/Behemoth rig #321/.test(xt)&&/1\.5 OKB<\/b> \(\$75\)/.test(xt)&&/30 days/.test(xt)&&/seller pays the OwlGate fee/.test(xt)&&/never holds your keys or funds/.test(xt)&&/not advice/.test(xt)&&!BAN.test(xt),'xl alert text');
 ok(((xt.match(/href="([^"]+)"/)||[])[1]||'').startsWith('https://owlgate.xyz/xl#buy='),'xl alert links owlgate.xyz/xl#buy=<voucher>');
 {const kb=(to(40).slice(-1)[0]||{}).reply_markup;ok(kb&&/^https:\/\/owlgate\.xyz\/xl#buy=\d+$/.test(kb.inline_keyboard[0][0].url)&&kb.inline_keyboard[1].some(b=>/^mu:\d+$/.test(b.callback_data)),'xl alert buttons: Buy url + Mute')}
 ok(await B.xlTick()===0,'xl: same ask not alerted twice');
 cfg.xm=null;ok(await B.xlTick()===0,'xl: API down -> no crash');
 await B.onMsg(msg('/lang zh',40));cfg.xm={ok:true,prices:{},vouchers:[xv('0xb1',{voucher:13})]};R1.dh=[];await B.xlTick();ok(/X Layer/.test(last(40))&&/凭证 #13/.test(last(40))&&/手续费由卖家支付/.test(last(40))&&!/\$/.test(last(40).split('OKB')[1].slice(0,4)),'xl alert ZH, no USD when OKB price missing');
 // step 2.1: public channel "New on OwlGate" (OG_CHANNEL)
 {const ch=()=>sent.filter(x=>x.chat_id==='@ogtest');cfg.xm.vouchers.push(xv('0xc1',{voucher:14}),xv('0xc2',{voucher:15,rig:{cpu:TO,id:9,power:40,mining:false},ask:{hash:'0xc2',priceOkb:1}}));
  await B.xlTick();ok(!ch().length,'channel off when OG_CHANNEL unset');cfg.xm.vouchers.push(xv('0xc3',{voucher:16}),xv('0xc4',{voucher:17,rig:{cpu:TO,id:9,power:40,mining:false},ask:{hash:'0xc4',priceOkb:1}}));
  process.env.OG_CHANNEL='@ogtest';await B.xlTick();const c=ch();ok(c.length===1&&/New on OwlGate<\/b> · X Layer/.test(c[0].text)&&/Voucher #16 · Behemoth rig #321/.test(c[0].text)&&/1\.5 OKB<\/b>/.test(c[0].text)&&/30 days/.test(c[0].text)&&!BAN.test(c[0].text),'channel: new mining ask posted, non-mining skipped');
  ok(c[0].reply_markup.inline_keyboard[0][0].url==='https://owlgate.xyz/xl#buy=16&s=tg_ch','channel Buy button, slug tg_ch');
  await B.xlTick();ok(ch().length===1,'channel: same ask not posted twice');
  S.ch=Array(12).fill(Date.now());ok(await B.chPost({net:'X',it:'a',px:'1',u:'',w:'1',pb:'1',d:'1'},'https://owlgate.xyz/')===false&&ch().length===1,'channel: 12 per hour cap');
  S.ch=[];ok(await B.chPost({net:'BNB Chain',it:'TapeOut #5',px:'0.1 BNB',u:' ($60)',w:'50',pb:'40 days',d:'2'},'https://owlgate.xyz/#buy=5&c=0&s=tg_ch')===true&&/BNB Chain\nTapeOut #5 · <b>0\.1 BNB<\/b> \(\$60\)/.test(ch()[1].text),'channel BNB format');
  {const TC='0x0e91460d6823c711643e650a9a4c0cc21de41614',it=(h,k,o={})=>({hash:'0x'+h.repeat(64),status:'open',cp:TC,kind:k,tid:k==='coll'?'0':'2833',price:'900000000000000000',chain:196,...o});
   S.ch=[];delete S.tc;cfg.b196=[it('1','list')];const n0=ch().length;await B.tcTick();ok(ch().length===n0,'TC: first read seeds, no post');
   cfg.b196.push(it('2','list'),it('3','coll'),it('4','list',{cp:'0x9cfc959cd42b2e1d39a0d850c528210e818ae520'}),it('5','list',{status:'filled'}));ok(await B.tcTick()===2,'TC: 2 new open TC orders posted, voucher / filled ignored');
   const c2=ch().slice(n0);ok(/TapeCode-Test1 #2833 listed · <b>0\.9 OKB/.test(c2[0].text)&&c2[0].reply_markup.inline_keyboard[0][0].url==='https://owlgate.xyz/xl?s=tg_ch#xc'&&!BAN.test(c2[0].text),'TC listing post + link');
   ok(/Offer on any TapeCode-Test1 · <b>0\.9 WOKB/.test(c2[1].text)&&c2[1].reply_markup.inline_keyboard[0][0].text==='Sell on OwlGate','TC collection offer post');
   ok(await B.tcTick()===0,'TC: not posted twice');cfg.b196=[]}
  delete process.env.OG_CHANNEL}
 await B.onMsg(msg('/lang en',40));await B.onMsg(msg('/snipe del all',40));
 ok(/rules: created 7 /.test(await B.ruleStats())||/rules: created \d+/.test(await B.ruleStats()),'rule metrics');const rs=await B.ruleStats();ok(/link opens 7/.test(rs)&&/buy txs sent 1/.test(rs)&&/alerts sent \d+/.test(rs),'rule metrics + funnel: '+rs.replace(/\n/g,' | '));

 // --- D56: welcome, /listings, wallet-proof trial (keccak + ecrecover checked against ethers)
 const { ethers } = require('./node_modules/ethers');
 for (const n of [0, 1, 55, 135, 136, 137, 272, 500]) { const b = Buffer.alloc(n, n % 251); ok('0x' + B.keccak256(b).toString('hex') === ethers.keccak256(b), 'keccak256 len ' + n); }
 const wl = Array.from({ length: 4 }, () => ethers.Wallet.createRandom());
 for (const w of wl) { const m = 'hello ' + w.address; ok(B.recoverPS(m, await w.signMessage(m)) === w.address.toLowerCase(), 'ecrecover matches ethers ' + w.address.slice(0, 8)); }
 ok(B.recoverPS('x', '0x' + '00'.repeat(65)) === null && B.recoverPS('x', 'nope') === null && B.recoverPS('x', '0x' + 'ff'.repeat(65)) === null, 'garbage signatures -> null');
 const sg = await wl[0].signMessage('abc'); ok(B.recoverPS('abd', sg) !== wl[0].address.toLowerCase(), 'signature over another text -> another address');
 const LK = id => { const m = last(id).match(/#v=([0-9a-f]{24})&amp;t=(\d+)&amp;x=(\d+)/); return m && { n: m[1], t: m[2], x: Number(m[3]) }; };
 // welcome
 sent.length = 0; await B.onMsg(msg('/start', 60)); const w1 = last(60), U60 = S.u['60'];
 ok(/Check a rig\./.test(w1) && /owlgate\.xyz/.test(w1) && /\/check 17628/.test(w1) && /\/watch 0x/.test(w1) && /\/snipe add/.test(w1) && /24 h free trial/.test(w1) && /\/trial/.test(w1) && /\/pay/.test(w1) && /\/help/.test(w1) && /Not financial advice/.test(w1) && !/\/feedback/.test(w1), 'welcome EN: what/where/3 commands/trial/help/disclaimer, no feedback line for a normal start');
 ok(w1.split('\n').filter(x => x.trim()).length <= 10, 'welcome is short');
 ok(U60.exp === 0 && U60.trial === 1, 'new user: no trial until wallet proof');
 sent.length = 0; await B.onMsg(msg('/start kol_tester', 61)); ok(/\/feedback/.test(last(61)) && /4 short questions/.test(last(61)) && S.u['61'].src === 'kol_tester', 'kol_tester start: feedback invite');
 await B.onMsg(msg('/start kol_abc', 62)); ok(/\/feedback/.test(last(62)), 'any kol_ slug');
 await B.onMsg(msg('/start x_other', 63)); ok(!/\/feedback/.test(last(63)), 'other slug: no feedback line');
 await B.onMsg(msg('/start kol_tester', 64, 'zh')); const wz = last(64); ok(/查询矿机/.test(wz) && /\/feedback/.test(wz) && /24 小时/.test(wz) && /不构成投资建议/.test(wz) && !VI.test(wz), 'welcome ZH + feedback invite');
 await B.onMsg(msg('/help', 60)); ok(/\/check 17628/.test(last(60)) && /\/listings/.test(last(60)) && /\/trial/.test(last(60)) && /\/payback/.test(last(60)) && /\/burn/.test(last(60)), 'help: /check /listings /trial and the old commands');
 sent.length = 0; await B.gMsg(msg('/listings', 60)); ok(/OwlGate \/check/.test(last(60)), '/listings in private = bare /check overview');
 await B.onMsg(msg('/watch ' + wl[1].address, 60)); ok(U60.exp === 0, '/watch of any address does not start a trial');
 // trial flow
 await B.onMsg(msg('/trial', 60)); const L1 = LK(60); ok(L1 && L1.t === '60' && L1.x * 1000 > Date.now() + 14 * 60000 && L1.x * 1000 <= Date.now() + 15 * 60000 + 1000 && /15 min/.test(last(60)), 'trial link: nonce, tg id, 15 min expiry');
 const sign = (w, L, wallet = w.address.toLowerCase(), id = L.t) => w.signMessage(B.trialMsg(wallet, id, L.n, L.x));
 await B.onMsg(msg('/verify', 60)); ok(/Usage: \/verify/.test(last(60)), 'verify usage');
 const bad = await sign(wl[2], L1, wl[0].address.toLowerCase()); await B.onMsg(msg('/verify ' + wl[0].address + ' ' + bad, 60)); ok(/does not match/.test(last(60)) && U60.exp === 0, 'signature by another wallet rejected');
 const wrongMsg = await wl[0].signMessage(B.trialMsg(wl[0].address.toLowerCase(), '999', L1.n, L1.x)); await B.onMsg(msg('/verify ' + wl[0].address + ' ' + wrongMsg, 60)); ok(/does not match/.test(last(60)) && U60.exp === 0, 'signature for another telegram id rejected');
 const good = await sign(wl[0], L1); const tv0 = Date.now(); await B.onMsg(msg('/verify ' + wl[0].address + ' ' + good, 60));
 ok(/24 h trial/.test(last(60)) && U60.wv === wl[0].address.toLowerCase() && Math.abs(U60.exp - tv0 - 864e5) < 5000 && U60.trial === 1 && B.S.tw[wl[0].address.toLowerCase()].id === '60', 'valid signature: 24 h trial starts, wallet bound');
 await B.onMsg(msg('/verify ' + wl[0].address + ' ' + good, 60)); ok(/No open verification/.test(last(60)), 'replayed signature / used nonce rejected');
 const e1 = U60.exp; await B.onMsg(msg('/trial', 60)); ok(/already active/.test(last(60)) && U60.exp === e1, '/trial again while active: unchanged');
 // second Telegram account, same wallet
 await B.onMsg(msg('/start', 70)); await B.onMsg(msg('/trial', 70)); const L2 = LK(70);
 await B.onMsg(msg('/verify ' + wl[0].address + ' ' + await sign(wl[0], L2), 70)); ok(/already used its free trial/.test(last(70)) && S.u['70'].exp === 0 && !S.u['70'].wv, 'second Telegram account, same wallet: no trial');
 // expired nonce, try limit, fresh wallet
 await B.onMsg(msg('/trial', 70)); const L3 = LK(70); B.S.vn[L3.n].x = Math.floor(Date.now() / 1000) - 30;
 await B.onMsg(msg('/verify ' + wl[3].address + ' ' + await sign(wl[3], { ...L3, x: B.S.vn[L3.n].x }), 70)); ok(/expired/.test(last(70)) && S.u['70'].exp === 0, 'expired nonce rejected');
 await B.onMsg(msg('/trial', 70)); const L4 = LK(70);
 for (let i = 0; i < 5; i++) { S.u['70'].vv = []; await B.onMsg(msg('/verify ' + wl[3].address + ' ' + bad, 70)); } S.u['70'].vv = []; await B.onMsg(msg('/verify ' + wl[3].address + ' ' + await sign(wl[3], L4), 70));
 ok(/No open verification/.test(last(70)) && S.u['70'].exp === 0, '5 wrong signatures burn the nonce');
 S.u['70'].vl = []; await B.onMsg(msg('/trial', 70)); const L5 = LK(70);
 await B.onMsg(msg('/verify ' + wl[3].address + ' ' + await sign(wl[3], L5), 70)); ok(S.u['70'].exp > Date.now() && S.u['70'].wv === wl[3].address.toLowerCase(), 'fresh wallet on another account: trial starts');
 await B.onMsg(msg('/trial', 70)); ok(/already active|already used/.test(last(70)), 'second trial for the same account refused');
 let rl = 0; await B.onMsg(msg('/start', 80)); for (let i = 0; i < 7; i++) { await B.onMsg(msg('/trial', 80)); if (/Too many tries/.test(last(80))) rl++; } ok(rl >= 2, '/trial is rate-limited (5 per hour)');
 // legacy trial keeps its expiry
 await B.onMsg(msg('/start', 90)); const U90 = S.u['90']; U90.exp = Date.now() + 5 * 864e5; const keep = U90.exp; await B.onMsg(msg('/trial', 90)); const L6 = LK(90), w9 = ethers.Wallet.createRandom();
 await B.onMsg(msg('/verify ' + w9.address + ' ' + await sign(w9, L6), 90)); ok(U90.exp === keep && /unchanged/.test(last(90)) && U90.wv, 'existing trial user keeps the current expiry');
 // 24 h trial reminder only in the last 3 hours; unstarted users get no "ended" message
 sent.length = 0; U60.warn = 0; U60.exp = Date.now() + 20 * 36e5; await B.reminders(); ok(!to(60).some(x => /trial ends/.test(x.text)), 'no reminder with 20 h left');
 U60.exp = Date.now() + 2 * 36e5; await B.reminders(); ok(to(60).some(x => /about 3 hours/.test(x.text)), 'reminder in the last 3 hours');
 ok(!to(61).length && !to(62).length, 'users without a started trial get no "ended" message');
 await B.onMsg(msg('/status', 63)); ok(/trial not started/.test(last(63)), '/status: trial not started');
 { const h = fs.readFileSync(path.join(__dirname, '../app/owlgate/index.html'), 'utf8'), i = h.indexOf("m='OwlGate trial verification"), j = h.indexOf(';', h.indexOf("replace('.000Z','Z')", i)), expr = h.slice(i + 2, j);
  const A = '0x' + 'ab'.repeat(20), tg = '123', v = 'a1'.repeat(12), x = '1790000000'; const siteMsg = new Function('A', 'tg', 'v', 'x', 'return ' + expr)(A, tg, v, x);
  ok(i > 0 && siteMsg === B.trialMsg(A, tg, v, 1790000000), 'site signs exactly the text the bot verifies'); }
 await B.onMsg(msg('/start trial', 95)); ok(/#v=[0-9a-f]{24}/.test(last(95)) && /Verify wallet/.test(last(95)), '/start trial (site button) shows the verify link');
 await B.onMsg(msg('/start rule', 96)); ok(/\/snipe add/.test(last(96)), '/start rule (site button) shows rule usage');
 // help mentions the new commands, EN + ZH only
 await B.onMsg(msg('/help',50));ok(/\/watch/.test(last(50))&&/\/snipe add/.test(last(50)),'help lists watch + rule');
 // offer above floor (watch holders): seed, new offer above mining floor, below floor, not owned, X Layer collection offer, mute
 {await B.onMsg(msg('/start',60));const U6=B.S.u['60'];for(const x of Object.values(B.S.u))if(x!==U6)x.w=[];U6.w=[{a:WA,c:Date.now()}];U6.dk=[];const W=e=>String(BigInt(Math.round(e*1e6))*10n**12n),
   bo=(h,tid,px,o={})=>({hash:'0x'+h.repeat(64).slice(0,64),status:'open',kind:'offer',chain:56,cp:TO,tid:String(tid),price:W(px),fee:W(px*.0075),end:Math.floor(Date.now()/1e3)+86400,...o});
  cfg.b56=[bo('1',1,.5)];cfg.b196=[];delete B.S.ob;ok(await B.offTick()===0,'offers: first read only seeds');
  cfg.b56.push(bo('2',1,.01));sent.length=0;const r2=await B.offTick();ok(r2===1,'offer above mining floor on a held rig: alert');const om=to(60).slice(-1)[0]||{};
  ok(/Offer above floor on your rig/.test(om.text)&&/TapeOut #1/.test(om.text)&&/0\.0099/.test(om.text)&&/0\.0001 BNB/.test(om.text)&&/not advice/.test(om.text),'offer alert text: net after fee, floor, no advice');
  {const kb=om.reply_markup.inline_keyboard;ok(kb[0][0].url==='https://owlgate.xyz/portfolio'&&kb[1][0].callback_data==='ck:0:1'&&kb[1][1].callback_data==='om','offer alert buttons: Sell to offer, Check, Mute')}
  ok(await B.offTick()===0,'same offer not alerted twice');
  cfg.b56.push(bo('3',1,.00005),bo('4',99,.5));ok(await B.offTick()===0,'below floor or not my rig: no alert');
  cfg.b196=[bo('5',0,2,{chain:196,kind:'coll',cp:'0x9cfc959cd42b2e1d39a0d850c528210e818ae520'})];
  cfg.xm={ok:true,vouchers:[{voucher:5,holder:WA,rig:{cpu:TO,id:12,mining:true},bemPerDay:1,ask:null},{voucher:6,holder:WB,rig:{cpu:TO,id:13,mining:true},ask:{priceOkb:'1'}}]};
  ok(await B.offTick()===1&&/any voucher \(#5\)/.test(last(60))&&/listing\): 1 OKB/.test(last(60))&&/1\.985 OKB/.test(last(60)),'X Layer collection offer above voucher floor: alert');
  await B.onCb({id:'q',data:'om',from:{id:60},message:{chat:{id:60,type:'private'},message_id:3}});ok(U6.om>Date.now(),'Mute button mutes offer alerts 24 h');
  cfg.b56.push(bo('6',2,.5));ok(await B.offTick()===0,'muted: no offer alert');cfg.xm=null}
 // step 2.2: seller tips (other users' snipe rules -> /watch holder)
 {const U=S.u['10'],OM=Object.entries(S.u).filter(([k])=>k!=='10').map(([k,x])=>[x,x.sm]);for(const[x]of OM)x.sm=Date.now()+1e9;U.w=[{a:WA}];U.on=1;U.blocked=0;U.lang='en';U.rl=[];delete U.sa;delete U.sk;delete U.sm;
  R1.rl=[];await B.onMsg(msg('/snipe add tapeout 30',40));cfg.se=WA;B.resetTop();cfg.xm={ok:true,prices:{},vouchers:[]};sent.length=0;
  ok(await B.sellTick()===1&&/1 buyer on OwlGate is looking for a rig like yours/.test(last(10))&&/TapeOut #500 · 0\.004 BNB/.test(last(10))&&!BAN.test(last(10)),'seller tip BNB: '+last(10).split('\n')[0]);
  {const kb=to(10).slice(-1)[0].reply_markup.inline_keyboard;ok(kb[0][0].url==='https://owlgate.xyz/#buy=500&c=0&s=tg_sell'&&kb[1].some(b=>b.callback_data==='sm')&&kb[1].some(b=>b.callback_data==='ck:0:500'),'seller tip BNB buttons')}
  ok(await B.sellTick()===0,'seller tip: max 1 per 24 h');U.sa=0;ok(await B.sellTick()===0,'seller tip: same listing not repeated');
  await B.onMsg(msg('/snipe xl 60 2 p50',40));await B.onMsg(msg('/snipe xl p10',40));
  cfg.xm={ok:true,prices:{},vouchers:[{voucher:21,holder:WA,rig:{cpu:BH,id:77,power:80,mining:true},paybackDays:20,ask:null},{voucher:22,holder:WA,rig:{cpu:BH,id:78,power:80,mining:false},paybackDays:20,ask:null}]};U.sa=0;
  ok(await B.sellTick()===1&&/2 buyers on OwlGate are looking for a voucher like yours/.test(last(10))&&/Voucher #21 · Behemoth rig #77/.test(last(10))&&/no limit/.test(last(10))&&!BAN.test(last(10)),'seller tip XL (rule without price -> no limit)');
  {const kb=to(10).slice(-1)[0].reply_markup.inline_keyboard;ok(kb[0][0].url==='https://owlgate.xyz/xl'&&kb[1].some(b=>b.callback_data==='ck:1:77'),'XL tip: List on OwlGate + Check')}
  U.sa=0;ok(await B.sellTick()===0,'XL: non-mining voucher never tipped, #21 not repeated');
  R1.rl=[];U.rl=[{id:1,cp:-1,pb:999,xl:1,at:0}];cfg.xm.vouchers.push({voucher:23,holder:WA,rig:{cpu:BH,id:79,power:80,mining:true},paybackDays:20,ask:null});U.sa=0;
  ok(await B.sellTick()===0,'own rules never count as buyers');U.rl=[];
  await B.onMsg(msg('/snipe xl 60 2 p50',40));U.lang='zh';U.sa=0;ok(await B.sellTick()===1&&/1 位买家在找类似你的凭证/.test(last(10))&&/2 OKB/.test(last(10)),'seller tip XL ZH, max price shown');U.lang='en';
  await B.onCb({id:'q1',data:'sm',message:{chat:{id:10,type:'private'},message_id:1},from:{id:10}});ok(U.sm>Date.now()+6*864e5,'Mute 7 d');
  cfg.xm.vouchers.push({voucher:24,holder:WA,rig:{cpu:BH,id:80,power:80,mining:true},paybackDays:20,ask:null});U.sa=0;ok(await B.sellTick()===0,'muted: no tip');
  cfg.se=undefined;cfg.xm=null;R1.rl=[];delete U.sm;for(const[x,v]of OM)if(v==null)delete x.sm;else x.sm=v}
 for(const l of['en','zh'])for(const k of Object.keys(B.WT[l]))ok(!VI.test(B.WT[l][k]),'no Vietnamese in WT.'+l+'.'+k);
 ok(Object.keys(B.WT.en).length===Object.keys(B.WT.zh).length,'EN and ZH have the same keys');
 try{fs.unlinkSync(DBF)}catch(e){}
 console.log(`bot-watch: ${pass} passed, ${fail} failed`);process.exit(fail?1:0)})().catch(e=>{console.error(e);process.exit(1)});
