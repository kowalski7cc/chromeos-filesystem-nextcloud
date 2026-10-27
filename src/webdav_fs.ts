import { createClient, Client } from 'webdav/web';
import { v1 as uuidv1 } from 'uuid';

import MetadataCache from './metadata_cache';
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

interface MountedStorage {
  mountedCredentials?: Record<string, Credential>
}

interface FileSystemProps {
  server: ServerType
  client: Client
  metadataCache: MetadataCache
  filePathConverter: PathConverter
  uploadPathConverter: PathConverter
}

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

    await removeMountedCredential(fileSystemId);
    await this.#proxy.reconcile(
      (await getMountedCredentials()).map(credential => credential.domain)
    );
  }

  async onReadDirectoryRequested(
    options: chrome.fileSystemProvider.ReadDirectoryRequestedOptions
  ) {
    const { fileSystemId, directoryPath } = options;
    console.log(`WebDAVFS.onReadDirectoryRequested: directoryPath=${directoryPath}`);
    console.debug(options);

    const { client, metadataCache, filePathConverter } =
      this.#fileSystemMap[fileSystemId];
    const stats =
      await client.getDirectoryContents(filePathConverter(directoryPath)) as any[];
    const metadataList = stats.map(fromStat);
    metadataCache.put(directoryPath, metadataList);
    const hasMore = false;
    return [metadataList.map(metadata =>
      canonicalizedMetadata(metadata, options)), hasMore];
  }

  async onGetMetadataRequested(
    options: chrome.fileSystemProvider.GetMetadataRequestedOptions
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

    const stat = await client.stat(filePathConverter(entryPath));
    console.debug(stat);
    return [canonicalizedMetadata(fromStat(stat), options)];
  }

  async onOpenFileRequested(
    options: chrome.fileSystemProvider.OpenFileRequestedOptions
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
    options: chrome.fileSystemProvider.CloseFileRequestedOptions
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
    }

    await removeOpenedFile(fileSystemId, openRequestId);
  }

  async onReadFileRequested(
    options: chrome.fileSystemProvider.ReadFileRequestedOptions
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

    const response = await fetch(url_, { headers });
    console.log(`WebDAVFS.onReadFileRequested: Content-Range: ${response.headers.get('Content-Range')}`);
    const buffer = await response.arrayBuffer();
    const hasMore = false;
    return [buffer, hasMore];
  }

  async onWriteFileRequested(
    options: chrome.fileSystemProvider.WriteFileRequestedOptions
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
    options: chrome.fileSystemProvider.CreateDirectoryRequestedOptions
  ) {
    const { fileSystemId, directoryPath } = options;
    console.log(`WebDAVFS.onCreateDirectoryRequested: directoryPath=${directoryPath}`);
    console.debug(options);

    const { client, metadataCache, filePathConverter } = this.#fileSystemMap[fileSystemId];
    await client.createDirectory(filePathConverter(directoryPath));

    metadataCache.remove(directoryPath);
  }

  async onDeleteEntryRequested(
    options: chrome.fileSystemProvider.DeleteEntryRequestedOptions
  ) {
    const { fileSystemId, entryPath } = options;
    console.log(`WebDAVFS.onDeleteEntryRequested: entryPath=${entryPath}`);

    const { client, metadataCache, filePathConverter } = this.#fileSystemMap[fileSystemId];
    await client.deleteFile(filePathConverter(entryPath));

    metadataCache.remove(entryPath);
  }

  async onCreateFileRequested(
    options: chrome.fileSystemProvider.CreateFileRequestedOptions
  ) {
    const { fileSystemId, filePath } = options;
    console.log(`WebDAVFS.onCreateFileRequested: filePath=${filePath}`);

    const { client, metadataCache, filePathConverter } = this.#fileSystemMap[fileSystemId];
    const data = new ArrayBuffer(0);
    await client.putFileContents(filePathConverter(filePath), data);

    metadataCache.remove(filePath);
  }

  async onCopyEntryRequested(
    options: chrome.fileSystemProvider.CopyEntryRequestedOptions
  ) {
    const { fileSystemId, sourcePath, targetPath } = options;
    console.log(`WebDAVFS.onCopyEntryRequested: sourcePath=${sourcePath}, targetPath=${targetPath}`);

    const { client, metadataCache, filePathConverter } = this.#fileSystemMap[fileSystemId];
    await client.copyFile(filePathConverter(sourcePath), filePathConverter(targetPath));

    metadataCache.remove(sourcePath);
    metadataCache.remove(targetPath);
  }

  async onMoveEntryRequested(
    options: chrome.fileSystemProvider.MoveEntryRequestedOptions
  ) {
    const { fileSystemId, sourcePath, targetPath } = options;
    console.log(`WebDAVFS.onMoveEntryRequested: sourcePath=${sourcePath}, targetPath=${targetPath}`);

    const { client, metadataCache, filePathConverter } = this.#fileSystemMap[fileSystemId];
    await client.moveFile(filePathConverter(sourcePath), filePathConverter(targetPath));

    metadataCache.remove(sourcePath);
    metadataCache.remove(targetPath);
  }

  async onTruncateRequested(
    options: chrome.fileSystemProvider.TruncateRequestedOptions
  ) {
    const { filePath, length } = options;
    console.log(`WebDAVFS.onTruncateRequested: filePath=${filePath}, length=${length}`);
    // do nothing
  }

  async onAbortRequested(
    options: chrome.fileSystemProvider.AbortRequestedOptions
  ) {
    const { operationRequestId } = options;
    console.log(`WebDAVFS.onAbortRequested: operationRequestId=${operationRequestId}`)
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
      server, client, metadataCache, filePathConverter, uploadPathConverter,
    };
  };
}

async function storeMountedCredential(
  fileSystemId: string, credential: Credential
) {
  const { mountedCredentials = {} } =
    await browser.storage.local.get<MountedStorage>();
  mountedCredentials[fileSystemId] = credential;
  await browser.storage.local.set({ mountedCredentials });
}

async function removeMountedCredential(fileSystemId: string) {
  const { mountedCredentials } =
    await browser.storage.local.get<MountedStorage>();
  if (!mountedCredentials) return;
  delete mountedCredentials[fileSystemId];
  await browser.storage.local.set({ mountedCredentials });
}

async function getMountedCredentials(): Promise<Credential[]> {
  const { mountedCredentials } =
    await browser.storage.local.get<MountedStorage>();
  return Object.values(mountedCredentials || {});
}

function createFileSystemID(domain: string, username: string) {
  return `webdavfs://${domain}/${username}`;
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
