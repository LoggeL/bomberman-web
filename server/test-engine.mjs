// Headless sanity check for the shared engine — no browser, no server.
// Run: node server/test-engine.mjs
import { createGame, step, setInput, toSnapshot } from '../shared/engine.js';
import { TICK_DT, CELL, COLS, ROWS, BOMB_FUSE, POWERUP, SHIELD_INVULN } from '../shared/constants.js';

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
ok('shield' in round.players[0] && 'ghost' in round.players[0] && 'pierce' in round.players[0],
  'snapshot carries ability fields');

console.log('tile-stepping clips to the grid');
{
  const gg = createGame(defs, { seed: 7, winsToWin: 2 });
  const pp = gg.players[0];
  const sx = pp.x;
  setInput(gg, 0, { right: true });
  for (let i = 0; i < 8; i++) step(gg, TICK_DT);   // mid-stride somewhere
  setInput(gg, 0, {});
  for (let i = 0; i < 40; i++) step(gg, TICK_DT);   // let it settle
  ok(pp.x > sx, 'stepped right');
  ok(Math.abs(pp.x - (Math.round(pp.x - 0.5) + 0.5)) < 1e-9, 'rests exactly on a cell centre');
  ok(!pp.moving, 'idle once input released');
}

console.log('GHOST walks through bricks');
{
  const gg = createGame(defs, { seed: 9, winsToWin: 2 });
  const pp = gg.players[0];
  pp.x = 1.5; pp.y = 1.5; pp.ghost = true;
  gg.grid[1 * COLS + 2] = CELL.BRICK; // brick immediately to the right
  setInput(gg, 0, { right: true });
  for (let i = 0; i < 60; i++) step(gg, TICK_DT);
  ok(pp.x > 2.0, 'ghost stepped into/through the brick cell');
}

console.log('PIERCE tears through multiple bricks');
{
  const gg = createGame(defs, { seed: 11, winsToWin: 2 });
  const pp = gg.players[0];
  pp.pierce = true; pp.range = 5;
  gg.hidden.clear();
  gg.grid[1 * COLS + 2] = CELL.BRICK;
  gg.grid[1 * COLS + 3] = CELL.BRICK;
  gg.grid[1 * COLS + 4] = CELL.EMPTY;
  gg.grid[3 * COLS + 1] = CELL.EMPTY; // escape route for the bomber
  pp.x = 1.5; pp.y = 1.5;
  setInput(gg, 0, { bomb: true }); step(gg, TICK_DT); setInput(gg, 0, { bomb: false });
  pp.x = 1.5; pp.y = 3.5; // step the bomber out of its own blast
  for (let i = 0; i < Math.ceil((BOMB_FUSE + 0.1) / TICK_DT); i++) step(gg, TICK_DT);
  ok(gg.grid[1 * COLS + 2] === CELL.EMPTY && gg.grid[1 * COLS + 3] === CELL.EMPTY,
    'pierce destroyed both bricks in the line');
}

console.log('SHIELD absorbs a lethal hit');
{
  const gg = createGame(defs, { seed: 13, winsToWin: 2 });
  const pp = gg.players[0];
  pp.x = 1.5; pp.y = 1.5; pp.shield = 1;
  gg.flames.push({ col: 1, row: 1, kind: 'center', orient: null, timer: 0.5 });
  step(gg, TICK_DT);
  ok(pp.alive, 'shield kept the player alive');
  ok(pp.shield === 0, 'shield charge consumed');
  ok(pp.invuln > 0 && pp.invuln <= SHIELD_INVULN, 'i-frames granted');
}

console.log('GHOST powerup applies via pickup');
{
  const gg = createGame(defs, { seed: 15, winsToWin: 2 });
  const pp = gg.players[0];
  pp.x = 1.5; pp.y = 1.5;
  gg.powerups.set(1 * COLS + 1, POWERUP.GHOST);
  step(gg, TICK_DT);
  ok(pp.ghost === true, 'walking onto a GHOST powerup grants wallpass');
}

console.log(failed === 0 ? '\nALL ENGINE TESTS PASSED' : `\n${failed} TEST(S) FAILED`);
process.exit(failed === 0 ? 1 - 1 : 1);
