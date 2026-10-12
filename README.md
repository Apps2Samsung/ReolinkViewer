<img src="icon.png" alt="" width="104" align="right">

# Reolink Viewer

Watch a Reolink camera on a Samsung TV. Type the camera's local IP address and
login, press Start, and the live stream fills the screen. Nothing leaves your
network: there is no cloud account, no relay, no app server. The TV talks
straight to the camera.

Requested in the Apps2Samsung community: *"an app where you just enter the local
IP address and login details of a Reolink security camera, hit start, and
directly view the live stream on the TV"*. This is that app.

## How it works

Reolink cameras and NVRs serve their live stream as FLV over plain HTTP
(the same endpoint the Reolink web client uses). The app fetches that stream
and feeds it to the TV's own video decoder through Media Source Extensions,
using [mpegts.js](https://github.com/xqq/mpegts.js). No transcoding, no
helper box, no RTSP: Samsung's TV player cannot open RTSP at all, which is why
the FLV endpoint is the right door.

The one catch is codec. **Reolink's FLV endpoint only carries H.264.** Cameras
whose main stream is H.265 (most 8 MP and 12 MP models at full resolution)
will not show their main stream. The **Sub** stream is H.264 on every Reolink
camera, so it is the default and always works. For full quality on an H.265
camera, set the main stream to H.264 in the Reolink app
(Camera → Display/Stream → Main Stream → Encoding) or drop the resolution
below 4K.

## Will it work on my TV?

Any Samsung TV running Tizen 2.4 or newer (2016 models onward). The app is a
plain Tizen web app, so there is one package for every platform version, and it
needs no .NET runtime.

| Your TV | Download | Notes |
| --- | --- | --- |
| 2016 and newer (Tizen 2.4+) | `ReolinkViewer.wgt` | One package for all. Not yet tested on hardware; please open an issue with your model and what you saw. |

Grab the package from the
[latest release](https://github.com/Apps2Samsung/ReolinkViewer/releases).

## Installing

1. Put the TV in Developer Mode (Apps → type `12345` on the remote) and note its
   IP address.
2. Install `ReolinkViewer.wgt` with
   [Apps2Samsung](https://github.com/Apps2Samsung/Apps2Samsung): it signs the
   package with a certificate for your TV and pushes it over the network. The
   package in releases is unsigned, which no TV accepts as-is.
3. Launch **Reolink Viewer** from the TV's Apps list.

Building and installing by hand with Tizen Studio is covered below.

## Camera settings

On the camera or NVR, in the Reolink app or web client:

- **Network → Advanced → Port Settings:** make sure **HTTP** is enabled (port
  80 by default). The FLV stream is served through the HTTP port.
- **Do not enable "HTTPS only".** The TV's browser refuses the camera's
  self-signed certificate, so the stream must come over plain HTTP. If you
  have enabled it, switch it off or the app cannot connect.
- Use a **dedicated user** if you like: a viewer-level user account is enough.
- For an **NVR**, enter the NVR's IP and login, and pick the camera with the
  **Channel** field (first camera is 0).

## Using the remote

Setup screen:

| Key | What it does |
| --- | --- |
| **▲ / ▼** | Move between fields |
| **◀ / ▶** | Change a choice (stream, channel, audio, protocol) |
| **OK** | On a text field: open the on-screen keyboard. On a choice: next option. On Start: connect |
| **Back** | Exit the app |

While watching:

| Key | What it does |
| --- | --- |
| **OK** | Show or hide the info overlay (codec, resolution, bandwidth, stream URL) |
| **CH ▲ / ▼** (or ▲ / ▼) | Switch NVR channel |
| **Play / Pause** | Pause; pressing again reconnects to the live edge |
| **Back** or **Stop** | Back to the setup screen |

Settings are remembered on the TV, including the password, so the next launch is
one press on Start. Turn on **Connect automatically on launch** to skip even
that.

If the stream drops, the app reconnects on its own with increasing delays. Press
Back to stop it trying.

## Troubleshooting

| Message | Likely cause |
| --- | --- |
| *Cannot reach the camera* | Wrong IP, HTTP port disabled, "HTTPS only" enabled, or the TV is on a different network (guest Wi-Fi, VLAN). |
| *Login rejected* | Username or password wrong. Reolink user names are case-sensitive. |
| *The TV cannot decode this stream* / *Stream is H.265* | Main stream is H.265. Use Sub, or set the main stream to H.264. |
| *The camera closed the stream* | Reolink limits concurrent viewers per stream. Close the Reolink app on your phone and try again. |
| *This TV does not support Media Source Extensions* | A very old or unusual firmware. Nothing the app can do. |

## Build and install by hand

You need [Tizen Studio](https://developer.samsung.com/smarttv/develop/getting-started/setting-up-sdk/installing-tv-sdk.html)
with the TV extension, and a Samsung certificate profile for your TV (made with
the Certificate Manager; the profile name goes in `TIZEN_PROFILE`).

```bash
TIZEN_PROFILE=MyTvProfile ./build.sh              # builds dist/ReolinkViewer.wgt, signed
TIZEN_PROFILE=MyTvProfile ./build.sh 192.168.1.20 # ...and installs and launches it on the TV at that IP
```

The script needs `tizen` and `sdb` on your `PATH`
(`<tizen-studio>/tools/ide/bin` and `<tizen-studio>/tools`).

### Hacking on it

It is static HTML and JavaScript, so you can develop in a desktop Chrome. The
only obstacle is CORS: the camera does not send CORS headers, and a Tizen app is
exempt from CORS (`<access origin="*">` in `config.xml`) while a desktop browser
is not. Start Chrome with web security off for a throwaway profile:

```bash
google-chrome --disable-web-security --user-data-dir=/tmp/chrome-dev index.html
```

Arrow keys and Enter drive the UI exactly as the remote does; Backspace is not
mapped, click the video area or use the browser's back instead.

Project layout:

```
config.xml        Tizen manifest: app id, privileges, network access
index.html        Setup screen and player
css/style.css     10-foot UI, 1920x1080
js/app.js         Remote navigation, settings, player and reconnect logic
js/vendor/        mpegts.js 1.8.2 (Apache-2.0)
build.sh          Package and install with Tizen Studio
```

## Thanks

- [mpegts.js](https://github.com/xqq/mpegts.js) by xqq, which does the FLV
  demuxing and MSE feeding.
- Reolink, for documenting the
  [FLV stream endpoint](https://support.reolink.com/articles/28256840140441-Introduction-to-FLV-Stream/).
