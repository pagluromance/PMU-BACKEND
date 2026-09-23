/**
 * Synchrophasor Canvas Charting Engine
 * High performance, zero dependency, Retina-crisp rendering
 *
 * Includes:
 *  - SynchroChart.drawFrequency()      — frequency trend with 50 Hz nominal line
 *  - SynchroChart.drawDualSeries()     — V & I magnitudes on dual Y-axes
 *  - SynchroChart.drawZeroCenteredSeries() — ROCOF / angle delta centered at 0
 *  - SynchroChart.drawPhasor()         — IEEE C37.118 polar phasor diagram (V & I vectors)
 *  - SynchroChart.drawMultiFreq()      — global overlay of up to 4 PMU frequency series
 *  - SynchroChart.drawAngleSeparation()— angle separation histories for B, C, D vs A
 */

class SynchroChart {
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
   * Draws a IEEE C37.118 phasor polar diagram.
   * Voltage vector (cyan) and Current vector (amber) plotted relative to 0° reference.
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
    ctx.clearRect(0, 0, width, height);

    const cx = width / 2;
    const cy = height / 2;
    const radius = Math.min(cx, cy) * 0.82;

    // Background
    ctx.fillStyle = 'rgba(5, 10, 20, 0.8)';
    ctx.beginPath();
    ctx.arc(cx, cy, radius + 10, 0, Math.PI * 2);
    ctx.fill();

    // Outer ring
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.stroke();

    // Concentric guide rings (at 25%, 50%, 75% of radius)
    [0.25, 0.5, 0.75].forEach(f => {
      ctx.strokeStyle = '#1a2a42';
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.arc(cx, cy, radius * f, 0, Math.PI * 2);
      ctx.stroke();
    });

    // Crosshairs (cardinal axes)
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(cx - radius, cy); ctx.lineTo(cx + radius, cy);
    ctx.moveTo(cx, cy - radius); ctx.lineTo(cx, cy + radius);
    ctx.stroke();

    // Axis labels (0°, 90°, 180°, 270°)
    ctx.fillStyle = '#556f8a';
    ctx.font = `9px 'JetBrains Mono', monospace`;
    ctx.textAlign = 'center';
    ctx.fillText('0°',    cx + radius + 7, cy + 3);
    ctx.fillText('90°',   cx, cy - radius - 5);
    ctx.fillText('180°',  cx - radius - 9, cy + 3);
    ctx.fillText('270°',  cx, cy + radius + 9);

    // Helper to convert angle→canvas (0°=right, CCW positive per IEEE 37.118)
    const toRad = deg => -deg * Math.PI / 180;

    // Normalize magnitudes for display (phasor lengths)
    const maxMag = Math.max(vMag || 0, iMag || 0, 1);
    const vLen = (vMag / maxMag) * radius;
    const iLen = (iMag / maxMag) * radius;

    // Draw Voltage phasor (cyan)
    if (vMag != null && vAngle != null) {
      const vRad = toRad(vAngle);
      const vx = cx + vLen * Math.cos(vRad);
      const vy = cy + vLen * Math.sin(vRad);

      // Glow effect
      ctx.save();
      ctx.shadowColor = '#06b6d4';
      ctx.shadowBlur = 6;

      ctx.strokeStyle = '#06b6d4';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(vx, vy);
      ctx.stroke();

      // Arrowhead
      this._arrowHead(ctx, cx, cy, vx, vy, '#06b6d4', 7);

      // Angle arc
      ctx.strokeStyle = 'rgba(6, 182, 212, 0.3)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, radius * 0.18, 0, vRad < 0 ? vRad : -vRad, vAngle >= 0);
      ctx.stroke();

      ctx.restore();

      // Value label
      ctx.fillStyle = '#06b6d4';
      ctx.font = `bold 10px 'JetBrains Mono', monospace`;
      ctx.textAlign = vx > cx ? 'left' : 'right';
      ctx.fillText(`${vMag.toFixed(0)}V`, vx + (vx > cx ? 4 : -4), vy - 4);
    }

