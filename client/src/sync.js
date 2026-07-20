// Pure helpers for online client synchronization. Keeping the timing and
// reconciliation policy DOM-free makes the tricky low-FPS/jitter cases easy to
// exercise from Node tests as well as from the browser.

import { CELL, COLS, TICK_DT } from '../../shared/constants.js';

const MAX_FRAME_BACKLOG = 0.25;
const CORRECTION_HALF_LIFE = 0.06;
const LANE_EPSILON = 0.08;

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
    alive: player.alive !== false,
    dir: player.dir,
    moving: player.moving,
    speedPicks: player.speedPicks,
    ghost: player.ghost,
    stepping: !!player.stepping,
    tx: Number.isFinite(player.tx) ? player.tx : player.x,
    ty: Number.isFinite(player.ty) ? player.ty : player.y,
  };
}

function movementAxis(player) {
  if (!player) return null;
  if (player.stepping) {
    const dx = Math.abs((player.tx ?? player.x) - player.x);
    const dy = Math.abs((player.ty ?? player.y) - player.y);
    if (dx > LANE_EPSILON && dy < LANE_EPSILON) return 'x';
    if (dy > LANE_EPSILON && dx < LANE_EPSILON) return 'y';
  }
  if (player.moving) {
    if (player.dir === 'left' || player.dir === 'right') return 'x';
    if (player.dir === 'up' || player.dir === 'down') return 'y';
  }
  return null;
}

function stepVector(player) {
  if (!player?.stepping) return null;
  const dx = Math.sign((player.tx ?? player.x) - player.x);
  const dy = Math.sign((player.ty ?? player.y) - player.y);
  if (Math.abs(dx) + Math.abs(dy) !== 1) return null;
  return { dx, dy };
}

function axisFromDir(dir) {
  if (dir === 'left' || dir === 'right') return 'x';
  if (dir === 'up' || dir === 'down') return 'y';
  return null;
}

// A predicted player may legitimately be one turn ahead of an RTT-old server
// snapshot: authority is still approaching the corner while prediction has
// already left that exact corner on the perpendicular lane. Treat that as the
// same route, not as a diagonal divergence that needs correction.
function isCompatibleCornerLead(predicted, authoritative) {
  const before = stepVector(authoritative);
  const after = stepVector(predicted);
  if (!before || !after || before.dx * after.dx + before.dy * after.dy !== 0) return false;

  const cornerX = authoritative.tx;
  const cornerY = authoritative.ty;
  const predictedOriginX = predicted.tx - after.dx;
  const predictedOriginY = predicted.ty - after.dy;
  return Math.abs(cornerX - predictedOriginX) < LANE_EPSILON &&
    Math.abs(cornerY - predictedOriginY) < LANE_EPSILON;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

// Interpolate snapshots along the same orthogonal route used by the engine.
// A plain x/y lerp cuts diagonally across the inside of a turn whenever two
// snapshots land on different legs of the corner.
export function interpolateGridPlayer(previous, next, amount) {
  if ((previous.teleportSeq || 0) !== (next.teleportSeq || 0)) {
    return { x: next.x, y: next.y, dir: next.dir, moving: next.moving };
  }
  const t = Math.max(0, Math.min(1, Number.isFinite(amount) ? amount : 1));
  const dx = next.x - previous.x;
  const dy = next.y - previous.y;
  if (Math.abs(dx) < LANE_EPSILON || Math.abs(dy) < LANE_EPSILON) {
    return {
      x: lerp(previous.x, next.x, t),
      y: lerp(previous.y, next.y, t),
      dir: next.dir,
      moving: next.moving,
    };
  }

  // Prefer the first snapshot's live movement axis. If it landed exactly on
  // the corner, its facing direction still identifies the first leg.
  const firstAxis = movementAxis(previous) || axisFromDir(previous.dir);
  const secondAxis = movementAxis(next) || axisFromDir(next.dir);
  const horizontalFirst = firstAxis === 'x' || (firstAxis === null && secondAxis === 'y');
  const corner = horizontalFirst
    ? { x: next.x, y: previous.y }
    : { x: previous.x, y: next.y };
  const firstLength = Math.abs(corner.x - previous.x) + Math.abs(corner.y - previous.y);
  const secondLength = Math.abs(next.x - corner.x) + Math.abs(next.y - corner.y);
  const totalLength = firstLength + secondLength;
  if (totalLength < 1e-9) {
    return { x: next.x, y: next.y, dir: next.dir, moving: next.moving };
  }

  const travelled = t * totalLength;
  if (travelled <= firstLength && firstLength > 0) {
    const legT = travelled / firstLength;
    return {
      x: lerp(previous.x, corner.x, legT),
      y: lerp(previous.y, corner.y, legT),
      dir: previous.dir,
      moving: previous.moving || next.moving,
    };
  }
  const legT = secondLength > 0 ? (travelled - firstLength) / secondLength : 1;
  return {
    x: lerp(corner.x, next.x, legT),
    y: lerp(corner.y, next.y, legT),
    dir: next.dir,
    moving: previous.moving || next.moving,
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

  const sameLane = Math.abs(dx) < LANE_EPSILON || Math.abs(dy) < LANE_EPSILON;
  const samePath = sameLane && predicted.dir === authoritative.dir;
  return distance > 1.25 && !samePath && !isCompatibleCornerLead(predicted, authoritative);
}

// Rebase simulation exactly to authority while retaining the old rendered
// position as a temporary offset on the authoritative lane. Never retain both
// axes: a two-axis correction cuts diagonally through a corner/wall.
export function rebaseWithVisualCorrection(predicted, authoritative, correction = { x: 0, y: 0 }) {
  const oldRenderX = predicted.x + correction.x;
  const oldRenderY = predicted.y + correction.y;
  const next = predictionFromSnapshot(authoritative);
  let x = oldRenderX - next.x;
  let y = oldRenderY - next.y;
  const axis = movementAxis(next);
  if (axis === 'x') y = 0;
  else if (axis === 'y') x = 0;
  else if (Math.abs(y) < LANE_EPSILON) y = 0;
  else if (Math.abs(x) < LANE_EPSILON) x = 0;
  else { x = 0; y = 0; }
  return {
    predicted: next,
    correction: { x, y },
  };
}

export function decayVisualCorrection(correction, frameDt, predicted = null) {
  const factor = Math.pow(0.5, Math.max(frameDt, 0) / CORRECTION_HALF_LIFE);
  let x = Math.abs(correction.x * factor) < 0.001 ? 0 : correction.x * factor;
  let y = Math.abs(correction.y * factor) < 0.001 ? 0 : correction.y * factor;
  // Drop a residual same-lane offset as soon as prediction turns onto the
  // perpendicular lane; otherwise movement plus decay would again look diagonal.
  const axis = movementAxis(predicted);
  if (axis === 'x') y = 0;
  else if (axis === 'y') x = 0;
  return { x, y };
}

export function canPredictBomb(slot, maxBombs, authoritativeBombs, pendingBombs) {
  const active = authoritativeBombs.filter((bomb) => bomb.owner === slot).length;
  return active + pendingBombs.length < maxBombs;
}
