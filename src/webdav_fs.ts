import { createClient, Client } from 'webdav/web';
import { v1 as uuidv1 } from 'uuid';

import MetadataCache from './metadata_cache';
import {
  clearOfflineEntries,
  getOfflineEntries,
  getOfflineEntry,
  invalidateOfflineEntries,
  OfflineEntryInput,
  removeOfflineEntries,
  replaceOfflineEntries,
} from './offline_store';
import {
  getOpenedFile,
  getOpenedFiles,
  openedFileKey,
  OpenedFileRecord,
  putOpenedFile,
  removeOpenedFile,
  updateOpenedFile,
} from './opened_files_store';
import Proxy from './proxy';

type ServerType = 'nc' | 'oc'; // Nextcloud/ownCloud
type PathConverter = (path: string) => string;

interface Credential {
  name: string
  domain: string
  server: ServerType
  username: string
  password: string
}

interface FileSystemProps {
  server: ServerType
  domain: string
  username: string
  client: Client
  metadataCache: MetadataCache
  filePathConverter: PathConverter
  uploadPathConverter: PathConverter
}

interface GetActionsOptions {
  fileSystemId: string
  entryPaths?: string[]
  entryPath?: string
}

interface ExecuteActionOptions extends GetActionsOptions {
  actionId: string
}

interface ProviderAction {
  id: string
  title?: string
}

const OPEN_ON_WEB = 'OPEN_ON_WEB';
const FILE_ID_PROPFIND = `<?xml version="1.0" encoding="UTF-8"?>
<d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
  <d:prop><oc:id/></d:prop>
</d:propfind>`;

export default class WebDAVFS {
  #proxy: Proxy;
  #fileSystemMap: { [fileSystemId: string]: FileSystemProps } = {};
  #ready: Promise<void> = Promise.resolve();

  constructor(proxy: Proxy) {
    this.#proxy = proxy;
    this.#ready = this.#resume();
    this.#assignEventHandlers();
  }

  async isMounted(domain: string, username: string) {
    await this.#ready;
    const fileSystemId = createFileSystemID(domain, username);
    const fileSystems: chrome.fileSystemProvider.FileSystemInfo[] =
      await new Promise(resolve => {
        chrome.fileSystemProvider.getAll(resolve);
      });
    return !! fileSystems.find(info => info.fileSystemId === fileSystemId);
  }

  async mount(credential: Credential) {
    await this.#ready;
    console.log('WebDAVFS.mount')

    const { name, domain, username } = credential;
    if (await this.isMounted(domain, username)) return;

    await this.#proxy.register(domain);

    const props = this.#getFileSystemProps(credential);
    const { client, filePathConverter } = props;
    // test connection and authentication
    await client.getDirectoryContents(filePathConverter('/'));

    const fileSystemId = createFileSystemID(domain, username);
    await new Promise<void>(resolve => chrome.fileSystemProvider.mount(
      { fileSystemId, displayName: name, writable: true }, () => resolve()
    ));

    this.#fileSystemMap[fileSystemId] = props;

    await storeMountedCredential(fileSystemId, credential);
  }

  async resumeMounts() {
    await this.#ready;
    for (const { name, domain, username } of await getMountedCredentials()) {
      const fileSystemId = createFileSystemID(domain, username);
      await new Promise<void>(resolve => chrome.fileSystemProvider.mount(
        { fileSystemId, displayName: name, writable: true }, () => resolve()
      ));
    }
    this.#resume();
  }

