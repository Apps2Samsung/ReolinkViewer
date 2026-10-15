/* ============================================================================
 * Reolink Viewer — RTSP relay service  (Tizen Web Service application)
 * ----------------------------------------------------------------------------
 * The web app can only do HTTP, so it plays the camera's HTTP-FLV stream, and
 * that stream is H.264 only. The full-quality H.265 main stream is on RTSP,
 * which needs a raw TCP socket. This service runs on the TV's Node runtime,
 * which can open one, and turns RTSP into something the web app can play:
 *
 *   Camera --RTSP/RTP over TCP--> this service --MPEG-TS on 127.0.0.1--> web app
 *
 * It does not transcode. RTP packets are unwrapped into H.265 / H.264 access
 * units and AAC frames, and those are wrapped again into MPEG-TS. The same TS
 * is served two ways:
 *
 *   GET  /live.ts        one endless chunked response, from the latest
 *                        keyframe onward, for mpegts.js + Media Source
 *                        Extensions (lowest delay)
 *   GET  /live.m3u8      a live HLS playlist of the last few seconds, for
 *                        Samsung's AVPlay when MSE cannot decode H.265
 *   GET  /seg/<n>.ts     one HLS segment
 *
 * Control:
 *   GET  /ping           { ok, version, running }
 *   POST /start          { host, port, user, pass, channel, stream, path, audio }
 *   POST /stop
 *   GET  /status         what the relay is doing, codecs, bitrate, errors
 *   GET  /log            the last few hundred log lines
 *
 * One camera at a time. Starting a new session stops the previous one. A
 * session with nobody reading its output is closed after a minute, because
 * Reolink counts the relay as a viewer and viewer slots are scarce.
 *
 * Self-contained on purpose: no npm dependencies, pure ES5, and only the
 * parts of Buffer the TV's old Node build is known to have (see the shims).
 * ==========================================================================*/

var http   = require('http');
var net    = require('net');
var crypto = require('crypto');
var urlMod = require('url');

var VERSION = '1.1.0';
var PORT        = 8129;
var LISTEN_HOST = '127.0.0.1';

/* The TV's Node runtime predates Buffer.alloc / Buffer.from. Polyfill onto the
 * legacy constructor. The native Buffer.from, where it exists, rejects plain
 * number arrays, so constant byte buffers go through bytes() below. */
if (typeof Buffer.alloc !== 'function') {
    Buffer.alloc = function (size, fill) {
        var b = new Buffer(size);
        b.fill(fill === undefined ? 0 : fill);
        return b;
    };
}
if (typeof Buffer.from !== 'function') {
    Buffer.from = function (data, encoding) { return new Buffer(data, encoding); };
}
function bytes(arr) {
    var b = Buffer.alloc(arr.length);
    for (var i = 0; i < arr.length; i++) b[i] = arr[i] & 0xFF;
    return b;
}
/* The TV's partial Buffer cannot be trusted with string encodings (Tessel found
 * 'ucs2' and 'binary' throwing), so base64 and ASCII are done by hand. Every
 * string this service handles (RTSP, SDP, auth) is ASCII. */
var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
var B64_INDEX = (function () {
    var t = {};
    for (var i = 0; i < B64.length; i++) t[B64.charAt(i)] = i;
    t['-'] = 62; t['_'] = 63;
    return t;
}());
function bufferFromBase64(s) {
    var clean = String(s).replace(/[^A-Za-z0-9+\/\-_]/g, '');
    var out = Buffer.alloc(Math.floor(clean.length * 3 / 4));
    var n = 0, bits = 0, acc = 0;
    for (var i = 0; i < clean.length; i++) {
        acc = (acc << 6) | B64_INDEX[clean.charAt(i)];
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out[n++] = (acc >> bits) & 0xFF;
        }
    }
    return n === out.length ? out : out.slice(0, n);
}
function base64FromString(s) {
    var out = '';
    for (var i = 0; i < s.length; i += 3) {
        var a = s.charCodeAt(i) & 0xFF;
        var b = i + 1 < s.length ? s.charCodeAt(i + 1) & 0xFF : 0;
        var c = i + 2 < s.length ? s.charCodeAt(i + 2) & 0xFF : 0;
        out += B64.charAt(a >> 2) + B64.charAt(((a & 3) << 4) | (b >> 4)) +
               (i + 1 < s.length ? B64.charAt(((b & 15) << 2) | (c >> 6)) : '=') +
               (i + 2 < s.length ? B64.charAt(c & 63) : '=');
    }
    return out;
}
function asciiString(buf, start, end) {
    start = start || 0;
    end = end === undefined ? buf.length : end;
    var out = '';
    for (var i = start; i < end; i += 4096) {
        var stop = Math.min(end, i + 4096);
        var codes = new Array(stop - i);
        for (var j = i; j < stop; j++) codes[j - i] = buf[j];
        out += String.fromCharCode.apply(null, codes);
    }
    return out;
}

/* ── log ring buffer, surfaced at GET /log ─────────────────────────────── */
var LOGS = [];
function log(msg, data) {
    var line = new Date().toISOString() + ' ' + msg + (data !== undefined ? ' ' + safeJson(data) : '');
    LOGS.push(line);
    if (LOGS.length > 500) LOGS.shift();
    try { console.log(line); } catch (e) {}
}
function safeJson(d) { try { return typeof d === 'object' ? JSON.stringify(d) : String(d); } catch (e) { return ''; } }

/* ============================================================================
 * Digest / Basic authentication (RFC 2617), as RTSP uses the HTTP scheme.
 * ==========================================================================*/
function md5hex(s) { return crypto.createHash('md5').update(s).digest('hex'); }

function parseAuthChallenge(headerValue) {
    var challenges = [];
    var re = /(\w+)\s+((?:[a-zA-Z0-9_-]+=(?:"[^"]*"|[^,\s]*)\s*,?\s*)*)/g;
    var m;
    while ((m = re.exec(headerValue || '')) !== null) {
        if (!m[1]) continue;
        var params = {};
        var pre = /([a-zA-Z0-9_-]+)=("([^"]*)"|([^,\s]*))/g;
        var p;
        while ((p = pre.exec(m[2])) !== null) params[p[1].toLowerCase()] = p[3] !== undefined ? p[3] : p[4];
        challenges.push({ scheme: m[1].toLowerCase(), params: params });
    }
    return challenges;
}

/* Prefer Digest; fall back to Basic. Returns the Authorization header value. */
function buildAuthorization(challenges, user, pass, method, uri, nonceCount) {
    var digest = null, basic = null;
    for (var i = 0; i < challenges.length; i++) {
        if (challenges[i].scheme === 'digest' && !digest) digest = challenges[i].params;
        if (challenges[i].scheme === 'basic' && !basic) basic = challenges[i].params;
    }
    if (digest && digest.nonce !== undefined) {
        var realm = digest.realm || '';
        var ha1 = md5hex(user + ':' + realm + ':' + pass);
        var ha2 = md5hex(method + ':' + uri);
        var qop = (digest.qop || '').split(',')[0].replace(/\s/g, '');
        var response, extra = '';
        if (qop === 'auth') {
            var nc = ('00000000' + (nonceCount || 1).toString(16)).slice(-8);
            var cnonce = crypto.randomBytes(8).toString('hex');
            response = md5hex(ha1 + ':' + digest.nonce + ':' + nc + ':' + cnonce + ':auth:' + ha2);
            extra = ', qop=auth, nc=' + nc + ', cnonce="' + cnonce + '"';
        } else {
            response = md5hex(ha1 + ':' + digest.nonce + ':' + ha2);
        }
        return 'Digest username="' + user + '", realm="' + realm + '", nonce="' + digest.nonce +
               '", uri="' + uri + '", response="' + response + '"' +
               (digest.opaque !== undefined ? ', opaque="' + digest.opaque + '"' : '') +
               (digest.algorithm ? ', algorithm=' + digest.algorithm : '') + extra;
    }
    if (basic) {
        return 'Basic ' + base64FromString(user + ':' + pass);
    }
    return null;
}

/* ============================================================================
 * SDP parsing: just the media sections and the attributes we act on.
 * ==========================================================================*/
function parseSdp(text) {
    var session = { control: null, media: [] };
    var current = null;
    var lines = text.split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        if (line.length < 2 || line.charAt(1) !== '=') continue;
        var type = line.charAt(0), value = line.slice(2).trim();
        if (type === 'm') {
            var parts = value.split(/\s+/);
            current = { kind: parts[0], payloadType: parseInt(parts[3], 10), control: null,
                        codec: null, clock: 90000, channels: 1, fmtp: {}, raw: value };
            session.media.push(current);
            continue;
        }
        if (type !== 'a') continue;
        var colon = value.indexOf(':');
        var name = colon < 0 ? value : value.slice(0, colon);
        var body = colon < 0 ? '' : value.slice(colon + 1);
        var target = current || session;
        if (name === 'control') {
            target.control = body;
        } else if (name === 'rtpmap' && current) {
            var rm = /^(\d+)\s+([^\/]+)\/(\d+)(?:\/(\d+))?/.exec(body);
            if (rm && parseInt(rm[1], 10) === current.payloadType) {
                current.codec = rm[2].toUpperCase();
                current.clock = parseInt(rm[3], 10);
                if (rm[4]) current.channels = parseInt(rm[4], 10);
            }
        } else if (name === 'fmtp' && current) {
            var fm = /^(\d+)\s+(.*)$/.exec(body);
            if (fm && parseInt(fm[1], 10) === current.payloadType) {
                var kvs = fm[2].split(';');
                for (var k = 0; k < kvs.length; k++) {
                    var kv = kvs[k].trim();
                    if (!kv) continue;
                    var eq = kv.indexOf('=');
                    if (eq < 0) current.fmtp[kv.toLowerCase()] = '';
                    else current.fmtp[kv.slice(0, eq).trim().toLowerCase()] = kv.slice(eq + 1).trim();
                }
            }
        }
    }
    return session;
}

