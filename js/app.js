/*
 * Reolink Viewer for Samsung Tizen TVs.
 *
 * Two ways to get the picture:
 *
 *  - HTTP-FLV: the camera's own FLV-over-HTTP live stream (H.264 + AAC), fed
 *    to the TV's decoder through Media Source Extensions by mpegts.js. Works on
 *    every Tizen TV, but H.264 only.
 *  - RTSP: the camera's RTSP stream, fetched by the relay service that ships
 *    inside this package (service/relay.js) and re-served on 127.0.0.1 as
 *    MPEG-TS. That stream is played either by mpegts.js (MSE, low delay) or,
 *    when the browser cannot decode H.265, by Samsung's AVPlay from a live
 *    HLS playlist. Needs Tizen 4.0 (2018 models) for the service.
 *
 * Everything stays on the local network; the only thing the app talks to is
 * the camera / NVR the user typed in, and the relay on the TV itself.
 */
(function () {
    'use strict';

    var STORAGE_KEY = 'reolink-viewer-settings';
    var RELAY_BASE = 'http://127.0.0.1:8129';

    // Samsung TV remote key codes. Arrows / Enter are standard; the rest are Tizen-specific.
    var KEY = {
        LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13,
        RETURN: 10009, EXIT: 10182,
        PLAY: 415, PAUSE: 19, PLAY_PAUSE: 10252, STOP: 413,
        CH_UP: 427, CH_DOWN: 428
    };

    var DEFAULTS = {
        host: '',
        port: '80',
        scheme: 'http',
        user: 'admin',
        password: '',
        stream: 'sub',
        channel: 0,
        audio: 'on',
        mode: 'flv',            // 'flv' | 'rtsp'
        rtspPort: '554',
        rtspPath: '',           // '' = Reolink's standard paths
        rtspPlayer: 'auto',     // 'auto' | 'mse' | 'avplay'
        autoconnect: 'off'
    };

    // Display names for toggle values that are not self-explanatory.
    var LABELS = {
        flv: 'HTTP-FLV (H.264)',
        rtsp: 'RTSP via relay (H.264 / H.265)',
        auto: 'Automatic',
        mse: 'Browser (MSE)',
        avplay: 'TV player (AVPlay)'
    };

    var MPEGTS_CONFIG = {
        enableWorker: false,
        enableStashBuffer: false,
        stashInitialSize: 128,
        isLive: true,
        lazyLoad: false,
        liveBufferLatencyChasing: true,
        liveBufferLatencyMaxLatency: 3.0,
        liveBufferLatencyMinRemain: 0.5,
        autoCleanupSourceBuffer: true,
        autoCleanupMaxBackwardDuration: 30,
        autoCleanupMinBackwardDuration: 10,
        fixAudioTimestampGap: true,
        reuseRedirectedURL: true
    };

    var RECONNECT_BASE_MS = 3000;
    var RECONNECT_MAX_MS = 30000;
    var OVERLAY_HIDE_MS = 4000;

    var RELAY_LAUNCH_TRIES = 25;          // x 300 ms waiting for the service to answer /ping
    var RELAY_START_TIMEOUT_MS = 25000;   // relay must reach 'playing' (first keyframe) in this time
    var RELAY_POLL_MS = 1000;
    var HLS_MIN_SEGMENTS = 3;             // AVPlay wants a few segments before it starts

    var settings = loadSettings();

    var el = {
        setup: document.getElementById('view-setup'),
        player: document.getElementById('view-player'),
        form: document.getElementById('form'),
        setupMessage: document.getElementById('setup-message'),
        video: document.getElementById('video'),
        avObject: document.getElementById('av-player'),
        overlay: document.getElementById('overlay'),
        status: document.getElementById('status'),
        stats: document.getElementById('stats')
    };

    var rows = Array.prototype.slice.call(el.form.querySelectorAll('.focusable'));
    var focusedRow = null;
    var currentView = 'setup';

    var player = null;              // mpegts.js player (FLV or relay TS)
    var avplayActive = false;       // AVPlay has a stream open
    var avplayPaused = false;
    var activeBackend = null;       // 'flv' | 'mse' | 'avplay'
    var startToken = 0;             // bumps on every (re)start; stale async steps check it
    var relaySessionId = null;
    var relayPollTimer = null;
    var mseFailedForRelay = false;  // MSE could not decode the relay stream: automatic mode uses AVPlay
    var reconnectTimer = null;
    var reconnectAttempt = 0;
    var overlayTimer = null;
    var lastMediaInfo = null;
    var lastRelayStatus = null;

    // ------------------------------------------------------------------ settings

    function loadSettings() {
        var saved = {};
        try {
            saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '{}');
        } catch (e) {
            saved = {};
        }
        var merged = {};
        Object.keys(DEFAULTS).forEach(function (key) {
            merged[key] = saved.hasOwnProperty(key) ? saved[key] : DEFAULTS[key];
        });
        return merged;
    }

    function saveSettings() {
        try {
            window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
        } catch (e) {
            // Storage unavailable: the app still works for this session.
        }
    }

    function buildStreamUrl(opts) {
        var defaultPort = opts.scheme === 'https' ? '443' : '80';
        var hostPort = opts.host + (opts.port && opts.port !== defaultPort ? ':' + opts.port : '');
        return opts.scheme + '://' + hostPort +
            '/flv?port=1935&app=bcs' +
            '&stream=channel' + opts.channel + '_' + opts.stream + '.bcs' +
            '&user=' + encodeURIComponent(opts.user) +
            '&password=' + encodeURIComponent(opts.password);
    }

    function maskPassword(url) {
        return url.replace(/password=[^&]*/, 'password=••••');
    }

    // ------------------------------------------------------------------ form rendering

    function visibleRows() {
        return rows.filter(function (row) { return !row.classList.contains('hidden'); });
    }

    // Rows marked data-mode only apply to one connection mode.
    function applyModeVisibility() {
        rows.forEach(function (row) {
            var mode = row.getAttribute('data-mode');
            if (mode) {
                row.classList.toggle('hidden', mode !== settings.mode);
            }
        });
    }

    function renderRow(row) {
        var field = row.getAttribute('data-field');
        if (!field) {
            return;
        }
        var type = row.getAttribute('data-type');
        if (type === 'text') {
            row.querySelector('input').value = settings[field];
        } else {
            var value = String(settings[field]);
            row.querySelector('.value').textContent = LABELS.hasOwnProperty(value) ? LABELS[value] : value;
        }
    }

    function renderForm() {
        applyModeVisibility();
        rows.forEach(renderRow);
    }

    // target: a row element, or an index into the visible rows.
    function setFocus(target) {
        var list = visibleRows();
        var index = typeof target === 'number' ? target : list.indexOf(target);
        index = Math.max(0, Math.min(list.length - 1, index));
        focusedRow = list[index];
        rows.forEach(function (row) {
            row.classList.toggle('focused', row === focusedRow);
        });
        focusedRow.scrollIntoView({ block: 'nearest' });
    }

    function moveFocus(direction) {
        setFocus(visibleRows().indexOf(focusedRow) + direction);
    }

    function cycleOption(row, direction) {
        var field = row.getAttribute('data-field');
        var options = row.getAttribute('data-options').split(',');
        var index = options.indexOf(String(settings[field]));
        index = (index + direction + options.length) % options.length;
        settings[field] = options[index];
        renderRow(row);
        if (field === 'mode') {
            applyModeVisibility();
        }
        saveSettings();
    }

    function stepValue(row, direction) {
        var field = row.getAttribute('data-field');
        var min = parseInt(row.getAttribute('data-min'), 10);
        var max = parseInt(row.getAttribute('data-max'), 10);
        var value = parseInt(settings[field], 10) + direction;
        settings[field] = Math.max(min, Math.min(max, value));
        renderRow(row);
        saveSettings();
    }

    function adjustRow(row, direction) {
        var type = row.getAttribute('data-type');
        if (type === 'toggle') {
            cycleOption(row, direction);
        } else if (type === 'stepper') {
            stepValue(row, direction);
        }
    }

    function activateRow(row) {
        var action = row.getAttribute('data-action');
        if (action === 'start') {
            startFromForm();
            return;
        }
        var type = row.getAttribute('data-type');
        if (type === 'text') {
            // Hand DOM focus to the input: the TV's on-screen keyboard opens.
            row.querySelector('input').focus();
        } else {
            adjustRow(row, 1);
        }
    }

    function commitInput(input) {
        var field = input.parentNode.getAttribute('data-field');
        settings[field] = input.value.trim();
        saveSettings();
    }

    function showSetupMessage(text) {
        el.setupMessage.textContent = text || '';
    }

    function validateSettings() {
        if (!settings.host) {
            return 'Enter the camera IP address first.';
        }
        if (settings.mode === 'rtsp') {
            if (settings.rtspPort && !/^\d+$/.test(settings.rtspPort)) {
                return 'RTSP port must be a number.';
            }
        } else if (settings.port && !/^\d+$/.test(settings.port)) {
            return 'Port must be a number.';
        }
        return null;
    }

    function startFromForm() {
        var problem = validateSettings();
        if (problem) {
            showSetupMessage(problem);
            setFocus(0);
            return;
        }
        showSetupMessage('');
        mseFailedForRelay = false;
        reconnectAttempt = 0;
        showView('player');
        startPlayer();
    }

    // ------------------------------------------------------------------ views

    function showView(name) {
        currentView = name;
        el.setup.classList.toggle('hidden', name !== 'setup');
        el.player.classList.toggle('hidden', name !== 'player');
    }

    function exitApp() {
        stopRelaySession();
        try {
            window.tizen.application.getCurrentApplication().exit();
        } catch (e) {
            // Not running on Tizen (e.g. desktop browser during development).
        }
    }

    // ------------------------------------------------------------------ status overlay

    function setStatus(text, isError) {
        el.status.textContent = text;
        el.status.classList.toggle('error', !!isError);
        showOverlay(!isError);
    }

    function showOverlay(autoHide) {
        el.overlay.classList.remove('faded');
        clearTimeout(overlayTimer);
        if (autoHide) {
            overlayTimer = setTimeout(function () {
                el.overlay.classList.add('faded');
            }, OVERLAY_HIDE_MS);
        }
    }

    function toggleOverlay() {
        if (el.overlay.classList.contains('faded')) {
            showOverlay(true);
        } else {
            el.overlay.classList.add('faded');
        }
    }

    function describeMediaInfo(info) {
        if (!info) {
            return '';
        }
        var parts = [];
        if (info.videoCodec) {
            parts.push(info.videoCodec);
        }
        if (info.width && info.height) {
            parts.push(info.width + 'x' + info.height);
        }
        if (info.fps) {
            parts.push(Math.round(info.fps) + ' fps');
        }
        if (info.audioCodec) {
            parts.push(info.audioCodec);
        }
        return parts.join('  ·  ');
    }

    function bufferLag() {
        if (!el.video.buffered.length) {
            return '';
        }
        var lag = el.video.buffered.end(el.video.buffered.length - 1) - el.video.currentTime;
        return '  ·  buffer ' + lag.toFixed(1) + 's';
    }

    // ------------------------------------------------------------------ codec support

    // Can this TV's browser decode the codec through Media Source Extensions?
    function mseCanPlay(codec) {
        if (!window.MediaSource || !window.mpegts || !window.mpegts.isSupported()) {
            return false;
        }
        var types = codec === 'H265'
            ? ['video/mp4; codecs="hvc1.1.6.L153.B0"', 'video/mp4; codecs="hev1.1.6.L153.B0"']
            : ['video/mp4; codecs="avc1.640028"'];
        for (var i = 0; i < types.length; i++) {
            try {
                if (window.MediaSource.isTypeSupported(types[i])) {
                    return true;
                }
            } catch (e) {
                // Fall through: treat as unsupported.
            }
        }
        return false;
    }

    // ------------------------------------------------------------------ mpegts.js (FLV and relay TS)

    function onMediaInfo(info) {
        lastMediaInfo = info;
        if (activeBackend === 'flv' && /hevc|hvc1|hev1|h265/i.test(info.videoCodec || '') && !mseCanPlay('H265')) {
            setStatus('This stream is H.265 and the TV\'s browser cannot decode it. Switch Connection to RTSP, choose the Sub stream, or set the camera\'s main stream to H.264.', true);
        }
    }

    function onStatistics(stats) {
        if (activeBackend !== 'flv') {
            return;   // relay modes render their stats from the relay's status
        }
        var speed = stats.speed ? (stats.speed / 1024).toFixed(2) + ' MB/s' : '';
        var dropped = stats.droppedFrames ? '  ·  dropped ' + stats.droppedFrames : '';
        el.stats.textContent = describeMediaInfo(lastMediaInfo) +
            (speed ? '\n' + speed : '') + dropped + bufferLag() +
            '\n' + maskPassword(buildStreamUrl(settings));
    }

    function explainError(type, detail, info) {
        var message = (info && info.msg) ? info.msg : '';
        if (type === 'NetworkError') {
            if (activeBackend === 'mse') {
                return 'The relay stream dropped.';
            }
            if (/40[13]/.test(message) || (info && (info.code === 401 || info.code === 403))) {
                return 'Login rejected. Check the username and password.';
            }
            if (info && info.code === 404) {
                return 'Camera reachable but no FLV stream at that URL. Check the channel number and that the firmware supports FLV.';
            }
            return 'Cannot reach the camera at ' + settings.host +
                (settings.port !== '80' ? ':' + settings.port : '') + '. Check the IP, port and that the TV is on the same network.';
        }
        if (type === 'MediaError') {
            if (/codec|not supported|unsupported/i.test(message + ' ' + detail)) {
                return activeBackend === 'mse'
                    ? 'The browser player cannot decode this stream. Set Player to TV player (AVPlay).'
                    : 'The TV cannot decode this stream. Switch Connection to RTSP, use the Sub stream, or set the camera to H.264.';
            }
            return 'Playback error: ' + (detail || message);
        }
        return 'Error: ' + type + ' ' + (detail || '') + ' ' + message;
    }

    function onPlayerError(type, detail, info) {
        if (activeBackend === 'mse' && type === 'MediaError' && settings.rtspPlayer === 'auto' && !mseFailedForRelay) {
            switchToAvPlay();
            return;
        }
        scheduleReconnect(explainError(type, detail, info));
    }

    function startMsePlayer(url, type, hasAudio) {
        if (!window.mpegts || !window.mpegts.isSupported()) {
            setStatus('This TV does not support Media Source Extensions. ' +
                (settings.mode === 'rtsp' ? 'Set Player to TV player (AVPlay).' : 'Switch Connection to RTSP and Player to TV player.'), true);
            return;
        }
        player = window.mpegts.createPlayer({
            type: type,
            isLive: true,
            url: url,
            hasVideo: true,
            hasAudio: hasAudio
        }, MPEGTS_CONFIG);

        player.attachMediaElement(el.video);
        player.on(window.mpegts.Events.ERROR, onPlayerError);
        player.on(window.mpegts.Events.MEDIA_INFO, onMediaInfo);
        player.on(window.mpegts.Events.STATISTICS_INFO, onStatistics);
        player.on(window.mpegts.Events.LOADING_COMPLETE, function () {
            scheduleReconnect(activeBackend === 'mse' ? 'The relay closed the stream.' : 'The camera closed the stream.');
        });

        player.load();
        var playPromise = player.play();
        if (playPromise && typeof playPromise.catch === 'function') {
            playPromise.catch(function (err) {
                setStatus('Playback could not start: ' + (err && err.message ? err.message : err), true);
            });
        }
    }

    function startFlvPlayback() {
        activeBackend = 'flv';
        var url = buildStreamUrl(settings);
        setStatus('Connecting to ' + settings.host + ' (channel ' + settings.channel + ', ' + settings.stream + ' stream)…');
        el.stats.textContent = maskPassword(url);
        startMsePlayer(url, 'flv', settings.audio === 'on');
    }

    function destroyMsePlayer() {
        if (!player) {
            return;
        }
        try {
            player.pause();
            player.unload();
            player.detachMediaElement();
            player.destroy();
        } catch (e) {
            // Ignore teardown errors; a fresh player is created on the next start.
        }
        player = null;
    }

    // ------------------------------------------------------------------ relay service (RTSP mode)

    function relayRequest(method, path, body, cb) {
        var xhr = new XMLHttpRequest();
        xhr.open(method, RELAY_BASE + path, true);
        xhr.timeout = 4000;
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4) {
                return;
            }
            if (xhr.status === 0) {
                cb(new Error('relay unreachable'));
                return;
            }
            var data = null;
            try {
                data = JSON.parse(xhr.responseText);
            } catch (e) {
                data = null;
            }
            cb(null, data || {}, xhr.status);
        };
        xhr.ontimeout = function () {
            cb(new Error('relay timeout'));
        };
        if (body) {
            xhr.setRequestHeader('Content-Type', 'application/json');
            xhr.send(JSON.stringify(body));
        } else {
            xhr.send();
        }
    }

    function relayServiceId() {
        try {
            var info = window.tizen.application.getCurrentApplication().appInfo;
            return (info.packageId || info.id.split('.')[0]) + '.relay';
        } catch (e) {
            return null;   // desktop browser: run `node service/relay.js` by hand
        }
    }

    function launchRelayService(cb) {
        var id = relayServiceId();
        if (!id) {
            cb(null);
            return;
        }
        try {
            window.tizen.application.launch(id, function () { cb(null); }, function (e) { cb(e); });
        } catch (e) {
            cb(e);
        }
    }

    // Make sure the relay answers; launch it if it is not running yet.
    function ensureRelay(cb) {
        relayRequest('GET', '/ping', null, function (err, data) {
            if (!err && data.ok) {
                cb(null);
                return;
            }
            launchRelayService(function (launchErr) {
                var tries = 0;
                (function poll() {
                    relayRequest('GET', '/ping', null, function (err2, data2) {
                        if (!err2 && data2.ok) {
                            cb(null);
                            return;
                        }
                        if (++tries >= RELAY_LAUNCH_TRIES) {
                            var name = launchErr ? String(launchErr.name || launchErr.message || '') : '';
                            if (/NotFound/i.test(name)) {
                                cb(new Error('RTSP mode needs the full package (ReolinkViewer.wgt, 2018 and newer TVs). This installation has no relay service.'));
                            } else {
                                cb(new Error('The relay service did not start' + (name ? ' (' + name + ')' : '') + '.'));
                            }
                            return;
                        }
                        setTimeout(poll, 300);
                    });
                }());
            });
        });
    }

    function stopRelaySession() {
        clearInterval(relayPollTimer);
        if (relaySessionId) {
            relaySessionId = null;
            relayRequest('POST', '/stop', {}, function () {});
        }
    }

    function explainRelayError(st) {
        var code = st.errorCode;
        if (code === 'auth') {
            return 'Login rejected by the camera. Check the username and password.';
        }
        if (code === 'unreachable') {
            return 'Cannot reach ' + settings.host + ':' + (settings.rtspPort || '554') +
                ' over RTSP. Check the IP, and that RTSP is enabled on the camera (Network → Advanced → Port Settings).';
        }
        if (code === 'notfound') {
            return 'No stream at the known RTSP paths. Check the channel number, or fill in the RTSP path.';
        }
        if (code === 'busy') {
            return 'The camera refused: too many viewers. Close the Reolink app elsewhere and try again.';
        }
        return st.error || 'Relay error.';
    }

    function startRelayPlayback(token) {
        activeBackend = null;
        lastRelayStatus = null;
        setStatus('Starting the RTSP relay…');
        el.stats.textContent = '';
        ensureRelay(function (err) {
            if (token !== startToken) {
                return;
            }
            if (err) {
                scheduleReconnect(err.message);
                return;
            }
            relayRequest('POST', '/start', {
                host: settings.host,
                port: parseInt(settings.rtspPort, 10) || 554,
                user: settings.user,
                pass: settings.password,
                channel: settings.channel,
                stream: settings.stream,
                path: settings.rtspPath,
                audio: settings.audio === 'on'
            }, function (err2, data) {
                if (token !== startToken) {
                    return;
                }
                if (err2 || !data.ok) {
                    scheduleReconnect('The relay could not start: ' + (err2 ? err2.message : data.error));
                    return;
                }
                relaySessionId = data.id;
                setStatus('Connecting to ' + settings.host + ' over RTSP…');
                el.stats.textContent = data.url || '';
                waitForRelay(token, Date.now());
            });
        });
    }

    // Poll until the relay has video (first keyframe), then pick a player.
    function waitForRelay(token, since) {
        relayRequest('GET', '/status', null, function (err, st) {
            if (token !== startToken) {
                return;
            }
            if (err) {
                scheduleReconnect('Lost contact with the relay.');
                return;
            }
            if (st.state === 'error') {
                scheduleReconnect(explainRelayError(st));
                return;
            }
            if (st.state === 'playing') {
                chooseRelayPlayer(token, st);
                return;
            }
            if (Date.now() - since > RELAY_START_TIMEOUT_MS) {
                scheduleReconnect('The relay got no video from the camera.' + (st.note ? ' ' + st.note + '.' : ''));
                return;
            }
            if (st.state === 'waiting') {
                setStatus('Connected. Waiting for the first keyframe…');
            }
            setTimeout(function () { waitForRelay(token, since); }, 500);
        });
    }

    function chooseRelayPlayer(token, st) {
        var codec = st.video ? st.video.codec : '';
        var choice = settings.rtspPlayer;
        if (choice === 'auto') {
            choice = (!mseFailedForRelay && mseCanPlay(codec)) ? 'mse' : 'avplay';
        }
        lastRelayStatus = st;
        if (choice === 'mse') {
            activeBackend = 'mse';
            setStatus('Opening the browser player (' + (codec === 'H265' ? 'H.265' : 'H.264') + ')…');
            startMsePlayer(RELAY_BASE + '/live.ts?t=' + Date.now(), 'mpegts', !!st.audio);
            startRelayPolling(token);
        } else {
            activeBackend = 'avplay';
            waitForSegments(token, Date.now());
        }
    }

    // MSE gave up on the relay stream mid-way: keep the relay session, hand the
    // stream to AVPlay instead.
    function switchToAvPlay() {
        mseFailedForRelay = true;
        startToken += 1;
        var token = startToken;
        clearInterval(relayPollTimer);
        destroyMsePlayer();
        setStatus('The browser player cannot decode this stream. Switching to the TV player…');
        activeBackend = 'avplay';
        waitForSegments(token, Date.now());
    }

    function waitForSegments(token, since) {
        relayRequest('GET', '/status', null, function (err, st) {
            if (token !== startToken) {
                return;
            }
            if (err) {
                scheduleReconnect('Lost contact with the relay.');
                return;
            }
            if (st.state === 'error') {
                scheduleReconnect(explainRelayError(st));
                return;
            }
            if (st.segments >= HLS_MIN_SEGMENTS) {
                startAvPlayer(token, RELAY_BASE + '/live.m3u8');
                return;
            }
            setStatus('Buffering for the TV player (' + st.segments + '/' + HLS_MIN_SEGMENTS + ')…');
            if (Date.now() - since > 30000) {
                scheduleReconnect('The relay did not produce enough video for the TV player.');
                return;
            }
            setTimeout(function () { waitForSegments(token, since); }, 500);
        });
    }

    // ------------------------------------------------------------------ AVPlay (HLS from the relay)

    function startAvPlayer(token, url) {
        var av = window.webapis && window.webapis.avplay;
        if (!av) {
            scheduleReconnect('AVPlay is not available on this TV. Set Player to Browser (MSE).');
            return;
        }
        try {
            av.open(url);
            av.setDisplayRect(0, 0, window.innerWidth || 1920, window.innerHeight || 1080);
            try {
                av.setDisplayMethod('PLAYER_DISPLAY_MODE_LETTER_BOX');
            } catch (e) {
                // Older firmware: default display method is fine.
            }
            av.setListener({
                onbufferingstart: function () { setStatus('Buffering…'); },
                onbufferingprogress: function () {},
                onbufferingcomplete: function () { reconnectAttempt = 0; setStatus('Live'); },
                oncurrentplaytime: function () {},
                onstreamcompleted: function () { scheduleReconnect('The stream ended.'); },
                onevent: function () {},
                onerror: function (e) { scheduleReconnect('TV player error: ' + e); },
                ondrmevent: function () {},
                onsubtitlechange: function () {}
            });
            avplayActive = true;
            avplayPaused = false;
            document.body.classList.add('avplay');
            el.video.classList.add('hidden');
            el.avObject.classList.remove('hidden');
            setStatus('Opening the TV player…');
            av.prepareAsync(function () {
                if (token !== startToken) {
                    return;
                }
                try {
                    av.play();
                } catch (e) {
                    scheduleReconnect('TV player could not start: ' + (e.message || e));
                    return;
                }
                reconnectAttempt = 0;
                setStatus('Live');
            }, function (e) {
                if (token !== startToken) {
                    return;
                }
                scheduleReconnect('TV player could not open the stream: ' + (e && e.message ? e.message : e));
            });
            startRelayPolling(token);
        } catch (e) {
            scheduleReconnect('TV player error: ' + (e.message || e));
        }
    }

    function stopAvPlayer() {
        if (avplayActive) {
            try { window.webapis.avplay.stop(); } catch (e) { /* already stopped */ }
            try { window.webapis.avplay.close(); } catch (e2) { /* already closed */ }
        }
        avplayActive = false;
        avplayPaused = false;
        document.body.classList.remove('avplay');
        el.video.classList.remove('hidden');
        el.avObject.classList.add('hidden');
    }

    // ------------------------------------------------------------------ relay status polling

    function startRelayPolling(token) {
        clearInterval(relayPollTimer);
        relayPollTimer = setInterval(function () {
            if (token !== startToken) {
                clearInterval(relayPollTimer);
                return;
            }
            relayRequest('GET', '/status', null, function (err, st) {
                if (token !== startToken) {
                    return;
                }
                if (err) {
                    scheduleReconnect('Lost contact with the relay.');
                    return;
                }
                if (st.state === 'error') {
                    scheduleReconnect(explainRelayError(st));
                    return;
                }
                if (st.state === 'stopped' || st.state === 'idle' || (relaySessionId && st.id !== relaySessionId)) {
                    scheduleReconnect('The relay stopped the stream.');
                    return;
                }
                lastRelayStatus = st;
                renderRelayStats(st);
            });
        }, RELAY_POLL_MS);
    }

    function renderRelayStats(st) {
        var parts = [];
        if (st.video) {
            parts.push(st.video.codec === 'H265' ? 'H.265' : 'H.264');
        }
        if (activeBackend === 'mse' && lastMediaInfo && lastMediaInfo.width) {
            parts.push(lastMediaInfo.width + 'x' + lastMediaInfo.height);
        }
        if (st.fps) {
            parts.push(st.fps + ' fps');
        }
        if (st.audio) {
            parts.push('AAC');
        } else if (st.note) {
            parts.push(st.note);
        }
        parts.push(activeBackend === 'avplay' ? 'TV player (HLS)' : 'browser player (MSE)');
        var line2 = st.kbps ? (st.kbps / 1000).toFixed(1) + ' Mbit/s' : '';
        if (st.rtpLost) {
            line2 += '  ·  RTP loss ' + st.rtpLost;
        }
        if (activeBackend === 'mse') {
            line2 += bufferLag();
        }
        el.stats.textContent = parts.join('  ·  ') + (line2 ? '\n' + line2 : '') + '\n' + (st.url || '');
    }

    // ------------------------------------------------------------------ player lifecycle

    function startPlayer() {
        clearTimeout(reconnectTimer);
        startToken += 1;
        clearInterval(relayPollTimer);
        destroyMsePlayer();
        stopAvPlayer();
        lastMediaInfo = null;
        if (settings.mode === 'rtsp') {
            startRelayPlayback(startToken);
        } else {
            startFlvPlayback();
        }
    }

    // Stop everything, including the relay session so the camera's viewer slot is freed.
    function destroyPlayer() {
        startToken += 1;
        destroyMsePlayer();
        stopAvPlayer();
        stopRelaySession();
        activeBackend = null;
    }

    function scheduleReconnect(reason) {
        destroyPlayer();
        reconnectAttempt += 1;
        var delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * Math.pow(2, reconnectAttempt - 1));
        var remaining = Math.round(delay / 1000);
        setStatus(reason + '  Retrying in ' + remaining + 's (attempt ' + reconnectAttempt + '). Press RETURN to go back.', true);

        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(function () {
            if (currentView === 'player') {
                startPlayer();
            }
        }, delay);
    }

    function stopAndReturnToSetup() {
        clearTimeout(reconnectTimer);
        reconnectAttempt = 0;
        destroyPlayer();
        showView('setup');
        setFocus(focusedRow);
    }

    function changeChannel(direction) {
        var row = el.form.querySelector('[data-field="channel"]');
        stepValue(row, direction);
        reconnectAttempt = 0;
        startPlayer();
    }

    function togglePlayPause() {
        if (activeBackend === 'avplay') {
            if (avplayPaused) {
                reconnectAttempt = 0;
                startPlayer();
            } else {
                try { window.webapis.avplay.pause(); } catch (e) { /* ignore */ }
                avplayPaused = true;
                setStatus('Paused');
            }
            return;
        }
        if (!player) {
            return;
        }
        if (el.video.paused) {
            // Resuming a live stream from a stale buffer is pointless: reconnect to the live edge.
            reconnectAttempt = 0;
            startPlayer();
        } else {
            player.pause();
            setStatus('Paused');
        }
    }

    // ------------------------------------------------------------------ video element events

    el.video.addEventListener('playing', function () {
        reconnectAttempt = 0;
        setStatus('Live');
    });
    el.video.addEventListener('waiting', function () {
        if (activeBackend !== 'avplay') {
            setStatus('Buffering…');
        }
    });
    el.video.addEventListener('error', function () {
        if (activeBackend === 'avplay') {
            return;
        }
        var err = el.video.error;
        if (activeBackend === 'mse' && settings.rtspPlayer === 'auto' && !mseFailedForRelay && err && err.code === 3) {
            switchToAvPlay();   // MEDIA_ERR_DECODE
            return;
        }
        scheduleReconnect('Video element error' + (err ? ' (code ' + err.code + ')' : '') + '.');
    });

    // ------------------------------------------------------------------ input handling

    function handleSetupKey(event) {
        var active = document.activeElement;
        var editing = active && active.tagName === 'INPUT';

        if (editing) {
            // The on-screen keyboard owns arrow keys. Enter / Return closes it.
            if (event.keyCode === KEY.ENTER || event.keyCode === KEY.RETURN) {
                commitInput(active);
                active.blur();
                event.preventDefault();
            }
            return;
        }

        switch (event.keyCode) {
            case KEY.UP:
                moveFocus(-1);
                break;
            case KEY.DOWN:
                moveFocus(1);
                break;
            case KEY.LEFT:
                adjustRow(focusedRow, -1);
                break;
            case KEY.RIGHT:
                adjustRow(focusedRow, 1);
                break;
            case KEY.ENTER:
                activateRow(focusedRow);
                break;
            case KEY.RETURN:
            case KEY.EXIT:
                exitApp();
                break;
            default:
                return;
        }
        event.preventDefault();
    }

    function handlePlayerKey(event) {
        switch (event.keyCode) {
            case KEY.RETURN:
                stopAndReturnToSetup();
                break;
            case KEY.EXIT:
                exitApp();
                break;
            case KEY.ENTER:
                toggleOverlay();
                break;
            case KEY.CH_UP:
            case KEY.UP:
                changeChannel(1);
                break;
            case KEY.CH_DOWN:
            case KEY.DOWN:
                changeChannel(-1);
                break;
            case KEY.PLAY_PAUSE:
            case KEY.PLAY:
            case KEY.PAUSE:
                togglePlayPause();
                break;
            case KEY.STOP:
                stopAndReturnToSetup();
                break;
            default:
                return;
        }
        event.preventDefault();
    }

    document.addEventListener('keydown', function (event) {
        if (currentView === 'player') {
            handlePlayerKey(event);
        } else {
            handleSetupKey(event);
        }
    });

    // Mouse / pointer support (Tizen pointer remote, or a desktop browser during development).
    rows.forEach(function (row) {
        row.addEventListener('click', function (event) {
            setFocus(row);
            if (event.target.tagName !== 'INPUT') {
                activateRow(row);
            }
        });
    });
    Array.prototype.slice.call(el.form.querySelectorAll('input')).forEach(function (input) {
        input.addEventListener('blur', function () {
            commitInput(input);
        });
    });
    el.overlay.addEventListener('click', toggleOverlay);
    el.video.addEventListener('click', toggleOverlay);

    function registerTvKeys() {
        try {
            ['MediaPlay', 'MediaPause', 'MediaPlayPause', 'MediaStop', 'ChannelUp', 'ChannelDown']
                .forEach(function (name) {
                    window.tizen.tvinputdevice.registerKey(name);
                });
        } catch (e) {
            // Not on a Tizen TV; the standard keys still work.
        }
    }

    // Free the decoder (and the camera's viewer slot) when the app goes to the
    // background; reconnect when it comes back.
    document.addEventListener('visibilitychange', function () {
        if (currentView !== 'player') {
            return;
        }
        if (document.hidden) {
            clearTimeout(reconnectTimer);
            destroyPlayer();
        } else {
            reconnectAttempt = 0;
            startPlayer();
        }
    });

    // ------------------------------------------------------------------ boot

    registerTvKeys();
    renderForm();
    setFocus(settings.host ? visibleRows().length - 1 : 0);

    if (settings.autoconnect === 'on' && !validateSettings()) {
        showView('player');
        startPlayer();
    }
}());
