'use strict';

// WaveDrop phone web app (iPhone / Android). Served by the PC it is paired
// with; all file contents are sealed end to end with the shared protocol.

const P = require('../shared/protocol.js');

const STORE_KEY = 'wavedrop.phone.v2';
const app = document.getElementById('app');

const PLATFORM = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  ? 'ios'
  : /Android/i.test(navigator.userAgent)
    ? 'android'
    : 'phone';
const DEFAULT_NAME = PLATFORM === 'ios' ? 'iPhone' : PLATFORM === 'android' ? 'Telefono Android' : 'Telefono';
const PLATFORM_LABEL = { win32: 'PC Windows', darwin: 'Mac', linux: 'Linux' };

const ICONS = {
  photo: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2.5"/><circle cx="9" cy="10" r="1.6"/><path d="M21 16l-5-5-8 8"/></svg>',
  text: '<svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h10"/></svg>',
  doc: '<svg viewBox="0 0 24 24"><path d="M7 3h7l5 5v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M14 3v5h5"/></svg>',
};

// ───────────── helpers ─────────────

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'icon') el.innerHTML = ICONS[v];
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

const nf = new Intl.NumberFormat('it-IT', { maximumFractionDigits: 1 });
function formatBytes(n) {
  if (n < 1000) return `${n} byte`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do {
    n /= 1000;
    i++;
  } while (n >= 1000 && i < units.length - 1);
  return `${nf.format(n)} ${units[i]}`;
}

function initials(name) {
  const w = String(name || '').split(/\s+/).map((x) => Array.from(x).find((c) => /\p{L}/u.test(c))).filter(Boolean);
  return (w.length > 1 ? [w[0], w[w.length - 1]] : w).join('').toUpperCase() || '?';
}

const basename = (p) => String(p).split('/').pop();

function describe(files, text) {
  if (!files.length && text) return 'un testo';
  const tops = [...new Set(files.map((f) => f.name.split('/')[0]))];
  if (tops.length === 1) return files.some((f) => f.name.includes('/')) ? `la cartella «${tops[0]}»` : `«${tops[0]}»`;
  return `${tops.length} elementi`;
}

const MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic',
  mp4: 'video/mp4', mov: 'video/quicktime', mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav',
  pdf: 'application/pdf', txt: 'text/plain', zip: 'application/zip',
};
const mimeOf = (name) => MIME[name.split('.').pop().toLowerCase()] || 'application/octet-stream';

function fromB64url(s) {
  return P.unb64(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
}

const isUrl = (s) => /^https?:\/\/\S+$/i.test(s.trim());

// ───────────── state ─────────────

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY));
    if (s && s.sk && s.desktop) return { ...s, sk: P.unb64(s.sk), pk: P.unb64(s.pk) };
  } catch {}
  return null;
}

function save() {
  localStorage.setItem(STORE_KEY, JSON.stringify({ ...state, sk: P.b64(state.sk), pk: P.b64(state.pk) }));
}

let state = load();
let online = false;
let events = null;
let reconnectTimer = null;
let offlineSince = Date.now();
const offers = new Set();

// ───────────── pairing ─────────────

async function pair(params, name) {
  const secret = fromB64url(params.get('k'));
  const pkD = fromB64url(params.get('p'));
  const kp = P.newKeyPair();
  const res = await fetch('/m/pair', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      pk: P.b64(kp.pk),
      name,
      platform: PLATFORM,
      proof: P.qrProof(secret, 'wd-mobile-pair', kp.pk, pkD),
    }),
  });
  if (res.status === 410) throw new Error('Il codice QR è scaduto o è già stato usato. Generane uno nuovo sul PC.');
  if (!res.ok) throw new Error('Collegamento non riuscito. Riprova inquadrando un nuovo codice QR.');
  const body = await res.json();
  const ok =
    body.pk === P.b64(pkD) && P.sameBytes(P.unb64(body.proof), P.unb64(P.qrProof(secret, 'wd-mobile-ok', pkD, kp.pk)));
  if (!ok) throw new Error('Il PC non ha superato la verifica. Collegamento annullato.');
  state = {
    sk: kp.sk,
    pk: kp.pk,
    id: P.deviceId(kp.pk),
    name,
    desktop: { id: body.id, pk: body.pk, name: body.name, platform: body.platform },
  };
  save();
}

// ───────────── live connection ─────────────

