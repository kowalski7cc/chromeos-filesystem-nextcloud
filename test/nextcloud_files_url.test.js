const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const typescript = require('typescript');

const source = fs.readFileSync(
  path.join(__dirname, '../src/nextcloud_files.ts'),
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
  buildNextcloudFileDestination,
  buildNextcloudFilesUrl,
  createNextcloudUploadFolder,
  getNextcloudUploadChunkCount,
  getNextcloudFileMetadata,
  getOpenInWebActions,
  NEXTCLOUD_MAX_UPLOAD_CHUNKS,
  NEXTCLOUD_UPLOAD_CHUNK_SIZE,
  NEXTCLOUD_FILE_INFO_PROPFIND_BODY,
  OPEN_IN_WEB_ACTION,
  uploadNextcloudFile,
} = helperModule.exports;

test('the Open in web action is returned for one or more Nextcloud entries', () => {
  assert.deepEqual(getOpenInWebActions('nc', 1, 'Open in web'), [[
    { id: OPEN_IN_WEB_ACTION, title: 'Open in web' },
  ]]);
  assert.deepEqual(getOpenInWebActions('nc', 2, 'Open in web'), [[
    { id: OPEN_IN_WEB_ACTION, title: 'Open in web' },
  ]]);
  assert.deepEqual(getOpenInWebActions('oc', 1, 'Open in web'), [[]]);
  assert.deepEqual(getOpenInWebActions('nc', 0, 'Open in web'), [[]]);
  assert.deepEqual(getOpenInWebActions(undefined, 1, 'Open in web'), [[
    { id: OPEN_IN_WEB_ACTION, title: 'Open in web' },
  ]]);
});

test('the file info request explicitly asks Nextcloud for its file ID', () => {
  assert.match(NEXTCLOUD_FILE_INFO_PROPFIND_BODY, /xmlns:oc="http:\/\/owncloud\.org\/ns"/);
  assert.match(NEXTCLOUD_FILE_INFO_PROPFIND_BODY, /<oc:fileid\/>/);
  assert.match(NEXTCLOUD_FILE_INFO_PROPFIND_BODY, /<d:resourcetype\/>/);
});

test('Nextcloud file metadata is read from explicitly requested DAV props', () => {
  const metadata = getNextcloudFileMetadata(
    '<d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">' +
    '<d:response><d:propstat><d:prop><oc:fileid>2671618</oc:fileid>' +
    '<d:resourcetype><d:collection/></d:resourcetype></d:prop>' +
    '<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>' +
    '</d:multistatus>'
  );

  assert.deepEqual(metadata, { fileId: '2671618', isDirectory: true });
});

test('Nextcloud file metadata recognizes files with an unprefixed fileid property', () => {
  assert.deepEqual(
    getNextcloudFileMetadata(
      '<d:multistatus xmlns:d="DAV:"><d:response><d:propstat><d:prop>' +
      '<fileid>123</fileid><d:resourcetype/>' +
      '</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>' +
      '</d:response></d:multistatus>'
    ),
    { fileId: '123', isDirectory: false }
  );
});

test('missing Nextcloud file IDs fail explicitly', () => {
  assert.throws(
    () => getNextcloudFileMetadata('<multistatus/>'),
    /Nextcloud file ID is unavailable from WebDAV metadata/
  );
});

test('file URLs open the preview in its containing directory', () => {
  const url = new URL(buildNextcloudFilesUrl(
    'cloud.example.com',
    '/Documents/report #1.pdf',
    false,
    '2671618'
  ));

  assert.equal(url.origin, 'https://cloud.example.com');
  assert.equal(url.pathname, '/apps/files/files/2671618');
  assert.equal(url.searchParams.get('dir'), '/Documents');
  assert.equal(url.searchParams.get('editing'), 'false');
  assert.equal(url.searchParams.get('openfile'), 'true');
});

test('directory URLs omit file preview parameters', () => {
  const url = new URL(buildNextcloudFilesUrl(
    'cloud.example.com',
    '/Projects/Archive/',
    true,
    '2597649'
  ));

  assert.equal(url.pathname, '/apps/files/files/2597649');
  assert.equal(url.searchParams.get('dir'), '/Projects');
  assert.equal(url.searchParams.has('editing'), false);
  assert.equal(url.searchParams.has('openfile'), false);
});

