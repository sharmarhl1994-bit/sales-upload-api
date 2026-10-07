# AOP (Annual Operating Plan) — Fashion Industry India
## Complete Design Document

---

## 1. WHY THIS DOCUMENT

Current system sirf **past sales ka simple forecast** karta hai.
AOP ke liye hume **store-level, zone-level, category-level** plan chahiye
with India-specific seasonality (festivals, weather, city tier).

---

## 2. KEY FACTOR LAYERS

### Layer 1 — Revenue Drivers (Must Have)
**Reason: Ye directly sales decide karte hain**

| Factor | What It Is | Why Important |
|---|---|---|
| Monthly Sales (₹ + Units) | Har store ka monthly turnover | Base data — iske bina kuch nahi |
| Average Transaction Value | Avg bill amount per customer | Rising ATV = premiumization trend |
| Units Per Transaction | Kitne piece ek bill mein | Fashion mein 1.8-2.2 UPT normal |
| Footfall | Kitne log aaye store mein | Conversion = buyers/footfall |
| Conversion Rate | Footfall mein se kitne khareedey | 15-25% good for fashion |
| Revenue per Sq Ft | Sales / store area | Store efficiency measure |
| Sell-Through Rate | Stock mein se kitna bikaa | Low STR = wrong buying plan |

---

### Layer 2 — Store DNA (Must Have)
**Reason: Har store ka behavior structurally alag hai**

| Factor | What It Is | Why Important |
|---|---|---|
| Store Age | Opening date se months | Naya store grow karta hai, mature plateau |
| Store Area (sq ft) | Physical size | Large store = more categories = different mix |
| Location Type | Mall / High Street / Standalone | Mall mein footfall organic, HS mein loyal |
| City Tier | 1 / 2 / 3 / 4 | Tier 1 = premium, Tier 3 = value-conscious |
| Zone | North/South/East/West | Festival pattern alag, weather alag |
| State | Specific state | Tax structure, local festival, income level |
| Competition Count | Nearby competitor stores | High competition = margin pressure |

---

### Layer 3 — India Festival Calendar (Critical — India Unique)
**Reason: Fashion industry ka 35-40% revenue festival windows mein aata hai**

| Festival | Zone Impact | Months | Sales Spike |
|---|---|---|---|
| Diwali | Pan India (North max) | Oct-Nov | +40-60% |
| Durga Puja | East (Bengal max) | Oct | +50-70% |
| Navratri | West (Gujarat max) | Oct | +30-40% |
| Eid | Pan India (varies) | Variable | +25-35% |
| Onam | South (Kerala) | Aug-Sep | +30-40% |
| Pongal | South (TN) | Jan | +20-30% |
| Wedding Season | North (heavy), West | Nov-Feb, Apr-Jun | +25-35% |
| Summer (Kids) | Pan India | Apr-May | +20-25% |

---

### Layer 4 — External Macro (Good to Have)
**Reason: Market conditions adjust karne ke liye**

| Factor | Why Needed | Impact |
|---|---|---|
| Inflation (CPI) | High inflation = downtrading to economy | ±10-15% on premium mix |
| E-commerce Pricing | Myntra/Ajio discount = store footfall down | -5-8% in sale season |
| New Store Openings | Cannibalization of nearby stores | -3-8% in catchment |
| State GDP Growth | Purchasing power | Positive correlation |

---

## 3. FEATURE ENGINEERING

### 3A — Time Features (Tum Compute Karo)

```
sales_lag_12M    = same month last year           → Strongest predictor (35-40% importance)
sales_lag_3M     = 3 month rolling average        → Short-term trend
yoy_growth       = (this - last_year) / last_year → Growth direction
rolling_3M_std   = 3 month standard deviation     → Volatility signal
cagr             = compound annual growth rate     → Long-term trend

month_sin = sin(2π × month / 12)   → Circular encoding
month_cos = cos(2π × month / 12)   → Month 12 aur Jan close hain
quarter   = ceil(month / 3)        → Q1/Q2/Q3/Q4
```

**Why circular encoding:** Agar month = 12 aur month = 1 ko linear treat karo,
model sochega 12 aur 1 mein 11 months ka gap hai — galat.
Sin/Cos encoding se Dec aur Jan close hote hain correctly.

---