  async onUnmountRequested(options: chrome.fileSystemProvider.UnmountOptions) {
    const { fileSystemId } = options;
    console.log(`WebDAVFS.onUnmountRequested: fileSystemId=${fileSystemId}`);

    await new Promise<void>(resolve =>
      chrome.fileSystemProvider.unmount({ fileSystemId }, () => resolve()));

    delete this.#fileSystemMap[fileSystemId];

    await clearOfflineEntries(fileSystemId);
    await removeMountedCredential(fileSystemId);
    await this.#proxy.reconcile(
      (await getMountedCredentials()).map(credential => credential.domain)
    );
  }

  async onReadDirectoryRequested(
    options: chrome.fileSystemProvider.DirectoryPathRequestedEventOptions
  ) {
    const { fileSystemId, directoryPath } = options;
    console.log(`WebDAVFS.onReadDirectoryRequested: directoryPath=${directoryPath}`);
    console.debug(options);

    const { client, metadataCache, filePathConverter } =
      this.#fileSystemMap[fileSystemId];
    let stats: any[];
    try {
      stats = await client.getDirectoryContents(filePathConverter(directoryPath)) as any[];
    } catch (error) {
      if (isClientHttpError(error)) throw error;
      const entries = await getOfflineEntries(fileSystemId);
      const directory = await getOfflineEntry(fileSystemId, directoryPath);
      if (directory && !directory.metadata.isDirectory) throw error;
      if (!directory && !entries.some(entry =>
        isStrictDescendant(entry.filePath, directoryPath)
      )) throw error;
      const childEntries = new Map<string, (typeof entries)[number]>();
      for (const entry of entries) {
        if (parentEntryPath(entry.filePath) !== directoryPath) continue;
        const current = childEntries.get(entry.filePath);
        if (!current || entry.cachedAt > current.cachedAt)
          childEntries.set(entry.filePath, entry);
      }
      const metadataList = Array.from(childEntries.values(), entry =>
        entry.metadata as chrome.fileSystemProvider.EntryMetadata);
      return [metadataList.map(metadata => canonicalizedMetadata(metadata, options)), false];
    }
    const metadataList = stats.map(fromStat);
    metadataCache.put(directoryPath, metadataList);
    const hasMore = false;
    return [metadataList.map(metadata =>
      canonicalizedMetadata(metadata, options)), hasMore];
  }

  async onGetMetadataRequested(
    options: chrome.fileSystemProvider.MetadataRequestedEventOptions
  ) {
    const { fileSystemId, entryPath, thumbnail } = options;
    console.log(`WebDAVFS.onGetMetadataRequested: entryPath=${entryPath}, thumbnail=${thumbnail}`);
    console.debug(options);

    if (thumbnail) throw new Error('Thumbnail not supported');

    const { client, metadataCache, filePathConverter } =
      this.#fileSystemMap[fileSystemId];
    const cache = metadataCache.get(entryPath);
    if (cache.metadata && cache.directoryExists && cache.fileExists)
      return [canonicalizedMetadata(cache.metadata, options)];

    try {
      const stat = await client.stat(filePathConverter(entryPath));
      console.debug(stat);
      return [canonicalizedMetadata(fromStat(stat), options)];
    } catch (error) {
      if (isClientHttpError(error)) throw error;
      const entry = await getOfflineEntry(fileSystemId, entryPath);
      const entries = entry ? [] : await getOfflineEntries(fileSystemId);
      if (!entry && !entries.some(candidate =>
        isStrictDescendant(candidate.filePath, entryPath)
      )) throw error;
      const metadata = entry?.metadata || {
        name: entryPath === '/' ? '' : entryPath.slice(entryPath.lastIndexOf('/') + 1),
        isDirectory: true,
        modificationTime: new Date(0),
      };
      return [canonicalizedMetadata(
        metadata as chrome.fileSystemProvider.EntryMetadata, options
      )];
    }
  }

  async onOpenFileRequested(
    options: chrome.fileSystemProvider.OpenFileRequestedEventOptions
  ) {
    const { fileSystemId, requestId, filePath, mode } = options;
    console.log(`WebDAVFS.onOpenFileRequested: requestId=${requestId}, filePath='${filePath}', mode=${mode}`);
    console.debug(options);

    const buffer = new ArrayBuffer(0);
    const uuid = uuidv1();
    const { server, client, uploadPathConverter } = this.#fileSystemMap[fileSystemId];

    if (mode === 'WRITE' && server === 'nc') {
      // Nextcloud chunked file upload
      // https://docs.nextcloud.com/server/15/developer_manual/client_apis/WebDAV/chunking.html
      await client.createDirectory(uploadPathConverter(`/${uuid}`));
    }

    await putOpenedFile({
      key: openedFileKey(fileSystemId, requestId),
      openRequestId: requestId,
      fileSystemId,
      filePath,
      mode,
      uuid,
      buffer,
      recoverable: true,
    });
  }

  async onCloseFileRequested(
    options: chrome.fileSystemProvider.OpenedFileRequestedEventOptions
  ) {
    const { fileSystemId, openRequestId } = options;
    const openedFile = await getOpenedFile(fileSystemId, openRequestId);
    if (!openedFile) throw new Error('Open file operation state is unavailable');
    const { filePath, mode, uuid, buffer, recoverable } = openedFile;
    console.log(`WebDAVFS.onCloseFileRequested: openRequestId=${openRequestId}, filePath='${filePath}', mode=${mode}`);

    const { server, client, filePathConverter, uploadPathConverter } =
      this.#fileSystemMap[fileSystemId];

    if (mode === 'WRITE') {
      if (!recoverable) throw new Error('Open file operation cannot be safely resumed');
      if (server === 'nc') {
        // Nextcloud chunked file upload
        // https://docs.nextcloud.com/server/15/developer_manual/client_apis/WebDAV/chunking.html
        await client.moveFile(
          uploadPathConverter(`/${uuid}/.file`), filePathConverter(filePath)
        );
      } else await client.putFileContents(filePathConverter(filePath), buffer);
      await invalidateOfflineEntries(fileSystemId, filePath);
    }

    await removeOpenedFile(fileSystemId, openRequestId);
  }

  async onReadFileRequested(
    options: chrome.fileSystemProvider.OpenedFileOffsetRequestedEventOptions
  ) {
    const { fileSystemId, openRequestId, offset, length } = options;
    const openedFile = await getOpenedFile(fileSystemId, openRequestId);
    if (!openedFile) throw new Error('Open file operation state is unavailable');
    const { filePath } = openedFile;
    console.log(`WebDAVFS.onReadFileRequested: openRequestId=${openRequestId}, filePath='${filePath}', offset=${offset}, length=${length}`);
    console.debug(options);

    const { client, filePathConverter } = this.#fileSystemMap[fileSystemId];
    const url = new URL(client.getFileDownloadLink(filePathConverter(filePath)));
    const url_ = url.origin + url.pathname;

    const credential = [url.username, url.password].map(decodeURIComponent).join(':');

    const headers = new Headers();
    headers.set('Authorization', `Basic ${btoa(credential)}`);
    // HTTP range requests
    // https://developer.mozilla.org/en-US/docs/Web/HTTP/Range_requests
    headers.set('Range', `bytes=${offset}-${offset + length - 1}`);

    let response: Response;
    try {
      response = await fetch(url_, { headers });
    } catch (error) {
      const entry = await getOfflineEntry(fileSystemId, filePath);
      if (!entry?.content) throw error;
      const bytes = new Uint8Array(entry.content).slice(offset, offset + length);
      return [bytes.buffer, offset + bytes.byteLength < entry.content.byteLength];
    }
    if (!response.ok) {
      if (response.status < 500)
        throw new Error(`File read failed with status ${response.status}`);
      const entry = await getOfflineEntry(fileSystemId, filePath);
      if (!entry?.content)
        throw new Error(`File read failed with status ${response.status}`);
      const bytes = new Uint8Array(entry.content).slice(offset, offset + length);
      return [bytes.buffer, offset + bytes.byteLength < entry.content.byteLength];
    }
    console.log(`WebDAVFS.onReadFileRequested: Content-Range: ${response.headers.get('Content-Range')}`);
    const buffer = await response.arrayBuffer();
    const hasMore = false;
    return [buffer, hasMore];
  }

  async onWriteFileRequested(
    options: chrome.fileSystemProvider.OpenedFileIoRequestedEventOptions
  ) {
    const { fileSystemId, openRequestId, offset, data } = options;
    const openedFile = await getOpenedFile(fileSystemId, openRequestId);
    if (!openedFile) throw new Error('Open file operation state is unavailable');
    if (!openedFile.recoverable)
      throw new Error('Open file operation cannot be safely resumed');
    const { filePath, uuid } = openedFile;
    console.log(`WebDAVFS.onWriteFileRequested: openRequestId=${openRequestId}, filePath='${filePath}', offset=${offset}, data.byteLength=${data.byteLength}`);

    const { server, client, uploadPathConverter } =
      this.#fileSystemMap[fileSystemId];

    if (server === 'nc') {
      // Nextcloud chunked file upload
      // https://docs.nextcloud.com/server/15/developer_manual/client_apis/WebDAV/chunking.html
      const end = offset + data.byteLength - 1;
      const uploadPath = `/${uuid}/${paddedIndex(offset)}-${paddedIndex(end)}`;

      console.log(`WebDAVFS.onWriteFileRequested: uploadPath: ${uploadPath}`);
      await client.putFileContents(uploadPathConverter(uploadPath), data);
    } else {
      await updateOpenedFile(fileSystemId, openRequestId, current => {
        const length = Math.max(current.buffer.byteLength, offset + data.byteLength);
        const typed = new Uint8Array(new ArrayBuffer(length));
        typed.set(new Uint8Array(current.buffer));
        typed.set(new Uint8Array(data), offset);
        return { ...current, buffer: typed.buffer };
      });
    }
  }

  async onCreateDirectoryRequested(
    options: chrome.fileSystemProvider.DirectoryPathRecursiveRequestedEventOptions
  ) {
    const { fileSystemId, directoryPath } = options;
    console.log(`WebDAVFS.onCreateDirectoryRequested: directoryPath=${directoryPath}`);
    console.debug(options);

    const { client, metadataCache, filePathConverter } = this.#fileSystemMap[fileSystemId];
    await client.createDirectory(filePathConverter(directoryPath));

    await invalidateOfflineEntries(fileSystemId, directoryPath);
    metadataCache.remove(directoryPath);
  }

  async onDeleteEntryRequested(
    options: chrome.fileSystemProvider.EntryPathRecursiveRequestedEventOptions
  ) {
    const { fileSystemId, entryPath } = options;
    console.log(`WebDAVFS.onDeleteEntryRequested: entryPath=${entryPath}`);

    const { client, metadataCache, filePathConverter } = this.#fileSystemMap[fileSystemId];
    await client.deleteFile(filePathConverter(entryPath));

    await invalidateOfflineEntries(fileSystemId, entryPath);
    metadataCache.remove(entryPath);
  }

  async onCreateFileRequested(
    options: chrome.fileSystemProvider.FilePathRequestedEventOptions
  ) {
    const { fileSystemId, filePath } = options;
    console.log(`WebDAVFS.onCreateFileRequested: filePath=${filePath}`);

    const { client, metadataCache, filePathConverter } = this.#fileSystemMap[fileSystemId];
    const data = new ArrayBuffer(0);
    await client.putFileContents(filePathConverter(filePath), data);

    await invalidateOfflineEntries(fileSystemId, filePath);
    metadataCache.remove(filePath);
  }

  async onCopyEntryRequested(
    options: chrome.fileSystemProvider.SourceTargetPathRequestedEventOptions
  ) {
    const { fileSystemId, sourcePath, targetPath } = options;
    console.log(`WebDAVFS.onCopyEntryRequested: sourcePath=${sourcePath}, targetPath=${targetPath}`);

    const { client, metadataCache, filePathConverter } = this.#fileSystemMap[fileSystemId];
    await client.copyFile(filePathConverter(sourcePath), filePathConverter(targetPath));

    await invalidateOfflineEntries(fileSystemId, targetPath);
    metadataCache.remove(sourcePath);
    metadataCache.remove(targetPath);
  }

  async onMoveEntryRequested(
    options: chrome.fileSystemProvider.SourceTargetPathRequestedEventOptions
  ) {
    const { fileSystemId, sourcePath, targetPath } = options;
    console.log(`WebDAVFS.onMoveEntryRequested: sourcePath=${sourcePath}, targetPath=${targetPath}`);

    const { client, metadataCache, filePathConverter } = this.#fileSystemMap[fileSystemId];
    await client.moveFile(filePathConverter(sourcePath), filePathConverter(targetPath));

    await invalidateOfflineEntries(fileSystemId, sourcePath);
    await invalidateOfflineEntries(fileSystemId, targetPath);
    metadataCache.remove(sourcePath);
    metadataCache.remove(targetPath);
  }

  async onTruncateRequested(
    options: chrome.fileSystemProvider.FilePathLengthRequestedEventOptions
  ) {
    const { filePath, length } = options;
    console.log(`WebDAVFS.onTruncateRequested: filePath=${filePath}, length=${length}`);
    // do nothing
  }

  async onAbortRequested(
    options: chrome.fileSystemProvider.OperationRequestedEventOptions
  ) {
    const { operationRequestId } = options;
    console.log(`WebDAVFS.onAbortRequested: operationRequestId=${operationRequestId}`)
  }

  async onGetActionsRequested(options: GetActionsOptions) {
    const { fileSystemId } = options;
    const entryPaths = requestedEntryPaths(options);
    if (!entryPaths.length) return [[
      { id: OPEN_ON_WEB, title: chrome.i18n.getMessage('openOnWeb') || 'Open on web' },
    ]];

    const props = this.#fileSystemMap[fileSystemId];
    const actions: ProviderAction[] = [];

    const entries = await Promise.all(entryPaths.map(entryPath =>
      getOfflineEntry(fileSystemId, entryPath).catch(error => {
        console.warn('Could not read offline pin state', error);
        return undefined;
      })
    ));
    const isPinned = entries.map(entry => Boolean(entry && !entry.incomplete));
    if (isPinned.every(Boolean)) actions.push({ id: 'OFFLINE_NOT_NECESSARY' });
    else actions.push({ id: 'SAVE_FOR_OFFLINE' });
    if (props?.server === 'nc' && entryPaths.length === 1)
      actions.push({ id: 'SHARE' });
    actions.push({
      id: OPEN_ON_WEB,
      title: chrome.i18n.getMessage('openOnWeb') || 'Open on web',
    });
    return [actions];
  }

  async onExecuteActionRequested(options: ExecuteActionOptions) {
    const { fileSystemId, actionId } = options;
    const requestedPaths = requestedEntryPaths(options);
    const entryPaths = actionId === OPEN_ON_WEB && !requestedPaths.length
      ? ['/']
      : requestedPaths;
    if (!entryPaths.length) throw new Error('Action requires a selected entry');
    if (actionId === 'SAVE_FOR_OFFLINE') {
      for (const entryPath of entryPaths) {
        const entry = await getOfflineEntry(fileSystemId, entryPath);
        if (entry && !entry.incomplete) continue;
        await this.#pinOfflineEntry(fileSystemId, entryPath);
      }
    } else if (actionId === 'OFFLINE_NOT_NECESSARY') {
      for (const entryPath of entryPaths)
        await removeOfflineEntries(fileSystemId, entryPath);
    } else if (actionId === 'SHARE') {
      if (entryPaths.length !== 1) throw new Error('Share one entry at a time');
      const shareUrl = await this.#createPublicShare(fileSystemId, entryPaths[0]);
      const panelUrl = browser.runtime.getURL(
        `share.html?url=${encodeURIComponent(shareUrl)}`
      );
      await browser.tabs.create({ url: panelUrl });
    } else if (actionId === OPEN_ON_WEB) {
      for (const entryPath of entryPaths)
        await this.#openInWeb(fileSystemId, entryPath);
    } else throw new Error('Unsupported action');
  }

  async #pinOfflineEntry(fileSystemId: string, entryPath: string) {
    const { client, filePathConverter } = this.#fileSystemMap[fileSystemId];
    const entries: OfflineEntryInput[] = [];
    const visited = new Set<string>();

    const collect = async (path: string, stat?: any): Promise<void> => {
      if (visited.has(path)) return;
      visited.add(path);
      const current = stat || await client.stat(filePathConverter(path));
      const metadata = fromStat(current) as OfflineEntryInput['metadata'];
      const entry: OfflineEntryInput = { filePath: path, metadata };
      entries.push(entry);
      if (metadata.isDirectory) {
        const children = await client.getDirectoryContents(filePathConverter(path)) as any[];
        for (const child of children)
          await collect(joinEntryPath(path, child.basename), child);
      } else {
        entry.content = toArrayBuffer(await client.getFileContents(
          filePathConverter(path), { format: 'binary' }
        ));
      }
    };

    await collect(entryPath);
    await replaceOfflineEntries(fileSystemId, entryPath, entries);
  }

  async #createPublicShare(fileSystemId: string, entryPath: string) {
    const { domain, client } = this.#fileSystemMap[fileSystemId];
    const headers = new Headers(client.getHeaders());
    headers.set('Accept', 'application/json');
    headers.set('OCS-APIRequest', 'true');
    headers.set('Content-Type', 'application/x-www-form-urlencoded');
    const body = new URLSearchParams({ path: entryPath, shareType: '3' });
    const response = await fetch(
      `https://${domain}/ocs/v2.php/apps/files_sharing/api/v1/shares`,
      { method: 'POST', headers, body }
    );
    if (!response.ok) throw new Error(`Nextcloud sharing failed with status ${response.status}`);
    const result = await response.json();
    const ocs = result?.ocs;
    const statusCode = Number(ocs?.meta?.statuscode);
    const shareUrl = ocs?.data?.url;
    if (![100, 200].includes(statusCode) || typeof shareUrl !== 'string' || !shareUrl)
      throw new Error(ocs?.meta?.message || 'Nextcloud did not return a public link');
    return shareUrl;
  }

  async #openInWeb(fileSystemId: string, entryPath: string) {
    const { domain, client, filePathConverter } = this.#fileSystemMap[fileSystemId];
    const result = await client.stat(filePathConverter(entryPath), {
      details: true,
      data: FILE_ID_PROPFIND,
    });
    const stat = result?.data || result;
    const url = new URL('/apps/files/', `https://${domain}`);
    if (stat.type === 'directory') {
      url.searchParams.set('dir', entryPath);
    } else {
      const fileId = getFileId(stat);
      if (!fileId) throw new Error('Nextcloud did not return a file ID for the selected file');
      url.pathname = `${url.pathname}files/${encodeURIComponent(fileId)}`;
      url.searchParams.set('dir', parentEntryPath(entryPath));
      url.searchParams.set('openfile', 'true');
    }
    await browser.tabs.create({ url: url.toString() });
  }

  #assignEventHandlers = () => {
    for (const name of Object.getOwnPropertyNames(WebDAVFS.prototype)) {
      if (!name.match(/^on/)) continue;

      (chrome.fileSystemProvider as any)[name].addListener(
        (options: any, successCallback: Function, errorCallback: Function) => {
            this.#ready.then(() => (this as any)[name](options)).then((result: void | Array<any>) => {
            successCallback(...(result || []));
          }).catch((error: string | Error) => {
            if (error instanceof Error) console.error(error);
            let reason = typeof error === 'string' ? error : 'FAILED';
            if ((error as Error).message === 'Request failed with status code 404')
              reason = 'NOT_FOUND';
            errorCallback(reason);
          });
        }
      );
    }
  };

  #resume = async () => {
    console.log('WebDAVFS.resume');

    const credentials = await getMountedCredentials();
    const fileSystems: chrome.fileSystemProvider.FileSystemInfo[] =
      await new Promise(resolve => chrome.fileSystemProvider.getAll(resolve));
    const mountedIds = new Set(fileSystems.map(fileSystem => fileSystem.fileSystemId));
    const mountedCredentials = credentials.filter(credential => {
      const fileSystemId = createFileSystemID(credential.domain, credential.username);
      return mountedIds.has(fileSystemId);
    });

    for (const credential of mountedCredentials) {
      const { domain, username } = credential;
      const fileSystemId = createFileSystemID(domain, username);
      this.#fileSystemMap[fileSystemId] = this.#getFileSystemProps(credential);
    }

    await this.#proxy.reconcile(mountedCredentials.map(credential => credential.domain));

    const storedFiles = new Map(
      (await getOpenedFiles()).map(openedFile => [openedFile.key, openedFile])
    );
    const activeKeys = new Set<string>();
    for (const fileSystem of fileSystems) {
      for (const openedFile of fileSystem.openedFiles || []) {
        const key = openedFileKey(fileSystem.fileSystemId, openedFile.openRequestId);
        activeKeys.add(key);
        const stored = storedFiles.get(key);
        if (stored && stored.filePath === openedFile.filePath && stored.mode === openedFile.mode)
          continue;

        const recovered: OpenedFileRecord = {
          key,
          openRequestId: openedFile.openRequestId,
          fileSystemId: fileSystem.fileSystemId,
          filePath: openedFile.filePath,
          mode: openedFile.mode,
          uuid: uuidv1(),
          buffer: new ArrayBuffer(0),
          recoverable: openedFile.mode !== 'WRITE',
        };
        await putOpenedFile(recovered);
      }
    }
    for (const record of storedFiles.values()) {
      if (mountedIds.has(record.fileSystemId) && !activeKeys.has(record.key))
        await removeOpenedFile(record.fileSystemId, record.openRequestId);
    }
  };

  #getFileSystemProps = (credential: Credential) => {
    const { domain, server, username, password } = credential;

    const url = `https://${domain}/remote.php/dav/`;
    const client = createClient(url, { username, password });
    const metadataCache = new MetadataCache();
    const filePathConverter: PathConverter =
      path => `/files/${username}${path}`;
    const uploadPathConverter: PathConverter =
      path => `/uploads/${username}${path}`;

    return {
      server, domain, username, client, metadataCache, filePathConverter, uploadPathConverter,
    };
  };
}

