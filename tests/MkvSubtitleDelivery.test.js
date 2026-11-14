import assert from 'node:assert/strict';
import test from 'node:test';
import { buildFile } from './fixtures/MkvFixtures.js';
import { normalizeSubtitleCodec } from '../src/player/core/SubtitleCodec.js';

globalThis.window = globalThis;
globalThis.localStorage = { getItem: () => null, length: 0 };
const { createInBandTextSource } = await import('../src/player/core/MkvTextSource.js');
const { createInBandPgsSource, parseHeader, parseCues, readElementHeader } =
    await import('../src/player/core/MkvPgsSource.js');

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

test('A transient 200 response is cancelled and retried before selecting a broken server-extraction fallback', async () => {
    const bytes = buildFile({ subtitleTracks: [[2, 'S_TEXT/UTF8', 'chi']], lines: [{ time: 1000, text: '恢复字幕' }] });
    let first = true;
    let cancelled = false;
    const goodRange = serve(bytes);
    const cues = await readText('S_TEXT/UTF8', 'unused', {
        fetcher: async (...args) => {
            if (first) {
                first = false;
                return {
                    status: 200,
                    body: {
                        cancel: async () => {
                            cancelled = true;
                        }
                    },
                    arrayBuffer: async () => {
                        throw new Error('Must not consume a full-video 200 response');
                    }
                };
            }
            return goodRange(...args);
        }
    });
    assert.equal(cancelled, true);
    assert.equal(cues[0].Text, '恢复字幕');
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
        const first = (await reader.read()).value;
        const second = (await reader.read()).value;
        const chunk = new Uint8Array([...first, ...second]);
        assert.equal(chunk[0], 0x50); // SUP magic "PG"
        assert.equal(chunk[1], 0x47);
        assert.equal(chunk.length, 52); // Two blocks, two segment frames each.
        assert.equal(source.needsRestart(0), true);
        await reader.cancel();
    } finally {
        source.dispose();
    }
});

test('One persistently failing PGS block cannot block delivery of all subsequent valid subtitles', async () => {
    const segment = new Uint8Array([0x16, 0, 0, 0x80, 0, 0]);
    const bytes = buildFile({
        subtitleTracks: [[2, 'S_HDMV/PGS', 'chi']],
        lines: [
            { time: 1000, text: segment },
            { time: 2000, text: segment },
            { time: 3000, text: segment }
        ]
    });
    const header = parseHeader(bytes);
    const cuesStart = header.segmentDataOffset + header.cuesOffset;
    const cuesHeader = readElementHeader(bytes, cuesStart);
    const cues = parseCues(bytes, cuesStart + cuesHeader.headerLength, cuesHeader.size, 2);
    const clusterStart = header.segmentDataOffset + cues[1].clusterPosition;
    const clusterHeader = readElementHeader(bytes, clusterStart);
    const failedBlock = clusterStart + clusterHeader.headerLength + cues[1].relativePosition;
    const goodRange = serve(bytes);
    let failures = 0;
    const source = createInBandPgsSource({
        streamUrl: 'unused',
        subtitleOrdinal: 0,
        getTime: () => 0,
        lookaheadSeconds: 30,
        fetcher: async (url, init) => {
            if (Number(/bytes=(\d+)/.exec(init.headers.Range)[1]) === failedBlock) {
                failures++;
                return { status: 503, body: null };
            }
            return goodRange(url, init);
        }
    });
    try {
        assert.equal(await source.ready, true);
        const reader = source.readable.getReader();
        const batch = await Promise.race([
            (async () => {
                const chunks = [];
                for (;;) {
                    const { value, done } = await reader.read();
                    if (done) return { value: new Uint8Array(chunks.flatMap((chunk) => [...chunk])) };
                    chunks.push(value);
                }
            })(),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error('A failed PGS cue stalled the entire batch')), 3000)
            )
        ]);
        assert.equal(failures, 3);
        assert.equal(batch.value.length, 52, 'Both valid blocks must still reach the decoder');
        await reader.cancel();
    } finally {
        source.dispose();
    }
});

