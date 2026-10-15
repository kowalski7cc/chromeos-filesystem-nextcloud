export interface OpenedFileRecord {
  key: string
  openRequestId: number
  fileSystemId: string
  filePath: string
  mode: string
  uuid: string
  buffer: ArrayBuffer
  recoverable: boolean
}

const DATABASE_NAME = 'nextcloud-filesystem';
const STORE_NAME = 'opened-files';
let databasePromise: Promise<IDBDatabase> | undefined;

export async function getOpenedFile(
  fileSystemId: string,
  openRequestId: number
): Promise<OpenedFileRecord | undefined> {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, 'readonly');
  const complete = transactionComplete(transaction);
  const request = transaction.objectStore(STORE_NAME).get(keyFor(fileSystemId, openRequestId));
  const record = await requestResult<OpenedFileRecord | undefined>(request);
  await complete;
  return record;
}

export async function getOpenedFiles(): Promise<OpenedFileRecord[]> {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, 'readonly');
  const complete = transactionComplete(transaction);
  const request = transaction.objectStore(STORE_NAME).getAll();
  const records = await requestResult<OpenedFileRecord[]>(request);
  await complete;
  return records;
}

export async function putOpenedFile(record: OpenedFileRecord): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, 'readwrite');
  const complete = transactionComplete(transaction);
  const request = transaction.objectStore(STORE_NAME).put(record);
  await requestResult(request);
  await complete;
}

export async function updateOpenedFile(
  fileSystemId: string,
  openRequestId: number,
  update: (record: OpenedFileRecord) => OpenedFileRecord
): Promise<OpenedFileRecord> {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, 'readwrite');
  const complete = transactionComplete(transaction);
  const store = transaction.objectStore(STORE_NAME);
  const request = store.get(keyFor(fileSystemId, openRequestId));
  const updatedPromise = new Promise<OpenedFileRecord | undefined>((resolve, reject) => {
    request.onsuccess = () => {
      const record = request.result as OpenedFileRecord | undefined;
      if (!record) {
        resolve(undefined);
        return;
      }
      try {
        const updated = update(record);
        store.put(updated);
        resolve(updated);
      } catch (error) {
        reject(error);
        transaction.abort();
      }
    };
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
  });

  let updated: OpenedFileRecord | undefined;
  try {
    updated = await updatedPromise;
    await complete;
  } catch (error) {
    await complete.catch(() => {});
    throw error;
  }
  if (!updated) throw new Error('Open file operation state is unavailable');
  return updated;
}

export async function removeOpenedFile(
  fileSystemId: string,
  openRequestId: number
): Promise<void> {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, 'readwrite');
  const complete = transactionComplete(transaction);
  const request = transaction.objectStore(STORE_NAME).delete(keyFor(fileSystemId, openRequestId));
  await requestResult(request);
  await complete;
}

function openDatabase(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise;

  const pending = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME))
        request.result.createObjectStore(STORE_NAME, { keyPath: 'key' });
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
      reject(request.error || new Error('Could not open file operation storage'));
    };
  });
  databasePromise = pending;
  return pending;
}

export function openedFileKey(fileSystemId: string, openRequestId: number) {
  return `${fileSystemId}:${openRequestId}`;
}

function keyFor(fileSystemId: string, openRequestId: number) {
  return openedFileKey(fileSystemId, openRequestId);
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