require('dotenv').config();
const express = require('express');
const cors    = require('cors');

const uploadRouter   = require('./routes/upload');
const forecastRouter = require('./routes/forecast');

const app  = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

// Routes
app.use('/api/upload',   uploadRouter);
app.use('/api/forecast', forecastRouter);

// Health check
app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`Sales Upload API running on http://localhost:${PORT}`);
});
