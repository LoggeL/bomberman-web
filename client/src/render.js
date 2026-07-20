// Canvas renderer for the Bomberman board.
//
// createRenderer(canvas) -> { resize(), draw(snap, { localSlots, pickupPopups }), shake(magnitude) }
//
// The board is COLS x ROWS logical tiles. We compute an integer-ish tile size
// that fits the viewport, centre the board, and draw everything in device
// pixels (scaled for devicePixelRatio) so it stays crisp on HiDPI screens.
//
// PERFORMANCE MODEL
// -----------------
// The expensive parts of canvas rendering here are (a) re-stroking the whole
// grid every frame and (b) toggling ctx.shadowBlur dozens of times per frame
// (each shadowed draw is effectively a blur pass). Both of those belong to the
// *static* terrain, which only changes on resize or when a brick is destroyed.
//
// So we cache two offscreen layers and blit them with a single drawImage each:
//   - FLOOR layer:   checkerboard + faint grid lines + board backdrop/frame
//                    glow. Rebuilt on resize() or when the arena theme changes.
//   - TERRAIN layer: solid pillars + bricks. Rebuilt only when snap.grid
//                    actually changes (cheap signature compare), the arena
//                    theme changes, or on resize().
//
// Everything genuinely dynamic (powerups, bombs, flames, players) is still
// drawn per frame, but we keep shadowBlur usage to a small handful of entities
// and prefer pre-baked radial gradients for glow where it reads the same.

import {
  COLS, ROWS, CELL, POWERUP, BOMB_FUSE, PLAYER_COLORS, GHOST_TIME, SHIELD_TIME,
} from '../../shared/constants.js';
import { getArenaVisual } from './arena-visuals.js';

const PLAYER_SPRITE_URLS = [
  '/sprites/player-red.webp',
  '/sprites/player-blue.webp',
  '/sprites/player-green.webp',
  '/sprites/player-yellow.webp',
];

const ARENA_TILE_URLS = Object.freeze({
  neon: '/tiles/neon-tiles.webp',
  foundry: '/tiles/foundry-tiles.webp',
  frost: '/tiles/frost-tiles.webp',
  reactor: '/tiles/reactor-tiles.webp',
});

// Player sheets are 4×2:
//   down A/B, right A/B
//   left A/B, up A/B
const PLAYER_FRAMES = Object.freeze({
  down: Object.freeze({ col: 0, row: 0 }),
  left: Object.freeze({ col: 0, row: 1 }),
  right: Object.freeze({ col: 2, row: 0 }),
  up: Object.freeze({ col: 2, row: 1 }),
});

// The generated poses are not perfectly centred inside their source cells.
// Anchor each frame at the character's visual centre and foot line so changing
// walk phase animates the limbs without making the whole player wobble.
const PLAYER_FRAME_ANCHORS = Object.freeze({
  down: Object.freeze([
    Object.freeze({ x: 0.622, y: 0.833 }),
    Object.freeze({ x: 0.539, y: 0.834 }),
  ]),
  right: Object.freeze([
    Object.freeze({ x: 0.455, y: 0.834 }),
    Object.freeze({ x: 0.375, y: 0.828 }),
  ]),
  left: Object.freeze([
    Object.freeze({ x: 0.561, y: 0.740 }),
    Object.freeze({ x: 0.467, y: 0.734 }),
  ]),
  up: Object.freeze([
    Object.freeze({ x: 0.433, y: 0.736 }),
    Object.freeze({ x: 0.358, y: 0.742 }),
  ]),
});

const POWERUP_ATLAS_CELLS = Object.freeze({
  [POWERUP.BOMB]: Object.freeze({ col: 0, row: 0 }),
  [POWERUP.RANGE]: Object.freeze({ col: 1, row: 0 }),
  [POWERUP.SPEED]: Object.freeze({ col: 2, row: 0 }),
  [POWERUP.GHOST]: Object.freeze({ col: 3, row: 0 }),
  [POWERUP.PIERCE]: Object.freeze({ col: 0, row: 1 }),
  [POWERUP.SHIELD]: Object.freeze({ col: 1, row: 1 }),
  [POWERUP.KICK]: Object.freeze({ col: 2, row: 1 }),
});

function loadImage(src) {
  const image = new Image();
  image.decoding = 'async';
  image.src = src;
  return image;
}

