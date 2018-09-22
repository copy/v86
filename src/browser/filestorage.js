"use strict";


/** @interface */
function FileStorage() {}

/**
 * @param {string} sha256sum
 * @return {!Promise<Uint8Array>}
 */
FileStorage.prototype.get = function(sha256sum) {};

/**
 * @param {string} sha256sum
 * @param {!Uint8Array} data
 * @return {!Promise}
 */
FileStorage.prototype.set = function(sha256sum, buffer) {};

/**
 * @constructor
 * @implements {FileStorage}
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
