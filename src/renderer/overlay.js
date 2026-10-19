'use strict';

const $ = (sel) => document.querySelector(sel);
const body = document.body;
const state = { peers: [], outgoing: [], settings: {}, pending: [] };
const ACTIVE = ['preparing', 'pairing', 'waiting', 'sending'];

$('#close').innerHTML = ICONS.close;
$('#open-settings').innerHTML = ICONS.gear;
$('#pending-clear').innerHTML = ICONS.close;
$('.pending-icon').innerHTML = ICONS.doc;
$('#visibility').insertAdjacentHTML('beforeend', ICONS.chevron);
for (const el of document.querySelectorAll('[data-icon]')) el.innerHTML = ICONS[el.dataset.icon];
for (const tick of document.querySelectorAll('.tick')) tick.innerHTML = ICONS.check;

const handlers = {
  activate(peerId) {
    const active = state.outgoing.find((t) => t.peerId === peerId && ACTIVE.includes(t.status));
    if (active) return wave.cancel(active.id);
    if (state.pending.length) {
      wave.send(peerId, state.pending);
      setPending([]);
    } else {
      wave.pickAndSend(peerId);
    }
  },
  drop(peerId, paths) {
    wave.send(peerId, paths);
  },
};

function render() {
  PeerTiles.render($('#peers'), state.peers, state.outgoing, handlers);
  body.classList.toggle('no-peers', state.peers.length === 0);
  renderPairSheet();
}

function setPending(paths) {
  state.pending = paths;
  body.classList.toggle('has-pending', paths.length > 0);
  $('#pending').hidden = paths.length === 0;
  if (paths.length) {
    $('#pending-title').textContent = paths.length === 1 ? basename(paths[0]) : `${paths.length} elementi`;
  }
}

const CAPTION = {
  everyone: "WaveDrop ti permette di condividere all'istante con le persone nelle vicinanze. Tutto è cifrato end-to-end.",
  contacts: 'Ti vedono solo i dispositivi già abbinati. Gli altri non sanno nemmeno che ci sei.',
  off: 'La ricezione è disattivata: puoi inviare, ma nessuno ti vede.',
};

function applySettings(s) {
  state.settings = s;
  body.classList.toggle('receiving-off', s.visibility === 'off');
  $('#visibility-label').textContent = VISIBILITY_LABEL[s.visibility] || 'Tutti';
  $('#caption').textContent = CAPTION[s.visibility] || CAPTION.everyone;
  for (const b of document.querySelectorAll('#vis-menu button')) {
    b.querySelector('.tick').style.visibility = b.dataset.v === s.visibility ? 'visible' : 'hidden';
  }
  if (document.activeElement !== $('#me-name')) $('#me-name').value = s.name;
  paintAvatar($('#me-ava'), { name: s.name, avatarUrl: s.self && s.self.avatarUrl, color: s.color });
  $('#hotkey').textContent = (s.hotkey || '').replace('Control', 'Ctrl').replace('Command', '⌘').replace(/\+/g, ' + ');
  renderAirDrop();
}

// ───────── AirDrop bridge (Linux only) ─────────

let airdropTick = null;

function clock(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function renderAirDrop() {
  const s = state.settings;
  const b = s.airdropBridge;
  const bar = $('#airdrop-bar');
  clearTimeout(airdropTick);
  bar.hidden = !(b && s.airdrop);
  if (bar.hidden) return;
  const action = $('#airdrop-action');
  const wifiOff = b.exclusive !== false; // unknown counts: say it rather than surprise
  bar.classList.toggle('is-visible', b.state === 'visible');
  bar.title = wifiOff ? 'Su questo PC il Wi-Fi si scollega finché sei visibile ad AirDrop.' : '';
  action.hidden = false;
  action.dataset.do = '';
  let text;
  switch (b.state) {
    case 'visible':
      text = b.visibleUntil ? `AirDrop: visibile ancora ${clock(b.visibleUntil - Date.now())}` : 'AirDrop: visibile';
      if (b.exclusive) text += ' · Wi-Fi scollegato';
      action.textContent = 'Disattiva';
      action.dataset.do = 'off';
      if (b.visibleUntil) airdropTick = setTimeout(renderAirDrop, 1000);
      break;
    case 'ready':
      text = 'AirDrop: non visibile ·';
      action.textContent = 'Rendi visibile per 10 minuti';
      action.dataset.do = 'on';
      break;
    case 'starting':
    case 'stopping':
    case 'unknown':
      text = b.detail || 'AirDrop: verifica…';
      action.hidden = true;
      break;
    default:
      text = 'AirDrop non disponibile.';
      action.textContent = 'Dettagli';
      action.dataset.do = 'settings';
  }
  $('#airdrop-text').textContent = text;
}

$('#airdrop-action').addEventListener('click', () => {
  const what = $('#airdrop-action').dataset.do;
  if (what === 'on' || what === 'off') wave.airdropVisible(what === 'on');
  else if (what === 'settings') wave.openSettings('generale');
});

// ───────── open / close ─────────

wave.on('overlay:open', (data) => {
  state.peers = data.peers;
  state.outgoing = data.outgoing;
  applySettings(data.settings);
  if (data.files && data.files.length) setPending(data.files);

  if (data.backdrop) {
    $('#backdrop').style.backgroundImage = `url("${data.backdrop}")`;
    body.classList.remove('no-backdrop');
  } else if (!body.classList.contains('open')) {
    $('#backdrop').style.backgroundImage = '';
    body.classList.add('no-backdrop');
  }
  render();
  requestAnimationFrame(() => body.classList.add('open'));
});

function close() {
  if (!body.classList.contains('open')) return;
  // Never hide while a code is being typed: the transfer waits on it.
  if (!$('#pair-sheet').hidden) return;
  body.classList.remove('open');
  closeMenu();
  $('#phone-sheet').hidden = true;
  $('#me-name').blur();
  setTimeout(() => {
    if (body.classList.contains('open')) return; // reopened meanwhile
    setPending([]);
    wave.hideOverlay();
  }, 260);
}

wave.on('overlay:close', close);
$('#close').addEventListener('click', close);
$('#pending-clear').addEventListener('click', () => setPending([]));
document.addEventListener('mousedown', (e) => {
  if (!$('#panel').contains(e.target)) close();
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('#vis-menu').hidden) return closeMenu();
  if (!$('#phone-sheet').hidden) return ($('#phone-sheet').hidden = true);
  if (!$('#pair-sheet').hidden) return cancelPairing();
  if (document.activeElement === $('#me-name')) {
    $('#me-name').value = state.settings.name;
    return $('#me-name').blur();
  }
  close();
});