async function storeMountedCredential(
  fileSystemId: string, credential: Credential
) {
  let { mountedCredentials } = await browser.storage.local.get();
  mountedCredentials = mountedCredentials || {};
  mountedCredentials[fileSystemId] = credential;
  await browser.storage.local.set({ mountedCredentials });
}

async function removeMountedCredential(fileSystemId: string) {
  const { mountedCredentials } = await browser.storage.local.get();
  if (!mountedCredentials) return;
  delete mountedCredentials[fileSystemId];
  await browser.storage.local.set({ mountedCredentials });
}

async function getMountedCredentials(): Promise<Credential[]> {
  const { mountedCredentials } = await browser.storage.local.get();
  return Object.values(mountedCredentials || {});
}

function createFileSystemID(domain: string, username: string) {
  return `webdavfs://${domain}/${username}`;
}

function requestedEntryPaths(options: GetActionsOptions) {
  const entryPaths = Array.isArray(options.entryPaths)
    ? options.entryPaths.filter(entryPath => typeof entryPath === 'string')
    : [];
  if (entryPaths.length) return entryPaths;
  return typeof options.entryPath === 'string' ? [options.entryPath] : [];
}

function parentEntryPath(entryPath: string) {
  if (entryPath === '/') return '/';
  const separator = entryPath.lastIndexOf('/');
  return separator <= 0 ? '/' : entryPath.slice(0, separator);
}

