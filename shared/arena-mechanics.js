// Deterministic, framework-agnostic arena mechanics.
//
// Integration contract
// --------------------
// 1. Create one mechanic immediately after generating a round:
//
//      state.arenaMechanic = createArenaMechanic(
//        { id: state.arenaId, theme: state.arenaTheme },
//      );
//      prepareArenaMechanic(state.arenaMechanic, state);
//
//    `prepareArenaMechanic` reserves the mechanic's floor cells. It is
//    idempotent and is also called lazily by `stepArenaMechanic`, but calling it
//    during round creation ensures the very first snapshot already has the
//    correct terrain. The world may expose `clearCell(col, row, meta)` for
//    bookkeeping; the module also clears `grid`, `hidden`, and `powerups`
//    directly when those conventional engine fields are present.
//
// 2. Before moving each player, pass their raw input through:
//
//      const input = arenaMechanicInput(mechanic, player, rawInput, state);
//
//    Only the frost mechanic changes input. It preserves non-directional input
//    (notably `bomb`) while carrying a moving player forward across ice.
//
// 3. Once per fixed simulation tick, after entity movement, call:
//
//      const events = stepArenaMechanic(mechanic, state, dt);
//
//    The world shape is deliberately small:
//      grid      Uint8Array | number[] of CELL values
//      players   objects with slot/id, x/y, dir, alive, moving, stepping
//      bombs     objects with id, col/row, x/y, vx/vy, timer
//
//    Optional callbacks:
//      clearCell(col, row, meta)
//        Notification/bookkeeping hook when a reserved mechanic cell is opened.
//      canPlayerEnter(player, col, row) -> boolean
//        Overrides the frost mechanic's normal grid/bomb collision check.
//      canBombEnter(bomb, col, row) -> boolean
//        Overrides the rail mechanic's normal grid/bomb collision check.
//      kill(player, meta) -> false | void
//        Applies arena damage. Return false when a shield/invulnerability
//        absorbs the hit. Without this callback the module sets alive=false.
//      ignite(col, row, meta)
//        One-shot lava activation notification for flame/SFX integration. It
//        does not replace `kill`; this avoids coupling hazards to blast rules.
//      onMechanicEvent(event)
//        Receives the same plain events returned from stepArenaMechanic.
//
// 4. Include `arenaMechanicSnapshot(mechanic)` in the game snapshot. It is plain
//    JSON data and contains everything a renderer needs. Authoritative mechanic
//    state can be reconstructed with `restoreArenaMechanic(snapshot)`.
//
// No random source or wall clock is used here. Given the same arena, initial
// snapshot, world state, dt sequence, and callback results, every mutation and
// emitted event is identical.

import { CELL, COLS, ROWS } from './constants.js';

const VERSION = 1;
const CENTER_EPSILON = 1e-6;
const TIME_EPSILON = 1e-9;
const key = (col, row) => row * COLS + col;
const inBounds = (col, row) => col >= 0 && col < COLS && row >= 0 && row < ROWS;

const PORTALS = [
  { id: 'north', pair: 'south', col: 7, row: 1 },
  { id: 'south', pair: 'north', col: 7, row: 11 },
];
const PORTAL_COOLDOWN = 0.45;

// Only one symmetric vent group is armed at a time. A group stays dormant,
// advertises itself long enough to react, then becomes lethal briefly.
const LAVA_GROUPS = [
  [
    { col: 5, row: 3 }, { col: 9, row: 3 },
    { col: 5, row: 9 }, { col: 9, row: 9 },
  ],
  [
    { col: 3, row: 5 }, { col: 11, row: 5 },
    { col: 3, row: 7 }, { col: 11, row: 7 },
  ],
];
const LAVA_DORMANT_TIME = 2.4;
const LAVA_TELEGRAPH_TIME = 1.2;
const LAVA_ACTIVE_TIME = 0.8;
const LAVA_ACTIVE_AT = LAVA_DORMANT_TIME + LAVA_TELEGRAPH_TIME;
const LAVA_CYCLE = LAVA_ACTIVE_AT + LAVA_ACTIVE_TIME;