function decodeSpropList(value) {
    var out = [];
    if (!value) return out;
    var items = value.split(',');
    for (var i = 0; i < items.length; i++) {
        var s = items[i].trim();
        if (!s) continue;
        var b = bufferFromBase64(s);
        if (b.length) out.push(b);
    }
    return out;
}

/* Resolve a track's control attribute against the Content-Base / request URL. */
function resolveControl(base, control) {
    if (!control || control === '*') return base;
    if (/^rtsp:\/\//i.test(control)) return control;
    if (base.charAt(base.length - 1) !== '/') base += '/';
    return base + control;
}

/* ============================================================================
 * RTP depacketizers. Each takes RTP payloads and emits whole units:
 *   video: { pts (RTP ticks, unwrapped), nalus: [Buffer], key: bool }
 *   audio: { pts, frame: Buffer }
 * ==========================================================================*/
function unwrapTimestamp(track, ts) {
    if (track.lastTs === null) { track.lastTs = ts; track.wrapOffset = 0; }
    var diff = ts - track.lastTs;
    if (diff < -2147483648) track.wrapOffset += 4294967296;
    else if (diff > 2147483648) track.wrapOffset -= 4294967296;
    track.lastTs = ts;
    return ts + track.wrapOffset;
}

function parseRtp(buf) {
    if (buf.length < 12) return null;
    var v = buf[0] >> 6;
    if (v !== 2) return null;
    var hasPadding = !!(buf[0] & 0x20);
    var hasExt = !!(buf[0] & 0x10);
    var csrcCount = buf[0] & 0x0F;
    var marker = !!(buf[1] & 0x80);
    var payloadType = buf[1] & 0x7F;
    var seq = buf.readUInt16BE(2);
    var ts = buf.readUInt32BE(4);
    var off = 12 + csrcCount * 4;
    if (hasExt) {
        if (buf.length < off + 4) return null;
        off += 4 + buf.readUInt16BE(off + 2) * 4;
    }
    var end = buf.length;
    if (hasPadding) end -= buf[buf.length - 1];
    if (off > end) return null;
    return { marker: marker, payloadType: payloadType, seq: seq, ts: ts, payload: buf.slice(off, end) };
}

/* H.264 (RFC 6184) and H.265 (RFC 7798). The two are near twins: single NAL
 * units, aggregation packets (STAP-A 24 / AP 48) and fragments (FU-A 28 /
 * FU 49). Access units are delimited by the RTP marker bit and, as a safety
 * net, by a change of timestamp. */
function VideoDepacketizer(codec, onUnit) {
    this.codec = codec;            // 'H264' | 'H265'
    this.onUnit = onUnit;
    this.nalus = [];
    this.auTs = null;
    this.fragment = null;          // Buffer being reassembled
    this.fragmentValid = false;
    this.lastTs = null;
    this.wrapOffset = 0;
    this.lastSeq = null;
    this.lost = 0;
}
VideoDepacketizer.prototype.nalType = function (nalu) {
    return this.codec === 'H265' ? (nalu[0] >> 1) & 0x3F : nalu[0] & 0x1F;
};
VideoDepacketizer.prototype.isKeyNal = function (type) {
    return this.codec === 'H265' ? (type >= 16 && type <= 21) : type === 5;
};
VideoDepacketizer.prototype.isParameterSet = function (type) {
    return this.codec === 'H265' ? (type >= 32 && type <= 34) : (type === 7 || type === 8);
};
VideoDepacketizer.prototype.flush = function () {
    if (!this.nalus.length) return;
    var key = false;
    for (var i = 0; i < this.nalus.length; i++) {
        if (this.isKeyNal(this.nalType(this.nalus[i]))) { key = true; break; }
    }
    var unit = { pts: this.auTs, nalus: this.nalus, key: key };
    this.nalus = [];
    this.onUnit(unit);
};
VideoDepacketizer.prototype.push = function (rtp) {
    if (this.lastSeq !== null) {
        var expected = (this.lastSeq + 1) & 0xFFFF;
        if (rtp.seq !== expected) { this.lost++; this.fragmentValid = false; this.fragment = null; }
    }
    this.lastSeq = rtp.seq;

    var ts = unwrapTimestamp(this, rtp.ts);
    if (this.auTs !== null && ts !== this.auTs) this.flush();
    this.auTs = ts;

    var p = rtp.payload;
    if (p.length < 1) return;
    var hdrLen = this.codec === 'H265' ? 2 : 1;
    if (p.length < hdrLen) return;
    var type = this.codec === 'H265' ? (p[0] >> 1) & 0x3F : p[0] & 0x1F;

    var aggType = this.codec === 'H265' ? 48 : 24;
    var fuType  = this.codec === 'H265' ? 49 : 28;

    if (type === aggType) {
        var off = hdrLen;
        while (off + 2 <= p.length) {
            var size = p.readUInt16BE(off);
            off += 2;
            if (size === 0 || off + size > p.length) break;
            this.nalus.push(p.slice(off, off + size));
            off += size;
        }
    } else if (type === fuType) {
        if (p.length < hdrLen + 1) return;
        var fuHeader = p[hdrLen];
        var start = !!(fuHeader & 0x80), end = !!(fuHeader & 0x40);
        var origType = fuHeader & 0x3F;
        if (start) {
            var nalHeader;
            if (this.codec === 'H265') {
                nalHeader = bytes([(p[0] & 0x81) | (origType << 1), p[1]]);
            } else {
                nalHeader = bytes([(p[0] & 0xE0) | (origType & 0x1F)]);
            }
            this.fragment = [nalHeader, p.slice(hdrLen + 1)];
            this.fragmentValid = true;
        } else if (this.fragmentValid && this.fragment) {
            this.fragment.push(p.slice(hdrLen + 1));
        } else {
            return;   // middle of a fragment whose start we never saw
        }
        if (end && this.fragmentValid) {
            this.nalus.push(Buffer.concat(this.fragment));
            this.fragment = null;
            this.fragmentValid = false;
        }
    } else if (this.codec === 'H264' && (type === 25 || type === 26 || type === 27 || type === 29)) {
        return;   // STAP-B / MTAP / FU-B: not used by cameras
    } else if (this.codec === 'H265' && type === 50) {
        return;   // PACI: not used by cameras
    } else {
        this.nalus.push(p);
    }

    if (rtp.marker) this.flush();
};

/* AAC over RTP (RFC 3640, MPEG4-GENERIC). One or more access units per
 * packet, each announced in the AU-header section; a unit larger than one
 * packet arrives as fragments with the marker bit on the last. */
function AacDepacketizer(fmtp, clock, onFrame) {
    this.onFrame = onFrame;
    this.clock = clock;
    this.sizeLength = parseInt(fmtp.sizelength || '13', 10);
    this.indexLength = parseInt(fmtp.indexlength || '3', 10);
    this.indexDeltaLength = parseInt(fmtp.indexdeltalength || '3', 10);
    this.lastTs = null;
    this.wrapOffset = 0;
    this.fragment = null;
    this.fragmentTs = 0;
}
AacDepacketizer.prototype.push = function (rtp) {
    var ts = unwrapTimestamp(this, rtp.ts);
    var p = rtp.payload;
    if (p.length < 2) return;
    var headersBits = p.readUInt16BE(0);
    var headersBytes = Math.ceil(headersBits / 8);
    var auHeaderBits = this.sizeLength + this.indexLength;
    var count = auHeaderBits > 0 ? Math.floor(headersBits / auHeaderBits) : 0;
    var sizes = [];
    var bitPos = 16;
    for (var i = 0; i < count; i++) {
        var size = readBits(p, bitPos, this.sizeLength);
        bitPos += this.sizeLength + (i === 0 ? this.indexLength : this.indexDeltaLength);
        sizes.push(size);
    }
    var off = 2 + headersBytes;
    for (var j = 0; j < sizes.length; j++) {
        var available = p.length - off;
        if (available <= 0) break;
        if (sizes[j] > available || this.fragment) {
            // Fragmented AU: collect until the marker.
            if (!this.fragment) { this.fragment = []; this.fragmentTs = ts; }
            this.fragment.push(p.slice(off, p.length));
            off = p.length;
            if (rtp.marker) {
                this.onFrame({ pts: this.fragmentTs, frame: Buffer.concat(this.fragment) });
                this.fragment = null;
            }
            break;
        }
        this.onFrame({ pts: ts + j * 1024, frame: p.slice(off, off + sizes[j]) });
        off += sizes[j];
    }
};
function readBits(buf, bitPos, n) {
    var v = 0;
    for (var i = 0; i < n; i++) {
        var byte = buf[(bitPos + i) >> 3];
        if (byte === undefined) return v << (n - i);
        v = (v << 1) | ((byte >> (7 - ((bitPos + i) & 7))) & 1);
    }
    return v >>> 0;
}

/* AudioSpecificConfig (from fmtp config=) -> the fields an ADTS header needs. */
var AAC_SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
function aacConfigFromFmtp(fmtp, clock, channels) {
    var cfg = { objectType: 2, sampleRateIndex: 8, channels: channels || 1 };
    var hex = (fmtp.config || '').replace(/[^0-9a-fA-F]/g, '');
    if (hex.length >= 4) {
        var b0 = parseInt(hex.slice(0, 2), 16), b1 = parseInt(hex.slice(2, 4), 16);
        var aot = b0 >> 3;
        var sri = ((b0 & 0x07) << 1) | (b1 >> 7);
        var ch = (b1 >> 3) & 0x0F;
        if (aot >= 1 && aot <= 4) cfg.objectType = aot;
        if (sri < 13) cfg.sampleRateIndex = sri;
        if (ch >= 1 && ch <= 7) cfg.channels = ch;
    } else {
        var idx = AAC_SAMPLE_RATES.indexOf(clock);
        if (idx >= 0) cfg.sampleRateIndex = idx;
    }
    return cfg;
}
function adtsFrame(cfg, raw) {
    var len = raw.length + 7;
    var hdr = Buffer.alloc(7);
    hdr[0] = 0xFF;
    hdr[1] = 0xF1;                                               // MPEG-4, layer 0, no CRC
    hdr[2] = ((cfg.objectType - 1) << 6) | (cfg.sampleRateIndex << 2) | ((cfg.channels >> 2) & 1);
    hdr[3] = ((cfg.channels & 3) << 6) | ((len >> 11) & 0x03);
    hdr[4] = (len >> 3) & 0xFF;
    hdr[5] = ((len & 7) << 5) | 0x1F;
    hdr[6] = 0xFC;
    return Buffer.concat([hdr, raw]);
}

/* ============================================================================
 * MPEG-TS muxer. PAT + PMT before every keyframe, one PES per access unit,
 * PCR on every video PES, PTS only (cameras do not reorder frames).
 * ==========================================================================*/
var CRC_TABLE = (function () {
    var t = new Array(256);
    for (var i = 0; i < 256; i++) {
        var c = i << 24;
        for (var k = 0; k < 8; k++) c = (c & 0x80000000) ? ((c << 1) ^ 0x04C11DB7) : (c << 1);
        t[i] = c >>> 0;
    }
    return t;
}());
function crc32mpeg(buf, end) {
    var crc = 0xFFFFFFFF;
    var n = end === undefined ? buf.length : end;
    for (var i = 0; i < n; i++) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ buf[i]) & 0xFF]) >>> 0;
    return crc >>> 0;
}

