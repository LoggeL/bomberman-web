// Pure, framework-agnostic Bomberman simulation.
//
// The SAME engine runs in two places:
//   - Local mode: directly in the browser, stepped each animation frame.
//   - Online mode: authoritatively on the Node server; the client only renders
//     snapshots produced by `toSnapshot()`.
//
// Everything here is deterministic given (seed, inputs). No DOM, no timers,
// no Math.random in the hot path — map generation uses a seeded RNG so a
// server round is fully reproducible.

import {
  COLS, ROWS, CELL, POWERUP, TICK_DT,
  BOMB_FUSE, FLAME_TIME, BRICK_FILL, POWERUP_CHANCE,
  BASE_SPEED, SPEED_PER_PICKUP, MAX_SPEED_PICKUPS,
  START_BOMBS, START_RANGE, MAX_BOMBS, MAX_RANGE,
  MAX_SHIELD, SHIELD_INVULN, GHOST_TIME, KICK_SPEED,
  SPAWNS, ROUND_END_DELAY, SUDDEN_DEATH_TIME, SPAWN_BOMB_LOCK,
} from './constants.js';

const PLAYER_HALF = 0.34; // half the player's collision box, in tiles (death/pickup checks)

// ---- seeded RNG (mulberry32) -------------------------------------------------
function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const key = (col, row) => row * COLS + col;
const inBounds = (col, row) => col >= 0 && col < COLS && row >= 0 && row < ROWS;

// ---- construction ------------------------------------------------------------

// playerDefs: [{ id, name, slot }]. winsToWin: rounds needed to win the match.
export function createGame(playerDefs, { seed = 1, winsToWin = 3 } = {}) {
  const state = {
    grid: new Uint8Array(COLS * ROWS),
    hidden: new Map(),   // key -> POWERUP kind hidden under a brick
    powerups: new Map(), // key -> POWERUP kind lying on the floor
    players: [],
    bombs: [],
    flames: [],
    time: 0,
    round: 1,
    phase: 'playing',    // 'playing' | 'roundover' | 'matchover'
    phaseTimer: 0,
    winner: null,        // slot of round winner, or null for a draw
    matchWinner: null,
    winsToWin,
    seed,
    rng: makeRng(seed),
    spiral: null,        // sudden-death cell order
    spiralIdx: 0,
    spiralTimer: 0,
    bombSeq: 0,          // monotonic id source so each bomb has a stable identity
  };

  for (const def of playerDefs) {
    state.players.push({
      id: def.id,
      slot: def.slot,
      name: def.name ?? `P${def.slot + 1}`,
      x: 0, y: 0, dir: 'down',
      alive: true,
      maxBombs: START_BOMBS,
      range: START_RANGE,
      speedPicks: 0,
      ghost: 0,        // seconds of wallpass remaining (0 = off)
      pierce: false,   // bombs tear through bricks
      shield: 0,       // absorbs lethal hits
      kick: false,     // can kick bombs
      invuln: 0,       // seconds of i-frames remaining after a shield pop
      score: 0,
      bombHeld: false,
      bombLock: 0,      // spawn grace: prevents fat-finger bomb drops right after respawn
      // Tile-step movement state: a player rests on a cell centre and glides one
      // whole tile toward (tx, ty) while `stepping`.
      stepping: false,
      tx: 0, ty: 0,
      moving: false,
    });
  }

  generateRound(state);
  return state;
}

