// The bytes of a disk image file (docs/disk-image-formats-plan.md P0): read
// at any offset and length, the reads cancellable, with an explicit error
// instead of a callback that never comes. The format readers
// (src/image/*.js) sit on top; the device sees a DiskImage
// (src/image/disk_image.js).
//
// A source: byteLength (once opened), name (for messages), sync (reads call
// back before read() returns), open(callback(error)), read(offset, length,
// callback(data, error), signal). `data` has exactly `length` bytes and
// may be a view of the source's own memory: readers copy from it and do not
// write to it. After `signal` aborts, the callback does not run.

import { dbg_assert, dbg_log } from "../log.js";
import { LOG_DISK } from "../const.js";
import { response_header } from "../lib.js";

// How long one HTTP request may take, and how often one that failed for a
// reason that may pass (network, timeout, 5xx) is tried again
const REQUEST_TIMEOUT = 30000;
const RETRY_DELAYS = [1000, 2000, 4000];

// The read cache of sources that are slow to read (URLs, split files)
export const DEFAULT_WINDOW_SIZE = 64 * 1024;
export const DEFAULT_CACHE_SIZE = 32 * 1024 * 1024;

/**
 * An error of a disk image: its source, its format or a feature the reader
 * does not support. `kind` is "io", "corrupt", "unsupported", "changed" or
 * "config".
 */
export class DiskImageError extends Error
{
    /**
     * @param {string} message
     * @param {string=} kind
     */
    constructor(message, kind)
    {
        super(message);
        this.name = "DiskImageError";
        /** @type {string} */
        this.kind = kind || "io";
    }
}

// lib.js reads `url` with fs in Node (a local path) and with XHR in browsers
const IN_NODE = typeof XMLHttpRequest === "undefined" ||
    typeof process !== "undefined" && !!process.versions && !!process.versions.node;

/* global require */
let node_fs;
async function get_node_fs()
{
    if(!node_fs)
    {
        // (as in lib.js: require in Electron renderers, the string split
        // for the Closure Compiler)
        node_fs = typeof require !== "undefined" ? require("fs")["promises"] : await import("node:" + "fs/promises");
    }
    return node_fs;
}

/**
 * Check a read against a source's length
 * @param {{byteLength: number, name: string}} source
 * @param {number} offset
 * @param {number} length
 */
function check_range(source, offset, length)
{
    if(!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 ||
        offset + length > source.byteLength)
    {
        throw new DiskImageError(source.name + ": read of " + length + " bytes at " + offset +
            " outside of the file (" + source.byteLength + " bytes)", "corrupt");
    }
}

/**
 * The bytes in memory (an ArrayBuffer, or a whole file downloaded)
 * @constructor
 * @param {!Uint8Array} bytes
 * @param {string} name
 */
export function MemorySource(bytes, name)
{
    this.bytes = bytes;
    this.byteLength = bytes.length;
    this.name = name;
    this.sync = true;
    this.stats = { requests: 0, bytes: 0 };
}

/** @param {function((Error|undefined))} callback */
MemorySource.prototype.open = function(callback)
{
    callback(undefined);
};

/**
 * @param {number} offset
 * @param {number} length
 * @param {function((!Uint8Array|undefined), (Error|undefined)=)} callback
 * @param {AbortSignal=} signal
 */
MemorySource.prototype.read = function(offset, length, callback, signal)
{
    check_range(this, offset, length);
    this.stats.requests++;
    this.stats.bytes += length;
    callback(this.bytes.subarray(offset, offset + length));
};

/**
 * A File or Blob: read synchronously in a worker (FileReaderSync, as
 * AsyncFileBuffer), asynchronously otherwise
 * @constructor
 * @param {!Blob} blob
 * @param {string} name
 */
export function BlobSource(blob, name)
{
    this.blob = blob;
    this.byteLength = blob.size;
    this.name = name;
    this.sync = typeof FileReaderSync !== "undefined";
    this.stats = { requests: 0, bytes: 0 };
}

BlobSource.prototype.open = MemorySource.prototype.open;

