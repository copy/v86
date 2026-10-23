// SHA-256 (FIPS 180-4), synchronous: the identity of a disk image's metadata
// (docs/disk-image-formats-plan.md P1). crypto.subtle is asynchronous and
// missing on pages that are not a secure context (http:// on a LAN).

const K = new Int32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/**
 * An incremental SHA-256
 * @constructor
 */
export function SHA256()
{
    this.h = new Int32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    this.w = new Int32Array(64);
    this.block = new Uint8Array(64);
    this.block_length = 0;
    this.total = 0;
}

/**
 * @param {!Uint8Array} data
 * @return {!SHA256}
 */
SHA256.prototype.update = function(data)
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
    for(; i + 64 <= data.length; i += 64)
    {
        this.compress(data, i);
    }
    this.block.set(data.subarray(i), 0);
    this.block_length = data.length - i;
    return this;
};

/**
 * @param {!Uint8Array} bytes
 * @param {number} offset
 */
SHA256.prototype.compress = function(bytes, offset)
{
    const w = this.w, h = this.h;
    for(let t = 0; t < 16; t++)
    {
        const p = offset + t * 4;
        w[t] = bytes[p] << 24 | bytes[p + 1] << 16 | bytes[p + 2] << 8 | bytes[p + 3];
    }
    for(let t = 16; t < 64; t++)
    {
        const x = w[t - 15], y = w[t - 2];
        const s0 = (x >>> 7 | x << 25) ^ (x >>> 18 | x << 14) ^ x >>> 3;
        const s1 = (y >>> 17 | y << 15) ^ (y >>> 19 | y << 13) ^ y >>> 10;
        w[t] = w[t - 16] + s0 + w[t - 7] + s1 | 0;
    }
    let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], k = h[7];
    for(let t = 0; t < 64; t++)
    {
        const s1 = (e >>> 6 | e << 26) ^ (e >>> 11 | e << 21) ^ (e >>> 25 | e << 7);
        const t1 = k + s1 + (e & f ^ ~e & g) + K[t] + w[t] | 0;
        const s0 = (a >>> 2 | a << 30) ^ (a >>> 13 | a << 19) ^ (a >>> 22 | a << 10);
        const t2 = s0 + (a & b ^ a & c ^ b & c) | 0;
        k = g; g = f; f = e; e = d + t1 | 0;
        d = c; c = b; b = a; a = t1 + t2 | 0;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d;
    h[4] += e; h[5] += f; h[6] += g; h[7] += k;
};

/**
 * @return {string} the digest in hexadecimal
 */
SHA256.prototype.hex = function()
{
    const bits_high = Math.floor(this.total / 0x20000000), bits_low = this.total * 8 >>> 0;
    const pad = new Uint8Array((this.block_length < 56 ? 64 : 128) - this.block_length);
    pad[0] = 0x80;
    const n = pad.length;
    pad[n - 8] = bits_high >>> 24; pad[n - 7] = bits_high >>> 16; pad[n - 6] = bits_high >>> 8; pad[n - 5] = bits_high;
    pad[n - 4] = bits_low >>> 24; pad[n - 3] = bits_low >>> 16; pad[n - 2] = bits_low >>> 8; pad[n - 1] = bits_low;
    const total = this.total;
    this.update(pad);
    this.total = total;
    return Array.from(this.h, x => (x >>> 0).toString(16).padStart(8, "0")).join("");
};

/**
 * @return {!Uint8Array} the digest's 32 bytes
 */
SHA256.prototype.digest = function()
{
    const hex = this.hex();
    const out = new Uint8Array(32);
    for(let i = 0; i < 32; i++) out[i] = parseInt(hex.substr(2 * i, 2), 16);
    return out;
};

/**
 * @param {...!Uint8Array} parts
 * @return {string}
 */
export function sha256_hex(...parts)
{
    const hash = new SHA256();
    for(const part of parts) hash.update(part);
    return hash.hex();
}
