require('dotenv').config();

const path = require('path');
const express = require('express');
const cors = require('cors');

const uploadRoutes = require('./routes/upload');
const publishRoutes = require('./routes/publish');
const storeRoutes = require('./routes/store');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true }));

app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use('/api/upload', uploadRoutes);
app.use('/api/publish', publishRoutes);
app.use('/api/store', storeRoutes);

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, app: 'WooCommerce Auto Publisher' });
});

app.listen(PORT, () => {
  console.log(`Woo Publisher running at http://localhost:${PORT}`);
});