/**
 * @param {number} offset
 * @param {number} length
 * @param {function((!Uint8Array|undefined), (Error|undefined)=)} callback
 * @param {AbortSignal=} signal
 */
BlobSource.prototype.read = function(offset, length, callback, signal)
{
    check_range(this, offset, length);
    this.stats.requests++;
    this.stats.bytes += length;
    const slice = this.blob.slice(offset, offset + length);
    const fail = error => new DiskImageError(this.name + ": reading " + length + " bytes at " + offset + " failed: " +
        (error && error.message || error), "io");
    if(this.sync)
    {
        let data;
        try
        {
            data = new Uint8Array(new FileReaderSync().readAsArrayBuffer(slice));
        }
        catch(error)
        {
            callback(undefined, fail(error));
            return;
        }
        callback(data.length === length ? data : undefined,
            data.length === length ? undefined : fail("short read"));
        return;
    }
    const reader = new FileReader();
    const abort = () => reader.abort();
    signal && signal.addEventListener("abort", abort, { once: true });
    reader.onload = () =>
    {
        signal && signal.removeEventListener("abort", abort);
        if(signal && signal.aborted) return;
        const data = new Uint8Array(/** @type {!ArrayBuffer} */ (reader.result));
        if(data.length !== length) callback(undefined, fail("short read"));
        else callback(data);
    };
    reader.onerror = () =>
    {
        signal && signal.removeEventListener("abort", abort);
        if(signal && signal.aborted) return;
        callback(undefined, fail(reader.error));
    };
    reader.readAsArrayBuffer(slice);
};

/**
 * One ranged read through XMLHttpRequest. `info` has the response's status
 * and the headers the source checks.
 * @param {string} url
 * @param {number} start
 * @param {number|undefined} length undefined: the whole file
 * @param {function((!Uint8Array|undefined), (Object|undefined), (Error|undefined)=)} callback
 * @param {AbortSignal=} signal
 */
export function xhr_transport(url, start, length, callback, signal)
{
    const http = new XMLHttpRequest();
    let finished = false;
    const finish = (data, info, error) =>
    {
        if(finished) return;
        finished = true;
        signal && signal.removeEventListener("abort", abort);
        if(signal && signal.aborted) return;
        callback(data, info, error);
    };
    const abort = () =>
    {
        finished = true;
        http.abort();
    };
    if(signal)
    {
        if(signal.aborted) return;
        signal.addEventListener("abort", abort, { once: true });
    }
    http.open("GET", url, true);
    http.responseType = "arraybuffer";
    http.timeout = REQUEST_TIMEOUT;
    if(length !== undefined)
    {
        http.setRequestHeader("Range", "bytes=" + start + "-" + (start + length - 1));
    }
    // (the same request headers as load_file's ranged reads)
    http.setRequestHeader("X-Accept-Encoding", "identity");
    const info = () => ({
        status: http.status,
        content_range: http.getResponseHeader("Content-Range"),
        content_encoding: http.getResponseHeader("Content-Encoding"),
        etag: response_header(http, "ETag"),
        last_modified: response_header(http, "Last-Modified"),
        total: undefined,
        version: undefined,
    });
    http.onreadystatechange = () =>
    {
        // the whole file in response to a range: stop it before it downloads
        if(length !== undefined && http.readyState === 2 && http.status === 200)
        {
            const result = info();
            http.abort();
            finish(undefined, result, new DiskImageError(url + ": the server sent the whole file in response to a " +
                "Range request: it must support Range requests (HTTP 206)", "io"));
        }
    };
    http.onload = () => finish(new Uint8Array(/** @type {!ArrayBuffer} */ (http.response || new ArrayBuffer(0))), info(), undefined);
    http.onerror = () => finish(undefined, undefined, new DiskImageError(url + ": network error", "io"));
    http.ontimeout = () => finish(undefined, undefined, new DiskImageError(url + ": no response in " +
        REQUEST_TIMEOUT / 1000 + " seconds", "io"));
    http.send(null);
}

