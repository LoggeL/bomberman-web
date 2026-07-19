// Headless checks for the browser's pure synchronization helpers.
// Run: node server/test-sync.mjs

import {
  advanceFixedPrediction,
  canPredictBomb,
  decayVisualCorrection,
  interpolateGridPlayer,
  isSnapshotDiscontinuity,
  needsPredictionRebase,
  rebaseWithVisualCorrection,
} from '../client/src/sync.js';
import { DEFAULT_ARENA_VISUAL, getArenaVisual } from '../client/src/arena-visuals.js';
import { findPickupEffects, getPickupEffect } from '../client/src/pickup-effects.js';
import { COLS, ROWS, CELL } from '../shared/constants.js';

let failed = 0;
const ok = (condition, message) => {
  if (condition) console.log('  ✓', message);
  else { failed++; console.error('  ✗', message); }
};

console.log('fixed-step prediction keeps slow frames');
{
  let accumulator = 0;
  let ticks = 0;
  for (let i = 0; i < 10; i++) {
    accumulator = advanceFixedPrediction(accumulator, 0.1, () => { ticks++; });
  }
  ok(ticks === 60, 'ten 100ms frames advance all sixty simulation ticks');
  ok(accumulator < 1e-8, 'fixed-step accumulator preserves no artificial drift');
}

console.log('snapshot boundaries are never interpolated');
ok(isSnapshotDiscontinuity({ round: 1, t: 12 }, { round: 2, t: 0 }),
  'round increment is a discontinuity');
ok(isSnapshotDiscontinuity({ round: 2, t: 12 }, { round: 2, t: 0 }),
  'clock rollback is a discontinuity');
ok(!isSnapshotDiscontinuity({ round: 2, t: 12 }, { round: 2, t: 12.04 }),
  'normal snapshots remain in the interpolation stream');

console.log('authoritative rebase is visually eased');
{
  const predicted = {
    x: 4.5, y: 2.5, dir: 'right', moving: false,
    speedPicks: 0, ghost: 0, stepping: false, tx: 4.5, ty: 2.5,
  };
  const authoritative = { ...predicted, x: 2.5, tx: 2.5 };
  const rebased = rebaseWithVisualCorrection(predicted, authoritative);
  ok(rebased.predicted.x === 2.5, 'collision state rebases to the exact server position');
  ok(rebased.predicted.x + rebased.correction.x === 4.5,
    'first rendered position is continuous instead of teleporting');
  const decayed = decayVisualCorrection(rebased.correction, 0.3);
  ok(Math.abs(decayed.x) < 0.07, 'render-only correction quickly converges to authority');
}

console.log('reconciliation distinguishes latency lead from divergence');
{
  const grid = new Array(COLS * ROWS).fill(CELL.EMPTY);
  const moving = {
    x: 4.5, y: 1.5, dir: 'right', moving: true, stepping: true,
    tx: 5.5, ty: 1.5,
  };
  const delayed = { ...moving, x: 2.5, tx: 3.5 };
  ok(!needsPredictionRebase(moving, delayed, grid),
    'same-lane motion is allowed to lead an old snapshot');
  ok(needsPredictionRebase(
    { ...moving, moving: false, stepping: false },
    { ...delayed, moving: false, stepping: false },
    grid,
  ), 'settled players at different cells are reconciled');
  grid[Math.floor(moving.y) * COLS + Math.floor(moving.x)] = CELL.SOLID;
  ok(needsPredictionRebase(moving, { ...moving, x: 4.0 }, grid),
    'a newly closed wall invalidates prediction immediately');
  ok(grid.length === COLS * ROWS, 'test grid matches the arena dimensions');
}

