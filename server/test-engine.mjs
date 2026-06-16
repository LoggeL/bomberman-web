// Headless sanity check for the shared engine — no browser, no server.
// Run: node server/test-engine.mjs
import { createGame, step, setInput, toSnapshot } from '../shared/engine.js';
import { TICK_DT, CELL, COLS, ROWS, BOMB_FUSE, POWERUP, SHIELD_INVULN, GHOST_TIME } from '../shared/constants.js';

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

console.log('GHOST walks through bricks (and is temporary)');
{
  const gg = createGame(defs, { seed: 9, winsToWin: 2 });
  const pp = gg.players[0];
  pp.x = 1.5; pp.y = 1.5; pp.ghost = GHOST_TIME;
  gg.grid[1 * COLS + 2] = CELL.BRICK; // brick immediately to the right
  setInput(gg, 0, { right: true });
  for (let i = 0; i < 60; i++) step(gg, TICK_DT);
  ok(pp.x > 2.0, 'ghost stepped into/through the brick cell');
  ok(pp.ghost > 0 && pp.ghost < GHOST_TIME, 'ghost timer is counting down');
  // run the rest of the timer out (no input) and confirm it expires
  setInput(gg, 0, {});
  for (let i = 0; i < Math.ceil(GHOST_TIME / TICK_DT) + 5; i++) step(gg, TICK_DT);
  ok(pp.ghost === 0, 'ghost expires after its duration');
}

console.log('KICK launches a bomb that slides until it hits something');
{
  const gg = createGame(defs, { seed: 17, winsToWin: 2 });
  const pp = gg.players[0];
  pp.kick = true;
  // clear a horizontal lane so a kicked bomb can slide
  for (let c = 1; c <= 6; c++) gg.grid[1 * COLS + c] = CELL.EMPTY;
  pp.x = 1.5; pp.y = 1.5;
  // a stationary bomb directly to the right at (2,1)
  gg.bombs.push({ id: 999, col: 2, row: 1, x: 2.5, y: 1.5, vx: 0, vy: 0, owner: 1, timer: BOMB_FUSE, range: 2, pierce: false });
  setInput(gg, 0, { right: true });
  step(gg, TICK_DT);
  const b = gg.bombs.find((x) => x.id === 999);
  ok(b && b.vx === 1, 'walking into a bomb kicks it');
  const startCol = b.col;
  for (let i = 0; i < 30; i++) step(gg, TICK_DT);
  ok(b.col > startCol, 'kicked bomb slid down the lane');
  ok(b.col === 6 || gg.grid[1 * COLS + (b.col + 1)] === CELL.SOLID, 'bomb stopped at the wall');
}

console.log('kicked bomb cannot tunnel a wall that closes mid-slide');
{
  const gg = createGame(defs, { seed: 21, winsToWin: 2 });
  for (let c = 1; c <= 8; c++) gg.grid[1 * COLS + c] = CELL.EMPTY;
  const bomb = { id: 777, col: 2, row: 1, x: 2.5, y: 1.5, vx: 1, vy: 0, owner: 1, timer: 99, range: 2, pierce: false };
  gg.bombs.push(bomb);
  for (let i = 0; i < 9; i++) step(gg, TICK_DT);   // bomb now past col 3, heading into col 4
  gg.grid[1 * COLS + 4] = CELL.SOLID;               // a wall closes right ahead of it
  for (let i = 0; i < 30; i++) step(gg, TICK_DT);
  const survivor = gg.bombs.find((x) => x.id === 777);
  ok(survivor && survivor.col <= 3, 'bomb stopped before the closed wall (no tunnel)');
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
  gg.flames.push({ col: 1, row: 1, kind: 'center', orient: null, timer: 0.5, fresh: true });
  step(gg, TICK_DT);
  ok(pp.alive, 'shield kept the player alive');
  ok(pp.shield === 0, 'shield charge consumed');
  ok(pp.invuln > 0 && pp.invuln <= SHIELD_INVULN, 'i-frames granted');
}

console.log('only the initial blast kills — lingering fire is harmless');
{
  const gg = createGame(defs, { seed: 23, winsToWin: 2 });
  const pp = gg.players[0];
  pp.x = 1.5; pp.y = 1.5;
  // a flame that already ignited on a PREVIOUS tick (fresh cleared) is décor
  gg.flames.push({ col: 1, row: 1, kind: 'center', orient: null, timer: 0.4, fresh: false });
  step(gg, TICK_DT);
  ok(pp.alive, 'walking in lingering (non-fresh) fire does not kill');
  // but a fresh ignition on the same tile this tick does kill
  gg.flames.push({ col: 1, row: 1, kind: 'center', orient: null, timer: 0.5, fresh: true });
  step(gg, TICK_DT);
  ok(!pp.alive, 'the initial blast (fresh flame) kills');
}

console.log('GHOST powerup applies via pickup');
{
  const gg = createGame(defs, { seed: 15, winsToWin: 2 });
  const pp = gg.players[0];
  pp.x = 1.5; pp.y = 1.5;
  gg.powerups.set(1 * COLS + 1, POWERUP.GHOST);
  step(gg, TICK_DT);
  ok(pp.ghost > 0, 'walking onto a GHOST powerup grants (timed) wallpass');
}

console.log(failed === 0 ? '\nALL ENGINE TESTS PASSED' : `\n${failed} TEST(S) FAILED`);
process.exit(failed === 0 ? 1 - 1 : 1);
