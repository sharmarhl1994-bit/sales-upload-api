const XLSX = require('xlsx');

const wb1     = XLSX.readFile('C:/Users/I546253/Downloads/EBO_FY_26-27_AOP_with_FY26-27_plan_target v1.0 (1) (1).xlsx');
const wb2     = XLSX.readFile('C:/Users/I546253/Downloads/FY2026_Forecast (1).xlsx');
const actual  = XLSX.utils.sheet_to_json(wb1.Sheets['FY 26-27 Apr-Sep Actual'], { header: 1 });

// Detect sheet name — might be "FY2026 Forecast" or "FY2027 Forecast" etc.
const fcSheetName = wb2.SheetNames.find(s => s.toLowerCase().includes('forecast')) || wb2.SheetNames[0];
const fcData  = XLSX.utils.sheet_to_json(wb2.Sheets[fcSheetName], { header: 1 });

const MONTHS = ['apr','may','jun','jul','aug','sep'];
const MHD    = ['APR','MAY','JUN','JUL','AUG','SEP'];

// ── Parse actual ────────────────────────────────────────────────
const ACT = {};
actual.slice(1).forEach(r => {
  if (!r[0] || String(r[0]).length > 20) return;
  const c = String(r[0]).trim();
  ACT[c] = { name:r[1], zone:r[2], region:r[3], grade:r[4], store_type:r[5], channel:r[6], status:r[7],
    apr:+r[8]||0, may:+r[9]||0, jun:+r[10]||0, jul:+r[11]||0, aug:+r[12]||0, sep:+r[13]||0 };
});

// ── Detect APR column in forecast export ────────────────────────
// Header row should have "APR" somewhere; find its index
const hdrRow = fcData[0] || [];
let aprCol = hdrRow.findIndex(h => String(h||'').toUpperCase() === 'APR');
if (aprCol < 0) aprCol = 9;  // fallback to known col
const totalCol = hdrRow.findIndex(h => String(h||'').toUpperCase() === 'TOTAL');
const yoyCol   = totalCol + 1;
const confCol  = totalCol + 2;

// ── Parse forecast ──────────────────────────────────────────────
const FC = {};
fcData.slice(1).forEach(r => {
  if (!r[0] || String(r[0]).trim() === 'TOTAL' || String(r[0]).trim() === 'Code') return;
  const c = String(r[0]).trim();
  FC[c] = {
    apr: +r[aprCol]   ||0, may: +r[aprCol+1] ||0, jun: +r[aprCol+2] ||0,
    jul: +r[aprCol+3] ||0, aug: +r[aprCol+4] ||0, sep: +r[aprCol+5] ||0,
    annualFc: totalCol >= 0 ? +r[totalCol]||0 : 0,
    growth:   +r[yoyCol]||0,
    rating:   r[confCol] || '',
    // also grab grade/zone/channel/status from forecast file itself (cols 4-7)
    fcGrade: r[4]||'', fcChannel: r[6]||'', fcStatus: r[7]||''
  };
});

const matched   = Object.keys(ACT).filter(c => FC[c]);
const unmatchedAct = Object.keys(ACT).filter(c => !FC[c]);
const unmatchedFc  = Object.keys(FC).filter(c => !ACT[c]);

