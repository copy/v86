// Lossless, paged command history. The budget limits the compressed RAM cache,
// not the amount of graphics work that can be included in a save state.
(function(global) {
    "use strict";
    const MAGIC = 0x32534756;
    const HEADER = 32, ENTRY = 32, PAGE_HEADER = 16;
    const PAGE_BYTES = 4 * 1024 * 1024;
    const MAX_PAGE_BYTES = 32 * 1024 * 1024;
    let serial = 0;
    const scriptURL = typeof document !== "undefined" && document.currentScript && document.currentScript.src;

    class PageCompressor {
        constructor(enabled) { this.enabled = enabled; }
        initialize() {
            if (this.ready) return this.ready;
            this.ready = new Promise(resolve => {
                if (!this.enabled || !scriptURL || typeof global.Worker !== "function") { resolve(); return; }
                try {
                    const url = new URL("graphics_journal_worker.js", scriptURL);
                    if (global.V86GL_BUILD_REVISION) url.searchParams.set("v", global.V86GL_BUILD_REVISION);
                    const worker = this.worker = new global.Worker(url);
                    worker.onmessage = event => {
                        if (event.data.ready) resolve();
                        else if (this.pending) {
                            const pending = this.pending;
                            this.pending = null;
                            pending.resolve(event.data);
                        }
                    };
                    worker.onerror = event => {
                        event.preventDefault();
                        const error = new Error("Graphics journal compression worker failed: " + event.message);
                        if (this.pending) { this.pending.reject(error); this.pending = null; }
                        worker.terminate();
                        this.worker = null;
                        resolve(); // Startup failure can still use the local fallback.
                    };
                } catch (_) { resolve(); }
            });
            return this.ready;
        }
        async compress(buffer, length, measure = false) {
            await this.initialize();
            if (this.worker) {
                const result = await new Promise((resolve, reject) => {
                    this.pending = { resolve, reject };
                    try { this.worker.postMessage({ buffer: buffer.buffer, length, measure }, [buffer.buffer]); }
                    catch (error) { this.pending = null; reject(error); }
                });
                return { data: new Uint8Array(result.buffer, 0, result.length), codec: result.codec,
                    compression_backend: "worker", compression_ms: result.compression_ms };
            }
            const start = measure ? global.performance.now() : 0;
            const raw = buffer.subarray(0, length);
            if (typeof global.CompressionStream === "function") {
                const blob = new Blob([raw]);
                const compressed = await new Response(blob.stream().pipeThrough(new global.CompressionStream("gzip"))).arrayBuffer();
                if (compressed.byteLength < length) return { data: new Uint8Array(compressed), codec: 1,
                    compression_backend: "local-stream", compression_ms: measure ? global.performance.now() - start : null };
            }
            return { data: length === buffer.length ? raw : raw.slice(), codec: 0,
                compression_backend: "local-raw", compression_ms: measure ? global.performance.now() - start : null };
        }
        destroy() { if (this.worker) this.worker.terminate(); this.worker = null; }
    }

    class PageStore {
        constructor() {
            this.prefix = Date.now() + "-" + (++serial) + "-" + Math.random() + ":";
            this.keys = [];
            this.database = null;
        }
        open() {
            if (!this.database) this.database = new Promise((resolve, reject) => {
                const request = global.indexedDB.open("v86-graphics-journal", 1);
                request.onupgradeneeded = () => request.result.createObjectStore("pages");
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            });
            return this.database;
        }
        async transaction(mode, action) {
            const db = await this.open();
            return new Promise((resolve, reject) => {
                const transaction = db.transaction("pages", mode);
                const request = action(transaction.objectStore("pages"));
                transaction.oncomplete = () => resolve(request && request.result);
                transaction.onabort = transaction.onerror = () => reject(transaction.error || new Error("Graphics journal cache failed"));
            });
        }
        async put(data) {
            const key = this.prefix + this.keys.length;
            await this.transaction("readwrite", store => store.put(data, key));
            this.keys.push(key);
            return key;
        }
        async get(key) {
            const data = await this.transaction("readonly", store => store.get(key));
            if (!(data instanceof Uint8Array)) throw new Error("Graphics journal cache page is missing");
            return data;
        }
        async destroy() {
            if (!this.database) return;
            try {
                await this.transaction("readwrite", store => {
                    for (const key of this.keys) store.delete(key);
                });
            } finally {
                (await this.database).close();
            }
        }
    }

    async function collect(stream, expected) {
        const reader = stream.getReader(), parts = [];
        let size = 0;
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                size += value.byteLength;
                if (size > expected) throw new Error("Graphics journal decompression exceeds page size");
                parts.push(value);
            }
        } catch (error) {
            await reader.cancel().catch(() => {});
            throw error;
        } finally { reader.releaseLock(); }
        const result = new Uint8Array(size);
        let offset = 0;
        for (const part of parts) { result.set(part, offset); offset += part.byteLength; }
        return result;
    }

    class GraphicsJournal {
        constructor(options = {}) {
            this["performanceTimingVersion"] = 1;
            this.budget = options.budget ?? 64 * 1024 * 1024;
            this.pageBytes = options.pageBytes || PAGE_BYTES;
            this.store = options.store === undefined ?
                (global.indexedDB ? new PageStore() : null) : options.store;
            this.compressor = new PageCompressor(options.worker !== false);
            this.buffer = null;
            this.view = null;
            this.partBytes = this.partCount = this.rawBytes = this.count = this.residentBytes = 0;
            this.pendingBytes = 0;
            this.pages = [];
            this.trimCursor = 0;
            this.work = Promise.resolve();
            this.error = null;
            this.cacheError = null;
        }
        append(record, bytes = record.bytes) {
            if (this.destroyed) throw new Error("Graphics journal has been destroyed");
            const ownerToken = record.ownerToken === undefined ? 0 : record.ownerToken;
            if (!Number.isInteger(ownerToken) || ownerToken < 0 || ownerToken > 0xffffffff || record.barrier && ownerToken)
                throw new Error("Invalid graphics owner token");
            const size = ENTRY + bytes.length;
            if (size > MAX_PAGE_BYTES)
                throw new Error("Graphics batch exceeds the supported page size");
            if (this.partBytes && this.partBytes + size > this.buffer.length) this.seal();
            if (!this.buffer) {
                this.buffer = new Uint8Array(Math.max(this.pageBytes, size));
                this.view = new DataView(this.buffer.buffer);
            }
            // One owned copy into a contiguous page: no per-batch header,
            // payload allocation, temporary word array, or Blob fragment.
            const offset = this.partBytes, view = this.view;
            view.setUint32(offset, bytes.length, true);
            view.setUint32(offset + 4, record.flags >>> 0, true);
            view.setUint32(offset + 8, record.frameId >>> 0, true);
            view.setUint32(offset + 12, record.submitCount >>> 0, true);
            view.setUint32(offset + 16, record.commandCount >>> 0, true);
            view.setUint32(offset + 20, record.responseBase >>> 0, true);
            view.setUint32(offset + 24, record.barrier ? 1 : 0, true);
            view.setUint32(offset + 28, ownerToken, true);
            this.buffer.set(bytes, offset + ENTRY);
            this.partBytes += size;
            this.rawBytes += size;
            this.partCount++;
            this.count++;
            if (this.partBytes >= this.pageBytes) this.seal();
        }
        seal() {
            if (!this.partCount) return;
            const buffer = this.buffer, rawBytes = this.partBytes, count = this.partCount;
            const allocatedBytes = buffer.byteLength;
            this.pendingBytes += allocatedBytes;
            const timing = this["performanceTiming"]?.["page"](rawBytes);
            this.buffer = this.view = null;
            this.partBytes = this.partCount = 0;
            this.work = this.work.then(async () => {
                if (timing) timing["start"]();
                let result;
                try { result = await this.compressor.compress(buffer, rawBytes, !!timing); }
                catch (error) { if (timing) timing["finish"](null); throw error; }
                if (timing) timing["finish"](result);
                const { data, codec } = result;
                const page = { data, bytes: data.length, rawBytes, count, codec };
                this.pages.push(page);
                this.residentBytes += page.bytes;
                await this.trim();
            }).catch(error => { this.error = error; })
                .finally(() => { this.pendingBytes -= allocatedBytes; });
        }
        waitForSpace() {
            // The compressed cache budget alone does not bound raw pages
            // queued behind a slower compressor. Hold the transport ACK at
            // this watermark; preserve every accepted record in order.
            if (this.pendingBytes < Math.max(this.pageBytes, this.budget) && !this.error) return null;
            return this.work.then(() => { if (this.error) throw this.error; });
        }
        async trim() {
            if (!this.store || this.cacheError) return;
            while (this.trimCursor < this.pages.length && this.residentBytes > this.budget) {
                const page = this.pages[this.trimCursor];
                try {
                    page.key = await this.store.put(page.data);
                    page.data = null;
                    this.residentBytes -= page.bytes;
                    ++this.trimCursor;
                } catch (error) {
                    // Quota/private-mode failures must not discard commands.
                    // Keep this and subsequent compressed pages in RAM.
                    this.cacheError = error;
                    console.warn("[v86gl] journal disk cache unavailable; retaining compressed history in memory", error);
                    break;
                }
            }
        }
        async data(page) { return page.data || this.store.get(page.key); }
        async snapshot(legacy = new Uint8Array(0)) {
            this.seal();
            await this.work;
            if (this.error) throw this.error;
            const size = HEADER + legacy.length + this.pages.reduce((n, page) => n + PAGE_HEADER + page.bytes, 0);
            if (size > 0x7fffffff) throw new Error("Compressed graphics state exceeds the emulator's 2 GiB state format");
            const bytes = new Uint8Array(size), view = new DataView(bytes.buffer);
            view.setUint32(0, MAGIC, true); view.setUint16(4, 4, true);
            view.setUint16(6, HEADER, true); view.setUint32(8, size, true);
            view.setUint32(12, legacy.length, true); view.setUint32(16, this.pages.length, true);
            bytes.set(legacy, HEADER);
            let offset = HEADER + legacy.length;
            for (const page of this.pages) {
                [page.bytes, page.rawBytes, page.count, page.codec].forEach((word, i) => view.setUint32(offset + i * 4, word, true));
                const data = await this.data(page);
                if (data.length !== page.bytes) throw new Error("Graphics journal cache page has the wrong size");
                bytes.set(data, offset + PAGE_HEADER);
                offset += PAGE_HEADER + page.bytes;
            }
            return bytes;
        }
        static parse(bytes) {
            const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            if (bytes.length < HEADER || view.getUint32(0, true) !== MAGIC ||
                    (view.getUint16(4, true) !== 3 && view.getUint16(4, true) !== 4) ||
                    view.getUint16(6, true) !== HEADER || view.getUint32(8, true) !== bytes.length)
                throw new Error("Invalid compressed graphics checkpoint header");
            const legacyBytes = view.getUint32(12, true);
            if (legacyBytes > bytes.length - HEADER) throw new Error("Invalid legacy checkpoint size");
            const legacy = bytes.slice(HEADER, HEADER + legacyBytes), pages = [];
            let offset = HEADER + legacyBytes;
            for (let i = 0, count = view.getUint32(16, true); i < count; ++i) {
                if (offset + PAGE_HEADER > bytes.length) throw new Error("Invalid graphics page header");
                const size = view.getUint32(offset, true), rawBytes = view.getUint32(offset + 4, true);
                const entries = view.getUint32(offset + 8, true), codec = view.getUint32(offset + 12, true);
                if (size > bytes.length - offset - PAGE_HEADER || !rawBytes || rawBytes > MAX_PAGE_BYTES ||
                        !entries || entries > rawBytes / ENTRY || codec > 1 || (codec === 0 && size !== rawBytes))
                    throw new Error("Invalid graphics checkpoint page");
                pages.push({ data: bytes.subarray(offset + PAGE_HEADER, offset + PAGE_HEADER + size), rawBytes, count: entries, codec });
                offset += PAGE_HEADER + size;
            }
            if (offset !== bytes.length) throw new Error("Invalid graphics checkpoint trailing data");
            return { version: view.getUint16(4, true), legacy, pages };
        }
        static async *records(parsed) {
            for (const page of parsed.pages) {
                let bytes = page.data;
                if (page.codec === 1) {
                    if (typeof global.DecompressionStream !== "function") throw new Error("This browser cannot decompress graphics checkpoints");
                    bytes = await collect(new Blob([bytes]).stream().pipeThrough(new global.DecompressionStream("gzip")), page.rawBytes);
                }
                if (bytes.length !== page.rawBytes) throw new Error("Graphics journal decompressed size mismatch");
                const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
                let offset = 0;
                for (let i = 0; i < page.count; ++i) {
                    if (offset + ENTRY > bytes.length) throw new Error("Invalid graphics batch header");
                    const size = view.getUint32(offset, true), kind = view.getUint32(offset + 24, true);
                    const ownerToken = view.getUint32(offset + 28, true);
                    if (size > bytes.length - offset - ENTRY || kind > 1 || (kind === 1 && size) ||
                            ownerToken && (parsed.version < 4 || kind === 1))
                        throw new Error("Invalid graphics batch");
                    yield { ...(ownerToken ? { ownerToken } : {}), flags: view.getUint32(offset + 4, true), frameId: view.getUint32(offset + 8, true),
                        submitCount: view.getUint32(offset + 12, true), commandCount: view.getUint32(offset + 16, true),
                        responseBase: view.getUint32(offset + 20, true), barrier: kind === 1,
                        bytes: bytes.subarray(offset + ENTRY, offset + ENTRY + size) };
                    offset += ENTRY + size;
                }
                if (offset !== bytes.length) throw new Error("Invalid graphics batch count");
            }
        }
        async destroy() {
            this.destroyed = true;
            await this.work;
            this.compressor.destroy();
            if (this.store) await this.store.destroy().catch(error => console.warn("[v86gl] journal cache cleanup failed", error));
            this.buffer = this.view = null;
            this.pages = [];
            this.residentBytes = 0;
        }
    }
    global.V86GraphicsJournal = GraphicsJournal;
    if (typeof module !== "undefined" && module.exports) module.exports = { GraphicsJournal };
})(typeof globalThis !== "undefined" ? globalThis : this);