// The citadel's open central cross becomes a continuous ice lane.
const ICE_CELLS = [
  ...Array.from({ length: 9 }, (_, i) => ({ col: i + 3, row: 6 })),
  ...Array.from({ length: 9 }, (_, i) => ({ col: 7, row: i + 2 })),
];

// Four short one-way conveyors in the switchyard. Endpoint cells intentionally
// have a zero vector, so bombs stop on the final belt tile instead of being
// pushed into ordinary floor.
const RAILS = [
  ...Array.from({ length: 5 }, (_, i) => ({
    track: 'north', col: i + 5, row: 3, dx: i < 4 ? 1 : 0, dy: 0,
  })),
  ...Array.from({ length: 5 }, (_, i) => ({
    track: 'south', col: i + 5, row: 9, dx: i > 0 ? -1 : 0, dy: 0,
  })),
  ...Array.from({ length: 3 }, (_, i) => ({
    track: 'west', col: 3, row: i + 5, dx: 0, dy: i < 2 ? 1 : 0,
  })),
  ...Array.from({ length: 3 }, (_, i) => ({
    track: 'east', col: 11, row: i + 5, dx: 0, dy: i > 0 ? -1 : 0,
  })),
];
const RAIL_STEP_TIME = 0.4;

const ARENA_ALIASES = {
  classic: { arenaId: 'classic', theme: 'neon', kind: 'portals' },
  neon: { arenaId: 'classic', theme: 'neon', kind: 'portals' },
  crossroads: { arenaId: 'crossroads', theme: 'foundry', kind: 'lava' },
  foundry: { arenaId: 'crossroads', theme: 'foundry', kind: 'lava' },
  citadel: { arenaId: 'citadel', theme: 'frost', kind: 'ice' },
  frost: { arenaId: 'citadel', theme: 'frost', kind: 'ice' },
  switchyard: { arenaId: 'switchyard', theme: 'reactor', kind: 'rails' },
  reactor: { arenaId: 'switchyard', theme: 'reactor', kind: 'rails' },
};

function cloneCells(cells) {
  return cells.map((cell) => ({ ...cell }));
}

function uniqueCells(cells) {
  const seen = new Set();
  const result = [];
  for (const cell of cells) {
    const k = key(cell.col, cell.row);
    if (seen.has(k)) continue;
    seen.add(k);
    result.push({ col: cell.col, row: cell.row });
  }
  return result.sort((a, b) => key(a.col, a.row) - key(b.col, b.row));
}

function resolveArena(arenaLike) {
  const id = typeof arenaLike === 'object' && arenaLike
    ? String(arenaLike.id || '').toLowerCase()
    : String(arenaLike || '').toLowerCase();
  const theme = typeof arenaLike === 'object' && arenaLike
    ? String(arenaLike.theme || '').toLowerCase()
    : '';
  return ARENA_ALIASES[id] || ARENA_ALIASES[theme] || {
    arenaId: id || 'unknown',
    theme: theme || null,
    kind: 'none',
  };
}

function mechanicCells(mechanic) {
  if (mechanic.kind === 'portals') return mechanic.portals;
  if (mechanic.kind === 'lava') return mechanic.groups.flat();
  if (mechanic.kind === 'ice') return mechanic.cells;
  if (mechanic.kind === 'rails') return mechanic.rails;
  return [];
}

