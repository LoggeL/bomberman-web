# Design

This document describes the current game model and network contract. Numeric
tuning lives in [`shared/constants.js`](shared/constants.js); match-rule
validation lives in [`shared/rules.js`](shared/rules.js).

---

## 1. Grid, arenas, and terrain

Every arena is a fixed **15 × 13** grid. Positions are stored in tile units,
centre-based: the centre of cell `(col, row)` is `(col + 0.5, row + 0.5)`.
The flat grid is indexed by `row * COLS + col` and contains:

| Value | Cell | Behaviour |
| ----- | ---- | --------- |
| `0` | `EMPTY` | Walkable floor. |
| `1` | `SOLID` | Indestructible wall; blocks players, bombs, and blasts. |
| `2` | `BRICK` | Destructible wall; may hide a powerup. |

[`shared/arenas.js`](shared/arenas.js) contains four symmetric, connected arena
masks:

| Rule id | Display name | Theme | Arena mechanic |
| ------- | ------------ | ----- | -------------- |
| `classic` | Neon Reactor | `neon` | Paired north/south portals |
| `crossroads` | Magma Foundry | `foundry` | Alternating, telegraphed lava vents |
| `citadel` | Cryo Circuit | `frost` | Momentum-carrying central ice lanes |
| `switchyard` | Switchyard Reactor | `reactor` | One-way rails that pulse stationary bombs forward |

`arena: "shuffle"` uses seeded four-arena bags. Every preset appears once per
bag, and adjacent bags are adjusted so their boundary cannot repeat an arena.
A fixed arena id selects that preset every round.

Terrain content uses a separate seeded RNG stream. Bricks are placed in
symmetry orbits at `BRICK_FILL` probability, while spawn escape corridors and
mechanic cells remain clear. Hidden powerup frequency is selected by
`powerupRate`: low (`0.24`), normal (`0.42`), or high (`0.64`). Therefore the
same seed, round, arena rule, and powerup-rate rule reproduce the same map.

---

## 2. Movement and actions

Players rest on cell centres and glide one full tile at a time. A held direction
chains steps, but the engine chooses a new direction only at a centre. This
keeps movement orthogonal and prevents diagonal corner cuts. If horizontal and
vertical directions are both held, horizontal wins.

Speed is `BASE_SPEED` plus `SPEED_PER_PICKUP` for each Speed pickup, capped at
`MAX_SPEED_PICKUPS`. Solid cells always block movement; bricks are walkable only
while Ghost is active. A bomb blocks entry into its cell, but never traps the
player already stepping away from the cell on which it was placed.

The complete input shape is:

```js
{ up, down, left, right, bomb, action }
```

All fields are booleans. `bomb` and `action` are edge-triggered. The shared
secondary action first tries to throw the stationary bomb immediately in front
of the player; if no throw occurs, it detonates the player's oldest live remote
bomb.

---

## 3. Bombs, flames, and advanced handling

A placed bomb stores its stable id, owner, cell and continuous position, fuse,
range, Pierce stack, Remote flag, movement velocity, and throw height/time. A
player cannot exceed `maxBombs`, and only one bomb can occupy a cell.

At detonation, flame arms travel in the four cardinal directions:

- `SOLID` stops an arm without receiving flame.
- `BRICK` is destroyed, reveals its hidden powerup, and normally stops the arm.
- Each Pierce stack lets each arm cross one additional brick.
- Empty cells receive flame; loose powerups on them are burned.
- A bomb reached by flame is set to detonate immediately.

The engine keeps resolving non-positive bomb timers until no new chain remains,
so a complete chain reaction finishes in one simulation tick. A newly ignited
flame is lethal during that tick; its remaining visible lifetime is decorative.

Advanced bomb abilities use the same bomb representation:

- **Kick** starts a centre-to-centre slide when the player pushes a stationary
  bomb and the next cell is free.
- **Remote Detonator** marks newly placed bombs as remote. They keep their normal
  fuse, but `action` may detonate the oldest owned one early.
- **Bomb Throw** uses `action` while facing an adjacent stationary bomb. The
  bomb arcs to the farthest valid empty landing cell up to three cells farther
  in that direction.
- Switchyard rails move eligible stationary bombs on deterministic pulses.

---

## 4. Powerups

All upgrades reset at the start of each round; scores persist across rounds.

