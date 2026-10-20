const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const typescript = require('typescript');
require('fake-indexeddb/auto');

const manifest = require('../manifest.json');

function createProxy(dynamicRules = [], rejectOptionalHeaders = false, hostAccessGranted = true) {
  const api = {
    rules: dynamicRules,
    updates: [],
    async getDynamicRules() {
      return this.rules;
    },
    async updateDynamicRules({ removeRuleIds, addRules }) {
      this.updates.push({ removeRuleIds, addRules });
      if (rejectOptionalHeaders && addRules.some(rule =>
        rule.action.requestHeaders?.some(header => header.header === 'origin')
      )) throw new Error('Unsupported header modification');
      this.rules = this.rules
        .filter(rule => !removeRuleIds.includes(rule.id))
        .concat(addRules);
    },
  };
  const browser = {
    runtime: { id: 'extension-test-id' },
    permissions: { async contains() { return hostAccessGranted; } },
  };
  const chrome = { declarativeNetRequest: api };
  const proxySource = fs.readFileSync(path.join(__dirname, '../src/proxy.ts'), 'utf8');
  const compiled = typescript.transpileModule(proxySource, {
    compilerOptions: {
      module: typescript.ModuleKind.CommonJS,
      target: typescript.ScriptTarget.ES2020,
    },
  }).outputText;
  const proxyModule = { exports: {} };
  new Function('exports', 'require', 'module', 'browser', 'chrome', 'URL', compiled)(
    proxyModule.exports,
    require,
    proxyModule,
    browser,
    chrome,
    URL
  );
  return { proxy: new proxyModule.exports.default(), api };
}

function createProvider({
  domain,
  server = 'nc',
  stat,
  fileContents = new Uint8Array(),
  directoryContents = async () => [],
  offlineLookupError = false,
  fetchImpl = async () => ({
  ok: true,
  async json() {
    return { ocs: { meta: { statuscode: 100 }, data: { url: 'https://cloud.example.com/s/abc' } } };
  },
  }),
}) {
  const fileSystemId = `webdavfs://${domain}/user`;
  const handlers = {};
  const openedTabs = [];
  const openedFiles = new Map();
  const statCalls = [];
  const credential = { name: 'Test', domain, server, username: 'user', password: 'secret' };
  const client = {
    getHeaders: () => new Headers({ Authorization: 'Basic dXNlcjpzZWNyZXQ=' }),
    async getDirectoryContents(path) { return directoryContents(path); },
    async getFileContents() { return fileContents; },
    getFileDownloadLink(path) { return `https://user:secret@${domain}${path}`; },
    async stat(path, options) {
      statCalls.push({ path, options });
      if (typeof stat === 'function') return stat(path, options);
      return stat || { basename: 'entry', type: 'directory', size: 0, lastmod: '' };
    },
  };
  const providerApi = new Proxy({}, {
    get(_target, name) {
      if (name === 'getAll') return callback => callback([{ fileSystemId, openedFiles: [] }]);
      return { addListener(handler) { handlers[name] = handler; } };
    },
  });
  const browser = {
    runtime: { getURL: value => `chrome-extension://test/${value}` },
    storage: { local: { async get() {
      return { mountedCredentials: { [fileSystemId]: credential } };
    } } },
    tabs: { async create(options) { openedTabs.push(options.url); } },
  };
  const chrome = {
    fileSystemProvider: providerApi,
    i18n: { getMessage: key => key },
  };
  const offlineSource = fs.readFileSync(path.join(__dirname, '../src/offline_store.ts'), 'utf8');
  const offlineCompiled = typescript.transpileModule(offlineSource, {
    compilerOptions: {
      module: typescript.ModuleKind.CommonJS,
      target: typescript.ScriptTarget.ES2020,
    },
  }).outputText;
  const offlineModule = { exports: {} };
  new Function('exports', 'require', 'module', offlineCompiled)(
    offlineModule.exports,
    require,
    offlineModule
  );
  if (offlineLookupError) {
    offlineModule.exports.getOfflineEntry = async () => {
      throw new Error('Offline database unavailable');
    };
  }
  const localModules = {
    'webdav/web': { createClient: () => client },
    uuid: { v1: () => 'operation-id' },
    './metadata_cache': { default: class { get() { return {}; } put() {} remove() {} } },
    './offline_store': offlineModule.exports,
    './opened_files_store': {
      getOpenedFile: async (id, requestId) => openedFiles.get(`${id}:${requestId}`),
      getOpenedFiles: async () => [],
      openedFileKey: (id, requestId) => `${id}:${requestId}`,
      putOpenedFile: async record => openedFiles.set(record.key, record),
      removeOpenedFile: async (id, requestId) => openedFiles.delete(`${id}:${requestId}`),
      updateOpenedFile: async () => {},
    },
    './proxy': { default: class {} },
  };
  const compiledRequire = name => localModules[name] || require(name);
  const source = fs.readFileSync(path.join(__dirname, '../src/webdav_fs.ts'), 'utf8');
  const compiled = typescript.transpileModule(source, {
    compilerOptions: {
      module: typescript.ModuleKind.CommonJS,
      target: typescript.ScriptTarget.ES2020,
    },
  }).outputText;
  const webdavModule = { exports: {} };
  new Function('exports', 'require', 'module', 'browser', 'chrome', 'fetch', compiled)(
    webdavModule.exports,
    compiledRequire,
    webdavModule,
    browser,
    chrome,
    fetchImpl
  );
  const filesystem = new webdavModule.exports.default({ async reconcile() {} });
  const invoke = (name, options) => new Promise((resolve, reject) => {
    handlers[name](options, resolve, reject);
  });
  return { fileSystemId, handlers, invoke, openedTabs, statCalls, offline: offlineModule.exports };
}