// Builds a fresh map and respawns every player to their corner.
function generateRound(state) {
  const g = state.grid;
  // `time` is elapsed time for the CURRENT round (it is exposed as `snap.t`
  // and drives sudden death/the HUD), not the lifetime of the match.
  state.time = 0;
  state.phaseTimer = 0;
  state.winner = null;
  state.hidden.clear();
  state.powerups.clear();
  state.bombs.length = 0;
  state.flames.length = 0;
  state.spiral = null;
  state.spiralIdx = 0;
  state.spiralTimer = 0;

  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      let cell = CELL.EMPTY;
      if (col === 0 || row === 0 || col === COLS - 1 || row === ROWS - 1) {
        cell = CELL.SOLID; // border wall
      } else if (col % 2 === 0 && row % 2 === 0) {
        cell = CELL.SOLID; // interior pillar grid
      }
      g[key(col, row)] = cell;
    }
  }

  // Keep each spawn corner and its two neighbours clear so nobody is boxed in.
  const clear = new Set();
  for (let i = 0; i < state.players.length; i++) {
    const s = SPAWNS[state.players[i].slot];
    for (const [dc, dr] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
      if (inBounds(s.col + dc, s.row + dr)) clear.add(key(s.col + dc, s.row + dr));
    }
  }

  // Scatter destructible bricks over the remaining empty cells.
  for (let row = 1; row < ROWS - 1; row++) {
    for (let col = 1; col < COLS - 1; col++) {
      const k = key(col, row);
      if (g[k] !== CELL.EMPTY || clear.has(k)) continue;
      if (state.rng() < BRICK_FILL) {
        g[k] = CELL.BRICK;
        if (state.rng() < POWERUP_CHANCE) {
          state.hidden.set(k, weightedPowerup(state.rng));
        }
      }
    }
  }

  for (const p of state.players) {
    const s = SPAWNS[p.slot];
    p.x = s.col + 0.5;
    p.y = s.row + 0.5;
    p.dir = 'down';
    p.alive = true;
    p.bombHeld = false;
    p.bombLock = SPAWN_BOMB_LOCK;
    p.stepping = false;
    p.tx = p.x;
    p.ty = p.y;
    p.invuln = 0;
    // Power-ups are per-round only. Scores persist; upgrades reset on respawn.
    p.maxBombs = START_BOMBS;
    p.range = START_RANGE;
    p.speedPicks = 0;
    p.ghost = 0;
    p.pierce = false;
    p.shield = 0;
    p.kick = false;
    p.moving = false;
  }
}

// Weighted hidden-powerup roll. The common stat boosts stay most likely; the
// flashy abilities (ghost / pierce / shield) are rarer treats.
function weightedPowerup(rng) {
  const r = rng();
  if (r < 0.26) return POWERUP.BOMB;   // 26%
  if (r < 0.48) return POWERUP.RANGE;  // 22%
  if (r < 0.62) return POWERUP.SPEED;  // 14%
  if (r < 0.74) return POWERUP.KICK;   // 12%
  if (r < 0.84) return POWERUP.GHOST;  // 10%
  if (r < 0.93) return POWERUP.PIERCE; //  9%
  return POWERUP.SHIELD;               //  7%
}

// ---- per-player input --------------------------------------------------------
// input: { up, down, left, right, bomb } booleans (current frame).
export function setInput(state, slot, input) {
  const p = state.players.find((q) => q.slot === slot);
  if (p) p._input = input;
}

// ---- movement (tile-by-tile grid stepping) -----------------------------------
//
// Players "clip to the squares": a player only ever rests on a cell centre and
// glides one whole tile at a time toward an adjacent centre. Holding a direction
// chains steps; a new direction can be chosen at each centre, so turning at
// intersections stays responsive. The model is pure over (grid, bombs) so the
// browser reuses the EXACT same logic for client-side prediction (see
// stepPlayerGrid), keeping prediction in lock-step with the authoritative sim.

// 4-directional intent from raw input. Horizontal wins when both axes are held
// (matches the old engine's tie-break).
function chooseDir(input) {
  let dx = (input.right ? 1 : 0) - (input.left ? 1 : 0);
  let dy = (input.down ? 1 : 0) - (input.up ? 1 : 0);
  if (dx !== 0 && dy !== 0) dy = 0;
  if (dx > 0) return { dx: 1, dy: 0, name: 'right' };
  if (dx < 0) return { dx: -1, dy: 0, name: 'left' };
  if (dy > 0) return { dx: 0, dy: 1, name: 'down' };
  if (dy < 0) return { dx: 0, dy: -1, name: 'up' };
  return null;
}

// Can a player enter this cell? Solids always block; bricks block unless the
// player has GHOST (wallpass); a live bomb blocks entry (you step off your own
// bomb by only ever checking the *target* cell, never the one you're leaving).
function cellWalkable(grid, bombs, col, row, canGhost) {
  if (!inBounds(col, row)) return false;
  const c = grid[key(col, row)];
  if (c === CELL.SOLID) return false;
  if (c === CELL.BRICK && !canGhost) return false;
  for (const b of bombs) if (b.col === col && b.row === row) return false;
  return true;
}

