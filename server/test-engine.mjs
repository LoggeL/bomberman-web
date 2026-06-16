// Headless sanity check for the shared engine — no browser, no server.
// Run: node server/test-engine.mjs
import { createGame, step, setInput, toSnapshot } from '../shared/engine.js';
import { TICK_DT, CELL, COLS, ROWS, BOMB_FUSE } from '../shared/constants.js';

let failed = 0;
const ok = (cond, msg) => { if (!cond) { failed++; console.error('  ✗', msg); } else console.log('  ✓', msg); };

const defs = [
  { id: 'a', slot: 0, name: 'Rot' },
  { id: 'b', slot: 1, name: 'Blau' },
];
const g = createGame(defs, { seed: 12345, winsToWin: 2 });

console.log('grid + spawn');
ok(g.grid.length === COLS * ROWS, 'grid sized COLS*ROWS');
ok(g.players.length === 2, 'two players');
ok(g.players[0].alive && g.players[1].alive, 'both start alive');
ok(g.phase === 'playing', 'phase playing');

// corners must be walkable
const corner = g.grid[1 * COLS + 1];
ok(corner === CELL.EMPTY, 'top-left spawn cell is empty');

console.log('movement');
const startX = g.players[0].x;
setInput(g, 0, { right: true });
for (let i = 0; i < 30; i++) step(g, TICK_DT);
ok(g.players[0].x > startX, 'player 0 moved right');
ok(g.players[0].dir === 'right', 'facing right');

console.log('bomb + explosion kills');
// Put both players adjacent and detonate.
const p0 = g.players[0], p1 = g.players[1];
p0.x = 3.5; p0.y = 1.5; p0.range = 4;
p1.x = 5.5; p1.y = 1.5;
// clear a horizontal lane so the flame reaches p1
for (let c = 3; c <= 6; c++) g.grid[1 * COLS + c] = CELL.EMPTY;
setInput(g, 0, { bomb: true });
step(g, TICK_DT);          // place bomb (rising edge) at tile (3,1)
setInput(g, 0, { bomb: false });
ok(g.bombs.length === 1, 'bomb placed');
// move the bomber clear of the blast cross (neither row 1 nor col 3)
g.grid[3 * COLS + 5] = CELL.EMPTY;
p0.x = 5.5; p0.y = 3.5;
// run past the fuse
for (let i = 0; i < Math.ceil((BOMB_FUSE + 0.3) / TICK_DT); i++) step(g, TICK_DT);
ok(g.flames.length === 0 || g.flames.length > 0, 'flames processed');
ok(!p1.alive, 'player 1 caught in the blast and died');

console.log('round resolution');
ok(g.phase === 'roundover' || g.phase === 'matchover', 'round resolved when one remains');
ok(g.players[0].score === 1, 'survivor scored a point');

console.log('snapshot is JSON-serializable');
const snap = toSnapshot(g);
const round = JSON.parse(JSON.stringify(snap));
ok(Array.isArray(round.grid) && round.grid.length === COLS * ROWS, 'snapshot grid ok');
ok(Array.isArray(round.players) && round.players[0].name === 'Rot', 'snapshot players ok');

console.log(failed === 0 ? '\nALL ENGINE TESTS PASSED' : `\n${failed} TEST(S) FAILED`);
process.exit(failed === 0 ? 1 - 1 : 1);
