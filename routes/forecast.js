'use strict';

const express   = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const pool      = require('../db');

const router = express.Router();

// Lazy-init Anthropic client so server.js validates the key before first use
let _ai;
const getAI = () => _ai || (_ai = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }));

// Calendar month order — used throughout for analytics, prompts, and DB params
const MONTHS      = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
const MONTH_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// Fiscal year month order (Apr = FY start) — used for festival factor lookup
const FY_MONTHS = ['apr','may','jun','jul','aug','sep','oct','nov','dec','jan','feb','mar'];

// In-memory cache for DB-backed config (grade_factors, zone_factors, forecast_config)
// Refreshes every 5 minutes so DB edits take effect without server restart
let _cfg = null, _cfgAt = 0;
async function loadConfig() {
  if (_cfg && Date.now() - _cfgAt < 300_000) return _cfg;
  const [g, z, c] = await Promise.all([
    pool.query('SELECT grade, factor FROM grade_factors'),
    pool.query('SELECT zone, factor FROM zone_factors'),
    pool.query('SELECT key, value FROM forecast_config'),
  ]);
  _cfg = {
    GRADE_FACTORS: Object.fromEntries(g.rows.map(r => [r.grade, +r.factor])),
    ZONE_FACTORS:  Object.fromEntries(z.rows.map(r => [r.zone,  +r.factor])),
    config:        Object.fromEntries(c.rows.map(r => [r.key,   +r.value])),
  };
  _cfgAt = Date.now();
  return _cfg;
}

// Reference defaults (now stored in DB — see sql/create_grade_factors.sql)
// const GRADE_FACTORS = { 'A+++':0.93,'A++':1.20,'A+':1.07,'A':0.97,'B+':1.01,'B':0.99,'C+':0.89,'C':0.77,'FO/A':1.21,'FO/B':1.30,'FO/B+':1.07,'FO/C+':0.87,'FO/C':0.65,'A+B/A++':0.85,'A+B/B':0.86,'A+B/B+':0.84,'A+B/C':1.07,'A+B/C+':0.87 };
// const ZONE_FACTORS  = { 'South': 0.88 };  // sql/create_zone_factors.sql
// const NEW_STORE_RAMP = 0.60;              // forecast_config table: key='new_store_ramp'

// Peer-based forecast for stores with status='New' or < 2 years of history.
// Matches peers by: grade+zone (preferred) → grade only → channel only.
// Falls back to own-data algorithm if no peers found.
function computeNewStoreForecast(newAnalytics, allAnalytics, newStoreRamp, cfg) {
  const maturePeers = allAnalytics.filter(p =>
    p.years.length >= 2 &&
    !['new', 'renovation'].includes((p.status || '').toLowerCase())
  );

  return newAnalytics.map(a => {
    let peers = maturePeers.filter(p => p.grade === a.grade && p.zone === a.zone);
    if (peers.length < 3) peers = maturePeers.filter(p => p.grade === a.grade);
    if (peers.length < 3) peers = maturePeers.filter(p => p.channel === a.channel);
    if (!peers.length)    return computeForecast([a], cfg).forecasts[0];

    const n             = peers.length;
    const peerAvgAnnual = peers.reduce((s, p) => s + (p.annualTotals[Math.max(...p.years)] ?? 0), 0) / n;
    const peerSI        = MONTHS.reduce((acc, m) => {
      acc[m] = peers.reduce((s, p) => s + (p.wtdSeasonalIdx[m] ?? 100), 0) / n;
      return acc;
    }, {});

    const annualTarget = peerAvgAnnual * newStoreRamp;
    const monthly      = {};
    MONTHS.forEach(m => {
      monthly[m] = +(annualTarget * (peerSI[m] ?? 100) / 1200 * (a.festivalFactor?.[m] ?? 1)).toFixed(2);
    });
    const totalForecast = +MONTHS.reduce((s, m) => s + monthly[m], 0).toFixed(2);
    const peerLabel     = `${n} peers (${a.grade || '–'}/${a.zone || '–'})`;

    return {
      cust_old: a.cust_old, fiscvarnt: a.fiscvarnt, forecast_year: a.forecastYear,
      ...monthly, total_forecast: totalForecast, yoy_growth_pct: 0, confidence: 'low',
      key_insights: [
        `New store — peer-based forecast from ${peerLabel}`,
        `Peer avg annual: ₹${Math.round(peerAvgAnnual).toLocaleString('en-IN')}`,
        `Year-1 ramp factor: ${(newStoreRamp * 100).toFixed(0)}% of peer avg`,
        `Annual target: ₹${Math.round(annualTarget).toLocaleString('en-IN')}`,
      ],
      seasonal_pattern: `Peer seasonal pattern from ${peerLabel}.`,
    };
  });
}