// Advance one player one tick of tile-stepping movement. Mutates p.x/p.y/p.dir/
// p.moving/p.stepping/p.tx/p.ty. Shared by step() (authoritative) and the client
// predictor.
//
//   grid  : Uint8Array | number[] of CELL values (snapshot grid is a plain array)
//   bombs : [{ col, row }, ...]
//   p     : { x, y, dir, moving, stepping, tx, ty, speedPicks, ghost }
//   input : { up, down, left, right }
//   dt    : seconds since the previous step
export function stepPlayerGrid(grid, bombs, p, input, dt) {
  const ox = p.x, oy = p.y;
  let budget = (BASE_SPEED + (p.speedPicks || 0) * SPEED_PER_PICKUP) * dt;

  // Consume the whole tick's distance, possibly crossing several cells when fast
  // — but always pausing to re-decide at each centre, so we stay grid-locked.
  while (budget > 0) {
    if (!p.stepping) {
      // Snap to the nearest centre before committing a step. This is a no-op in
      // normal play (a finished step lands exactly on a centre) but cleans up
      // after a client reconciliation snap to an off-centre server position.
      const cc = Math.round(p.x - 0.5);
      const cr = Math.round(p.y - 0.5);
      p.x = cc + 0.5; p.y = cr + 0.5;

      const dir = chooseDir(input);
      if (!dir) break;            // no input — rest at the centre
      p.dir = dir.name;           // face the way we're pushing, even if blocked
      // Wallpass while ghosting, and as an escape grace if ghost expired while
      // embedded inside a brick (so a player can never get stuck in a wall).
      const canGhost = p.ghost > 0 || grid[key(cc, cr)] === CELL.BRICK;
      if (!cellWalkable(grid, bombs, cc + dir.dx, cr + dir.dy, canGhost)) break;
      p.tx = (cc + dir.dx) + 0.5;
      p.ty = (cr + dir.dy) + 0.5;
      p.stepping = true;
    }

    const dx = p.tx - p.x, dy = p.ty - p.y;
    const dist = Math.abs(dx) + Math.abs(dy); // axis-aligned: one term is zero
    if (budget >= dist) {
      p.x = p.tx; p.y = p.ty; p.stepping = false; budget -= dist;
    } else {
      p.x += Math.sign(dx) * budget;
      p.y += Math.sign(dy) * budget;
      budget = 0;
    }
  }

  p.moving = p.x !== ox || p.y !== oy;
}

// ---- bombs & explosions ------------------------------------------------------

function placeBomb(state, p) {
  // Drop on the cell the player is centred over (nearest centre), so a bomb
  // tapped mid-glide lands on the tile they occupy, not the one ahead.
  const col = Math.round(p.x - 0.5);
  const row = Math.round(p.y - 0.5);
  const active = state.bombs.filter((b) => b.owner === p.slot).length;
  if (active >= p.maxBombs) return;
  if (state.bombs.some((b) => b.col === col && b.row === row)) return;
  state.bombs.push({
    id: state.bombSeq++, col, row, owner: p.slot,
    timer: BOMB_FUSE, range: p.range, pierce: p.pierce,
    // Continuous position (centre-based) + slide velocity for kicked bombs.
    x: col + 0.5, y: row + 0.5, vx: 0, vy: 0,
  });
}

// Can a sliding bomb occupy this cell? Blocked by walls, bricks, the board edge,
// and any OTHER bomb. (Players don't stop a kicked bomb — it slides under them.)
function bombCanEnter(state, self, col, row) {
  if (!inBounds(col, row)) return false;
  const c = state.grid[key(col, row)];
  if (c === CELL.SOLID || c === CELL.BRICK) return false;
  for (const b of state.bombs) if (b !== self && b.col === col && b.row === row) return false;
  return true;
}