// ───────── live updates ─────────

wave.on('peers', (peers) => {
  state.peers = peers;
  render();
  renderAirDrop();
});
wave.on('outgoing', (outgoing) => {
  state.outgoing = outgoing;
  render();
});
wave.on('settings', applySettings);

// ───────── first-contact code ─────────

let pairingFor = null; // transfer id the sheet is showing
let lastPairError = null;

function renderPairSheet() {
  const t = state.outgoing.find((x) => x.status === 'pairing');
  const sheet = $('#pair-sheet');
  if (!t) {
    sheet.hidden = true;
    pairingFor = null;
    return;
  }
  const input = $('#pair-code');
  if (pairingFor !== t.id) {
    pairingFor = t.id;
    lastPairError = null;
    $('#pair-title').textContent = `Abbina con ${t.peerName}`;
    $('#pair-text').textContent =
      `È la prima volta che invii a ${t.peerName}. Per essere sicuro che sia proprio lui, scrivi il codice a 6 cifre comparso sul suo schermo.`;
    $('#pair-error').hidden = true;
    input.value = '';
    $('#pair-ok').disabled = true;
    sheet.hidden = false;
    setTimeout(() => input.focus(), 50);
  }
  const err = t.pairError ? t.pairError.left : null;
  if (err !== lastPairError) {
    lastPairError = err;
    if (err != null) {
      $('#pair-error').textContent = `Codice errato. ${err === 1 ? 'Ultimo tentativo' : `Tentativi rimasti: ${err}`}.`;
      $('#pair-error').hidden = false;
      input.value = '';
      input.disabled = false;
      $('#pair-ok').disabled = true;
      input.classList.remove('shake');
      void input.offsetWidth;
      input.classList.add('shake');
      input.focus();
    }
  }
}

function submitCode() {
  const code = $('#pair-code').value.replace(/\D/g, '');
  if (code.length !== 6 || !pairingFor) return;
  $('#pair-ok').disabled = true;
  $('#pair-code').disabled = true;
  wave.pairCode(pairingFor, code).finally(() => ($('#pair-code').disabled = false));
}

function cancelPairing() {
  if (pairingFor) wave.cancel(pairingFor);
  $('#pair-sheet').hidden = true;
}

$('#pair-code').addEventListener('input', (e) => {
  e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
  $('#pair-ok').disabled = e.target.value.length !== 6;
  if (e.target.value.length === 6) submitCode();
});
$('#pair-code').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submitCode();
});
$('#pair-ok').addEventListener('click', submitCode);
$('#pair-cancel').addEventListener('click', cancelPairing);

// ───────── phone QR ─────────

async function showPhoneSheet() {
  const link = await wave.phoneLink();
  $('#qr').src = link.qr;
  $('.qr-box').classList.remove('done');
  $('#phone-title').textContent = 'Collega il tuo telefono';
  $('#phone-url').textContent = link.url.replace(/#.*$/, '');
  $('#phone-sheet').hidden = false;
}

$('#link-phone').addEventListener('click', showPhoneSheet);
$('#phone-new').addEventListener('click', showPhoneSheet);
$('#phone-done').addEventListener('click', () => ($('#phone-sheet').hidden = true));
wave.on('phone:paired', ({ name }) => {
  if ($('#phone-sheet').hidden) return;
  $('#phone-title').textContent = `${name} è collegato ✓`;
  $('.qr-box').classList.add('done');
  setTimeout(() => ($('#phone-sheet').hidden = true), 1800);
});

// ───────── controls ─────────

function closeMenu() {
  $('#vis-menu').hidden = true;
}
$('#visibility').addEventListener('click', (e) => {
  e.stopPropagation();
  $('#vis-menu').hidden = !$('#vis-menu').hidden;
});
$('#vis-menu').addEventListener('click', (e) => {
  const button = e.target.closest('button[data-v]');
  if (!button) return;
  wave.setSettings({ visibility: button.dataset.v });
  closeMenu();
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('.discover')) closeMenu();
});

const nameInput = $('#me-name');
nameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') nameInput.blur();
});
nameInput.addEventListener('input', () => {
  if (!state.settings.self || !state.settings.self.avatarUrl) $('#me-ava').textContent = initials(nameInput.value || state.settings.name);
});
nameInput.addEventListener('blur', () => {
  const name = nameInput.value.trim();
  if (name && name !== state.settings.name) wave.setSettings({ name });
  else nameInput.value = state.settings.name;
});

$('#me-ava').addEventListener('click', (e) => {
  e.preventDefault();
  wave.openSettings('profilo');
});
$('#open-settings').addEventListener('click', () => wave.openSettings('profilo'));
$('#open-folder').addEventListener('click', () => wave.openSaveDir());

wave.snapshot().then((s) => {
  state.peers = s.peers;
  state.outgoing = s.outgoing;
  applySettings(s.settings);
  render();
});
