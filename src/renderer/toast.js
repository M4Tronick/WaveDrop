'use strict';

const stack = document.getElementById('stack');
const cards = new Map(); // id -> element

const timeFormat = new Intl.DateTimeFormat('it-IT', { hour: '2-digit', minute: '2-digit' });

function chime() {
  try {
    const ctx = new AudioContext();
    [880, 1318.5].forEach((freq, i) => {
      const t = ctx.currentTime + i * 0.13;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.16, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.6);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.65);
    });
    setTimeout(() => ctx.close(), 1200);
  } catch {
    // Audio is a nicety; ignore failures.
  }
}

const b = (text) => h('b', {}, text);
const pct = (p) => `${Math.floor(p * 100)}%`;

function thumbFor(v) {
  const box = h('div', { class: 'thumb' });
  if (v.kind === 'pairing' || v.kind === 'phone') {
    box.append(h('div', { class: 'glyph', svg: v.kind === 'phone' ? 'phone' : 'shield' }));
    if (v.status === 'done' || v.kind === 'phone') box.append(h('div', { class: 'mini ok', svg: 'check' }));
    return box;
  }
  if (v.kind === 'incoming' && v.thumbnail) {
    box.append(h('img', { class: 'preview', src: v.thumbnail, alt: '' }));
  } else if (v.kind === 'incoming') {
    const ava = h('div', { class: 'ava' });
    paintAvatar(ava, v.sender);
    box.append(ava);
  } else {
    box.append(h('img', { class: 'app', src: '../../assets/icon.svg', alt: '' }));
  }
  if (v.status === 'done') box.append(h('div', { class: 'mini ok', svg: 'check' }));
  if (['declined', 'failed'].includes(v.status)) box.append(h('div', { class: 'mini bad', svg: 'close' }));
  return box;
}

// Returns [headline nodes, meta text, progress?, actions[]] for a card view.
const PAIR_END = {
  done: 'Abbinamento riuscito: ora vi riconoscete.',
  failed: 'Abbinamento non riuscito: codice sbagliato 3 volte.',
  expired: 'Il codice è scaduto.',
  cancelled: 'Abbinamento annullato.',
  replaced: 'Richiesta sostituita da una nuova.',
};

function textBlock(card, text) {
  const copy = () =>
    wave.copy(text).then(() => {
      if (card._meta) card._meta.textContent = 'Copiato negli appunti';
    });
  const actions = [['Copia', copy]];
  if (/^https?:\/\/\S+$/i.test(text.trim())) actions.push(['Apri link', () => wave.openUrl(text.trim()), 'primary']);
  return { box: h('div', { class: 'textbox' }, text.length > 600 ? `${text.slice(0, 600)}…` : text), actions };
}

function contentFor(v, card) {
  if (v.kind === 'phone') {
    return { headline: [b(v.name), ' è collegato.'], meta: 'Ora puoi scambiare file e testi con il telefono.', dismiss: true };
  }
  if (v.kind === 'pairing') {
    const who = b(v.peer.name);
    const device = PLATFORM_LABEL[v.peer.platform] || 'dispositivo';
    if (v.status === 'waiting') {
      return {
        headline: [who, ` (${device}) vuole abbinarsi. Scrivi questo codice sul suo dispositivo:`],
        code: v.code,
        meta: v.attempts < 3 ? `Codice errato inserito. Tentativi rimasti: ${v.attempts}` : 'Se non sai chi è, annulla.',
        actions: [['Annulla', () => wave.cancelPairing(v.id)]],
      };
    }
    return { headline: [v.status === 'done' ? 'Abbinato con ' : 'Abbinamento con ', who], meta: PAIR_END[v.status] || '', dismiss: true };
  }
  const what = describePayload(v);
  if (v.kind === 'incoming') {
    const who = b(v.sender.name);
    const device = PLATFORM_LABEL[v.sender.platform];
    const size = formatBytes(v.totalSize);
    switch (v.status) {
      case 'pending': {
        const trust = v.sender.trusted
          ? null
          : h('label', { class: 'trust' }, h('input', { type: 'checkbox' }), ` Accetta sempre da ${v.sender.name}`);
        return {
          headline: [who, ` vuole condividere ${what}.`],
          meta: v.isText ? `Testo · ${device || 'contatto verificato'}` : device ? `${size} · ${device}` : size,
          extra: [v.text ? textBlock(card, v.text).box : null, trust],
          actions: [
            ['Rifiuta', () => wave.respond(v.id, false)],
            ['Accetta', () => wave.respond(v.id, true, { trust: !!(trust && trust.firstChild.checked) }), 'primary'],
          ],
        };
      }
      case 'receiving':
        return {
          headline: ['Ricezione da ', who, '…'],
          meta: `${pct(v.progress)} · ${formatBytes(v.received)} di ${size}`,
          progress: v.progress,
          actions: [['Annulla', () => wave.respond(v.id, false)]],
        };
      case 'done': {
        const airdrop = v.via === 'airdrop';
        if (v.isText) {
          const t = textBlock(card, v.text);
          return {
            headline: airdrop ? [who, ' ti ha inviato un link via AirDrop'] : [who, ' ti ha inviato un testo'],
            meta: airdrop ? 'AirDrop' : device || '',
            extra: [t.box],
            actions: t.actions,
            dismiss: true,
          };
        }
        const actions = [['Mostra nella cartella', () => wave.showInFolder(v.reveal)]];
        if (v.items === 1 && !v.isFolder) actions.push(['Apri', () => wave.openPath(v.paths[0]), 'primary']);
        if (airdrop) return { headline: ['Hai ricevuto ', what, ' da ', who], meta: `${size} · AirDrop`, actions, dismiss: true };
        return { headline: [v.auto ? 'Ricevuto automaticamente ' : 'Hai ricevuto ', what, ' da ', who], meta: size, actions, dismiss: true };
      }
      case 'declined':
        return { headline: ['Hai rifiutato ', what, ' da ', who], meta: size, dismiss: true };
      case 'cancelled':
        return { headline: [who, " ha annullato l'invio."], meta: what, dismiss: true };
      case 'cancelled-local':
        return { headline: ['Ricezione annullata.'], meta: what, dismiss: true };
      default:
        return { headline: ['Ricezione da ', who, ' non riuscita.'], meta: v.error || what, dismiss: true };
    }
  }

  const who = b(v.peerName);
  switch (v.status) {
    case 'preparing':
    case 'waiting':
      return {
        headline: ['In attesa che ', who, ' accetti…'],
        meta: v.items ? what : 'Preparazione…',
        progress: null,
        actions: [['Annulla', () => wave.cancel(v.id)]],
      };
    case 'sending':
      return {
        headline: ['Invio a ', who, '…'],
        meta: `${pct(v.progress)} · ${what}`,
        progress: v.progress,
        actions: [['Annulla', () => wave.cancel(v.id)]],
      };
    case 'done':
      return v.pairOnly
        ? { headline: ['Abbinato con ', who, '.'], meta: 'Ora vi riconoscete in modo sicuro.', dismiss: true }
        : { headline: ['Inviato a ', who, '.'], meta: what, dismiss: true };
    case 'declined':
      return {
        headline:
          v.reason === 'off'
            ? [who, ' non sta ricevendo file.']
            : v.reason === 'timeout'
              ? [who, ' non ha risposto.']
              : [who, ' ha rifiutato.'],
        meta: what,
        dismiss: true,
      };
    case 'cancelled':
      return { headline: v.reason === 'remote' ? [who, ' ha annullato la ricezione.'] : ['Invio annullato.'], meta: what, dismiss: true };
    default:
      return { headline: ['Invio a ', who, ' non riuscito.'], meta: AIRDROP_HINT[v.reason] || FAILURE_LABEL[v.reason] || what, dismiss: true };
  }
}