export function createRenderer(canvas) {
  const ctx = canvas.getContext('2d');
  const playerSprites = PLAYER_SPRITE_URLS.map(loadImage);
  const powerupAtlas = loadImage('/sprites/modern-arcade-atlas.webp');
  const arenaTileAtlases = Object.fromEntries(
    Object.entries(ARENA_TILE_URLS).map(([id, src]) => [id, loadImage(src)]),
  );

  // Layout (recomputed on resize): tile size + board origin in CSS pixels.
  let dpr = 1;
  let tile = 40;
  let originX = 0;
  let originY = 0;
  let viewW = 0;
  let viewH = 0;

  // Offscreen cached layers. We draw into these in CSS-pixel coordinates after
  // scaling their context by dpr, so they render crisp at HiDPI and can be
  // blitted 1:1 over the (also dpr-scaled) main context.
  const floorCanvas = document.createElement('canvas');
  const floorCtx = floorCanvas.getContext('2d');
  const terrainCanvas = document.createElement('canvas');
  const terrainCtx = terrainCanvas.getContext('2d');

  // Begin with the safe fallback so resize() can build a complete floor before
  // the first snapshot arrives. draw() replaces it when an arena is announced.
  let activeArenaVisual = getArenaVisual(null);

  // The terrain layer is keyed by a signature of the grid contents; when the
  // signature is unchanged we skip the (relatively pricey) terrain rebuild.
  let terrainSig = null;

  // Tile atlases may arrive after the first frame. Refresh the cached static
  // layers as each image becomes available so the procedural fallback is
  // replaced without waiting for a resize or round transition.
  for (const image of Object.values(arenaTileAtlases)) {
    image.addEventListener('load', () => {
      renderFloorLayer(activeArenaVisual.palette, activeArenaVisual.id);
      terrainSig = null;
    }, { once: true });
  }

  // A monotonic clock for animations (pulsing bombs, flame flicker, etc.).
  const startTime = performance.now();
  const now = () => (performance.now() - startTime) / 1000;

  // ---- screen shake ---------------------------------------------------------
  // `shakeAmt` is the current shake energy in CSS pixels; it decays every frame.
  // `shakeFrame` is an internal counter that drives a deterministic pseudo-random
  // offset so we never call Math.random per frame and the motion stays smooth.
  let shakeAmt = 0;
  let shakeFrame = 0;
  const SHAKE_MAX = 18;          // hard cap so the board can't fly off-screen
  const SHAKE_DECAY = 0.86;      // multiplicative per-frame decay

  function shake(magnitude) {
    // Accumulate energy but clamp; safe to call on every explosion.
    shakeAmt = Math.min(SHAKE_MAX, shakeAmt + (magnitude || 0));
  }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    viewW = window.innerWidth;
    viewH = window.innerHeight;

    canvas.width = Math.round(viewW * dpr);
    canvas.height = Math.round(viewH * dpr);
    canvas.style.width = viewW + 'px';
    canvas.style.height = viewH + 'px';

    // Fit the board into the viewport with a little breathing room.
    const padX = 24;
    const padTop = 84;   // leave room for the HUD bar at the top
    const padBottom = 24;
    const availW = viewW - padX * 2;
    const availH = viewH - padTop - padBottom;
    tile = Math.max(16, Math.floor(Math.min(availW / COLS, availH / ROWS)));

    const boardW = tile * COLS;
    const boardH = tile * ROWS;
    originX = Math.floor((viewW - boardW) / 2);
    originY = Math.floor(padTop + (availH - boardH) / 2);

    // Size both offscreen layers to the full viewport in device pixels and
    // scale their contexts so we can keep drawing in CSS-pixel coordinates.
    for (const c of [floorCanvas, terrainCanvas]) {
      c.width = canvas.width;
      c.height = canvas.height;
    }
    floorCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    terrainCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // The floor is fully determined by layout and the active arena palette.
    renderFloorLayer(activeArenaVisual.palette, activeArenaVisual.id);
    // ...and force the terrain layer to rebuild on the next draw().
    terrainSig = null;
  }

  // ---- small drawing helpers ------------------------------------------------

  // Position helpers: convert tile coords to CSS pixels at the board origin.
  const px = (col) => originX + col * tile;
  const py = (row) => originY + row * tile;

  function roundRect(c, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    c.beginPath();
    c.moveTo(x + rr, y);
    c.arcTo(x + w, y, x + w, y + h, rr);
    c.arcTo(x + w, y + h, x, y + h, rr);
    c.arcTo(x, y + h, x, y, rr);
    c.arcTo(x, y, x + w, y, rr);
    c.closePath();
  }

  function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function imageReady(image) {
    return image?.complete && image.naturalWidth > 0 && image.naturalHeight > 0;
  }

  function drawSpriteCell(image, col, row, cols, rows, x, y, width, height) {
    if (!imageReady(image)) return false;
    const sourceWidth = image.naturalWidth / cols;
    const sourceHeight = image.naturalHeight / rows;
    ctx.drawImage(
      image,
      col * sourceWidth,
      row * sourceHeight,
      sourceWidth,
      sourceHeight,
      x,
      y,
      width,
      height,
    );
    return true;
  }

  function drawAtlasCell(c, image, col, row, cols, rows, x, y, width, height) {
    if (!imageReady(image)) return false;
    const cellWidth = image.naturalWidth / cols;
    const cellHeight = image.naturalHeight / rows;
    // Trim half a source pixel from each edge to prevent texture bleeding from
    // neighbouring atlas cells while the browser downsamples to board tiles.
    const inset = 0.5;
    c.drawImage(
      image,
      col * cellWidth + inset,
      row * cellHeight + inset,
      cellWidth - inset * 2,
      cellHeight - inset * 2,
      x,
      y,
      width,
      height,
    );
    return true;
  }

  function tileVariant(col, row, salt = 0) {
    return (col * 7 + row * 11 + salt) & 1;
  }

  function getFont() {
    return "'Segoe UI', system-ui, sans-serif";
  }

  // ---- static FLOOR layer (rebuilt on resize/theme change) ------------------

  // Renders the board backdrop/frame glow, the checkerboard, and the faint grid
  // lines into the floor offscreen canvas. The frame glow uses shadowBlur, but
  // because it's baked here it costs nothing per frame.
  function renderFloorLayer(palette, visualId) {
    const c = floorCtx;
    c.clearRect(0, 0, viewW, viewH);

    const boardW = tile * COLS, boardH = tile * ROWS;

    // Board backdrop with a soft neon frame glow.
    c.save();
    c.shadowColor = palette.frameGlow;
    c.shadowBlur = 30;
    c.fillStyle = palette.backdrop;
    roundRect(c, originX - 6, originY - 6, boardW + 12, boardH + 12, 14);
    c.fill();
    c.restore();

    // Clip to the board so the checkerboard/grid stay inside the rounded arena.
    c.save();
    roundRect(c, originX, originY, boardW, boardH, 8);
    c.clip();

    // Each arena has two seamless floor variants. Keep the old checkerboard as
    // an immediate fallback while the atlas is loading or if an asset fails.
    const atlas = arenaTileAtlases[visualId];
    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        const variant = tileVariant(col, row);
        if (!drawAtlasCell(c, atlas, 0, variant, 3, 2, px(col), py(row), tile, tile)) {
          c.fillStyle = variant === 0 ? palette.floorA : palette.floorB;
          c.fillRect(px(col), py(row), tile, tile);
        }
      }
    }

    // Faint grid lines for that arcade-floor feel.
    c.strokeStyle = palette.grid;
    c.lineWidth = 1;
    c.beginPath();
    for (let col = 0; col <= COLS; col++) {
      c.moveTo(px(col) + 0.5, py(0));
      c.lineTo(px(col) + 0.5, py(ROWS));
    }
    for (let row = 0; row <= ROWS; row++) {
      c.moveTo(px(0), py(row) + 0.5);
      c.lineTo(px(COLS), py(row) + 0.5);
    }
    c.stroke();

    c.restore();
  }

  // ---- static TERRAIN layer (rebuilt only when the grid changes) ------------

  // Cheap signature of the grid: only solids/bricks matter for terrain, and the
  // grid is a flat int array, so a join is plenty fast for a 15x13 board and is
  // far cheaper than rebuilding the bevelled tiles every frame.
  function gridSignature(grid, visualId) {
    // Include tile size and the resolved visual so either layout or arena
    // changes invalidate the otherwise-identical terrain cache.
    let sig = visualId + ':' + tile + ':';
    for (let i = 0; i < grid.length; i++) {
      const v = grid[i];
      // Only SOLID/BRICK affect the rendered terrain; collapse everything else.
      sig += (v === CELL.SOLID || v === CELL.BRICK) ? v : '0';
    }
    return sig;
  }

  function renderTerrainLayer(grid, palette, visualId) {
    const c = terrainCtx;
    c.clearRect(0, 0, viewW, viewH);

    // Clip to the board so bevelled edges stay tidy at the arena border.
    const boardW = tile * COLS, boardH = tile * ROWS;
    c.save();
    roundRect(c, originX, originY, boardW, boardH, 8);
    c.clip();

    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        const v = grid[row * COLS + col];
        if (v === CELL.SOLID) drawSolid(c, col, row, palette, visualId);
        else if (v === CELL.BRICK) drawBrick(c, col, row, palette, visualId);
      }
    }

    c.restore();
  }

  function drawSolid(c, col, row, palette, visualId) {
    const x = px(col), y = py(row);
    const t = tile;
    if (drawAtlasCell(
      c,
      arenaTileAtlases[visualId],
      1,
      tileVariant(col, row, 1),
      3,
      2,
      x,
      y,
      t,
      t,
    )) return;

    // 3D-ish bevelled pillar.
    c.fillStyle = palette.solidBase;
    roundRect(c, x + 1, y + 1, t - 2, t - 2, 5);
    c.fill();
    // top-left highlight
    c.fillStyle = palette.solidHighlight;
    roundRect(c, x + 2, y + 2, t - 4, (t - 4) * 0.45, 4);
    c.fill();
    // bottom shadow
    c.fillStyle = palette.solidShadow;
    roundRect(c, x + 2, y + t * 0.6, t - 4, t * 0.36, 4);
    c.fill();
    // crisp edge
    c.strokeStyle = palette.solidEdge;
    c.lineWidth = 1;
    roundRect(c, x + 1.5, y + 1.5, t - 3, t - 3, 5);
    c.stroke();
  }

  function drawBreakableCue(c, x, y, t) {
    c.save();
    c.lineCap = 'round';
    c.lineJoin = 'round';

    // A segmented warm inner rim reads as "destructible" independently of the
    // arena palette, while solid walls keep their uninterrupted heavy outline.
    c.strokeStyle = 'rgba(255, 205, 105, 0.42)';
    c.lineWidth = Math.max(1, t * 0.032);
    c.setLineDash([t * 0.13, t * 0.16]);
    roundRect(c, x + t * 0.1, y + t * 0.1, t * 0.8, t * 0.8, t * 0.08);
    c.stroke();
    c.setLineDash([]);

    // Dual-tone crack stays visible over both bright frost and dark foundry
    // textures without turning the block into a UI icon.
    c.beginPath();
    c.moveTo(x + t * 0.53, y + t * 0.26);
    c.lineTo(x + t * 0.45, y + t * 0.42);
    c.lineTo(x + t * 0.56, y + t * 0.54);
    c.lineTo(x + t * 0.47, y + t * 0.74);
    c.strokeStyle = 'rgba(255, 215, 135, 0.34)';
    c.lineWidth = Math.max(1.4, t * 0.055);
    c.stroke();
    c.strokeStyle = 'rgba(20, 12, 18, 0.78)';
    c.lineWidth = Math.max(1, t * 0.026);
    c.stroke();
    c.restore();
  }

  function drawBrick(c, col, row, palette, visualId) {
    const x = px(col), y = py(row);
    const t = tile;
    const usedAtlas = drawAtlasCell(
      c,
      arenaTileAtlases[visualId],
      2,
      tileVariant(col, row, 2),
      3,
      2,
      x,
      y,
      t,
      t,
    );

    if (!usedAtlas) {
      c.fillStyle = palette.brickBase;
      roundRect(c, x + 1, y + 1, t - 2, t - 2, 4);
      c.fill();
      // brick courses
      c.strokeStyle = palette.brickMortar;
      c.lineWidth = Math.max(1, t * 0.045);
      const rows = 3;
      const rh = (t - 2) / rows;
      c.beginPath();
      for (let i = 1; i < rows; i++) {
        c.moveTo(x + 2, y + 1 + i * rh);
        c.lineTo(x + t - 2, y + 1 + i * rh);
      }
      // offset vertical joints
      for (let i = 0; i < rows; i++) {
        const offset = i % 2 === 0 ? t * 0.5 : t * 0.25;
        c.moveTo(x + offset, y + 1 + i * rh);
        c.lineTo(x + offset, y + 1 + (i + 1) * rh);
      }
      c.stroke();
      // top highlight
      c.fillStyle = palette.brickHighlight;
      c.fillRect(x + 2, y + 2, t - 4, Math.max(1, t * 0.08));
    } else if (palette.brickTint) {
      // Keep the authored texture and cracks, but shift the destructible atlas
      // cell toward a map-specific accent. source-atop confines the wash to the
      // already-drawn tile instead of painting an opaque square around it.
      c.save();
      c.globalCompositeOperation = 'source-atop';
      c.globalAlpha = palette.brickTintAlpha ?? 0.35;
      c.fillStyle = palette.brickTint;
      roundRect(c, x + 1, y + 1, t - 2, t - 2, 4);
      c.fill();
      c.restore();
    }

    if (palette.brickEdge) {
      c.strokeStyle = palette.brickEdge;
      c.lineWidth = Math.max(1, t * 0.035);
      roundRect(c, x + 1.5, y + 1.5, t - 3, t - 3, 4);
      c.stroke();
    }

    drawBreakableCue(c, x, y, t);
  }

  // ---- arena mechanics (dynamic floor overlays) ---------------------------

  function drawArenaMechanic(mechanic) {
    if (!mechanic || mechanic.kind === 'none') return;
    const pulse = 0.5 + 0.5 * Math.sin(now() * 5);

    ctx.save();
    if (mechanic.kind === 'portals') {
      for (const portal of mechanic.portals || []) {
        const x = px(portal.col) + tile / 2;
        const y = py(portal.row) + tile / 2;
        const color = portal.id === 'north' ? '#50d8ff' : '#ec65ff';
        ctx.strokeStyle = color;
        ctx.lineWidth = Math.max(2, tile * 0.06);
        ctx.shadowColor = color;
        ctx.shadowBlur = tile * (0.25 + pulse * 0.25);
        ctx.beginPath();
        ctx.ellipse(x, y, tile * (0.29 + pulse * 0.03), tile * 0.18, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 0.22 + pulse * 0.12;
        ctx.fillStyle = color;
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    } else if (mechanic.kind === 'lava') {
      for (const vent of mechanic.vents || []) {
        const x = px(vent.col), y = py(vent.row);
        const active = vent.state === 'active';
        const warning = vent.state === 'telegraph';
        ctx.fillStyle = active
          ? `rgba(255, 70, 22, ${0.58 + pulse * 0.22})`
          : warning
            ? `rgba(255, 190, 45, ${0.18 + pulse * 0.2})`
            : 'rgba(115, 45, 24, 0.2)';
        ctx.strokeStyle = active ? '#fff0a6' : warning ? '#ffbd3f' : 'rgba(255, 120, 65, 0.35)';
        ctx.lineWidth = Math.max(1.5, tile * 0.045);
        ctx.shadowColor = active ? '#ff4a22' : '#ff9b3f';
        ctx.shadowBlur = active || warning ? tile * 0.38 : 0;
        roundRect(ctx, x + tile * 0.13, y + tile * 0.13, tile * 0.74, tile * 0.74, tile * 0.18);
        ctx.fill();
        ctx.stroke();
      }
    } else if (mechanic.kind === 'ice') {
      for (const cell of mechanic.cells || []) {
        const x = px(cell.col), y = py(cell.row);
        ctx.fillStyle = 'rgba(136, 226, 255, 0.13)';
        ctx.strokeStyle = 'rgba(200, 248, 255, 0.34)';
        ctx.lineWidth = Math.max(1, tile * 0.025);
        roundRect(ctx, x + tile * 0.06, y + tile * 0.06, tile * 0.88, tile * 0.88, tile * 0.18);
        ctx.fill();
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x + tile * 0.22, y + tile * 0.72);
        ctx.lineTo(x + tile * 0.72, y + tile * 0.22);
        ctx.stroke();
      }
    } else if (mechanic.kind === 'rails') {
      for (const rail of mechanic.rails || []) {
        const x = px(rail.col), y = py(rail.row);
        ctx.fillStyle = 'rgba(175, 255, 87, 0.1)';
        ctx.strokeStyle = 'rgba(190, 255, 105, 0.42)';
        ctx.lineWidth = Math.max(1.5, tile * 0.04);
        roundRect(ctx, x + tile * 0.09, y + tile * 0.18, tile * 0.82, tile * 0.64, tile * 0.12);
        ctx.fill();
        ctx.stroke();
        if (rail.dx || rail.dy) {
          const cx = x + tile / 2, cy = y + tile / 2;
          const dx = rail.dx * tile * 0.22, dy = rail.dy * tile * 0.22;
          ctx.beginPath();
          ctx.moveTo(cx - dx, cy - dy);
          ctx.lineTo(cx + dx, cy + dy);
          ctx.lineTo(cx + dx - rail.dx * tile * 0.12 + rail.dy * tile * 0.12,
            cy + dy - rail.dy * tile * 0.12 - rail.dx * tile * 0.12);
          ctx.moveTo(cx + dx, cy + dy);
          ctx.lineTo(cx + dx - rail.dx * tile * 0.12 - rail.dy * tile * 0.12,
            cy + dy - rail.dy * tile * 0.12 + rail.dx * tile * 0.12);
          ctx.stroke();
        }
      }
    }
    ctx.restore();
  }

  // ---- powerups (dynamic) ---------------------------------------------------

  function drawPowerup(col, row, kind) {
    const x = px(col) + tile / 2;
    const y = py(row) + tile / 2;
    const r = tile * 0.32;
    const bob = Math.sin(now() * 3 + col + row) * tile * 0.04;
    const cy = y + bob;

    let color, glyph;
    if (kind === POWERUP.BOMB) { color = '#ff5470'; glyph = 'bomb'; }
    else if (kind === POWERUP.RANGE) { color = '#ffcf3f'; glyph = 'range'; }
    else if (kind === POWERUP.SPEED) { color = '#5dd95d'; glyph = 'speed'; }
    else if (kind === POWERUP.GHOST) { color = '#b98cff'; glyph = 'ghost'; }
    else if (kind === POWERUP.PIERCE) { color = '#ff8a3f'; glyph = 'pierce'; }
    else if (kind === POWERUP.KICK) { color = '#ff7ed4'; glyph = 'kick'; }
    else if (kind === POWERUP.SHIELD) { color = '#3fe0ff'; glyph = 'shield'; }
    else if (kind === POWERUP.REMOTE) { color = '#8fe7ff'; glyph = 'remote'; }
    else { color = '#f4a8ff'; glyph = 'throw'; }

    // glowing pill (one shadowBlur use per powerup; there are only a few on
    // screen at once, so this stays cheap)
    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = tile * 0.4;
    ctx.fillStyle = 'rgba(8, 11, 20, 0.85)';
    roundRect(ctx, x - r, cy - r, r * 2, r * 2, r * 0.5);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.lineWidth = Math.max(1.5, tile * 0.05);
    ctx.strokeStyle = color;
    roundRect(ctx, x - r, cy - r, r * 2, r * 2, r * 0.5);
    ctx.stroke();
    ctx.restore();

    const atlasCell = POWERUP_ATLAS_CELLS[kind];
    if (atlasCell && imageReady(powerupAtlas)) {
      const width = tile * 0.9;
      const height = width * (powerupAtlas.naturalHeight / 2) /
        (powerupAtlas.naturalWidth / 4);
      ctx.save();
      ctx.shadowColor = color;
      ctx.shadowBlur = tile * 0.18;
      drawSpriteCell(
        powerupAtlas,
        atlasCell.col,
        atlasCell.row,
        4,
        2,
        x - width / 2,
        cy - height / 2,
        width,
        height,
      );
      ctx.restore();
      return;
    }

    // icon
    ctx.save();
    ctx.translate(x, cy);
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = Math.max(1.5, tile * 0.05);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (glyph === 'bomb') {
      // little bomb circle + fuse
      ctx.beginPath();
      ctx.arc(0, r * 0.18, r * 0.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(r * 0.25, -r * 0.25);
      ctx.lineTo(r * 0.5, -r * 0.55);
      ctx.stroke();
    } else if (glyph === 'range') {
      // four-way arrow burst
      const a = r * 0.55;
      ctx.beginPath();
      for (let i = 0; i < 4; i++) {
        const ang = (Math.PI / 2) * i;
        const dx = Math.cos(ang), dy = Math.sin(ang);
        ctx.moveTo(0, 0); ctx.lineTo(dx * a, dy * a);
        // arrowhead
        ctx.moveTo(dx * a, dy * a);
        ctx.lineTo(dx * a - dy * a * 0.3 - dx * a * 0.3, dy * a + dx * a * 0.3 - dy * a * 0.3);
        ctx.moveTo(dx * a, dy * a);
        ctx.lineTo(dx * a + dy * a * 0.3 - dx * a * 0.3, dy * a - dx * a * 0.3 - dy * a * 0.3);
      }
      ctx.stroke();
    } else if (glyph === 'speed') {
      // lightning bolt
      ctx.beginPath();
      ctx.moveTo(r * 0.15, -r * 0.55);
      ctx.lineTo(-r * 0.35, r * 0.1);
      ctx.lineTo(0, r * 0.1);
      ctx.lineTo(-r * 0.15, r * 0.55);
      ctx.lineTo(r * 0.4, -r * 0.1);
      ctx.lineTo(0, -r * 0.1);
      ctx.closePath();
      ctx.fill();
    } else if (glyph === 'ghost') {
      // little ghost silhouette + punched-out eyes
      const gr = r * 0.52;
      ctx.beginPath();
      ctx.arc(0, -r * 0.02, gr, Math.PI, 0);  // rounded head
      ctx.lineTo(gr, r * 0.5);
      ctx.lineTo(gr * 0.5, r * 0.3);
      ctx.lineTo(0, r * 0.5);
      ctx.lineTo(-gr * 0.5, r * 0.3);
      ctx.lineTo(-gr, r * 0.5);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = 'rgba(8, 11, 20, 0.95)';
      for (const sx of [-1, 1]) {
        ctx.beginPath();
        ctx.arc(sx * gr * 0.38, -r * 0.05, gr * 0.2, 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (glyph === 'pierce') {
      // double chevron » suggesting a blast tearing through
      ctx.lineWidth = Math.max(2, tile * 0.07);
      for (const ox of [-r * 0.22, r * 0.22]) {
        ctx.beginPath();
        ctx.moveTo(ox - r * 0.22, -r * 0.42);
        ctx.lineTo(ox + r * 0.28, 0);
        ctx.lineTo(ox - r * 0.22, r * 0.42);
        ctx.stroke();
      }
    } else if (glyph === 'kick') {
      // a ball being booted: small circle + motion arrow
      ctx.beginPath();
      ctx.arc(-r * 0.3, 0, r * 0.26, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = Math.max(2, tile * 0.06);
      ctx.beginPath();
      ctx.moveTo(r * 0.0, 0); ctx.lineTo(r * 0.52, 0);
      ctx.moveTo(r * 0.52, 0); ctx.lineTo(r * 0.3, -r * 0.2);
      ctx.moveTo(r * 0.52, 0); ctx.lineTo(r * 0.3, r * 0.2);
      ctx.stroke();
    } else if (glyph === 'remote') {
      // antenna with two radio-wave arcs
      ctx.beginPath();
      ctx.arc(0, r * 0.34, r * 0.16, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(0, r * 0.2);
      ctx.lineTo(0, -r * 0.45);
      ctx.stroke();
      for (const radius of [r * 0.34, r * 0.58]) {
        ctx.beginPath();
        ctx.arc(0, -r * 0.38, radius, Math.PI * 1.15, Math.PI * 1.85);
        ctx.stroke();
      }
    } else if (glyph === 'throw') {
      // glove/hand shape with a rising throw arc
      ctx.beginPath();
      ctx.moveTo(-r * 0.48, r * 0.32);
      ctx.lineTo(-r * 0.2, -r * 0.12);
      ctx.lineTo(-r * 0.05, r * 0.05);
      ctx.lineTo(r * 0.08, -r * 0.32);
      ctx.lineTo(r * 0.25, -r * 0.24);
      ctx.lineTo(r * 0.18, r * 0.04);
      ctx.lineTo(r * 0.42, -r * 0.08);
      ctx.lineTo(r * 0.5, r * 0.12);
      ctx.lineTo(r * 0.14, r * 0.5);
      ctx.closePath();
      ctx.fill();
    } else {
      // shield crest
      ctx.beginPath();
      ctx.moveTo(0, -r * 0.62);
      ctx.lineTo(r * 0.52, -r * 0.34);
      ctx.lineTo(r * 0.52, r * 0.12);
      ctx.quadraticCurveTo(r * 0.52, r * 0.52, 0, r * 0.66);
      ctx.quadraticCurveTo(-r * 0.52, r * 0.52, -r * 0.52, r * 0.12);
      ctx.lineTo(-r * 0.52, -r * 0.34);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  // ---- bombs (dynamic) ------------------------------------------------------

  // The cells a bomb's blast will cover, mirroring the engine's detonate(): the
  // centre plus each arm out to `range`, stopping at SOLID. Each pierce stack
  // lets an arm cross one additional BRICK. Used only for the on-floor preview.
  function blastCells(b, grid) {
    const cells = [[b.col, b.row]];
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (const [dc, dr] of dirs) {
      let pierceLeft = Math.max(0, Number(b.pierce) || 0);
      for (let i = 1; i <= b.range; i++) {
        const col = b.col + dc * i, row = b.row + dr * i;
        if (col < 0 || col >= COLS || row < 0 || row >= ROWS) break;
        const c = grid[row * COLS + col];
        if (c === CELL.SOLID) break;
        cells.push([col, row]);
        if (c === CELL.BRICK) {
          if (pierceLeft <= 0) break;
          pierceLeft -= 1;
        }
      }
    }
    return cells;
  }

  // Faint, pulsing warning of a bomb's reach — intensifies as the fuse burns
  // down so you can read the danger zone before it goes off.
  function drawBlastPreview(b, grid) {
    const frac = Math.max(0, Math.min(1, (b.timer != null ? b.timer : BOMB_FUSE) / BOMB_FUSE));
    const urgency = 1 - frac;                       // 0 fresh -> 1 about to blow
    const pulse = 0.5 + 0.5 * Math.sin(now() * (6 + urgency * 12));
    const alpha = 0.10 + urgency * 0.16 + pulse * 0.06;
    ctx.save();
    ctx.fillStyle = `rgba(255, 138, 63, ${alpha})`;
    const inset = tile * 0.16;
    for (const [col, row] of blastCells(b, grid)) {
      roundRect(ctx, px(col) + inset, py(row) + inset, tile - inset * 2, tile - inset * 2, tile * 0.18);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawBomb(b) {
    // Use the bomb's continuous position when present (kicked bombs slide
    // between cells); fall back to the cell centre for safety.
    const bx = b.x != null ? b.x : b.col + 0.5;
    const by = b.y != null ? b.y : b.row + 0.5;
    const x = px(0) + bx * tile;
    const groundY = py(0) + by * tile;
    const y = groundY - Math.max(0, b.z || 0) * tile;
    // pulse faster as the fuse runs down
    const frac = Math.max(0, Math.min(1, b.timer / BOMB_FUSE));
    const speed = 6 + (1 - frac) * 22;
    const pulse = 1 + Math.sin(now() * speed) * 0.08 * (1.2 - frac);
    const r = tile * 0.34 * pulse;

    if (b.z > 0) {
      ctx.save();
      ctx.fillStyle = `rgba(0, 0, 0, ${0.28 - Math.min(0.16, b.z * 0.12)})`;
      ctx.beginPath();
      ctx.ellipse(x, groundY + tile * 0.24, r * 0.78, r * 0.32, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    ctx.save();
    // body with a soft red glow that intensifies near detonation
    ctx.shadowColor = `rgba(255, 84, 112, ${0.3 + (1 - frac) * 0.5})`;
    ctx.shadowBlur = tile * (0.25 + (1 - frac) * 0.5);
    const grad = ctx.createRadialGradient(x - r * 0.3, y - r * 0.3, r * 0.1, x, y, r);
    grad.addColorStop(0, '#3a3f55');
    grad.addColorStop(1, '#12141f');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    // highlight glint
    ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
    ctx.beginPath();
    ctx.arc(x - r * 0.35, y - r * 0.35, r * 0.18, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // fuse + spark
    ctx.save();
    ctx.strokeStyle = '#caa15a';
    ctx.lineWidth = Math.max(1.5, tile * 0.05);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x + r * 0.3, y - r * 0.85);
    ctx.quadraticCurveTo(x + r * 0.7, y - r * 1.25, x + r * 0.4, y - r * 1.5);
    ctx.stroke();
    const sparkR = (0.5 + Math.abs(Math.sin(now() * 18)) * 0.5) * tile * 0.09;
    ctx.fillStyle = '#ffd27a';
    ctx.shadowColor = '#ffae3a';
    ctx.shadowBlur = tile * 0.3;
    ctx.beginPath();
    ctx.arc(x + r * 0.4, y - r * 1.5, sparkR, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // ---- flames (dynamic, additive) -------------------------------------------

  function drawFlame(f) {
    const x = px(f.col);
    const y = py(f.row);
    const t = tile;
    const flick = 0.85 + Math.sin(now() * 30 + f.col * 2 + f.row * 3) * 0.15;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    // shape the lit area depending on kind/orient so we get nice caps
    let bx = x, by = y, bw = t, bh = t;
    const inset = t * 0.06;
    if (f.kind === 'arm' || f.kind === 'tip') {
      if (f.orient === 'h') { by = y + inset; bh = t - inset * 2; }
      else if (f.orient === 'v') { bx = x + inset; bw = t - inset * 2; }
    } else {
      bx = x + inset; by = y + inset; bw = t - inset * 2; bh = t - inset * 2;
    }

    const cx = x + t / 2, cy = y + t / 2;
    // Additive radial gradient gives the glow without needing shadowBlur.
    const grad = ctx.createRadialGradient(cx, cy, t * 0.05, cx, cy, t * 0.7);
    grad.addColorStop(0, `rgba(255, 255, 230, ${0.95 * flick})`);
    grad.addColorStop(0.35, `rgba(255, 180, 70, ${0.85 * flick})`);
    grad.addColorStop(0.75, `rgba(255, 90, 40, ${0.55 * flick})`);
    grad.addColorStop(1, 'rgba(180, 30, 20, 0)');
    ctx.fillStyle = grad;

    const radius = f.kind === 'tip' ? t * 0.42 : t * 0.2;
    roundRect(ctx, bx, by, bw, bh, radius);
    ctx.fill();

    // bright hot core
    ctx.fillStyle = `rgba(255, 255, 245, ${0.55 * flick})`;
    const coreR = t * (f.kind === 'center' ? 0.22 : 0.14);
    ctx.beginPath();
    ctx.arc(cx, cy, coreR, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  // ---- players (dynamic) ----------------------------------------------------

  function drawPlayerSprite(p, x, y, color) {
    const image = playerSprites[p.slot];
    const direction = PLAYER_FRAMES[p.dir] ? p.dir : 'down';
    const frame = PLAYER_FRAMES[direction];
    const phase = p.moving && p.alive ? Math.floor(now() * 8) % 2 : 0;
    if (!imageReady(image)) return false;

    const width = tile * 1.55;
    const height = width * (image.naturalHeight / 2) / (image.naturalWidth / 4);
    const anchor = PLAYER_FRAME_ANCHORS[direction][phase];
    const sourceCol = frame.col + phase;
    const sourceWidth = image.naturalWidth / 4;
    const sourceHeight = image.naturalHeight / 2;
    const footY = y + tile * 0.36;

    ctx.shadowColor = color;
    ctx.shadowBlur = p.alive ? tile * 0.22 : 0;
    ctx.drawImage(
      image,
      sourceCol * sourceWidth,
      frame.row * sourceHeight,
      sourceWidth,
      sourceHeight,
      x - anchor.x * width,
      footY - anchor.y * height,
      width,
      height,
    );
    ctx.shadowBlur = 0;
    return true;
  }

  function drawPlayer(p, isLocal) {
    const x = px(0) + p.x * tile; // p.x already includes the +0.5 centre offset
    const y = py(0) + p.y * tile;
    const r = tile * 0.34;
    const color = PLAYER_COLORS[p.slot] || '#ffffff';
    const [cr, cg, cb] = hexToRgb(color);
    const hasPlayerSprite = imageReady(playerSprites[p.slot]);

    ctx.save();
    if (!p.alive) ctx.globalAlpha = 0.28;                 // faded when dead
    else if (p.invuln > 0) ctx.globalAlpha = 0.45 + 0.4 * Math.abs(Math.sin(now() * 22)); // i-frame flicker
    else if (p.ghost) ctx.globalAlpha = 0.6;              // see-through while wallpassing

    // soft shadow on the floor
    ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
    ctx.beginPath();
    ctx.ellipse(x, y + r * 0.85, r * 0.85, r * 0.4, 0, 0, Math.PI * 2);
    ctx.fill();

    // local-player ring
    if (isLocal && p.alive) {
      ctx.strokeStyle = `rgba(${cr}, ${cg}, ${cb}, 0.9)`;
      ctx.lineWidth = Math.max(2, tile * 0.06);
      ctx.shadowColor = color;
      ctx.shadowBlur = tile * 0.4;
      ctx.beginPath();
      ctx.arc(x, y + r * 0.85, r * 1.05, 0, Math.PI * 2);
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    // shield bubble — cyan ring that pulses while the timed blocker is active
    if (p.alive && p.shield > 0) {
      const pulse = 0.6 + 0.4 * Math.sin(now() * 6);
      ctx.strokeStyle = `rgba(63, 224, 255, ${0.45 + 0.35 * pulse})`;
      ctx.lineWidth = Math.max(1.5, tile * 0.05);
      ctx.shadowColor = '#3fe0ff';
      ctx.shadowBlur = tile * 0.3;
      ctx.beginPath();
      const shieldY = y - (hasPlayerSprite ? tile * 0.24 : 0);
      const shieldRadius = hasPlayerSprite ? tile * 0.72 : r * 1.28;
      ctx.arc(x, shieldY, shieldRadius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    // little bobbing while moving
    const bob = !hasPlayerSprite && p.moving && p.alive
      ? Math.sin(now() * 12) * tile * 0.04
      : 0;
    const by = y + bob;

    const usedSprite = drawPlayerSprite(p, x, by, color);
    if (!usedSprite) {
      // Lightweight procedural fallback while the image sheet is loading.
      ctx.fillStyle = color;
      if (p.alive) {
        ctx.shadowColor = color;
        ctx.shadowBlur = tile * 0.25;
      }
      roundRect(ctx, x - r * 0.78, by - r, r * 1.56, r * 1.9, r * 0.7);
      ctx.fill();
      ctx.shadowBlur = 0;

      ctx.fillStyle = 'rgba(255, 255, 255, 0.18)';
      roundRect(ctx, x - r * 0.5, by - r * 0.7, r * 1.0, r * 0.7, r * 0.4);
      ctx.fill();

      let ex = 0, ey = 0;
      if (p.dir === 'left') ex = -r * 0.22;
      else if (p.dir === 'right') ex = r * 0.22;
      else if (p.dir === 'up') ey = -r * 0.18;
      else ey = r * 0.1;

      const eyeY = by - r * 0.3 + ey * 0.4;
      const eyeDX = r * 0.32;
      ctx.fillStyle = '#ffffff';
      for (const sx of [-1, 1]) {
        ctx.beginPath();
        ctx.arc(x + sx * eyeDX, eyeY, r * 0.24, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = '#0b0f1a';
      for (const sx of [-1, 1]) {
        ctx.beginPath();
        ctx.arc(x + sx * eyeDX + ex * 0.6, eyeY + ey * 0.6, r * 0.12, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    ctx.restore();

    // name tag above the head
    ctx.save();
    ctx.globalAlpha = p.alive ? 1 : 0.45;
    ctx.font = `700 ${Math.max(9, tile * 0.26)}px ${getFont()}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    const label = p.name || `P${p.slot + 1}`;
    const ty = by - (usedSprite ? tile * 0.94 : r * 1.25);
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.strokeText(label, x, ty);
    ctx.fillStyle = color;
    ctx.fillText(label, x, ty);
    ctx.restore();

    // Timed-buff bars below the character. If both are active, stack them.
    const timedBuffs = [];
    if (p.alive && p.ghost > 0) {
      timedBuffs.push({ fraction: p.ghost / GHOST_TIME, color: '#b98cff' });
    }
    if (p.alive && p.shield > 0 && p.shieldTime > 0) {
      timedBuffs.push({ fraction: p.shieldTime / SHIELD_TIME, color: '#3fe0ff' });
    }
    for (let i = 0; i < timedBuffs.length; i++) {
      const buff = timedBuffs[i];
      const frac = Math.max(0, Math.min(1, buff.fraction));
      const bw = r * 1.7, bh = Math.max(2, tile * 0.08);
      const bx = x - bw / 2, byb = y + r * 1.35 + i * (bh + 2);
      ctx.save();
      ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
      roundRect(ctx, bx - 1, byb - 1, bw + 2, bh + 2, bh);
      ctx.fill();
      ctx.fillStyle = buff.color;
      roundRect(ctx, bx, byb, bw * frac, bh, bh);
      ctx.fill();
      ctx.restore();
    }
  }

  function drawPickupPopup(p, popup) {
    if (!p.alive) return;
    const progress = Math.max(0, Math.min(1, popup.progress || 0));
    const fadeIn = Math.min(1, progress / 0.12);
    const fadeOut = Math.min(1, (1 - progress) / 0.28);
    const alpha = Math.max(0, Math.min(fadeIn, fadeOut));
    if (alpha <= 0) return;

    const x = px(0) + p.x * tile;
    const y = py(0) + p.y * tile;
    const rise = tile * (0.1 + progress * 0.38);
    const textY = y - tile * 0.72 - rise;
    const fontSize = Math.max(9, tile * 0.24);

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = `800 ${fontSize}px ${getFont()}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const width = ctx.measureText(popup.text).width + tile * 0.34;
    const height = fontSize + tile * 0.18;
    const edgePadding = tile * 0.06;
    const labelX = Math.max(
      originX + width / 2 + edgePadding,
      Math.min(originX + tile * COLS - width / 2 - edgePadding, x),
    );
    const labelY = Math.max(originY + height / 2 + edgePadding, textY);
    ctx.fillStyle = 'rgba(5, 8, 16, 0.82)';
    roundRect(ctx, labelX - width / 2, labelY - height / 2, width, height, height / 2);
    ctx.fill();
    ctx.strokeStyle = popup.color;
    ctx.lineWidth = Math.max(1, tile * 0.035);
    roundRect(ctx, labelX - width / 2, labelY - height / 2, width, height, height / 2);
    ctx.stroke();
    ctx.fillStyle = popup.color;
    ctx.shadowColor = popup.color;
    ctx.shadowBlur = tile * 0.18;
    ctx.fillText(popup.text, labelX, labelY + fontSize * 0.02);
    ctx.restore();
  }

  // ---- frame ----------------------------------------------------------------

  function draw(snap, opts = {}) {
    const localSlots = opts.localSlots || [];
    const pickupPopups = opts.pickupPopups || [];

    // Compute the current shake offset before resetting the transform. We use a
    // deterministic counter-driven jitter (no Math.random) and decay the energy
    // afterwards. Offsets are clamped to the live energy so they never exceed
    // SHAKE_MAX pixels and can't throw the board off-screen.
    let sx = 0, sy = 0;
    if (shakeAmt > 0.1) {
      shakeFrame++;
      // Two out-of-phase sinusoids give a lively, non-repeating-looking jitter.
      sx = Math.sin(shakeFrame * 1.7) * shakeAmt;
      sy = Math.cos(shakeFrame * 2.3) * shakeAmt;
      shakeAmt *= SHAKE_DECAY;
    } else {
      shakeAmt = 0;
    }

    // Reset transform then scale to device pixels, folding in the shake offset.
    ctx.setTransform(dpr, 0, 0, dpr, sx * dpr, sy * dpr);
    ctx.clearRect(-sx, -sy, viewW, viewH);

    if (!snap) return;

    // Arena metadata can change between rounds while the grid shape remains
    // identical. Rebuild both static layers before blitting the new frame.
    const nextArenaVisual = getArenaVisual(snap.arena);
    if (nextArenaVisual.id !== activeArenaVisual.id) {
      activeArenaVisual = nextArenaVisual;
      renderFloorLayer(activeArenaVisual.palette, activeArenaVisual.id);
      terrainSig = null;
    }

    // Static layers: one drawImage each. The offscreen canvases are full
    // viewport-sized and already in device pixels, so we blit them at 0,0 in the
    // (dpr-scaled) coordinate space.
    ctx.drawImage(floorCanvas, 0, 0, viewW, viewH);

    // Rebuild terrain only when the grid contents, tile size, or theme changed.
    const sig = gridSignature(snap.grid, activeArenaVisual.id);
    if (sig !== terrainSig) {
      renderTerrainLayer(snap.grid, activeArenaVisual.palette, activeArenaVisual.id);
      terrainSig = sig;
    }
    ctx.drawImage(terrainCanvas, 0, 0, viewW, viewH);

    // Clip dynamic entities to the board so glows don't bleed past the arena.
    const boardW = tile * COLS, boardH = tile * ROWS;
    ctx.save();
    roundRect(ctx, originX, originY, boardW, boardH, 8);
    ctx.clip();

    drawArenaMechanic(snap.mechanic);

    // blast-range preview (faint ghost of where each live bomb will reach),
    // drawn under everything dynamic so it reads as a floor warning
    for (const b of snap.bombs) drawBlastPreview(b, snap.grid);

    // loose powerups
    for (const pu of snap.powerups) drawPowerup(pu.col, pu.row, pu.kind);

    // bombs
    for (const b of snap.bombs) drawBomb(b);

    // flames (drawn over bombs/terrain)
    for (const f of snap.flames) drawFlame(f);

    // players — draw dead ones first so living players sit in front.
    const players = [...snap.players].sort((a, b) => (a.alive === b.alive ? 0 : a.alive ? 1 : -1));
    for (const p of players) {
      drawPlayer(p, localSlots.includes(p.slot));
    }
    for (const popup of pickupPopups) {
      const p = players.find((player) => player.slot === popup.slot);
      if (p) drawPickupPopup(p, popup);
    }

    ctx.restore();
  }

  // initial layout
  resize();

  return { resize, draw, shake };
}
