// 10B329's I2C byte-copy loops narrow the index to uint8 even though the
// request length and controller FIFO can hold 256 bytes. Under slow CPU
// emulation the gyro batches enough samples to reach exactly that length:
// the index wraps to zero and XNU never leaves the read loop. Keep the
// full counter; perform the same real reads/writes and completion checks.
const UUID = "3bfc23e42eb53dad9d909e79ac235537";
const LOOPS = [
    [0x8074EF8C, [0x05, 0x22, 0xE8, 0xB2, 0x88, 0x42, 0xF1, 0xD3], 0x4628], // mov r0, r5
    [0x8074F03A, [0x48, 0x55, 0xF5, 0xB2, 0xD4, 0xF8, 0x98, 0x00], 0x4635], // mov r5, r6
];

/** Apply only to loaded RAM; the owner's kernel file and trust baseline stay intact. */
export function n90_i2c_counters(ram, kernel)
{
    if(kernel.uuid !== UUID) return 0;
    const view = new DataView(ram.buffer, ram.byteOffset, ram.byteLength);
    // Validate every site before changing any byte.
    for(const [va, bytes, replacement] of LOOPS)
    {
        const at = va - 0x80000000;
        if(at < 2 || at + bytes.length - 2 > ram.length ||
            !bytes.every((byte, i) => i === 2 || i === 3 || ram[at - 2 + i] === byte) ||
            ![bytes[2] | bytes[3] << 8, replacement].includes(view.getUint16(at, true)))
            throw new Error("Unexpected 10B329 I2C FIFO loop at 0x" + va.toString(16));
    }
    for(const [va, , replacement] of LOOPS) view.setUint16(va - 0x80000000, replacement, true);
    return LOOPS.length;
}
