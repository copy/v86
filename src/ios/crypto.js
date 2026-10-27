// The ciphers and hashes Apple's firmware needs (docs/iphone4-plan.md S0),
// synchronous and in plain JS so that the same code runs in node, in a
// browser worker and on pages that are not a secure context (crypto.subtle
// is missing there): AES (FIPS 197) with CBC and no padding (IMG3 payloads,
// the root filesystem's chunks), SHA-1 (FIPS 180-4; the IPSW's identity,
// HMAC-SHA1 for the root filesystem's chunk IVs) and HMAC (RFC 2104).

const SBOX = new Uint8Array(256), INV_SBOX = new Uint8Array(256);
// (the round tables: T0..T3 encrypt, D0..D3 decrypt, one byte rotation apart)
const T = [0, 1, 2, 3].map(() => new Uint32Array(256)), D = [0, 1, 2, 3].map(() => new Uint32Array(256));

{
    const exp = new Uint8Array(256), log = new Uint8Array(256);
    for(let i = 0, x = 1; i < 255; i++)
    {
        exp[i] = x;
        log[x] = i;
        x ^= x << 1 ^ (x & 0x80 ? 0x11B : 0);
        x &= 0xFF;
    }
    const mul = (a, b) => a && b ? exp[(log[a] + log[b]) % 255] : 0;
    for(let i = 0; i < 256; i++)
    {
        const inv = i ? exp[(255 - log[i]) % 255] : 0;
        let s = inv;
        for(let k = 1; k < 5; k++) s ^= (inv << k | inv >>> 8 - k) & 0xFF;
        s ^= 0x63;
        SBOX[i] = s;
        INV_SBOX[s] = i;
    }
    for(let i = 0; i < 256; i++)
    {
        const s = SBOX[i], v = INV_SBOX[i];
        const e = (mul(s, 2) << 24 | s << 16 | s << 8 | mul(s, 3)) >>> 0;
        const d = (mul(v, 14) << 24 | mul(v, 9) << 16 | mul(v, 13) << 8 | mul(v, 11)) >>> 0;
        for(let r = 0; r < 4; r++)
        {
            T[r][i] = (e >>> 8 * r | e << 32 - 8 * r) >>> 0;
            D[r][i] = (d >>> 8 * r | d << 32 - 8 * r) >>> 0;
        }
    }
}

/**
 * An expanded AES key (128, 192 or 256 bits)
 * @constructor
 * @param {!Uint8Array} key
 */
export function AES(key)
{
    const nk = key.length / 4;
    if(nk !== 4 && nk !== 6 && nk !== 8) throw new Error(`AES: a ${key.length}-byte key`);
    const rounds = this.rounds = nk + 6;
    const w = this.encrypt_keys = new Uint32Array(4 * (rounds + 1));
    for(let i = 0; i < nk; i++) w[i] = (key[4 * i] << 24 | key[4 * i + 1] << 16 | key[4 * i + 2] << 8 | key[4 * i + 3]) >>> 0;
    for(let i = nk, rcon = 1; i < w.length; i++)
    {
        let t = w[i - 1];
        if(i % nk === 0)
        {
            t = (SBOX[t >>> 16 & 0xFF] << 24 | SBOX[t >>> 8 & 0xFF] << 16 | SBOX[t & 0xFF] << 8 | SBOX[t >>> 24]) ^ rcon << 24;
            rcon = rcon << 1 ^ (rcon & 0x80 ? 0x11B : 0);
        }
        else if(nk > 6 && i % nk === 4)
        {
            t = SBOX[t >>> 24] << 24 | SBOX[t >>> 16 & 0xFF] << 16 | SBOX[t >>> 8 & 0xFF] << 8 | SBOX[t & 0xFF];
        }
        w[i] = (w[i - nk] ^ t) >>> 0;
    }
    // (the equivalent inverse cipher's keys: reversed, InvMixColumns on the middle rounds)
    const dk = this.decrypt_keys = new Uint32Array(w.length);
    for(let r = 0; r <= rounds; r++)
    {
        for(let c = 0; c < 4; c++)
        {
            const x = w[4 * (rounds - r) + c];
            dk[4 * r + c] = r === 0 || r === rounds ? x :
                D[0][SBOX[x >>> 24]] ^ D[1][SBOX[x >>> 16 & 0xFF]] ^ D[2][SBOX[x >>> 8 & 0xFF]] ^ D[3][SBOX[x & 0xFF]];
        }
    }
    this.state = new Uint32Array(4);
}

/**
 * One block in place, encrypted (decrypt false) or decrypted
 * @param {!Uint8Array} b
 * @param {number} at
 * @param {boolean} decrypt
 */