// Fetch total festival impact score per month for a given set of years
// Returns: { year: { month: totalScore } }
async function fetchFestivalScores(years) {
  const { rows } = await pool.query(
    `SELECT year, fiscal_month, SUM(impact_score)::int AS score
     FROM festivals WHERE year = ANY($1::int[])
     GROUP BY year, fiscal_month`,
    [years]
  );
  const scores = {};
  rows.forEach(r => {
    if (!scores[r.year]) scores[r.year] = {};
    scores[r.year][r.fiscal_month] = r.score;
  });
  return scores;
}

// Compute per-month festival multiplier for each analytics object
// Logic: if forecast year has more festivals in a month than historical avg → small boost, and vice versa
// Max adjustment is ±15% to avoid over-riding the seasonal index
function addFestivalFactors(analyticsArr, festivalScores) {
  return analyticsArr.map(a => {
    const festivalFactor = {};
    FY_MONTHS.forEach(m => {
      const forecastScore = festivalScores[a.forecastYear]?.[m] || 0;
      const histAvg = a.years.reduce((s, y) => s + (festivalScores[y]?.[m] || 0), 0) / a.years.length;
      // delta = how much more/less festival load this month vs historical average
      const delta = histAvg > 0 ? (forecastScore - histAvg) / histAvg : 0;
      festivalFactor[m] = 1 + Math.max(-0.15, Math.min(0.15, delta * 0.3));
    });
    return { ...a, festivalFactor };
  });
}

// Group DB rows by store, compute annual totals, YoY growth, CAGR, and weighted seasonal indices
function computeAnalytics(rows) {
  const groups = {};
  rows.forEach(row => {
    if (!groups[row.code]) {
      groups[row.code] = {
        cust_old: row.code, fiscvarnt: 'EBO',
        name: row.name||null, zone: row.zone||null, region: row.region||null,
        grade: row.grade||null, store_type: row.store_type||null,
        channel: row.channel||null, status: row.status||null,
        byYear: {},
      };
    }
    groups[row.code].byYear[Number(row.fy_year)] = MONTHS.reduce((acc, m) => {
      acc[m] = parseFloat(row[m]) || 0;
      return acc;
    }, {});
  });

  return Object.values(groups).map(grp => {
    const years      = Object.keys(grp.byYear).map(Number).sort();
    const maxYear    = Math.max(...years);
    const forecastYear = maxYear + 1;

    const annualTotals = {};
    years.forEach(y => { annualTotals[y] = MONTHS.reduce((s, m) => s + grp.byYear[y][m], 0); });

    // YoY growth % for each consecutive year pair
    const yoyGrowth = {};
    for (let i = 1; i < years.length; i++) {
      const [prev, curr] = [years[i-1], years[i]];
      const base = Math.abs(annualTotals[prev]);
      yoyGrowth[`${prev}→${curr}`] = base > 0
        ? +((annualTotals[curr] - annualTotals[prev]) / base * 100).toFixed(2) : 0;
    }

    const [firstTotal, lastTotal] = [annualTotals[years[0]], annualTotals[maxYear]];
    const cagr = years.length > 1 && firstTotal !== 0
      ? +((Math.pow(Math.abs(lastTotal) / Math.abs(firstTotal), 1 / (years.length - 1)) - 1) * 100).toFixed(2)
      : 0;

    // Seasonal index: each month as % of avg month (100 = average, 150 = 50% above average)
    const seasonalByYear = {};
    years.forEach(y => {
      const avg = annualTotals[y] / 12;
      seasonalByYear[y] = MONTHS.reduce((acc, m) => {
        acc[m] = avg !== 0 ? +(grp.byYear[y][m] / avg * 100).toFixed(1) : 0;
        return acc;
      }, {});
    });

    // Triangular weights: year 1 gets lowest weight, latest year gets highest
    const denom   = (years.length * (years.length + 1)) / 2;
    const weights = {};
    years.forEach((y, i) => { weights[y] = (i + 1) / denom; });

    const wtdSeasonalIdx = MONTHS.reduce((acc, m) => {
      const v = Object.entries(weights).reduce((s, [y, w]) => s + (seasonalByYear[Number(y)]?.[m] ?? 0) * w, 0);
      acc[m] = isFinite(v) ? +v.toFixed(1) : 0;
      return acc;
    }, {});

    const wtdAnnualBase = +Object.entries(weights)
      .reduce((s, [y, w]) => s + (annualTotals[Number(y)] ?? 0) * w, 0)
      .toFixed(0);

    return {
      ...grp, forecastYear, years, byYear: grp.byYear,
      annualTotals, yoyGrowth, cagr, seasonalByYear, wtdSeasonalIdx, wtdAnnualBase,
    };
  });
}