test('manifest declares a Chrome 154 MV3 service worker and public permissions', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.minimum_chrome_version, '154');
  assert.equal(manifest.background.service_worker, 'dist/background.js');
  assert.ok(manifest.permissions.includes('declarativeNetRequestWithHostAccess'));
  assert.ok(manifest.permissions.includes('clipboardWrite'));
  assert.ok(!manifest.permissions.includes('webRequestBlocking'));
  assert.ok(manifest.optional_host_permissions.includes('https://*/'));
  assert.equal(manifest.file_system_provider_capabilities.source, 'network');
});

test('all locales define the share panel and web action messages', () => {
  const requiredMessages = [
    'openOnWeb', 'shareLinkTitle', 'shareLinkDescription',
    'copyLink', 'linkCopied', 'copyLinkFailed',
  ];
  const localeDirectory = path.join(__dirname, '../_locales');
  for (const locale of fs.readdirSync(localeDirectory)) {
    const messages = JSON.parse(fs.readFileSync(
      path.join(localeDirectory, locale, 'messages.json'), 'utf8'
    ));
    for (const key of requiredMessages)
      assert.ok(messages[key]?.message, `${locale} is missing ${key}`);
  }
});

test('WebDAV browser bundle does not depend on a document global', () => {
  const webdavBundle = fs.readFileSync(require.resolve('webdav/web'), 'utf8');
  assert.ok(!/\bdocument\s*\.\s*createElement/.test(webdavBundle));
});

