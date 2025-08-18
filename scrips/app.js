// UI wiring & charts; will use Web Worker if available, else fallback to main thread.
const els = {};
let worker = null;
let useFallback = false; // set true if worker creation or messaging fails

document.addEventListener('DOMContentLoaded', () => {
  [
    "periods","sims","seed","demandDist","demandMu","demandSigma","aov",
    "cogsPct","varCostPct","startingCash","fixedCost","dsoDays","latePayPct",
    "taxRate","shortfallThresh","runBtn","status"
  ].forEach(id => els[id] = document.getElementById(id));

  ["kpiShortfall","kpiEndNeg","kpiVaR","kpiMedian"].forEach(id => els[id] = document.getElementById(id));
  ["fanChart","histChart","tornadoChart"].forEach(id => els[id] = document.getElementById(id));

  document.getElementById('year').textContent = new Date().getFullYear();

  // Try to spin up the worker
  try {
    worker = new Worker('scripts/sim.worker.js'); // classic worker = widest compatibility
    worker.onmessage = onWorkerMessage;
    worker.onerror = (e)=>{ failToFallback("Worker error: " + (e.message||"unknown")); };
  } catch (err) {
    failToFallback("Worker failed to start: " + err.message);
  }

  els.runBtn.addEventListener('click', run);
  drawEmpty();
});

function failToFallback(msg){
  console.warn(msg);
  useFallback = true;
  worker = null;
  if (els.status) els.status.textContent = "Running without worker (fallback). For best performance, serve via http://localhost/ .";
}

function getParams(){
  return {
    periods: clamp(parseInt(els.periods.value||"12"), 3, 60),
    sims: clamp(parseInt(els.sims.value||"10000"), 1000, 100000),
    seed: els.seed.value ? Number(els.seed.value) : null,
    demand: {
      dist: els.demandDist.value,
      mu: Number(els.demandMu.value),
      sigma: Number(els.demandSigma.value)
    },
    aov: Number(els.aov.value),
    cogsPct: clampPct(Number(els.cogsPct.value)),
    varCostPct: clampPct(Number(els.varCostPct.value)),
    startingCash: Number(els.startingCash.value),
    fixedCost: Number(els.fixedCost.value),
    dsoDays: clamp(Number(els.dsoDays.value), 0, 120),
    latePayPct: clampPct(Number(els.latePayPct.value)),
    taxRate: clampPct(Number(els.taxRate.value)),
    shortfallThresh: Number(els.shortfallThresh.value),
  };
}

function run(){
  const p = getParams();
  els.status.textContent = useFallback ? "Running (fallback: no worker)…" : "Running simulations…";
  els.runBtn.disabled = true;

  if (useFallback){
    // Run on main thread (same logic copied from worker)
    try {
      const result = runSim(p);
      els.status.textContent = `Done. Sims: ${p.sims.toLocaleString()} (fallback)`;
      els.runBtn.disabled = false;
      renderAll(result);
    } catch (err) {
      els.status.textContent = "Error: " + err.message;
      els.runBtn.disabled = false;
    }
  } else {
    try {
      worker.postMessage({ type: 'run', params: p });
    } catch (err) {
      // Messaging failed — drop to fallback
      failToFallback("Worker postMessage failed: " + err.message);
      run();
    }
  }
}

function onWorkerMessage(e){
  const msg = e.data;
  if (msg.type === 'result'){
    els.status.textContent = `Done. Sims: ${msg.sims.toLocaleString()}`;
    els.runBtn.disabled = false;
    renderAll(msg.result);
  } else if (msg.type === 'error'){
    failToFallback("Worker internal error: " + msg.error);
    els.runBtn.disabled = false;
  }
}

function renderAll(res){
  // KPIs
  els.kpiShortfall.textContent = pct(res.metrics.pShortfallAny);
  els.kpiEndNeg.textContent = pct(res.metrics.pEndCashNeg);
  els.kpiVaR.textContent = money(res.metrics.var5);
  els.kpiMedian.textContent = money(res.metrics.medianEnd);

  renderFan(res.bands, res.timeline);
  renderHist(res.endingCash);
  renderTornado(res.tornado);
}

