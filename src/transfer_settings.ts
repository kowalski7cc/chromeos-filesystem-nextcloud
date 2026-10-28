export const MEBIBYTE = 1024 * 1024;
export const TRANSFER_SETTINGS_KEY = 'transferSettings';

export const DEFAULT_TRANSFER_SETTINGS: TransferSettings = {
  uploadChunkSize: 10 * MEBIBYTE,
  downloadReadAheadSize: 16 * MEBIBYTE,
  downloadCacheSize: 64 * MEBIBYTE,
  sequentialPrefetch: true,
};

export const TRANSFER_SETTING_LIMITS = {
  uploadChunkSize: { min: 5 * MEBIBYTE, max: 100 * MEBIBYTE },
  downloadReadAheadSize: { min: 8 * MEBIBYTE, max: 64 * MEBIBYTE },
  downloadCacheSize: { min: 16 * MEBIBYTE, max: 512 * MEBIBYTE },
};

export interface TransferSettings {
  uploadChunkSize: number
  downloadReadAheadSize: number
  downloadCacheSize: number
  sequentialPrefetch: boolean
}

export function validateTransferSettings(
  value: Partial<TransferSettings>
): TransferSettings {
  const settings = {
    uploadChunkSize: value.uploadChunkSize ??
      DEFAULT_TRANSFER_SETTINGS.uploadChunkSize,
    downloadReadAheadSize: value.downloadReadAheadSize ??
      DEFAULT_TRANSFER_SETTINGS.downloadReadAheadSize,
    downloadCacheSize: value.downloadCacheSize ??
      DEFAULT_TRANSFER_SETTINGS.downloadCacheSize,
    sequentialPrefetch: value.sequentialPrefetch ??
      DEFAULT_TRANSFER_SETTINGS.sequentialPrefetch,
  };

  validateSize(
    'Upload chunk size',
    settings.uploadChunkSize,
    TRANSFER_SETTING_LIMITS.uploadChunkSize.min,
    TRANSFER_SETTING_LIMITS.uploadChunkSize.max
  );
  validateSize(
    'Download read-ahead size',
    settings.downloadReadAheadSize,
    TRANSFER_SETTING_LIMITS.downloadReadAheadSize.min,
    TRANSFER_SETTING_LIMITS.downloadReadAheadSize.max
  );
  validateSize(
    'Download cache size',
    settings.downloadCacheSize,
    TRANSFER_SETTING_LIMITS.downloadCacheSize.min,
    TRANSFER_SETTING_LIMITS.downloadCacheSize.max
  );
  if (settings.downloadCacheSize < settings.downloadReadAheadSize)
    throw new Error('Download cache size must be at least the read-ahead size');
  if (typeof settings.sequentialPrefetch !== 'boolean')
    throw new Error('Sequential prefetch setting must be a boolean');
  return settings;
}

export async function loadTransferSettings(): Promise<TransferSettings> {
  const result = await browser.storage.local.get(TRANSFER_SETTINGS_KEY);
  const saved = result[TRANSFER_SETTINGS_KEY] as
    Partial<TransferSettings> | undefined;
  return saved ? validateTransferSettings(saved) : { ...DEFAULT_TRANSFER_SETTINGS };
}

export async function saveTransferSettings(
  settings: Partial<TransferSettings>
): Promise<TransferSettings> {
  const validated = validateTransferSettings(settings);
  await browser.storage.local.set({ [TRANSFER_SETTINGS_KEY]: validated });
  return validated;
}

function validateSize(
  name: string,
  value: number,
  minimum: number,
  maximum: number
): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum} bytes`);
}