var TS_PACKET = 188;
var PID_PAT = 0, PID_PMT = 0x1000, PID_VIDEO = 0x100, PID_AUDIO = 0x101;
var STREAM_TYPE = { H264: 0x1B, H265: 0x24, AAC: 0x0F };
var PTS_MODULO = 8589934592;      // 2^33
var PTS_START = 90000;            // first PTS 1 s in, so PCR (PTS - 0.3 s) stays positive

function TsMuxer(opts) {
    this.videoCodec = opts.videoCodec;           // 'H264' | 'H265'
    this.hasAudio = !!opts.hasAudio;
    this.cc = {};                                 // continuity counters per PID
    this.pat = this.buildPat();
    this.pmt = this.buildPmt();
}
TsMuxer.prototype.nextCc = function (pid) {
    var c = this.cc[pid] === undefined ? 0 : (this.cc[pid] + 1) & 0x0F;
    this.cc[pid] = c;
    return c;
};
TsMuxer.prototype.psiPacket = function (pid, tableId, tableIdExt, payload) {
    var sectionLen = 5 + payload.length + 4;
    var sec = Buffer.alloc(3 + sectionLen);
    sec[0] = tableId;
    sec[1] = 0xB0 | ((sectionLen >> 8) & 0x0F);
    sec[2] = sectionLen & 0xFF;
    sec.writeUInt16BE(tableIdExt, 3);
    sec[5] = 0xC1;                                // reserved, version 0, current
    sec[6] = 0; sec[7] = 0;                       // section 0 of 0
    payload.copy(sec, 8);
    sec.writeUInt32BE(crc32mpeg(sec, 8 + payload.length), 8 + payload.length);

    var pkt = Buffer.alloc(TS_PACKET, 0xFF);
    pkt[0] = 0x47;
    pkt[1] = 0x40 | ((pid >> 8) & 0x1F);
    pkt[2] = pid & 0xFF;
    pkt[3] = 0x10 | this.nextCc(pid);
    pkt[4] = 0;                                   // pointer_field
    sec.copy(pkt, 5);
    return pkt;
};
TsMuxer.prototype.buildPat = function () {
    return this.psiPacket(PID_PAT, 0x00, 1, bytes([0x00, 0x01, 0xE0 | (PID_PMT >> 8), PID_PMT & 0xFF]));
};
TsMuxer.prototype.buildPmt = function () {
    var list = [0xE0 | (PID_VIDEO >> 8), PID_VIDEO & 0xFF, 0xF0, 0x00,
                STREAM_TYPE[this.videoCodec], 0xE0 | (PID_VIDEO >> 8), PID_VIDEO & 0xFF, 0xF0, 0x00];
    if (this.hasAudio) list = list.concat([STREAM_TYPE.AAC, 0xE0 | (PID_AUDIO >> 8), PID_AUDIO & 0xFF, 0xF0, 0x00]);
    return this.psiPacket(PID_PMT, 0x02, 1, bytes(list));
};
/* PAT and PMT are rebuilt per emission so their continuity counters advance. */
TsMuxer.prototype.tables = function () {
    return Buffer.concat([this.buildPat(), this.buildPmt()]);
};

