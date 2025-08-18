// UI wiring & charts; simulation logic runs in sim.worker.js
const els = {};
let worker;

document.addEventListener('DOMContentLoaded', () => {
  [
    "periods","sims","seed","demandDist","demandMu","demandSigma","aov",
    "cogsPct","varCostPct","startingCash","fixedCost","dsoDays","latePayPct",
    "taxRate","shortfallThresh","runBtn","status"
  ].forEach(id => els[id] = document.getElementById(id));

  ["kpiShortfall","kpiEndNeg","kpiVaR","kpiMedian"].forEach(id => els[id] = document.getElementById(id));
  ["fanChart","histChart","tornadoChart"].forEach(id => els[id] = document.getElementById(id));

  document.getElementById('year').textContent = new Date().getFullYear();

  worker = new Worker('scripts/sim.worker.js', { type: 'module' });
  worker.onmessage = onWorkerMessage;

  els.runBtn.addEventListener('click', run);
  // initial blank charts
  drawEmpty();
});

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
  els.status.textContent = "Running simulations…";
  els.runBtn.disabled = true;
  worker.postMessage({ type: 'run', params: p });
}

function onWorkerMessage(e){
  const msg = e.data;
  if (msg.type === 'progress'){
    els.status.textContent = msg.text;
  } else if (msg.type === 'result'){
    els.status.textContent = `Done. Sims: ${msg.sims.toLocaleString()}`;
    els.runBtn.disabled = false;
    renderAll(msg.result);
  } else if (msg.type === 'error'){
    els.status.textContent = "Error: " + msg.error;
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
  // timeline: [1..periods]
  // bands: { p5, p25, p50, p75, p95 } arrays
  const x = timeline;
  const p5 = bands.p5, p25 = bands.p25, p50 = bands.p50, p75 = bands.p75, p95 = bands.p95;

  const traceP95 = { x, y: p95, mode:'lines', line:{ width:0 }, name:'95th', showlegend:false };
  const traceP5  = { x, y: p5,  mode:'lines', fill:'tonexty', fillcolor:'rgba(106,209,255,0.08)', line:{ width:0 }, name:'5th' };
  const traceP75 = { x, y: p75, mode:'lines', line:{ width:0 }, showlegend:false };
  const traceP25 = { x, y: p25, mode:'lines', fill:'tonexty', fillcolor:'rgba(106,209,255,0.18)', line:{ width:0 }, name:'25–75%' };
  const traceMed = { x, y: p50, mode:'lines', line:{ color:'#6ad1ff', width:2 }, name:'Median' };

  Plotly.newPlot('fanChart', [traceP95, traceP5, traceP75, traceP25, traceMed], {
    title:'Cash Balance — Uncertainty Bands',
    xaxis:{ title:'Month', dtick:1, gridcolor:'rgba(255,255,255,0.06)', automargin:true },
    yaxis:{ title:'Cash ($)', gridcolor:'rgba(255,255,255,0.06)', automargin:true },
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
    }, { displayModeBar:false });
    return;
  }
  // tornado.items: [{name, deltaLow, deltaHigh}]
  const sorted = [...tornado.items].sort((a,b)=> Math.max(Math.abs(b.deltaLow), Math.abs(b.deltaHigh)) - Math.max(Math.abs(a.deltaLow), Math.abs(a.deltaHigh)));
  const names = sorted.map(d=>d.name);
  const low = sorted.map(d=> d.deltaLow * 100);   // %
  const high= sorted.map(d=> d.deltaHigh * 100);  // %

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
