-- ============================================================
-- PostgreSQL: Create past_sales table (EBO format)
-- Run this in pgAdmin → salesdb → Query Tool → F5
-- WARNING: Drops and recreates the table. Backup data first.
-- ============================================================

DROP TABLE IF EXISTS past_sales;

CREATE TABLE IF NOT EXISTS past_sales (
    id          SERIAL          PRIMARY KEY,
    code        VARCHAR(50)     NOT NULL,
    name        VARCHAR(200),
    zone        VARCHAR(50),
    region      VARCHAR(50),
    grade       VARCHAR(20),
    store_type  VARCHAR(30),
    channel     VARCHAR(30),
    status      VARCHAR(50),
    fy_year     INTEGER         NOT NULL,

    -- Monthly sales in Indian fiscal year order (Apr = FY start)
    apr  NUMERIC(18,2) DEFAULT 0,
    may  NUMERIC(18,2) DEFAULT 0,
    jun  NUMERIC(18,2) DEFAULT 0,
    jul  NUMERIC(18,2) DEFAULT 0,
    aug  NUMERIC(18,2) DEFAULT 0,
    sep  NUMERIC(18,2) DEFAULT 0,
    oct  NUMERIC(18,2) DEFAULT 0,
    nov  NUMERIC(18,2) DEFAULT 0,
    dec  NUMERIC(18,2) DEFAULT 0,
    jan  NUMERIC(18,2) DEFAULT 0,
    feb  NUMERIC(18,2) DEFAULT 0,
    mar  NUMERIC(18,2) DEFAULT 0,

    fy_total    NUMERIC(18,2)   DEFAULT 0,
    updated_at  TIMESTAMP       DEFAULT NOW(),

    CONSTRAINT uq_code_year UNIQUE (code, fy_year)
);

CREATE INDEX IF NOT EXISTS idx_past_sales_code ON past_sales (code);
CREATE INDEX IF NOT EXISTS idx_past_sales_zone ON past_sales (zone);
CREATE INDEX IF NOT EXISTS idx_past_sales_year ON past_sales (fy_year);