// Advance a kicked bomb: glide centre-to-centre in its slide direction. The next
// cell is re-checked on arrival at EVERY centre (not just the first), so a bomb
// can never skip past a wall regardless of speed. Its logical (col,row) tracks
// the nearest cell so detonation/chains stay grid-correct.
function updateBombSlide(state, b, dt) {
  if (b.vx === 0 && b.vy === 0) return;
  // Safety: if a wall closed onto our cell mid-slide, back out to the cell we
  // came from and stop, so we never end up embedded in (or tunnel through) it.
  const here = state.grid[key(Math.round(b.x - 0.5), Math.round(b.y - 0.5))];
  if (here === CELL.SOLID || here === CELL.BRICK) {
    b.col = Math.round(b.x - 0.5) - b.vx;
    b.row = Math.round(b.y - 0.5) - b.vy;
    b.x = b.col + 0.5; b.y = b.row + 0.5;
    b.vx = 0; b.vy = 0;
    return;
  }
  let budget = KICK_SPEED * dt;
  while (budget > 0) {
    const cc = Math.round(b.x - 0.5), cr = Math.round(b.y - 0.5);
    const tx = (cc + b.vx) + 0.5, ty = (cr + b.vy) + 0.5;
    const dx = tx - b.x, dy = ty - b.y;
    const dist = Math.abs(dx) + Math.abs(dy);
    if (budget >= dist) {
      // Arrived at the next centre — commit, then check the cell beyond before
      // continuing. (Snapping to the exact centre keeps these checks reliable at
      // any KICK_SPEED, with no tunneling.)
      b.x = tx; b.y = ty; budget -= dist;
      if (!bombCanEnter(state, b, (cc + b.vx) + b.vx, (cr + b.vy) + b.vy)) { b.vx = 0; b.vy = 0; break; }
    } else {
      b.x += Math.sign(dx) * budget; b.y += Math.sign(dy) * budget; budget = 0;
    }
  }
  b.col = Math.round(b.x - 0.5);
  b.row = Math.round(b.y - 0.5);
}

// If a kick-capable player at a centre pushes into a stationary bomb that has
// somewhere to go, launch it sliding in that direction.
function tryKick(state, p, inp) {
  if (p.stepping) return;
  const dir = chooseDir(inp);
  if (!dir) return;
  const cc = Math.round(p.x - 0.5), cr = Math.round(p.y - 0.5);
  const tcol = cc + dir.dx, trow = cr + dir.dy;
  const bomb = state.bombs.find((b) => b.col === tcol && b.row === trow && b.vx === 0 && b.vy === 0);
  if (!bomb) return;
  if (!bombCanEnter(state, bomb, tcol + dir.dx, trow + dir.dy)) return; // nowhere to slide
  bomb.vx = dir.dx; bomb.vy = dir.dy;
}

function detonate(state, bomb, toExplode) {
  addFlame(state, bomb.col, bomb.row, 'center', null);
  const dirs = [
    [1, 0, 'h'], [-1, 0, 'h'], [0, 1, 'v'], [0, -1, 'v'],
  ];
  for (const [dc, dr, orient] of dirs) {
    for (let i = 1; i <= bomb.range; i++) {
      const col = bomb.col + dc * i;
      const row = bomb.row + dr * i;
      if (!inBounds(col, row)) break;
      const k = key(col, row);
      const cell = state.grid[k];
      if (cell === CELL.SOLID) break;
      if (cell === CELL.BRICK) {
        state.grid[k] = CELL.EMPTY;
        if (state.hidden.has(k)) {
          state.powerups.set(k, state.hidden.get(k));
          state.hidden.delete(k);
        }
        // A normal blast stops at the first brick; a PIERCE blast tears straight
        // through and keeps going to the edge of its range.
        if (!bomb.pierce) {
          addFlame(state, col, row, 'tip', orient);
          break;
        }
        addFlame(state, col, row, i === bomb.range ? 'tip' : 'arm', orient);
        continue;
      }
      // chain-detonate any bomb caught in the blast
      const chained = state.bombs.find((b) => b.col === col && b.row === row && b.timer > 0);
      if (chained) chained.timer = 0;
      // flames burn away loose powerups
      if (state.powerups.has(k)) state.powerups.delete(k);
      addFlame(state, col, row, i === bomb.range ? 'tip' : 'arm', orient);
    }
  }
}

function addFlame(state, col, row, kind, orient) {
  // Overlapping flames refresh the timer at that tile. A 'center' always wins
  // over a residual arm/tip so a new detonation landing on an old flame is
  // still marked as a blast centre (drawn correctly + detectable as an event).
  // `fresh` marks a tile that was (re)ignited THIS tick — only fresh flame is
  // lethal, so the lingering fire afterwards is harmless to walk through.
  const existing = state.flames.find((f) => f.col === col && f.row === row);
  if (existing) {
    existing.timer = FLAME_TIME;
    existing.fresh = true;
    if (kind === 'center') { existing.kind = 'center'; existing.orient = null; }
    return;
  }
  state.flames.push({ col, row, kind, orient, timer: FLAME_TIME, fresh: true });
}

