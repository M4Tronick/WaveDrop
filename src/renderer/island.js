'use strict';

const body = document.body;
const peersEl = document.getElementById('peers');
const state = { peers: [], outgoing: [] };
const GROW_DELAY_MS = 30; // let the window grow before the capsule animates into it
const SHRINK_DELAY_MS = 340; // let the capsule animate down before the window shrinks
const HOVER_INTENT_MS = 260; // passing over the top edge on the way to a tab is not a hover
const FLASH_MS = 1600;

let mode = 'idle';
let dragDepth = 0;
let collapseTimer = null;
let holdUntil = 0;
let hoverTimer = null;
let flashTimer = null;

function setMode(next) {
  if (next === mode) return;
  const growing = ['idle', 'hover', 'open'].indexOf(next) > ['idle', 'hover', 'open'].indexOf(mode);
  mode = next;
  if (growing) {
    wave.islandMode(next);
    setTimeout(() => {
      if (mode === next) body.dataset.mode = next;
    }, GROW_DELAY_MS);
  } else {
    body.dataset.mode = next;
    setTimeout(() => {
      if (mode === next) wave.islandMode(next);
    }, SHRINK_DELAY_MS);
  }
}

function render() {
  PeerTiles.render(peersEl, state.peers, state.outgoing, {
    activate: () => wave.openOverlay(),
    drop(peerId, paths) {
      dragDepth = 0; // the tile swallows the drop, so no dragleave will follow
      wave.send(peerId, paths);
      holdUntil = Date.now() + 1800; // show the "waiting" ring for a moment
      scheduleCollapse(1850);
    },
  });
  body.classList.toggle('has-peers', state.peers.length > 0);
}

function scheduleCollapse(ms) {
  clearTimeout(collapseTimer);
  collapseTimer = setTimeout(() => {
    if (dragDepth === 0 && Date.now() >= holdUntil) setMode('idle');
  }, ms);
}

// Hover: peek at the capsule (only if the pointer rests there, and not while a
// button is held, e.g. dragging a window by its title bar); click opens the
// full overlay.
body.addEventListener('mouseenter', (e) => {
  if (mode !== 'idle' || e.buttons) return;
  clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => {
    if (mode === 'idle') setMode('hover');
  }, HOVER_INTENT_MS);
});
body.addEventListener('mouseleave', () => {
  clearTimeout(hoverTimer);
  if (mode === 'hover') setMode('idle');
});
document.getElementById('cap').addEventListener('click', () => {
  if (mode === 'hover') wave.openOverlay();
});

// Dragging files over the top edge opens the island.
window.addEventListener('dragenter', (e) => {
  e.preventDefault();
  clearTimeout(hoverTimer);
  dragDepth++;
  clearTimeout(collapseTimer);
  setMode('open');
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) scheduleCollapse(220);
});
window.addEventListener('drop', () => {
  dragDepth = 0;
  scheduleCollapse(Math.max(220, holdUntil - Date.now() + 50));
});

wave.on('island:mode', ({ lift }) => {
  document.documentElement.style.setProperty('--lift', `${lift}px`);
});

// Transfers in progress: a progress line in the idle pill, then a short flash.
wave.on('island:activity', ({ active, progress, flash }) => {
  body.classList.toggle('busy', active);
  document.documentElement.style.setProperty('--progress', String(Math.max(0.04, Math.min(1, progress))));
  if (!flash) return;
  body.dataset.flash = flash;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => delete body.dataset.flash, FLASH_MS);
});

wave.on('peers', (peers) => {
  state.peers = peers;
  render();
});
wave.on('outgoing', (outgoing) => {
  state.outgoing = outgoing;
  render();
});

wave.snapshot().then((s) => {
  state.peers = s.peers;
  state.outgoing = s.outgoing;
  render();
});
