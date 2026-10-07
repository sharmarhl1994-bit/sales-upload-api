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

// Grade-based calibration factors — derived from FY26-27 H1 actual vs algorithmic forecast
// Each factor = actual_H1 / forecast_H1 per grade (L2L stores only, New/Renovation excluded)
// Grades with < 5 stores are dampened (50% correction) to avoid over-fitting noise
const GRADE_FACTORS = {
  'A+++':    0.93,   // 16 stores — premium malls over-forecast by ~7%
  'A++':     1.20,   // 4 stores  — airport/flagship under-forecast by ~24% (dampened)
  'A+':      1.07,   // 19 stores — slight under-forecast
  'A':       0.97,   // 38 stores — nearly accurate
  'B+':      1.01,   // 32 stores — accurate
  'B':       0.99,   // 42 stores — accurate
  'C+':      0.89,   // 89 stores — largest group, consistently over-forecast
  'C':       0.77,   // 3 stores  — significant over-forecast (small towns)
  'FO/A':    1.21,   // 1 store   — dampened from raw 1.21
  'FO/B':    1.30,   // 3 stores  — dampened from raw 1.44
  'FO/B+':   1.07,   // 2 stores
  'FO/C+':   0.87,   // 10 stores — franchise C+ over-forecast
  'FO/C':    0.65,   // 4 stores  — dampened from raw 0.59
  'A+B/A++': 0.85,   // 1 store
  'A+B/B':   0.86,   // 2 stores
  'A+B/B+':  0.84,   // 2 stores
  'A+B/C':   1.07,   // 2 stores
  'A+B/C+':  0.87,   // 15 stores — A+B format C+ over-forecast
};

// New store ramp: year-1 stores typically do 60% of what a mature peer does
// (derived from FY26-27 H1: new store actual = 6.71 Cr vs peer-avg-based 11.64 Cr = 57.6%)
const NEW_STORE_RAMP = 0.60;

// Peer-based forecast for stores with status='New' or < 2 years of history.
// Matches peers by: grade+zone (preferred) → grade only → channel only.
// Falls back to own-data algorithm if no peers found.
function computeNewStoreForecast(newAnalytics, allAnalytics) {
  const maturePeers = allAnalytics.filter(p =>
    p.years.length >= 2 &&
    !['new', 'renovation'].includes((p.status || '').toLowerCase())
  );

  return newAnalytics.map(a => {
    let peers = maturePeers.filter(p => p.grade === a.grade && p.zone === a.zone);
    if (peers.length < 3) peers = maturePeers.filter(p => p.grade === a.grade);
    if (peers.length < 3) peers = maturePeers.filter(p => p.channel === a.channel);
    if (!peers.length)    return computeForecast([a]).forecasts[0];

    const n             = peers.length;
    const peerAvgAnnual = peers.reduce((s, p) => s + (p.annualTotals[Math.max(...p.years)] ?? 0), 0) / n;
    const peerSI        = MONTHS.reduce((acc, m) => {
      acc[m] = peers.reduce((s, p) => s + (p.wtdSeasonalIdx[m] ?? 100), 0) / n;
      return acc;
    }, {});

    const annualTarget = peerAvgAnnual * NEW_STORE_RAMP;
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
        `Year-1 ramp factor: ${NEW_STORE_RAMP * 100}% of peer avg`,
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

// Claude tool schema — forces structured forecast output
const FORECAST_TOOL = {
  name: 'submit_forecast',
  description: 'Submit monthly sales forecasts for all segments. All values are plain integers in INR (no commas, no symbols).',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['forecasts', 'executive_summary', 'methodology', 'risk_factors'],
    properties: {
      forecasts: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: [
            'cust_old','fiscvarnt','forecast_year',
            'jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec',
            'total_forecast','yoy_growth_pct','confidence','key_insights','seasonal_pattern',
          ],
          properties: {
            cust_old:         { type: 'string', description: 'Exact store code from segment header, e.g. "AMB"' },
            fiscvarnt:        { type: 'string' },
            forecast_year:    { type: 'integer' },
            jan: { type: 'number' }, feb: { type: 'number' }, mar: { type: 'number' },
            apr: { type: 'number' }, may: { type: 'number' }, jun: { type: 'number' },
            jul: { type: 'number' }, aug: { type: 'number' }, sep: { type: 'number' },
            oct: { type: 'number' }, nov: { type: 'number' }, dec: { type: 'number' },
            total_forecast:   { type: 'number' },
            yoy_growth_pct:   { type: 'number' },
            confidence:       { type: 'string', enum: ['high','medium','low'] },
            key_insights:     { type: 'array', items: { type: 'string' } },
            seasonal_pattern: { type: 'string' },
          },
        },
      },
      executive_summary: { type: 'string' },
      methodology:       { type: 'string' },
      risk_factors:      { type: 'array', items: { type: 'string' } },
    },
  },
};

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