/**
 * One read of a local file in Node: `info` has the file's size and version
 * (inode, size and modification time)
 * @param {string} path
 * @param {number} start
 * @param {number|undefined} length
 * @param {function((!Uint8Array|undefined), (Object|undefined), (Error|undefined)=)} callback
 * @param {AbortSignal=} signal
 */
export function node_file_transport(path, start, length, callback, signal)
{
    (async () =>
    {
        const fs = await get_node_fs();
        const file = await fs["open"](path, "r");
        try
        {
            const stat = await file["stat"]();
            const size = stat["size"];
            if(length === undefined) length = Math.max(0, size - start);
            const data = new Uint8Array(length);
            let done = 0;
            while(done < length)
            {
                const result = await file["read"](data, done, length - done, start + done);
                if(!result["bytesRead"]) break;
                done += result["bytesRead"];
            }
            const info = {
                status: done === length ? 206 : 0,
                total: size,
                version: stat["ino"] + ":" + stat["size"] + ":" + stat["mtimeMs"],
                content_range: null, content_encoding: null, etag: null, last_modified: null,
            };
            return { data: done === length ? data : data.subarray(0, done), info };
        }
        finally
        {
            await file["close"]();
        }
    })().then(({ data, info }) =>
    {
        if(signal && signal.aborted) return;
        callback(data, info);
    }, error =>
    {
        if(signal && signal.aborted) return;
        callback(undefined, undefined, new DiskImageError(path + ": " + (error && error.message || error), "io"));
    });
}

/**
 * A file at a URL, read in ranges (HTTP Range requests in browsers, a local
 * path in Node, as load_file). Every response is checked: status 206, the
 * Content-Range asked for and the file's length, the length of the data,
 * and the file's version (ETag, Last-Modified; inode and modification time
 * in Node), which must not change during the session: a source that changes
 * fails every read from then on rather than mix data of two versions.
 * @constructor
 * @param {string} url
 * @param {number|undefined} size the file's length, if known
 * @param {string} name
 * @param {!Function=} transport
 * @param {!Array<number>=} retry_delays (tests)
 */
export function URLSource(url, size, name, transport, retry_delays)
{
    this.url = url;
    this.byteLength = size === undefined ? -1 : size;
    this.given_size = size;
    this.name = name;
    this.sync = false;
    this.transport = transport || (IN_NODE ? node_file_transport : xhr_transport);
    this.node = !transport && IN_NODE;
    this.retry_delays = retry_delays || RETRY_DELAYS;
    /** @type {?Object} the version of the first response */
    this.version = null;
    /** @type {Error|undefined} set when the source changed: every read fails */
    this.failed = undefined;
    this.stats = { requests: 0, bytes: 0, retries: 0 };
}

/** @param {function((Error|undefined))} callback */
URLSource.prototype.open = function(callback)
{
    if(this.given_size !== undefined && !this.node)
    {
        // (the first read checks the length the server reports)
        if(!Number.isSafeInteger(this.given_size) || this.given_size < 0)
        {
            callback(new DiskImageError(this.name + ": invalid size " + this.given_size, "config"));
            return;
        }
        callback(undefined);
        return;
    }
    // the length from a read of the first byte (Content-Range: bytes 0-0/<length>)
    this.request(0, 1, true, (data, error) => callback(error), undefined, 0);
};

/**
 * @param {number} offset
 * @param {number} length
 * @param {function((!Uint8Array|undefined), (Error|undefined)=)} callback
 * @param {AbortSignal=} signal
 */
URLSource.prototype.read = function(offset, length, callback, signal)
{
    check_range(this, offset, length);
    if(length === 0)
    {
        callback(new Uint8Array(0));
        return;
    }
    this.request(offset, length, false, callback, signal, 0);
};

/**
 * @param {number} offset
 * @param {number} length
 * @param {boolean} opening
 * @param {function((!Uint8Array|undefined), (Error|undefined)=)} callback
 * @param {AbortSignal|undefined} signal
 * @param {number} attempt
 */
