// Export of a hard disk as a new QCOW2 image (docs/disk-image-formats-plan.md
// P5): version 3, clusters of 64 KiB, 16-bit refcounts, no compression, no
// parent, the clusters that are all zeros left out. The stream is written
// in order, so the image's layout is decided first: a first pass over the
// disk finds the clusters with data, the second writes the header, the L1
// table, the refcount table and blocks, the L2 tables and the data.
// qemu-img check finds no errors in it (refcounts and copied flags
// consistent).

import { DiskImageError } from "./source.js";
import { big } from "./disk_image.js";

const CLUSTER_BITS = 16;
const CLUSTER_SIZE = 1 << CLUSTER_BITS;
const L2_ENTRIES = CLUSTER_SIZE / 8;
// 16-bit refcounts: entries in a refcount block
const REFCOUNTS_PER_BLOCK = CLUSTER_SIZE / 2;
const COPIED = big(1) << big(63);

// clusters read at once
const READ_CLUSTERS = 16;
// the parts of the disk checked for zeros by the image's metadata first
const SPAN = 256 * 1024 * 1024;

/**
 * @param {?} buffer
 * @param {number} offset
 * @param {number} length
 * @return {!Promise<!Uint8Array>}
 */
function get(buffer, offset, length)
{
    return new Promise((resolve, reject) => buffer.get(offset, length, (data, error) =>
        error || !data ? reject(error || new DiskImageError("The disk returned no data at " + offset, "io")) : resolve(data)));
}

/**
 * The layout of the image for the clusters with data
 * @param {number} size the disk's size
 * @param {!Uint8Array} allocated one byte per cluster: 1 with data
 * @return {!Object}
 */
export function qcow2_layout(size, allocated)
{
    const clusters = allocated.length;
    const l1_size = Math.ceil(clusters / L2_ENTRIES);
    const l1_clusters = Math.max(1, Math.ceil(l1_size * 8 / CLUSTER_SIZE));
    let l2_count = 0;
    const l2_index = new Int32Array(l1_size).fill(-1);
    for(let i = 0; i < l1_size; i++)
    {
        const start = i * L2_ENTRIES;
        for(let c = start; c < Math.min(clusters, start + L2_ENTRIES); c++)
        {
            if(allocated[c])
            {
                l2_index[i] = l2_count++;
                break;
            }
        }
    }
    let data_count = 0;
    for(let c = 0; c < clusters; c++) data_count += allocated[c];
    // the refcount table and blocks cover every cluster, theirs included
    let rb_count = 1, rt_clusters = 1;
    for(;;)
    {
        const total = 1 + l1_clusters + rt_clusters + rb_count + l2_count + data_count;
        const rb_needed = Math.ceil(total / REFCOUNTS_PER_BLOCK);
        const rt_needed = Math.max(1, Math.ceil(rb_needed * 8 / CLUSTER_SIZE));
        if(rb_needed <= rb_count && rt_needed <= rt_clusters) break;
        rb_count = Math.max(rb_count, rb_needed);
        rt_clusters = Math.max(rt_clusters, rt_needed);
    }
    const l1_offset = CLUSTER_SIZE;
    const rt_offset = l1_offset + l1_clusters * CLUSTER_SIZE;
    const rb_offset = rt_offset + rt_clusters * CLUSTER_SIZE;
    const l2_offset = rb_offset + rb_count * CLUSTER_SIZE;
    const data_offset = l2_offset + l2_count * CLUSTER_SIZE;
    const total = data_offset / CLUSTER_SIZE + data_count;
    return { size, clusters, l1_size, l1_clusters, l1_offset, rt_clusters, rt_offset, rb_count, rb_offset,
        l2_count, l2_index, l2_offset, data_count, data_offset, total, file_size: total * CLUSTER_SIZE };
}

/**
 * The header and the tables of the image, in the order of the file
 * @param {!Object} layout
 * @param {!Uint8Array} allocated
 * @return {!Uint8Array} everything up to the data
 */
export function qcow2_metadata(layout, allocated)
{
    const bytes = new Uint8Array(layout.data_offset);
    const view = new DataView(bytes.buffer);
    const u64 = (offset, value) =>
    {
        view.setUint32(offset, Number(value >> big(32)));
        view.setUint32(offset + 4, Number(value & big(0xFFFFFFFF)));
    };
    // the header (version 3, 104 bytes, then the end of the extensions)
    view.setUint32(0, 0x514649FB);
    view.setUint32(4, 3);
    view.setUint32(20, CLUSTER_BITS);
    u64(24, big(layout.size));
    view.setUint32(36, layout.l1_size);
    u64(40, big(layout.l1_offset));
    u64(48, big(layout.rt_offset));
    view.setUint32(56, layout.rt_clusters);
    view.setUint32(96, 4);
    view.setUint32(100, 104);
    // L1 and L2: the clusters with data in order
    let data_cluster = 0;
    for(let i = 0; i < layout.l1_size; i++)
    {
        const table = layout.l2_index[i];
        if(table < 0) continue;
        const table_offset = layout.l2_offset + table * CLUSTER_SIZE;
        u64(layout.l1_offset + i * 8, big(table_offset) | COPIED);
        const start = i * L2_ENTRIES;
        for(let c = start; c < Math.min(layout.clusters, start + L2_ENTRIES); c++)
        {
            if(!allocated[c]) continue;
            u64(table_offset + (c - start) * 8, big(layout.data_offset + data_cluster++ * CLUSTER_SIZE) | COPIED);
        }
    }
    // refcounts: 1 for every cluster of the file
    for(let b = 0; b < layout.rb_count; b++)
    {
        u64(layout.rt_offset + b * 8, big(layout.rb_offset + b * CLUSTER_SIZE));
    }
    for(let c = 0; c < layout.total; c++)
    {
        view.setUint16(layout.rb_offset + c * 2, 1);
    }
    return bytes;
}

