export interface OpenedFileRecord {
  key: string
  openRequestId: number
  fileSystemId: string
  filePath: string
  mode: string
  uuid: string
  buffer: ArrayBuffer
  recoverable: boolean
  size?: number
  uploadChunkSize?: number
  writeCalls?: number
  writeBytes?: number
  chunkVersions?: Record<string, number>
  uploadedChunkVersions?: Record<string, number>
  nextChunkToUpload?: number
}

const DATABASE_NAME = 'nextcloud-filesystem';
const STORE_NAME = 'opened-files';
const BLOCK_STORE_NAME = 'opened-file-blocks';
export const OPENED_FILE_BLOCK_SIZE = 256 * 1024;
let databasePromise: Promise<IDBDatabase> | undefined;

interface OpenedFileBlock {
  key: string
  blockIndex: number
  data: ArrayBuffer
}

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
  const transaction = database.transaction(
    [STORE_NAME, BLOCK_STORE_NAME],
    'readwrite'
  );
  const complete = transactionComplete(transaction);
  transaction.objectStore(STORE_NAME).delete(keyFor(fileSystemId, openRequestId));
  const request = transaction.objectStore(BLOCK_STORE_NAME).getAllKeys(
    blockKeyRange(fileSystemId, openRequestId)
  );
  await new Promise<void>((resolve, reject) => {
    request.onsuccess = () => {
      for (const key of request.result)
        transaction.objectStore(BLOCK_STORE_NAME).delete(key);
      resolve();
    };
    request.onerror = () => reject(
      request.error || new Error('Could not find staged file blocks to remove')
    );
  });
  await complete;
}

export async function stageOpenedFileWrite(
  fileSystemId: string,
  openRequestId: number,
  offset: number,
  data: ArrayBuffer,
  uploadChunkSize?: number
): Promise<void> {
  if (!Number.isSafeInteger(offset) || offset < 0 ||
    !Number.isSafeInteger(offset + data.byteLength))
    throw new Error('File write offset and length must be non-negative safe integers');

  const database = await openDatabase();
  const transaction = database.transaction(
    [STORE_NAME, BLOCK_STORE_NAME],
    'readwrite'
  );
  const complete = transactionComplete(transaction);
  const files = transaction.objectStore(STORE_NAME);
  const blocks = transaction.objectStore(BLOCK_STORE_NAME);
  const recordRequest = files.get(keyFor(fileSystemId, openRequestId));
  const staged = new Promise<void>((resolve, reject) => {
    recordRequest.onsuccess = () => {
      const record = recordRequest.result as OpenedFileRecord | undefined;
      if (!record) {
        reject(new Error('Open file operation state is unavailable'));
        transaction.abort();
        return;
      }

      const writeEnd = offset + data.byteLength;
      if (uploadChunkSize && writeEnd > offset) {
        record.chunkVersions = record.chunkVersions || {};
        const firstChunk = Math.floor(offset / uploadChunkSize);
        const lastChunk = Math.floor((writeEnd - 1) / uploadChunkSize);
        for (let chunkIndex = firstChunk; chunkIndex <= lastChunk; chunkIndex++) {
          const key = String(chunkIndex);
          record.chunkVersions[key] = (record.chunkVersions[key] || 0) + 1;
        }
      }
      const firstBlock = Math.floor(offset / OPENED_FILE_BLOCK_SIZE);
      const lastBlock = Math.floor(
        Math.max(offset, writeEnd - 1) / OPENED_FILE_BLOCK_SIZE
      );
      let pending = writeEnd > offset ? lastBlock - firstBlock + 1 : 0;
      const source = new Uint8Array(data);

      for (let blockIndex = firstBlock; blockIndex <= lastBlock && pending > 0; blockIndex++) {
        const pageStart = blockIndex * OPENED_FILE_BLOCK_SIZE;
        const pageEnd = pageStart + OPENED_FILE_BLOCK_SIZE;
        const blockRequest = blocks.get(blockKey(fileSystemId, openRequestId, blockIndex));
        blockRequest.onsuccess = () => {
          try {
            const legacyBuffer = new Uint8Array(record.buffer);
            const legacyEnd = Math.min(pageEnd, legacyBuffer.byteLength);
            const existing = blockRequest.result as OpenedFileBlock | undefined;
            const overlapStart = Math.max(offset, pageStart);
            const overlapEnd = Math.min(writeEnd, pageEnd);
            const pageLength = Math.max(
              Math.max(0, legacyEnd - pageStart),
              existing?.data.byteLength || 0,
              overlapEnd - pageStart
            );
            const page = new Uint8Array(pageLength);

            if (legacyEnd > pageStart)
              page.set(legacyBuffer.subarray(pageStart, legacyEnd), 0);
            if (existing)
              page.set(new Uint8Array(existing.data).subarray(0, page.byteLength));

            if (overlapEnd > overlapStart) {
              page.set(
                source.subarray(overlapStart - offset, overlapEnd - offset),
                overlapStart - pageStart
              );
            }

            blocks.put({
              key: blockKey(fileSystemId, openRequestId, blockIndex),
              blockIndex,
              data: page.buffer,
            } satisfies OpenedFileBlock);
            pending--;
            if (pending === 0) resolve();
          } catch (error) {
            reject(error);
            transaction.abort();
          }
        };
        blockRequest.onerror = () => reject(
          blockRequest.error || new Error('Could not read staged file block')
        );
      }

      record.size = Math.max(
        openedFileSize(record),
        writeEnd
      );
      record.writeCalls = (record.writeCalls || 0) + 1;
      record.writeBytes = (record.writeBytes || 0) + data.byteLength;
      files.put(record);
      if (pending === 0) resolve();
    };
    recordRequest.onerror = () => reject(
      recordRequest.error || new Error('Could not read open file operation state')
    );
  });

  try {
    await staged;
    await complete;
  } catch (error) {
    await complete.catch(() => {});
    throw error;
  }
}

