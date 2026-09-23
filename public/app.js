/**
 * Synchrophasor PMU SCADA Web Dashboard Application
 * Handles cold-start resilience, real-time Socket.IO streaming,
 * staleness tracking, history charts, and modal telemetry inspection.
 */

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Configuration & Constants
  // ---------------------------------------------------------------------------
  const DEFAULT_RENDER_URL = 'https://pmu-backend-ury8.onrender.com';
  
  // 4 Standard PMU Units Monitored
  const PMU_CONFIG = [
    { id: 'PMU_A', defaultStation: 'SUBSTATION_1 (Primary Grid Tie)' },
    { id: 'PMU_B', defaultStation: 'SUBSTATION_2 (Solar Inverter / DG)' },
    { id: 'PMU_C', defaultStation: 'SUBSTATION_3 (Industrial Feeder)' },
    { id: 'PMU_D', defaultStation: 'SUBSTATION_4 (Microgrid Bus)' },
  ];

  const ALLOWED_RANGES = ['-15m', '-1h', '-6h', '-24h', '-7d'];

  // Application State
  const state = {
    serverUrl: DEFAULT_RENDER_URL,
    staleThresholdSec: 30,
    socket: null,
    isConnected: false,
    selectedPmuId: null,
    isModalOpen: false,
    modalRange: '-15m',
    isSimulating: false,
    simTimer: null,
    
    // Per-PMU state: { latestFrame: {...}, history: { '-15m': [...], ... }, activeRange: '-15m', chartPoints: [...] }
    pmus: {}
  };

  // Initialize PMU tracking dictionary
  PMU_CONFIG.forEach(cfg => {
    state.pmus[cfg.id] = {
      id: cfg.id,
      station: cfg.defaultStation,
      latestFrame: null,
      frameTimeMs: 0,
      activeRange: '-15m',
      historyCache: {},
      chartPoints: []
    };
  });

  // DOM Elements
  const elements = {
    grid: document.getElementById('pmu-grid'),
    statusDot: document.getElementById('status-dot'),
    statusText: document.getElementById('status-text'),
    connectionBadge: document.getElementById('connection-badge'),
    staleSelect: document.getElementById('stale-threshold-select'),
    backendSelect: document.getElementById('backend-target-select'),
    btnToggleSim: document.getElementById('btn-toggle-sim'),
    coldStartBanner: document.getElementById('cold-start-banner'),
    coldStartMsg: document.getElementById('cold-start-msg'),
    retryCounter: document.getElementById('retry-counter'),
    summaryOnline: document.getElementById('summary-online-count'),
    summaryLastTime: document.getElementById('summary-last-time'),
    
    // Modal
    modal: document.getElementById('scada-modal'),
    modalTitle: document.getElementById('modal-title'),
    modalStation: document.getElementById('modal-station'),
    modalCloseBtn: document.getElementById('modal-close-btn'),
    modalTimestamp: document.getElementById('modal-timestamp-label'),
    modalRangePills: document.getElementById('modal-range-pills'),
    modalChartVI: document.getElementById('modal-chart-vi'),
    modalChartAngle: document.getElementById('modal-chart-angle'),
    modalChartRocof: document.getElementById('modal-chart-rocof'),
    modalAngleVal: document.getElementById('modal-angle-delta-val'),
    modalRocofVal: document.getElementById('modal-rocof-val'),
    modalRawJson: document.getElementById('modal-raw-json'),
  };

  // ---------------------------------------------------------------------------
  // URL Determination
  // ---------------------------------------------------------------------------
  function resolveServerUrl(choice) {
    if (choice === 'auto') {
      const origin = window.location.origin;
      if (origin && origin.startsWith('http') && !origin.includes('file://')) {
        return origin;
      }
      return DEFAULT_RENDER_URL;
    }
    return choice;
  }

  // ---------------------------------------------------------------------------
  // Timestamp Calculation (Per IEEE spec and backend formula)
  // ---------------------------------------------------------------------------
  function computeFrameTimestamp(frame) {
    if (frame.time) {
      return new Date(frame.time).getTime();
    }
    if (frame.timestamp_soc != null) {
      const frac = frame.timestamp_frac_sec_us || 0;
      return frame.timestamp_soc * 1000 + Math.round(frac / 1000);
    }
    return Date.now();
  }

  function formatTimeIso(ms) {
    return new Date(ms).toISOString();
  }

  function getFrameAgeSeconds(frameTimeMs) {
    if (!frameTimeMs) return Infinity;
    return Math.max(0, Math.floor((Date.now() - frameTimeMs) / 1000));
  }

  // ---------------------------------------------------------------------------
  // Skeletons & Initial Rendering
  // ---------------------------------------------------------------------------
  function renderSkeletons() {
    elements.grid.innerHTML = PMU_CONFIG.map(cfg => `
      <div class="pmu-card skeleton" id="card-${cfg.id}">
        <div class="card-header">
          <div class="card-title-group">
            <span class="pmu-id">${cfg.id}</span>
            <span class="station-name">${cfg.defaultStation}</span>
          </div>
          <span class="last-updated">Connecting...</span>
        </div>
        <div style="height: 60px;"></div>
        <div style="height: 100px;"></div>
      </div>
    `).join('');
  }

  function renderCard(pmuId) {
    const pmu = state.pmus[pmuId];
    const frame = pmu.latestFrame;
    const ageSec = getFrameAgeSeconds(pmu.frameTimeMs);
    const isStale = ageSec > state.staleThresholdSec;
    const hasData = frame !== null;

    let card = document.getElementById(`card-${pmuId}`);
    if (!card || card.classList.contains('skeleton')) {
      // Create fresh card element
      const div = document.createElement('div');
      div.className = 'pmu-card';
      div.id = `card-${pmuId}`;
      div.innerHTML = buildCardHtml(pmu, frame, ageSec, isStale, hasData);
      if (card) {
        elements.grid.replaceChild(div, card);
      } else {
        elements.grid.appendChild(div);
      }
      card = div;
      bindCardEvents(card, pmuId);
    } else {
      // Update existing card DOM cleanly
      updateCardDom(card, pmu, frame, ageSec, isStale, hasData);
    }

    // Render Mini Frequency Chart on canvas
    const canvas = card.querySelector('.canvas-freq');
    if (canvas) {
      SynchroChart.drawFrequency(canvas, pmu.chartPoints, {
        emptyText: hasData ? 'Populating history...' : 'Standby: Awaiting PMU frames'
      });
    }
  }

  function buildCardHtml(pmu, frame, ageSec, isStale, hasData) {
    const f = frame || {};
    const freq = f.frequency_hz != null ? f.frequency_hz.toFixed(3) : '--.---';
    const deltaF = f.frequency_hz != null ? (f.frequency_hz - 50.0).toFixed(3) : '+0.000';
    const deltaSign = Number(deltaF) >= 0 ? `+${deltaF}` : deltaF;

    let deltaClass = 'freq-delta';
    if (f.frequency_hz != null) {
      const dev = Math.abs(f.frequency_hz - 50.0);
      if (dev > 0.05) deltaClass += ' alarm';
      else if (dev > 0.02) deltaClass += ' warning';
    }

    const vMag = f.voltage_magnitude_v != null ? f.voltage_magnitude_v.toFixed(1) : '---.-';
    const vAngle = f.voltage_angle_deg != null ? f.voltage_angle_deg.toFixed(1) : '-.-';
    const iMag = f.current_magnitude_a != null ? f.current_magnitude_a.toFixed(2) : '--.--';
    const iAngle = f.current_angle_deg != null ? f.current_angle_deg.toFixed(1) : '-.-';

    const pKw = f.power_p_kw != null ? f.power_p_kw.toFixed(2) : '-.--';
    const qKvar = f.power_q_kvar != null ? f.power_q_kvar.toFixed(2) : '-.--';
    const sKva = f.power_s_kva != null ? f.power_s_kva.toFixed(2) : '-.--';
    const pf = f.power_power_factor != null ? f.power_power_factor.toFixed(3) : '-.---';

    const gpsOk = f.status_gps_locked === true;
    const dataOk = f.status_data_valid === true;
    const pmuOk = f.status_pmu_ok === true;
    const syncSource = f.sync_source || 'SIM';
    const syncQuality = f.sync_time_quality != null ? f.sync_time_quality : '-';

    const ageText = hasData ? (ageSec === 0 ? 'Just now' : `${ageSec}s ago`) : 'No frames';
    const seq = f.sequence != null ? `#${f.sequence}` : '#0';
    const rate = f.rate_hz != null ? `${f.rate_hz} Hz` : '-- Hz';

    return `
      <!-- Card Header -->
      <div class="card-header">
        <div class="card-title-group">
          <div class="pmu-id-tag">
            <span class="pmu-id">${pmu.id}</span>
            ${isStale ? '<span class="stale-badge">STALE / OFFLINE</span>' : ''}
          </div>
          <span class="station-name">${pmu.station}</span>
        </div>
        <div class="last-updated ${isStale ? 'stale-text' : ''}">
          <span>DEVICE TIME</span>
          <span class="last-updated-val mono age-val">${ageText}</span>
        </div>
      </div>

      <!-- Frequency Primary Display -->
      <div class="freq-hero">
        <div class="freq-left">
          <span class="freq-label">Frequency (Hz)</span>
          <div class="freq-value-wrap">
            <span class="freq-value mono val-freq">${freq}</span>
            <span class="freq-unit">Hz</span>
          </div>
        </div>
        <div class="${deltaClass} mono val-delta">${deltaSign} Hz</div>
      </div>

      <!-- Electrical Phasors (Voltage & Current) -->
      <div class="metrics-grid">
        <div class="metric-cell">
          <div class="metric-header">
            <span class="metric-label">Voltage (V)</span>
            <span class="metric-angle mono val-vangle">&theta; ${vAngle}&deg;</span>
          </div>
          <div class="metric-val mono"><span class="val-vmag">${vMag}</span> <span class="metric-val-unit">V RMS</span></div>
        </div>
        <div class="metric-cell">
          <div class="metric-header">
            <span class="metric-label">Current (I)</span>
            <span class="metric-angle mono val-iangle">&theta; ${iAngle}&deg;</span>
          </div>
          <div class="metric-val mono"><span class="val-imag">${iMag}</span> <span class="metric-val-unit">A RMS</span></div>
        </div>
      </div>

      <!-- Power Measurements (P, Q, S, PF) -->
      <div class="power-strip">
        <div class="power-item">
          <span class="power-label">P (Active)</span>
          <span class="power-val mono"><span class="val-p">${pKw}</span> kW</span>
        </div>
        <div class="power-item">
          <span class="power-label">Q (Reactive)</span>
          <span class="power-val mono"><span class="val-q">${qKvar}</span> kVAR</span>
        </div>
        <div class="power-item">
          <span class="power-label">S (Apparent)</span>
          <span class="power-val mono"><span class="val-s">${sKva}</span> kVA</span>
        </div>
        <div class="power-item">
          <span class="power-label">PF</span>
          <span class="power-val mono val-pf">${pf}</span>
        </div>
      </div>

      <!-- Status Badges -->
      <div class="status-strip">
        <span class="badge-pill ${gpsOk ? 'ok' : 'warning'} badge-gps">GPS: ${gpsOk ? 'LOCKED' : 'UNLOCKED'}</span>
        <span class="badge-pill ${dataOk ? 'ok' : 'fail'} badge-data">DATA: ${dataOk ? 'VALID' : 'INVALID'}</span>
        <span class="badge-pill ${pmuOk ? 'ok' : 'fail'} badge-pmu">PMU: ${pmuOk ? 'OK' : 'FAULT'}</span>
        <span class="badge-pill badge-sync" title="Sync source & time quality">SYNC: ${syncSource} (Q:${syncQuality})</span>
      </div>

      <!-- Mini Chart -->
      <div class="card-chart-wrap">
        <div class="chart-header">
          <span class="chart-title">Grid Frequency Stability</span>
          <div class="range-pills">
            ${ALLOWED_RANGES.map(r => `
              <button class="range-btn ${pmu.activeRange === r ? 'active' : ''}" data-pmu="${pmu.id}" data-range="${r}">${r.replace('-', '')}</button>
            `).join('')}
          </div>
        </div>
        <div class="canvas-container">
          <canvas class="canvas-freq"></canvas>
        </div>
      </div>

      <!-- Card Footer -->
      <div class="card-footer">
        <span class="mono" style="font-size: 11px;">Seq: <span class="val-seq">${seq}</span> &bull; <span class="val-rate">${rate}</span></span>
        <button class="btn-details" data-pmu="${pmu.id}">
          <span>Inspect Details</span>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"></polyline></svg>
        </button>
      </div>
    `;
  }

  function updateCardDom(card, pmu, frame, ageSec, isStale, hasData) {
    if (isStale) card.classList.add('is-stale');
    else card.classList.remove('is-stale');

    const f = frame || {};
    const ageVal = card.querySelector('.age-val');
    if (ageVal) ageVal.textContent = hasData ? (ageSec === 0 ? 'Just now' : `${ageSec}s ago`) : 'No frames';

    if (!hasData) return;

    // Fast text updates without full innerHTML thrashing
    const valFreq = card.querySelector('.val-freq');
    if (valFreq && f.frequency_hz != null) valFreq.textContent = f.frequency_hz.toFixed(3);

    const valDelta = card.querySelector('.val-delta');
    if (valDelta && f.frequency_hz != null) {
      const dev = f.frequency_hz - 50.0;
      valDelta.textContent = (dev >= 0 ? `+${dev.toFixed(3)}` : dev.toFixed(3)) + ' Hz';
      valDelta.className = 'freq-delta mono val-delta' + (Math.abs(dev) > 0.05 ? ' alarm' : (Math.abs(dev) > 0.02 ? ' warning' : ''));
    }

    const valVmag = card.querySelector('.val-vmag');
    if (valVmag && f.voltage_magnitude_v != null) valVmag.textContent = f.voltage_magnitude_v.toFixed(1);

    const valVangle = card.querySelector('.val-vangle');
    if (valVangle && f.voltage_angle_deg != null) valVangle.innerHTML = `&theta; ${f.voltage_angle_deg.toFixed(1)}&deg;`;

    const valImag = card.querySelector('.val-imag');
    if (valImag && f.current_magnitude_a != null) valImag.textContent = f.current_magnitude_a.toFixed(2);

    const valIangle = card.querySelector('.val-iangle');
    if (valIangle && f.current_angle_deg != null) valIangle.innerHTML = `&theta; ${f.current_angle_deg.toFixed(1)}&deg;`;

    const valP = card.querySelector('.val-p');
    if (valP && f.power_p_kw != null) valP.textContent = f.power_p_kw.toFixed(2);

    const valQ = card.querySelector('.val-q');
    if (valQ && f.power_q_kvar != null) valQ.textContent = f.power_q_kvar.toFixed(2);

    const valS = card.querySelector('.val-s');
    if (valS && f.power_s_kva != null) valS.textContent = f.power_s_kva.toFixed(2);

    const valPf = card.querySelector('.val-pf');
    if (valPf && f.power_power_factor != null) valPf.textContent = f.power_power_factor.toFixed(3);

    const valSeq = card.querySelector('.val-seq');
    if (valSeq && f.sequence != null) valSeq.textContent = `#${f.sequence}`;

    const valRate = card.querySelector('.val-rate');
    if (valRate && f.rate_hz != null) valRate.textContent = `${f.rate_hz} Hz`;

    // Status badges
    const badgeGps = card.querySelector('.badge-gps');
    if (badgeGps) {
      badgeGps.className = `badge-pill ${f.status_gps_locked ? 'ok' : 'warning'} badge-gps`;
      badgeGps.textContent = `GPS: ${f.status_gps_locked ? 'LOCKED' : 'UNLOCKED'}`;
    }

    const badgeData = card.querySelector('.badge-data');
    if (badgeData) {
      badgeData.className = `badge-pill ${f.status_data_valid ? 'ok' : 'fail'} badge-data`;
      badgeData.textContent = `DATA: ${f.status_data_valid ? 'VALID' : 'INVALID'}`;
    }

    const badgePmu = card.querySelector('.badge-pmu');
    if (badgePmu) {
      badgePmu.className = `badge-pill ${f.status_pmu_ok ? 'ok' : 'fail'} badge-pmu`;
      badgePmu.textContent = `PMU: ${f.status_pmu_ok ? 'OK' : 'FAULT'}`;
    }
  }

  function bindCardEvents(card, pmuId) {
    // Details button
    const btnDetails = card.querySelector('.btn-details');
    if (btnDetails) {
      btnDetails.addEventListener('click', () => openModal(pmuId));
    }

    // Range selector buttons
    const rangeBtns = card.querySelectorAll('.range-btn');
    rangeBtns.forEach(btn => {
      btn.addEventListener('click', (e) => {
        const range = e.target.getAttribute('data-range');
        setCardRange(pmuId, range);
      });
    });
  }

  function setCardRange(pmuId, range) {
    const pmu = state.pmus[pmuId];
    if (!pmu) return;
    pmu.activeRange = range;

    const card = document.getElementById(`card-${pmuId}`);
    if (card) {
      card.querySelectorAll('.range-btn').forEach(b => {
        b.classList.toggle('active', b.getAttribute('data-range') === range);
      });
    }

    fetchHistory(pmuId, range);
  }

  // ---------------------------------------------------------------------------
  // Data Ingestion & State Updates
  // ---------------------------------------------------------------------------
  function handleNewReading(frame) {
    if (!frame || !frame.pmu_id) return;

    const pmuId = frame.pmu_id;
    if (!state.pmus[pmuId]) {
      state.pmus[pmuId] = {
        id: pmuId,
        station: frame.station || 'SUBSTATION',
        latestFrame: null,
        frameTimeMs: 0,
        activeRange: '-15m',
        historyCache: {},
        chartPoints: []
      };
    }

    const pmu = state.pmus[pmuId];
    pmu.latestFrame = frame;
    if (frame.station) pmu.station = frame.station;
    pmu.frameTimeMs = computeFrameTimestamp(frame);

    // Append to mini chart live points
    if (frame.frequency_hz != null) {
      pmu.chartPoints.push({
        time: pmu.frameTimeMs,
        value: frame.frequency_hz
      });
      // Cap in-memory live sparkline to last 100 points
      if (pmu.chartPoints.length > 100) pmu.chartPoints.shift();
    }

    // Re-render card
    renderCard(pmuId);
    updateGlobalSummary();

    // If modal is open for this PMU, update modal views
    if (state.isModalOpen && state.selectedPmuId === pmuId) {
      updateModalViews(pmu);
    }
  }

  function updateGlobalSummary() {
    let onlineCount = 0;
    let latestTime = 0;

    Object.values(state.pmus).forEach(pmu => {
      const age = getFrameAgeSeconds(pmu.frameTimeMs);
      if (pmu.latestFrame && age <= state.staleThresholdSec) {
        onlineCount++;
      }
      if (pmu.frameTimeMs > latestTime) {
        latestTime = pmu.frameTimeMs;
      }
    });

    elements.summaryOnline.textContent = `${onlineCount} / 4 Online`;
    elements.summaryOnline.style.color = onlineCount > 0 ? 'var(--color-green)' : 'var(--color-amber)';

    if (latestTime > 0) {
      const d = new Date(latestTime);
      elements.summaryLastTime.textContent = d.toLocaleTimeString() + ' (UTC: ' + d.toISOString().substr(11, 8) + ')';
    } else {
      elements.summaryLastTime.textContent = 'Awaiting telemetry...';
    }
  }

  // ---------------------------------------------------------------------------
  // Backend Fetching & Cold Start Handling
  // ---------------------------------------------------------------------------
  async function fetchWithRetry(url, options = {}, retries = 8, backoffMs = 2000) {
    let attempt = 0;
    while (attempt < retries) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000); // 15s request timeout
        
        const response = await fetch(url, { ...options, signal: controller.signal });
        clearTimeout(timeoutId);

        if (!response.ok) {
          throw new Error(`HTTP ${response.status} ${response.statusText}`);
        }
        return await response.json();
      } catch (err) {
        attempt++;
        console.warn(`Fetch attempt ${attempt} failed for ${url}:`, err.message);

        // Show cold start banner on first retry
        if (attempt >= 1 && elements.coldStartBanner) {
          elements.coldStartBanner.style.display = 'flex';
          elements.retryCounter.textContent = attempt;
        }

        if (attempt >= retries) {
          throw err;
        }

        // Wait with backoff
        await new Promise(r => setTimeout(r, backoffMs));
        backoffMs = Math.min(backoffMs * 1.5, 10000);
      }
    }
  }

  async function loadInitialData() {
    const url = `${state.serverUrl}/api/latest`;
    try {
      setConnectionStatus('connecting', 'WAKING UP BACKEND');
      const data = await fetchWithRetry(url);

      if (elements.coldStartBanner) {
        elements.coldStartBanner.style.display = 'none';
      }

      setConnectionStatus('connected', 'LIVE STREAM');

      // Populate frames
      if (Array.isArray(data)) {
        data.forEach(frame => {
          handleNewReading(frame);
        });
      }

      // Render cards for all 4 PMUs (even those with no data yet)
      PMU_CONFIG.forEach(cfg => renderCard(cfg.id));

      // Trigger initial history fetch for active devices
      Object.keys(state.pmus).forEach(id => {
        fetchHistory(id, '-15m');
      });

    } catch (err) {
      console.error('Failed to load initial latest readings:', err);
      setConnectionStatus('error', 'SERVER OFFLINE');
      if (elements.coldStartMsg) {
        elements.coldStartMsg.innerHTML = `<strong>Backend connection timeout:</strong> Could not reach ${state.serverUrl}. <button onclick="location.reload()" style="background:var(--color-cyan);color:#000;border:none;padding:2px 8px;border-radius:4px;cursor:pointer;font-weight:600;">Retry</button>`;
      }
      // Render cards in offline/standby state anyway so UI is ready
      PMU_CONFIG.forEach(cfg => renderCard(cfg.id));
    }
  }

  async function fetchHistory(pmuId, range) {
    const pmu = state.pmus[pmuId];
    if (!pmu) return;

    const url = `${state.serverUrl}/api/history?pmu_id=${encodeURIComponent(pmuId)}&range=${encodeURIComponent(range)}`;
    try {
      const data = await fetch(url);
      if (!data.ok) return;
      const history = await data.json();

      if (Array.isArray(history) && history.length > 0) {
        pmu.historyCache[range] = history;
        
        // Convert to points for frequency chart
        pmu.chartPoints = history
          .filter(h => h.frequency_hz != null)
          .map(h => ({
            time: computeFrameTimestamp(h),
            value: h.frequency_hz
          }));

        // Redraw canvas
        const card = document.getElementById(`card-${pmuId}`);
        if (card) {
          const canvas = card.querySelector('.canvas-freq');
          if (canvas) {
            SynchroChart.drawFrequency(canvas, pmu.chartPoints);
          }
        }

        // If modal is open for this PMU, redraw modal charts
        if (state.isModalOpen && state.selectedPmuId === pmuId) {
          renderModalCharts(pmu, history);
        }
      }
    } catch (err) {
      console.warn(`Could not load history for ${pmuId}:`, err);
    }
  }

  // ---------------------------------------------------------------------------
  // Socket.IO Real-Time Stream
  // ---------------------------------------------------------------------------
  function initSocket() {
    if (state.socket) {
      try { state.socket.disconnect(); } catch (e) {}
    }

    if (typeof io === 'undefined') {
      console.warn('Socket.IO client library not loaded. Real-time push disabled.');
      return;
    }

    console.log(`Connecting Socket.IO to ${state.serverUrl}...`);
    state.socket = io(state.serverUrl, {
      transports: ['websocket', 'polling'],
      reconnectionAttempts: Infinity,
      reconnectionDelay: 2000
    });

    state.socket.on('connect', () => {
      console.log('Socket.IO connected to PMU backend:', state.socket.id);
      setConnectionStatus('connected', 'LIVE STREAM');
    });

    state.socket.on('disconnect', () => {
      console.log('Socket.IO disconnected.');
      setConnectionStatus('reconnecting', 'RECONNECTING');
    });

    state.socket.on('connect_error', (err) => {
      console.warn('Socket.IO connection error:', err.message);
      setConnectionStatus('reconnecting', 'RETRYING');
    });

    // Main real-time event from backend server.js
    state.socket.on('new-reading', (reading) => {
      handleNewReading(reading);
    });
  }

  function setConnectionStatus(type, label) {
    elements.statusDot.className = `status-dot ${type}`;
    elements.statusText.textContent = label;
  }

  // ---------------------------------------------------------------------------
  // Modal Telemetry & Expanded Charts
  // ---------------------------------------------------------------------------
  function openModal(pmuId) {
    state.selectedPmuId = pmuId;
    state.isModalOpen = true;
    const pmu = state.pmus[pmuId];
    if (!pmu) return;

    elements.modalTitle.textContent = `${pmu.id} SCADA TELEMETRY`;
    elements.modalStation.textContent = pmu.station;

    updateModalViews(pmu);

    // Fetch or use cached history for current modal range
    const cached = pmu.historyCache[state.modalRange];
    if (cached) {
      renderModalCharts(pmu, cached);
    } else {
      fetchHistory(pmuId, state.modalRange);
    }

    if (typeof elements.modal.showModal === 'function') {
      elements.modal.showModal();
    } else {
      elements.modal.setAttribute('open', '');
    }
  }

  function closeModal() {
    state.isModalOpen = false;
    if (typeof elements.modal.close === 'function') {
      elements.modal.close();
    } else {
      elements.modal.removeAttribute('open');
    }
  }

  function updateModalViews(pmu) {
    const f = pmu.latestFrame;
    if (!f) {
      elements.modalTimestamp.textContent = 'No telemetry frames recorded.';
      elements.modalRawJson.textContent = 'No frame data available.';
      return;
    }

    const ts = computeFrameTimestamp(f);
    elements.modalTimestamp.textContent = `Timestamp: ${formatTimeIso(ts)} (SOC: ${f.timestamp_soc}, \u03BCs: ${f.timestamp_frac_sec_us})`;

    // Phase angle delta = V_angle - I_angle
    if (f.voltage_angle_deg != null && f.current_angle_deg != null) {
      const deltaDeg = f.voltage_angle_deg - f.current_angle_deg;
      elements.modalAngleVal.textContent = `${deltaDeg >= 0 ? '+' : ''}${deltaDeg.toFixed(2)}\u00B0`;
    }

    // ROCOF
    if (f.rocof_hz_per_s != null) {
      elements.modalRocofVal.textContent = `${f.rocof_hz_per_s.toFixed(3)} Hz/s`;
    }

    // Raw JSON Inspector
    elements.modalRawJson.textContent = JSON.stringify(f, null, 2);
  }

  function renderModalCharts(pmu, history) {
    if (!Array.isArray(history) || history.length === 0) return;

    // 1. Voltage & Current Dual Series
    const seriesV = history.filter(h => h.voltage_magnitude_v != null).map(h => ({
      time: computeFrameTimestamp(h),
      value: h.voltage_magnitude_v
    }));
    const seriesI = history.filter(h => h.current_magnitude_a != null).map(h => ({
      time: computeFrameTimestamp(h),
      value: h.current_magnitude_a
    }));
    SynchroChart.drawDualSeries(elements.modalChartVI, seriesV, seriesI, 'Voltage (V)', 'Current (A)');

    // 2. Phase Angle Difference
    const seriesAngle = history
      .filter(h => h.voltage_angle_deg != null && h.current_angle_deg != null)
      .map(h => ({
        time: computeFrameTimestamp(h),
        value: h.voltage_angle_deg - h.current_angle_deg
      }));
    SynchroChart.drawZeroCenteredSeries(elements.modalChartAngle, seriesAngle, '\u00B0', '#8b5cf6');

    // 3. ROCOF
    const seriesRocof = history
      .filter(h => h.rocof_hz_per_s != null)
      .map(h => ({
        time: computeFrameTimestamp(h),
        value: h.rocof_hz_per_s
      }));
    SynchroChart.drawZeroCenteredSeries(elements.modalChartRocof, seriesRocof, 'Hz/s', '#ec4899');
  }

  // ---------------------------------------------------------------------------
  // Demo / Simulation Generator (Academic & Testing Mode)
  // ---------------------------------------------------------------------------
  function toggleSimulation() {
    state.isSimulating = !state.isSimulating;
    elements.btnToggleSim.classList.toggle('active', state.isSimulating);
    elements.btnToggleSim.querySelector('span').textContent = state.isSimulating ? 'Stop Demo' : 'Demo Feed';

    if (state.isSimulating) {
      console.log('Demo Hardware Simulator Started');
      let seq = 1000;
      state.simTimer = setInterval(() => {
        seq++;
        const now = Date.now();
        const soc = Math.floor(now / 1000);
        const fracUs = (now % 1000) * 1000;

        // Simulate frame for all 4 PMUs in sequence
        PMU_CONFIG.forEach((cfg, idx) => {
          const baseFreq = 50.0 + (Math.sin(seq * 0.1 + idx) * 0.035) + ((Math.random() - 0.5) * 0.01);
          const vMag = 230.0 + Math.sin(seq * 0.05 + idx) * 3.5 + (Math.random() - 0.5);
          const iMag = 4.8 + Math.cos(seq * 0.08 + idx) * 0.5 + (Math.random() - 0.5) * 0.2;
          const vAngle = -2.0 + Math.sin(seq * 0.1) * 1.5;
          const iAngle = vAngle - (15.0 + Math.sin(seq * 0.05) * 2.0);
          const pKw = (vMag * iMag * Math.cos((vAngle - iAngle) * Math.PI / 180)) / 1000;
          const qKvar = (vMag * iMag * Math.sin((vAngle - iAngle) * Math.PI / 180)) / 1000;
          const sKva = (vMag * iMag) / 1000;
          const pf = Math.cos((vAngle - iAngle) * Math.PI / 180);

          const simFrame = {
            pmu_id: cfg.id,
            station: cfg.defaultStation,
            sequence: seq + idx * 10,
            rate_hz: 10,
            timestamp_soc: soc,
            timestamp_frac_sec_us: fracUs,
            sync_source: 'GPS_NMEA',
            sync_locked: true,
            sync_pps_count: seq,
            sync_time_quality: 3,
            voltage_magnitude_v: Number(vMag.toFixed(2)),
            voltage_angle_deg: Number(vAngle.toFixed(2)),
            current_magnitude_a: Number(iMag.toFixed(3)),
            current_angle_deg: Number(iAngle.toFixed(2)),
            frequency_hz: Number(baseFreq.toFixed(3)),
            rocof_hz_per_s: Number(((Math.random() - 0.5) * 0.02).toFixed(3)),
            power_p_kw: Number(pKw.toFixed(3)),
            power_q_kvar: Number(qKvar.toFixed(3)),
            power_s_kva: Number(sKva.toFixed(3)),
            power_power_factor: Number(pf.toFixed(3)),
            status_data_valid: true,
            status_pmu_ok: true,
            status_test_mode: false,
            status_gps_locked: true,
            status_measurement_valid: true
          };

          handleNewReading(simFrame);
        });
      }, 1500);
    } else {
      console.log('Demo Hardware Simulator Stopped');
      if (state.simTimer) clearInterval(state.simTimer);
    }
  }

  // ---------------------------------------------------------------------------
  // 1-Second Interval Timer for Staleness & Clock
  // ---------------------------------------------------------------------------
  function startStalenessMonitor() {
    setInterval(() => {
      Object.keys(state.pmus).forEach(id => {
        const pmu = state.pmus[id];
        const card = document.getElementById(`card-${id}`);
        if (!card || card.classList.contains('skeleton')) return;

        const ageSec = getFrameAgeSeconds(pmu.frameTimeMs);
        const isStale = ageSec > state.staleThresholdSec;

        const ageEl = card.querySelector('.age-val');
        if (ageEl) {
          ageEl.textContent = pmu.latestFrame ? (ageSec === 0 ? 'Just now' : `${ageSec}s ago`) : 'No frames';
        }

        const lastUpWrap = card.querySelector('.last-updated');
        if (lastUpWrap) {
          lastUpWrap.classList.toggle('stale-text', isStale);
        }

        card.classList.toggle('is-stale', isStale);

        const idTag = card.querySelector('.pmu-id-tag');
        if (idTag) {
          const existingBadge = idTag.querySelector('.stale-badge');
          if (isStale && !existingBadge) {
            const badge = document.createElement('span');
            badge.className = 'stale-badge';
            badge.textContent = 'STALE / OFFLINE';
            idTag.appendChild(badge);
          } else if (!isStale && existingBadge) {
            existingBadge.remove();
          }
        }
      });

      updateGlobalSummary();
    }, 1000);
  }

  // ---------------------------------------------------------------------------
  // App Initialization
  // ---------------------------------------------------------------------------
  function init() {
    renderSkeletons();

    // Event Listeners
    elements.staleSelect.addEventListener('change', (e) => {
      state.staleThresholdSec = parseInt(e.target.value, 10) || 30;
    });

    elements.backendSelect.addEventListener('change', (e) => {
      state.serverUrl = resolveServerUrl(e.target.value);
      console.log('Switching backend URL to:', state.serverUrl);
      loadInitialData();
      initSocket();
    });

    elements.btnToggleSim.addEventListener('click', toggleSimulation);

    elements.modalCloseBtn.addEventListener('click', closeModal);
    elements.modal.addEventListener('click', (e) => {
      if (e.target === elements.modal) closeModal();
    });

    // Modal range selector
    elements.modalRangePills.querySelectorAll('.range-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        elements.modalRangePills.querySelectorAll('.range-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.modalRange = btn.getAttribute('data-range');
        if (state.selectedPmuId) {
          fetchHistory(state.selectedPmuId, state.modalRange);
        }
      });
    });

    // Window resize handler to redraw charts crisply
    window.addEventListener('resize', () => {
      Object.keys(state.pmus).forEach(id => {
        const card = document.getElementById(`card-${id}`);
        if (card) {
          const canvas = card.querySelector('.canvas-freq');
          if (canvas) SynchroChart.drawFrequency(canvas, state.pmus[id].chartPoints);
        }
      });
      if (state.isModalOpen && state.selectedPmuId) {
        const pmu = state.pmus[state.selectedPmuId];
        const cached = pmu.historyCache[state.modalRange];
        if (cached) renderModalCharts(pmu, cached);
      }
    });

    // Resolve URL and start
    state.serverUrl = resolveServerUrl(elements.backendSelect.value);
    loadInitialData();
    initSocket();
    startStalenessMonitor();
  }

  // Boot on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