### 3B — Festival Features (Tum Compute Karo)
**Reason: Claude ko ye bhejne ki zaroorat nahi — pure date math hai**

```
days_to_next_festival  = min(days to Diwali, Eid, Puja, Onam...)
pre_festival_window    = 1 if days_to_next_festival <= 14 else 0
post_festival_dip      = 1 if days_since_festival <= 7 else 0
is_wedding_season      = 1 if month in [11,12,1,2,4,5] else 0

Zone × Festival interaction:
north_wedding          = is_north × is_wedding_season
east_puja              = is_east × is_oct           (Durga Puja)
west_navratri          = is_west × is_oct
south_onam             = is_south × is_aug_sep
```

---

### 3C — Store Features (Tum Compute Karo)

```
store_age_months   = (current_date - store_opening_date) in months
store_maturity     = log(store_age_months + 1)   → diminishing returns curve

rev_per_sqft       = monthly_sales / store_area_sqft
catchment_score    = (city_tier_score × 0.4) + (location_score × 0.3) + (competition_penalty × 0.3)

growth_velocity    = 3M rolling slope   → accelerating or decelerating?
```

---

### 3D — Product Health Features (Tum Compute Karo)

```
sell_through_rate   = units_sold / units_received        → demand health
weeks_of_cover      = closing_stock / avg_weekly_sales   → inventory risk
markdown_depth      = avg_discount_pct                   → pricing pressure
premium_mix_pct     = premium_sales / total_sales        → premiumization
new_arrival_pct     = new_sku_sales / total_sales        → freshness
```

---

## 4. WHAT YOU COMPUTE vs WHAT CLAUDE DOES

### You Compute (Code mein — free, fast, deterministic)

| Computation | Where | Reason |
|---|---|---|
| Monthly forecast numbers | `computeAnalytics()` | Pure math — `annual × SI/1200` |
| Annual target | `computeAnalytics()` | `weighted_base × (1 + cagr)` |
| YoY growth % | `computeAnalytics()` | Already done |
| CAGR | `computeAnalytics()` | Already done |
| Seasonal indices | `computeAnalytics()` | Already done |
| Festival day counts | New function | Date math |
| Store maturity score | New function | log formula |
| Growth std deviation | `computeAnalytics()` | Confidence signal |
| SI variance | `computeAnalytics()` | Confidence signal |
| Sell-through rate | New function | Inventory health |

### Claude Does (AI — expensive, for judgment only)

| Task | Why Claude | Not You |
|---|---|---|
| Confidence level (HIGH/MED/LOW) | Requires judgment on multiple signals | Rule-based misses edge cases |
| Key insights (3 bullets) | Natural language pattern description | You can't auto-write business language |
| Executive summary | Narrative across multiple stores | Complex language generation |
| Risk factors | Business context reasoning | Requires domain knowledge synthesis |
| Seasonal pattern description | 1-line qualitative description | Language task |
| Recommendations | Actionable business advice | Judgment + language |

**Token saving result: ~70% less tokens sent to Claude**

---

## 5. DB CHANGES REQUIRED

### 5A — New Table: `store_master`
**Reason: Store attributes abhi DB mein hain hi nahi — hardcode karna padta**

```sql
CREATE TABLE store_master (
    id              SERIAL PRIMARY KEY,
    store_code      VARCHAR(20) UNIQUE NOT NULL,  -- e.g. MUM_001
    store_name      VARCHAR(100),
    zone            VARCHAR(10) NOT NULL,          -- NORTH/SOUTH/EAST/WEST
    state           VARCHAR(50) NOT NULL,
    city            VARCHAR(50),
    city_tier       INTEGER NOT NULL,              -- 1/2/3/4
    location_type   VARCHAR(20),                   -- MALL/HIGHSTREET/STANDALONE
    store_area_sqft INTEGER,
    opening_date    DATE NOT NULL,
    is_active       BOOLEAN DEFAULT TRUE,
    created_at      TIMESTAMP DEFAULT NOW()
);
```

---

### 5B — New Table: `festival_calendar`
**Reason: Festival dates har saal change hoti hain (Diwali, Eid) — hardcode nahi kar sakte**

