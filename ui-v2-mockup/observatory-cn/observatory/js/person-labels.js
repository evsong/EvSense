/**
 * PersonLabels — A/B/C/D head labels for multi-person scenarios.
 *
 * Driven by the FigurePool's id-keyed assignments: each currently-visible
 * person gets a CSS2D overlay anchored above their nose joint, showing a
 * stable letter (A..D, assigned in first-seen order) and the Chinese pose
 * label. Border + letter color use the figure pool's per-id hash so the
 * overlay matches the particle cloud color.
 *
 * Letters are allocated lazily and released when the person's pool slot
 * is freed (after STALE_SECONDS without observation, per FigurePool GC),
 * so a track that briefly disappears keeps its letter when re-IDed.
 *
 * Vitals are intentionally NOT shown here — the WS payload's vital_signs
 * is global per frame, not per-person, so duplicating "HR 72" above every
 * head would mislead. Step 5 adds an over-the-head card only when
 * persons.length === 1.
 */
import * as THREE from 'three';
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

const LETTERS = ['A', 'B', 'C', 'D'];

const POSE_LABELS = {
  standing:   '站立',
  walking:    '行走',
  sitting:    '坐',
  lying:      '躺',
  fallen:     '⚠ 跌倒',
  falling:    '⚠ 跌倒中',
  exercising: '运动',
  gesturing:  '手势',
  crouching:  '蹲',
};

// Single-person sparkline buffer: ~10s of HR samples at one sample per
// SPARK_SAMPLE_INTERVAL_MS, drawn into a 80x20 SVG polyline.
const SPARK_CAPACITY = 40;
const SPARK_SAMPLE_INTERVAL_MS = 250;
const SPARK_WIDTH = 80;
const SPARK_HEIGHT = 20;

export class PersonLabels {
  /**
   * @param {THREE.Scene} scene
   * @param {object} figurePool  Must expose activeAssignments(),
   *   getHeadWorldPosition(id, out), getPersonColor(id, out).
   */
  constructor(scene, figurePool) {
    this._scene = scene;
    this._pool = figurePool;
    this._labels = new Map();        // personId -> {object, divEl, letterEl, poseEl, vitalsEl, hrEl, brEl, arousalEl, polyEl}
    this._letterFor = new Map();     // personId -> letter
    this._usedLetters = new Set();   // currently-assigned letters
    this._headScratch = new THREE.Vector3();
    this._colorScratch = new THREE.Color();
    // Sparkline state — single buffer that follows the currently-only
    // visible person. Reset on transition into/out of single-person mode.
    this._hrSeries = [];
    this._lastSparkSampleMs = 0;
    this._lastSparkOwner = null;
  }

  /**
   * Reconcile labels with the figure pool's current assignments and the
   * latest frame's per-person pose. Call once per animation frame.
   *
   * @param {object} data Sensing data frame ({persons: [...]})
   */
  sync(data) {
    const personById = new Map();
    for (const p of (data?.persons || [])) {
      if (p.id !== undefined && p.id !== null) personById.set(p.id, p);
    }
    const vitals = data?.vital_signs || null;

    // First pass: collect visible ids so we know if we're in single-person mode.
    const visible = [];
    for (const [pid, fig] of this._pool.activeAssignments()) {
      if (fig.visible) visible.push(pid);
    }
    const isSingle = visible.length === 1;
    const singleId = isSingle ? visible[0] : null;

    // Reset sparkline buffer if the single-person owner changed (or we
    // left/entered single-person mode). Otherwise the new person inherits
    // the prior person's curve, which is misleading.
    if (singleId !== this._lastSparkOwner) {
      this._hrSeries.length = 0;
      this._lastSparkSampleMs = 0;
      this._lastSparkOwner = singleId;
    }
    if (isSingle) this._maybeSampleHr(vitals);

    const seen = new Set();

    for (const [pid, fig] of this._pool.activeAssignments()) {
      if (!fig.visible) continue;

      seen.add(pid);
      let label = this._labels.get(pid);
      if (!label) {
        label = this._createLabel(pid);
        if (!label) continue;
        this._labels.set(pid, label);
      }

      const pose = personById.get(pid)?.pose || 'standing';
      label.poseEl.textContent = POSE_LABELS[pose] || pose;

      const col = this._pool.getPersonColor(pid, this._colorScratch);
      const hex = '#' + col.getHexString();
      label.divEl.style.borderColor = hex;
      label.letterEl.style.color = hex;

      // Single-person mode: this label gets the full HR/BR/arousal card
      // + sparkline. Multi-person: hide the card so the head label stays
      // small and unambiguous.
      if (isSingle && pid === singleId) {
        label.vitalsEl.style.display = 'flex';
        const hr = vitals?.heart_rate_bpm;
        const br = vitals?.breathing_rate_bpm;
        label.hrEl.textContent = (typeof hr === 'number' && hr > 0)
          ? Math.round(hr).toString() : '--';
        label.brEl.textContent = (typeof br === 'number' && br > 0)
          ? Math.round(br).toString() : '--';
        const ar = this._pool.getPersonArousal(pid);
        label.arousalEl.textContent = ar.toFixed(2);
        label.polyEl.setAttribute('stroke', hex);
        label.polyEl.setAttribute('points', this._sparkPoints());
      } else {
        label.vitalsEl.style.display = 'none';
      }

      if (this._pool.getHeadWorldPosition(pid, this._headScratch)) {
        label.object.position.copy(this._headScratch);
        label.object.visible = true;
      } else {
        label.object.visible = false;
      }
    }

    for (const [pid, label] of this._labels) {
      if (!seen.has(pid)) {
        this._scene.remove(label.object);
        label.divEl.remove();
        this._labels.delete(pid);
        const letter = this._letterFor.get(pid);
        if (letter) {
          this._usedLetters.delete(letter);
          this._letterFor.delete(pid);
        }
      }
    }
  }

