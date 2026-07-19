// Procedural arena music. Every track is built from small Web Audio voices so
// the game keeps its zero-audio-asset footprint and can crossfade instantly
// when a new round or Sudden Death begins.

import { getArenaVisual } from './arena-visuals.js';

const LOOKAHEAD_MS = 25;
const SCHEDULE_AHEAD = 0.12;
const STEPS_PER_BEAT = 4; // sixteenth-note grid
const TRACK_GAIN = 0.42;

const midi = (note) => 440 * 2 ** ((note - 69) / 12);
const on = (step, hits) => hits.includes(step % 16);

const NEON_BASS = [45, 45, 48, 43, 45, 52, 48, 43];
const NEON_ARP = [69, 72, 76, 81, 76, 72, 67, 72];
const FOUNDRY_BASS = [40, 40, 43, 38, 40, 46, 43, 38];
const FROST_ARP = [74, 78, 81, 85, 81, 78, 73, 78];
const REACTOR_BASS = [38, 45, 41, 45, 38, 48, 41, 45];
const REACTOR_PULSE = [62, 69, 65, 69, 62, 72, 65, 69];
const SUDDEN_BASS = [36, 36, 39, 36, 41, 39, 34, 35];

function makeTrack(id, bpm, schedule) {
  return Object.freeze({ id, bpm, steps: 64, schedule });
}

export const MUSIC_TRACKS = Object.freeze({
  neon: makeTrack('neon', 124, (v, step, t) => {
    const barStep = step % 16;
    if (barStep % 4 === 0) v.kick(t, 0.16);
    if (barStep % 4 === 2) v.hat(t, 0.034);

    if (step % 2 === 0) {
      const index = (step / 2) % NEON_BASS.length;
      v.note('sawtooth', NEON_BASS[index], t, 0.18, 0.075, { cutoff: 620 });
      v.note('square', NEON_ARP[index], t + 0.008, 0.105, 0.038, { cutoff: 2200 });
    }

    if (on(step, [0, 7, 10, 14])) {
      const lead = [81, 79, 76, 84][[0, 7, 10, 14].indexOf(barStep)];
      v.note('square', lead, t, 0.18, 0.045, { cutoff: 1750 });
    }
  }),

  foundry: makeTrack('foundry', 104, (v, step, t) => {
    const barStep = step % 16;
    if (on(step, [0, 6, 10])) v.kick(t, barStep === 0 ? 0.19 : 0.14);
    if (on(step, [4, 12])) v.clang(t, barStep === 12 ? 0.055 : 0.07);
    if (on(step, [3, 7, 11, 15])) v.hat(t, 0.028);

    if (step % 2 === 0) {
      const note = FOUNDRY_BASS[(step / 2) % FOUNDRY_BASS.length];
      v.note('square', note, t, 0.24, 0.085, { cutoff: 460, endNote: note - 0.5 });
    }

    if (on(step, [2, 9, 14])) {
      const stab = barStep === 9 ? 55 : 52;
      v.note('sawtooth', stab, t, 0.13, 0.05, { cutoff: 880 });
      v.note('square', stab + 6, t, 0.1, 0.025, { cutoff: 1300 });
    }
  }),

  frost: makeTrack('frost', 112, (v, step, t) => {
    const bar = Math.floor(step / 16) % 4;
    const barStep = step % 16;
    const roots = [50, 46, 53, 48];

    if (barStep === 0) {
      const root = roots[bar];
      for (const offset of [0, 3, 7]) {
        v.note('sine', root + offset + 12, t, 1.75, 0.027, { attack: 0.18 });
      }
      v.note('triangle', root, t, 0.72, 0.052, { cutoff: 760, attack: 0.05 });
    }

    if (step % 2 === 0) {
      const note = FROST_ARP[(step / 2 + bar * 2) % FROST_ARP.length];
      v.note('sine', note, t, 0.34, 0.048, { attack: 0.012 });
      v.note('triangle', note + 12, t + 0.012, 0.16, 0.018, { cutoff: 3600 });
    }

    if (on(step, [6, 14])) v.hat(t, 0.018, 5200);
  }),

  reactor: makeTrack('reactor', 132, (v, step, t) => {
    const barStep = step % 16;
    if (on(step, [0, 4, 8, 11])) v.kick(t, barStep === 0 ? 0.17 : 0.12);
    if (barStep % 2 === 1) v.hat(t, 0.022, 4300);

    const pulse = REACTOR_PULSE[step % REACTOR_PULSE.length];
    v.note('square', pulse, t, 0.062, 0.025, { cutoff: 1250 });

    if (step % 2 === 0) {
      const bass = REACTOR_BASS[(step / 2) % REACTOR_BASS.length];
      v.note('sawtooth', bass, t, 0.15, 0.068, { cutoff: 540 });
    }

    if (on(step, [0, 3, 7, 10, 14])) {
      const motif = [74, 77, 81, 79, 84][[0, 3, 7, 10, 14].indexOf(barStep)];
      v.note('triangle', motif, t, 0.12, 0.042, { endNote: motif + 0.8, cutoff: 2400 });
    }
  }),

  'sudden-death': makeTrack('sudden-death', 170, (v, step, t) => {
    const barStep = step % 16;
    if (barStep % 4 === 0 || barStep === 14) v.kick(t, barStep === 0 ? 0.21 : 0.15);
    if (barStep % 2 === 1) v.hat(t, 0.034, 4800);
    if (on(step, [4, 12])) v.clang(t, 0.045);

    if (step % 2 === 0) {
      const bass = SUDDEN_BASS[(step / 2) % SUDDEN_BASS.length];
      v.note('sawtooth', bass, t, 0.12, 0.085, { cutoff: 720 });
    }

    if (step % 8 === 0) {
      const alarm = (Math.floor(step / 8) % 2 === 0) ? 79 : 76;
      v.note('square', alarm, t, 0.32, 0.055, { endNote: alarm + 0.5, cutoff: 2100 });
      v.note('square', alarm + 12, t + 0.025, 0.23, 0.022, { cutoff: 2800 });
    }
  }),
});

