'use strict';
/*
 * Tests for the RTSP relay service. Run with:  node --test tests
 *
 * The unit tests exercise the parsers and the TS muxer directly. The
 * integration test stands up a fake RTSP camera (Digest auth, interleaved
 * RTP over TCP, H.265 fragments and AAC) and checks what the relay serves on
 * /live.ts, /live.m3u8 and /status.
 */
process.env.REOLINK_RELAY_TEST = '1';

const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const http = require('http');
const crypto = require('crypto');
const path = require('path');

const relay = require(path.join(__dirname, '..', 'service', 'relay.js'));

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------- unit tests

test('CRC-32/MPEG-2 matches the reference vector', () => {
    assert.strictEqual(relay.crc32mpeg(Buffer.from('123456789')), 0x0376E6E7);
});

test('Digest auth without qop follows RFC 2617', () => {
    const challenges = relay.parseAuthChallenge('Digest realm="Login to 1234", nonce="abc123"');
    assert.strictEqual(challenges.length, 1);
    const header = relay.buildAuthorization(challenges, 'admin', 'secret', 'DESCRIBE', 'rtsp://cam/h265Preview_01_main', 1);
    const expected = md5(md5('admin:Login to 1234:secret') + ':abc123:' + md5('DESCRIBE:rtsp://cam/h265Preview_01_main'));
    assert.match(header, /^Digest username="admin", realm="Login to 1234", nonce="abc123"/);
    assert.ok(header.includes('response="' + expected + '"'));
    assert.ok(!header.includes('qop='));
});

test('Digest auth with qop=auth uses nc and cnonce', () => {
    const challenges = relay.parseAuthChallenge('Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"');
    const header = relay.buildAuthorization(challenges, 'Mufasa', 'Circle Of Life', 'GET', '/dir/index.html', 1);
    const cnonce = /cnonce="([^"]+)"/.exec(header)[1];
    const ha1 = md5('Mufasa:testrealm@host.com:Circle Of Life');
    const ha2 = md5('GET:/dir/index.html');
    const expected = md5(ha1 + ':dcd98b7102dd2f0e8b11d0f600bfb0c093:00000001:' + cnonce + ':auth:' + ha2);
    assert.ok(header.includes('response="' + expected + '"'), header);
    assert.ok(header.includes('opaque="5ccc069c403ebaf9f0171e9517f40e41"'));
    assert.ok(header.includes('nc=00000001'));
});

test('Basic auth is used when Digest is not offered', () => {
    const challenges = relay.parseAuthChallenge('Basic realm="camera"');
    const header = relay.buildAuthorization(challenges, 'admin', 'pw', 'DESCRIBE', 'rtsp://x/', 1);
    assert.strictEqual(header, 'Basic ' + Buffer.from('admin:pw').toString('base64'));
});

const REOLINK_SDP = [
    'v=0', 'o=- 1 1 IN IP4 192.168.1.50', 's=Session', 't=0 0', 'a=control:*',
    'm=video 0 RTP/AVP 96', 'a=rtpmap:96 H265/90000',
    'a=fmtp:96 sprop-vps=QAEMAf//AWAAAAMAgAAAAwAAAwCZrAk=;sprop-sps=QgEBAWAAAAMAgAAAAwAAAwCZoAFAIAWhY2uSTL03AQEBAIA=;sprop-pps=RAHA8vA8kA==',
    'a=control:trackID=1',
    'm=audio 0 RTP/AVP 97', 'a=rtpmap:97 MPEG4-GENERIC/16000/1',
    'a=fmtp:97 streamtype=5;profile-level-id=1;mode=AAC-hbr;sizelength=13;indexlength=3;indexdeltalength=3;config=1408',
    'a=control:trackID=2', ''
].join('\r\n');

test('SDP parsing picks up codecs, clocks, controls and fmtp', () => {
    const sdp = relay.parseSdp(REOLINK_SDP);
    assert.strictEqual(sdp.media.length, 2);
    const [video, audio] = sdp.media;
    assert.strictEqual(video.codec, 'H265');
    assert.strictEqual(video.clock, 90000);
    assert.strictEqual(video.control, 'trackID=1');
    assert.ok(video.fmtp['sprop-vps'].startsWith('QAEM'));
    assert.strictEqual(audio.codec, 'MPEG4-GENERIC');
    assert.strictEqual(audio.clock, 16000);
    assert.strictEqual(audio.fmtp.config, '1408');
    assert.strictEqual(relay.resolveControl('rtsp://cam/h265Preview_01_main', 'trackID=1'), 'rtsp://cam/h265Preview_01_main/trackID=1');
    assert.strictEqual(relay.resolveControl('rtsp://cam/x/', 'rtsp://cam/abs'), 'rtsp://cam/abs');
    assert.strictEqual(relay.resolveControl('rtsp://cam/x', '*'), 'rtsp://cam/x');
});

