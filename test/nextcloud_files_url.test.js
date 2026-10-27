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
  buildNextcloudFilesUrl,
  getNextcloudFileMetadata,
  getOpenInWebActions,
  NEXTCLOUD_FILE_INFO_PROPFIND_BODY,
  OPEN_IN_WEB_ACTION,
} = helperModule.exports;

test('the Open in web action is only returned for one Nextcloud entry', () => {
  assert.deepEqual(getOpenInWebActions('nc', 1, 'Open in web'), [[
    { id: OPEN_IN_WEB_ACTION, title: 'Open in web' },
  ]]);
  assert.deepEqual(getOpenInWebActions('oc', 1, 'Open in web'), [[]]);
  assert.deepEqual(getOpenInWebActions('nc', 2, 'Open in web'), [[]]);
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