// Creates plain, JSON-compatible authoritative mechanic state. `arenaLike` may
// be an id ("classic"), a theme ("neon"), or `{ id, theme }`.
export function createArenaMechanic(arenaLike) {
  const resolved = resolveArena(arenaLike);
  const mechanic = {
    version: VERSION,
    arenaId: resolved.arenaId,
    theme: resolved.theme,
    kind: resolved.kind,
    elapsed: 0,
    prepared: false,
  };

  if (resolved.kind === 'portals') {
    mechanic.portals = cloneCells(PORTALS);
    mechanic.cooldowns = {};
    mechanic.occupants = {};
    mechanic.cooldownTime = PORTAL_COOLDOWN;
  } else if (resolved.kind === 'lava') {
    mechanic.groups = LAVA_GROUPS.map(cloneCells);
    mechanic.dormantTime = LAVA_DORMANT_TIME;
    mechanic.telegraphTime = LAVA_TELEGRAPH_TIME;
    mechanic.activeTime = LAVA_ACTIVE_TIME;
    mechanic.cycleTime = LAVA_CYCLE;
  } else if (resolved.kind === 'ice') {
    mechanic.cells = uniqueCells(ICE_CELLS);
  } else if (resolved.kind === 'rails') {
    mechanic.rails = cloneCells(RAILS);
    mechanic.stepTime = RAIL_STEP_TIME;
  }

  return mechanic;
}

// Returns the fixed cells that must remain floor for this mechanic. This is
// useful for map validators and renderers that need metadata before the round's
// first simulation step.
export function arenaMechanicReservedCells(mechanic) {
  return uniqueCells(mechanicCells(mechanic || {}));
}

function deleteCellFromStore(store, cellKey, col, row) {
  if (!store) return;
  if (typeof store.delete === 'function') {
    store.delete(cellKey);
    return;
  }
  if (Array.isArray(store)) {
    for (let i = store.length - 1; i >= 0; i--) {
      const item = store[i];
      if (item && item.col === col && item.row === row) store.splice(i, 1);
    }
    return;
  }
  if (typeof store === 'object') delete store[cellKey];
}

// Opens all reserved cells. Safe to call more than once.
export function prepareArenaMechanic(mechanic, world = {}) {
  if (!mechanic || mechanic.prepared) return mechanic;
  for (const cell of arenaMechanicReservedCells(mechanic)) {
    const meta = { source: 'arena-mechanic', kind: mechanic.kind };
    if (typeof world.clearCell === 'function') world.clearCell(cell.col, cell.row, meta);
    if (world.grid && key(cell.col, cell.row) < world.grid.length) {
      world.grid[key(cell.col, cell.row)] = CELL.EMPTY;
    }
    deleteCellFromStore(world.hidden, key(cell.col, cell.row), cell.col, cell.row);
    deleteCellFromStore(world.powerups, key(cell.col, cell.row), cell.col, cell.row);
  }
  mechanic.prepared = true;
  return mechanic;
}

function playerCell(player) {
  if (!player || !Number.isFinite(player.x) || !Number.isFinite(player.y)) return null;
  return { col: Math.floor(player.x), row: Math.floor(player.y) };
}

function playerAtCellCenter(player) {
  if (!player || !Number.isFinite(player.x) || !Number.isFinite(player.y)) return null;
  const col = Math.round(player.x - 0.5);
  const row = Math.round(player.y - 0.5);
  if (Math.abs(player.x - (col + 0.5)) > CENTER_EPSILON ||
      Math.abs(player.y - (row + 0.5)) > CENTER_EPSILON) return null;
  return { col, row };
}

function directionVector(direction) {
  if (direction === 'left') return { dx: -1, dy: 0 };
  if (direction === 'right') return { dx: 1, dy: 0 };
  if (direction === 'up') return { dx: 0, dy: -1 };
  if (direction === 'down') return { dx: 0, dy: 1 };
  return null;
}

function canPlayerEnterFallback(world, player, col, row) {
  if (!inBounds(col, row)) return false;
  const cell = world.grid?.[key(col, row)];
  if (cell === CELL.SOLID) return false;
  if (cell === CELL.BRICK && !(Number(player.ghost) > 0)) return false;
  if (world.bombs?.some((bomb) => bomb.col === col && bomb.row === row)) return false;
  return true;
}

