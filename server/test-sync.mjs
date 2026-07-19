// Headless checks for the browser's pure synchronization helpers.
// Run: node server/test-sync.mjs

import {
  advanceFixedPrediction,
  canPredictBomb,
  decayVisualCorrection,
  isSnapshotDiscontinuity,
  needsPredictionRebase,
  rebaseWithVisualCorrection,
} from '../client/src/sync.js';
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

console.log('predicted bombs respect the authoritative quota');
{
  const bombs = [{ owner: 0 }, { owner: 1 }];
  ok(!canPredictBomb(0, 1, bombs, []), 'full quota does not create a phantom bomb');
  ok(canPredictBomb(0, 2, bombs, []), 'free quota permits local bomb prediction');
  ok(!canPredictBomb(0, 2, bombs, [{}]), 'pending local bombs count toward the quota');
}

console.log(failed === 0 ? '\nALL SYNC TESTS PASSED' : `\n${failed} SYNC TEST(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