console.log('corner prediction stays on the routed grid path');
{
  const grid = new Array(COLS * ROWS).fill(CELL.EMPTY);
  const authoritative = {
    x: 4.2, y: 1.5, dir: 'right', moving: true, stepping: true,
    tx: 5.5, ty: 1.5,
  };
  const predicted = {
    x: 5.5, y: 2.35, dir: 'down', moving: true, stepping: true,
    tx: 5.5, ty: 2.5,
  };
  ok(!needsPredictionRebase(predicted, authoritative, grid),
    'a one-corner prediction lead is not mistaken for divergence');

  const wrongCorner = {
    ...predicted,
    x: 6.5, tx: 6.5,
  };
  ok(needsPredictionRebase(wrongCorner, authoritative, grid),
    'a perpendicular path from a different corner still rebases');

  const rebased = rebaseWithVisualCorrection(wrongCorner, authoritative);
  ok(rebased.correction.x !== 0 && rebased.correction.y === 0,
    'a real turn correction is projected onto the authoritative lane');

  const turned = {
    ...rebased.predicted,
    x: 5.5, y: 1.7, dir: 'down', stepping: true, tx: 5.5, ty: 2.5,
  };
  const afterTurn = decayVisualCorrection(rebased.correction, 0.01, turned);
  ok(afterTurn.x === 0 && afterTurn.y === 0,
    'old lane correction is cleared when prediction turns');
}

console.log('remote interpolation follows corners instead of cutting diagonally');
{
  const before = {
    x: 4.9, y: 1.5, dir: 'right', moving: true, stepping: true,
    tx: 5.5, ty: 1.5,
  };
  const after = {
    x: 5.5, y: 1.9, dir: 'down', moving: true, stepping: true,
    tx: 5.5, ty: 2.5,
  };
  const firstLeg = interpolateGridPlayer(before, after, 0.5);
  const secondLeg = interpolateGridPlayer(before, after, 0.8);
  ok(firstLeg.y === before.y && firstLeg.x > before.x,
    'first half of a turn remains on the incoming lane');
  ok(secondLeg.x === after.x && secondLeg.y > before.y,
    'second half continues from the corner on the outgoing lane');

  const straight = interpolateGridPlayer(
    { ...before, x: 2.5, tx: 3.5 },
    { ...before, x: 3.5, tx: 4.5 },
    0.25,
  );
  ok(straight.x === 2.75 && straight.y === 1.5,
    'straight-line interpolation remains linear');
}

console.log('predicted bombs respect the authoritative quota');
{
  const bombs = [{ owner: 0 }, { owner: 1 }];
  ok(!canPredictBomb(0, 1, bombs, []), 'full quota does not create a phantom bomb');
  ok(canPredictBomb(0, 2, bombs, []), 'free quota permits local bomb prediction');
  ok(!canPredictBomb(0, 2, bombs, [{}]), 'pending local bombs count toward the quota');
}

console.log('pickup effects identify the player and describe the ability');
{
  const previous = {
    powerups: [
      { col: 3, row: 2, kind: 4 },
      { col: 7, row: 7, kind: 2 },
    ],
  };
  const next = {
    powerups: [{ col: 7, row: 7, kind: 2 }],
    players: [
      { slot: 0, x: 3.5, y: 2.5, alive: true },
      { slot: 1, x: 9.5, y: 9.5, alive: true },
    ],
  };
  const effects = findPickupEffects(previous, next);
  ok(effects.length === 1 && effects[0].slot === 0 && effects[0].kind === 4,
    'a vanished power-up is assigned to the player on its cell');
  ok(effects[0].text === 'Wandlauf · 5s' && effects[0].color === '#b98cff',
    'the popup explains the timed ghost effect with its matching color');
  ok(getPickupEffect(6).text === 'Schild · 10s',
    'the shield popup explains its temporary protection window');
  ok(getPickupEffect(999).text === 'Power-up',
    'unknown future pickup kinds retain a safe fallback label');
}

console.log('arena visuals resolve snapshots and safely fall back');
{
  ok(getArenaVisual({ arena: { id: 'crossroads', theme: 'foundry' } }).id === 'foundry',
    'snapshot arena metadata selects the foundry presentation');
  ok(getArenaVisual({ id: 'citadel' }).id === 'frost',
    'arena ids resolve even when a theme is omitted');
  ok(getArenaVisual({ theme: 'reactor' }).id === 'reactor',
    'theme metadata selects the switchyard presentation');
  ok(getArenaVisual({ id: 'future-arena' }) === DEFAULT_ARENA_VISUAL,
    'unknown arenas keep the neon fallback');
}

console.log(failed === 0 ? '\nALL SYNC TESTS PASSED' : `\n${failed} SYNC TEST(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
