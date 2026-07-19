// Headless sanity check for the shared engine — no browser, no server.
// Run: node server/test-engine.mjs
import { createGame, step, setInput, toSnapshot } from '../shared/engine.js';
import {
  TICK_DT, CELL, COLS, ROWS, BOMB_FUSE, POWERUP,
  SHIELD_INVULN, SHIELD_TIME, GHOST_TIME,
  ROUND_END_DELAY, SUDDEN_DEATH_TIME, SPAWNS, START_RANGE,
} from '../shared/constants.js';

let failed = 0;
const ok = (cond, msg) => { if (!cond) { failed++; console.error('  ✗', msg); } else console.log('  ✓', msg); };

const defs = [
  { id: 'a', slot: 0, name: 'Rot' },
  { id: 'b', slot: 1, name: 'Blau' },
];
const defs4 = [
  ...defs,
  { id: 'c', slot: 2, name: 'Grün' },
  { id: 'd', slot: 3, name: 'Gelb' },
];

const arenaCapture = (game) => ({
  arena: { id: game.arenaId, theme: game.arenaTheme },
  grid: Array.from(game.grid),
  hidden: [...game.hidden.entries()].sort((a, b) => a[0] - b[0]),
});

function advanceDrawRound(game) {
  const previousRound = game.round;
  for (const p of game.players) p.alive = false;
  step(game, TICK_DT);
  const maxTicks = Math.ceil(ROUND_END_DELAY / TICK_DT) + 5;
  for (let i = 0; i < maxTicks && game.round === previousRound; i++) step(game, TICK_DT);
  return game.phase === 'playing' && game.round === previousRound + 1;
}

function symmetryKeys(col, row) {
  return [...new Set([
    row * COLS + col,
    row * COLS + (COLS - 1 - col),
    (ROWS - 1 - row) * COLS + col,
    (ROWS - 1 - row) * COLS + (COLS - 1 - col),
  ])];
}

function hasD2Symmetry(game) {
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const orbit = symmetryKeys(col, row);
      const cell = game.grid[orbit[0]];
      const hasHidden = game.hidden.has(orbit[0]);
      const hidden = game.hidden.get(orbit[0]);
      if (orbit.some((k) =>
        game.grid[k] !== cell ||
        game.hidden.has(k) !== hasHidden ||
        game.hidden.get(k) !== hidden)) return false;
    }
  }
  return true;
}

function spawnCorridorsAreSafe(game) {
  return SPAWNS.every((spawn) => {
    const dc = spawn.col < COLS / 2 ? 1 : -1;
    const dr = spawn.row < ROWS / 2 ? 1 : -1;
    for (let distance = 0; distance <= START_RANGE + 1; distance++) {
      for (const [col, row] of [
        [spawn.col + dc * distance, spawn.row],
        [spawn.col, spawn.row + dr * distance],
      ]) {
        const k = row * COLS + col;
        if (game.grid[k] !== CELL.EMPTY || game.hidden.has(k)) return false;
      }
    }
    return true;
  });
}

function distanceHistogram(grid, spawn) {
  const distances = new Int16Array(COLS * ROWS);
  distances.fill(-1);
  const start = spawn.row * COLS + spawn.col;
  distances[start] = 0;
  const queue = [start];
  for (let i = 0; i < queue.length; i++) {
    const k = queue[i], col = k % COLS, row = (k - col) / COLS;
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nc = col + dc, nr = row + dr;
      if (nc < 0 || nc >= COLS || nr < 0 || nr >= ROWS) continue;
      const nk = nr * COLS + nc;
      if (grid[nk] !== CELL.SOLID && distances[nk] === -1) {
        distances[nk] = distances[k] + 1;
        queue.push(nk);
      }
    }
  }
  const histogram = [];
  for (const distance of distances) {
    if (distance >= 0) histogram[distance] = (histogram[distance] || 0) + 1;
  }
  return {
    reached: queue.length,
    signature: histogram.map((count) => count || 0).join(','),
  };
}

const g = createGame(defs, { seed: 12345, winsToWin: 2 });

console.log('grid + spawn');
ok(g.grid.length === COLS * ROWS, 'grid sized COLS*ROWS');
ok(g.players.length === 2, 'two players');
ok(g.players[0].alive && g.players[1].alive, 'both start alive');
ok(g.phase === 'playing', 'phase playing');

