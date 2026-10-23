// A disk service's image written by the Android importer
// (docs/android-images-plan.md I3.2, tools/disk-service.mjs): a write
// session (open, write, close), the importer's writes gathered into runs
// of whole sectors (4 MiB a request). The image is new (zeros): a run's
// last partial sector is sent padded with zeros.

const SECTOR = 512;
const CHUNK = 4 << 20;

/**
 * @param {string} url the image's
 * @param {string=} token the service's, if it needs one
 * @return {!Promise<{write: function(number, !Uint8Array): !Promise, close: function(): !Promise}>}
 */
export async function service_writer(url, token)
{
    const post = async (op, headers = {}, body = undefined) =>
    {
        const all = Object.assign({ "X-V86-Disk-Op": op }, headers);
        if(token) all["Authorization"] = "Bearer " + token;
        const response = await fetch(url, { method: "POST", headers: all, body, cache: "no-store" });
        const answer = await response.json().catch(() => ({}));
        if(!response.ok) throw new Error("the disk service refused " + op + ": " + (answer.error || response.status));
        return answer;
    };
    const open = await post("open");
    const session = { "X-V86-Disk-Session": String(open.session), "X-V86-Disk-Epoch": String(open.epoch) };
    let sequence = 0;
    // the run gathered: its start (whole sectors) and bytes
    let start = -1, buffer = new Uint8Array(CHUNK + SECTOR), length = 0;
    const send = async (offset, bytes) =>
    {
        await post("write", Object.assign({ "X-V86-Disk-Sequence": String(++sequence), "X-V86-Disk-Offset": String(offset) }, session), bytes);
    };
    // (whole sectors sent; the rest kept, or with end padded and sent)
    const flush = async end =>
    {
        if(start < 0) return;
        const whole = end ? Math.ceil(length / SECTOR) * SECTOR : Math.floor(length / SECTOR) * SECTOR;
        if(whole)
        {
            if(whole > length) buffer.fill(0, length, whole);
            await send(start, buffer.slice(0, whole));
        }
        if(end || whole >= length)
        {
            start = -1;
            length = 0;
            return;
        }
        buffer.copyWithin(0, whole, length);
        start += whole;
        length -= whole;
    };
    return {
        async write(offset, bytes)
        {
            for(let at = 0; at < bytes.length;)
            {
                if(start < 0 || offset + at !== start + length)
                {
                    await flush(true);
                    // (a run begins on a sector: the importer's partitions do)
                    if((offset + at) % SECTOR) throw new Error("the disk service: a write at " + (offset + at) + ", within a sector");
                    start = offset + at;
                }
                const n = Math.min(bytes.length - at, CHUNK - length);
                buffer.set(bytes.subarray(at, at + n), length);
                length += n;
                at += n;
                if(length >= CHUNK) await flush(false);
            }
        },
        async close()
        {
            await flush(true);
            await post("close", session);
        },
    };
}
