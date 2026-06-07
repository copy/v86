import { dbg_assert } from "../log.js";
import { load_file } from "../lib.js";

/** @interface */
export function FileStorageInterface() {}

/**
 * Read a portion of a file.
 * @param {string} sha256sum
 * @param {number} offset
 * @param {number} count
 * @param {number} file_size
 * @return {!Promise<Uint8Array>} null if file does not exist.
 */
FileStorageInterface.prototype.read = function(sha256sum, offset, count, file_size) {};

/**
 * Add a read-only file to the filestorage.
 * @param {string} sha256sum
 * @param {!Uint8Array} data
 * @return {!Promise}
 */
FileStorageInterface.prototype.cache = function(sha256sum, data) {};

/**
 * Call this when the file won't be used soon, e.g. when a file closes or when this immutable
 * version is already out of date. It is used to help prevent accumulation of unused files in
 * memory in the long run for some FileStorage mediums.
 */
FileStorageInterface.prototype.uncache = function(sha256sum) {};

/**
 * @constructor
 * @implements {FileStorageInterface}
 */
export function MemoryFileStorage()
{
    /**
     * From sha256sum to file data.
     * @type {Map<string,Uint8Array>}
     */
    this.filedata = new Map();
}

/**
 * @param {string} sha256sum
 * @param {number} offset
 * @param {number} count
 * @return {!Promise<Uint8Array>} null if file does not exist.
 */
MemoryFileStorage.prototype.read = async function(sha256sum, offset, count)
{
    dbg_assert(sha256sum, "MemoryFileStorage read: sha256sum should be a non-empty string");
    const data = this.filedata.get(sha256sum);

    if(!data)
    {
        return null;
    }

    return data.subarray(offset, offset + count);
};

/**
 * @param {string} sha256sum
 * @param {!Uint8Array} data
 */
MemoryFileStorage.prototype.cache = async function(sha256sum, data)
{
    dbg_assert(sha256sum, "MemoryFileStorage cache: sha256sum should be a non-empty string");
    this.filedata.set(sha256sum, data);
};

/**
 * @param {string} sha256sum
 */
MemoryFileStorage.prototype.uncache = function(sha256sum)
{
    this.filedata.delete(sha256sum);
};

/**
 * @constructor
 * @implements {FileStorageInterface}
 * @param {FileStorageInterface} file_storage
 * @param {string} baseurl
 * @param {function(number,Uint8Array):ArrayBuffer} zstd_decompress
 */
export function ServerFileStorageWrapper(file_storage, baseurl, zstd_decompress)
{
    dbg_assert(baseurl, "ServerMemoryFileStorage: baseurl should not be empty");

    if(!baseurl.endsWith("/"))
    {
        baseurl += "/";
    }

    this.storage = file_storage;
    this.baseurl = baseurl;
    this.zstd_decompress = zstd_decompress;
}

/**
 * @param {string} sha256sum
 * @param {number} file_size
 * @return {!Promise<Uint8Array>}
 */
ServerFileStorageWrapper.prototype.load_from_server = function(sha256sum, file_size)
{
    return new Promise((resolve, reject) =>
    {
        load_file(this.baseurl + sha256sum, { done: async buffer =>
        {
            let data = new Uint8Array(buffer);
            if(sha256sum.endsWith(".zst"))
            {
                data = new Uint8Array(
                    this.zstd_decompress(file_size, data)
                );
            }
            await this.cache(sha256sum, data);
            resolve(data);
        }});
    });
};

/**
 * @param {string} sha256sum
 * @param {number} offset
 * @param {number} count
 * @param {number} file_size
 * @return {!Promise<Uint8Array>}
 */
ServerFileStorageWrapper.prototype.read = async function(sha256sum, offset, count, file_size)
{
    const data = await this.storage.read(sha256sum, offset, count, file_size);
    if(!data)
    {
        const full_file = await this.load_from_server(sha256sum, file_size);
        return full_file.subarray(offset, offset + count);
    }
    return data;
};

/**
 * @param {string} sha256sum
 * @param {!Uint8Array} data
 */
ServerFileStorageWrapper.prototype.cache = async function(sha256sum, data)
{
    return await this.storage.cache(sha256sum, data);
};

/**
 * @param {string} sha256sum
 */
ServerFileStorageWrapper.prototype.uncache = function(sha256sum)
{
    this.storage.uncache(sha256sum);
};
