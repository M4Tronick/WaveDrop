'use strict';

const body = document.body;
const peersEl = document.getElementById('peers');
const state = { peers: [], outgoing: [] };
const GROW_DELAY_MS = 30; // let the window grow before the capsule animates into it
const SHRINK_DELAY_MS = 340; // let the capsule animate down before the window shrinks

let mode = 'idle';
let dragDepth = 0;
let collapseTimer = null;
let holdUntil = 0;

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

// Hover: peek at the capsule; click opens the full overlay.
body.addEventListener('mouseenter', () => {
  if (mode === 'idle') setMode('hover');
});
body.addEventListener('mouseleave', () => {
  if (mode === 'hover') setMode('idle');
});
document.getElementById('cap').addEventListener('click', () => {
  if (mode === 'hover') wave.openOverlay();
});

// Dragging files over the top edge opens the island.
window.addEventListener('dragenter', (e) => {
  e.preventDefault();
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
