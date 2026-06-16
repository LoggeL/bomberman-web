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
  SPAWNS, ROUND_END_DELAY, SUDDEN_DEATH_TIME,
} from './constants.js';

const PLAYER_HALF = 0.34; // half the player's collision box, in tiles

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
      score: 0,
      bombHeld: false,
      passBombs: new Set(), // bomb tiles this player may walk through
      moving: false,
    });
  }

  generateRound(state);
  return state;
}

// Builds a fresh map and respawns every player to their corner.
function generateRound(state) {
  const g = state.grid;
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
    p.passBombs.clear();
    p.moving = false;
  }
}

function weightedPowerup(rng) {
  const r = rng();
  if (r < 0.42) return POWERUP.BOMB;
  if (r < 0.80) return POWERUP.RANGE;
  return POWERUP.SPEED;
}

// ---- per-player input --------------------------------------------------------
// input: { up, down, left, right, bomb } booleans (current frame).
export function setInput(state, slot, input) {
  const p = state.players.find((q) => q.slot === slot);
  if (p) p._input = input;
}

// ---- collision ---------------------------------------------------------------

function cellBlocks(state, p, col, row) {
  if (!inBounds(col, row)) return true;
  const c = state.grid[key(col, row)];
  if (c === CELL.SOLID || c === CELL.BRICK) return true;
  // A bomb blocks unless this player is still allowed to pass it.
  for (const b of state.bombs) {
    if (b.col === col && b.row === row && !p.passBombs.has(key(col, row))) return true;
  }
  return false;
}

function canStand(state, p, x, y) {
  const minC = Math.floor(x - PLAYER_HALF);
  const maxC = Math.floor(x + PLAYER_HALF);
  const minR = Math.floor(y - PLAYER_HALF);
  const maxR = Math.floor(y + PLAYER_HALF);
  for (let r = minR; r <= maxR; r++) {
    for (let c = minC; c <= maxC; c++) {
      if (cellBlocks(state, p, c, r)) return false;
    }
  }
  return true;
}

// Move along a single axis with Bomberman-style cornering assist: when blocked
// head-on, nudge toward the lane centre so players can round corners smoothly.
function moveAxis(state, p, mx, my) {
  if (canStand(state, p, p.x + mx, p.y + my)) { p.x += mx; p.y += my; return; }
  const step = Math.abs(mx) + Math.abs(my);
  if (mx !== 0) {
    const cy = Math.floor(p.y) + 0.5;
    const dir = Math.sign(cy - p.y);
    if (dir !== 0) {
      const ny = p.y + dir * Math.min(step, Math.abs(cy - p.y));
      if (canStand(state, p, p.x + mx, ny)) { p.x += mx; p.y = ny; return; }
      if (canStand(state, p, p.x, ny)) { p.y = ny; return; }
    }
  } else if (my !== 0) {
    const cx = Math.floor(p.x) + 0.5;
    const dir = Math.sign(cx - p.x);
    if (dir !== 0) {
      const nx = p.x + dir * Math.min(step, Math.abs(cx - p.x));
      if (canStand(state, p, nx, p.y + my)) { p.x = nx; p.y += my; return; }
      if (canStand(state, p, nx, p.y)) { p.x = nx; return; }
    }
  }
}

// ---- bombs & explosions ------------------------------------------------------

function placeBomb(state, p) {
  const col = Math.floor(p.x);
  const row = Math.floor(p.y);
  const active = state.bombs.filter((b) => b.owner === p.slot).length;
  if (active >= p.maxBombs) return;
  if (state.bombs.some((b) => b.col === col && b.row === row)) return;
  state.bombs.push({ col, row, owner: p.slot, timer: BOMB_FUSE, range: p.range });
  p.passBombs.add(key(col, row)); // let the owner step off it
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
        addFlame(state, col, row, 'tip', orient);
        break; // bricks stop the blast
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
  // Overlapping flames just refresh the timer at that tile.
  const existing = state.flames.find((f) => f.col === col && f.row === row);
  if (existing) { existing.timer = FLAME_TIME; return; }
  state.flames.push({ col, row, kind, orient, timer: FLAME_TIME });
}

// ---- main step ---------------------------------------------------------------

// Advances the simulation by one fixed tick. Call repeatedly with TICK_DT.
export function step(state, dt = TICK_DT) {
  state.time += dt;

  if (state.phase === 'roundover' || state.phase === 'matchover') {
    state.phaseTimer -= dt;
    if (state.phase === 'roundover' && state.phaseTimer <= 0) {
      state.round += 1;
      generateRound(state);
      state.phase = 'playing';
      state.winner = null;
    }
    return;
  }

  // 1. movement + bomb placement
  for (const p of state.players) {
    if (!p.alive) continue;
    const inp = p._input || {};
    const speed = (BASE_SPEED + p.speedPicks * SPEED_PER_PICKUP) * dt;

    let dx = (inp.right ? 1 : 0) - (inp.left ? 1 : 0);
    let dy = (inp.down ? 1 : 0) - (inp.up ? 1 : 0);
    p.moving = dx !== 0 || dy !== 0;
    if (dx !== 0 && dy !== 0) dy = 0; // 4-directional movement only
    if (dx > 0) p.dir = 'right'; else if (dx < 0) p.dir = 'left';
    else if (dy > 0) p.dir = 'down'; else if (dy < 0) p.dir = 'up';

    if (dx !== 0) moveAxis(state, p, dx * speed, 0);
    if (dy !== 0) moveAxis(state, p, 0, dy * speed);

    // release bomb tiles the player has fully walked off of
    for (const tk of [...p.passBombs]) {
      const bc = tk % COLS, br = (tk - bc) / COLS;
      const overlaps =
        p.x + PLAYER_HALF > bc && p.x - PLAYER_HALF < bc + 1 &&
        p.y + PLAYER_HALF > br && p.y - PLAYER_HALF < br + 1;
      const stillBomb = state.bombs.some((b) => b.col === bc && b.row === br);
      if (!overlaps || !stillBomb) p.passBombs.delete(tk);
    }

    // bomb on rising edge
    if (inp.bomb && !p.bombHeld) placeBomb(state, p);
    p.bombHeld = !!inp.bomb;

    // pick up a powerup on the player's centre tile
    const pk = key(Math.floor(p.x), Math.floor(p.y));
    if (state.powerups.has(pk)) {
      applyPowerup(p, state.powerups.get(pk));
      state.powerups.delete(pk);
    }
  }

  // 2. bombs
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

  // 5. deaths
  for (const p of state.players) {
    if (!p.alive) continue;
    if (playerInFlame(state, p)) p.alive = false;
  }

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
}

function playerInFlame(state, p) {
  const minC = Math.floor(p.x - PLAYER_HALF + 0.15);
  const maxC = Math.floor(p.x + PLAYER_HALF - 0.15);
  const minR = Math.floor(p.y - PLAYER_HALF + 0.15);
  const maxR = Math.floor(p.y + PLAYER_HALF - 0.15);
  return state.flames.some(
    (f) => f.col >= minC && f.col <= maxC && f.row >= minR && f.row <= maxR,
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
    if (state.bombs[i].col === col && state.bombs[i].row === row) state.bombs.splice(i, 1);
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
      speedPicks: p.speedPicks, score: p.score, moving: p.moving,
    })),
    bombs: state.bombs.map((b) => ({ col: b.col, row: b.row, timer: b.timer, range: b.range })),
    flames: state.flames.map((f) => ({ col: f.col, row: f.row, kind: f.kind, orient: f.orient })),
  };
}
