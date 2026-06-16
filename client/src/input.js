// Keyboard input handling.
//
// Two flavours:
//   createLocalInput()       — polls all local couch players at once.
//   createPlayerInput(slot)   — a single player's input for online play.
//
// Both share one global key-state tracker so we only ever attach one pair of
// window listeners regardless of how many input objects exist.

// ----------------------------------------------------------------------------
// Per-slot key maps. Keys are matched against KeyboardEvent.code (layout-
// independent: 'KeyW' is the physical W key on any layout). Arrow keys and the
// numeric/symbol bomb keys use their code names too.
// ----------------------------------------------------------------------------
const KEYMAPS = [
  // P0 — Rot: WASD + Space
  { up: 'KeyW', down: 'KeyS', left: 'KeyA', right: 'KeyD', bomb: 'Space' },
  // P1 — Blau: Arrows + Enter
  { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', bomb: 'Enter' },
  // P2 — Grün: IJKL + U
  { up: 'KeyI', down: 'KeyK', left: 'KeyJ', right: 'KeyL', bomb: 'KeyU' },
  // P3 — Gelb: TFGH + R
  { up: 'KeyT', down: 'KeyG', left: 'KeyF', right: 'KeyH', bomb: 'KeyR' },
];

// Codes we never want to bubble to the browser (page scroll, etc.).
const PREVENT = new Set([
  'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter',
]);

// ----------------------------------------------------------------------------
// Shared key-state singleton. Reference-counted so detach() only removes the
// real window listeners once nobody is listening anymore.
// ----------------------------------------------------------------------------
const pressed = new Set();
let refCount = 0;

function onKeyDown(e) {
  if (PREVENT.has(e.code)) e.preventDefault();
  pressed.add(e.code);
}
function onKeyUp(e) {
  pressed.delete(e.code);
}
function onBlur() {
  // Window lost focus — drop all keys so players don't "stick" walking.
  pressed.clear();
}

function attachGlobal() {
  if (refCount === 0) {
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
  }
  refCount++;
}
function detachGlobal() {
  refCount = Math.max(0, refCount - 1);
  if (refCount === 0) {
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', onBlur);
    pressed.clear();
  }
}

// Read one slot's directional + bomb state from the shared key set.
function readSlot(slot) {
  const m = KEYMAPS[slot];
  return {
    up: pressed.has(m.up),
    down: pressed.has(m.down),
    left: pressed.has(m.left),
    right: pressed.has(m.right),
    bomb: pressed.has(m.bomb),
  };
}

// ----------------------------------------------------------------------------
// Local couch input: poll() returns inputs for slots 0..count-1.
// ----------------------------------------------------------------------------
export function createLocalInput(count = 4) {
  let attached = false;
  const n = Math.max(1, Math.min(KEYMAPS.length, count));

  return {
    /** @returns {{ [slot:number]: {up,down,left,right,bomb} }} */
    poll() {
      const out = {};
      for (let slot = 0; slot < n; slot++) out[slot] = readSlot(slot);
      return out;
    },
    attach() { if (!attached) { attached = true; attachGlobal(); } },
    detach() { if (attached) { attached = false; detachGlobal(); } },
  };
}

// ----------------------------------------------------------------------------
// Online input: one player, always driven from slot 0's key map (WASD+Space)
// regardless of which network slot we were assigned — the online player always
// uses the primary controls.
// ----------------------------------------------------------------------------
export function createPlayerInput(_slot = 0) {
  let attached = false;
  return {
    /** @returns {{up,down,left,right,bomb}} */
    current() { return readSlot(0); },
    attach() { if (!attached) { attached = true; attachGlobal(); } },
    detach() { if (attached) { attached = false; detachGlobal(); } },
  };
}
