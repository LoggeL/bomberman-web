// Entry point + state machine. Owns the single requestAnimationFrame loop and
// switches cleanly between three modes:
//   'menu'   — no game running, just menus.
//   'local'  — this client owns a game instance and simulates it.
//   'online' — the server owns the game; we render incoming snapshots, but we
//              client-side *predict* our own player so it responds instantly.

import { createGame, step, setInput, toSnapshot, stepPlayerGrid } from '../../shared/engine.js';
import { TICK_DT } from '../../shared/constants.js';
import { SNAPSHOT_HZ } from '../../shared/protocol.js';
import { createRenderer } from './render.js';
import { createUI } from './ui.js';
import { createLocalInput, createPlayerInput } from './input.js';
import { createNet } from './net.js';
import { createSound } from './sounds.js';

const canvas = document.getElementById('board');
const renderer = createRenderer(canvas);
const sound = createSound();

// Unlock the AudioContext on the first real user gesture (autoplay policy).
function unlockAudioOnce() {
  sound.unlock();
  window.removeEventListener('keydown', unlockAudioOnce);
  window.removeEventListener('pointerdown', unlockAudioOnce);
}
window.addEventListener('keydown', unlockAudioOnce);
window.addEventListener('pointerdown', unlockAudioOnce);

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
let localEventSnap = null;    // previous snapshot, for SFX/shake event detection

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
let predicted = null;         // client-side predicted local player {x,y,dir,moving,speedPicks}

// HUD refresh throttle (the DOM update itself is diff-based, but there is no
// point doing the comparisons more than a dozen times a second).
let lastHudAt = 0;
const HUD_INTERVAL = 0.08; // seconds (~12.5 Hz)

let lastFrame = performance.now();