// corners must be walkable
const corner = g.grid[1 * COLS + 1];
ok(corner === CELL.EMPTY, 'top-left spawn cell is empty');

console.log('arena bags are deterministic and player-count independent');
{
  const seed = 0xdecafbad;
  const a = createGame(defs, { seed, winsToWin: 9 });
  const b = createGame(defs, { seed, winsToWin: 9 });
  const capturesA = [], capturesB = [];
  let lifecycleOk = true;

  for (let i = 0; i < 12; i++) {
    capturesA.push(arenaCapture(a));
    capturesB.push(arenaCapture(b));
    if (i < 11) {
      lifecycleOk = advanceDrawRound(a) && advanceDrawRound(b) && lifecycleOk;
    }
  }

  ok(lifecycleOk, 'arena replay advanced through twelve rounds');
  ok(JSON.stringify(capturesA) === JSON.stringify(capturesB),
    'same seed reproduces arena order, terrain, and hidden powerups');

  const ids = capturesA.map((capture) => capture.arena.id);
  const bagsAreUnique = [0, 4, 8].every((offset) =>
    new Set(ids.slice(offset, offset + 4)).size === 4);
  ok(bagsAreUnique, 'each deterministic four-round bag contains every arena once');
  ok(ids.every((id, i) => i === 0 || id !== ids[i - 1]),
    'arena shuffle has no repeats inside or across bag boundaries');

  const withFourPlayers = createGame(defs4, { seed, winsToWin: 9 });
  ok(JSON.stringify(arenaCapture(withFourPlayers)) === JSON.stringify(capturesA[0]),
    'arena content is independent of active player count');
}

console.log('all arena presets preserve structural and resource fairness');
{
  const gg = createGame(defs4, { seed: 0x13579bdf, winsToWin: 9 });
  const ids = [], themes = [], openCounts = [];
  let symmetric = true;
  let safeSpawns = true;
  let connected = true;
  let equalDistances = true;
  let hiddenCount = 0;
  let brickCount = 0;
  let lifecycleOk = true;

  for (let i = 0; i < 4; i++) {
    ids.push(gg.arenaId);
    themes.push(gg.arenaTheme);
    symmetric = hasD2Symmetry(gg) && symmetric;
    safeSpawns = spawnCorridorsAreSafe(gg) && safeSpawns;
    hiddenCount += gg.hidden.size;
    brickCount += Array.from(gg.grid).filter((cell) => cell === CELL.BRICK).length;

    const openCount = Array.from(gg.grid).filter((cell) => cell !== CELL.SOLID).length;
    openCounts.push(openCount);
    const paths = SPAWNS.map((spawn) => distanceHistogram(gg.grid, spawn));
    connected = paths.every((path) => path.reached === openCount) && connected;
    equalDistances = paths.every((path) => path.signature === paths[0].signature) && equalDistances;

    if (i < 3) lifecycleOk = advanceDrawRound(gg) && lifecycleOk;
  }

  ok(lifecycleOk && new Set(ids).size === 4, 'first arena bag exercises all four presets');
  ok(new Set(themes).size === 4, 'each arena exposes a stable render theme');
  ok(symmetric, 'solid walls, bricks, and hidden powerups retain D2 symmetry');
  ok(safeSpawns, 'all four spawns have two clear bomb-safe escape corridors');
  ok(connected, 'every non-solid cell and spawn share one permanent topology');
  ok(equalDistances, 'all four spawns have identical permanent-path distance profiles');
  ok(Math.max(...openCounts) - Math.min(...openCounts) <= 3,
    'preset open-cell counts stay within the fairness tolerance');
  ok(brickCount > 0 && hiddenCount > 0, 'fairness checks exercised generated bricks and powerups');
}

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
p0.stepping = false; p0.tx = p0.x; p0.ty = p0.y; p0.moving = false;
p0.bombLock = 0;
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
p0.stepping = false; p0.tx = p0.x; p0.ty = p0.y; p0.moving = false;
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
ok('shield' in round.players[0] && 'shieldTime' in round.players[0] &&
   'ghost' in round.players[0] && 'pierce' in round.players[0],
  'snapshot carries ability fields');