URLSource.prototype.request = function(offset, length, opening, callback, signal, attempt)
{
    if(this.failed)
    {
        callback(undefined, this.failed);
        return;
    }
    this.stats.requests++;
    this.transport(this.url, offset, length, (data, info, error) =>
    {
        if(this.failed)
        {
            callback(undefined, this.failed);
            return;
        }
        if(!error)
        {
            error = this.check_response(offset, length, opening, data, info);
        }
        if(error)
        {
            const retry = error.kind === "io" && attempt < this.retry_delays.length &&
                (!info || info.status >= 500 && info.status < 600) && !this.node;
            if(retry)
            {
                this.stats.retries++;
                dbg_log(this.name + ": " + error.message + ", trying again", LOG_DISK);
                setTimeout(() =>
                {
                    if(signal && signal.aborted) return;
                    this.request(offset, length, opening, callback, signal, attempt + 1);
                }, this.retry_delays[attempt]);
                return;
            }
            if(error.kind === "changed") this.failed = error;
            callback(undefined, error);
            return;
        }
        this.stats.bytes += length;
        callback(data);
    }, signal);
};

/**
 * @param {number} offset
 * @param {number} length
 * @param {boolean} opening
 * @param {!Uint8Array|undefined} data
 * @param {!Object} info
 * @return {Error|undefined}
 */
URLSource.prototype.check_response = function(offset, length, opening, data, info)
{
    const where = this.name + ": the response to a read of " + length + " bytes at " + offset;
    if(this.node)
    {
        if(opening)
        {
            this.byteLength = info.total;
            this.version = info.version;
            if(this.given_size !== undefined && this.given_size !== info.total)
            {
                return new DiskImageError(this.name + ": the file has " + info.total + " bytes, its size is given as " +
                    this.given_size, "config");
            }
            return undefined;
        }
        if(info.version !== this.version)
        {
            return new DiskImageError(this.name + ": the file changed during the session", "changed");
        }
        if(!data || data.length !== length)
        {
            return new DiskImageError(where + " is short (" + (data ? data.length : 0) + " bytes): the file was truncated?", "io");
        }
        return undefined;
    }

    if(info.status !== 206)
    {
        return new DiskImageError(where + " has status " + info.status + " (expected 206)", "io");
    }
    if(info.content_encoding && info.content_encoding !== "identity")
    {
        return new DiskImageError(where + " has Content-Encoding " + info.content_encoding, "io");
    }
    const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec((info.content_range || "").trim());
    if(!range)
    {
        return new DiskImageError(where + " has the Content-Range \"" + info.content_range + "\"", "io");
    }
    const first = +range[1], last = +range[2], total = +range[3];
    if(first !== offset || last !== offset + length - 1)
    {
        return new DiskImageError(where + " is for bytes " + first + "-" + last, "io");
    }
    if(!data || data.length !== length)
    {
        return new DiskImageError(where + " has " + (data ? data.length : 0) + " bytes", "io");
    }
    if(opening || this.version === null)
    {
        if(this.given_size !== undefined && total !== this.given_size)
        {
            return new DiskImageError(this.name + ": the server reports " + total + " bytes, the size is given as " +
                this.given_size, "config");
        }
        this.byteLength = total;
        this.version = { etag: info.etag, last_modified: info.last_modified };
        return undefined;
    }
    if(total !== this.byteLength ||
        this.version.etag && info.etag !== this.version.etag ||
        this.version.last_modified && info.last_modified !== this.version.last_modified)
    {
        return new DiskImageError(this.name + ": the file changed on the server during the session (" +
            (total !== this.byteLength ? "length " + this.byteLength + " -> " + total :
            "ETag/Last-Modified " + JSON.stringify(this.version) + " -> " + JSON.stringify([info.etag, info.last_modified])) +
            "): no more reads from it", "changed");
    }
    return undefined;
};