test('AAC config from fmtp and the ADTS header', () => {
    const cfg = relay.aacConfigFromFmtp({ config: '1408' }, 16000, 1);
    assert.deepStrictEqual(cfg, { objectType: 2, sampleRateIndex: 8, channels: 1 });
    const frame = relay.adtsFrame(cfg, Buffer.alloc(100, 0xAB));
    assert.strictEqual(frame.length, 107);
    assert.strictEqual(frame[0], 0xFF);
    assert.strictEqual(frame[1], 0xF1);
    assert.strictEqual(frame[2] >> 6, 1);                     // profile = AAC-LC
    assert.strictEqual((frame[2] >> 2) & 0x0F, 8);            // 16 kHz
    const length = ((frame[3] & 0x03) << 11) | (frame[4] << 3) | (frame[5] >> 5);
    assert.strictEqual(length, 107);
    const fallback = relay.aacConfigFromFmtp({}, 8000, 2);
    assert.strictEqual(fallback.sampleRateIndex, 11);
    assert.strictEqual(fallback.channels, 2);
});

function rtp(seq, ts, marker, payload, pt = 96) {
    const hdr = Buffer.alloc(12);
    hdr[0] = 0x80;
    hdr[1] = (marker ? 0x80 : 0) | pt;
    hdr.writeUInt16BE(seq & 0xFFFF, 2);
    hdr.writeUInt32BE(ts >>> 0, 4);
    hdr.writeUInt32BE(0x12345678, 8);
    return Buffer.concat([hdr, payload]);
}

function h265Fus(nal, chunk) {
    const type = (nal[0] >> 1) & 0x3F;
    const out = [];
    for (let off = 2; off < nal.length; off += chunk) {
        const start = off === 2, end = off + chunk >= nal.length;
        const fuHeader = (start ? 0x80 : 0) | (end ? 0x40 : 0) | type;
        out.push(Buffer.concat([Buffer.from([(nal[0] & 0x81) | (49 << 1), nal[1], fuHeader]), nal.slice(off, off + chunk)]));
    }
    return out;
}

test('H.265 depacketizer reassembles fragments and aggregation packets', () => {
    const units = [];
    const dep = new relay.VideoDepacketizer('H265', (u) => units.push(u));
    const idr = Buffer.concat([Buffer.from([0x26, 0x01]), crypto.randomBytes(3000)]);   // type 19 IDR_W_RADL
    const fus = h265Fus(idr, 1400);
    let seq = 100;
    fus.forEach((p, i) => dep.push(relay.parseRtp(rtp(seq++, 9000, i === fus.length - 1, p))));
    assert.strictEqual(units.length, 1);
    assert.ok(units[0].key);
    assert.strictEqual(units[0].nalus.length, 1);
    assert.ok(units[0].nalus[0].equals(idr));
    assert.strictEqual(units[0].pts, 9000);

    const sei = Buffer.from([0x4E, 0x01, 0x05, 0x01, 0x02]);
    const trail = Buffer.concat([Buffer.from([0x02, 0x01]), crypto.randomBytes(200)]);
    const ap = Buffer.concat([Buffer.from([0x60, 0x01]),
        Buffer.from([sei.length >> 8, sei.length & 0xFF]), sei,
        Buffer.from([trail.length >> 8, trail.length & 0xFF]), trail]);
    dep.push(relay.parseRtp(rtp(seq++, 12600, true, ap)));
    assert.strictEqual(units.length, 2);
    assert.ok(!units[1].key);
    assert.strictEqual(units[1].nalus.length, 2);
    assert.ok(units[1].nalus[1].equals(trail));
});