// ── Per-store analysis ──────────────────────────────────────────
const rows = matched.map(code => {
  const a = ACT[code], f = FC[code];
  const actH1  = MONTHS.reduce((s,m) => s + a[m], 0);
  const fcH1   = MONTHS.reduce((s,m) => s + f[m], 0);
  const devAbs = actH1 - fcH1;
  const devPct = fcH1 !== 0 ? +((devAbs / Math.abs(fcH1)) * 100).toFixed(1) : null;

  const mDev = {};
  MONTHS.forEach(m => { mDev[m] = f[m] !== 0 ? +((a[m]-f[m])/Math.abs(f[m])*100).toFixed(1) : null; });

  const zeroFcMonths = MONTHS.filter(m => f[m] === 0 && a[m] > 0).length;
  const isNewStore   = zeroFcMonths >= 3 || (a.status||'').toLowerCase().includes('new');

  let reason = '';
  if (isNewStore)                      reason = 'New store — peer-based / limited history';
  else if (devPct === null)            reason = 'No forecast data';
  else if (devPct > 30)                reason = 'Store outperformed: ramp-up / events / location uplift';
  else if (devPct < -50)               reason = 'Severe underperformance: closure / long renovation';
  else if (devPct < -20)               reason = 'Underperformed: footfall / competition / market slowdown';
  else if (Math.abs(devPct) <= 10)     reason = 'On track ✓';
  else if (devPct < 0)                 reason = 'Slight underperformance: seasonality or local factor';
  else                                 reason = 'Slight overperformance';

  return {
    code, name:a.name, zone:a.zone, region:a.region, grade:a.grade,
    store_type:a.store_type, channel:a.channel, status:a.status, isNewStore,
    ...MONTHS.reduce((acc,m)=>({...acc,[`act_${m}`]:a[m],[`fc_${m}`]:f[m],[`dev_${m}pct`]:mDev[m]}),{}),
    actH1, fcH1, devAbs: Math.round(devAbs), devPct, reason,
    annualFc: f.annualFc, rating: f.rating
  };
});
rows.sort((a,b) => (a.devPct??0) - (b.devPct??0));

const totA = rows.reduce((s,r)=>s+r.actH1,0);
const totF = rows.reduce((s,r)=>s+r.fcH1,0);
const portfolioDev = +((totA-totF)/Math.abs(totF)*100).toFixed(1);

// ── Sheet 1: Store-wise deviation ──────────────────────────────
const s1hdr = ['Code','Name','Zone','Region','Grade','Type','Channel','Status','New?',
  ...MHD.flatMap(m=>[`Act ${m}`,`Fc ${m}`,`Dev% ${m}`]),
  'Act H1','Fc H1','Dev Abs (₹)','Dev% H1','Reason','Annual FC','Confidence'];

const s1data = [s1hdr, ...rows.map(r => [
  r.code, r.name, r.zone, r.region, r.grade, r.store_type, r.channel, r.status,
  r.isNewStore ? 'Y' : 'N',
  ...MONTHS.flatMap(m => [r[`act_${m}`], r[`fc_${m}`], r[`dev_${m}pct`] != null ? r[`dev_${m}pct`]/100 : null]),
  r.actH1, r.fcH1, r.devAbs, r.devPct != null ? r.devPct/100 : null, r.reason, r.annualFc, r.rating
])];

s1data.push(['TOTAL','ALL','','','','','','','',
  ...MONTHS.flatMap(m => [
    Math.round(rows.reduce((s,r)=>s+r[`act_${m}`],0)),
    Math.round(rows.reduce((s,r)=>s+r[`fc_${m}`],0)), null
  ]),
  Math.round(totA), Math.round(totF),
  Math.round(totA-totF), portfolioDev/100, '','',''
]);

const ws1 = XLSX.utils.aoa_to_sheet(s1data);
ws1['!cols'] = [{wch:7},{wch:28},{wch:10},{wch:10},{wch:7},{wch:8},{wch:7},{wch:8},{wch:5},
  ...Array(18).fill({wch:10}), {wch:11},{wch:11},{wch:13},{wch:8},{wch:40},{wch:12},{wch:10}];

// ── Sheet 2: Grade summary ──────────────────────────────────────
const grades = [...new Set(rows.map(r=>r.grade).filter(Boolean))].sort();
const gSummary = [
  ['Grade-wise Summary — Apr-Sep FY26-27  |  Previous baseline: C+ was −11%, A++ was +24%'],
  [],
  ['Grade','Stores','Actual H1 (Cr)','Forecast H1 (Cr)','Dev Abs (Cr)','Dev %',
   'On-Track (±10%)','Over-Fc (>+10%)','Under-Fc (<-10%)','Prev Dev%','Change vs Prev','Status']
];

// Known previous deviations (before grade factors) for comparison
const PREV_DEV = {
  'A+++': -7, 'A++': +24, 'A+': +7, 'A': -3, 'B+': +1, 'B': -1,
  'C+': -11, 'C': -23, 'FO/A': +21, 'FO/B': +30, 'FO/B+': +7,
  'FO/C+': -13, 'FO/C': -35, 'A+B/A++': -15, 'A+B/B': -14, 'A+B/B+': -16, 'A+B/C': +7, 'A+B/C+': -13
};