function connect() {
  clearTimeout(reconnectTimer);
  events?.close();
  const t = Date.now();
  const link = P.pairKey(state.sk, state.pk, P.unb64(state.desktop.pk), 'link');
  const sig = P.b64(P.mac(link, P.lv('wd-events', String(t))));
  events = new EventSource(`/m/events?id=${state.id}&t=${t}&sig=${encodeURIComponent(sig)}`);
  events.addEventListener('hello', (e) => {
    const d = JSON.parse(e.data);
    if (d.name && d.name !== state.desktop.name) {
      state.desktop.name = d.name;
      save();
    }
    setOnline(true);
  });
  events.addEventListener('offer', (e) => onOffer(JSON.parse(e.data)));
  events.addEventListener('cancel', (e) => offerCards.get(JSON.parse(e.data).offer)?.remoteCancel());
  events.onerror = () => {
    events.close();
    setOnline(false);
    reconnectTimer = setTimeout(connect, 3000);
  };
}

function setOnline(value) {
  if (value) offlineSince = 0;
  else if (!offlineSince) offlineSince = Date.now();
  online = value;
  renderStatus();
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state && !online) connect();
});

// ───────────── UI: screens ─────────────

function screenNoLink() {
  app.replaceChildren(
    h(
      'div',
      { class: 'hero' },
      h('img', { src: 'icon.png', alt: '' }),
      h('h1', {}, 'Collega questo telefono'),
      h('p', {}, 'Sul PC apri WaveDrop, scegli «Collega telefono» e inquadra il codice QR con la fotocamera.'),
    ),
  );
}

function screenPair(params) {
  const input = h('input', { class: 'field', value: DEFAULT_NAME, maxlength: '40', autocomplete: 'off' });
  const error = h('div', { class: 'error', hidden: true });
  const button = h('button', { class: 'btn primary wide' }, 'Collega');
  button.addEventListener('click', async () => {
    button.disabled = true;
    error.hidden = true;
    try {
      await pair(params, input.value.trim() || DEFAULT_NAME);
      history.replaceState(null, '', location.pathname); // drop the one-time secret
      screenMain();
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
      button.disabled = false;
    }
  });
  // With the native app installed, hand the same one-time link to it instead.
  const link = location.href;
  const appHref =
    PLATFORM === 'android'
      ? `intent://pair?u=${encodeURIComponent(link)}#Intent;scheme=wavedrop;package=app.wavedrop.android;end`
      : `wavedrop://pair?u=${encodeURIComponent(link)}`;
  const openApp =
    PLATFORM === 'phone'
      ? null
      : h(
          'p',
          { class: 'footnote' },
          'Hai installato l\'app WaveDrop? ',
          h('a', { class: 'link', href: appHref }, 'Apri il collegamento nell\'app'),
        );
  app.replaceChildren(
    h(
      'div',
      { class: 'hero' },
      h('img', { src: 'icon.png', alt: '' }),
      h('h1', {}, 'Collega questo telefono'),
      h('p', {}, 'Il telefono e il PC si scambiano le chiavi di cifratura. Come vuoi chiamare questo telefono?'),
      input,
      button,
      error,
      openApp,
    ),
  );
}

let statusEl;
let actionsEl;
let listEl;