/**
 * Resolve the soundtrack for an arena snapshot. Sudden Death intentionally
 * overrides the arena identity so every client switches to the same urgent cue.
 */
export function resolveMusicTrack(arenaLike, suddenDeath = false) {
  if (suddenDeath) return MUSIC_TRACKS['sudden-death'];
  const visual = getArenaVisual(arenaLike);
  return MUSIC_TRACKS[visual.id] || MUSIC_TRACKS.neon;
}

/**
 * Create a look-ahead Web Audio sequencer. `destination` is the SFX system's
 * master input, so music and effects share the same limiter while retaining
 * independent track crossfades.
 */
export function createMusicSequencer(ctx, destination) {
  let current = null;
  let noiseBuffer = null;

  function ensureNoise() {
    if (noiseBuffer) return noiseBuffer;
    noiseBuffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * 0.25), ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    return noiseBuffer;
  }

  function makeVoices(channel) {
    function note(type, midiNote, t0, duration, peak, options = {}) {
      const osc = ctx.createOscillator();
      const filter = ctx.createBiquadFilter();
      const gain = ctx.createGain();
      const attack = Math.min(options.attack ?? 0.006, duration * 0.45);

      osc.type = type;
      osc.frequency.setValueAtTime(midi(midiNote), t0);
      if (Number.isFinite(options.endNote)) {
        osc.frequency.exponentialRampToValueAtTime(midi(options.endNote), t0 + duration);
      }
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(options.cutoff || 3200, t0);
      filter.Q.value = options.q || 0.7;
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.linearRampToValueAtTime(peak, t0 + attack);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);

      osc.connect(filter);
      filter.connect(gain);
      gain.connect(channel);
      osc.onended = () => {
        osc.disconnect();
        filter.disconnect();
        gain.disconnect();
      };
      osc.start(t0);
      osc.stop(t0 + duration + 0.02);
    }

    function kick(t0, peak = 0.16) {
      note('sine', 45, t0, 0.14, peak, { endNote: 27, cutoff: 900 });
    }

    function hat(t0, peak = 0.028, cutoff = 6000) {
      const source = ctx.createBufferSource();
      const filter = ctx.createBiquadFilter();
      const gain = ctx.createGain();
      source.buffer = ensureNoise();
      filter.type = 'highpass';
      filter.frequency.setValueAtTime(cutoff, t0);
      gain.gain.setValueAtTime(peak, t0);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.045);
      source.connect(filter);
      filter.connect(gain);
      gain.connect(channel);
      source.onended = () => {
        source.disconnect();
        filter.disconnect();
        gain.disconnect();
      };
      source.start(t0);
      source.stop(t0 + 0.055);
    }

    function clang(t0, peak = 0.055) {
      note('triangle', 83, t0, 0.12, peak, { endNote: 71, cutoff: 3600 });
      note('square', 89, t0 + 0.006, 0.085, peak * 0.35, { cutoff: 4200 });
    }

    return { note, kick, hat, clang };
  }

  function fadeCurrent() {
    if (!current) return;
    const old = current;
    current = null;
    clearInterval(old.timer);
    const now = ctx.currentTime;
    old.channel.gain.cancelScheduledValues(now);
    old.channel.gain.setValueAtTime(Math.max(0.0001, old.channel.gain.value), now);
    old.channel.gain.exponentialRampToValueAtTime(0.0001, now + 0.16);
    setTimeout(() => old.channel.disconnect(), 500);
  }

  function setTrack(trackOrId) {
    const track = typeof trackOrId === 'string' ? MUSIC_TRACKS[trackOrId] : trackOrId;
    if (!track || current?.track.id === track.id) return;
    fadeCurrent();

    const channel = ctx.createGain();
    const now = ctx.currentTime;
    channel.gain.setValueAtTime(0.0001, now);
    channel.gain.exponentialRampToValueAtTime(TRACK_GAIN, now + 0.18);
    channel.connect(destination);

    const state = {
      track,
      channel,
      voices: makeVoices(channel),
      step: 0,
      nextTime: now + 0.025,
      timer: null,
    };
    current = state;

    const secondsPerStep = 60 / track.bpm / STEPS_PER_BEAT;
    const schedule = () => {
      if (current !== state) return;
      const horizon = ctx.currentTime + SCHEDULE_AHEAD;
      while (state.nextTime < horizon) {
        track.schedule(state.voices, state.step, state.nextTime);
        state.step = (state.step + 1) % track.steps;
        state.nextTime += secondsPerStep;
      }
    };
    schedule();
    state.timer = setInterval(schedule, LOOKAHEAD_MS);
  }

  function stop() {
    fadeCurrent();
  }

  function currentTrack() {
    return current?.track.id || null;
  }

  return { setTrack, stop, currentTrack };
}
