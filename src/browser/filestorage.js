"use strict";

const INDEXEDDB_STORAGE_VERSION = 1;
const INDEXEDDB_STORAGE_NAME = "IndexedDBFileStorage";
const INDEXEDDB_STORAGE_STORE = "Store";
const INDEXEDDB_STORAGE_KEYPATH = "sha256sum";
const INDEXEDDB_STORAGE_VALUEPATH = "data";

/** @interface */
function FileStorageInterface() {}

/**
 * @param {string} sha256sum
 * @return {!Promise<Uint8Array>}
 */
FileStorageInterface.prototype.get = function(sha256sum) {};

/**
 * @param {string} sha256sum
 * @param {!Uint8Array} data
 * @return {!Promise}
 */
FileStorageInterface.prototype.set = function(sha256sum, buffer) {};

/**
 * @constructor
 * @implements {FileStorageInterface}
 * @param {string=} baseurl
 */
function MemoryFileStorage(baseurl)
{
    this.baseurl = baseurl;

    /**
     * From sha256sum to file data.
     * @type {Map<string,Uint8Array>}
     */
    this.filedata = new Map();
}

/**
 * @private
 * @param {string} sha256sum
 * @return {!Promise<Uint8Array>}
 */
MemoryFileStorage.prototype.load_from_server = function(sha256sum)
{
    return new Promise((resolve, reject) =>
    {
        if(!this.baseurl)
        {
            resolve(null);
            return;
        }

        v86util.load_file(this.baseurl + sha256sum, { done: buffer =>
        {
            const data = new Uint8Array(buffer);
            this.filedata.set(sha256sum, data);
            resolve(data);
        }});
    });
};

/**
 * @param {string} sha256sum
 * @return {!Promise<Uint8Array>}
 */
MemoryFileStorage.prototype.get = function(sha256sum)
{
    dbg_assert(sha256sum !== "", "MemoryFileStorage get: sha256sum should not be an empty string");

    return new Promise((resolve, reject) =>
    {
        if(this.filedata.has(sha256sum))
        {
            resolve(this.filedata.get(sha256sum));
        }
        else
        {
            this.load_from_server(sha256sum).then(data => resolve(data));
        }
    });
};

/**
 * @param {string} sha256sum
 * @param {!Uint8Array} data
 * @return {!Promise}
 */
MemoryFileStorage.prototype.set = function(sha256sum, buffer)
{
    dbg_assert(sha256sum !== "", "MemoryFileStorage set: sha256sum should not be an empty string");

    return new Promise((resolve, reject) =>
    {
        this.filedata.set(sha256sum, buffer);
        resolve();
    });
};

/**
 * @constructor
 * @implements {FileStorageInterface}
 * @param {string=} baseurl
 */
function IndexedDBFileStorage(baseurl)
{
    this.fallback_storage = new MemoryFileStorage(baseurl);
    this.baseurl = baseurl;
    this.db = null;

    if(typeof indexedDB === "undefined")
    {
        dbg_log("IndexedDB not available. Using MemoryFileStorage as fallback.", LOG_9P);
    }
    else
    {
        const open_request = indexedDB.open(INDEXEDDB_STORAGE_NAME, INDEXEDDB_STORAGE_VERSION);

        open_request.onblocked = event =>
        {
            dbg_log("IndexedDB blocked by an older database version being opened.", LOG_9P);
            dbg_log("Using MemoryFileStorage until unblocked.", LOG_9P);
        };

        open_request.onerror = event =>
        {
            dbg_log("Error opening IndexedDB! Are you in private browsing mode? ", LOG_9P);
            dbg_log("Falling back to MemoryFileStorage. Error: " + open_request.error, LOG_9P);
        };

        open_request.onupgradeneeded = event =>
        {
            const db = open_request.result;
            db.createObjectStore(INDEXEDDB_STORAGE_STORE, { keyPath: INDEXEDDB_STORAGE_KEYPATH });
        };

        open_request.onsuccess = event =>
        {
            // Fallback no longer needed.
            this.fallback_storage = null;

            this.db = open_request.result;
            this.db.onabort = event =>
            {
                dbg_assert(false, "IndexedDBFileStorage: transaction aborted unexpectedly");
            };
            this.db.onclose = event =>
            {
                dbg_assert(false, "IndexedDBFileStorage: connection closed unexpectedly");
            };
            this.db.onerror = error =>
            {
                dbg_assert(false,  "IndexedDBFileStorage: unexpected error: " + error);
            };
            this.db.onversionchange = event =>
            {
                dbg_log("Warning: another v86 instance is trying to open IndexedDB database but " +
                    "is blocked by this current v86 instance.", LOG_9P);
            };
        };
    }
}

/**
 * @private
 * @param {string} sha256sum
 * @return {!Promise<Uint8Array>}
 */
IndexedDBFileStorage.prototype.load_from_server = function(sha256sum)
{
    dbg_assert(this.db, "IndexedDBFileStorage load_from_server called without opening database");

    return new Promise((resolve, reject) =>
    {
        if(!this.baseurl)
        {
            resolve(null);
            return;
        }
        v86util.load_file(this.baseurl + sha256sum, { done: buffer =>
        {
            const data = new Uint8Array(buffer);
            this.set(sha256sum, data).then(() => resolve(data));
        }});
    });
};

/**
 * @param {string} sha256sum
 * @return {!Promise<Uint8Array>}
 */
IndexedDBFileStorage.prototype.get = function(sha256sum)
{
    dbg_assert(sha256sum !== "", "IndexedDBFileStorage get: sha256sum should not be an empty string");

    if(!this.db)
    {
        return this.fallback_storage.get(sha256sum);
    }

    return new Promise((resolve, reject) =>
    {
        const transaction = this.db.transaction(INDEXEDDB_STORAGE_STORE, "readonly");
        const store = transaction.objectStore(INDEXEDDB_STORAGE_STORE);
        const request = store.get(sha256sum);
        request.onsuccess = event =>
        {
            dbg_assert(!request.result || request.result.data instanceof Uint8Array,
                "IndexedDBFileStorage get: invalid entry format: " + request.result);

            if(request.result && request.result.data instanceof Uint8Array)
            {
                resolve(request.result.data);
            }
            else
            {
                this.load_from_server(sha256sum).then(data => resolve(data));
            }
        };
    });
};

/**
 * @param {string} sha256sum
 * @param {!Uint8Array} data
 * @return {!Promise}
 */
IndexedDBFileStorage.prototype.set = function(sha256sum, data)
{
    dbg_assert(sha256sum !== "", "IndexedDBFileStorage set: sha256sum should not be an empty string");

    if(!this.db)
    {
        return this.fallback_storage.get(sha256sum);
    }

    return new Promise((resolve, reject) =>
    {
        const transaction = this.db.transaction(INDEXEDDB_STORAGE_STORE, "readwrite");
        const store = transaction.objectStore(INDEXEDDB_STORAGE_STORE);
        const request = store.put({
            [INDEXEDDB_STORAGE_KEYPATH]: sha256sum,
            [INDEXEDDB_STORAGE_VALUEPATH]: data,
        });
        request.onsuccess = event => resolve();
    });
};
