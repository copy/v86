// Simulator-only N90 provisioning. No firmware keys or device secrets.
import { AES, HMAC_SHA1 } from "./crypto.js";
import { N90_UID } from "../apple/uid.js";
import { SHA256 } from "../image/sha256.js";
import { crc32 } from "../android/bytes.js";

const encoder = new TextEncoder();
const ascii = value => encoder.encode(value);
const view = bytes => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const derive = label => new SHA256().update(ascii("v86/N90/10B329/" + label)).digest();
const deviceKey = new Uint8Array(16).fill(1);
new AES(N90_UID).block(deviceKey, 0, false);

// The emulated phone has neither a cellular modem nor a SIM. Native
// SpringBoard reads these booleans before launching Setup Assistant.
export function offline_setup_file()
{
    return {
        path: "/mobile/Library/Preferences/com.apple.purplebuddy.plist",
        uid: 501, gid: 501, mode: 0o600, dir_mode: 0o755,
        bytes: ascii('<?xml version="1.0" encoding="UTF-8"?>\n' +
            '<plist version="1.0"><dict><key>SetupDone</key><true/>' +
            '<key>SetupFinishedAllSteps</key><true/></dict></plist>\n'),
    };
}

function join(parts)
{
    const out = new Uint8Array(parts.reduce((length, bytes) => length + bytes.length, 0));
    let at = 0;
    for(const bytes of parts) { out.set(bytes, at); at += bytes.length; }
    return out;
}

function wrap(bytes)
{
    // RFC 3394, with a fixed 32-byte payload and the N90's synthetic KEK.
    const result = new Uint8Array(40).fill(0xA6), block = new Uint8Array(16), cipher = new AES(deviceKey);
    result.set(bytes, 8);
    for(let t = 1; t <= 24; t++)
    {
        const at = 8 * (1 + (t - 1) % 4);
        block.set(result.subarray(0, 8));
        block.set(result.subarray(at, at + 8), 8);
        cipher.block(block, 0, false);
        block[7] ^= t;
        result.set(block.subarray(0, 8));
        result.set(block.subarray(8), at);
    }
    return result;
}

export function wipe_info()
{
    return { iv: derive("wipe-iv").subarray(0, 16), key: derive("wipe-key") };
}

export function effaceable_unit()
{
    const bytes = new Uint8Array(1024), v = view(bytes), { iv, key } = wipe_info();
    // The second 16-byte field is zero: these are unencrypted boot pages.
    bytes.set(ascii("ecaF"));
    for(const at of [4, 8, 56]) v.setUint32(at, 1, true);
    const wipe = 64;
    v.setUint16(wipe, 0x4C6B, true);
    v.setUint16(wipe + 2, 52, true);
    v.setUint32(wipe + 4, 0x42414731, true);
    v.setUint32(wipe + 8, 0x42414731, true);
    bytes.set(iv, wipe + 12);
    bytes.set(key, wipe + 28);
    const dkey = wipe + 8 + 52, wrapped = wrap(derive("class4"));
    v.setUint16(dkey, 0x4C6B, true);
    v.setUint16(dkey + 2, wrapped.length, true);
    v.setUint32(dkey + 4, 0x446B6579, true);
    bytes.set(wrapped, dkey + 8);
    const end = dkey + 8 + wrapped.length;
    v.setUint16(end, 0x4C6B, true);
    v.setUint32(end + 4, 0x444F4E45, true);
    v.setUint32(60, crc32(bytes.subarray(64), crc32(bytes.subarray(32, 60), crc32(bytes.subarray(0, 16)))), true);
    return bytes;
}

function u32(value)
{
    const bytes = new Uint8Array(4);
    view(bytes).setUint32(0, value);
    return bytes;
}

function field(tag, value)
{
    const bytes = typeof value === "number" ? u32(value) : value;
    return join([ascii(tag), u32(bytes.length), bytes]);
}

// Both keybag plists are small flat dictionaries of ASCII keys, data,
// and unsigned integers. Write only those binary plist object types.
function bag_plist(values)
{
    const prefix = (tag, size) => size < 15 ? Uint8Array.of(tag | size) : join([Uint8Array.of(tag | 15, 0x12), u32(size)]);
    const keys = Object.keys(values), n = keys.length;
    const dict = join([prefix(0xD0, n), Uint8Array.from({ length: n * 2 }, (_, i) => i + 1)]);
    const objects = [dict, ...keys.map(k => join([prefix(0x50, k.length), ascii(k)])),
        ...Object.values(values).map(v => typeof v === "number" ?
            join([Uint8Array.of(0x12), u32(v)]) : join([prefix(0x40, v.length), v]))];
    const offsets = new Uint8Array(objects.length * 4), trailer = new Uint8Array(32), tv = view(trailer);
    let at = 8;
    for(const [i, obj] of objects.entries())
    {
        view(offsets).setUint32(i * 4, at);
        at += obj.length;
    }
    trailer[6] = 4;
    trailer[7] = 1;
    tv.setBigUint64(8, BigInt(objects.length));
    tv.setBigUint64(24, BigInt(at));
    return join([ascii("bplist00"), ...objects, offsets, trailer]);
}

export function systembag()
{
    const hmacKey = derive("bag-hmac");
    const fields = [field("VERS", 3), field("TYPE", 0), field("UUID", derive("bag-uuid").subarray(0, 16)),
        field("HMCK", wrap(hmacKey)), field("WRAP", 1), field("SALT", derive("bag-salt").subarray(0, 20)), field("ITER", 1)];
    const cipher = new AES(deviceKey);
    for(const id of [1, 2, 3, 4, 6, 7, 8, 9, 10, 11])
    {
        const key = derive("class" + id);
        cipher.cbc(key, new Uint8Array(16), false);
        fields.push(field("UUID", derive("uuid" + id).subarray(0, 16)), field("CLAS", id), field("WRAP", 1),
            field("KTYP", 0), field("WPKY", key));
    }
    const data = join(fields);
    // iOS 6 uses the serialized DATA as the HMAC key, not the message.
    const signature = new HMAC_SHA1(data).mac(hmacKey);
    const inner = bag_plist({ KeyBagKeys: join([field("DATA", data), field("SIGN", signature)]) });
    const { iv, key } = wipe_info();
    const pad = 16 - inner.length % 16, payload = join([inner, new Uint8Array(pad).fill(pad)]);
    new AES(key).cbc(payload, iv, false);
    return bag_plist({ _MKBWIPEID: 0x42414731, _MKBIV: iv, _MKBPAYLOAD: payload });
}
