'use strict';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

Object.assign(ICONS, {
  person: '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/></svg>',
  download: '<svg viewBox="0 0 24 24"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>',
  people: '<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c1-3.5 3.6-5.5 6.5-5.5s5.5 2 6.5 5.5"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.8c1.8.8 3 2.6 3.6 5.2"/></svg>',
  info: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.01"/></svg>',
  clock: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
});
for (const el of $$('[data-icon]')) el.innerHTML = ICONS[el.dataset.icon];

const model = { settings: {}, contacts: [], history: [], peers: [] };
const rtf = new Intl.RelativeTimeFormat('it', { numeric: 'auto' });
const dtf = new Intl.DateTimeFormat('it-IT', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

function ago(ts) {
  if (!ts) return 'mai';
  const s = Math.round((ts - Date.now()) / 1000);
  if (Math.abs(s) < 60) return 'adesso';
  if (Math.abs(s) < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (Math.abs(s) < 86400) return rtf.format(Math.round(s / 3600), 'hour');
  return rtf.format(Math.round(s / 86400), 'day');
}

// ───────── navigation ─────────

function showSection(name) {
  if (!$(`section[data-section="${name}"]`)) name = 'profilo';
  for (const b of $$('#sidebar button')) b.classList.toggle('active', b.dataset.section === name);
  for (const s of $$('section')) s.classList.toggle('active', s.dataset.section === name);
  history.replaceState(null, '', `#${name}`);
  if (name === 'telefono') newQr();
}
for (const b of $$('#sidebar button')) b.addEventListener('click', () => showSection(b.dataset.section));
wave.on('settings:section', showSection);

// ───────── settings ─────────

const VIS_NOTE = {
  everyone: 'Tutti i dispositivi WaveDrop nelle vicinanze ti vedono. Chi non è ancora un contatto deve inserire il codice di abbinamento prima di inviarti qualcosa.',
  contacts: 'Ti vedono solo i dispositivi già abbinati. Gli annunci non contengono nome né chiave: gli estranei non possono riconoscerti.',
  off: 'Nessuno ti vede e non ricevi nulla. Puoi comunque inviare.',
};

function renderSettings(s) {
  model.settings = s;
  const self = s.self || {};
  paintAvatar($('#side-ava'), { name: s.name, avatarUrl: self.avatarUrl, color: s.color });
  paintAvatar($('#avatar'), { name: s.name, avatarUrl: self.avatarUrl, color: s.color });
  $('#side-name').textContent = s.name;
  if (document.activeElement !== $('#name')) $('#name').value = s.name;
  $('#avatar-remove').hidden = !self.avatarUrl;
  for (const [i, sw] of $$('.swatch').entries()) sw.classList.toggle('active', i === s.color);

  for (const b of $$('#visibility button')) b.classList.toggle('active', b.dataset.v === s.visibility);
  $('#visibility-note').textContent = VIS_NOTE[s.visibility] || '';
  $('#save-dir').textContent = s.saveDir;

  for (const input of $$('input.switch[data-key]')) input.checked = !!s[input.dataset.key];
  const hotkey = $('#hotkey');
  if (!hotkey.options.length) {
    for (const k of s.hotkeys) hotkey.append(h('option', { value: k }, k.replace('Control', 'Ctrl').replace(/\+/g, ' + ')));
  }
  for (const select of $$('select[data-key]')) select.value = s[select.dataset.key];
  $('#hotkey-warning').textContent = s.hotkeyOk || s.instance ? '' : 'Questa scorciatoia è già usata da un altro programma: scegline un\'altra.';
  $('#sendto-row').hidden = s.sendTo === null;

  const bleText = {
    on: 'Attivo',
    starting: 'Avvio…',
    off: 'Spento',
    unsupported: 'Non disponibile su questo PC',
    error: 'Errore',
  }[s.bluetoothState];
  $('#ble-state').textContent = [bleText, s.bluetoothDetail].filter(Boolean).join(' · ');
  $('input[data-key="bluetooth"]').disabled = s.bluetoothState === 'unsupported';

  renderAirDrop(s);

  $('#safety').textContent = self.safety || '';
  $('#address').textContent = s.address;
  $('#key-protection').textContent = s.platform === 'win32' ? 'Protetta da Windows (DPAPI)' : 'Protetta dal portachiavi di sistema';
}

// ───────── AirDrop bridge (Linux only) ─────────

let airdropTick = null;

function airdropAvailability(b) {
  const via = b.backendLabel ? ` (${b.backendLabel}${b.driver ? ` · driver ${b.driver}` : ''})` : '';
  switch (b.state) {
    case 'unknown':
      return 'Verifica in corso…';
    case 'missing':
      return 'Non disponibile: omdrop-owl non è installato. Vedi il README di WaveDrop.';
    case 'blocked':
    case 'error':
      return `Non disponibile${via}: ${b.detail}`;
    case 'starting':
    case 'stopping':
      return b.detail;
    default:
      return `Disponibile${via}`;
  }
}

function airdropWarning(b) {
  if (b.exclusive === true) {
    return `Attenzione: con questa scheda Wi-Fi omdrop-owl usa la modalità esclusiva, quindi il Wi-Fi si scollega finché il PC è visibile ad AirDrop. In quel tempo non hai Internet e non vedi i dispositivi WaveDrop in rete; il Wi-Fi si ricollega da solo quando la visibilità finisce.`;
  }
  if (b.exclusive === false) {
    return 'Con questa scheda Wi-Fi omdrop-owl usa la modalità condivisa: il Wi-Fi resta connesso, ma la rete deve essere sui canali 6, 44 o 149.';
  }
  return 'Attenzione: su molte schede Wi-Fi (per esempio le Intel) omdrop-owl usa la modalità esclusiva, che scollega il Wi-Fi finché il PC è visibile ad AirDrop.';
}

function renderAirDrop(s) {
  const b = s.airdropBridge;
  clearTimeout(airdropTick);
  $('#airdrop-block').hidden = !b;
  if (!b) return;
  $('#airdrop-state').textContent = airdropAvailability(b);
  $('input[data-key="airdrop"]').disabled = !s.airdrop && ['missing', 'unsupported', 'unknown'].includes(b.state);
  $('#airdrop-warning').textContent = airdropWarning(b);
  const row = $('#airdrop-visible-row');
  row.hidden = !s.airdrop || !['ready', 'visible', 'starting', 'stopping', 'error'].includes(b.state);
  const button = $('#airdrop-visible');
  const left = b.visibleUntil ? Math.max(0, Math.round((b.visibleUntil - Date.now()) / 1000)) : null;
  if (b.state === 'visible') {
    $('#airdrop-visible-hint').textContent =
      `Visibile${b.name ? ` come «${b.name}»` : ''}${left != null ? ` ancora per ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` : ''}`;
    button.textContent = 'Disattiva';
    button.disabled = false;
    if (left) airdropTick = setTimeout(() => renderAirDrop(model.settings), 1000);
  } else {
    $('#airdrop-visible-hint').textContent = ['starting', 'stopping'].includes(b.state) ? b.detail : 'Non visibile';
    button.textContent = 'Rendi visibile per 10 minuti';
    button.disabled = ['starting', 'stopping'].includes(b.state);
  }
}

$('#airdrop-visible').addEventListener('click', () => wave.airdropVisible(model.settings.airdropBridge?.state !== 'visible'));

const swatches = $('#swatches');
for (let i = 0; i < 8; i++) {
  const b = h('button', { class: 'swatch ava', 'data-color': String(i), title: 'Colore' });
  b.addEventListener('click', () => wave.setSettings({ color: i }));
  swatches.append(b);
}

for (const input of $$('input.switch[data-key]')) {
  input.addEventListener('change', () => wave.setSettings({ [input.dataset.key]: input.checked }));
}
for (const select of $$('select[data-key]')) {
  select.addEventListener('change', () => wave.setSettings({ [select.dataset.key]: select.value }));
}
for (const b of $$('#visibility button')) b.addEventListener('click', () => wave.setSettings({ visibility: b.dataset.v }));

$('#name').addEventListener('change', () => {
  const name = $('#name').value.trim();
  if (name) wave.setSettings({ name });
  else $('#name').value = model.settings.name;
});
$('#name').addEventListener('keydown', (e) => e.key === 'Enter' && $('#name').blur());
$('#avatar-choose').addEventListener('click', () => wave.chooseAvatar());
$('#avatar-remove').addEventListener('click', () => wave.removeAvatar());
$('#save-dir-choose').addEventListener('click', () => wave.chooseSaveDir());
$('#save-dir-open').addEventListener('click', () => wave.openSaveDir());

// ───────── contacts ─────────

function contactRow(c) {
  const ava = h('div', { class: 'ava' });
  paintAvatar(ava, c);
  const nick = h('input', { value: c.nickname || c.name, maxlength: '40', spellcheck: 'false', title: 'Rinomina' });
  nick.addEventListener('change', () => {
    const value = nick.value.trim();
    wave.updateContact(c.id, { nickname: value === c.name ? '' : value });
  });
  nick.addEventListener('keydown', (e) => e.key === 'Enter' && nick.blur());
  const trust = h('input', { type: 'checkbox', class: 'switch' });
  trust.checked = c.trusted;
  trust.addEventListener('change', () => wave.updateContact(c.id, { trusted: trust.checked }));
  const remove = h('button', { class: 'btn small danger' }, 'Rimuovi');
  remove.addEventListener('click', () => {
    if (confirm(`Dimenticare ${c.nickname || c.name}? Al prossimo invio servirà di nuovo il codice.`)) wave.removeContact(c.id);
  });
  return h(
    'div',
    { class: 'row contact' },
    ava,
    h(
      'div',
      { class: 'grow' },
      h('div', { class: 'title' }, h('span', { class: c.online ? 'dot on' : 'dot', title: c.online ? 'Nelle vicinanze' : 'Non raggiungibile' }), nick),
      h(
        'div',
        { class: 'sub' },
        `${PLATFORM_LABEL[c.platform] || 'Dispositivo'} · codice `,
        h('span', { class: 'code' }, c.safety),
        ` · visto ${ago(c.lastSeen)}`,
      ),
    ),
    h('label', { class: 'trust-label', title: 'Accetta i suoi file senza chiedere' }, 'Attendibile', trust),
    remove,
  );
}

function renderContacts(list) {
  model.contacts = list;
  const pcs = list.filter((c) => c.kind !== 'phone');
  const phones = list.filter((c) => c.kind === 'phone');
  $('#contacts').replaceChildren(...pcs.map(contactRow));
  $('#contacts-empty').hidden = pcs.length > 0;
  $('#phones').replaceChildren(...phones.map(contactRow));
  $('#phones-empty').hidden = phones.length > 0;
}

function renderNearby(peers) {
  model.peers = peers;
  const strangers = peers.filter((p) => !p.contact && p.transport === 'lan');
  $('#nearby').replaceChildren(
    ...strangers.map((p) => {
      const ava = h('div', { class: 'ava' });
      paintAvatar(ava, p);
      const pair = h('button', { class: 'btn small primary' }, 'Abbina…');
      pair.addEventListener('click', () => wave.pairPeer(p.id));
      return h(
        'div',
        { class: 'row contact' },
        ava,
        h('div', { class: 'grow' }, h('div', { class: 'title' }, p.name), h('div', { class: 'sub' }, PLATFORM_LABEL[p.platform] || 'Dispositivo')),
        pair,
      );
    }),
  );
  $('#nearby-empty').hidden = strangers.length > 0;
}

// ───────── phone ─────────

let qrTimer = null;
async function newQr() {
  const link = await wave.phoneLink();
  $('#qr').src = link.qr;
  $('.qr-box').classList.remove('done');
  $('#phone-title').textContent = 'Collega iPhone o Android';
  clearInterval(qrTimer);
  const tick = () => {
    const left = Math.max(0, Math.round((link.expires - Date.now()) / 1000));
    $('#qr-expiry').textContent = left ? `Valido ancora ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` : 'Scaduto: genera un nuovo codice';
  };
  tick();
  qrTimer = setInterval(tick, 1000);
}
$('#qr-new').addEventListener('click', newQr);
wave.on('phone:paired', ({ name }) => {
  $('.qr-box').classList.add('done');
  $('#phone-title').textContent = `${name} è collegato ✓`;
  clearInterval(qrTimer);
  $('#qr-expiry').textContent = '';
});

// ───────── history ─────────

const STATUS_LABEL = {
  done: 'completato',
  declined: 'rifiutato',
  cancelled: 'annullato',
  'cancelled-local': 'annullato',
  failed: 'non riuscito',
};

function renderHistory(items) {
  model.history = items;
  $('#history').replaceChildren(
    ...items.map((it) => {
      const ok = it.status === 'done';
      const dir = h('div', { class: `dir ${ok ? it.direction : 'fail'}` }, it.direction === 'in' ? '↓' : '↑');
      const what = it.summary.isText ? `testo «${(it.text || '').slice(0, 60)}»` : describePayload(it.summary);
      const title = it.direction === 'in' ? `Da ${it.peer}: ${what}` : `A ${it.peer}: ${what}`;
      const sub = [
        dtf.format(new Date(it.time)),
        it.size ? formatBytes(it.size) : null,
        it.via === 'airdrop' ? 'AirDrop' : null,
        STATUS_LABEL[it.status] || it.status,
      ]
        .filter(Boolean)
        .join(' · ');
      const show =
        it.direction === 'in' && ok && it.reveal ? h('button', { class: 'btn small', onclick: () => wave.showInFolder(it.reveal) }, 'Mostra') : null;
      return h('div', { class: 'row hist' }, dir, h('div', { class: 'grow' }, h('div', { class: 'title' }, title), h('div', { class: 'sub' }, sub)), show);
    }),
  );
  $('#history-empty').hidden = items.length > 0;
}
$('#history-clear').addEventListener('click', () => {
  if (confirm('Cancellare tutta la cronologia dei trasferimenti? I file ricevuti restano dove sono.')) wave.clearHistory();
});

$('#reset-identity').addEventListener('click', () => wave.resetIdentity());

// ───────── about ─────────

function renderAbout(about) {
  if (!about) return;
  $('#about-version').textContent = `Versione ${about.version} · Electron ${about.electron}`;
  $('#about-repo').hidden = !about.repo;
  if (about.repo) {
    $('#about-repo').dataset.url = about.repo;
    $('#about-repo-url').textContent = about.repo.replace(/^https:\/\//, '');
  }
}
for (const b of $$('button[data-url], #about-repo')) b.addEventListener('click', () => wave.openUrl(b.dataset.url));

// ───────── updates ─────────

const UPDATE_KIND = {
  installer: 'Il nuovo installer viene scaricato, verificato e installato; poi WaveDrop si riapre.',
  portable: 'La nuova versione portatile viene salvata accanto a questa e avviata.',
  appimage: "L'AppImage viene sostituita con la nuova e riavviata.",
  source: 'Stai usando i sorgenti: si apre la pagina della release.',
  other: 'Si apre la pagina della release da cui scaricarla.',
};

function renderUpdate(u) {
  $('#update-box').hidden = !u;
  if (!u) return;
  const busy = ['checking', 'downloading', 'installing'].includes(u.status);
  const title = {
    idle: `Versione ${u.version}`,
    checking: 'Controllo in corso…',
    latest: `WaveDrop ${u.version} è la versione più recente`,
    available: `È disponibile WaveDrop ${u.latest}`,
    downloading: `Download di WaveDrop ${u.latest}… ${Math.round(u.progress * 100)}%`,
    installing: `Installazione di WaveDrop ${u.latest}…`,
    error: 'Controllo non riuscito',
  }[u.status];
  $('#update-title').textContent = title || '';
  $('#update-detail').textContent =
    u.error || (u.status === 'available' ? `Hai la ${u.version}. ${UPDATE_KIND[u.kind] || ''}` : u.checkedAt ? `Ultimo controllo ${ago(u.checkedAt)}` : '');
  $('#update-check').hidden = u.status === 'available' || busy;
  $('#update-install').hidden = u.status !== 'available';
  $('#update-install').textContent = ['source', 'other'].includes(u.kind) ? 'Apri la release' : 'Scarica e installa';
  $('#update-progress-row').hidden = u.status !== 'downloading';
  $('#update-progress').style.width = `${Math.round(u.progress * 100)}%`;
  $('#update-notes-row').hidden = !(u.notes && ['available', 'downloading'].includes(u.status));
  $('#update-notes').textContent = u.notes || '';
}

$('#update-check').addEventListener('click', () => wave.checkUpdate());
$('#update-install').addEventListener('click', () => wave.installUpdate());
wave.on('update', renderUpdate);

// ───────── live data ─────────

wave.on('settings', renderSettings);
wave.on('contacts', renderContacts);
wave.on('history', renderHistory);
wave.on('peers', (peers) => {
  renderNearby(peers);
  // Online dots in the contact list follow the peer list.
  const online = new Set(peers.map((p) => p.id));
  renderContacts(model.contacts.map((c) => ({ ...c, online: online.has(c.id) })));
});

wave.getSettings().then((data) => {
  renderSettings(data.settings);
  renderContacts(data.contacts);
  renderHistory(data.history);
  renderNearby(data.peers);
  renderAbout(data.about);
  renderUpdate(data.update);
  showSection(location.hash.slice(1) || 'profilo');
});
