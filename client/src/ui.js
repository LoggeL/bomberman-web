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
    resetHud();
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

  // The HUD is refreshed many times a second, so it must be DIFF-based: build
  // the per-player cards once for a given roster, then only poke text nodes /
  // classes when their values actually change. Rebuilding innerHTML every frame
  // (the old approach) thrashed layout and made the whole UI feel laggy.
  let hudCards = new Map(); // slot -> { card, nameEl, scoreEl, bombsEl, rangeEl, speedEl, dead }
  let hudRosterKey = '';
  let lastRoundText = '';
  let lastTimerText = '';
  let lastTimerDanger = null;
  let lastSudden = null;

  function buildHudCards(players, localSlots) {
    hudPlayers.innerHTML = '';
    hudCards = new Map();
    for (const p of players) {
      const color = PLAYER_COLORS[p.slot] || '#fff';
      const youTag = localSlots.includes(p.slot) ? ' ◂' : '';
      const card = document.createElement('div');
      card.className = 'hud-card';
      card.style.borderLeftColor = color;
      card.innerHTML = `
        <div class="hc-main">
          <span class="hc-name" style="color:${color}">${escapeHtml(p.name)}${youTag}</span>
          <span class="hc-score">Siege: ${p.score}</span>
        </div>
        <div class="hc-stats">
          <span title="Bomben">💣<b>${p.maxBombs}</b></span>
          <span title="Reichweite">🔥<b>${p.range}</b></span>
          <span title="Tempo">⚡<b>${p.speedPicks}</b></span>
          <span title="Schild">🛡<b>${p.shield}</b></span>
          <span class="hc-badges" title="Fähigkeiten"></span>
        </div>`;
      const bs = card.querySelectorAll('.hc-stats b');
      hudCards.set(p.slot, {
        card,
        scoreEl: card.querySelector('.hc-score'),
        bombsEl: bs[0], rangeEl: bs[1], speedEl: bs[2], shieldEl: bs[3],
        badgesEl: card.querySelector('.hc-badges'),
        dead: false,
      });
      hudPlayers.appendChild(card);
    }
  }

  function updateHud(snap, localSlots = []) {
    if (!snap) return;
    const players = [...snap.players].sort((a, b) => a.slot - b.slot);

    // Rebuild only when the roster (slots / names / who is local) changes.
    const rosterKey = players.map((p) => `${p.slot}:${p.name}`).join('|') + '#' + localSlots.join(',');
    if (rosterKey !== hudRosterKey) {
      buildHudCards(players, localSlots);
      hudRosterKey = rosterKey;
    }

    for (const p of players) {
      const c = hudCards.get(p.slot);
      if (!c) continue;
      const score = `Siege: ${p.score}`;
      if (c.scoreEl.textContent !== score) c.scoreEl.textContent = score;
      const mb = String(p.maxBombs); if (c.bombsEl.textContent !== mb) c.bombsEl.textContent = mb;
      const rg = String(p.range);    if (c.rangeEl.textContent !== rg) c.rangeEl.textContent = rg;
      const sp = String(p.speedPicks); if (c.speedEl.textContent !== sp) c.speedEl.textContent = sp;
      const sh = String(p.shield);   if (c.shieldEl.textContent !== sh) c.shieldEl.textContent = sh;
      const badges = (p.ghost > 0 ? '👻' : '') + (p.pierce ? '💥' : '') + (p.kick ? '🦵' : '');
      if (c.badgesEl.textContent !== badges) c.badgesEl.textContent = badges;
      if (c.dead !== !p.alive) { c.dead = !p.alive; c.card.classList.toggle('dead', !p.alive); }
    }

    const roundText = `Runde ${snap.round} · Ziel: ${snap.winsToWin} Sieg${snap.winsToWin === 1 ? '' : 'e'}`;
    if (roundText !== lastRoundText) { hudRound.textContent = roundText; lastRoundText = roundText; }

    // Timer / sudden-death countdown.
    const sudden = snap.t >= SUDDEN_DEATH_TIME;
    if (sudden !== lastSudden) { suddenDeath.hidden = !sudden; lastSudden = sudden; }
    let timerText, danger;
    if (sudden) {
      timerText = 'Die Wände schließen sich!';
      danger = true;
    } else {
      const tLeft = SUDDEN_DEATH_TIME - snap.t;
      timerText = `Sudden Death in ${Math.ceil(tLeft)}s`;
      danger = tLeft <= 15;
    }
    if (timerText !== lastTimerText) { hudTimer.textContent = timerText; lastTimerText = timerText; }
    if (danger !== lastTimerDanger) { hudTimer.classList.toggle('danger', danger); lastTimerDanger = danger; }
  }

  // Reset cached HUD state so the next match rebuilds cleanly, and clear any
  // transient banner left over from a previous match (e.g. sudden death) so it
  // can't flash before the first updateHud of the new round.
  function resetHud() {
    hudRosterKey = '';
    lastRoundText = '';
    lastTimerText = '';
    lastTimerDanger = false;
    lastSudden = false;
    suddenDeath.hidden = true;
    hudTimer.classList.remove('danger');
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

  // ---- in-game buttons (quit + sound) -------------------------------------
  $('btn-quit').addEventListener('click', () => cb.onBackToMenu && cb.onBackToMenu());

  const soundBtn = $('btn-sound');
  function syncSoundBtn() {
    const muted = cb.sound ? cb.sound.isMuted() : false;
    soundBtn.classList.toggle('is-muted', muted);
    soundBtn.textContent = muted ? '🔇' : '🔊';
    soundBtn.title = muted ? 'Ton einschalten' : 'Ton ausschalten';
  }
  soundBtn.addEventListener('click', () => {
    if (cb.sound) { cb.sound.unlock(); cb.sound.toggleMuted(); }
    syncSoundBtn();
  });
  syncSoundBtn();

  // Delegated click feedback for every button (the sound toggle manages its own
  // audio, so skip it here to avoid a click right as you mute).
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.btn, .seg-btn');
    if (!btn || btn.id === 'btn-sound' || btn.disabled) return;
    const back = btn.hasAttribute('data-back') || btn.id === 'btn-leave-room' || btn.id === 'btn-result-menu';
    if (cb.sound) cb.sound.play(back ? 'uiBack' : 'uiClick');
  });

  return {
    show,
    enterRoom,
    resetOnline,
    updateLobby,
    updateHud,
    resetHud,
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
