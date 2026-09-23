/**
 * Synchrophasor Canvas Charting Engine
 * High performance, zero dependency, Retina-crisp rendering
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
      // Empty state
      ctx.fillStyle = '#64748b';
      ctx.font = '11px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillText(options.emptyText || 'Awaiting frequency telemetry...', width / 2, height / 2);
      return;
    }

    // Determine Y range (centered around 50.00 Hz if near nominal)
    const vals = points.map(p => p.value);
    let minVal = Math.min(...vals);
    let maxVal = Math.max(...vals);

    // Ensure nominal 50 is in view with at least ±0.1 Hz margin
    minVal = Math.min(minVal, 49.90);
    maxVal = Math.max(maxVal, 50.10);
    const margin = (maxVal - minVal) * 0.1 || 0.05;
    minVal -= margin;
    maxVal += margin;

    const getY = (val) => padTop + plotH - ((val - minVal) / (maxVal - minVal)) * plotH;
    const getX = (idx) => padLeft + (idx / Math.max(1, points.length - 1)) * plotW;

    // Gridlines & Reference 50.00 Hz
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padLeft, padTop);
    ctx.lineTo(width - padRight, padTop);
    ctx.moveTo(padLeft, padTop + plotH);
    ctx.lineTo(width - padRight, padTop + plotH);
    ctx.stroke();

    // Nominal 50.00 Hz dashed guide
    const nominalY = getY(50.00);
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = 'rgba(6, 182, 212, 0.4)';
    ctx.beginPath();
    ctx.moveTo(padLeft, nominalY);
    ctx.lineTo(width - padRight, nominalY);
    ctx.stroke();
    ctx.restore();

    // Nominal label
    ctx.fillStyle = 'rgba(6, 182, 212, 0.7)';
    ctx.font = '9px "JetBrains Mono", monospace';
    ctx.textAlign = 'right';
    ctx.fillText('50.00', padLeft - 4, nominalY + 3);

    // Min & Max Y-labels
    ctx.fillStyle = '#64748b';
    ctx.fillText(maxVal.toFixed(2), padLeft - 4, padTop + 8);
    ctx.fillText(minVal.toFixed(2), padLeft - 4, padTop + plotH);

    // Gradient fill under curve
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

    // Current latest point dot
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

    const padTop = 16;
    const padBottom = 20;
    const padLeft = 45;
    const padRight = 45;
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

    const getYA = (v) => padTop + plotH - ((v - minA) / (maxA - minA || 1)) * plotH;
    const getYB = (v) => padTop + plotH - ((v - minB) / (maxB - minB || 1)) * plotH;
    const getX = (i, len) => padLeft + (i / Math.max(1, len - 1)) * plotW;

    // Gridlines
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 1;
    ctx.strokeRect(padLeft, padTop, plotW, plotH);

    // Left Y-axis (Series A - Voltage - Cyan)
    ctx.fillStyle = '#06b6d4';
    ctx.font = '9px "JetBrains Mono", monospace';
    ctx.textAlign = 'right';
    ctx.fillText(maxA.toFixed(1) + ' V', padLeft - 4, padTop + 8);
    ctx.fillText(minA.toFixed(1) + ' V', padLeft - 4, padTop + plotH);

    // Right Y-axis (Series B - Current - Amber)
    ctx.fillStyle = '#f59e0b';
    ctx.textAlign = 'left';
    ctx.fillText(maxB.toFixed(2) + ' A', width - padRight + 4, padTop + 8);
    ctx.fillText(minB.toFixed(2) + ' A', width - padRight + 4, padTop + plotH);

    // Draw Series A
    ctx.beginPath();
    ctx.moveTo(getX(0, seriesA.length), getYA(seriesA[0].value));
    for (let i = 1; i < seriesA.length; i++) {
      ctx.lineTo(getX(i, seriesA.length), getYA(seriesA[i].value));
    }
    ctx.strokeStyle = '#06b6d4';
    ctx.lineWidth = 1.75;
    ctx.stroke();

    // Draw Series B
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

    const padTop = 16;
    const padBottom = 20;
    const padLeft = 45;
    const padRight = 15;
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
    const minVal = -absMax;
    const maxVal = absMax;

    const getY = (v) => padTop + plotH - ((v - minVal) / (maxVal - minVal)) * plotH;
    const getX = (i) => padLeft + (i / Math.max(1, points.length - 1)) * plotW;

    // Zero guide line
    const zeroY = getY(0);
    ctx.save();
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
    ctx.beginPath();
    ctx.moveTo(padLeft, zeroY);
    ctx.lineTo(width - padRight, zeroY);
    ctx.stroke();
    ctx.restore();

    // Y Axis labels
    ctx.fillStyle = '#64748b';
    ctx.font = '9px "JetBrains Mono", monospace';
    ctx.textAlign = 'right';
    ctx.fillText('+' + absMax.toFixed(2) + ' ' + unit, padLeft - 4, padTop + 8);
    ctx.fillText('0.00 ' + unit, padLeft - 4, zeroY + 3);
    ctx.fillText('-' + absMax.toFixed(2) + ' ' + unit, padLeft - 4, padTop + plotH);

    // Plot line
    ctx.beginPath();
    ctx.moveTo(getX(0), getY(points[0].value));
    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(getX(i), getY(points[i].value));
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.75;
    ctx.stroke();
  }
}

window.SynchroChart = SynchroChart;
