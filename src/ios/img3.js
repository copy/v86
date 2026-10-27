// IMG3, the container of iOS 2–6 firmware files (docs/iphone4-plan.md S0):
// a 20-byte header (magic "Img3", full size, size without the signature,
// signed area, the image's type) then tags, each a magic, its total length
// (with padding), its data's length and the data. Magics and types are
// four characters stored little-endian ("DATA" reads "ATAD"). DATA is the
// payload; KBAG says how it is encrypted (AES-CBC, its IV and key wrapped
// by the device's GID key, so the keys come from the user: The Apple Wiki's
// key pages). The cipher text runs on into the tag's padding up to a whole
// AES block: decrypting only DATA's recorded length garbles the last block.

import { u32, latin1 } from "../android/bytes.js";
import { AES, from_hex } from "./crypto.js";

const MAGIC = 0x496D6733; // "Img3"

/** @param {!Uint8Array} b @param {number} at @return {string} a four-character code stored little-endian */
function fourcc(b, at)
{
    return latin1(b, at, at + 4).split("").reverse().join("");
}

/**
 * The tags of an IMG3 file
 * @param {!Uint8Array} bytes
 * @return {{type: string, tags: !Array<{magic: string, data: !Uint8Array, room: !Uint8Array}>}}
 *     (room: the tag's data with its padding)
 */
export function img3_parse(bytes)
{
    if(bytes.length < 20 || u32(bytes, 0) !== MAGIC) throw new Error("IMG3: no Img3 header");
    const size = Math.min(u32(bytes, 4), bytes.length);
    const tags = [];
    for(let at = 20; at + 12 <= size;)
    {
        const total = u32(bytes, at + 4), length = u32(bytes, at + 8);
        if(total < 12 || length > total - 12 || at + total > size) throw new Error(`IMG3: a broken tag at ${at}`);
        tags.push({ magic: fourcc(bytes, at), data: bytes.subarray(at + 12, at + 12 + length), room: bytes.subarray(at + 12, at + total) });
        at += total;
    }
    return { type: fourcc(bytes, 16), tags };
}

/**
 * An IMG3 file's payload, decrypted with key (hexadecimal or bytes; null
 * for an unencrypted image)
 * @param {!Uint8Array} bytes
 * @param {?{iv: (string|!Uint8Array), key: (string|!Uint8Array)}=} key
 * @return {{type: string, data: !Uint8Array, encrypted: boolean}}
 */
export function img3_payload(bytes, key)
{
    const image = img3_parse(bytes);
    const data = image.tags.find(t => t.magic === "DATA");
    if(!data) throw new Error(`IMG3 ${image.type}: no DATA tag`);
    const kbag = image.tags.find(t => t.magic === "KBAG");
    if(!kbag) return { type: image.type, data: data.data.slice(), encrypted: false };
    if(!key) throw new Error(`IMG3 ${image.type}: encrypted, and no key given`);
    const iv = typeof key.iv === "string" ? from_hex(key.iv) : key.iv;
    const k = typeof key.key === "string" ? from_hex(key.key) : key.key;
    const bits = u32(kbag.data, 4);
    if(iv.length !== 16 || k.length * 8 !== bits) throw new Error(`IMG3 ${image.type}: wants AES-${bits}, got a ${k.length * 8}-bit key and a ${iv.length}-byte IV`);
    const whole = data.data.length + 15 & ~15;
    if(whole > data.room.length) throw new Error(`IMG3 ${image.type}: DATA is not padded to an AES block`);
    const plain = data.room.slice(0, whole);
    new AES(k).cbc(plain, iv, true);
    return { type: image.type, data: plain.subarray(0, data.data.length), encrypted: true };
}

/**
 * An IMG3 file made of tags (tests; the padding up to 4 bytes, or to whole
 * AES blocks for an encrypted DATA, given in the tag's room)
 * @param {string} type
 * @param {!Array<{magic: string, data: !Uint8Array, room: (!Uint8Array|undefined)}>} tags
 * @return {!Uint8Array}
 */
export function img3_build(type, tags)
{
    const cc = s => [3, 2, 1, 0].map(i => s.charCodeAt(i));
    const parts = tags.map(t =>
    {
        const room = t.room || new Uint8Array(t.data.length + 3 & ~3);
        if(!t.room) room.set(t.data);
        const out = new Uint8Array(12 + room.length);
        out.set(cc(t.magic), 0);
        new DataView(out.buffer).setUint32(4, out.length, true);
        new DataView(out.buffer).setUint32(8, t.data.length, true);
        out.set(room, 12);
        return out;
    });
    const size = 20 + parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(size), view = new DataView(out.buffer);
    view.setUint32(0, MAGIC, true);
    view.setUint32(4, size, true);
    view.setUint32(8, size - 20, true);
    view.setUint32(12, size - 20, true);
    out.set(cc(type), 16);
    let at = 20;
    for(const p of parts) { out.set(p, at); at += p.length; }
    return out;
}
