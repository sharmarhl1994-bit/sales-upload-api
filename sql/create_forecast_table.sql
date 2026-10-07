-- ============================================================
-- Run this in pgAdmin → salesdb → Query Tool → F5
-- For a FRESH setup: run the full CREATE TABLE block.
-- For an EXISTING table: run the ALTER TABLE block at the bottom.
-- ============================================================

CREATE TABLE IF NOT EXISTS forecasts (
    id              SERIAL PRIMARY KEY,
    cust_old        VARCHAR(50)     NOT NULL,
    fiscvarnt       VARCHAR(10)     NOT NULL,
    forecast_year   INTEGER         NOT NULL,

    -- Store metadata (copied from past_sales at generation time)
    name            VARCHAR(200),
    zone            VARCHAR(50),
    region          VARCHAR(50),
    grade           VARCHAR(20),
    store_type      VARCHAR(30),
    channel         VARCHAR(30),
    status          VARCHAR(50),

    -- Monthly forecasted turnover (INR) — fiscal year order
    apr             NUMERIC(18, 2)  DEFAULT 0,
    may             NUMERIC(18, 2)  DEFAULT 0,
    jun             NUMERIC(18, 2)  DEFAULT 0,
    jul             NUMERIC(18, 2)  DEFAULT 0,
    aug             NUMERIC(18, 2)  DEFAULT 0,
    sep             NUMERIC(18, 2)  DEFAULT 0,
    oct             NUMERIC(18, 2)  DEFAULT 0,
    nov             NUMERIC(18, 2)  DEFAULT 0,
    dec             NUMERIC(18, 2)  DEFAULT 0,
    jan             NUMERIC(18, 2)  DEFAULT 0,
    feb             NUMERIC(18, 2)  DEFAULT 0,
    mar             NUMERIC(18, 2)  DEFAULT 0,

    -- Forecast metadata
    total_forecast  NUMERIC(18, 2)  DEFAULT 0,
    yoy_growth_pct  NUMERIC(8, 4),
    confidence      VARCHAR(10),

    -- AI-generated insights (stored as JSON arrays)
    key_insights        JSONB,
    risk_factors        JSONB,
    seasonal_pattern    TEXT,
    executive_summary   TEXT,
    methodology         TEXT,

    generated_at    TIMESTAMP       DEFAULT NOW(),

    CONSTRAINT uq_forecast_key UNIQUE (cust_old, fiscvarnt, forecast_year)
);

CREATE INDEX IF NOT EXISTS idx_forecasts_cust  ON forecasts (cust_old);
CREATE INDEX IF NOT EXISTS idx_forecasts_year  ON forecasts (forecast_year);
CREATE INDEX IF NOT EXISTS idx_forecasts_zone  ON forecasts (zone);

-- ============================================================
-- EXISTING TABLE? Run only this block to add the new columns:
-- ============================================================
/*
ALTER TABLE forecasts
    ADD COLUMN IF NOT EXISTS name       VARCHAR(200),
    ADD COLUMN IF NOT EXISTS zone       VARCHAR(50),
    ADD COLUMN IF NOT EXISTS region     VARCHAR(50),
    ADD COLUMN IF NOT EXISTS grade      VARCHAR(20),
    ADD COLUMN IF NOT EXISTS store_type VARCHAR(30),
    ADD COLUMN IF NOT EXISTS channel    VARCHAR(30),
    ADD COLUMN IF NOT EXISTS status     VARCHAR(50);

-- Also reorder monthly columns to fiscal year order (Apr first):
-- (PostgreSQL doesn't support reordering, but the app reads by column name so order doesn't matter)
ALTER TABLE forecasts
    ADD COLUMN IF NOT EXISTS apr NUMERIC(18,2) DEFAULT 0,
    ADD COLUMN IF NOT EXISTS may NUMERIC(18,2) DEFAULT 0,
    ADD COLUMN IF NOT EXISTS jun NUMERIC(18,2) DEFAULT 0,
    ADD COLUMN IF NOT EXISTS jul NUMERIC(18,2) DEFAULT 0,
    ADD COLUMN IF NOT EXISTS aug NUMERIC(18,2) DEFAULT 0,
    ADD COLUMN IF NOT EXISTS sep NUMERIC(18,2) DEFAULT 0,
    ADD COLUMN IF NOT EXISTS oct NUMERIC(18,2) DEFAULT 0,
    ADD COLUMN IF NOT EXISTS nov NUMERIC(18,2) DEFAULT 0;
*/