function writePts(buf, off, prefix, pts) {
    pts = pts % PTS_MODULO;
    var hi = Math.floor(pts / 4294967296) & 1;
    var lo = pts % 4294967296;
    buf[off]     = prefix | (hi << 3) | (((lo >>> 30) & 0x03) << 1) | 0x01;
    buf[off + 1] = (lo >>> 22) & 0xFF;
    buf[off + 2] = (((lo >>> 15) & 0x7F) << 1) | 0x01;
    buf[off + 3] = (lo >>> 7) & 0xFF;
    buf[off + 4] = ((lo & 0x7F) << 1) | 0x01;
}

function pesHeader(streamId, pts, payloadLength, unbounded) {
    var hdr = Buffer.alloc(14);
    var pesLen = unbounded ? 0 : 3 + 5 + payloadLength;
    if (pesLen > 0xFFFF) pesLen = 0;
    hdr[0] = 0; hdr[1] = 0; hdr[2] = 1; hdr[3] = streamId;
    hdr.writeUInt16BE(pesLen, 4);
    hdr[6] = 0x84;                                // '10', data_alignment_indicator
    hdr[7] = 0x80;                                // PTS only
    hdr[8] = 5;
    writePts(hdr, 9, 0x20, pts);
    return hdr;
}

/* One PES (header + payload) as a run of TS packets, written into a single
 * buffer: one allocation per access unit rather than one per 188 bytes. */
TsMuxer.prototype.packetize = function (pid, data, pcr, randomAccess) {
    var out = Buffer.alloc((Math.ceil((data.length + 8) / 184) + 1) * TS_PACKET, 0xFF);
    var count = 0;
    var pos = 0, first = true;
    while (pos < data.length) {
        var pkt = out.slice(count * TS_PACKET, (count + 1) * TS_PACKET);
        count++;
        pkt[0] = 0x47;
        pkt[1] = (first ? 0x40 : 0x00) | ((pid >> 8) & 0x1F);
        pkt[2] = pid & 0xFF;

        var remaining = data.length - pos;
        var af = null;                            // adaptation field body (after its length byte)
        if (first && (pcr !== null || randomAccess)) {
            var flags = (randomAccess ? 0x40 : 0) | (pcr !== null ? 0x10 : 0);
            af = [flags];
            if (pcr !== null) {
                var base = pcr % PTS_MODULO;
                var bHi = Math.floor(base / 4294967296) & 1;
                var bLo = base % 4294967296;
                // 33-bit base, 6 reserved bits, 9-bit extension (0)
                af.push((bHi << 7) | ((bLo >>> 25) & 0x7F));
                af.push((bLo >>> 17) & 0xFF);
                af.push((bLo >>> 9) & 0xFF);
                af.push((bLo >>> 1) & 0xFF);
                af.push(((bLo & 1) << 7) | 0x7E);
                af.push(0x00);
            }
        }
        var afLen = af ? af.length : -1;          // -1: no adaptation field at all
        var space = TS_PACKET - 4 - (afLen >= 0 ? afLen + 1 : 0);
        if (remaining < space) {
            var stuff = space - remaining;
            if (afLen < 0) {
                if (stuff === 1) { afLen = 0; af = []; }
                else { afLen = stuff - 1; af = [0x00]; }     // flags byte + 0xFF stuffing
            } else {
                afLen += stuff;
            }
            space = remaining;
        }
        pkt[3] = (afLen >= 0 ? 0x20 : 0x00) | 0x10 | this.nextCc(pid);
        if (afLen >= 0) {
            pkt[4] = afLen;
            for (var i = 0; i < af.length; i++) pkt[5 + i] = af[i];
        }
        data.copy(pkt, TS_PACKET - space, pos, pos + space);
        pos += space;
        first = false;
    }
    return out.slice(0, count * TS_PACKET);
};

var ANNEXB_START = bytes([0, 0, 0, 1]);
var AUD_H264 = bytes([0, 0, 0, 1, 0x09, 0xF0]);
var AUD_H265 = bytes([0, 0, 0, 1, 0x46, 0x01, 0x50]);

/* A video access unit as TS packets. Parameter sets are repeated before every
 * keyframe so any keyframe is a valid entry point (HLS segments, late joiners). */
TsMuxer.prototype.videoUnit = function (pts, nalus, key, parameterSets) {
    var parts = [this.videoCodec === 'H265' ? AUD_H265 : AUD_H264];
    var i;
    if (key && parameterSets) {
        for (i = 0; i < parameterSets.length; i++) parts.push(ANNEXB_START, parameterSets[i]);
    }
    for (i = 0; i < nalus.length; i++) {
        var t = this.videoCodec === 'H265' ? (nalus[i][0] >> 1) & 0x3F : nalus[i][0] & 0x1F;
        if (this.videoCodec === 'H265' ? t === 35 : t === 9) continue;        // we added our own AUD
        if (key && parameterSets && (this.videoCodec === 'H265' ? (t >= 32 && t <= 34) : (t === 7 || t === 8))) continue;
        parts.push(ANNEXB_START, nalus[i]);
    }
    var es = Buffer.concat(parts);
    var pes = Buffer.concat([pesHeader(0xE0, pts, es.length, true), es]);
    var pcr = pts - 27000;                        // 0.3 s ahead of the PCR
    if (pcr < 0) pcr += PTS_MODULO;
    return this.packetize(PID_VIDEO, pes, pcr, key);
};
TsMuxer.prototype.audioFrame = function (pts, adts) {
    var pes = Buffer.concat([pesHeader(0xC0, pts, adts.length, false), adts]);
    return this.packetize(PID_AUDIO, pes, null, false);
};

/* ============================================================================
 * RTSP client over TCP with interleaved RTP.
 * ==========================================================================*/
function RtspClient(opts) {
    this.host = opts.host;
    this.port = opts.port || 554;
    this.user = opts.user || '';
    this.pass = opts.pass || '';
    this.paths = opts.paths.slice();
    this.wantAudio = opts.audio !== false;
    this.onTrackInfo = opts.onTrackInfo || function () {};
    this.onRtp = opts.onRtp || function () {};
    this.onRtcp = opts.onRtcp || function () {};
    this.onError = opts.onError || function () {};
    this.onPlaying = opts.onPlaying || function () {};

    this.socket = null;
    this.cseq = 0;
    this.pending = {};                 // cseq -> callback(err, response)
    this.buffer = Buffer.alloc(0);
    this.session = null;
    this.timeoutSec = 60;
    this.authorization = null;         // header value, once a challenge was answered
    this.challenges = null;
    this.nonceCount = 0;
    this.keepaliveTimer = null;
    this.keepaliveMethod = 'OPTIONS';
    this.closed = false;
    this.tracks = [];
    this.baseUrl = null;
    this.currentPath = null;
}

RtspClient.prototype.url = function (path) {
    var p = path || this.currentPath || this.paths[0] || '';
    if (p.charAt(0) !== '/') p = '/' + p;
    return 'rtsp://' + this.host + (this.port !== 554 ? ':' + this.port : '') + p;
};