| Kind | Effect | Lifetime / cap |
| ---- | ------ | -------------- |
| `BOMB` (1) | `+1` concurrent bomb | `MAX_BOMBS` = 8 |
| `RANGE` (2) | `+1` blast reach | `MAX_RANGE` = 8 |
| `SPEED` (3) | `+1` movement-speed stack | `MAX_SPEED_PICKUPS` = 4 |
| `GHOST` (4) | Walk through destructible bricks | Refreshes to 5 s |
| `PIERCE` (5) | Cross one more brick per blast arm | Stacks to 8 |
| `SHIELD` (6) | Absorb one otherwise lethal hit | Expires after 10 s; grants 1.2 s i-frames when used |
| `KICK` (7) | Kick stationary bombs | Remainder of round |
| `REMOTE` (8) | Detonate the oldest owned remote bomb with `action` | Remainder of round |
| `THROW` (9) | Throw the bomb directly ahead with `action` | Remainder of round |

Weighted drops favour the core Bomb, Range, and Speed upgrades; Remote and Throw
are the rarest.

---

## 5. Arena mechanics

[`shared/arena-mechanics.js`](shared/arena-mechanics.js) hides arena-specific
behaviour behind one deterministic interface:

```js
createArenaMechanic(arena)
prepareArenaMechanic(mechanic, world)
arenaMechanicInput(mechanic, player, input, world)
stepArenaMechanic(mechanic, world, dt)
arenaMechanicSnapshot(mechanic)
restoreArenaMechanic(snapshot)
```

The engine prepares reserved mechanic cells during round generation, optionally
transforms player input before movement (ice), and advances the mechanic after
player movement but before bomb fuses. Portals snap players between endpoints
with a cooldown/occupancy latch. Lava cycles through dormant, telegraph, and
active phases. Rails move bombs every `0.4` seconds. Mechanic state is included
in snapshots so rendering does not duplicate the authoritative layout or phase.

---

## 6. Bots and teams

[`shared/bot-ai.js`](shared/bot-ai.js) exports
`decideBotInput(state, player)`. It is deterministic, does not mutate its
arguments, and returns the same six-button input shape as a human. Bots use
grid search to escape current and predicted blast danger, account for sudden
death and lava warnings, seek powerups/opponents, place bombs when they can
escape, and use Remote when useful.

The engine identifies bots with `playerDefs[].bot`. Before each fixed step it
feeds bot decisions through the same input, movement, and action seam as human
control.

- Local play always has two humans and may add zero, one, or two bots.
- Online rooms target two to four total slots. Configured bots reserve their
  slots, so the room accepts only the required number of humans.
- If a human disconnects during active play, the authoritative player becomes
  a bot instead of freezing or disappearing, including when the disconnect
  lands during the inter-round result delay.

In `mode: "teams"`, the target is always four players. Slots `0–1` form Team 0
and slots `2–3` form Team 1; because spawn order is diagonal, teammates start
in opposite corners. A round ends when at most one team remains, and both team
members display the shared team score.

---

## 7. Round flow, rules, and sudden death

The fixed simulation rate is **60 Hz** (`TICK_DT = 1 / 60`). Callers use an
accumulator so render or server-timer jitter does not change game speed.

In FFA, a round resolves when at most one player remains. In 2v2, it resolves
when at most one team remains. A sole player/team earns one point; simultaneous
elimination is a draw. `roundover` lasts `ROUND_END_DELAY` (3 s), after which a
new arena, mechanic state, players, and upgrades are generated automatically.
The first player/team to `winsToWin` enters `matchover`.

Rules are canonicalized by `normalizeRules(input)`:

| Field | Values | Default |
| ----- | ------ | ------- |
| `winsToWin` | integer `1..9` | `3` |
| `suddenDeathSeconds` | integer `30..300` | `90` |
| `powerupRate` | `low`, `normal`, `high` | `normal` |
| `arena` | `shuffle`, `classic`, `crossroads`, `citadel`, `switchyard` | `shuffle` |
| `botCount` | `0..playerTarget-1` | `0` |
| `mode` | `ffa`, `teams` | `ffa` |
| `playerTarget` | `2..4`; forced to `4` for teams | `2` |

After `suddenDeathSeconds`, non-solid interior cells become solid in an inward
spiral at roughly `0.18` seconds per cell. A collapsing cell removes its hidden
or loose powerup and any bomb, and kills a player standing there. Round time,
the spiral index, and its timer all reset on every generated round.

---

## 8. Shared-engine architecture

The simulation is shared by local browser play and authoritative Node play:

```text
                       shared/engine.js
                 deterministic game coordinator
                    /          |          \
          rules.js       arena mechanics    bot-ai.js
                    \          |          /
             browser local          Node server
             step + render       step + snapshots
```

The coordinator owns round flow and calls three focused modules:

- [`shared/rules.js`](shared/rules.js) validates the complete match policy at
  browser/server trust boundaries.
- [`shared/arena-mechanics.js`](shared/arena-mechanics.js) owns all per-arena
  state and mutation behind one world adapter.
- [`shared/bot-ai.js`](shared/bot-ai.js) produces ordinary input without a
  separate bot-only movement or bomb path.

Main engine surface:

```js
createGame(
  [{ id, slot, name, bot? }],
  { seed, rules } // legacy winsToWin is also accepted
)
setInput(state, slot, { up, down, left, right, bomb, action })
step(state, dt)
stepPlayerGrid(grid, bombs, player, input, dt) // shared client prediction
toSnapshot(state)
```

The online client predicts only its own grid movement with `stepPlayerGrid`,
interpolates other players along orthogonal routes, and rebases to server
authority only when paths genuinely diverge. Portal sequence changes snap
directly to the destination so interpolation never cuts diagonally across the
map.

### Snapshot shape

`toSnapshot` returns plain JSON. The shape below lists the current gameplay and
rendering fields (mechanic fields vary by arena kind):

```jsonc
{
  "t", "phase", "round", "phaseTimer",
  "winner", "matchWinner",
  "winnerTeam", "matchWinnerTeam", "teamScores",
  "winsToWin", "rules",
  "arena": { "id", "theme" },
  "mechanic": { "arenaId", "theme", "kind", "elapsed" },
  "grid": [/* COLS * ROWS CELL values */],
  "powerups": [{ "col", "row", "kind" }],
  "players": [{
    "slot", "name", "team", "bot",
    "x", "y", "dir", "alive", "moving", "stepping", "tx", "ty",
    "maxBombs", "range", "speedPicks", "ghost", "pierce",
    "shield", "shieldTime", "kick", "remote", "throwBombs",
    "invuln", "bombLock", "score", "teleportSeq"
  }],
  "bombs": [{
    "id", "owner", "col", "row", "x", "y", "z",
    "vx", "vy", "airTime", "timer", "range", "pierce", "remote"
  }],
  "flames": [{ "col", "row", "kind", "orient" }]
}
```

---

## 9. Wire protocol and room lifecycle

Online messages are JSON `{ type, ...payload }`, encoded/decoded through
[`shared/protocol.js`](shared/protocol.js). The server simulates at 60 Hz and
broadcasts full snapshots at **30 Hz**. It queues short input transitions in
wire order, skips redundant snapshots for a backed-up socket, and always keeps
round/match boundary snapshots reliable. Clients send periodic Ping probes and
display a smoothed round-trip time.

**Client → server**

| `MSG` | Payload | Meaning |
| ----- | ------- | ------- |
| `JOIN` (`join`) | `{ name, room, rules? }` | Empty `room` creates a room and applies normalized host rules; joiners inherit them. |
| `INPUT` (`input`) | `{ input: { up, down, left, right, bomb, action } }` | Current six-button state. |
| `READY` (`ready`) | `{ ready }` | Toggle the human member's lobby-ready flag. |
| `RESTART` (`restart`) | `{}` | Host requests a new match after `matchover`. |
| `LEAVE` (`leave`) | `{}` | Leave the room. |
| `PING` (`ping`) | `{ id }` | Round-trip-time probe; valid before joining. |

**Server → client**

| `MSG` | Payload | Meaning |
| ----- | ------- | ------- |
| `JOINED` (`joined`) | `{ room, slot, host }` | Assigned room, player slot, and initial host flag. |
| `LOBBY` (`lobby`) | `{ room, host, players: [{ slot, name, ready }], rules, playableCount, canStart }` | Human members plus normalized room configuration and human+bot readiness count. |
| `START` (`start`) | `{ winsToWin, rules }` | Authoritative new-match boundary. |
| `SNAPSHOT` (`snapshot`) | `{ snap }` | Full `toSnapshot` world state. |
| `PONG` (`pong`) | `{ id }` | Echo of the matching Ping id. |
| `ERROR` (`error`) | `{ message }` | Human-readable server error. |

`canStart` becomes true when every human is ready and humans plus configured
bots reach `playerTarget`; the host then starts the match. The host may restart
only after `matchover` and while the full configured `playerTarget` remains
playable. Host duty passes to the lowest remaining human slot when the current
host leaves.
