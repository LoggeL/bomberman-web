// Headless online integration test: boots the real server in-process, then
// drives two WebSocket clients through join -> ready -> START -> SNAPSHOT.
// Run: node server/test-online.mjs   (self-contained — no separate server)
import { WebSocket } from 'ws';
import { MSG, encode, decode } from '../shared/protocol.js';

const PORT = process.env.PORT || 8097;
const URL = `ws://localhost:${PORT}`;

// Start the actual server (index.js listens on import).
process.env.PORT = String(PORT);
await import('./index.js');
await new Promise((r) => setTimeout(r, 500));
let failed = 0;
const ok = (c, m) => { if (!c) { failed++; console.error('  ✗', m); } else console.log('  ✓', m); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function client() {
  const ws = new WebSocket(URL);
  const c = {
    ws, msgs: [], joined: null, lobby: null, started: null,
    starts: 0, snaps: 0, lastSnap: null,
  };
  ws.on('message', (d) => {
    const m = decode(d.toString());
    if (!m) return;
    c.msgs.push(m);
    if (m.type === MSG.JOINED) c.joined = m;
    else if (m.type === MSG.LOBBY) c.lobby = m;
    else if (m.type === MSG.START) { c.started = m; c.starts++; }
    else if (m.type === MSG.SNAPSHOT) { c.snaps++; c.lastSnap = m.snap; }
  });
  c.send = (t, p) => ws.send(encode(t, p));
  c.open = new Promise((res) => ws.on('open', res));
  return c;
}

async function eventually(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await wait(25);
  }
  return !!predicate();
}