// ---------------------------------------------------------------------------
// UI wiring.
// ---------------------------------------------------------------------------
const ui = createUI({
  sound,
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
  localEventSnap = null;

  mode = 'local';
  lastHudAt = HUD_INTERVAL; // refresh the HUD on the very first frame
  ui.resetHud();
  ui.show('hud');
  sound.play('start');
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
  detectEvents(localEventSnap, snap);
  localEventSnap = snap;

  renderer.draw(snap, { localSlots });
  updateHudThrottled(snap, localSlots, frameDt);

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
      predicted = null;
      lastHudAt = HUD_INTERVAL; // refresh the HUD on the very first frame
      if (onlineInput) onlineInput.attach();
      ui.resetHud();
      ui.show('hud');
      sound.play('start');
    },
    onSnapshot: (snap) => {
      // Detect SFX/shake events against the previously-held server snapshot,
      // then advance the interpolation buffer and reconcile our prediction.
      detectEvents(curSnap, snap);
      prevSnap = curSnap || snap;
      curSnap = snap;
      snapRecvTime = performance.now();
      reconcilePrediction(snap);
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

function tickOnline(frameDt) {
  // Send our input each frame, but only when it actually changed.
  if (onlineStarted && onlineInput && net) {
    const inp = onlineInput.current();
    if (!sameInput(inp, lastSentInput)) {
      net.sendInput(inp);
      lastSentInput = inp;
    }
  }

  if (!curSnap) return;

  // Advance the client-side prediction for our own player so it reacts to input
  // instantly instead of after a full server round-trip.
  const sp = curSnap.players.find((p) => p.slot === mySlot);
  const inp = onlineInput ? onlineInput.current() : null;
  if (sp && sp.alive && inp && curSnap.phase === 'playing') {
    if (!predicted) {
      predicted = {
        x: sp.x, y: sp.y, dir: sp.dir, moving: sp.moving,
        speedPicks: sp.speedPicks, ghost: sp.ghost, stepping: false, tx: 0, ty: 0,
      };
    }
    // Keep ability-derived inputs to the movement model synced from authority.
    predicted.speedPicks = sp.speedPicks;
    predicted.ghost = sp.ghost;
    stepPlayerGrid(curSnap.grid, curSnap.bombs, predicted, inp, Math.min(frameDt, 0.05));
  } else {
    predicted = null;
  }

  // Interpolate other players between the previous and current snapshots for
  // smooth motion despite the 30 Hz server tick; our own player is overridden
  // with the predicted position below.
  const t = Math.min(1, (performance.now() - snapRecvTime) / (snapInterval * 1000));
  const render = interpolate(prevSnap, curSnap, t);
  if (predicted) {
    render.players = render.players.map((p) => (
      p.slot === mySlot
        ? { ...p, x: predicted.x, y: predicted.y, dir: predicted.dir, moving: predicted.moving }
        : p
    ));
  }

  renderer.draw(render, { localSlots: [mySlot] });
  updateHudThrottled(render, [mySlot], frameDt);

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

// Reconcile the prediction with authority. With tile-stepping a soft off-axis
// pull would drag the player off the grid, so we only correct on a real
// discrepancy (death, sudden-death wall, a mispredicted turn under lag): snap to
// the server position and let the next step re-align to the nearest centre.
// Small latency lead on the same path is left alone so movement stays crisp.
function reconcilePrediction(snap) {
  if (!predicted) return;
  const sp = snap.players.find((p) => p.slot === mySlot);
  if (!sp) return;
  if (!sp.alive) { predicted = null; return; }
  predicted.speedPicks = sp.speedPicks;
  predicted.ghost = sp.ghost;
  if (Math.hypot(sp.x - predicted.x, sp.y - predicted.y) > 0.9) {
    predicted.x = sp.x; predicted.y = sp.y; predicted.stepping = false;
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
// SOUND / SHAKE EVENT DETECTION
// ===========================================================================
// Both modes ultimately diff two consecutive snapshots; this keeps the audio
// and screen-shake logic in one place and identical for local and online play.
function detectEvents(prev, snap) {
  if (!prev || !snap || prev === snap) return;

  // New bombs (by stable id) -> placement blip. Keying on id (not col/row)
  // catches a fresh bomb dropped on a tile that just detonated.
  for (const b of snap.bombs) {
    if (!prev.bombs.some((o) => o.id === b.id)) {
      sound.play('place');
    }
  }

  // New explosion centres -> detonation + screen shake.
  let newCenters = 0;
  for (const f of snap.flames) {
    if (f.kind !== 'center') continue;
    if (!prev.flames.some((o) => o.col === f.col && o.row === f.row && o.kind === 'center')) {
      newCenters++;
    }
  }
  if (newCenters > 0) {
    sound.play('explode', { rate: 0.92 + Math.min(newCenters, 4) * 0.04 });
    renderer.shake(Math.min(8 + newCenters * 3, 18));
  }

  // Powerup pickups -> any player's total upgrades increased.
  for (const p of snap.players) {
    const o = prev.players.find((q) => q.slot === p.slot);
    if (!o) continue;
    if (upgradeTotal(p) > upgradeTotal(o)) sound.play('pickup');
    // A shield just absorbed a hit (charge dropped but still alive).
    if (p.alive && p.shield < o.shield) { sound.play('shield'); renderer.shake(10); }
    // Player just died.
    if (o.alive && !p.alive) sound.play('death');
  }

  // Round / match resolution -> win or draw sting (fired once on transition).
  if (prev.phase === 'playing' && snap.phase !== 'playing') {
    sound.play(snap.winner === null || snap.winner === undefined ? 'draw' : 'win');
  }
}

// Sum of a player's collected upgrades — a jump means a powerup was grabbed.
function upgradeTotal(p) {
  return p.maxBombs + p.range + p.speedPicks + p.shield +
         (p.ghost ? 1 : 0) + (p.pierce ? 1 : 0);
}

// ===========================================================================
// SHARED FLOW
// ===========================================================================
function updateHudThrottled(snap, slots, frameDt) {
  lastHudAt += frameDt;
  if (lastHudAt < HUD_INTERVAL) return;
  lastHudAt = 0;
  ui.updateHud(snap, slots);
}

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
  localEventSnap = null;
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
  predicted = null;
}

// ===========================================================================
// MAIN LOOP
// ===========================================================================
function frame(t) {
  const dt = (t - lastFrame) / 1000;
  lastFrame = t;

  if (mode === 'local') stepLocal(dt);
  else if (mode === 'online') tickOnline(dt);
  // menu: nothing to render on the canvas.

  requestAnimationFrame(frame);
}

window.addEventListener('resize', () => renderer.resize());

// Boot.
ui.show('menu');
renderer.draw(null, {});
requestAnimationFrame(frame);