export async function markOpenedFileChunkUploaded(
  fileSystemId: string,
  openRequestId: number,
  chunkIndex: number,
  version: number
): Promise<void> {
  await updateOpenedFile(fileSystemId, openRequestId, record => {
    record.uploadedChunkVersions = record.uploadedChunkVersions || {};
    const key = String(chunkIndex);
    record.uploadedChunkVersions[key] = Math.max(
      record.uploadedChunkVersions[key] || 0,
      version
    );
    record.nextChunkToUpload = Math.max(
      record.nextChunkToUpload || 0,
      chunkIndex + 1
    );
    return record;
  });
}

export function openedFileSize(record: OpenedFileRecord): number {
  return Math.max(record.size || 0, record.buffer.byteLength);
}

export async function readOpenedFileRange(
  record: OpenedFileRecord,
  offset: number,
  length: number
): Promise<ArrayBuffer> {
  if (!Number.isSafeInteger(offset) || offset < 0 ||
    !Number.isSafeInteger(length) || length < 0 ||
    !Number.isSafeInteger(offset + length))
    throw new Error('File read offset and length must be non-negative safe integers');

  const output = new Uint8Array(length);
  const legacy = new Uint8Array(record.buffer);
  const legacyEnd = Math.min(offset + length, legacy.byteLength);
  if (legacyEnd > offset)
    output.set(legacy.subarray(offset, legacyEnd), 0);

  if (length === 0) return output.buffer;

  const firstBlock = Math.floor(offset / OPENED_FILE_BLOCK_SIZE);
  const lastBlock = Math.floor((offset + length - 1) / OPENED_FILE_BLOCK_SIZE);
  const database = await openDatabase();
  const transaction = database.transaction(BLOCK_STORE_NAME, 'readonly');
  const complete = transactionComplete(transaction);
  const request = transaction.objectStore(BLOCK_STORE_NAME).getAll(
    IDBKeyRange.bound(
      blockKey(record.fileSystemId, record.openRequestId, firstBlock),
      blockKey(record.fileSystemId, record.openRequestId, lastBlock)
    )
  );
  const blocks = await requestResult<OpenedFileBlock[]>(request);
  await complete;

  for (const block of blocks) {
    const blockStart = block.blockIndex * OPENED_FILE_BLOCK_SIZE;
    const overlapStart = Math.max(offset, blockStart);
    const overlapEnd = Math.min(
      offset + length,
      blockStart + OPENED_FILE_BLOCK_SIZE
    );
    if (overlapEnd > overlapStart) {
      output.set(
        new Uint8Array(block.data).subarray(
          overlapStart - blockStart,
          overlapEnd - blockStart
        ),
        overlapStart - offset
      );
    }
  }

  return output.buffer;
}

function openDatabase(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise;

  const pending = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 2);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME))
        request.result.createObjectStore(STORE_NAME, { keyPath: 'key' });
      if (!request.result.objectStoreNames.contains(BLOCK_STORE_NAME))
        request.result.createObjectStore(BLOCK_STORE_NAME, { keyPath: 'key' });
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

function blockKey(
  fileSystemId: string,
  openRequestId: number,
  blockIndex: number
) {
  return `${keyFor(fileSystemId, openRequestId)}:block:${String(blockIndex).padStart(12, '0')}`;
}

function blockKeyRange(fileSystemId: string, openRequestId: number) {
  const prefix = `${keyFor(fileSystemId, openRequestId)}:block:`;
  return IDBKeyRange.bound(`${prefix}000000000000`, `${prefix}\uffff`);
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