test('provider actions reflect server and whole-selection constraints', async () => {
  const nextcloud = createProvider({ domain: 'actions.example.com' });
  const single = await nextcloud.invoke('onGetActionsRequested', {
    fileSystemId: nextcloud.fileSystemId,
    entryPaths: ['/one'],
  });
  assert.deepEqual(single.map(action => action.id), [
    'SAVE_FOR_OFFLINE', 'SHARE', 'OPEN_ON_WEB',
  ]);

  const multiple = await nextcloud.invoke('onGetActionsRequested', {
    fileSystemId: nextcloud.fileSystemId,
    entryPaths: ['/one', '/two'],
  });
  assert.ok(!multiple.some(action => action.id === 'SHARE'));

  const mixed = createProvider({ domain: 'mixed-actions.example.com' });
  await mixed.offline.replaceOfflineEntries(mixed.fileSystemId, '/pinned', [{
    filePath: '/pinned',
    metadata: { name: 'pinned', isDirectory: false },
    content: new ArrayBuffer(0),
  }]);
  const mixedActions = await mixed.invoke('onGetActionsRequested', {
    fileSystemId: mixed.fileSystemId,
    entryPaths: ['/pinned', '/fresh'],
  });
  assert.ok(mixedActions.some(action => action.id === 'SAVE_FOR_OFFLINE'));
  assert.ok(!mixedActions.some(action => action.id === 'OFFLINE_NOT_NECESSARY'));
  await mixed.invoke('onExecuteActionRequested', {
    fileSystemId: mixed.fileSystemId,
    entryPaths: ['/pinned', '/fresh'],
    actionId: 'SAVE_FOR_OFFLINE',
  });
  const fullyPinnedActions = await mixed.invoke('onGetActionsRequested', {
    fileSystemId: mixed.fileSystemId,
    entryPaths: ['/pinned', '/fresh'],
  });
  assert.ok(fullyPinnedActions.some(action => action.id === 'OFFLINE_NOT_NECESSARY'));
  assert.ok(!fullyPinnedActions.some(action => action.id === 'SAVE_FOR_OFFLINE'));

  const owncloud = createProvider({ domain: 'owncloud.example.com', server: 'oc' });
  const owncloudActions = await owncloud.invoke('onGetActionsRequested', {
    fileSystemId: owncloud.fileSystemId,
    entryPaths: ['/one'],
  });
  assert.ok(!owncloudActions.some(action => action.id === 'SHARE'));
});

test('volume-root requests expose Open on web and open the Files root', async () => {
  const provider = createProvider({ domain: 'root-action.example.com' });
  const actions = await provider.invoke('onGetActionsRequested', {
    fileSystemId: provider.fileSystemId,
    entryPaths: [],
  });
  assert.deepEqual(actions.map(action => action.id), ['OPEN_ON_WEB']);
  await provider.invoke('onExecuteActionRequested', {
    fileSystemId: provider.fileSystemId,
    entryPaths: [],
    actionId: 'OPEN_ON_WEB',
  });
  assert.equal(new URL(provider.openedTabs[0]).searchParams.get('dir'), '/');
});

test('web and offline actions survive singular paths and cache lookup failures', async () => {
  const singular = createProvider({ domain: 'singular-actions.example.com' });
  const singularActions = await singular.invoke('onGetActionsRequested', {
    fileSystemId: singular.fileSystemId,
    entryPath: '/legacy.txt',
  });
  assert.ok(singularActions.some(action => action.id === 'OPEN_ON_WEB'));
  assert.ok(singularActions.some(action => action.id === 'SAVE_FOR_OFFLINE'));
  const emptyPlural = await singular.invoke('onGetActionsRequested', {
    fileSystemId: singular.fileSystemId,
    entryPaths: [],
    entryPath: '/legacy.txt',
  });
  assert.ok(emptyPlural.some(action => action.id === 'OPEN_ON_WEB'));

  const unavailableCache = createProvider({
    domain: 'cache-error.example.com',
    offlineLookupError: true,
  });
  const fallbackActions = await unavailableCache.invoke('onGetActionsRequested', {
    fileSystemId: unavailableCache.fileSystemId,
    entryPaths: ['/file.txt'],
  });
  assert.ok(fallbackActions.some(action => action.id === 'OPEN_ON_WEB'));
  assert.ok(fallbackActions.some(action => action.id === 'SAVE_FOR_OFFLINE'));
});