RtspClient.prototype.connect = function () {
    var self = this;
    var connected = false;
    var connectTimer = setTimeout(function () {
        if (!connected) self.fail('unreachable', 'No answer from ' + self.host + ':' + self.port + ' (RTSP). Is RTSP enabled on the camera?');
    }, 8000);
    this.socket = net.connect(this.port, this.host, function () {
        connected = true;
        clearTimeout(connectTimer);
        try { self.socket.setNoDelay(true); } catch (e) {}
        self.describeNext();
    });
    this.socket.on('data', function (chunk) { self.onData(chunk); });
    this.socket.on('error', function (err) {
        clearTimeout(connectTimer);
        self.fail(connected ? 'closed' : 'unreachable',
                  (connected ? 'Connection to the camera failed: ' : 'Cannot reach ' + self.host + ':' + self.port + ': ') + (err && err.message));
    });
    this.socket.on('close', function () {
        clearTimeout(connectTimer);
        if (!self.closed) self.fail('closed', 'The camera closed the RTSP connection.');
    });
};

RtspClient.prototype.fail = function (code, message) {
    if (this.closed) return;
    this.close();
    this.onError(code, message);
};

RtspClient.prototype.close = function () {
    this.closed = true;
    clearInterval(this.keepaliveTimer);
    var s = this.socket;
    if (!s) return;
    this.socket = null;
    if (this.session) {
        // Say goodbye so the camera frees the viewer slot at once, then let the write flush.
        try { s.write(this.requestText('TEARDOWN', this.baseUrl || this.url(), {}).text); } catch (e) {}
        try { s.end(); } catch (e2) {}
        setTimeout(function () { try { s.destroy(); } catch (e3) {} }, 500);
    } else {
        try { s.destroy(); } catch (e4) {}
    }
};

RtspClient.prototype.requestText = function (method, url, headers) {
    var cseq = ++this.cseq;
    var text = method + ' ' + url + ' RTSP/1.0\r\nCSeq: ' + cseq + '\r\nUser-Agent: ReolinkViewer/' + VERSION + '\r\n';
    if (this.session) text += 'Session: ' + this.session + '\r\n';
    if (this.authorization) text += 'Authorization: ' + this.authorization + '\r\n';
    for (var k in headers) text += k + ': ' + headers[k] + '\r\n';
    return { cseq: cseq, text: text + '\r\n' };
};

RtspClient.prototype.send = function (method, url, headers, cb) {
    if (this.closed || !this.socket) return;
    if (this.challenges && this.user) {
        this.authorization = buildAuthorization(this.challenges, this.user, this.pass, method, url, ++this.nonceCount);
    }
    var req = this.requestText(method, url, headers);
    this.pending[req.cseq] = { cb: cb || function () {}, method: method, url: url, headers: headers,
                               authAttempt: !!this.authorization };
    try { this.socket.write(req.text); } catch (e) { this.fail('closed', 'Write to camera failed: ' + e.message); }
};

/* Interleaved framing: '$' channel length(2) RTP|RTCP, mixed with text responses. */
RtspClient.prototype.onData = function (chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (this.buffer.length) {
        if (this.buffer[0] === 0x24) {                                   // '$'
            if (this.buffer.length < 4) return;
            var len = this.buffer.readUInt16BE(2);
            if (this.buffer.length < 4 + len) return;
            var channel = this.buffer[1];
            var frame = this.buffer.slice(4, 4 + len);
            this.buffer = this.buffer.slice(4 + len);
            if (channel & 1) this.onRtcp(channel, frame);
            else this.onRtp(channel, frame);
            continue;
        }
        var headerEnd = indexOfSeq(this.buffer, '\r\n\r\n');
        if (headerEnd < 0) {
            // Garbage between frames (seen on some firmware): resync on the next '$' or 'RTSP'.
            if (this.buffer.length > 65536) this.buffer = Buffer.alloc(0);
            return;
        }
        var headText = asciiString(this.buffer, 0, headerEnd);
        var headers = parseHeaders(headText);
        var contentLength = parseInt(headers['content-length'] || '0', 10) || 0;
        if (this.buffer.length < headerEnd + 4 + contentLength) return;
        var body = asciiString(this.buffer, headerEnd + 4, headerEnd + 4 + contentLength);
        this.buffer = this.buffer.slice(headerEnd + 4 + contentLength);
        this.onMessage(headText, headers, body);
    }
};

function indexOfSeq(buf, str) {
    var first = str.charCodeAt(0);
    for (var i = 0; i <= buf.length - str.length; i++) {
        if (buf[i] !== first) continue;
        var ok = true;
        for (var j = 1; j < str.length; j++) if (buf[i + j] !== str.charCodeAt(j)) { ok = false; break; }
        if (ok) return i;
    }
    return -1;
}
function parseHeaders(text) {
    var lines = text.split('\r\n');
    var headers = { _status: lines[0] };
    for (var i = 1; i < lines.length; i++) {
        var colon = lines[i].indexOf(':');
        if (colon < 0) continue;
        headers[lines[i].slice(0, colon).trim().toLowerCase()] = lines[i].slice(colon + 1).trim();
    }
    return headers;
}

RtspClient.prototype.onMessage = function (headText, headers, body) {
    var statusLine = headers._status || '';
    if (statusLine.indexOf('RTSP/') !== 0) {
        // A request from the server (some send GET_PARAMETER / OPTIONS as keepalive): acknowledge it.
        if (headers.cseq && this.socket) {
            try { this.socket.write('RTSP/1.0 200 OK\r\nCSeq: ' + headers.cseq + '\r\n\r\n'); } catch (e) {}
        }
        return;
    }
    var m = /^RTSP\/\d\.\d\s+(\d+)\s*(.*)$/.exec(statusLine);
    var status = m ? parseInt(m[1], 10) : 0;
    var cseq = parseInt(headers.cseq, 10);
    var entry = this.pending[cseq];
    if (!entry) return;
    delete this.pending[cseq];

    if (status === 401 && headers['www-authenticate']) {
        if (!this.user) return this.fail('auth', 'The camera requires a login.');
        var challenges = parseAuthChallenge(headers['www-authenticate']);
        var stale = false;
        for (var i = 0; i < challenges.length; i++) if (/^true$/i.test(challenges[i].params.stale || '')) stale = true;
        if (entry.authAttempt && !stale) return this.fail('auth', 'Login rejected. Check the username and password.');
        // First challenge (or a stale nonce): answer it and repeat the request.
        this.challenges = challenges;
        return this.send(entry.method, entry.url, entry.headers, entry.cb);
    }
    entry.cb(null, { status: status, reason: m ? m[2] : '', headers: headers, body: body });
};

RtspClient.prototype.describeNext = function () {
    var self = this;
    if (!this.paths.length) return this.fail('notfound', 'No RTSP stream found at any of the known paths. Check the channel, or fill in the RTSP path.');
    this.currentPath = this.paths.shift();
    var url = this.url();
    log('RTSP_DESCRIBE', url);
    this.send('DESCRIBE', url, { Accept: 'application/sdp' }, function (err, res) {
        if (err) return;
        if (res.status === 401) return self.fail('auth', 'Login rejected. Check the username and password.');
        if (res.status === 404 || res.status === 400 || res.status === 403 || res.status === 500 || res.status === 503) {
            log('RTSP_DESCRIBE_FAIL', { status: res.status, path: self.currentPath });
            if (res.status === 503) return self.fail('busy', 'The camera refused the stream (503). It may have reached its viewer limit.');
            return self.describeNext();
        }
        if (res.status !== 200) return self.fail('rtsp', 'DESCRIBE failed: ' + res.status + ' ' + res.reason);
        self.baseUrl = res.headers['content-base'] || res.headers['content-location'] || url;
        self.onDescribe(res.body);
    });
};

