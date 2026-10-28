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
    permissions: {
      checkedOrigins: [],
      async contains({ origins }) {
        this.checkedOrigins.push(origins[0]);
        return hostAccessGranted;
      },
    },
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
  return { proxy: new proxyModule.exports.default(), api, browser };
}

test('manifest declares a Chrome 154 MV3 service worker and public permissions', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.minimum_chrome_version, '154');
  assert.equal(manifest.background.service_worker, 'dist/background.js');
  assert.deepEqual(manifest.options_ui, {
    page: 'options.html',
    open_in_tab: true,
  });
  assert.ok(fs.existsSync(path.join(__dirname, '../options.html')));
  assert.ok(manifest.permissions.includes('declarativeNetRequestWithHostAccess'));
  assert.ok(!manifest.permissions.includes('webRequestBlocking'));
  assert.ok(manifest.optional_host_permissions.includes('https://*/'));
  assert.ok(manifest.optional_host_permissions.includes('http://*/'));
  assert.equal(manifest.file_system_provider_capabilities.source, 'network');
});

test('transfer settings use defaults, validate bounds, and persist globally', async () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../src/transfer_settings.ts'),
    'utf8'
  );
  const compiled = typescript.transpileModule(source, {
    compilerOptions: {
      module: typescript.ModuleKind.CommonJS,
      target: typescript.ScriptTarget.ES2020,
    },
  }).outputText;
  const storage = {};
  const browser = {
    storage: {
      local: {
        async get(key) {
          return { [key]: storage[key] };
        },
        async set(values) {
          Object.assign(storage, values);
        },
      },
    },
  };
  const settingsModule = { exports: {} };
  new Function('exports', 'require', 'module', 'browser', compiled)(
    settingsModule.exports,
    require,
    settingsModule,
    browser
  );
  const {
    DEFAULT_TRANSFER_SETTINGS,
    MEBIBYTE,
    TRANSFER_SETTINGS_KEY,
    loadTransferSettings,
    saveTransferSettings,
    validateTransferSettings,
  } = settingsModule.exports;

  assert.deepEqual(await loadTransferSettings(), DEFAULT_TRANSFER_SETTINGS);
  const customSettings = {
    uploadChunkSize: 5 * MEBIBYTE,
    downloadReadAheadSize: 8 * MEBIBYTE,
    downloadCacheSize: 32 * MEBIBYTE,
    sequentialPrefetch: false,
  };
  assert.deepEqual(await saveTransferSettings(customSettings), customSettings);
  assert.deepEqual(storage[TRANSFER_SETTINGS_KEY], customSettings);
  assert.deepEqual(await loadTransferSettings(), customSettings);
  assert.throws(
    () => validateTransferSettings({
      ...customSettings,
      uploadChunkSize: 4 * MEBIBYTE,
    }),
    /Upload chunk size must be/
  );
  assert.throws(
    () => validateTransferSettings({
      ...customSettings,
      downloadCacheSize: 4 * MEBIBYTE,
    }),
    /Download cache size must be/
  );
  assert.throws(
    () => validateTransferSettings({
      ...customSettings,
      downloadReadAheadSize: 32 * MEBIBYTE,
      downloadCacheSize: 16 * MEBIBYTE,
    }),
    /at least the read-ahead size/
  );
});

