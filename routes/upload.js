const express  = require('express');
const multer   = require('multer');
const xlsx     = require('xlsx');
const pool     = require('../db');

const router = express.Router();

// Store upload in memory (no temp file on disk)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// Month number → column name
const MONTH_COL = { 1:'jan',2:'feb',3:'mar',4:'apr',5:'may',6:'jun',7:'jul',8:'aug',9:'sep',10:'oct',11:'nov',12:'dec' };

const ALLOWED_MIME = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',  // .xlsx
  'application/vnd.ms-excel',                                           // .xls
  'application/octet-stream',                                           // some browsers send this for xlsx
]);

/**
 * Aggregate Excel rows into { "custOld|fiscvarnt|year" -> { jan:0, feb:0, ... } }
 * Excel columns used:
 *   /BIC/ZCUST_OLD  – customer code
 *   FISCVARNT       – fiscal variant  (header in file is FISCVARNT)
 *   CALMONTH2       – month number 1-12
 *   CALYEAR         – 4-digit year
 *   /BIC/ZTURNOVR   – turnover amount to sum
 */
function aggregateRows(rows) {
  const map = {};

  rows.forEach((row) => {
    const custOld  = String(row['/BIC/ZCUST_OLD'] || '').trim();
    const fiscvar  = String(row['FISCVARNT']       || '').trim();
    const monthNum = parseInt(row['CALMONTH2'],     10);
    const year     = parseInt(row['CALYEAR'],       10);
    const turnover = parseFloat(row['/BIC/ZTURNOVR']) || 0;

    if (!custOld || !fiscvar || !monthNum || !year) return;   // skip incomplete rows

    const monthCol = MONTH_COL[monthNum];
    if (!monthCol) return;                                     // skip invalid month

    const key = `${custOld}|${fiscvar}|${year}`;
    if (!map[key]) {
      map[key] = { custOld, fiscvar, year, jan:0, feb:0, mar:0, apr:0, may:0, jun:0, jul:0, aug:0, sep:0, oct:0, nov:0, dec:0 };
    }
    map[key][monthCol] += turnover;
  });

  return Object.values(map);
}

/**
 * POST /api/upload
 * Accepts multipart/form-data with a field named "file" containing the .xlsx
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
    // Parse Excel from buffer
    const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
    const sheet    = workbook.Sheets[workbook.SheetNames[0]];
    const rows     = xlsx.utils.sheet_to_json(sheet);

    if (!rows.length) {
      return res.status(400).json({ error: 'Excel file is empty.' });
    }

    const records = aggregateRows(rows);

    if (!records.length) {
      return res.status(400).json({ error: 'No valid rows found after aggregation. Check column names.' });
    }

    // Upsert each aggregated record
    const client = await pool.connect();
    let upserted = 0;

    try {
      await client.query('BEGIN');

      for (const r of records) {
        await client.query(
          `INSERT INTO past_sales
             (cust_old, fiscvarnt, year, jan, feb, mar, apr, may, jun, jul, aug, sep, oct, nov, dec, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, NOW())
           ON CONFLICT (cust_old, fiscvarnt, year)
           DO UPDATE SET
             jan        = EXCLUDED.jan,
             feb        = EXCLUDED.feb,
             mar        = EXCLUDED.mar,
             apr        = EXCLUDED.apr,
             may        = EXCLUDED.may,
             jun        = EXCLUDED.jun,
             jul        = EXCLUDED.jul,
             aug        = EXCLUDED.aug,
             sep        = EXCLUDED.sep,
             oct        = EXCLUDED.oct,
             nov        = EXCLUDED.nov,
             dec        = EXCLUDED.dec,
             updated_at = NOW()`,
          [
            r.custOld, r.fiscvar, r.year,
            r.jan, r.feb, r.mar, r.apr, r.may, r.jun,
            r.jul, r.aug, r.sep, r.oct, r.nov, r.dec,
          ]
        );
        upserted++;
      }

      await client.query('COMMIT');
    } catch (dbErr) {
      await client.query('ROLLBACK');
      throw dbErr;
    } finally {
      client.release();
    }

    return res.json({
      message:   'Upload successful',
      rowsRead:  rows.length,
      upserted,
      preview:   records.slice(0, 5),
    });

  } catch (err) {
    console.error('Upload error:', err);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/upload/data
 * Returns all records from past_sales (for React table display)
 */
router.get('/data', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM past_sales ORDER BY year, cust_old, fiscvarnt'
    );
    res.json({ count: rows.length, data: rows });
  } catch (err) {
    console.error('Fetch error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