const run = async () => {
  console.log(`online flow against ${URL}`);
  const host = client();
  await host.open;
  host.send(MSG.PING, { id: 17 });
  ok(await eventually(() => host.msgs.some((m) => m.type === MSG.PONG && m.id === 17)),
    'server echoes ping probes before room join');
  host.send(MSG.JOIN, { name: 'Host', room: '', winsToWin: 2 });
  await wait(200);
  ok(host.joined && host.joined.host === true, 'host joined and is host');
  const code = host.joined.room;
  ok(typeof code === 'string' && code.length === 4, `room code issued (${code})`);

  const guest = client();
  await guest.open;
  guest.send(MSG.JOIN, { name: 'Gast', room: code });
  await wait(200);
  ok(guest.joined && guest.joined.slot === 1, 'guest joined as slot 1');
  ok(host.lobby && host.lobby.players.length === 2, 'host sees 2 players in lobby');

  // Ready both; the host being ready + canStart triggers START.
  guest.send(MSG.READY, { ready: true });
  await wait(80);
  host.send(MSG.READY, { ready: true });
  await wait(300);

  ok(host.started && guest.started, 'both clients received START');
  ok(host.started && host.started.winsToWin === 2, 'winsToWin from host honoured (=2)');
  ok(host.snaps > 0 && guest.snaps > 0, `snapshots flowing (host=${host.snaps}, guest=${guest.snaps})`);
  ok(typeof host.lastSnap?.arena?.id === 'string' && typeof host.lastSnap?.arena?.theme === 'string',
    'authoritative snapshots carry arena identity and theme');

  // Send some input and confirm the world keeps advancing.
  const before = host.snaps;
  host.send(MSG.INPUT, { input: { right: true, up: false, down: false, left: false, bomb: false } });
  await wait(300);
  ok(host.snaps > before, 'snapshots continue after input');

  // A press + release can reach the server inside one 60 Hz interval. Both
  // transitions must survive so prediction and authority commit the same step.
  host.send(MSG.INPUT, { input: { right: false, up: false, down: false, left: false, bomb: false } });
  await wait(300); // let the current grid step settle
  const xBeforeTap = host.lastSnap.players.find((p) => p.slot === 0).x;
  // Return toward the guaranteed-clear spawn cell; the next cell to the right
  // may legitimately contain a randomly generated brick.
  host.send(MSG.INPUT, { input: { right: false, up: false, down: false, left: true, bomb: false } });
  host.send(MSG.INPUT, { input: { right: false, up: false, down: false, left: false, bomb: false } });
  const movedAfterTap = await eventually(() => {
    const p = host.lastSnap?.players.find((q) => q.slot === 0);
    return p && p.x < xBeforeTap - 0.5;
  });
  ok(movedAfterTap, 'back-to-back movement press/release commits one grid step');

  // The same transition race used to erase quick bomb taps completely.
  await eventually(() => host.lastSnap?.t > 1.05);
  host.send(MSG.INPUT, { input: { right: false, up: false, down: false, left: false, bomb: true } });
  host.send(MSG.INPUT, { input: { right: false, up: false, down: false, left: false, bomb: false } });
  const quickBombPlaced = await eventually(() =>
    host.lastSnap?.bombs.some((b) => b.owner === 0));
  ok(quickBombPlaced, 'back-to-back bomb press/release places one authoritative bomb');

  console.log('bot-backed and team lobbies');
  const solo = client();
  await solo.open;
  solo.send(MSG.JOIN, {
    name: 'SoloHost',
    room: '',
    rules: {
      winsToWin: 2,
      botCount: 1,
      playerTarget: 2,
      arena: 'citadel',
      suddenDeathSeconds: 45,
    },
  });
  await eventually(() => solo.joined && solo.lobby);
  ok(solo.lobby?.playableCount === 2 && solo.lobby.rules?.botCount === 1,
    'one host plus one configured bot forms a playable lobby');
  solo.send(MSG.READY, { ready: true });
  ok(await eventually(() => solo.started && solo.lastSnap?.players.length === 2),
    'solo host starts a server-authoritative bot match');
  ok(solo.lastSnap.players.some((player) => player.bot) &&
     solo.lastSnap.rules?.arena === 'citadel' &&
     solo.lastSnap.rules?.suddenDeathSeconds === 45,
    'bot and normalized host rules reach authoritative snapshots');
  solo.ws.close();

  const teamHost = client();
  await teamHost.open;
  teamHost.send(MSG.JOIN, {
    name: 'TeamHost',
    room: '',
    rules: { mode: 'teams', botCount: 2, playerTarget: 4, winsToWin: 1 },
  });
  await eventually(() => teamHost.joined);
  const teamGuest = client();
  await teamGuest.open;
  teamGuest.send(MSG.JOIN, { name: 'TeamGuest', room: teamHost.joined.room });
  await eventually(() => teamGuest.joined);
  teamGuest.send(MSG.READY, { ready: true });
  await wait(50);
  teamHost.send(MSG.READY, { ready: true });
  ok(await eventually(() => teamHost.started && teamHost.lastSnap?.players.length === 4),
    'two humans plus two bots start a full 2v2 match');
  ok(teamHost.lastSnap.rules?.mode === 'teams' &&
     teamHost.lastSnap.players.filter((player) => player.bot).length === 2 &&
     new Set(teamHost.lastSnap.players.map((player) => player.team)).size === 2,
    '2v2 snapshot exposes two teams and both bot slots');
  await eventually(() => teamHost.lastSnap?.t > 1.05);
  const selfBomb = {
    input: { up: false, down: false, left: false, right: false, bomb: true, action: false },
  };
  const release = {
    input: { up: false, down: false, left: false, right: false, bomb: false, action: false },
  };
  teamHost.send(MSG.INPUT, selfBomb);
  teamHost.send(MSG.INPUT, release);
  teamGuest.send(MSG.INPUT, selfBomb);
  teamGuest.send(MSG.INPUT, release);
  ok(await eventually(() => teamHost.lastSnap?.phase === 'matchover', 4000),
    '2v2 reaches matchover for roster validation');
  teamGuest.ws.close();
  ok(await eventually(() => teamHost.lobby?.playableCount === 3),
    'departed teammate drops the playable 2v2 roster below its target');
  teamHost.send(MSG.RESTART, {});
  await wait(150);
  ok(teamHost.starts === 1 && teamHost.msgs.some((m) =>
    m.type === MSG.ERROR && /configured rematch/i.test(m.message)),
  '2v2 rematch is rejected until all four configured slots are playable');
  teamHost.ws.close();

  console.log('round-boundary disconnect takeover');
  const roundHost = client();
  await roundHost.open;
  roundHost.send(MSG.JOIN, {
    name: 'RoundHost',
    room: '',
    rules: { winsToWin: 2, playerTarget: 2 },
  });
  await eventually(() => roundHost.joined);
  const roundGuest = client();
  await roundGuest.open;
  roundGuest.send(MSG.JOIN, { name: 'RoundGuest', room: roundHost.joined.room });
  await eventually(() => roundGuest.joined);
  roundGuest.send(MSG.READY, { ready: true });
  await wait(50);
  roundHost.send(MSG.READY, { ready: true });
  await eventually(() => roundHost.started && roundHost.lastSnap?.t > 1.05);
  roundHost.send(MSG.INPUT, selfBomb);
  roundHost.send(MSG.INPUT, release);
  ok(await eventually(() => roundHost.lastSnap?.phase === 'roundover', 4000),
    'two-win match enters the inter-round result phase');
  roundGuest.ws.close();
  ok(await eventually(() =>
    roundHost.lastSnap?.phase === 'playing' &&
    roundHost.lastSnap.round === 2 &&
    roundHost.lastSnap.players.some((player) =>
      player.slot === 1 && player.bot && /Bot$/.test(player.name)), 4500),
  'disconnect during roundover respawns as an active bot next round');
  roundHost.ws.close();

  console.log('match restart idempotency');
  const rematchHost = client();
  await rematchHost.open;
  rematchHost.send(MSG.JOIN, { name: 'RematchHost', room: '', winsToWin: 1 });
  await eventually(() => rematchHost.joined);
  const rematchGuest = client();
  await rematchGuest.open;
  rematchGuest.send(MSG.JOIN, { name: 'RematchGuest', room: rematchHost.joined.room });
  await eventually(() => rematchGuest.joined);
  rematchGuest.send(MSG.READY, { ready: true });
  await wait(50);
  rematchHost.send(MSG.READY, { ready: true });
  ok(await eventually(() => rematchHost.starts === 1 && rematchGuest.starts === 1),
    'one-win match started once');

  await eventually(() => rematchHost.lastSnap?.t > 1.05);
  rematchHost.send(MSG.INPUT, { input: { up: false, down: false, left: false, right: false, bomb: true } });
  rematchHost.send(MSG.INPUT, { input: { up: false, down: false, left: false, right: false, bomb: false } });
  ok(await eventually(() => rematchHost.lastSnap?.phase === 'matchover', 4000),
    'one-win match reached matchover');

  rematchGuest.send(MSG.RESTART, {});
  await wait(150);
  ok(rematchHost.starts === 1 && rematchGuest.starts === 1,
    'non-host restart is ignored');

  rematchHost.send(MSG.RESTART, {});
  rematchHost.send(MSG.RESTART, {});
  ok(await eventually(() => rematchHost.starts === 2 && rematchGuest.starts === 2),
    'duplicate host restart requests create exactly one new match');
  await wait(100);
  ok(rematchHost.starts === 2 && rematchGuest.starts === 2,
    'no duplicate START appears after the rematch');

  // Resolve the rematch too, then remove the host. The remaining guest becomes
  // host but must not be allowed to start an unwinnable one-player game.
  await eventually(() =>
    rematchHost.lastSnap?.phase === 'playing' && rematchHost.lastSnap.t > 1.05);
  rematchHost.send(MSG.INPUT, { input: { up: false, down: false, left: false, right: false, bomb: true } });
  rematchHost.send(MSG.INPUT, { input: { up: false, down: false, left: false, right: false, bomb: false } });
  ok(await eventually(() => rematchHost.lastSnap?.phase === 'matchover', 4000),
    'rematch reached matchover for host-handoff check');
  rematchHost.ws.close();
  ok(await eventually(() =>
    rematchGuest.lobby?.host === rematchGuest.joined.slot && rematchGuest.lobby.players.length === 1),
  'remaining player becomes host with a one-player roster');
  rematchGuest.send(MSG.RESTART, {});
  await wait(150);
  ok(rematchGuest.starts === 2 && rematchGuest.msgs.some((m) =>
    m.type === MSG.ERROR && /not enough players/i.test(m.message)),
  'one-player host rematch is rejected with an error');

  // Guest leaves; host should get an updated lobby/host stays.
  guest.ws.close();
  await wait(200);

  rematchGuest.ws.close();
  host.ws.close();
  console.log(failed === 0 ? '\nALL ONLINE TESTS PASSED' : `\n${failed} ONLINE TEST(S) FAILED`);
  process.exit(failed === 0 ? 0 : 1);
};

run().catch((e) => { console.error(e); process.exit(1); });