```sql
CREATE TABLE festival_calendar (
    id              SERIAL PRIMARY KEY,
    festival_name   VARCHAR(50) NOT NULL,   -- DIWALI, EID, DURGA_PUJA etc.
    festival_date   DATE NOT NULL,
    zone_applicable VARCHAR(20) DEFAULT 'ALL',  -- ALL/NORTH/SOUTH/EAST/WEST
    importance      VARCHAR(10) DEFAULT 'HIGH', -- HIGH/MEDIUM/LOW
    UNIQUE(festival_name, festival_date)
);

-- Sample data insert:
INSERT INTO festival_calendar VALUES
(DEFAULT, 'DIWALI',     '2024-11-01', 'ALL',   'HIGH'),
(DEFAULT, 'DURGA_PUJA', '2024-10-13', 'EAST',  'HIGH'),
(DEFAULT, 'EID',        '2024-04-10', 'ALL',   'HIGH'),
(DEFAULT, 'NAVRATRI',   '2024-10-03', 'WEST',  'HIGH'),
(DEFAULT, 'ONAM',       '2024-09-15', 'SOUTH', 'HIGH'),
(DEFAULT, 'PONGAL',     '2025-01-14', 'SOUTH', 'MEDIUM'),
(DEFAULT, 'DIWALI',     '2025-10-20', 'ALL',   'HIGH');
```

---

### 5C — Modify Existing Table: `past_sales`
**Reason: Store-level data link karna hai, abhi sirf cust_old hai**

```sql
-- Add store_code column to link with store_master
ALTER TABLE past_sales ADD COLUMN store_code VARCHAR(20);
ALTER TABLE past_sales ADD COLUMN footfall    INTEGER DEFAULT 0;
ALTER TABLE past_sales ADD COLUMN atv         NUMERIC(10,2) DEFAULT 0;  -- avg transaction value
ALTER TABLE past_sales ADD COLUMN sell_through_rate NUMERIC(5,2) DEFAULT 0;

-- Index for performance
CREATE INDEX idx_past_sales_store ON past_sales(store_code);
CREATE INDEX idx_past_sales_year  ON past_sales(year);
CREATE INDEX idx_past_sales_cust  ON past_sales(cust_old);
```

---

### 5D — New Table: `aop_forecast`
**Reason: AOP store+category level hota hai, current `forecasts` table sirf customer level hai**

```sql
CREATE TABLE aop_forecast (
    id              SERIAL PRIMARY KEY,
    store_code      VARCHAR(20) NOT NULL,
    zone            VARCHAR(10),
    state           VARCHAR(50),
    city_tier       INTEGER,
    category        VARCHAR(30) DEFAULT 'TOTAL', -- MENS/WOMENS/KIDS/TOTAL
    forecast_year   INTEGER NOT NULL,

    -- Monthly plan (₹)
    jan  NUMERIC(18,2) DEFAULT 0,
    feb  NUMERIC(18,2) DEFAULT 0,
    mar  NUMERIC(18,2) DEFAULT 0,
    apr  NUMERIC(18,2) DEFAULT 0,
    may  NUMERIC(18,2) DEFAULT 0,
    jun  NUMERIC(18,2) DEFAULT 0,
    jul  NUMERIC(18,2) DEFAULT 0,
    aug  NUMERIC(18,2) DEFAULT 0,
    sep  NUMERIC(18,2) DEFAULT 0,
    oct  NUMERIC(18,2) DEFAULT 0,
    nov  NUMERIC(18,2) DEFAULT 0,
    dec  NUMERIC(18,2) DEFAULT 0,
    total_forecast  NUMERIC(18,2) DEFAULT 0,

    -- Growth signals (pre-computed by your code)
    cagr                NUMERIC(8,4),
    yoy_growth_pct      NUMERIC(8,4),
    growth_std_dev      NUMERIC(8,4),     -- volatility
    si_variance         NUMERIC(8,4),     -- seasonal consistency

    -- Festival impact score (pre-computed)
    festival_boost_oct  NUMERIC(5,2),     -- Oct festival impact for zone
    festival_boost_nov  NUMERIC(5,2),     -- Diwali impact

    -- Store context (denormalized for fast reads)
    store_age_months    INTEGER,
    store_maturity_score NUMERIC(5,3),

    -- Claude output (qualitative only)
    confidence          VARCHAR(10),
    key_insights        JSONB,
    risk_factors        JSONB,
    seasonal_pattern    TEXT,
    executive_summary   TEXT,
    methodology         TEXT,

    generated_at        TIMESTAMP DEFAULT NOW(),

    CONSTRAINT uq_aop UNIQUE(store_code, category, forecast_year)
);

CREATE INDEX idx_aop_store  ON aop_forecast(store_code);
CREATE INDEX idx_aop_zone   ON aop_forecast(zone);
CREATE INDEX idx_aop_year   ON aop_forecast(forecast_year);
```

