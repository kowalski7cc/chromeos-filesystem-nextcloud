export interface OfflineEntryMetadata {
  name: string
  isDirectory: boolean
  size?: number
  modificationTime?: Date
  mimeType?: string
}

export interface OfflineEntryRecord {
  key: string
  fileSystemId: string
  filePath: string
  pinRoot: string
  cachedAt: number
  incomplete?: boolean
  metadata: OfflineEntryMetadata
  content?: ArrayBuffer
}

export type OfflineEntryInput = Omit<OfflineEntryRecord, 'key' | 'fileSystemId' | 'pinRoot' | 'cachedAt'>

const DATABASE_NAME = 'nextcloud-offline-cache';
const STORE_NAME = 'entries';
let databasePromise: Promise<IDBDatabase> | undefined;
let lastCacheTimestamp = 0;

export async function getOfflineEntry(
  fileSystemId: string,
  filePath: string
): Promise<OfflineEntryRecord | undefined> {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, 'readonly');
  const complete = transactionComplete(transaction);
  const request = transaction.objectStore(STORE_NAME)
    .index('fileSystemPath').getAll([fileSystemId, filePath]);
  const records = await requestResult<OfflineEntryRecord[]>(request);
  await complete;
  return records.reduce<OfflineEntryRecord | undefined>((latest, record) =>
    !latest || record.cachedAt > latest.cachedAt ? record : latest, undefined);
}

export async function getOfflineEntries(
  fileSystemId: string
): Promise<OfflineEntryRecord[]> {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, 'readonly');
  const complete = transactionComplete(transaction);
  const request = transaction.objectStore(STORE_NAME).index('fileSystemId').getAll(fileSystemId);
  const records = await requestResult<OfflineEntryRecord[]>(request);
  await complete;
  return records;
}

export async function replaceOfflineEntries(
  fileSystemId: string,
  pinRoot: string,
  entries: OfflineEntryInput[]
): Promise<void> {
  if (!entries.some(entry => entry.filePath === pinRoot))
    throw new Error('Offline pin must include its root entry');
  if (entries.some(entry => !isSameOrDescendant(entry.filePath, pinRoot)))
    throw new Error('Offline entry is outside its pinned root');

  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, 'readwrite');
  const complete = transactionComplete(transaction);
  const store = transaction.objectStore(STORE_NAME);
  const request = store.index('fileSystemPinRoot').getAll([fileSystemId, pinRoot]);
  const cachedAt = lastCacheTimestamp = Math.max(Date.now(), lastCacheTimestamp + 1);
  request.onsuccess = () => {
    for (const existing of request.result as OfflineEntryRecord[]) {
      store.delete(existing.key);
    }
    for (const entry of entries) {
      store.put({
        ...entry,
        key: keyFor(fileSystemId, entry.filePath, pinRoot),
        fileSystemId,
        pinRoot,
        cachedAt,
        incomplete: false,
      } satisfies OfflineEntryRecord);
    }
  };
  request.onerror = () => transaction.abort();
  await complete;
}

export async function removeOfflineEntries(
  fileSystemId: string,
  entryPath: string
): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, 'readwrite');
  const complete = transactionComplete(transaction);
  const store = transaction.objectStore(STORE_NAME);
  const request = store.index('fileSystemId').getAll(fileSystemId);
  request.onsuccess = () => {
    for (const record of request.result as OfflineEntryRecord[]) {
      if (record.pinRoot === record.filePath &&
          isStrictDescendant(entryPath, record.pinRoot))
        store.put({ ...record, incomplete: true });
      if (isSameOrDescendant(record.filePath, entryPath))
        store.delete(record.key);
    }
  };
  request.onerror = () => transaction.abort();
  await complete;
}

export async function invalidateOfflineEntries(
  fileSystemId: string,
  changedPath: string
): Promise<void> {
  await removeMatchingEntries(fileSystemId, record =>
    pathsOverlap(record.pinRoot, changedPath)
  );
}

export async function clearOfflineEntries(fileSystemId: string): Promise<void> {
  await removeMatchingEntries(fileSystemId, () => true);
}

function removeMatchingEntries(
  fileSystemId: string,
  matches: (record: OfflineEntryRecord) => boolean
): Promise<void> {
  return openDatabase().then(database => new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    const complete = transactionComplete(transaction);
    const store = transaction.objectStore(STORE_NAME);
    const request = store.index('fileSystemId').getAll(fileSystemId);
    request.onsuccess = () => {
      for (const record of request.result as OfflineEntryRecord[]) {
        if (matches(record))
          store.delete(record.key);
      }
    };
    request.onerror = () => transaction.abort();
    complete.then(resolve, reject);
  }));
}

function openDatabase(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise;

  const pending = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        const store = request.result.createObjectStore(STORE_NAME, { keyPath: 'key' });
        store.createIndex('fileSystemId', 'fileSystemId');
        store.createIndex('fileSystemPath', ['fileSystemId', 'filePath']);
        store.createIndex('fileSystemPinRoot', ['fileSystemId', 'pinRoot']);
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => {
        database.close();
        databasePromise = undefined;
      };
      resolve(database);
    };
    request.onerror = () => {
      databasePromise = undefined;
      reject(request.error || new Error('Could not open offline file storage'));
    };
  });
  databasePromise = pending;
  return pending;
}

function keyFor(fileSystemId: string, filePath: string, pinRoot: string) {
  return JSON.stringify([fileSystemId, pinRoot, filePath]);
}

function isSameOrDescendant(filePath: string, parentPath: string) {
  if (parentPath === '/') return filePath.startsWith('/');
  return filePath === parentPath || filePath.startsWith(`${parentPath}/`);
}

function isStrictDescendant(filePath: string, parentPath: string) {
  return filePath !== parentPath && isSameOrDescendant(filePath, parentPath);
}

function pathsOverlap(firstPath: string, secondPath: string) {
  return isSameOrDescendant(firstPath, secondPath) ||
    isSameOrDescendant(secondPath, firstPath);
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed'));
    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted'));
  });
}