function build(card, v) {
  const c = contentFor(v, card);
  const head = h(
    'div',
    { class: 'head' },
    h('img', { src: '../../assets/icon.svg', alt: '' }),
    'WaveDrop',
    h('span', { class: 'when' }, card.dataset.when),
    c.dismiss || !['pending', 'waiting'].includes(v.status)
      ? h('button', { class: 'icon-btn x', svg: 'close', 'aria-label': 'Chiudi', onclick: () => wave.dismissToast(v.id) })
      : null,
  );
  const meta = h('div', { class: 'meta' }, c.meta);
  let bar = null;
  if (c.progress !== undefined) {
    bar = h('div', { class: c.progress === null ? 'progress indeterminate' : 'progress' }, h('i'));
  }
  const code = c.code ? h('div', { class: 'code' }, `${c.code.slice(0, 3)} ${c.code.slice(3)}`) : null;
  const text = h('div', { class: 'text' }, h('div', { class: 'headline' }, ...c.headline), code, meta, bar);
  const actions = c.actions
    ? h(
        'div',
        { class: 'actions' },
        c.actions.map(([label, onclick, kind]) => h('button', { class: kind ? `btn ${kind}` : 'btn', onclick }, label)),
      )
    : null;
  const extra = (c.extra || []).filter(Boolean);
  card.replaceChildren(...[head, h('div', { class: 'main' }, thumbFor(v), text), ...extra, actions].filter(Boolean));
  card._meta = meta;
  card._bar = bar && bar.firstChild;
  refresh(card, v, c);
}

function refresh(card, v, c = contentFor(v, card)) {
  card._meta.textContent = c.meta;
  if (card._bar && typeof c.progress === 'number') card._bar.style.width = `${c.progress * 100}%`;
}

let soundOn = true;

wave.on('toasts', ({ items: views, sound }) => {
  soundOn = sound;
  const ids = new Set(views.map((v) => v.id));
  for (const [id, card] of cards) {
    if (ids.has(id)) continue;
    cards.delete(id);
    card.classList.add('leaving');
    setTimeout(() => {
      card.remove();
      syncSize();
    }, 220);
  }
  for (const v of views) {
    let card = cards.get(v.id);
    if (!card) {
      card = h('div', { class: 'card' });
      card.dataset.when = timeFormat.format(new Date());
      cards.set(v.id, card);
      stack.prepend(card);
      if (soundOn && ((v.kind === 'incoming' && (v.status === 'pending' || v.auto)) || v.kind === 'pairing')) chime();
    }
    const key = `${v.kind}:${v.status}:${v.kind === 'pairing' ? v.attempts : ''}`;
    if (card.dataset.key !== key) {
      card.dataset.key = key;
      build(card, v);
    } else {
      refresh(card, v);
    }
  }
  syncSize();
});

function syncSize() {
  const live = [...cards.values()].length + stack.querySelectorAll('.leaving').length;
  wave.resizeToast(live ? Math.ceil(document.body.getBoundingClientRect().height) : 0);
}
new ResizeObserver(syncSize).observe(stack);
