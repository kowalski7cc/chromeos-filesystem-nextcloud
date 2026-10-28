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
    useHttps: { ...eventHandlers('useHttps'), checked: options.useHttps ?? true },
    useHttpsLabel: { textContent: '' },
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
    setInterval(callback) {
      return options.setInterval ? options.setInterval(callback) : 1;
    },
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
          '#useHttps': elements.useHttps,
          '#useHttpsLabel': elements.useHttpsLabel,
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
    window: {
      close() {},
      alert: options.alert || (() => {}),
    },
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

test('server domain normalization enforces the selected protocol and rejects invalid origins', () => {
  const { normalizeServerDomain } = loadWindowScript();

  assert.equal(normalizeServerDomain('cloud.example.com'), 'cloud.example.com');
  assert.equal(normalizeServerDomain('https://cloud.example.com'), 'cloud.example.com');
  assert.equal(normalizeServerDomain('cloud.example.com', false), 'cloud.example.com');
  assert.equal(normalizeServerDomain('http://cloud.example.com', false), 'cloud.example.com');
  assert.equal(normalizeServerDomain('https://'), null);
  assert.equal(normalizeServerDomain('https://cloud.example.com/path'), null);
  assert.equal(normalizeServerDomain('http://cloud.example.com'), null);
  assert.equal(normalizeServerDomain('https://cloud.example.com', false), null);
});

test('HTTPS defaults on and the HTTP choice reaches the connection and mount request', async () => {
  const permissionRequests = [];
  const sentMessages = [];
  const fetchedUrls = [];
  const { elements, listeners } = loadWindowScript({
    permissionRequest: async request => {
      permissionRequests.push(request);
      return true;
    },
    sendMessage: async message => sentMessages.push(message),
    fetchImplementation: async url => {
      fetchedUrls.push(url);
      return {
        ok: true,
        json: async () => ({
          ocs: {
            meta: { status: 'ok' },
            data: { capabilities: { theming: { name: 'Example Cloud' } } },
          },
        }),
      };
    },
  });
  elements.expander.open = true;
  assert.equal(elements.useHttps.checked, true);
  elements.useHttps.checked = false;

  await listeners.get('button:click')({ target: elements.button });

  assert.equal(permissionRequests[0].origins[0], 'http://cloud.example.com/*');
  assert.equal(
    fetchedUrls[0],
    'http://cloud.example.com/ocs/v2.php/cloud/capabilities?format=json'
  );
  assert.equal(sentMessages[0][0], 'mount');
  assert.equal(sentMessages[0][1].useHttps, false);
});

test('connection dialog enables HTTPS by default in its markup', () => {
  const markup = fs.readFileSync(path.join(__dirname, '../window.html'), 'utf8');

  assert.match(markup, /<input id="useHttps" type="checkbox" role="switch" checked>/);
});

test('turning HTTPS off warns about unencrypted HTTP traffic', () => {
  const alerts = [];
  const { elements, listeners } = loadWindowScript({
    alert: message => alerts.push(message),
  });

  elements.useHttps.checked = false;
  listeners.get('useHttps:change')();
  elements.useHttps.checked = true;
  listeners.get('useHttps:change')();

  assert.deepEqual(alerts, ['httpConnectionWarning']);
});

test('HTTP Login Flow uses HTTP endpoints and registers the matching proxy rule', async () => {
  const fetchedUrls = [];
  const sentMessages = [];
  const { elements, listeners } = loadWindowScript({
    setInterval: callback => {
      queueMicrotask(callback);
      return 1;
    },
    sendMessage: async message => sentMessages.push(message),
    fetchImplementation: async url => {
      fetchedUrls.push(url);
      if (fetchedUrls.length === 1) {
        return {
          json: async () => ({
            poll: { token: 'token', endpoint: 'http://cloud.example.com/poll' },
            login: 'http://cloud.example.com/login',
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({ loginName: 'user', appPassword: 'password' }),
      };
    },
  });
  elements.useHttps.checked = false;
  elements.useInstanceName.checked = false;

  await listeners.get('button:click')({ target: elements.button });

  assert.equal(fetchedUrls[0], 'http://cloud.example.com/index.php/login/v2');
  assert.equal(fetchedUrls[1], 'http://cloud.example.com/poll');
  assert.equal(sentMessages[0][0], 'registerProxy');
  assert.equal(sentMessages[0][1].useHttps, false);
  assert.equal(sentMessages[1][0], 'mount');
  assert.equal(sentMessages[1][1].useHttps, false);
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