// ---- main step ---------------------------------------------------------------

// Advances the simulation by one fixed tick. Call repeatedly with TICK_DT.
export function step(state, dt = TICK_DT) {
  if (state.phase === 'roundover' || state.phase === 'matchover') {
    state.phaseTimer -= dt;
    if (state.phase === 'roundover' && state.phaseTimer <= 0) {
      state.round += 1;
      generateRound(state);
      state.phase = 'playing';
    }
    return;
  }

  state.time += dt;

  // 1. movement + bomb placement
  for (const p of state.players) {
    if (!p.alive) continue;
    if (p.invuln > 0) p.invuln = Math.max(0, p.invuln - dt);
    if (p.ghost > 0) p.ghost = Math.max(0, p.ghost - dt);
    if (p.bombLock > 0) p.bombLock = Math.max(0, p.bombLock - dt);
    const inp = p._input || {};

    // Kick a bomb we're walking into (before moving, so we stay put this tick
    // while the bomb slides away).
    if (p.kick) tryKick(state, p, inp);

    // Tile-by-tile movement (clips to the grid).
    stepPlayerGrid(state.grid, state.bombs, p, inp, dt);

    // bomb on rising edge — drops on the cell the player is centred over
    if (inp.bomb && !p.bombHeld && p.bombLock <= 0) placeBomb(state, p);
    p.bombHeld = !!inp.bomb;

    // pick up a powerup on the player's centre tile
    const pk = key(Math.floor(p.x), Math.floor(p.y));
    if (state.powerups.has(pk)) {
      applyPowerup(p, state.powerups.get(pk));
      state.powerups.delete(pk);
    }
  }

  // 2. bombs
  for (const bomb of state.bombs) updateBombSlide(state, bomb, dt); // kicked bombs glide
  for (const bomb of state.bombs) bomb.timer -= dt;
  // detonate (looping so chain reactions resolve this tick)
  let exploded = true;
  while (exploded) {
    exploded = false;
    for (let i = state.bombs.length - 1; i >= 0; i--) {
      if (state.bombs[i].timer <= 0) {
        const b = state.bombs.splice(i, 1)[0];
        detonate(state, b);
        exploded = true;
      }
    }
  }

  // 3. flames decay
  for (let i = state.flames.length - 1; i >= 0; i--) {
    state.flames[i].timer -= dt;
    if (state.flames[i].timer <= 0) state.flames.splice(i, 1);
  }

  // 4. sudden death — close the arena in a spiral to break stalemates
  updateSuddenDeath(state, dt);

  // 5. deaths — only the INITIAL blast (a flame ignited this tick) is lethal;
  // the lingering fire afterwards is harmless. A SHIELD absorbs one otherwise-
  // lethal hit and grants brief i-frames so one blast can't burn several charges.
  for (const p of state.players) {
    if (!p.alive) continue;
    if (p.invuln > 0) continue;
    if (playerInFlame(state, p)) {
      if (p.shield > 0) { p.shield -= 1; p.invuln = SHIELD_INVULN; }
      else p.alive = false;
    }
  }
  // The blast has resolved for this tick — remaining flame is now just décor.
  for (const f of state.flames) f.fresh = false;

  // 6. round resolution
  const alive = state.players.filter((p) => p.alive);
  const everStarted = state.players.length >= 1;
  if (everStarted && alive.length <= 1 && state.players.length >= 2) {
    state.phase = 'roundover';
    state.phaseTimer = ROUND_END_DELAY;
    state.winner = alive.length === 1 ? alive[0].slot : null;
    if (alive.length === 1) {
      alive[0].score += 1;
      if (alive[0].score >= state.winsToWin) {
        state.phase = 'matchover';
        state.matchWinner = alive[0].slot;
      }
    }
  }
}

function applyPowerup(p, kind) {
  if (kind === POWERUP.BOMB) p.maxBombs = Math.min(MAX_BOMBS, p.maxBombs + 1);
  else if (kind === POWERUP.RANGE) p.range = Math.min(MAX_RANGE, p.range + 1);
  else if (kind === POWERUP.SPEED) p.speedPicks = Math.min(MAX_SPEED_PICKUPS, p.speedPicks + 1);
  else if (kind === POWERUP.GHOST) p.ghost = GHOST_TIME; // (re)arm the timer
  else if (kind === POWERUP.PIERCE) p.pierce = true;
  else if (kind === POWERUP.SHIELD) p.shield = Math.min(MAX_SHIELD, p.shield + 1);
  else if (kind === POWERUP.KICK) p.kick = true;
}