grades.forEach(g => {
  const gr = rows.filter(r=>r.grade===g);
  const gA = gr.reduce((s,r)=>s+r.actH1,0);
  const gF = gr.reduce((s,r)=>s+r.fcH1,0);
  const dev = gF !== 0 ? +((gA-gF)/Math.abs(gF)*100).toFixed(1) : null;
  const prevDev = PREV_DEV[g] ?? '—';
  const change = (dev !== null && prevDev !== '—') ? +(dev - prevDev).toFixed(1) : '—';
  const status = dev === null ? '—'
    : Math.abs(dev) <= 10 ? '✅ On Track'
    : dev < 0 ? '⚠ Over-forecast' : '⚠ Under-forecast';

  gSummary.push([
    g, gr.length, +(gA/1e7).toFixed(2), +(gF/1e7).toFixed(2),
    +((gA-gF)/1e7).toFixed(2), dev != null ? dev/100 : null,
    gr.filter(r=>r.devPct!=null && Math.abs(r.devPct)<=10).length,
    gr.filter(r=>r.devPct!=null && r.devPct>10).length,
    gr.filter(r=>r.devPct!=null && r.devPct<-10).length,
    prevDev !== '—' ? prevDev/100 : '—',
    change !== '—' ? change/100 : '—',
    status
  ]);
});
// total
gSummary.push(['ALL', rows.length, +(totA/1e7).toFixed(2), +(totF/1e7).toFixed(2),
  +((totA-totF)/1e7).toFixed(2), portfolioDev/100,
  rows.filter(r=>r.devPct!=null && Math.abs(r.devPct)<=10).length,
  rows.filter(r=>r.devPct!=null && r.devPct>10).length,
  rows.filter(r=>r.devPct!=null && r.devPct<-10).length,
  '—', '—', Math.abs(portfolioDev)<=10 ? '✅ Portfolio OK' : '⚠ Check']);

const ws2 = XLSX.utils.aoa_to_sheet(gSummary);
ws2['!cols'] = [{wch:10},{wch:7},{wch:14},{wch:15},{wch:13},{wch:8},{wch:15},{wch:15},{wch:15},{wch:10},{wch:14},{wch:14}];

// ── Sheet 3: Zone summary ──────────────────────────────────────
const zones = [...new Set(rows.map(r=>r.zone).filter(Boolean))].sort();
const zSummary = [
  ['Zone-wise Summary — Apr-Sep FY26-27'],
  [],
  ['Zone','Stores','Actual H1 (Cr)','Forecast H1 (Cr)','Dev Abs (Cr)','Dev% H1',
   'On-Track','Over-Fc','Under-Fc','Grades in Zone']
];
zones.forEach(z => {
  const zr = rows.filter(r=>r.zone===z);
  const zA = zr.reduce((s,r)=>s+r.actH1,0);
  const zF = zr.reduce((s,r)=>s+r.fcH1,0);
  const dev = zF !== 0 ? (zA-zF)/Math.abs(zF) : null;
  const gradeList = [...new Set(zr.map(r=>r.grade).filter(Boolean))].sort().join(', ');
  zSummary.push([z, zr.length, +(zA/1e7).toFixed(2), +(zF/1e7).toFixed(2),
    +((zA-zF)/1e7).toFixed(2), dev,
    zr.filter(r=>r.devPct!=null && Math.abs(r.devPct)<=10).length,
    zr.filter(r=>r.devPct!=null && r.devPct>10).length,
    zr.filter(r=>r.devPct!=null && r.devPct<-10).length,
    gradeList
  ]);
});
const ws3 = XLSX.utils.aoa_to_sheet(zSummary);
ws3['!cols'] = [{wch:10},{wch:7},{wch:14},{wch:15},{wch:13},{wch:8},{wch:10},{wch:10},{wch:10},{wch:35}];