test('save-for-offline pins file bytes and serves ranges when offline', async () => {
  let online = true;
  let serverFailure = false;
  const provider = createProvider({
    domain: 'offline-read.example.com',
    stat: async () => {
      if (!online) throw new Error('Network unavailable');
      return { basename: 'pin.bin', type: 'file', size: 3, lastmod: '' };
    },
    fileContents: Uint8Array.from([9, 8, 7]),
    directoryContents: async () => {
      if (!online) throw new Error('Network unavailable');
      return [];
    },
    fetchImpl: async () => {
      if (serverFailure) return { ok: false, status: 503 };
      throw new Error('Network unavailable');
    },
  });
  await provider.invoke('onExecuteActionRequested', {
    fileSystemId: provider.fileSystemId,
    entryPaths: ['/pin.bin'],
    actionId: 'SAVE_FOR_OFFLINE',
  });

  const cached = await provider.offline.getOfflineEntry(provider.fileSystemId, '/pin.bin');
  assert.deepEqual(Array.from(new Uint8Array(cached.content)), [9, 8, 7]);
  const actions = await provider.invoke('onGetActionsRequested', {
    fileSystemId: provider.fileSystemId,
    entryPaths: ['/pin.bin'],
  });
  assert.ok(actions.some(action => action.id === 'OFFLINE_NOT_NECESSARY'));
  assert.ok(!actions.some(action => action.id === 'SAVE_FOR_OFFLINE'));

  online = false;
  const rootMetadata = await provider.invoke('onGetMetadataRequested', {
    fileSystemId: provider.fileSystemId,
    entryPath: '/',
    name: true,
    isDirectory: true,
  });
  assert.equal(rootMetadata.isDirectory, true);
  const rootChildren = await provider.invoke('onReadDirectoryRequested', {
    fileSystemId: provider.fileSystemId,
    directoryPath: '/',
    name: true,
    isDirectory: true,
  });
  assert.deepEqual(rootChildren.map(entry => entry.name), ['pin.bin']);

  serverFailure = true;
  await provider.invoke('onOpenFileRequested', {
    fileSystemId: provider.fileSystemId,
    requestId: 17,
    filePath: '/pin.bin',
    mode: 'READ',
  });
  const result = await provider.invoke('onReadFileRequested', {
    fileSystemId: provider.fileSystemId,
    openRequestId: 17,
    offset: 1,
    length: 1,
  });
  assert.deepEqual(Array.from(new Uint8Array(result)), [8]);

  await provider.invoke('onExecuteActionRequested', {
    fileSystemId: provider.fileSystemId,
    entryPaths: ['/pin.bin'],
    actionId: 'OFFLINE_NOT_NECESSARY',
  });
  assert.equal(await provider.offline.getOfflineEntry(provider.fileSystemId, '/pin.bin'), undefined);
});

test('save-for-offline recursively caches folders for offline listings', async () => {
  let online = true;
  const provider = createProvider({
    domain: 'offline-folder.example.com',
    stat: { basename: 'folder', type: 'directory', size: 0, lastmod: '' },
    fileContents: Uint8Array.from([1]),
    directoryContents: async path => {
      if (!online) throw new Error('Network unavailable');
      if (path.endsWith('/folder')) return [
        { basename: 'nested', type: 'directory', size: 0, lastmod: '' },
        { basename: 'top.txt', type: 'file', size: 1, lastmod: '' },
      ];
      if (path.endsWith('/folder/nested')) return [
        { basename: 'inside.txt', type: 'file', size: 1, lastmod: '' },
      ];
      return [];
    },
    fetchImpl: async () => { throw new Error('Network unavailable'); },
  });
  await provider.invoke('onExecuteActionRequested', {
    fileSystemId: provider.fileSystemId,
    entryPaths: ['/folder'],
    actionId: 'SAVE_FOR_OFFLINE',
  });

  const paths = (await provider.offline.getOfflineEntries(provider.fileSystemId))
    .map(entry => entry.filePath).sort();
  assert.deepEqual(paths, [
    '/folder', '/folder/nested', '/folder/nested/inside.txt', '/folder/top.txt',
  ]);

  online = false;
  const children = await provider.invoke('onReadDirectoryRequested', {
    fileSystemId: provider.fileSystemId,
    directoryPath: '/folder',
    name: true,
    isDirectory: true,
  });
  assert.deepEqual(children.map(entry => entry.name).sort(), ['nested', 'top.txt']);

  await provider.invoke('onExecuteActionRequested', {
    fileSystemId: provider.fileSystemId,
    entryPaths: ['/folder/nested'],
    actionId: 'OFFLINE_NOT_NECESSARY',
  });
  const partialFolder = await provider.offline.getOfflineEntry(provider.fileSystemId, '/folder');
  assert.ok(partialFolder);
  assert.equal(partialFolder.incomplete, true);
  const folderActions = await provider.invoke('onGetActionsRequested', {
    fileSystemId: provider.fileSystemId,
    entryPaths: ['/folder'],
  });
  assert.ok(folderActions.some(action => action.id === 'SAVE_FOR_OFFLINE'));
  assert.ok(!folderActions.some(action => action.id === 'OFFLINE_NOT_NECESSARY'));
  assert.equal(await provider.offline.getOfflineEntry(
    provider.fileSystemId,
    '/folder/nested/inside.txt'
  ), undefined);
});

