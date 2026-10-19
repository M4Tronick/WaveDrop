#!/usr/bin/env bash
# Builds WaveDrop for iPhone from WSL: copies the project to the Linux file
# system (much faster than /mnt/c) and runs `xtool dev`, which compiles, signs
# and installs the app on the iPhone connected through iTunes (see ../README.md).
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$HOME/wavedrop-ios"

if [ -f "$HOME/.local/share/swiftly/env.sh" ]; then . "$HOME/.local/share/swiftly/env.sh"; fi
export PATH="$HOME/.local/bin:$PATH"
# The Apple Mobile Device service of iTunes on Windows, forwarded to WSL.
export USBMUXD_SOCKET_ADDRESS="${USBMUXD_SOCKET_ADDRESS:-$(ip route list default | awk '{print $3}'):27015}"

mkdir -p "$DEST"
rsync -a --delete --exclude .build --exclude xtool "$SRC/" "$DEST/"
cd "$DEST"

echo "› test del protocollo"
swift test 2>&1 | grep -E "Executed|error:" | tail -1

echo "› compilazione e installazione sull'iPhone"
xtool dev "$@"