// ── Sheet 4: New stores ────────────────────────────────────────
const newRows = rows.filter(r=>r.isNewStore);
const l2lRows = rows.filter(r=>!r.isNewStore);
const nSummary = [
  [`New / Renovation Stores — ${newRows.length} stores`],
  [],
  ['Code','Name','Zone','Grade','Channel','Status',
   'Actual H1','Forecast H1','Dev Abs','Dev %','Monthly Actual Pattern']
];
newRows.forEach(r => {
  const mPat = MONTHS.map(m => Math.round(r[`act_${m}`]/1000)+'K').join(' | ');
  nSummary.push([
    r.code, r.name, r.zone, r.grade, r.channel, r.status,
    r.actH1, r.fcH1, r.devAbs, r.devPct != null ? r.devPct/100 : null, mPat
  ]);
});
// aggregate
const nA = newRows.reduce((s,r)=>s+r.actH1,0);
const nF = newRows.reduce((s,r)=>s+r.fcH1,0);
nSummary.push(['TOTAL NEW','','','','','', Math.round(nA), Math.round(nF),
  Math.round(nA-nF), nF !== 0 ? (nA-nF)/Math.abs(nF) : null, '']);
nSummary.push([]);
nSummary.push(['L2L Portfolio summary']);
const lA = l2lRows.reduce((s,r)=>s+r.actH1,0);
const lF = l2lRows.reduce((s,r)=>s+r.fcH1,0);
nSummary.push(['L2L Stores', l2lRows.length, '', '', '', '', Math.round(lA), Math.round(lF),
  Math.round(lA-lF), lF !== 0 ? (lA-lF)/Math.abs(lF) : null, '']);

const ws4 = XLSX.utils.aoa_to_sheet(nSummary);
ws4['!cols'] = [{wch:7},{wch:28},{wch:10},{wch:7},{wch:8},{wch:8},
  {wch:12},{wch:12},{wch:12},{wch:8},{wch:55}];

// ── Sheet 5: Month summary ──────────────────────────────────────
const mSummary = [
  ['Month-wise Portfolio — Apr-Sep FY26-27'],
  [],
  ['Month','Actual (Cr)','Forecast (Cr)','Deviation (Cr)','Dev %','Assessment'],
];
MONTHS.forEach((m, i) => {
  const tA = rows.reduce((s,r)=>s+r[`act_${m}`],0);
  const tF = rows.reduce((s,r)=>s+r[`fc_${m}`],0);
  const d  = tA - tF;
  const p  = tF !== 0 ? d/Math.abs(tF) : 0;
  mSummary.push([MHD[i], +(tA/1e7).toFixed(2), +(tF/1e7).toFixed(2), +(d/1e7).toFixed(2), p,
    Math.abs(p*100) <= 10 ? 'ON TRACK ✓' : p < 0 ? 'OVER-FORECAST' : 'UNDER-FORECAST']);
});
mSummary.push(['H1 TOTAL', +(totA/1e7).toFixed(2), +(totF/1e7).toFixed(2),
  +((totA-totF)/1e7).toFixed(2), (totA-totF)/Math.abs(totF), '']);
const ws5 = XLSX.utils.aoa_to_sheet(mSummary);
ws5['!cols'] = [{wch:10},{wch:14},{wch:14},{wch:14},{wch:10},{wch:18}];

// ── Write workbook ──────────────────────────────────────────────
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws1, 'Store Deviation');
XLSX.utils.book_append_sheet(wb, ws2, 'Grade Summary');
XLSX.utils.book_append_sheet(wb, ws3, 'Zone Summary');
XLSX.utils.book_append_sheet(wb, ws4, 'New Stores');
XLSX.utils.book_append_sheet(wb, ws5, 'Month Summary');
XLSX.writeFile(wb, 'C:/Users/I546253/Downloads/FY26-27_Deviation_v2.xlsx');

// ── Console output ──────────────────────────────────────────────
const bar = (v, max, w=25) => {
  const filled = Math.round(Math.abs(v)/max*w);
  return (v<0?'📉':'📈') + '▓'.repeat(filled) + '░'.repeat(w-filled);
};
const fmt = n => (n>=0?'+':'')+n.toFixed(1)+'%';

