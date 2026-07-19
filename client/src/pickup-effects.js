import { GHOST_TIME, POWERUP, SHIELD_TIME } from '../../shared/constants.js';

export const PICKUP_POPUP_DURATION_MS = 1350;

const FALLBACK_EFFECT = Object.freeze({ text: 'Power-up', color: '#ffffff' });
const EFFECTS = Object.freeze({
  [POWERUP.BOMB]: Object.freeze({ text: 'Bombenkapazität ↑', color: '#ff5470' }),
  [POWERUP.RANGE]: Object.freeze({ text: 'Reichweite ↑', color: '#ffcf3f' }),
  [POWERUP.SPEED]: Object.freeze({ text: 'Tempo ↑', color: '#5dd95d' }),
  [POWERUP.GHOST]: Object.freeze({ text: `Wandlauf · ${GHOST_TIME}s`, color: '#b98cff' }),
  [POWERUP.PIERCE]: Object.freeze({ text: 'Durchschlag +1', color: '#ff8a3f' }),
  [POWERUP.SHIELD]: Object.freeze({ text: `Schild · ${SHIELD_TIME}s`, color: '#3fe0ff' }),
  [POWERUP.KICK]: Object.freeze({ text: 'Bomben-Kick aktiv', color: '#ff7ed4' }),
});

export function getPickupEffect(kind) {
  return EFFECTS[kind] || FALLBACK_EFFECT;
}

// Snapshots do not carry an explicit pickup event, so identify one by matching
// a vanished loose power-up to the living player now occupying that cell.
export function findPickupEffects(previous, next) {
  if (!previous?.powerups || !next?.powerups || !next?.players) return [];

  const remaining = new Set(next.powerups.map((pu) => `${pu.col}:${pu.row}`));
  const vanished = new Map();
  for (const pu of previous.powerups) {
    const cell = `${pu.col}:${pu.row}`;
    if (!remaining.has(cell)) vanished.set(cell, pu);
  }

  const events = [];
  for (const player of next.players) {
    if (!player.alive) continue;
    const cell = `${Math.floor(player.x)}:${Math.floor(player.y)}`;
    const pickup = vanished.get(cell);
    if (!pickup) continue;
    events.push({ slot: player.slot, kind: pickup.kind, ...getPickupEffect(pickup.kind) });
    vanished.delete(cell); // one pickup can only belong to one player
  }
  return events;
}