/**
 * @param {?} buffer the disk's buffer
 * @param {function(!Uint8Array):(Promise<*>|undefined)} write
 * @param {{progress: (function({phase: string, loaded: number, total: number})|undefined),
 *          signal: (AbortSignal|undefined)}=} options
 * @return {!Promise<number>} the image's size
 */
export async function export_qcow2(buffer, write, options)
{
    const size = buffer.byteLength;
    if(size % 512) throw new DiskImageError("The disk's size " + size + " is not a multiple of 512 bytes", "unsupported");
    const progress = options && options.progress;
    const signal = options && options.signal;
    const check = () =>
    {
        if(signal && signal.aborted) throw new DiskImageError("The export was cancelled", "io");
    };
    const clusters = Math.ceil(size / CLUSTER_SIZE);
    const read_cluster_run = async first =>
    {
        const start = first * CLUSTER_SIZE;
        const length = Math.min(size - start, READ_CLUSTERS * CLUSTER_SIZE);
        return get(buffer, start, length);
    };

    // which clusters have data: the parts that read as zeros by a disk
    // image's metadata and have no guest writes are not read (a large
    // sparse disk), spans of 256 MiB first, then groups of READ_CLUSTERS
    const allocated = new Uint8Array(clusters);
    const group_size = READ_CLUSTERS * CLUSTER_SIZE;
    const guest_written = new Set();
    if(buffer.overlay)
    {
        for(const [first, , count] of buffer.overlay.runs())
        {
            const start = first * 256, end = start + count * 256;
            for(let g = Math.floor(start / group_size); g <= Math.floor((end - 1) / group_size); g++) guest_written.add(g);
        }
    }
    const zero = (offset, length) => !buffer.reader ? Promise.resolve(false) :
        new Promise(resolve => buffer.reader.is_zero(offset, length, (is_zero, error) => resolve(!error && is_zero)));
    const groups_per_span = SPAN / group_size;
    for(let span = 0; span * SPAN < size; span++)
    {
        check();
        const span_start = span * SPAN, span_length = Math.min(SPAN, size - span_start);
        let touched = false;
        for(let g = span * groups_per_span; g < (span + 1) * groups_per_span && !touched; g++) touched = guest_written.has(g);
        if(!touched && await zero(span_start, span_length)) continue;
        for(let g = span * groups_per_span; g * group_size < Math.min(size, span_start + SPAN); g++)
        {
            const c = g * READ_CLUSTERS;
            const group_start = g * group_size;
            if(!guest_written.has(g) && await zero(group_start, Math.min(group_size, size - group_start))) continue;
            check();
            const data = await read_cluster_run(c);
            for(let i = 0; i < READ_CLUSTERS && c + i < clusters; i++)
            {
                const part = data.subarray(i * CLUSTER_SIZE, (i + 1) * CLUSTER_SIZE);
                for(let j = 0; j < part.length; j++)
                {
                    if(part[j])
                    {
                        allocated[c + i] = 1;
                        break;
                    }
                }
            }
        }
        progress && progress({ phase: "scan", loaded: span_start + span_length, total: size });
    }
    const layout = qcow2_layout(size, allocated);
    const metadata = qcow2_metadata(layout, allocated);
    progress && progress({ phase: "write", loaded: 0, total: layout.file_size });
    for(let offset = 0; offset < metadata.length; offset += 1024 * 1024)
    {
        check();
        await write(metadata.slice(offset, offset + 1024 * 1024));
    }
    let written = metadata.length;
    for(let c = 0; c < clusters; c += READ_CLUSTERS)
    {
        let any = false;
        for(let i = 0; i < READ_CLUSTERS && c + i < clusters; i++) any = any || !!allocated[c + i];
        if(!any) continue;
        check();
        const data = await read_cluster_run(c);
        const parts = [];
        for(let i = 0; i < READ_CLUSTERS && c + i < clusters; i++)
        {
            if(!allocated[c + i]) continue;
            const cluster = new Uint8Array(CLUSTER_SIZE);
            cluster.set(data.subarray(i * CLUSTER_SIZE, (i + 1) * CLUSTER_SIZE));
            parts.push(cluster);
        }
        const out = new Uint8Array(parts.length * CLUSTER_SIZE);
        parts.forEach((p, i) => out.set(p, i * CLUSTER_SIZE));
        // (the length first: the writer may transfer the buffer)
        written += out.length;
        await write(out);
        progress && progress({ phase: "write", loaded: written, total: layout.file_size });
    }
    if(written !== layout.file_size)
    {
        throw new DiskImageError("The disk changed during the export (" + written + " bytes written, " + layout.file_size + " planned)", "io");
    }
    return written;
}