function isStrictDescendant(entryPath: string, directoryPath: string) {
  if (directoryPath === '/') return entryPath !== '/' && entryPath.startsWith('/');
  return entryPath.startsWith(`${directoryPath}/`);
}

function joinEntryPath(directoryPath: string, name: string) {
  return directoryPath === '/' ? `/${name}` : `${directoryPath}/${name}`;
}

function toArrayBuffer(value: any): ArrayBuffer {
  if (value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) {
    const bytes = new Uint8Array(value.byteLength);
    bytes.set(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    return bytes.buffer;
  }
  throw new Error('WebDAV returned an unsupported file content type');
}

function getFileId(stat: any): string | undefined {
  const properties = stat.props || {};
  const fileId = properties['oc:id'] ?? properties['{http://owncloud.org/ns}id'] ??
    properties.id ?? stat.id ?? stat.fileId ?? properties.fileId ??
    stat.fileid ?? properties.fileid ?? properties['nc:id'] ??
    properties['{http://owncloud.org/ns}fileid'] ??
    properties['oc:fileid'] ?? properties['nc:fileid'] ??
    properties['{http://nextcloud.org/ns}fileid'];
  return fileId === undefined || fileId === null ? undefined : String(fileId);
}

function isClientHttpError(error: any) {
  const status = error?.status || error?.response?.status ||
    Number(error?.message?.match(/status code (\d+)/)?.[1]);
  return Number.isFinite(status) && status > 0 && status < 500;
}

function fromStat(stat: any): chrome.fileSystemProvider.EntryMetadata {
  const { basename, lastmod, size, type, mime } = stat;
  return {
    isDirectory: type === 'directory',
    name: basename,
    size: size,
    modificationTime: new Date(lastmod),
    mimeType: mime,
  };
}

function canonicalizedMetadata(
  metadata: chrome.fileSystemProvider.EntryMetadata, options: any
): chrome.fileSystemProvider.EntryMetadata {
  const _metadata: any = Object.assign({}, metadata);
  for (const key of Object.keys(metadata)) {
    if (!options[key]) delete _metadata[key];
  }
  return _metadata;
}

function paddedIndex(index: number) {
  const padding = '000000000000000';
  const length = padding.length;

  return (padding + String(index)).slice(-length);
}
