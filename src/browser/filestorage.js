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
 */
function MemoryFileStorage()
{
    /**
     * From sha256sum to file data.
     * @type {Map<string,Uint8Array>}
     */
    this.filedata = new Map();
}

/**
 * @param {string} sha256sum
 * @return {Uint8Array}
 */
MemoryFileStorage.prototype.get = async function(sha256sum) // jshint ignore:line
{
    dbg_assert(sha256sum, "MemoryFileStorage get: sha256sum should be a non-empty string");
    return this.filedata.get(sha256sum);
}; // jshint ignore:line

/**
 * @param {string} sha256sum
 * @param {!Uint8Array} data
 */
MemoryFileStorage.prototype.set = async function(sha256sum, buffer) // jshint ignore:line
{
    dbg_assert(sha256sum, "MemoryFileStorage set: sha256sum should be a non-empty string");
    this.filedata.set(sha256sum, buffer);
}; // jshint ignore:line

/**
 * @constructor
 * @implements {FileStorageInterface}
 */
function IndexedDBFileStorage()
{
    dbg_assert(typeof window !== "undefined" && window.indexedDB,
        "IndexedDBFileStorage - indexedDB not available.");
    this.db = null;
}

IndexedDBFileStorage.try_create = async function() // jshint ignore:line
{
    if(typeof window === "undefined" || !window.indexedDB)
    {
        throw new Error("IndexedDB is not available");
    }
    const file_storage = new IndexedDBFileStorage();
    await file_storage.init(); // jshint ignore:line
    return file_storage;
}; // jshint ignore:line

IndexedDBFileStorage.prototype.init = function()
{
    dbg_assert(!this.db, "IndexedDBFileStorage init: Database already intiialized");

    return new Promise((resolve, reject) =>
    {
        const open_request = indexedDB.open(INDEXEDDB_STORAGE_NAME, INDEXEDDB_STORAGE_VERSION);

        open_request.onblocked = event =>
        {
            dbg_log("IndexedDB blocked by an older database version being opened.", LOG_9P);
        };

        open_request.onerror = event =>
        {
            dbg_log("Error opening IndexedDB! Are you in private browsing mode? Error:", LOG_9P);
            dbg_log(open_request.error, LOG_9P);
            reject();
        };

        open_request.onupgradeneeded = event =>
        {
            const db = open_request.result;
            db.createObjectStore(INDEXEDDB_STORAGE_STORE, { keyPath: INDEXEDDB_STORAGE_KEYPATH });
        };

        open_request.onsuccess = event =>
        {
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
                // TODO: double check this message
                dbg_log("Warning: another v86 instance is trying to open IndexedDB database but " +
                    "is blocked by this current v86 instance.", LOG_9P);
            };
            resolve();
        };
    });
};

/**
 * @param {string} sha256sum
 * @return {!Promise<Uint8Array>}
 */
IndexedDBFileStorage.prototype.get = function(sha256sum)
{
    dbg_assert(this.db, "IndexedDBFileStorage get: Database is not initialized");
    dbg_assert(sha256sum, "IndexedDBFileStorage get: sha256sum should be a non-empty string");

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
                resolve(null);
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
    dbg_assert(this.db, "IndexedDBFileStorage set: Database is not initialized");
    dbg_assert(sha256sum, "IndexedDBFileStorage set: sha256sum should be a non-empty string");

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

/**
 * @constructor
 * @implements {FileStorageInterface}
 * @param {string} baseurl
 */
function ServerMemoryFileStorage(baseurl)
{
    dbg_assert(baseurl, "ServerMemoryFileStorage: baseurl should not be empty");

    this.empty_storage = new MemoryFileStorage();
    this.baseurl = baseurl;
}

/**
 * @private
 * @param {string} sha256sum
 * @return {!Promise<Uint8Array>}
 */
ServerMemoryFileStorage.prototype.load_from_server = function(sha256sum)
{
    return new Promise((resolve, reject) =>
    {
        v86util.load_file(this.baseurl + sha256sum, { done: buffer =>
        {
            const data = new Uint8Array(buffer);
            this.set(sha256sum, data).then(() => resolve(data));
        }});
    });
};

/**
 * @param {string} sha256sum
 * @return {Uint8Array}
 */
ServerMemoryFileStorage.prototype.get = async function(sha256sum) // jshint ignore:line
{
    const data = await this.empty_storage.get(sha256sum); // jshint ignore:line
    if(!data)
    {
        return await this.load_from_server(sha256sum); // jshint ignore:line
    }
    return data;
}; // jshint ignore:line

/**
 * @param {string} sha256sum
 * @param {!Uint8Array} data
 */
ServerMemoryFileStorage.prototype.set = async function(sha256sum, data) // jshint ignore:line
{
    await this.empty_storage.set(sha256sum, data); // jshint ignore:line
}; // jshint ignore:line

/**
 * @constructor
 * @implements {FileStorageInterface}
 * @param {string} baseurl
 */
function ServerIndexedDBFileStorage(baseurl)
{
    dbg_assert(baseurl, "ServerIndexedDBFileStorage: baseurl should not be empty");

    this.empty_storage = new IndexedDBFileStorage();
    this.baseurl = baseurl;
}

/**
 * @param {string} baseurl
 * @return {IndexedDBFileStorage}
 */
ServerIndexedDBFileStorage.try_create = async function(baseurl) // jshint ignore:line
{
    if(typeof window === "undefined" || !window.indexedDB)
    {
        throw new Error("IndexedDB is not available");
    }
    const file_storage = new ServerIndexedDBFileStorage(baseurl);
    await file_storage.empty_storage.init(); // jshint ignore:line
    return file_storage;
}; // jshint ignore:line

/**
 * @private
 * @param {string} sha256sum
 * @return {!Promise<Uint8Array>}
 */
ServerIndexedDBFileStorage.prototype.load_from_server = function(sha256sum)
{
    return new Promise((resolve, reject) =>
    {
        v86util.load_file(this.baseurl + sha256sum, { done: buffer =>
        {
            const data = new Uint8Array(buffer);
            this.set(sha256sum, data).then(() => resolve(data));
        }});
    });
};

/**
 * @param {string} sha256sum
 * @return {Uint8Array}
 */
ServerIndexedDBFileStorage.prototype.get = async function(sha256sum) // jshint ignore:line
{
    const data = await this.empty_storage.get(sha256sum); // jshint ignore:line
    if(!data)
    {
        return await this.load_from_server(sha256sum); // jshint ignore:line
    }
    return data;
}; // jshint ignore:line

/**
 * @param {string} sha256sum
 * @param {!Uint8Array} data
 */
ServerIndexedDBFileStorage.prototype.set = async function(sha256sum, data) // jshint ignore:line
{
    await this.empty_storage.set(sha256sum, data); // jshint ignore:line
}; // jshint ignore:line