function renderFan(bands, timeline){
  const x = timeline;
  const {p5,p25,p50,p75,p95} = bands;
  const traceP95 = { x, y: p95, mode:'lines', line:{ width:0 }, name:'95th', showlegend:false };
  const traceP5  = { x, y: p5,  mode:'lines', fill:'tonexty', fillcolor:'rgba(106,209,255,0.08)', line:{ width:0 }, name:'5th' };
  const traceP75 = { x, y: p75, mode:'lines', line:{ width:0 }, showlegend:false };
  const traceP25 = { x, y: p25, mode:'lines', fill:'tonexty', fillcolor:'rgba(106,209,255,0.18)', line:{ width:0 }, name:'25–75%' };
  const traceMed = { x, y: p50, mode:'lines', line:{ color:'#6ad1ff', width:2 }, name:'Median' };
  Plotly.newPlot('fanChart', [traceP95, traceP5, traceP75, traceP25, traceMed], {
    title:'Cash Balance — Uncertainty Bands',
    xaxis:{ title:'Month', dtick:1, gridcolor:'rgba(255,255,255,0.06)' },
    yaxis:{ title:'Cash ($)', gridcolor:'rgba(255,255,255,0.06)' },
    paper_bgcolor:'transparent', plot_bgcolor:'transparent', showlegend:true, legend:{ orientation:'h' }
  }, { displayModeBar:false, responsive:true });
}

function renderHist(endingCash){
  const n = 40;
  const min = Math.min(...endingCash), max = Math.max(...endingCash);
  const bins = linspace(min, max, n+1);
  const counts = new Array(n).fill(0);
  for (const v of endingCash){
    let i = Math.min(n-1, Math.max(0, Math.floor((v - min) / ((max-min) || 1) * n)));
    counts[i]++;
  }
  const centers = bins.slice(0, -1).map((b,i)=> (b + bins[i+1]) / 2);
  Plotly.newPlot('histChart', [{
    x: centers, y: counts, type:'bar', marker:{ color:'#6ad1ff' }, name:'End cash'
  }], {
    title:'Distribution — Ending Cash',
    xaxis:{ title:'End cash ($)', gridcolor:'rgba(255,255,255,0.06)' },
    yaxis:{ title:'Count', gridcolor:'rgba(255,255,255,0.06)' },
    paper_bgcolor:'transparent', plot_bgcolor:'transparent', showlegend:false
  }, { displayModeBar:false, responsive:true });
}

function renderTornado(tornado){
  if (!tornado || !tornado.items || !tornado.items.length){
    Plotly.newPlot('tornadoChart', [], {
      title:'Sensitivity (ΔP(Shortfall))',
      paper_bgcolor:'transparent', plot_bgcolor:'transparent'
    }, { displayModeBar:false, responsive:true });
    return;
  }
  const sorted = [...tornado.items].sort((a,b)=> Math.max(Math.abs(b.deltaLow), Math.abs(b.deltaHigh)) - Math.max(Math.abs(a.deltaLow), Math.abs(a.deltaHigh)));
  const names = sorted.map(d=>d.name);
  const low = sorted.map(d=> d.deltaLow * 100);
  const high= sorted.map(d=> d.deltaHigh * 100);
  const traceLow = { x: low, y: names, type:'bar', orientation:'h', name:'-10%', marker:{ color:'rgba(255,107,107,0.85)' } };
  const traceHigh= { x: high, y: names, type:'bar', orientation:'h', name:'+10%', marker:{ color:'rgba(66,211,146,0.85)' } };
  Plotly.newPlot('tornadoChart', [traceLow, traceHigh], {
    title:'Sensitivity: ΔP(Shortfall) when varying one input ±10%',
    xaxis:{ title:'Percentage points', zeroline:true, zerolinewidth:2, gridcolor:'rgba(255,255,255,0.06)' },
    yaxis:{ automargin:true, gridcolor:'rgba(255,255,255,0.06)' },
    barmode:'overlay',
    paper_bgcolor:'transparent', plot_bgcolor:'transparent', showlegend:true, legend:{ orientation:'h' }
  }, { displayModeBar:false, responsive:true });
}

function drawEmpty(){
  Plotly.newPlot('fanChart', [], {paper_bgcolor:'transparent', plot_bgcolor:'transparent'}, {displayModeBar:false});
  Plotly.newPlot('histChart', [], {paper_bgcolor:'transparent', plot_bgcolor:'transparent'}, {displayModeBar:false});
  Plotly.newPlot('tornadoChart', [], {paper_bgcolor:'transparent', plot_bgcolor:'transparent'}, {displayModeBar:false});
}

