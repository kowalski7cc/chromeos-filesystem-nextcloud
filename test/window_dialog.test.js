const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadWindowScript(options = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../window.js'), 'utf8');
  const listeners = new Map();
  const eventHandlers = name => ({
    addEventListener(type, handler) {
      listeners.set(`${name}:${type}`, handler);
    },
  });

  const elements = {
    name: { ...eventHandlers('name'), value: 'Nextcloud', textContent: '', innerText: '', setAttribute() {}, removeAttribute() {}, focus() {}, dataset: {} },
    domain: { ...eventHandlers('domain'), value: 'cloud.example.com', placeholder: '', focus() {}, setCustomValidity(message) { this.validationMessage = message; }, reportValidity() { return !this.validationMessage; } },
    username: { ...eventHandlers('username'), value: '' },
    password: { ...eventHandlers('password'), value: '' },
    button: { ...eventHandlers('button'), textContent: 'Login', disabled: false, setAttribute() {}, removeAttribute() {} },
    message: { ...eventHandlers('message'), textContent: '', innerText: '' },
    expander: { ...eventHandlers('expander'), open: false },
    useInstanceName: { ...eventHandlers('useInstanceName'), checked: true },
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
    console: options.console || console,
    URL,
    URLSearchParams,
    setInterval() { return 1; },
    clearInterval() {},
    module: { exports: {} },
    document: {
      title: '',
      documentElement: { lang: '' },
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
      runtime: { sendMessage: options.sendMessage || (async () => {}) },
      tabs: { create: async () => {} },
      permissions: { request: options.permissionRequest || (async () => true) },
    },
    fetch: options.fetchImplementation || (async () => ({
      ok: true,
      json: async () => ({ ocs: { meta: { status: 'ok' }, data: { capabilities: { theming: { name: 'Example Cloud' } } } } }),
    })),
    window: { close() {} },
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context);
  return { ...context.module.exports, elements, listeners };
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

test('server domain normalization rejects values that cannot form HTTPS permission origins', () => {
  const { normalizeServerDomain } = loadWindowScript();

  assert.equal(normalizeServerDomain('cloud.example.com'), 'cloud.example.com');
  assert.equal(normalizeServerDomain('https://cloud.example.com'), 'cloud.example.com');
  assert.equal(normalizeServerDomain('https://'), null);
  assert.equal(normalizeServerDomain('https://cloud.example.com/path'), null);
  assert.equal(normalizeServerDomain('http://cloud.example.com'), null);
});

test('invalid server domains show a dialog message without requesting permissions', async () => {
  let permissionRequests = 0;
  const { elements, listeners } = loadWindowScript({
    permissionRequest: async () => {
      permissionRequests += 1;
      return true;
    },
  });
  elements.domain.value = 'https://';

  await listeners.get('button:click')({ target: elements.button });

  assert.equal(permissionRequests, 0);
  assert.equal(elements.message.textContent, 'invalidServerDomain');
});

test('failed instance-name lookup continues with Nextcloud and announces the fallback', async () => {
  const { elements, listeners } = loadWindowScript({
    fetchImplementation: async () => {
      throw new TypeError('Failed to fetch');
    },
    console: { ...console, warn() {} },
  });
  elements.expander.open = true;

  await listeners.get('button:click')({ target: elements.button });

  assert.equal(elements.name.value, 'Nextcloud');
  assert.equal(elements.message.textContent, 'instanceNameUnavailable');
  assert.equal(elements.button.disabled, false);
});

test('connection errors are shown in the dialog and re-enable the button', async () => {
  const { elements, listeners } = loadWindowScript({
    permissionRequest: async () => {
      throw new Error('Permission request failed');
    },
    console: { ...console, error() {} },
  });

  await listeners.get('button:click')({ target: elements.button });

  assert.equal(elements.message.textContent, 'connectionFailed');
  assert.equal(elements.button.disabled, false);
});
