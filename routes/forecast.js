'use strict';

require('dotenv').config();
const express   = require('express');
const Anthropic  = require('@anthropic-ai/sdk');
const pool      = require('../db');

const router = express.Router();
const ai     = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MONTHS      = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const MONTH_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// ─────────────────────────────────────────────────────────────────────────────
// Tool definition — forced structured JSON output via tool_use
// strict: true guarantees Claude always returns schema-valid JSON
// ─────────────────────────────────────────────────────────────────────────────
const FORECAST_TOOL = {
  name: 'submit_forecast',
  description: `Submit the complete monthly sales forecast for the next fiscal year.
Call this tool once with ALL segments. Every number must be a precise integer or decimal in INR.`,
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['forecasts', 'executive_summary', 'methodology', 'risk_factors'],
    properties: {
      forecasts: {
        type: 'array',
        description: 'One entry per cust_old + fiscvarnt combination',
        items: {
          type: 'object',
          additionalProperties: false,
          required: [
            'cust_old','fiscvarnt','forecast_year',
            'jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec',
            'total_forecast','yoy_growth_pct','confidence','key_insights','seasonal_pattern'
          ],
          properties: {
            cust_old:         { type: 'string' },
            fiscvarnt:        { type: 'string' },
            forecast_year:    { type: 'integer' },
            jan:  { type: 'number', description: 'January forecast (INR)' },
            feb:  { type: 'number' }, mar:  { type: 'number' },
            apr:  { type: 'number' }, may:  { type: 'number' },
            jun:  { type: 'number' }, jul:  { type: 'number' },
            aug:  { type: 'number' }, sep:  { type: 'number' },
            oct:  { type: 'number' }, nov:  { type: 'number' },
            dec:  { type: 'number', description: 'December forecast (INR)' },
            total_forecast:   { type: 'number', description: 'Sum of all 12 monthly forecasts' },
            yoy_growth_pct:   { type: 'number', description: 'YoY growth % vs most recent year' },
            confidence:       { type: 'string', enum: ['high','medium','low'] },
            key_insights:     { type: 'array',  items: { type: 'string' }, minItems: 3 },
            seasonal_pattern: { type: 'string', description: 'Observed seasonal pattern description' }
          }
        }
      },
      executive_summary: { type: 'string', description: '3-5 sentence executive summary' },
      methodology:       { type: 'string', description: 'Forecasting method description' },
      risk_factors:      { type: 'array',  items: { type: 'string' }, minItems: 2, description: 'Key forecast risks' }
    }
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Pre-process DB rows into rich analytics before sending to Claude.
// Giving Claude pre-computed stats dramatically improves forecast quality.
// ─────────────────────────────────────────────────────────────────────────────
function computeAnalytics(rows) {
  const groups = {};

  rows.forEach(row => {
    const key = `${row.cust_old}|${row.fiscvarnt}`;
    if (!groups[key]) groups[key] = { cust_old: row.cust_old, fiscvarnt: row.fiscvarnt, byYear: {} };
    groups[key].byYear[Number(row.year)] = MONTHS.reduce((acc, m) => {
      acc[m] = parseFloat(row[m]) || 0;
      return acc;
    }, {});
  });

  return Object.values(groups).map(grp => {
    const years     = Object.keys(grp.byYear).map(Number).sort();
    const maxYear   = Math.max(...years);
    const forecastYear = maxYear + 1;

    // Annual totals
    const annualTotals = {};
    years.forEach(y => {
      annualTotals[y] = MONTHS.reduce((s, m) => s + grp.byYear[y][m], 0);
    });

    // Year-over-year growth rates
    const yoyGrowth = {};
    for (let i = 1; i < years.length; i++) {
      const [prev, curr] = [years[i - 1], years[i]];
      const base = Math.abs(annualTotals[prev]);
      yoyGrowth[`${prev}→${curr}`] = base > 0
        ? +((annualTotals[curr] - annualTotals[prev]) / base * 100).toFixed(2)
        : 0;
    }

    // CAGR across all available years
    const firstTotal = annualTotals[years[0]];
    const lastTotal  = annualTotals[maxYear];
    const cagr = (years.length > 1 && Math.abs(firstTotal) > 0)
      ? +((Math.pow(Math.abs(lastTotal) / Math.abs(firstTotal), 1 / (years.length - 1)) - 1) * 100).toFixed(2)
      : 0;

    // Seasonal indices per year (month value / monthly avg × 100)
    const seasonalByYear = {};
    years.forEach(y => {
      const monthlyAvg = annualTotals[y] / 12;
      seasonalByYear[y] = MONTHS.reduce((acc, m) => {
        acc[m] = monthlyAvg !== 0 ? +(grp.byYear[y][m] / monthlyAvg * 100).toFixed(1) : 0;
        return acc;
      }, {});
    });

    // Weighted average seasonal index: recent year gets 50%, year-1 gets 30%, year-2 gets 20%
    const weights = years.length >= 3
      ? { [years[years.length-1]]: 0.50, [years[years.length-2]]: 0.30, [years[years.length-3]]: 0.20 }
      : years.length === 2
        ? { [years[1]]: 0.65, [years[0]]: 0.35 }
        : { [years[0]]: 1.0 };

    const wtdSeasonalIdx = MONTHS.reduce((acc, m) => {
      acc[m] = +Object.entries(weights).reduce((s, [y, w]) => s + (seasonalByYear[Number(y)]?.[m] ?? 0) * w, 0).toFixed(1);
      return acc;
    }, {});

    // Weighted annual trend projection (same weights applied to annual totals)
    const wtdAnnualBase = +Object.entries(weights)
      .reduce((s, [y, w]) => s + (annualTotals[Number(y)] ?? 0) * w, 0)
      .toFixed(0);

    return {
      cust_old:       grp.cust_old,
      fiscvarnt:      grp.fiscvarnt,
      forecastYear,
      years,
      byYear:         grp.byYear,
      annualTotals,
      yoyGrowth,
      cagr,
      seasonalByYear,
      wtdSeasonalIdx,
      wtdAnnualBase,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Build structured prompt — pre-computed analytics reduces hallucination risk
// ─────────────────────────────────────────────────────────────────────────────
function buildPrompt(analyticsArr) {
  const segments = analyticsArr.map(a => {
    const header = [
      `\n### Segment  Customer: ${a.cust_old}  |  FiscalVariant: ${a.fiscvarnt}`,
      `Forecast Target: **${a.forecastYear}**`,
    ];

    // Monthly data table
    const colHeader = `| Month | ${a.years.join(' | ')} |`;
    const separator = `|-------|${a.years.map(() => '----------:').join('|')}|`;
    const dataRows  = MONTHS.map((m, i) =>
      `| ${MONTH_SHORT[i].padEnd(5)} | ${a.years.map(y => a.byYear[y][m].toLocaleString('en-IN')).join(' | ')} |`
    );
    const totalRow  = `| **TOTAL** | ${a.years.map(y => Math.round(a.annualTotals[y]).toLocaleString('en-IN')).join(' | ')} |`;

    // Growth stats
    const growthLines = Object.entries(a.yoyGrowth)
      .map(([period, pct]) => `- ${period}: **${pct > 0 ? '+' : ''}${pct}%**`);
    growthLines.push(`- CAGR (${a.years[0]}–${a.years[a.years.length-1]}): **${a.cagr > 0 ? '+' : ''}${a.cagr}%**`);

    // Seasonal index table
    const siHeader = `| Month | ${a.years.map(y => `SI_${y}`).join(' | ')} | Weighted SI |`;
    const siSep    = `|-------|${a.years.map(() => '-------:').join('|')}|----------:|`;
    const siRows   = MONTHS.map((m, i) => {
      const vals = a.years.map(y => (a.seasonalByYear[y]?.[m] ?? 0).toFixed(1)).join(' | ');
      const wsi  = a.wtdSeasonalIdx[m].toFixed(1);
      return `| ${MONTH_SHORT[i].padEnd(5)} | ${vals} | **${wsi}** |`;
    });

    return [
      ...header,
      '\n**Monthly Turnover (INR):**',
      colHeader, separator, ...dataRows, totalRow,
      '\n**YoY Growth Analysis:**',
      ...growthLines,
      `\n**Seasonal Indices (100 = average month; >100 = above-average month):**`,
      siHeader, siSep, ...siRows,
      `\n**Weighted Annual Base for ${a.forecastYear} projection:** ₹${Math.round(a.wtdAnnualBase).toLocaleString('en-IN')}`,
    ].join('\n');
  });

  return `You are forecasting next-year sales. Use the pre-computed analytics below.

${segments.join('\n\n---\n')}

---
## Forecasting Instructions

**Step 1 — Trend-adjusted annual target**
Start from the Weighted Annual Base and apply the CAGR-informed growth rate.
Use recent YoY growth trend (give more weight to the most recent YoY vs earlier ones).

**Step 2 — Monthly distribution**
Apply each month's Weighted Seasonal Index to distribute the annual target:
  month_forecast = annual_target × (Weighted_SI / 1200)

**Step 3 — Sanity check**
Verify that sum(jan..dec) ≈ total_forecast.

**Step 4 — Confidence assessment**
- HIGH: 3+ years of stable seasonal patterns, consistent YoY trend
- MEDIUM: Some volatility or only 2 data points
- LOW: High variance or inconsistent patterns

Return all results via the submit_forecast tool.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/forecast/generate
// Streams SSE events back: status | thinking | complete | error
// ─────────────────────────────────────────────────────────────────────────────
router.post('/generate', async (req, res) => {
  // SSE headers
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  const emit = (event, data) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  try {
    // ── Step 1: Load historical data ────────────────────────
    emit('status', { step: 1, msg: '📊 Loading historical data from DB...' });

    const { rows } = await pool.query(
      'SELECT * FROM past_sales ORDER BY year, cust_old, fiscvarnt'
    );
    if (!rows.length) throw new Error('No historical data found. Upload Excel first.');

    const yearSet = new Set(rows.map(r => r.year));
    emit('status', { step: 1, msg: `✅ ${rows.length} records loaded across ${yearSet.size} year(s)` });

    // ── Step 2: Pre-compute analytics ───────────────────────
    emit('status', { step: 2, msg: '🔢 Computing trends, seasonal indices, CAGR...' });
    const analytics   = computeAnalytics(rows);
    const forecastYear = analytics[0]?.forecastYear;
    emit('status', { step: 2, msg: `✅ Analytics ready for ${analytics.length} segment(s) → forecasting year ${forecastYear}` });

    // ── Step 3: Call Claude Opus 5.5 with streaming ─────────
    emit('status', { step: 3, msg: '🤖 Claude Opus 5.5 is analyzing patterns (this may take 30–90 seconds)...' });
    emit('thinking', { msg: 'Initializing AI analysis with adaptive thinking...' });

    const msgStream = ai.messages.stream({
      model:        'claude-opus-5-5',
      max_tokens:   64000,
      thinking:     { type: 'adaptive', display: 'summarized' },
      output_config:{ effort: 'high' },
      system: `You are an elite sales forecasting analyst with deep expertise in:
- Time-series decomposition and trend analysis
- Seasonal pattern recognition and adjustment
- Statistical forecasting (weighted moving averages, exponential smoothing)
- Retail and distribution sales cycles

You produce precise, reproducible forecasts with clear quantitative reasoning.
IMPORTANT: You MUST call the submit_forecast tool — do not return plain text.`,
      messages: [{ role: 'user', content: buildPrompt(analytics) }],
      tools:   [FORECAST_TOOL],
    });

    // Forward summarized thinking snippets to client for UX feedback
    msgStream.on('inputJson', (_delta, snapshot) => {
      if (snapshot && typeof snapshot === 'object' && snapshot.forecasts) {
        emit('thinking', { msg: `🔄 Building forecast for ${snapshot.forecasts.length} segment(s)...` });
      }
    });

    // Await full response
    const finalMsg = await msgStream.finalMessage();

    const toolBlock = finalMsg.content.find(b => b.type === 'tool_use' && b.name === 'submit_forecast');
    if (!toolBlock) {
      const textFallback = finalMsg.content.find(b => b.type === 'text')?.text || '';
      throw new Error(`Claude did not call the forecast tool. Response: ${textFallback.slice(0, 300)}`);
    }

    const payload = toolBlock.input;
    emit('status', { step: 3, msg: `✅ Forecast generated — ${payload.forecasts.length} segment(s), ${finalMsg.usage.output_tokens.toLocaleString()} output tokens` });

    // ── Step 4: Persist to DB ────────────────────────────────
    emit('status', { step: 4, msg: '💾 Saving forecast to PostgreSQL...' });

    const dbClient = await pool.connect();
    try {
      await dbClient.query('BEGIN');

      for (const f of payload.forecasts) {
        await dbClient.query(
          `INSERT INTO forecasts
             (cust_old, fiscvarnt, forecast_year,
              jan,feb,mar,apr,may,jun,jul,aug,sep,oct,nov,dec,
              total_forecast, yoy_growth_pct, confidence,
              key_insights, risk_factors, seasonal_pattern,
              executive_summary, methodology, generated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
                   $16,$17,$18,$19,$20,$21,$22,$23,NOW())
           ON CONFLICT (cust_old, fiscvarnt, forecast_year) DO UPDATE SET
             jan=$4,feb=$5,mar=$6,apr=$7,may=$8,jun=$9,jul=$10,
             aug=$11,sep=$12,oct=$13,nov=$14,dec=$15,
             total_forecast=$16, yoy_growth_pct=$17, confidence=$18,
             key_insights=$19, risk_factors=$20, seasonal_pattern=$21,
             executive_summary=$22, methodology=$23, generated_at=NOW()`,
          [
            f.cust_old, f.fiscvarnt, f.forecast_year,
            f.jan, f.feb, f.mar, f.apr, f.may, f.jun,
            f.jul, f.aug, f.sep, f.oct, f.nov, f.dec,
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

    emit('status', { step: 4, msg: '✅ Forecast saved to DB!' });
    emit('complete', {
      forecast:     payload,
      forecastYear,
      tokens: {
        input:  finalMsg.usage.input_tokens,
        output: finalMsg.usage.output_tokens,
      },
    });

  } catch (err) {
    console.error('[forecast] error:', err.message);
    emit('error', { msg: err.message });
  } finally {
    res.end();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/forecast/latest  — fetch stored forecasts for UI display
// ─────────────────────────────────────────────────────────────────────────────
router.get('/latest', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM forecasts ORDER BY forecast_year DESC, cust_old, fiscvarnt'
    );
    res.json({ count: rows.length, data: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Structured tool for deep-dive recommendation (Haiku — fast & cheap)
// ─────────────────────────────────────────────────────────────────────────────
const RECOMMEND_TOOL = {
  name: 'submit_recommendation',
  description: 'Submit deep-dive reasoning, confidence breakdown, and actionable recommendations for a sales forecast row.',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['reasoning_summary', 'confidence_explanation', 'recommendations', 'monthly_highlights'],
    properties: {
      reasoning_summary: {
        type: 'string',
        description: '3-5 sentences explaining WHY these forecast numbers were derived from the historical data.'
      },
      confidence_explanation: {
        type: 'string',
        description: 'Explain specifically what makes the confidence HIGH/MEDIUM/LOW for this forecast.'
      },
      recommendations: {
        type: 'array',
        minItems: 3,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['action', 'rationale', 'priority'],
          properties: {
            action:    { type: 'string', description: 'Specific actionable recommendation for the sales/business team' },
            rationale: { type: 'string', description: 'Why this action is important based on the forecast data' },
            priority:  { type: 'string', enum: ['high', 'medium', 'low'] }
          }
        }
      },
      monthly_highlights: {
        type: 'array',
        description: 'Call out 3-4 notable months (peak, trough, inflection points)',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['month', 'forecast_value', 'note'],
          properties: {
            month:          { type: 'string' },
            forecast_value: { type: 'number' },
            note:           { type: 'string', description: 'Why this month is noteworthy' }
          }
        }
      }
    }
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/forecast/recommend
// Body: { cust_old, fiscvarnt, forecast_year }
// Returns deep reasoning + recommendations using Claude Haiku (fast)
// ─────────────────────────────────────────────────────────────────────────────
router.post('/recommend', async (req, res) => {
  const { cust_old, fiscvarnt, forecast_year } = req.body || {};

  if (!cust_old || !fiscvarnt || !forecast_year) {
    return res.status(400).json({ error: 'cust_old, fiscvarnt, forecast_year are required.' });
  }

  try {
    // Fetch the stored forecast row
    const { rows: fRows } = await pool.query(
      `SELECT * FROM forecasts
       WHERE cust_old=$1 AND fiscvarnt=$2 AND forecast_year=$3 LIMIT 1`,
      [cust_old, fiscvarnt, Number(forecast_year)]
    );
    if (!fRows.length) return res.status(404).json({ error: 'Forecast not found. Generate it first.' });

    // Fetch the historical baseline
    const { rows: hRows } = await pool.query(
      `SELECT * FROM past_sales
       WHERE cust_old=$1 AND fiscvarnt=$2 ORDER BY year`,
      [cust_old, fiscvarnt]
    );

    const f = fRows[0];

    // Build compact context for Haiku
    const histSummary = hRows.map(r =>
      `${r.year}: ${MONTHS.map(m => `${MONTH_SHORT[MONTHS.indexOf(m)]}=₹${Math.round(parseFloat(r[m])||0).toLocaleString('en-IN')}`).join(', ')}`
    ).join('\n');

    const fcstSummary = MONTHS
      .map((m, i) => `${MONTH_SHORT[i]}: ₹${Math.round(parseFloat(f[m])||0).toLocaleString('en-IN')}`)
      .join(' | ');

    const prompt = `You are a senior sales analyst. Analyze this forecast and provide actionable business intelligence.

CUSTOMER: ${cust_old}  |  FISCAL VARIANT: ${fiscvarnt}  |  FORECAST YEAR: ${forecast_year}
CONFIDENCE: ${f.confidence?.toUpperCase()}
YoY GROWTH FORECAST: ${Number(f.yoy_growth_pct).toFixed(2)}%

HISTORICAL DATA:
${histSummary}

${forecast_year} FORECAST (monthly):
${fcstSummary}
TOTAL: ₹${Math.round(parseFloat(f.total_forecast)||0).toLocaleString('en-IN')}

SEASONAL PATTERN NOTED: ${f.seasonal_pattern || 'N/A'}
METHODOLOGY USED: ${f.methodology || 'N/A'}

Provide deep reasoning, confidence explanation, and 3-5 specific business recommendations.
Call the submit_recommendation tool with your analysis.`;

    const response = await ai.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      system:     'You are a sharp, data-driven sales analytics expert. Always call the submit_recommendation tool.',
      messages:   [{ role: 'user', content: prompt }],
      tools:      [RECOMMEND_TOOL],
    });

    const toolBlock = response.content.find(b => b.type === 'tool_use' && b.name === 'submit_recommendation');
    if (!toolBlock) {
      const fallback = response.content.find(b => b.type === 'text')?.text || 'No recommendation generated.';
      return res.status(500).json({ error: fallback.slice(0, 300) });
    }

    res.json({
      cust_old, fiscvarnt, forecast_year,
      confidence: f.confidence,
      ...toolBlock.input,
      tokens: { input: response.usage.input_tokens, output: response.usage.output_tokens },
    });

  } catch (err) {
    console.error('[recommend] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
