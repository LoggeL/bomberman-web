// Deterministic, framework-free bot policy.
//
// Integration contract:
//   const input = decideBotInput(gameStateOrSnapshot, player);
//   setInput(gameState, player.slot, input);
//
// Call once before each simulation step. The function never mutates its
// arguments and accepts both the authoritative engine state and `toSnapshot()`
// output. `action` is the reserved secondary-button bit; the remote-detonator
// integration can consume it without changing this module's public interface.
// Arena mechanics may expose current/future threats as `mechanic.dangerCells`
// or `mechanic.snapshot.dangerCells`.

import {
  BASE_SPEED, BOMB_FUSE, BOMB_THROW_DISTANCE, CELL, COLS, FLAME_TIME, ROWS,
  SPEED_PER_PICKUP, SUDDEN_DEATH_TIME,
} from './constants.js';

const DIRS = Object.freeze([
  Object.freeze({ name: 'up', dc: 0, dr: -1 }),
  Object.freeze({ name: 'right', dc: 1, dr: 0 }),
  Object.freeze({ name: 'down', dc: 0, dr: 1 }),
  Object.freeze({ name: 'left', dc: -1, dr: 0 }),
]);

const SD_STEP = 0.18;
const HOLD_MARGIN = 0.12;
const MAX_SEARCH_DEPTH = COLS * ROWS;

const cellKey = (col, row) => row * COLS + col;
const inBounds = (col, row) => col >= 0 && col < COLS && row >= 0 && row < ROWS;

function idleInput() {
  return {
    up: false, down: false, left: false, right: false,
    bomb: false, action: false,
  };
}

function inputFor(dir, bomb = false, action = false) {
  const input = idleInput();
  if (dir) input[dir.name] = true;
  input.bomb = !!bomb;
  input.action = !!action;
  return input;
}

