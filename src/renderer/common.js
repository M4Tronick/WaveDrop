'use strict';

const PLATFORM_LABEL = { win32: 'PC Windows', darwin: 'Mac', linux: 'Linux', ios: 'iPhone', android: 'Android', phone: 'Telefono' };
const VISIBILITY_LABEL = { everyone: 'Tutti', contacts: 'Solo contatti', off: 'Nessuno' };
const RING_LENGTH = 2 * Math.PI * 40;
const RESULT_VISIBLE_MS = 6000;

// Static, trusted markup only. Anything coming from a peer goes through textContent.
const ICONS = {
  monitor: '<svg viewBox="0 0 24 24"><rect x="3" y="4.5" width="18" height="12" rx="2"/><path d="M9 20h6M12 16.5V20"/></svg>',
  laptop: '<svg viewBox="0 0 24 24"><rect x="5" y="5.5" width="14" height="9.5" rx="1.5"/><path d="M2.5 18.5h19"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  close: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  chevron: '<svg viewBox="0 0 24 24"><path d="M7 10l5 5 5-5"/></svg>',
  folder: '<svg viewBox="0 0 24 24"><path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2h9A1.5 1.5 0 0 1 21 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/></svg>',
  doc: '<svg viewBox="0 0 24 24"><path d="M7 3h7l5 5v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M14 3v5h5"/></svg>',
  phone: '<svg viewBox="0 0 24 24"><rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/></svg>',
  gear: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  lock: '<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
  shield: '<svg viewBox="0 0 24 24"><path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6z"/><path d="M9 12l2 2 4-4"/></svg>',
  airdrop: '<svg viewBox="0 0 24 24"><path d="M5.6 17.4a9 9 0 1 1 12.8 0"/><path d="M8.5 14.5a5 5 0 1 1 7 0"/><path d="M12 12v9M9.5 18.5L12 21l2.5-2.5"/></svg>',
};

// Shows a profile photo when there is one, otherwise coloured initials.
function paintAvatar(el, { name, avatarUrl, color }) {
  el.dataset.color = String(color || 0);
  if (avatarUrl) {
    let img = el.querySelector('img');
    if (!img) {
      img = document.createElement('img');
      img.alt = '';
      el.replaceChildren(img);
    }
    if (img.src !== avatarUrl) img.src = avatarUrl;
  } else {
    el.textContent = initials(name);
  }
}

function deviceIcon(peer) {
  if (peer.kind === 'phone' || ['ios', 'android', 'phone'].includes(peer.platform)) return 'phone';
  return peer.platform === 'darwin' ? 'laptop' : 'monitor';
}

const numberFormat = new Intl.NumberFormat('it-IT', { maximumFractionDigits: 1 });

function formatBytes(n) {
  if (n < 1000) return `${n} byte`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do {
    n /= 1000;
    i++;
  } while (n >= 1000 && i < units.length - 1);
  return `${numberFormat.format(n)} ${units[i]}`;
}

function initials(name) {
  const words = String(name || '')
    .split(/\s+/)
    .map((w) => Array.from(w).find((ch) => /\p{L}/u.test(ch)))
    .filter(Boolean);
  const picked = words.length > 1 ? [words[0], words[words.length - 1]] : words;
  return picked.join('').toUpperCase() || '?';
}

function basename(p) {
  return String(p).split(/[\\/]/).filter(Boolean).pop() || p;
}

// «foto.jpg», la cartella «Foto», 3 elementi
function describePayload({ items, label, isFolder, isText }) {
  if (isText) return 'un testo';
  if (items === 1 && label) return isFolder ? `la cartella «${label}»` : `«${label}»`;
  return `${items} elementi`;
}

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'svg') el.innerHTML = ICONS[v];
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

function latestByPeer(outgoing) {
  const map = new Map();
  for (const t of outgoing) map.set(t.peerId, t); // insertion order = chronological
  return map;
}

function tileState(t, now = Date.now()) {
  if (!t) return null;
  if (t.status === 'pairing') return { cls: 'is-waiting', text: 'Abbinamento…', tone: 'accent' };
  if (t.status === 'preparing' || t.status === 'waiting') return { cls: 'is-waiting', text: 'In attesa…', tone: 'accent' };
  if (t.status === 'sending') {
    return { cls: 'is-sending', text: `Invio… ${Math.floor(t.progress * 100)}%`, tone: 'accent', progress: t.progress };
  }
  if (!t.endedAt || now - t.endedAt > RESULT_VISIBLE_MS) return null;
  switch (t.status) {
    case 'done':
      return { cls: 'is-done', text: t.pairOnly ? 'Abbinato' : 'Inviato', tone: 'ok' };
    case 'declined':
      return {
        text: t.reason === 'off' ? 'Ricezione disattivata' : t.reason === 'timeout' ? 'Nessuna risposta' : 'Rifiutato',
        tone: 'bad',
      };
    case 'cancelled':
      return { text: 'Annullato', tone: 'muted' };
    default:
      return { text: FAILURE_LABEL[t.reason] || 'Non riuscito', tone: 'bad' };
  }
}

const FAILURE_LABEL = {
  PAIR_BAD_CODE: 'Codice errato',
  PAIR_FAILED: 'Abbinamento fallito',
  PAIR_MISMATCH: 'Dispositivo diverso',
  AUTH: 'Verifica fallita',
  PHONE_OFFLINE: 'Telefono non aperto',
  TIMEOUT: 'Nessuna risposta',
  AIRDROP_FOLDER: 'Cartelle non supportate',
  AIRDROP_EVERYONE: 'Serve «Tutti»',
  AIRDROP_UNREACHABLE: 'Non raggiungibile',
  AIRDROP_NOT_FOUND: 'Non più visibile',
  AIRDROP_OFF: 'AirDrop spento',
  AIRDROP_FAILED: 'Non riuscito',
};