test('H.264 depacketizer handles FU-A and STAP-A', () => {
    const units = [];
    const dep = new relay.VideoDepacketizer('H264', (u) => units.push(u));
    const idr = Buffer.concat([Buffer.from([0x65]), crypto.randomBytes(2500)]);
    let seq = 1;
    for (let off = 1; off < idr.length; off += 1000) {
        const start = off === 1, end = off + 1000 >= idr.length;
        const p = Buffer.concat([Buffer.from([(idr[0] & 0xE0) | 28, (start ? 0x80 : 0) | (end ? 0x40 : 0) | 5]), idr.slice(off, off + 1000)]);
        dep.push(relay.parseRtp(rtp(seq++, 3000, end, p)));
    }
    assert.strictEqual(units.length, 1);
    assert.ok(units[0].key && units[0].nalus[0].equals(idr));

    const sps = Buffer.from([0x67, 0x42, 0x00, 0x1E]), pps = Buffer.from([0x68, 0xCE, 0x38, 0x80]);
    const stap = Buffer.concat([Buffer.from([0x78]), Buffer.from([0, sps.length]), sps, Buffer.from([0, pps.length]), pps]);
    dep.push(relay.parseRtp(rtp(seq++, 6600, false, stap)));
    const slice = Buffer.concat([Buffer.from([0x41]), crypto.randomBytes(50)]);
    dep.push(relay.parseRtp(rtp(seq++, 6600, true, slice)));
    assert.strictEqual(units.length, 2);
    assert.strictEqual(units[1].nalus.length, 3);
    assert.ok(units[1].nalus[0].equals(sps) && units[1].nalus[2].equals(slice));
});

test('Timestamp unwrapping survives the 32-bit wrap', () => {
    const units = [];
    const dep = new relay.VideoDepacketizer('H264', (u) => units.push(u));
    dep.push(relay.parseRtp(rtp(1, 0xFFFFF000, true, Buffer.from([0x41, 1, 2]))));
    dep.push(relay.parseRtp(rtp(2, 0x00000E10, true, Buffer.from([0x41, 1, 2]))));
    assert.strictEqual(units[1].pts - units[0].pts, 0x1000 + 0xE10);
});

test('AAC depacketizer splits multiple access units per packet', () => {
    const frames = [];
    const dep = new relay.AacDepacketizer({ sizelength: '13', indexlength: '3', indexdeltalength: '3' }, 16000, (f) => frames.push(f));
    const au1 = crypto.randomBytes(120), au2 = crypto.randomBytes(130);
    const headers = Buffer.from([0x00, 0x20, (au1.length << 3) >> 8, (au1.length << 3) & 0xFF, (au2.length << 3) >> 8, (au2.length << 3) & 0xFF]);
    dep.push(relay.parseRtp(rtp(7, 48000, true, Buffer.concat([headers, au1, au2]), 97)));
    assert.strictEqual(frames.length, 2);
    assert.ok(frames[0].frame.equals(au1) && frames[1].frame.equals(au2));
    assert.strictEqual(frames[1].pts - frames[0].pts, 1024);
});

/* A small TS reader: packets -> { pid, pusi, payload } with the adaptation field skipped. */
function tsPackets(buf) {
    assert.strictEqual(buf.length % 188, 0, 'TS length is a multiple of 188');
    const out = [];
    for (let off = 0; off < buf.length; off += 188) {
        const p = buf.slice(off, off + 188);
        assert.strictEqual(p[0], 0x47, 'sync byte at ' + off);
        const pusi = !!(p[1] & 0x40);
        const pid = ((p[1] & 0x1F) << 8) | p[2];
        const afc = (p[3] >> 4) & 0x03;
        let payloadOff = 4;
        let af = null;
        if (afc & 2) { af = p.slice(5, 5 + p[4]); payloadOff = 5 + p[4]; }
        out.push({ pid, pusi, cc: p[3] & 0x0F, af, payload: (afc & 1) ? p.slice(payloadOff) : Buffer.alloc(0) });
    }
    return out;
}
function readPts(pes) {
    const b = pes.slice(9, 14);
    return (((b[0] >> 1) & 0x07) * 1073741824) + (((b[1] << 7) | (b[2] >> 1)) & 0x7FFF) * 32768 + (((b[3] << 7) | (b[4] >> 1)) & 0x7FFF);
}