/**
 * A file split in parts of `chunk_size` bytes (use_parts with
 * fixed_chunk_size, as AsyncXHRPartfileBuffer), each part optionally
 * compressed with Zstandard (".zst")
 * @constructor
 * @param {string} url
 * @param {number} size
 * @param {number} chunk_size
 * @param {boolean} alt_format the parts are numbered (filename-%08d.ext)
 * @param {function(number, !Uint8Array):!Promise<!ArrayBuffer>|undefined} zstd_decompress
 * @param {string} name
 * @param {!Function=} transport
 */
export function PartsSource(url, size, chunk_size, alt_format, zstd_decompress, name, transport)
{
    const parts = url.match(/\.[^\.]+(\.zst)?$/);
    this.extension = parts ? parts[0] : "";
    this.basename = url.substring(0, url.length - this.extension.length);
    if(!this.basename.endsWith("/")) this.basename += "-";
    this.is_zstd = this.extension.endsWith(".zst");
    this.byteLength = size;
    this.chunk_size = chunk_size;
    this.alt_format = alt_format;
    this.zstd_decompress = zstd_decompress;
    this.name = name;
    this.sync = false;
    this.transport = transport || (IN_NODE ? node_file_transport : xhr_transport);
    this.node = !transport && IN_NODE;
    this.stats = { requests: 0, bytes: 0, retries: 0 };
}

/** @param {function((Error|undefined))} callback */
PartsSource.prototype.open = function(callback)
{
    if(!Number.isSafeInteger(this.byteLength) || this.byteLength < 0 ||
        !Number.isSafeInteger(this.chunk_size) || this.chunk_size <= 0 || this.chunk_size % 512)
    {
        callback(new DiskImageError(this.name + ": use_parts needs size and a fixed_chunk_size that is a multiple of 512", "config"));
        return;
    }
    if(this.is_zstd && !this.zstd_decompress)
    {
        callback(new DiskImageError(this.name + ": no Zstandard decompressor for the parts", "config"));
        return;
    }
    callback(undefined);
};

/**
 * @param {number} index
 * @return {string}
 */
PartsSource.prototype.part_url = function(index)
{
    const start = index * this.chunk_size;
    return this.alt_format ?
        this.basename + String(index).padStart(8, "0") + this.extension :
        this.basename + start + "-" + (start + this.chunk_size) + this.extension;
};

/**
 * @param {number} offset
 * @param {number} length
 * @param {function((!Uint8Array|undefined), (Error|undefined)=)} callback
 * @param {AbortSignal=} signal
 */
PartsSource.prototype.read = function(offset, length, callback, signal)
{
    check_range(this, offset, length);
    if(length === 0)
    {
        callback(new Uint8Array(0));
        return;
    }
    const first = Math.floor(offset / this.chunk_size);
    const last = Math.floor((offset + length - 1) / this.chunk_size);
    const result = new Uint8Array(length);
    let pending = last - first + 1;
    let failed = false;
    for(let index = first; index <= last; index++)
    {
        this.read_part(index, (data, error) =>
        {
            if(failed) return;
            if(error)
            {
                failed = true;
                callback(undefined, error);
                return;
            }
            const part_start = index * this.chunk_size;
            const from = Math.max(offset, part_start), to = Math.min(offset + length, part_start + data.length);
            result.set(data.subarray(from - part_start, to - part_start), from - offset);
            if(--pending === 0) callback(result);
        }, signal, 0);
    }
};

/**
 * @param {number} index
 * @param {function((!Uint8Array|undefined), (Error|undefined)=)} callback
 * @param {AbortSignal|undefined} signal
 * @param {number} attempt
 */