// Build the markdown prompt Claude receives — pre-computed stats keep it on-formula
function buildPrompt(analyticsArr) {
  const segments = analyticsArr.map(a => {
    const colHdr   = `| Month | ${a.years.join(' | ')} |`;
    const sep      = `|-------|${a.years.map(() => '----------:').join('|')}|`;
    const dataRows = MONTHS.map((m, i) =>
      `| ${MONTH_SHORT[i].padEnd(5)} | ${a.years.map(y => Math.round(a.byYear[y][m])).join(' | ')} |`
    );
    const siHdr  = `| Month | ${a.years.map(y => `SI_${y}`).join(' | ')} | Weighted SI |`;
    const siSep  = `|-------|${a.years.map(() => '-------:').join('|')}|----------:|`;
    const siRows = MONTHS.map((m, i) => {
      const vals = a.years.map(y => (a.seasonalByYear[y]?.[m] ?? 0).toFixed(1)).join(' | ');
      return `| ${MONTH_SHORT[i].padEnd(5)} | ${vals} | ${a.wtdSeasonalIdx[m].toFixed(1)} |`;
    });

    return [
      `\n### Code: ${a.cust_old}  |  Grade: ${a.grade||'–'}  |  Channel: ${a.channel||'–'}  |  Forecast Year: ${a.forecastYear}`,
      '\nMonthly Turnover (INR, plain integers — no commas):',
      colHdr, sep, ...dataRows,
      `| TOTAL | ${a.years.map(y => Math.round(a.annualTotals[y])).join(' | ')} |`,
      '\nGrowth:',
      ...Object.entries(a.yoyGrowth).map(([p, pct]) => `- ${p}: ${pct >= 0 ? '+' : ''}${pct}%`),
      `- CAGR: ${a.cagr >= 0 ? '+' : ''}${a.cagr}%`,
      '\nSeasonal Indices (100 = average month):',
      siHdr, siSep, ...siRows,
      `\nWeighted Annual Base: ${Math.round(a.wtdAnnualBase)} INR`,
      // Festival factors — only show months where adjustment is non-trivial
      ...(a.festivalFactor
        ? ['\nFestival Adjustments (pre-computed, already applied):',
           ...FY_MONTHS
             .filter(m => Math.abs((a.festivalFactor[m] ?? 1) - 1) > 0.01)
             .map(m => `- ${m.toUpperCase()}: ${((a.festivalFactor[m] - 1) * 100).toFixed(1)}% (festival shift vs historical avg)`)]
        : []),
    ].join('\n');
  });

  return `Forecast next-year sales for each segment. All values are in INR as plain integers (no commas, no currency symbols).

${segments.join('\n\n---\n')}

---
Instructions:
1. blended_growth = 0.7 × most_recent_YoY + 0.3 × CAGR, capped at ±40%
2. annual_target  = Weighted_Annual_Base × (1 + blended_growth / 100)
3. Apply grade calibration to annual_target: A++×1.20, A+×1.07, A×0.97, B+×1.01, B×0.99, C+×0.89, C×0.77, A+++×0.93, FO/C+×0.87, A+B/C+×0.87 (others×1.0)
4. month_forecast = annual_target × (Weighted_SI / 1200)
5. total_forecast = sum of all 12 months
6. confidence: high = 3+ stable years | medium = 2 years or volatile | low = 1 year

Call submit_forecast with results for ALL ${analyticsArr.length} segment(s).`;
}