// Applies frost momentum without mutating the raw input object. Call this at the
// same point where the engine would otherwise pass raw input to player movement.
export function arenaMechanicInput(mechanic, player, input = {}, world = {}) {
  if (!mechanic || mechanic.kind !== 'ice' || !player?.alive) return input;
  const cell = playerCell(player);
  const targetCell = player.stepping && Number.isFinite(player.tx) && Number.isFinite(player.ty)
    ? { col: Math.floor(player.tx), row: Math.floor(player.ty) }
    : null;
  const isIce = (candidate) => candidate && mechanic.cells.some(
    (ice) => ice.col === candidate.col && ice.row === candidate.row,
  );
  // Treat an in-progress step *onto* ice as engaged already. Movement can use a
  // small leftover budget after reaching a cell centre; forcing the input for
  // the whole tick prevents that remainder from starting an illegal turn.
  if (!isIce(cell) && !isIce(targetCell)) {
    return input;
  }

  // A player who walked onto ice keeps their last grid direction. If they have
  // stopped against an obstacle, normal input is restored so they cannot become
  // permanently trapped on the lane.
  if (!player.stepping && !player.moving) return input;
  const vector = directionVector(player.dir);
  if (!vector) return input;
  const center = targetCell || playerAtCellCenter(player) || {
    col: Math.round(player.x - 0.5), row: Math.round(player.y - 0.5),
  };
  const col = center.col + vector.dx;
  const row = center.row + vector.dy;
  const canEnter = typeof world.canPlayerEnter === 'function'
    ? world.canPlayerEnter(player, col, row)
    : canPlayerEnterFallback(world, player, col, row);
  if (!canEnter) return input;

  return {
    ...input,
    up: player.dir === 'up',
    down: player.dir === 'down',
    left: player.dir === 'left',
    right: player.dir === 'right',
  };
}

function entityKey(entity, fallback) {
  if (entity?.slot !== undefined) return String(entity.slot);
  if (entity?.id !== undefined) return String(entity.id);
  return String(fallback);
}

function emit(world, events, event) {
  events.push(event);
  if (typeof world.onMechanicEvent === 'function') world.onMechanicEvent(event);
}

function stepPortals(mechanic, world, dt, events) {
  for (const id of Object.keys(mechanic.cooldowns)) {
    const remaining = mechanic.cooldowns[id] - dt;
    if (remaining > TIME_EPSILON) mechanic.cooldowns[id] = remaining;
    else delete mechanic.cooldowns[id];
  }

  const players = world.players || [];
  for (let index = 0; index < players.length; index++) {
    const player = players[index];
    if (!player?.alive) continue;
    const id = entityKey(player, index);
    const cell = playerCell(player);
    if (!cell) continue;
    const source = mechanic.portals.find(
      (portal) => portal.col === cell.col && portal.row === cell.row,
    );
    if (!source) {
      delete mechanic.occupants[id];
      continue;
    }
    // Occupancy latching means a player who pauses on a portal never bounces
    // back when the short jitter cooldown expires. They must leave the tile
    // before either endpoint can trigger again.
    if (mechanic.occupants[id] === source.id) continue;
    if (mechanic.cooldowns[id] > 0) {
      mechanic.occupants[id] = source.id;
      continue;
    }
    const destination = mechanic.portals.find((portal) => portal.id === source.pair);
    if (!destination) continue;
    // Sudden death can eventually seal one endpoint. Never teleport into a
    // closed cell: the player would otherwise survive embedded in a wall after
    // that endpoint had already collapsed on an earlier tick.
    const destinationCell = world.grid?.[key(destination.col, destination.row)];
    if (destinationCell === CELL.SOLID || destinationCell === CELL.BRICK) {
      mechanic.occupants[id] = source.id;
      continue;
    }

    player.x = destination.col + 0.5;
    player.y = destination.row + 0.5;
    player.tx = player.x;
    player.ty = player.y;
    player.stepping = false;
    player.moving = true;
    mechanic.cooldowns[id] = mechanic.cooldownTime;
    mechanic.occupants[id] = destination.id;
    emit(world, events, {
      type: 'portal',
      arenaId: mechanic.arenaId,
      entity: 'player',
      player: player.slot ?? player.id ?? index,
      from: { id: source.id, col: source.col, row: source.row },
      to: { id: destination.id, col: destination.col, row: destination.row },
    });
  }
}

