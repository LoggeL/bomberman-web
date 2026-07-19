// Room / lobby / match management for the authoritative Bomberman server.
//
// A "room" is a lobby of up to MAX_PLAYERS sockets identified by a short code.
// Each member occupies a fixed slot (0..MAX_PLAYERS-1) that maps directly onto
// the engine's player slot (spawn corner, color, name). The first member is the
// host: only the host can trigger START (when everyone is ready) and RESTART.
//
// The engine is the single source of truth for gameplay. This module owns:
//   - membership (join / leave / disconnect, slot allocation, host handoff)
//   - the lobby ready handshake
//   - the fixed-timestep simulation loop and snapshot broadcast throttling
//
// All wire framing goes through shared/protocol.js so the contract stays in one
// place.

import {
  MSG, SNAPSHOT_HZ, ROOM_CODE_LEN, encode,
} from '../shared/protocol.js';
import {
  MIN_PLAYERS, MAX_PLAYERS, TICK_DT, TICK_HZ,
} from '../shared/constants.js';
import { createGame, step, setInput, toSnapshot } from '../shared/engine.js';

// Default round wins that decide a match. The room creator (host) may override
// this via the JOIN payload; clampWins keeps it in a sane range.
const WINS_TO_WIN = 3;
function clampWins(n) {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v)) return WINS_TO_WIN;
  return Math.max(1, Math.min(9, v));
}

// Idle input applied to a player whose socket has gone away mid-match.
const IDLE_INPUT = { up: false, down: false, left: false, right: false, bomb: false };

// Clients send input only when it changes. Keep a short ordered queue so two
// transitions received between simulation ticks (notably press -> release) are
// both observed by the engine. The bound prevents a noisy client from building
// an ever-growing input backlog; under overload, favour recent intent.
const MAX_INPUT_QUEUE = 32;

// Drive the sim interval a touch faster than a single tick so the accumulator
// always has work to do; the fixed-step loop keeps the actual rate exact.
const SIM_INTERVAL_MS = 1000 / TICK_HZ; // ~16.67ms
const SNAPSHOT_INTERVAL = 1 / SNAPSHOT_HZ; // seconds between broadcasts

// Room codes avoid visually ambiguous characters (no I/O/0/1, etc.).
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

// ---- room registry -----------------------------------------------------------

/** @type {Map<string, Room>} code -> Room */
const rooms = new Map();

function makeRoomCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < ROOM_CODE_LEN; i++) {
      code += CODE_ALPHABET[(Math.random() * CODE_ALPHABET.length) | 0];
    }
  } while (rooms.has(code));
  return code;
}

// A unique-ish seed per match. Math.random + Date.now are fine on the server.
function makeSeed() {
  return ((Date.now() ^ (Math.random() * 0xffffffff)) >>> 0);
}

// ---- Room --------------------------------------------------------------------

class Room {
  constructor(code) {
    this.code = code;
    this.winsToWin = WINS_TO_WIN; // set by the host when the room is created
    // members: array indexed by slot. null = free slot.
    /** @type {(Member|null)[]} */
    this.members = new Array(MAX_PLAYERS).fill(null);
    this.hostSlot = null;

    // Active match (null while in lobby).
    this.game = null;
    this.timer = null;        // setInterval handle for the sim loop
    this.lastTickAt = 0;      // ms timestamp of the previous loop iteration
    this.accumulator = 0;     // leftover seconds awaiting a fixed step
    this.snapAccumulator = 0; // seconds since the last snapshot broadcast
    this.lastSnapshotPhase = null;
    this.lastSnapshotRound = null;
  }

  // First free slot, or -1 if the room is full.
  freeSlot() {
    return this.members.findIndex((m) => m === null);
  }

  get memberList() {
    return this.members.filter((m) => m !== null);
  }

  get count() {
    return this.memberList.length;
  }

  get inGame() {
    return this.game !== null;
  }

  // ---- membership ----

  add(socket, name) {
    const slot = this.freeSlot();
    if (slot === -1) return null; // full
    const member = {
      socket,
      slot,
      name: name || `P${slot + 1}`,
      ready: false,
      input: IDLE_INPUT,
      inputQueue: [],
    };
    this.members[slot] = member;
    if (this.hostSlot === null) this.hostSlot = slot;
    return member;
  }

  remove(slot) {
    const member = this.members[slot];
    if (!member) return;
    this.members[slot] = null;

    // If the room is mid-match, neutralise the departed player's input so the
    // engine sees them standing still rather than holding their last keys.
    if (this.game) setInput(this.game, slot, IDLE_INPUT);

    // Hand off host duty to the lowest remaining slot.
    if (this.hostSlot === slot) {
      const next = this.memberList[0];
      this.hostSlot = next ? next.slot : null;
    }
  }

  // ---- lobby ----

  // canStart = enough players AND everyone ready.
  canStart() {
    const list = this.memberList;
    return list.length >= MIN_PLAYERS && list.every((m) => m.ready);
  }