// Algorithmic fallback — same formula as the prompt tells Claude to use
// blended_growth = 0.7 × recent_YoY + 0.3 × CAGR, capped ±80%
// month = annual_target × (wtdSeasonalIdx[m] / 1200)
function computeForecast(analyticsArr) {
  const forecasts = analyticsArr.map(a => {
    const maxYear   = Math.max(...a.years);
    const lastTotal = a.annualTotals[maxYear];
    const yoyKeys   = Object.keys(a.yoyGrowth).sort();
    const recentYoy = yoyKeys.length > 0 ? a.yoyGrowth[yoyKeys[yoyKeys.length - 1]] : 0;
    const rawGrowth = yoyKeys.length >= 2 ? 0.7 * recentYoy + 0.3 * a.cagr : recentYoy || a.cagr || 0;
    const growth    = Math.max(-40, Math.min(40, rawGrowth));

    const gradeFactor  = GRADE_FACTORS[a.grade] ?? 1.0;
    const annualTarget = a.wtdAnnualBase * (1 + growth / 100) * gradeFactor;
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
        `Weighted base: ₹${Math.round(a.wtdAnnualBase).toLocaleString('en-IN')}`,
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
    methodology: 'Triangular-weighted seasonal decomposition. blended_growth = 0.7 × recent_YoY + 0.3 × CAGR (capped ±40%). Grade calibration factors applied (derived from FY26-27 H1 actuals). month = annual_target × grade_factor × (SI / 1200).',
    risk_factors: [
      'Growth blending assumes recent trend continues — large business changes may invalidate.',
      'Seasonal indices from historical data only — structural pattern shifts not captured.',
      'Growth capped at ±40% to prevent over-extrapolation from short history.',
    ],
  };
}

// Batch size config: small batches keep each prompt within token limits
function getBatchConfig(n) {
  if (n <= 10)  return { batchSize: n,  parallel: 1 };
  if (n <= 50)  return { batchSize: 10, parallel: 3 };
  if (n <= 200) return { batchSize: 10, parallel: 5 };
  return              { batchSize: 15, parallel: 5 };
}

async function callBatch(batchAnalytics) {
  const msg = await getAI().messages.create({
    model:       'claude-haiku-4-5-20251001',
    max_tokens:  8000,
    tool_choice: { type: 'any' },
    system:      `You are a sales forecasting analyst. Call submit_forecast for ALL ${batchAnalytics.length} segment(s). Follow the instructions exactly.`,
    messages:    [{ role: 'user', content: buildPrompt(batchAnalytics) }],
    tools:       [FORECAST_TOOL],
  });

  const toolBlock = msg.content.find(b => b.type === 'tool_use' && b.name === 'submit_forecast');
  if (!toolBlock) throw new Error('tool_not_called');
  if (!Array.isArray(toolBlock.input?.forecasts)) throw new Error('no_forecasts_array');

  // batchMap for cust_old-based lookup (index-based is unsafe after filter)
  const batchMap = Object.fromEntries(batchAnalytics.map(a => [a.cust_old, a]));

  // Recover missing identity fields Claude sometimes omits (using same-index as last resort)
  let forecasts = toolBlock.input.forecasts
    .map((f, idx) => {
      const ref = batchAnalytics[idx];
      return {
        ...f,
        cust_old:      f.cust_old      || ref?.cust_old     || null,
        fiscvarnt:     f.fiscvarnt     || ref?.fiscvarnt    || 'EBO',
        forecast_year: f.forecast_year || ref?.forecastYear || null,
      };
    })
    .filter(f => f.cust_old);

  // Scale check: if AI total < 5% of historical max, Claude misread the numbers → use algorithm
  forecasts = forecasts.map(f => {
    const ref     = batchMap[f.cust_old];
    const histMax = ref ? Math.max(0, ...Object.values(ref.annualTotals)) : 0;
    if (histMax > 0 && (parseFloat(f.total_forecast) || 0) < histMax * 0.05) {
      return computeForecast([ref]).forecasts[0];
    }
    return f;
  });

  return { ...toolBlock.input, forecasts };
}

// POST /api/forecast/generate — streams SSE: status | thinking | complete | error
router.post('/generate', async (req, res) => {
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

    // Fetch festival scores for historical years + forecast year, then enrich analytics
    const allYears        = [...new Set(rows.map(r => Number(r.fy_year))), forecastYear];
    const festivalScores  = await fetchFestivalScores(allYears);
    const richAnalytics   = addFestivalFactors(analytics, festivalScores);

    const metaMap = Object.fromEntries(richAnalytics.map(a => [a.cust_old, a]));
    emit('status', { step: 2, msg: `✅ ${richAnalytics.length} segments → forecasting FY${forecastYear}` });

    // Split: new/insufficient stores use peer-based logic; rest go to Claude
    const isNew = a => ['new', 'renovation'].includes((a.status || '').toLowerCase()) || a.years.length < 2;
    const newAnalytics     = richAnalytics.filter(isNew);
    const regularAnalytics = richAnalytics.filter(a => !isNew(a));

    const newForecasts = computeNewStoreForecast(newAnalytics, richAnalytics);
    if (newForecasts.length)
      emit('status', { step: 2, msg: `🆕 ${newForecasts.length} new/renovation stores → peer-based forecast (${NEW_STORE_RAMP * 100}% ramp)` });

    const { batchSize, parallel } = getBatchConfig(regularAnalytics.length);
    const batches = [];
    for (let i = 0; i < regularAnalytics.length; i += batchSize) batches.push(regularAnalytics.slice(i, i + batchSize));

    emit('status', { step: 3, msg: `🤖 Forecasting ${regularAnalytics.length} L2L segments — ${batches.length} batch(es), ${parallel} parallel...` });

    const allForecasts = [...newForecasts];
    let fallbackCount  = 0;

    for (let i = 0; i < batches.length; i += parallel) {
      emit('thinking', { msg: `Round ${Math.floor(i / parallel) + 1}/${Math.ceil(batches.length / parallel)}...` });

      const results = await Promise.all(
        batches.slice(i, i + parallel).map(async batch => {
          try {
            return await callBatch(batch);
          } catch {
            fallbackCount += batch.length;
            return computeForecast(batch);
          }
        })
      );
      results.forEach(r => allForecasts.push(...r.forecasts));
    }

    emit('status', { step: 3, msg: `✅ ${allForecasts.length} forecasts done${fallbackCount ? ` (${fallbackCount} algorithmic fallback)` : ''}${newForecasts.length ? ` + ${newForecasts.length} peer-based` : ''}` });

    const grandTotal = allForecasts.reduce((s, f) => s + (parseFloat(f.total_forecast) || 0), 0);
    const counts     = { high: 0, medium: 0, low: 0 };
    allForecasts.forEach(f => counts[f.confidence]++);

    const payload = {
      forecasts: allForecasts,
      executive_summary: `AI forecast for ${allForecasts.length} segments, FY${forecastYear}. Total: ₹${Math.round(grandTotal).toLocaleString('en-IN')}. Confidence: ${counts.high} HIGH, ${counts.medium} MEDIUM, ${counts.low} LOW.`,
      methodology: 'Claude Haiku with triangular-weighted seasonal decomposition. 10 segments/batch, 5 parallel. Algorithmic fallback on API failure or scale error.',
      risk_factors: [
        'Forecast based on historical patterns — external factors not modelled.',
        'Low-confidence segments (single year of data) may have higher error.',
      ],
    };

    emit('status', { step: 4, msg: '💾 Saving to PostgreSQL...' });
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
            JSON.stringify(payload.risk_factors),
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

    emit('status', { step: 4, msg: '✅ Saved!' });
    emit('complete', { forecast: payload, forecastYear });

  } catch (err) {
    console.error('[forecast/generate]', err.message);
    emit('error', { msg: err.message });
  } finally {
    res.end();
  }
});

// GET /api/forecast/latest — fetch all stored forecasts for UI
router.get('/latest', async (_req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM forecasts ORDER BY forecast_year DESC, cust_old, fiscvarnt');
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

module.exports = router;
