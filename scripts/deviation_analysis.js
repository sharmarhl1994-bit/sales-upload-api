const XLSX = require('xlsx');

const wb1     = XLSX.readFile('C:/Users/I546253/Downloads/EBO_FY_26-27_AOP_with_FY26-27_plan_target v1.0 (1) (1).xlsx');
const wb2     = XLSX.readFile('C:/Users/I546253/Downloads/FY2026_Forecast.xlsx');
const actual  = XLSX.utils.sheet_to_json(wb1.Sheets['FY 26-27 Apr-Sep Actual'], { header: 1 });
const fcData  = XLSX.utils.sheet_to_json(wb2.Sheets['FY2026 Forecast'],         { header: 1 });

const MONTHS = ['apr','may','jun','jul','aug','sep'];
const MHD    = ['APR','MAY','JUN','JUL','AUG','SEP'];

// Parse actual
const ACT = {};
actual.slice(1).forEach(r => {
  if (!r[0] || String(r[0]).length > 20) return;
  const c = String(r[0]).trim();
  ACT[c] = { name:r[1], zone:r[2], region:r[3], grade:r[4], store_type:r[5], channel:r[6], status:r[7],
    apr:r[8]||0, may:r[9]||0, jun:r[10]||0, jul:r[11]||0, aug:r[12]||0, sep:r[13]||0 };
});

// Parse forecast — new export: header row 0, APR at col 9, no code remapping needed
const FC = {};
fcData.slice(1).forEach(r => {
  if (!r[0] || r[0]==='TOTAL') return;
  const c = String(r[0]).trim();
  FC[c] = { apr:r[9]||0, may:r[10]||0, jun:r[11]||0, jul:r[12]||0, aug:r[13]||0, sep:r[14]||0,
    annualFc:r[21]||0, growth:r[22], rating:r[23] };
});

const matched = Object.keys(ACT).filter(c => FC[c]);

// Build per-store analysis
const rows = matched.map(code => {
  const a = ACT[code], f = FC[code];
  const actH1  = MONTHS.reduce((s,m) => s + a[m], 0);
  const fcH1   = MONTHS.reduce((s,m) => s + f[m], 0);
  const devAbs = actH1 - fcH1;
  const devPct = fcH1 !== 0 ? +((devAbs / Math.abs(fcH1)) * 100).toFixed(1) : 0;

  // Per-month deviation
  const mDev = {};
  MONTHS.forEach(m => { mDev[m] = f[m] !== 0 ? +((a[m]-f[m])/Math.abs(f[m])*100).toFixed(1) : null; });

  // Classify reason
  let reason = '';
  const zeroFcMonths = MONTHS.filter(m => f[m] === 0 && a[m] > 0).length;
  if (zeroFcMonths >= 3)           reason = 'New store — not in forecast plan';
  else if (devPct > 30)            reason = 'Store outperformed: new opening / ramp-up / events';
  else if (devPct < -50)           reason = 'Store severely underperformed: possible closure / renovation / inactive';
  else if (devPct < -20)           reason = 'Underperformed: lower footfall / market slowdown / competition';
  else if (Math.abs(devPct) <= 10) reason = 'On track';
  else if (devPct < 0)             reason = 'Slight underperformance: seasonality mismatch';
  else                             reason = 'Slight overperformance';

  return { code, name:a.name, zone:a.zone, region:a.region, grade:a.grade,
    store_type:a.store_type, channel:a.channel, status:a.status,
    ...MONTHS.reduce((acc,m)=>({...acc,[`act_${m}`]:a[m],[`fc_${m}`]:f[m],[`dev_${m}pct`]:mDev[m]}),{}),
    actH1, fcH1, devAbs: Math.round(devAbs), devPct, reason,
    annualFc: f.annualFc, rating: f.rating };
});

rows.sort((a,b) => a.devPct - b.devPct);   // worst underperformers first

// ── Sheet 1: Store-wise deviation ──────────────────────────────
const s1hdr = ['Code','Name','Zone','Region','Grade','Type','Channel','Status',
  ...MHD.flatMap(m=>[`Act ${m}`,`Fc ${m}`,`Dev% ${m}`]),
  'Act H1','Fc H1','Dev Abs','Dev% H1','Reason','Annual FC','Rating'];

const s1data = [s1hdr, ...rows.map(r => [
  r.code, r.name, r.zone, r.region, r.grade, r.store_type, r.channel, r.status,
  ...MONTHS.flatMap(m => [r[`act_${m}`], r[`fc_${m}`], r[`dev_${m}pct`] != null ? r[`dev_${m}pct`]/100 : null]),
  r.actH1, r.fcH1, r.devAbs, r.devPct/100, r.reason, r.annualFc, r.rating
])];

// Total row
const totRow = ['TOTAL','ALL','','','','','','',
  ...MONTHS.flatMap(m => [
    Math.round(rows.reduce((s,r)=>s+r[`act_${m}`],0)),
    Math.round(rows.reduce((s,r)=>s+r[`fc_${m}`],0)),
    null
  ]),
  Math.round(rows.reduce((s,r)=>s+r.actH1,0)),
  Math.round(rows.reduce((s,r)=>s+r.fcH1,0)),
  Math.round(rows.reduce((s,r)=>s+r.devAbs,0)),
  +((rows.reduce((s,r)=>s+r.actH1,0)-rows.reduce((s,r)=>s+r.fcH1,0))/rows.reduce((s,r)=>s+r.fcH1,0)*100).toFixed(1)/100,
  '','',''
];
s1data.push(totRow);

