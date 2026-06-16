// Canvas renderer for the Bomberman board.
//
// createRenderer(canvas) -> { resize(), draw(snap, { localSlots }) }
//
// The board is COLS x ROWS logical tiles. We compute an integer-ish tile size
// that fits the viewport, centre the board, and draw everything in device
// pixels (scaled for devicePixelRatio) so it stays crisp on HiDPI screens.

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

  // A monotonic clock for animations (pulsing bombs, flame flicker, etc.).
  const startTime = performance.now();
  const now = () => (performance.now() - startTime) / 1000;

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

  // ---- terrain --------------------------------------------------------------

  function drawFloor() {
    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        const x = px(col), y = py(row);
        // Subtle checkerboard so motion is readable.
        ctx.fillStyle = (col + row) % 2 === 0 ? '#10162a' : '#0d1322';
        ctx.fillRect(x, y, tile, tile);
      }
    }
    // Faint grid lines for that arcade-floor feel.
    ctx.strokeStyle = 'rgba(120, 150, 220, 0.05)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let col = 0; col <= COLS; col++) {
      ctx.moveTo(px(col) + 0.5, py(0));
      ctx.lineTo(px(col) + 0.5, py(ROWS));
    }
    for (let row = 0; row <= ROWS; row++) {
      ctx.moveTo(px(0), py(row) + 0.5);
      ctx.lineTo(px(COLS), py(row) + 0.5);
    }
    ctx.stroke();
  }

  function drawSolid(col, row) {
    const x = px(col), y = py(row);
    const t = tile;
    // 3D-ish bevelled pillar.
    ctx.fillStyle = '#243152';
    roundRect(ctx, x + 1, y + 1, t - 2, t - 2, 5);
    ctx.fill();
    // top-left highlight
    ctx.fillStyle = 'rgba(150, 180, 255, 0.18)';
    roundRect(ctx, x + 2, y + 2, t - 4, (t - 4) * 0.45, 4);
    ctx.fill();
    // bottom shadow
    ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
    roundRect(ctx, x + 2, y + t * 0.6, t - 4, t * 0.36, 4);
    ctx.fill();
    // crisp edge
    ctx.strokeStyle = 'rgba(120, 150, 220, 0.35)';
    ctx.lineWidth = 1;
    roundRect(ctx, x + 1.5, y + 1.5, t - 3, t - 3, 5);
    ctx.stroke();
  }

  function drawBrick(col, row) {
    const x = px(col), y = py(row);
    const t = tile;
    ctx.fillStyle = '#6b4630';
    roundRect(ctx, x + 1, y + 1, t - 2, t - 2, 4);
    ctx.fill();
    // brick courses
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.28)';
    ctx.lineWidth = Math.max(1, t * 0.045);
    const rows = 3;
    const rh = (t - 2) / rows;
    ctx.beginPath();
    for (let i = 1; i < rows; i++) {
      ctx.moveTo(x + 2, y + 1 + i * rh);
      ctx.lineTo(x + t - 2, y + 1 + i * rh);
    }
    // offset vertical joints
    for (let i = 0; i < rows; i++) {
      const offset = i % 2 === 0 ? t * 0.5 : t * 0.25;
      ctx.moveTo(x + offset, y + 1 + i * rh);
      ctx.lineTo(x + offset, y + 1 + (i + 1) * rh);
    }
    ctx.stroke();
    // top highlight
    ctx.fillStyle = 'rgba(255, 200, 150, 0.14)';
    ctx.fillRect(x + 2, y + 2, t - 4, Math.max(1, t * 0.08));
  }

  // ---- powerups -------------------------------------------------------------

  function drawPowerup(col, row, kind) {
    const x = px(col) + tile / 2;
    const y = py(row) + tile / 2;
    const r = tile * 0.32;
    const bob = Math.sin(now() * 3 + col + row) * tile * 0.04;
    const cy = y + bob;

    let color, glyph;
    if (kind === POWERUP.BOMB) { color = '#ff5470'; glyph = 'bomb'; }
    else if (kind === POWERUP.RANGE) { color = '#ffcf3f'; glyph = 'range'; }
    else { color = '#5dd95d'; glyph = 'speed'; }

    // glowing pill
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
    } else {
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
    }
    ctx.restore();
  }

  // ---- bombs ----------------------------------------------------------------

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

  // ---- flames ---------------------------------------------------------------

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

  // ---- players --------------------------------------------------------------

  function drawPlayer(p, isLocal) {
    const x = px(0) + p.x * tile; // p.x already includes the +0.5 centre offset
    const y = py(0) + p.y * tile;
    const r = tile * 0.34;
    const color = PLAYER_COLORS[p.slot] || '#ffffff';
    const [cr, cg, cb] = hexToRgb(color);

    ctx.save();
    if (!p.alive) ctx.globalAlpha = 0.28; // ghost when dead

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

  function getFont() {
    return "'Segoe UI', system-ui, sans-serif";
  }

  // ---- frame ----------------------------------------------------------------

  function draw(snap, opts = {}) {
    const localSlots = opts.localSlots || [];

    // Reset transform then scale to device pixels.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, viewW, viewH);

    if (!snap) return;

    // board backdrop / frame glow
    const boardW = tile * COLS, boardH = tile * ROWS;
    ctx.save();
    ctx.shadowColor = 'rgba(63, 182, 255, 0.25)';
    ctx.shadowBlur = 30;
    ctx.fillStyle = '#0a0e1a';
    roundRect(ctx, originX - 6, originY - 6, boardW + 12, boardH + 12, 14);
    ctx.fill();
    ctx.restore();

    // clip to the board so glows don't bleed outside the arena
    ctx.save();
    roundRect(ctx, originX, originY, boardW, boardH, 8);
    ctx.clip();

    drawFloor();

    // terrain
    const grid = snap.grid;
    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        const c = grid[row * COLS + col];
        if (c === CELL.SOLID) drawSolid(col, row);
        else if (c === CELL.BRICK) drawBrick(col, row);
      }
    }

    // loose powerups
    for (const pu of snap.powerups) drawPowerup(pu.col, pu.row, pu.kind);

    // bombs
    for (const b of snap.bombs) drawBomb(b);

    // flames (drawn over bombs/terrain)
    for (const f of snap.flames) drawFlame(f);

    // players — draw dead ones first so living ghosts sit behind the action
    const players = [...snap.players].sort((a, b) => (a.alive === b.alive ? 0 : a.alive ? 1 : -1));
    for (const p of players) {
      drawPlayer(p, localSlots.includes(p.slot));
    }

    ctx.restore();
  }

  // initial layout
  resize();

  return { resize, draw };
}
