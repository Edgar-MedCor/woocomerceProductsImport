const express = require('express');
const { createWooClient } = require('../services/wooClient');
const { analyzeAgainstStore } = require('../services/storeAnalyzer');
const { prepareStore } = require('../services/storePreparer');

const router = express.Router();

router.get('/connection', async (_req, res) => {
  try {
    const api = createWooClient();
    const result = await api.get('system_status');
    res.json({
      ok: true,
      storeUrl: process.env.WOO_URL,
      environment: result.data?.environment || {},
    });
  } catch (error) {
    res.status(500).json({ ok: false, message: error.message, details: error?.response?.data });
  }
});

router.post('/check', async (req, res) => {
  try {
    const { products = [], mode = 'auto' } = req.body;
    const api = createWooClient();
    const analysis = await analyzeAgainstStore(api, products, { mode });
    res.json({ ok: true, analysis });
  } catch (error) {
    console.error(error?.response?.data || error);
    res.status(500).json({ ok: false, message: error.message, details: error?.response?.data });
  }
});

router.post('/prepare', async (req, res) => {
  try {
    const { products = [], createMissing = true } = req.body;
    const api = createWooClient();
    const result = await prepareStore(api, products, { createMissing });
    res.json({ ok: true, createMissing, result });
  } catch (error) {
    console.error(error?.response?.data || error);
    res.status(500).json({ ok: false, message: error.message, details: error?.response?.data });
  }
});

module.exports = router;