RtspClient.prototype.onDescribe = function (sdpText) {
    var sdp = parseSdp(sdpText);
    var video = null, audio = null;
    for (var i = 0; i < sdp.media.length; i++) {
        var md = sdp.media[i];
        if (md.kind === 'video' && !video && (md.codec === 'H265' || md.codec === 'H264')) video = md;
        if (md.kind === 'audio' && !audio && this.wantAudio && /^MPEG4-GENERIC$/i.test(md.codec || '')) audio = md;
    }
    if (!video) {
        var seen = [];
        for (var j = 0; j < sdp.media.length; j++) seen.push(sdp.media[j].kind + '/' + sdp.media[j].codec);
        return this.fail('nocodec', 'No H.264 or H.265 video in the RTSP stream (' + (seen.join(', ') || 'no media') + ').');
    }
    var audioNote = '';
    if (!audio && this.wantAudio) {
        for (var k = 0; k < sdp.media.length; k++) {
            if (sdp.media[k].kind === 'audio') audioNote = sdp.media[k].codec + ' audio is not supported, video only';
        }
    }

    var parameterSets = [];
    if (video.codec === 'H265') {
        parameterSets = decodeSpropList(video.fmtp['sprop-vps'])
            .concat(decodeSpropList(video.fmtp['sprop-sps']))
            .concat(decodeSpropList(video.fmtp['sprop-pps']));
    } else {
        parameterSets = decodeSpropList(video.fmtp['sprop-parameter-sets']);
    }

    this.tracks = [{ kind: 'video', media: video, channel: 0, parameterSets: parameterSets,
                     url: resolveControl(this.baseUrl, video.control) }];
    if (audio) {
        this.tracks.push({ kind: 'audio', media: audio, channel: 2, url: resolveControl(this.baseUrl, audio.control) });
    }
    log('RTSP_SDP', { video: video.codec, audio: audio ? audio.codec + '/' + audio.clock : (audioNote || 'none'),
                      paramSets: parameterSets.length });
    this.onTrackInfo(this.tracks, audioNote);
    this.setupTrack(0);
};

RtspClient.prototype.setupTrack = function (index) {
    var self = this;
    if (index >= this.tracks.length) return this.play();
    var track = this.tracks[index];
    var transport = 'RTP/AVP/TCP;unicast;interleaved=' + track.channel + '-' + (track.channel + 1);
    this.send('SETUP', track.url, { Transport: transport }, function (err, res) {
        if (err) return;
        if (res.status !== 200) {
            if (track.kind === 'audio') {
                log('RTSP_SETUP_AUDIO_FAIL', res.status);
                self.tracks.splice(index, 1);
                self.onTrackInfo(self.tracks, 'audio track refused by the camera, video only');
                return self.setupTrack(index);
            }
            return self.fail('rtsp', 'SETUP failed: ' + res.status + ' ' + res.reason + '. The camera may not allow TCP transport.');
        }
        if (res.headers.session) {
            var parts = res.headers.session.split(';');
            self.session = parts[0].trim();
            for (var i = 1; i < parts.length; i++) {
                var tm = /timeout\s*=\s*(\d+)/i.exec(parts[i]);
                if (tm) self.timeoutSec = Math.max(10, parseInt(tm[1], 10));
            }
        }
        self.setupTrack(index + 1);
    });
};

RtspClient.prototype.play = function () {
    var self = this;
    this.send('PLAY', this.baseUrl || this.url(), { Range: 'npt=0.000-' }, function (err, res) {
        if (err) return;
        if (res.status !== 200) return self.fail('rtsp', 'PLAY failed: ' + res.status + ' ' + res.reason);
        log('RTSP_PLAYING', { session: self.session, timeout: self.timeoutSec });
        self.startKeepalive();
        self.onPlaying();
    });
};

RtspClient.prototype.startKeepalive = function () {
    var self = this;
    clearInterval(this.keepaliveTimer);
    var every = Math.max(5, Math.min(30, Math.floor(this.timeoutSec / 2))) * 1000;
    this.keepaliveTimer = setInterval(function () {
        if (self.closed) return;
        self.send(self.keepaliveMethod, self.baseUrl || self.url(), {}, function (err, res) {
            if (!err && res && res.status === 405 && self.keepaliveMethod === 'GET_PARAMETER') self.keepaliveMethod = 'OPTIONS';
        });
    }, every);
};

/* ============================================================================
 * Session: one camera stream, from RTSP to the TS ring buffer.
 * ==========================================================================*/
var SEGMENT_MIN_90K = 90000;          // a segment closes at the first keyframe after 1 s
var MAX_SEGMENTS = 8;
var MAX_RING_BYTES = 24 * 1024 * 1024;
var IDLE_STOP_MS = 60000;

var session = null;

function Session(params) {
    this.id = Date.now().toString(36);
    this.params = params;
    this.state = 'connecting';
    this.error = null;
    this.errorCode = null;
    this.note = '';
    this.startedAt = Date.now();
    this.video = null;              // { codec, clock }
    this.audio = null;              // { codec, clock, channels }
    this.muxer = null;
    this.videoDepacketizer = null;
    this.audioDepacketizer = null;
    this.aacConfig = null;
    this.parameterSets = [];
    this.gotKeyframe = false;
    this.clock = { t0: Date.now() };
    this.trackTime = { video: null, audio: null };   // { base, offset, clock, sr }
    this.lastVideoPts = 0;

    this.segments = [];             // closed, newest last
    this.current = null;            // open segment
    this.nextSeq = 1;
    this.ringBytes = 0;
    this.lastKeyChunk = null;       // { seg, index } of the latest keyframe chunk
    this.clients = [];              // live.ts responses
    this.lastMediaActivity = Date.now();

    this.frames = 0;
    this.bytes = 0;
    this.rate = { frames: 0, bytes: 0, at: Date.now(), fps: 0, kbps: 0 };
    this.rtpLost = 0;

    var self = this;
    this.rtsp = new RtspClient({
        host: params.host, port: params.port, user: params.user, pass: params.pass,
        paths: params.paths, audio: params.audio,
        onTrackInfo: function (tracks, note) { self.onTracks(tracks, note); },
        onRtp: function (channel, frame) { self.onRtp(channel, frame); },
        onRtcp: function (channel, frame) { self.onRtcp(channel, frame); },
        onError: function (code, message) { self.failed(code, message); },
        onPlaying: function () { if (self.state === 'connecting') self.state = 'waiting'; }
    });
    this.rtsp.connect();
    this.timer = setInterval(function () { self.tick(); }, 1000);
}

Session.prototype.failed = function (code, message) {
    if (this.state === 'stopped' || this.state === 'error') return;
    log('SESSION_ERROR', { code: code, message: message });
    this.state = 'error';
    this.errorCode = code;
    this.error = message;
    this.rtsp.close();
    clearInterval(this.timer);
    this.endClients();
};

Session.prototype.stop = function () {
    if (this.state === 'stopped') return;
    log('SESSION_STOP', { id: this.id, frames: this.frames, bytes: this.bytes });
    this.state = 'stopped';
    this.rtsp.close();
    clearInterval(this.timer);
    this.endClients();
};

Session.prototype.endClients = function () {
    var clients = this.clients;
    this.clients = [];
    for (var i = 0; i < clients.length; i++) { try { clients[i].end(); } catch (e) {} }
};

Session.prototype.onTracks = function (tracks, note) {
    var self = this;
    this.note = note || '';
    var video = tracks[0];
    this.video = { codec: video.media.codec, clock: video.media.clock };
    this.parameterSets = video.parameterSets;
    this.videoDepacketizer = new VideoDepacketizer(video.media.codec, function (unit) { self.onVideoUnit(unit); });
    this.audio = null;
    this.audioDepacketizer = null;
    for (var i = 1; i < tracks.length; i++) {
        if (tracks[i].kind !== 'audio') continue;
        var md = tracks[i].media;
        this.aacConfig = aacConfigFromFmtp(md.fmtp, md.clock, md.channels);
        this.audio = { codec: 'AAC', clock: md.clock, channels: this.aacConfig.channels };
        this.audioDepacketizer = new AacDepacketizer(md.fmtp, md.clock, function (frame) { self.onAudioFrame(frame); });
    }
    this.muxer = new TsMuxer({ videoCodec: this.video.codec, hasAudio: !!this.audio });
};

