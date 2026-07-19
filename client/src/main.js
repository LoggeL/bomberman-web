// Entry point + state machine. Owns the single requestAnimationFrame loop and
// switches cleanly between three modes:
//   'menu'   — no game running, just menus.
//   'local'  — this client owns a game instance and simulates it.
//   'online' — the server owns the game; we render incoming snapshots, but we
//              client-side *predict* our own player so it responds instantly.

import { createGame, step, setInput, toSnapshot, stepPlayerGrid } from '../../shared/engine.js';
import { MIN_PLAYERS, TICK_DT } from '../../shared/constants.js';
import { SNAPSHOT_HZ } from '../../shared/protocol.js';
import { createRenderer } from './render.js';
import { createUI } from './ui.js';
import { createLocalInput, createPlayerInput, initTouchControls, setTouchControlsVisible } from './input.js';
import { createNet } from './net.js';
import { createSound } from './sounds.js';
import {
  findPickupEffects,
  PICKUP_POPUP_DURATION_MS,
} from './pickup-effects.js';
import {
  advanceFixedPrediction,
  canPredictBomb,
  decayVisualCorrection,
  interpolateGridPlayer,
  isSnapshotDiscontinuity,
  needsPredictionRebase,
  predictionFromSnapshot,
  rebaseWithVisualCorrection,
} from './sync.js';

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
let onlineHostSlot = null;    // current host (updated on every LOBBY, including handoff)
let onlinePlayerCount = 0;    // rematches still require a playable roster
let curSnap = null;           // latest authoritative snapshot (events, prediction, dynamic render)
let snapBuf = [];             // recent snapshots [{ snap, at }] for jitter-tolerant interpolation
let lastSentInput = null;     // dedupe identical INPUT messages
let onlineStarted = false;    // has START been received?
let resultOpenOnline = false;
let restartPending = false;   // host rematch request sent; wait for authoritative START
let predicted = null;         // client-side predicted local player {x,y,dir,moving,speedPicks}
let predictionAcc = 0;        // fixed-step prediction accumulator
let predictionCorrection = { x: 0, y: 0 }; // render-only easing after reconciliation
let predBombs = [];           // client-predicted own bombs awaiting server confirmation
let predBombHeld = false;     // bomb-button edge state for local bomb prediction
let pickupPopups = [];        // newest pickup effect label per player

// HUD refresh throttle (the DOM update itself is diff-based, but there is no
// point doing the comparisons more than a dozen times a second).
let lastHudAt = 0;
const HUD_INTERVAL = 0.08; // seconds (~12.5 Hz)
const LOCAL_PLAYER_COUNT = 2;