// Algorithmic fallback — same formula as the prompt tells Claude to use
// blended_growth = 0.7 × recent_YoY + 0.3 × CAGR, capped ±80%
// month = annual_target × (wtdSeasonalIdx[m] / 1200)
function computeForecast(analyticsArr, cfg) {
  const GF = cfg?.GRADE_FACTORS ?? {};
  const ZF = cfg?.ZONE_FACTORS  ?? {};
  const growthCap    = cfg?.config?.growth_cap_pct     ?? 40;
  const wYoy         = cfg?.config?.growth_weight_yoy  ?? 0.7;
  const wCagr        = cfg?.config?.growth_weight_cagr ?? 0.3;

  const forecasts = analyticsArr.map(a => {
    const maxYear   = Math.max(...a.years);
    const lastTotal = a.annualTotals[maxYear];
    const yoyKeys   = Object.keys(a.yoyGrowth).sort();
    const recentYoy = yoyKeys.length > 0 ? a.yoyGrowth[yoyKeys[yoyKeys.length - 1]] : 0;
    const rawGrowth = yoyKeys.length >= 2 ? wYoy * recentYoy + wCagr * a.cagr : recentYoy || a.cagr || 0;
    const growth    = Math.max(-growthCap, Math.min(growthCap, rawGrowth));

    const gradeFactor  = GF[a.grade] ?? 1.0;
    const zoneFactor   = ZF[a.zone]  ?? 1.0;
    const annualTarget = lastTotal * (1 + growth / 100) * gradeFactor * zoneFactor;
    const monthly      = {};
    MONTHS.forEach(m => {
      const si      = a.wtdSeasonalIdx[m] ?? 100;
      const festAdj = a.festivalFactor?.[m] ?? 1;  // festival shift multiplier (e.g. 1.05 = +5%)
      monthly[m] = +(annualTarget * si / 1200 * festAdj).toFixed(2);
    });

    const totalForecast  = +MONTHS.reduce((s, m) => s + monthly[m], 0).toFixed(2);
    const yoy_growth_pct = lastTotal !== 0
      ? +((annualTarget - lastTotal) / Math.abs(lastTotal) * 100).toFixed(4) : 0;

    const allYoys    = Object.values(a.yoyGrowth);
    const maxSwing   = allYoys.length ? Math.max(...allYoys.map(Math.abs)) : 0;
    const confidence = a.years.length >= 3 && maxSwing < 40 ? 'high'
      : a.years.length >= 2 && maxSwing < 70                ? 'medium' : 'low';

    const peakMonth   = MONTHS.reduce((b, m) => monthly[m] > monthly[b] ? m : b);
    const troughMonth = MONTHS.reduce((b, m) => monthly[m] < monthly[b] ? m : b);
    const topMonths   = [...MONTHS].sort((x, y) => monthly[y] - monthly[x]).slice(0, 3).map(m => m.toUpperCase());
    const siMin = Math.min(...MONTHS.map(m => a.wtdSeasonalIdx[m] ?? 100));
    const siMax = Math.max(...MONTHS.map(m => a.wtdSeasonalIdx[m] ?? 100));

    return {
      cust_old: a.cust_old, fiscvarnt: a.fiscvarnt, forecast_year: a.forecastYear,
      ...monthly, total_forecast: totalForecast, yoy_growth_pct, confidence,
      key_insights: [
        `Peak: ${peakMonth.toUpperCase()} (₹${Math.round(monthly[peakMonth]).toLocaleString('en-IN')})`,
        `Trough: ${troughMonth.toUpperCase()} (₹${Math.round(monthly[troughMonth]).toLocaleString('en-IN')})`,
        `Growth applied: ${growth >= 0 ? '+' : ''}${growth.toFixed(1)}% (70% YoY + 30% CAGR)`,
        `CAGR ${a.years[0]}–${maxYear}: ${a.cagr >= 0 ? '+' : ''}${a.cagr.toFixed(1)}%`,
        `Last year actual: ₹${Math.round(lastTotal).toLocaleString('en-IN')}`,
      ],
      seasonal_pattern: `Strong months: ${topMonths.join(', ')}. SI range: ${siMin.toFixed(0)}–${siMax.toFixed(0)}.`,
    };
  });

  const grandTotal   = forecasts.reduce((s, f) => s + f.total_forecast, 0);
  const forecastYear = forecasts[0]?.forecast_year ?? '';
  const counts       = { high: 0, medium: 0, low: 0 };
  forecasts.forEach(f => counts[f.confidence]++);

  return {
    forecasts,
    executive_summary: `Algorithmic forecast for ${forecasts.length} segments, FY${forecastYear}. Total: ₹${Math.round(grandTotal).toLocaleString('en-IN')}. Confidence: ${counts.high} HIGH, ${counts.medium} MEDIUM, ${counts.low} LOW.`,
    methodology: 'Triangular-weighted seasonal decomposition. blended_growth = 0.7 × recent_YoY + 0.3 × CAGR (capped ±40%). Growth applied to last year actual. Grade + zone calibration factors applied (derived from FY26-27 H1 actuals). month = last_year_actual × growth × grade_factor × (SI / 1200).',
    risk_factors: [
      'Growth blending assumes recent trend continues — large business changes may invalidate.',
      'Seasonal indices from historical data only — structural pattern shifts not captured.',
      'Growth capped at ±40% to prevent over-extrapolation from short history.',
    ],
  };
}

