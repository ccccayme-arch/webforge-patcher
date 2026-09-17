// doctor.js — Device Doctor: client-side phone diagnostics
// All checks use native browser APIs. No dependencies.
import { Utils } from './utils.js';

export class DeviceDoctor {
  constructor() {
    this.refreshTimer = null;
    this.pixelColorIndex = 0;
    this.pixelColors = ['#ff0000', '#00ff00', '#0000ff', '#ffffff', '#000000'];
  }

  _el(id) { return document.getElementById(id); }

  bind() {
    const btnScan = this._el('btn-doc-scan');
    if (btnScan) btnScan.addEventListener('click', () => this.runScan());

    const btnTouch = this._el('btn-doc-touch');
    if (btnTouch) btnTouch.addEventListener('click', () => this.startTouchTest());

    const btnPixel = this._el('btn-doc-pixel');
    if (btnPixel) btnPixel.addEventListener('click', () => this.startPixelTest());

    const btnSpeaker = this._el('btn-doc-speaker');
    if (btnSpeaker) btnSpeaker.addEventListener('click', () => this.startSpeakerTest());

    const btnSensor = this._el('btn-doc-sensor');
    if (btnSensor) btnSensor.addEventListener('click', () => this.toggleSensorTest());
  }

  /* ---------- Full system scan ---------- */

  async runScan() {
    const out = this._el('doc-results');
    if (!out) return;
    out.innerHTML = '';
    Utils.log('Device Doctor: running full scan...');

    const rows = [];
    const add = (label, value, warn) => rows.push({ label, value, warn });

    // --- Battery ---
    try {
      if (navigator.getBattery) {
        const b = await navigator.getBattery();
        add('Battery', `${Math.round(b.level * 100)}%${b.charging ? ' (charging)' : ''}`,
          (!b.charging && b.level < 0.15) ? 'Low battery' : null);
        b.addEventListener('levelchange', () => {});
      } else {
        add('Battery', 'API unavailable in this browser');
      }
    } catch { add('Battery', 'Read failed'); }

    // --- Network ---
    const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (c) {
      add('Network type', c.effectiveType || 'unknown');
      if (c.downlink) add('Downlink estimate', `${c.downlink} Mbps`);
      if (c.rtt) add('Round-trip time', `${c.rtt} ms`);
      if (c.saveData) add('Data saver', 'ON', 'Data saver may limit downloads');
    } else {
      add('Network', 'API unavailable — online: ' + navigator.onLine);
    }
    add('Online', navigator.onLine ? 'Yes' : 'No', navigator.onLine ? null : 'No internet connection');

    // --- Storage ---
    try {
      if (navigator.storage?.estimate) {
        const { usage = 0, quota = 0 } = await navigator.storage.estimate();
        const pct = quota ? Math.round((usage / quota) * 100) : 0;
        add('Storage used (site)', `${Utils.formatBytes(usage)} of ${Utils.formatBytes(quota)} (${pct}%)`);
      }
    } catch { /* not supported */ }

    // --- Memory ---
    if (navigator.deviceMemory) add('Device RAM (approx)', `${navigator.deviceMemory} GB`);
    if (performance.memory) {
      const m = performance.memory;
      add('JS heap', `${Utils.formatBytes(m.usedJSHeapSize)} / ${Utils.formatBytes(m.jsHeapSizeLimit)}`);
    }

    // --- CPU / platform ---
    add('CPU cores', navigator.hardwareConcurrency ? `${navigator.hardwareConcurrency}` : 'unknown');
    add('Platform', navigator.userAgentData?.platform || navigator.platform || 'unknown');

    // --- GPU ---
    try {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
      if (gl) {
        const dbg = gl.getExtension('WEBGL_debug_renderer_info');
        const gpu = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
        add('GPU', String(gpu).slice(0, 60));
      }
    } catch { /* WebGL blocked */ }

    // --- Screen ---
    add('Screen', `${screen.width} × ${screen.height} @ ${window.devicePixelRatio}x`);
    add('Color depth', `${screen.colorDepth}-bit`);
    add('Viewport', `${window.innerWidth} × ${window.innerHeight}`);

    // --- Refresh rate (measured) ---
    const hz = await this.measureRefreshRate();
    if (hz) add('Refresh rate', `~${hz} Hz`);

    // --- PWA / standalone ---
    const standalone = matchMedia('(display-mode: standalone)').matches;
    add('Installed as PWA', standalone ? 'Yes' : 'No — browser tab');

    // --- WebUSB ---
    add('WebUSB', navigator.usb ? 'Available' : 'Unavailable', navigator.usb ? null : 'Flashing needs Chrome/Edge');

    // Render
    rows.forEach(r => {
      const row = document.createElement('div');
      row.className = 'doc-row';
      const label = document.createElement('span');
      label.className = 'doc-label';
      label.textContent = r.label;
      const value = document.createElement('span');
      value.className = 'doc-value' + (r.warn ? ' doc-warn' : '');
      value.textContent = r.value;
      row.append(label, value);
      out.appendChild(row);
      if (r.warn) {
        const w = document.createElement('div');
        w.className = 'warning';
        w.textContent = `⚠ ${r.warn}`;
        out.appendChild(w);
      }
    });
    Utils.log(`Device Doctor: scan complete (${rows.length} checks)`);
    this._el('doc-summary').textContent = `${rows.length} checks complete`;
  }