function lavaStateAt(mechanic, elapsed) {
  const safeElapsed = Math.max(0, elapsed);
  const cycle = Math.floor(safeElapsed / mechanic.cycleTime);
  const localTime = safeElapsed - cycle * mechanic.cycleTime;
  let phase = 'dormant';
  if (localTime >= mechanic.dormantTime + mechanic.telegraphTime) phase = 'active';
  else if (localTime >= mechanic.dormantTime) phase = 'telegraph';
  return {
    cycle,
    group: cycle % mechanic.groups.length,
    localTime,
    phase,
  };
}

function damageLavaGroup(mechanic, world, groupIndex, events) {
  const cells = mechanic.groups[groupIndex] || [];
  for (let index = 0; index < (world.players || []).length; index++) {
    const player = world.players[index];
    if (!player?.alive) continue;
    const cell = playerCell(player);
    if (!cell || !cells.some((vent) => vent.col === cell.col && vent.row === cell.row)) {
      continue;
    }
    const meta = {
      source: 'lava',
      arenaId: mechanic.arenaId,
      group: groupIndex,
      col: cell.col,
      row: cell.row,
    };
    const wasAlive = player.alive;
    if (typeof world.kill === 'function') world.kill(player, meta);
    else player.alive = false;
    if (wasAlive && !player.alive) {
      emit(world, events, {
        type: 'lava-hit',
        ...meta,
        player: player.slot ?? player.id ?? index,
      });
    }
  }
}

function stepLava(mechanic, world, oldElapsed, newElapsed, events) {
  const activeGroups = new Set();
  const oldState = lavaStateAt(mechanic, oldElapsed);
  if (oldState.phase === 'active') activeGroups.add(oldState.group);

  // Emit every activation boundary crossed by this step. With the normal fixed
  // tick this loop runs at most once; handling all boundaries keeps restoration
  // and coarse deterministic test steps well-defined.
  let cycle = Math.max(
    0,
    Math.floor((oldElapsed - LAVA_ACTIVE_AT) / mechanic.cycleTime) + 1,
  );
  for (;;) {
    const activation = cycle * mechanic.cycleTime + LAVA_ACTIVE_AT;
    if (activation > newElapsed + TIME_EPSILON) break;
    if (activation > oldElapsed + TIME_EPSILON) {
      const group = cycle % mechanic.groups.length;
      activeGroups.add(group);
      for (const vent of mechanic.groups[group]) {
        const meta = {
          source: 'lava',
          arenaId: mechanic.arenaId,
          group,
          duration: mechanic.activeTime,
        };
        if (typeof world.ignite === 'function') world.ignite(vent.col, vent.row, meta);
      }
      emit(world, events, {
        type: 'lava-activate',
        arenaId: mechanic.arenaId,
        group,
        cells: cloneCells(mechanic.groups[group]),
        duration: mechanic.activeTime,
      });
    }
    cycle += 1;
  }

  const newState = lavaStateAt(mechanic, newElapsed);
  if (newState.phase === 'active') activeGroups.add(newState.group);
  for (const group of activeGroups) damageLavaGroup(mechanic, world, group, events);
}

function canBombEnterFallback(world, self, col, row) {
  if (!inBounds(col, row)) return false;
  const cell = world.grid?.[key(col, row)];
  if (cell === CELL.SOLID || cell === CELL.BRICK) return false;
  return !(world.bombs || []).some(
    (bomb) => bomb !== self && bomb.col === col && bomb.row === row,
  );
}

