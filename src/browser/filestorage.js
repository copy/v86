"use strict";

const INDEXEDDB_STORAGE_VERSION = 1;
const INDEXEDDB_STORAGE_NAME = "v86-filesystem-storage";
const INDEXEDDB_STORAGE_STORE = "store";
const INDEXEDDB_STORAGE_KEY_PATH = "sha256sum";
const INDEXEDDB_STORAGE_DATA_PATH = "data";
const INDEXEDDB_STORAGE_EXTRABLOCKCOUNT_PATH = "extra-block-count";
const INDEXEDDB_STORAGE_BLOCKSIZE_PATH = "block-size";
const INDEXEDDB_STORAGE_TOTALSIZE_PATH = "total-size";
const INDEXEDDB_STORAGE_GET_BLOCK_KEY = (sha256sum, block_number) => `${sha256sum}-${block_number}`;
const INDEXEDDB_STORAGE_CHUNKING_THRESHOLD = 4096;
const INDEXEDDB_STORAGE_BLOCKSIZE = 4096;

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
    this.initializing = false;
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
    dbg_assert(!this.initializing, "IndexedDBFileStorage init: Database already intiializing");
    this.initializing = true;

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
            this.initializing = false;
            reject();
        };

        open_request.onupgradeneeded = event =>
        {
            const db = open_request.result;
            db.createObjectStore(INDEXEDDB_STORAGE_STORE, { keyPath: INDEXEDDB_STORAGE_KEY_PATH });
        };

        open_request.onsuccess = event =>
        {
            this.initializing = false;
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
 * @param {string} key
 * @return {!Promise<Object>}
 */
IndexedDBFileStorage.prototype.db_get = function(key)
{
    return new Promise((resolve, reject) =>
    {
        const transaction = this.db.transaction(INDEXEDDB_STORAGE_STORE, "readonly");
        const store = transaction.objectStore(INDEXEDDB_STORAGE_STORE);
        const request = store.get(key);
        request.onsuccess = event => resolve(request.result);
    });
};

/**
 * @param {Object} value
 * @return {!Promise}
 */
IndexedDBFileStorage.prototype.db_set = function(value)
{
    return new Promise((resolve, reject) =>
    {
        const transaction = this.db.transaction(INDEXEDDB_STORAGE_STORE, "readwrite");
        const store = transaction.objectStore(INDEXEDDB_STORAGE_STORE);
        const request = store.put(value);
        request.onsuccess = event => resolve();
    });
};

/**
 * TODO: Convert this into a single atomic transaction.
 * @param {string} sha256sum
 * @return {!Uint8Array}
 */
IndexedDBFileStorage.prototype.get = async function(sha256sum) // jshint ignore:line
{
    dbg_assert(this.db, "IndexedDBFileStorage get: Database is not initialized");
    dbg_assert(sha256sum, "IndexedDBFileStorage get: sha256sum should be a non-empty string");

    const entry = await this.db_get(sha256sum); // jshint ignore:line

    if(!entry)
    {
        return null;
    }

    const base_data = entry[INDEXEDDB_STORAGE_DATA_PATH];
    const extra_block_count = entry[INDEXEDDB_STORAGE_EXTRABLOCKCOUNT_PATH];
    const block_size = entry[INDEXEDDB_STORAGE_BLOCKSIZE_PATH];
    const total_size = entry[INDEXEDDB_STORAGE_TOTALSIZE_PATH];

    dbg_assert(base_data instanceof Uint8Array,
        `IndexedDBFileStorage get: Invalid base entry without the data Uint8Array field: ${base_data}`);
    dbg_assert(Number.isInteger(extra_block_count),
        `IndexedDBFileStorage get: Invalid base entry with non-integer block_count: ${extra_block_count}`);
    dbg_assert(Number.isInteger(block_size),
        `IndexedDBFileStorage get: Invalid base entry with non-integer block_size: ${block_size}`);
    dbg_assert(Number.isInteger(total_size) && total_size >= base_data.length,
        `IndexedDBFileStorage get: Invalid base entry with invalid total_size: ${total_size}`);

    const file_data = new Uint8Array(total_size);
    file_data.set(base_data);

    for(let i = 0, offset = base_data.length; i < extra_block_count; i++, offset += block_size)
    {
        const block_key = INDEXEDDB_STORAGE_GET_BLOCK_KEY(sha256sum, i);
        const block_entry = await this.db_get(block_key); // jshint ignore:line

        dbg_assert(block_entry, `IndexedDBFileStorage get: Missing entry for block-${i}`);

        const block_data = block_entry[INDEXEDDB_STORAGE_DATA_PATH];
        dbg_assert(block_data instanceof Uint8Array,
            `IndexedDBFileStorage get: Entry for block-${i} without Uint8Array data field: ${block_data}`);

        file_data.set(block_data, offset);
    }

    return file_data;
}; // jshint ignore:line

/**
 * XXX: When shrinking a large file, the old blocks aren't deleted. This is ok for now with the
 * current scheme of keeping IndexedDB contents read-only.
 * @param {string} sha256sum
 * @param {!Uint8Array} data
 */
IndexedDBFileStorage.prototype.set = async function(sha256sum, data) // jshint ignore:line
{
    dbg_assert(this.db, "IndexedDBFileStorage set: Database is not initialized");
    dbg_assert(sha256sum, "IndexedDBFileStorage set: sha256sum should be a non-empty string");

    const extra_block_count = Math.ceil(
        (data.length - INDEXEDDB_STORAGE_CHUNKING_THRESHOLD) /
        INDEXEDDB_STORAGE_BLOCKSIZE
    );

    await this.db_set({ // jshint ignore:line
        [INDEXEDDB_STORAGE_KEY_PATH]: sha256sum,
        [INDEXEDDB_STORAGE_DATA_PATH]: data.subarray(0, INDEXEDDB_STORAGE_CHUNKING_THRESHOLD),
        [INDEXEDDB_STORAGE_BLOCKSIZE_PATH]: INDEXEDDB_STORAGE_BLOCKSIZE,
        [INDEXEDDB_STORAGE_TOTALSIZE_PATH]: data.length,
        [INDEXEDDB_STORAGE_EXTRABLOCKCOUNT_PATH]: extra_block_count,
    });

    let offset = INDEXEDDB_STORAGE_CHUNKING_THRESHOLD;
    for(let i = 0; offset < data.length; i++, offset += INDEXEDDB_STORAGE_BLOCKSIZE)
    {
        const block_key = INDEXEDDB_STORAGE_GET_BLOCK_KEY(sha256sum, i);
        const block_data = data.subarray(offset, offset + INDEXEDDB_STORAGE_BLOCKSIZE);
        await this.db_set({ //jshint ignore:line
            [INDEXEDDB_STORAGE_KEY_PATH]: block_key,
            [INDEXEDDB_STORAGE_DATA_PATH]: block_data,
        });
    }
}; // jshint ignore:line

/**
 * @constructor
 * @implements {FileStorageInterface}
 * @param {FileStorageInterface} file_storage
 * @param {string} baseurl
 */
function ServerFileStorageWrapper(file_storage, baseurl)
{
    dbg_assert(baseurl, "ServerMemoryFileStorage: baseurl should not be empty");

    this.storage = file_storage;
    this.baseurl = baseurl;
}

/**
 * @private
 * @param {string} sha256sum
 * @return {!Promise<Uint8Array>}
 */
ServerFileStorageWrapper.prototype.load_from_server = function(sha256sum)
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
ServerFileStorageWrapper.prototype.get = async function(sha256sum) // jshint ignore:line
{
    const data = await this.storage.get(sha256sum); // jshint ignore:line
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
ServerFileStorageWrapper.prototype.set = async function(sha256sum, data) // jshint ignore:line
{
    await this.storage.set(sha256sum, data); // jshint ignore:line
}; // jshint ignore:line
