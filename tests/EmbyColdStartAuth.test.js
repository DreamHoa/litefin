import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/api/ApiClient.js', import.meta.url), 'utf8')
    .replace(/^import .+;\r?\n/gm, '')
    .replace(/^export default api;\r?\n?/m, '')
    .replace(/^export /gm, '');

function setup() {
    const events = [];
    const requests = [];
    const log = { info() {}, debug() {}, warn() {}, error() {} };
    const context = vm.createContext({
        URLSearchParams,
        AbortController,
        setTimeout,
        clearTimeout,
        navigator: { userAgent: 'Chrome/120.0.0.0' },
        window: { AbortController, fetch() {} },
        eventBus: { emit: (name) => events.push(name) },
        state: { get: () => undefined, set() {} },
        storage: { getItem: () => null },
        logger: { create: () => log },
        customHeaders: { getHeadersForUrl: () => ({}) },
        i18n: { currentLang: 'zh-CN' },
        platformInfo: {},
        tizenAdapter: {},
        idleGate: {},
        fetch: async (url, options) => {
            requests.push({ url, options });
            const accepted = options.headers['X-Emby-Token'] === 'saved-session';
            return {
                ok: accepted,
                status: accepted ? 200 : 401,
                headers: { get: () => 'application/json' },
                json: async () => ({ Id: 'user-1' }),
                text: async () => ''
            };
        }
    });
    vm.runInContext(source + '\nglobalThis.client = new ApiClient();', context);
    const client = context.client;
    client._serverUrl = 'https://example.invalid';
    client._accessToken = 'saved-session';
    client._userId = 'user-1';
    return { client, requests, events };
}

test('Emby cold start sends the saved token before server identification, including after a language reload', async () => {
    const { client, requests, events } = setup();
    // server:info is deliberately absent, as it is during optimistic restore.
    const user = await client.getCurrentUser();
    assert.equal(user.Id, 'user-1');
    assert.equal(requests[0].options.headers['X-Emby-Token'], 'saved-session');
    assert.equal(events.includes('api:unauthorized'), false);
});

test('Unauthenticated public requests do not transmit the saved token', async () => {
    const { client, requests } = setup();
    await client.request('/System/Info/Public', { skipAuth: true, suppressUnauthorized: true }).catch(() => {});
    assert.equal(requests[0].options.headers['X-Emby-Token'], undefined);
});