const ws1 = XLSX.utils.aoa_to_sheet(s1data);
ws1['!cols'] = [{wch:7},{wch:28},{wch:10},{wch:10},{wch:6},{wch:8},{wch:7},{wch:6},
  ...Array(18).fill({wch:11}), {wch:10},{wch:10},{wch:11},{wch:8},{wch:38},{wch:11},{wch:8}];

// ── Sheet 2: Month-wise portfolio summary ──────────────────────
const mSummary = [
  ['Month-wise Portfolio: Actual vs Forecast (Apr-Sep FY26-27)'],
  [],
  ['Month','Actual (Cr)','Forecast (Cr)','Deviation (Cr)','Deviation %','Assessment'],
];
MONTHS.forEach((m, i) => {
  const tA = rows.reduce((s,r)=>s+r[`act_${m}`],0);
  const tF = rows.reduce((s,r)=>s+r[`fc_${m}`],0);
  const d  = tA - tF;
  const p  = tF !== 0 ? d/Math.abs(tF) : 0;
  mSummary.push([MHD[i], +(tA/1e7).toFixed(2), +(tF/1e7).toFixed(2), +(d/1e7).toFixed(2), p,
    Math.abs(p) <= 0.10 ? 'ON TRACK' : p < 0 ? 'OVER-FORECAST' : 'UNDER-FORECAST']);
});
const totA = rows.reduce((s,r)=>s+r.actH1,0);
const totF = rows.reduce((s,r)=>s+r.fcH1,0);
mSummary.push(['H1 TOTAL', +(totA/1e7).toFixed(2), +(totF/1e7).toFixed(2),
  +((totA-totF)/1e7).toFixed(2), (totA-totF)/Math.abs(totF), '']);

const ws2 = XLSX.utils.aoa_to_sheet(mSummary);
ws2['!cols'] = [{wch:8},{wch:14},{wch:14},{wch:14},{wch:12},{wch:16}];

// ── Sheet 3: Zone summary ──────────────────────────────────────
const zones = [...new Set(rows.map(r=>r.zone))].sort();
const zSummary = [
  ['Zone-wise Summary — Apr-Sep FY26-27'],
  [],
  ['Zone','Stores','Actual H1 (Cr)','Forecast H1 (Cr)','Dev% H1','On-Track','Over-Fc','Under-Fc']
];
zones.forEach(z => {
  const zr = rows.filter(r=>r.zone===z);
  const zA = zr.reduce((s,r)=>s+r.actH1,0);
  const zF = zr.reduce((s,r)=>s+r.fcH1,0);
  zSummary.push([z, zr.length, +(zA/1e7).toFixed(2), +(zF/1e7).toFixed(2),
    (zA-zF)/Math.abs(zF),
    zr.filter(r=>Math.abs(r.devPct)<=10).length,
    zr.filter(r=>r.devPct>10).length,
    zr.filter(r=>r.devPct<-10).length,
  ]);
});
const ws3 = XLSX.utils.aoa_to_sheet(zSummary);
ws3['!cols'] = Array(8).fill({wch:14});

// ── Sheet 4: Reason analysis ───────────────────────────────────
const reasonGroups = {};
rows.forEach(r => {
  const key = r.reason;
  if (!reasonGroups[key]) reasonGroups[key] = { count:0, stores:[], totalDev:0 };
  reasonGroups[key].count++;
  reasonGroups[key].stores.push(r.code);
  reasonGroups[key].totalDev += r.devAbs;
});
const rSummary = [
  ['Deviation Reason Analysis'],
  [],
  ['Reason','Store Count','Total Dev Abs (Cr)','Sample Stores']
];
Object.entries(reasonGroups).sort((a,b)=>b[1].count-a[1].count).forEach(([reason, data]) => {
  rSummary.push([reason, data.count, +(data.totalDev/1e7).toFixed(2),
    data.stores.slice(0,8).join(', ')]);
});
const ws4 = XLSX.utils.aoa_to_sheet(rSummary);
ws4['!cols'] = [{wch:45},{wch:12},{wch:18},{wch:60}];

// Write workbook
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws1, 'Store Deviation');
XLSX.utils.book_append_sheet(wb, ws2, 'Month Summary');
XLSX.utils.book_append_sheet(wb, ws3, 'Zone Summary');
XLSX.utils.book_append_sheet(wb, ws4, 'Reason Analysis');
XLSX.writeFile(wb, 'C:/Users/I546253/Downloads/FY26-27_Forecast_vs_Actual.xlsx');

console.log('Done: FY26-27_Forecast_vs_Actual.xlsx');
console.log('Stores analyzed:', rows.length);
console.log('');
console.log('PORTFOLIO: Actual =', (totA/1e7).toFixed(2)+'Cr | Forecast =', (totF/1e7).toFixed(2)+'Cr | Dev =', +((totA-totF)/Math.abs(totF)*100).toFixed(1)+'%');
console.log('');
console.log('REASON BREAKDOWN:');
Object.entries(reasonGroups).sort((a,b)=>b[1].count-a[1].count).forEach(([r,d]) => {
  console.log(' ', d.count.toString().padStart(3), 'stores —', r);
});
