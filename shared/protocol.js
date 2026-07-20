// Wire protocol shared by the WebSocket server and the online client.
// Messages are JSON: { type, ...payload }. Keep this the single source of truth.

export const MSG = {
  // client -> server
  JOIN: 'join',         // { name, room, rules? }  room '' => create a room with normalized host rules
  INPUT: 'input',       // { input: {up,down,left,right,bomb,action} }
  READY: 'ready',       // { ready: bool }   toggle ready in the lobby
  RESTART: 'restart',   // {}                host requests a new match
  LEAVE: 'leave',       // {}
  PING: 'ping',         // { id }             RTT probe, also valid before joining a room

  // server -> client
  JOINED: 'joined',     // { room, slot, host }  you successfully joined
  LOBBY: 'lobby',       // { room, host, players, rules, playableCount, canStart }
  START: 'start',       // { winsToWin, rules }     match begins
  SNAPSHOT: 'snapshot', // { snap }          full world snapshot (see engine.toSnapshot)
  PONG: 'pong',         // { id }             echoes the matching PING id
  ERROR: 'error',       // { message }
};

export const SNAPSHOT_HZ = 30;   // server broadcast rate
export const ROOM_CODE_LEN = 4;

export function encode(type, payload = {}) {
  return JSON.stringify({ type, ...payload });
}

export function decode(raw) {
  try { return JSON.parse(raw); } catch { return null; }
}
