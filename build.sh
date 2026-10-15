#!/usr/bin/env bash
# Package Reolink Viewer as Tizen .wgt files.
#
#   ./build.sh                       -> dist/ReolinkViewer.wgt and dist/ReolinkViewer-legacy.wgt, unsigned
#   ./build.sh --sign                -> the same, signed with a Tizen Studio profile (TIZEN_PROFILE)
#   ./build.sh --install 192.168.1.20 -> signed, then installed and launched on the TV at that IP
#
# Two packages come out of one source tree:
#   ReolinkViewer.wgt         Tizen 4.0+ (2018 and newer TVs). HTTP-FLV and RTSP,
#                             including the relay service for H.265 main streams.
#   ReolinkViewer-legacy.wgt  Tizen 2.4+ (2016-2017 TVs). HTTP-FLV only: the
#                             config.xml block between the rtsp-mode markers is
#                             removed, along with the service directory.
#
# Unsigned packages are what CI publishes; Apps2Samsung signs them for your TV.
# Signing here needs Tizen Studio with the TV extension on PATH (tizen, sdb).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$HERE/dist"
PROFILE="${TIZEN_PROFILE:-ReolinkViewer}"
APP_ID="ReoLnkVwr1.ReolinkViewer"

MODE="zip"
TV_IP=""
case "${1:-}" in
    "")          ;;
    --sign)      MODE="sign" ;;
    --install)   MODE="sign"; TV_IP="${2:-}"; [[ -n "$TV_IP" ]] || { echo "usage: $0 --install <tv-ip>"; exit 1; } ;;
    *)           echo "usage: $0 [--sign | --install <tv-ip>]"; exit 1 ;;
esac

FILES=(config.xml index.html icon.png css js)

rm -rf "$OUT"
mkdir -p "$OUT/full" "$OUT/legacy"

# Full package: the source tree as is.
cp -r "${FILES[@]/#/$HERE/}" "$HERE/service" "$OUT/full/"

# Legacy package: no service, no service-only config, Tizen 2.4 minimum.
cp -r "${FILES[@]/#/$HERE/}" "$OUT/legacy/"
sed -e '/rtsp-mode:begin/,/rtsp-mode:end/d' \
    -e 's/required_version="4.0"/required_version="2.4"/' \
    "$HERE/config.xml" > "$OUT/legacy/config.xml"
grep -q 'tizen:service' "$OUT/legacy/config.xml" && { echo "legacy config still contains the service"; exit 1; }
grep -q 'required_version="2.4"' "$OUT/legacy/config.xml" || { echo "legacy config did not get required_version 2.4"; exit 1; }

package() {   # package <dir> <name>
    local dir="$1" name="$2"
    if [[ "$MODE" == "zip" ]]; then
        if command -v zip >/dev/null; then
            (cd "$dir" && zip -r -X -q "$OUT/$name.wgt" .)
        else
            (cd "$dir" && python3 -m zipfile -c "$OUT/$name.wgt" ./*)
        fi
    else
        command -v tizen >/dev/null || { echo "tizen CLI not found. Add <tizen-studio>/tools/ide/bin to PATH."; exit 1; }
        tizen package -t wgt -s "$PROFILE" -- "$dir" >/dev/null
        mv "$dir"/*.wgt "$OUT/$name.wgt"
    fi
    echo "Built: $OUT/$name.wgt ($(du -h "$OUT/$name.wgt" | cut -f1))"
}

package "$OUT/full" ReolinkViewer
package "$OUT/legacy" ReolinkViewer-legacy
rm -rf "$OUT/full" "$OUT/legacy"

if [[ -n "$TV_IP" ]]; then
    sdb connect "$TV_IP"
    TARGET="$(sdb devices | awk 'NR>1 && $2=="device" {print $1; exit}')"
    [[ -n "$TARGET" ]] || { echo "No TV found via sdb. Is Developer Mode on and the host PC IP whitelisted?"; exit 1; }
    tizen install -n "$OUT/ReolinkViewer.wgt" -t "$TARGET"
    tizen run -p "$APP_ID" -t "$TARGET"
fi