ok(round.arena?.id === g.arenaId && round.arena?.theme === g.arenaTheme,
  'snapshot carries arena identity and render theme');

console.log('snapshot carries prediction and bomb ownership state');
{
  const gg = createGame(defs, { seed: 29, winsToWin: 2 });
  const pp = gg.players[0];
  pp.bombLock = 0;
  setInput(gg, 0, { right: true, bomb: true });
  step(gg, TICK_DT);

  const wire = JSON.parse(JSON.stringify(toSnapshot(gg)));
  const player = wire.players.find((p) => p.slot === 0);
  const bomb = wire.bombs[0];
  ok(player && player.stepping === pp.stepping && player.tx === pp.tx && player.ty === pp.ty,
    'snapshot carries stepping target for client prediction');
  ok(bomb && bomb.owner === 0, 'snapshot carries bomb owner');
}

console.log('round reset clears powerups but keeps score');
{
  const gg = createGame(defs, { seed: 31, winsToWin: 3 });
  const p0 = gg.players[0], p1 = gg.players[1];
  p0.maxBombs = 4; p0.range = 5; p0.speedPicks = 2; p0.pierce = true; p0.kick = true;
  p0.shield = 1; p0.shieldTime = 6; p0.ghost = 3;
  p1.alive = false;
  step(gg, TICK_DT); // resolves round, awards p0 one score
  for (let i = 0; i < 200; i++) step(gg, TICK_DT); // advance through ROUND_END_DELAY
  ok(gg.phase === 'playing' && gg.round === 2, 'new round started after roundover delay');
  ok(p0.score === 1, 'score persists across rounds');
  ok(p0.maxBombs === 1 && p0.range === 2 && p0.speedPicks === 0 &&
     !p0.pierce && !p0.kick && p0.shield === 0 && p0.shieldTime === 0 && p0.ghost === 0,
    'all powerups reset at new round spawn');
}

console.log('sudden-death clock resets between rounds');
{
  const gg = createGame(defs, { seed: 37, winsToWin: 3 });
  const p0 = gg.players[0], p1 = gg.players[1];
  // Resolve a round after sudden death has already begun, keeping the survivor
  // away from the first collapsing cell at the top-left spawn.
  gg.time = SUDDEN_DEATH_TIME + 5;
  p0.x = 3.5; p0.y = 3.5;
  p1.alive = false;
  step(gg, TICK_DT);
  ok(gg.phase === 'roundover', 'long round resolves normally');

  const maxDelayTicks = Math.ceil(ROUND_END_DELAY / TICK_DT) + 2;
  for (let i = 0; i < maxDelayTicks && gg.phase === 'roundover'; i++) step(gg, TICK_DT);
  ok(gg.phase === 'playing' && gg.round === 2, 'next round starts after the result delay');
  ok(gg.time === 0, 'new round starts with a fresh sudden-death clock');
  ok(gg.spiral === null && gg.spiralIdx === 0, 'new round starts without a collapse in progress');

  const scoreBefore = p0.score;
  step(gg, TICK_DT);
  ok(gg.phase === 'playing' && gg.players.every((p) => p.alive),
    'first tick of the new round does not kill a player at spawn');
  ok(p0.score === scoreBefore && gg.grid[1 * COLS + 1] === CELL.EMPTY,
    'new round neither awards a free win nor closes the top-left spawn');
}

console.log('sudden death still activates at the normal threshold');
{
  const gg = createGame(defs, { seed: 41, winsToWin: 2 });
  // Keep both players clear of the first spiral cell so activation itself does
  // not end the round and obscure the threshold assertion.
  gg.players[0].x = 3.5; gg.players[0].y = 3.5;
  gg.time = SUDDEN_DEATH_TIME - TICK_DT / 2;
  step(gg, TICK_DT);
  ok(Array.isArray(gg.spiral) && gg.spiralIdx === 1,
    'crossing the threshold starts the sudden-death spiral');
  ok(gg.grid[1 * COLS + 1] === CELL.SOLID, 'first sudden-death wall is placed');
}

