/**
 * WAMS Synchrophasor PMU SCADA Dashboard — Application Logic
 * Modern SaaS / Engineering Analytics (Streamlit / Grafana / Linear)
 *
 * Real-time via Socket.IO "new-reading" event.
 * REST fallback: GET /api/latest, GET /api/history?pmu_id=X&range=Y
 */

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Configuration & Constants
  // ---------------------------------------------------------------------------
  const DEFAULT_RENDER_URL = 'https://pmu-backend-ury8.onrender.com';

  const PMU_CONFIG = [
    { id: 'PMU_A', color: '#2563EB', defaultStation: 'SUBSTATION_1 (Primary Grid Tie)' },
    { id: 'PMU_B', color: '#059669', defaultStation: 'SUBSTATION_2 (Solar Inverter / DG)' },
    { id: 'PMU_C', color: '#D97706', defaultStation: 'SUBSTATION_3 (Industrial Feeder)' },
    { id: 'PMU_D', color: '#7C3AED', defaultStation: 'SUBSTATION_4 (Microgrid Bus)' },
  ];

  const ALLOWED_RANGES = ['-15m', '-1h', '-6h', '-24h', '-7d'];
  const NOMINAL_HZ = 50.0;
  const FREQ_ALARM_HZ = 0.5;   // ±0.5 Hz from nominal
  const FREQ_WARN_HZ  = 0.2;   // ±0.2 Hz from nominal

  // Application State
  const state = {
    serverUrl: DEFAULT_RENDER_URL,
    staleThresholdSec: 30,
    socket: null,
    isConnected: false,
    inspectedPmuId: null,  // currently open in modal
    isModalOpen: false,
    modalRange: '-15m',
    isSimulating: false,
    simTimer: null,
    globalFreqRange: '-15m',
    alarmCount: 0,
    // Per-PMU state
    pmus: {}
  };

  PMU_CONFIG.forEach(cfg => {
    state.pmus[cfg.id] = {
      id: cfg.id,
      color: cfg.color,
      station: cfg.defaultStation,
      latestFrame: null,
      frameTimeMs: 0,
      activeRange: '-15m',
      historyCache: {},
      chartPoints: []   // frequency sparkline points
    };
  });

  // DOM Elements
  const el = {
    cardsGrid:    document.getElementById('pmu-cards-grid'),
    pmuIndex:     document.getElementById('pmu-index'),
    angleSepBody: document.querySelector('#angle-sep-table tbody'),
    alarmLog:     document.getElementById('alarm-log'),
    alarmInitTime:document.getElementById('alarm-init-time'),
    alarmBadge:   document.getElementById('alarm-badge'),
    alarmCount:   document.getElementById('alarm-count'),
    connDot:      document.getElementById('conn-dot'),
    connText:     document.getElementById('conn-text'),
    utcClock:     document.getElementById('utc-time'),
    coldBanner:   document.getElementById('cold-banner'),
    coldMsg:      document.getElementById('cold-msg'),
    retryCounter: document.getElementById('retry-counter'),
    statOnline:   document.getElementById('stat-online'),
    statLastFrame:document.getElementById('stat-last-frame'),
    statRate:     document.getElementById('stat-rate'),
    staleSelect:  document.getElementById('stale-threshold-select'),
    backendSelect:document.getElementById('backend-target-select'),
    btnSim:       document.getElementById('btn-toggle-sim'),
    themeBtn:     document.getElementById('btn-theme-toggle'),
    sunIcon:      document.getElementById('theme-sun-icon'),
    moonIcon:     document.getElementById('theme-moon-icon'),
    globalFreqCanvas:  document.getElementById('global-freq-canvas'),
    globalAngleCanvas: document.getElementById('global-angle-canvas'),
    globalFreqPills:   document.getElementById('global-freq-pills'),
    // Modal
    modal:        document.getElementById('detail-modal'),
    modalH2:      document.getElementById('modal-h2'),
    modalTs:      document.getElementById('modal-ts'),
    modalClose:   document.getElementById('modal-close'),
    modalRangePills: document.getElementById('modal-range-pills'),
    modalPhasorCanvas: document.getElementById('modal-phasor-canvas'),
    mvFreq:       document.getElementById('mv-freq'),
    mvRocof:      document.getElementById('mv-rocof'),
    mvVmag:       document.getElementById('mv-vmag'),
    mvVangle:     document.getElementById('mv-vangle'),
    mvImag:       document.getElementById('mv-imag'),
    mvIangle:     document.getElementById('mv-iangle'),
    mvP:          document.getElementById('mv-p'),
    mvQ:          document.getElementById('mv-q'),
    mvPf:         document.getElementById('mv-pf'),
    mvS:          document.getElementById('mv-s'),
    modalChartVI:    document.getElementById('modal-chart-vi'),
    modalChartAngle: document.getElementById('modal-chart-angle'),
    modalChartRocof: document.getElementById('modal-chart-rocof'),
    modalChartFreq:  document.getElementById('modal-chart-freq'),
    modalRawJson: document.getElementById('modal-raw-json'),
  };

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------
  function resolveServerUrl(choice) {
    if (choice === 'auto') {
      const o = window.location.origin;
      return (o && o.startsWith('http') && !o.includes('file://')) ? o : DEFAULT_RENDER_URL;
    }
    return choice;
  }

  function computeFrameTimestamp(frame) {
    if (frame.time) return new Date(frame.time).getTime();
    if (frame.timestamp_soc != null) {
      return frame.timestamp_soc * 1000 + Math.round((frame.timestamp_frac_sec_us || 0) / 1000);
    }
    return Date.now();
  }

  function getFrameAgeSec(frameTimeMs) {
    if (!frameTimeMs) return Infinity;
    return Math.max(0, Math.floor((Date.now() - frameTimeMs) / 1000));
  }

  function fmtHz(v) { return v != null ? v.toFixed(3) : '---.---'; }
  function fmtV(v)  { return v != null ? v.toFixed(1)  : '---.--'; }
  function fmtA(v)  { return v != null ? v.toFixed(2)  : '--.---'; }
  function fmtDeg(v){ return v != null ? v.toFixed(2)  : '--.-'; }
  function fmtKW(v) { return v != null ? v.toFixed(3)  : '-.---'; }
  function fmtPF(v) { return v != null ? v.toFixed(3)  : '-.---'; }

  function nowUtc() {
    const d = new Date();
    return d.getUTCHours().toString().padStart(2,'0') + ':' +
           d.getUTCMinutes().toString().padStart(2,'0') + ':' +
           d.getUTCSeconds().toString().padStart(2,'0');
  }

  function getFreqStatus(hz) {
    if (hz == null) return 'ok';
    const dev = Math.abs(hz - NOMINAL_HZ);
    if (dev > FREQ_ALARM_HZ) return 'alarm';
    if (dev > FREQ_WARN_HZ)  return 'warn';
    return 'ok';
  }

  // ---------------------------------------------------------------------------
  // Theme Management (Light by default, Dark optional)
  // ---------------------------------------------------------------------------
  function initTheme() {
    const saved = localStorage.getItem('pmu_theme') || 'light';
    setTheme(saved);

    if (el.themeBtn) {
      el.themeBtn.addEventListener('click', () => {
        const cur = document.documentElement.getAttribute('data-theme') || 'light';
        const next = cur === 'dark' ? 'light' : 'dark';
        setTheme(next);
      });
    }
  }

  function setTheme(theme) {
    if (theme === 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
      if (el.sunIcon) el.sunIcon.style.display = 'block';
      if (el.moonIcon) el.moonIcon.style.display = 'none';
    } else {
      document.documentElement.removeAttribute('data-theme');
      if (el.sunIcon) el.sunIcon.style.display = 'none';
      if (el.moonIcon) el.moonIcon.style.display = 'block';
    }
    localStorage.setItem('pmu_theme', theme);
    redrawAllCanvases();
  }

  function redrawAllCanvases() {
    Object.keys(state.pmus).forEach(id => {
      const card = document.getElementById(`card-${id}`);
      const pmu = state.pmus[id];
      if (card) {
        const fc = card.querySelector('.canvas-freq');
        if (fc) SynchroChart.drawFrequency(fc, pmu.chartPoints);
        const pc = card.querySelector('.canvas-phasor');
        if (pc) {
          if (pmu.latestFrame) {
            SynchroChart.drawPhasor(pc,
              pmu.latestFrame.voltage_magnitude_v, pmu.latestFrame.voltage_angle_deg,
              pmu.latestFrame.current_magnitude_a, pmu.latestFrame.current_angle_deg
            );
          } else {
            SynchroChart.drawPhasor(pc, null, null, null, null);
          }
        }
      }
    });

    if (state.isModalOpen && state.inspectedPmuId) {
      const pmu = state.pmus[state.inspectedPmuId];
      if (pmu) updateModalVitals(pmu);
    }
    redrawGlobalCharts();
  }

  // ---------------------------------------------------------------------------
  // UTC Clock
  // ---------------------------------------------------------------------------
  function startClock() {
    if (el.alarmInitTime) el.alarmInitTime.textContent = nowUtc();
    setInterval(() => {
      if (el.utcClock) el.utcClock.textContent = nowUtc();
    }, 1000);
  }

  // ---------------------------------------------------------------------------
  // Connection Status (Subtle calm dot, no neon blinking)
  // ---------------------------------------------------------------------------
  function setConnStatus(state_str, label) {
    if (el.connDot) el.connDot.className = `conn-dot ${state_str}`;
    if (el.connText) el.connText.textContent = label;
  }

  // ---------------------------------------------------------------------------
  // Alarm Log
  // ---------------------------------------------------------------------------
  function logAlarm(level, message) {
    const entry = document.createElement('div');
    entry.className = `alarm-entry level-${level}`;
    entry.innerHTML = `<span class="alarm-time mono">${nowUtc()}</span><span class="alarm-msg">${message}</span>`;

    if (el.alarmLog) {
      el.alarmLog.insertBefore(entry, el.alarmLog.firstChild);
      while (el.alarmLog.children.length > 50) {
        el.alarmLog.removeChild(el.alarmLog.lastChild);
      }
    }

    if (level === 'alarm' || level === 'warn') {
      state.alarmCount++;
      if (el.alarmBadge) {
        el.alarmBadge.className = 'alarm-badge';
        if (el.alarmCount) el.alarmCount.textContent = `${state.alarmCount} Alarm${state.alarmCount !== 1 ? 's' : ''}`;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // PMU Sidebar Index
  // ---------------------------------------------------------------------------
  function renderSidebarIndex() {
    if (!el.pmuIndex) return;
    el.pmuIndex.innerHTML = PMU_CONFIG.map(cfg => {
      const pmu = state.pmus[cfg.id];
      const frame = pmu.latestFrame;
      const ageSec = getFrameAgeSec(pmu.frameTimeMs);
      const isStale = ageSec > state.staleThresholdSec;
      const hasData = frame !== null;
      const freq = frame ? fmtHz(frame.frequency_hz) : '---.---';
      const statusLabel = !hasData ? 'Offline' : isStale ? 'Stale' : 'Online';
      const statusColor = !hasData ? 'var(--alarm)' : isStale ? 'var(--warn)' : 'var(--ok)';
      const dotClass = !hasData ? 'offline' : isStale ? 'stale' : 'online';

      return `
        <div class="pmu-row" id="row-${cfg.id}" data-pmu="${cfg.id}" role="button" tabindex="0" title="${pmu.station}">
          <span class="pmu-row-dot ${dotClass}" style="background: ${cfg.color};"></span>
          <div class="pmu-row-info">
            <div class="pmu-row-id">${cfg.id}</div>
            <div class="pmu-row-station">${pmu.station}</div>
          </div>
          <div style="text-align:right;">
            <div class="pmu-row-status" style="color: ${statusColor};">${statusLabel}</div>
            <div class="pmu-row-freq mono">${freq} Hz</div>
          </div>
        </div>
      `;
    }).join('');

    el.pmuIndex.querySelectorAll('.pmu-row').forEach(row => {
      row.addEventListener('click', () => openModal(row.getAttribute('data-pmu')));
      row.addEventListener('keydown', e => { if (e.key === 'Enter') openModal(row.getAttribute('data-pmu')); });
    });
  }

  // ---------------------------------------------------------------------------
  // Angular Separation Table (WAMS key feature)
  // ---------------------------------------------------------------------------
  function updateAngleSepTable() {
    if (!el.angleSepBody) return;
    const refFrame = state.pmus['PMU_A'] && state.pmus['PMU_A'].latestFrame;

    const rows = ['PMU_B', 'PMU_C', 'PMU_D'].map(id => {
      const pmu = state.pmus[id];
      const f = pmu && pmu.latestFrame;

      if (!f || !refFrame) {
        return `<tr><td style="font-weight:600;color:${PMU_CONFIG.find(c => c.id === id)?.color || '#2563EB'}">${id}</td><td class="dim mono">—</td><td class="dim mono">—</td><td class="dim mono">—</td></tr>`;
      }

      const dv = (f.voltage_angle_deg - (refFrame.voltage_angle_deg || 0));
      const di = (f.current_angle_deg  - (refFrame.current_angle_deg  || 0));
      const df = (f.frequency_hz       - (refFrame.frequency_hz       || NOMINAL_HZ));

      const dvClass = Math.abs(dv) > 30 ? 'sep-large' : Math.abs(dv) > 15 ? 'sep-medium' : '';
      const color = PMU_CONFIG.find(c => c.id === id)?.color || '#2563EB';

      return `
        <tr>
          <td style="font-weight:600;color:${color}">${id}</td>
          <td class="mono ${dvClass}">${dv >= 0 ? '+' : ''}${dv.toFixed(2)}</td>
          <td class="mono">${di >= 0 ? '+' : ''}${di.toFixed(2)}</td>
          <td class="mono">${df >= 0 ? '+' : ''}${df.toFixed(3)}</td>
        </tr>`;
    });

    el.angleSepBody.innerHTML = rows.join('');
  }

  // ---------------------------------------------------------------------------
  // Status Bar
  // ---------------------------------------------------------------------------
  function updateStatusBar() {
    let onlineCount = 0;
    let latestMs = 0;
    let latestRate = null;

    Object.values(state.pmus).forEach(pmu => {
      const age = getFrameAgeSec(pmu.frameTimeMs);
      const isOnline = pmu.latestFrame && age <= state.staleThresholdSec;
      if (isOnline) onlineCount++;
      if (pmu.frameTimeMs > latestMs) latestMs = pmu.frameTimeMs;
      if (pmu.latestFrame && pmu.latestFrame.rate_hz != null) latestRate = pmu.latestFrame.rate_hz;

      const dot = document.getElementById(`dot-${pmu.id}`);
      if (dot) {
        dot.classList.toggle('online', !!isOnline);
        dot.classList.toggle('offline', !isOnline);
      }
    });

    if (el.statOnline) {
      el.statOnline.textContent = `${onlineCount} / 4`;
      el.statOnline.style.color = onlineCount === 4 ? 'var(--ok)' : onlineCount > 0 ? 'var(--warn)' : 'var(--alarm)';
    }
    if (el.statLastFrame && latestMs > 0) {
      const d = new Date(latestMs);
      el.statLastFrame.textContent = d.toISOString().substr(11, 12) + ' UTC';
    }
    if (el.statRate && latestRate) {
      el.statRate.textContent = `${latestRate} sps`;
    }
  }

  // ---------------------------------------------------------------------------
  // PMU Cards — Build HTML
  // ---------------------------------------------------------------------------
  function buildCardHtml(pmu) {
    const f = pmu.latestFrame || {};
    const ageSec = getFrameAgeSec(pmu.frameTimeMs);
    const isStale = ageSec > state.staleThresholdSec;
    const hasData = pmu.latestFrame !== null;
    const cfg = PMU_CONFIG.find(c => c.id === pmu.id);

    const freq = hasData ? fmtHz(f.frequency_hz) : '50.000';
    const dev = (hasData && f.frequency_hz != null) ? (f.frequency_hz - NOMINAL_HZ) : 0;
    const devSign = dev >= 0 ? `+${dev.toFixed(3)}` : dev.toFixed(3);
    const devCls = !hasData ? 'dim' : Math.abs(dev) > FREQ_ALARM_HZ ? 'alarm' : Math.abs(dev) > FREQ_WARN_HZ ? 'warn' : 'ok';

    // Frequency bar fill
    const barPct = Math.min(Math.abs(dev) / FREQ_ALARM_HZ * 50, 50);
    const barColor = !hasData ? 'transparent' : devCls === 'alarm' ? 'var(--alarm)' : devCls === 'warn' ? 'var(--warn)' : 'var(--ok)';

    // Status badges
    let badgesHtml = '';
    if (!hasData) {
      badgesHtml = `<span class="badge neutral">OFFLINE</span>`;
    } else {
      const pmuOk  = f.status_pmu_ok === true;
      const gpsOk  = f.status_gps_locked === true;
      const dataOk = f.status_data_valid === true;
      badgesHtml = `
        <span class="badge ${isStale ? 'warn' : 'ok'}">${isStale ? 'STALE' : 'ONLINE'}</span>
        ${pmuOk  ? '<span class="badge ok">PMU OK</span>' : '<span class="badge alarm">PMU ERR</span>'}
        ${gpsOk  ? '<span class="badge ok">GPS LK</span>' : '<span class="badge warn">GPS UN</span>'}
        ${dataOk ? '' : '<span class="badge alarm">DATA ERR</span>'}
      `;
    }

    const syncSrc = hasData ? (f.sync_source || 'N/A') : '—';
    const tQ      = (hasData && f.sync_time_quality != null) ? f.sync_time_quality : '—';
    const ageText = hasData ? (ageSec === 0 ? 'Just now' : `${ageSec}s ago`) : 'No telemetry';
    const seq     = hasData && f.sequence != null ? `#${f.sequence}` : '—';
    const rate    = hasData && f.rate_hz != null ? `${f.rate_hz} sps` : '—';
    const staleClass = isStale ? 'stale' : '';

    return `
      <!-- Card Header -->
      <div class="card-header">
        <div class="card-title-wrap">
          <span class="card-id" style="color:${cfg?.color || '#2563EB'}">${pmu.id}</span>
          <span class="card-station">${pmu.station}</span>
        </div>
        <div class="card-badges">
          ${badgesHtml}
        </div>
        <span class="card-age ${staleClass}"><span class="val-age">${ageText}</span></span>
      </div>

      <!-- Card Body: Phasor diagram | Measurement data -->
      <div class="card-body">
        <!-- Phasor polar diagram -->
        <div class="phasor-panel">
          <span class="phasor-title">Phasor Diagram</span>
          <div class="phasor-canvas-wrap">
            <canvas class="canvas-phasor"></canvas>
          </div>
          <div class="phasor-legend">
            <div class="phasor-legend-item">
              <span class="phasor-legend-dot" style="background:var(--voltage-color)"></span>
              <span>V: <span class="mono val-vmag">${hasData ? fmtV(f.voltage_magnitude_v) : '—'}</span> V @ <span class="mono val-vangle">${hasData ? fmtDeg(f.voltage_angle_deg) + '°' : '—'}</span></span>
            </div>
            <div class="phasor-legend-item">
              <span class="phasor-legend-dot" style="background:var(--current-color)"></span>
              <span>I: <span class="mono val-imag">${hasData ? fmtA(f.current_magnitude_a) : '—'}</span> A @ <span class="mono val-iangle">${hasData ? fmtDeg(f.current_angle_deg) + '°' : '—'}</span></span>
            </div>
          </div>
        </div>

        <!-- Data panel -->
        <div class="data-panel">
          <!-- Frequency primary metric -->
          <div class="freq-bar-wrap">
            <div class="freq-bar-header">
              <span>
                <span class="freq-reading mono ${devCls} val-freq">${hasData ? freq : '—'}</span>
                <span class="freq-deviation ${devCls} val-delta">${hasData ? devSign + ' Hz' : 'Standby'}</span>
              </span>
              <span class="label">Grid Frequency</span>
            </div>
            <div class="freq-bar-track">
              <div class="freq-bar-fill val-freqbar" style="width:${barPct}%; background:${barColor}; ${dev >= 0 ? 'left:50%' : `left:calc(50% - ${barPct}%)`}"></div>
              <div class="freq-bar-center"></div>
            </div>
          </div>

          <!-- Electrical measurements table -->
          <table class="meas-table" aria-label="${pmu.id} measurements">
            <tbody>
              <tr>
                <td class="meas-name">Voltage (RMS)</td>
                <td class="meas-val mono val-vmag">${hasData ? fmtV(f.voltage_magnitude_v) : '—'}</td>
                <td class="meas-unit">V</td>
              </tr>
              <tr>
                <td class="meas-name">Voltage Angle θ_V</td>
                <td class="meas-val mono val-vangle">${hasData ? fmtDeg(f.voltage_angle_deg) : '—'}</td>
                <td class="meas-unit">°</td>
              </tr>
              <tr>
                <td class="meas-name">Current (RMS)</td>
                <td class="meas-val mono val-imag">${hasData ? fmtA(f.current_magnitude_a) : '—'}</td>
                <td class="meas-unit">A</td>
              </tr>
              <tr>
                <td class="meas-name">Current Angle θ_I</td>
                <td class="meas-val mono val-iangle">${hasData ? fmtDeg(f.current_angle_deg) : '—'}</td>
                <td class="meas-unit">°</td>
              </tr>
              <tr class="meas-divider">
                <td class="meas-name">Active Power P</td>
                <td class="meas-val mono val-p">${hasData ? fmtKW(f.power_p_kw) : '—'}</td>
                <td class="meas-unit">kW</td>
              </tr>
              <tr>
                <td class="meas-name">Reactive Power Q</td>
                <td class="meas-val mono val-q">${hasData ? fmtKW(f.power_q_kvar) : '—'}</td>
                <td class="meas-unit">kVAR</td>
              </tr>
              <tr>
                <td class="meas-name">Apparent Power S</td>
                <td class="meas-val mono val-s">${hasData ? fmtKW(f.power_s_kva) : '—'}</td>
                <td class="meas-unit">kVA</td>
              </tr>
              <tr>
                <td class="meas-name">Power Factor</td>
                <td class="meas-val mono val-pf">${hasData ? fmtPF(f.power_power_factor) : '—'}</td>
                <td class="meas-unit"></td>
              </tr>
              <tr class="meas-divider">
                <td class="meas-name">ROCOF</td>
                <td class="meas-val mono val-rocof">${hasData && f.rocof_hz_per_s != null ? f.rocof_hz_per_s.toFixed(3) : '—'}</td>
                <td class="meas-unit">Hz/s</td>
              </tr>
              <tr>
                <td class="meas-name">Sync Source</td>
                <td class="meas-val mono">${syncSrc}</td>
                <td class="meas-unit">TQ: ${tQ}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- Card Footer -->
      <div class="card-footer">
        <div class="range-pills">
          ${ALLOWED_RANGES.map(r => `<button class="rpill${pmu.activeRange === r ? ' active' : ''}" data-pmu="${pmu.id}" data-range="${r}">${r.replace('-','')}</button>`).join('')}
        </div>
        <div class="sparkline-wrap"><canvas class="canvas-freq"></canvas></div>
        <span class="dim mono" style="font-size:10px;">Seq: <span class="val-seq">${seq}</span> &bull; <span class="val-rate">${rate}</span></span>
        <button class="btn-inspect" data-pmu="${pmu.id}">Inspect &rarr;</button>
      </div>
    `;
  }

  function renderCard(pmuId) {
    const id = (typeof pmuId === 'object' && pmuId !== null) ? pmuId.id : pmuId;
    const pmu = state.pmus[id];
    if (!pmu) return;

    const ageSec = getFrameAgeSec(pmu.frameTimeMs);
    const isStale = ageSec > state.staleThresholdSec;

    let card = document.getElementById(`card-${id}`);
    const isNew = !card;

    if (isNew) {
      card = document.createElement('div');
      card.id = `card-${id}`;
      card.className = 'pmu-card';
      card.setAttribute('data-pmu', id);
      el.cardsGrid.appendChild(card);
    }

    card.className = `pmu-card ${isStale && pmu.latestFrame ? 'stale' : !pmu.latestFrame ? 'offline' : ''}`;
    card.innerHTML = buildCardHtml(pmu);
    bindCardEvents(card, id);

    // Draw phasor diagram
    const phasorCanvas = card.querySelector('.canvas-phasor');
    if (phasorCanvas) {
      if (pmu.latestFrame) {
        const f = pmu.latestFrame;
        SynchroChart.drawPhasor(phasorCanvas,
          f.voltage_magnitude_v, f.voltage_angle_deg,
          f.current_magnitude_a, f.current_angle_deg
        );
      } else {
        SynchroChart.drawPhasor(phasorCanvas, null, null, null, null);
      }
    }

    // Draw frequency sparkline
    const freqCanvas = card.querySelector('.canvas-freq');
    if (freqCanvas) {
      SynchroChart.drawFrequency(freqCanvas, pmu.chartPoints, {
        emptyText: pmu.latestFrame ? 'Populating...' : 'Standby'
      });
    }
  }

  function updateCardValues(pmuId) {
    const pmu = state.pmus[pmuId];
    const f = pmu?.latestFrame;
    if (!f) return;

    const card = document.getElementById(`card-${pmuId}`);
    if (!card) return;

    const ageSec = getFrameAgeSec(pmu.frameTimeMs);
    const isStale = ageSec > state.staleThresholdSec;
    card.className = `pmu-card${isStale ? ' stale' : ''}`;

    const setText = (sel, val) => { const e = card.querySelector(sel); if (e) e.textContent = val; };

    const dev = f.frequency_hz != null ? f.frequency_hz - NOMINAL_HZ : 0;
    const devSign = dev >= 0 ? `+${dev.toFixed(3)}` : dev.toFixed(3);
    const devCls = Math.abs(dev) > FREQ_ALARM_HZ ? 'alarm' : Math.abs(dev) > FREQ_WARN_HZ ? 'warn' : 'ok';

    // Frequency
    const freqEl = card.querySelector('.val-freq');
    if (freqEl && f.frequency_hz != null) {
      freqEl.textContent = fmtHz(f.frequency_hz);
      freqEl.className = `freq-reading mono val-freq ${devCls}`;
    }
    const deltaEl = card.querySelector('.val-delta');
    if (deltaEl) {
      deltaEl.textContent = devSign + ' Hz';
      deltaEl.className = `freq-deviation val-delta ${devCls}`;
    }

    // Frequency bar
    const barEl = card.querySelector('.val-freqbar');
    if (barEl) {
      const barPct = Math.min(Math.abs(dev) / FREQ_ALARM_HZ * 50, 50);
      const barColor = devCls === 'alarm' ? 'var(--alarm)' : devCls === 'warn' ? 'var(--warn)' : 'var(--ok)';
      barEl.style.width = barPct + '%';
      barEl.style.background = barColor;
      barEl.style.left = dev >= 0 ? '50%' : `calc(50% - ${barPct}%)`;
    }

    // Update badges
    const badgesWrap = card.querySelector('.card-badges');
    if (badgesWrap) {
      const pmuOk  = f.status_pmu_ok === true;
      const gpsOk  = f.status_gps_locked === true;
      const dataOk = f.status_data_valid === true;
      badgesWrap.innerHTML = `
        <span class="badge ${isStale ? 'warn' : 'ok'}">${isStale ? 'STALE' : 'ONLINE'}</span>
        ${pmuOk  ? '<span class="badge ok">PMU OK</span>' : '<span class="badge alarm">PMU ERR</span>'}
        ${gpsOk  ? '<span class="badge ok">GPS LK</span>' : '<span class="badge warn">GPS UN</span>'}
        ${dataOk ? '' : '<span class="badge alarm">DATA ERR</span>'}
      `;
    }

    setText('.val-vmag', fmtV(f.voltage_magnitude_v));
    setText('.val-vangle', fmtDeg(f.voltage_angle_deg) + '°');
    setText('.val-imag', fmtA(f.current_magnitude_a));
    setText('.val-iangle', fmtDeg(f.current_angle_deg) + '°');
    setText('.val-p', fmtKW(f.power_p_kw));
    setText('.val-q', fmtKW(f.power_q_kvar));
    setText('.val-s', fmtKW(f.power_s_kva));
    setText('.val-pf', fmtPF(f.power_power_factor));
    setText('.val-rocof', f.rocof_hz_per_s != null ? f.rocof_hz_per_s.toFixed(3) : '—');
    setText('.val-age', pmu.latestFrame ? (ageSec === 0 ? 'Just now' : `${ageSec}s ago`) : 'No telemetry');
    setText('.val-seq', f.sequence != null ? `#${f.sequence}` : '—');
    setText('.val-rate', f.rate_hz != null ? `${f.rate_hz} sps` : '—');

    // Phasor diagram update
    const phasorCanvas = card.querySelector('.canvas-phasor');
    if (phasorCanvas) {
      SynchroChart.drawPhasor(phasorCanvas,
        f.voltage_magnitude_v, f.voltage_angle_deg,
        f.current_magnitude_a, f.current_angle_deg
      );
    }

    // Sparkline update
    const freqCanvas = card.querySelector('.canvas-freq');
    if (freqCanvas) {
      SynchroChart.drawFrequency(freqCanvas, pmu.chartPoints);
    }
  }

  function bindCardEvents(card, pmuId) {
    const inspectBtn = card.querySelector('.btn-inspect');
    if (inspectBtn) inspectBtn.addEventListener('click', () => openModal(pmuId));

    card.querySelectorAll('.rpill').forEach(btn => {
      btn.addEventListener('click', e => {
        const range = e.currentTarget.getAttribute('data-range');
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
      card.querySelectorAll('.rpill').forEach(b =>
        b.classList.toggle('active', b.getAttribute('data-range') === range)
      );
    }
    fetchHistory(pmuId, range);
  }

  function renderSkeletons() {
    PMU_CONFIG.forEach(cfg => renderCard(cfg.id));
  }

  // ---------------------------------------------------------------------------
  // Global Bottom Panel Charts
  // ---------------------------------------------------------------------------
  function redrawGlobalCharts() {
    if (!el.globalFreqCanvas) return;

    const series = PMU_CONFIG.map(cfg => ({
      color: cfg.color,
      label: cfg.id,
      points: state.pmus[cfg.id].chartPoints
    }));
    SynchroChart.drawMultiFreq(el.globalFreqCanvas, series);

    if (!el.globalAngleCanvas) return;
    const refPmu = state.pmus['PMU_A'];
    if (!refPmu || !refPmu.historyCache[state.globalFreqRange]) return;
    const refHistory = refPmu.historyCache[state.globalFreqRange];

    const angleSeries = ['PMU_B', 'PMU_C', 'PMU_D'].map(id => {
      const cfg = PMU_CONFIG.find(c => c.id === id);
      const history = state.pmus[id].historyCache[state.globalFreqRange] || [];
      const points = history.map(h => {
        const ref = refHistory.find(r => Math.abs(computeFrameTimestamp(r) - computeFrameTimestamp(h)) < 5000);
        const delta = (h.voltage_angle_deg || 0) - (ref ? (ref.voltage_angle_deg || 0) : 0);
        return { time: computeFrameTimestamp(h), value: delta };
      });
      return { color: cfg.color, label: id, points };
    });
    SynchroChart.drawAngleSeparation(el.globalAngleCanvas, angleSeries);
  }

  // ---------------------------------------------------------------------------
  // Data Ingestion & State Updates
  // ---------------------------------------------------------------------------
  function handleNewReading(frame) {
    if (!frame || !frame.pmu_id) return;
    const pmuId = frame.pmu_id;

    if (!state.pmus[pmuId]) {
      const cfg = PMU_CONFIG.find(c => c.id === pmuId) || { color: '#2563EB', defaultStation: 'SUBSTATION' };
      state.pmus[pmuId] = {
        id: pmuId, color: cfg.color,
        station: frame.station || cfg.defaultStation,
        latestFrame: null, frameTimeMs: 0,
        activeRange: '-15m', historyCache: {}, chartPoints: []
      };
    }

    const pmu = state.pmus[pmuId];
    pmu.latestFrame = frame;
    if (frame.station) pmu.station = frame.station;
    pmu.frameTimeMs = computeFrameTimestamp(frame);

    // Append to sparkline
    if (frame.frequency_hz != null) {
      pmu.chartPoints.push({ time: pmu.frameTimeMs, value: frame.frequency_hz });
      if (pmu.chartPoints.length > 200) pmu.chartPoints.shift();
    }

    // Frequency alarm detection
    if (frame.frequency_hz != null) {
      const dev = Math.abs(frame.frequency_hz - NOMINAL_HZ);
      if (dev > FREQ_ALARM_HZ) {
        logAlarm('alarm', `${pmuId}: Frequency deviation ${frame.frequency_hz.toFixed(3)} Hz (Δ${(frame.frequency_hz - NOMINAL_HZ >= 0 ? '+' : '')}${(frame.frequency_hz - NOMINAL_HZ).toFixed(3)} Hz)`);
      }
    }

    // Render / update card
    const card = document.getElementById(`card-${pmuId}`);
    if (!card || card.classList.contains('loading') || card.classList.contains('offline')) {
      renderCard(pmuId);
    } else {
      updateCardValues(pmuId);
    }

    renderSidebarIndex();
    updateAngleSepTable();
    updateStatusBar();
    redrawGlobalCharts();

    if (state.isModalOpen && state.inspectedPmuId === pmuId) {
      updateModalVitals(pmu);
    }
  }

  // ---------------------------------------------------------------------------
  // Network: Fetch with retry (cold-start handling)
  // ---------------------------------------------------------------------------
  async function fetchWithRetry(url, retries = 8, backoffMs = 2000) {
    let attempt = 0;
    while (attempt < retries) {
      try {
        const ctrl = new AbortController();
        const tid = setTimeout(() => ctrl.abort(), 15000);
        const res = await fetch(url, { signal: ctrl.signal });
        clearTimeout(tid);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
      } catch (err) {
        attempt++;
        if (attempt >= 1 && el.coldBanner) {
          el.coldBanner.style.display = 'flex';
          if (el.retryCounter) el.retryCounter.textContent = attempt;
        }
        if (attempt >= retries) throw err;
        await new Promise(r => setTimeout(r, backoffMs));
        backoffMs = Math.min(backoffMs * 1.5, 10000);
      }
    }
  }

  async function loadInitialData() {
    setConnStatus('reconnecting', 'Connecting');
    try {
      const data = await fetchWithRetry(`${state.serverUrl}/api/latest`);
      if (el.coldBanner) el.coldBanner.style.display = 'none';
      setConnStatus('connected', 'Live Stream');

      if (Array.isArray(data)) data.forEach(handleNewReading);
      PMU_CONFIG.forEach(cfg => {
        // Fixed: Pass cfg.id string
        renderCard(cfg.id);
      });

      Object.keys(state.pmus).forEach(id => fetchHistory(id, '-15m'));
      logAlarm('info', 'Initial telemetry loaded successfully.');
    } catch (err) {
      // Only show error and log unreachable if socket is not connected and retries exhausted
      if (!state.isConnected) {
        setConnStatus('error', 'Server Offline');
        if (el.coldMsg) {
          el.coldMsg.innerHTML = `<strong>Backend connection timeout:</strong> ${state.serverUrl} failed to respond after retries. <button onclick="location.reload()" class="ctrl-btn" style="margin-left:8px;padding:2px 8px;">Retry</button>`;
        }
        logAlarm('alarm', `Backend unreachable: ${state.serverUrl}`);
      } else {
        // Socket.IO is connected and operational
        setConnStatus('connected', 'Live Stream');
        if (el.coldBanner) el.coldBanner.style.display = 'none';
      }
      PMU_CONFIG.forEach(cfg => renderCard(cfg.id));
    }
  }

  async function fetchHistory(pmuId, range) {
    const pmu = state.pmus[pmuId];
    if (!pmu) return;
    const url = `${state.serverUrl}/api/history?pmu_id=${encodeURIComponent(pmuId)}&range=${encodeURIComponent(range)}`;
    try {
      const res = await fetch(url);
      if (!res.ok) return;
      const history = await res.json();

      if (Array.isArray(history) && history.length > 0) {
        pmu.historyCache[range] = history;

        if (range === pmu.activeRange) {
          pmu.chartPoints = history
            .filter(h => h.frequency_hz != null)
            .map(h => ({ time: computeFrameTimestamp(h), value: h.frequency_hz }));

          const card = document.getElementById(`card-${pmuId}`);
          if (card) {
            const canvas = card.querySelector('.canvas-freq');
            if (canvas) SynchroChart.drawFrequency(canvas, pmu.chartPoints);
          }
        }

        if (state.isModalOpen && state.inspectedPmuId === pmuId) {
          renderModalCharts(pmu, history);
        }

        redrawGlobalCharts();
      }
    } catch (err) {
      console.warn(`History fetch failed for ${pmuId} ${range}:`, err.message);
    }
  }

  // ---------------------------------------------------------------------------
  // Socket.IO Real-Time Stream
  // ---------------------------------------------------------------------------
  function initSocket() {
    if (state.socket) { try { state.socket.disconnect(); } catch (e) {} }
    if (typeof io === 'undefined') {
      console.warn('Socket.IO not loaded. REST polling fallback active.');
      return;
    }

    state.socket = io(state.serverUrl, {
      transports: ['websocket', 'polling'],
      reconnectionAttempts: Infinity,
      reconnectionDelay: 2000
    });

    state.socket.on('connect', () => {
      state.isConnected = true;
      setConnStatus('connected', 'Live Stream');
      if (el.coldBanner) el.coldBanner.style.display = 'none';
      logAlarm('info', 'Socket.IO stream connected.');
    });
    state.socket.on('disconnect', () => {
      state.isConnected = false;
      setConnStatus('reconnecting', 'Reconnecting');
    });
    state.socket.on('connect_error', () => {
      setConnStatus('reconnecting', 'Retrying');
    });
    state.socket.on('new-reading', frame => handleNewReading(frame));
  }

  // ---------------------------------------------------------------------------
  // Modal Inspector
  // ---------------------------------------------------------------------------
  function openModal(pmuId) {
    state.inspectedPmuId = pmuId;
    state.isModalOpen = true;
    const pmu = state.pmus[pmuId];
    const cfg = PMU_CONFIG.find(c => c.id === pmuId);

    if (el.modalH2) {
      el.modalH2.textContent = `${pmuId} — Telemetry Inspector`;
      el.modalH2.style.color = cfg?.color || 'var(--text-primary)';
    }

    updateModalVitals(pmu);

    const cached = pmu.historyCache[state.modalRange];
    if (cached) renderModalCharts(pmu, cached);
    else fetchHistory(pmuId, state.modalRange);

    if (typeof el.modal.showModal === 'function') el.modal.showModal();
    else el.modal.setAttribute('open', '');

    document.querySelectorAll('.pmu-row').forEach(r =>
      r.classList.toggle('selected', r.getAttribute('data-pmu') === pmuId)
    );
  }

  function closeModal() {
    state.isModalOpen = false;
    if (typeof el.modal.close === 'function') el.modal.close();
    else el.modal.removeAttribute('open');
    document.querySelectorAll('.pmu-row').forEach(r => r.classList.remove('selected'));
  }

  function updateModalVitals(pmu) {
    const f = pmu?.latestFrame;

    if (el.mvFreq) el.mvFreq.textContent = f ? `${fmtHz(f.frequency_hz)} Hz` : '—';
    if (el.mvRocof) el.mvRocof.textContent = f?.rocof_hz_per_s != null ? `ROCOF: ${f.rocof_hz_per_s.toFixed(3)} Hz/s` : 'ROCOF: —';
    if (el.mvVmag) el.mvVmag.textContent = f ? `${fmtV(f.voltage_magnitude_v)} V` : '—';
    if (el.mvVangle) el.mvVangle.textContent = f?.voltage_angle_deg != null ? `θ_V: ${fmtDeg(f.voltage_angle_deg)}°` : 'θ_V: —°';
    if (el.mvImag) el.mvImag.textContent = f ? `${fmtA(f.current_magnitude_a)} A` : '—';
    if (el.mvIangle) el.mvIangle.textContent = f?.current_angle_deg != null ? `θ_I: ${fmtDeg(f.current_angle_deg)}°` : 'θ_I: —°';
    if (el.mvP) el.mvP.textContent = f ? `${fmtKW(f.power_p_kw)} kW` : '—';
    if (el.mvQ) el.mvQ.textContent = f ? `${fmtKW(f.power_q_kvar)} kVAR` : '—';
    if (el.mvPf) el.mvPf.textContent = f ? fmtPF(f.power_power_factor) : '—';
    if (el.mvS) el.mvS.textContent = f ? `S: ${fmtKW(f.power_s_kva)} kVA` : 'S: —';

    if (el.modalTs && f) {
      const ts = computeFrameTimestamp(f);
      el.modalTs.textContent = `Timestamp: ${new Date(ts).toISOString()} | SOC: ${f.timestamp_soc} | μs: ${f.timestamp_frac_sec_us || 0}`;
    }

    if (el.modalPhasorCanvas) {
      if (f) {
        SynchroChart.drawPhasor(el.modalPhasorCanvas,
          f.voltage_magnitude_v, f.voltage_angle_deg,
          f.current_magnitude_a, f.current_angle_deg
        );
      } else {
        SynchroChart.drawPhasor(el.modalPhasorCanvas, null, null, null, null);
      }
    }

    if (el.modalRawJson) el.modalRawJson.textContent = f ? JSON.stringify(f, null, 2) : 'No telemetry data received for this unit.';
  }

  function renderModalCharts(pmu, history) {
    if (!Array.isArray(history) || !history.length) return;

    const seriesV = history.filter(h => h.voltage_magnitude_v != null).map(h => ({
      time: computeFrameTimestamp(h), value: h.voltage_magnitude_v
    }));
    const seriesI = history.filter(h => h.current_magnitude_a != null).map(h => ({
      time: computeFrameTimestamp(h), value: h.current_magnitude_a
    }));
    if (el.modalChartVI) SynchroChart.drawDualSeries(el.modalChartVI, seriesV, seriesI, 'Voltage (V)', 'Current (A)');

    const seriesAngle = history.filter(h => h.voltage_angle_deg != null && h.current_angle_deg != null).map(h => ({
      time: computeFrameTimestamp(h), value: h.voltage_angle_deg - h.current_angle_deg
    }));
    if (el.modalChartAngle) SynchroChart.drawZeroCenteredSeries(el.modalChartAngle, seriesAngle, '°', '#7C3AED');

    const seriesRocof = history.filter(h => h.rocof_hz_per_s != null).map(h => ({
      time: computeFrameTimestamp(h), value: h.rocof_hz_per_s
    }));
    if (el.modalChartRocof) SynchroChart.drawZeroCenteredSeries(el.modalChartRocof, seriesRocof, 'Hz/s', '#DC2626');

    const seriesFreq = history.filter(h => h.frequency_hz != null).map(h => ({
      time: computeFrameTimestamp(h), value: h.frequency_hz
    }));
    if (el.modalChartFreq) SynchroChart.drawFrequency(el.modalChartFreq, seriesFreq);
  }

  // ---------------------------------------------------------------------------
  // Demo / Simulation Generator
  // ---------------------------------------------------------------------------
  function toggleSimulation() {
    state.isSimulating = !state.isSimulating;
    el.btnSim.classList.toggle('active', state.isSimulating);
    el.btnSim.querySelector('span').textContent = state.isSimulating ? 'Stop Demo' : 'Demo Feed';

    if (state.isSimulating) {
      logAlarm('info', 'Demo simulation feed activated.');
      let seq = 1000;
      state.simTimer = setInterval(() => {
        seq++;
        const now = Date.now();
        const soc = Math.floor(now / 1000);
        const fracUs = (now % 1000) * 1000;

        PMU_CONFIG.forEach((cfg, idx) => {
          const baseFreq = NOMINAL_HZ + (Math.sin(seq * 0.1 + idx) * 0.035) + ((Math.random() - 0.5) * 0.01);
          const vMag = 230.0 + Math.sin(seq * 0.05 + idx) * 3.5 + (Math.random() - 0.5);
          const iMag = 4.8 + Math.cos(seq * 0.08 + idx) * 0.5 + (Math.random() - 0.5) * 0.2;
          const vAngle = -2.0 + Math.sin(seq * 0.1) * 1.5 + idx * 8;
          const iAngle = vAngle - (15.0 + Math.sin(seq * 0.05) * 2.0);
          const phi = (vAngle - iAngle) * Math.PI / 180;
          const pKw   = (vMag * iMag * Math.cos(phi)) / 1000;
          const qKvar = (vMag * iMag * Math.sin(phi)) / 1000;
          const sKva  = (vMag * iMag) / 1000;
          const pf    = Math.cos(phi);

          handleNewReading({
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
            voltage_magnitude_v:  +vMag.toFixed(2),
            voltage_angle_deg:    +vAngle.toFixed(2),
            current_magnitude_a:  +iMag.toFixed(3),
            current_angle_deg:    +iAngle.toFixed(2),
            frequency_hz:         +baseFreq.toFixed(3),
            rocof_hz_per_s:       +(((Math.random() - 0.5) * 0.02).toFixed(3)),
            power_p_kw:           +pKw.toFixed(3),
            power_q_kvar:         +qKvar.toFixed(3),
            power_s_kva:          +sKva.toFixed(3),
            power_power_factor:   +pf.toFixed(3),
            status_data_valid:    true,
            status_pmu_ok:        true,
            status_test_mode:     false,
            status_gps_locked:    true,
            status_measurement_valid: true
          });
        });
      }, 1500);
    } else {
      if (state.simTimer) clearInterval(state.simTimer);
      logAlarm('info', 'Demo simulation feed stopped.');
    }
  }

  // ---------------------------------------------------------------------------
  // 1-second Staleness Monitor
  // ---------------------------------------------------------------------------
  function startStalenessMonitor() {
    setInterval(() => {
      Object.keys(state.pmus).forEach(id => {
        const pmu = state.pmus[id];
        const card = document.getElementById(`card-${id}`);
        if (!card) return;

        const ageSec = getFrameAgeSec(pmu.frameTimeMs);
        const isStale = ageSec > state.staleThresholdSec;

        card.classList.toggle('stale', isStale && !!pmu.latestFrame);

        const ageEl = card.querySelector('.val-age');
        if (ageEl) ageEl.textContent = pmu.latestFrame ? (ageSec === 0 ? 'Just now' : `${ageSec}s ago`) : 'No telemetry';

        const cardAgeEl = card.querySelector('.card-age');
        if (cardAgeEl) cardAgeEl.classList.toggle('stale', isStale);
      });

      renderSidebarIndex();
      updateAngleSepTable();
      updateStatusBar();
    }, 1000);
  }

  // ---------------------------------------------------------------------------
  // App Initialization
  // ---------------------------------------------------------------------------
  function init() {
    initTheme();
    startClock();
    renderSkeletons();
    renderSidebarIndex();

    el.staleSelect?.addEventListener('change', e => {
      state.staleThresholdSec = parseInt(e.target.value, 10) || 30;
    });

    el.backendSelect?.addEventListener('change', e => {
      state.serverUrl = resolveServerUrl(e.target.value);
      loadInitialData();
      initSocket();
    });

    el.btnSim?.addEventListener('click', toggleSimulation);

    el.modalClose?.addEventListener('click', closeModal);
    el.modal?.addEventListener('click', e => { if (e.target === el.modal) closeModal(); });
    el.modal?.addEventListener('cancel', closeModal);

    // Modal range pills
    el.modalRangePills?.querySelectorAll('.rpill').forEach(btn => {
      btn.addEventListener('click', () => {
        el.modalRangePills.querySelectorAll('.rpill').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.modalRange = btn.getAttribute('data-range');
        if (state.inspectedPmuId) fetchHistory(state.inspectedPmuId, state.modalRange);
      });
    });

    // Global frequency range pills
    el.globalFreqPills?.querySelectorAll('.rpill').forEach(btn => {
      btn.addEventListener('click', () => {
        el.globalFreqPills.querySelectorAll('.rpill').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.globalFreqRange = btn.getAttribute('data-range');
        Object.keys(state.pmus).forEach(id => fetchHistory(id, state.globalFreqRange));
      });
    });

    // Window resize handler
    window.addEventListener('resize', redrawAllCanvases);

    state.serverUrl = resolveServerUrl(el.backendSelect?.value || 'auto');
    loadInitialData();
    initSocket();
    startStalenessMonitor();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
