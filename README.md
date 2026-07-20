# 💣 bomberman-web

> Fast local and online Bomberman with bots, four arenas, configurable rules,
> and one shared deterministic engine.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-24-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Vite](https://img.shields.io/badge/build-Vite_6-646CFF?logo=vite&logoColor=white)](https://vitejs.dev)
[![Vanilla JS](https://img.shields.io/badge/client-vanilla_JS_+_Canvas-f7df1e?logo=javascript&logoColor=black)](#-how-it-works)
[![Deploy](https://img.shields.io/badge/Pages-local_mode-222?logo=githubpages&logoColor=white)](#-deploy)

A compact, framework‑free Bomberman built around **one deterministic game engine** that runs identically in the browser (local play) and on a Node server (authoritative online play). No game framework, no bundled UI library — just vanilla JS and a `<canvas>`.

---

## ✨ Features

- **Local play** — exactly two human players on one keyboard, with zero to two
  bots filling the remaining slots.
- **Online multiplayer** — two to four total players through a four-character
  room code, with a server-authoritative simulation, ping display, and optional
  bot fill. A disconnected player is taken over by a bot during an active round.
- **FFA or 2v2** — individual round scores in free-for-all, or shared team
  scores in four-player team matches.
- **Four 15×13 arenas** — Neon Reactor, Magma Foundry, Cryo Circuit, and
  Switchyard Reactor. Pick one or use a deterministic shuffled bag that rotates
  through all four.
- **Arena mechanics** — paired portals, telegraphed lava vents, momentum-carrying
  ice lanes, and rails that move stationary bombs.
- **Destructible terrain** — solid walls stay put; visually distinct bricks blow
  apart and may hide a powerup.
- **9 powerups** — Bomb, Range, Speed, temporary Ghost, stacking Pierce,
  temporary Shield, Kick, Remote Detonator, and Bomb Throw.
- **Chain‑reaction explosions** — a blast that touches another bomb detonates it instantly, resolved within the same tick.
- **Configurable matches** — choose wins required, arena, powerup frequency,
  sudden-death time, bots, player target, and game mode.
- **Sudden death** — after the configured delay, the arena collapses inward in
  a spiral of walls. Its clock and collapse state reset every round.
- **First-to-N rounds** — the first player or team to the configured number of
  round wins takes the match.

---

## 🎮 Controls

### Local play

| Player | Move | Drop bomb | Action |
| ------ | ---- | --------- | ------ |
| **P1** (Rot)  | `W` `A` `S` `D` | `Space` | Left `Shift` |
| **P2** (Blau) | `↑` `↓` `←` `→` | `Enter` | Right `Shift` |

Movement is four-directional and grid-locked. Bomb and action presses are
edge-triggered. The action key throws the bomb directly ahead when Bomb Throw
is active; otherwise it detonates the oldest owned remote bomb when Remote
Detonator is active. Touch devices get a D-pad plus bomb and action buttons.

### Online play

Each player uses a single, full control scheme on their own device. The default is **P1's** layout — `WASD` to move and `Space` to drop a bomb — regardless of which colour/slot the server assigns you.
The action key is left `Shift`.

---

## 🚀 Quick Start

Requires **Node 24+**.

```bash
npm install
```

### Development (client + server, hot reload)

```bash
npm run dev
```

This runs both processes concurrently:

- **Client** (Vite dev server) → <http://localhost:5173>
- **Server** (WebSocket) → `ws://localhost:8080`

Open the client URL in your browser. Local mode works immediately; online mode connects to the dev WebSocket server on port 8080.

You can also run the halves independently:

```bash
npm run dev:client   # Vite only (local play)
npm run dev:server   # WebSocket server only
```

### Production (single server)

```bash
npm start
```

This builds the client (`vite build` → `dist/`) and then launches the Node server, which serves the built static client **and** the WebSocket endpoint on a single port:

- **App + WebSocket** → <http://localhost:8080>

> `npm run build` produces the static bundle in `dist/` without starting a server — handy for static hosting (see [Deploy](#-deploy)).

---

## 🗂️ Project Structure

```
bomberman-web/
├── client/                 # Browser app (Vite root, dependency-free)
│   ├── index.html          # Canvas + lobby markup
│   ├── public/             # Static assets copied as-is
│   └── src/                # Vanilla JS: render, HUD, input, net, local loop
├── server/
│   └── index.js            # WebSocket server: rooms, lobby, authoritative loop
├── shared/                 # The single source of truth, imported by BOTH sides
│   ├── constants.js        # Grid size, tuning, spawns, colours, flow timings
│   ├── engine.js           # Deterministic simulation (createGame/step/setInput/toSnapshot)
│   ├── arenas.js           # Seeded arena selection and terrain generation
│   ├── arena-mechanics.js  # Portals, lava, ice, and bomb rails
│   ├── bot-ai.js           # Deterministic hazard-aware bot policy
│   ├── rules.js            # Match-rule defaults and normalization
│   └── protocol.js         # Wire message types + encode/decode
├── dist/                   # Build output (generated by `npm run build`)
├── vite.config.js          # root=client, base=./, outDir=../dist, fs.allow=['..']
└── package.json
```

---

## 🧠 How it works

The whole game lives in **one place**: [`shared/engine.js`](shared/engine.js). It is a pure, framework‑agnostic simulation — no DOM, no timers, no `Math.random` in the hot path. Map generation uses a **seeded RNG**, so a round is fully reproducible given its seed and inputs.

It exposes a tiny surface:

- `createGame(playerDefs, { seed, rules })` → fresh game `state`
- `step(state, dt)` → advance one fixed tick (60 Hz; call with `TICK_DT` behind an accumulator)
- `setInput(state, slot, { up, down, left, right, bomb, action })` → set a player's current input
- `toSnapshot(state)` → a plain JSON view the renderer and HUD consume

That single engine drives **both** modes:

- **Local mode** — the engine runs *in the browser*. The page reads two human
  keymaps, lets the engine drive any configured bots, and renders the snapshot
  to canvas. No network is involved.
- **Online mode** — the engine runs *authoritatively on the server*. Clients only send their own input and render the snapshots the server broadcasts. Because the simulation is deterministic and the server owns it, every client sees exactly the same world.

Rules use the canonical shape
`{ winsToWin, suddenDeathSeconds, powerupRate, arena, botCount, mode, playerTarget }`.
Team mode always targets four slots, and bot count is capped so at least one
human slot remains.

The renderer never touches engine internals — it consumes `toSnapshot()` output, so local and online rendering share the exact same code path. Player `x`/`y` in a snapshot are in **tile units, centre‑based** (`col + 0.5`); multiply by `TILE` (40) to get pixels.

See [DESIGN.md](DESIGN.md) for the mechanics and protocol in detail.

---

## 🌐 Deploy

There are two deployment targets, and they are **not** equivalent:

- **GitHub Pages — local mode only.** Pages is static hosting with no Node process, so it can serve the built client but **cannot** run the WebSocket server. The included workflow ([`.github/workflows/pages.yml`](.github/workflows/pages.yml)) builds the client on every push to `main` and publishes `dist/`. Visitors get full **local couch play**; online multiplayer is unavailable there.
- **Online multiplayer — needs a Node host.** To enable room‑code matches you must run the server (`npm start`) on a host that supports a long‑lived Node process and WebSockets (a VPS, a container platform, etc.). That single process builds and serves the client *and* the WebSocket endpoint on one port.

---

## 📄 License

[MIT](LICENSE) © 2026 bomberman-web contributors.
