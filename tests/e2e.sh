#!/usr/bin/env bash
# End-to-end check of the relay against real encoders and decoders.
#
# ffmpeg publishes an H.265 clip, then an H.264 clip (both with AAC), to a
# mediamtx RTSP server that demands a login. The relay pulls each over RTSP
# with Digest auth, and ffprobe/ffmpeg read what the relay serves on /live.ts
# and /live.m3u8 and decode it. Any decode error fails the run.
#
# Needs ffmpeg, ffprobe and mediamtx (https://github.com/bluenviron/mediamtx)
# on PATH, or in FFMPEG / FFPROBE / MEDIAMTX. Not run in CI.
#
#   tests/e2e.sh
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FFMPEG="${FFMPEG:-ffmpeg}"
FFPROBE="${FFPROBE:-ffprobe}"
MEDIAMTX="${MEDIAMTX:-mediamtx}"
RELAY_PORT=8129
RTSP_PORT=18554
RELAY="http://127.0.0.1:$RELAY_PORT"

for tool in "$FFMPEG" "$FFPROBE" "$MEDIAMTX" node curl; do
    command -v "$tool" >/dev/null || { echo "missing: $tool"; exit 2; }
done

WORK="$(mktemp -d)"
PIDS=()
cleanup() {
    for pid in "${PIDS[@]:-}"; do [[ -n "$pid" ]] && kill "$pid" 2>/dev/null || true; done
    wait 2>/dev/null || true
    rm -rf "$WORK"
}
trap cleanup EXIT

echo "== encoding test clips"
"$FFMPEG" -hide_banner -loglevel error -y -f lavfi -i testsrc2=size=1280x720:rate=25 -f lavfi -i sine=frequency=440:sample_rate=16000 \
    -c:v libx265 -preset ultrafast -tag:v hvc1 -x265-params keyint=50:min-keyint=50:scenecut=0:bframes=0:log-level=error \
    -c:a aac -ac 1 -b:a 48k -t 20 "$WORK/h265.mp4"
"$FFMPEG" -hide_banner -loglevel error -y -f lavfi -i testsrc2=size=1280x720:rate=25 -f lavfi -i sine=frequency=440:sample_rate=16000 \
    -c:v libx264 -preset ultrafast -g 50 -bf 0 -c:a aac -ac 1 -b:a 48k -t 20 "$WORK/h264.mp4"

cat > "$WORK/mediamtx.yml" <<EOF
logLevel: error
api: false
metrics: false
pprof: false
playback: false
rtsp: true
rtspAddress: 127.0.0.1:$RTSP_PORT
rtspTransports: [tcp]
rtmp: false
hls: false
webrtc: false
srt: false
authInternalUsers:
  - user: admin
    pass: secret
    permissions:
      - action: publish
      - action: read
paths:
  all_others:
EOF

echo "== starting mediamtx and the relay"
(cd "$WORK" && "$MEDIAMTX" "$WORK/mediamtx.yml" >"$WORK/mediamtx.log" 2>&1) &
PIDS+=($!)
(cd "$REPO" && node service/relay.js >"$WORK/relay.log" 2>&1) &
PIDS+=($!)
sleep 1.5

failures=0
status() { curl -s "$RELAY/status"; }

check() {   # check <label> <clip> <expected ffprobe codec>
    local label="$1" clip="$2" codec="$3" st="" pub
    echo
    echo "== $label"
    "$FFMPEG" -hide_banner -loglevel error -re -stream_loop -1 -i "$clip" -c copy -f rtsp -rtsp_transport tcp \
        "rtsp://admin:secret@127.0.0.1:$RTSP_PORT/cam" >"$WORK/publish-$label.log" 2>&1 &
    pub=$!
    PIDS+=("$pub")
    sleep 1.5

    curl -s -X POST -H 'Content-Type: application/json' \
        -d "{\"host\":\"127.0.0.1\",\"port\":$RTSP_PORT,\"user\":\"admin\",\"pass\":\"secret\",\"path\":\"cam\",\"audio\":true}" \
        "$RELAY/start" >/dev/null

    for _ in $(seq 1 40); do
        st="$(status)"
        [[ "$st" == *'"state":"playing"'* || "$st" == *'"state":"error"'* ]] && break
        sleep 0.5
    done
    if [[ "$st" != *'"state":"playing"'* ]]; then
        echo "FAIL: relay did not reach playing: $st"; failures=$((failures + 1)); kill "$pub" 2>/dev/null || true; return
    fi
    echo "relay: $(echo "$st" | sed -e 's/.*"video":\({[^}]*}\).*"audio":\({[^}]*}\|null\).*/video \1 audio \2/')"

    local streams
    streams="$(timeout 30 "$FFPROBE" -v error -show_entries stream=codec_type,codec_name -of csv=p=0 "$RELAY/live.ts" | sort | tr '\n' ' ')"
    echo "ffprobe live.ts: $streams"
    if [[ "$streams" != *"$codec,video"* || "$streams" != *"aac,audio"* ]]; then
        echo "FAIL: expected $codec video and aac audio"; failures=$((failures + 1))
    fi

    timeout 40 "$FFMPEG" -hide_banner -v error -t 5 -i "$RELAY/live.ts" -f null - 2>"$WORK/decode-ts-$label.log" || true
    local errs
    errs="$(grep -c . "$WORK/decode-ts-$label.log" || true)"
    echo "decode 5 s of live.ts: $errs error lines"
    if [[ "$errs" -ne 0 ]]; then head -5 "$WORK/decode-ts-$label.log"; failures=$((failures + 1)); fi

    for _ in $(seq 1 40); do
        st="$(status)"
        [[ "$st" =~ \"segments\":([0-9]+) ]] && [[ "${BASH_REMATCH[1]}" -ge 3 ]] && break
        sleep 0.5
    done
    echo "playlist: $(curl -s "$RELAY/live.m3u8" | tr '\n' ' ')"
    timeout 60 "$FFMPEG" -hide_banner -v error -t 5 -i "$RELAY/live.m3u8" -f null - 2>"$WORK/decode-hls-$label.log" || true
    errs="$(grep -c . "$WORK/decode-hls-$label.log" || true)"
    echo "decode 5 s of HLS: $errs error lines"
    if [[ "$errs" -ne 0 ]]; then head -5 "$WORK/decode-hls-$label.log"; failures=$((failures + 1)); fi

    curl -s -X POST "$RELAY/stop" >/dev/null
    kill "$pub" 2>/dev/null || true
    wait "$pub" 2>/dev/null || true
}

check h265 "$WORK/h265.mp4" hevc
check h264 "$WORK/h264.mp4" h264

echo
echo "== relay log"
grep -v "^$" "$WORK/relay.log" | tail -20
echo
if [[ "$failures" -eq 0 ]]; then echo "ALL GOOD"; else echo "$failures FAILURE(S)"; fi
exit "$failures"