// Longer explanations for the toast, where there is room.
const AIRDROP_HINT = {
  AIRDROP_FOLDER: 'AirDrop non accetta cartelle da qui: comprimile in un file .zip.',
  AIRDROP_EVERYONE: 'Sul dispositivo Apple imposta AirDrop su «Tutti per 10 minuti».',
  AIRDROP_UNREACHABLE: 'Non accetta file adesso: su iPhone apri un foglio di condivisione e riprova.',
  AIRDROP_NOT_FOUND: 'Il dispositivo non si vede più: apri AirDrop su di esso e riprova.',
  AIRDROP_OFF: 'La radio AirDrop di questo PC è spenta.',
};

const PeerTiles = {
  STATE_CLASSES: ['is-waiting', 'is-sending', 'is-done'],

  create(peer, handlers) {
    const el = h(
      'div',
      { class: 'peer', 'data-id': peer.id, role: 'button', tabindex: '0' },
      h(
        'div',
        { class: 'ava-wrap' },
        h('div', { class: 'ava' }),
        h('div', { class: 'badge', svg: peer.transport === 'airdrop' ? 'airdrop' : deviceIcon(peer) }),
        h('div', { class: 'check', svg: 'check' }),
      ),
      h('div', { class: 'name' }),
      h('div', { class: 'sub' }),
    );
    el.querySelector('.ava-wrap').insertAdjacentHTML(
      'afterbegin',
      '<svg class="ring" viewBox="0 0 84 84"><circle class="track" cx="42" cy="42" r="40"/><circle class="bar" cx="42" cy="42" r="40"/></svg>',
    );

    el.addEventListener('click', () => handlers.activate(el.dataset.id));
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      wave.peerMenu(el.dataset.id);
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') handlers.activate(el.dataset.id);
    });
    let depth = 0;
    el.addEventListener('dragenter', (e) => {
      e.preventDefault();
      depth++;
      el.classList.add('drop-target');
    });
    el.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    el.addEventListener('dragleave', () => {
      if (--depth <= 0) {
        depth = 0;
        el.classList.remove('drop-target');
      }
    });
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      depth = 0;
      el.classList.remove('drop-target');
      const paths = Array.from(e.dataTransfer.files, (f) => wave.pathFor(f)).filter(Boolean);
      if (paths.length) handlers.drop(el.dataset.id, paths);
    });
    return el;
  },

  update(el, peer, transfer) {
    const state = tileState(transfer);
    paintAvatar(el.querySelector('.ava'), peer);
    el.querySelector('.name').textContent = peer.name;
    const apple = peer.transport === 'airdrop';
    el.classList.toggle('is-contact', !!peer.contact);
    el.classList.toggle('is-airdrop', apple);
    el.title = apple
      ? `${peer.name} · dispositivo Apple via AirDrop
Il proprietario deve accettare sul suo dispositivo. Clic destro per altre opzioni`
      : peer.contact
        ? `${peer.name} · verificato${peer.trusted ? ' e attendibile' : ''}
Clic destro per altre opzioni`
        : `${peer.name} · non ancora abbinato: al primo invio ti verrà chiesto un codice
Clic destro per altre opzioni`;
    const sub = el.querySelector('.sub');
    sub.textContent = state
      ? state.text
      : apple
        ? 'AirDrop'
        : peer.contact
          ? PLATFORM_LABEL[peer.platform] || 'Dispositivo'
          : 'Nuovo dispositivo';
    sub.dataset.tone = state ? state.tone : '';
    el.classList.remove(...this.STATE_CLASSES);
    if (state && state.cls) el.classList.add(state.cls);
    el.querySelector('.ring .bar').style.strokeDashoffset =
      state && state.cls === 'is-sending' ? String(RING_LENGTH * (1 - state.progress)) : '';
  },

  // Keyed render so tiles keep their DOM (and running animations) across updates.
  render(container, peers, outgoing, handlers) {
    const byPeer = latestByPeer(outgoing);
    const seen = new Set();
    for (const peer of peers) {
      seen.add(peer.id);
      let el = container.querySelector(`.peer[data-id="${CSS.escape(peer.id)}"]`);
      if (el && el.classList.contains('leaving')) {
        el.remove();
        el = null;
      }
      if (!el) {
        el = this.create(peer, handlers);
        container.append(el);
      }
      this.update(el, peer, byPeer.get(peer.id));
    }
    for (const el of container.querySelectorAll('.peer:not(.leaving)')) {
      if (!seen.has(el.dataset.id)) {
        el.classList.add('leaving');
        setTimeout(() => el.classList.contains('leaving') && el.remove(), 260);
      }
    }
    // Finished results fade back to the device label after a few seconds.
    const now = Date.now();
    const next = Math.min(
      ...outgoing.filter((t) => t.endedAt && now - t.endedAt <= RESULT_VISIBLE_MS).map((t) => t.endedAt + RESULT_VISIBLE_MS - now + 50),
    );
    clearTimeout(container._refresh);
    if (Number.isFinite(next)) container._refresh = setTimeout(() => this.render(container, peers, outgoing, handlers), next);
  },
};

// Never let a stray file drop navigate the window away.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());
