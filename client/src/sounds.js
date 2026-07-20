// Procedural Web Audio sound system — zero asset files.
//
// createSound() -> { unlock(), play(name, opts), setMuted(b), toggleMuted(),
//                    isMuted(), syncMusic(arena, opts), stopMusic() }
//
// Every effect is synthesised on the fly from oscillators, gain envelopes and
// short noise buffers, then routed through:
//
//   voice gain -> master gain -> compressor (limiter) -> destination
//
// The compressor catches overlapping voices so bursts of explosions can never
// clip or get harsh. The AudioContext is created lazily on the first user
// gesture (unlock) or first play() — never at module load, because browsers
// emit an autoplay warning for contexts created without a gesture. If Web Audio
// is missing or throws, every method silently degrades to a no-op.

import { createMusicSequencer, resolveMusicTrack } from './music.js';

const MUTE_KEY = 'bomberman.muted';
const MASTER_GAIN = 0.35;     // modest headroom so the limiter rarely engages
const MAX_VOICES = 12;        // ignore extra non-critical sounds past this

export function createSound() {
  // Read persisted mute state up front; tolerate storage being unavailable
  // (private mode, disabled, etc.) without throwing.
  let muted = readMuted();

  // Audio graph — all null until the first unlock()/play() builds it.
  let ctx = null;
  let master = null;            // master GainNode
  let limiter = null;           // DynamicsCompressorNode acting as a limiter
  let music = null;             // independently crossfaded arena sequencer
  let musicTarget = null;       // desired track id, retained while muted
  let noiseBuf = null;          // cached white-noise buffer (explosion/death)
  let active = 0;               // currently-live source count (voice cap)
  let dead = false;             // Web Audio unavailable — permanent no-op

  // -------------------------------------------------------------------------
  // Graph construction (idempotent + resilient).
  // -------------------------------------------------------------------------
  function ensureCtx() {
    if (ctx || dead) return ctx;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) { dead = true; return null; }
      ctx = new AC();

      // Limiter: high ratio + low threshold smooths peaks from stacked voices.
      limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -10;
      limiter.knee.value = 12;
      limiter.ratio.value = 12;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.18;

      master = ctx.createGain();
      master.gain.value = MASTER_GAIN;

      master.connect(limiter);
      limiter.connect(ctx.destination);
      music = createMusicSequencer(ctx, master);
    } catch {
      // Construction failed — never try again, stay silent.
      dead = true;
      ctx = null;
    }
    return ctx;
  }

  // Lazily build (and cache) one second of mono white noise for percussive hits.
  function ensureNoise() {
    if (noiseBuf || !ctx) return noiseBuf;
    const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    noiseBuf = buf;
    return noiseBuf;
  }

  // -------------------------------------------------------------------------
  // Low-level voice helpers. Each tracks `active` and self-cleans on end so
  // we never leak nodes, then frees its voice slot for the cap.
  // -------------------------------------------------------------------------

  // A pitched tone with an attack/decay gain envelope.
  //   freq0/freq1: start/end frequency (linear glide if they differ)
  //   t0: start time, dur: total length, peak: peak gain
  function tone(type, freq0, freq1, t0, dur, peak) {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq0, t0);
    if (freq1 != null && freq1 !== freq0) {
      osc.frequency.linearRampToValueAtTime(freq1, t0 + dur);
    }
    // Fast attack, exponential-ish decay (linear ramp to ~0 keeps it cheap).
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + Math.min(0.012, dur * 0.3));
    g.gain.linearRampToValueAtTime(0.0001, t0 + dur);

    osc.connect(g);
    g.connect(master);
    startStop(osc, t0, dur, () => { osc.disconnect(); g.disconnect(); });
  }

  // A filtered noise burst — the body of explosion/death hits.
  function noise(t0, dur, peak, lowpass) {
    const src = ctx.createBufferSource();
    src.buffer = ensureNoise();
    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.setValueAtTime(lowpass, t0);
    // Sweep the cutoff down so the burst "closes" — feels like a real boom.
    filt.frequency.exponentialRampToValueAtTime(Math.max(120, lowpass * 0.25), t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(peak, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

    src.connect(filt);
    filt.connect(g);
    g.connect(master);
    startStop(src, t0, dur, () => { src.disconnect(); filt.disconnect(); g.disconnect(); });
  }

  // Schedule a source, count it as an active voice, and guarantee teardown.
  function startStop(node, t0, dur, cleanup) {
    active++;
    node.onended = () => { active--; cleanup(); };
    node.start(t0);
    node.stop(t0 + dur + 0.02);
  }

  // -------------------------------------------------------------------------
  // The sound bank. Each entry receives (t0, opts) where t0 is a scheduling
  // start time slightly in the future to avoid glitches. Keep them short.
  // -------------------------------------------------------------------------
  const BANK = {
    // Soft UI tick for button presses.
    uiClick(t0) {
      tone('square', 880, 660, t0, 0.07, 0.18);
    },
    // Lower, mellower tick for back/cancel.
    uiBack(t0) {
      tone('square', 520, 400, t0, 0.08, 0.18);
    },
    // Placing a bomb: a short muted thud.
    place(t0) {
      tone('sine', 220, 130, t0, 0.12, 0.3);
      noise(t0, 0.05, 0.08, 1200);
    },
    // The signature detonation: noise burst + low sine drop. opts.rate varies
    // pitch slightly so repeated explosions don't sound identical.
    explode(t0, opts) {
      const rate = clamp(opts && opts.rate ? opts.rate : 1, 0.7, 1.4);
      // Low-frequency body that drops fast.
      tone('sine', 170 * rate, 42 * rate, t0, 0.32, 0.42);
      // Bright crack on the transient.
      tone('triangle', 320 * rate, 90 * rate, t0, 0.12, 0.18);
      // Noise burst — the "boom".
      noise(t0, 0.34, 0.5, 1800 * rate);
    },
    // Grabbing a powerup: bright ascending arpeggio.
    pickup(t0) {
      tone('square', 660, 660, t0, 0.08, 0.16);
      tone('square', 880, 880, t0 + 0.07, 0.08, 0.16);
      tone('square', 1320, 1320, t0 + 0.14, 0.12, 0.16);
    },
    // A player dies: descending sad tone + a little noise.
    death(t0) {
      tone('sawtooth', 440, 110, t0, 0.45, 0.22);
      noise(t0, 0.25, 0.14, 900);
    },
    // Round/match won: triumphant ascending major arpeggio (C-E-G-C).
    win(t0) {
      tone('square', 523, 523, t0, 0.12, 0.2);
      tone('square', 659, 659, t0 + 0.11, 0.12, 0.2);
      tone('square', 784, 784, t0 + 0.22, 0.14, 0.2);
      tone('square', 1047, 1047, t0 + 0.34, 0.4, 0.22);
    },
    // A draw: neutral falling two-note.
    draw(t0) {
      tone('triangle', 494, 494, t0, 0.16, 0.2);
      tone('triangle', 392, 392, t0 + 0.16, 0.26, 0.2);
    },
    // Match start: a rising sweep into a short fanfare.
    start(t0) {
      tone('sawtooth', 220, 660, t0, 0.3, 0.18);
      tone('square', 784, 784, t0 + 0.3, 0.12, 0.2);
      tone('square', 1047, 1047, t0 + 0.42, 0.32, 0.22);
    },
    // Countdown / sudden-death warning beep.
    tick(t0) {
      tone('square', 988, 988, t0, 0.09, 0.2);
    },
    // A shield absorbs a hit: bright metallic "ting" over a soft thud.
    shield(t0) {
      tone('triangle', 1320, 1760, t0, 0.18, 0.22);
      tone('sine', 440, 220, t0, 0.16, 0.18);
      noise(t0, 0.08, 0.12, 2600);
    },
    // Kicking a bomb: a short rising whoosh + thump.
    kick(t0) {
      tone('sine', 180, 320, t0, 0.14, 0.26);
      noise(t0, 0.1, 0.16, 1400);
    },
    // Bomb thrown into the air: quick elastic lift.
    throw(t0) {
      tone('sine', 260, 620, t0, 0.18, 0.2);
      noise(t0, 0.07, 0.08, 2200);
    },
    portal(t0) {
      tone('sine', 320, 980, t0, 0.22, 0.18);
      tone('triangle', 880, 440, t0 + 0.05, 0.2, 0.12);
    },
  };

  // -------------------------------------------------------------------------
  // Public API.
  // -------------------------------------------------------------------------

  // Create or resume the context. Safe to call repeatedly; call on the first
  // user gesture so the autoplay policy lets us make sound afterwards.
  function unlock() {
    if (dead) return;
    if (!ensureCtx()) return;
    if (ctx.state === 'suspended') {
      // resume() returns a promise; swallow rejections (e.g. no gesture yet).
      ctx.resume().then(startPendingMusic).catch(() => {});
    }
    startPendingMusic();
  }

  function play(name, opts) {
    if (muted || dead) return;
    const make = BANK[name];
    if (!make) return;                 // unknown name -> no-op
    if (!ensureCtx()) return;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    startPendingMusic();

    // Voice cap: drop new sounds when saturated so spam can't melt the mix.
    // (Every effect here is "non-critical" enough to skip under heavy load.)
    if (active >= MAX_VOICES) return;

    try {
      // Schedule a hair in the future so envelopes start cleanly.
      make(ctx.currentTime + 0.001, opts);
    } catch {
      // A bad parameter or a closing context must never crash the game.
    }
  }

  function setMuted(b) {
    muted = !!b;
    writeMuted(muted);
    if (muted) music?.stop();
    else startPendingMusic();
  }

  function toggleMuted() {
    setMuted(!muted);
    return muted;
  }

  function isMuted() {
    return muted;
  }

  function startPendingMusic() {
    if (!muted && music && musicTarget) music.setTrack(musicTarget);
  }

  function syncMusic(arenaLike, { suddenDeath = false } = {}) {
    const track = resolveMusicTrack(arenaLike, suddenDeath);
    musicTarget = track.id;
    startPendingMusic();
  }

  function stopMusic() {
    musicTarget = null;
    music?.stop();
  }

  return {
    unlock,
    play,
    setMuted,
    toggleMuted,
    isMuted,
    syncMusic,
    stopMusic,
  };
}

// ---------------------------------------------------------------------------
// Small free helpers.
// ---------------------------------------------------------------------------
function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function readMuted() {
  try {
    return localStorage.getItem(MUTE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeMuted(b) {
  try {
    localStorage.setItem(MUTE_KEY, b ? '1' : '0');
  } catch {
    // Storage unavailable — mute still works for this session.
  }
}
