// Entry point + state machine. Owns the single requestAnimationFrame loop and
// switches cleanly between three modes:
//   'menu'   — no game running, just menus.
//   'local'  — this client owns a game instance and simulates it.
//   'online' — the server owns the game; we render incoming snapshots.

import { createGame, step, setInput, toSnapshot } from '../../shared/engine.js';
import { TICK_DT } from '../../shared/constants.js';
import { SNAPSHOT_HZ } from '../../shared/protocol.js';
import { createRenderer } from './render.js';
import { createUI } from './ui.js';
import { createLocalInput, createPlayerInput } from './input.js';
import { createNet } from './net.js';

const canvas = document.getElementById('board');
const renderer = createRenderer(canvas);

// ---------------------------------------------------------------------------
// Mutable app state.
// ---------------------------------------------------------------------------
let mode = 'menu';            // 'menu' | 'local' | 'online'

// Local mode.
let localGame = null;         // engine state we own
let localInput = null;        // createLocalInput()
let localSlots = [];          // which slots are human-controlled here
let acc = 0;                  // fixed-timestep accumulator
let lastResultShown = false;  // have we already opened the result overlay?

// Online mode.
let net = null;
let onlineInput = null;       // createPlayerInput()
let mySlot = -1;              // our network slot (from JOINED)
let prevSnap = null;          // for interpolation
let curSnap = null;
let snapRecvTime = 0;         // performance.now() when curSnap arrived
let snapInterval = 1 / SNAPSHOT_HZ; // smoothing window, tied to server rate
let lastSentInput = null;     // dedupe identical INPUT messages
let onlineStarted = false;    // has START been received?
let resultOpenOnline = false;

let lastFrame = performance.now();

// ---------------------------------------------------------------------------
// UI wiring.
// ---------------------------------------------------------------------------
const ui = createUI({
  onStartLocal: startLocal,
  onCreateRoom: (name, wins) => connectAndJoin(name, '', wins),
  onJoinRoom: (name, code) => connectAndJoin(name, code, 3),
  onToggleReady: (ready) => { if (net) net.setReady(ready); },
  onStartOnline: () => { if (net) net.setReady(true); }, // host: mark ready -> server auto-starts when all ready
  onRestart: onRestart,
  onBackToMenu: backToMenu,
});

// ===========================================================================
// LOCAL MODE
// ===========================================================================
function startLocal(numPlayers, winsToWin) {
  teardownOnline();

  const defs = [];
  localSlots = [];
  for (let slot = 0; slot < numPlayers; slot++) {
    defs.push({ id: `local-${slot}`, slot, name: undefined });
    localSlots.push(slot);
  }

  localGame = createGame(defs, { seed: (Math.random() * 1e9) | 0, winsToWin });
  localInput = createLocalInput(numPlayers);
  localInput.attach();
  acc = 0;
  lastResultShown = false;

  mode = 'local';
  ui.show('hud');
}

function stepLocal(frameDt) {
  if (!localGame) return;

  // Feed current keyboard state to every local player.
  const inputs = localInput.poll();
  for (const slot of localSlots) setInput(localGame, slot, inputs[slot]);

  // Fixed-timestep simulation with an accumulator. Clamp to avoid the
  // "spiral of death" after a tab was backgrounded.
  acc += Math.min(frameDt, 0.25);
  let guard = 0;
  while (acc >= TICK_DT && guard < 600) {
    step(localGame, TICK_DT);
    acc -= TICK_DT;
    guard++;
  }

  const snap = toSnapshot(localGame);
  renderer.draw(snap, { localSlots });
  ui.updateHud(snap, localSlots);

  // Show the result overlay once when a round/match resolves; keep rendering.
  if ((snap.phase === 'roundover' || snap.phase === 'matchover') && !lastResultShown) {
    ui.showResult(snap);
    lastResultShown = true;
  }
  if (snap.phase === 'playing' && lastResultShown) {
    // A new round began (roundover auto-advances in the engine) — back to HUD.
    lastResultShown = false;
    ui.show('hud');
  }
}