test('TS muxer writes valid PAT/PMT, PTS and PCR', () => {
    const mux = new relay.TsMuxer({ videoCodec: 'H265', hasAudio: true });
    const vps = Buffer.from([0x40, 0x01, 0x0C]), sps = Buffer.from([0x42, 0x01, 0x01]), pps = Buffer.from([0x44, 0x01, 0xC0]);
    const idr = Buffer.concat([Buffer.from([0x26, 0x01]), crypto.randomBytes(500)]);
    const pts = 5 * 90000 + 4294967296 + 12345;            // past the 32-bit boundary, under 2^33
    const ts = Buffer.concat([mux.tables(), mux.videoUnit(pts, [idr], true, [vps, sps, pps])]);
    const packets = tsPackets(ts);

    const pat = packets[0];
    assert.strictEqual(pat.pid, 0);
    const patSection = pat.payload.slice(1);
    const patLen = ((patSection[1] & 0x0F) << 8) | patSection[2];
    assert.strictEqual(relay.crc32mpeg(patSection, 3 + patLen - 4), patSection.readUInt32BE(3 + patLen - 4));

    const pmt = packets[1];
    assert.strictEqual(pmt.pid, 0x1000);
    const pmtSection = pmt.payload.slice(1);
    assert.strictEqual(pmtSection[0], 0x02);
    const streamTypes = [];
    const pmtLen = ((pmtSection[1] & 0x0F) << 8) | pmtSection[2];
    for (let o = 12; o < 3 + pmtLen - 4; o += 5) streamTypes.push(pmtSection[o]);
    assert.deepStrictEqual(streamTypes, [0x24, 0x0F]);

    const video = packets.slice(2);
    assert.ok(video.every((p) => p.pid === 0x100));
    assert.ok(video[0].pusi && !video[1].pusi);
    assert.ok(video[0].af[0] & 0x40, 'random access indicator on keyframe');
    assert.ok(video[0].af[0] & 0x10, 'PCR present');
    const pes = video[0].payload;
    assert.deepStrictEqual([...pes.slice(0, 4)], [0, 0, 1, 0xE0]);
    assert.strictEqual(readPts(pes), pts);
    const es = Buffer.concat(video.map((p) => p.payload)).slice(14);
    assert.deepStrictEqual([...es.slice(0, 7)], [0, 0, 0, 1, 0x46, 0x01, 0x50], 'starts with an AUD');
    assert.ok(es.indexOf(Buffer.concat([Buffer.from([0, 0, 0, 1]), vps])) > 0, 'VPS repeated before the keyframe');
    assert.ok(es.indexOf(idr) > 0, 'IDR payload present');
    // Continuity counters advance by one per packet on the video PID.
    for (let i = 1; i < video.length; i++) assert.strictEqual(video[i].cc, (video[i - 1].cc + 1) & 0x0F);

    const audio = tsPackets(mux.audioFrame(pts + 1800, relay.adtsFrame({ objectType: 2, sampleRateIndex: 8, channels: 1 }, Buffer.alloc(50))));
    assert.strictEqual(audio[0].pid, 0x101);
    assert.strictEqual(audio[0].payload.readUInt16BE(4), 3 + 5 + 57, 'bounded PES length for audio');
});

test('Reolink path candidates', () => {
    assert.deepStrictEqual(relay.reolinkPaths({ channel: 0, stream: 'main' }),
        ['/h265Preview_01_main', '/h264Preview_01_main', '/Preview_01_main']);
    assert.deepStrictEqual(relay.reolinkPaths({ channel: 3, stream: 'sub' }), ['/h264Preview_04_sub', '/Preview_04_sub']);
    assert.deepStrictEqual(relay.reolinkPaths({ channel: 0, stream: 'main', path: 'h264Preview_01_main' }), ['/h264Preview_01_main']);
});

// --------------------------------------------------------- integration test

/* A fake Reolink: Digest auth, 404 on the h265 path so the relay has to fall
 * back, TCP-interleaved H.265 + AAC once PLAY is received. */