Session.prototype.onRtp = function (channel, frame) {
    var rtp = parseRtp(frame);
    if (!rtp) return;
    if (channel === 0 && this.videoDepacketizer) this.videoDepacketizer.push(rtp);
    else if (channel === 2 && this.audioDepacketizer) this.audioDepacketizer.push(rtp);
};

/* RTCP sender reports map each track's RTP clock to wall-clock (NTP) time.
 * With one for each track, audio is lined up to video exactly instead of by
 * arrival time. */
Session.prototype.onRtcp = function (channel, frame) {
    if (frame.length < 20 || (frame[1] !== 200)) return;
    var kind = channel === 1 ? 'video' : channel === 3 ? 'audio' : null;
    if (!kind) return;
    var tt = this.trackTime[kind];
    var dep = kind === 'video' ? this.videoDepacketizer : this.audioDepacketizer;
    if (!tt || !dep || dep.lastTs === null) return;
    var ntpSec = frame.readUInt32BE(8), ntpFrac = frame.readUInt32BE(12), rtpTs = frame.readUInt32BE(16);
    var ntpMs = ntpSec * 1000 + Math.floor(ntpFrac / 4294967.296);
    // Put the report's RTP time in the same unwrapped domain as the depacketizer's timestamps.
    var latest = dep.lastTs + dep.wrapOffset;
    var unwrapped = rtpTs + dep.wrapOffset;
    if (unwrapped - latest > 2147483648) unwrapped -= 4294967296;
    else if (latest - unwrapped > 2147483648) unwrapped += 4294967296;
    if (!tt.sr) tt.sr = { ntpMs: ntpMs, rtpTs: unwrapped };
    var v = this.trackTime.video, a = this.trackTime.audio;
    if (v && a && v.sr && a.sr && !this.synced) {
        var ntpOfVideoBase = v.sr.ntpMs + (v.base - v.sr.rtpTs) / v.clock * 1000;
        var ntpOfAudioBase = a.sr.ntpMs + (a.base - a.sr.rtpTs) / a.clock * 1000;
        var newOffset = (ntpOfAudioBase - ntpOfVideoBase) * 90 + v.offset;
        var shift = newOffset - a.offset;
        if (Math.abs(shift) < 5 * 90000) {
            a.offset = newOffset;
            log('AV_SYNC', { shiftMs: Math.round(shift / 90) });
        }
        this.synced = true;
    }
};

/* RTP ticks -> 90 kHz PTS, anchored on arrival time at the first packet. */
Session.prototype.toPts = function (kind, rtpTs, clock) {
    var tt = this.trackTime[kind];
    if (!tt) {
        tt = this.trackTime[kind] = { base: rtpTs, clock: clock,
                                      offset: (Date.now() - this.clock.t0) * 90 + PTS_START };
    }
    var pts = Math.round((rtpTs - tt.base) * 90000 / clock) + tt.offset;
    return pts < 0 ? 0 : pts;
};

Session.prototype.onVideoUnit = function (unit) {
    if (!this.muxer) return;
    // Remember in-band parameter sets; they replace the SDP's.
    var dep = this.videoDepacketizer;
    var inband = [];
    for (var i = 0; i < unit.nalus.length; i++) {
        if (dep.isParameterSet(dep.nalType(unit.nalus[i]))) inband.push(unit.nalus[i]);
    }
    if (inband.length >= (this.video.codec === 'H265' ? 3 : 2)) this.parameterSets = inband;

    if (!this.gotKeyframe) {
        if (!unit.key) return;
        if (!this.parameterSets.length) { log('NO_PARAMETER_SETS'); return; }
        this.gotKeyframe = true;
        this.state = 'playing';
        log('FIRST_KEYFRAME', { codec: this.video.codec, afterMs: Date.now() - this.startedAt });
    }
    var pts = this.toPts('video', unit.pts, this.video.clock);
    this.lastVideoPts = pts;
    var ts = this.muxer.videoUnit(pts, unit.nalus, unit.key, this.parameterSets);
    if (unit.key) ts = Buffer.concat([this.muxer.tables(), ts]);
    this.frames++;
    this.rate.frames++;
    this.append(ts, unit.key, pts);
};

Session.prototype.onAudioFrame = function (frame) {
    if (!this.muxer || !this.gotKeyframe) return;
    var pts = this.toPts('audio', frame.pts, this.audio.clock);
    this.append(this.muxer.audioFrame(pts, adtsFrame(this.aacConfig, frame.frame)), false, pts);
};

/* Ring buffer of TS chunks grouped into HLS segments; live clients get each chunk as it lands. */
Session.prototype.append = function (chunk, key, pts) {
    if (key && (!this.current || pts - this.current.startPts >= SEGMENT_MIN_90K)) this.closeSegment(pts);
    if (!this.current) this.current = { seq: this.nextSeq++, startPts: pts, endPts: pts, chunks: [], bytes: 0 };
    this.current.chunks.push(chunk);
    this.current.bytes += chunk.length;
    if (pts > this.current.endPts) this.current.endPts = pts;
    if (key) this.lastKeyChunk = { seg: this.current, index: this.current.chunks.length - 1 };
    this.bytes += chunk.length;
    this.rate.bytes += chunk.length;
    this.ringBytes += chunk.length;
    this.trimRing();

    for (var i = this.clients.length - 1; i >= 0; i--) {
        var res = this.clients[i];
        var sock = res.socket || res.connection;
        var queued = sock ? (sock.bufferSize || 0) : 0;
        if (queued > 16 * 1024 * 1024) {
            log('CLIENT_TOO_SLOW', { queued: queued });
            this.clients.splice(i, 1);
            try { res.end(); } catch (e) {}
            continue;
        }
        try { res.write(chunk); } catch (e2) { this.clients.splice(i, 1); }
    }
};

Session.prototype.closeSegment = function (nextPts) {
    if (!this.current) return;
    this.current.endPts = nextPts;
    this.current.duration = Math.max(0.1, (nextPts - this.current.startPts) / 90000);
    this.segments.push(this.current);
    this.current = null;
    while (this.segments.length > MAX_SEGMENTS) this.dropOldest();
};

Session.prototype.dropOldest = function () {
    var seg = this.segments.shift();
    if (seg) this.ringBytes -= seg.bytes;
};

Session.prototype.trimRing = function () {
    while (this.ringBytes > MAX_RING_BYTES && this.segments.length > 2) this.dropOldest();
};

Session.prototype.tick = function () {
    var now = Date.now();
    var dt = (now - this.rate.at) / 1000;
    if (dt >= 1) {
        this.rate.fps = Math.round(this.rate.frames / dt * 10) / 10;
        this.rate.kbps = Math.round(this.rate.bytes * 8 / dt / 1000);
        this.rate.frames = 0; this.rate.bytes = 0; this.rate.at = now;
    }
    if (this.videoDepacketizer) this.rtpLost = this.videoDepacketizer.lost;
    if (this.clients.length) this.lastMediaActivity = now;
    if (now - this.lastMediaActivity > IDLE_STOP_MS) {
        log('SESSION_IDLE_STOP');
        this.stop();
        return;
    }
    if (this.state === 'waiting' && now - this.startedAt > 20000) {
        this.failed('nokeyframe', 'The camera is sending data but no decodable video arrived in 20 s.');
    }
};

Session.prototype.status = function () {
    return {
        ok: true,
        id: this.id,
        state: this.state,
        error: this.error,
        errorCode: this.errorCode,
        note: this.note,
        url: this.rtsp.url(),
        video: this.video,
        audio: this.audio,
        fps: this.rate.fps,
        kbps: this.rate.kbps,
        frames: this.frames,
        bytes: this.bytes,
        rtpLost: this.rtpLost,
        segments: this.segments.length,
        clients: this.clients.length,
        uptime: Math.round((Date.now() - this.startedAt) / 1000)
    };
};