  async measureRefreshRate() {
    return new Promise(resolve => {
      let frames = 0;
      const t0 = performance.now();
      const tick = () => {
        frames++;
        if (performance.now() - t0 < 400) requestAnimationFrame(tick);
        else resolve(Math.round(frames / ((performance.now() - t0) / 1000)));
      };
      requestAnimationFrame(tick);
    });
  }

  /* ---------- Touch grid test ---------- */

  startTouchTest() {
    const overlay = this._el('doc-overlay');
    if (!overlay) return;
    const GRID = 12;
    overlay.innerHTML = '';
    overlay.classList.remove('hidden');

    const header = document.createElement('div');
    header.className = 'doc-test-header';
    header.textContent = 'Tap every square — they turn green when touched';

    const grid = document.createElement('div');
    grid.className = 'doc-touch-grid';
    let touched = 0, total = GRID * GRID;

    for (let i = 0; i < total; i++) {
      const cell = document.createElement('div');
      cell.className = 'doc-touch-cell';
      const mark = () => {
        if (!cell.classList.contains('touched')) {
          cell.classList.add('touched');
          touched++;
          header.textContent = `${touched} / ${total} squares touched`;
          if (touched === total) {
            header.textContent = '✓ All squares responded — touch is healthy';
            header.classList.add('doc-pass');
            setTimeout(() => overlay.classList.add('hidden'), 2000);
          }
        }
      };
      cell.addEventListener('touchstart', mark, { passive: true });
      cell.addEventListener('mousedown', mark);
      grid.appendChild(cell);
    }

    const close = document.createElement('button');
    close.className = 'btn btn-secondary';
    close.textContent = 'Exit test';
    close.addEventListener('click', () => {
      overlay.classList.add('hidden');
      overlay.innerHTML = '';
    });

    overlay.append(header, grid, close);
    Utils.log('Device Doctor: touch grid test started');
  }

  /* ---------- Dead pixel test ---------- */

  startPixelTest() {
    const overlay = this._el('doc-overlay');
    if (!overlay) return;
    overlay.innerHTML = '';
    overlay.classList.remove('hidden');

    const names = ['Red', 'Green', 'Blue', 'White', 'Black'];
    const hint = document.createElement('div');
    hint.className = 'doc-test-header';
    const paint = () => {
      overlay.style.background = this.pixelColors[this.pixelColorIndex];
      hint.textContent = `Tap to cycle: ${names[this.pixelColorIndex]} (${this.pixelColorIndex + 1}/${this.pixelColors.length}) — look for stuck pixels`;
    };
    paint();

    const close = document.createElement('button');
    close.className = 'btn btn-secondary';
    close.textContent = 'Exit test';
    close.addEventListener('click', e => {
      e.stopPropagation();
      overlay.style.background = '';
      overlay.classList.add('hidden');
      overlay.innerHTML = '';
      this.pixelColorIndex = 0;
    });

    overlay.append(hint, close);
    overlay.addEventListener('click', () => {
      this.pixelColorIndex = (this.pixelColorIndex + 1) % this.pixelColors.length;
      paint();
    });
    Utils.log('Device Doctor: dead pixel test started');
  }

