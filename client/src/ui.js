// DOM screen management. ui.js owns every overlay element, wires their buttons
// to the callbacks main.js provides, and exposes a small API for main.js to
// drive (show a screen, refresh the lobby/HUD, show results/errors).

import { PLAYER_COLORS, PLAYER_NAMES, SUDDEN_DEATH_TIME } from '../../shared/constants.js';

const SCREENS = ['menu', 'local', 'online', 'hud', 'result'];

export function createUI(callbacks = {}) {
  const cb = callbacks;
  const $ = (id) => document.getElementById(id);

  // Cache screen sections.
  const screens = {};
  for (const name of SCREENS) screens[name] = $(`screen-${name}`);

  // ---- segmented-control helper -------------------------------------------
  // Returns a getter for the currently-selected numeric value.
  function makeSeg(containerId) {
    const el = $(containerId);
    let value = Number(el.querySelector('.is-active')?.dataset.val || 0);
    el.addEventListener('click', (e) => {
      const btn = e.target.closest('.seg-btn');
      if (!btn) return;
      el.querySelectorAll('.seg-btn').forEach((b) => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      value = Number(btn.dataset.val);
    });
    return () => value;
  }

  const getPlayers = makeSeg('seg-players');
  const getWinsLocal = makeSeg('seg-wins-local');
  const getWinsOnline = makeSeg('seg-wins-online');

  // ---- toast --------------------------------------------------------------
  const toastEl = $('toast');
  let toastTimer = null;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, 3200);
  }

  // ---- navigation ---------------------------------------------------------
  function show(screen) {
    for (const name of SCREENS) {
      screens[name].classList.toggle('is-visible', name === screen);
    }
  }

  // ---- menu ---------------------------------------------------------------
  $('btn-goto-local').addEventListener('click', () => show('local'));
  $('btn-goto-online').addEventListener('click', () => show('online'));

  // ---- "Zurück" buttons ---------------------------------------------------
  document.querySelectorAll('[data-back]').forEach((b) => {
    b.addEventListener('click', () => cb.onBackToMenu && cb.onBackToMenu());
  });

  // ---- local setup --------------------------------------------------------
  $('btn-start-local').addEventListener('click', () => {
    cb.onStartLocal && cb.onStartLocal(getPlayers(), getWinsLocal());
  });

  // ---- online setup -------------------------------------------------------
  const nameInput = $('inp-name');
  const codeInput = $('inp-code');
  const onlineSetup = $('online-setup');
  const onlineRoom = $('online-room');

  function playerName() {
    return (nameInput.value || '').trim().slice(0, 12) || 'Spieler';
  }

  $('btn-create-room').addEventListener('click', () => {
    cb.onCreateRoom && cb.onCreateRoom(playerName(), getWinsOnline());
  });
  $('btn-join-room').addEventListener('click', () => {
    const code = (codeInput.value || '').trim().toUpperCase();
    if (code.length < 1) { toast('Bitte einen Raumcode eingeben.'); return; }
    cb.onJoinRoom && cb.onJoinRoom(playerName(), code);
  });
  codeInput.addEventListener('input', () => {
    codeInput.value = codeInput.value.toUpperCase();
  });

  // ---- room (lobby) -------------------------------------------------------
  let myReady = false;
  const readyBtn = $('btn-ready');
  readyBtn.addEventListener('click', () => {
    myReady = !myReady;
    cb.onToggleReady && cb.onToggleReady(myReady);
    syncReadyBtn();
  });
  function syncReadyBtn() {
    readyBtn.classList.toggle('is-ready', myReady);
    readyBtn.textContent = myReady ? 'Nicht bereit' : 'Bereit';
  }

  $('btn-start-online').addEventListener('click', () => {
    cb.onStartOnline && cb.onStartOnline();
  });
  $('btn-leave-room').addEventListener('click', () => cb.onBackToMenu && cb.onBackToMenu());

  $('btn-copy-code').addEventListener('click', () => {
    const code = $('room-code-value').textContent;
    if (navigator.clipboard) navigator.clipboard.writeText(code).then(
      () => toast('Code kopiert: ' + code),
      () => toast('Kopieren nicht möglich.'),
    );
  });

  // Called by main.js when JOINED arrives — switch to the room sub-view.
  let mySlot = -1;
  function enterRoom({ room, slot, host }) {
    mySlot = slot;
    myReady = false;
    syncReadyBtn();
    onlineSetup.hidden = true;
    onlineRoom.hidden = false;
    $('room-code-value').textContent = room;
    $('btn-start-online').hidden = !host;
    show('online');
  }

  // Reset the online screen back to its connect/setup state.
  function resetOnline() {
    onlineSetup.hidden = false;
    onlineRoom.hidden = true;
    myReady = false;
    mySlot = -1;
    syncReadyBtn();
    $('lobby-players').innerHTML = '';
    $('lobby-hint').textContent = '';
  }

  function updateLobby(data) {
    const list = $('lobby-players');
    list.innerHTML = '';
    for (const p of data.players) {
      const li = document.createElement('li');
      const color = PLAYER_COLORS[p.slot] || '#fff';
      const isHost = p.slot === data.host;
      const isMe = p.slot === mySlot;
      li.innerHTML = `
        <span class="pl-swatch" style="background:${color};color:${color}"></span>
        <span class="pl-name">${escapeHtml(p.name)}${isMe ? ' (du)' : ''}</span>
        ${isHost ? '<span class="pl-host">Host</span>' : ''}
        <span class="pl-ready ${p.ready ? 'ready' : 'waiting'}">${p.ready ? '✓ Bereit' : 'Wartet'}</span>
      `;
      list.appendChild(li);
    }
    // Host can start once everyone's ready and there are enough players.
    const startBtn = $('btn-start-online');
    if (!startBtn.hidden) startBtn.disabled = !data.canStart;

    const me = data.players.find((p) => p.slot === mySlot);
    if (me) { myReady = !!me.ready; syncReadyBtn(); }

    const hint = $('lobby-hint');
    if (data.players.length < 2) hint.textContent = 'Warte auf mindestens einen weiteren Spieler…';
    else if (!data.canStart) hint.textContent = 'Warte, bis alle bereit sind…';
    else if (startBtn.hidden) hint.textContent = 'Bereit! Der Host kann starten.';
    else hint.textContent = 'Alle bereit — du kannst starten!';
  }

  // ---- HUD ----------------------------------------------------------------
  const hudPlayers = $('hud-players');
  const hudRound = $('hud-round');
  const hudTimer = $('hud-timer');
  const suddenDeath = $('sudden-death');

  function updateHud(snap, localSlots = []) {
    if (!snap) return;
    // Per-player cards.
    hudPlayers.innerHTML = '';
    for (const p of [...snap.players].sort((a, b) => a.slot - b.slot)) {
      const color = PLAYER_COLORS[p.slot] || '#fff';
      const card = document.createElement('div');
      card.className = 'hud-card' + (p.alive ? '' : ' dead');
      card.style.borderLeftColor = color;
      const youTag = localSlots.includes(p.slot) ? ' ◂' : '';
      card.innerHTML = `
        <div class="hc-main">
          <span class="hc-name" style="color:${color}">${escapeHtml(p.name)}${youTag}</span>
          <span class="hc-score">Siege: ${p.score}</span>
        </div>
        <div class="hc-stats">
          <span title="Bomben">💣<b>${p.maxBombs}</b></span>
          <span title="Reichweite">🔥<b>${p.range}</b></span>
          <span title="Tempo">⚡<b>${p.speedPicks}</b></span>
        </div>
      `;
      hudPlayers.appendChild(card);
    }

    hudRound.textContent = `Runde ${snap.round} · Best of ${snap.winsToWin}`;

    // Timer / sudden-death countdown.
    const tLeft = SUDDEN_DEATH_TIME - snap.t;
    if (snap.t >= SUDDEN_DEATH_TIME) {
      suddenDeath.hidden = false;
      hudTimer.textContent = 'Die Wände schließen sich!';
      hudTimer.classList.add('danger');
    } else {
      suddenDeath.hidden = true;
      hudTimer.classList.toggle('danger', tLeft <= 15);
      hudTimer.textContent = `Sudden Death in ${Math.ceil(tLeft)}s`;
    }
  }

  // ---- result -------------------------------------------------------------
  $('btn-rematch').addEventListener('click', () => cb.onRestart && cb.onRestart());
  $('btn-result-menu').addEventListener('click', () => cb.onBackToMenu && cb.onBackToMenu());

  function showResult(snap) {
    const title = $('result-title');
    const winnerEl = $('result-winner');
    const isMatch = snap.phase === 'matchover';
    const winnerSlot = isMatch ? snap.matchWinner : snap.winner;

    title.textContent = isMatch ? 'Spiel vorbei!' : 'Runde vorbei';

    if (winnerSlot === null || winnerSlot === undefined) {
      winnerEl.innerHTML = `<span class="crown">🤝</span>Unentschieden`;
    } else {
      const color = PLAYER_COLORS[winnerSlot] || '#fff';
      const name = snap.players.find((p) => p.slot === winnerSlot)?.name || PLAYER_NAMES[winnerSlot];
      winnerEl.innerHTML = `<span class="crown">${isMatch ? '👑' : '🏆'}</span>` +
        `<span style="color:${color}">${escapeHtml(name)}</span> ${isMatch ? 'gewinnt das Spiel!' : 'gewinnt die Runde'}`;
    }

    // Scoreboard.
    const scores = $('result-scores');
    scores.innerHTML = '';
    for (const p of [...snap.players].sort((a, b) => b.score - a.score)) {
      const color = PLAYER_COLORS[p.slot] || '#fff';
      const row = document.createElement('div');
      row.className = 'rs-row';
      row.innerHTML = `
        <span class="rs-swatch" style="background:${color};color:${color}"></span>
        <span class="rs-name">${escapeHtml(p.name)}</span>
        <span class="rs-score">${p.score}</span>
      `;
      scores.appendChild(row);
    }

    // Rematch only really makes sense after the whole match.
    $('btn-rematch').textContent = isMatch ? 'Revanche' : 'Weiter';
    show('result');
  }

  function showError(msg) {
    toast(msg);
  }

  return {
    show,
    enterRoom,
    resetOnline,
    updateLobby,
    updateHud,
    showResult,
    showError,
    // expose so main can read the selected name if it needs to reconnect
    getName: playerName,
  };
}

// Basic HTML escaping for user-supplied names.
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
