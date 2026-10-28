export const WEBDAV_READ_AHEAD_SIZE = 16 * 1024 * 1024;
const MAX_CACHED_BLOCKS = 4;
let nextCacheId = 0;
const cachedBlocks = new Map<string, ArrayBuffer>();

export interface WebDAVReadMetrics {
  requestCount: number
  prefetchRequests: number
  bytesFetched: number
  bytesReturned: number
  cacheHits: number
  networkTimeMs: number
}

export async function fetchWebDAVRange(
  url: string,
  authorization: string,
  offset: number,
  length: number,
  fetcher: typeof fetch = fetch
): Promise<ArrayBuffer> {
  const response = await fetcher(url, {
    headers: {
      Authorization: authorization,
      Range: `bytes=${offset}-${offset + length - 1}`,
    },
  });
  if (response.status !== 206)
    throw new Error(`WebDAV server did not honor byte range request (HTTP ${response.status})`);

  const contentRange = response.headers.get('Content-Range');
  const match = contentRange?.match(/^bytes (\d+)-(\d+)\/(?:\d+|\*)$/i);
  if (!match || Number(match[1]) !== offset)
    throw new Error(`WebDAV server returned an invalid Content-Range: ${contentRange}`);

  const data = await response.arrayBuffer();
  if (Number(match[2]) - offset + 1 !== data.byteLength)
    throw new Error('WebDAV range response length does not match Content-Range');
  return data;
}

export class WebDAVReadCache {
  #id = nextCacheId++;
  #active = true;
  #pending = new Map<number, Promise<ArrayBuffer>>();
  #lastReadEnd: number | undefined;
  #shortRangeSeen = false;
  #metrics: WebDAVReadMetrics = {
    requestCount: 0,
    prefetchRequests: 0,
    bytesFetched: 0,
    bytesReturned: 0,
    cacheHits: 0,
    networkTimeMs: 0,
  };

  async read(
    offset: number,
    length: number,
    fetchRange: (offset: number, length: number) => Promise<ArrayBuffer>
  ): Promise<ArrayBuffer> {
    if (!Number.isSafeInteger(offset) || offset < 0 ||
      !Number.isSafeInteger(length) || length < 0 ||
      !Number.isSafeInteger(offset + length))
      throw new Error('File read offset and length must be non-negative safe integers');

    if (length === 0) return new ArrayBuffer(0);

    let data: ArrayBuffer;
    let dataOffset: number;
    let sequential = false;
    if (length > WEBDAV_READ_AHEAD_SIZE) {
      dataOffset = offset;
      data = await this.#fetch(fetchRange, offset, length);
    } else {
      const firstBlockOffset =
        Math.floor(offset / WEBDAV_READ_AHEAD_SIZE) * WEBDAV_READ_AHEAD_SIZE;
      const lastBlockOffset =
        Math.floor((offset + length - 1) / WEBDAV_READ_AHEAD_SIZE) *
        WEBDAV_READ_AHEAD_SIZE;
      const blockOffsets: number[] = [];
      for (let blockOffset = firstBlockOffset;
        blockOffset <= lastBlockOffset;
        blockOffset += WEBDAV_READ_AHEAD_SIZE)
        blockOffsets.push(blockOffset);

      sequential = offset === this.#lastReadEnd;
      if (sequential && !this.#shortRangeSeen) {
        void this.#prefetchBlock(
          blockOffsets[blockOffsets.length - 1] + WEBDAV_READ_AHEAD_SIZE,
          fetchRange
        );
      }
      const blocks = await Promise.all(blockOffsets.map(blockOffset =>
        this.#getBlock(blockOffset, fetchRange)
      ));
      dataOffset = firstBlockOffset;
      const availableEnd = Math.max(...blocks.map((block, index) =>
        blockOffsets[index] + block.byteLength
      ));
      const outputLength = Math.max(0, Math.min(offset + length, availableEnd) - offset);
      const output = new Uint8Array(outputLength);
      blocks.forEach((block, index) => {
        const blockOffset = blockOffsets[index];
        const copyStart = Math.max(offset, blockOffset);
        const copyEnd = Math.min(offset + outputLength, blockOffset + block.byteLength);
        if (copyEnd > copyStart) {
          output.set(
            new Uint8Array(block, copyStart - blockOffset, copyEnd - copyStart),
            copyStart - offset
          );
        }
      });
      data = output.buffer;
      dataOffset = offset;
    }

    const availableLength = Math.max(0, Math.min(length, data.byteLength - (offset - dataOffset)));
    this.#metrics.bytesReturned += availableLength;
    this.#lastReadEnd = offset + availableLength;
    return data.slice(offset - dataOffset, offset - dataOffset + availableLength);
  }

  get metrics(): WebDAVReadMetrics {
    return { ...this.#metrics };
  }

  clear(): void {
    this.#active = false;
    const prefix = `${this.#id}:`;
    for (const key of cachedBlocks.keys()) {
      if (key.startsWith(prefix)) cachedBlocks.delete(key);
    }
    this.#pending.clear();
  }

  async #getBlock(
    offset: number,
    fetchRange: (offset: number, length: number) => Promise<ArrayBuffer>
  ): Promise<ArrayBuffer> {
    const key = `${this.#id}:${offset}`;
    const cached = cachedBlocks.get(key);
    if (cached) {
      cachedBlocks.delete(key);
      cachedBlocks.set(key, cached);
      this.#metrics.cacheHits++;
      return cached;
    }

    const pending = this.#pending.get(offset);
    if (pending) {
      this.#metrics.cacheHits++;
      return pending;
    }

    const request = this.#fetch(fetchRange, offset, WEBDAV_READ_AHEAD_SIZE)
      .then(data => {
        if (data.byteLength < WEBDAV_READ_AHEAD_SIZE)
          this.#shortRangeSeen = true;
        if (this.#active) {
          cachedBlocks.set(key, data);
          while (cachedBlocks.size > MAX_CACHED_BLOCKS) {
            const oldest = cachedBlocks.keys().next().value;
            if (oldest !== undefined) cachedBlocks.delete(oldest);
          }
        }
        return data;
      })
      .finally(() => this.#pending.delete(offset));
    this.#pending.set(offset, request);
    return request;
  }

  async #prefetchBlock(
    offset: number,
    fetchRange: (offset: number, length: number) => Promise<ArrayBuffer>
  ): Promise<void> {
    if (!this.#active || this.#shortRangeSeen) return;
    const key = `${this.#id}:${offset}`;
    if (cachedBlocks.has(key) || this.#pending.has(offset)) return;
    this.#metrics.prefetchRequests++;
    try {
      await this.#getBlock(offset, fetchRange);
    } catch (error) {
      console.warn('WebDAV range read-ahead failed; a later read will retry', error);
    }
  }

  async #fetch(
    fetchRange: (offset: number, length: number) => Promise<ArrayBuffer>,
    offset: number,
    length: number
  ): Promise<ArrayBuffer> {
    const startedAt = performance.now();
    this.#metrics.requestCount++;
    try {
      const data = await fetchRange(offset, length);
      this.#metrics.bytesFetched += data.byteLength;
      return data;
    } finally {
      this.#metrics.networkTimeMs += performance.now() - startedAt;
    }
  }
}