// Render OTHER players this far in the past so two buffered snapshots always
// bracket the render time — this absorbs network jitter / late packets so
// enemies glide smoothly instead of stuttering or teleporting. (Online only;
// local mode steps the engine live and needs no interpolation.) Our own player
// is client-predicted, so it stays instant despite this delay.
const INTERP_DELAY = (1000 / SNAPSHOT_HZ) * 2.6; // ms (~87 ms at 30 Hz)

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
function startLocal(_numPlayers, winsToWin) {
  teardownOnline();
  teardownLocal();

  const numPlayers = LOCAL_PLAYER_COUNT;
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
  clearPickupPopups();

  mode = 'local';
  lastHudAt = HUD_INTERVAL; // refresh the HUD on the very first frame
  ui.resetHud();
  ui.show('hud');
  sound.play('start');
  setTouchControlsVisible(true);
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

  renderer.draw(snap, { localSlots, pickupPopups: activePickupPopups() });
  updateHudThrottled(snap, localSlots, frameDt);

  // Show the result overlay once when a round/match resolves; keep rendering.
  if ((snap.phase === 'roundover' || snap.phase === 'matchover') && !lastResultShown) {
    ui.showResult(snap, { canRestart: snap.phase === 'matchover' });
    setTouchControlsVisible(false);
    lastResultShown = true;
  }
  if (snap.phase === 'playing' && lastResultShown) {
    // A new round began (roundover auto-advances in the engine) — back to HUD.
    lastResultShown = false;
    ui.show('hud');
    setTouchControlsVisible(true);
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
      onlineHostSlot = msg.host ? msg.slot : null;
      onlineInput = createPlayerInput(mySlot);
      ui.enterRoom({ room: msg.room, slot: msg.slot, host: msg.host });
    },
    onLobby: (msg) => {
      onlineHostSlot = msg.host;
      onlinePlayerCount = msg.players.length;
      ui.updateLobby(msg);
      // Host ownership can change after a disconnect, including while the final
      // result is open. Refresh just the action without replaying the overlay.
      if (resultOpenOnline && curSnap?.phase === 'matchover') syncOnlineResultAction();
    },
    onStart: () => {
      onlineStarted = true;
      resultOpenOnline = false;
      restartPending = false;
      lastSentInput = null;
      // START is the authoritative match boundary. Never render or interpolate
      // the old terminal snapshot while waiting for the fresh initial snapshot.
      curSnap = null;
      snapBuf = [];
      clearPredictionState();
      clearPickupPopups();
      lastHudAt = HUD_INTERVAL; // refresh the HUD on the very first frame
      if (onlineInput) onlineInput.attach();
      ui.setRestartPending(false);
      ui.resetHud();
      ui.show('hud');
      sound.play('start');
      setTouchControlsVisible(true);
    },
    onSnapshot: (snap) => {
      // Detect SFX/shake events against the previously-held server snapshot,
      // then buffer this one for interpolation and reconcile our prediction.
      const discontinuity = isSnapshotDiscontinuity(curSnap, snap);
      detectEvents(discontinuity ? null : curSnap, snap);
      if (discontinuity) {
        // Respawns are teleports by design. Blending a dead position from the
        // previous round into a spawn point makes remote players streak across
        // the board and leaves local prediction/bombs attached to stale state.
        snapBuf = [];
        clearPredictionState();
        clearPickupPopups();
      }
      curSnap = snap;
      snapBuf.push({ snap, at: performance.now() });
      if (snapBuf.length > 40) snapBuf.shift(); // keep ~1.3 s of history, plenty
      reconcilePrediction(snap);
    },
    onPing: (ms) => ui.updatePing(ms),
    onError: (msg) => {
      if (restartPending) {
        restartPending = false;
        ui.setRestartPending(false);
      }
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
      predicted = predictionFromSnapshot(sp);
      predictionAcc = 0;
      predictionCorrection = { x: 0, y: 0 };
    }
    // Keep ability-derived inputs to the movement model synced from authority.
    predicted.speedPicks = sp.speedPicks;
    predicted.ghost = sp.ghost;
    // Bomb placement is server-authoritative and only comes back in the next
    // snapshot, so predict our OWN bombs locally — otherwise we'd predict-walk
    // back through a bomb the server already blocks and rubber-band. Each entry
    // expires once the real bomb arrives in curSnap.bombs (or after a timeout).
    const nowMs = performance.now();
    predBombs = predBombs.filter((b) =>
      b.until > nowMs && !curSnap.bombs.some((s) => s.col === b.col && s.row === b.row));
    if (inp.bomb && !predBombHeld && (sp.bombLock || 0) <= 0) {
      const bc = Math.round(predicted.x - 0.5), br = Math.round(predicted.y - 0.5);
      const dup = predBombs.some((b) => b.col === bc && b.row === br) ||
                  curSnap.bombs.some((b) => b.col === bc && b.row === br);
      // Match the server's concurrent-bomb quota. Without owner metadata a
      // rejected placement became a phantom collision tile for 1.5 seconds.
      if (!dup && canPredictBomb(mySlot, sp.maxBombs, curSnap.bombs, predBombs)) {
        predBombs.push({ col: bc, row: br, until: nowMs + 1500 });
      }
    }
    predBombHeld = !!inp.bomb;
    const bombs = predBombs.length ? curSnap.bombs.concat(predBombs) : curSnap.bombs;
    // Mirror the server's 60 Hz fixed steps. The old per-frame 50 ms cap threw
    // away half the elapsed time at 10 FPS, guaranteeing a later rubber-band.
    predictionAcc = advanceFixedPrediction(predictionAcc, frameDt, (pdt) => {
      stepPlayerGrid(curSnap.grid, bombs, predicted, inp, pdt);
      // Tick predicted wallpass too (re-synced from authority on snapshots).
      if (predicted.ghost > 0) predicted.ghost = Math.max(0, predicted.ghost - pdt);
    });
  } else {
    clearPredictionState();
  }

  // Build the render view: other players + sliding bombs interpolated from the
  // buffered snapshots (smooth despite jitter), our own player from prediction.
  const view = interpolatedView();
  if (predicted) {
    predictionCorrection = decayVisualCorrection(predictionCorrection, frameDt, predicted);
    const me = view.players.find((p) => p.slot === mySlot);
    if (me) {
      me.x = predicted.x + predictionCorrection.x;
      me.y = predicted.y + predictionCorrection.y;
      me.dir = predicted.dir;
      me.moving = predicted.moving || predictionCorrection.x !== 0 || predictionCorrection.y !== 0;
    }
  }
  const render = { ...curSnap, players: view.players, bombs: view.bombs };

  renderer.draw(render, { localSlots: [mySlot], pickupPopups: activePickupPopups() });
  updateHudThrottled(render, [mySlot], frameDt);

  const phase = curSnap.phase;
  if ((phase === 'roundover' || phase === 'matchover') && !resultOpenOnline) {
    showOnlineResult(curSnap);
    setTouchControlsVisible(false);
    resultOpenOnline = true;
  }
  if (phase === 'playing' && resultOpenOnline) {
    resultOpenOnline = false;
    ui.show('hud');
    setTouchControlsVisible(true);
  }
}

