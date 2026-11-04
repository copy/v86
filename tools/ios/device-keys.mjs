// Simulator-only material shared by the system bag and NAND lockers.
import { createCipheriv, createHash } from "node:crypto";
import { N90_UID } from "../../src/apple/uid.js";

export function derive(label)
{
    return createHash("sha256").update("v86/N90/10B329/" + label).digest();
}

export function encrypt(algorithm, key, iv, bytes, pad = false)
{
    const cipher = createCipheriv(algorithm, key, iv);
    cipher.setAutoPadding(pad);
    return Buffer.concat([cipher.update(bytes), cipher.final()]);
}

export const device_key = encrypt("aes-128-ecb", N90_UID, null, Buffer.alloc(16, 1));

export function wrap_device_key(bytes)
{
    return encrypt("id-aes128-wrap", device_key, Buffer.alloc(8, 0xA6), bytes);
}
