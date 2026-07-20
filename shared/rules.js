// Canonical match-rule validation shared by browser, server, engine and wire
// payloads. Keep this module data-only: normalized rules must round-trip through
// JSON without losing information or requiring environment-specific types.

const LIMITS = Object.freeze({
  winsToWin: Object.freeze({ min: 1, max: 9 }),
  suddenDeathSeconds: Object.freeze({ min: 30, max: 300 }),
  playerTarget: Object.freeze({ min: 2, max: 4 }),
  botCount: Object.freeze({ min: 0, max: 3 }),
});

const POWERUP_RATES = Object.freeze(['low', 'normal', 'high']);
const ARENAS = Object.freeze([
  'shuffle',
  'classic',
  'crossroads',
  'citadel',
  'switchyard',
]);
const MODES = Object.freeze(['ffa', 'teams']);

/**
 * Invariants of every exported/normalized rule set:
 * - all values are JSON primitives and the containing object is frozen;
 * - numeric settings are finite integers inside their documented bounds;
 * - enum settings contain only canonical lower-case whitelist values;
 * - FFA targets 2..4 players, while teams always targets exactly 4;
 * - bots never occupy every slot (at least one human slot remains).
 */
export const DEFAULT_RULES = Object.freeze({
  winsToWin: 3,
  suddenDeathSeconds: 90,
  powerupRate: 'normal',
  arena: 'shuffle',
  botCount: 0,
  mode: 'ffa',
  playerTarget: 2,
});

function boundedInteger(value, fallback, { min, max }) {
  // HTML controls and wire payloads commonly carry numbers as strings. Blank
  // strings and non-number primitives are malformed rather than zero.
  if (typeof value !== 'number' && typeof value !== 'string') return fallback;
  if (typeof value === 'string' && value.trim() === '') return fallback;

  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function whitelisted(value, allowed, fallback) {
  if (typeof value !== 'string') return fallback;
  const candidate = value.trim().toLowerCase();
  return allowed.includes(candidate) ? candidate : fallback;
}

/**
 * Return a fresh, frozen canonical rule set without mutating `input`.
 *
 * Unknown fields are intentionally discarded so this function can also serve
 * as the trust boundary for unvalidated network payloads.
 */
export function normalizeRules(input) {
  const source = input && typeof input === 'object' && !Array.isArray(input)
    ? input
    : {};

  const mode = whitelisted(source.mode, MODES, DEFAULT_RULES.mode);
  const requestedTarget = boundedInteger(
    source.playerTarget,
    DEFAULT_RULES.playerTarget,
    LIMITS.playerTarget,
  );
  const playerTarget = mode === 'teams' ? 4 : requestedTarget;
  const requestedBots = boundedInteger(
    source.botCount,
    DEFAULT_RULES.botCount,
    LIMITS.botCount,
  );

  return Object.freeze({
    winsToWin: boundedInteger(
      source.winsToWin,
      DEFAULT_RULES.winsToWin,
      LIMITS.winsToWin,
    ),
    suddenDeathSeconds: boundedInteger(
      source.suddenDeathSeconds,
      DEFAULT_RULES.suddenDeathSeconds,
      LIMITS.suddenDeathSeconds,
    ),
    powerupRate: whitelisted(
      source.powerupRate,
      POWERUP_RATES,
      DEFAULT_RULES.powerupRate,
    ),
    arena: whitelisted(source.arena, ARENAS, DEFAULT_RULES.arena),
    botCount: Math.min(requestedBots, playerTarget - 1),
    mode,
    playerTarget,
  });
}
