import { DEFAULT_TRANSFER_SETTINGS } from './transfer_settings';

export const OPEN_IN_WEB_ACTION = 'open-in-web';
export const NEXTCLOUD_UPLOAD_CHUNK_SIZE =
  DEFAULT_TRANSFER_SETTINGS.uploadChunkSize;
export const NEXTCLOUD_MAX_UPLOAD_CHUNKS = 10000;
export const NEXTCLOUD_PREVIEW_SIZE = 128;
export const MAX_THUMBNAIL_DATA_URI_LENGTH = 32 * 1024;

export const NEXTCLOUD_FILE_INFO_PROPFIND_BODY =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">' +
  '<d:prop><oc:fileid/><d:resourcetype/></d:prop></d:propfind>';

export function getNextcloudFileMetadata(xml: string): {
  fileId: string
  isDirectory: boolean
} {
  const fileIdElement = xml.match(
    /<((?:[A-Za-z_][\w.-]*:)?fileid)\b[^>]*>([^<]*)<\/\1\s*>/i
  );
  const fileId = fileIdElement?.[2].trim();
  if (!fileId)
    throw new Error('Nextcloud file ID is unavailable from WebDAV metadata');

  const resourceType = xml.match(
    /<((?:[A-Za-z_][\w.-]*:)?resourcetype)\b[^>]*>([\s\S]*?)<\/\1\s*>/i
  );

  return {
    fileId,
    isDirectory: !!resourceType &&
      /<(?:[A-Za-z_][\w.-]*:)?collection(?:\s|\/?>)/i.test(resourceType[2]),
  };
}

export function getOpenInWebActions(
  server: 'nc' | 'oc' | undefined,
  entryCount: number,
  title: string
): [chrome.fileSystemProvider.Action[]] {
  if (server === 'oc' || entryCount === 0) return [[]];
  return [[{ id: OPEN_IN_WEB_ACTION, title }]];
}

export function buildNextcloudFilesUrl(
  domain: string,
  entryPath: string,
  isDirectory: boolean,
  fileId: string,
  useHttps = true
): string {
  const url = new URL(
    `/apps/files/files/${encodeURIComponent(fileId)}`,
    `${useHttps ? 'https' : 'http'}://${domain}`
  );
  const path = entryPath.endsWith('/') && entryPath !== '/'
    ? entryPath.slice(0, -1)
    : entryPath;
  const parentSeparator = path.lastIndexOf('/');
  url.searchParams.set(
    'dir',
    isDirectory
      ? path
      : parentSeparator <= 0 ? '/' : path.slice(0, parentSeparator)
  );

  if (!isDirectory) {
    url.searchParams.set('editing', 'false');
    url.searchParams.set('openfile', 'true');
  }

  return url.toString();
}

export function buildNextcloudFileDestination(
  domain: string,
  username: string,
  filePath: string,
  useHttps = true
): string {
  const origin = new URL(`${useHttps ? 'https' : 'http'}://${domain}`).origin;
  const encodedPath = filePath
    .split('/')
    .map(segment => encodeURIComponent(segment))
    .join('/');
  return `${origin}/remote.php/dav/files/${encodeURIComponent(username)}${encodedPath}`;
}

export function getNextcloudUploadChunkCount(
  fileSize: number,
  chunkSize = NEXTCLOUD_UPLOAD_CHUNK_SIZE
): number {
  if (!Number.isSafeInteger(fileSize) || fileSize < 0)
    throw new Error('Nextcloud upload size must be a non-negative safe integer');
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 5 * 1024 * 1024 ||
    chunkSize > 5 * 1024 * 1024 * 1024)
    throw new Error('Nextcloud upload chunk size must be between 5 MiB and 5 GiB');

  const chunkCount = Math.ceil(fileSize / chunkSize);
  if (chunkCount > NEXTCLOUD_MAX_UPLOAD_CHUNKS)
    throw new Error(`Nextcloud uploads are limited to ${NEXTCLOUD_MAX_UPLOAD_CHUNKS} chunks`);
  return chunkCount;
}

interface NextcloudUploadClient {
  customRequest(
    path: string,
    options: {
      method: string
      headers?: Record<string, string>
      data?: ArrayBuffer
    }
  ): Promise<unknown>
}

interface NextcloudPreviewResponse {
  ok: boolean
  status: number
  headers: { get(name: string): string | null }
  arrayBuffer(): Promise<ArrayBuffer>
}

interface NextcloudPreviewClient {
  customRequest(
    path: string,
    options: { method: string; url: string }
  ): Promise<NextcloudPreviewResponse>
}

interface NextcloudFileInfoResponse {
  text(): Promise<string>
}

interface NextcloudFileInfoClient {
  customRequest(
    path: string,
    options: {
      method: string
      headers: Record<string, string>
      data: string
    }
  ): Promise<NextcloudFileInfoResponse>
}

export function buildNextcloudPreviewUrl(origin: string, fileId: string): string {
  const url = new URL('/index.php/core/preview', origin);
  url.search = new URLSearchParams({
    fileId,
    x: String(NEXTCLOUD_PREVIEW_SIZE),
    y: String(NEXTCLOUD_PREVIEW_SIZE),
    a: 'true',
    forceIcon: 'false',
    mimeFallback: 'false',
  }).toString();
  return url.toString();
}