console.log('\n══════════════════════════════════════════════════════');
console.log('  FY26-27 Apr-Sep  |  Actual vs Forecast (New Run)');
console.log('══════════════════════════════════════════════════════');
console.log(`  Stores in actual  : ${Object.keys(ACT).length}`);
console.log(`  Stores in forecast: ${Object.keys(FC).length}`);
console.log(`  Matched           : ${matched.length}`);
console.log(`  In actual only    : ${unmatchedAct.length}  ${unmatchedAct.slice(0,5).join(', ')}`);
console.log(`  In forecast only  : ${unmatchedFc.length}   ${unmatchedFc.slice(0,5).join(', ')}`);
console.log('');
console.log('  PORTFOLIO');
console.log(`  Actual   : ₹${(totA/1e7).toFixed(2)} Cr`);
console.log(`  Forecast : ₹${(totF/1e7).toFixed(2)} Cr`);
console.log(`  Deviation: ${fmt(portfolioDev)}  (${portfolioDev>0?'under-forecast':'over-forecast'})`);
console.log(`  Previous : -1.7%  |  Change: ${fmt(portfolioDev - (-1.7))}`);
console.log('');

console.log('  GRADE BREAKDOWN');
console.log('  Grade      Stores  Actual Cr  Fcst Cr  Dev%    vs Prev');
console.log('  ─────────────────────────────────────────────────────');
grades.forEach(g => {
  const gr = rows.filter(r=>r.grade===g);
  const gA = gr.reduce((s,r)=>s+r.actH1,0);
  const gF = gr.reduce((s,r)=>s+r.fcH1,0);
  const dev = gF !== 0 ? +((gA-gF)/Math.abs(gF)*100).toFixed(1) : 0;
  const prev = PREV_DEV[g];
  const chg = prev !== undefined ? ` | was ${prev>0?'+':''}${prev}%  Δ${fmt(dev-prev)}` : '';
  const flag = Math.abs(dev)<=10 ? '✅' : dev>10 ? '⬆' : '⬇';
  console.log(`  ${flag} ${g.padEnd(10)} ${String(gr.length).padStart(4)}  ${(gA/1e7).toFixed(2).padStart(8)}   ${(gF/1e7).toFixed(2).padStart(7)}  ${fmt(dev).padStart(7)}${chg}`);
});

console.log('');
console.log('  ZONE BREAKDOWN');
zones.forEach(z => {
  const zr = rows.filter(r=>r.zone===z);
  const zA = zr.reduce((s,r)=>s+r.actH1,0);
  const zF = zr.reduce((s,r)=>s+r.fcH1,0);
  const dev = zF !== 0 ? +((zA-zF)/Math.abs(zF)*100).toFixed(1) : 0;
  const flag = Math.abs(dev)<=10?'✅':dev>10?'⬆':'⬇';
  console.log(`  ${flag} ${z.padEnd(12)} ${String(zr.length).padStart(3)} stores | Actual ₹${(zA/1e7).toFixed(2)}Cr | Dev ${fmt(dev)}`);
});

console.log('');
console.log('  NEW STORES');
console.log(`  Count  : ${newRows.length}`);
const nA2 = newRows.reduce((s,r)=>s+r.actH1,0);
const nF2 = newRows.reduce((s,r)=>s+r.fcH1,0);
console.log(`  Actual : ₹${(nA2/1e7).toFixed(2)} Cr`);
console.log(`  Fcst   : ₹${(nF2/1e7).toFixed(2)} Cr`);
console.log(`  Dev    : ${nF2!==0 ? fmt((nA2-nF2)/Math.abs(nF2)*100) : 'N/A'}  (Previous: +544%)`);

console.log('');
console.log('  STORE ACCURACY DISTRIBUTION');
const tiers = [
  ['Within ±5%',  r=>r.devPct!=null && Math.abs(r.devPct)<=5],
  ['Within ±10%', r=>r.devPct!=null && Math.abs(r.devPct)<=10],
  ['Within ±20%', r=>r.devPct!=null && Math.abs(r.devPct)<=20],
  ['>20% off',    r=>r.devPct!=null && Math.abs(r.devPct)>20],
];
tiers.forEach(([label, fn]) => {
  const n = rows.filter(fn).length;
  const pct = (n/rows.length*100).toFixed(0);
  console.log(`  ${label.padEnd(14)}: ${String(n).padStart(3)} stores (${pct}%)`);
});

console.log('');
console.log(`  Excel saved → FY26-27_Deviation_v2.xlsx (5 sheets)`);
console.log('══════════════════════════════════════════════════════\n');