// Helpers
const clamp = (x,min,max)=> Math.max(min, Math.min(max, x));
const clampPct = x => clamp(x, 0, 100);
const pct = v => (v*100).toFixed(1) + '%';
const money = v => (v>=0? '$':'-$') + Math.abs(v).toLocaleString(undefined,{maximumFractionDigits:0});
const linspace = (a,b,n) => Array.from({length:n},(_,i)=> a + (i*(b-a)/(n-1)));

/* ===== Fallback simulation logic (same as worker) ===== */
function mulberry32(seed) { let t = seed >>> 0; return function(){ t|=0; t = t + 0x6D2B79F5 | 0; let r = Math.imul(t ^ t>>>15, 1|t) + Math.imul(t ^ t>>>7, 61|t) ^ t; return ((r ^ r>>>14)>>>0) / 4294967296; }; }
function seeded(seed){ if (seed == null) seed = Math.floor(Math.random()*2**31); return mulberry32(seed); }
function randn(rng){ let u=0,v=0; while(u===0) u=rng(); while(v===0) v=rng(); return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v); }
function sampleDemand(dist, mu, sigma, rng){
  if (dist==='poisson'){ const L=Math.exp(-Math.max(0,mu)); let k=0,p=1; do{ k++; p*=rng(); } while(p>L); return k-1; }
  if (dist==='lognormal'){ const m=Math.max(1e-9,mu), s=Math.max(1e-9,sigma); const phi=Math.sqrt(1+(s*s)/(m*m)); const muL=Math.log(m/phi); const sigmaL=Math.sqrt(Math.log(phi*phi)); return Math.max(0, Math.exp(muL + sigmaL*randn(rng))); }
  return Math.max(0, mu + sigma*randn(rng)); // normal truncated at 0
}
function runSim(p){
  const rng = seeded(p.seed == null ? Math.floor(Math.random()*1e9) : p.seed);
  const months = Math.max(3, Math.min(60, p.periods|0));
  const sims = Math.max(1000, Math.min(100000, p.sims|0));
  const dsoMonths = Math.round(p.dsoDays/30);
  const lateShare = Math.max(0, Math.min(1, p.latePayPct/100));
  const cogs = Math.max(0, Math.min(1, p.cogsPct/100));
  const varc = Math.max(0, Math.min(1, p.varCostPct/100));
  const tax = Math.max(0, Math.min(1, p.taxRate/100));
  const shortfallThresh = Number(p.shortfallThresh)||0;

  const timeline = Array.from({length: months}, (_,i)=> i+1);
  const mat = Array.from({length: months}, () => new Float64Array(sims));
  const endCash = new Float64Array(sims);
  let shortfallAny = 0, endNeg = 0;

  for (let s=0; s<sims; s++){
    let cash = Number(p.startingCash)||0;
    const rev = new Float64Array(months);
    const cost = new Float64Array(months);
    const cashIn = new Float64Array(months);

    for (let t=0; t<months; t++){
      const demand = sampleDemand(p.demand.dist, p.demand.mu, p.demand.sigma, rng);
      const revenue = demand * p.aov;
      const cogsCost = revenue * cogs;
      const varCost  = revenue * varc;
      const fixed    = p.fixedCost;
      const pbt      = revenue - (cogsCost + varCost + fixed);
      const taxPay   = pbt > 0 ? tax * pbt : 0;
      rev[t]  = revenue;
      cost[t] = (cogsCost + varCost + fixed - taxPay);
    }
    for (let t=0; t<months; t++){
      const baseIdx = t - dsoMonths;
      const lateIdx = baseIdx - 1;
      let collect = 0;
      if (baseIdx >= 0) collect += rev[baseIdx] * (1 - lateShare);
      if (lateIdx >= 0) collect += rev[lateIdx] * lateShare;
      cash = cash + collect - cost[t];
      mat[t][s] = cash;
      if (cash < shortfallThresh) shortfallAny = shortfallAny + 1, t = months; // break loop
    }
    endCash[s] = cash;
    if (cash < 0) endNeg++;
  }

  const pcts = [5, 25, 50, 75, 95];
  const bands = { p5:[], p25:[], p50:[], p75:[], p95:[] };
  for (let t=0; t<months; t++){
    const arr = Array.from(mat[t]).sort((a,b)=>a-b);
    const q = quantilesFromSorted(arr, pcts);
    bands.p5.push(q[0]); bands.p25.push(q[1]); bands.p50.push(q[2]); bands.p75.push(q[3]); bands.p95.push(q[4]);
  }

  const endArr = Array.from(endCash).sort((a,b)=>a-b);
  const var5 = quantileFromSorted(endArr, 0.05);
  const med  = quantileFromSorted(endArr, 0.50);
  const mean = endArr.reduce((s,x)=>s+x,0) / sims;

  const tornado = sensitivityTornado(p, 3000, seeded(12345)); // deterministic seed for stability

  return {
    timeline,
    bands,
    endingCash: Array.from(endCash),
    metrics: {
      pShortfallAny: shortfallAny / sims,
      pEndCashNeg: endNeg / sims,
      var5, medianEnd: med, meanEnd: mean
    },
    tornado
  };
}
function sensitivityTornado(base, simsSmall, rng){ // simplified for fallback
  const names = [
    { key:'demand.mu', label:'Demand mean' },
    { key:'demand.sigma', label:'Demand std' },
    { key:'aov', label:'Average order value' },
    { key:'cogsPct', label:'COGS %' },
    { key:'varCostPct', label:'Var Opex %' },
    { key:'fixedCost', label:'Fixed cost' },
    { key:'dsoDays', label:'DSO days' }
  ];
  const baseRisk = riskShortfall(base, simsSmall, rng);
  const items = names.map(n=>{
    const loP = riskShortfall(nudge(base, n.key, -0.10), simsSmall, rng);
    const hiP = riskShortfall(nudge(base, n.key, +0.10), simsSmall, rng);
    return { name: n.label, deltaLow: loP - baseRisk, deltaHigh: hiP - baseRisk };
  });
  return { base: baseRisk, items };
}
function nudge(obj, dotted, frac){
  const clone = JSON.parse(JSON.stringify(obj));
  const parts = dotted.split('.');
  let ref = clone; for (let i=0;i<parts.length-1;i++) ref = ref[parts[i]];
  const k = parts.at(-1); let nv = ref[k];
  if (typeof nv === 'number'){ nv = nv * (1 + frac);
    if (k.includes('Pct')) nv = Math.max(0, Math.min(100, nv));
    if (k === 'dsoDays') nv = Math.max(0, Math.min(120, nv));
    if (k === 'sigma' && nv <= 0) nv = 1e-6;
    ref[k] = nv;
  }
  return clone;
}
function riskShortfall(p, sims, rng){
  const rnd = rng || seeded(98765);
  const months = Math.max(3, Math.min(60, p.periods|0));
  const dsoMonths = Math.round(p.dsoDays/30);
  const lateShare = Math.max(0, Math.min(1, p.latePayPct/100));
  const cogs = Math.max(0, Math.min(1, p.cogsPct/100));
  const varc = Math.max(0, Math.min(1, p.varCostPct/100));
  const tax = Math.max(0, Math.min(1, p.taxRate/100));
  const thresh = Number(p.shortfallThresh)||0;

  let shortfallAny = 0;
  for (let s=0; s<sims; s++){
    let cash = Number(p.startingCash)||0;
    const rev = new Float64Array(months);
    const cost = new Float64Array(months);
    for (let t=0; t<months; t++){
      const demand = sampleDemand(p.demand.dist, p.demand.mu, p.demand.sigma, rnd);
      const revenue = demand * p.aov;
      const cogsCost = revenue * cogs;
      const varCost  = revenue * varc;
      const fixed    = p.fixedCost;
      const pbt      = revenue - (cogsCost + varCost + fixed);
      const taxPay   = pbt > 0 ? tax * pbt : 0;
      cash = cash + revenue - (cogsCost + varCost + fixed - taxPay); // simplified timing for speed
      if (cash < thresh){ shortfallAny++; break; }
    }
  }
  return shortfallAny / sims;
}
function quantilesFromSorted(arr, pcts){ return pcts.map(p => quantileFromSorted(arr, p/100)); }
function quantileFromSorted(arr, q){
  const n = arr.length; if (n===0) return NaN;
  const pos = (n-1)*q, base=Math.floor(pos), rest=pos-base;
  return arr[base+1]!==undefined ? arr[base] + rest*(arr[base+1]-arr[base]) : arr[base];
}
