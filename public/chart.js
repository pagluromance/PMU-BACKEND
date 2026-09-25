/**
 * Synchrophasor Canvas Charting Engine
 * High performance, zero dependency, Retina-crisp rendering
 * Modern SaaS / Grafana engineering analytics aesthetic
 *
 * Includes:
 *  - SynchroChart.drawFrequency()          — frequency trend with 50 Hz nominal line
 *  - SynchroChart.drawDualSeries()         — V & I magnitudes on dual Y-axes
 *  - SynchroChart.drawZeroCenteredSeries() — ROCOF / angle delta centered at 0
 *  - SynchroChart.drawPhasor()             — IEEE C37.118 polar phasor diagram (V & I vectors)
 *  - SynchroChart.drawMultiFreq()          — global overlay of up to 4 PMU frequency series
 *  - SynchroChart.drawAngleSeparation()    — angle separation histories for B, C, D vs A
 */

class SynchroChart {
  /**
   * Returns palette based on current active theme (light or dark).
   */
  static getTheme() {
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    return {
      isDark,
      grid: isDark ? '#1F2937' : '#F1F5F9',
      border: isDark ? '#374151' : '#E2E8F0',
      text: isDark ? '#9CA3AF' : '#64748B',
      textMuted: isDark ? '#6B7280' : '#94A3B8',
      nominalLine: isDark ? 'rgba(96, 165, 250, 0.5)' : 'rgba(37, 99, 235, 0.45)',
      nominalText: isDark ? '#60A5FA' : '#2563EB',
      zeroLine: isDark ? 'rgba(255, 255, 255, 0.2)' : 'rgba(15, 23, 42, 0.15)',
      // Phasor
      phasorBg: isDark ? '#111827' : '#F8FAFC',
      phasorOuter: isDark ? '#374151' : '#CBD5E1',
      phasorGuides: isDark ? '#1F2937' : '#E2E8F0',
      phasorAxes: isDark ? '#374151' : '#E2E8F0',
      phasorText: isDark ? '#9CA3AF' : '#64748B',
      phasorV: isDark ? '#3B82F6' : '#2563EB',
      phasorI: isDark ? '#F59E0B' : '#D97706',
      phasorCenter: isDark ? '#E5E7EB' : '#475569',
      // Frequency line
      freqStroke: isDark ? '#3B82F6' : '#2563EB',
      freqGradientTop: isDark ? 'rgba(59, 130, 246, 0.2)' : 'rgba(37, 99, 235, 0.08)',
      freqGradientBottom: 'rgba(37, 99, 235, 0.0)',
    };
  }

  /**
   * Prepares a canvas for high-DPI crisp rendering.
   */
  static setupCanvas(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const width = rect.width || canvas.parentElement.clientWidth || 300;
    const height = rect.height || canvas.parentElement.clientHeight || 110;

    if (canvas.width !== Math.floor(width * dpr) || canvas.height !== Math.floor(height * dpr)) {
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
    }

    const ctx = canvas.getContext('2d');
    ctx.resetTransform?.();
    ctx.scale(dpr, dpr);
    return { ctx, width, height };
  }

  /**
   * Draws a clean, minimal IEEE C37.118 phasor polar diagram.
   * Voltage vector (blue) and Current vector (amber) plotted relative to 0° reference.
   *
   * @param {HTMLCanvasElement} canvas
   * @param {number} vMag   - Voltage magnitude (V RMS)
   * @param {number} vAngle - Voltage angle (degrees)
   * @param {number} iMag   - Current magnitude (A RMS)
   * @param {number} iAngle - Current angle (degrees)
   * @param {Object} options
   */
  static drawPhasor(canvas, vMag, vAngle, iMag, iAngle, options = {}) {
    const { ctx, width, height } = this.setupCanvas(canvas);
    const theme = this.getTheme();
    ctx.clearRect(0, 0, width, height);

    const cx = width / 2;
    const cy = height / 2;
    const radius = Math.min(cx, cy) * 0.80;

    // Subtle polar background
    ctx.fillStyle = theme.phasorBg;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fill();

    // Concentric guide rings (at 33% and 66% of radius)
    [0.33, 0.66].forEach(f => {
      ctx.strokeStyle = theme.phasorGuides;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.arc(cx, cy, radius * f, 0, Math.PI * 2);
      ctx.stroke();
    });
    ctx.setLineDash([]);

    // Outer circle
    ctx.strokeStyle = theme.phasorOuter;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.stroke();

    // Cardinal axes (crosshairs)
    ctx.strokeStyle = theme.phasorAxes;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx - radius, cy); ctx.lineTo(cx + radius, cy);
    ctx.moveTo(cx, cy - radius); ctx.lineTo(cx, cy + radius);
    ctx.stroke();

