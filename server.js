require('dotenv').config();

const express     = require('express');
const cors        = require('cors');
const helmet      = require('helmet');
const rateLimit   = require('express-rate-limit');

const uploadRouter   = require('./routes/upload');
const forecastRouter = require('./routes/forecast');

// ── Validate required env vars before any route is loaded ────
const required = ['DB_PASSWORD', 'ANTHROPIC_API_KEY'];
const missing  = required.filter(k => !process.env[k]);
if (missing.length) {
  console.error(`[startup] Missing env vars: ${missing.join(', ')} — check your .env file`);
  process.exit(1);
}

const app  = express();
const PORT = parseInt(process.env.PORT) || 4000;

// ── Security headers ─────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false,   // disabled so the HTML UI works without a CSP nonce
  crossOriginEmbedderPolicy: false,
}));

// ── CORS — allow same-machine browser requests only ─────────
app.use(cors({
  origin: [
    'http://localhost:3000',   // React dev server
    'http://localhost:4000',   // same-origin HTML file served by this API
    'null',                    // file:// origin (opening HTML directly from disk)
  ],
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Accept'],
}));

// ── Rate limiting ─────────────────────────────────────────────
// General API: 200 req/15 min per IP
app.use('/api/', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests — slow down and try again in 15 minutes.' },
}));

// Forecast generation is expensive — stricter limit
app.use('/api/forecast/generate', rateLimit({
  windowMs: 60 * 60 * 1000,   // 1 hour window
  max: 10,
  message: { error: 'Forecast generation limit reached (10/hour). Try again later.' },
}));

// Recommend (Haiku call) — moderate limit
app.use('/api/forecast/recommend', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { error: 'Recommendation limit reached (30/15 min). Try again later.' },
}));

app.use(express.json({ limit: '1mb' }));

// ── Routes ────────────────────────────────────────────────────
app.use('/api/upload',   uploadRouter);
app.use('/api/forecast', forecastRouter);

// ── Health check ─────────────────────────────────────────────
app.get('/api/health', (_req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

// ── 404 handler ──────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: 'Route not found.' }));

// ── Global error handler — must have 4 params ────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('[unhandled]', err);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error.' });
});

// ── Start ─────────────────────────────────────────────────────
const server = app.listen(PORT, () => {
  console.log(`[server] Sales Upload API → http://localhost:${PORT}`);
});

// ── Graceful shutdown — finish in-flight requests before exit ─
function gracefulShutdown(signal) {
  console.log(`[server] ${signal} received — shutting down gracefully...`);
  server.close(() => {
    console.log('[server] All connections closed. Goodbye.');
    process.exit(0);
  });
  // Force exit if connections don't close in 10 s
  setTimeout(() => { console.error('[server] Force exit.'); process.exit(1); }, 10_000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
process.on('uncaughtException',  err => { console.error('[uncaughtException]',  err); gracefulShutdown('uncaughtException'); });
process.on('unhandledRejection', err => { console.error('[unhandledRejection]', err); });