/* GET /live.ts: everything from the latest keyframe, then live. */
Session.prototype.serveLive = function (res) {
    var self = this;
    res.writeHead(200, {
        'Content-Type': 'video/mp2t',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
        'Connection': 'close'
    });
    if (this.lastKeyChunk) {
        var seg = this.lastKeyChunk.seg;
        for (var i = this.lastKeyChunk.index; i < seg.chunks.length; i++) res.write(seg.chunks[i]);
        if (seg !== this.current && this.current) {
            for (var j = 0; j < this.current.chunks.length; j++) res.write(this.current.chunks[j]);
        }
    }
    this.clients.push(res);
    this.lastMediaActivity = Date.now();
    var remove = function () {
        var idx = self.clients.indexOf(res);
        if (idx >= 0) self.clients.splice(idx, 1);
    };
    res.on('close', remove);
    res.on('finish', remove);
    res.on('error', remove);
};

Session.prototype.playlist = function () {
    var segs = this.segments;
    var target = 1;
    for (var i = 0; i < segs.length; i++) target = Math.max(target, Math.ceil(segs[i].duration));
    var lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:' + target,
                 '#EXT-X-MEDIA-SEQUENCE:' + (segs.length ? segs[0].seq : 1)];
    for (var j = 0; j < segs.length; j++) {
        lines.push('#EXTINF:' + segs[j].duration.toFixed(3) + ',');
        lines.push('seg/' + segs[j].seq + '.ts');
    }
    return lines.join('\n') + '\n';
};

Session.prototype.segment = function (seq) {
    for (var i = 0; i < this.segments.length; i++) if (this.segments[i].seq === seq) return this.segments[i];
    return null;
};

/* ============================================================================
 * Reolink URL conventions
 * ==========================================================================*/
function reolinkPaths(params) {
    if (params.path) {
        var p = String(params.path).trim();
        return [p.charAt(0) === '/' ? p : '/' + p];
    }
    var ch = ('0' + (parseInt(params.channel, 10) + 1)).slice(-2);
    var stream = params.stream === 'main' ? 'main' : params.stream === 'ext' ? 'ext' : 'sub';
    if (stream === 'main') {
        return ['/h265Preview_' + ch + '_main', '/h264Preview_' + ch + '_main', '/Preview_' + ch + '_main'];
    }
    return ['/h264Preview_' + ch + '_' + stream, '/Preview_' + ch + '_' + stream];
}

/* ============================================================================
 * HTTP surface
 * ==========================================================================*/
function cors(res, status, type, extra) {
    var headers = {
        'Content-Type': type,
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
    };
    for (var k in (extra || {})) headers[k] = extra[k];
    res.writeHead(status, headers);
}
function sendJson(res, status, obj) {
    var body = JSON.stringify(obj);
    cors(res, status, 'application/json', { 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
}
function readJsonBody(req, cb) {
    var raw = '';
    req.on('data', function (c) { raw += c; if (raw.length > 65536) req.destroy(); });
    req.on('end', function () {
        var obj;
        try { obj = JSON.parse(raw || '{}'); } catch (e) { return cb(new Error('bad json')); }
        cb(null, obj);
    });
}

function startSession(params) {
    if (session) session.stop();
    var p = {
        host: String(params.host || '').trim(),
        port: parseInt(params.port, 10) || 554,
        user: String(params.user || ''),
        pass: String(params.pass || ''),
        channel: parseInt(params.channel, 10) || 0,
        stream: params.stream || 'main',
        path: params.path || '',
        audio: params.audio !== false && params.audio !== 'off'
    };
    p.paths = reolinkPaths(p);
    log('SESSION_START', { host: p.host, port: p.port, user: p.user, paths: p.paths, audio: p.audio });
    session = new Session(p);
    return session;
}

function handle(req, res) {
    var u = urlMod.parse(req.url, true);
    var path = u.pathname;
    if (req.method === 'OPTIONS') { cors(res, 204, 'text/plain'); return res.end(); }

    if (path === '/ping') {
        return sendJson(res, 200, { ok: true, version: VERSION, running: !!(session && (session.state === 'playing' || session.state === 'connecting' || session.state === 'waiting')) });
    }
    if (path === '/log') return sendJson(res, 200, { ok: true, logs: LOGS });
    if (path === '/status') {
        if (!session) return sendJson(res, 200, { ok: true, state: 'idle' });
        return sendJson(res, 200, session.status());
    }
    if (path === '/start' && req.method === 'POST') {
        return readJsonBody(req, function (err, body) {
            if (err) return sendJson(res, 400, { ok: false, error: err.message });
            if (!body.host) return sendJson(res, 400, { ok: false, error: 'host required' });
            var s;
            try { s = startSession(body); } catch (e) { log('START_THREW', e && e.stack); return sendJson(res, 500, { ok: false, error: 'service error: ' + (e && e.message) }); }
            sendJson(res, 200, { ok: true, id: s.id, url: s.rtsp.url() });
        });
    }
    if (path === '/stop' && req.method === 'POST') {
        if (session) session.stop();
        return sendJson(res, 200, { ok: true });
    }
    if (path === '/live.ts') {
        if (!session || session.state === 'stopped' || session.state === 'error') return sendJson(res, 409, { ok: false, error: 'no stream' });
        return session.serveLive(res);
    }
    if (path === '/live.m3u8') {
        if (!session || session.state === 'stopped' || session.state === 'error') return sendJson(res, 409, { ok: false, error: 'no stream' });
        session.lastMediaActivity = Date.now();
        var pl = session.playlist();
        cors(res, 200, 'application/vnd.apple.mpegurl', { 'Content-Length': Buffer.byteLength(pl) });
        return res.end(pl);
    }
    var sm = /^\/seg\/(\d+)\.ts$/.exec(path);
    if (sm) {
        var seg = session ? session.segment(parseInt(sm[1], 10)) : null;
        if (!seg) { cors(res, 404, 'text/plain'); return res.end('gone'); }
        session.lastMediaActivity = Date.now();
        cors(res, 200, 'video/mp2t', { 'Content-Length': seg.bytes });
        for (var i = 0; i < seg.chunks.length; i++) res.write(seg.chunks[i]);
        return res.end();
    }
    cors(res, 404, 'text/plain');
    res.end('Not Found');
}

var server = http.createServer(handle);
server.on('error', function (e) { log('HTTP_SERVER_ERROR', e && e.message); });

/* The unit tests load this file as a module and bind their own port. */
var underTest = typeof process !== 'undefined' && process && process.env && process.env.REOLINK_RELAY_TEST;
if (!underTest) {
    server.listen(PORT, LISTEN_HOST, function () { log('RELAY_LISTENING', LISTEN_HOST + ':' + PORT + ' v' + VERSION); });
}

process.on('uncaughtException', function (e) {
    var where = (e && e.stack) ? String(e.stack).split('\n').slice(0, 4).join(' <- ') : '';
    log('UNCAUGHT', (e && e.message) + (where ? ' | ' + where : ''));
});

module.exports = {
    VERSION: VERSION,
    handle: handle,
    server: server,
    parseAuthChallenge: parseAuthChallenge,
    buildAuthorization: buildAuthorization,
    parseSdp: parseSdp,
    resolveControl: resolveControl,
    parseRtp: parseRtp,
    VideoDepacketizer: VideoDepacketizer,
    AacDepacketizer: AacDepacketizer,
    aacConfigFromFmtp: aacConfigFromFmtp,
    adtsFrame: adtsFrame,
    crc32mpeg: crc32mpeg,
    TsMuxer: TsMuxer,
    RtspClient: RtspClient,
    reolinkPaths: reolinkPaths,
    startSession: startSession,
    currentSession: function () { return session; },
    logs: LOGS
};
