import assert from 'node:assert/strict';
import test from 'node:test';
import { buildFile } from './fixtures/MkvFixtures.js';
import { normalizeSubtitleCodec } from '../src/player/core/SubtitleCodec.js';

globalThis.window = globalThis;
globalThis.localStorage = { getItem: () => null, length: 0 };
const { createInBandTextSource } = await import('../src/player/core/MkvTextSource.js');
const { createInBandPgsSource } = await import('../src/player/core/MkvPgsSource.js');

function serve(bytes, status = 206) {
    return async (_url, init) => {
        const [, start, end] = /bytes=(\d+)-(\d+)/.exec(init.headers.Range).map(Number);
        return { status, arrayBuffer: async () => bytes.slice(start, Math.min(end + 1, bytes.length)).buffer };
    };
}

async function readText(codec, text, extra = {}) {
    let resolve;
    const batch = new Promise((r) => {
        resolve = r;
    });
    const bytes = buildFile({ subtitleTracks: [[2, codec, 'chi']], lines: [{ time: 1000, text, duration: 2500 }] });
    const source = createInBandTextSource({
        streamUrl: 'https://example.invalid/video',
        subtitleOrdinal: 0,
        language: 'zho',
        getTime: () => 1,
        fetcher: serve(bytes),
        onEvents: resolve,
        ...extra
    });
    try {
        assert.equal(await source.ready, true);
        return await Promise.race([
            batch,
            new Promise((_, reject) => setTimeout(() => reject(new Error('No subtitle cues')), 1000))
        ]);
    } finally {
        source.dispose();
    }
}

test('Emby PGS and SRT aliases normalize before delivery and native mapping', () => {
    assert.equal(normalizeSubtitleCodec('HDMV_PGS_SUBTITLE'), 'pgssub');
    assert.equal(normalizeSubtitleCodec('PGS'), 'pgssub');
    assert.equal(normalizeSubtitleCodec('SUBRIP'), 'subrip');
});

test('MKV SubRip reads indexed bytes and preserves absolute duration and Chinese text', async () => {
    const cues = await readText('S_TEXT/UTF8', '中文字幕');
    assert.deepEqual(cues, [{ StartPositionTicks: 10000000, EndPositionTicks: 35000000, Text: '中文字幕' }]);
});

test('MKV ASS dialogue fallback handles style fields, line breaks and text commas', async () => {
    const cues = await readText('S_TEXT/ASS', '0,0,Default,,0,0,0,,{\\i1}你好\\N世界,字幕');
    assert.equal(cues[0].Text, '你好\n世界,字幕');
});

test('Reader rejects a full-video 200 response instead of downloading or interpreting it as a range', async () => {
    const bytes = buildFile({ lines: [{ time: 1000, text: 'text' }] });
    const source = createInBandTextSource({
        streamUrl: 'unused',
        subtitleOrdinal: 0,
        getTime: () => 0,
        fetcher: serve(bytes, 200),
        onEvents() {}
    });
    try {
        assert.equal(await source.ready, false);
    } finally {
        source.dispose();
    }
});

test('PGS reader frames indexed blocks as SUP and reads the next display set beyond the lookahead', async () => {
    const segment = new Uint8Array([0x16, 0, 0, 0x80, 0, 0]);
    const bytes = buildFile({
        subtitleTracks: [[2, 'S_HDMV/PGS', 'chi']],
        lines: [
            { time: 5000, text: segment },
            { time: 20000, text: segment }
        ]
    });
    const source = createInBandPgsSource({
        streamUrl: 'unused',
        subtitleOrdinal: 0,
        startTime: 5,
        getTime: () => 5,
        lookaheadSeconds: 2,
        fetcher: serve(bytes)
    });
    try {
        assert.equal(await source.ready, true);
        const reader = source.readable.getReader();
        const chunk = (await reader.read()).value;
        assert.equal(chunk[0], 0x50); // SUP magic "PG"
        assert.equal(chunk[1], 0x47);
        assert.equal(chunk.length, 52); // Two blocks, two segment frames each.
        assert.equal(source.needsRestart(0), true);
        await reader.cancel();
    } finally {
        source.dispose();
    }
});