export async function fetchNextcloudThumbnail(
  client: NextcloudPreviewClient,
  fileId: string,
  origin: string
): Promise<string | undefined> {
  const response = await client.customRequest('/', {
    method: 'GET',
    url: buildNextcloudPreviewUrl(origin, fileId),
  });
  if (!response.ok) {
    console.warn(`Nextcloud preview request failed: HTTP ${response.status}`);
    return undefined;
  }

  const mimeType = response.headers.get('content-type')
    ?.split(';', 1)[0]
    .trim()
    .toLowerCase();
  if (!mimeType || !['image/png', 'image/jpeg', 'image/webp'].includes(mimeType)) {
    console.warn(`Nextcloud preview returned unsupported content type: ${mimeType || 'missing'}`);
    return undefined;
  }

  const image = new Uint8Array(await response.arrayBuffer());

  let binary = '';
  for (let offset = 0; offset < image.length; offset += 0x8000) {
    binary += String.fromCharCode(...image.subarray(offset, offset + 0x8000));
  }
  const dataUri = `data:${mimeType};base64,${btoa(binary)}`;
  if (dataUri.length > MAX_THUMBNAIL_DATA_URI_LENGTH) {
    console.warn(`Nextcloud preview exceeds Chrome's 32 KB data URI limit: ${dataUri.length} bytes`);
    return undefined;
  }
  return dataUri;
}

export async function fetchNextcloudThumbnailForPath(
  fileClient: NextcloudFileInfoClient,
  previewClient: NextcloudPreviewClient,
  filePath: string,
  previewOrigin: string
): Promise<string | undefined> {
  const response = await fileClient.customRequest(filePath, {
    method: 'PROPFIND',
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      Depth: '0',
    },
    data: NEXTCLOUD_FILE_INFO_PROPFIND_BODY,
  });
  const { fileId, isDirectory } = getNextcloudFileMetadata(await response.text());
  if (isDirectory) return undefined;
  return fetchNextcloudThumbnail(previewClient, fileId, previewOrigin);
}

export interface NextcloudUploadTimings {
  chunkCount: number
  chunkUploadMs: number
  assemblyMs: number
}

interface NextcloudUploadTimingCallbacks {
  onChunksUploaded?: (timing: Pick<NextcloudUploadTimings, 'chunkCount' | 'chunkUploadMs'>) => void
  onAssemblyComplete?: (assemblyMs: number) => void
}

export interface NextcloudUploadOptions extends NextcloudUploadTimingCallbacks {
  firstChunkIndex?: number
  chunkSize?: number
}

export async function uploadNextcloudChunk(
  client: NextcloudUploadClient,
  uploadPath: string,
  chunkIndex: number,
  destination: string,
  data: ArrayBuffer,
  totalLength?: number
): Promise<void> {
  const headers: Record<string, string> = { Destination: destination };
  if (totalLength !== undefined)
    headers['OC-Total-Length'] = String(totalLength);
  const chunkName = String(chunkIndex + 1).padStart(5, '0');
  await client.customRequest(`${uploadPath}/${chunkName}`, {
    method: 'PUT',
    headers,
    data,
  });
}

export async function createNextcloudUploadFolder(
  client: NextcloudUploadClient,
  uploadPath: string,
  destination: string
): Promise<void> {
  await client.customRequest(uploadPath, {
    method: 'MKCOL',
    headers: { Destination: destination },
  });
}

export async function uploadNextcloudFile(
  client: NextcloudUploadClient,
  uploadPath: string,
  destinationPath: string,
  destination: string,
  fileSize: number,
  readRange: (offset: number, length: number) => Promise<ArrayBuffer>,
  options: NextcloudUploadOptions = {}
): Promise<NextcloudUploadTimings> {
  const chunkSize = options.chunkSize ?? NEXTCLOUD_UPLOAD_CHUNK_SIZE;
  const chunkCount = getNextcloudUploadChunkCount(fileSize, chunkSize);

  if (chunkCount === 0) {
    const uploadStartedAt = performance.now();
    await client.customRequest(destinationPath, {
      method: 'PUT',
      data: await readRange(0, 0),
    });
    await client.customRequest(`${uploadPath}/`, { method: 'DELETE' });
    const timing = {
      chunkCount: 0,
      chunkUploadMs: performance.now() - uploadStartedAt,
      assemblyMs: 0,
    };
    options.onChunksUploaded?.({
      chunkCount: timing.chunkCount,
      chunkUploadMs: timing.chunkUploadMs,
    });
    options.onAssemblyComplete?.(timing.assemblyMs);
    return timing;
  }

  const headers = {
    Destination: destination,
    'OC-Total-Length': String(fileSize),
  };
  const chunkUploadStartedAt = performance.now();
  const firstChunkIndex = options.firstChunkIndex ?? 0;
  if (!Number.isSafeInteger(firstChunkIndex) ||
    firstChunkIndex < 0 ||
    firstChunkIndex > chunkCount)
    throw new Error('First Nextcloud upload chunk index is out of range');
  for (let index = firstChunkIndex; index < chunkCount; index++) {
    const start = index * chunkSize;
    const end = Math.min(start + chunkSize, fileSize);
    await client.customRequest(`${uploadPath}/${String(index + 1).padStart(5, '0')}`, {
      method: 'PUT',
      headers,
      data: await readRange(start, end - start),
    });
  }
  const chunkUploadMs = performance.now() - chunkUploadStartedAt;
  options.onChunksUploaded?.({
    chunkCount: chunkCount - firstChunkIndex,
    chunkUploadMs,
  });

  const assemblyStartedAt = performance.now();
  await client.customRequest(`${uploadPath}/.file`, {
    method: 'MOVE',
    headers,
  });
  const assemblyMs = performance.now() - assemblyStartedAt;
  options.onAssemblyComplete?.(assemblyMs);
  return {
    chunkCount: chunkCount - firstChunkIndex,
    chunkUploadMs,
    assemblyMs,
  };
}
