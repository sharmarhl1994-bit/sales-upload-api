-- ============================================================
-- PostgreSQL: Create past_sales table
-- Run this once to set up the database.
-- ============================================================

-- 1. Create database (run as superuser / postgres user):
--    CREATE DATABASE salesdb;
--    \c salesdb

-- 2. Create table
CREATE TABLE IF NOT EXISTS past_sales (
    id          SERIAL PRIMARY KEY,
    cust_old    VARCHAR(50)     NOT NULL,
    fiscvarnt   VARCHAR(10)     NOT NULL,
    year        INTEGER         NOT NULL,
    jan         NUMERIC(18, 2)  DEFAULT 0,
    feb         NUMERIC(18, 2)  DEFAULT 0,
    mar         NUMERIC(18, 2)  DEFAULT 0,
    apr         NUMERIC(18, 2)  DEFAULT 0,
    may         NUMERIC(18, 2)  DEFAULT 0,
    jun         NUMERIC(18, 2)  DEFAULT 0,
    jul         NUMERIC(18, 2)  DEFAULT 0,
    aug         NUMERIC(18, 2)  DEFAULT 0,
    sep         NUMERIC(18, 2)  DEFAULT 0,
    oct         NUMERIC(18, 2)  DEFAULT 0,
    nov         NUMERIC(18, 2)  DEFAULT 0,
    dec         NUMERIC(18, 2)  DEFAULT 0,
    updated_at  TIMESTAMP       DEFAULT NOW(),
    CONSTRAINT uq_cust_fiscvar_year UNIQUE (cust_old, fiscvarnt, year)
);

-- Index for fast lookups by customer
CREATE INDEX IF NOT EXISTS idx_past_sales_cust ON past_sales (cust_old);
CREATE INDEX IF NOT EXISTS idx_past_sales_year ON past_sales (year);
