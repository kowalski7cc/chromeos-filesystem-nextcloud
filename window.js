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

async function fetchDefaultInstanceName(domain) {
  const url = `https://${domain}/ocs/v2.php/cloud/capabilities?format=json`;

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
  if (advancedSummary) advancedSummary.textContent = i18n('advancedSettings');
  if (summary) summary.textContent = i18n('useUsernamePassword');
  if (usernameLabel) usernameLabel.textContent = i18n('username');
  if (passwordLabel) passwordLabel.textContent = i18n('password');
  if (button) button.textContent = i18n('login');
  if (message) message.textContent = '';
}

// modify User-Agent
async function registerProxy(host) {
  await browser.runtime.sendMessage(['registerProxy', { host }]);
}

async function ncLoginFlow(domain) {
  await registerProxy(domain);

  // Nextcloud Login flow v2
  // https://docs.nextcloud.com/server/latest/developer_manual/client_apis/LoginFlow/index.html#login-flow-v2
  const url = `https://${domain}/index.php/login/v2`;
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
const nameOverrideRow = document.querySelector('#nameOverrideRow');

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
  const btnOk = ev.target;
  const domainInput = document.querySelector('#domain');
  const domain = domainInput.value.trim();
  domainInput.value = domain;
  if (!domainInput.reportValidity()) return;

  btnOk.setAttribute('disabled', 'true');
  const username = document.querySelector('#username').value;
  const password = document.querySelector('#password').value;

  const granted = await browser.permissions.request({
    origins: [`https://${domain}/`]
  });
  if (!granted) {
    btnOk.removeAttribute('disabled');
    return;
  }

  let resolvedName = nameInput.value || 'Nextcloud';
  if (useInstanceNameInput && useInstanceNameInput.checked) {
    const defaultName = await fetchDefaultInstanceName(domain);
    resolvedName = defaultName || 'Nextcloud';
    nameInput.value = resolvedName;
  }

  const request = {
    server: 'oc',
    name: resolvedName,
    domain,
    username,
    password,
  };

  const details = document.querySelector('#expander');
  if (!details.open) {
    Object.assign(request, await ncLoginFlow(domain));
  }

  const message = document.querySelector('#message');
  message.innerText = i18n('mounting');

  await browser.runtime.sendMessage(['mount', request])
    .then(window.close)
    .catch(error => {
      console.error(error);
      message.innerText = error.message;
      btnOk.removeAttribute('disabled');
    });
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
  };
}
