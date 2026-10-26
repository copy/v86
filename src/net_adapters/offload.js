// What network cards compute for the driver (built into the card plugins):
// the Internet checksum (RFC 1071) of transmit offload and receive checks,
// and the Ethernet FCS a card leaves in memory when it does not strip it.

/**
 * The 16-bit one's complement sum of bytes [start, end), not yet folded; an
 * odd last byte is the high half of a word
 * @param {!Uint8Array} data
 * @param {number} start
 * @param {number} end
 * @param {number=} sum to continue
 * @return {number}
 */
export function checksum_add(data, start, end, sum = 0)
{
    let i = start;
    for(; i + 1 < end; i += 2)
    {
        sum += data[i] << 8 | data[i + 1];
        // (fold early: a frame of 64 KiB stays far below 2 ** 53 anyway, but
        // small integers are faster)
        if(sum > 0x7FFFFFFF) sum = (sum & 0xFFFF) + (sum >>> 16);
    }
    if(i < end)
    {
        sum += data[i] << 8;
    }
    return sum;
}

/**
 * Fold a sum into 16 bits
 * @param {number} sum
 * @return {number}
 */
export function checksum_fold(sum)
{
    while(sum > 0xFFFF)
    {
        sum = (sum & 0xFFFF) + Math.floor(sum / 0x10000);
    }
    return sum;
}

/**
 * The checksum to store: the complement of the folded sum, 0xFFFF instead of
 * 0 (for UDP, 0 means "no checksum"; for TCP and IP the two are the same)
 * @param {number} sum
 * @return {number}
 */
export function checksum_finish(sum)
{
    return ~checksum_fold(sum) & 0xFFFF || 0xFFFF;
}

/**
 * Store a big-endian 16-bit value
 * @param {!Uint8Array} data
 * @param {number} offset
 * @param {number} value
 */
export function store16(data, offset, value)
{
    data[offset] = value >> 8;
    data[offset + 1] = value;
}

/**
 * @param {!Uint8Array} data
 * @param {number} offset
 * @return {number}
 */
export function load16(data, offset)
{
    return data[offset] << 8 | data[offset + 1];
}

/**
 * @param {!Uint8Array} data
 * @param {number} offset
 * @param {number} value
 */
export function store32(data, offset, value)
{
    data[offset] = value >>> 24;
    data[offset + 1] = value >>> 16;
    data[offset + 2] = value >>> 8;
    data[offset + 3] = value;
}

/**
 * @param {!Uint8Array} data
 * @param {number} offset
 * @return {number}
 */
export function load32(data, offset)
{
    return (data[offset] << 24 | data[offset + 1] << 16 | data[offset + 2] << 8 | data[offset + 3]) >>> 0;
}

/** @type {Int32Array} */
let crc_table = null;

/**
 * The Ethernet FCS (CRC-32, IEEE 802.3) of bytes [start, end); it goes on
 * the wire least significant byte first
 * @param {!Uint8Array} data
 * @param {number} start
 * @param {number} end
 * @return {number}
 */
export function ethernet_fcs(data, start, end)
{
    if(!crc_table)
    {
        crc_table = new Int32Array(256);
        for(let n = 0; n < 256; n++)
        {
            let c = n;
            for(let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ c >>> 1 : c >>> 1;
            crc_table[n] = c;
        }
    }
    let crc = -1;
    for(let i = start; i < end; i++)
    {
        crc = crc_table[(crc ^ data[i]) & 0xFF] ^ crc >>> 8;
    }
    return ~crc >>> 0;
}

/** What a card found when it checked a frame's checksums (receive offload) */
export const CHECKSUM_NONE = 0;
export const CHECKSUM_GOOD = 1;
export const CHECKSUM_BAD = 2;

/**
 * Check the IPv4 header and the TCP or UDP checksum of an Ethernet frame
 * (without a VLAN tag). Fragments and other protocols have no L4 result.
 * @param {!Uint8Array} frame
 * @param {number} length
 * @return {{ip: number, l4: number}} CHECKSUM_*
 */
export function check_checksums(frame, length)
{
    const result = { ip: CHECKSUM_NONE, l4: CHECKSUM_NONE };
    if(length < 14 + 20 || load16(frame, 12) !== 0x0800 || frame[14] >> 4 !== 4)
    {
        return result;
    }
    const ihl = (frame[14] & 0xF) << 2;
    const total = load16(frame, 16);
    if(ihl < 20 || 14 + ihl > length)
    {
        return result;
    }
    result.ip = checksum_fold(checksum_add(frame, 14, 14 + ihl)) === 0xFFFF ? CHECKSUM_GOOD : CHECKSUM_BAD;

    const protocol = frame[14 + 9];
    const fragment = load16(frame, 14 + 6) & 0x3FFF;
    if(result.ip !== CHECKSUM_GOOD || fragment || protocol !== 6 && protocol !== 17 ||
        total < ihl || 14 + total > length)
    {
        return result;
    }
    const start = 14 + ihl, end = 14 + total;
    if(protocol === 17 && (end - start < 8 || load16(frame, start + 6) === 0))
    {
        // (UDP without a checksum)
        result.l4 = end - start < 8 ? CHECKSUM_BAD : CHECKSUM_GOOD;
        return result;
    }
    // the pseudo header: addresses, protocol, length
    let sum = checksum_add(frame, 14 + 12, 14 + 20);
    sum += protocol + (end - start);
    sum = checksum_add(frame, start, end, sum);
    result.l4 = checksum_fold(sum) === 0xFFFF ? CHECKSUM_GOOD : CHECKSUM_BAD;
    return result;
}
