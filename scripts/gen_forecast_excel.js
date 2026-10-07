const XLSX = require('xlsx');
const wb_src = XLSX.readFile('C:/Users/I546253/Downloads/EBO_FY_26-27_AOP_with_FY26-27_plan_target v1.0 (1) (1).xlsx');
const MONTHS = ['apr','may','jun','jul','aug','sep','oct','nov','dec','jan','feb','mar'];

function parseSheet(sheetName, fyYear) {
  const ws = wb_src.Sheets[sheetName];
  const data = XLSX.utils.sheet_to_json(ws, { header: 1 });
  const rows = [];
  for (let i = 1; i < data.length; i++) {
    const r = data[i];
    if (!r[0]) continue;
    rows.push({
      code: String(r[0]).trim(), name: String(r[1]||''), zone: String(r[2]||''),
      region: String(r[3]||''), grade: String(r[4]||''), store_type: String(r[5]||''),
      channel: String(r[6]||''), status: String(r[7]||''), fy_year: fyYear,
      ...MONTHS.reduce((a,m,i) => ({...a, [m]: parseFloat(r[8+i])||0}), {})
    });
  }
  return rows;
}

const rows = [...parseSheet('FY 24-25 Monthly', 2024), ...parseSheet('FY 25-26 Monthly', 2025)];

const groups = {};
rows.forEach(r => {
  if (!groups[r.code]) groups[r.code] = {
    code:r.code, name:r.name, zone:r.zone, region:r.region,
    grade:r.grade, store_type:r.store_type, channel:r.channel, status:r.status, byYear:{}
  };
  groups[r.code].byYear[r.fy_year] = MONTHS.reduce((a,m) => ({...a, [m]:r[m]}), {});
});

function computeForecast(grp) {
  const years = Object.keys(grp.byYear).map(Number).sort();
  const aT = {};
  years.forEach(y => { aT[y] = MONTHS.reduce((s,m) => s + grp.byYear[y][m], 0); });

  const denom = (years.length*(years.length+1))/2;
  const wt = {};
  years.forEach((y,i) => { wt[y] = (i+1)/denom; });

  const sBy = {};
  years.forEach(y => {
    const avg = aT[y]/12;
    sBy[y] = MONTHS.reduce((acc,m) => ({...acc, [m]: avg!==0 ? +(grp.byYear[y][m]/avg*100).toFixed(1) : 0}), {});
  });

  const wSI = MONTHS.reduce((acc,m) => ({
    ...acc,
    [m]: +Object.entries(wt).reduce((s,[y,w]) => s + (sBy[Number(y)]?.[m]??0)*w, 0).toFixed(1)
  }), {});

  const wBase = +Object.entries(wt).reduce((s,[y,w]) => s + (aT[Number(y)]??0)*w, 0).toFixed(0);

  const yoys = [];
  for (let i=1; i<years.length; i++) {
    const b = Math.abs(aT[years[i-1]]);
    yoys.push(b > 0 ? +((aT[years[i]]-aT[years[i-1]])/b*100).toFixed(2) : 0);
  }
  const cagr = (years.length>1 && aT[years[0]]!==0)
    ? +((Math.pow(Math.abs(aT[years[years.length-1]])/Math.abs(aT[years[0]]), 1/(years.length-1))-1)*100).toFixed(2)
    : 0;
  const rYoy = yoys.length > 0 ? yoys[yoys.length-1] : 0;
  const raw = yoys.length >= 2 ? (0.7*rYoy + 0.3*cagr) : (rYoy||cagr||0);
  const growth = Math.max(-80, Math.min(80, raw));
  const target = wBase * (1 + growth/100);

  const monthly = {};
  MONTHS.forEach(m => { monthly[m] = Math.round(target * (wSI[m]??100) / 1200); });
  const total = MONTHS.reduce((s,m) => s + monthly[m], 0);
  const fy2526 = aT[2025] || 0;
  const yoyPct = fy2526 !== 0 ? +((total-fy2526)/Math.abs(fy2526)*100).toFixed(1) : 0;

  return {
    ...monthly, total, yoyPct, growth: +growth.toFixed(1),
    fy2425: Math.round(aT[2024]||0), fy2526: Math.round(fy2526),
    fy2425mo: grp.byYear[2024]||{}, fy2526mo: grp.byYear[2025]||{}
  };
}

const result = Object.values(groups).map(grp => ({...grp, ...computeForecast(grp)}));
result.sort((a,b) => a.zone.localeCompare(b.zone) || a.code.localeCompare(b.code));

const wb = XLSX.utils.book_new();

