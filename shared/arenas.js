// Deterministic arena selection and generation.
//
// Each match seed produces shuffled four-arena bags: every preset appears once
// per bag, and adjacent bags cannot repeat at their boundary. Terrain content
// uses a separate per-round RNG stream, so changing preset order never changes
// brick/powerup rolls in later rounds.

import {
  BRICK_FILL, CELL, COLS, POWERUP, POWERUP_CHANCE, ROWS, SPAWNS, START_RANGE,
} from './constants.js';

const PRESETS = [
  {
    id: 'classic',
    theme: 'neon',
    rows: [
      '###############',
      '#.............#',
      '#.#.#.#.#.#.#.#',
      '#.............#',
      '#.#.#.#.#.#.#.#',
      '#.............#',
      '#.#.#.#.#.#.#.#',
      '#.............#',
      '#.#.#.#.#.#.#.#',
      '#.............#',
      '#.#.#.#.#.#.#.#',
      '#.............#',
      '###############',
    ],
  },
  {
    id: 'crossroads',
    theme: 'foundry',
    rows: [
      '###############',
      '#.............#',
      '#..#.#...#.#..#',
      '#......#......#',
      '#..#.#...#.#..#',
      '#......#......#',
      '#.#.#.###.#.#.#',
      '#......#......#',
      '#..#.#...#.#..#',
      '#......#......#',
      '#..#.#...#.#..#',
      '#.............#',
      '###############',
    ],
  },
  {
    id: 'citadel',
    theme: 'frost',
    rows: [
      '###############',
      '#.............#',
      '#.............#',
      '#..####.####..#',
      '#..#.......#..#',
      '#..#..#.#..#..#',
      '#.............#',
      '#..#..#.#..#..#',
      '#..#.......#..#',
      '#..####.####..#',
      '#.............#',
      '#.............#',
      '###############',
    ],
  },
  {
    id: 'switchyard',
    theme: 'reactor',
    rows: [
      '###############',
      '#.............#',
      '#...#.....#...#',
      '#...#.....#...#',
      '#...###.###...#',
      '#...#.....#...#',
      '#.#...#.#...#.#',
      '#...#.....#...#',
      '#...###.###...#',
      '#...#.....#...#',
      '#...#.....#...#',
      '#.............#',
      '###############',
    ],
  },
];

const DECK_SALT = 0x4152454e;    // "AREN"
const CONTENT_SALT = 0x4d415053; // "MAPS"
const key = (col, row) => row * COLS + col;