---

## 6. CODE CHANGES REQUIRED

### 6A — New File: `utils/computeAOP.js`
**Reason: AOP-specific calculations — `computeAnalytics()` se alag rakhna**

```javascript
'use strict';
const pool = require('../db');

// Festival day calculation — Claude ko bhejne ki zaroorat nahi
async function getFestivalSignals(zone, targetDate) {
  const { rows } = await pool.query(
    `SELECT festival_name, festival_date
     FROM festival_calendar
     WHERE (zone_applicable = $1 OR zone_applicable = 'ALL')
       AND festival_date BETWEEN $2 AND $2::date + INTERVAL '365 days'
     ORDER BY festival_date`,
    [zone, targetDate]
  );

  const daysToNext = rows.length > 0
    ? Math.ceil((new Date(rows[0].festival_date) - new Date(targetDate)) / 86400000)
    : 999;

  return {
    daysToNextFestival: daysToNext,
    preFestivalWindow:  daysToNext <= 14 ? 1 : 0,
    nextFestivalName:   rows[0]?.festival_name || 'NONE',
    festivalCount90Days: rows.filter(r =>
      (new Date(r.festival_date) - new Date(targetDate)) / 86400000 <= 90
    ).length
  };
}

// Store maturity curve
function computeStoreMaturity(openingDate) {
  const months = Math.floor(
    (new Date() - new Date(openingDate)) / (1000 * 60 * 60 * 24 * 30)
  );
  return {
    ageMonths:     months,
    maturityScore: +Math.log(months + 1).toFixed(3), // log curve — diminishing returns
    isNewStore:    months < 12,
    isMatureStore: months > 36,
  };
}

// Monthly forecast from pre-computed signals — no Claude needed for this
function computeMonthlyForecast(wtdAnnualBase, cagr, wtdSeasonalIdx, MONTHS) {
  const forecastAnnual = +(wtdAnnualBase * (1 + cagr / 100)).toFixed(0);
  const forecastMonthly = {};
  MONTHS.forEach(m => {
    forecastMonthly[m] = +(forecastAnnual * (wtdSeasonalIdx[m] / 1200)).toFixed(2);
  });
  return { forecastAnnual, forecastMonthly };
}

// Confidence signals — pass to Claude as pre-computed numbers
function computeConfidenceSignals(yoyGrowth, seasonalByYear, MONTHS, years) {
  const yoyValues  = Object.values(yoyGrowth);
  const avgGrowth  = yoyValues.reduce((s, v) => s + v, 0) / (yoyValues.length || 1);
  const growthStdDev = yoyValues.length > 1
    ? +Math.sqrt(
        yoyValues.reduce((s, v) => s + Math.pow(v - avgGrowth, 2), 0) / yoyValues.length
      ).toFixed(2)
    : 0;

  const siVariance = MONTHS.reduce((s, m) => {
    const vals  = years.map(y => seasonalByYear[y]?.[m] ?? 0);
    const avg   = vals.reduce((a, b) => a + b, 0) / vals.length;
    const std   = Math.sqrt(vals.reduce((a, b) => a + Math.pow(b - avg, 2), 0) / vals.length);
    return s + std;
  }, 0) / 12;

  return { growthStdDev, siVariance, dataYears: years.length };
}

module.exports = {
  getFestivalSignals,
  computeStoreMaturity,
  computeMonthlyForecast,
  computeConfidenceSignals,
};
```

---

### 6B — Modify `routes/forecast.js`

**buildPrompt() — 70% token reduction**

