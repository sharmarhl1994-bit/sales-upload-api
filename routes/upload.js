'use strict';
const express = require('express');
const multer  = require('multer');
const xlsx    = require('xlsx');
const pool    = require('../db');

const router = express.Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// ── EBO Monthly sheet definitions ────────────────────────────────────────────
const EBO_SHEETS = [
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

const ALLOWED_MIME = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/octet-stream',
]);

/**
 * Parse one EBO Monthly sheet. Returns records ready for past_sales upsert.
 * Skips rows with no/long Code (summary rows) or all-zero months.
 */
function parseEboSheet(workbook, sheetDef) {
  const ws = workbook.Sheets[sheetDef.name];
  if (!ws) return [];

  const [headerRow, ...dataRows] = xlsx.utils.sheet_to_json(ws, { header: 1, defval: null });

  const idx = {};
  headerRow.forEach((h, i) => { if (h) idx[String(h).trim()] = i; });

  const toNum = (v) => (v == null || v === '' ? 0 : Number(v) || 0);
  const toStr = (v) => (v == null ? null : String(v).trim() || null);
  const m = sheetDef.cols;
  const records = [];

  for (const row of dataRows) {
    const code = row[idx['Code']];
    if (!code || typeof code !== 'string' || code.trim() === '') continue;
    if (code.trim().length > 20) continue;   // summary/total rows have long text

    const apr = toNum(row[idx[m.apr]]);  const may = toNum(row[idx[m.may]]);
    const jun = toNum(row[idx[m.jun]]);  const jul = toNum(row[idx[m.jul]]);
    const aug = toNum(row[idx[m.aug]]);  const sep = toNum(row[idx[m.sep]]);
    const oct = toNum(row[idx[m.oct]]);  const nov = toNum(row[idx[m.nov]]);
    const dec = toNum(row[idx[m.dec]]);  const jan = toNum(row[idx[m.jan]]);
    const feb = toNum(row[idx[m.feb]]);  const mar = toNum(row[idx[m.mar]]);

    if (apr+may+jun+jul+aug+sep+oct+nov+dec+jan+feb+mar === 0) continue;

    records.push({
      code      : code.trim(),
      name      : toStr(row[idx['Name']]),
      zone      : toStr(row[idx['Zone']]),
      region    : toStr(row[idx['Region']]),
      grade     : toStr(row[idx['Grade']]),
      store_type: toStr(row[idx['Store Type']]),
      channel   : toStr(row[idx['Channel']]),
      status    : toStr(row[idx['Status']]),
      fy_year   : sheetDef.year,
      apr, may, jun, jul, aug, sep, oct, nov, dec, jan, feb, mar,
      fy_total  : apr+may+jun+jul+aug+sep+oct+nov+dec+jan+feb+mar,
    });
  }

  return records;
}

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

async function upsertRecords(client, records) {
  let count = 0;
  for (const r of records) {
    await client.query(UPSERT_SQL, [
      r.code, r.name, r.zone, r.region, r.grade, r.store_type, r.channel, r.status, r.fy_year,
      r.apr, r.may, r.jun, r.jul, r.aug, r.sep,
      r.oct, r.nov, r.dec, r.jan, r.feb, r.mar, r.fy_total,
    ]);
    count++;
  }
  return count;
}

/**
 * POST /api/upload
 * Accepts EBO Monthly Excel (.xlsx). Parses FY 24-25 and FY 25-26 Monthly sheets.
 */
router.post('/', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded. Use field name "file".' });
  }

  const mime = req.file.mimetype || '';
  const ext  = (req.file.originalname || '').split('.').pop().toLowerCase();
  if (!ALLOWED_MIME.has(mime) && ext !== 'xlsx' && ext !== 'xls') {
    return res.status(400).json({ error: `Invalid file type "${mime}". Upload an Excel (.xlsx/.xls) file.` });
  }

  try {
    const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });

    const foundSheets = EBO_SHEETS.filter(s => workbook.SheetNames.includes(s.name));
    if (!foundSheets.length) {
      return res.status(400).json({
        error : 'No matching sheets found.',
        hint  : 'File must contain "FY 24-25 Monthly" or "FY 25-26 Monthly" sheets.',
        found : workbook.SheetNames,
      });
    }

    let allRecords = [];
    for (const sheetDef of foundSheets) {
      allRecords = allRecords.concat(parseEboSheet(workbook, sheetDef));
    }

    if (!allRecords.length) {
      return res.status(400).json({ error: 'No valid data rows found. Check that Code column is populated and monthly values are non-zero.' });
    }

    const client = await pool.connect();
    let upserted = 0;
    try {
      await client.query('BEGIN');
      upserted = await upsertRecords(client, allRecords);
      await client.query('COMMIT');
    } catch (dbErr) {
      await client.query('ROLLBACK');
      throw dbErr;
    } finally {
      client.release();
    }

    return res.json({
      message : 'Upload successful',
      rowsRead: allRecords.length,
      upserted,
      preview : allRecords.slice(0, 5),
    });

  } catch (err) {
    console.error('Upload error:', err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/upload/ebo  (alias — same logic, more detailed response)
 */
router.post('/ebo', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded. Use field name "file".' });
  }

  const ext = (req.file.originalname || '').split('.').pop().toLowerCase();
  if (ext !== 'xlsx' && ext !== 'xls') {
    return res.status(400).json({ error: 'Upload an Excel (.xlsx) file.' });
  }

  try {
    const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });

    const foundSheets = EBO_SHEETS.filter(s => workbook.SheetNames.includes(s.name));
    if (!foundSheets.length) {
      return res.status(400).json({
        error : 'No matching sheets found.',
        hint  : 'File must contain "FY 24-25 Monthly" or "FY 25-26 Monthly" sheets.',
        found : workbook.SheetNames,
      });
    }

    let allRecords = [];
    const sheetSummary = {};
    for (const sheetDef of foundSheets) {
      const records = parseEboSheet(workbook, sheetDef);
      sheetSummary[sheetDef.name] = records.length;
      allRecords = allRecords.concat(records);
    }

    if (!allRecords.length) {
      return res.status(400).json({ error: 'No valid data rows found. Check that Code column is populated and monthly values are non-zero.' });
    }

    const client = await pool.connect();
    let upserted = 0;
    try {
      await client.query('BEGIN');
      upserted = await upsertRecords(client, allRecords);
      await client.query('COMMIT');
    } catch (dbErr) {
      await client.query('ROLLBACK');
      throw dbErr;
    } finally {
      client.release();
    }

    return res.json({
      message      : 'EBO upload successful',
      sheetsLoaded : sheetSummary,
      totalUpserted: upserted,
      preview      : allRecords.slice(0, 5),
    });

  } catch (err) {
    console.error('EBO upload error:', err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/upload/data — all past_sales rows for UI display
 */
router.get('/data', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM past_sales ORDER BY fy_year, code'
    );
    res.json({ count: rows.length, data: rows });
  } catch (err) {
    console.error('Fetch error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