AES.prototype.block = function(b, at, decrypt)
{
    const k = decrypt ? this.decrypt_keys : this.encrypt_keys, t = decrypt ? D : T, box = decrypt ? INV_SBOX : SBOX;
    const [t0, t1, t2, t3] = t;
    // (decrypting, the rows shift the other way: the word sources run 3, 2, 1 instead of 1, 2, 3)
    const s1 = decrypt ? 3 : 1, s3 = decrypt ? 1 : 3;
    let a0 = (b[at] << 24 | b[at + 1] << 16 | b[at + 2] << 8 | b[at + 3]) ^ k[0];
    let a1 = (b[at + 4] << 24 | b[at + 5] << 16 | b[at + 6] << 8 | b[at + 7]) ^ k[1];
    let a2 = (b[at + 8] << 24 | b[at + 9] << 16 | b[at + 10] << 8 | b[at + 11]) ^ k[2];
    let a3 = (b[at + 12] << 24 | b[at + 13] << 16 | b[at + 14] << 8 | b[at + 15]) ^ k[3];
    const a = this.state;
    for(let r = 1; r < this.rounds; r++)
    {
        a[0] = a0; a[1] = a1; a[2] = a2; a[3] = a3;
        const q = 4 * r;
        a0 = t0[a[0] >>> 24] ^ t1[a[s1] >>> 16 & 0xFF] ^ t2[a[2] >>> 8 & 0xFF] ^ t3[a[s3] & 0xFF] ^ k[q];
        a1 = t0[a[1] >>> 24] ^ t1[a[(1 + s1) & 3] >>> 16 & 0xFF] ^ t2[a[3] >>> 8 & 0xFF] ^ t3[a[(1 + s3) & 3] & 0xFF] ^ k[q + 1];
        a2 = t0[a[2] >>> 24] ^ t1[a[(2 + s1) & 3] >>> 16 & 0xFF] ^ t2[a[0] >>> 8 & 0xFF] ^ t3[a[(2 + s3) & 3] & 0xFF] ^ k[q + 2];
        a3 = t0[a[3] >>> 24] ^ t1[a[(3 + s1) & 3] >>> 16 & 0xFF] ^ t2[a[1] >>> 8 & 0xFF] ^ t3[a[(3 + s3) & 3] & 0xFF] ^ k[q + 3];
    }
    a[0] = a0; a[1] = a1; a[2] = a2; a[3] = a3;
    const q = 4 * this.rounds;
    for(let c = 0; c < 4; c++)
    {
        const x = box[a[c] >>> 24] << 24 | box[a[(c + s1) & 3] >>> 16 & 0xFF] << 16 |
            box[a[(c + 2) & 3] >>> 8 & 0xFF] << 8 | box[a[(c + s3) & 3] & 0xFF];
        const y = x ^ k[q + c];
        b[at + 4 * c] = y >>> 24; b[at + 4 * c + 1] = y >>> 16; b[at + 4 * c + 2] = y >>> 8; b[at + 4 * c + 3] = y;
    }
};

/**
 * CBC without padding, in place: data's length a multiple of 16. Returns the
 * IV for what follows (the last cipher block)
 * @param {!Uint8Array} data
 * @param {!Uint8Array} iv 16 bytes, not changed
 * @param {boolean} decrypt
 * @return {!Uint8Array}
 */
AES.prototype.cbc = function(data, iv, decrypt)
{
    if(data.length % 16) throw new Error(`AES-CBC: ${data.length} bytes, not whole blocks`);
    const chain = new Uint8Array(iv), saved = new Uint8Array(16);
    for(let at = 0; at < data.length; at += 16)
    {
        if(decrypt)
        {
            saved.set(data.subarray(at, at + 16));
            this.block(data, at, true);
            for(let i = 0; i < 16; i++) data[at + i] ^= chain[i];
            chain.set(saved);
        }
        else
        {
            for(let i = 0; i < 16; i++) data[at + i] ^= chain[i];
            this.block(data, at, false);
            chain.set(data.subarray(at, at + 16));
        }
    }
    return chain;
};

/**
 * An incremental SHA-1
 * @constructor
 */
export function SHA1()
{
    this.h = new Int32Array([0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0]);
    this.w = new Int32Array(80);
    this.block = new Uint8Array(64);
    this.block_length = 0;
    this.total = 0;
}

/**
 * @param {!Uint8Array} data
 * @return {!SHA1}
 */
