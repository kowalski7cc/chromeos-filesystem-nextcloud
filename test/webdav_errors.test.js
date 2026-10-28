const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const typescript = require('typescript');

const source = fs.readFileSync(
  path.join(__dirname, '../src/webdav_errors.ts'),
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
const { getWebDAVFileSystemErrorCode } = helperModule.exports;

test('WebDAV 404 status errors map to the ChromeOS NOT_FOUND code', () => {
  const error = new Error('Invalid response: 404 Not Found');
  error.status = 404;
  assert.equal(getWebDAVFileSystemErrorCode(error), 'NOT_FOUND');
});

test('nested response status and legacy 404 messages remain supported', () => {
  assert.equal(
    getWebDAVFileSystemErrorCode({ response: { status: 404 } }),
    'NOT_FOUND'
  );
  assert.equal(
    getWebDAVFileSystemErrorCode(
      new Error('Request failed with status code 404')
    ),
    'NOT_FOUND'
  );
});

test('non-404 and unrelated errors retain the default handler behavior', () => {
  const error = new Error('Invalid response: 500 Server Error');
  error.status = 500;
  assert.equal(getWebDAVFileSystemErrorCode(error), undefined);
  assert.equal(
    getWebDAVFileSystemErrorCode(new Error('The message mentions 404')),
    undefined
  );
  assert.equal(getWebDAVFileSystemErrorCode('NOT_FOUND'), undefined);
});