  /* ---------- Speaker test ---------- */

  startSpeakerTest() {
    const btn = this._el('btn-doc-speaker');
    if (!btn) return;
    btn.disabled = true;
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const play = (freq, startAt, dur, pan) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        const panner = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
        osc.frequency.value = freq;
        osc.type = 'sine';
        gain.gain.setValueAtTime(0.0001, ctx.currentTime + startAt);
        gain.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + startAt + 0.05);
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + startAt + dur);
        osc.connect(gain);
        if (panner) { panner.pan.value = pan; gain.connect(panner); panner.connect(ctx.destination); }
        else gain.connect(ctx.destination);
        osc.start(ctx.currentTime + startAt);
        osc.stop(ctx.currentTime + startAt + dur + 0.05);
      };
      play(440, 0, 0.4, -1);      // left — A4
      play(660, 0.6, 0.4, 1);     // right — E5
      play(880, 1.2, 0.5, 0);     // center — A5
      setTimeout(() => { ctx.close(); btn.disabled = false; }, 2200);
      Utils.log('Device Doctor: speaker test — left tone, right tone, center tone');
      const out = this._el('doc-summary');
      if (out) out.textContent = 'Speaker test: low tone = left, high tone = right, final tone = both';
    } catch (err) {
      btn.disabled = false;
      Utils.log(`Speaker test failed: ${err.message}`, 'warn');
    }
  }

  /* ---------- Sensor test ---------- */

  toggleSensorTest() {
    const out = this._el('doc-results');
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
      const btn = this._el('btn-doc-sensor');
      if (btn) btn.textContent = 'Sensor Test';
      const head = this._el('doc-summary');
      if (head) head.textContent = 'Sensor test stopped';
      return;
    }
    const btn = this._el('btn-doc-sensor');
    if (btn) btn.textContent = 'Stop Sensors';

    const onOrient = (e) => {
      if (this.refreshTimer === null) { window.removeEventListener('deviceorientation', onOrient); return; }
      out.innerHTML = '';
      const rows = [
        ['Alpha (compass)', `${(e.alpha ?? 0).toFixed(1)}°`],
        ['Beta (tilt F/B)', `${(e.beta ?? 0).toFixed(1)}°`],
        ['Gamma (tilt L/R)', `${(e.gamma ?? 0).toFixed(1)}°`],
      ];
      rows.forEach(([label, value]) => {
        const row = document.createElement('div');
        row.className = 'doc-row';
        const l = document.createElement('span'); l.className = 'doc-label'; l.textContent = label;
        const v = document.createElement('span'); v.className = 'doc-value'; v.textContent = value;
        row.append(l, v); out.appendChild(row);
      });
      if (e.absolute === false) {
        const w = document.createElement('div');
        w.className = 'info-hint';
        w.textContent = 'Relative orientation only — no magnetometer reading';
        out.appendChild(w);
      }
    };

    window.addEventListener('deviceorientation', onOrient);
    // iOS requires permission
    if (typeof DeviceOrientationEvent !== 'undefined' && DeviceOrientationEvent.requestPermission) {
      DeviceOrientationEvent.requestPermission()
        .then(r => { if (r !== 'granted') { this.toggleSensorTest(); Utils.log('Sensor permission denied', 'warn'); } })
        .catch(() => this.toggleSensorTest());
    }
    Utils.log('Device Doctor: sensor test started — tilt your phone');
    const head = this._el('doc-summary');
    if (head) head.textContent = 'Move/tilt the phone — values should change';
  }
}
