# Design

This document describes how bomberman-web is modelled and wired together. The
authoritative source for any number is [`shared/constants.js`](shared/constants.js);
this doc explains the *why*.

---

## 1. Grid & terrain

The arena is a fixed **15 × 13** grid (`COLS` × `ROWS`), each cell `TILE` = 40
logical pixels. Odd‑by‑odd dimensions make the classic Bomberman pillar pattern
land cleanly.

The grid is a flat `number[]` of length `COLS * ROWS`, indexed `row * COLS + col`.
Each cell holds a `CELL` value:

| Value | Cell | Behaviour |
| ----- | ---- | --------- |
| `0` | `EMPTY` | Walkable floor. |
| `1` | `SOLID` | Indestructible pillar / border. Blocks movement and blasts. |
| `2` | `BRICK` | Destructible. Blocks movement and stops a blast; may hide a powerup. |

**Generation** (`generateRound`) is deterministic from the round seed:

1. The outer border is `SOLID`; interior cells where both `col` and `row` are
   even are `SOLID` (the pillar lattice).
2. Each player's spawn corner plus its orthogonal neighbours are kept clear so
   nobody starts boxed in.
3. Remaining empty interior cells are filled with `BRICK` at `BRICK_FILL`
   (0.78) probability. Each brick independently has a `POWERUP_CHANCE` (0.42)
   of hiding a powerup, chosen by a weighted roll.

Map generation uses a seeded **mulberry32** RNG, so a given seed reproduces the
same map and the same hidden powerups — essential for server authority.

Players spawn in the four corners in slot order (`SPAWNS`), coloured Rot / Blau /
Grün / Gelb (`PLAYER_COLORS` / `PLAYER_NAMES`).

---

## 2. Movement & collision

Player position is stored in **tile units**, centre‑based: a player at the
centre of its tile is at `(col + 0.5, row + 0.5)`. Collision uses an
axis‑aligned box of half‑width `0.34` tiles.

- Movement is **4‑directional**; if both axes are pressed, vertical is dropped
  so the player commits to one axis.
- Speed is `BASE_SPEED` (4.2 tiles/s) plus `SPEED_PER_PICKUP` (0.9) per speed
  powerup, capped at `MAX_SPEED_PICKUPS` (4).
- **Cornering assist**: when a move is blocked head‑on, the engine nudges the
  player toward the lane centre so they can slip around corners smoothly instead
  of catching on pillar edges.
- A freshly placed bomb does **not** trap its owner: the owner may walk through
  the bomb's tile until they fully step off it (`passBombs`), after which it
  becomes solid to everyone.

---

## 3. Bombs, flames & chains

**Placement** is edge‑triggered (`bomb` true this tick, false last tick). A
player may have at most `maxBombs` live bombs, and only one bomb per tile. A
bomb stores its owner, a `BOMB_FUSE` (2.4 s) timer, and the owner's current
`range`.

**Detonation** (`detonate`) writes flame tiles outward from the bomb centre
along the four cardinal directions, up to `range` tiles each:

- A `SOLID` cell stops the arm immediately (no flame on it).
- A `BRICK` cell is destroyed, drops its hidden powerup onto the floor (if any),
  receives a `tip` flame, and stops the arm (bricks absorb the blast).
- An empty cell receives an `arm` flame (or `tip` at the last reachable cell)
  and the blast continues. Any loose powerup there is burned away.

Flame tiles carry a `kind` (`center` / `arm` / `tip`) and `orient` (`h` / `v` /
`null`) purely so the renderer can draw the right sprite. Each flame lives for
`FLAME_TIME` (0.5 s); overlapping flames just refresh the timer.

**Chain reactions**: if a blast reaches a tile holding another live bomb, that
bomb's timer is forced to `0`. The step loop keeps detonating until no bomb has
a non‑positive timer, so an entire chain resolves **within the same tick**.

**Deaths**: after bombs and flames update, any living player whose (slightly
inset) box overlaps a flame tile dies. Death is resolved after detonation, so a
chain can wipe several players in one tick.

---

## 4. Powerups

When a brick is destroyed it may reveal one of three powerups, which then lies
on the floor until a player walks onto that tile:

| Kind | Effect | Cap |
| ---- | ------ | --- |
| `BOMB` (1)  | `+1` concurrent bomb (`maxBombs`) | `MAX_BOMBS` = 8 |
| `RANGE` (2) | `+1` explosion reach (`range`)    | `MAX_RANGE` = 8 |
| `SPEED` (3) | `+1` speed pickup                 | `MAX_SPEED_PICKUPS` = 4 |

Hidden powerups are weighted toward Bomb and Range over Speed. A powerup lying
on the floor is destroyed if a flame passes over it before anyone grabs it.

---

## 5. Round & match flow

Each `step` runs at a fixed **60 Hz** (`TICK_HZ`); callers drive it with
`TICK_DT` behind a time accumulator so simulation speed is independent of frame
rate.

