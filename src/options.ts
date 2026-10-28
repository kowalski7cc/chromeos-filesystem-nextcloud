import {
  DEFAULT_TRANSFER_SETTINGS,
  MEBIBYTE,
  loadTransferSettings,
  saveTransferSettings,
} from './transfer_settings';

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Transfer settings element is missing: ${selector}`);
  return element;
}

const form = requireElement<HTMLFormElement>('#settingsForm');
const uploadChunkSize = requireElement<HTMLInputElement>('#uploadChunkSize');
const downloadReadAheadSize =
  requireElement<HTMLInputElement>('#downloadReadAheadSize');
const downloadCacheSize = requireElement<HTMLInputElement>('#downloadCacheSize');
const downloadCacheSizeLabel =
  requireElement<HTMLLabelElement>('#downloadCacheSizeLabel');
const sequentialPrefetch =
  requireElement<HTMLInputElement>('#sequentialPrefetch');
const message = requireElement<HTMLElement>('#message');
const saveButton = requireElement<HTMLButtonElement>('#btnSave');
const resetButton = requireElement<HTMLButtonElement>('#btnReset');

function localize(key: string): string {
  return chrome.i18n.getMessage(key);
}

function applyLocale(): void {
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach(element => {
    const key = element.dataset.i18n;
    if (!key) throw new Error('Transfer settings localization key is missing');
    const translation = localize(key);
    if (!translation)
      throw new Error(`Transfer settings localization is missing: ${key}`);
    element.textContent = translation;
  });
  document.title = localize('settingsTitle');
}

function setFormValues(settings: {
  uploadChunkSize: number
  downloadReadAheadSize: number
  downloadCacheSize: number
  sequentialPrefetch: boolean
}): void {
  uploadChunkSize.value = String(settings.uploadChunkSize / MEBIBYTE);
  downloadReadAheadSize.value = String(settings.downloadReadAheadSize / MEBIBYTE);
  downloadCacheSize.value = String(settings.downloadCacheSize / MEBIBYTE);
  downloadCacheSize.min = String(
    Math.max(16, Math.ceil(settings.downloadReadAheadSize / MEBIBYTE))
  );
  sequentialPrefetch.checked = settings.sequentialPrefetch;
}

function readFormValues() {
  return {
    uploadChunkSize: Number(uploadChunkSize.value) * MEBIBYTE,
    downloadReadAheadSize: Number(downloadReadAheadSize.value) * MEBIBYTE,
    downloadCacheSize: Number(downloadCacheSize.value) * MEBIBYTE,
    sequentialPrefetch: sequentialPrefetch.checked,
  };
}

async function initialize(): Promise<void> {
  applyLocale();
  downloadCacheSizeLabel.textContent = localize('downloadCacheLimitLabel');
  try {
    const settings = await loadTransferSettings();
    setFormValues(settings);
  } catch (error) {
    console.error('Could not load transfer settings', error);
    message.textContent = localize('settingsLoadError');
    saveButton.disabled = true;
  }
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (!form.reportValidity()) return;

  saveButton.disabled = true;
  resetButton.disabled = true;
  try {
    const saved = await saveTransferSettings(readFormValues());
    setFormValues(saved);
    message.textContent = localize('settingsSaved');
  } catch (error) {
    console.error('Could not save transfer settings', error);
    message.textContent = localize('settingsSaveError');
  } finally {
    saveButton.disabled = false;
    resetButton.disabled = false;
  }
});

resetButton.addEventListener('click', async () => {
  saveButton.disabled = true;
  resetButton.disabled = true;
  try {
    const saved = await saveTransferSettings(DEFAULT_TRANSFER_SETTINGS);
    setFormValues(saved);
    message.textContent = localize('settingsReset');
  } catch (error) {
    console.error('Could not restore transfer settings', error);
    message.textContent = localize('settingsSaveError');
  } finally {
    saveButton.disabled = false;
    resetButton.disabled = false;
  }
});

downloadReadAheadSize.addEventListener('input', () => {
  const parsedSize = Number(downloadReadAheadSize.value);
  if (Number.isFinite(parsedSize))
    downloadCacheSize.min = String(Math.max(16, Math.ceil(parsedSize)));
});

void initialize();
