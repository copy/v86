// The root filesystem DMG's encryption (docs/iphone4-plan.md S0): FileVault's
// "encrcdsa" version 2 format as vfdecrypt reads it. The header (big-endian)
// gives the chunk size, the plain data's size and where the chunks start;
// each chunk is AES-128-CBC with IV = HMAC-SHA1(chunk number, big-endian
// 32 bits) cut to 16 bytes. The key page's root filesystem key is 36 bytes:
// the AES key, then the HMAC key.

import { u32be, u64be, latin1 } from "../android/bytes.js";
import { AES, HMAC_SHA1, from_hex } from "./crypto.js";

/**
 * @param {!Uint8Array} bytes the file's first bytes (0x48 at least)
 * @return {{block_size: number, data_size: number, data_offset: number}}
 */
export function encrcdsa_header(bytes)
{
    if(bytes.length < 0x48 || latin1(bytes, 0, 8) !== "encrcdsa") throw new Error("root filesystem: no encrcdsa header");
    const version = u32be(bytes, 8);
    if(version !== 2) throw new Error(`root filesystem: encrcdsa version ${version}`);
    const block_size = u32be(bytes, 52), data_size = u64be(bytes, 56), data_offset = u64be(bytes, 64);
    if(!block_size || block_size % 16) throw new Error(`root filesystem: a chunk of ${block_size} bytes`);
    return { block_size, data_size, data_offset };
}

/**
 * The chunk cipher
 * @constructor
 * @param {string|!Uint8Array} key 36 bytes
 * @param {number} block_size
 */
export function VFDecrypt(key, block_size)
{
    const k = typeof key === "string" ? from_hex(key) : key;
    if(k.length !== 36) throw new Error(`root filesystem: a ${k.length}-byte key, not 36`);
    this.aes = new AES(k.subarray(0, 16));
    this.hmac = new HMAC_SHA1(k.subarray(16));
    this.block_size = block_size;
    this.number = new Uint8Array(4);
}

/**
 * Chunk number n in place
 * @param {!Uint8Array} chunk
 * @param {number} n
 */
VFDecrypt.prototype.decrypt = function(chunk, n)
{
    this.number[0] = n >>> 24; this.number[1] = n >>> 16; this.number[2] = n >>> 8; this.number[3] = n;
    this.aes.cbc(chunk, this.hmac.mac(this.number).subarray(0, 16), true);
};

/**
 * Chunk number n in place, encrypted (tests)
 * @param {!Uint8Array} chunk
 * @param {number} n
 */
VFDecrypt.prototype.encrypt = function(chunk, n)
{
    this.number[0] = n >>> 24; this.number[1] = n >>> 16; this.number[2] = n >>> 8; this.number[3] = n;
    this.aes.cbc(chunk, this.hmac.mac(this.number).subarray(0, 16), false);
};

/**
 * A decrypting stream: write() the encrypted file's bytes in order, from
 * its start; sink(bytes, offset) gets the plain data in order, data_size
 * bytes in all (awaited), or only the chunks that want(offset, length)
 * accepts (the others are not decrypted). end() checks that the file was
 * whole
 * @param {string|!Uint8Array} key
 * @param {function(!Uint8Array, number): (Promise|undefined)} sink
 * @param {{want: (function(number, number): boolean|undefined)}=} options
 * @return {{write: function(!Uint8Array): !Promise, end: function(): !Promise, header: function(): ?Object}}
 */
export function vfdecrypt_stream(key, sink, options = {})
{
    const want = options.want || (() => true);
    let header = null, cipher = null, head = new Uint8Array(0), offset = 0, chunk = null, filled = 0, number = 0, out = 0;
    const flush = async () =>
    {
        const n = Math.min(chunk.length, header.data_size - out);
        if(n > 0 && want(out, n))
        {
            cipher.decrypt(chunk, number);
            await sink(chunk.slice(0, n), out);
        }
        number++;
        out += n;
        filled = 0;
    };
    return {
        header: () => header,
        async write(bytes)
        {
            let at = 0;
            if(!header)
            {
                const joined = new Uint8Array(head.length + bytes.length);
                joined.set(head);
                joined.set(bytes, head.length);
                head = joined;
                if(head.length < 0x48) return;
                header = encrcdsa_header(head);
                cipher = new VFDecrypt(key, header.block_size);
                chunk = new Uint8Array(header.block_size);
                bytes = head;
                head = null;
            }
            for(; at < bytes.length;)
            {
                if(offset < header.data_offset)
                {
                    const skip = Math.min(bytes.length - at, header.data_offset - offset);
                    at += skip;
                    offset += skip;
                    continue;
                }
                const n = Math.min(bytes.length - at, chunk.length - filled);
                chunk.set(bytes.subarray(at, at + n), filled);
                filled += n;
                at += n;
                offset += n;
                if(filled === chunk.length && out < header.data_size) await flush();
                else if(filled === chunk.length) filled = 0;
            }
        },
        async end()
        {
            if(!header) throw new Error("root filesystem: cut short before its header");
            if(out < header.data_size) throw new Error(`root filesystem: ${out} of ${header.data_size} bytes decrypted, the file is cut short`);
        },
    };
}
