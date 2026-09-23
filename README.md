# Phasor Measurement Unit (PMU) Backend

[![Node.js](https://img.shields.io/badge/Node.js-18.x%20%7C%2020.x-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Python](https://img.shields.io/badge/Python-3.10%20%7C%203.11-3776AB?logo=python&logoColor=white)](https://www.python.org/)
[![FastAPI](https://img.shields.io/badge/FastAPI-0.100+-009688?logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com/)
[![InfluxDB](https://img.shields.io/badge/InfluxDB-Time--Series-22ADF6?logo=influxdb&logoColor=white)](https://www.influxdata.com/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Backend service for the **MicroSmartGrid Synchrophasor (PMU) Project**. It receives real-time synchrophasor frames from distributed PMU hardware units (via Wi-Fi, Ethernet, or GSM), persists them into time-series or relational storage, and pushes live updates to the monitoring dashboard via WebSockets.

---

## ⚡ Overview & Features

This repository includes two flexible backend implementations tailored for smart grid telemetry:

1. **Node.js + InfluxDB + Socket.IO (`server.js`)**:
   - Built for high-frequency time-series ingestion using **InfluxDB**.
   - Validates and flattens nested IEEE C37.118-compliant telemetry (voltage, current, angle, frequency, ROCOF, GPS lock, data validity).
   - Real-time updates pushed directly to dashboards via **Socket.IO**.
2. **Python + FastAPI + SQLAlchemy (`main.py`)**:
   - Zero-dependency local setup using **SQLite** (or easily swapped to PostgreSQL/TimescaleDB).
   - Auto-generated interactive Swagger UI and OpenAPI documentation at `/docs`.
   - Real-time event streaming via native FastAPI **WebSockets** (`/ws/live`).

---

## 📁 Repository Structure

```text
pmu-backend/
├── .github/
│   └── workflows/
│       └── ci.yml             # GitHub Actions CI workflow (syntax & lint checks)
├── src/
│   ├── db.js                  # InfluxDB client, field spec, validation, queries
│   └── routes.js              # Express REST routes & Socket.IO publisher
├── .env.example               # Sanitized environment configuration template
├── .gitattributes             # Git LF line-ending normalization
├── .gitignore                 # Rules to prevent committing secrets, caches & dependencies
├── database.py                # SQLAlchemy engine and session dependency (FastAPI)
├── LICENSE                    # MIT License
├── main.py                    # FastAPI server entry point, routes & WebSocket manager
├── models.py                  # SQLAlchemy ORM model for readings table
├── package.json               # Node.js dependencies and scripts
├── package-lock.json          # Node.js exact dependency lockfile
├── README.md                  # Project documentation
├── requirements.txt           # Python dependencies (FastAPI, uvicorn, SQLAlchemy)
├── schemas.py                 # Pydantic schemas for data validation & API docs
└── server.js                  # Node.js Express & Socket.IO server entry point
```

---

## 🚀 Quickstart Guide

### 1. Clone & Configure Environment

Clone the repository and create your local `.env` configuration file:

```bash
# Clone the repository (replace with your repo URL)
git clone https://github.com/your-username/pmu-backend.git
cd pmu-backend

# Copy the example environment template
cp .env.example .env
```

Open `.env` and fill in your keys (e.g., InfluxDB credentials, device API key).

---

### Option A: Running the Node.js Server (InfluxDB + Socket.IO)

#### Prerequisites
- **Node.js**: v18.0.0 or higher
- **InfluxDB**: Free InfluxDB Cloud 2.x account or local InfluxDB instance

#### Installation & Run
```bash
# Install dependencies
npm install

# Verify syntax
npm test

# Start the server (runs on port 3000 by default)
npm start
```

The server will start listening at `http://localhost:3000`.

---

### Option B: Running the Python FastAPI Server (SQLite/PostgreSQL)

#### Prerequisites
- **Python**: 3.9 or higher

#### Installation & Run
```bash
# Create and activate a virtual environment
# Windows:
python -m venv venv
.\venv\Scripts\activate

# Linux / macOS:
python3 -m venv venv
source venv/bin/activate

# Install Python dependencies
pip install -r requirements.txt

# Start the FastAPI server with auto-reload
uvicorn main:app --reload --port 8000
```

- **API Documentation**: Open `http://127.0.0.1:8000/docs` in your browser to interact with the auto-generated Swagger UI.
- **WebSocket Endpoint**: `ws://127.0.0.1:8000/ws/live`

---

## ⚙️ Environment Variables

| Variable | Description | Default / Example | Used By |
| :--- | :--- | :--- | :--- |
| `PORT` | HTTP server port | `3000` | Node.js |
| `DEVICE_API_KEY` | Shared secret key required for PMUs to push data | `your_secret_device_api_key` | Both |
| `INFLUX_URL` | URL of the InfluxDB instance | `https://us-east-1-1.aws.cloud2.influxdata.com` | Node.js |
| `INFLUX_TOKEN` | InfluxDB API authentication token | *(Keep secret!)* | Node.js |
| `INFLUX_ORG` | Organization name in InfluxDB | `DST FIST MicroSmartGrid \| PMU` | Node.js |
| `INFLUX_BUCKET` | InfluxDB bucket name | `pmu_data` | Node.js |
| `DATABASE_URL` | Relational database connection string | `sqlite:///./pmu_data.db` | FastAPI |

> [!CAUTION]
> **Never commit your `.env` file to Git.** The `.gitignore` file is configured to exclude `.env` to prevent accidental credential leakage.

---

## 📡 API Reference

### 1. Node.js Endpoints (`http://localhost:3000`)

#### `POST /api/pmu-data`
Ingests a full synchrophasor data frame from a PMU.

- **Request Body (JSON)**:
```json
{
  "api_key": "your_device_key",
  "pmu_id": "PMU_01",
  "station": "SUBSTATION_ALPHA",
  "sequence": 1042,
  "rate_hz": 50,
  "timestamp": {
    "soc": 1727092800,
    "frac_sec_us": 125000
  },
  "sync": {
    "source": "GPS",
    "locked": true,
    "pps_count": 50,
    "time_quality": 0
  },
  "voltage": {
    "magnitude_v": 230.12,
    "angle_deg": 0.0
  },
  "current": {
    "magnitude_a": 12.45,
    "angle_deg": -15.3
  },
  "frequency_hz": 50.02,
  "rocof_hz_per_s": 0.001,
  "power": {
    "p_kw": 2.76,
    "q_kvar": 0.75,
    "s_kva": 2.86,
    "power_factor": 0.965
  },
  "status": {
    "data_valid": true,
    "pmu_ok": true,
    "test_mode": false,
    "gps_locked": true,
    "measurement_valid": true
  }
}
```
- **Responses**:
  - `200 OK`: `{"status": "ok"}`
  - `401 Unauthorized`: `{"error": "Invalid api_key"}`
  - `400 Bad Request`: `{"error": "Missing required field: ..."}`

#### `GET /api/latest`
Returns the most recent reading from each active PMU.

#### `GET /api/history?pmu_id=PMU_01&range=-1h`
Returns historical measurements for a given PMU.
- Allowed `range` parameters: `-15m`, `-1h`, `-6h`, `-24h`, `-7d`.

#### Real-time Events (Socket.IO)
- Connect to `http://localhost:3000`
- Listen on event: `new-reading`

---

### 2. FastAPI Endpoints (`http://localhost:8000`)

| Method | Path | Description |
| :--- | :--- | :--- |
| `POST` | `/api/ingest` | Ingests phasor reading (Header `X-API-Key` required) |
| `GET` | `/api/readings/latest` | Most recent reading for each PMU ID |
| `GET` | `/api/readings/history` | Historical trend data (`pmu_id`, `minutes`, `limit`) |
| `GET` | `/api/health` | Healthcheck verification endpoint |
| `WS` | `/ws/live` | WebSocket connection for real-time broadcast |

---

## 🛠️ Pushing to GitHub for the First Time

If you haven't published this project to GitHub yet, follow these steps:

1. **Make sure Git is installed** on your machine:
   - On Windows: Run `winget install --id Git.Git -e --source winget` or download from [git-scm.com](https://git-scm.com/).
2. **Initialize Git and commit**:
   ```bash
   git init
   git add .
   git commit -m "feat: initial commit with PMU backend, CI workflow, and documentation"
   ```
3. **Link to your GitHub repository**:
   ```bash
   git branch -M main
   git remote add origin https://github.com/<your-username>/<your-repo-name>.git
   git push -u origin main
   ```

---

## 🔒 Security & Best Practices

- **Token Safety**: Rotate your InfluxDB token immediately if it has ever been shared in public chat or unencrypted files.
- **CORS Protection**: The development CORS policy is set to allow `*`. Update `cors: { origin: 'https://your-dashboard-domain.com' }` in `server.js` and `allow_origins` in `main.py` before deploying to production.
- **Environment Management**: Keep `.env` out of version control at all times.

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).
