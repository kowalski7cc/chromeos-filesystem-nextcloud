'use strict';

function i18n(key, substitutions) {
  return chrome.i18n.getMessage(key, substitutions);
}

function parseInstanceNameFromCapabilities(data) {
  if (!data || typeof data !== 'object') {
    return null;
  }

  const status = data?.ocs?.meta?.status;
  if (status && status !== 'ok' && status !== 'success') {
    return null;
  }

  const name = data?.ocs?.data?.capabilities?.theming?.name;
  if (typeof name !== 'string') {
    return null;
  }

  const trimmed = name.trim();
  return trimmed || null;
}

function normalizeServerDomain(value, useHttps = true) {
  const trimmed = value.trim();
  if (!trimmed) return null;

  try {
    const protocol = useHttps ? 'https:' : 'http:';
    const url = new URL(trimmed.includes('://') ? trimmed : `${protocol}//${trimmed}`);
    if (url.protocol !== protocol || !url.hostname || url.username || url.password ||
        url.pathname !== '/' || url.search || url.hash) {
      return null;
    }
    return url.host;
  } catch {
    return null;
  }
}

async function fetchDefaultInstanceName(domain, useHttps = true) {
  const url = `${useHttps ? 'https' : 'http'}://${domain}/ocs/v2.php/cloud/capabilities?format=json`;

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'OCS-APIRequest': 'true',
      },
    });

    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    const status = data && typeof data === 'object' ? data?.ocs?.meta?.status : undefined;
    if (status && status !== 'ok' && status !== 'success') {
      return null;
    }

    return parseInstanceNameFromCapabilities(data);
  } catch (error) {
    console.warn('Could not fetch default instance name', error);
    return null;
  }
}

function applyLocale() {
  document.documentElement.lang = chrome.i18n.getUILanguage?.() || 'en';
  const nameLabel = document.querySelector('label[for="name"]');
  const domainLabel = document.querySelector('label[for="domain"]');
  const usernameLabel = document.querySelector('label[for="username"]');
  const passwordLabel = document.querySelector('label[for="password"]');
  const useInstanceNameLabel = document.querySelector('.advanced-toggle-label');
  const useHttpsLabel = document.querySelector('#useHttpsLabel');
  const advancedSummary = document.querySelector('#advancedSettings summary');
  const summary = document.querySelector('#expander summary');
  const title = document.querySelector('h1');
  const button = document.querySelector('#btnOk');
  const message = document.querySelector('#message');

  document.title = i18n('appName');
  title.textContent = i18n('loginTitle');
  if (nameLabel) nameLabel.textContent = i18n('nameLabel');
  if (domainLabel) domainLabel.textContent = i18n('serverDomain');
  if (useInstanceNameLabel) useInstanceNameLabel.textContent = i18n('useNameFromNextcloudInstance');
  if (useHttpsLabel) useHttpsLabel.textContent = i18n('useHttpsForConnection');
  if (advancedSummary) advancedSummary.textContent = i18n('advancedSettings');
  if (summary) summary.textContent = i18n('useUsernamePassword');
  if (usernameLabel) usernameLabel.textContent = i18n('username');
  if (passwordLabel) passwordLabel.textContent = i18n('password');
  if (button) button.textContent = i18n('login');
  if (message) message.textContent = '';
}

// modify User-Agent
async function registerProxy(host, useHttps) {
  await browser.runtime.sendMessage(['registerProxy', { host, useHttps }]);
}

async function ncLoginFlow(domain, useHttps) {
  const protocol = useHttps ? 'https' : 'http';
  await registerProxy(domain, useHttps);

  // Nextcloud Login flow v2
  // https://docs.nextcloud.com/server/latest/developer_manual/client_apis/LoginFlow/index.html#login-flow-v2
  const url = `${protocol}://${domain}/index.php/login/v2`;
  const response = await fetch(url, { method: 'POST' });
  const { poll: { token, endpoint }, login } = await response.json();

  await browser.tabs.create({ url: login });

  return await new Promise(resolve => {
    // polling
    const id = setInterval(async () => {
      const body = new URLSearchParams();
      body.append('token', token);
      const response = await fetch(endpoint, { method: 'POST', body });
      if (response.ok) {
        const { loginName: username, appPassword: password } = await response.json();
        clearInterval(id);
        resolve({ server: 'nc', username, password });
      }
    }, 1000);
  });
}

