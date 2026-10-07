'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const xlsx = require('xlsx');
const pool = require('../db');
const path = require('path');

// ── Config ──────────────────────────────────────────────────────────────────
const EXCEL_PATH = process.argv[2] ||
  'C:/Users/I546253/Downloads/EBO_FY_26-27_AOP_with_FY26-27_plan_target v1.0 (1) (1).xlsx';

const BATCH_SIZE = 50;

// ── Sheet definitions ────────────────────────────────────────────────────────
const SHEETS = [
  {
    name : 'FY 24-25 Monthly',
    year : 2024,
    cols : {
      apr: 'Apr-24', may: 'May-24', jun: 'Jun-24',
      jul: 'Jul-24', aug: 'Aug-24', sep: 'Sep-24',
      oct: 'Oct-24', nov: 'Nov-24', dec: 'Dec-24',
      jan: 'Jan-25', feb: 'Feb-25', mar: 'Mar-25',
    },
  },
  {
    name : 'FY 25-26 Monthly',
    year : 2025,
    cols : {
      apr: 'Apr-25', may: 'May-25', jun: 'Jun-25',
      jul: 'Jul-25', aug: 'Aug-25', sep: 'Sep-25',
      oct: 'Oct-25', nov: 'Nov-25', dec: 'Dec-25',
      jan: 'Jan-26', feb: 'Feb-26', mar: 'Mar-26',
    },
  },
];

// ── Helpers ──────────────────────────────────────────────────────────────────
const toNum = (v) => (v == null || v === '' ? 0 : Number(v) || 0);
const toStr = (v) => (v == null ? null : String(v).trim() || null);

function parseSheet(wb, sheetDef) {
  const ws = wb.Sheets[sheetDef.name];
  if (!ws) throw new Error(`Sheet "${sheetDef.name}" not found in Excel`);

  const rows = xlsx.utils.sheet_to_json(ws, { header: 1, defval: null });
  const [headerRow, ...dataRows] = rows;

  const colIdx = {};
  headerRow.forEach((h, i) => { if (h) colIdx[String(h).trim()] = i; });

  const records = [];

  for (const row of dataRows) {
    const code = row[colIdx['Code']];
    if (!code || typeof code !== 'string' || code.trim() === '') continue;
    if (code.length > 20) continue;

    const m   = sheetDef.cols;
    const apr = toNum(row[colIdx[m.apr]]);  const may = toNum(row[colIdx[m.may]]);
    const jun = toNum(row[colIdx[m.jun]]);  const jul = toNum(row[colIdx[m.jul]]);
    const aug = toNum(row[colIdx[m.aug]]);  const sep = toNum(row[colIdx[m.sep]]);
    const oct = toNum(row[colIdx[m.oct]]);  const nov = toNum(row[colIdx[m.nov]]);
    const dec = toNum(row[colIdx[m.dec]]);  const jan = toNum(row[colIdx[m.jan]]);
    const feb = toNum(row[colIdx[m.feb]]);  const mar = toNum(row[colIdx[m.mar]]);

    const fy_total = apr+may+jun+jul+aug+sep+oct+nov+dec+jan+feb+mar;
    if (fy_total === 0) continue;

    records.push({
      code      : code.trim(),
      name      : toStr(row[colIdx['Name']]),
      zone      : toStr(row[colIdx['Zone']]),
      region    : toStr(row[colIdx['Region']]),
      grade     : toStr(row[colIdx['Grade']]),
      store_type: toStr(row[colIdx['Store Type']]),
      channel   : toStr(row[colIdx['Channel']]),
      status    : toStr(row[colIdx['Status']]),
      fy_year   : sheetDef.year,
      apr, may, jun, jul, aug, sep, oct, nov, dec, jan, feb, mar, fy_total,
    });
  }

  return records;
}

// ── Batch UPSERT ─────────────────────────────────────────────────────────────
const UPSERT_SQL = `
  INSERT INTO past_sales
    (code, name, zone, region, grade, store_type, channel, status, fy_year,
     apr, may, jun, jul, aug, sep, oct, nov, dec, jan, feb, mar, fy_total, updated_at)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23, NOW())
  ON CONFLICT (code, fy_year) DO UPDATE SET
    name=EXCLUDED.name, zone=EXCLUDED.zone, region=EXCLUDED.region,
    grade=EXCLUDED.grade, store_type=EXCLUDED.store_type,
    channel=EXCLUDED.channel, status=EXCLUDED.status,
    apr=EXCLUDED.apr, may=EXCLUDED.may, jun=EXCLUDED.jun,
    jul=EXCLUDED.jul, aug=EXCLUDED.aug, sep=EXCLUDED.sep,
    oct=EXCLUDED.oct, nov=EXCLUDED.nov, dec=EXCLUDED.dec,
    jan=EXCLUDED.jan, feb=EXCLUDED.feb, mar=EXCLUDED.mar,
    fy_total=EXCLUDED.fy_total, updated_at=NOW()`;

async function upsertBatch(client, batch) {
  for (const r of batch) {
    await client.query(UPSERT_SQL, [
      r.code, r.name, r.zone, r.region, r.grade, r.store_type, r.channel, r.status, r.fy_year,
      r.apr, r.may, r.jun, r.jul, r.aug, r.sep,
      r.oct, r.nov, r.dec, r.jan, r.feb, r.mar, r.fy_total,
    ]);
  }
  return batch.length;
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\nReading Excel: ${EXCEL_PATH}`);
  const wb = xlsx.readFile(EXCEL_PATH);

  let allRecords = [];
  for (const sheetDef of SHEETS) {
    const recs = parseSheet(wb, sheetDef);
    console.log(`  ${sheetDef.name}: ${recs.length} store rows parsed (fy_year=${sheetDef.year})`);
    allRecords = allRecords.concat(recs);
  }

  console.log(`\nTotal records to upsert: ${allRecords.length}`);
  console.log(`Batch size: ${BATCH_SIZE}\n`);

  const client = await pool.connect();
  let inserted = 0;

  try {
    await client.query('BEGIN');

    for (let i = 0; i < allRecords.length; i += BATCH_SIZE) {
      const batch = allRecords.slice(i, i + BATCH_SIZE);
      await upsertBatch(client, batch);
      inserted += batch.length;
      process.stdout.write(`\r  Progress: ${inserted}/${allRecords.length}`);
    }

    await client.query('COMMIT');
    console.log(`\n\nDone. ${inserted} rows upserted into past_sales.`);

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\nRolled back. Error:', err.message);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