function fakeCamera({ user, pass, realm = 'Reolink' }) {
    const nonce = crypto.randomBytes(8).toString('hex');
    const state = { describes: [], teardown: false, socket: null, frames: 0 };
    const server = net.createServer((socket) => {
        state.socket = socket;
        let buf = '';
        let timer = null;
        socket.on('data', (d) => {
            buf += d.toString('latin1');
            let idx;
            while ((idx = buf.indexOf('\r\n\r\n')) >= 0) {
                const head = buf.slice(0, idx);
                buf = buf.slice(idx + 4);
                const lines = head.split('\r\n');
                const [method, url] = lines[0].split(' ');
                const headers = {};
                lines.slice(1).forEach((l) => { const c = l.indexOf(':'); if (c > 0) headers[l.slice(0, c).toLowerCase()] = l.slice(c + 1).trim(); });
                const cseq = headers.cseq;
                const reply = (status, extra = '', body = '') =>
                    socket.write(`RTSP/1.0 ${status}\r\nCSeq: ${cseq}\r\n${extra}${body ? 'Content-Length: ' + Buffer.byteLength(body) + '\r\n' : ''}\r\n${body}`);

                if (method === 'OPTIONS') { reply('200 OK', 'Public: OPTIONS, DESCRIBE, SETUP, PLAY, TEARDOWN, GET_PARAMETER\r\n'); continue; }
                if (method === 'DESCRIBE') {
                    state.describes.push(url);
                    const auth = headers.authorization || '';
                    const want = (() => {
                        const m = /response="([0-9a-f]+)"/.exec(auth);
                        if (!m) return false;
                        const uri = /uri="([^"]+)"/.exec(auth)[1];
                        return m[1] === md5(md5(`${user}:${realm}:${pass}`) + ':' + nonce + ':' + md5('DESCRIBE:' + uri));
                    })();
                    if (!want) { reply('401 Unauthorized', `WWW-Authenticate: Digest realm="${realm}", nonce="${nonce}"\r\n`); continue; }
                    if (url.endsWith('/h265Preview_01_main')) { reply('404 Not Found'); continue; }
                    reply('200 OK', `Content-Base: ${url}/\r\nContent-Type: application/sdp\r\n`, REOLINK_SDP);
                    continue;
                }
                if (method === 'SETUP') { reply('200 OK', `Session: 7A3F;timeout=60\r\nTransport: ${headers.transport}\r\n`); continue; }
                if (method === 'PLAY') {
                    reply('200 OK', 'Session: 7A3F\r\nRange: npt=0.000-\r\n');
                    let seq = 0, aseq = 0, ts = 1000000, ats = 5000;
                    const interleave = (ch, pkt) => socket.write(Buffer.concat([Buffer.from([0x24, ch, pkt.length >> 8, pkt.length & 0xFF]), pkt]));
                    timer = setInterval(() => {
                        state.frames++;
                        const key = state.frames % 25 === 1;
                        if (key) {
                            const idr = Buffer.concat([Buffer.from([0x26, 0x01]), Buffer.alloc(4000, 0x5A)]);
                            const fus = h265Fus(idr, 1400);
                            fus.forEach((p, i) => interleave(0, rtp(seq++, ts, i === fus.length - 1, p)));
                        } else {
                            interleave(0, rtp(seq++, ts, true, Buffer.concat([Buffer.from([0x02, 0x01]), Buffer.alloc(300, 0xA5)])));
                        }
                        ts += 3600;
                        if (state.frames % 2 === 0) {
                            const au = Buffer.alloc(64, 0x33);
                            interleave(2, rtp(aseq++, ats, true, Buffer.concat([Buffer.from([0x00, 0x10, (au.length << 3) >> 8, (au.length << 3) & 0xFF]), au]), 97));
                            ats += 1024;
                        }
                    }, 10);
                    continue;
                }
                if (method === 'GET_PARAMETER') { reply('200 OK', 'Session: 7A3F\r\n'); continue; }
                if (method === 'TEARDOWN') { state.teardown = true; reply('200 OK'); continue; }
                reply('405 Method Not Allowed');
            }
        });
        socket.on('close', () => clearInterval(timer));
        socket.on('error', () => {});
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, state })));
}

function get(base, p, { timeout = 2000, maxBytes = Infinity } = {}) {
    return new Promise((resolve, reject) => {
        const req = http.get(base + p, (res) => {
            const chunks = [];
            let size = 0;
            const done = () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) });
            res.on('data', (c) => { chunks.push(c); size += c.length; if (size >= maxBytes) { req.destroy(); done(); } });
            res.on('end', done);
            res.on('error', () => done());
            setTimeout(() => { req.destroy(); done(); }, timeout);
        });
        req.on('error', (e) => { if (!e || e.code !== 'ECONNRESET') reject(e); });
    });
}
function post(base, p, body) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(body || {});
        const req = http.request(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString()) }));
        });
        req.on('error', reject);
        req.end(data);
    });
}