A round ends when **at most one** player remains alive (with ≥ 2 players in the
game). The phase becomes `roundover` for `ROUND_END_DELAY` (3 s):

- A sole survivor is the round `winner` and scores `+1`; a mutual kill is a draw
  (`winner = null`).
- After the delay, the engine generates a fresh map, increments `round`, and
  returns to `playing`.

The match is **best‑of‑N**: `winsToWin` round wins (configurable, default 3).
When a player reaches `winsToWin`, the phase becomes `matchover`, `matchWinner`
is set, and the simulation stops advancing until a restart builds a new game.

Valid phases: `playing` → `roundover` → `playing` … → `matchover`.

---

## 6. Sudden death

To break stalemates, once the current round's `state.time` passes
`SUDDEN_DEATH_TIME` (90 s) the arena begins to collapse. The clock and collapse
state reset whenever a fresh round is generated. The engine precomputes an **inward spiral** of every
interior cell and, every ~0.18 s, converts the next cell along the spiral to
`SOLID`:

- Any hidden/loose powerup on that cell is removed.
- Any bomb on that cell is removed.
- Any player standing on that cell is killed.

The walls close from the outside in, steadily shrinking the playable area until
a winner emerges.

---

## 7. Shared‑engine architecture

The simulation in [`shared/engine.js`](shared/engine.js) is the **single source
of game truth**, imported unchanged by both the browser client and the Node
server. It has no DOM, no timers, and no nondeterministic RNG in the hot path.

```
              shared/engine.js  (one deterministic simulation)
                       │
        ┌──────────────┴───────────────┐
        ▼                              ▼
  LOCAL (browser)                ONLINE (server-authoritative)
  step() each frame              server steps; broadcasts snapshots
  reads 4 local keymaps          clients send only their own input
  renders toSnapshot()           clients render toSnapshot()
```

Engine surface:

- `createGame(playerDefs, { seed, winsToWin })` → `state`, where
  `playerDefs = [{ id, slot, name }]`.
- `setInput(state, slot, { up, down, left, right, bomb })` — set a player's
  current input (booleans).
- `step(state, dt)` — advance one fixed tick.
- `toSnapshot(state)` — plain JSON the renderer/HUD consume.

Because the renderer only ever reads `toSnapshot()` output, local and online
rendering share one code path. Snapshot player coordinates are in tile units
(centre‑based); multiply by `TILE` for pixels.

### Snapshot shape

```jsonc
{
  "t",                     // elapsed seconds in the current round
  "phase",                 // 'playing' | 'roundover' | 'matchover'
  "round", "phaseTimer",
  "winner",                // slot | null
  "matchWinner", "winsToWin",
  "grid":     [/* COLS*ROWS CELL values, index = row*COLS+col */],
  "powerups": [{ "col", "row", "kind" }],
  "players":  [{ "slot", "name", "x", "y", "dir", "alive",
                 "maxBombs", "range", "speedPicks", "score", "moving",
                 "stepping", "tx", "ty" }],
  "bombs":    [{ "id", "owner", "col", "row", "x", "y",
                 "vx", "vy", "timer", "range" }],
  "flames":   [{ "col", "row", "kind", "orient" }]
}
```

---

## 8. Wire protocol

Online play uses JSON messages over WebSockets, defined once in
[`shared/protocol.js`](shared/protocol.js). Every message is
`{ type, ...payload }`, produced by `encode(type, payload)` and parsed by
`decode(raw)` (returns `null` on malformed input). The server broadcasts
snapshots at `SNAPSHOT_HZ` (30/s); room codes are `ROOM_CODE_LEN` (4) chars.

**Client → server**

| `MSG` | Payload | Meaning |
| ----- | ------- | ------- |
| `JOIN` (`join`)       | `{ name, room }` | Join `room`; empty `room` creates a fresh one. |
| `INPUT` (`input`)     | `{ input: { up, down, left, right, bomb } }` | Current input. |
| `READY` (`ready`)     | `{ ready }` | Toggle ready in the lobby. |
| `RESTART` (`restart`) | `{}` | Host requests a new match. |
| `LEAVE` (`leave`)     | `{}` | Leave the room. |

**Server → client**

| `MSG` | Payload | Meaning |
| ----- | ------- | ------- |
| `JOINED` (`joined`)     | `{ room, slot, host }` | You joined; your slot and host flag. |
| `LOBBY` (`lobby`)       | `{ room, host, players: [{ slot, name, ready }], canStart }` | Lobby state. |
| `START` (`start`)       | `{ winsToWin }` | Match begins. |
| `SNAPSHOT` (`snapshot`) | `{ snap }` | Full world snapshot (`engine.toSnapshot` output). |
| `ERROR` (`error`)       | `{ message }` | Something went wrong. |

A typical online session: `JOIN` → `JOINED` + `LOBBY` (players toggle `READY`
until `canStart`) → host triggers `START` → a stream of `SNAPSHOT`s while
clients send `INPUT` → `RESTART` for another match, or `LEAVE`.
