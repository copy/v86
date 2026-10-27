// The TPM's permanent state in a store of its own (docs/tpm.md): a buffer
// object (src/buffer.js's, or a disk written back: tpm.state with
// disk_option "read_write"), as the UEFI variables have theirs. Two slots
// of STORE_SIZE / 2 bytes each, written alternately: a header (magic,
// format, sequence number, length, CRC-32 of the blob) and the blob. The
// newer valid slot is the state; a store of zeros is a TPM not yet
// manufactured. Anything else is refused, never cleared: a TPM's state
// holds keys (BitLocker's) that a new TPM would not have.

/** The store's size: two slots of 256 KiB (libtpms's permanent state is under 140 KiB) */
export const STORE_SIZE = 512 * 1024;
const SLOT_SIZE = STORE_SIZE / 2;
const HEADER_SIZE = 64;
const MAGIC = "V86TPMS1";
const FORMAT = 1;

const CRC_TABLE = (() =>
{
    const table = new Int32Array(256);
    for(let n = 0; n < 256; n++)
    {
        let c = n;
        for(let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ c >>> 1 : c >>> 1;
        table[n] = c;
    }
    return table;
})();

/**
 * @param {!Uint8Array} bytes
 * @return {number}
 */
function crc32(bytes)
{
    let c = -1;
    for(let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ c >>> 8;
    return (c ^ -1) >>> 0;
}

/**
 * @constructor
 * @param {!Object} buffer get, set (synchronous), byteLength
 */
export function TpmStore(buffer)
{
    if(buffer.byteLength < STORE_SIZE)
    {
        throw new Error("tpm.state: the store has " + buffer.byteLength + " bytes, it needs " + STORE_SIZE);
    }
    this.buffer = buffer;
    /** The sequence number of the slot read or written last */
    this.sequence = 0;
    this.slot = 1;
}

/**
 * @param {number} offset
 * @param {number} length
 * @return {!Uint8Array}
 */
TpmStore.prototype.read = function(offset, length)
{
    let result = null;
    this.buffer.get(offset, length, data => { result = data; });
    if(!result) throw new Error("tpm.state: the store cannot be read");
    return result;
};

/**
 * The permanent state: null for a store of zeros (a TPM to manufacture)
 * @return {?Uint8Array}
 */
TpmStore.prototype.load = function()
{
    let best = null;
    for(let slot = 0; slot < 2; slot++)
    {
        const header = this.read(slot * SLOT_SIZE, HEADER_SIZE);
        if(String.fromCharCode(...header.subarray(0, 8)) !== MAGIC) continue;
        const view = new DataView(header.buffer, header.byteOffset, header.length);
        const format = view.getUint32(8, true), sequence = view.getUint32(12, true), length = view.getUint32(16, true), crc = view.getUint32(20, true);
        if(format !== FORMAT || length > SLOT_SIZE - HEADER_SIZE) continue;
        const blob = this.read(slot * SLOT_SIZE + HEADER_SIZE, length);
        if(crc32(blob) !== crc) continue;
        if(!best || (sequence - best.sequence | 0) > 0)
        {
            best = { slot, sequence, blob };
        }
    }
    if(best)
    {
        this.slot = best.slot;
        this.sequence = best.sequence;
        return best.blob;
    }
    // (no whole slot: a new TPM only where the store is all zeros)
    if(this.read(0, STORE_SIZE).some(byte => byte !== 0))
    {
        throw new Error("tpm.state: the TPM's state is damaged (neither of its copies is whole); " +
            "it is not replaced by a new TPM: clear it explicitly to start over");
    }
    this.slot = 1;
    this.sequence = 0;
    return null;
};

/**
 * The permanent state, into the slot not holding the current one: the blob
 * first, then its header
 * @param {!Uint8Array} blob
 */
TpmStore.prototype.save = function(blob)
{
    if(blob.length > SLOT_SIZE - HEADER_SIZE)
    {
        throw new Error("tpm.state: the TPM's state (" + blob.length + " bytes) is larger than a slot of the store");
    }
    const slot = this.slot ^ 1;
    const sequence = this.sequence + 1 >>> 0;
    const header = new Uint8Array(HEADER_SIZE);
    for(let i = 0; i < 8; i++) header[i] = MAGIC.charCodeAt(i);
    const view = new DataView(header.buffer);
    view.setUint32(8, FORMAT, true);
    view.setUint32(12, sequence, true);
    view.setUint32(16, blob.length, true);
    view.setUint32(20, crc32(blob), true);
    const failed = error => { if(error) throw new Error("tpm.state: the store cannot be written (" + error.message + ")"); };
    this.buffer.set(slot * SLOT_SIZE + HEADER_SIZE, blob, failed);
    this.buffer.set(slot * SLOT_SIZE, header, failed);
    this.slot = slot;
    this.sequence = sequence;
};