function playerInFlame(state, p) {
  const minC = Math.floor(p.x - PLAYER_HALF + 0.15);
  const maxC = Math.floor(p.x + PLAYER_HALF - 0.15);
  const minR = Math.floor(p.y - PLAYER_HALF + 0.15);
  const maxR = Math.floor(p.y + PLAYER_HALF - 0.15);
  return state.flames.some(
    (f) => f.fresh && f.col >= minC && f.col <= maxC && f.row >= minR && f.row <= maxR,
  );
}

// Builds an inward spiral of interior cells the walls collapse along.
function buildSpiral() {
  const cells = [];
  let top = 1, bottom = ROWS - 2, left = 1, right = COLS - 2;
  while (top <= bottom && left <= right) {
    for (let c = left; c <= right; c++) cells.push([c, top]);
    for (let r = top + 1; r <= bottom; r++) cells.push([right, r]);
    for (let c = right - 1; c >= left; c--) cells.push([c, bottom]);
    for (let r = bottom - 1; r > top; r--) cells.push([left, r]);
    top++; bottom--; left++; right--;
  }
  return cells;
}

function updateSuddenDeath(state, dt) {
  if (state.time < SUDDEN_DEATH_TIME) return;
  if (!state.spiral) state.spiral = buildSpiral();
  state.spiralTimer -= dt;
  if (state.spiralTimer > 0) return;
  state.spiralTimer = 0.18; // drop a block every ~0.18s
  if (state.spiralIdx >= state.spiral.length) return;
  const [col, row] = state.spiral[state.spiralIdx++];
  const k = key(col, row);
  state.grid[k] = CELL.SOLID;
  state.hidden.delete(k);
  state.powerups.delete(k);
  for (let i = state.bombs.length - 1; i >= 0; i--) {
    const b = state.bombs[i];
    // Remove a bomb on the cell, or one currently sliding into it (its logical
    // cell leads behind its target), so a kicked bomb can't slip through a wall.
    const onCell = b.col === col && b.row === row;
    const slidingInto = (b.vx || b.vy) && b.col + b.vx === col && b.row + b.vy === row;
    if (onCell || slidingInto) state.bombs.splice(i, 1);
  }
  for (const p of state.players) {
    if (p.alive && Math.floor(p.x) === col && Math.floor(p.y) === row) p.alive = false;
  }
}

// ---- snapshot for networking & rendering ------------------------------------

// Produces a plain JSON-serializable view of the world for clients.
export function toSnapshot(state) {
  const powerups = [];
  for (const [k, kind] of state.powerups) {
    const col = k % COLS, row = (k - col) / COLS;
    powerups.push({ col, row, kind });
  }
  return {
    t: state.time,
    phase: state.phase,
    round: state.round,
    phaseTimer: state.phaseTimer,
    winner: state.winner,
    matchWinner: state.matchWinner,
    winsToWin: state.winsToWin,
    grid: Array.from(state.grid),
    powerups,
    players: state.players.map((p) => ({
      slot: p.slot, name: p.name, x: p.x, y: p.y, dir: p.dir,
      alive: p.alive, maxBombs: p.maxBombs, range: p.range,
      speedPicks: p.speedPicks, ghost: p.ghost, pierce: p.pierce,
      shield: p.shield, kick: p.kick, invuln: p.invuln, bombLock: p.bombLock,
      score: p.score, moving: p.moving,
      // Movement internals let an online client resume prediction from the
      // exact authoritative point in a tile step instead of rounding to a cell.
      stepping: p.stepping, tx: p.tx, ty: p.ty,
    })),
    bombs: state.bombs.map((b) => ({
      id: b.id, col: b.col, row: b.row, x: b.x, y: b.y,
      owner: b.owner,
      vx: b.vx, vy: b.vy, timer: b.timer, range: b.range, pierce: b.pierce,
    })),
    flames: state.flames.map((f) => ({ col: f.col, row: f.row, kind: f.kind, orient: f.orient })),
  };
}