test('provider creates a Nextcloud public link through the OCS API', async () => {
  let request;
  const provider = createProvider({
    domain: 'sharing.example.com',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        async json() {
          return { ocs: { meta: { statuscode: 100 }, data: { url: 'https://sharing.example.com/s/abc' } } };
        },
      };
    },
  });
  await provider.invoke('onExecuteActionRequested', {
    fileSystemId: provider.fileSystemId,
    entryPaths: ['/folder/space & name.txt'],
    actionId: 'SHARE',
  });

  assert.equal(request.url, 'https://sharing.example.com/ocs/v2.php/apps/files_sharing/api/v1/shares');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers.get('OCS-APIRequest'), 'true');
  assert.equal(request.options.headers.get('Authorization'), 'Basic dXNlcjpzZWNyZXQ=');
  assert.equal(new URLSearchParams(request.options.body).get('path'), '/folder/space & name.txt');
  assert.equal(new URLSearchParams(request.options.body).get('shareType'), '3');
  const panelUrl = new URL(provider.openedTabs[0]);
  assert.equal(panelUrl.pathname, '/share.html');
  assert.equal(panelUrl.searchParams.get('url'), 'https://sharing.example.com/s/abc');
});

test('provider reports OCS share permission failures without opening a panel', async () => {
  const provider = createProvider({
    domain: 'denied.example.com',
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return { ocs: { meta: { statuscode: 403, message: 'Sharing is disabled' }, data: {} } };
      },
    }),
  });
  await assert.rejects(provider.invoke('onExecuteActionRequested', {
    fileSystemId: provider.fileSystemId,
    entryPaths: ['/private.txt'],
    actionId: 'SHARE',
  }), error => error === 'FAILED');
  assert.deepEqual(provider.openedTabs, []);
});

test('open-on-web targets selected files and folders with encoded paths', async () => {
  const fileProvider = createProvider({
    domain: 'files.example.com',
    stat: { data: { type: 'file', props: { id: 42, fileid: 999 } } },
  });
  await fileProvider.invoke('onExecuteActionRequested', {
    fileSystemId: fileProvider.fileSystemId,
    entryPaths: ['/folder/space & name.txt'],
    actionId: 'OPEN_ON_WEB',
  });
  const fileUrl = new URL(fileProvider.openedTabs[0]);
  assert.equal(fileUrl.pathname, '/apps/files/files/42');
  assert.equal(fileUrl.searchParams.get('dir'), '/folder');
  assert.equal(fileUrl.searchParams.get('openfile'), 'true');
  assert.match(fileProvider.statCalls[0].options.data, /<oc:id\/>/);
  assert.doesNotMatch(fileProvider.statCalls[0].options.data, /<oc:fileid\/>/);

  const folderProvider = createProvider({
    domain: 'folders.example.com',
    stat: { data: { type: 'directory' } },
  });
  await folderProvider.invoke('onExecuteActionRequested', {
    fileSystemId: folderProvider.fileSystemId,
    entryPaths: ['/folder/space & name'],
    actionId: 'OPEN_ON_WEB',
  });
  const folderUrl = new URL(folderProvider.openedTabs[0]);
  assert.equal(folderUrl.searchParams.get('dir'), '/folder/space & name');
  assert.equal(folderUrl.searchParams.has('openfile'), false);
});

