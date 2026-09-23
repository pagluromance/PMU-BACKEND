// This file is the ONLY place that talks to InfluxDB directly.
// Everything else calls these functions instead of touching InfluxDB itself.

const { InfluxDB, Point } = require('@influxdata/influxdb-client');

const url = process.env.INFLUX_URL;
const token = process.env.INFLUX_TOKEN;
const org = process.env.INFLUX_ORG;
const bucket = process.env.INFLUX_BUCKET;

const client = new InfluxDB({ url, token });
const writeApi = client.getWriteApi(org, bucket, 'ms'); // point timestamps given in milliseconds
const queryApi = client.getQueryApi(org);

// ---------------------------------------------------------------------
// Field spec: describes every value we expect in a PMU frame.
// path   = where to find it in the incoming JSON (dot notation for nested objects)
// type   = 'string' | 'int' | 'float' | 'bool'
// tag    = true for values InfluxDB should index for fast filtering
//          (pmu_id, station) — keep this list short, tags are for identity,
//          not measurements.
// ---------------------------------------------------------------------
const FIELD_SPEC = [
  { path: 'pmu_id', type: 'string', tag: true },
  { path: 'station', type: 'string', tag: true },

  { path: 'sequence', type: 'int' },
  { path: 'rate_hz', type: 'int' },

  { path: 'timestamp.soc', type: 'int' },
  { path: 'timestamp.frac_sec_us', type: 'int' },

  { path: 'sync.source', type: 'string' },
  { path: 'sync.locked', type: 'bool' },
  { path: 'sync.pps_count', type: 'int' },
  { path: 'sync.time_quality', type: 'int' },

  { path: 'voltage.magnitude_v', type: 'float' },
  { path: 'voltage.angle_deg', type: 'float' },

  { path: 'current.magnitude_a', type: 'float' },
  { path: 'current.angle_deg', type: 'float' },

  { path: 'frequency_hz', type: 'float' },
  { path: 'rocof_hz_per_s', type: 'float' },

  { path: 'power.p_kw', type: 'float' },
  { path: 'power.q_kvar', type: 'float' },
  { path: 'power.s_kva', type: 'float' },
  { path: 'power.power_factor', type: 'float' },

  { path: 'status.data_valid', type: 'bool' },
  { path: 'status.pmu_ok', type: 'bool' },
  { path: 'status.test_mode', type: 'bool' },
  { path: 'status.gps_locked', type: 'bool' },
  { path: 'status.measurement_valid', type: 'bool' },
];

// Reads a dot-path like "voltage.magnitude_v" out of a nested object.
function getByPath(obj, path) {
  return path.split('.').reduce((o, key) => (o == null ? undefined : o[key]), obj);
}

// Turns "voltage.magnitude_v" into "voltage_magnitude_v" — InfluxDB field
// names can't have dots, and flat names are easier to query.
function flatKey(path) {
  return path.replace(/\./g, '_');
}

/**
 * Validates an incoming PMU frame against FIELD_SPEC.
 * Returns { valid: true, flat: {...} } or { valid: false, error: "..." }.
 * `flat` has every value pulled out and flattened, ready to write.
 */
function validateAndFlatten(body) {
  const flat = {};

  for (const field of FIELD_SPEC) {
    const value = getByPath(body, field.path);

    if (value === undefined || value === null) {
      return { valid: false, error: `Missing field: ${field.path}` };
    }

    switch (field.type) {
      case 'string':
        if (typeof value !== 'string') {
          return { valid: false, error: `${field.path} must be a string` };
        }
        break;
      case 'bool':
        if (typeof value !== 'boolean') {
          return { valid: false, error: `${field.path} must be true/false` };
        }
        break;
      case 'int':
      case 'float':
        if (typeof value !== 'number' || Number.isNaN(value)) {
          return { valid: false, error: `${field.path} must be a number` };
        }
        if (field.type === 'int' && !Number.isInteger(value)) {
          return { valid: false, error: `${field.path} must be an integer` };
        }
        break;
    }

    flat[flatKey(field.path)] = value;
  }

  return { valid: true, flat };
}

/**
 * Write one validated, flattened PMU frame to InfluxDB.
 * Uses the PMU's OWN timestamp (soc + frac_sec_us) rather than the
 * server's receive time — that's the whole point of a synchrophasor:
 * the timestamp has to reflect when the measurement was taken, not
 * when it happened to arrive over the network.
 */
function writeReading(flat) {
  const point = new Point('pmu_frame')
    .tag('pmu_id', flat.pmu_id)
    .tag('station', flat.station);

  for (const field of FIELD_SPEC) {
    if (field.tag) continue; // tags already set above
    const key = flatKey(field.path);
    const value = flat[key];

    if (field.type === 'string') point.stringField(key, value);
    else if (field.type === 'bool') point.booleanField(key, value);
    else if (field.type === 'int') point.intField(key, value);
    else point.floatField(key, value);
  }

  // Device timestamp: SOC is whole seconds (Unix epoch convention),
  // frac_sec_us is the fractional part of that second, in microseconds.
  const ms = flat.timestamp_soc * 1000 + Math.round(flat.timestamp_frac_sec_us / 1000);
  point.timestamp(new Date(ms));

  writeApi.writePoint(point);
  return writeApi.flush();
}

/**
 * Get the single most recent frame for every PMU.
 */
async function getLatestReadings() {
  const fluxQuery = `
    from(bucket: "${bucket}")
      |> range(start: -30d)
      |> filter(fn: (r) => r._measurement == "pmu_frame")
      |> group(columns: ["pmu_id", "_field"])
      |> last()
  `;
  return runQueryAndShape(fluxQuery);
}

/**
 * Get history for one PMU over a time range, e.g. range = "-1h", "-30m", "-24h".
 * Only a small allowed list of ranges is accepted — see routes.js.
 */
async function getHistory(pmuId, range) {
  const fluxQuery = `
    from(bucket: "${bucket}")
      |> range(start: ${range})
      |> filter(fn: (r) => r._measurement == "pmu_frame")
      |> filter(fn: (r) => r.pmu_id == "${pmuId}")
  `;
  return runQueryAndShape(fluxQuery);
}

/**
 * Runs a Flux query and reshapes InfluxDB's row-per-field output into
 * one object per timestamp: { time, pmu_id, station, voltage_magnitude_v, ... }
 */
function runQueryAndShape(fluxQuery) {
  return new Promise((resolve, reject) => {
    const rows = {};
    queryApi.queryRows(fluxQuery, {
      next(row, tableMeta) {
        const o = tableMeta.toObject(row);
        const key = `${o._time}|${o.pmu_id}`;
        if (!rows[key]) {
          rows[key] = { time: o._time, pmu_id: o.pmu_id, station: o.station };
        }
        rows[key][o._field] = o._value;
      },
      error(err) {
        reject(err);
      },
      complete() {
        resolve(Object.values(rows));
      },
    });
  });
}

module.exports = { validateAndFlatten, writeReading, getLatestReadings, getHistory, FIELD_SPEC };