function finite(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function mix32(value) {
  let x = value >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

function stableSalt(state, player) {
  const seed = finite(state.seed, 1) >>> 0;
  const round = Math.max(1, Math.floor(finite(state.round, 1)));
  const slot = Math.max(0, Math.floor(finite(player.slot, 0)));
  const time = finite(state.time, finite(state.t, 0));
  // Half-second buckets prevent route tie-breaks from flickering every tick,
  // while still letting a stuck bot eventually try an equivalent alternative.
  const timeBucket = Math.max(0, Math.floor(time * 2));
  return mix32(seed ^ Math.imul(round, 0x9e3779b1) ^
    Math.imul(slot + 1, 0x85ebca6b) ^ timeBucket);
}

function orderedDirs(salt, key) {
  const hash = mix32(salt ^ Math.imul(key + 1, 0x27d4eb2d));
  const offset = hash & 3;
  const reverse = (hash & 4) !== 0;
  const dirs = [];
  for (let i = 0; i < DIRS.length; i++) {
    const index = reverse ? (offset - i + 4) & 3 : (offset + i) & 3;
    dirs.push(DIRS[index]);
  }
  return dirs;
}

function playerCell(player) {
  // While gliding, input is next consumed at the target centre, so plan from
  // that cell instead of repeatedly changing intent halfway through a step.
  if (player.stepping && Number.isFinite(player.tx) && Number.isFinite(player.ty)) {
    return {
      col: Math.round(player.tx - 0.5),
      row: Math.round(player.ty - 0.5),
    };
  }
  return {
    col: Math.round(finite(player.x, 0.5) - 0.5),
    row: Math.round(finite(player.y, 0.5) - 0.5),
  };
}

function cellOf(entity) {
  if (Number.isFinite(entity?.col) && Number.isFinite(entity?.row)) {
    return { col: Math.floor(entity.col), row: Math.floor(entity.row) };
  }
  if (Number.isFinite(entity?.x) && Number.isFinite(entity?.y)) {
    return { col: Math.floor(entity.x), row: Math.floor(entity.y) };
  }
  return null;
}

function isOpponent(player, other) {
  if (!other || !other.alive || other.slot === player.slot) return false;
  return player.team == null || other.team == null || player.team !== other.team;
}

function blastFor(grid, bomb) {
  const origin = cellOf(bomb);
  if (!origin || !inBounds(origin.col, origin.row)) {
    return { cells: [], keys: new Set(), bricks: 0 };
  }

  const cells = [origin];
  const keys = new Set([cellKey(origin.col, origin.row)]);
  let bricks = 0;
  const range = Math.max(1, Math.floor(finite(bomb.range, 2)));

  for (const dir of DIRS) {
    let pierceLeft = Math.max(0, Math.floor(finite(bomb.pierce, 0)));
    for (let distance = 1; distance <= range; distance++) {
      const col = origin.col + dir.dc * distance;
      const row = origin.row + dir.dr * distance;
      if (!inBounds(col, row)) break;
      const key = cellKey(col, row);
      const tile = grid[key];
      if (tile === CELL.SOLID) break;
      cells.push({ col, row });
      keys.add(key);
      if (tile !== CELL.BRICK) continue;
      bricks += 1;
      if (pierceLeft <= 0) break;
      pierceLeft -= 1;
    }
  }
  return { cells, keys, bricks };
}

function addDanger(danger, key, start, end, source = 'hazard', owner = null) {
  if (!Number.isInteger(key) || key < 0 || key >= COLS * ROWS) return;
  const from = Math.max(0, finite(start, 0));
  const until = end === Infinity ? Infinity : Math.max(from, finite(end, from));
  const intervals = danger.get(key) || [];
  intervals.push({ start: from, end: until, source, owner });
  danger.set(key, intervals);
}

function effectiveBombTimes(grid, bombs) {
  const blasts = bombs.map((bomb) => blastFor(grid, bomb));
  const times = bombs.map((bomb) => {
    if (bomb.timer === Infinity) return Infinity;
    if (typeof bomb.timer === 'number' && Number.isFinite(bomb.timer)) {
      return Math.max(0, bomb.timer);
    }
    if (bomb.remoteOnly || bomb.awaitingDetonation) return Infinity;
    return BOMB_FUSE;
  });

  // Resolve possible chain reactions without mutating bomb timers.
  for (let pass = 0; pass < bombs.length; pass++) {
    let changed = false;
    for (let i = 0; i < bombs.length; i++) {
      if (!Number.isFinite(times[i])) continue;
      for (let j = 0; j < bombs.length; j++) {
        if (i === j || times[j] <= times[i]) continue;
        const target = cellOf(bombs[j]);
        if (target && blasts[i].keys.has(cellKey(target.col, target.row))) {
          times[j] = times[i];
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  return { blasts, times };
}

function spiralCells() {
  const cells = [];
  let top = 1;
  let bottom = ROWS - 2;
  let left = 1;
  let right = COLS - 2;
  while (top <= bottom && left <= right) {
    for (let col = left; col <= right; col++) cells.push([col, top]);
    for (let row = top + 1; row <= bottom; row++) cells.push([right, row]);
    if (top < bottom) {
      for (let col = right - 1; col >= left; col--) cells.push([col, bottom]);
    }
    if (left < right) {
      for (let row = bottom - 1; row > top; row--) cells.push([left, row]);
    }
    top += 1;
    bottom -= 1;
    left += 1;
    right -= 1;
  }
  return cells;
}

function dangerCellList(item) {
  if (item == null) return [];
  if (Number.isInteger(item)) {
    return [{ col: item % COLS, row: Math.floor(item / COLS) }];
  }
  if (Array.isArray(item)) {
    if (item.length >= 2 && Number.isFinite(item[0]) && Number.isFinite(item[1])) {
      return [{ col: Math.floor(item[0]), row: Math.floor(item[1]) }];
    }
    return item.flatMap(dangerCellList);
  }
  if (Array.isArray(item.cells)) return item.cells.flatMap(dangerCellList);
  const cell = cellOf(item);
  return cell ? [cell] : [];
}

function addMechanicDanger(state, danger) {
  const mechanic = state.mechanic;
  const lists = [
    mechanic?.dangerCells,
    mechanic?.snapshot?.dangerCells,
    state.hazards,
    state.arenaHazards,
  ];

  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (item?.lethal === false || item?.active === false && item?.warning !== true) continue;
      const active = item?.active !== false;
      const start = active
        ? 0
        : Math.max(0, finite(item.startsIn, finite(item.delay, finite(item.timer, 0))));
      const duration = finite(item?.duration, finite(item?.remaining, active
        ? finite(item?.timer, 0.75)
        : 0.75));
      const end = item?.permanent || item?.blocking
        ? Infinity
        : start + Math.max(0.08, duration);
      for (const cell of dangerCellList(item)) {
        if (inBounds(cell.col, cell.row)) {
          addDanger(danger, cellKey(cell.col, cell.row), start, end, 'mechanic');
        }
      }
    }
  }
}

function buildDanger(state, grid, bombs) {
  const danger = new Map();
  const { blasts, times } = effectiveBombTimes(grid, bombs);
  for (let i = 0; i < bombs.length; i++) {
    if (!Number.isFinite(times[i])) continue;
    const owner = bombs[i].owner ?? null;
    for (const cell of blasts[i].cells) {
      addDanger(
        danger,
        cellKey(cell.col, cell.row),
        times[i],
        times[i] + FLAME_TIME,
        'bomb',
        owner,
      );
    }
  }

  for (const flame of state.flames || []) {
    // In live engine state `fresh:false` fire is already decorative. Snapshots
    // omit that bit, so conservatively treat visible fire as briefly dangerous.
    if (flame.fresh === false) continue;
    const cell = cellOf(flame);
    if (!cell) continue;
    addDanger(
      danger,
      cellKey(cell.col, cell.row),
      0,
      Math.max(0.08, finite(flame.timer, FLAME_TIME)),
      'flame',
    );
  }

  addMechanicDanger(state, danger);

  const now = finite(state.time, finite(state.t, 0));
  const suddenDeathAt = finite(state.rules?.suddenDeathSeconds, SUDDEN_DEATH_TIME);
  let spiral = Array.isArray(state.spiral) ? state.spiral : null;
  let index = Math.max(0, Math.floor(finite(state.spiralIdx, 0)));
  let firstDrop = Math.max(0, finite(state.spiralTimer, 0));
  if (!spiral && now >= suddenDeathAt - 1.5) {
    spiral = spiralCells().filter(([col, row]) => grid[cellKey(col, row)] !== CELL.SOLID);
    index = 0;
    firstDrop = Math.max(0, suddenDeathAt - now);
  }
  if (spiral) {
    for (let i = index; i < spiral.length; i++) {
      const [col, row] = spiral[i];
      addDanger(
        danger,
        cellKey(col, row),
        firstDrop + (i - index) * SD_STEP,
        Infinity,
        'sudden-death',
      );
    }
  }

  return { danger, bombData: { blasts, times } };
}

function powerupKeys(powerups) {
  const keys = new Set();
  if (powerups instanceof Map) {
    for (const rawKey of powerups.keys()) {
      const key = Number(rawKey);
      if (Number.isInteger(key)) keys.add(key);
    }
    return keys;
  }
  if (Array.isArray(powerups)) {
    for (const powerup of powerups) {
      const cell = cellOf(powerup);
      if (cell && inBounds(cell.col, cell.row)) keys.add(cellKey(cell.col, cell.row));
    }
  }
  return keys;
}

function makeContext(state, player) {
  const grid = state.grid || [];
  const bombs = Array.isArray(state.bombs) ? state.bombs : [];
  const dangerData = buildDanger(state, grid, bombs);
  const speed = BASE_SPEED +
    Math.max(0, finite(player.speedPicks, 0)) * SPEED_PER_PICKUP;
  return {
    state,
    player,
    grid,
    bombs,
    players: Array.isArray(state.players) ? state.players : [],
    danger: dangerData.danger,
    bombData: dangerData.bombData,
    powerups: powerupKeys(state.powerups),
    stepTime: 1 / Math.max(1, speed),
    salt: stableSalt(state, player),
  };
}

function intervalOverlaps(interval, from, until) {
  return interval.start <= until + HOLD_MARGIN && interval.end >= from - HOLD_MARGIN;
}

function isDangerous(ctx, key, from, until = from) {
  const intervals = ctx.danger.get(key);
  return !!intervals?.some((interval) => intervalOverlaps(interval, from, until));
}

function nextThreat(ctx, key, horizon) {
  let best = null;
  for (const interval of ctx.danger.get(key) || []) {
    if (interval.end < 0 || interval.start > horizon) continue;
    if (!best || interval.start < best.start ||
        interval.start === best.start && interval.end > best.end) {
      best = interval;
    }
  }
  return best;
}

function bombClearsAt(ctx, key) {
  let clearAt = -1;
  for (let i = 0; i < ctx.bombs.length; i++) {
    const cell = cellOf(ctx.bombs[i]);
    if (!cell || cellKey(cell.col, cell.row) !== key) continue;
    const timer = ctx.bombData.times[i];
    clearAt = Number.isFinite(timer) ? Math.max(clearAt, timer + FLAME_TIME) : Infinity;
  }
  return clearAt;
}

function canEnter(ctx, col, row, arrival, startKey, extraBlocked) {
  if (!inBounds(col, row)) return false;
  const key = cellKey(col, row);
  const tile = ctx.grid[key];
  if (tile === CELL.SOLID) return false;
  if (tile === CELL.BRICK) {
    const ghostLeft = Math.max(0, finite(ctx.player.ghost, 0) - arrival);
    if (ghostLeft <= 0 && key !== startKey) return false;
  }
  if (extraBlocked?.has(key) && key !== startKey) return false;
  const clears = bombClearsAt(ctx, key);
  if (clears >= 0 && arrival < clears && key !== startKey) return false;
  return true;
}

function transitionSafe(ctx, node, nextKey, arrival) {
  const halfway = node.arrival + (arrival - node.arrival) * 0.5;
  // If the bot is already standing in an active mechanic cell, moving out is
  // always better than freezing there. Later path segments remain strict.
  const mayExitActiveStart = node.depth === 0 &&
    isDangerous(ctx, node.key, 0, 0);
  return (mayExitActiveStart || !isDangerous(ctx, node.key, node.arrival, halfway)) &&
    !isDangerous(ctx, nextKey, halfway, arrival + 0.04);
}

function explore(ctx, start, { extraBlocked = null, maxDepth = MAX_SEARCH_DEPTH } = {}) {
  const startKey = cellKey(start.col, start.row);
  const root = {
    col: start.col, row: start.row, key: startKey,
    depth: 0, arrival: 0, first: null,
  };
  const nodes = new Map([[startKey, root]]);
  const queue = [root];

  for (let head = 0; head < queue.length; head++) {
    const node = queue[head];
    if (node.depth >= maxDepth) continue;
    for (const dir of orderedDirs(ctx.salt, node.key)) {
      const col = node.col + dir.dc;
      const row = node.row + dir.dr;
      const key = cellKey(col, row);
      if (nodes.has(key)) continue;
      const arrival = (node.depth + 1) * ctx.stepTime;
      if (!canEnter(ctx, col, row, arrival, startKey, extraBlocked)) continue;
      if (!transitionSafe(ctx, node, key, arrival)) continue;
      const next = {
        col, row, key, arrival,
        depth: node.depth + 1,
        first: node.first || dir,
      };
      nodes.set(key, next);
      queue.push(next);
    }
  }
  return { nodes, queue };
}

function findEscape(ctx, start, threat, extraBlocked = null) {
  const maxDepth = Math.min(MAX_SEARCH_DEPTH, Math.ceil(
    (Math.min(3.2, Math.max(1.2, threat.start + 1.0))) / ctx.stepTime,
  ));
  const search = explore(ctx, start, { extraBlocked, maxDepth });
  const holdUntil = Math.min(3.2, Math.max(1.1, threat.start + FLAME_TIME + 0.2));

  for (const node of search.queue) {
    if (node.depth === 0 || node.arrival >= holdUntil) continue;
    if (!isDangerous(ctx, node.key, node.arrival, holdUntil)) return node.first;
  }

  // If every complete route is compromised, still choose the neighbouring cell
  // whose next threat is latest instead of freezing on the blast line.
  let fallback = null;
  for (const node of search.queue) {
    if (node.depth !== 1) continue;
    const danger = nextThreat(ctx, node.key, 4);
    const safeUntil = danger ? danger.start : Infinity;
    const rank = mix32(ctx.salt ^ node.key);
    if (!fallback || safeUntil > fallback.safeUntil ||
        safeUntil === fallback.safeUntil && rank < fallback.rank) {
      fallback = { dir: node.first, safeUntil, rank };
    }
  }
  return fallback?.dir || null;
}

function opponentsIn(ctx, keys) {
  let count = 0;
  for (const other of ctx.players) {
    if (!isOpponent(ctx.player, other)) continue;
    const cell = cellOf(other);
    if (cell && keys.has(cellKey(cell.col, cell.row))) count += 1;
  }
  return count;
}

function bombOpportunity(ctx, col, row) {
  const blast = blastFor(ctx.grid, {
    col, row,
    range: ctx.player.range,
    pierce: ctx.player.pierce,
  });
  return {
    blast,
    enemyHits: opponentsIn(ctx, blast.keys),
    brickHits: blast.bricks,
  };
}

function activeBombCount(ctx) {
  return ctx.bombs.reduce(
    (count, bomb) => count + (bomb.owner === ctx.player.slot ? 1 : 0),
    0,
  );
}

function readyToBomb(ctx, start) {
  if (ctx.player.stepping || finite(ctx.player.bombLock, 0) > 0) return false;
  if (activeBombCount(ctx) >= Math.max(1, finite(ctx.player.maxBombs, 1))) return false;
  return !ctx.bombs.some((bomb) => {
    const cell = cellOf(bomb);
    return cell?.col === start.col && cell?.row === start.row;
  });
}

function bombEscape(ctx, start) {
  const key = cellKey(start.col, start.row);
  let fuse = BOMB_FUSE;
  for (const interval of ctx.danger.get(key) || []) {
    if (interval.source === 'bomb') fuse = Math.min(fuse, interval.start);
  }
  if (fuse < ctx.stepTime * 1.5) return null;

  const hypothetical = blastFor(ctx.grid, {
    col: start.col,
    row: start.row,
    range: ctx.player.range,
    pierce: ctx.player.pierce,
  });
  const extraBlocked = new Set([key]);
  const maxDepth = Math.min(
    MAX_SEARCH_DEPTH,
    Math.max(1, Math.floor((fuse - HOLD_MARGIN) / ctx.stepTime)),
  );
  const search = explore(ctx, start, { extraBlocked, maxDepth });

  for (const node of search.queue) {
    if (node.depth === 0 || hypothetical.keys.has(node.key)) continue;
    if (node.arrival >= fuse - HOLD_MARGIN) continue;
    if (!isDangerous(ctx, node.key, node.arrival, fuse + FLAME_TIME)) {
      return node.first;
    }
  }
  return null;
}

function hasRemoteDetonator(player) {
  return !!(player.remote || player.detonator || player.remoteDetonator ||
    player.hasRemote || player.remoteBombs);
}

function actionWouldThrow(ctx) {
  const player = ctx.player;
  if (!player.throwBombs || player.stepping) return false;
  const facing = DIRS.find((dir) => dir.name === player.dir) || DIRS[2];
  const playerPos = playerCell(player);
  const col = playerPos.col + facing.dc;
  const row = playerPos.row + facing.dr;
  const bomb = ctx.bombs.find((candidate) => {
    const cell = cellOf(candidate);
    return cell?.col === col && cell?.row === row &&
      !(candidate.airTime > 0) && !candidate.vx && !candidate.vy;
  });
  if (!bomb) return false;

  // Mirrors the engine's throw landing scan. If no landing exists the action
  // falls through to remote detonation, so it is safe to request.
  for (let distance = 1; distance <= BOMB_THROW_DISTANCE; distance++) {
    const landingCol = col + facing.dc * distance;
    const landingRow = row + facing.dr * distance;
    if (!inBounds(landingCol, landingRow)) break;
    if (ctx.grid[cellKey(landingCol, landingRow)] !== CELL.EMPTY) continue;
    const occupied = ctx.bombs.some((candidate) => {
      if (candidate === bomb) return false;
      const cell = cellOf(candidate);
      return cell?.col === landingCol && cell?.row === landingRow;
    });
    if (!occupied) return true;
  }
  return false;
}

function usefulRemoteDetonation(ctx, startKey) {
  if (!hasRemoteDetonator(ctx.player) &&
      !ctx.bombs.some((bomb) => bomb.owner === ctx.player.slot && bomb.remote === true)) {
    return false;
  }
  if (actionWouldThrow(ctx)) return false;

  const ordered = ctx.bombs
    .map((bomb, index) => ({ bomb, index }))
    .filter(({ bomb }) =>
      bomb.owner === ctx.player.slot && bomb.remote === true && finite(bomb.timer, 0) > 0)
    .sort((a, b) => {
      const aid = finite(a.bomb.id, cellKey(cellOf(a.bomb)?.col || 0, cellOf(a.bomb)?.row || 0));
      const bid = finite(b.bomb.id, cellKey(cellOf(b.bomb)?.col || 0, cellOf(b.bomb)?.row || 0));
      return aid - bid;
    });

  // The engine always detonates the oldest owned remote bomb, so evaluate that
  // exact bomb rather than choosing an action the engine cannot target.
  const candidate = ordered[0];
  if (!candidate) return false;
  const chain = new Set([candidate.index]);
  const queue = [candidate.index];
  for (let head = 0; head < queue.length; head++) {
    const blast = ctx.bombData.blasts[queue[head]];
    for (let i = 0; i < ctx.bombs.length; i++) {
      if (chain.has(i)) continue;
      const cell = cellOf(ctx.bombs[i]);
      if (cell && blast.keys.has(cellKey(cell.col, cell.row))) {
        chain.add(i);
        queue.push(i);
      }
    }
  }

  const allKeys = new Set();
  let bricks = 0;
  for (const index of chain) {
    const blast = ctx.bombData.blasts[index];
    bricks += blast.bricks;
    for (const key of blast.keys) allKeys.add(key);
  }
  if (allKeys.has(startKey)) return false;
  return opponentsIn(ctx, allKeys) > 0 || bricks >= 1;
}

function actionPulse(state, player, wanted) {
  if (!wanted) return false;
  if (typeof player.actionHeld === 'boolean') return !player.actionHeld;
  // Network snapshots intentionally omit edge-trigger bookkeeping. Emit one
  // deterministic pulse frame out of four so a snapshot-driven integration
  // still releases the button between consecutive remote bombs.
  const time = finite(state.time, finite(state.t, 0));
  return (Math.max(0, Math.floor(time * 60)) & 3) === 0;
}

function betterCandidate(candidate, best, salt) {
  if (!best) return true;
  for (let i = 0; i < candidate.score.length; i++) {
    if (candidate.score[i] !== best.score[i]) {
      return candidate.score[i] < best.score[i];
    }
  }
  return mix32(salt ^ candidate.node.key) < mix32(salt ^ best.node.key);
}

function chooseObjective(ctx, search, startKey, canBomb) {
  let bestPowerup = null;
  let bestTactical = null;
  let bestBrick = null;
  let bestApproach = null;
  const opponents = ctx.players
    .filter((other) => isOpponent(ctx.player, other))
    .map(cellOf)
    .filter(Boolean);

  for (const node of search.queue) {
    if (node.depth > 0 && ctx.powerups.has(node.key)) {
      const candidate = { node, score: [node.depth] };
      if (betterCandidate(candidate, bestPowerup, ctx.salt)) bestPowerup = candidate;
    }

    if (canBomb && !ctx.bombs.some((bomb) => {
      const cell = cellOf(bomb);
      return cell?.col === node.col && cell?.row === node.row;
    })) {
      const opportunity = bombOpportunity(ctx, node.col, node.row);
      if (opportunity.enemyHits > 0) {
        const candidate = {
          node,
          score: [node.depth, -opportunity.enemyHits, -opportunity.brickHits],
        };
        if (betterCandidate(candidate, bestTactical, ctx.salt)) bestTactical = candidate;
      } else if (opportunity.brickHits > 0) {
        const candidate = { node, score: [node.depth, -opportunity.brickHits] };
        if (betterCandidate(candidate, bestBrick, ctx.salt)) bestBrick = candidate;
      }
    }

    if (opponents.length) {
      const opponentDistance = Math.min(...opponents.map(
        (cell) => Math.abs(cell.col - node.col) + Math.abs(cell.row - node.row),
      ));
      const candidate = { node, score: [opponentDistance, node.depth] };
      if (betterCandidate(candidate, bestApproach, ctx.salt)) bestApproach = candidate;
    }
  }

  // Loose upgrades are safest and most valuable. A direct bomb line on an
  // opponent comes next, then opening terrain, then simply closing distance.
  return bestPowerup || bestTactical || bestBrick ||
    (bestApproach?.node.key !== startKey ? bestApproach : null);
}

/**
 * Choose one deterministic human-shaped input frame for `player`.
 *
 * @param {object} state authoritative engine state or `toSnapshot()` result
 * @param {object} player a player object belonging to that state
 * @returns {{up:boolean,down:boolean,left:boolean,right:boolean,bomb:boolean,action:boolean}}
 */
export function decideBotInput(state, player) {
  if (!state || !player || !player.alive || state.phase !== 'playing') {
    return idleInput();
  }
  const start = playerCell(player);
  if (!inBounds(start.col, start.row)) return idleInput();

  const ctx = makeContext(state, player);
  const startKey = cellKey(start.col, start.row);
  const imminentWindow = Math.max(1.35, ctx.stepTime * 6);
  const threat = nextThreat(ctx, startKey, imminentWindow);
  if (threat) {
    return inputFor(findEscape(ctx, start, threat));
  }

  const action = actionPulse(state, player, usefulRemoteDetonation(ctx, startKey));
  const canBomb = readyToBomb(ctx, start);
  if (canBomb) {
    const opportunity = bombOpportunity(ctx, start.col, start.row);
    if (opportunity.enemyHits > 0 || opportunity.brickHits > 0) {
      const escape = bombEscape(ctx, start);
      if (escape) return inputFor(escape, true, action);
    }
  }

  const search = explore(ctx, start);
  const objective = chooseObjective(ctx, search, startKey, canBomb);
  return inputFor(objective?.node.first || null, false, action);
}