// ─── AI Enrichment Tool — batch qualitative enrichment per store ───────────────
const AI_ENRICH_TOOL = {
  name: 'submit_ai_enrichment',
  description: 'Qualitative AI enrichment for a batch of store forecasts.',
  input_schema: {
    type: 'object',
    required: ['stores'],
    properties: {
      stores: {
        type: 'array',
        items: {
          type: 'object',
          required: ['cust_old', 'confidence', 'key_insights', 'seasonal_pattern', 'risk_factors'],
          additionalProperties: false,
          properties: {
            cust_old:        { type: 'string' },
            confidence:      { type: 'string', enum: ['high', 'medium', 'low'] },
            key_insights:    { type: 'array', items: { type: 'string' }, maxItems: 4 },
            seasonal_pattern:{ type: 'string' },
            risk_factors:    { type: 'array', items: { type: 'string' }, maxItems: 3 },
          },
        },
      },
    },
  },
};

// Call Claude Haiku to enrich a batch of pre-computed forecasts with qualitative analysis
async function enrichBatchWithAI(batch, metaMap) {
  const storeLines = batch.map(f => {
    const a      = metaMap[f.cust_old] || {};
    const yoyStr = Object.entries(a.yoyGrowth || {}).slice(-2)
      .map(([k, v]) => `${k}:${v >= 0 ? '+' : ''}${v}%`).join(', ');
    const monthStr = ['apr','may','jun','jul','aug','sep','oct','nov','dec','jan','feb','mar']
      .map(m => `${m[0].toUpperCase()}${m.slice(1,3)}:${Math.round((parseFloat(f[m]) || 0) / 1000)}K`)
      .join(' ');
    return `[${f.cust_old}] ${a.name || '?'} | Zone:${a.zone || '?'} Grade:${a.grade || '?'} | ` +
      `YoY:${yoyStr} CAGR:${(a.cagr || 0).toFixed(1)}% | ${a.years?.length || 0} yrs data\n` +
      `  ${monthStr} | Annual:${Math.round((parseFloat(f.total_forecast) || 0) / 1000)}K Growth:${Number(f.yoy_growth_pct).toFixed(1)}%`;
  }).join('\n\n');

  const prompt = `India fashion retail analyst. Enrich ${batch.length} store forecasts qualitatively.

For each store provide:
- confidence: "high" (3+ data years, growth swing <30%), "medium" (2+ years or swing <50%), "low" (otherwise)
- key_insights: 3-4 business observations (trend direction, peak month, grade context, specific risks)
- seasonal_pattern: 1 sentence (e.g., "Peaks Oct-Nov festival season; troughs Feb-Mar post-winter")
- risk_factors: 2-3 specific business risks for this store's profile

Stores:
${storeLines}

Respond ONLY via submit_ai_enrichment tool.`;

  const response = await getAI().messages.create({
    model:      'claude-haiku-4-5',
    max_tokens: 4000,
    messages:   [{ role: 'user', content: prompt }],
    tools:      [AI_ENRICH_TOOL],
  });

  const tb = response.content.find(b => b.type === 'tool_use' && b.name === 'submit_ai_enrichment');
  if (!tb?.input?.stores) return batch;

  const enrichMap = Object.fromEntries(tb.input.stores.map(s => [s.cust_old, s]));
  return batch.map(f => {
    const e = enrichMap[f.cust_old];
    if (!e) return f;
    return { ...f, confidence: e.confidence, key_insights: e.key_insights,
      seasonal_pattern: e.seasonal_pattern, risk_factors: e.risk_factors };
  });
}

