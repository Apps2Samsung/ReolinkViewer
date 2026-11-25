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
 * Up to four cameras (or NVR channels) can be saved. One plays full screen as
 * described above; the grid shows all of them at once as small muted players
 * on the Sub stream, each with its own mpegts.js player and, in RTSP mode,
 * its own slot in the relay.
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

    var MAX_CAMERAS = 4;

    // Per camera.
    var CAMERA_DEFAULTS = {
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
        rtspPlayer: 'auto'      // 'auto' | 'mse' | 'avplay'
    };

    // For the app as a whole (form rows marked data-scope="app").
    var APP_DEFAULTS = {
        camera: 1,              // 1-based: the camera the form edits and the player shows
        view: 'single',         // 'single' | 'grid'
        autoconnect: 'off'
    };

    // Display names for toggle values that are not self-explanatory.
    var LABELS = {
        flv: 'HTTP-FLV (H.264)',
        rtsp: 'RTSP via relay (H.264 / H.265)',
        auto: 'Automatic',
        mse: 'Browser (MSE)',
        avplay: 'TV player (AVPlay)',
        single: 'One camera',
        grid: 'All cameras in a grid'
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

    var GRID_COLUMNS = 2;
    var GRID_STREAM = 'sub';              // tiles are small: the light H.264 stream is enough
    var GRID_STALL_MS = 20000;            // a tile must show a picture in this time

    var store = loadStore();
    var settings = store.cameras[store.camera - 1];   // the selected camera

    var el = {
        setup: document.getElementById('view-setup'),
        player: document.getElementById('view-player'),
        gridView: document.getElementById('view-grid'),
        grid: document.getElementById('grid'),
        gridHint: document.getElementById('grid-hint'),
        form: document.getElementById('form'),
        setupMessage: document.getElementById('setup-message'),
        video: document.getElementById('video'),
        avObject: document.getElementById('av-player'),
        overlay: document.getElementById('overlay'),
        status: document.getElementById('status'),
        stats: document.getElementById('stats')
    };

    var rows = Array.prototype.slice.call(el.form.querySelectorAll('.focusable'));
    var hostRow = el.form.querySelector('[data-field="host"]');
    var cameraRow = el.form.querySelector('[data-field="camera"]');
    var focusedRow = null;
    var currentView = 'setup';      // 'setup' | 'player' | 'grid'

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

    var relayUsed = false;          // the relay answered at least once: tell it to stop on exit
    var relayWaiters = null;        // callbacks waiting for one shared ensureRelay() round
    var tiles = [];                 // the grid's Tile objects
    var gridFocus = 0;              // index into tiles
    var gridHintTimer = null;
    var returnToGrid = false;       // the full-screen player was opened from the grid

    // ------------------------------------------------------------------ settings

    function withDefaults(saved, defaults) {
        var merged = {};
        Object.keys(defaults).forEach(function (key) {
            merged[key] = saved && saved.hasOwnProperty(key) ? saved[key] : defaults[key];
        });
        return merged;
    }

    function loadStore() {
        var saved = {};
        try {
            saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '{}') || {};
        } catch (e) {
            saved = {};
        }
        // Before the grid there was one camera, saved as a flat object: it becomes camera 1.
        var savedCameras = Array.isArray(saved.cameras) ? saved.cameras : [saved];
        var loaded = withDefaults(saved, APP_DEFAULTS);
        loaded.cameras = [];
        for (var i = 0; i < MAX_CAMERAS; i++) {
            loaded.cameras.push(withDefaults(savedCameras[i], CAMERA_DEFAULTS));
        }
        loaded.camera = Math.max(1, Math.min(MAX_CAMERAS, parseInt(loaded.camera, 10) || 1));
        return loaded;
    }

    function saveSettings() {
        try {
            window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
        } catch (e) {
            // Storage unavailable: the app still works for this session.
        }
    }

    // Indexes of the cameras that have an address: the ones the grid shows.
    function configuredCameras() {
        var list = [];
        store.cameras.forEach(function (camera, index) {
            if (camera.host) {
                list.push(index);
            }
        });
        return list;
    }

    // Make camera `number` (1-based) the one the form edits and the player shows.
    function selectCamera(number) {
        store.camera = number;
        settings = store.cameras[number - 1];
        if (!settings.host) {
            // An unused camera starts as a copy of a neighbour, minus the address:
            // login and connection settings are usually the same on every camera.
            var used = configuredCameras();
            if (used.length) {
                var source = store.cameras[used[0]];
                used.forEach(function (index) {
                    if (index < number - 1) {
                        source = store.cameras[index];
                    }
                });
                Object.keys(CAMERA_DEFAULTS).forEach(function (key) {
                    if (key !== 'host') {
                        settings[key] = source[key];
                    }
                });
            }
        }
        saveSettings();
        renderForm();
    }

    function cameraName(index) {
        var camera = store.cameras[index];
        return 'Camera ' + (index + 1) + '  ·  ' + camera.host +
            (parseInt(camera.channel, 10) > 0 ? '  ·  channel ' + camera.channel : '');
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

    // The object a row's field lives in: the app-wide settings or the selected camera.
    function fieldOwner(row) {
        return row.getAttribute('data-scope') === 'app' ? store : settings;
    }

    function renderRow(row) {
        var field = row.getAttribute('data-field');
        if (!field) {
            return;
        }
        var type = row.getAttribute('data-type');
        if (type === 'text') {
            row.querySelector('input').value = settings[field];
        } else if (field === 'camera') {
            row.querySelector('.value').textContent = store.camera + '  ·  ' + (settings.host || 'not set up');
        } else {
            var value = String(fieldOwner(row)[field]);
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
        var owner = fieldOwner(row);
        var index = options.indexOf(String(owner[field]));
        index = (index + direction + options.length) % options.length;
        owner[field] = options[index];
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
        var owner = fieldOwner(row);
        var value = Math.max(min, Math.min(max, parseInt(owner[field], 10) + direction));
        if (field === 'camera') {
            selectCamera(value);
            return;
        }
        owner[field] = value;
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
        if (field === 'host') {
            renderRow(cameraRow);
        }
    }

    function showSetupMessage(text) {
        el.setupMessage.textContent = text || '';
    }

    function validateCamera(camera) {
        if (!camera.host) {
            return 'Enter the camera IP address first.';
        }
        if (camera.mode === 'rtsp') {
            if (camera.rtspPort && !/^\d+$/.test(camera.rtspPort)) {
                return 'RTSP port must be a number.';
            }
        } else if (camera.port && !/^\d+$/.test(camera.port)) {
            return 'Port must be a number.';
        }
        return null;
    }

    // What stops Start from working, as { message, row }, or null when it can go ahead.
    function startProblem() {
        if (store.view !== 'grid') {
            var message = validateCamera(settings);
            return message ? { message: message, row: hostRow } : null;
        }
        var used = configuredCameras();
        if (used.length < 2) {
            return {
                message: 'The grid needs at least two cameras. Choose another Camera number and enter its IP address, or set View to One camera.',
                row: cameraRow
            };
        }
        for (var i = 0; i < used.length; i++) {
            var problem = validateCamera(store.cameras[used[i]]);
            if (problem) {
                return { message: 'Camera ' + (used[i] + 1) + ': ' + problem, row: cameraRow };
            }
        }
        return null;
    }

    function start() {
        showSetupMessage('');
        if (store.view === 'grid') {
            gridFocus = Math.max(0, configuredCameras().indexOf(store.camera - 1));
            showView('grid');
            startGrid();
        } else {
            returnToGrid = false;
            openPlayer();
        }
    }

    function startFromForm() {
        var problem = startProblem();
        if (problem) {
            showSetupMessage(problem.message);
            setFocus(problem.row);
            return;
        }
        start();
    }

    // Show the selected camera full screen.
    function openPlayer() {
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
        el.gridView.classList.toggle('hidden', name !== 'grid');
    }

    function exitApp() {
        relaySessionId = null;
        if (relayUsed) {
            relayRequest('POST', '/stop', { all: true }, function () {});
        }
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
                relayUsed = true;
                cb(null);
                return;
            }
            launchRelayService(function (launchErr) {
                var tries = 0;
                (function poll() {
                    relayRequest('GET', '/ping', null, function (err2, data2) {
                        if (!err2 && data2.ok) {
                            relayUsed = true;
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

    // The same, for several callers at once (the grid's tiles): one round of
    // pinging and launching serves them all.
    function ensureRelayShared(cb) {
        if (relayWaiters) {
            relayWaiters.push(cb);
            return;
        }
        relayWaiters = [cb];
        ensureRelay(function (err) {
            var waiting = relayWaiters;
            relayWaiters = null;
            waiting.forEach(function (waiter) { waiter(err); });
        });
    }

    function stopRelaySession() {
        clearInterval(relayPollTimer);
        if (relaySessionId) {
            relaySessionId = null;
            relayRequest('POST', '/stop', {}, function () {});
        }
    }

    function explainRelayError(st, camera) {
        var code = st.errorCode;
        if (code === 'auth') {
            return 'Login rejected by the camera. Check the username and password.';
        }
        if (code === 'unreachable') {
            return 'Cannot reach ' + camera.host + ':' + (camera.rtspPort || '554') +
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
                scheduleReconnect(explainRelayError(st, settings));
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
                scheduleReconnect(explainRelayError(st, settings));
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
                    scheduleReconnect(explainRelayError(st, settings));
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

    // Leave the full-screen player: back to the grid it was opened from, or to setup.
    function closePlayer() {
        clearTimeout(reconnectTimer);
        reconnectAttempt = 0;
        destroyPlayer();
        if (returnToGrid) {
            returnToGrid = false;
            showView('grid');
            startGrid();
        } else {
            showView('setup');
            setFocus(focusedRow);
        }
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

    // ------------------------------------------------------------------ camera grid

    // One camera in the grid: a muted player on the Sub stream. Tiles always use
    // mpegts.js; AVPlay has a single hardware plane, so it cannot draw several.
    function Tile(cameraIndex, slot) {
        var self = this;
        this.cameraIndex = cameraIndex;
        this.camera = store.cameras[cameraIndex];
        this.slot = slot;               // this tile's session in the relay (RTSP mode)
        this.token = 0;                 // bumps on every (re)start; stale async steps check it
        this.player = null;
        this.relayStarted = false;
        this.attempt = 0;
        this.retryTimer = null;
        this.stallTimer = null;

        this.root = document.createElement('div');
        this.root.className = 'tile';
        this.video = document.createElement('video');
        this.video.muted = true;
        this.video.setAttribute('playsinline', '');
        this.note = document.createElement('div');
        this.note.className = 'tile-note';
        var label = document.createElement('div');
        label.className = 'tile-label';
        label.textContent = cameraName(cameraIndex);
        var frame = document.createElement('div');
        frame.className = 'tile-frame';
        [this.video, this.note, label, frame].forEach(function (child) {
            self.root.appendChild(child);
        });

        this.video.addEventListener('playing', function () {
            self.attempt = 0;
            clearTimeout(self.stallTimer);
            self.setNote('');
        });
        this.video.addEventListener('error', function () {
            if (self.player) {
                self.fail('The TV cannot decode this stream.');
            }
        });
    }

    Tile.prototype.setNote = function (text, isError) {
        this.note.textContent = text;
        this.note.classList.toggle('error', !!isError);
    };

    Tile.prototype.start = function () {
        this.closePlayer();
        var token = this.token;
        this.setNote('Connecting…');
        if (this.camera.mode === 'rtsp') {
            this.startRelay(token);
        } else {
            var options = {};
            Object.keys(this.camera).forEach(function (key) { options[key] = this.camera[key]; }, this);
            options.stream = GRID_STREAM;
            this.play(buildStreamUrl(options), 'flv');
        }
    };

    Tile.prototype.startRelay = function (token) {
        var self = this;
        var camera = this.camera;
        ensureRelayShared(function (err) {
            if (token !== self.token) {
                return;
            }
            if (err) {
                self.fail(err.message);
                return;
            }
            relayRequest('POST', '/start', {
                slot: self.slot,
                host: camera.host,
                port: parseInt(camera.rtspPort, 10) || 554,
                user: camera.user,
                pass: camera.password,
                channel: camera.channel,
                stream: GRID_STREAM,
                path: camera.rtspPath,
                audio: false
            }, function (err2, data) {
                if (token !== self.token) {
                    return;
                }
                if (err2 || !data.ok) {
                    self.fail('The relay could not start: ' + (err2 ? err2.message : data.error));
                    return;
                }
                self.relayStarted = true;
                self.waitForRelay(token, Date.now());
            });
        });
    };

    // Poll until the relay has video (first keyframe), then play it.
    Tile.prototype.waitForRelay = function (token, since) {
        var self = this;
        relayRequest('GET', '/status?slot=' + this.slot, null, function (err, st) {
            if (token !== self.token) {
                return;
            }
            if (err) {
                self.fail('Lost contact with the relay.');
                return;
            }
            if (st.state === 'error') {
                self.fail(explainRelayError(st, self.camera));
                return;
            }
            if (st.state === 'playing') {
                var codec = st.video ? st.video.codec : '';
                if (!mseCanPlay(codec)) {
                    // Retrying will not help; free the camera's viewer slot.
                    self.stop();
                    self.setNote('This stream is ' + (codec === 'H265' ? 'H.265' : codec) +
                        ', which this TV cannot show in the grid. Press OK to watch it full screen.', true);
                    return;
                }
                self.play(RELAY_BASE + '/live.ts?slot=' + self.slot + '&t=' + Date.now(), 'mpegts');
                return;
            }
            if (Date.now() - since > RELAY_START_TIMEOUT_MS) {
                self.fail('The relay got no video from the camera.');
                return;
            }
            setTimeout(function () { self.waitForRelay(token, since); }, 500);
        });
    };

    Tile.prototype.play = function (url, type) {
        var self = this;
        if (!window.mpegts || !window.mpegts.isSupported()) {
            this.setNote('This TV does not support Media Source Extensions, which the grid needs.', true);
            return;
        }
        this.player = window.mpegts.createPlayer({
            type: type,
            isLive: true,
            url: url,
            hasVideo: true,
            hasAudio: false
        }, MPEGTS_CONFIG);
        this.player.attachMediaElement(this.video);
        this.player.on(window.mpegts.Events.ERROR, function (errorType, detail, info) {
            self.fail(self.explainError(errorType, detail, info));
        });
        this.player.on(window.mpegts.Events.LOADING_COMPLETE, function () {
            self.fail('The stream closed.');
        });
        this.player.load();
        var playPromise = this.player.play();
        if (playPromise && typeof playPromise.catch === 'function') {
            playPromise.catch(function () {
                // The stall timer reports a player that never starts.
            });
        }
        this.stallTimer = setTimeout(function () {
            self.fail('No picture. This TV may not be able to play this many streams at once.');
        }, GRID_STALL_MS);
    };

    Tile.prototype.explainError = function (type, detail, info) {
        if (type === 'NetworkError') {
            if (this.camera.mode === 'rtsp') {
                return 'The relay stream dropped.';
            }
            if (info && (info.code === 401 || info.code === 403)) {
                return 'Login rejected.';
            }
            return 'Cannot reach ' + this.camera.host + '.';
        }
        if (type === 'MediaError') {
            return 'The TV cannot decode this stream.';
        }
        return 'Error: ' + type + ' ' + (detail || '');
    };

    // Give up on this attempt and try again later, with increasing delays.
    Tile.prototype.fail = function (reason) {
        var self = this;
        this.stop();
        this.attempt += 1;
        var delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * Math.pow(2, this.attempt - 1));
        this.setNote(reason + '  Retrying in ' + Math.round(delay / 1000) + 's.', true);
        this.retryTimer = setTimeout(function () { self.start(); }, delay);
    };

    Tile.prototype.closePlayer = function () {
        this.token += 1;
        clearTimeout(this.retryTimer);
        clearTimeout(this.stallTimer);
        if (!this.player) {
            return;
        }
        try {
            this.player.pause();
            this.player.unload();
            this.player.detachMediaElement();
            this.player.destroy();
        } catch (e) {
            // Ignore teardown errors; a fresh player is created on the next start.
        }
        this.player = null;
    };

    // Stop everything, including the relay session so the camera's viewer slot is freed.
    Tile.prototype.stop = function () {
        this.closePlayer();
        if (this.relayStarted) {
            this.relayStarted = false;
            relayRequest('POST', '/stop', { slot: this.slot }, function () {});
        }
    };

    function stopGrid() {
        tiles.forEach(function (tile) { tile.stop(); });
    }

    // Build a tile for every camera that has an address and connect them all.
    function startGrid() {
        stopGrid();
        el.grid.innerHTML = '';
        tiles = configuredCameras().map(function (cameraIndex, position) {
            var tile = new Tile(cameraIndex, 'tile' + position);
            tile.root.addEventListener('click', function () {
                setGridFocus(position);
                openFocusedTile();
            });
            el.grid.appendChild(tile.root);
            return tile;
        });
        el.grid.className = 'grid ' + (tiles.length > GRID_COLUMNS ? 'grid-rows-2' : 'grid-rows-1');
        setGridFocus(gridFocus);
        showGridHint();
        tiles.forEach(function (tile) { tile.start(); });
    }

    function setGridFocus(index) {
        gridFocus = Math.max(0, Math.min(tiles.length - 1, index));
        tiles.forEach(function (tile, position) {
            tile.root.classList.toggle('focused', position === gridFocus);
        });
    }

    function moveGridFocus(columns, rowsDown) {
        var column = gridFocus % GRID_COLUMNS + columns;
        var target = gridFocus + columns + rowsDown * GRID_COLUMNS;
        if (column >= 0 && column < GRID_COLUMNS && target >= 0 && target < tiles.length) {
            setGridFocus(target);
        }
    }

    function showGridHint() {
        el.gridHint.classList.remove('faded');
        clearTimeout(gridHintTimer);
        gridHintTimer = setTimeout(function () {
            el.gridHint.classList.add('faded');
        }, OVERLAY_HIDE_MS);
    }

    // Watch the highlighted camera full screen, with its own stream and audio
    // settings. The tiles close first: the TV may have only one decoder to give.
    function openFocusedTile() {
        var tile = tiles[gridFocus];
        if (!tile) {
            return;
        }
        stopGrid();
        returnToGrid = true;
        selectCamera(tile.cameraIndex + 1);
        openPlayer();
    }

    function closeGrid() {
        stopGrid();
        showView('setup');
        setFocus(focusedRow);
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
                closePlayer();
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
                closePlayer();
                break;
            default:
                return;
        }
        event.preventDefault();
    }

    function handleGridKey(event) {
        showGridHint();
        switch (event.keyCode) {
            case KEY.LEFT:
                moveGridFocus(-1, 0);
                break;
            case KEY.RIGHT:
                moveGridFocus(1, 0);
                break;
            case KEY.UP:
                moveGridFocus(0, -1);
                break;
            case KEY.DOWN:
                moveGridFocus(0, 1);
                break;
            case KEY.ENTER:
                openFocusedTile();
                break;
            case KEY.RETURN:
            case KEY.STOP:
                closeGrid();
                break;
            case KEY.EXIT:
                exitApp();
                break;
            default:
                return;
        }
        event.preventDefault();
    }

    document.addEventListener('keydown', function (event) {
        if (currentView === 'player') {
            handlePlayerKey(event);
        } else if (currentView === 'grid') {
            handleGridKey(event);
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
        if (currentView === 'grid') {
            if (document.hidden) {
                stopGrid();
            } else {
                startGrid();
            }
            return;
        }
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
    setFocus(settings.host ? visibleRows().length - 1 : hostRow);

    if (store.autoconnect === 'on' && !startProblem()) {
        start();
    }
}());
