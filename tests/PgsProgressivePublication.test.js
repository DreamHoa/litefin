import assert from 'node:assert/strict';
import test from 'node:test';
import { PgsRenderer } from 'libpgs';

globalThis.window = globalThis;
globalThis.localStorage = { getItem: () => null, length: 0 };
const { supFrame } = await import('../src/player/core/MkvPgsSource.js');
const { default: MkvPgsRenderer } = await import('../src/player/core/MkvPgsRenderer.js');

test('MKV adapter publishes decoded PGS while the indexed stream waits for playback', async () => {
    let controller;
    const stream = new ReadableStream({
        start(value) {
            controller = value;
            for (const time of [5000, 10000, 15000]) {
                // Valid clear compositions suffice to exercise the real decoder.
                value.enqueue(supFrame(time, new Uint8Array([0x16, 0, 11, 7, 128, 4, 56, 24, 0, 0, 0x80, 0, 0, 0])));
                value.enqueue(supFrame(time, new Uint8Array([0x80, 0, 0])));
            }
            // Remain open: an indexed reader waits for the playback clock.
        }
    });
    const renderer = new PgsRenderer({ canvas: { style: {}, getContext: () => ({}) }, mode: 'mainThread' });
    const originalFetch = globalThis.fetch;
    const originalNow = Object.getOwnPropertyDescriptor(performance, 'now');
    let renders = 0;
    try {
        Object.defineProperty(performance, 'now', { configurable: true, value: () => 0 });
        globalThis.fetch = async () => new Response(stream);
        renderer.implementation.onTimestampsUpdated = () => {};
        renderer.loadFromUrl('https://example.invalid/indexed-pgs');
        globalThis.fetch = originalFetch;
        for (let attempt = 0; attempt < 50 && !renderer.implementation.pgs.updateTimestamps.length; attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 2));
        }
        const impl = renderer.implementation;
        assert.ok(impl.pgs.updateTimestamps.length > 0, 'real decoder parsed the first batch');
        assert.deepEqual(impl.updateTimestamps, [], 'libpgs throttled the progress notification');
        renderer.renderAtTimestamp = () => renders++;
        const adapter = Object.assign(Object.create(MkvPgsRenderer.prototype), {
            _source: { needsRestart: () => false },
            _renderer: renderer,
            _offset: 0
        });
        adapter.tick(5);
        assert.equal(impl.updateTimestamps, impl.pgs.updateTimestamps, 'publish without waiting for another batch');
        assert.equal(renders, 1);
        let notifications = 0;
        impl.onTimestampsUpdated = () => notifications++;
        adapter.tick(6);
        assert.equal(notifications, 0, 'already shared timeline needs no repeated notification');
    } finally {
        globalThis.fetch = originalFetch;
        if (originalNow) Object.defineProperty(performance, 'now', originalNow);
        else delete performance.now;
        controller.close();
        await new Promise((resolve) => setTimeout(resolve, 0));
        renderer.dispose();
    }
});
