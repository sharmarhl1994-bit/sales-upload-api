require('dotenv').config();
const express = require('express');
const cors    = require('cors');

const uploadRouter = require('./routes/upload');

const app  = express();
const PORT = process.env.PORT || 4000;

app.use(cors());                          // allow React dev server (localhost:3000)
app.use(express.json());

// Routes
app.use('/api/upload', uploadRouter);

// Health check
app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`Sales Upload API running on http://localhost:${PORT}`);
});
