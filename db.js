require('dotenv').config();
const { Pool } = require('pg');

const isProduction = process.env.NODE_ENV === 'production';

const pool = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME     || 'salesdb',
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD || '',

  // Pool sizing: enough for concurrent uploads + forecast + recommend
  max:                 10,
  min:                 2,
  idleTimeoutMillis:   30_000,
  connectionTimeoutMillis: 5_000,

  // Enable SSL in production; disable locally
  ssl: isProduction ? { rejectUnauthorized: true } : false,
});

pool.on('error', (err) => {
  console.error('[pg] Unexpected pool error:', err.message);
});

// Verify connectivity at startup — fail fast if DB is unreachable
pool.query('SELECT 1').catch(err => {
  console.error('[pg] Cannot connect to PostgreSQL:', err.message);
  process.exit(1);
});

module.exports = pool;