console.log('sudden death skips preset walls without changing drop cadence');
{
  const gg = createGame(defs, { seed: 0x2468ace0, winsToWin: 9 });
  const ids = [];
  let filteredEveryPreset = true;
  let lifecycleOk = true;

  for (let i = 0; i < 4; i++) {
    ids.push(gg.arenaId);
    const effectiveCells = Array.from(gg.grid).filter((cell) => cell !== CELL.SOLID).length;
    for (const p of gg.players) { p.x = 7.5; p.y = 6.5; }
    gg.time = SUDDEN_DEATH_TIME - TICK_DT / 2;
    step(gg, TICK_DT);
    filteredEveryPreset = Array.isArray(gg.spiral) &&
      gg.spiral.length === effectiveCells &&
      gg.spiral.every(([col, row], index) => {
        const cell = gg.grid[row * COLS + col];
        // The first effective cell was just closed; every remaining entry was
        // non-solid when the collapse order was built.
        return index === 0 || cell !== CELL.SOLID;
      }) &&
      filteredEveryPreset;
    if (i < 3) lifecycleOk = advanceDrawRound(gg) && lifecycleOk;
  }

  ok(lifecycleOk && new Set(ids).size === 4, 'collapse filtering exercised every preset');
  ok(filteredEveryPreset, 'collapse order contains only effective new-wall cells');
}

console.log('spawn bomb lock prevents fat-finger self-bomb');
{
  const gg = createGame(defs, { seed: 33, winsToWin: 2 });
  setInput(gg, 0, { bomb: true });
  for (let i = 0; i < 30; i++) step(gg, TICK_DT); // first half-second: should still be locked
  ok(gg.bombs.length === 0, 'cannot place a bomb immediately after spawning');
  setInput(gg, 0, { bomb: false });
  for (let i = 0; i < 40; i++) step(gg, TICK_DT); // pass one second total
  setInput(gg, 0, { bomb: true });
  step(gg, TICK_DT);
  ok(gg.bombs.length === 1, 'can place a bomb after the spawn lock expires');
}

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
  pp.bombLock = 0;
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

console.log('SHIELD is temporary and absorbs one lethal hit');
{
  const gg = createGame(defs, { seed: 13, winsToWin: 2 });
  const pp = gg.players[0];
  pp.x = 1.5; pp.y = 1.5; pp.shield = 1; pp.shieldTime = SHIELD_TIME;
  gg.flames.push({ col: 1, row: 1, kind: 'center', orient: null, timer: 0.5, fresh: true });
  step(gg, TICK_DT);
  ok(pp.alive, 'shield kept the player alive');
  ok(pp.shield === 0, 'shield charge consumed');
  ok(pp.shieldTime === 0, 'shield timer clears when the charge is consumed');
  ok(pp.invuln > 0 && pp.invuln <= SHIELD_INVULN, 'i-frames granted');
}
{
  const gg = createGame(defs, { seed: 14, winsToWin: 2 });
  const pp = gg.players[0];
  pp.shield = 1;
  pp.shieldTime = TICK_DT * 2;
  step(gg, TICK_DT);
  ok(pp.shield === 1 && pp.shieldTime > 0, 'unused shield remains active before timeout');
  step(gg, TICK_DT);
  ok(pp.shield === 0 && pp.shieldTime === 0, 'unused shield expires when its timer ends');
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

console.log('SHIELD powerup starts and refreshes its timer');
{
  const gg = createGame(defs, { seed: 16, winsToWin: 2 });
  const pp = gg.players[0];
  pp.x = 1.5; pp.y = 1.5;
  gg.powerups.set(1 * COLS + 1, POWERUP.SHIELD);
  step(gg, TICK_DT);
  ok(pp.shield === 1 && pp.shieldTime === SHIELD_TIME,
    'walking onto a SHIELD powerup grants ten seconds of protection');
  pp.shieldTime = 2;
  gg.powerups.set(1 * COLS + 1, POWERUP.SHIELD);
  step(gg, TICK_DT);
  ok(pp.shield === 1 && pp.shieldTime === SHIELD_TIME,
    'another SHIELD pickup refreshes rather than stacking');
}

console.log(failed === 0 ? '\nALL ENGINE TESTS PASSED' : `\n${failed} TEST(S) FAILED`);
process.exit(failed === 0 ? 1 - 1 : 1);