PartsSource.prototype.read_part = function(index, callback, signal, attempt)
{
    const url = this.part_url(index);
    const expected = Math.min(this.chunk_size, this.byteLength - index * this.chunk_size);
    this.stats.requests++;
    this.transport(url, 0, undefined, (data, info, error) =>
    {
        if(!error && !this.node && info.status !== 200)
        {
            error = new DiskImageError(this.name + ": " + url + " has status " + info.status, "io");
        }
        if(error)
        {
            if(attempt < RETRY_DELAYS.length && (!info || info.status >= 500) && !this.node)
            {
                this.stats.retries++;
                setTimeout(() =>
                {
                    if(signal && signal.aborted) return;
                    this.read_part(index, callback, signal, attempt + 1);
                }, RETRY_DELAYS[attempt]);
                return;
            }
            callback(undefined, error);
            return;
        }
        const check = bytes =>
        {
            if(signal && signal.aborted) return;
            // (a last part may be the whole chunk size, padded)
            if(bytes.length !== expected && !(bytes.length === this.chunk_size && expected < this.chunk_size))
            {
                callback(undefined, new DiskImageError(this.name + ": " + url + " has " + bytes.length +
                    " bytes, expected " + expected, "io"));
                return;
            }
            this.stats.bytes += bytes.length;
            callback(bytes.subarray(0, expected));
        };
        if(this.is_zstd)
        {
            this.zstd_decompress(this.chunk_size, data).then(result => check(new Uint8Array(result)), error =>
            {
                if(signal && signal.aborted) return;
                callback(undefined, new DiskImageError(this.name + ": " + url + ": " + error.message, "corrupt"));
            });
        }
        else
        {
            check(/** @type {!Uint8Array} */ (data));
        }
    }, signal);
};

/**
 * A read cache over a slow source: the file in aligned windows, the ones
 * read last kept up to a budget. Reads of windows already on their way wait
 * for them; adjacent missing windows are read with one request. A read
 * cancelled by its caller ends the requests no other read waits for.
 * @constructor
 * @param {?} inner a source
 * @param {number=} window_size
 * @param {number=} budget
 */
export function CachedSource(inner, window_size, budget)
{
    this.inner = inner;
    this.name = inner.name;
    this.byteLength = inner.byteLength;
    this.sync = inner.sync;
    this.window_size = window_size || DEFAULT_WINDOW_SIZE;
    this.max_windows = Math.max(4, Math.floor((budget || DEFAULT_CACHE_SIZE) / this.window_size));
    /** @type {!Map<number, !Uint8Array>} window number -> data, the most recently used last */
    this.windows = new Map();
    /** @type {!Map<number, !Object>} window number -> the request reading it */
    this.in_flight = new Map();
    this.stats = { hits: 0, misses: 0 };
}

/** @param {function((Error|undefined))} callback */
CachedSource.prototype.open = function(callback)
{
    this.inner.open(error =>
    {
        this.byteLength = this.inner.byteLength;
        callback(error);
    });
};

/**
 * @param {number} offset
 * @param {number} length
 * @param {function((!Uint8Array|undefined), (Error|undefined)=)} callback
 * @param {AbortSignal=} signal
 */
CachedSource.prototype.read = function(offset, length, callback, signal)
{
    check_range(this, offset, length);
    if(length === 0)
    {
        callback(new Uint8Array(0));
        return;
    }
    if(signal && signal.aborted) return;
    const size = this.window_size;
    const first = Math.floor(offset / size), last = Math.floor((offset + length - 1) / size);
    // (the windows a read waits for are kept with it: others may evict them
    // from the cache meanwhile)
    const waiter = { first, last, offset, length, callback, signal, on_abort: null,
        /** @type {!Map<number, !Uint8Array>} */ parts: new Map(),
        remaining: 0, done: false, /** @type {!Set<!Object>} */ requests: new Set() };

    const new_indices = [];
    for(let index = first; index <= last; index++)
    {
        const cached = this.windows.get(index);
        if(cached)
        {
            // the most recently used last
            this.windows.delete(index);
            this.windows.set(index, cached);
            waiter.parts.set(index, cached);
            continue;
        }
        waiter.remaining++;
        const request = this.in_flight.get(index);
        if(request)
        {
            request.waiters.add(waiter);
            waiter.requests.add(request);
        }
        else
        {
            new_indices.push(index);
        }
    }
    if(waiter.remaining) this.stats.misses++;
    else this.stats.hits++;
    if(waiter.remaining === 0)
    {
        this.deliver(waiter);
        return;
    }

    // one request for each run of adjacent missing windows
    const started = [];
    for(let i = 0; i < new_indices.length;)
    {
        let j = i + 1;
        while(j < new_indices.length && new_indices[j] === new_indices[j - 1] + 1) j++;
        const request = { indices: new_indices.slice(i, j), waiters: new Set([waiter]),
            controller: new AbortController(), finished: false };
        for(const index of request.indices) this.in_flight.set(index, request);
        waiter.requests.add(request);
        started.push(request);
        i = j;
    }
    if(signal)
    {
        waiter.on_abort = () => this.cancel(waiter);
        signal.addEventListener("abort", waiter.on_abort, { once: true });
    }
    for(const request of started)
    {
        if(request.finished) continue;
        const start = request.indices[0] * size;
        const end = Math.min(this.byteLength, (request.indices[request.indices.length - 1] + 1) * size);
        this.inner.read(start, end - start, (data, error) => this.complete(request, data, error), request.controller.signal);
    }
};

