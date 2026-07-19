// Client-only presentation data for arenas. Gameplay code can identify an
// arena by either its map id (for example "crossroads") or its authored theme
// (for example "magma-foundry"); both resolve to the same visual treatment.

function freezeVisual({ id, name, splash, palette }) {
  return Object.freeze({
    id,
    name,
    splash: Object.freeze(splash),
    palette: Object.freeze(palette),
  });
}

export const ARENA_VISUALS = Object.freeze({
  neon: freezeVisual({
    id: 'neon',
    name: 'Neon Reactor',
    splash: {
      src: '/splashes/neon-reactor.webp',
      alt: 'A blue and magenta neon reactor arena',
      eyebrow: 'ARENA ONLINE',
      title: 'Neon Reactor',
      subtitle: 'Cold light. Hot fuses.',
    },
    palette: {
      frameGlow: 'rgba(63, 182, 255, 0.28)',
      backdrop: '#0a0e1a',
      floorA: '#10162a',
      floorB: '#0d1322',
      grid: 'rgba(120, 150, 220, 0.06)',
      solidBase: '#243152',
      solidHighlight: 'rgba(150, 180, 255, 0.18)',
      solidShadow: 'rgba(0, 0, 0, 0.35)',
      solidEdge: 'rgba(120, 150, 220, 0.35)',
      brickBase: '#6b4630',
      brickMortar: 'rgba(0, 0, 0, 0.28)',
      brickHighlight: 'rgba(255, 200, 150, 0.14)',
    },
  }),

  foundry: freezeVisual({
    id: 'foundry',
    name: 'Magma Foundry',
    splash: {
      src: '/splashes/magma-foundry.webp',
      alt: 'An industrial foundry arena lit by molten magma',
      eyebrow: 'HEAT WARNING',
      title: 'Magma Foundry',
      subtitle: 'Every corridor runs hot.',
    },
    palette: {
      frameGlow: 'rgba(255, 105, 45, 0.30)',
      backdrop: '#160d0a',
      floorA: '#241510',
      floorB: '#1b100d',
      grid: 'rgba(255, 155, 92, 0.08)',
      solidBase: '#49332e',
      solidHighlight: 'rgba(255, 184, 120, 0.18)',
      solidShadow: 'rgba(19, 5, 2, 0.45)',
      solidEdge: 'rgba(255, 126, 73, 0.36)',
      brickBase: '#843e25',
      brickMortar: 'rgba(26, 7, 3, 0.46)',
      brickHighlight: 'rgba(255, 202, 132, 0.20)',
    },
  }),

  frost: freezeVisual({
    id: 'frost',
    name: 'Cryo Circuit',
    splash: {
      src: '/splashes/cryo-circuit.webp',
      alt: 'A frozen circuit arena glowing with cyan light',
      eyebrow: 'CORE TEMPERATURE',
      title: 'Cryo Circuit',
      subtitle: 'Keep moving or freeze out.',
    },
    palette: {
      frameGlow: 'rgba(112, 224, 255, 0.30)',
      backdrop: '#07131d',
      floorA: '#0d2030',
      floorB: '#091925',
      grid: 'rgba(172, 237, 255, 0.09)',
      solidBase: '#29485d',
      solidHighlight: 'rgba(218, 250, 255, 0.22)',
      solidShadow: 'rgba(0, 10, 20, 0.42)',
      solidEdge: 'rgba(133, 225, 255, 0.42)',
      brickBase: '#426d7f',
      brickMortar: 'rgba(1, 19, 31, 0.43)',
      brickHighlight: 'rgba(226, 252, 255, 0.22)',
    },
  }),

  reactor: freezeVisual({
    id: 'reactor',
    name: 'Switchyard Reactor',
    splash: {
      // The switchyard shares the reactor artwork while retaining its own
      // industrial green treatment on the board.
      src: '/splashes/neon-reactor.webp',
      alt: 'A charged reactor complex feeding an industrial switchyard',
      eyebrow: 'GRID CHARGED',
      title: 'Switchyard Reactor',
      subtitle: 'Mind the live rails.',
    },
    palette: {
      frameGlow: 'rgba(170, 255, 76, 0.27)',
      backdrop: '#09130f',
      floorA: '#122019',
      floorB: '#0d1914',
      grid: 'rgba(185, 255, 106, 0.08)',
      solidBase: '#344a40',
      solidHighlight: 'rgba(207, 255, 177, 0.17)',
      solidShadow: 'rgba(0, 12, 7, 0.43)',
      solidEdge: 'rgba(156, 222, 109, 0.38)',
      brickBase: '#716027',
      brickMortar: 'rgba(18, 19, 5, 0.44)',
      brickHighlight: 'rgba(244, 230, 133, 0.18)',
    },
  }),
});

const VISUAL_ALIASES = Object.freeze({
  classic: 'neon',
  neon: 'neon',
  'neon-reactor': 'neon',

  crossroads: 'foundry',
  foundry: 'foundry',
  'magma-foundry': 'foundry',

  citadel: 'frost',
  frost: 'frost',
  'cryo-circuit': 'frost',

  switchyard: 'reactor',
  reactor: 'reactor',
});

export const DEFAULT_ARENA_VISUAL = ARENA_VISUALS.neon;

function normalizeKey(value) {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase().replace(/[\s_]+/g, '-');
}

/**
 * Resolve a visual from a theme string, an `{ id, theme }` arena object, or a
 * snapshot-like `{ arena }` object. Unknown and missing values safely use neon.
 */
export function getArenaVisual(arenaLike) {
  let arena = arenaLike;
  if (arena && typeof arena === 'object' && arena.arena != null) {
    arena = arena.arena;
  }

  const candidates = typeof arena === 'string'
    ? [arena]
    : [arena?.theme, arena?.id];

  for (const candidate of candidates) {
    const visualId = VISUAL_ALIASES[normalizeKey(candidate)];
    if (visualId) return ARENA_VISUALS[visualId];
  }

  return DEFAULT_ARENA_VISUAL;
}