function mixSeed(seed, value, salt) {
  let x = ((Number(seed) >>> 0) ^ Math.imul((value >>> 0) + 1, 0x9e3779b1) ^ salt) >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function rawDeck(seed, cycle) {
  const deck = PRESETS.slice();
  const rng = makeRng(mixSeed(seed, cycle, DECK_SALT));
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function presetForRound(seed, round, selection = 'shuffle') {
  if (selection !== 'shuffle') {
    const selected = PRESETS.find((preset) => preset.id === selection);
    if (selected) return selected;
  }
  const roundIndex = Math.max(0, Math.floor(Number(round) || 1) - 1);
  const cycle = Math.floor(roundIndex / PRESETS.length);
  const slot = roundIndex % PRESETS.length;
  const deck = rawDeck(seed, cycle);

  // A bag is unique internally. Swap its first two entries when needed to also
  // prevent a repeat at the previous bag boundary. This never changes a bag's
  // last entry, so the previous raw deck is sufficient for the comparison.
  if (cycle > 0) {
    const previous = rawDeck(seed, cycle - 1);
    if (deck[0].id === previous[previous.length - 1].id) {
      [deck[0], deck[1]] = [deck[1], deck[0]];
    }
  }
  return deck[slot];
}

function spawnClearKeys() {
  const clear = new Set();
  for (const spawn of SPAWNS) {
    const dc = spawn.col < COLS / 2 ? 1 : -1;
    const dr = spawn.row < ROWS / 2 ? 1 : -1;
    for (let distance = 0; distance <= START_RANGE + 1; distance++) {
      clear.add(key(spawn.col + dc * distance, spawn.row));
      clear.add(key(spawn.col, spawn.row + dr * distance));
    }
  }
  return clear;
}

const SPAWN_CLEAR = spawnClearKeys();

function symmetryOrbit(col, row) {
  return [...new Set([
    key(col, row),
    key(COLS - 1 - col, row),
    key(col, ROWS - 1 - row),
    key(COLS - 1 - col, ROWS - 1 - row),
  ])].sort((a, b) => a - b);
}

function weightedPowerup(rng) {
  const r = rng();
  if (r < 0.23) return POWERUP.BOMB;
  if (r < 0.42) return POWERUP.RANGE;
  if (r < 0.55) return POWERUP.SPEED;
  if (r < 0.66) return POWERUP.KICK;
  if (r < 0.76) return POWERUP.GHOST;
  if (r < 0.85) return POWERUP.PIERCE;
  if (r < 0.91) return POWERUP.SHIELD;
  if (r < 0.96) return POWERUP.REMOTE;
  return POWERUP.THROW;
}

function validatePresets() {
  const openCounts = [];
  for (const preset of PRESETS) {
    if (preset.rows.length !== ROWS) throw new Error(`Arena ${preset.id}: expected ${ROWS} rows`);
    for (const row of preset.rows) {
      if (row.length !== COLS) throw new Error(`Arena ${preset.id}: expected ${COLS} columns`);
      if (/[^#.]/.test(row)) throw new Error(`Arena ${preset.id}: invalid cell marker`);
    }

    let openCount = 0;
    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        const cell = preset.rows[row][col];
        const border = row === 0 || col === 0 || row === ROWS - 1 || col === COLS - 1;
        if (border && cell !== '#') throw new Error(`Arena ${preset.id}: border must be solid`);
        if (cell !== preset.rows[row][COLS - 1 - col] ||
            cell !== preset.rows[ROWS - 1 - row][col]) {
          throw new Error(`Arena ${preset.id}: mask must have D2 symmetry`);
        }
        if (cell === '.') openCount++;
      }
    }

    for (const k of SPAWN_CLEAR) {
      const col = k % COLS, row = (k - col) / COLS;
      if (preset.rows[row][col] !== '.') {
        throw new Error(`Arena ${preset.id}: permanent wall intersects a spawn escape corridor`);
      }
    }

    const start = SPAWNS[0];
    const seen = new Set([key(start.col, start.row)]);
    const queue = [[start.col, start.row]];
    for (let i = 0; i < queue.length; i++) {
      const [col, row] = queue[i];
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nc = col + dc, nr = row + dr;
        if (nc < 0 || nc >= COLS || nr < 0 || nr >= ROWS) continue;
        const k = key(nc, nr);
        if (preset.rows[nr][nc] === '.' && !seen.has(k)) {
          seen.add(k);
          queue.push([nc, nr]);
        }
      }
    }
    if (seen.size !== openCount) throw new Error(`Arena ${preset.id}: open topology is disconnected`);
    openCounts.push(openCount);
  }

  if (Math.max(...openCounts) - Math.min(...openCounts) > 3) {
    throw new Error('Arena presets: open-cell counts differ too much for fair brick density');
  }
}

validatePresets();

export function generateArena({ seed, round, arena = 'shuffle', powerupRate = 'normal' }) {
  const preset = presetForRound(seed, round, arena);
  const grid = new Uint8Array(COLS * ROWS);
  const hidden = new Map();
  const powerupChance = powerupRate === 'low'
    ? 0.24
    : powerupRate === 'high'
      ? 0.64
      : POWERUP_CHANCE;

  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      grid[key(col, row)] = preset.rows[row][col] === '#' ? CELL.SOLID : CELL.EMPTY;
    }
  }

  const roundNumber = Math.max(1, Math.floor(Number(round) || 1));
  const rng = makeRng(mixSeed(seed, roundNumber, CONTENT_SALT));
  for (let row = 1; row < ROWS - 1; row++) {
    for (let col = 1; col < COLS - 1; col++) {
      const k = key(col, row);
      const orbit = symmetryOrbit(col, row);
      if (k !== orbit[0] || grid[k] !== CELL.EMPTY || SPAWN_CLEAR.has(k)) continue;

      // Preset and spawn-clear validation guarantee that every member of this
      // orbit has the same eligibility, so one roll can be applied fairly.
      if (rng() >= BRICK_FILL) continue;
      for (const cellKey of orbit) grid[cellKey] = CELL.BRICK;

      if (rng() < powerupChance) {
        const kind = weightedPowerup(rng);
        for (const cellKey of orbit) hidden.set(cellKey, kind);
      }
    }
  }

  return {
    id: preset.id,
    theme: preset.theme,
    grid,
    hidden,
  };
}