    // Draw Current phasor (amber)
    if (iMag != null && iAngle != null) {
      const iRad = toRad(iAngle);
      const ix = cx + iLen * Math.cos(iRad);
      const iy = cy + iLen * Math.sin(iRad);

      ctx.save();
      ctx.shadowColor = '#f59e0b';
      ctx.shadowBlur = 6;

      ctx.strokeStyle = '#f59e0b';
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 3]);
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(ix, iy);
      ctx.stroke();
      ctx.setLineDash([]);

      this._arrowHead(ctx, cx, cy, ix, iy, '#f59e0b', 7);
      ctx.restore();

      ctx.fillStyle = '#f59e0b';
      ctx.font = `bold 10px 'JetBrains Mono', monospace`;
      ctx.textAlign = ix > cx ? 'left' : 'right';
      ctx.fillText(`${iMag.toFixed(1)}A`, ix + (ix > cx ? 4 : -4), iy + 11);
    }

    // Center dot
    ctx.fillStyle = '#e8eef7';
    ctx.beginPath();
    ctx.arc(cx, cy, 3, 0, Math.PI * 2);
    ctx.fill();

    // Angle difference annotation
    if (vMag != null && iMag != null && vAngle != null && iAngle != null) {
      const delta = (vAngle - iAngle).toFixed(1);
      ctx.fillStyle = '#8ba4c0';
      ctx.font = `9px 'JetBrains Mono', monospace`;
      ctx.textAlign = 'center';
      ctx.fillText(`Δθ = ${delta}°`, cx, cy + radius + 16);
    }
  }

  /**
   * Draws an arrowhead on a canvas context.
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
   * Draws a frequency trend chart (nominal reference at 50.00 Hz).
   * @param {HTMLCanvasElement} canvas
   * @param {Array<{time: string|number, value: number}>} points
   * @param {Object} options
   */
  static drawFrequency(canvas, points, options = {}) {
    const { ctx, width, height } = this.setupCanvas(canvas);
    ctx.clearRect(0, 0, width, height);

    const padTop = 14;
    const padBottom = 18;
    const padLeft = 40;
    const padRight = 14;
    const plotW = width - padLeft - padRight;
    const plotH = height - padTop - padBottom;

    if (!points || points.length === 0) {
      ctx.fillStyle = '#64748b';
      ctx.font = '11px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillText(options.emptyText || 'Awaiting frequency telemetry...', width / 2, height / 2);
      return;
    }

    const vals = points.map(p => p.value);
    let minVal = Math.min(...vals);
    let maxVal = Math.max(...vals);

    minVal = Math.min(minVal, 49.90);
    maxVal = Math.max(maxVal, 50.10);
    const margin = (maxVal - minVal) * 0.1 || 0.05;
    minVal -= margin;
    maxVal += margin;

    const getY = val => padTop + plotH - ((val - minVal) / (maxVal - minVal)) * plotH;
    const getX = idx => padLeft + (idx / Math.max(1, points.length - 1)) * plotW;

    // Grid lines
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padLeft, padTop); ctx.lineTo(width - padRight, padTop);
    ctx.moveTo(padLeft, padTop + plotH); ctx.lineTo(width - padRight, padTop + plotH);
    ctx.stroke();

    // 50.00 Hz dashed nominal line
    const nominalY = getY(50.00);
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = 'rgba(6, 182, 212, 0.4)';
    ctx.beginPath();
    ctx.moveTo(padLeft, nominalY);
    ctx.lineTo(width - padRight, nominalY);
    ctx.stroke();
    ctx.restore();

    // Labels
    ctx.fillStyle = 'rgba(6, 182, 212, 0.7)';
    ctx.font = '9px "JetBrains Mono", monospace';
    ctx.textAlign = 'right';
    ctx.fillText('50.00', padLeft - 4, nominalY + 3);

    ctx.fillStyle = '#64748b';
    ctx.fillText(maxVal.toFixed(2), padLeft - 4, padTop + 8);
    ctx.fillText(minVal.toFixed(2), padLeft - 4, padTop + plotH);

    // Gradient fill
    const gradient = ctx.createLinearGradient(0, padTop, 0, padTop + plotH);
    gradient.addColorStop(0, 'rgba(6, 182, 212, 0.25)');
    gradient.addColorStop(1, 'rgba(6, 182, 212, 0.0)');

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
    ctx.strokeStyle = '#06b6d4';
    ctx.lineWidth = 1.75;
    ctx.stroke();

    // Latest point dot
    const lastX = getX(points.length - 1);
    const lastY = getY(points[points.length - 1].value);
    ctx.fillStyle = '#06b6d4';
    ctx.beginPath();
    ctx.arc(lastX, lastY, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  /**
   * Draws a multi-series chart (e.g. Voltage & Current on dual axes).
   */
  static drawDualSeries(canvas, seriesA, seriesB, labelA, labelB) {
    const { ctx, width, height } = this.setupCanvas(canvas);
    ctx.clearRect(0, 0, width, height);

    const padTop = 16, padBottom = 20, padLeft = 45, padRight = 45;
    const plotW = width - padLeft - padRight;
    const plotH = height - padTop - padBottom;

    if (!seriesA || seriesA.length === 0) {
      ctx.fillStyle = '#64748b';
      ctx.font = '11px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
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

    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 1;
    ctx.strokeRect(padLeft, padTop, plotW, plotH);

    ctx.fillStyle = '#06b6d4';
    ctx.font = '9px "JetBrains Mono", monospace';
    ctx.textAlign = 'right';
    ctx.fillText(maxA.toFixed(1) + ' V', padLeft - 4, padTop + 8);
    ctx.fillText(minA.toFixed(1) + ' V', padLeft - 4, padTop + plotH);

    ctx.fillStyle = '#f59e0b';
    ctx.textAlign = 'left';
    ctx.fillText(maxB.toFixed(2) + ' A', width - padRight + 4, padTop + 8);
    ctx.fillText(minB.toFixed(2) + ' A', width - padRight + 4, padTop + plotH);

    ctx.beginPath();
    ctx.moveTo(getX(0, seriesA.length), getYA(seriesA[0].value));
    for (let i = 1; i < seriesA.length; i++) {
      ctx.lineTo(getX(i, seriesA.length), getYA(seriesA[i].value));
    }
    ctx.strokeStyle = '#06b6d4';
    ctx.lineWidth = 1.75;
    ctx.stroke();

    if (seriesB && seriesB.length > 0) {
      ctx.beginPath();
      ctx.moveTo(getX(0, seriesB.length), getYB(seriesB[0].value));
      for (let i = 1; i < seriesB.length; i++) {
        ctx.lineTo(getX(i, seriesB.length), getYB(seriesB[i].value));
      }
      ctx.strokeStyle = '#f59e0b';
      ctx.lineWidth = 1.75;
      ctx.stroke();
    }
  }

  /**
   * Draws a single series chart with a center zero-line (Angle Delta or ROCOF).
   */
  static drawZeroCenteredSeries(canvas, points, unit = '°', color = '#8b5cf6') {
    const { ctx, width, height } = this.setupCanvas(canvas);
    ctx.clearRect(0, 0, width, height);

    const padTop = 16, padBottom = 20, padLeft = 45, padRight = 15;
    const plotW = width - padLeft - padRight;
    const plotH = height - padTop - padBottom;

    if (!points || points.length === 0) {
      ctx.fillStyle = '#64748b';
      ctx.font = '11px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillText('Awaiting data series...', width / 2, height / 2);
      return;
    }

    const vals = points.map(p => p.value);
    const absMax = Math.max(...vals.map(Math.abs), 0.1) * 1.15;
    const minVal = -absMax, maxVal = absMax;

    const getY = v => padTop + plotH - ((v - minVal) / (maxVal - minVal)) * plotH;
    const getX = i => padLeft + (i / Math.max(1, points.length - 1)) * plotW;

    const zeroY = getY(0);
    ctx.save();
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
    ctx.beginPath();
    ctx.moveTo(padLeft, zeroY); ctx.lineTo(width - padRight, zeroY);
    ctx.stroke();
    ctx.restore();

    ctx.fillStyle = '#64748b';
    ctx.font = '9px "JetBrains Mono", monospace';
    ctx.textAlign = 'right';
    ctx.fillText('+' + absMax.toFixed(2) + ' ' + unit, padLeft - 4, padTop + 8);
    ctx.fillText('0.00 ' + unit, padLeft - 4, zeroY + 3);
    ctx.fillText('-' + absMax.toFixed(2) + ' ' + unit, padLeft - 4, padTop + plotH);

    ctx.beginPath();
    ctx.moveTo(getX(0), getY(points[0].value));
    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(getX(i), getY(points[i].value));
    }
    ctx.strokeStyle = color;
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
    ctx.clearRect(0, 0, width, height);

    const padTop = 14, padBottom = 18, padLeft = 42, padRight = 10;
    const plotW = width - padLeft - padRight;
    const plotH = height - padTop - padBottom;

    const allPoints = series.flatMap(s => s.points || []);
    if (allPoints.length === 0) {
      ctx.fillStyle = '#556f8a';
      ctx.font = '11px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillText('Awaiting global frequency data...', width / 2, height / 2);
      return;
    }

    const allVals = allPoints.map(p => p.value);
    let minVal = Math.min(...allVals, 49.90);
    let maxVal = Math.max(...allVals, 50.10);
    const margin = (maxVal - minVal) * 0.1 || 0.05;
    minVal -= margin; maxVal += margin;

    const getY = val => padTop + plotH - ((val - minVal) / (maxVal - minVal)) * plotH;

    // Gridlines
    ctx.strokeStyle = '#1a2a42';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = padTop + (plotH / 4) * i;
      ctx.beginPath();
      ctx.moveTo(padLeft, y); ctx.lineTo(width - padRight, y);
      ctx.stroke();
      const v = maxVal - ((maxVal - minVal) / 4) * i;
      ctx.fillStyle = '#556f8a';
      ctx.font = '9px "JetBrains Mono", monospace';
      ctx.textAlign = 'right';
      ctx.fillText(v.toFixed(3), padLeft - 4, y + 3);
    }

    // 50 Hz reference
    const nomY = getY(50.0);
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = 'rgba(6, 182, 212, 0.5)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padLeft, nomY); ctx.lineTo(width - padRight, nomY);
    ctx.stroke();
    ctx.restore();
    ctx.fillStyle = 'rgba(6, 182, 212, 0.6)';
    ctx.font = '9px "JetBrains Mono", monospace';
    ctx.textAlign = 'right';
    ctx.fillText('50.000', padLeft - 4, nomY + 3);

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
      ctx.lineWidth = 1.5;
      ctx.stroke();
    });
  }

  /**
   * Draws angle separation histories (B, C, D relative to A).
   * @param {HTMLCanvasElement} canvas
   * @param {Array<{points: Array, color: string, label: string}>} series  — delta angle points
   */
  static drawAngleSeparation(canvas, series) {
    this.drawZeroCenteredSeries(
      canvas,
      [],  // let multi-series handle it below
      '°', '#f59e0b'
    );

    const { ctx, width, height } = this.setupCanvas(canvas);
    ctx.clearRect(0, 0, width, height);

    const padTop = 14, padBottom = 18, padLeft = 42, padRight = 10;
    const plotW = width - padLeft - padRight;
    const plotH = height - padTop - padBottom;

    const allPoints = series.flatMap(s => s.points || []);
    if (allPoints.length === 0) {
      ctx.fillStyle = '#556f8a';
      ctx.font = '11px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillText('Awaiting angle separation data...', width / 2, height / 2);
      return;
    }

    const allVals = allPoints.map(p => p.value);
    const absMax = Math.max(...allVals.map(Math.abs), 1) * 1.2;

    const getY = val => padTop + plotH / 2 - (val / absMax) * (plotH / 2);
    const zeroY = padTop + plotH / 2;

    // Grid
    ctx.strokeStyle = '#1a2a42';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const y = padTop + (plotH / 4) * i;
      ctx.beginPath();
      ctx.moveTo(padLeft, y); ctx.lineTo(width - padRight, y);
      ctx.stroke();
    }

    // Zero line
    ctx.save();
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padLeft, zeroY); ctx.lineTo(width - padRight, zeroY);
    ctx.stroke();
    ctx.restore();

    ctx.fillStyle = '#556f8a';
    ctx.font = '9px "JetBrains Mono", monospace';
    ctx.textAlign = 'right';
    ctx.fillText('+' + absMax.toFixed(1) + '°', padLeft - 4, padTop + 8);
    ctx.fillText('0°', padLeft - 4, zeroY + 3);
    ctx.fillText('-' + absMax.toFixed(1) + '°', padLeft - 4, padTop + plotH);

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
      ctx.lineWidth = 1.5;
      ctx.stroke();
    });
  }
}

window.SynchroChart = SynchroChart;
