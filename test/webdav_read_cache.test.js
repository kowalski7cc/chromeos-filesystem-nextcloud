const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const typescript = require('typescript');

const source = fs.readFileSync(
  path.join(__dirname, '../src/webdav_read_cache.ts'),
  'utf8'
);
const compiled = typescript.transpileModule(source, {
  compilerOptions: {
    module: typescript.ModuleKind.CommonJS,
    target: typescript.ScriptTarget.ES2020,
  },
}).outputText;
const helperModule = { exports: {} };
new Function('exports', 'require', 'module', compiled)(
  helperModule.exports,
  require,
  helperModule
);
const {
  fetchWebDAVRange,
  WebDAVReadCache,
  WEBDAV_READ_AHEAD_SIZE,
} = helperModule.exports;

test('sequential small reads share prefetched range data', async () => {
  const cache = new WebDAVReadCache();
  const requests = [];
  const fetchRange = async (offset, length) => {
    requests.push({ offset, length });
    return Uint8Array.from(
      { length },
      (_, index) => (offset + index) % 251
    ).buffer;
  };

  const first = await cache.read(100, 4, fetchRange);
  const second = await cache.read(104, 4, fetchRange);
  assert.deepEqual(Array.from(new Uint8Array(first)), [100, 101, 102, 103]);
  assert.deepEqual(Array.from(new Uint8Array(second)), [104, 105, 106, 107]);
  assert.deepEqual(requests, [{ offset: 0, length: WEBDAV_READ_AHEAD_SIZE }]);
  assert.deepEqual(cache.metrics, {
    requestCount: 1,
    bytesFetched: WEBDAV_READ_AHEAD_SIZE,
    bytesReturned: 8,
    cacheHits: 1,
    networkTimeMs: cache.metrics.networkTimeMs,
  });
  assert.ok(cache.metrics.networkTimeMs >= 0);
  cache.clear();
});

test('concurrent reads of the same range share a single network request', async () => {
  const cache = new WebDAVReadCache();
  let requestCount = 0;
  const fetchRange = async (offset, length) => {
    requestCount++;
    await new Promise(resolve => setTimeout(resolve, 5));
    return new Uint8Array(length).fill(offset % 251).buffer;
  };

  const [first, second] = await Promise.all([
    cache.read(12, 3, fetchRange),
    cache.read(12, 3, fetchRange),
  ]);
  assert.equal(requestCount, 1);
  assert.deepEqual(Array.from(new Uint8Array(first)), [0, 0, 0]);
  assert.deepEqual(Array.from(new Uint8Array(second)), [0, 0, 0]);
  assert.equal(cache.metrics.cacheHits, 1);
  cache.clear();
});

test('large reads request only the requested range and return short EOF data', async () => {
  const cache = new WebDAVReadCache();
  const requests = [];
  const requestedData = Uint8Array.from([9, 8, 7, 6, 5]);
  const result = await cache.read(
    31,
    WEBDAV_READ_AHEAD_SIZE + 1,
    async (offset, length) => {
      requests.push({ offset, length });
      return requestedData.buffer;
    }
  );

  assert.deepEqual(requests, [{
    offset: 31,
    length: WEBDAV_READ_AHEAD_SIZE + 1,
  }]);
  assert.deepEqual(Array.from(new Uint8Array(result)), [9, 8, 7, 6, 5]);
  assert.equal(cache.metrics.bytesReturned, 5);
  cache.clear();
});

test('range requests validate HTTP status and Content-Range', async () => {
  const fetcher = async (url, options) => {
    assert.equal(url, 'https://cloud.example.com/file');
    assert.deepEqual(options.headers, {
      Authorization: 'Basic token',
      Range: 'bytes=100-103',
    });
    return new Response(Uint8Array.from([1, 2, 3, 4]), {
      status: 206,
      headers: { 'Content-Range': 'bytes 100-103/1000' },
    });
  };
  assert.deepEqual(
    Array.from(new Uint8Array(await fetchWebDAVRange(
      'https://cloud.example.com/file',
      'Basic token',
      100,
      4,
      fetcher
    ))),
    [1, 2, 3, 4]
  );
  await assert.rejects(
    fetchWebDAVRange(
      'https://cloud.example.com/file',
      'Basic token',
      100,
      4,
      async () => new Response(new ArrayBuffer(4), { status: 200 })
    ),
    /did not honor byte range request/
  );
  await assert.rejects(
    fetchWebDAVRange(
      'https://cloud.example.com/file',
      'Basic token',
      100,
      4,
      async () => new Response(new ArrayBuffer(4), {
        status: 206,
        headers: { 'Content-Range': 'bytes 0-3/1000' },
      })
    ),
    /invalid Content-Range/
  );
  await assert.rejects(
    fetchWebDAVRange(
      'https://cloud.example.com/file',
      'Basic token',
      100,
      4,
      async () => new Response(Uint8Array.from([1, 2]), {
        status: 206,
        headers: { 'Content-Range': 'bytes 100-103/1000' },
      })
    ),
    /length does not match Content-Range/
  );
});

test('read-ahead cache retains a bounded least-recently-used window', async () => {
  const cache = new WebDAVReadCache();
  const requestedOffsets = [];
  const fetchRange = async (offset, length) => {
    requestedOffsets.push(offset);
    return new Uint8Array(length).fill(offset % 251).buffer;
  };

  for (let index = 0; index < 5; index++)
    await cache.read(index * WEBDAV_READ_AHEAD_SIZE, 1, fetchRange);
  await cache.read(WEBDAV_READ_AHEAD_SIZE, 1, fetchRange);
  await cache.read(0, 1, fetchRange);

  assert.deepEqual(requestedOffsets, [
    0,
    WEBDAV_READ_AHEAD_SIZE,
    WEBDAV_READ_AHEAD_SIZE * 2,
    WEBDAV_READ_AHEAD_SIZE * 3,
    WEBDAV_READ_AHEAD_SIZE * 4,
    0,
  ]);
  cache.clear();
});

test('read-ahead cache memory is bounded across concurrent open files', async () => {
  const firstFile = new WebDAVReadCache();
  const secondFile = new WebDAVReadCache();
  const fetched = [];
  const makeFetchRange = file => async (offset, length) => {
    fetched.push({ file, offset });
    return new Uint8Array(length).buffer;
  };
  const fetchFirstFile = makeFetchRange('first');
  const fetchSecondFile = makeFetchRange('second');

  await firstFile.read(0, 1, fetchFirstFile);
  for (let index = 0; index < 4; index++)
    await secondFile.read(index * WEBDAV_READ_AHEAD_SIZE, 1, fetchSecondFile);
  await firstFile.read(0, 1, fetchFirstFile);

  assert.equal(
    fetched.filter(({ file, offset }) => file === 'first' && offset === 0).length,
    2
  );
  firstFile.clear();
  secondFile.clear();
});