  _maybeSampleHr(vitals) {
    const now = performance.now();
    if (now - this._lastSparkSampleMs < SPARK_SAMPLE_INTERVAL_MS) return;
    this._lastSparkSampleMs = now;
    const hr = vitals?.heart_rate_bpm;
    const sample = (typeof hr === 'number' && hr > 0) ? hr : null;
    this._hrSeries.push(sample);
    if (this._hrSeries.length > SPARK_CAPACITY) this._hrSeries.shift();
  }

  /** Build the SVG `points` attribute from the current HR ring buffer. */
  _sparkPoints() {
    const series = this._hrSeries;
    if (series.length < 2) return '';
    // Use a clinically reasonable HR window so the sparkline shape reads
    // as "varying around resting" rather than autoscaling each frame.
    const minHR = 50;
    const maxHR = 130;
    const dx = SPARK_WIDTH / (SPARK_CAPACITY - 1);
    const parts = [];
    for (let i = 0; i < series.length; i++) {
      const v = series[i];
      if (v == null) continue;
      const x = (i + (SPARK_CAPACITY - series.length)) * dx;
      const yNorm = (v - minHR) / (maxHR - minHR);
      const y = SPARK_HEIGHT - Math.max(0, Math.min(1, yNorm)) * SPARK_HEIGHT;
      parts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
    }
    return parts.join(' ');
  }

  _allocateLetter(pid) {
    let letter = this._letterFor.get(pid);
    if (letter) return letter;
    for (const L of LETTERS) {
      if (!this._usedLetters.has(L)) {
        this._usedLetters.add(L);
        this._letterFor.set(pid, L);
        return L;
      }
    }
    return null;
  }

  _createLabel(pid) {
    const letter = this._allocateLetter(pid);
    if (!letter) return null;

    const divEl = document.createElement('div');
    divEl.className = 'person-label';

    const letterEl = document.createElement('span');
    letterEl.className = 'person-label__letter';
    letterEl.textContent = letter;

    const poseEl = document.createElement('span');
    poseEl.className = 'person-label__pose';

    // Single-person vitals card. Hidden by default; sync() reveals it when
    // exactly one person is visible and updates HR/BR/arousal + sparkline.
    const vitalsEl = document.createElement('div');
    vitalsEl.className = 'person-label__vitals';

    const hrRow  = document.createElement('div'); hrRow.className  = 'person-label__row';
    const brRow  = document.createElement('div'); brRow.className  = 'person-label__row';
    const arRow  = document.createElement('div'); arRow.className  = 'person-label__row';

    hrRow.innerHTML = '<span>心率</span><b class="hr-num">--</b><span class="unit">BPM</span>';
    brRow.innerHTML = '<span>呼吸</span><b class="br-num">--</b><span class="unit">次/分</span>';
    arRow.innerHTML = '<span>激活度<sup class="experimental">实验</sup></span><b class="ar-num">--</b>';

    // 10s heart-rate sparkline.
    const sparkNs = 'http://www.w3.org/2000/svg';
    const sparkEl = document.createElementNS(sparkNs, 'svg');
    sparkEl.setAttribute('class', 'hr-sparkline');
    sparkEl.setAttribute('viewBox', `0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`);
    sparkEl.setAttribute('width', String(SPARK_WIDTH));
    sparkEl.setAttribute('height', String(SPARK_HEIGHT));
    const polyEl = document.createElementNS(sparkNs, 'polyline');
    polyEl.setAttribute('fill', 'none');
    polyEl.setAttribute('stroke', 'currentColor');
    polyEl.setAttribute('stroke-width', '1.4');
    polyEl.setAttribute('points', '');
    sparkEl.appendChild(polyEl);

    vitalsEl.appendChild(hrRow);
    vitalsEl.appendChild(brRow);
    vitalsEl.appendChild(arRow);
    vitalsEl.appendChild(sparkEl);

    divEl.appendChild(letterEl);
    divEl.appendChild(poseEl);
    divEl.appendChild(vitalsEl);

    const object = new CSS2DObject(divEl);
    this._scene.add(object);

    return {
      object, divEl, letterEl, poseEl, vitalsEl,
      hrEl: hrRow.querySelector('.hr-num'),
      brEl: brRow.querySelector('.br-num'),
      arousalEl: arRow.querySelector('.ar-num'),
      polyEl,
    };
  }

  dispose() {
    for (const [, label] of this._labels) {
      this._scene.remove(label.object);
      label.divEl.remove();
    }
    this._labels.clear();
    this._letterFor.clear();
    this._usedLetters.clear();
  }
}