applyLocale();

const nameInput = document.querySelector('#name');
const useInstanceNameInput = document.querySelector('#useInstanceName');
const useHttpsInput = document.querySelector('#useHttps');
const nameOverrideRow = document.querySelector('#nameOverrideRow');

useHttpsInput.addEventListener('change', () => {
  if (!useHttpsInput.checked)
    window.alert(i18n('httpConnectionWarning'));
});

function syncAdvancedNameControls() {
  const shouldUseInstanceName = !!useInstanceNameInput && useInstanceNameInput.checked;
  if (nameOverrideRow) {
    nameOverrideRow.hidden = shouldUseInstanceName;
  }
  if (shouldUseInstanceName && !nameInput.value) {
    nameInput.value = 'Nextcloud';
  }
}

useInstanceNameInput.addEventListener('change', syncAdvancedNameControls);

nameInput.addEventListener('input', () => {
  nameInput.dataset.userEdited = 'true';
});

document.querySelector('#name').addEventListener('keydown', ev => {
  if (ev.key === 'Enter') {
    ev.preventDefault();
    document.querySelector('#domain').focus();
  }
});

document.querySelector('#domain').addEventListener('keydown', ev => {
  if (ev.key === 'Enter') {
    ev.preventDefault();
    document.querySelector('#btnOk').focus();
  }
});

document.querySelector('#btnOk').addEventListener('click', async ev => {
  const btnOk = ev.currentTarget || ev.target;
  const domainInput = document.querySelector('#domain');
  const message = document.querySelector('#message');
  const useHttps = !useHttpsInput || useHttpsInput.checked;
  const domain = normalizeServerDomain(domainInput.value, useHttps);
  if (!domain) {
    domainInput.setCustomValidity(i18n('invalidServerDomain'));
    message.textContent = i18n('invalidServerDomain');
    domainInput.reportValidity();
    return;
  }
  domainInput.setCustomValidity('');
  domainInput.value = domain;

  btnOk.disabled = true;
  message.textContent = '';
  try {
    const granted = await browser.permissions.request({
      origins: [`${useHttps ? 'https' : 'http'}://${domain}/*`]
    });
    if (!granted) {
      message.textContent = i18n('connectionFailed');
      return;
    }

    const username = document.querySelector('#username').value;
    const password = document.querySelector('#password').value;
    let resolvedName = nameInput.value || 'Nextcloud';
    if (useInstanceNameInput && useInstanceNameInput.checked) {
      const defaultName = await fetchDefaultInstanceName(domain, useHttps);
      resolvedName = defaultName || 'Nextcloud';
      nameInput.value = resolvedName;
      if (!defaultName) message.textContent = i18n('instanceNameUnavailable');
    }

    const request = {
      server: 'oc',
      name: resolvedName,
      domain,
      useHttps,
      username,
      password,
    };

    const details = document.querySelector('#expander');
    if (!details.open) {
      Object.assign(request, await ncLoginFlow(domain, useHttps));
    }

    if (!message.textContent) message.textContent = i18n('mounting');
    await browser.runtime.sendMessage(['mount', request]);
    window.close();
  } catch (error) {
    console.error('Could not connect or mount the server', error);
    message.textContent = i18n('connectionFailed');
  } finally {
    btnOk.disabled = false;
  }
});

document.querySelector('#expander').addEventListener('toggle', ev => {
  const details = ev.target;
  const button = document.querySelector('#btnOk');

  button.textContent = details.open ? i18n('mount') : i18n('login');
});

if (useInstanceNameInput) {
  syncAdvancedNameControls();
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    parseInstanceNameFromCapabilities,
    fetchDefaultInstanceName,
    normalizeServerDomain,
  };
}
