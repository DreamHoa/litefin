import { PgsRenderer } from 'libpgs';
import { createInBandPgsSource } from './MkvPgsSource.js';
import { logger } from '../../utils/Logger.js';

const log = logger.create('MkvPgsRenderer');
let sequence = 0;

/** Canvas rendering of indexed MKV PGS blocks, using the playback clock. */
export default class MkvPgsRenderer {
    constructor({ container, streamUrl, subtitleOrdinal, getTime, fetcher }) {
        this._options = { streamUrl, subtitleOrdinal, getTime, fetcher };
        this._offset = 0;
        this._generation = 0;
        this._disposed = false;
        this._restarting = false;
        this._canvas = document.createElement('canvas');
        this._canvas.className = 'pgs-subtitle-wrapper';
        Object.assign(this._canvas.style, {
            position: 'absolute',
            inset: '0',
            width: '100%',
            height: '100%',
            objectFit: 'contain',
            pointerEvents: 'none',
            zIndex: '30'
        });
        container.appendChild(this._canvas);
        this.ready = this._start();
    }

    async _start() {
        const generation = ++this._generation;
        this._restarting = true;
        this._source?.dispose();
        this._renderer?.dispose();
        this._renderer = null;
        const source = createInBandPgsSource({
            ...this._options,
            getTime: () => this._options.getTime() + this._offset,
            startTime: this._options.getTime() + this._offset
        });
        this._source = source;
        try {
            if (!(await source.ready)) throw new Error('MKV has no supported indexed PGS track');
            if (this._disposed || generation !== this._generation) return false;
            // libpgs 0.8 loads URLs synchronously up to its first fetch. The
            // temporary synthetic response stays on the main thread, where our
            // indexed reader can follow the AVPlay clock without downloading MKV.
            const renderer = new PgsRenderer({ canvas: this._canvas, mode: 'mainThread' });
            this._renderer = renderer;
            const impl = renderer.implementation;
            impl.previousTimestampIndex = -2;
            impl.onTimestampsUpdated = () => {
                if (this._disposed || generation !== this._generation) return;
                impl.previousTimestampIndex = -2;
                renderer.renderAtTimestamp(this._options.getTime() + this._offset);
            };
            const url = `litefin-mkv-pgs:${++sequence}`;
            const originalFetch = globalThis.fetch;
            globalThis.fetch = (input, init) =>
                (typeof input === 'string' ? input : input?.url) === url
                    ? Promise.resolve(new Response(source.readable))
                    : originalFetch(input, init);
            try {
                renderer.loadFromUrl(url);
            } finally {
                globalThis.fetch = originalFetch;
            }
            log.info('MKV PGS canvas ready');
            return true;
        } catch (error) {
            source.dispose();
            if (!this._disposed && generation === this._generation) log.warn('MKV PGS unavailable:', error.message);
            return false;
        } finally {
            if (generation === this._generation) this._restarting = false;
        }
    }

    tick(time) {
        if (this._disposed || this._restarting) return;
        if (this._source?.needsRestart(time + this._offset)) {
            this.clear();
            this.ready = this._start();
            return;
        }
        this._renderer?.renderAtTimestamp(time + this._offset);
    }

    clear() {
        const context = this._canvas.getContext('2d');
        context?.clearRect(0, 0, this._canvas.width, this._canvas.height);
        if (this._renderer) this._renderer.implementation.previousTimestampIndex = -2;
    }

    setOffset(seconds) {
        this._offset = seconds;
    }
    updateOpacity() {}

    destroy() {
        this._disposed = true;
        this._generation++;
        this._source?.dispose();
        this._renderer?.dispose();
        this._canvas.remove();
    }
}
