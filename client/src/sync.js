// Pure helpers for online client synchronization. Keeping the timing and
// reconciliation policy DOM-free makes the tricky low-FPS/jitter cases easy to
// exercise from Node tests as well as from the browser.

import { CELL, COLS, TICK_DT } from '../../shared/constants.js';

const MAX_FRAME_BACKLOG = 0.25;
const CORRECTION_HALF_LIFE = 0.06;

export function advanceFixedPrediction(accumulator, frameDt, tick) {
  let next = accumulator + Math.min(Math.max(frameDt, 0), MAX_FRAME_BACKLOG);
  let steps = 0;
  while (next + 1e-9 >= TICK_DT && steps < 30) {
    tick(TICK_DT);
    next -= TICK_DT;
    steps++;
  }
  return Math.max(0, next);
}

export function isSnapshotDiscontinuity(previous, next) {
  if (!previous || !next) return false;
  return next.round !== previous.round || next.t + TICK_DT < previous.t;
}

export function predictionFromSnapshot(player) {
  return {
    x: player.x,
    y: player.y,
    dir: player.dir,
    moving: player.moving,
    speedPicks: player.speedPicks,
    ghost: player.ghost,
    stepping: !!player.stepping,
    tx: Number.isFinite(player.tx) ? player.tx : player.x,
    ty: Number.isFinite(player.ty) ? player.ty : player.y,
  };
}

// Decide whether a discrepancy is real rather than the normal lead between a
// predicted player and an RTT-old snapshot. Active motion on the same lane is
// deliberately left alone. We rebase when authority invalidates the predicted
// cell, both simulations have settled at different cells, or paths have clearly
// diverged at a turn.
export function needsPredictionRebase(predicted, authoritative, grid) {
  if (!predicted || !authoritative) return false;

  const dx = authoritative.x - predicted.x;
  const dy = authoritative.y - predicted.y;
  const distance = Math.hypot(dx, dy);
  if (distance < 0.12) return false;

  const col = Math.floor(predicted.x);
  const row = Math.floor(predicted.y);
  const cell = col >= 0 && col < COLS && row >= 0 && row * COLS + col < grid.length
    ? grid[row * COLS + col]
    : CELL.SOLID;
  if (cell === CELL.SOLID) return true;

  const bothSettled = !predicted.stepping && !authoritative.stepping &&
    !predicted.moving && !authoritative.moving;
  if (bothSettled) return true;

  const sameLane = Math.abs(dx) < 0.08 || Math.abs(dy) < 0.08;
  const samePath = sameLane && predicted.dir === authoritative.dir;
  return distance > 1.25 && !samePath;
}

// Rebase simulation exactly to authority while retaining the old rendered
// position as a temporary offset. The next frames decay that offset, turning a
// correction into a short glide instead of a visible teleport.
export function rebaseWithVisualCorrection(predicted, authoritative, correction = { x: 0, y: 0 }) {
  const oldRenderX = predicted.x + correction.x;
  const oldRenderY = predicted.y + correction.y;
  const next = predictionFromSnapshot(authoritative);
  return {
    predicted: next,
    correction: {
      x: oldRenderX - next.x,
      y: oldRenderY - next.y,
    },
  };
}

export function decayVisualCorrection(correction, frameDt) {
  const factor = Math.pow(0.5, Math.max(frameDt, 0) / CORRECTION_HALF_LIFE);
  const x = Math.abs(correction.x * factor) < 0.001 ? 0 : correction.x * factor;
  const y = Math.abs(correction.y * factor) < 0.001 ? 0 : correction.y * factor;
  return { x, y };
}

export function canPredictBomb(slot, maxBombs, authoritativeBombs, pendingBombs) {
  const active = authoritativeBombs.filter((bomb) => bomb.owner === slot).length;
  return active + pendingBombs.length < maxBombs;
}