// ===========================================================================
// ONLINE MODE
// ===========================================================================
function connectAndJoin(name, room, winsToWin) {
  teardownLocal();
  resetOnlineState();
  mode = 'online';

  net = createNet({
    onJoined: (msg) => {
      mySlot = msg.slot;
      onlineInput = createPlayerInput(mySlot);
      ui.enterRoom({ room: msg.room, slot: msg.slot, host: msg.host });
    },
    onLobby: (msg) => ui.updateLobby(msg),
    onStart: () => {
      onlineStarted = true;
      resultOpenOnline = false;
      lastSentInput = null;
      if (onlineInput) onlineInput.attach();
      ui.show('hud');
    },
    onSnapshot: (snap) => {
      prevSnap = curSnap || snap;
      curSnap = snap;
      snapRecvTime = performance.now();
    },
    onError: (msg) => {
      ui.showError(msg);
      // If we never made it into a room, drop back to the menu cleanly.
      if (!onlineStarted && mySlot < 0) backToMenu();
    },
    onClose: (wasOpen) => {
      if (mode !== 'online') return;
      ui.showError(wasOpen ? 'Verbindung zum Server verloren.' : 'Server nicht erreichbar.');
      backToMenu();
    },
  });

  net.connect();
  // join() is buffered until OPEN by net.js (send() checks readyState), so we
  // wait for the socket to open before sending — small poll keeps net.js simple.
  const trySend = () => {
    if (!net) return;
    // winsToWin is honoured by the server only for the room creator (host).
    net.join(name, room, winsToWin);
  };
  // Give the socket a tick to open; net.send no-ops until OPEN, so retry a few times.
  let attempts = 0;
  const joinTimer = setInterval(() => {
    if (mode !== 'online' || !net) { clearInterval(joinTimer); return; }
    trySend();
    if (mySlot >= 0 || ++attempts > 50) clearInterval(joinTimer);
  }, 100);
}

function tickOnline() {
  // Send our input each frame, but only when it actually changed.
  if (onlineStarted && onlineInput && net) {
    const inp = onlineInput.current();
    if (!sameInput(inp, lastSentInput)) {
      net.sendInput(inp);
      lastSentInput = inp;
    }
  }

  if (!curSnap) return;

  // Interpolate player positions between the previous and current snapshots
  // for smooth motion despite the 30 Hz server tick.
  const t = Math.min(1, (performance.now() - snapRecvTime) / (snapInterval * 1000));
  const render = interpolate(prevSnap, curSnap, t);

  renderer.draw(render, { localSlots: [mySlot] });
  ui.updateHud(render, [mySlot]);

  const phase = curSnap.phase;
  if ((phase === 'roundover' || phase === 'matchover') && !resultOpenOnline) {
    ui.showResult(curSnap);
    resultOpenOnline = true;
  }
  if (phase === 'playing' && resultOpenOnline) {
    resultOpenOnline = false;
    ui.show('hud');
  }
}

// Linearly blend only the player x/y/dir; everything else snaps to current.
function interpolate(a, b, t) {
  if (!a || a === b) return b;
  const players = b.players.map((pb) => {
    const pa = a.players.find((q) => q.slot === pb.slot);
    if (!pa) return pb;
    return {
      ...pb,
      x: pa.x + (pb.x - pa.x) * t,
      y: pa.y + (pb.y - pa.y) * t,
    };
  });
  return { ...b, players };
}

function sameInput(a, b) {
  if (!a || !b) return false;
  return a.up === b.up && a.down === b.down && a.left === b.left &&
         a.right === b.right && a.bomb === b.bomb;
}

// ===========================================================================
// SHARED FLOW
// ===========================================================================
function onRestart() {
  if (mode === 'local' && localGame) {
    // Recreate a fresh match with the same player count / wins.
    const numPlayers = localGame.players.length;
    const winsToWin = localGame.winsToWin;
    startLocal(numPlayers, winsToWin);
  } else if (mode === 'online' && net) {
    net.restart();
    resultOpenOnline = false;
    ui.show('hud');
  }
}

function backToMenu() {
  teardownLocal();
  teardownOnline();
  mode = 'menu';
  curSnap = null;
  prevSnap = null;
  ui.resetOnline();
  ui.show('menu');
  // Clear the board.
  renderer.draw(null, {});
}

// ---- teardown helpers -----------------------------------------------------
function teardownLocal() {
  if (localInput) { localInput.detach(); localInput = null; }
  localGame = null;
  localSlots = [];
  lastResultShown = false;
}

function teardownOnline() {
  if (onlineInput) { onlineInput.detach(); onlineInput = null; }
  if (net) { net.close(); net = null; }
  resetOnlineState();
}

function resetOnlineState() {
  mySlot = -1;
  prevSnap = null;
  curSnap = null;
  onlineStarted = false;
  resultOpenOnline = false;
  lastSentInput = null;
}

// ===========================================================================
// MAIN LOOP
// ===========================================================================
function frame(t) {
  const dt = (t - lastFrame) / 1000;
  lastFrame = t;

  if (mode === 'local') stepLocal(dt);
  else if (mode === 'online') tickOnline();
  // menu: nothing to render on the canvas.

  requestAnimationFrame(frame);
}

window.addEventListener('resize', () => renderer.resize());

// Boot.
ui.show('menu');
renderer.draw(null, {});
requestAnimationFrame(frame);