function stationaryBomb(bomb) {
  if (!bomb || (Number.isFinite(bomb.timer) && bomb.timer <= 0)) return false;
  if ((Number(bomb.vx) || 0) !== 0 || (Number(bomb.vy) || 0) !== 0) return false;
  const x = Number.isFinite(bomb.x) ? bomb.x : bomb.col + 0.5;
  const y = Number.isFinite(bomb.y) ? bomb.y : bomb.row + 0.5;
  return Math.abs(x - (bomb.col + 0.5)) <= CENTER_EPSILON &&
    Math.abs(y - (bomb.row + 0.5)) <= CENTER_EPSILON;
}

function railPulse(mechanic, world, events) {
  const candidates = [];
  for (let index = 0; index < (world.bombs || []).length; index++) {
    const bomb = world.bombs[index];
    if (!stationaryBomb(bomb)) continue;
    const rail = mechanic.rails.find((item) => item.col === bomb.col && item.row === bomb.row);
    if (!rail || (!rail.dx && !rail.dy)) continue;
    candidates.push({ bomb, rail, index });
  }

  // Front-to-back processing makes a line of bombs advance together instead of
  // allowing array order to decide whether the rear bomb sees the front cell as
  // occupied. The stable id/index tie-break makes malformed overlaps deterministic.
  candidates.sort((a, b) => {
    const aForward = a.bomb.col * a.rail.dx + a.bomb.row * a.rail.dy;
    const bForward = b.bomb.col * b.rail.dx + b.bomb.row * b.rail.dy;
    if (aForward !== bForward) return bForward - aForward;
    return String(a.bomb.id ?? a.index).localeCompare(String(b.bomb.id ?? b.index));
  });

  for (const { bomb, rail, index } of candidates) {
    const col = bomb.col + rail.dx;
    const row = bomb.row + rail.dy;
    const canEnter = typeof world.canBombEnter === 'function'
      ? world.canBombEnter(bomb, col, row)
      : canBombEnterFallback(world, bomb, col, row);
    if (!canEnter) continue;

    const from = { col: bomb.col, row: bomb.row };
    bomb.col = col;
    bomb.row = row;
    bomb.x = col + 0.5;
    bomb.y = row + 0.5;
    bomb.vx = 0;
    bomb.vy = 0;
    emit(world, events, {
      type: 'rail-move',
      arenaId: mechanic.arenaId,
      bomb: bomb.id ?? index,
      track: rail.track,
      from,
      to: { col, row },
    });
  }
}

function stepRails(mechanic, world, oldElapsed, newElapsed, events) {
  const oldPulse = Math.floor((oldElapsed + TIME_EPSILON) / mechanic.stepTime);
  const newPulse = Math.floor((newElapsed + TIME_EPSILON) / mechanic.stepTime);
  for (let pulse = oldPulse; pulse < newPulse; pulse++) railPulse(mechanic, world, events);
}

// Advances the active mechanic and mutates only the documented world entity
// fields. Returns plain per-tick events, also mirrored to onMechanicEvent.
export function stepArenaMechanic(mechanic, world = {}, dt = 0) {
  if (!mechanic) return [];
  prepareArenaMechanic(mechanic, world);
  const delta = Number.isFinite(dt) && dt > 0 ? dt : 0;
  if (delta === 0) return [];

  const events = [];
  const oldElapsed = mechanic.elapsed;
  const newElapsed = oldElapsed + delta;
  mechanic.elapsed = newElapsed;

  if (mechanic.kind === 'portals') stepPortals(mechanic, world, delta, events);
  else if (mechanic.kind === 'lava') {
    stepLava(mechanic, world, oldElapsed, newElapsed, events);
  } else if (mechanic.kind === 'rails') {
    stepRails(mechanic, world, oldElapsed, newElapsed, events);
  }
  return events;
}

function cooldownSnapshot(cooldowns) {
  return Object.entries(cooldowns || {})
    .filter(([, remaining]) => Number.isFinite(remaining) && remaining > 0)
    .map(([entity, remaining]) => ({ entity, remaining }))
    .sort((a, b) => a.entity.localeCompare(b.entity));
}