test('WebDAV browser bundle does not depend on a document global', () => {
  const webdavBundle = fs.readFileSync(require.resolve('webdav/web'), 'utf8');
  assert.ok(!/\bdocument\s*\.\s*createElement/.test(webdavBundle));
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

test('proxy registration creates HTTP rules and requests HTTP host access', async () => {
  const { proxy, api, browser } = createProxy();
  await proxy.register('cloud.example.com', false);

  assert.equal(api.rules[0].condition.urlFilter, '|http://cloud.example.com/');
  assert.ok(browser.permissions.checkedOrigins.includes('http://cloud.example.com/*'));
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
  await assert.rejects(proxy.reconcile(['cloud.example.com/path']), /valid server address/);
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

test('block staging preserves overlapping writes, gaps, and bounded block count', async () => {
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
  const fileSystemId = 'webdavfs://blocks.example.com/user';
  const openRequestId = 29;
  const record = {
    key: `${fileSystemId}:${openRequestId}`,
    openRequestId,
    fileSystemId,
    filePath: '/large.bin',
    mode: 'WRITE',
    uuid: 'upload-blocks',
    buffer: new ArrayBuffer(0),
    recoverable: true,
    size: 0,
  };
  await store.putOpenedFile(record);

  await Promise.all([
    store.stageOpenedFileWrite(fileSystemId, openRequestId, 0, Uint8Array.from([1, 2, 3]).buffer),
    store.stageOpenedFileWrite(fileSystemId, openRequestId, 1, Uint8Array.from([8, 9]).buffer),
  ]);
  const sparseOffset = store.OPENED_FILE_BLOCK_SIZE * 2 + 5;
  await store.stageOpenedFileWrite(
    fileSystemId,
    openRequestId,
    sparseOffset,
    Uint8Array.from([7]).buffer
  );

  const stagedRecord = await store.getOpenedFile(fileSystemId, openRequestId);
  assert.equal(store.openedFileSize(stagedRecord), sparseOffset + 1);
  assert.equal(stagedRecord.buffer.byteLength, 0);
  assert.equal(stagedRecord.writeCalls, 3);
  assert.equal(stagedRecord.writeBytes, 6);
  const prefix = new Uint8Array(await store.readOpenedFileRange(
    stagedRecord,
    0,
    store.OPENED_FILE_BLOCK_SIZE + 1
  ));
  assert.deepEqual(Array.from(prefix.subarray(0, 3)), [1, 8, 9]);
  assert.equal(prefix[store.OPENED_FILE_BLOCK_SIZE], 0);

  const tail = new Uint8Array(await store.readOpenedFileRange(
    stagedRecord,
    sparseOffset - 1,
    2
  ));
  assert.deepEqual(Array.from(tail), [0, 7]);

  const database = await new Promise((resolve, reject) => {
    const request = indexedDB.open('nextcloud-filesystem', 2);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const transaction = database.transaction('opened-file-blocks', 'readonly');
  const keys = await new Promise((resolve, reject) => {
    const request = transaction.objectStore('opened-file-blocks').getAllKeys();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const stagedKeys = keys.filter(key => String(key).startsWith(`${record.key}:block:`));
  assert.equal(stagedKeys.length, 2);
  const restartedModule = { exports: {} };
  new Function('exports', 'require', 'module', compiled)(
    restartedModule.exports,
    require,
    restartedModule
  );
  const restartedStore = restartedModule.exports;
  const recoveredRecord = await restartedStore.getOpenedFile(fileSystemId, openRequestId);
  assert.deepEqual(
    Array.from(new Uint8Array(await restartedStore.readOpenedFileRange(
      recoveredRecord,
      0,
      3
    ))),
    [1, 8, 9]
  );
  await restartedStore.removeOpenedFile(fileSystemId, openRequestId);
  const remainingKeys = await new Promise((resolve, reject) => {
    const request = database.transaction('opened-file-blocks', 'readonly')
      .objectStore('opened-file-blocks').getAllKeys();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  assert.equal(
    remainingKeys.filter(key => String(key).startsWith(`${record.key}:block:`)).length,
    0
  );
  database.close();
});

test('chunk upload versions persist and detect writes to previously uploaded chunks', async () => {
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
  const fileSystemId = 'webdavfs://chunks.example.com/user';
  const openRequestId = 37;
  await store.putOpenedFile({
    key: `${fileSystemId}:${openRequestId}`,
    openRequestId,
    fileSystemId,
    filePath: '/chunked.bin',
    mode: 'WRITE',
    uuid: 'chunked-upload',
    buffer: new ArrayBuffer(0),
    recoverable: true,
    size: 0,
    uploadChunkSize: 5 * 1024 * 1024,
  });

  await store.stageOpenedFileWrite(
    fileSystemId,
    openRequestId,
    0,
    new ArrayBuffer(8),
    4
  );
  await store.markOpenedFileChunkUploaded(fileSystemId, openRequestId, 0, 1);
  await store.stageOpenedFileWrite(
    fileSystemId,
    openRequestId,
    1,
    new ArrayBuffer(1),
    4
  );

  const record = await store.getOpenedFile(fileSystemId, openRequestId);
  assert.equal(record.uploadChunkSize, 5 * 1024 * 1024);
  assert.deepEqual(record.chunkVersions, { 0: 2, 1: 1 });
  assert.deepEqual(record.uploadedChunkVersions, { 0: 1 });
  assert.equal(record.nextChunkToUpload, 1);
  await store.removeOpenedFile(fileSystemId, openRequestId);
});

test('block staging overlays new writes on legacy persisted buffers', async () => {
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
  const fileSystemId = 'webdavfs://legacy.example.com/user';
  const openRequestId = 31;
  await store.putOpenedFile({
    key: `${fileSystemId}:${openRequestId}`,
    openRequestId,
    fileSystemId,
    filePath: '/legacy.bin',
    mode: 'WRITE',
    uuid: 'legacy-upload',
    buffer: Uint8Array.from([4, 5, 6]).buffer,
    recoverable: true,
  });

  await store.stageOpenedFileWrite(
    fileSystemId,
    openRequestId,
    1,
    Uint8Array.from([0]).buffer
  );
  const record = await store.getOpenedFile(fileSystemId, openRequestId);
  assert.deepEqual(
    Array.from(new Uint8Array(await store.readOpenedFileRange(record, 0, 3))),
    [4, 0, 6]
  );
  await store.removeOpenedFile(fileSystemId, openRequestId);
});