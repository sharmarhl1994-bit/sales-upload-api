-- ============================================================
-- Run this in pgAdmin → salesdb → Query Tool → F5
-- ============================================================

CREATE TABLE IF NOT EXISTS forecasts (
    id              SERIAL PRIMARY KEY,
    cust_old        VARCHAR(50)     NOT NULL,
    fiscvarnt       VARCHAR(10)     NOT NULL,
    forecast_year   INTEGER         NOT NULL,

    -- Monthly forecasted turnover (INR)
    jan             NUMERIC(18, 2)  DEFAULT 0,
    feb             NUMERIC(18, 2)  DEFAULT 0,
    mar             NUMERIC(18, 2)  DEFAULT 0,
    apr             NUMERIC(18, 2)  DEFAULT 0,
    may             NUMERIC(18, 2)  DEFAULT 0,
    jun             NUMERIC(18, 2)  DEFAULT 0,
    jul             NUMERIC(18, 2)  DEFAULT 0,
    aug             NUMERIC(18, 2)  DEFAULT 0,
    sep             NUMERIC(18, 2)  DEFAULT 0,
    oct             NUMERIC(18, 2)  DEFAULT 0,
    nov             NUMERIC(18, 2)  DEFAULT 0,
    dec             NUMERIC(18, 2)  DEFAULT 0,

    -- Forecast metadata
    total_forecast  NUMERIC(18, 2)  DEFAULT 0,
    yoy_growth_pct  NUMERIC(8, 4),
    confidence      VARCHAR(10),

    -- AI-generated insights (stored as JSON arrays)
    key_insights    JSONB,
    risk_factors    JSONB,
    seasonal_pattern    TEXT,
    executive_summary   TEXT,
    methodology         TEXT,

    generated_at    TIMESTAMP       DEFAULT NOW(),

    CONSTRAINT uq_forecast_key UNIQUE (cust_old, fiscvarnt, forecast_year)
);

CREATE INDEX IF NOT EXISTS idx_forecasts_cust  ON forecasts (cust_old);
CREATE INDEX IF NOT EXISTS idx_forecasts_year  ON forecasts (forecast_year);
