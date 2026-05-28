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

export class PersonLabels {
  /**
   * @param {THREE.Scene} scene
   * @param {object} figurePool  Must expose activeAssignments(),
   *   getHeadWorldPosition(id, out), getPersonColor(id, out).
   */
  constructor(scene, figurePool) {
    this._scene = scene;
    this._pool = figurePool;
    this._labels = new Map();        // personId -> {object, divEl, letterEl, poseEl}
    this._letterFor = new Map();     // personId -> letter
    this._usedLetters = new Set();   // currently-assigned letters
    this._headScratch = new THREE.Vector3();
    this._colorScratch = new THREE.Color();
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
      if (typeof p.id === 'number') personById.set(p.id, p);
    }

    const seen = new Set();

    for (const [pid, fig] of this._pool.activeAssignments()) {
      // Skip slots that are reserved but currently hidden (figure between
      // frames); their label re-appears when the figure re-shows.
      if (!fig.visible) continue;

      seen.add(pid);
      let label = this._labels.get(pid);
      if (!label) {
        label = this._createLabel(pid);
        if (!label) continue; // all 4 letters in use (shouldn't happen given pool cap)
        this._labels.set(pid, label);
      }

      const pose = personById.get(pid)?.pose || 'standing';
      label.poseEl.textContent = POSE_LABELS[pose] || pose;

      const col = this._pool.getPersonColor(pid, this._colorScratch);
      const hex = '#' + col.getHexString();
      label.divEl.style.borderColor = hex;
      label.letterEl.style.color = hex;

      if (this._pool.getHeadWorldPosition(pid, this._headScratch)) {
        label.object.position.copy(this._headScratch);
        label.object.visible = true;
      } else {
        label.object.visible = false;
      }
    }

    // Drop labels for ids no longer assigned or no longer visible.
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

    divEl.appendChild(letterEl);
    divEl.appendChild(poseEl);

    const object = new CSS2DObject(divEl);
    this._scene.add(object);

    return { object, divEl, letterEl, poseEl };
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
