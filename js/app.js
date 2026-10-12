/*
 * Reolink Viewer for Samsung Tizen TVs.
 *
 * Plays the camera's HTTP-FLV live stream (H.264 + AAC) through Media Source
 * Extensions using mpegts.js. Everything stays on the local network; the only
 * thing the app talks to is the camera / NVR the user typed in.
 */
(function () {
    'use strict';

    var STORAGE_KEY = 'reolink-viewer-settings';

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
        autoconnect: 'off'
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

    var settings = loadSettings();

    var el = {
        setup: document.getElementById('view-setup'),
        player: document.getElementById('view-player'),
        form: document.getElementById('form'),
        setupMessage: document.getElementById('setup-message'),
        video: document.getElementById('video'),
        overlay: document.getElementById('overlay'),
        status: document.getElementById('status'),
        stats: document.getElementById('stats')
    };

    var rows = Array.prototype.slice.call(el.form.querySelectorAll('.focusable'));
    var focusIndex = 0;
    var currentView = 'setup';

    var player = null;
    var reconnectTimer = null;
    var reconnectAttempt = 0;
    var overlayTimer = null;
    var lastMediaInfo = null;

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

    function renderRow(row) {
        var field = row.getAttribute('data-field');
        if (!field) {
            return;
        }
        var type = row.getAttribute('data-type');
        if (type === 'text') {
            row.querySelector('input').value = settings[field];
        } else {
            row.querySelector('.value').textContent = String(settings[field]);
        }
    }

    function renderForm() {
        rows.forEach(renderRow);
    }

    function setFocus(index) {
        focusIndex = Math.max(0, Math.min(rows.length - 1, index));
        rows.forEach(function (row, i) {
            row.classList.toggle('focused', i === focusIndex);
        });
        rows[focusIndex].scrollIntoView({ block: 'nearest' });
    }

    function cycleOption(row, direction) {
        var field = row.getAttribute('data-field');
        var options = row.getAttribute('data-options').split(',');
        var index = options.indexOf(String(settings[field]));
        index = (index + direction + options.length) % options.length;
        settings[field] = options[index];
        renderRow(row);
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
        if (settings.port && !/^\d+$/.test(settings.port)) {
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
        try {
            window.tizen.application.getCurrentApplication().exit();
        } catch (e) {
            // Not running on Tizen (e.g. desktop browser during development).
        }
    }

    // ------------------------------------------------------------------ player

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

    function onMediaInfo(info) {
        lastMediaInfo = info;
        if (/hevc|hvc1|hev1|h265/i.test(info.videoCodec || '')) {
            setStatus('Stream is H.265. Select the Sub stream, or set the camera\'s main stream to H.264.', true);
        }
    }

    function onStatistics(stats) {
        var speed = stats.speed ? (stats.speed / 1024).toFixed(2) + ' MB/s' : '';
        var dropped = stats.droppedFrames ? '  ·  dropped ' + stats.droppedFrames : '';
        var latency = '';
        if (el.video.buffered.length) {
            var lag = el.video.buffered.end(el.video.buffered.length - 1) - el.video.currentTime;
            latency = '  ·  buffer ' + lag.toFixed(1) + 's';
        }
        el.stats.textContent = describeMediaInfo(lastMediaInfo) +
            (speed ? '\n' + speed : '') + dropped + latency +
            '\n' + maskPassword(buildStreamUrl(settings));
    }

    function explainError(type, detail, info) {
        var message = (info && info.msg) ? info.msg : '';
        if (type === 'NetworkError') {
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
                return 'The TV cannot decode this stream. Use the Sub stream or set the camera to H.264.';
            }
            return 'Playback error: ' + (detail || message);
        }
        return 'Error: ' + type + ' ' + (detail || '') + ' ' + message;
    }

    function onPlayerError(type, detail, info) {
        scheduleReconnect(explainError(type, detail, info));
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

    function startPlayer() {
        clearTimeout(reconnectTimer);
        destroyPlayer();

        if (!window.mpegts || !window.mpegts.isSupported()) {
            setStatus('This TV does not support Media Source Extensions for live H.264 FLV. Playback is not possible on this model.', true);
            return;
        }

        var url = buildStreamUrl(settings);
        setStatus('Connecting to ' + settings.host + ' (channel ' + settings.channel + ', ' + settings.stream + ' stream)…');
        el.stats.textContent = maskPassword(url);

        player = window.mpegts.createPlayer({
            type: 'flv',
            isLive: true,
            url: url,
            hasVideo: true,
            hasAudio: settings.audio === 'on'
        }, MPEGTS_CONFIG);

        player.attachMediaElement(el.video);
        player.on(window.mpegts.Events.ERROR, onPlayerError);
        player.on(window.mpegts.Events.MEDIA_INFO, onMediaInfo);
        player.on(window.mpegts.Events.STATISTICS_INFO, onStatistics);
        player.on(window.mpegts.Events.LOADING_COMPLETE, function () {
            scheduleReconnect('The camera closed the stream.');
        });

        player.load();
        var playPromise = player.play();
        if (playPromise && typeof playPromise.catch === 'function') {
            playPromise.catch(function (err) {
                setStatus('Playback could not start: ' + (err && err.message ? err.message : err), true);
            });
        }
    }

    function destroyPlayer() {
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

    function stopAndReturnToSetup() {
        clearTimeout(reconnectTimer);
        reconnectAttempt = 0;
        destroyPlayer();
        showView('setup');
        setFocus(focusIndex);
    }

    function changeChannel(direction) {
        var row = el.form.querySelector('[data-field="channel"]');
        stepValue(row, direction);
        reconnectAttempt = 0;
        startPlayer();
    }

    function togglePlayPause() {
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
        setStatus('Buffering…');
    });
    el.video.addEventListener('error', function () {
        var err = el.video.error;
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

        var row = rows[focusIndex];
        switch (event.keyCode) {
            case KEY.UP:
                setFocus(focusIndex - 1);
                break;
            case KEY.DOWN:
                setFocus(focusIndex + 1);
                break;
            case KEY.LEFT:
                adjustRow(row, -1);
                break;
            case KEY.RIGHT:
                adjustRow(row, 1);
                break;
            case KEY.ENTER:
                activateRow(row);
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
    rows.forEach(function (row, index) {
        row.addEventListener('click', function (event) {
            if (event.target.tagName === 'INPUT') {
                setFocus(index);
                return;
            }
            setFocus(index);
            activateRow(row);
        });
    });
    Array.prototype.slice.call(el.form.querySelectorAll('input')).forEach(function (input) {
        input.addEventListener('blur', function () {
            commitInput(input);
        });
    });
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

    // Free the decoder when the app goes to the background; reconnect when it comes back.
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
    setFocus(settings.host ? rows.length - 1 : 0);

    if (settings.autoconnect === 'on' && !validateSettings()) {
        showView('player');
        startPlayer();
    }
}());
