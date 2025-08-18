// ------- NO WORKER VERSION (runs entirely on main thread) -------
(function(){
  const els = {};
  window.addEventListener('load', () => {
    // Cache elements
    [
      "periods","sims","seed","demandDist","demandMu","demandSigma","aov",
      "cogsPct","varCostPct","startingCash","fixedCost","dsoDays","latePayPct",
      "taxRate","shortfallThresh","runBtn","status",
      "kpiShortfall","kpiEndNeg","kpiVaR","kpiMedian",
      "fanChart","histChart","tornadoChart"
    ].forEach(id => els[id] = document.getElementById(id));

    const year = document.getElementById('year'); if (year) year.textContent = new Date().getFullYear();

    // Safety: Plotly must be present
    if (!window.Plotly) {
      alert("Plotly failed to load. Check your network or script tag.");
      return;
    }

    // Bind click
    els.runBtn.addEventListener('click', run);
    // Initial blank charts
    drawEmpty();

    // Tiny smoke test so you know the button is live
    console.log('[MC] UI ready – click "Run Simulation" to start.');
  });

  function getParams(){
    return {
      periods: clamp(parseInt(els.periods.value||"12"), 3, 60),
      sims: clamp(parseInt(els.sims.value||"10000"), 1000, 100000),
      seed: els.seed.value ? Number(els.seed.value) : null,
      demand: { dist: els.demandDist.value, mu: Number(els.demandMu.value), sigma: Number(els.demandSigma.value) },
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
    els.status.textContent = "Running…";
    els.runBtn.disabled = true;
    // Let the UI paint before crunching
    setTimeout(() => {
      try {
        const res = runSim(p);      // compute on main thread
        renderAll(res);
        els.status.textContent = `Done. Sims: ${p.sims.toLocaleString()}`;
      } catch (err) {
        console.error(err);
        els.status.textContent = "Error: " + (err.message || err);
      } finally {
        els.runBtn.disabled = false;
      }
    }, 20);
  }

  function renderAll(res){
    els.kpiShortfall.textContent = pct(res.metrics.pShortfallAny);
    els.kpiEndNeg.textContent    = pct(res.metrics.pEndCashNeg);
    els.kpiVaR.textContent       = money(res.metrics.var5);
    els.kpiMedian.textContent    = money(res.metrics.medianEnd);
    renderFan(res.bands, res.timeline);
    renderHist(res.endingCash);
    renderTornado(res.tornado);
  }

  function renderFan(bands, timeline){
    const x = timeline;
    const {p5,p25,p50,p75,p95} = bands;
    const t95 = { x, y:p95, mode:'lines', line:{width:0}, showlegend:false };
    const t5  = { x, y:p5,  mode:'lines', line:{width:0}, fill:'tonexty', fillcolor:'rgba(106,209,255,0.08)' };
    const t75 = { x, y:p75, mode:'lines', line:{width:0}, showlegend:false };
    const t25 = { x, y:p25, mode:'lines', line:{width:0}, fill:'tonexty', fillcolor:'rgba(106,209,255,0.18)', name:'25–75%' };
    const med = { x, y:p50, mode:'lines', line:{color:'#6ad1ff', width:2}, name:'Median' };
    Plotly.newPlot('fanChart', [t95,t5,t75,t25,med], {
      title:'Cash Balance — Uncertainty Bands',
      xaxis:{ title:'Month', dtick:1, gridcolor:'rgba(255,255,255,0.06)' },
      yaxis:{ title:'Cash ($)', gridcolor:'rgba(255,255,255,0.06)' },
      paper_bgcolor:'transparent', plot_bgcolor:'transparent', showlegend:true, legend:{orientation:'h'}
    }, { displayModeBar:false, responsive:true });
  }

  function renderHist(endingCash){
    const n=40, min=Math.min(...endingCash), max=Math.max(...endingCash);
    const bins = linspace(min,max,n+1), counts=new Array(n).fill(0);
    for(const v of endingCash){ const i=Math.min(n-1, Math.max(0, Math.floor((v-min)/((max-min)||1)*n))); counts[i]++; }
    const centers = bins.slice(0,-1).map((b,i)=>(b+bins[i+1])/2);
    Plotly.newPlot('histChart', [{ x:centers, y:counts, type:'bar', marker:{color:'#6ad1ff'} }], {
      title:'Distribution — Ending Cash',
      xaxis:{ title:'End cash ($)', gridcolor:'rgba(255,255,255,0.06)' },
      yaxis:{ title:'Count', gridcolor:'rgba(255,255,255,0.06)' },
      paper_bgcolor:'transparent', plot_bgcolor:'transparent', showlegend:false
    }, { displayModeBar:false, responsive:true });
  }

  function renderTornado(tornado){
    if (!tornado?.items?.length){
      Plotly.newPlot('tornadoChart', [], { title:'Sensitivity (ΔP(Shortfall))',
        paper_bgcolor:'transparent', plot_bgcolor:'transparent' }, { displayModeBar:false });
      return;
    }
    const sorted=[...tornado.items].sort((a,b)=>Math.max(Math.abs(b.deltaLow),Math.abs(b.deltaHigh)) - Math.max(Math.abs(a.deltaLow),Math.abs(a.deltaHigh)));
    const names=sorted.map(d=>d.name), low=sorted.map(d=>d.deltaLow*100), high=sorted.map(d=>d.deltaHigh*100);
    const tL={ x:low, y:names, type:'bar', orientation:'h', name:'-10%', marker:{color:'rgba(255,107,107,0.85)'} };
    const tH={ x:high,y:names, type:'bar', orientation:'h', name:'+10%', marker:{color:'rgba(66,211,146,0.85)'} };
    Plotly.newPlot('tornadoChart', [tL,tH], {
      title:'Sensitivity: ΔP(Shortfall) when varying one input ±10%',
      xaxis:{ title:'Percentage points', zeroline:true, zerolinewidth:2, gridcolor:'rgba(255,255,255,0.06)' },
      yaxis:{ automargin:true, gridcolor:'rgba(255,255,255,0.06)' },
      barmode:'overlay', paper_bgcolor:'transparent', plot_bgcolor:'transparent', showlegend:true, legend:{orientation:'h'}
    }, { displayModeBar:false, responsive:true });
  }

  function drawEmpty(){
    Plotly.newPlot('fanChart', [], {paper_bgcolor:'transparent', plot_bgcolor:'transparent'}, {displayModeBar:false});
    Plotly.newPlot('histChart', [], {paper_bgcolor:'transparent', plot_bgcolor:'transparent'}, {displayModeBar:false});
    Plotly.newPlot('tornadoChart', [], {paper_bgcolor:'transparent', plot_bgcolor:'transparent'}, {displayModeBar:false});
  }

  // -------- Monte Carlo core (same logic as worker version) --------
  function runSim(p){
    const rng = seeded(p.seed == null ? Math.floor(Math.random()*1e9) : p.seed);
    const months = clamp(p.periods|0, 3, 60);
    const sims   = clamp(p.sims|0, 1000, 100000);
    const dsoM = Math.round(p.dsoDays/30);
    const late = clamp01(p.latePayPct/100);
    const cogs = clamp01(p.cogsPct/100);
    const varc = clamp01(p.varCostPct/100);
    const tax  = clamp01(p.taxRate/100);
    const thresh = Number(p.shortfallThresh)||0;

    const timeline = Array.from({length:months},(_,i)=>i+1);
    const mat = Array.from({length:months},()=>new Float64Array(sims));
    const endCash = new Float64Array(sims);
    let shortfallAny=0, endNeg=0;

    for(let s=0;s<sims;s++){
      let cash = +p.startingCash||0;
      const rev = new Float64Array(months);
      const cost= new Float64Array(months);
      const cin = new Float64Array(months);

      for(let t=0;t<months;t++){
        const demand = sampleDemand(p.demand.dist, p.demand.mu, p.demand.sigma, rng);
        const revenue = demand * p.aov;
        const cogsCost = revenue*cogs, varCost=revenue*varc, fixed=p.fixedCost;
        const pbt = revenue - (cogsCost + varCost + fixed);
        const taxPay = pbt>0 ? tax*pbt : 0;
        rev[t]=revenue; cost[t]=(cogsCost + varCost + fixed - taxPay);
      }
      for(let t=0;t<months;t++){
        const i0 = t - dsoM, iLate = i0 - 1;
        let collect = 0;
        if (i0   >=0) collect += rev[i0]*(1-late);
        if (iLate>=0) collect += rev[iLate]*late;
        cash = cash + collect - cost[t];
        mat[t][s]=cash;
        if (cash < thresh) { shortfallAny++; break; }
      }
      endCash[s]=cash;
      if (cash<0) endNeg++;
    }

    // Percentiles across months
    const bands = { p5:[], p25:[], p50:[], p75:[], p95:[] };
    for(let t=0;t<months;t++){
      const arr = Array.from(mat[t]).sort((a,b)=>a-b);
      bands.p5.push(qSorted(arr,0.05));
      bands.p25.push(qSorted(arr,0.25));
      bands.p50.push(qSorted(arr,0.50));
      bands.p75.push(qSorted(arr,0.75));
      bands.p95.push(qSorted(arr,0.95));
    }

    const endArr = Array.from(endCash).sort((a,b)=>a-b);
    const var5 = qSorted(endArr,0.05), med = qSorted(endArr,0.50);
    const tornado = sensitivity(p, 3000); // fast

    return {
      timeline,
      bands,
      endingCash: Array.from(endCash),
      metrics:{
        pShortfallAny: shortfallAny/sims,
        pEndCashNeg: endNeg/sims,
        var5, medianEnd: med
      },
      tornado
    };
  }

  // Sensitivity (±10% one-at-a-time)
  function sensitivity(base, simsSmall){
    const params = [
      { key:'demand.mu', label:'Demand mean' },
      { key:'demand.sigma', label:'Demand std' },
      { key:'aov', label:'Average order value' },
      { key:'cogsPct', label:'COGS %' },
      { key:'varCostPct', label:'Var Opex %' },
      { key:'fixedCost', label:'Fixed cost' },
      { key:'dsoDays', label:'DSO days' }
    ];
    const baseRisk = riskShortfall(base, simsSmall);
    const items = params.map(n=>{
      const lo = riskShortfall(nudge(base,n.key,-0.10), simsSmall);
      const hi = riskShortfall(nudge(base,n.key,+0.10), simsSmall);
      return { name:n.label, deltaLow:lo-baseRisk, deltaHigh:hi-baseRisk };
    });
    return { base: baseRisk, items };
  }
  function nudge(obj, dotted, frac){
    const copy = JSON.parse(JSON.stringify(obj));
    const parts = dotted.split('.'); let ref = copy;
    for(let i=0;i<parts.length-1;i++) ref = ref[parts[i]];
    const k = parts.at(-1); let v = ref[k];
    if (typeof v==='number'){ v = v*(1+frac);
      if (k.includes('Pct')) v = clamp(v, 0, 100);
      if (k==='dsoDays') v = clamp(v, 0, 120);
      if (k==='sigma' && v<=0) v = 1e-6;
      ref[k]=v;
    }
    return copy;
  }
  function riskShortfall(p, sims){
    const rng = seeded(1234567);
    const months = clamp(p.periods|0, 3, 60);
    const dsoM = Math.round(p.dsoDays/30);
    const late = clamp01(p.latePayPct/100);
    const cogs = clamp01(p.cogsPct/100);
    const varc = clamp01(p.varCostPct/100);
    const tax  = clamp01(p.taxRate/100);
    const thr  = Number(p.shortfallThresh)||0;
    let short=0;
    for(let s=0;s<sims;s++){
      let cash = +p.startingCash||0;
      const rev=new Float64Array(months), cost=new Float64Array(months);
      for(let t=0;t<months;t++){
        const demand = sampleDemand(p.demand.dist, p.demand.mu, p.demand.sigma, rng);
        const revenue = demand * p.aov;
        const cogsCost = revenue*cogs, varCost=revenue*varc, fixed=p.fixedCost;
        const pbt = revenue - (cogsCost + varCost + fixed);
        const taxPay = pbt>0 ? tax*pbt : 0;
        rev[t]=revenue; cost[t]=(cogsCost + varCost + fixed - taxPay);
      }
      for(let t=0;t<months;t++){
        const i0=t-dsoM, iLate=i0-1; let collect=0;
        if (i0>=0) collect += rev[i0]*(1-late);
        if (iLate>=0) collect += rev[iLate]*late;
        cash = cash + collect - cost[t];
        if (cash < thr){ short++; break; }
      }
    }
    return short/sims;
  }

  // --- RNG & distributions ---
  function seeded(seed){ if (seed==null) seed=Math.floor(Math.random()*2**31); return mulberry32(seed); }
  function mulberry32(seed){ let t=seed>>>0; return function(){ t|=0; t=t+0x6D2B79F5|0; let r=Math.imul(t^t>>>15,1|t)+Math.imul(t^t>>>7,61|t)^t; return ((r^r>>>14)>>>0)/4294967296; }; }
  function randn(rng){ let u=0,v=0; while(u===0) u=rng(); while(v===0) v=rng(); return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v); }
  function sampleDemand(dist, mu, sigma, rng){
    if (dist==='poisson'){ const L=Math.exp(-Math.max(0,mu)); let k=0,p=1; do{ k++; p*=rng(); } while(p>L); return k-1; }
    if (dist==='lognormal'){ const m=Math.max(1e-9,mu), s=Math.max(1e-9,sigma);
      const phi=Math.sqrt(1+(s*s)/(m*m)); const muL=Math.log(m/phi); const sigmaL=Math.sqrt(Math.log(phi*phi));
      return Math.max(0, Math.exp(muL + sigmaL*randn(rng)));
    }
    return Math.max(0, mu + sigma*randn(rng)); // normal truncated at 0
  }

  // --- Utils ---
  const clamp = (x,min,max)=> Math.max(min, Math.min(max, x));
  const clamp01 = x => Math.max(0, Math.min(1, x));
  const pct = v => (v*100).toFixed(1) + '%';
  const money = v => (v>=0? '$':'-$') + Math.abs(v).toLocaleString(undefined,{maximumFractionDigits:0});
  const linspace = (a,b,n)=> Array.from({length:n},(_,i)=> a + (i*(b-a)/(n-1)));
  function qSorted(arr,q){ const n=arr.length; if(!n) return NaN; const pos=(n-1)*q, base=Math.floor(pos), rest=pos-base; return arr[base+1]!==undefined ? arr[base] + rest*(arr[base+1]-arr[base]) : arr[base]; }

})();