  lobbyPayload() {
    return {
      room: this.code,
      host: this.hostSlot,
      players: this.memberList.map((m) => ({
        slot: m.slot,
        name: m.name,
        ready: m.ready,
      })),
      canStart: this.canStart(),
    };
  }

  broadcast(raw, { dropIfBuffered = false } = {}) {
    for (const m of this.memberList) {
      // ws readyState 1 === OPEN
      if (m.socket.readyState !== 1) continue;
      // Snapshots are complete world states, so an older queued snapshot has no
      // value. Skip this one for a slow socket instead of extending its backlog;
      // reliable lifecycle/lobby messages still use the non-droppable default.
      if (dropIfBuffered && m.socket.bufferedAmount > 0) continue;
      m.socket.send(raw);
    }
  }

  broadcastLobby() {
    this.broadcast(encode(MSG.LOBBY, this.lobbyPayload()));
  }

  // ---- match lifecycle ----

  // Build a fresh game from the current membership and begin the sim loop.
  startMatch() {
    const playerDefs = this.memberList.map((m) => ({
      id: `slot${m.slot}`,
      slot: m.slot,
      name: m.name,
    }));
    this.game = createGame(playerDefs, { seed: makeSeed(), winsToWin: this.winsToWin });

    // Reset both the engine and the member-side held/queued input. Resetting only
    // the engine would let tick() immediately reapply a stale key from the
    // previous match.
    for (const m of this.memberList) {
      m.input = IDLE_INPUT;
      m.inputQueue.length = 0;
      setInput(this.game, m.slot, IDLE_INPUT);
    }

    this.broadcast(encode(MSG.START, { winsToWin: this.winsToWin }));
    this.startLoop();
  }

  // Restart only makes sense once a match has fully resolved.
  restartMatch() {
    if (!this.game || this.game.phase !== 'matchover' || this.count < MIN_PLAYERS) return false;
    this.stopLoop();
    // Wipe ready flags and scores by rebuilding the game from scratch.
    this.startMatch();
    return true;
  }

  startLoop() {
    this.stopLoop();
    this.lastTickAt = Date.now();
    this.accumulator = 0;
    this.snapAccumulator = 0;
    this.lastSnapshotPhase = null;
    this.lastSnapshotRound = null;
    this.timer = setInterval(() => this.tick(), SIM_INTERVAL_MS);
    // Push one snapshot immediately so clients render the initial world.
    this.broadcastSnapshot();
  }

  stopLoop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // Fixed-timestep loop: accumulate real elapsed time and consume it in whole
  // TICK_DT chunks so the simulation rate is independent of timer jitter.
  tick() {
    if (!this.game) return;

    const now = Date.now();
    let elapsed = (now - this.lastTickAt) / 1000; // seconds
    this.lastTickAt = now;

    // Clamp huge gaps (e.g. the event loop stalled) so we never spiral trying
    // to catch up an unbounded number of steps at once.
    if (elapsed > 0.25) elapsed = 0.25;
    this.accumulator += elapsed;

    while (this.accumulator >= TICK_DT) {
      // Consume at most one transition per simulation step, then keep holding it
      // until another transition arrives. This preserves short taps whose press
      // and release reached the socket within the same timer interval.
      for (const m of this.memberList) {
        if (m.inputQueue.length > 0) m.input = m.inputQueue.shift();
        setInput(this.game, m.slot, m.input);
      }
      step(this.game, TICK_DT);
      this.accumulator -= TICK_DT;
    }

    // Throttle snapshots to SNAPSHOT_HZ, independent of the sim rate.
    this.snapAccumulator += elapsed;
    if (this.snapAccumulator >= SNAPSHOT_INTERVAL) {
      // Preserve fractional overshoot so timer jitter cannot slowly drag the
      // effective broadcast rate below SNAPSHOT_HZ. Discard whole missed
      // intervals after a stall; snapshots are full states, so bursts add no
      // value.
      this.snapAccumulator %= SNAPSHOT_INTERVAL;
      this.broadcastSnapshot();
    }
  }

  broadcastSnapshot() {
    if (!this.game) return;
    const snap = toSnapshot(this.game);
    const lifecycleChanged = snap.phase !== this.lastSnapshotPhase ||
      snap.round !== this.lastSnapshotRound;
    this.broadcast(
      encode(MSG.SNAPSHOT, { snap }),
      // Round/match results and fresh-round spawns exist only in snapshots. They
      // are reliable boundaries; only redundant steady-state updates may drop.
      { dropIfBuffered: !lifecycleChanged },
    );
    this.lastSnapshotPhase = snap.phase;
    this.lastSnapshotRound = snap.round;
  }

  // Tear everything down (room is being deleted).
  destroy() {
    this.stopLoop();
    this.game = null;
  }
}

// ---- public API (used by the WebSocket layer) --------------------------------

// Every connected socket carries a small bit of session state we hang off it.
// `attach` initialises that. The server calls handleMessage / handleClose.

export function attach(socket) {
  socket._room = null;   // Room instance once joined
  socket._slot = null;   // this socket's slot in that room
}

