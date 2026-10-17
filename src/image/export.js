// Export of a hard disk as the guest sees it (docs/disk-image-formats-plan.md
// P2): a RAW stream of the disk's whole size, the image's data with the
// guest's writes, in order, with progress, cancellation and the writer's
// backpressure (write may return a promise). Any disk buffer: a disk image
// (src/image/disk_image.js) or one of src/buffer.js. The caller stops the
// machine and waits for its disk I/O first (v86.prototype.export_disk), so
// the stream is one view of the disk.

import { DiskImageError } from "./source.js";

// the most bytes in one chunk (STATE_STREAM_CHUNK_SIZE: the CPU Worker sends
// them to the page as they are)
export const EXPORT_CHUNK_SIZE = 1024 * 1024;

/**
 * @param {?} buffer the disk's buffer
 * @param {function(!Uint8Array):(Promise<*>|undefined)} write
 * @param {{progress: (function({loaded: number, total: number})|undefined),
 *          signal: (AbortSignal|undefined), chunk_size: (number|undefined)}=} options
 * @return {!Promise<number>} the size written
 */
export async function export_raw(buffer, write, options)
{
    if(!buffer) throw new DiskImageError("No disk", "config");
    const total = buffer.byteLength;
    const chunk_size = Math.max(512, Math.min(EXPORT_CHUNK_SIZE, options && options.chunk_size || EXPORT_CHUNK_SIZE) & ~511);
    const progress = options && options.progress;
    const signal = options && options.signal;
    progress && progress({ loaded: 0, total });
    for(let offset = 0; offset < total;)
    {
        if(signal && signal.aborted) throw new DiskImageError("The export was cancelled at " + offset + " of " + total + " bytes", "io");
        const length = Math.min(chunk_size, total - offset);
        const data = await new Promise((resolve, reject) =>
        {
            buffer.get(offset, length, (data, error) =>
            {
                if(error || !data) reject(error || new DiskImageError("The disk returned no data at " + offset, "io"));
                else resolve(data);
            });
        });
        // (a copy: the buffer's view may be of memory that changes, and the
        // writer may transfer what it gets)
        await write(data.slice());
        offset += length;
        progress && progress({ loaded: offset, total });
    }
    return total;
}