function screenMain() {
  const pcName = h('div', { class: 'name' });
  statusEl = h('div', { class: 'status' }, h('span', { class: 'dot' }), h('span', { class: 'label' }));
  const picker = h('input', { type: 'file', multiple: true, hidden: true });
  picker.addEventListener('change', () => {
    if (picker.files.length) sendToPc([...picker.files], null);
    picker.value = '';
  });
  actionsEl = h(
    'div',
    { class: 'actions' },
    h('button', { class: 'action', onclick: () => picker.click() }, h('span', { class: 'icon', icon: 'photo' }), 'Invia foto e file'),
    h('button', { class: 'action', onclick: openTextSheet }, h('span', { class: 'icon', icon: 'text' }), 'Invia testo o link'),
  );
  listEl = h('div', {});

  const nameInput = h('input', { value: state.name, maxlength: '40' });
  nameInput.addEventListener('change', () => {
    state.name = nameInput.value.trim() || DEFAULT_NAME;
    nameInput.value = state.name;
    save();
  });

  const tip =
    PLATFORM === 'ios'
      ? 'Per averlo come app: tocca Condividi, poi «Aggiungi alla schermata Home». Le immagini ricevute si salvano in Foto tenendole premute.'
      : 'Per averlo come app: menu ⋮ del browser, poi «Aggiungi a schermata Home».';

  app.replaceChildren(
    h('div', { class: 'large-title' }, h('img', { src: 'icon.png', alt: '' }), 'WaveDrop'),
    h('div', { class: 'card pc' }, h('div', { class: 'ava' }, initials(state.desktop.name)), h('div', {}, pcName, statusEl)),
    actionsEl,
    picker,
    listEl,
    h('div', { class: 'section-title' }, 'Questo telefono'),
    h(
      'div',
      { class: 'card' },
      h('label', { class: 'row' }, h('span', { class: 'grow' }, 'Nome'), nameInput),
      h('div', { class: 'row' }, h('span', { class: 'grow' }, 'Codice di sicurezza'), h('span', { class: 'value' }, P.safetyCode(state.pk))),
      h('div', { class: 'row' }, h('span', { class: 'grow' }, 'Codice del PC'), h('span', { class: 'value' }, P.safetyCode(P.unb64(state.desktop.pk)))),
    ),
    h('p', { class: 'footnote' }, 'I file viaggiano cifrati end-to-end (X25519 + ChaCha20-Poly1305): solo questo telefono e il PC possono leggerli. I codici di sicurezza devono coincidere con quelli mostrati nelle impostazioni di WaveDrop sul PC.'),
    h('p', { class: 'footnote' }, tip),
    h('div', { class: 'btns' }, h('button', { class: 'btn danger wide', onclick: unlink }, 'Scollega dal PC')),
  );
  pcName.textContent = state.desktop.name;
  renderStatus();
  connect();
}

function renderStatus() {
  if (!statusEl) return;
  statusEl.classList.toggle('online', online);
  const stale = !online && offlineSince && Date.now() - offlineSince > 20000;
  statusEl.querySelector('.label').textContent = online
    ? `Connesso · ${PLATFORM_LABEL[state.desktop.platform] || 'PC'}`
    : stale
      ? 'PC non raggiungibile: WaveDrop è aperto e sulla stessa rete?'
      : 'Connessione in corso…';
  for (const b of actionsEl.querySelectorAll('button')) b.disabled = !online;
}
setInterval(renderStatus, 5000);

function unlink() {
  if (!confirm('Scollegare questo telefono dal PC? Per ricollegarlo servirà un nuovo codice QR.')) return;
  events?.close();
  localStorage.removeItem(STORE_KEY);
  state = null;
  screenNoLink();
}

function openTextSheet() {
  const area = h('textarea', { placeholder: 'Scrivi un testo o incolla un link' });
  const bg = h('div', { class: 'sheet-bg' });
  const close = () => bg.remove();
  bg.addEventListener('click', (e) => e.target === bg && close());
  bg.append(
    h(
      'div',
      { class: 'sheet' },
      h('h2', {}, `Invia a ${state.desktop.name}`),
      area,
      h(
        'div',
        { class: 'btns' },
        h('button', { class: 'btn', onclick: close }, 'Annulla'),
        h(
          'button',
          {
            class: 'btn primary',
            onclick: () => {
              if (!area.value.trim()) return;
              sendToPc([], area.value);
              close();
            },
          },
          'Invia',
        ),
      ),
    ),
  );
  document.body.append(bg);
  area.focus();
}

// ───────────── transfer cards ─────────────

function transferCard() {
  const thumb = h('div', { class: 'thumb', icon: 'doc' });
  const headline = h('div', { class: 'headline' });
  const meta = h('div', { class: 'meta' });
  const bar = h('div', { class: 'bar', hidden: true }, h('i'));
  const extra = h('div', {});
  const buttons = h('div', { class: 'btns', hidden: true });
  const el = h('div', { class: 'card transfer' }, h('div', { class: 'top' }, thumb, h('div', { class: 'grow' }, headline, meta)), bar, extra, buttons);
  listEl.prepend(el);
  return {
    el,
    thumb(src) {
      const img = h('img', { class: 'thumb', src, alt: '' });
      thumb.replaceWith(img);
    },
    headline(...nodes) {
      headline.replaceChildren(...nodes);
    },
    meta(text, tone = '') {
      meta.textContent = text;
      meta.className = `meta ${tone}`;
    },
    progress(p) {
      bar.hidden = p == null;
      if (p != null) bar.firstChild.style.width = `${Math.round(p * 100)}%`;
    },
    buttons(list) {
      buttons.hidden = !list.length;
      buttons.replaceChildren(...list.map(([label, fn, kind]) => h('button', { class: `btn ${kind || ''}`, onclick: fn }, label)));
    },
    extra(...nodes) {
      extra.replaceChildren(...nodes);
    },
  };
}

