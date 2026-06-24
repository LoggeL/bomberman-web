// Shared constants for both client and server. Pure data, no imports.
// Grid is odd-by-odd so the classic Bomberman pillar pattern works out.

export const COLS = 15;
export const ROWS = 13;
export const TILE = 40; // logical pixels per tile (rendering scales this)

// Tile types stored in the grid.
export const CELL = {
  EMPTY: 0,
  SOLID: 1, // indestructible pillar
  BRICK: 2, // destructible, may hide a powerup
};

// Powerup kinds. Stored on a cell after a brick is destroyed.
export const POWERUP = {
  NONE: 0,
  BOMB: 1, // +1 max concurrent bombs
  RANGE: 2, // +1 explosion range
  SPEED: 3, // + movement speed
  GHOST: 4, // walk through destructible bricks (wallpass) — temporary
  PIERCE: 5, // blasts tear through bricks instead of stopping at the first
  SHIELD: 6, // absorb one otherwise-lethal blast (stackable, with brief i-frames)
  KICK: 7, // kick a bomb you walk into so it slides until it hits something
};

// Simulation tuning.
export const TICK_HZ = 60; // fixed engine step
export const TICK_DT = 1 / TICK_HZ;

export const BOMB_FUSE = 2.4; // seconds before a bomb detonates
export const FLAME_TIME = 0.5; // seconds a flame tile stays lethal
export const BRICK_FILL = 0.78; // fraction of free cells filled with bricks
export const POWERUP_CHANCE = 0.42; // chance a destroyed brick drops a powerup

// Player movement, in tiles/second.
export const BASE_SPEED = 4.2;
export const SPEED_PER_PICKUP = 0.9;
export const MAX_SPEED_PICKUPS = 4;

export const START_BOMBS = 1;
export const START_RANGE = 2;
export const MAX_BOMBS = 8;
export const MAX_RANGE = 8;
export const MAX_SHIELD = 3;        // how many shield charges a player can hold
export const SHIELD_INVULN = 1.2;   // seconds of i-frames after a shield absorbs a hit
export const GHOST_TIME = 8;        // seconds of wallpass per GHOST pickup (re-arms on pickup)
export const KICK_SPEED = 7.5;      // tiles/second a kicked bomb slides
export const SPAWN_BOMB_LOCK = 1.0; // seconds after spawn before bombs can be placed

// Players spawn in the four corners. Order matters: P1..P4.
export const SPAWNS = [
  { col: 1, row: 1 },
  { col: COLS - 2, row: ROWS - 2 },
  { col: COLS - 2, row: 1 },
  { col: 1, row: ROWS - 2 },
];

// Player colors (also used by the UI). Index = player slot.
export const PLAYER_COLORS = ['#ff5470', '#3fb6ff', '#5dd95d', '#ffcf3f'];
export const PLAYER_NAMES = ['Rot', 'Blau', 'Grün', 'Gelb'];

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 4;

// Win/round flow.
export const ROUND_END_DELAY = 3.0; // seconds shown after a round resolves
export const SUDDEN_DEATH_TIME = 90; // seconds before walls start closing in
