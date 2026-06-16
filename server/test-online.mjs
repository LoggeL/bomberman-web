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
  const c = { ws, msgs: [], joined: null, lobby: null, started: null, snaps: 0 };
  ws.on('message', (d) => {
    const m = decode(d.toString());
    if (!m) return;
    c.msgs.push(m);
    if (m.type === MSG.JOINED) c.joined = m;
    else if (m.type === MSG.LOBBY) c.lobby = m;
    else if (m.type === MSG.START) c.started = m;
    else if (m.type === MSG.SNAPSHOT) c.snaps++;
  });
  c.send = (t, p) => ws.send(encode(t, p));
  c.open = new Promise((res) => ws.on('open', res));
  return c;
}

const run = async () => {
  console.log(`online flow against ${URL}`);
  const host = client();
  await host.open;
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

  // Send some input and confirm the world keeps advancing.
  const before = host.snaps;
  host.send(MSG.INPUT, { input: { right: true, up: false, down: false, left: false, bomb: false } });
  await wait(300);
  ok(host.snaps > before, 'snapshots continue after input');

  // Guest leaves; host should get an updated lobby/host stays.
  guest.ws.close();
  await wait(200);

  host.ws.close();
  console.log(failed === 0 ? '\nALL ONLINE TESTS PASSED' : `\n${failed} ONLINE TEST(S) FAILED`);
  process.exit(failed === 0 ? 0 : 1);
};

run().catch((e) => { console.error(e); process.exit(1); });