    // Cardinal angle labels (0°, 90°, 180°, 270°)
    ctx.fillStyle = theme.phasorText;
    ctx.font = '9px "Inter", -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('0°', cx + radius - 10, cy - 8);
    ctx.fillText('90°', cx, cy - radius + 9);
    ctx.fillText('180°', cx - radius + 14, cy - 8);
    ctx.fillText('270°', cx, cy + radius - 9);

    // If no data
    if (vMag == null && iMag == null) {
      ctx.fillStyle = theme.textMuted;
      ctx.font = '10px "Inter", -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Awaiting data', cx, cy);
      return;
    }

    // Helper to convert angle -> canvas coordinates (0°=right, CCW positive per IEEE 37.118)
    const toRad = deg => -deg * Math.PI / 180;

    // Normalize magnitudes for clean vector scale
    const vLen = radius * 0.88;
    const iLen = radius * 0.68;

    // Draw Voltage phasor (Solid blue)
    if (vMag != null && vAngle != null) {
      const vRad = toRad(vAngle);
      const vx = cx + vLen * Math.cos(vRad);
      const vy = cy + vLen * Math.sin(vRad);

      ctx.strokeStyle = theme.phasorV;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(vx, vy);
      ctx.stroke();

      // Sharp arrowhead
      this._arrowHead(ctx, cx, cy, vx, vy, theme.phasorV, 7);

      // Angle arc
      ctx.strokeStyle = theme.phasorV;
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.arc(cx, cy, radius * 0.22, 0, vRad < 0 ? vRad : -vRad, vAngle >= 0);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Draw Current phasor (Amber)
    if (iMag != null && iAngle != null) {
      const iRad = toRad(iAngle);
      const ix = cx + iLen * Math.cos(iRad);
      const iy = cy + iLen * Math.sin(iRad);

      ctx.strokeStyle = theme.phasorI;
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 2]);
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(ix, iy);
      ctx.stroke();
      ctx.setLineDash([]);

      this._arrowHead(ctx, cx, cy, ix, iy, theme.phasorI, 6);
    }

    // Center pivot dot
    ctx.fillStyle = theme.phasorCenter;
    ctx.beginPath();
    ctx.arc(cx, cy, 3, 0, Math.PI * 2);
    ctx.fill();

    // Delta phase annotation at bottom center
    if (vAngle != null && iAngle != null) {
      const delta = (vAngle - iAngle).toFixed(1);
      ctx.fillStyle = theme.text;
      ctx.font = '10px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(`Δθ = ${delta}°`, cx, cy + radius + 4);
    }
  }

  /**
   * Draws a clean arrowhead on a canvas context.
   */
  static _arrowHead(ctx, fromX, fromY, toX, toY, color, size) {
    const angle = Math.atan2(toY - fromY, toX - fromX);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(toX, toY);
    ctx.lineTo(
      toX - size * Math.cos(angle - Math.PI / 6),
      toY - size * Math.sin(angle - Math.PI / 6)
    );
    ctx.lineTo(
      toX - size * Math.cos(angle + Math.PI / 6),
      toY - size * Math.sin(angle + Math.PI / 6)
    );
    ctx.closePath();
    ctx.fill();
  }

  /**
   * Draws a frequency trend sparkline/chart with 50.00 Hz nominal reference.
   * @param {HTMLCanvasElement} canvas
   * @param {Array<{time: string|number, value: number}>} points
   * @param {Object} options
   */
  static drawFrequency(canvas, points, options = {}) {
    const { ctx, width, height } = this.setupCanvas(canvas);
    const theme = this.getTheme();
    ctx.clearRect(0, 0, width, height);

    const padTop = 10;
    const padBottom = 16;
    const padLeft = 40;
    const padRight = 10;
    const plotW = width - padLeft - padRight;
    const plotH = height - padTop - padBottom;

    if (!points || points.length === 0) {
      ctx.fillStyle = theme.textMuted;
      ctx.font = '11px "Inter", -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(options.emptyText || 'Awaiting telemetry...', width / 2, height / 2);
      return;
    }

    const vals = points.map(p => p.value);
    let minVal = Math.min(...vals);
    let maxVal = Math.max(...vals);

    minVal = Math.min(minVal, 49.92);
    maxVal = Math.max(maxVal, 50.08);
    const margin = (maxVal - minVal) * 0.12 || 0.04;
    minVal -= margin;
    maxVal += margin;

    const getY = val => padTop + plotH - ((val - minVal) / (maxVal - minVal)) * plotH;
    const getX = idx => padLeft + (idx / Math.max(1, points.length - 1)) * plotW;

    // Background horizontal grid lines
    ctx.strokeStyle = theme.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padLeft, padTop); ctx.lineTo(width - padRight, padTop);
    ctx.moveTo(padLeft, padTop + plotH); ctx.lineTo(width - padRight, padTop + plotH);
    ctx.stroke();

    // 50.00 Hz dashed nominal line
    const nominalY = getY(50.00);
    ctx.save();
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = theme.nominalLine;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padLeft, nominalY);
    ctx.lineTo(width - padRight, nominalY);
    ctx.stroke();
    ctx.restore();

    // Y-axis labels
    ctx.fillStyle = theme.nominalText;
    ctx.font = '9px "JetBrains Mono", monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText('50.00', padLeft - 4, nominalY);

    ctx.fillStyle = theme.textMuted;
    ctx.fillText(maxVal.toFixed(2), padLeft - 4, padTop + 4);
    ctx.fillText(minVal.toFixed(2), padLeft - 4, padTop + plotH - 2);

    // Subtle area fill
    const gradient = ctx.createLinearGradient(0, padTop, 0, padTop + plotH);
    gradient.addColorStop(0, theme.freqGradientTop);
    gradient.addColorStop(1, theme.freqGradientBottom);

    ctx.beginPath();
    ctx.moveTo(getX(0), getY(points[0].value));
    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(getX(i), getY(points[i].value));
    }
    ctx.lineTo(getX(points.length - 1), padTop + plotH);
    ctx.lineTo(getX(0), padTop + plotH);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();

    // Stroke line
    ctx.beginPath();
    ctx.moveTo(getX(0), getY(points[0].value));
    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(getX(i), getY(points[i].value));
    }
    ctx.strokeStyle = theme.freqStroke;
    ctx.lineWidth = 1.75;
    ctx.stroke();

    // Latest point dot
    const lastX = getX(points.length - 1);
    const lastY = getY(points[points.length - 1].value);
    ctx.fillStyle = theme.freqStroke;
    ctx.beginPath();
    ctx.arc(lastX, lastY, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = theme.isDark ? '#111827' : '#FFFFFF';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  /**
   * Draws a multi-series chart (Voltage & Current on dual axes).
   */
  static drawDualSeries(canvas, seriesA, seriesB, labelA, labelB) {
    const { ctx, width, height } = this.setupCanvas(canvas);
    const theme = this.getTheme();
    ctx.clearRect(0, 0, width, height);

    const padTop = 16, padBottom = 20, padLeft = 45, padRight = 45;
    const plotW = width - padLeft - padRight;
    const plotH = height - padTop - padBottom;

    if (!seriesA || seriesA.length === 0) {
      ctx.fillStyle = theme.textMuted;
      ctx.font = '11px "Inter", -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Awaiting waveform history...', width / 2, height / 2);
      return;
    }

    const valsA = seriesA.map(p => p.value);
    const minA = Math.min(...valsA) * 0.95;
    const maxA = Math.max(...valsA) * 1.05 || 1;

    const valsB = (seriesB && seriesB.length > 0) ? seriesB.map(p => p.value) : [0];
    const minB = Math.min(...valsB) * 0.95;
    const maxB = Math.max(...valsB) * 1.05 || 1;

    const getYA = v => padTop + plotH - ((v - minA) / (maxA - minA || 1)) * plotH;
    const getYB = v => padTop + plotH - ((v - minB) / (maxB - minB || 1)) * plotH;
    const getX = (i, len) => padLeft + (i / Math.max(1, len - 1)) * plotW;

    // Grid bounding box
    ctx.strokeStyle = theme.border;
    ctx.lineWidth = 1;
    ctx.strokeRect(padLeft, padTop, plotW, plotH);

    // Left Y-axis labels (Voltage in blue)
    ctx.fillStyle = theme.phasorV;
    ctx.font = '9px "JetBrains Mono", monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(maxA.toFixed(1) + ' V', padLeft - 4, padTop + 6);
    ctx.fillText(minA.toFixed(1) + ' V', padLeft - 4, padTop + plotH - 6);

    // Right Y-axis labels (Current in amber)
    ctx.fillStyle = theme.phasorI;
    ctx.textAlign = 'left';
    ctx.fillText(maxB.toFixed(2) + ' A', width - padRight + 4, padTop + 6);
    ctx.fillText(minB.toFixed(2) + ' A', width - padRight + 4, padTop + plotH - 6);

    // Draw Voltage series (A)
    ctx.beginPath();
    ctx.moveTo(getX(0, seriesA.length), getYA(seriesA[0].value));
    for (let i = 1; i < seriesA.length; i++) {
      ctx.lineTo(getX(i, seriesA.length), getYA(seriesA[i].value));
    }
    ctx.strokeStyle = theme.phasorV;
    ctx.lineWidth = 1.75;
    ctx.stroke();

    // Draw Current series (B)
    if (seriesB && seriesB.length > 0) {
      ctx.beginPath();
      ctx.moveTo(getX(0, seriesB.length), getYB(seriesB[0].value));
      for (let i = 1; i < seriesB.length; i++) {
        ctx.lineTo(getX(i, seriesB.length), getYB(seriesB[i].value));
      }
      ctx.strokeStyle = theme.phasorI;
      ctx.lineWidth = 1.75;
      ctx.stroke();
    }
  }

  /**
   * Draws a single series chart with a center zero-line (Angle Delta or ROCOF).
   */
  static drawZeroCenteredSeries(canvas, points, unit = '°', color = null) {
    const { ctx, width, height } = this.setupCanvas(canvas);
    const theme = this.getTheme();
    ctx.clearRect(0, 0, width, height);

    const seriesColor = color || (theme.isDark ? '#A78BFA' : '#7C3AED');
    const padTop = 16, padBottom = 20, padLeft = 45, padRight = 15;
    const plotW = width - padLeft - padRight;
    const plotH = height - padTop - padBottom;

    if (!points || points.length === 0) {
      ctx.fillStyle = theme.textMuted;
      ctx.font = '11px "Inter", -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Awaiting data series...', width / 2, height / 2);
      return;
    }

    const vals = points.map(p => p.value);
    const absMax = Math.max(...vals.map(Math.abs), 0.1) * 1.15;
    const minVal = -absMax, maxVal = absMax;

    const getY = v => padTop + plotH - ((v - minVal) / (maxVal - minVal)) * plotH;
    const getX = i => padLeft + (i / Math.max(1, points.length - 1)) * plotW;

    // Grid box
    ctx.strokeStyle = theme.border;
    ctx.lineWidth = 1;
    ctx.strokeRect(padLeft, padTop, plotW, plotH);

    // Center zero reference line
    const zeroY = getY(0);
    ctx.save();
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = theme.zeroLine;
    ctx.beginPath();
    ctx.moveTo(padLeft, zeroY); ctx.lineTo(width - padRight, zeroY);
    ctx.stroke();
    ctx.restore();

    // Labels
    ctx.fillStyle = theme.textMuted;
    ctx.font = '9px "JetBrains Mono", monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText('+' + absMax.toFixed(2) + ' ' + unit, padLeft - 4, padTop + 6);
    ctx.fillText('0.00 ' + unit, padLeft - 4, zeroY);
    ctx.fillText('-' + absMax.toFixed(2) + ' ' + unit, padLeft - 4, padTop + plotH - 6);

    ctx.beginPath();
    ctx.moveTo(getX(0), getY(points[0].value));
    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(getX(i), getY(points[i].value));
    }
    ctx.strokeStyle = seriesColor;
    ctx.lineWidth = 1.75;
    ctx.stroke();
  }

  /**
   * Draws global frequency overlay for up to 4 PMUs on one chart.
   * @param {HTMLCanvasElement} canvas
   * @param {Array<{points: Array, color: string, label: string}>} series
   */
  static drawMultiFreq(canvas, series) {
    const { ctx, width, height } = this.setupCanvas(canvas);
    const theme = this.getTheme();
    ctx.clearRect(0, 0, width, height);

    const padTop = 14, padBottom = 18, padLeft = 45, padRight = 12;
    const plotW = width - padLeft - padRight;
    const plotH = height - padTop - padBottom;

    const allPoints = series.flatMap(s => s.points || []);
    if (allPoints.length === 0) {
      ctx.fillStyle = theme.textMuted;
      ctx.font = '11px "Inter", -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Awaiting global frequency telemetry...', width / 2, height / 2);
      return;
    }

    const allVals = allPoints.map(p => p.value);
    let minVal = Math.min(...allVals, 49.92);
    let maxVal = Math.max(...allVals, 50.08);
    const margin = (maxVal - minVal) * 0.1 || 0.04;
    minVal -= margin; maxVal += margin;

    const getY = val => padTop + plotH - ((val - minVal) / (maxVal - minVal)) * plotH;

    // Subtle horizontal gridlines
    for (let i = 0; i <= 4; i++) {
      const y = padTop + (plotH / 4) * i;
      ctx.strokeStyle = theme.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padLeft, y); ctx.lineTo(width - padRight, y);
      ctx.stroke();

      const v = maxVal - ((maxVal - minVal) / 4) * i;
      ctx.fillStyle = theme.textMuted;
      ctx.font = '9px "JetBrains Mono", monospace';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(v.toFixed(3), padLeft - 4, y);
    }

    // 50.000 Hz reference line
    const nomY = getY(50.0);
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = theme.nominalLine;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padLeft, nomY); ctx.lineTo(width - padRight, nomY);
    ctx.stroke();
    ctx.restore();

    ctx.fillStyle = theme.nominalText;
    ctx.font = '9px "JetBrains Mono", monospace';
    ctx.textAlign = 'right';
    ctx.fillText('50.000', padLeft - 4, nomY);

    // Draw each PMU series
    series.forEach(s => {
      if (!s.points || s.points.length < 2) return;
      const pts = s.points;
      const len = pts.length;
      const getX = i => padLeft + (i / Math.max(1, len - 1)) * plotW;

      ctx.beginPath();
      ctx.moveTo(getX(0), getY(pts[0].value));
      for (let i = 1; i < len; i++) {
        ctx.lineTo(getX(i), getY(pts[i].value));
      }
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 1.75;
      ctx.stroke();
    });
  }

  /**
   * Draws angle separation histories (B, C, D relative to A).
   * @param {HTMLCanvasElement} canvas
   * @param {Array<{points: Array, color: string, label: string}>} series
   */
  static drawAngleSeparation(canvas, series) {
    const { ctx, width, height } = this.setupCanvas(canvas);
    const theme = this.getTheme();
    ctx.clearRect(0, 0, width, height);

    const padTop = 14, padBottom = 18, padLeft = 45, padRight = 12;
    const plotW = width - padLeft - padRight;
    const plotH = height - padTop - padBottom;

    const allPoints = series.flatMap(s => s.points || []);
    if (allPoints.length === 0) {
      ctx.fillStyle = theme.textMuted;
      ctx.font = '11px "Inter", -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Awaiting angle separation data...', width / 2, height / 2);
      return;
    }

    const allVals = allPoints.map(p => p.value);
    const absMax = Math.max(...allVals.map(Math.abs), 1) * 1.2;

    const getY = val => padTop + plotH / 2 - (val / absMax) * (plotH / 2);
    const zeroY = padTop + plotH / 2;

    // Horizontal grid
    for (let i = 0; i <= 4; i++) {
      const y = padTop + (plotH / 4) * i;
      ctx.strokeStyle = theme.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padLeft, y); ctx.lineTo(width - padRight, y);
      ctx.stroke();
    }

    // Zero reference line
    ctx.save();
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = theme.zeroLine;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padLeft, zeroY); ctx.lineTo(width - padRight, zeroY);
    ctx.stroke();
    ctx.restore();

    ctx.fillStyle = theme.textMuted;
    ctx.font = '9px "JetBrains Mono", monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText('+' + absMax.toFixed(1) + '°', padLeft - 4, padTop + 4);
    ctx.fillText('0°', padLeft - 4, zeroY);
    ctx.fillText('-' + absMax.toFixed(1) + '°', padLeft - 4, padTop + plotH - 4);

    series.forEach(s => {
      if (!s.points || s.points.length < 2) return;
      const pts = s.points;
      const len = pts.length;
      const getX = i => padLeft + (i / Math.max(1, len - 1)) * plotW;

      ctx.beginPath();
      ctx.moveTo(getX(0), getY(pts[0].value));
      for (let i = 1; i < len; i++) {
        ctx.lineTo(getX(i), getY(pts[i].value));
      }
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 1.75;
      ctx.stroke();
    });
  }
}

window.SynchroChart = SynchroChart;