// Reconcile only a real topology/settled-state discrepancy. A moving predicted
// player normally leads the RTT-old snapshot, so raw distance alone is not an
// error. Exact authority resets the simulation; a render-only offset hides the
// correction briefly without pulling the collision state off-grid.
function reconcilePrediction(snap) {
  if (!predicted) return;
  const sp = snap.players.find((p) => p.slot === mySlot);
  if (!sp) return;
  if (!sp.alive) { clearPredictionState(); return; }
  predicted.speedPicks = sp.speedPicks;
  predicted.ghost = sp.ghost;
  if (needsPredictionRebase(predicted, sp, snap.grid)) {
    const rebased = rebaseWithVisualCorrection(predicted, sp, predictionCorrection);
    predicted = rebased.predicted;
    predictionCorrection = rebased.correction;
    predictionAcc = 0;
  }
}

// Interpolated view rendered INTERP_DELAY ms in the past: find the two buffered
// snapshots bracketing that time and linearly blend PLAYER positions between
// them (robust to variable / late arrival — no freeze-then-jump). Bombs are NOT
// interpolated: they render at their latest position so a kicked bomb and its
// explosion flame (which comes from the latest snapshot) stay in sync.
function interpolatedView() {
  const players = curSnap.players.map((p) => ({ ...p }));
  const bombs = curSnap.bombs.map((b) => ({ ...b }));
  if (snapBuf.length < 2) return { players, bombs };

  const target = performance.now() - INTERP_DELAY;
  const first = snapBuf[0], last = snapBuf[snapBuf.length - 1];
  let a = last, b = last;
  if (target <= first.at) {
    a = b = first;                       // not enough history yet
  } else if (target < last.at) {
    for (let i = 0; i < snapBuf.length - 1; i++) {
      if (snapBuf[i].at <= target && target <= snapBuf[i + 1].at) {
        a = snapBuf[i]; b = snapBuf[i + 1]; break;
      }
    }
  } // else target >= last.at -> starved: hold the latest (a = b = last)

  const span = b.at - a.at;
  const f = span > 0 ? (target - a.at) / span : 1;

  for (const p of players) {
    const pa = a.snap.players.find((q) => q.slot === p.slot);
    const pb = b.snap.players.find((q) => q.slot === p.slot);
    if (!pa || !pb) continue;
    const pose = interpolateGridPlayer(pa, pb, f);
    p.x = pose.x;
    p.y = pose.y;
    p.dir = pose.dir;
    p.moving = pose.moving;
  }
  return { players, bombs };
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
  // catches a fresh bomb dropped on a tile that just detonated. A bomb that
  // starts sliding (gains velocity) -> kick whoosh.
  for (const b of snap.bombs) {
    const o = prev.bombs.find((q) => q.id === b.id);
    if (!o) { sound.play('place'); continue; }
    const wasMoving = o.vx || o.vy;
    const nowMoving = b.vx || b.vy;
    if (!wasMoving && nowMoving) sound.play('kick');
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

  for (const pickup of findPickupEffects(prev, snap)) {
    sound.play('pickup');
    showPickupPopup(pickup);
  }

  for (const p of snap.players) {
    const o = prev.players.find((q) => q.slot === p.slot);
    if (!o) continue;
    // A shield just absorbed a hit. Expiry also drops shield to zero, so the
    // newly granted i-frames are the unambiguous signal for an actual block.
    if (p.alive && (p.invuln || 0) > (o.invuln || 0)) {
      sound.play('shield');
      renderer.shake(10);
    }
    // Player just died.
    if (o.alive && !p.alive) sound.play('death');
  }

  // Round / match resolution -> win or draw sting (fired once on transition).
  if (prev.phase === 'playing' && snap.phase !== 'playing') {
    sound.play(snap.winner === null || snap.winner === undefined ? 'draw' : 'win');
  }
}

function showPickupPopup(effect) {
  const startedAt = performance.now();
  pickupPopups = pickupPopups.filter((popup) => popup.slot !== effect.slot);
  pickupPopups.push({
    ...effect,
    startedAt,
    until: startedAt + PICKUP_POPUP_DURATION_MS,
  });
}

function activePickupPopups() {
  const timestamp = performance.now();
  pickupPopups = pickupPopups.filter((popup) => popup.until > timestamp);
  return pickupPopups.map((popup) => ({
    slot: popup.slot,
    text: popup.text,
    color: popup.color,
    progress: (timestamp - popup.startedAt) / PICKUP_POPUP_DURATION_MS,
  }));
}

function clearPickupPopups() {
  pickupPopups = [];
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

function showOnlineResult(snap) {
  const isMatch = snap.phase === 'matchover';
  const amHost = onlineHostSlot === mySlot;
  const enoughPlayers = onlinePlayerCount >= MIN_PLAYERS;
  const canRestart = isMatch && amHost && enoughPlayers;
  ui.showResult(snap, {
    canRestart,
    waitingForHost: isMatch && !amHost,
    waitingForPlayers: isMatch && amHost && !enoughPlayers,
    restartPending,
  });
}

function syncOnlineResultAction() {
  const amHost = onlineHostSlot === mySlot;
  const enoughPlayers = onlinePlayerCount >= MIN_PLAYERS;
  const canRestart = amHost && enoughPlayers;
  ui.setResultAction({
    visible: true,
    canRestart,
    waitingForHost: !amHost,
    waitingForPlayers: amHost && !enoughPlayers,
    pending: restartPending,
  });
}

function onRestart() {
  if (mode === 'local' && localGame?.phase === 'matchover') {
    // Recreate a fresh match with the same player count / wins.
    const numPlayers = localGame.players.length;
    const winsToWin = localGame.winsToWin;
    startLocal(numPlayers, winsToWin);
  } else if (mode === 'online' && net && curSnap?.phase === 'matchover' &&
             onlineHostSlot === mySlot && onlinePlayerCount >= MIN_PLAYERS && !restartPending) {
    // Keep the result visible and disabled until START confirms the new match.
    // This makes double clicks and stale terminal snapshots harmless.
    restartPending = true;
    net.restart();
    ui.setRestartPending(true);
  } else {
    // The UI disables itself synchronously before invoking this callback. Undo
    // that optimistic state if the lifecycle/host guard rejected the action.
    ui.setRestartPending(false);
  }
}

function backToMenu() {
  teardownLocal();
  teardownOnline();
  setTouchControlsVisible(false);
  mode = 'menu';
  curSnap = null;
  snapBuf = [];
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
  clearPickupPopups();
}

function teardownOnline() {
  if (onlineInput) { onlineInput.detach(); onlineInput = null; }
  if (net) { net.close(); net = null; }
  resetOnlineState();
}

function resetOnlineState() {
  mySlot = -1;
  onlineHostSlot = null;
  onlinePlayerCount = 0;
  curSnap = null;
  snapBuf = [];
  onlineStarted = false;
  resultOpenOnline = false;
  restartPending = false;
  lastSentInput = null;
  clearPickupPopups();
  clearPredictionState();
  ui.setRestartPending(false);
  ui.updatePing(null);
}

function clearPredictionState() {
  predicted = null;
  predictionAcc = 0;
  predictionCorrection = { x: 0, y: 0 };
  predBombs = [];
  predBombHeld = false;
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
initTouchControls();
requestAnimationFrame(frame);
