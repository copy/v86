// DEFLATE (RFC 1951) and gzip (RFC 1952) decompression, synchronous, for
// the kernels the virt machine loads (docs/arm64-virt-android16-plan.md
// P4.6: an EFI zboot vmlinuz carries its Image gzipped; the browser's
// DecompressionStream is asynchronous and machine setup is not).

const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073,
    4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/**
 * A canonical Huffman code from its code lengths: counts per length and
 * the symbols sorted by code
 */
function huffman(lengths)
{
    const counts = new Uint16Array(16);
    for(const l of lengths) counts[l]++;
    counts[0] = 0;
    const offsets = new Uint16Array(16);
    for(let l = 1; l < 16; l++) offsets[l] = offsets[l - 1] + counts[l - 1];
    const symbols = new Uint16Array(lengths.length);
    lengths.forEach((l, symbol) => { if(l) symbols[offsets[l]++] = symbol; });
    return { counts, symbols };
}

// (thrown inside inflate when the output reaches its limit)
const LIMIT_REACHED = {};

/**
 * Inflate a raw DEFLATE stream
 * @param {!Uint8Array} input
 * @param {number=} start
 * @param {number=} size_hint the output's size, if known
 * @param {number=} limit the most bytes to produce: decoding stops there,
 *     even inside the stream (a disk image's compressed cluster:
 *     docs/disk-image-formats-plan.md P2)
 * @return {{output: !Uint8Array, end: number}} the data and where the stream ended (or stopped)
 */
export function inflate(input, start = 0, size_hint = 0, limit = Infinity)
{
    let pos = start, bitbuf = 0, bitcount = 0;
    let out = new Uint8Array(Math.max(Math.min(size_hint, limit), Math.min(1 << 16, limit))), out_len = 0;
    const ensure = n => {
        if(out_len + n <= out.length) return;
        let size = out.length * 2;
        while(size < out_len + n) size *= 2;
        const bigger = new Uint8Array(size);
        bigger.set(out.subarray(0, out_len));
        out = bigger;
    };
    const bits = n => {
        while(bitcount < n)
        {
            if(pos >= input.length) throw new Error("inflate: the stream ends early");
            bitbuf |= input[pos++] << bitcount;
            bitcount += 8;
        }
        const value = bitbuf & ((1 << n) - 1);
        bitbuf >>>= n;
        bitcount -= n;
        return value;
    };
    const decode = h => {
        let code = 0, first = 0, index = 0;
        for(let l = 1; l < 16; l++)
        {
            code |= bits(1);
            const count = h.counts[l];
            if(code - count < first) return h.symbols[index + (code - first)];
            index += count;
            first += count;
            first <<= 1;
            code <<= 1;
        }
        throw new Error("inflate: a bad Huffman code");
    };
    const fixed_lengths = new Uint8Array(288);
    fixed_lengths.fill(8, 0, 144); fixed_lengths.fill(9, 144, 256); fixed_lengths.fill(7, 256, 280); fixed_lengths.fill(8, 280, 288);
    const fixed_literal = huffman(fixed_lengths), fixed_distance = huffman(new Uint8Array(30).fill(5));
    try
    {
        for(;;)
        {
            const last = bits(1);
            const type = bits(2);
            if(type === 0)
            {
                bitbuf = 0; bitcount = 0;
                if(pos + 4 > input.length) throw new Error("inflate: the stream ends early");
                const len = input[pos] | input[pos + 1] << 8;
                if((input[pos + 2] | input[pos + 3] << 8) !== (len ^ 0xFFFF)) throw new Error("inflate: a stored block's length check fails");
                pos += 4;
                if(pos + len > input.length) throw new Error("inflate: the stream ends early");
                const n = Math.min(len, limit - out_len);
                ensure(n);
                out.set(input.subarray(pos, pos + n), out_len);
                out_len += n;
                pos += len;
                if(n < len) throw LIMIT_REACHED;
            }
            else
            {
                let literal = fixed_literal, distance = fixed_distance;
                if(type === 2)
                {
                    const hlit = bits(5) + 257, hdist = bits(5) + 1, hclen = bits(4) + 4;
                    const code_lengths = new Uint8Array(19);
                    for(let i = 0; i < hclen; i++) code_lengths[CODE_LENGTH_ORDER[i]] = bits(3);
                    const code_length_code = huffman(code_lengths);
                    const lengths = new Uint8Array(hlit + hdist);
                    for(let i = 0; i < hlit + hdist;)
                    {
                        const symbol = decode(code_length_code);
                        if(symbol < 16) lengths[i++] = symbol;
                        else if(symbol === 16)
                        {
                            if(i === 0) throw new Error("inflate: a repeat of no code length");
                            const prev = lengths[i - 1];
                            for(let r = 3 + bits(2); r > 0; r--) lengths[i++] = prev;
                        }
                        else if(symbol === 17) i += 3 + bits(3);
                        else i += 11 + bits(7);
                        if(i > hlit + hdist) throw new Error("inflate: code lengths past their count");
                    }
                    literal = huffman(lengths.subarray(0, hlit));
                    distance = huffman(lengths.subarray(hlit));
                }
                else if(type !== 1)
                {
                    throw new Error("inflate: a reserved block type");
                }
                for(;;)
                {
                    const symbol = decode(literal);
                    if(symbol < 256)
                    {
                        if(out_len >= limit) throw LIMIT_REACHED;
                        ensure(1);
                        out[out_len++] = symbol;
                    }
                    else if(symbol === 256)
                    {
                        break;
                    }
                    else
                    {
                        const l = symbol - 257;
                        if(l >= 29) throw new Error("inflate: an invalid length code");
                        const length = LENGTH_BASE[l] + bits(LENGTH_EXTRA[l]);
                        const d = decode(distance);
                        if(d >= 30) throw new Error("inflate: an invalid distance code");
                        const dist = DIST_BASE[d] + bits(DIST_EXTRA[d]);
                        if(dist > out_len) throw new Error("inflate: a distance before the start of the data");
                        const n = Math.min(length, limit - out_len);
                        ensure(n);
                        for(let i = 0; i < n; i++, out_len++) out[out_len] = out[out_len - dist];
                        if(n < length) throw LIMIT_REACHED;
                    }
                }
            }
            if(last) break;
        }
    }
    catch(e)
    {
        if(e !== LIMIT_REACHED) throw e;
    }
    return { output: out.subarray(0, out_len), end: pos };
}

/**
 * The data of a gzip member
 * @param {!Uint8Array} input
 * @return {!Uint8Array}
 */
export function gunzip(input)
{
    if(input[0] !== 0x1F || input[1] !== 0x8B || input[2] !== 8) throw new Error("gunzip: not gzip (deflate) data");
    const flags = input[3];
    let pos = 10;
    if(flags & 4) pos += 2 + (input[pos] | input[pos + 1] << 8);
    if(flags & 8) while(input[pos++]) {}
    if(flags & 16) while(input[pos++]) {}
    if(flags & 2) pos += 2;
    // (ISIZE, the size modulo 2^32, closes the member)
    const size = (input[input.length - 4] | input[input.length - 3] << 8 | input[input.length - 2] << 16 | input[input.length - 1] << 24) >>> 0;
    return inflate(input, pos, size).output;
}
