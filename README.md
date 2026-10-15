<img src="icon.png" alt="" width="104" align="right">

# Reolink Viewer

Watch a Reolink camera on a Samsung TV. Type the camera's local IP address and
login, press Start, and the live stream fills the screen. Nothing leaves your
network: there is no cloud account, no relay server, no app server. The TV talks
straight to the camera.

Requested in the Apps2Samsung community: *"an app where you just enter the local
IP address and login details of a Reolink security camera, hit start, and
directly view the live stream on the TV"*. This is that app.

## How it works

There are two ways to get the picture, chosen with the **Connection** field.

**HTTP-FLV** (the default). Reolink cameras and NVRs serve their live stream as
FLV over plain HTTP, the same endpoint the Reolink web client uses. The app
fetches that stream and feeds it to the TV's own video decoder through Media
Source Extensions, using [mpegts.js](https://github.com/xqq/mpegts.js). No
transcoding, no helper box. It works on every Tizen TV, with one catch:
**the FLV endpoint only carries H.264.** Cameras whose main stream is H.265
(most 8 MP and 12 MP models at full resolution) will not show their main stream
this way. The **Sub** stream is H.264 on every Reolink camera, so it is the
default and always works.

**RTSP** (2018 and newer TVs). The full-quality H.265 main stream is available
over RTSP, which a TV web app cannot speak by itself. So the package carries a
small background service, [`service/relay.js`](service/relay.js), that runs on
the TV's Node.js runtime. It opens the camera's RTSP stream over TCP, unwraps
the H.265 (or H.264) and AAC, and re-wraps them as MPEG-TS on `127.0.0.1`,
still without transcoding; the TV's hardware decoder does the work. The app
plays that either in the browser (mpegts.js again, lowest delay) or, when the
browser cannot decode H.265, with Samsung's AVPlay from a live HLS playlist,
which runs a few seconds behind. **Player** = Automatic picks for you.

```
HTTP-FLV:  camera --FLV over HTTP--> web app (mpegts.js + MSE)
RTSP:      camera --RTSP/RTP over TCP--> relay service --MPEG-TS on 127.0.0.1--> web app (MSE) or AVPlay (HLS)
```

Not keen on RTSP? The zero-effort alternative for an H.265 camera is to set
its main stream to H.264 in the Reolink app (Camera → Display/Stream → Main
Stream → Encoding) or to drop the resolution below 4K. On a TV the difference
is rarely visible.

## Will it work on my TV?

Any Samsung TV running Tizen 2.4 or newer (2016 models onward). The app is a
plain Tizen web app and needs no .NET runtime. There are two packages:

| Your TV | Download | What you get |
| --- | --- | --- |
| 2018 and newer (Tizen 4.0+) | `ReolinkViewer.wgt` | HTTP-FLV and RTSP, including H.265 main streams through the relay. |
| 2016–2017 (Tizen 2.4 / 3.0) | `ReolinkViewer-legacy.wgt` | HTTP-FLV only (H.264). The relay service needs Tizen 4.0. |

Neither has been tested on hardware yet; please open an issue with your model
and what you saw. Grab the package from the
[latest release](https://github.com/Apps2Samsung/ReolinkViewer/releases).

## Installing

1. Put the TV in Developer Mode (Apps → type `12345` on the remote) and note its
   IP address.
2. Install the `.wgt` for your TV with
   [Apps2Samsung](https://github.com/Apps2Samsung/Apps2Samsung): it signs the
   package with a certificate for your TV and pushes it over the network. The
   packages in releases are unsigned, which no TV accepts as-is.
3. Launch **Reolink Viewer** from the TV's Apps list.

Building and installing by hand with Tizen Studio is covered below.

## Camera settings

On the camera or NVR, in the Reolink app or web client, under
**Network → Advanced → Port Settings**:

- For **HTTP-FLV**: make sure **HTTP** is enabled (port 80 by default). **Do not
  enable "HTTPS only"**: the TV's browser refuses the camera's self-signed
  certificate, so the stream must come over plain HTTP.
- For **RTSP**: make sure **RTSP** is enabled (port 554 by default). The relay
  uses TCP, so no port forwarding or firewall rules are needed on the TV side.
- Use a **dedicated user** if you like: a viewer-level user account is enough.
- For an **NVR**, enter the NVR's IP and login, and pick the camera with the
  **Channel** field (first camera is 0).

In RTSP mode the app tries Reolink's standard stream paths for the channel
and stream you picked (`h265Preview_01_main`, `h264Preview_01_main`,
`Preview_01_main`, and the `_sub` / `_ext` variants). If your device uses
another path, type it into **RTSP path**.

## Using the remote

Setup screen:

| Key | What it does |
| --- | --- |
| **▲ / ▼** | Move between fields |
| **◀ / ▶** | Change a choice (connection, stream, channel, audio, player) |
| **OK** | On a text field: open the on-screen keyboard. On a choice: next option. On Start: connect |
| **Back** | Exit the app |

While watching:

| Key | What it does |
| --- | --- |
| **OK** | Show or hide the info overlay (codec, resolution, bandwidth, player, stream URL) |
| **CH ▲ / ▼** (or ▲ / ▼) | Switch NVR channel |
| **Play / Pause** | Pause; pressing again reconnects to the live edge |
| **Back** or **Stop** | Back to the setup screen |

Settings are remembered on the TV, including the password, so the next launch is
one press on Start. Turn on **Connect automatically on launch** to skip even
that.

If the stream drops, the app reconnects on its own with increasing delays. Press
Back to stop it trying. Leaving the player screen, or sending the app to the
background, closes the camera connection so your viewer slot is freed.

## Troubleshooting

| Message | Likely cause |
| --- | --- |
| *Cannot reach the camera* | Wrong IP, HTTP port disabled, "HTTPS only" enabled, or the TV is on a different network (guest Wi-Fi, VLAN). |
| *Cannot reach … over RTSP* | RTSP disabled on the camera, wrong RTSP port, or a different network. |
| *Login rejected* | Username or password wrong. Reolink user names are case-sensitive. |
| *This stream is H.265 and the TV's browser cannot decode it* | HTTP-FLV with an H.265 main stream. Switch Connection to RTSP, use Sub, or set the main stream to H.264. |
| *No stream at the known RTSP paths* | Wrong channel number, or a device with non-standard paths. Fill in **RTSP path**. |
| *The camera refused: too many viewers* / *The camera closed the stream* | Reolink limits concurrent viewers per stream. Close the Reolink app on your phone and try again. |
| *RTSP mode needs the full package* | You installed `ReolinkViewer-legacy.wgt`, which has no relay. Install `ReolinkViewer.wgt` (2018+ TVs). |
| *The relay service did not start* | The TV refused to launch the background service. Reinstall the package; if it persists, open an issue with your model. |
| *The browser player cannot decode this stream* | Set **Player** to TV player (AVPlay). Automatic does this by itself after the first failure. |
| *This TV does not support Media Source Extensions* | A very old or unusual firmware. In RTSP mode, set Player to TV player. |

## Build and install by hand

```bash
./build.sh                          # dist/ReolinkViewer.wgt and dist/ReolinkViewer-legacy.wgt, unsigned
TIZEN_PROFILE=MyTv ./build.sh --sign            # signed with a Tizen Studio certificate profile
TIZEN_PROFILE=MyTv ./build.sh --install 192.168.1.20   # ...and installed and launched on that TV
```

Signing needs [Tizen Studio](https://developer.samsung.com/smarttv/develop/getting-started/setting-up-sdk/installing-tv-sdk.html)
with the TV extension, a Samsung certificate profile for your TV (made with the
Certificate Manager), and `tizen` and `sdb` on your `PATH`
(`<tizen-studio>/tools/ide/bin` and `<tizen-studio>/tools`). Unsigned
packages need only `zip` or Python 3.

Both packages come from one source tree: the legacy one is the same app with
the block between the `rtsp-mode` markers in `config.xml` removed and
`required_version` set back to 2.4.

### Tests

```bash
node --test tests        # parsers, depacketizers, TS muxer, and a fake camera end to end
tests/e2e.sh             # real encoders and decoders: needs ffmpeg, ffprobe and mediamtx
```

The second script publishes H.265 and H.264 clips to a local
[mediamtx](https://github.com/bluenviron/mediamtx) with a login, lets the relay
pull them over RTSP with Digest auth, and has ffmpeg decode what the relay
serves on `/live.ts` and `/live.m3u8`.

### Hacking on it

It is static HTML and JavaScript, so you can develop in a desktop Chrome. The
only obstacle is CORS: the camera does not send CORS headers, and a Tizen app is
exempt from CORS (`<access origin="*">` in `config.xml`) while a desktop browser
is not. Start Chrome with web security off for a throwaway profile:

```bash
google-chrome --disable-web-security --user-data-dir=/tmp/chrome-dev index.html
```

For RTSP mode on the desktop, run the relay by hand (`node service/relay.js`,
it listens on 127.0.0.1:8129) and the app will find it. The relay's own API is
documented at the top of `service/relay.js`; `GET /status` and `GET /log` are
handy while debugging.

The relay is written for the TV's old Node.js build: plain ES5, no npm
packages, and only the parts of `Buffer` that are known to exist there.
