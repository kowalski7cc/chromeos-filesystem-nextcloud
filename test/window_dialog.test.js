const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadWindowScript() {
  const source = fs.readFileSync(path.join(__dirname, '../window.js'), 'utf8');

  const elements = {
    name: { value: 'Nextcloud', textContent: '', innerText: '', addEventListener() {}, setAttribute() {}, removeAttribute() {}, focus() {}, dataset: {} },
    domain: { value: 'cloud.example.com', placeholder: '', addEventListener() {}, focus() {} },
    username: { value: '', addEventListener() {} },
    password: { value: '', addEventListener() {} },
    button: { textContent: 'Login', addEventListener() {}, setAttribute() {}, removeAttribute() {} },
    message: { textContent: '', innerText: '', addEventListener() {} },
    expander: { open: false, addEventListener() {} },
    useInstanceName: { checked: true, addEventListener() {} },
    nameOverrideRow: { hidden: false },
    advancedSummary: { textContent: '' },
    nameLabel: { textContent: '' },
    domainLabel: { textContent: '' },
    usernameLabel: { textContent: '' },
    passwordLabel: { textContent: '' },
    summary: { textContent: '' },
    title: { textContent: '' },
  };

  const context = {
    console,
    URLSearchParams,
    setInterval() { return 1; },
    clearInterval() {},
    module: { exports: {} },
    document: {
      title: '',
      querySelector(selector) {
        const mapping = {
          '#name': elements.name,
          '#domain': elements.domain,
          '#username': elements.username,
          '#password': elements.password,
          '#btnOk': elements.button,
          '#message': elements.message,
          '#expander': elements.expander,
          '#useInstanceName': elements.useInstanceName,
          '#nameOverrideRow': elements.nameOverrideRow,
          '#advancedSettings summary': elements.advancedSummary,
          'label[for="name"]': elements.nameLabel,
          '#useInstanceName + span': { textContent: '' },
          'label[for="domain"]': elements.domainLabel,
          'label[for="username"]': elements.usernameLabel,
          'label[for="password"]': elements.passwordLabel,
          '#expander summary': elements.summary,
          'h1': elements.title,
        };
        return mapping[selector] ?? null;
      }
    },
    chrome: {
      i18n: {
        getMessage(key) { return key; },
      },
    },
    browser: {
      runtime: { sendMessage: async () => {} },
      tabs: { create: async () => {} },
      permissions: { request: async () => true },
    },
    fetch: async () => ({
      ok: true,
      json: async () => ({ ocs: { meta: { status: 'ok' }, data: { capabilities: { theming: { name: 'Example Cloud' } } } } }),
    }),
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context);
  return context.module.exports;
}

test('the instance name parser accepts a valid theming payload and rejects invalid payloads', () => {
  const { parseInstanceNameFromCapabilities } = loadWindowScript();

  assert.equal(parseInstanceNameFromCapabilities({
    ocs: {
      meta: { status: 'ok' },
      data: {
        capabilities: { theming: { name: 'Example Cloud' } },
      },
    },
  }), 'Example Cloud');

  assert.equal(parseInstanceNameFromCapabilities({}), null);
  assert.equal(parseInstanceNameFromCapabilities({
    ocs: {
      meta: { status: 'failure' },
      data: { capabilities: { theming: { name: 'Example Cloud' } } },
    },
  }), null);

  assert.equal(parseInstanceNameFromCapabilities({
    ocs: {
      meta: { status: 'ok' },
      data: { capabilities: { theming: { name: '   ' } } },
    },
  }), null);
});