async function thumbnailFor(file) {
  if (!file || !file.type.startsWith('image/') || !window.createImageBitmap) return null;
  const bmp = await createImageBitmap(file);
  const scale = 160 / Math.max(bmp.width, bmp.height);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bmp.width * scale));
  canvas.height = Math.max(1, Math.round(bmp.height * scale));
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.75);
}

// Phone → PC: the regular /Ask + /Chunk protocol.
async function sendToPc(files, text) {
  const card = transferCard();
  const abort = new AbortController();
  const list = files.map((file) => ({ file, name: file.name, size: file.size }));
  const what = describe(list, text);
  const total = list.reduce((n, f) => n + f.size, 0);
  card.headline('Invio di ', what, ' a ', h('b', {}, state.desktop.name));
  card.meta('Preparazione…');
  card.buttons([['Annulla', () => abort.abort()]]);
  try {
    const thumbnail = await thumbnailFor(files[0]).catch(() => null);
    if (thumbnail) card.thumb(thumbnail);
    const sealed = P.askSeal({
      sk: state.sk,
      pk: state.pk,
      peerPk: P.unb64(state.desktop.pk),
      request: { name: state.name, platform: PLATFORM, files: list.map(({ name, size }) => ({ name, size })), text, thumbnail },
    });
    card.meta('In attesa di conferma sul PC…');
    card.progress(0);
    const res = await fetch('/Ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: state.id, ...sealed.msg }),
      signal: abort.signal,
    });
    if (res.status === 401) throw new Error('Il PC non riconosce più questo telefono: ricollegalo con un nuovo QR.');
    if (res.status !== 200) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.reason === 'off' ? 'Il PC non sta ricevendo file.' : body.reason === 'timeout' ? 'Nessuna risposta dal PC.' : 'Il PC ha rifiutato.');
    }
    const { key, answer } = P.answerOpen({ k1: sealed.k1, sk: state.sk, e: sealed.e, msg: await res.json() });
    let sent = 0;
    for (let f = 0; f < list.length; f++) {
      const count = P.chunkCount(list[f].size);
      for (let c = 0; c < count; c++) {
        const last = c === count - 1;
        const slice = list[f].file.slice(c * P.CHUNK_SIZE, Math.min(list[f].size, (c + 1) * P.CHUNK_SIZE));
        const data = new Uint8Array(await slice.arrayBuffer());
        const body = P.sealChunk(key, answer.session, f, c, last, data);
        const r = await fetch(`/Chunk?s=${encodeURIComponent(answer.session)}&f=${f}&c=${c}&last=${last ? 1 : 0}`, {
          method: 'POST',
          headers: { 'content-type': 'application/octet-stream' },
          body,
          signal: abort.signal,
        });
        if (r.status === 410) throw new Error('Annullato sul PC.');
        if (!r.ok) throw new Error(`Invio interrotto (errore ${r.status}).`);
        sent += data.length;
        card.progress(total ? sent / total : 1);
        card.meta(`${Math.floor((total ? sent / total : 1) * 100)}% · ${formatBytes(sent)} di ${formatBytes(total)}`);
      }
    }
    card.progress(null);
    card.meta(text && !list.length ? 'Testo inviato' : `Inviato · ${formatBytes(total)}`, 'ok');
  } catch (err) {
    card.progress(null);
    card.meta(abort.signal.aborted ? 'Invio annullato' : err.message, abort.signal.aborted ? '' : 'bad');
  }
  card.buttons([]);
}

// PC → phone: offers pushed over the event stream; chunks pulled over HTTP.
const offerCards = new Map();

