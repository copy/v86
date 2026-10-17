// A small QCOW2 image built in memory, for the device tests (they run without
// qemu-img; tests/image/qcow2.mjs checks the reader against qemu-img's
// images): version 3, data clusters where given, zero clusters, damaged L2
// entries on request. The refcounts are not kept (the reader does not read
// them), so qemu-img check would complain.

/**
 * @param {{size: number, cluster_bits?: number, data?: Array<[number, Uint8Array]>,
 *          zero?: Array<number>, damaged?: Array<number>}} options
 *   data: [guest offset (cluster aligned), bytes (whole clusters)];
 *   zero: guest offsets of zero clusters; damaged: guest offsets of clusters
 *   whose L2 entry has a reserved bit set
 * @return {Uint8Array}
 */
export function build_qcow2({ size, cluster_bits = 16, data = [], zero = [], damaged = [] })
{
    const cluster = 2 ** cluster_bits;
    const l2_entries = cluster / 8;
    const l1_size = Math.ceil(size / (cluster * l2_entries));
    const l1_clusters = Math.max(1, Math.ceil(l1_size * 8 / cluster));
    // cluster 0: header, then the L1 table, an empty refcount table, then
    // L2 tables and data as needed
    let next = 1 + l1_clusters + 1;
    const l2_tables = new Map();
    const clusters = [];
    const l2_for = guest =>
    {
        const index = Math.floor(guest / (cluster * l2_entries));
        if(!l2_tables.has(index))
        {
            l2_tables.set(index, { at: next++ * cluster, table: new Uint8Array(cluster) });
        }
        return [l2_tables.get(index), Math.floor(guest / cluster) % l2_entries];
    };
    const set_entry = (guest, value) =>
    {
        const [l2, index] = l2_for(guest);
        new DataView(l2.table.buffer).setBigUint64(index * 8, value);
    };
    for(const [guest, bytes] of data)
    {
        for(let i = 0; i < bytes.length; i += cluster)
        {
            const at = next++ * cluster;
            const chunk = new Uint8Array(cluster);
            chunk.set(bytes.subarray(i, i + cluster));
            clusters.push([at, chunk]);
            set_entry(guest + i, BigInt(at) | 1n << 63n);
        }
    }
    for(const guest of zero) set_entry(guest, 1n);
    for(const guest of damaged) set_entry(guest, BigInt((next + 1000) * cluster) | 2n);

    const image = new Uint8Array(next * cluster);
    const view = new DataView(image.buffer);
    view.setUint32(0, 0x514649FB);
    view.setUint32(4, 3);
    view.setUint32(20, cluster_bits);
    view.setBigUint64(24, BigInt(size));
    view.setUint32(36, l1_size);
    view.setBigUint64(40, BigInt(cluster));
    view.setBigUint64(48, BigInt((1 + l1_clusters) * cluster));
    view.setUint32(56, 1);
    view.setUint32(96, 4);
    view.setUint32(100, 104);
    for(const [index, { at, table }] of l2_tables)
    {
        view.setBigUint64(cluster + index * 8, BigInt(at) | 1n << 63n);
        image.set(table, at);
    }
    for(const [at, chunk] of clusters) image.set(chunk, at);
    return image;
}