test('relay: RTSP in, TS and HLS out', async () => {
    const cam = await fakeCamera({ user: 'admin', pass: 'hunter2' });
    const relayServer = http.createServer(relay.handle);
    await new Promise((resolve) => relayServer.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + relayServer.address().port;
    try {
        const ping = await get(base, '/ping');
        assert.strictEqual(JSON.parse(ping.body).ok, true);
        assert.strictEqual(JSON.parse((await get(base, '/status')).body).state, 'idle');

        const started = await post(base, '/start', { host: '127.0.0.1', port: cam.port, user: 'admin', pass: 'hunter2', channel: 0, stream: 'main', audio: 'on' });
        assert.strictEqual(started.status, 200);

        let status;
        for (let i = 0; i < 100; i++) {
            await sleep(50);
            status = JSON.parse((await get(base, '/status')).body);
            if (status.state === 'playing' || status.state === 'error') break;
        }
        assert.strictEqual(status.state, 'playing', JSON.stringify(status));
        assert.strictEqual(status.video.codec, 'H265');
        assert.strictEqual(status.audio.codec, 'AAC');
        assert.ok(status.url.endsWith('/h264Preview_01_main'), 'fell back after 404 on the h265 path');
        assert.ok(cam.state.describes.some((u) => u.endsWith('/h265Preview_01_main')));

        const live = await get(base, '/live.ts', { timeout: 1500, maxBytes: 150000 });
        assert.strictEqual(live.status, 200);
        assert.strictEqual(live.headers['content-type'], 'video/mp2t');
        const packets = tsPackets(live.body);
        assert.strictEqual(packets[0].pid, 0, 'stream starts with a PAT');
        assert.strictEqual(packets[1].pid, 0x1000, 'then the PMT');
        const firstVideo = packets.find((p) => p.pid === 0x100);
        assert.ok(firstVideo.pusi && (firstVideo.af[0] & 0x40), 'then a keyframe');
        const pids = new Set(packets.map((p) => p.pid));
        assert.ok(pids.has(0x101), 'audio packets present');
        const all = Buffer.concat(packets.filter((p) => p.pid === 0x100).map((p) => p.payload));
        assert.ok(all.indexOf(Buffer.alloc(200, 0x5A)) >= 0, 'keyframe bytes made it through fragment reassembly');

        for (let i = 0; i < 100; i++) {
            status = JSON.parse((await get(base, '/status')).body);
            if (status.segments >= 3) break;
            await sleep(50);
        }
        assert.ok(status.segments >= 3, 'segments: ' + status.segments);
        const playlist = (await get(base, '/live.m3u8')).body.toString();
        assert.match(playlist, /#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:\d+\n#EXT-X-MEDIA-SEQUENCE:1\n/);
        const segs = playlist.match(/seg\/\d+\.ts/g);
        assert.ok(segs.length >= 3);
        const seg = await get(base, '/' + segs[0]);
        assert.strictEqual(seg.status, 200);
        assert.strictEqual(seg.body.length % 188, 0);
        assert.strictEqual(tsPackets(seg.body)[0].pid, 0, 'segment starts with PAT');
        assert.strictEqual((await get(base, '/seg/9999.ts')).status, 404);

        const stopped = await post(base, '/stop');
        assert.strictEqual(stopped.json.ok, true);
        await sleep(50);
        assert.strictEqual(JSON.parse((await get(base, '/status')).body).state, 'stopped');
        assert.ok(cam.state.teardown, 'TEARDOWN sent to the camera');
        assert.strictEqual((await get(base, '/live.ts')).status, 409);
    } finally {
        relayServer.close();
        cam.server.close();
        if (cam.state.socket) cam.state.socket.destroy();
    }
});

test('relay: wrong password is reported as an auth error', async () => {
    const cam = await fakeCamera({ user: 'admin', pass: 'right' });
    try {
        const session = relay.startSession({ host: '127.0.0.1', port: cam.port, user: 'admin', pass: 'wrong', channel: 0, stream: 'sub' });
        for (let i = 0; i < 60 && session.state !== 'error'; i++) await sleep(50);
        assert.strictEqual(session.state, 'error');
        assert.strictEqual(session.errorCode, 'auth');
    } finally {
        cam.server.close();
        if (cam.state.socket) cam.state.socket.destroy();
    }
});

test('relay: unreachable host is reported', async () => {
    const closed = net.createServer();
    await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const port = closed.address().port;
    closed.close();
    await sleep(20);
    const session = relay.startSession({ host: '127.0.0.1', port, user: 'a', pass: 'b', channel: 0, stream: 'sub' });
    for (let i = 0; i < 60 && session.state !== 'error'; i++) await sleep(50);
    assert.strictEqual(session.state, 'error');
    assert.strictEqual(session.errorCode, 'unreachable');
});
