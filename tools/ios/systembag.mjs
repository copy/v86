// Construct an iOS 6 system keybag for this simulated N90's UID and BAG1.
// All material is reproducible so a newly provisioned disk matches its board.
import { createCipheriv, createHash, createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
import { N90_UID } from "../../src/apple/uid.js";
import { wipe_info } from "./lockers.mjs";

function derive(label)
{
    return createHash("sha256").update("v86/N90/10B329/" + label).digest();
}

function number(value)
{
    const out = Buffer.alloc(4);
    out.writeUInt32BE(value);
    return out;
}

function field(tag, value)
{
    const bytes = typeof value === "number" ? number(value) : value;
    return Buffer.concat([Buffer.from(tag), number(bytes.length), bytes]);
}

function encrypt(algorithm, key, iv, bytes, pad = false)
{
    const cipher = createCipheriv(algorithm, key, iv);
    cipher.setAutoPadding(pad);
    return Buffer.concat([cipher.update(bytes), cipher.final()]);
}

function plist(values)
{
    const entries = Object.entries(values).map(([key, value]) => "<key>" + key + "</key>" +
        (typeof value === "number" ? "<integer>" + value + "</integer>" : "<data>" + value.toString("base64") + "</data>"));
    return execFileSync("/usr/bin/plutil", ["-convert", "binary1", "-o", "-", "--", "-"],
        { input: '<?xml version="1.0"?><plist version="1.0"><dict>' + entries.join("") + "</dict></plist>" });
}

export function systembag()
{
    const deviceKey = encrypt("aes-128-ecb", N90_UID, null, Buffer.alloc(16, 1));
    const wrap = bytes => encrypt("id-aes128-wrap", deviceKey, Buffer.alloc(8, 0xA6), bytes);
    const hmacKey = derive("bag-hmac");
    const fields = [field("VERS", 3), field("TYPE", 0), field("UUID", derive("bag-uuid").subarray(0, 16)),
        field("HMCK", wrap(hmacKey)), field("WRAP", 1), field("SALT", derive("bag-salt").subarray(0, 20)), field("ITER", 1)];
    for(const id of [1, 2, 3, 4, 6, 7, 8, 9, 10, 11])
    {
        fields.push(field("UUID", derive("uuid" + id).subarray(0, 16)), field("CLAS", id), field("WRAP", 1),
            field("KTYP", 0), field("WPKY", wrap(derive("class" + id))));
    }
    const data = Buffer.concat(fields);
    // iOS 6 signs the unwrapped HMCK using the serialized DATA as its HMAC key.
    const signature = createHmac("sha1", data).update(hmacKey).digest();
    const inner = plist({ KeyBagKeys: Buffer.concat([field("DATA", data), field("SIGN", signature)]) });
    const { iv, key } = wipe_info();
    return plist({ _MKBWIPEID: 0x42414731, _MKBIV: iv, _MKBPAYLOAD: encrypt("aes-256-cbc", key, iv, inner, true) });
}