function onOffer(ev) {
  if (offers.has(ev.offer)) return;
  let opened;
  try {
    opened = P.askOpen({ sk: state.sk, pk: state.pk, peerPk: P.unb64(state.desktop.pk), msg: ev });
  } catch {
    return; // not sealed for us by our PC
  }
  offers.add(ev.offer);
  const req = opened.request;
  const files = Array.isArray(req.files) ? req.files : [];
  const text = typeof req.text === 'string' ? req.text : null;
  const total = files.reduce((n, f) => n + f.size, 0);
  const card = transferCard();
  const pdName = h('b', {}, req.name || state.desktop.name);
  if (req.thumbnail) card.thumb(req.thumbnail);
  card.headline(pdName, ` vuole inviarti ${describe(files, text)}.`);
  card.meta(files.length ? formatBytes(total) : 'Testo');
  if (navigator.vibrate) navigator.vibrate(60);

  let abort = null;
  let key = null;
  const answer = async (accepted) => {
    const sealed = P.answerSeal({ k1: opened.k1, eA: opened.eA, peerPk: P.unb64(state.desktop.pk), answer: { accepted } });
    const r = await fetch('/m/answer', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ offer: ev.offer, ...sealed.msg }),
    });
    if (!r.ok) throw new Error('L\'offerta non è più valida.');
    return sealed.key;
  };

  const controls = {
    remoteCancel() {
      abort?.abort();
      card.progress(null);
      card.buttons([]);
      card.meta('Annullato dal PC');
    },
  };
  offerCards.set(ev.offer, controls);

  card.buttons([
    [
      'Rifiuta',
      async () => {
        card.buttons([]);
        card.meta('Rifiutato');
        await answer(false).catch(() => {});
      },
    ],
    [
      'Accetta',
      async () => {
        card.buttons([]);
        try {
          key = await answer(true);
          if (!files.length) {
            showText(card, text);
            card.meta('Ricevuto', 'ok');
            return;
          }
          abort = new AbortController();
          card.buttons([['Annulla', () => cancelDownload(ev.offer, key, abort)]]);
          await download(ev.offer, key, files, total, card, abort);
        } catch (err) {
          card.progress(null);
          card.buttons([]);
          card.meta(abort?.signal.aborted ? 'Annullato' : err.message, abort?.signal.aborted ? '' : 'bad');
        }
      },
      'primary',
    ],
  ]);
}

function showText(card, text) {
  const box = h('div', { class: 'textbox' }, text);
  const copy = () => {
    const area = h('textarea', {}, text);
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    document.execCommand('copy'); // navigator.clipboard needs HTTPS
    area.remove();
    card.meta('Copiato negli appunti', 'ok');
  };
  const buttons = [['Copia', copy]];
  if (isUrl(text)) buttons.push(['Apri link', () => window.open(text.trim(), '_blank', 'noopener'), 'primary']);
  card.extra(box);
  card.buttons(buttons);
}

async function cancelDownload(offer, key, abort) {
  abort.abort();
  await fetch('/m/cancel', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ offer, mac: P.b64(P.mac(key, P.lv('wd-cancel', offer))) }),
  }).catch(() => {});
}

async function download(offer, key, files, total, card, abort) {
  let got = 0;
  const results = [];
  card.progress(0);
  for (let f = 0; f < files.length; f++) {
    const count = P.chunkCount(files[f].size);
    const parts = [];
    for (let c = 0; c < count; c++) {
      const last = c === count - 1;
      const r = await fetch(`/m/chunk?o=${encodeURIComponent(offer)}&f=${f}&c=${c}`, { signal: abort.signal, cache: 'no-store' });
      if (r.status === 410) throw new Error('Annullato dal PC.');
      if (!r.ok) throw new Error(`Download interrotto (errore ${r.status}).`);
      const plain = P.openChunk(key, offer, f, c, last, new Uint8Array(await r.arrayBuffer()));
      parts.push(plain);
      got += plain.length;
      card.progress(total ? got / total : 1);
      card.meta(`${Math.floor((total ? got / total : 1) * 100)}% · ${formatBytes(got)} di ${formatBytes(total)}`);
    }
    const name = files[f].name;
    const blob = new Blob(parts, { type: mimeOf(name) });
    results.push({ name, blob, url: URL.createObjectURL(blob) });
  }
  card.progress(null);
  card.buttons([]);
  card.meta(`Ricevuto · ${formatBytes(total)}`, 'ok');
  card.extra(
    h(
      'div',
      { class: 'files' },
      results.map((r) =>
        h(
          'div',
          { class: 'file' },
          r.blob.type.startsWith('image/') ? h('img', { class: 'preview', src: r.url, alt: '' }) : h('div', { class: 'thumb', icon: 'doc' }),
          h('div', { class: 'grow' }, basename(r.name), h('div', { class: 'meta' }, formatBytes(r.blob.size))),
          h('a', { class: 'btn', href: r.url, download: basename(r.name) }, 'Salva'),
        ),
      ),
    ),
  );
}

// ───────────── start ─────────────

const params = new URLSearchParams(location.hash.slice(1));
if (params.get('k') && params.get('p')) screenPair(params);
else if (state) screenMain();
else screenNoLink();