test('root directory URLs use the Nextcloud Files root', () => {
  const url = new URL(buildNextcloudFilesUrl(
    'cloud.example.com',
    '/',
    true,
    '1'
  ));

  assert.equal(url.searchParams.get('dir'), '/');
});

test('Nextcloud upload destinations are absolute and encode path segments', () => {
  assert.equal(
    buildNextcloudFileDestination(
      'cloud.example.com',
      'user@example.com',
      '/Documents/report #1.pdf'
    ),
    'https://cloud.example.com/remote.php/dav/files/user%40example.com/Documents/report%20%231.pdf'
  );
});

test('Nextcloud upload folder creation sends its final destination', async () => {
  const requests = [];
  const client = {
    async customRequest(path, options) {
      requests.push({ path, options });
    },
  };
  const destination = 'https://cloud.example.com/remote.php/dav/files/user/file.txt';

  await createNextcloudUploadFolder(client, '/uploads/user/upload-id', destination);

  assert.deepEqual(requests, [{
    path: '/uploads/user/upload-id',
    options: {
      method: 'MKCOL',
      headers: { Destination: destination },
    },
  }]);
});

test('Nextcloud files upload as ordered numeric chunks with v2 headers', async () => {
  const requests = [];
  const client = {
    async customRequest(path, options) {
      requests.push({ path, options });
    },
  };
  const fileSize = NEXTCLOUD_UPLOAD_CHUNK_SIZE * 2 + 3;
  const destination = 'https://cloud.example.com/remote.php/dav/files/user/file.bin';

  await uploadNextcloudFile(
    client,
    '/uploads/user/upload-id',
    '/files/user/file.bin',
    destination,
    new ArrayBuffer(fileSize)
  );

  assert.deepEqual(requests.map(({ path, options }) => [
    path,
    options.method,
    options.data?.byteLength,
  ]), [
    ['/uploads/user/upload-id/00001', 'PUT', NEXTCLOUD_UPLOAD_CHUNK_SIZE],
    ['/uploads/user/upload-id/00002', 'PUT', NEXTCLOUD_UPLOAD_CHUNK_SIZE],
    ['/uploads/user/upload-id/00003', 'PUT', 3],
    ['/uploads/user/upload-id/.file', 'MOVE', undefined],
  ]);
  for (const { options } of requests) {
    assert.equal(options.headers.Destination, destination);
    assert.equal(options.headers['OC-Total-Length'], String(fileSize));
  }
});

test('empty Nextcloud files use a direct PUT and remove the temporary folder', async () => {
  const requests = [];
  const client = {
    async customRequest(path, options) {
      requests.push({ path, options });
    },
  };

  await uploadNextcloudFile(
    client,
    '/uploads/user/upload-id',
    '/files/user/empty',
    'https://cloud.example.com/remote.php/dav/files/user/empty',
    new ArrayBuffer(0)
  );

  assert.deepEqual(requests.map(({ path, options }) => [path, options.method]), [
    ['/files/user/empty', 'PUT'],
    ['/uploads/user/upload-id/', 'DELETE'],
  ]);
  assert.equal(requests[0].options.data.byteLength, 0);
});

test('Nextcloud upload chunk-count limits are enforced before requests', () => {
  assert.equal(
    getNextcloudUploadChunkCount(NEXTCLOUD_UPLOAD_CHUNK_SIZE * NEXTCLOUD_MAX_UPLOAD_CHUNKS),
    NEXTCLOUD_MAX_UPLOAD_CHUNKS
  );
  assert.throws(
    () => getNextcloudUploadChunkCount(
      NEXTCLOUD_UPLOAD_CHUNK_SIZE * NEXTCLOUD_MAX_UPLOAD_CHUNKS + 1
    ),
    /limited to 10000 chunks/
  );
  assert.throws(() => getNextcloudUploadChunkCount(-1), /non-negative safe integer/);
});

test('all locale catalogs define the Open in web action label', () => {
  const localeRoot = path.join(__dirname, '../_locales');
  const locales = fs.readdirSync(localeRoot);

  for (const locale of locales) {
    const messages = JSON.parse(fs.readFileSync(
      path.join(localeRoot, locale, 'messages.json'),
      'utf8'
    ));
    assert.ok(messages.openInWeb.message, `Missing openInWeb message for ${locale}`);
  }
});