test('Ready PGS compositions reach the decoder before slower future lookahead blocks', async () => {
    const segment = new Uint8Array([0x16, 0, 0, 0x80, 0, 0]);
    const bytes = buildFile({
        subtitleTracks: [[2, 'S_HDMV/PGS', 'chi']],
        lines: [
            { time: 1000, text: segment },
            { time: 2000, text: segment }
        ]
    });
    const header = parseHeader(bytes);
    const cuesStart = header.segmentDataOffset + header.cuesOffset;
    const cuesHeader = readElementHeader(bytes, cuesStart);
    const cues = parseCues(bytes, cuesStart + cuesHeader.headerLength, cuesHeader.size, 2);
    const clusterStart = header.segmentDataOffset + cues[1].clusterPosition;
    const clusterHeader = readElementHeader(bytes, clusterStart);
    const delayedBlock = clusterStart + clusterHeader.headerLength + cues[1].relativePosition;
    let release;
    const delayed = new Promise((resolve) => {
        release = resolve;
    });
    const goodRange = serve(bytes);
    const source = createInBandPgsSource({
        streamUrl: 'unused',
        subtitleOrdinal: 0,
        getTime: () => 0,
        fetcher: async (url, init) => {
            if (Number(/bytes=(\d+)/.exec(init.headers.Range)[1]) === delayedBlock) await delayed;
            return goodRange(url, init);
        }
    });
    let reader;
    try {
        assert.equal(await source.ready, true);
        reader = source.readable.getReader();
        const first = await Promise.race([
            reader.read(),
            new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Ready composition waited for a future block')), 500)
            )
        ]);
        assert.equal(first.value.length, 26);
        release();
        const second = await reader.read();
        assert.equal(second.value.length, 26);
        assert.ok(new DataView(first.value.buffer).getUint32(2) < new DataView(second.value.buffer).getUint32(2));
    } finally {
        release();
        source.dispose();
        await reader?.cancel();
    }
});

for (const payloadLength of [20000, 60000]) {
    test(`Cold PGS start coalesces a ${payloadLength} byte composition and reuses validation data`, async () => {
        const segment = new Uint8Array(payloadLength + 6);
        segment.set([0x15, payloadLength >> 8, payloadLength & 255]);
        segment.set([0x80, 0, 0], payloadLength + 3);
        const bytes = buildFile({ subtitleTracks: [[2, 'S_HDMV/PGS', 'chi']], lines: [{ time: 1000, text: segment }] });
        const header = parseHeader(bytes);
        const cuesStart = header.segmentDataOffset + header.cuesOffset;
        const cuesHeader = readElementHeader(bytes, cuesStart);
        const cue = parseCues(bytes, cuesStart + cuesHeader.headerLength, cuesHeader.size, 2)[0];
        const clusterStart = header.segmentDataOffset + cue.clusterPosition;
        const blockStart = clusterStart + readElementHeader(bytes, clusterStart).headerLength + cue.relativePosition;
        const goodRange = serve(bytes);
        const blockRequests = [];
        const source = createInBandPgsSource({
            streamUrl: 'unused',
            subtitleOrdinal: 0,
            getTime: () => 1,
            startTime: 1,
            fetcher: (url, init) => {
                const [, start, end] = /bytes=(\d+)-(\d+)/.exec(init.headers.Range).map(Number);
                if (start >= blockStart && start < blockStart + segment.length) blockRequests.push({ start, end });
                return goodRange(url, init);
            }
        });
        try {
            assert.equal(await source.ready, true);
            const reader = source.readable.getReader();
            const { value } = await reader.read();
            assert.equal(value.length, segment.length + 20, 'both complete segments keep their SUP headers');
            assert.deepEqual(value.slice(10, payloadLength + 13), segment.slice(0, payloadLength + 3));
            assert.equal(
                blockRequests.length,
                payloadLength < 32768 ? 1 : 2,
                'avoid duplicate reads, but preserve the exact tail for oversized compositions'
            );
            assert.ok(
                blockRequests[0].end - blockRequests[0].start + 1 <= 32768,
                'bounded range, never whole-file consumption'
            );
            await reader.cancel();
        } finally {
            source.dispose();
        }
    });
}
