// The TPM 2.0 behind the TPM device (docs/tpm.md): libtpms with OpenSSL's
// cryptography, built for WebAssembly (tools/libtpms/build.sh:
// bios/libtpms.wasm, its interface tools/libtpms/v86_tpm.c). A command in, a
// response out, synchronously; the TPM's permanent state comes in at power-on
// and goes out at every store; its volatile state on request, for snapshots.
// Entropy is the host's (crypto.getRandomValues, never Math.random).

/** The largest command or response: the CRB's data buffer (4 KiB less the registers before it) */
export const TPM_BUFFER_SIZE = 0xF80;

/** The state blobs libtpms stores: permanent, volatile, save state (TPM2_Shutdown(STATE)) */
export const BLOB_PERMANENT = 0;
export const BLOB_VOLATILE = 1;
export const BLOB_SAVE_STATE = 2;

const ERRNO_NOSYS = 52;
const ERRNO_BADF = 8;

/**
 * Compile the module (asynchronously: browsers refuse large modules
 * compiled synchronously on the page's thread)
 * @param {!ArrayBuffer|!Uint8Array} bytes
 * @return {!Promise<!WebAssembly.Module>}
 */
export function compile_libtpms(bytes)
{
    return WebAssembly.compile(bytes);
}

/**
 * A TPM: an instance of the module
 * @param {!WebAssembly.Module} module
 * @param {function(number, ?Uint8Array)} on_store the TPM stored a blob (BLOB_*; null: deleted)
 * @return {!Promise<!Libtpms>}
 */
export async function create_libtpms(module, on_store)
{
    const tpm = new Libtpms(on_store);
    const instance = await WebAssembly.instantiate(/** @type {?} */ (module), tpm.imports());
    tpm.exports = instance.exports;
    tpm.exports["_initialize"]();
    return tpm;
}

/**
 * @constructor
 * @param {function(number, ?Uint8Array)} on_store
 */
export function Libtpms(on_store)
{
    this.on_store = on_store;
    /** @type {!Object} */
    this.exports = {};
    /** The locality of the command being processed */
    this.locality = 0;
    this.powered = false;
    /** libtpms's own messages (TPM failure mode, ...) */
    this.log = "";
}

/** @return {!Uint8Array} the module's memory as it is (it may grow) */
Libtpms.prototype.memory = function()
{
    return new Uint8Array(this.exports["memory"].buffer);
};

Libtpms.prototype.imports = function()
{
    const view = () => new DataView(this.exports["memory"].buffer);
    return {
        "env": {
            "tpm_nv_store": (kind, pointer, length) =>
            {
                this.on_store(kind, pointer ? this.memory().slice(pointer, pointer + length) : null);
            },
            "tpm_locality": () => this.locality,
            "emscripten_notify_memory_growth": () => {},
            "__syscall_getdents64": () => -ERRNO_NOSYS,
        },
        "wasi_snapshot_preview1": {
            "random_get": (pointer, length) =>
            {
                // (at most 64 KiB a call: crypto.getRandomValues's limit)
                for(let done = 0; done < length; done += 0x10000)
                {
                    globalThis.crypto.getRandomValues(this.memory().subarray(pointer + done, pointer + Math.min(length, done + 0x10000)));
                }
                return 0;
            },
            "clock_time_get": (id, precision, out) =>
            {
                view().setBigUint64(out, BigInt(Date.now()) * 1000000n, true);
                return 0;
            },
            "fd_write": (fd, iovs, count, written) =>
            {
                let total = 0;
                for(let i = 0; i < count; i++)
                {
                    const pointer = view().getUint32(iovs + i * 8, true), length = view().getUint32(iovs + i * 8 + 4, true);
                    this.log += String.fromCharCode(...this.memory().subarray(pointer, pointer + length));
                    total += length;
                }
                if(this.log.length > 0x10000) this.log = this.log.slice(-0x8000);
                view().setUint32(written, total, true);
                return 0;
            },
            "fd_read": () => ERRNO_BADF,
            "fd_close": () => ERRNO_BADF,
            "fd_seek": () => ERRNO_BADF,
            "environ_sizes_get": (count, size) =>
            {
                view().setUint32(count, 0, true);
                view().setUint32(size, 0, true);
                return 0;
            },
            "environ_get": () => 0,
        },
    };
};

/**
 * Bytes into the module's memory (the TPM frees them)
 * @param {!Uint8Array} bytes
 * @return {number}
 */
Libtpms.prototype.copy_in = function(bytes)
{
    const pointer = this.exports["v86_tpm_alloc"](Math.max(bytes.length, 1));
    if(!pointer) throw new Error("tpm: out of memory");
    this.memory().set(bytes, pointer);
    return pointer;
};

/**
 * Power on: from the permanent state (null: a TPM that manufactures itself)
 * and, resuming a snapshot, the volatile state
 * @param {?Uint8Array} permanent
 * @param {?Uint8Array=} volatile
 * @return {number} 0, or libtpms's error
 */
Libtpms.prototype.power_on = function(permanent, volatile)
{
    for(const [kind, blob] of [[BLOB_PERMANENT, permanent], [BLOB_VOLATILE, volatile]])
    {
        if(blob) this.exports["v86_tpm_set_blob"](kind, this.copy_in(blob), blob.length);
    }
    const result = this.exports["v86_tpm_init"](TPM_BUFFER_SIZE) >>> 0;
    this.powered = result === 0;
    return result;
};

/** Power off: the TPM's memory released (the permanent state was stored with every change) */
Libtpms.prototype.power_off = function()
{
    if(this.powered) this.exports["v86_tpm_terminate"]();
    this.powered = false;
};

/**
 * A command
 * @param {!Uint8Array} command
 * @param {number} locality
 * @return {!Uint8Array} the response
 */
Libtpms.prototype.process = function(command, locality)
{
    this.locality = locality;
    const pointer = this.copy_in(command);
    const length = this.exports["v86_tpm_process"](pointer, command.length);
    this.exports["v86_tpm_free"](pointer);
    const response = this.exports["v86_tpm_response"]();
    return this.memory().slice(response, response + length);
};

/**
 * The volatile state of the running TPM (for a snapshot), or null
 * @return {?Uint8Array}
 */
Libtpms.prototype.volatile_state = function()
{
    if(!this.powered) return null;
    const length = this.exports["v86_tpm_get_state"](2);
    if(!length) return null;
    const pointer = this.exports["v86_tpm_state"]();
    return this.memory().slice(pointer, pointer + length);
};