// ── Sheet 1: FY26-27 Forecast ─────────────────────────────────
const s1 = [
  ['FY 26-27 FORECAST — STORE WISE MONTHLY'],
  [],
  ['Code','Name','Zone','Region','Grade','Store Type','Channel','Status',
   'APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC','JAN','FEB','MAR','FY26-27 TOTAL','YoY%']
];
result.forEach(f => {
  s1.push([
    f.code, f.name, f.zone, f.region, f.grade, f.store_type, f.channel, f.status,
    ...MONTHS.map(m => f[m]),
    f.total, f.yoyPct/100
  ]);
});
s1.push([
  'TOTAL','ALL STORES','','','','','','',
  ...MONTHS.map(m => result.reduce((s,r) => s+r[m], 0)),
  result.reduce((s,r) => s+r.total, 0), ''
]);
const ws1 = XLSX.utils.aoa_to_sheet(s1);
ws1['!cols'] = [{wch:7},{wch:28},{wch:10},{wch:10},{wch:6},{wch:10},{wch:8},{wch:8},
  ...Array(12).fill({wch:12}), {wch:14},{wch:7}];

// ── Sheet 2: FY25-26 Actual ───────────────────────────────────
const s2 = [
  ['FY 25-26 ACTUAL — STORE WISE MONTHLY'],
  [],
  ['Code','Name','Zone','Region','Grade','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC','JAN','FEB','MAR','FY25-26 TOTAL']
];
result.forEach(f => {
  const mo = f.fy2526mo;
  s2.push([f.code, f.name, f.zone, f.region, f.grade,
    ...MONTHS.map(m => Math.round(mo[m]||0)), f.fy2526]);
});
s2.push(['TOTAL','ALL','','','',
  ...MONTHS.map(m => Math.round(result.reduce((s,r) => s+(r.fy2526mo[m]||0), 0))),
  result.reduce((s,r) => s+r.fy2526, 0)
]);
const ws2 = XLSX.utils.aoa_to_sheet(s2);
ws2['!cols'] = [{wch:7},{wch:28},{wch:10},{wch:10},{wch:6},...Array(12).fill({wch:12}),{wch:14}];

// ── Sheet 3: FY24-25 Actual ───────────────────────────────────
const s3 = [
  ['FY 24-25 ACTUAL — STORE WISE MONTHLY'],
  [],
  ['Code','Name','Zone','Region','Grade','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC','JAN','FEB','MAR','FY24-25 TOTAL']
];
result.forEach(f => {
  const mo = f.fy2425mo;
  s3.push([f.code, f.name, f.zone, f.region, f.grade,
    ...MONTHS.map(m => Math.round(mo[m]||0)), f.fy2425]);
});
s3.push(['TOTAL','ALL','','','',
  ...MONTHS.map(m => Math.round(result.reduce((s,r) => s+(r.fy2425mo[m]||0), 0))),
  result.reduce((s,r) => s+r.fy2425, 0)
]);
const ws3 = XLSX.utils.aoa_to_sheet(s3);
ws3['!cols'] = [{wch:7},{wch:28},{wch:10},{wch:10},{wch:6},...Array(12).fill({wch:12}),{wch:14}];

// ── Sheet 4: Summary ──────────────────────────────────────────
const s4 = [
  ['STORE SUMMARY — FY 24-25 vs FY 25-26 vs FY 26-27 FORECAST'],
  [],
  ['Code','Name','Zone','Grade','FY24-25 Total','FY25-26 Total','FY26-27 Forecast','YoY 24-25→25-26','YoY 25-26→26-27','Growth Applied']
];
result.forEach(f => {
  const yoy2425 = f.fy2425!==0 ? +((f.fy2526-f.fy2425)/Math.abs(f.fy2425)*100).toFixed(1) : 0;
  s4.push([f.code, f.name, f.zone, f.grade, f.fy2425, f.fy2526, f.total,
    yoy2425/100, f.yoyPct/100, f.growth/100]);
});
const ws4 = XLSX.utils.aoa_to_sheet(s4);
ws4['!cols'] = [{wch:7},{wch:28},{wch:10},{wch:6},{wch:14},{wch:14},{wch:16},{wch:16},{wch:16},{wch:13}];

XLSX.utils.book_append_sheet(wb, ws1, 'FY26-27 Forecast');
XLSX.utils.book_append_sheet(wb, ws2, 'FY25-26 Actual');
XLSX.utils.book_append_sheet(wb, ws3, 'FY24-25 Actual');
XLSX.utils.book_append_sheet(wb, ws4, 'Summary');

XLSX.writeFile(wb, 'C:/Users/I546253/Downloads/FY26-27_Storewise_Monthly_Forecast.xlsx');
console.log('Done: FY26-27_Storewise_Monthly_Forecast.xlsx');
console.log('Total stores:', result.length);
const gt = result.reduce((s,r) => s+r.total, 0);
const ga = result.reduce((s,r) => s+r.fy2526, 0);
console.log('FY25-26 Actual  : Rs', (ga/1e7).toFixed(2), 'Cr');
console.log('FY26-27 Forecast: Rs', (gt/1e7).toFixed(2), 'Cr');
console.log('YoY Change      :', +((gt-ga)/Math.abs(ga)*100).toFixed(2), '%');
