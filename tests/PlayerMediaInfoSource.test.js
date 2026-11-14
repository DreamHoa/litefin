import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/player/osd/PlayerMediaInfoModal.js', import.meta.url), 'utf8')
    .replace(/^import .+;\r?\n/gm, '')
    .replace('export default class', 'class');

function setup(responseSources, activeSource) {
    const noop = () => {};
    const context = vm.createContext({
        BaseMenu: class { constructor(osd) { this.osd = osd; this.player = osd.player; } },
        logger: { create: () => ({ error: noop }) },
        i18n: { t: key => key },
        api: {}
    });
    vm.runInContext(source + '\nglobalThis.Modal = PlayerMediaInfoModal;', context);
    const container = { innerHTML: '' };
    const osd = {
        api: { getItem: async () => ({ Id: 'movie', MediaSources: responseSources }) },
        player: { getCurrentMediaSource: () => activeSource }
    };
    const modal = new context.Modal(osd);
    modal._item = { Id: 'movie' };
    modal.isVisible = true;
    modal.$el = { querySelector: () => container };
    return { modal, container };
}

const sdr = { Id: 'first', Container: 'mp4', MediaStreams: [{ Type: 'Video', Codec: 'h264', Width: 1920, Height: 1080, VideoRange: 'SDR' }] };
const hdr = { Id: 'selected', Container: 'mkv', MediaStreams: [{ Type: 'Video', Codec: 'hevc', Width: 3840, Height: 2160, VideoRange: 'HDR' }] };

test('Playing media info shows the active non-first source instead of the first/all versions', async () => {
    const { modal, container } = setup([sdr, hdr], hdr);
    await modal._loadItemData();
    assert.match(container.innerHTML, /3840x2160/);
    assert.doesNotMatch(container.innerHTML, /1920x1080|>SDR</);
});

test('Playing media info can use the active source when fresh item metadata omits it', async () => {
    const { modal, container } = setup([sdr], hdr);
    await modal._loadItemData();
    assert.match(container.innerHTML, /3840x2160/);
    assert.doesNotMatch(container.innerHTML, /1920x1080/);
});

test('Playing media info does not substitute the first version when the active source is unavailable', async () => {
    const { modal, container } = setup([sdr, hdr], undefined);
    await modal._loadItemData();
    assert.match(container.innerHTML, /NoMediaSourcesFound/);
    assert.doesNotMatch(container.innerHTML, /1920x1080|3840x2160/);
});