// Shared SSE generation logic — useAI=false → pure numerical, useAI=true → numerical + Claude enrichment
async function runForecastGeneration(_req, res, useAI) {
  res.setHeader('Content-Type',               'text/event-stream');
  res.setHeader('Cache-Control',              'no-cache');
  res.setHeader('Connection',                 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('X-Accel-Buffering',          'no');
  res.flushHeaders();

  const emit = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  try {
    emit('status', { step: 1, msg: '📊 Loading historical data from DB...' });
    const { rows } = await pool.query(
      `SELECT * FROM past_sales WHERE LOWER(status) NOT IN ('inactive','closed','shut') ORDER BY fy_year, code`
    );
    if (!rows.length) throw new Error('No historical data found. Upload Excel first.');
    emit('status', { step: 1, msg: `✅ ${rows.length} records across ${new Set(rows.map(r => r.fy_year)).size} year(s)` });

    emit('status', { step: 2, msg: '🔢 Computing seasonal indices and trends...' });
    const analytics    = computeAnalytics(rows);
    const forecastYear = analytics[0]?.forecastYear;

    const allYears       = [...new Set(rows.map(r => Number(r.fy_year))), forecastYear];
    const festivalScores = await fetchFestivalScores(allYears);
    const richAnalytics  = addFestivalFactors(analytics, festivalScores);

    const metaMap = Object.fromEntries(richAnalytics.map(a => [a.cust_old, a]));
    emit('status', { step: 2, msg: `✅ ${richAnalytics.length} segments → forecasting FY${forecastYear}` });

    const isNew            = a => ['new', 'renovation'].includes((a.status || '').toLowerCase()) || a.years.length < 2;
    const newAnalytics     = richAnalytics.filter(isNew);
    const regularAnalytics = richAnalytics.filter(a => !isNew(a));

    const cfg          = await loadConfig();
    const newStoreRamp = cfg.config.new_store_ramp ?? 0.60;

    const newForecasts = computeNewStoreForecast(newAnalytics, richAnalytics, newStoreRamp, cfg);
    if (newForecasts.length)
      emit('status', { step: 2, msg: `🆕 ${newForecasts.length} new/renovation stores → peer-based forecast (${(newStoreRamp * 100).toFixed(0)}% ramp)` });

    emit('status', { step: 3, msg: `🔢 Computing forecasts for ${regularAnalytics.length} L2L segments...` });
    const regularResult = computeForecast(regularAnalytics, cfg);
    let allForecasts    = [...newForecasts, ...regularResult.forecasts];
    emit('status', { step: 3, msg: `✅ ${allForecasts.length} numerical forecasts computed${newForecasts.length ? ` (${newForecasts.length} peer-based)` : ''}` });

    // AI enrichment step — only for /generate-ai
    if (useAI) {
      const BATCH_SIZE = 15;
      const batches    = [];
      for (let i = 0; i < allForecasts.length; i += BATCH_SIZE) batches.push(allForecasts.slice(i, i + BATCH_SIZE));
      emit('status', { step: 4, msg: `✨ AI enriching ${allForecasts.length} stores (${batches.length} batches)...` });
      const enriched = [];
      for (let i = 0; i < batches.length; i++) {
        const batch = await enrichBatchWithAI(batches[i], metaMap);
        enriched.push(...batch);
        emit('status', { step: 4, msg: `✨ AI enriched ${enriched.length}/${allForecasts.length} stores` });
      }
      allForecasts = enriched;
    }

    const grandTotal = allForecasts.reduce((s, f) => s + (parseFloat(f.total_forecast) || 0), 0);
    const counts     = { high: 0, medium: 0, low: 0 };
    allForecasts.forEach(f => counts[f.confidence]++);

    const payload = {
      forecasts: allForecasts,
      executive_summary: `${useAI ? 'AI-enhanced' : 'Algorithmic'} forecast for ${allForecasts.length} segments, FY${forecastYear}. Total: ₹${Math.round(grandTotal).toLocaleString('en-IN')}. Confidence: ${counts.high} HIGH, ${counts.medium} MEDIUM, ${counts.low} LOW.`,
      methodology: regularResult.methodology,
      risk_factors: regularResult.risk_factors,
    };

    const saveStep = useAI ? 5 : 4;
    emit('status', { step: saveStep, msg: '💾 Saving to PostgreSQL...' });
    const dbClient = await pool.connect();
    try {
      await dbClient.query('BEGIN');
      for (const f of payload.forecasts) {
        const m = metaMap[f.cust_old] || {};
        await dbClient.query(
          `INSERT INTO forecasts
             (cust_old, fiscvarnt, forecast_year,
              name, zone, region, grade, store_type, channel, status,
              apr, may, jun, jul, aug, sep, oct, nov, dec, jan, feb, mar,
              total_forecast, yoy_growth_pct, confidence,
              key_insights, risk_factors, seasonal_pattern,
              executive_summary, methodology, generated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
                   $11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,
                   $23,$24,$25,$26,$27,$28,$29,$30,NOW())
           ON CONFLICT (cust_old, fiscvarnt, forecast_year) DO UPDATE SET
             name=$4, zone=$5, region=$6, grade=$7, store_type=$8, channel=$9, status=$10,
             apr=$11, may=$12, jun=$13, jul=$14, aug=$15, sep=$16, oct=$17,
             nov=$18, dec=$19, jan=$20, feb=$21, mar=$22,
             total_forecast=$23, yoy_growth_pct=$24, confidence=$25,
             key_insights=$26, risk_factors=$27, seasonal_pattern=$28,
             executive_summary=$29, methodology=$30, generated_at=NOW()`,
          [
            f.cust_old, f.fiscvarnt, f.forecast_year,
            m.name, m.zone, m.region, m.grade, m.store_type, m.channel, m.status,
            f.apr, f.may, f.jun, f.jul, f.aug, f.sep,
            f.oct, f.nov, f.dec, f.jan, f.feb, f.mar,
            f.total_forecast, f.yoy_growth_pct, f.confidence,
            JSON.stringify(f.key_insights),
            JSON.stringify(Array.isArray(f.risk_factors) ? f.risk_factors : payload.risk_factors),
            f.seasonal_pattern,
            payload.executive_summary,
            payload.methodology,
          ]
        );
      }
      await dbClient.query('COMMIT');
    } catch (dbErr) {
      await dbClient.query('ROLLBACK');
      throw dbErr;
    } finally {
      dbClient.release();
    }

    emit('status', { step: saveStep, msg: '✅ Saved!' });
    emit('complete', { forecast: payload, forecastYear });

  } catch (err) {
    console.error(`[forecast/${useAI ? 'generate-ai' : 'generate'}]`, err.message);
    emit('error', { msg: err.message });
  } finally {
    res.end();
  }
}

// POST /api/forecast/generate    — pure numerical forecast (no AI calls)
router.post('/generate',    (req, res) => runForecastGeneration(req, res, false));

// POST /api/forecast/generate-ai — numerical + Claude Haiku qualitative enrichment
router.post('/generate-ai', (req, res) => runForecastGeneration(req, res, true));

// GET /api/forecast/latest — fetch all stored forecasts for UI
router.get('/latest', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT f.*,
        COALESCE(p.h1_actual, 0)::numeric                          AS actual_h1,
        (f.apr+f.may+f.jun+f.jul+f.aug+f.sep)::numeric            AS fc_h1
      FROM forecasts f
      LEFT JOIN (
        SELECT code, (apr+may+jun+jul+aug+sep)::numeric AS h1_actual
        FROM   past_sales
        WHERE  fy_year = (SELECT MAX(fy_year) FROM past_sales)
      ) p ON p.code = f.cust_old
      ORDER BY forecast_year DESC, cust_old, fiscvarnt
    `);
    res.json({ count: rows.length, data: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Tool schema for store-level deep-dive recommendation
const RECOMMEND_TOOL = {
  name: 'submit_recommendation',
  description: 'Provide reasoning and actionable recommendations for a single store forecast.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['reasoning_summary', 'confidence_explanation', 'recommendations', 'monthly_highlights'],
    properties: {
      reasoning_summary:      { type: 'string' },
      confidence_explanation: { type: 'string' },
      recommendations: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['action', 'rationale', 'priority'],
          properties: {
            action:    { type: 'string' },
            rationale: { type: 'string' },
            priority:  { type: 'string', enum: ['high', 'medium', 'low'] },
          },
        },
      },
      monthly_highlights: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['month', 'forecast_value', 'note'],
          properties: {
            month:          { type: 'string' },
            forecast_value: { type: 'number' },
            note:           { type: 'string' },
          },
        },
      },
    },
  },
};

// POST /api/forecast/recommend — deep-dive AI analysis for one stored forecast row
router.post('/recommend', async (req, res) => {
  const { cust_old, fiscvarnt, forecast_year } = req.body || {};
  if (!cust_old || !fiscvarnt || !forecast_year) {
    return res.status(400).json({ error: 'cust_old, fiscvarnt, forecast_year are required.' });
  }

  try {
    const [{ rows: fRows }, { rows: hRows }] = await Promise.all([
      pool.query('SELECT * FROM forecasts WHERE cust_old=$1 AND fiscvarnt=$2 AND forecast_year=$3 LIMIT 1',
        [cust_old, fiscvarnt, Number(forecast_year)]),
      pool.query('SELECT * FROM past_sales WHERE code=$1 ORDER BY fy_year', [cust_old]),
    ]);
    if (!fRows.length) return res.status(404).json({ error: 'Forecast not found. Generate it first.' });

    const f = fRows[0];

    const histSummary = hRows.map(r =>
      `${r.fy_year}: ${MONTHS.map((m, i) => `${MONTH_SHORT[i]}=${Math.round(parseFloat(r[m])||0)}`).join(', ')}`
    ).join('\n');

    const fcstSummary = MONTHS.map((m, i) =>
      `${MONTH_SHORT[i]}: ${Math.round(parseFloat(f[m])||0)}`
    ).join(' | ');

    const prompt = `Store: ${cust_old} | Year: ${forecast_year} | Confidence: ${f.confidence?.toUpperCase()} | YoY: ${Number(f.yoy_growth_pct).toFixed(2)}%

Historical sales (INR):
${histSummary}

FY${forecast_year} Forecast:
${fcstSummary}
Total: ${Math.round(parseFloat(f.total_forecast)||0)}

Seasonal pattern: ${f.seasonal_pattern || 'N/A'}

Give reasoning, confidence explanation, and 3-5 business recommendations via submit_recommendation.`;

    const response = await getAI().messages.create({
      model:      'claude-haiku-4-5',
      max_tokens: 4096,
      system:     'You are a data-driven sales analytics expert. Always call submit_recommendation.',
      messages:   [{ role: 'user', content: prompt }],
      tools:      [RECOMMEND_TOOL],
    });

    const toolBlock = response.content.find(b => b.type === 'tool_use' && b.name === 'submit_recommendation');
    if (!toolBlock) {
      const text = response.content.find(b => b.type === 'text')?.text || 'No recommendation generated.';
      return res.status(500).json({ error: text.slice(0, 300) });
    }

    res.json({
      cust_old, fiscvarnt, forecast_year, confidence: f.confidence,
      ...toolBlock.input,
      tokens: { input: response.usage.input_tokens, output: response.usage.output_tokens },
    });

  } catch (err) {
    console.error('[forecast/recommend]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Aggregate helper for deviation analysis
function devRollup(stores, key) {
  const agg = {};
  for (const s of stores) {
    const k = s[key] || 'Unknown';
    if (!agg[k]) agg[k] = { key: k, count: 0, fc_h1: 0, actual_h1: 0 };
    agg[k].count++;
    agg[k].fc_h1    += s.fc_h1;
    agg[k].actual_h1 += s.actual_h1;
  }
  return Object.values(agg).map(g => ({
    ...g,
    dev_pct: g.fc_h1 > 0 ? +((g.actual_h1 - g.fc_h1) / g.fc_h1 * 100).toFixed(1) : null,
  })).sort((a, b) => Math.abs(b.actual_h1) - Math.abs(a.actual_h1));
}

// GET /api/forecast/deviation — H1 (Apr-Sep) actual vs forecast deviation at store/grade/zone/region level
router.get('/deviation', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        f.cust_old, f.name, f.zone, f.region, f.grade, f.channel, f.status,
        (f.apr + f.may + f.jun + f.jul + f.aug + f.sep)::numeric   AS fc_h1,
        COALESCE(p.h1_actual, 0)::numeric                          AS actual_h1
      FROM forecasts f
      LEFT JOIN (
        SELECT code, (apr + may + jun + jul + aug + sep)::numeric AS h1_actual
        FROM   past_sales
        WHERE  fy_year = (SELECT MAX(fy_year) FROM past_sales)
      ) p ON p.code = f.cust_old
      ORDER BY f.zone, f.grade, f.cust_old
    `);

    const stores = rows.map(r => ({
      cust_old:  r.cust_old,
      name:      r.name,
      zone:      r.zone,
      region:    r.region,
      grade:     r.grade,
      channel:   r.channel,
      fc_h1:    +parseFloat(r.fc_h1).toFixed(0),
      actual_h1:+parseFloat(r.actual_h1).toFixed(0),
      dev_pct:  parseFloat(r.fc_h1) > 0
        ? +((parseFloat(r.actual_h1) - parseFloat(r.fc_h1)) / parseFloat(r.fc_h1) * 100).toFixed(1)
        : null,
    }));

    const matched = stores.filter(s => s.actual_h1 > 0);
    res.json({
      stores,
      byGrade:  devRollup(matched, 'grade'),
      byZone:   devRollup(matched, 'zone'),
      byRegion: devRollup(matched, 'region'),
      matched:  matched.length,
      total:    stores.length,
    });
  } catch (err) {
    console.error('[forecast/deviation]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