/**
 * A read stops waiting: its callback does not run, and the requests only it
 * waited for are ended
 * @param {!Object} waiter
 */
CachedSource.prototype.cancel = function(waiter)
{
    if(waiter.done) return;
    this.end(waiter);
    for(const request of waiter.requests)
    {
        if(!request.finished && request.waiters.size === 0)
        {
            request.finished = true;
            request.controller.abort();
            for(const index of request.indices)
            {
                if(this.in_flight.get(index) === request) this.in_flight.delete(index);
            }
        }
    }
};

/** @param {!Object} waiter */
CachedSource.prototype.end = function(waiter)
{
    waiter.done = true;
    if(waiter.signal && waiter.on_abort) waiter.signal.removeEventListener("abort", waiter.on_abort);
    for(const request of waiter.requests) request.waiters.delete(waiter);
};

/** @param {!Object} waiter */
CachedSource.prototype.deliver = function(waiter)
{
    this.end(waiter);
    const size = this.window_size;
    if(waiter.first === waiter.last)
    {
        const start = waiter.offset - waiter.first * size;
        waiter.callback(waiter.parts.get(waiter.first).subarray(start, start + waiter.length));
        return;
    }
    const result = new Uint8Array(waiter.length);
    for(let index = waiter.first; index <= waiter.last; index++)
    {
        const data = waiter.parts.get(index);
        const window_start = index * size;
        const from = Math.max(waiter.offset, window_start);
        const to = Math.min(waiter.offset + waiter.length, window_start + data.length);
        result.set(data.subarray(from - window_start, to - window_start), from - waiter.offset);
    }
    waiter.callback(result);
};

/**
 * @param {!Object} request
 * @param {!Uint8Array|undefined} data
 * @param {Error|undefined} error
 */
CachedSource.prototype.complete = function(request, data, error)
{
    if(request.finished) return;
    request.finished = true;
    for(const index of request.indices)
    {
        if(this.in_flight.get(index) === request) this.in_flight.delete(index);
    }
    const size = this.window_size;
    /** @type {!Map<number, !Uint8Array>} */
    const arrived = new Map();
    if(!error)
    {
        const start = request.indices[0] * size;
        for(const index of request.indices)
        {
            const from = index * size - start;
            // (a copy: the inner source's view may be of memory it reuses)
            const window = data.slice(from, Math.min(data.length, from + size));
            arrived.set(index, window);
            this.windows.set(index, window);
        }
        while(this.windows.size > this.max_windows)
        {
            this.windows.delete(this.windows.keys().next().value);
        }
    }
    for(const waiter of Array.from(request.waiters))
    {
        if(waiter.done) continue;
        if(error)
        {
            this.end(waiter);
            waiter.callback(undefined, error);
            continue;
        }
        for(const [index, window] of arrived)
        {
            if(index >= waiter.first && index <= waiter.last && !waiter.parts.has(index))
            {
                waiter.parts.set(index, window);
                waiter.remaining--;
            }
        }
        dbg_assert(waiter.remaining >= 0);
        if(waiter.remaining === 0) this.deliver(waiter);
    }
};