SHA1.prototype.update = function(data)
{
    this.total += data.length;
    let i = 0;
    if(this.block_length)
    {
        const n = Math.min(64 - this.block_length, data.length);
        this.block.set(data.subarray(0, n), this.block_length);
        this.block_length += n;
        i = n;
        if(this.block_length < 64) return this;
        this.compress(this.block, 0);
        this.block_length = 0;
    }
    for(; i + 64 <= data.length; i += 64) this.compress(data, i);
    this.block.set(data.subarray(i), 0);
    this.block_length = data.length - i;
    return this;
};

/**
 * @param {!Uint8Array} bytes
 * @param {number} offset
 */
SHA1.prototype.compress = function(bytes, offset)
{
    const w = this.w, h = this.h;
    for(let t = 0; t < 16; t++)
    {
        const p = offset + t * 4;
        w[t] = bytes[p] << 24 | bytes[p + 1] << 16 | bytes[p + 2] << 8 | bytes[p + 3];
    }
    for(let t = 16; t < 80; t++)
    {
        const x = w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16];
        w[t] = x << 1 | x >>> 31;
    }
    let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4];
    for(let t = 0; t < 80; t++)
    {
        const f = t < 20 ? (b & c | ~b & d) + 0x5A827999 :
            t < 40 ? (b ^ c ^ d) + 0x6ED9EBA1 :
            t < 60 ? (b & c | b & d | c & d) + 0x8F1BBCDC :
            (b ^ c ^ d) + 0xCA62C1D6;
        const x = (a << 5 | a >>> 27) + f + e + w[t] | 0;
        e = d; d = c; c = b << 30 | b >>> 2; b = a; a = x;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e;
};

/**
 * @return {!Uint8Array} the digest's 20 bytes (the hash is finished)
 */
SHA1.prototype.digest = function()
{
    const bits_high = Math.floor(this.total / 0x20000000), bits_low = this.total * 8 >>> 0;
    const pad = new Uint8Array((this.block_length < 56 ? 64 : 128) - this.block_length);
    pad[0] = 0x80;
    const n = pad.length;
    pad[n - 8] = bits_high >>> 24; pad[n - 7] = bits_high >>> 16; pad[n - 6] = bits_high >>> 8; pad[n - 5] = bits_high;
    pad[n - 4] = bits_low >>> 24; pad[n - 3] = bits_low >>> 16; pad[n - 2] = bits_low >>> 8; pad[n - 1] = bits_low;
    this.update(pad);
    const out = new Uint8Array(20);
    for(let i = 0; i < 5; i++)
    {
        out[4 * i] = this.h[i] >>> 24; out[4 * i + 1] = this.h[i] >>> 16; out[4 * i + 2] = this.h[i] >>> 8; out[4 * i + 3] = this.h[i];
    }
    return out;
};

/**
 * @return {string} the digest in hexadecimal (the hash is finished)
 */
SHA1.prototype.hex = function()
{
    return to_hex(this.digest());
};

/**
 * HMAC-SHA1 with a fixed key: the key's padded blocks hashed once
 * @constructor
 * @param {!Uint8Array} key
 */
export function HMAC_SHA1(key)
{
    if(key.length > 64) key = new SHA1().update(key).digest();
    const pad = new Uint8Array(64);
    pad.set(key);
    for(let i = 0; i < 64; i++) pad[i] ^= 0x36;
    this.inner = new SHA1().update(pad);
    for(let i = 0; i < 64; i++) pad[i] ^= 0x36 ^ 0x5C;
    this.outer = new SHA1().update(pad);
}

/**
 * @param {!Uint8Array} message
 * @return {!Uint8Array} 20 bytes
 */
HMAC_SHA1.prototype.mac = function(message)
{
    const inner = clone_sha1(this.inner).update(message).digest();
    return clone_sha1(this.outer).update(inner).digest();
};

/** @param {!SHA1} hash @return {!SHA1} */
function clone_sha1(hash)
{
    const copy = new SHA1();
    copy.h.set(hash.h);
    copy.block.set(hash.block);
    copy.block_length = hash.block_length;
    copy.total = hash.total;
    return copy;
}

/**
 * @param {string} hex
 * @return {!Uint8Array}
 */
export function from_hex(hex)
{
    if(!/^([0-9a-fA-F]{2})*$/.test(hex)) throw new Error("not a hexadecimal string of whole bytes");
    const out = new Uint8Array(hex.length / 2);
    for(let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(2 * i, 2), 16);
    return out;
}

/**
 * @param {!Uint8Array} bytes
 * @return {string}
 */
export function to_hex(bytes)
{
    return Array.from(bytes, x => x.toString(16).padStart(2, "0")).join("");
}
