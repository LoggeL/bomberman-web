// Canvas renderer for the Bomberman board.
//
// createRenderer(canvas) -> { resize(), draw(snap, { localSlots }), shake(magnitude) }
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
//                    glow. Rebuilt only on resize().
//   - TERRAIN layer: solid pillars + bricks. Rebuilt only when snap.grid
//                    actually changes (cheap signature compare) or on resize().
//
// Everything genuinely dynamic (powerups, bombs, flames, players) is still
// drawn per frame, but we keep shadowBlur usage to a small handful of entities
// and prefer pre-baked radial gradients for glow where it reads the same.

import {
  COLS, ROWS, CELL, POWERUP, BOMB_FUSE, PLAYER_COLORS,
} from '../../shared/constants.js';

export function createRenderer(canvas) {
  const ctx = canvas.getContext('2d');

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

  // The terrain layer is keyed by a signature of the grid contents; when the
  // signature is unchanged we skip the (relatively pricey) terrain rebuild.
  let terrainSig = null;

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

    // The floor is fully determined by layout, so rebuild it now...
    renderFloorLayer();
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

  function getFont() {
    return "'Segoe UI', system-ui, sans-serif";
  }

  // ---- static FLOOR layer (rebuilt only on resize) --------------------------

  // Renders the board backdrop/frame glow, the checkerboard, and the faint grid
  // lines into the floor offscreen canvas. The frame glow uses shadowBlur, but
  // because it's baked here it costs nothing per frame.
  function renderFloorLayer() {
    const c = floorCtx;
    c.clearRect(0, 0, viewW, viewH);

    const boardW = tile * COLS, boardH = tile * ROWS;

    // Board backdrop with a soft neon frame glow.
    c.save();
    c.shadowColor = 'rgba(63, 182, 255, 0.25)';
    c.shadowBlur = 30;
    c.fillStyle = '#0a0e1a';
    roundRect(c, originX - 6, originY - 6, boardW + 12, boardH + 12, 14);
    c.fill();
    c.restore();

    // Clip to the board so the checkerboard/grid stay inside the rounded arena.
    c.save();
    roundRect(c, originX, originY, boardW, boardH, 8);
    c.clip();

    // Subtle checkerboard so motion is readable.
    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        c.fillStyle = (col + row) % 2 === 0 ? '#10162a' : '#0d1322';
        c.fillRect(px(col), py(row), tile, tile);
      }
    }

    // Faint grid lines for that arcade-floor feel.
    c.strokeStyle = 'rgba(120, 150, 220, 0.05)';
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
  function gridSignature(grid) {
    // Include tile size so a resize (handled separately) or any layout drift
    // also invalidates the cache.
    let sig = tile + ':';
    for (let i = 0; i < grid.length; i++) {
      const v = grid[i];
      // Only SOLID/BRICK affect the rendered terrain; collapse everything else.
      sig += (v === CELL.SOLID || v === CELL.BRICK) ? v : '0';
    }
    return sig;
  }

  function renderTerrainLayer(grid) {
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
        if (v === CELL.SOLID) drawSolid(c, col, row);
        else if (v === CELL.BRICK) drawBrick(c, col, row);
      }
    }

    c.restore();
  }

  function drawSolid(c, col, row) {
    const x = px(col), y = py(row);
    const t = tile;
    // 3D-ish bevelled pillar.
    c.fillStyle = '#243152';
    roundRect(c, x + 1, y + 1, t - 2, t - 2, 5);
    c.fill();
    // top-left highlight
    c.fillStyle = 'rgba(150, 180, 255, 0.18)';
    roundRect(c, x + 2, y + 2, t - 4, (t - 4) * 0.45, 4);
    c.fill();
    // bottom shadow
    c.fillStyle = 'rgba(0, 0, 0, 0.35)';
    roundRect(c, x + 2, y + t * 0.6, t - 4, t * 0.36, 4);
    c.fill();
    // crisp edge
    c.strokeStyle = 'rgba(120, 150, 220, 0.35)';
    c.lineWidth = 1;
    roundRect(c, x + 1.5, y + 1.5, t - 3, t - 3, 5);
    c.stroke();
  }

  function drawBrick(c, col, row) {
    const x = px(col), y = py(row);
    const t = tile;
    c.fillStyle = '#6b4630';
    roundRect(c, x + 1, y + 1, t - 2, t - 2, 4);
    c.fill();
    // brick courses
    c.strokeStyle = 'rgba(0, 0, 0, 0.28)';
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
    c.fillStyle = 'rgba(255, 200, 150, 0.14)';
    c.fillRect(x + 2, y + 2, t - 4, Math.max(1, t * 0.08));
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
    else { color = '#3fe0ff'; glyph = 'shield'; }

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

  function drawBomb(b) {
    const x = px(b.col) + tile / 2;
    const y = py(b.row) + tile / 2;
    // pulse faster as the fuse runs down
    const frac = Math.max(0, Math.min(1, b.timer / BOMB_FUSE));
    const speed = 6 + (1 - frac) * 22;
    const pulse = 1 + Math.sin(now() * speed) * 0.08 * (1.2 - frac);
    const r = tile * 0.34 * pulse;

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

  function drawPlayer(p, isLocal) {
    const x = px(0) + p.x * tile; // p.x already includes the +0.5 centre offset
    const y = py(0) + p.y * tile;
    const r = tile * 0.34;
    const color = PLAYER_COLORS[p.slot] || '#ffffff';
    const [cr, cg, cb] = hexToRgb(color);

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

    // shield bubble — cyan ring, thicker with more charges, gently pulsing
    if (p.alive && p.shield > 0) {
      const pulse = 0.6 + 0.4 * Math.sin(now() * 6);
      ctx.strokeStyle = `rgba(63, 224, 255, ${0.45 + 0.35 * pulse})`;
      ctx.lineWidth = Math.max(1.5, tile * 0.04 * Math.min(p.shield, 3));
      ctx.shadowColor = '#3fe0ff';
      ctx.shadowBlur = tile * 0.3;
      ctx.beginPath();
      ctx.arc(x, y, r * 1.28, 0, Math.PI * 2);
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    // little bobbing while moving
    const bob = p.moving && p.alive ? Math.sin(now() * 12) * tile * 0.04 : 0;
    const by = y + bob;

    // body — a rounded capsule "character"
    ctx.fillStyle = color;
    if (p.alive) {
      ctx.shadowColor = color;
      ctx.shadowBlur = tile * 0.25;
    }
    roundRect(ctx, x - r * 0.78, by - r, r * 1.56, r * 1.9, r * 0.7);
    ctx.fill();
    ctx.shadowBlur = 0;

    // belly highlight
    ctx.fillStyle = 'rgba(255, 255, 255, 0.18)';
    roundRect(ctx, x - r * 0.5, by - r * 0.7, r * 1.0, r * 0.7, r * 0.4);
    ctx.fill();

    // face — eyes that look in the facing direction
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

    ctx.restore();

    // name tag above the head
    ctx.save();
    ctx.globalAlpha = p.alive ? 1 : 0.45;
    ctx.font = `700 ${Math.max(9, tile * 0.26)}px ${getFont()}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    const label = p.name || `P${p.slot + 1}`;
    const ty = by - r * 1.25;
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.strokeText(label, x, ty);
    ctx.fillStyle = color;
    ctx.fillText(label, x, ty);
    ctx.restore();
  }

  // ---- frame ----------------------------------------------------------------

  function draw(snap, opts = {}) {
    const localSlots = opts.localSlots || [];

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

    // Static layers: one drawImage each. The offscreen canvases are full
    // viewport-sized and already in device pixels, so we blit them at 0,0 in the
    // (dpr-scaled) coordinate space.
    ctx.drawImage(floorCanvas, 0, 0, viewW, viewH);

    // Rebuild terrain only when the grid contents (or tile size) changed.
    const sig = gridSignature(snap.grid);
    if (sig !== terrainSig) {
      renderTerrainLayer(snap.grid);
      terrainSig = sig;
    }
    ctx.drawImage(terrainCanvas, 0, 0, viewW, viewH);

    // Clip dynamic entities to the board so glows don't bleed past the arena.
    const boardW = tile * COLS, boardH = tile * ROWS;
    ctx.save();
    roundRect(ctx, originX, originY, boardW, boardH, 8);
    ctx.clip();

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

    ctx.restore();
  }

  // initial layout
  resize();

  return { resize, draw, shake };
}
