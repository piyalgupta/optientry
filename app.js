'use strict';
// ── CURRENCY ──────────────────────────────────────────────
const SYM={USD:'$',INR:'₹',JPY:'¥',EUR:'€',GBP:'£',CNY:'¥',HKD:'HK$',KRW:'₩',CAD:'CA$',AUD:'A$',SGD:'S$',CHF:'CHF ',TWD:'NT$',BRL:'R$',MXN:'MX$',NOK:'kr ',SEK:'kr ',DKK:'kr ',ZAR:'R ',TRY:'₺',SAR:'SR ',AED:'AED ',THB:'฿',IDR:'Rp ',MYR:'RM '};
const NO_DEC=['JPY','KRW','IDR'];
// Single source of truth for how many decimals a currency shows — shared by
// fmt() and the Chart.js tick/tooltip callbacks so they can never disagree.
const decFor=cur=>NO_DEC.includes(cur)?0:2;
function fmt(val,cur){
  if(val==null||isNaN(val))return'—';
  const s=SYM[cur]||(cur+' ');
  const d=decFor(cur);
  return s+val.toLocaleString('en',{minimumFractionDigits:d,maximumFractionDigits:d});
}

// ── FETCH LAYER ───────────────────────────────────────────
const SESSION=new Map();          // key → {data, ts}
const CACHE_TTL=5*60*1000;        // 5 min — a timing tool shouldn't serve all-session-stale prices
let currentAC=null;               // AbortController of the in-flight analysis (superseded → aborted)
const SUPA='https://brysartqcjylgqwmnjkk.supabase.co/functions/v1/yahoo';
const SUPA_KEY='eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJyeXNhcnRxY2p5bGdxd21uamtrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYzMjgyNzMsImV4cCI6MjA5MTkwNDI3M30.CanSxg9nrotjPuoFnGUaU6WMOxLovAtzNONS_JJ1WVY';
const ROUTES=[
  // Primary route: our own Supabase edge proxy. It fetches Yahoo server-side
  // (no browser CORS) on reliable infra, replacing dependence on flaky public
  // CORS proxies — the real cause of the "couldn't reach the market-data
  // service" error. The public proxies below stay as extra fallbacks.
  (u,o)=>fetch(`${SUPA}?url=${encodeURIComponent(u)}&apikey=${SUPA_KEY}`,o),
  (u,o)=>fetch(u,o),
  (u,o)=>fetch(`https://corsproxy.io/?url=${encodeURIComponent(u)}`,o),
  (u,o)=>fetch(`https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,o),
  (u,o)=>fetch(`https://thingproxy.freeboard.io/fetch/${u}`,o),
  (u,o)=>fetch(`https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(u)}`,o),
];
const T=9000;

async function fetchYahoo(path,detailEl,parentSignal){
  if(detailEl)detailEl.textContent='Fetching via fastest available route…';
  const urls=[`https://query1.finance.yahoo.com${path}`,`https://query2.finance.yahoo.com${path}`];
  const all=urls.flatMap(u=>ROUTES.map(fn=>{
    const ctrl=new AbortController();
    const tid=setTimeout(()=>ctrl.abort(),T);
    // Abort this route when the per-request timeout fires OR when a newer
    // analysis supersedes this one (parentSignal), so stale work stops promptly.
    if(parentSignal){parentSignal.aborted?ctrl.abort():parentSignal.addEventListener('abort',()=>ctrl.abort(),{once:true});}
    // Pass the abort signal into the actual fetch so the timeout truly cancels
    // a hung request; clear the timer on every outcome so it can't leak/fire late.
    return fn(u,{cache:'no-store',signal:ctrl.signal})
      .then(r=>{if(!r.ok)throw new Error('route '+r.status);return r.json();})
      .finally(()=>clearTimeout(tid));
  }));
  return new Promise((res,rej)=>{
    let failed=0,done=false;
    all.forEach(p=>p.then(d=>{if(!done){done=true;res(d);}}).catch(()=>{if(++failed===all.length)rej(new Error("Couldn't reach market data. Check your connection or try again."));}));
  });
}

async function search(q){
  const d=await fetchYahoo(`/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=8&newsCount=0&enableFuzzyQuery=true`);
  return(d.quotes||[]).filter(s=>s.symbol&&s.exchange).map(s=>({symbol:s.symbol,name:s.longname||s.shortname||s.symbol,exchange:s.exchange}));
}

async function history(symbol,detailEl,signal){
  const key=symbol.toUpperCase();
  const hit=SESSION.get(key);
  if(hit&&Date.now()-hit.ts<CACHE_TTL){
    if(detailEl){detailEl.textContent='Loaded from cache ✓';setTimeout(()=>{if(detailEl)detailEl.textContent='';},800);}
    return hit.data;
  }
  const end=Math.floor(Date.now()/1000),start=end-190*86400;
  const paths=[
    `/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${start}&period2=${end}&interval=1d&includePrePost=false`,
    `/v8/finance/chart/${encodeURIComponent(symbol)}?range=6mo&interval=1d`,
    `/v7/finance/chart/${encodeURIComponent(symbol)}?range=6mo&interval=1d`,
  ];
  // `reached` flips true the moment ANY path/route returns a parseable response,
  // even one without chart data. That lets us tell two very different failures
  // apart below: a transport outage (every proxy/route rejected → reached stays
  // false) vs. a genuinely empty/invalid ticker (we got responses, just no
  // series). Previously both collapsed into "check the ticker", which wrongly
  // blamed the user's input during a proxy/network outage.
  let d,reached=false;
  for(const path of paths){
    try{d=await fetchYahoo(path,detailEl,signal);reached=true;if(d?.chart?.result?.[0])break;}
    catch{/* this path's routes all failed; try the next path */}
  }
  const r=d?.chart?.result?.[0];
  if(!r){
    if(!reached)throw new Error("Couldn't reach the market-data service — this is usually a temporary network or proxy issue, not a problem with the ticker. Please try again in a moment.");
    throw new Error(`No price data returned for "${symbol}". Double-check the symbol — it may be delisted, an index, or not traded on a supported exchange.`);
  }
  const currency=r.meta?.currency||'USD';
  const timestamp=r.timestamp;
  const q=r.indicators?.quote?.[0];
  if(!Array.isArray(timestamp)||!q||!Array.isArray(q.close)){
    throw new Error(`No price history for "${symbol}". It may be delisted, an index, or not actively traded.`);
  }
  const closes=[],highs=[],lows=[],labels=[],volumes=[];
  for(let i=0;i<timestamp.length;i++){
    const c=q.close[i],h=q.high[i],l=q.low[i],v=q.volume?.[i];
    if(c!=null&&!isNaN(c)){
      closes.push(+c);highs.push(h!=null?+h:+c);lows.push(l!=null?+l:+c);
      volumes.push(v!=null&&!isNaN(v)?+v:0);
      labels.push(new Date(timestamp[i]*1e3).toLocaleDateString('en',{month:'short',day:'numeric'}));
    }
  }
  if(closes.length<20)throw new Error('Not enough data (need at least 20 trading days).');
  const result={closes,highs,lows,labels,volumes,currency};
  SESSION.set(key,{data:result,ts:Date.now()});
  if(detailEl)detailEl.textContent='';
  return result;
}

// ── MATH ──────────────────────────────────────────────────
function calcRSI(p,n=14){
  if(p.length<n+1)return p.map(()=>50);
  let ag=0,al=0;
  for(let i=1;i<=n;i++){const d=p[i]-p[i-1];d>=0?ag+=d:al+=(-d);}
  ag/=n;al/=n;
  const out=p.map(()=>50);
  out[n]=100-100/(1+ag/(al||0.001));
  for(let i=n+1;i<p.length;i++){
    const d=p[i]-p[i-1];
    ag=(ag*(n-1)+(d>0?d:0))/n;
    al=(al*(n-1)+(d<0?-d:0))/n;
    out[i]=100-100/(1+ag/(al||0.001));
  }
  return out;
}

function calcSMA(p,n){
  // Rolling sum: O(n) instead of O(n·window). Same windows, same null warmup.
  const out=new Array(p.length).fill(null);
  let sum=0;
  for(let i=0;i<p.length;i++){
    sum+=p[i];
    if(i>=n)sum-=p[i-n];
    if(i>=n-1)out[i]=sum/n;
  }
  return out;
}

function calcEMA(p,n){
  const k=2/(n+1);const out=[p[0]];
  for(let i=1;i<p.length;i++)out.push(p[i]*k+out[i-1]*(1-k));
  return out;
}

function calcMACD(p){
  if(p.length<35)return null;
  const e12=calcEMA(p,12),e26=calcEMA(p,26);
  const ml=e12.map((v,i)=>v-e26[i]);
  const sig=calcEMA(ml.slice(25),9);
  const macd=ml[ml.length-1],s=sig[sig.length-1];
  const pMacd=ml[ml.length-2],pSig=sig[sig.length-2];
  const bullish=macd>s;
  const cross=(bullish&&pMacd<=pSig)?'bullish':(!bullish&&pMacd>=pSig)?'bearish':null;
  return{macd,signal:s,histogram:macd-s,bullish,cross};
}

function calcBB(p,n=20,m=2){
  const sma=calcSMA(p,n);
  const upper=[],lower=[];
  for(let i=0;i<p.length;i++){
    if(sma[i]==null){upper.push(null);lower.push(null);continue;}
    const sl=p.slice(Math.max(0,i-n+1),i+1);
    const std=Math.sqrt(sl.reduce((a,v)=>a+(v-sma[i])**2,0)/sl.length);
    upper.push(sma[i]+m*std);lower.push(sma[i]-m*std);
  }
  const bbU=upper[upper.length-1],bbL=lower[lower.length-1];
  const bbPct=(bbU&&bbL&&bbU!==bbL)?Math.min(100,Math.max(0,(p[p.length-1]-bbL)/(bbU-bbL)*100)):50;
  return{upper,lower,middle:sma,bbU,bbL,bbPct};
}

function calcATR(hi,lo,cl,n=14){
  const tr=cl.map((_,i)=>i===0?hi[i]-lo[i]:Math.max(hi[i]-lo[i],Math.abs(hi[i]-cl[i-1]),Math.abs(lo[i]-cl[i-1])));
  const s=calcSMA(tr,n);
  const atr=s[s.length-1]??tr.slice(-n).reduce((a,b)=>a+b,0)/Math.min(n,tr.length);
  return{atr,atrPct:atr/cl[cl.length-1]*100};
}

function calcStoch(hi,lo,cl,k=14){
  if(cl.length<k)return 50;
  const rH=hi.slice(-k),rL=lo.slice(-k);
  const H=Math.max(...rH),L=Math.min(...rL);
  return H===L?50:(cl[cl.length-1]-L)/(H-L)*100;
}

function detectCross(s20,s50){
  for(let i=1;i<=6;i++){
    const c20=s20[s20.length-i],c50=s50[s50.length-i];
    const p20=s20[s20.length-i-1],p50=s50[s50.length-i-1];
    if(c20!=null&&c50!=null&&p20!=null&&p50!=null){
      if(c20>c50&&p20<=p50)return{type:'golden',days:i-1};
      if(c20<c50&&p20>=p50)return{type:'death',days:i-1};
    }
  }
  const m20=s20[s20.length-1],m50=s50[s50.length-1];
  return{type:m20!=null&&m50!=null?m20>m50?'above':'below':'unknown',days:null};
}

function calcStreak(cl){
  if(cl.length<2)return{count:1,dir:'flat'};
  const dir=cl[cl.length-1]>=cl[cl.length-2]?'up':'dn';
  let count=0;
  for(let i=cl.length-1;i>0;i--){
    if(dir==='up'?cl[i]>=cl[i-1]:cl[i]<=cl[i-1])count++;else break;
  }
  return{count,dir};
}

function bestTrade(cl,labels){
  if(cl.length<10)return null;
  let bi=-1,bp=0,bd=5;
  for(let i=0;i<cl.length-5;i++)
    for(let d=5;d<=20&&i+d<cl.length;d++){
      const p=(cl[i+d]-cl[i])/cl[i]*100;
      if(p>bp){bp=p;bi=i;bd=d;}
    }
  if(bi<0||bp<=0)return null;
  return{buyDate:labels[bi],buyPrice:cl[bi],sellDate:labels[bi+bd],sellPrice:cl[bi+bd],pct:bp.toFixed(1),days:bd};
}

function calcScore(rsi,a20,a50,macdBullish,bbPct,stoch,volSig,streakDir){
  let s=50;
  if(rsi<30)s+=18;else if(rsi<40)s+=10;else if(rsi<50)s+=4;else if(rsi>70)s-=18;else if(rsi>60)s-=8;
  if(a20)s+=10;else s-=7;
  if(a50)s+=8;else s-=5;
  if(macdBullish===true)s+=10;else if(macdBullish===false)s-=8;
  if(bbPct<25)s+=7;else if(bbPct>75)s-=7;
  if(stoch<25)s+=6;else if(stoch>75)s-=6;
  if(volSig>0)s+=5;else if(volSig<0)s-=4;
  if(streakDir==='up')s+=3;else if(streakDir==='dn')s-=3;
  return Math.min(100,Math.max(0,Math.round(s)));
}

// Percentage return over the last `k` bars (null until enough history exists).
// Replaces five hand-written ((cur-closes[n-1-k])/closes[n-1-k]*100) lines.
function retN(c,k){return c.length>k?((c[c.length-1]-c[c.length-1-k])/c[c.length-1-k]*100):null;}

// ── CHART ─────────────────────────────────────────────────
let ci=null;
let chartState=null;
function drawChart(labels,closes,s20,s50,bbU,bbL,currency){
  chartState={labels,closes,s20,s50,bbU,bbL,currency};
  // A chart failure must NEVER take down the whole analysis. drawChart() is the
  // last thing render() does, and render() runs inside analyse()'s try BEFORE
  // the result panel is revealed — so anything thrown here bubbles into the
  // catch and hides every number and the verdict, even though they all computed
  // fine. Chart.js loads from a third-party CDN with no SRI and no fallback, so
  // a blocked/slow CDN, an ad-blocker, or a Chart.js internal error on an odd
  // series is a realistic trigger. The chart is a nicety; the analysis is the
  // product. Guard the dependency and contain any render error.
  const canvas=document.getElementById('chart');
  if(typeof Chart==='undefined'||!canvas){
    if(ci){try{ci.destroy();}catch(_){}ci=null;}
    console.warn('Chart.js unavailable — showing analysis without the chart.');
    return;
  }
  try{
  if(ci){ci.destroy();ci=null;}
  const root=document.documentElement;
  const dark=root.getAttribute('data-theme')==='dark'||(root.getAttribute('data-theme')!=='light'&&window.matchMedia('(prefers-color-scheme:dark)').matches);
  const gc=dark?'rgba(255,255,255,0.04)':'rgba(0,0,0,0.04)';
  const tc=dark?'#555':'#999';
  const pc=dark?'#d0d0d0':'#1a1a1a';
  const mob=window.innerWidth<480;
  ci=new Chart(canvas.getContext('2d'),{
    type:'line',
    data:{labels,datasets:[
      {label:'BB Upper',data:bbU,borderColor:'rgba(0,184,201,0.45)',borderWidth:0.8,borderDash:[3,5],fill:false,pointRadius:0,tension:0.2},
      {label:'BB Lower',data:bbL,borderColor:'rgba(0,184,201,0.45)',borderWidth:0.8,borderDash:[3,5],fill:'-1',backgroundColor:dark?'rgba(0,240,255,0.03)':'rgba(0,184,201,0.04)',pointRadius:0,tension:0.2},
      {label:'Price',data:closes,borderColor:pc,borderWidth:2,fill:false,tension:0.1,pointRadius:0,order:0},
      {label:'20d avg',data:s20,borderColor:'#4ade80',borderWidth:1.2,borderDash:[5,4],fill:false,pointRadius:0},
      {label:'50d avg',data:s50,borderColor:'#60a5fa',borderWidth:1.2,borderDash:[2,5],fill:false,pointRadius:0},
    ]},
    options:{
      responsive:true,maintainAspectRatio:false,
      interaction:{mode:'index',intersect:false},
      plugins:{
        legend:{labels:{color:tc,font:{family:'Inter',size:mob?10:11},boxWidth:12,padding:mob?8:12,filter:i=>i.text!=='BB Lower'}},
        tooltip:{callbacks:{label:ctx=>{if(ctx.dataset.label==='BB Lower')return null;const d=decFor(currency);return` ${ctx.dataset.label}: ${SYM[currency]||''}${Number(ctx.parsed.y).toLocaleString('en',{maximumFractionDigits:d})}`;},itemSort:(a,b)=>a.datasetIndex===2?-1:1}}
      },
      scales:{
        y:{grid:{color:gc},border:{display:false},ticks:{color:tc,font:{size:mob?10:11},maxTicksLimit:mob?4:6,callback:v=>{const d=decFor(currency);return(SYM[currency]||'')+Number(v).toLocaleString('en',{maximumFractionDigits:d});}}},
        x:{grid:{display:false},border:{display:false},ticks:{color:tc,font:{size:mob?10:11},maxRotation:0,maxTicksLimit:mob?4:7}},
      }
    }
  });
  }catch(e){
    // Chart.js threw mid-render (bad data, context loss, version skew…). Tear
    // down any half-built instance and carry on — the analysis is already
    // computed and will still be shown by analyse().
    if(ci){try{ci.destroy();}catch(_){}ci=null;}
    console.error('Chart render failed — analysis still shown:',e);
  }
}

// ── HELPER: set card accent ───────────────────────────────
// Result-panel nodes are static (the script runs after them), so cache lookups
// instead of re-querying the DOM on every one of the ~60 setX calls per render.
const _elCache=new Map();
function el(id){if(!_elCache.has(id))_elCache.set(id,document.getElementById(id));return _elCache.get(id);}
function setAcc(id,col){const e=el(id);if(e)e.style.setProperty('--card-accent',col);}
function setTxt(id,txt){const e=el(id);if(e)e.textContent=txt;}
function setHTML(id,html){const e=el(id);if(e)e.innerHTML=html;}
// Render the verdict as a cascade of split-flap tiles ("flipclock"). Rebuilding
// the nodes restarts the CSS flip animation on every fresh analysis.
function flipVerdict(word){
  const w=el('bshWord');if(!w)return;
  w.textContent='';
  [...String(word)].forEach((ch,i)=>{
    const f=document.createElement('span');
    f.className='flap';f.style.setProperty('--i',i);
    const g=document.createElement('span');
    g.className='flap-glyph';g.textContent=ch;
    f.appendChild(g);w.appendChild(f);
  });
}
// HTML-escape untrusted strings (Yahoo search results) before injecting via
// innerHTML — keeps markup in a ticker symbol or company name from breaking the
// layout or injecting nodes. Output round-trips cleanly through dataset, whose
// reads decode the entities back to the original characters.
const _ESC={'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'};
function esc(s){return String(s).replace(/[&<>"']/g,c=>_ESC[c]);}
function setBar(id,pct,col){const e=el(id);if(e)e.style.cssText=`width:${pct}%;background:${col}`;}
// Threshold → status band, used to drive a card's accent colour, chip class and
// bar fill from ONE decision instead of three duplicated ternaries. 'pos' = good
// (green, value below `low`), 'neg' = bad (red, above `high`), else 'neu' (amber).
const BAND_COLOR={pos:'var(--green)',neg:'var(--red)',neu:'var(--amber)'};
const BAND_CHIP={pos:'c-g',neg:'c-r',neu:'c-a'};
function band(v,low,high){return v<low?'pos':v>high?'neg':'neu';}

// ── ANALYSE ───────────────────────────────────────────────
// Monotonic request counter. Every analyse() call claims the next number;
// only the call whose number still matches `reqSeq` when its data arrives is
// allowed to touch the DOM. This prevents an earlier-but-slower request
// (e.g. the auto-loaded NVDA) from overwriting the stock the user actually
// asked for last — the classic "I searched X but the page shows Y" bug.
let reqSeq=0;
async function analyse(symbol,dname){
  const myReq=++reqSeq;
  if(currentAC)currentAC.abort();          // cancel any still-in-flight previous analysis
  const ac=currentAC=new AbortController();
  const elLoad=document.getElementById('sLoad');
  const elDetail=document.getElementById('sLoadDetail');
  const elErr=document.getElementById('sErr');
  const elRes=document.getElementById('result');
  elErr.style.display='none';
  elRes.style.display='none';
  document.getElementById('btWrap').style.display='none';
  document.querySelectorAll('.hc-card.open').forEach(c=>c.classList.remove('open'));
  elLoad.style.display='block';
  elDetail.textContent='';

  try{
    const data=await history(symbol,elDetail,ac.signal);
    // Stale-response guard: a newer analyse() started while we were fetching,
    // so discard this result instead of rendering the wrong stock.
    if(myReq!==reqSeq)return;
    render(buildAnalysis(data,symbol,dname));
    elLoad.style.display='none';
    elRes.style.display='block';
  }catch(err){
    // Same guard: don't let a superseded request's failure clobber the
    // current result or re-show the error/loading state out of order.
    if(myReq!==reqSeq)return;
    elLoad.style.display='none';
    document.getElementById('sErr').textContent=err.message||'Something went wrong. Please try again.';
    document.getElementById('sErr').style.display='block';
  }
}

// ── VERDICT COPY ──────────────────────────────────────────
// The Buy/Hold/Sell call plus its plain-English rationale, isolated from the
// computation so the wording can be edited (or localised) without touching
// logic. Strings are the previous inline block verbatim.
// Score bands: at/above BUY → buy, at/below SELL → sell, between → hold. Shared
// by verdict() (the copy) and render() (the score-bar colour) so the words and
// the colour can never disagree about where the cut-offs are.
const VERDICT_BUY=62,VERDICT_SELL=38;
function verdict(sc,rsi,a20,a50,sup,currency){
  if(sc>=VERDICT_BUY)return{bsh:'BUY',bshCls:'buy',bshReason:rsi<40?`This stock is on sale. Fewer people are buying it than usual — historically, that's one of the best times to quietly enter. Score: ${sc}/100. Consider starting with a small amount.`
    :a20&&a50?`The stock is rising steadily above both its short and long-term averages — a healthy pattern. Momentum is on your side. Score: ${sc}/100. Small buys in tranches make sense.`
    :`Most signals favour buyers. Score: ${sc}/100. Conditions lean in your favour — not perfect, but a reasonable entry opportunity.`};
  if(sc<=VERDICT_SELL)return{bsh:'SELL',bshCls:'sell',bshReason:rsi>70?`This stock is overheated — too many people have already jumped in. When everyone is rushing to buy, a drop often follows. Score: ${sc}/100. If you own it, consider taking profits now.`
    :!a20&&!a50?`The price has fallen below both its short and long-term averages. Sellers are in control. Score: ${sc}/100. If you hold this stock, now may be the time to reduce your position.`
    :`Most signals point downward. Score: ${sc}/100. The odds don't favour buyers right now. Sit on the sidelines until conditions improve.`};
  return{bsh:'HOLD',bshCls:'hold',bshReason:`The signals are mixed — not clearly up or down. Score: ${sc}/100. If you already own this stock, hold and watch. If thinking of buying, wait for a clearer dip toward ${fmt(sup,currency)} before committing.`};
}

// Pure compute: market series → everything the view layer needs. Performs no
// DOM access, so it can be unit-tested in isolation. Returns a plain object
// whose keys match the names the renderer destructures below.
function buildAnalysis(series,symbol,dname){
    const{closes,highs,lows,labels,volumes,currency}=series;
    const n=closes.length;
    const cur=closes[n-1],prev=closes[n-2];
    const chg=(cur-prev)/prev*100;

    const rsiArr=calcRSI(closes),rsi=rsiArr[n-1];
    const s20a=calcSMA(closes,20),s50a=calcSMA(closes,50);
    const s20=s20a[n-1],s50=s50a[n-1];
    const a20=s20!=null&&cur>s20,a50=s50!=null&&cur>s50;
    const sup=Math.min(...lows.slice(-20)),res_=Math.max(...highs.slice(-20));
    const macd=calcMACD(closes);
    const bb=calcBB(closes);
    const{atr,atrPct}=calcATR(highs,lows,closes);
    const stoch=calcStoch(highs,lows,closes);
    const cross=detectCross(s20a,s50a);
    const streak=calcStreak(closes);
    const best=bestTrade(closes,labels);
    const lo52=Math.min(...lows),hi52=Math.max(...highs);
    const pos52=hi52===lo52?50:Math.min(100,Math.max(0,(cur-lo52)/(hi52-lo52)*100));

    const hasVol=volumes.some(v=>v>0);
    const avgVol20=hasVol?volumes.slice(-20).reduce((a,b)=>a+b,0)/20:0;
    const lastVol=volumes[n-1]||0;
    const volRatio=avgVol20>0?lastVol/avgVol20:1;
    const volSig=(volRatio>1.3&&a20)?1:(volRatio>1.3&&!a20)?-1:0;

    const ret1w=retN(closes,5),ret2w=retN(closes,10),ret1m=retN(closes,21),ret3m=retN(closes,63);
    const mom20=ret1m;// identical formula to the old 1-month return; computed once

    const sc=calcScore(rsi,a20,a50,macd?.bullish??null,bb.bbPct,stoch,volSig,streak.dir);
    const exp=res_>cur?((res_-cur)/cur*100).toFixed(1):'0';

    // ── BUY / SELL / HOLD ──────────────────────────────
    const bullArr=[(a20?1:0),(a50?1:0),(rsi<50?1:0),(mom20!==null&&mom20>0?1:0),(macd?.bullish?1:0),(stoch<50?1:0),(bb.bbPct<50?1:0),(volSig>=0?1:0)];
    const bullSigs=bullArr.reduce((a,b)=>a+b,0),total=8;
    const{bsh,bshCls,bshReason}=verdict(sc,rsi,a20,a50,sup,currency);

    return{closes,highs,lows,labels,volumes,currency,n,cur,prev,chg,rsi,s20a,s50a,s20,s50,a20,a50,sup,res_,macd,bb,atr,atrPct,stoch,cross,streak,best,lo52,hi52,pos52,hasVol,avgVol20,lastVol,volRatio,volSig,ret1w,ret2w,ret1m,ret3m,mom20,sc,exp,bullArr,bullSigs,total,bsh,bshCls,bshReason,symbol,dname};
}

// Pure DOM rendering of a built analysis — no math, no network. Destructures
// the exact same names buildAnalysis() returns, so the body below is unchanged.
function render(A){
    const{closes,highs,lows,labels,volumes,currency,n,cur,prev,chg,rsi,s20a,s50a,s20,s50,a20,a50,sup,res_,macd,bb,atr,atrPct,stoch,cross,streak,best,lo52,hi52,pos52,hasVol,avgVol20,lastVol,volRatio,volSig,ret1w,ret2w,ret1m,ret3m,mom20,sc,exp,bullArr,bullSigs,total,bsh,bshCls,bshReason,symbol,dname}=A;

    // Populate header
    setTxt('rSym',symbol);setTxt('rName',dname||symbol);
    setTxt('rPrice',fmt(cur,currency));
    const chgEl=document.getElementById('rChg');
    chgEl.textContent=`${chg>=0?'+':''}${chg.toFixed(2)}% today`;
    chgEl.className='t-chg '+(chg>=0?'up':'dn');

    // Verdict
    const bshBlock=document.getElementById('bshBlock');
    bshBlock.className=`bsh-block ${bshCls}`;
    flipVerdict(bsh);
    setTxt('bshCount',`${bullSigs} of ${total} signals agree`);
    setTxt('bshReason',bshReason);

    // Score
    const scCol=sc>=VERDICT_BUY?'var(--green)':sc<=VERDICT_SELL?'var(--red)':'var(--amber)';
    document.getElementById('scFill').style.cssText=`width:${sc}%;background:${scCol};height:100%`;
    setTxt('scNum',`${sc} / 100`);
    const pills=[
      {l:'RSI '+(rsi<35?'Cheap':rsi>65?'Pricey':'Ok'),c:rsi<45?'pos':rsi>55?'neg':'neu'},
      {l:'Trend '+(a20&&a50?'↑↑':!a20&&!a50?'↓↓':'Mixed'),c:a20&&a50?'pos':!a20&&!a50?'neg':'neu'},
      {l:'MACD '+(macd?.bullish?'↑':'↓'),c:!macd?'neu':macd.bullish?'pos':'neg'},
      {l:'Band '+(bb.bbPct<30?'Low':bb.bbPct>70?'High':'Mid'),c:bb.bbPct<30?'pos':bb.bbPct>70?'neg':'neu'},
      {l:'Stoch '+(stoch<25?'Low':stoch>75?'High':'Ok'),c:stoch<30?'pos':stoch>70?'neg':'neu'},
      {l:'Vol '+(volSig>0?'✓':volSig<0?'⚠':'–'),c:volSig>0?'pos':volSig<0?'neg':'neu'},
    ];
    setHTML('scBreakdown',pills.map(p=>`<div class="sc-pill ${p.c}">${p.l}</div>`).join(''));

    // ── RSI ────────────────────────────────────────────
    const rsiB=band(rsi,40,60);
    setAcc('hc-rsi',BAND_COLOR[rsiB]);
    const rsiLabel=rsi<30?'On Sale 🟢':rsi<40?'Cooling 🟡':rsi>70?'Overheated 🔴':rsi>60?'Warm 🟡':'Normal';
    setHTML('dRsi',`${rsi.toFixed(0)}/100 <span class="chip ${BAND_CHIP[rsiB]}">${rsiLabel}</span>`);
    setBar('dRsiBar',rsi,BAND_COLOR[rsiB]);
    setTxt('dRsiDesc',rsi<30?'Think of this like a clearance sale. Fewer people are buying than usual — which historically is one of the best times to enter quietly.'
      :rsi<40?'The rush has calmed. The stock is cooling off and may be setting up for a bounce. Keep an eye on it.'
      :rsi>70?'Everyone is rushing in right now. When a stock gets this popular this fast, a drop often follows. Patience pays.'
      :'Normal zone — neither too popular nor too ignored. Look at other signals to decide direction.');
    setTxt('dRsiAction',rsi<30?'✅ Good time to consider a small buy.':rsi<40?'👀 Worth watching closely.':rsi>70?'⚠️ Avoid buying — may drop soon.':'⏳ Wait for a dip below 40 for a better signal.');

    // ── MACD ───────────────────────────────────────────
    if(macd){
      setAcc('hc-macd',macd.bullish?'var(--green)':'var(--red)');
      const mLabel=macd.cross==='bullish'?'🔥 Fresh Buy Signal':macd.cross==='bearish'?'🚨 Fresh Sell Signal':macd.bullish?'Rising':'Falling';
      setHTML('dMacd',`Hist: ${macd.histogram>0?'+':''}${macd.histogram.toFixed(3)} <span class="chip ${macd.bullish?'c-g':'c-r'}">${mLabel}</span>`);
      setTxt('dMacdDesc',macd.cross==='bullish'?'A key signal just fired — the momentum indicator crossed upward. Like a traffic light turning green. Historically reliable when other signals agree.'
        :macd.cross==='bearish'?'A sell signal just fired — momentum crossed downward. Like a red light. This warns that buyer enthusiasm is fading.'
        :macd.bullish?'Momentum is still positive — more buyers than sellers under the surface. Good background condition for holding or buying dips.'
        :'Momentum is running negative — selling interest is dominating. Not a good environment for new purchases.');
      setTxt('dMacdAction',macd.cross==='bullish'?'✅ Strong signal. Best combined with RSI below 50.':macd.cross==='bearish'?'⚠️ Consider exiting or reducing positions.':macd.bullish?'👍 Positive background — supports holding.':'⏳ Wait for momentum to turn positive before buying.');
    }else{
      setAcc('hc-macd','var(--fg3)');
      setTxt('dMacd','Not enough data');
      setTxt('dMacdDesc','Need at least 35 trading days to calculate this signal.');
      setTxt('dMacdAction','ℹ️ Check back when more history is available.');
    }

    // ── MOMENTUM (1M) ──────────────────────────────────
    if(mom20!==null){
      setAcc('hc-mom',mom20>=3?'var(--green)':mom20<=-3?'var(--red)':'var(--amber)');
      setHTML('dMom',`<span class="${mom20>=0?'up':'dn'}">${mom20>=0?'+':''}${mom20.toFixed(1)}%</span> <span class="chip ${mom20>=3?'c-g':mom20<=-3?'c-r':'c-a'}">${mom20>=10?'Surging':mom20>=3?'Rising':mom20>=-3?'Flat':mom20>=-10?'Slipping':'Falling'}</span>`);
      setTxt('dMomDesc',mom20>=10?'Big run-up last month. Exciting — but chasing a stock after a big rise is risky. What goes up fast can come down fast.'
        :mom20>=3?'Steady healthy rise. This is what you want to see — gradual, not explosive. A good sign before buying.'
        :mom20>=-3?'Going nowhere much. The stock is drifting sideways. Wait for it to pick a direction first.'
        :mom20>=-10?'Sliding downward. Sellers winning right now. If you hold, be cautious. If considering buying, wait.'
        :'Sharp drop. Only very experienced investors buy into steep falls. Make sure you understand why before acting.');
      setTxt('dMomAction',mom20>=3?'👍 Positive momentum supports the buy case.':mom20<=-3?'⚠️ Wait for the slide to stop first.':'⏳ Sideways — no urgency either way.');
    }else{
      setAcc('hc-mom','var(--fg3)');setTxt('dMom','N/A');setTxt('dMomDesc','Not enough historical data.');setTxt('dMomAction','');
    }

    // ── BOLLINGER BANDS ────────────────────────────────
    const bbB=band(bb.bbPct,35,65);
    const bbL=bb.bbPct<25?'Very Cheap 🟢':bb.bbPct<45?'Cheap':bb.bbPct>75?'Very Pricey 🔴':bb.bbPct>55?'Pricey':'Normal';
    setAcc('hc-bb',BAND_COLOR[bbB]);
    setHTML('dBb',`${bb.bbPct.toFixed(0)}% of range <span class="chip ${BAND_CHIP[bbB]}">${bbL}</span>`);
    setBar('dBbBar',bb.bbPct,BAND_COLOR[bbB]);
    setTxt('dBbDesc',bb.bbPct<20?`The stock is pressing the bottom of its normal range (${fmt(bb.bbL,currency)}). Imagine it like a coiled spring — statistically, prices tend to bounce from here.`
      :bb.bbPct>80?`The stock is pressing the top of its normal range (${fmt(bb.bbU,currency)}). Like a rubber band stretched too far — it often snaps back down. Risky to buy here.`
      :`Price is in the comfortable middle of its normal range — between ${fmt(bb.bbL,currency)} and ${fmt(bb.bbU,currency)}. No extreme reading either way.`);
    setTxt('dBbAction',bb.bbPct<25?'✅ Historically a good area to buy a small amount.':bb.bbPct>75?'⚠️ Avoid buying — stretched upward.':'⏳ Middle of range — follow other signals.');

    // ── SHORT-TERM TREND (20d) ─────────────────────────
    setAcc('hc-s20',a20?'var(--green)':'var(--red)');
    setHTML('dS20',s20?`${fmt(s20,currency)} <span class="chip ${a20?'c-g':'c-r'}">${a20?'Price Above ↑':'Price Below ↓'}</span>`:'N/A');
    setTxt('dS20Desc',a20?`The current price (${fmt(cur,currency)}) is above its 20-day average (${fmt(s20,currency)}). Think of it like a student scoring above their recent class average — recent performance is strong.`
      :`The current price (${fmt(cur,currency)}) has slipped below its 20-day average (${fmt(s20,currency)}). Like grades falling below average — short-term momentum is weakening.`);
    setTxt('dS20Action',a20?'👍 Short-term trend positive. Good for holders.':'⚠️ Short-term trend negative. Wait for recovery.');

    // ── LONG-TERM TREND (50d) ──────────────────────────
    setAcc('hc-s50',a50?'var(--green)':'var(--red)');
    setHTML('dS50',s50?`${fmt(s50,currency)} <span class="chip ${a50?'c-g':'c-r'}">${a50?'Healthy ↑':'Weak ↓'}</span>`:'N/A');
    setTxt('dS50Desc',a50?`Above its long-term average of ${fmt(s50,currency)}. The bigger picture is healthy — like a company still growing despite bumps along the way.`
      :`Below its long-term average of ${fmt(s50,currency)}. The bigger trend is pointing down. Usually, waiting is smarter than buying here.`);
    setTxt('dS50Action',a50?'✅ Big-picture trend intact. Supports buying on dips.':'🚫 Long-term trend broken. Extra caution needed.');

    // ── STOCHASTIC ─────────────────────────────────────
    const stochB=band(stoch,30,70);
    setAcc('hc-stoch',BAND_COLOR[stochB]);
    setHTML('dStoch',`${stoch.toFixed(0)}/100 <span class="chip ${BAND_CHIP[stochB]}">${stoch<25?'Oversold 🟢':stoch>75?'Overbought 🔴':'Normal'}</span>`);
    setBar('dStochBar',stoch,BAND_COLOR[stochB]);
    setTxt('dStochDesc',stoch<25?`The stock is near the bottom of where it has traded over the past 2 weeks. Think of it like a spring compressed tight — there's potential energy for a bounce. A second signal confirming cheap conditions.`
      :stoch>75?`The stock is near the top of its recent trading range. It's getting tired. This second indicator confirms what RSI is saying: the stock is stretched upward.`
      :`In the middle of its recent range. No strong reading — use RSI and MACD as the main guides.`);
    setTxt('dStochAction',stoch<25?'✅ Oversold confirmation — buy conditions improving.':stoch>75?'⚠️ Overbought confirmation — wait before buying.':'⏳ Neutral — follow the bigger indicators.');

    // ── STREAK ─────────────────────────────────────────
    setAcc('hc-streak',streak.dir==='up'?'var(--green)':'var(--red)');
    setHTML('dStreak',`<span class="${streak.dir==='up'?'up':'dn'}">${streak.count} day${streak.count!==1?'s':''} ${streak.dir==='up'?'rising ↑':'falling ↓'}</span>${streak.count>=4?`<span class="chip ${streak.dir==='up'?'c-a':'c-r'}">${streak.dir==='up'?'Hot!':'Warning'}</span>`:''}`);
    setTxt('dStreakDesc',streak.dir==='up'?`The stock has closed higher ${streak.count} days in a row. ${streak.count>=4?'A hot streak — exciting! But streaks often pause or reverse after several days. Be cautious chasing.':'Healthy short-term momentum.'}`
      :`The stock has closed lower ${streak.count} days in a row. ${streak.count>=4?'A significant losing streak. Sellers are firmly in control right now.':'A short dip — not necessarily alarming yet.'}`);
    setTxt('dStreakAction',streak.dir==='up'&&streak.count>=4?'⚠️ Don\'t chase a hot streak — wait for a small pullback.'
      :streak.dir==='dn'&&streak.count>=4?'🚫 Avoid buying into a strong downtrend.'
      :streak.dir==='up'?'👍 Positive short-term momentum.':'⏳ Short-term sellers active — be patient.');

    // ── CROSS ──────────────────────────────────────────
    const crossBull=cross.type==='golden'||cross.type==='above';
    setAcc('hc-cross',crossBull?'var(--green)':'var(--red)');
    const crossAge=cross.days===0?'(today)':cross.days===1?'(yesterday)':cross.days!=null?`(${cross.days}d ago)`:'';
    const crossLabel=cross.type==='golden'?`✨ Golden Cross ${crossAge}`:cross.type==='death'?`💀 Death Cross ${crossAge}`:cross.type==='above'?'↑ Short-term above Long-term':'↓ Short-term below Long-term';
    setHTML('dCross',`<span class="chip ${crossBull?'c-g':'c-r'}" style="font-size:11px">${crossLabel}</span>`);
    setTxt('dCrossDesc',cross.type==='golden'?`The 20-day average just crossed above the 50-day average. This is the famous "Golden Cross" — one of the most trusted buy signals. It means short-term buyer momentum has overtaken the long-term trend.`
      :cross.type==='death'?`The 20-day average just crossed below the 50-day — a "Death Cross". One of the most widely-watched warning signals. Short-term momentum is dragging the long-term trend downward.`
      :cross.type==='above'?`Short-term average (${fmt(s20,currency)}) is above long-term average (${fmt(s50,currency)}). Healthy background — no dramatic signal, but conditions favour bulls.`
      :`Short-term average (${fmt(s20,currency)}) is below long-term average (${fmt(s50,currency)}). Bearish background. Be patient.`);
    setTxt('dCrossAction',cross.type==='golden'?'✅ Strong medium-term buy signal. Enter on a small dip.':cross.type==='death'?'🚫 Major warning. Avoid until trend recovers.':crossBull?'👍 Healthy trend — good for holders.':'⚠️ Bearish background. Be patient.');

    // ── 52-WEEK RANGE ──────────────────────────────────
    setAcc('hc-52w','var(--accent)');
    setHTML('d52w',`${pos52.toFixed(0)}% of range <span class="chip ${pos52<30?'c-g':pos52>70?'c-r':'c-a'}">${pos52<25?'Near Yearly Low':pos52>75?'Near Yearly High':'Mid Range'}</span>`);
    document.getElementById('d52wBar').style.width=`${pos52}%`;
    setTxt('d52wDesc',pos52<25?`Near its lowest price of the year (${fmt(lo52,currency)}). You wouldn't be buying at the top — though falling prices aren't automatically a buy. First understand why it fell.`
      :pos52>75?`Near its highest price of the year (${fmt(hi52,currency)}). You'd be buying near the peak — higher risk, less room to grow.`
      :`Sitting in the middle of its yearly range (${fmt(lo52,currency)} – ${fmt(hi52,currency)}). Neither a bargain nor expensive.`);
    setTxt('d52wAction',pos52<25?'ℹ️ Potentially a value zone — but research the reason.':pos52>75?'⚠️ Near yearly high — higher risk entry.':'⏳ Middle of range — other signals matter more.');

    // ── RETURNS ────────────────────────────────────────
    setAcc('hc-returns','var(--accent)');
    const rets=[{l:'1W',v:ret1w},{l:'2W',v:ret2w},{l:'1M',v:ret1m},{l:'3M',v:ret3m}];
    setHTML('dReturns',rets.map(({l,v})=>`<div class="ret-cell"><div class="ret-period">${l}</div><div class="ret-val ${v===null?'':v>=0?'up':'dn'}">${v!==null?(v>=0?'+':'')+v.toFixed(1)+'%':'N/A'}</div></div>`).join(''));
    const posC=rets.filter(r=>r.v!==null&&r.v>0).length,totC=rets.filter(r=>r.v!==null).length;
    setTxt('dReturnsDesc',`This shows real returns over different time windows. ${posC>=3?'Most timeframes are positive — consistently strong momentum.':posC===0?'All timeframes are negative — persistent weakness.':`${posC} of ${totC} timeframes are positive. Mixed performance.`}`);

    // ── FLOOR / SUPPORT ────────────────────────────────
    setAcc('hc-sup','var(--green)');
    const bufAbove=((cur-sup)/sup*100);
    setHTML('dSup',`${fmt(sup,currency)} <span class="chip c-g">+${bufAbove.toFixed(1)}% above</span>`);
    setTxt('dSupDesc',`Over the past month, this stock has repeatedly bounced off ${fmt(sup,currency)} — like an invisible floor. Many buyers step in there. Waiting for the price to dip near this level gives you a safer, lower-risk entry.`);
    setTxt('dSupAction',`🛡️ Set your stop-loss just below ${fmt(sup,currency)} if you buy. That's your safety exit.`);

    // ── CEILING / RESISTANCE ───────────────────────────
    setAcc('hc-res','var(--red)');
    const toRes=((res_-cur)/cur*100);
    setHTML('dRes',`${fmt(res_,currency)} <span class="chip c-r">+${toRes.toFixed(1)}% away</span>`);
    setTxt('dResDesc',`The stock has struggled to break above ${fmt(res_,currency)} recently — like an invisible ceiling. Many sellers appear at that level. This is your profit target.`);
    setTxt('dResAction',`🎯 Plan to sell near ${fmt(res_,currency)} for a ~${toRes.toFixed(1)}% gain from today.`);

    // ── ATR / VOLATILITY ───────────────────────────────
    setAcc('hc-atr',atrPct>3?'var(--red)':atrPct>1.5?'var(--amber)':'var(--green)');
    setHTML('dVol',`~${atrPct.toFixed(2)}%/day <span class="chip ${atrPct>3?'c-r':atrPct>1.5?'c-a':'c-g'}">${atrPct>3?'Very Bumpy 🌊':atrPct>1.5?'Moderate':'Calm ✅'}</span>`);
    setTxt('dVolDesc',atrPct>3?`This stock moves more than 3% per day on average — like a rollercoaster. Exciting but risky. Only invest what you're comfortable seeing fluctuate sharply day to day.`
      :atrPct>1.5?`Moderate swings of ~${atrPct.toFixed(1)}% per day. Normal for most stocks. You might see a few percent move in one day — that's okay as long as you're patient.`
      :`Barely moves day to day. A relatively calm, steady stock — easier to hold without anxiety.`);
    setTxt('dVolAction',atrPct>3?'⚠️ Only invest what you can afford to see swing sharply.':atrPct>1.5?'👍 Moderate volatility — set a stop-loss 7–10% below your buy price.':'✅ Calm stock — easier to hold patiently.');

    // ── VOLUME ─────────────────────────────────────────
    if(hasVol){
      const fV=v=>v>=1e9?(v/1e9).toFixed(1)+'B':v>=1e6?(v/1e6).toFixed(1)+'M':v>=1e3?(v/1e3).toFixed(0)+'K':String(v);
      const vLbl=volRatio>2?'Very Heavy':volRatio>1.3?'Above Average':volRatio<0.6?'Very Quiet':'Normal';
      setAcc('hc-volume',volRatio>1.3&&a20?'var(--green)':volRatio>1.3&&!a20?'var(--red)':'var(--amber)');
      setHTML('dVolTrend',`Today: ${fV(lastVol)} <span class="chip ${volRatio>1.3&&a20?'c-g':volRatio>1.3&&!a20?'c-r':'c-a'}">${vLbl} (×${volRatio.toFixed(1)} avg)</span>`);
      setTxt('dVolTrendDesc',volRatio>1.5&&a20?'Lots more people trading today — and the price is going up. The best combo: rising price confirmed by heavy activity. The move is real, not a fluke.'
        :volRatio>1.5&&!a20?'Lots of activity — but price is falling. People are rushing to sell. That selling has real conviction behind it. A bearish warning.'
        :volRatio<0.6?'Very few people trading today. Price moves on thin volume are often temporary. Wait for more activity before acting.'
        :'Normal trading volume. Nothing alarming or exciting to note.');
      setTxt('dVolAction2',volRatio>1.3&&a20?'✅ Volume confirms the price rise. Stronger buy signal.':volRatio>1.3&&!a20?'🚫 Volume confirms the drop. Sellers have conviction.':'⏳ Normal volume — no extra signal.');
      const recentVols=volumes.slice(-20);
      const maxV=Math.max(...recentVols,1);
      setHTML('dVolSpark',recentVols.map(v=>{
        const h=Math.max(10,Math.round(v/maxV*100));
        const spike=v>avgVol20*1.4;
        return`<div class="vol-bar${spike?' spike':''}" style="height:${h}%;background:${spike?(a20?'var(--green)':'var(--red)'):'var(--fg3)'}"></div>`;
      }).join(''));
    }else{
      setAcc('hc-volume','var(--fg3)');
      setTxt('dVolTrend','Volume data not available');setTxt('dVolTrendDesc','This ticker does not provide trading volume data.');setTxt('dVolAction2','');setHTML('dVolSpark','');
    }

    // ── AGREEMENT ──────────────────────────────────────
    const agree=[(a20?1:0),(a50?1:0),(rsi<50?1:0),(mom20!==null&&mom20>0?1:0),(macd?.bullish?1:0),(stoch<50?1:0)].reduce((a,b)=>a+b,0);
    const aLabel=agree>=5?'Strongly Bullish 🟢':agree>=4?'Mostly Bullish':agree===3?'Mixed ⚖️':agree<=1?'Strongly Bearish 🔴':'Mostly Bearish';
    setAcc('hc-agree','var(--accent)');
    setHTML('dTrend',`${agree}/6 signals positive <span class="chip ${agree>=4?'c-g':agree<=2?'c-r':'c-a'}">${aLabel}</span>`);
    setTxt('dTrendDesc',agree>=5?'Almost all signals point up. Highest-confidence scenario. Invest only what you can afford to lose even then.'
      :agree>=4?'More signals positive than negative. The odds lean toward buyers being in control. A cautious entry may make sense.'
      :agree===3?'Signals are exactly split. The market hasn\'t decided. Patience is the wisest move here.'
      :agree<=2?'Most signals point down. Sellers are in control. Wait for conditions to improve before investing.'
      :'All signals are bearish. Avoid completely for now.');

    // ── ACTION PLAN ────────────────────────────────────
    if(rsi<35||bb.bbPct<25){
      setTxt('pBuyM','Buy now in small amounts');
      setTxt('pBuyS',`Best zone: ${fmt(sup,currency)} to ${fmt(sup*1.02,currency)}. Don't put it all in at once — buy in batches.`);
    }else{
      setTxt('pBuyM','Wait for a better price');
      setTxt('pBuyS',`Wait for the price to dip near ${fmt(sup,currency)}. Set a price alert if your broker supports it.`);
    }
    setTxt('pSellM',`Sell near ${fmt(res_,currency)}`);
    setTxt('pSellS',`That's +${exp}% from today. Also set an automatic exit if it drops 6–8% below your buy price — that's your insurance policy.`);

    const stopLoss=Math.max(cur-atr*1.5,sup*0.97);
    const reward=res_-cur,risk=cur-stopLoss;
    const rr=risk>0?reward/risk:0;
    const rrCol=rr>=2?'var(--green)':rr>=1?'var(--amber)':'var(--red)';
    setHTML('pRR',`<span style="color:${rrCol};font-family:var(--mono);font-size:15px;font-weight:700">1 : ${rr.toFixed(2)}</span>`);
    setTxt('pRRDesc',`For every ${fmt(risk,currency)} you risk losing, you could gain ${fmt(reward,currency)}. ${rr>=2?'Excellent — reward is 2× the risk. A solid setup.':rr>=1?'Acceptable — reward equals or slightly beats risk. Proceed with caution.':'Poor — you\'re risking more than you could gain. Wait for a better entry near the floor.'}`);

    if(best){
      setHTML('btBody',`Bought at ${fmt(best.buyPrice,currency)} on ${best.buyDate}, sold at ${fmt(best.sellPrice,currency)} on ${best.sellDate}.<br><span class="bt-profit">+${best.pct}% profit in just ${best.days} days.</span>`);
      document.getElementById('btWrap').style.display='block';
    }

    drawChart(labels,closes,s20a,s50a,bb.upper,bb.lower,currency);
}

// ── HOVER / TAP CARD TOGGLE ──────────────────────────────
document.getElementById('hcGrid').addEventListener('click',e=>{
  const card=e.target.closest('.hc-card');
  if(!card)return;
  const isOpen=card.classList.contains('open');
  document.querySelectorAll('.hc-card.open').forEach(c=>{c.classList.remove('open');c.setAttribute('aria-expanded','false');});
  if(!isOpen){card.classList.add('open');card.setAttribute('aria-expanded','true');}
});
document.getElementById('hcGrid').addEventListener('keydown',e=>{
  if(e.key==='Enter'||e.key===' '){e.preventDefault();const card=e.target.closest('.hc-card');if(card)card.click();}
});

// ── SEARCH ────────────────────────────────────────────────
const inp=document.getElementById('inp'),dd=document.getElementById('dd');
let dbt;
inp.addEventListener('input',()=>{
  clearTimeout(dbt);
  const q=inp.value.trim();
  if(q.length<2){dd.style.display='none';return;}
  dbt=setTimeout(async()=>{
    try{
      const res=await search(q);
      if(!res.length){dd.style.display='none';return;}
      dd.innerHTML=res.map(s=>`<div class="dd-item" data-sym="${esc(s.symbol)}" data-name="${esc(s.name)}" tabindex="-1" role="option">
        <div class="dd-left"><span class="dd-sym">${esc(s.symbol)}</span><span class="dd-exch">${esc(s.exchange||'')}</span></div>
        <span class="dd-name">${esc(s.name.length>36?s.name.slice(0,36)+'…':s.name)}</span>
      </div>`).join('');
      dd.style.display='block';
      dd.querySelectorAll('.dd-item').forEach(item=>{
        item.addEventListener('click',()=>{inp.value=item.dataset.sym+' — '+item.dataset.name;dd.style.display='none';analyse(item.dataset.sym,item.dataset.name);});
      });
    }catch{dd.style.display='none';}
  },300);
});
document.addEventListener('click',e=>{if(!inp.contains(e.target)&&!dd.contains(e.target))dd.style.display='none';});
function parseInput(raw){const p=raw.split(' — ');return{sym:p[0].trim().toUpperCase(),name:p[1]?.trim()||p[0].trim().toUpperCase()};}
document.getElementById('goBtn').addEventListener('click',()=>{const q=inp.value.trim();if(q){const{sym,name}=parseInput(q);analyse(sym,name);}});
inp.addEventListener('keydown',e=>{
  if(e.key==='Enter'){dd.style.display='none';const q=inp.value.trim();if(q){const{sym,name}=parseInput(q);analyse(sym,name);}}
  if(e.key==='ArrowDown'){e.preventDefault();const items=dd.querySelectorAll('.dd-item');if(items.length)items[0].focus();}
});
dd.addEventListener('keydown',e=>{
  const items=[...dd.querySelectorAll('.dd-item')];
  const idx=items.indexOf(document.activeElement);
  if(e.key==='ArrowDown'){e.preventDefault();items[Math.min(idx+1,items.length-1)]?.focus();}
  if(e.key==='ArrowUp'){e.preventDefault();idx===0?inp.focus():items[idx-1]?.focus();}
  if(e.key==='Enter'&&idx>=0)items[idx].click();
  if(e.key==='Escape'){dd.style.display='none';inp.focus();}
});

// ── THEME ─────────────────────────────────────────────────
(function(){
  const btn=document.getElementById('themeBtn'),root=document.documentElement;
  function isDark(){const t=root.getAttribute('data-theme');return t==='dark'?true:t==='light'?false:window.matchMedia('(prefers-color-scheme:dark)').matches;}
  const meta=document.querySelector('meta[name="theme-color"]');
  function apply(){const d=isDark();btn.textContent=d?'☀':'🌙';if(meta)meta.setAttribute('content',d?'#070912':'#eaeefb');}
  apply();
  btn.addEventListener('click',()=>{
    root.setAttribute('data-theme',isDark()?'light':'dark');
    apply();
    if(ci&&chartState){const s=chartState;drawChart(s.labels,s.closes,s.s20,s.s50,s.bbU,s.bbL,s.currency);}
  });
})();

// No default ticker — the search box starts blank and the user drives the first
// analysis. (Previously auto-loaded NVDA on page load.)
