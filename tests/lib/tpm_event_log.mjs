// A TPM 2.0 event log (tests/tpm/): replayed, the PCRs it gives.

import assert from "node:assert/strict";
import crypto from "node:crypto";

/**
 * A crypto-agile TCG event log (TCG PC Client Platform Firmware Profile,
 * 10.2): the first event in the SHA-1 format, its Spec ID event naming the
 * digests of the others. The SHA-256 PCRs it extends (from zero; PCR 0 from
 * a startup locality event's locality), and the number of events.
 * @param {!Buffer} log
 * @return {{pcrs: !Map<number, !Buffer>, events: number}}
 */
export function replay(log)
{
    let at = 0;
    const u32 = () => { const value = log.readUInt32LE(at); at += 4; return value; };
    const u16 = () => { const value = log.readUInt16LE(at); at += 2; return value; };
    // the first event: index, type, a SHA-1 digest, the Spec ID event
    u32();
    assert.equal(u32(), 3, "the first event is EV_NO_ACTION");
    at += 20;
    const spec_size = u32(), spec = at;
    assert.equal(log.toString("latin1", spec, spec + 15), "Spec ID Event03", "a crypto-agile log");
    at = spec + 24;
    const sizes = new Map();
    for(let n = u32(); n > 0; n--) sizes.set(u16(), u16());
    assert.ok(sizes.has(0x0B), "SHA-256 digests in the log");
    at = spec + spec_size;
    const pcrs = new Map();
    let events = 0;
    while(at < log.length)
    {
        const index = u32(), type = u32();
        let sha256 = null;
        for(let n = u32(); n > 0; n--)
        {
            const algorithm = u16();
            const digest = log.subarray(at, at + sizes.get(algorithm));
            at += sizes.get(algorithm);
            if(algorithm === 0x0B) sha256 = digest;
        }
        const size = u32();
        const data = log.subarray(at, at + size);
        at += size;
        events++;
        if(type === 3)
        {
            // (EV_NO_ACTION: not extended; "StartupLocality" sets PCR 0's start)
            if(data.toString("latin1", 0, 16) === "StartupLocality\0")
            {
                pcrs.set(0, Buffer.concat([Buffer.alloc(31), data.subarray(16, 17)]));
            }
            continue;
        }
        const old = pcrs.get(index) || Buffer.alloc(32);
        pcrs.set(index, crypto.createHash("sha256").update(Buffer.concat([old, sha256])).digest());
    }
    return { pcrs, events };
}