```javascript
// OLD: Full markdown tables — ~630 tokens per customer
// NEW: Compressed signals only — ~180 tokens per customer

function buildPrompt(analyticsArr) {
  const segments = analyticsArr.map(a => {
    // Send pre-computed monthly numbers — not raw data
    const monthly = MONTHS.map((m, i) =>
      `${MONTH_SHORT[i]}:${Math.round(a.forecastMonthly[m]).toLocaleString('en-IN')}`
    ).join(' ');

    const recentYoY = Object.entries(a.yoyGrowth)
      .slice(-2)
      .map(([p, v]) => `${p}:${v > 0 ? '+' : ''}${v}%`)
      .join(', ');

    return [
      `SEGMENT: ${a.cust_old} | ${a.fiscvarnt} | Year: ${a.forecastYear}`,
      `Data: ${a.dataYears} years | CAGR: ${a.cagr > 0 ? '+' : ''}${a.cagr}%`,
      `Recent YoY: ${recentYoY}`,
      `Growth StdDev: ${a.growthStdDev}% | SI Variance: ${a.siVariance.toFixed(1)}`,
      `Pre-computed forecast: ${monthly}`,
      `Annual Total: ₹${Math.round(a.forecastAnnual).toLocaleString('en-IN')}`,
    ].join('\n');
  });

  return `Validate these pre-computed sales forecasts and provide qualitative analysis.

${segments.join('\n\n---\n')}

---
Rules:
- Return exact pre-computed jan-dec values (adjust ±5% only if strong reason)
- total_forecast = sum of jan to dec
- confidence: HIGH if StdDev<5 and years>=3, MEDIUM if StdDev<15, LOW otherwise
- Provide key_insights, seasonal_pattern, risk_factors
- Call submit_forecast tool.`;
}
```

---

### 6C — New Route: `routes/aop.js`
**Reason: AOP is separate from simple forecast — store+zone+category level**

```javascript
// New endpoints needed:
// POST /api/aop/generate   — generate AOP for all stores
// GET  /api/aop/summary    — zone/state level rollup
// GET  /api/aop/store/:code — single store AOP detail
```

---

## 7. EXCEL UPLOAD CHANGES

### New Columns to Add in Upload

```
Current Excel columns used:
/BIC/ZCUST_OLD, CALMONTH2, CALYEAR, FISCVARNT, /BIC/ZTURNOVR

New columns to map (if available in your SAP BW export):
STORE_CODE    → store_master.store_code
FOOTFALL      → past_sales.footfall
SELL_THROUGH  → past_sales.sell_through_rate
CATEGORY      → aop_forecast.category (MENS/WOMENS/KIDS)
```

---

## 8. WHAT TO DO — PRIORITY ORDER

### Phase 1 — Foundation (Ye pehle karo)
- [ ] Run `store_master` table SQL
- [ ] Run `festival_calendar` table SQL + insert 2024-2026 dates
- [ ] Add `store_code`, `footfall` columns to `past_sales`
- [ ] Create `aop_forecast` table

### Phase 2 — Code Changes
- [ ] Create `utils/computeAOP.js`
- [ ] Update `buildPrompt()` with compressed format
- [ ] Add `computeMonthlyForecast()` to `computeAnalytics()`
- [ ] Add `computeConfidenceSignals()` to `computeAnalytics()`
- [ ] Reduce `max_tokens` from 16000 to 4000

### Phase 3 — AOP Route
- [ ] Create `routes/aop.js`
- [ ] Add store master upload endpoint
- [ ] Add zone/state rollup API

### Phase 4 — UI
- [ ] Tab 3: AOP Planning (store × month grid)
- [ ] Zone rollup view
- [ ] State comparison view

---

## 9. SUMMARY TABLE

| What | Who Does It | Tokens Saved | Reason |
|---|---|---|---|
| Monthly forecast numbers | Your code | ~150/customer | Pure math |
| Annual target | Your code | ~50/customer | Simple formula |
| Festival day counts | Your code (DB query) | ~80/customer | Date math |
| Store maturity | Your code | ~40/customer | log formula |
| Confidence signals | Your code | ~60/customer | Statistical formula |
| **TOTAL saved** | | **~380/customer** | ~70% reduction |
| Confidence level | Claude | — | Judgment on multiple signals |
| Key insights | Claude | — | Business language |
| Risk factors | Claude | — | Domain reasoning |
| Executive summary | Claude | — | Narrative writing |

---

*Document created: October 2026*
*Project: Sales Upload API — AOP Extension*
