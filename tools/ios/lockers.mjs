// Reproducible simulator-only wipe material, not keys from a device.
import { derive, wrap_device_key } from "./device-keys.mjs";
import { crc32 } from "../../src/android/bytes.js";

export function wipe_info()
{
    return { iv: derive("wipe-iv").subarray(0, 16), key: derive("wipe-key") };
}

export function effaceable_unit()
{
    const unit = Buffer.alloc(1024), { iv, key } = wipe_info();
    // The first two 16-byte fields XOR to the Face header. The second
    // field stays zero on these unencrypted synthetic boot pages.
    unit.write("ecaF");
    unit.writeUInt32LE(1, 4);
    unit.writeUInt32LE(1, 8);
    unit.writeUInt32LE(1, 56);
    const wipe = 64;
    unit.writeUInt16LE(0x4C6B, wipe);
    unit.writeUInt16LE(52, wipe + 2);
    unit.writeUInt32LE(0x42414731, wipe + 4); // BAG1 locker tag
    unit.writeUInt32LE(0x42414731, wipe + 8);
    iv.copy(unit, wipe + 12);
    key.copy(unit, wipe + 28);
    const dkey = wipe + 8 + 52;
    const wrapped = wrap_device_key(derive("class4"));
    unit.writeUInt16LE(0x4C6B, dkey);
    unit.writeUInt16LE(wrapped.length, dkey + 2);
    unit.writeUInt32LE(0x446B6579, dkey + 4); // Dkey for the always-accessible class
    wrapped.copy(unit, dkey + 8);
    const end = dkey + 8 + wrapped.length;
    unit.writeUInt16LE(0x4C6B, end);
    unit.writeUInt32LE(0x444F4E45, end + 4); // DONE
    const crc = crc32(unit.subarray(64), crc32(unit.subarray(32, 60), crc32(unit.subarray(0, 16))));
    unit.writeUInt32LE(crc, 60);
    return unit;
}
