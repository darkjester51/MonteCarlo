// Monte Carlo core (runs in a Web Worker)
self.onmessage = (e) => {
  try {
    const { type, params } = e.data || {};
    if (type !== 'run') return;
    const res = runSim(params);
    self.postMessage({ type: 'result', sims: params.sims, result: res });
  } catch (err) {
    self.postMessage({ type: 'error', error: String(err?.message || err) });
  }
};

/* ------------ RNG (seeded) & distributions ------------- */
function mulberry32(seed) {
  let t = seed >>> 0;
  return function() {
    t |= 0; t = t + 0x6D2B79F5 | 0;
    let r = Math.imul(t ^ t >>> 15, 1 | t) + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((r ^ r >>> 14) >>> 0) / 4294967296;
  };
}
function seeded(seed){
  if (seed == null) seed = Math.floor(Math.random()*2**31);
  return mulberry32(seed);
}
function randn(rng){ // Box–Muller
  let u=0, v=0;
  while(u===0) u = rng();
  while(v===0) v = rng();
  return Math.sqrt(-2.0*Math.log(u)) * Math.cos(2.0*Math.PI*v);
}
function sampleDemand(dist, mu, sigma, rng){
  if (dist === 'poisson'){
    // Knuth
    const L = Math.exp(-Math.max(0, mu));
    let k = 0, p = 1;
    do { k++; p *= rng(); } while (p > L);
    return k-1;
  } else if (dist === 'lognormal'){
    // treat mu as mean of underlying normal? Simpler: use log-space params from mean/sd approx
    const m = Math.max(1e-9, mu);
    const s = Math.max(1e-9, sigma);
    const phi = Math.sqrt(1 + (s*s)/(m*m));
    const muL = Math.log(m / phi);
    const sigmaL = Math.sqrt(Math.log(phi*phi));
    const z = randn(rng);
    return Math.max(0, Math.exp(muL + sigmaL*z));
  } else {
    // normal truncated at 0
    const z = randn(rng);
    return Math.max(0, mu + sigma*z);
  }
}

/* ------------- Core simulation ---------------- */
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
  const mat = Array.from({length: months}, () => new Float64Array(sims)); // cash paths per month
  const endCash = new Float64Array(sims);
  let shortfallAny = 0;
  let endNeg = 0;

  for (let s=0; s<sims; s++){
    let cash = Number(p.startingCash)||0;
    const rev = new Float64Array(months);
    const cost = new Float64Array(months);
    const cashIn = new Float64Array(months);

    // generate revenue & costs
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

    // cash timing: revenue collected after dsoMonths; lateShare delayed one more month
    for (let t=0; t<months; t++){
      const baseIdx = t - dsoMonths;
      const lateIdx = baseIdx - 1; // additional month for late payments
      let collect = 0;
      if (baseIdx >= 0) collect += rev[baseIdx] * (1 - lateShare);
      if (lateIdx >= 0) collect += rev[lateIdx] * lateShare;
      cashIn[t] = collect;
    }

    // cash balance
    let anyShortfall = false;
    for (let t=0; t<months; t++){
      cash = cash + cashIn[t] - cost[t];
      mat[t][s] = cash;
      if (cash < shortfallThresh) anyShortfall = true;
    }
    endCash[s] = cash;
    if (anyShortfall) shortfallAny++;
    if (cash < 0) endNeg++;
  }

  // Percentile bands across months
  const pcts = [5, 25, 50, 75, 95];
  const bands = { p5:[], p25:[], p50:[], p75:[], p95:[] };
  for (let t=0; t<months; t++){
    const arr = Array.from(mat[t]); arr.sort((a,b)=>a-b);
    const q = quantilesFromSorted(arr, pcts);
    bands.p5.push(q[0]); bands.p25.push(q[1]); bands.p50.push(q[2]); bands.p75.push(q[3]); bands.p95.push(q[4]);
  }

  // KPIs on end cash
  const endArr = Array.from(endCash).sort((a,b)=>a-b);
  const var5 = quantileFromSorted(endArr, 0.05);
  const med  = quantileFromSorted(endArr, 0.50);
  const mean = endArr.reduce((s,x)=>s+x,0) / sims;

  // Sensitivity tornado (±10%, fewer sims for speed)
  const tornado = sensitivityTornado(p, 3000, rng);

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

/* ---------- Sensitivity (one-at-a-time ±10%) ---------- */
function sensitivityTornado(base, simsSmall, rngSeed){
  const names = [
    { key:'demand.mu', label:'Demand mean' },
    { key:'demand.sigma', label:'Demand std' },
    { key:'aov', label:'Average order value' },
    { key:'cogsPct', label:'COGS %' },
    { key:'varCostPct', label:'Var Opex %' },
    { key:'fixedCost', label:'Fixed cost' },
    { key:'dsoDays', label:'DSO days' }
  ];
  const baseRisk = riskShortfall(base, simsSmall, rngSeed);
  const items = names.map(n=>{
    const loP = riskShortfall(nudge(base, n.key, -0.10), simsSmall, rngSeed);
    const hiP = riskShortfall(nudge(base, n.key, +0.10), simsSmall, rngSeed);
    return { name: n.label, deltaLow: loP - baseRisk, deltaHigh: hiP - baseRisk };
  });
  return { base: baseRisk, items };
}
function nudge(obj, dotted, frac){
  const clone = JSON.parse(JSON.stringify(obj));
  const parts = dotted.split('.');
  let ref = clone;
  for (let i=0;i<parts.length-1;i++) ref = ref[parts[i]];
  const k = parts.at(-1);
  const v = ref[k];
  if (typeof v === 'number'){
    let nv = v * (1 + frac);
    if (k.includes('Pct')) nv = Math.max(0, Math.min(100, nv));
    if (k === 'dsoDays') nv = Math.max(0, Math.min(120, nv));
    if (k === 'sigma' && nv <= 0) nv = 1e-6;
    ref[k] = nv;
  }
  return clone;
}
function riskShortfall(p, sims, rngSeed){
  const rng = seeded(rngSeed ? Math.floor(rngSeed()*1e9) : Math.floor(Math.random()*1e9));
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
      if (cash < thresh){ shortfallAny++; break; }
    }
  }
  return shortfallAny / sims;
}

/* ----------------- Quantiles ------------------ */
function quantilesFromSorted(arr, pcts){
  return pcts.map(p => quantileFromSorted(arr, p/100));
}
function quantileFromSorted(arr, q){
  const n = arr.length;
  if (n === 0) return NaN;
  const pos = (n - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (arr[base+1] !== undefined) return arr[base] + rest * (arr[base+1] - arr[base]);
  return arr[base];
}