test('proxy registration creates extension-origin-scoped WebDAV header rules', async () => {
  const { proxy, api } = createProxy();
  await proxy.register('cloud.example.com');

  assert.equal(api.rules.length, 2);
  const [requestRule, responseRule] = api.rules;
  assert.equal(requestRule.condition.urlFilter, '|https://cloud.example.com/');
  assert.deepEqual(requestRule.condition.initiatorDomains, ['extension-test-id']);
  assert.deepEqual(requestRule.condition.resourceTypes, ['xmlhttprequest']);
  assert.ok(requestRule.action.requestHeaders.some(header =>
    header.header === 'user-agent' && header.operation === 'set'
  ));
  for (const headerName of ['cookie', 'origin', 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest'])
    assert.ok(requestRule.action.requestHeaders.some(header =>
      header.header === headerName && header.operation === 'remove'
    ));
  assert.deepEqual(responseRule.action.responseHeaders, [
    { header: 'set-cookie', operation: 'remove' },
  ]);
});

test('proxy reconciliation removes only its own rules', async () => {
  const { proxy, api } = createProxy([
    { id: 100000, condition: { urlFilter: '|https://old.example.com/' } },
    { id: 100001, condition: { urlFilter: '|https://old.example.com/' } },
    { id: 7, condition: { urlFilter: '|https://other.example.com/' } },
  ]);
  await proxy.reconcile(['new.example.com']);

  assert.deepEqual(api.updates[0].removeRuleIds, [100000, 100001]);
  assert.ok(api.rules.some(rule => rule.id === 7));
  assert.equal(api.rules.filter(rule => rule.id >= 100000 && rule.id < 105000).length, 2);
});

test('proxy rejects non-origin server input', async () => {
  const { proxy, api } = createProxy();
  await assert.rejects(proxy.reconcile(['cloud.example.com/path']), /valid HTTPS server domain/);
  assert.equal(api.updates.length, 0);
});

test('proxy skips hosts whose optional permission has been revoked', async () => {
  const { proxy, api } = createProxy([], false, false);
  await proxy.reconcile(['cloud.example.com']);

  assert.equal(api.updates.length, 1);
  assert.deepEqual(api.updates[0].addRules, []);
});

test('proxy retries without optional Origin and Sec-Fetch edits', async () => {
  const { proxy, api } = createProxy([], true);
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    await proxy.reconcile(['cloud.example.com']);
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(api.updates.length, 2);
  const requestRule = api.updates[1].addRules.find(rule => rule.action.requestHeaders);
  assert.ok(requestRule.action.requestHeaders.some(header => header.header === 'cookie'));
  assert.ok(requestRule.action.requestHeaders.some(header => header.header === 'user-agent'));
  assert.ok(!requestRule.action.requestHeaders.some(header => header.header === 'origin'));
  assert.ok(!requestRule.action.requestHeaders.some(header => header.header.startsWith('sec-fetch-')));
});

test('open-file records persist when the service-worker module is reloaded', async () => {
  const storeSource = fs.readFileSync(path.join(__dirname, '../src/opened_files_store.ts'), 'utf8');
  const compiled = typescript.transpileModule(storeSource, {
    compilerOptions: {
      module: typescript.ModuleKind.CommonJS,
      target: typescript.ScriptTarget.ES2020,
    },
  }).outputText;
  const loadStore = () => {
    const storeModule = { exports: {} };
    new Function('exports', 'require', 'module', compiled)(
      storeModule.exports,
      require,
      storeModule
    );
    return storeModule.exports;
  };
  const firstWorker = loadStore();
  const record = {
    key: 'webdavfs://cloud.example.com/user:17',
    openRequestId: 17,
    fileSystemId: 'webdavfs://cloud.example.com/user',
    filePath: '/document.txt',
    mode: 'WRITE',
    uuid: 'upload-id',
    buffer: Uint8Array.from([1, 2, 3]).buffer,
    recoverable: true,
  };
  await firstWorker.putOpenedFile(record);

  const restartedWorker = loadStore();
  assert.deepEqual(
    await restartedWorker.getOpenedFile(record.fileSystemId, record.openRequestId),
    record
  );
  await restartedWorker.removeOpenedFile(record.fileSystemId, record.openRequestId);
  assert.equal(
    await restartedWorker.getOpenedFile(record.fileSystemId, record.openRequestId),
    undefined
  );
});

test('concurrent persisted writes retain bytes at all offsets', async () => {
  const storeSource = fs.readFileSync(path.join(__dirname, '../src/opened_files_store.ts'), 'utf8');
  const compiled = typescript.transpileModule(storeSource, {
    compilerOptions: {
      module: typescript.ModuleKind.CommonJS,
      target: typescript.ScriptTarget.ES2020,
    },
  }).outputText;
  const storeModule = { exports: {} };
  new Function('exports', 'require', 'module', compiled)(
    storeModule.exports,
    require,
    storeModule
  );
  const store = storeModule.exports;
  const fileSystemId = 'webdavfs://atomic.example.com/user';
  const openRequestId = 23;
  await store.putOpenedFile({
    key: `${fileSystemId}:${openRequestId}`,
    openRequestId,
    fileSystemId,
    filePath: '/parallel.bin',
    mode: 'WRITE',
    uuid: 'upload-id',
    buffer: new ArrayBuffer(0),
    recoverable: true,
  });

  const writeAt = (offset, value) => store.updateOpenedFile(
    fileSystemId,
    openRequestId,
    current => {
      const length = Math.max(current.buffer.byteLength, offset + 1);
      const buffer = new Uint8Array(length);
      buffer.set(new Uint8Array(current.buffer));
      buffer[offset] = value;
      return { ...current, buffer: buffer.buffer };
    }
  );
  await Promise.all([writeAt(1, 2), writeAt(0, 1)]);

  const result = await store.getOpenedFile(fileSystemId, openRequestId);
  assert.deepEqual(Array.from(new Uint8Array(result.buffer)), [1, 2]);
});

test('offline cache persists pinned trees and invalidates overlapping roots', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/offline_store.ts'), 'utf8');
  const compiled = typescript.transpileModule(source, {
    compilerOptions: {
      module: typescript.ModuleKind.CommonJS,
      target: typescript.ScriptTarget.ES2020,
    },
  }).outputText;
  const loadStore = () => {
    const storeModule = { exports: {} };
    new Function('exports', 'require', 'module', compiled)(
      storeModule.exports,
      require,
      storeModule
    );
    return storeModule.exports;
  };
  const firstWorker = loadStore();
  const fileSystemId = 'webdavfs://cloud.example.com/user';
  const rootEntry = {
    filePath: '/folder',
    metadata: { name: 'folder', isDirectory: true },
  };
  await firstWorker.replaceOfflineEntries(fileSystemId, '/folder', [
    rootEntry,
    {
      filePath: '/folder/document.txt',
      metadata: { name: 'document.txt', isDirectory: false, size: 3 },
      content: Uint8Array.from([1, 2, 3]).buffer,
    },
  ]);
  await firstWorker.replaceOfflineEntries(fileSystemId, '/other', [{
    filePath: '/other',
    metadata: { name: 'other', isDirectory: true },
  }]);

  const restartedWorker = loadStore();
  assert.deepEqual(
    Array.from(new Uint8Array((await restartedWorker.getOfflineEntry(
      fileSystemId,
      '/folder/document.txt'
    )).content)),
    [1, 2, 3]
  );
  await restartedWorker.invalidateOfflineEntries(fileSystemId, '/folder/document.txt');
  assert.equal(await restartedWorker.getOfflineEntry(fileSystemId, '/folder'), undefined);
  assert.ok(await restartedWorker.getOfflineEntry(fileSystemId, '/other'));

  await restartedWorker.removeOfflineEntries(fileSystemId, '/other');
  assert.equal(await restartedWorker.getOfflineEntries(fileSystemId).then(entries => entries.length), 0);
});