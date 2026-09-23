const express = require('express');
const db = require('./db');

// Only these history ranges are accepted — never pass the client's raw
// input straight into a database query string.
const ALLOWED_RANGES = ['-15m', '-1h', '-6h', '-24h', '-7d'];

function createRouter(io) {
  const router = express.Router();

  // ---- Used by the PMU devices ----
  // POST /api/pmu-data
  // Body: the full nested PMU frame, PLUS a top-level "api_key" field:
  // { "api_key": "...", "pmu_id": "PMU_A", "station": "SUBSTATION_1", ... }
  router.post('/pmu-data', async (req, res) => {
    try {
      if (req.body.api_key !== process.env.DEVICE_API_KEY) {
        return res.status(401).json({ error: 'Invalid api_key' });
      }

      const result = db.validateAndFlatten(req.body);
      if (!result.valid) {
        return res.status(400).json({ error: result.error });
      }

      await db.writeReading(result.flat);

      // Push it straight to any connected dashboard browsers, live.
      io.emit('new-reading', result.flat);

      res.status(200).json({ status: 'ok' });
    } catch (err) {
      console.error('Error writing reading:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ---- Used by the dashboard website ----

  // GET /api/latest -> most recent frame from each PMU
  router.get('/latest', async (req, res) => {
    try {
      const data = await db.getLatestReadings();
      res.json(data);
    } catch (err) {
      console.error('Error fetching latest:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // GET /api/history?pmu_id=PMU_A&range=-1h -> time series for one PMU
  router.get('/history', async (req, res) => {
    try {
      const { pmu_id, range } = req.query;
      if (!pmu_id) return res.status(400).json({ error: 'pmu_id is required' });

      const chosenRange = range || '-1h';
      if (!ALLOWED_RANGES.includes(chosenRange)) {
        return res.status(400).json({ error: `range must be one of: ${ALLOWED_RANGES.join(', ')}` });
      }

      const data = await db.getHistory(pmu_id, chosenRange);
      res.json(data);
    } catch (err) {
      console.error('Error fetching history:', err.message);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = createRouter;
