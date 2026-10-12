#!/usr/bin/env bash
# Package the app as a .wgt and (optionally) install it on a TV.
#
#   ./build.sh                      -> builds ReolinkViewer.wgt
#   ./build.sh 192.168.1.20         -> builds and installs on the TV at that IP
#
# Requires Tizen Studio with the TV extension and a signing profile
# (see README.md, "Build and install").
set -euo pipefail

PROFILE="${TIZEN_PROFILE:-ReolinkViewer}"
TV_IP="${1:-}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$HERE/dist"

command -v tizen >/dev/null || { echo "tizen CLI not found. Add <tizen-studio>/tools/ide/bin to PATH."; exit 1; }

rm -rf "$OUT" && mkdir -p "$OUT"
# Stage only the files that belong in the package.
cp -r "$HERE/config.xml" "$HERE/index.html" "$HERE/icon.png" "$HERE/css" "$HERE/js" "$OUT/"

tizen package -t wgt -s "$PROFILE" -- "$OUT"
WGT="$(ls "$OUT"/*.wgt | head -n 1)"
echo "Built: $WGT"

if [[ -n "$TV_IP" ]]; then
    sdb connect "$TV_IP"
    TARGET="$(sdb devices | awk 'NR>1 && $2=="device" {print $1; exit}')"
    [[ -n "$TARGET" ]] || { echo "No TV found via sdb. Is Developer Mode on and the host PC IP whitelisted?"; exit 1; }
    tizen install -n "$WGT" -t "$TARGET"
    tizen run -p ReoLnkVwr1.ReolinkViewer -t "$TARGET"
fi