// Plain JSON rendering/persistence state. Static layouts are included so clients
// never need to duplicate arena-coordinate knowledge.
export function arenaMechanicSnapshot(mechanic) {
  if (!mechanic) return null;
  const snapshot = {
    version: VERSION,
    arenaId: mechanic.arenaId,
    theme: mechanic.theme,
    kind: mechanic.kind,
    elapsed: mechanic.elapsed,
    prepared: !!mechanic.prepared,
  };

  if (mechanic.kind === 'portals') {
    snapshot.portals = cloneCells(mechanic.portals);
    snapshot.cooldownTime = mechanic.cooldownTime;
    snapshot.cooldowns = cooldownSnapshot(mechanic.cooldowns);
    snapshot.occupants = Object.entries(mechanic.occupants || {})
      .map(([entity, portal]) => ({ entity, portal }))
      .sort((a, b) => a.entity.localeCompare(b.entity));
  } else if (mechanic.kind === 'lava') {
    const state = lavaStateAt(mechanic, mechanic.elapsed);
    const phaseStarts = {
      dormant: 0,
      telegraph: mechanic.dormantTime,
      active: mechanic.dormantTime + mechanic.telegraphTime,
    };
    const phaseDurations = {
      dormant: mechanic.dormantTime,
      telegraph: mechanic.telegraphTime,
      active: mechanic.activeTime,
    };
    const rawPhaseElapsed = state.localTime - phaseStarts[state.phase];
    const phaseElapsed = Math.abs(rawPhaseElapsed) <= TIME_EPSILON ? 0 : rawPhaseElapsed;
    const phaseDuration = phaseDurations[state.phase];
    snapshot.phase = state.phase;
    snapshot.group = state.group;
    snapshot.phaseElapsed = phaseElapsed;
    snapshot.phaseDuration = phaseDuration;
    snapshot.phaseProgress = phaseDuration > 0
      ? Math.max(0, Math.min(1, phaseElapsed / phaseDuration))
      : 1;
    snapshot.dormantTime = mechanic.dormantTime;
    snapshot.telegraphTime = mechanic.telegraphTime;
    snapshot.activeTime = mechanic.activeTime;
    snapshot.cycleTime = mechanic.cycleTime;
    snapshot.vents = mechanic.groups.flatMap((cells, group) => cells.map((cell) => ({
      ...cell,
      group,
      state: group === state.group ? state.phase : 'dormant',
    })));
  } else if (mechanic.kind === 'ice') {
    snapshot.cells = cloneCells(mechanic.cells);
  } else if (mechanic.kind === 'rails') {
    snapshot.stepTime = mechanic.stepTime;
    snapshot.pulse = (mechanic.elapsed % mechanic.stepTime) / mechanic.stepTime;
    snapshot.rails = cloneCells(mechanic.rails);
  }
  return snapshot;
}

// Rebuilds authoritative state from a previously emitted snapshot. Layout and
// tuning values are derived from the current module instead of trusting network
// data; only genuinely dynamic state is restored.
export function restoreArenaMechanic(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return createArenaMechanic('unknown');
  const mechanic = createArenaMechanic({
    id: snapshot.arenaId,
    theme: snapshot.theme,
  });
  mechanic.elapsed = Number.isFinite(snapshot.elapsed) && snapshot.elapsed >= 0
    ? snapshot.elapsed
    : 0;
  mechanic.prepared = !!snapshot.prepared;

  if (mechanic.kind === 'portals' && Array.isArray(snapshot.cooldowns)) {
    for (const entry of snapshot.cooldowns) {
      if (!entry || !Number.isFinite(entry.remaining) || entry.remaining <= 0) continue;
      mechanic.cooldowns[String(entry.entity)] = entry.remaining;
    }
  }
  if (mechanic.kind === 'portals' && Array.isArray(snapshot.occupants)) {
    for (const entry of snapshot.occupants) {
      if (!entry || !mechanic.portals.some((portal) => portal.id === entry.portal)) continue;
      mechanic.occupants[String(entry.entity)] = entry.portal;
    }
  }
  return mechanic;
}
