// WebSocket networking for online play.
//
// createNet(handlers) returns an object that owns one socket and translates
// between the UI's intent (join / input / ready / restart / leave) and the wire
// protocol defined in shared/protocol.js. Incoming messages are dispatched to
// the matching handler callback.

import { MSG, encode, decode } from '../../shared/protocol.js';

// Work out the server's WebSocket URL.
//   - Vite dev server runs the page on :5173 while the ws server is on :8080,
//     so in dev we hard-target ws://<hostname>:8080.
//   - In production the same Node process serves the page and the socket, so we
//     reuse the page's host and match ws:/wss: to http:/https:.
function resolveUrl() {
  const loc = window.location;
  if (loc.port === '5173') {
    return `ws://${loc.hostname}:8080`;
  }
  const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${loc.host}`;
}

export function createNet(handlers = {}) {
  let ws = null;
  let opened = false; // did we ever reach the OPEN state?

  const noop = () => {};
  const h = {
    onJoined: handlers.onJoined || noop,
    onLobby: handlers.onLobby || noop,
    onStart: handlers.onStart || noop,
    onSnapshot: handlers.onSnapshot || noop,
    onError: handlers.onError || noop,
    onClose: handlers.onClose || noop,
  };

  function send(type, payload) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(encode(type, payload));
    }
  }

  function connect() {
    // Tear down any previous socket before opening a fresh one.
    close();
    opened = false;
    try {
      ws = new WebSocket(resolveUrl());
    } catch (err) {
      h.onError('Verbindung fehlgeschlagen.');
      return;
    }

    ws.addEventListener('open', () => { opened = true; });

    ws.addEventListener('message', (ev) => {
      const msg = decode(ev.data);
      if (!msg || !msg.type) return;
      switch (msg.type) {
        case MSG.JOINED:   h.onJoined(msg); break;
        case MSG.LOBBY:    h.onLobby(msg); break;
        case MSG.START:    h.onStart(msg); break;
        case MSG.SNAPSHOT: h.onSnapshot(msg.snap); break;
        case MSG.ERROR:    h.onError(msg.message || 'Serverfehler.'); break;
        default: break;
      }
    });

    ws.addEventListener('error', () => {
      // Surface a friendly message; the UI can fall back to the menu.
      if (!opened) h.onError('Konnte den Server nicht erreichen.');
    });

    ws.addEventListener('close', () => {
      const wasOpen = opened;
      ws = null;
      opened = false;
      h.onClose(wasOpen);
    });
  }

  function close() {
    if (ws) {
      // Stop our listeners from firing onClose during an intentional teardown.
      try { ws.close(); } catch { /* ignore */ }
      ws = null;
    }
  }

  return {
    connect,
    join(name, room, winsToWin) { send(MSG.JOIN, { name, room, winsToWin }); },
    sendInput(input) { send(MSG.INPUT, { input }); },
    setReady(ready) { send(MSG.READY, { ready }); },
    restart() { send(MSG.RESTART, {}); },
    leave() { send(MSG.LEAVE, {}); },
    close,
  };
}