// Convenience: send an ERROR frame to a single socket.
function sendError(socket, message) {
  if (socket.readyState === 1) socket.send(encode(MSG.ERROR, { message }));
}

function onPing(socket, msg) {
  if (socket.readyState !== 1 || !Number.isSafeInteger(msg.id)) return;
  socket.send(encode(MSG.PONG, { id: msg.id }));
}

// Dispatch a decoded client message. `msg` is the object from decode().
export function handleMessage(socket, msg) {
  if (!msg || typeof msg.type !== 'string') return; // malformed / non-object

  switch (msg.type) {
    case MSG.PING:
      return onPing(socket, msg);
    case MSG.JOIN:
      return onJoin(socket, msg);
    case MSG.INPUT:
      return onInput(socket, msg);
    case MSG.READY:
      return onReady(socket, msg);
    case MSG.RESTART:
      return onRestart(socket);
    case MSG.LEAVE:
      return onLeave(socket);
    default:
      // Unknown type: ignore quietly (forward-compat) but only if joined.
      return;
  }
}

function onJoin(socket, msg) {
  // Re-joining while already in a room is not allowed.
  if (socket._room) {
    sendError(socket, 'Already in a room.');
    return;
  }

  const name = typeof msg.name === 'string' ? msg.name.slice(0, 16).trim() : '';
  const requested = typeof msg.room === 'string' ? msg.room.trim().toUpperCase() : '';

  let room;
  if (requested === '') {
    // Create a brand new room; this socket becomes its host and picks the
    // match length.
    room = new Room(makeRoomCode());
    room.winsToWin = clampWins(msg.winsToWin);
    rooms.set(room.code, room);
  } else {
    room = rooms.get(requested);
    if (!room) {
      sendError(socket, `Room ${requested} not found.`);
      return;
    }
    if (room.inGame) {
      sendError(socket, 'That match has already started.');
      return;
    }
    if (room.freeSlot() === -1) {
      sendError(socket, 'Room is full.');
      return;
    }
  }

  const member = room.add(socket, name);
  if (!member) {
    // Race: filled between the check and the add. Clean up if we just made it.
    if (requested === '' && room.count === 0) {
      rooms.delete(room.code);
    }
    sendError(socket, 'Room is full.');
    return;
  }

  socket._room = room;
  socket._slot = member.slot;

  socket.send(encode(MSG.JOINED, {
    room: room.code,
    slot: member.slot,
    host: room.hostSlot === member.slot,
  }));
  room.broadcastLobby();
}

function onInput(socket, msg) {
  const room = socket._room;
  if (!room) return; // not joined yet
  const member = room.members[socket._slot];
  if (!member) return;

  const inp = msg.input;
  if (!inp || typeof inp !== 'object') return;
  // Coerce to clean booleans so a malformed payload can't poison the engine.
  const clean = {
    up: !!inp.up,
    down: !!inp.down,
    left: !!inp.left,
    right: !!inp.right,
    bomb: !!inp.bomb,
  };

  // Ignore duplicate states (the browser already dedupes, but the server must
  // not trust clients to do so). Otherwise queue the transition in wire order.
  const previous = member.inputQueue[member.inputQueue.length - 1] || member.input;
  if (sameInput(previous, clean)) return;
  member.inputQueue.push(clean);
  if (member.inputQueue.length > MAX_INPUT_QUEUE) member.inputQueue.shift();
}

function sameInput(a, b) {
  return a.up === b.up && a.down === b.down && a.left === b.left &&
         a.right === b.right && a.bomb === b.bomb;
}

function onReady(socket, msg) {
  const room = socket._room;
  if (!room) return;
  const member = room.members[socket._slot];
  if (!member) return;

  member.ready = !!msg.ready;
  room.broadcastLobby();

  // The host implicitly triggers start once the lobby is fully ready.
  if (!room.inGame && room.hostSlot === member.slot && room.canStart()) {
    room.startMatch();
  }
}

function onRestart(socket) {
  const room = socket._room;
  if (!room) return;
  // Only the host may restart, and only after the match is over.
  if (room.hostSlot !== socket._slot) return;
  if (room.game?.phase === 'matchover' && room.count < MIN_PLAYERS) {
    sendError(socket, 'At least two players are required for a rematch.');
    return;
  }
  room.restartMatch();
}

function onLeave(socket) {
  leaveRoom(socket);
}

// Socket dropped (close/error). Same teardown as an explicit LEAVE.
export function handleClose(socket) {
  leaveRoom(socket);
}

// Remove a socket from its room and reconcile host / emptiness.
function leaveRoom(socket) {
  const room = socket._room;
  if (!room) return;
  const slot = socket._slot;

  socket._room = null;
  socket._slot = null;

  room.remove(slot);

  if (room.count === 0) {
    // No players left: stop the loop and drop the room entirely.
    room.destroy();
    rooms.delete(room.code);
    return;
  }

  // Otherwise let the remaining members know membership/host changed.
  room.broadcastLobby();
}

// Exposed for diagnostics / tests.
export function roomCount() {
  return rooms.size;
}
