// Android Verified Boot (external/avb/libavb): vbmeta structs and their
// descriptors, the digest a bootloader passes to the kernel, and dm-verity
// hash trees (docs/android-images-plan.md I1). Big-endian structures.

import { u32be, u64be, put32be, put64be, latin1, c_string, concat, sha256, sha256_hex } from "./bytes.js";

const AVB_HEADER_SIZE = 256;
/** vbmeta's flags: hash trees off, verification off (avbtool --disable-verity, --disable-verification) */
export const AVB_FLAG_HASHTREE_DISABLED = 1, AVB_FLAG_VERIFICATION_DISABLED = 2;

/**
 * A vbmeta struct (header, authentication and auxiliary blocks) at offset
 * @param {!Uint8Array} bytes
 * @param {number=} offset
 * @return {{struct: !Uint8Array, descriptors: !Array<{tag: number, partition: (string|undefined)}>, flags: number}}
 */
export function vbmeta_struct(bytes, offset = 0)
{
    if(latin1(bytes, offset, offset + 4) !== "AVB0") throw new Error("no vbmeta");
    const auth = u64be(bytes, offset + 12), aux = u64be(bytes, offset + 20);
    const struct = bytes.subarray(offset, offset + AVB_HEADER_SIZE + auth + aux);
    const descriptors = [];
    const start = AVB_HEADER_SIZE + auth + u64be(struct, 96), end = start + u64be(struct, 104);
    for(let at = start; at < end;)
    {
        const tag = u64be(struct, at), following = u64be(struct, at + 8);
        if(tag === 4)
        {
            // chain partition: rollback_index_location, partition_name_len, public_key_len, flags, reserved[60]
            const name_length = u32be(struct, at + 20);
            descriptors.push({ tag, partition: latin1(struct, at + 92, at + 92 + name_length) });
        }
        else if(tag === 1 || tag === 2)
        {
            // hashtree (1) / hash (2): the partition name follows the fixed part
            const fixed = tag === 1 ? 180 : 132, name_length = u32be(struct, at + (tag === 1 ? 104 : 56));
            descriptors.push({ tag, partition: latin1(struct, at + fixed, at + fixed + name_length) });
        }
        else descriptors.push({ tag });
        at += 16 + following;
    }
    return { struct, descriptors, flags: u32be(struct, 120) };
}

/**
 * A partition image's vbmeta: through its footer, else at its start
 * @param {!Uint8Array} bytes
 */
export function partition_vbmeta(bytes)
{
    const footer = bytes.length - 64;
    if(footer >= 0 && latin1(bytes, footer, footer + 4) === "AVBf")
    {
        return vbmeta_struct(bytes, u64be(bytes, footer + 20));
    }
    return vbmeta_struct(bytes);
}

/**
 * The digest a bootloader passes as androidboot.vbmeta.digest: sha256 of
 * the vbmeta structs in libavb's load order (depth first). With
 * verification disabled in vbmeta's flags libavb loads vbmeta alone.
 * @param {function(string): !Uint8Array} read_partition
 * @return {{digest: string, size: number, chained: !Array<string>}}
 */
export function vbmeta_digest(read_partition)
{
    const structs = [];
    const root = vbmeta_struct(read_partition("vbmeta"));
    const verify = !(root.flags & AVB_FLAG_VERIFICATION_DISABLED);
    const visit = vbmeta =>
    {
        structs.push(vbmeta.struct);
        if(!verify) return;
        for(const d of vbmeta.descriptors)
        {
            if(d.tag === 4) visit(partition_vbmeta(read_partition(/** @type {string} */ (d.partition))));
        }
    };
    visit(root);
    const all = concat(structs);
    return { digest: sha256_hex(all), size: all.length,
        chained: verify ? root.descriptors.filter(d => d.tag === 4).map(d => /** @type {string} */ (d.partition)) : [] };
}

/**
 * A hashtree descriptor's fields in a vbmeta struct (offsets into bytes)
 * @param {!Uint8Array} bytes
 * @param {string} partition
 */
export function hashtree_descriptor(bytes, partition)
{
    const auth = u64be(bytes, 12);
    const start = AVB_HEADER_SIZE + auth + u64be(bytes, 96), end = start + u64be(bytes, 104);
    for(let at = start; at < end; at += 16 + u64be(bytes, at + 8))
    {
        if(u64be(bytes, at) !== 1) continue;
        const name_length = u32be(bytes, at + 104), salt_length = u32be(bytes, at + 108);
        if(latin1(bytes, at + 180, at + 180 + name_length) !== partition) continue;
        const salt = at + 180 + name_length;
        return { at, image_size: u64be(bytes, at + 20), data_block: u32be(bytes, at + 44),
            hash_block: u32be(bytes, at + 48), algorithm: c_string(bytes, at + 72, 32),
            salt: bytes.subarray(salt, salt + salt_length), digest: salt + salt_length, digest_length: u32be(bytes, at + 112) };
    }
    throw new Error("vbmeta: no hashtree descriptor for " + partition);
}

/**
 * dm-verity's hash tree of image as avbtool makes it (the top level first)
 * and its root digest
 * @param {!Uint8Array} image
 * @param {!Uint8Array} salt
 * @param {number=} block
 * @return {{root: !Uint8Array, tree: !Uint8Array}}
 */
export function avb_hashtree(image, salt, block = 4096)
{
    const levels = [];
    let level = image;
    while(level.length > block)
    {
        const count = Math.ceil(level.length / block);
        const next = new Uint8Array(Math.ceil(count * 32 / block) * block);
        const data = new Uint8Array(block);
        for(let i = 0; i < count; i++)
        {
            data.fill(0);
            data.set(level.subarray(i * block, Math.min(level.length, (i + 1) * block)));
            next.set(sha256(salt, data), i * 32);
        }
        levels.unshift(next);
        level = next;
    }
    return { root: sha256(salt, level), tree: concat(levels) };
}

/**
 * A hashtree descriptor (in vbmeta bytes, changed in place) set to image's
 * size and a tree's size and root digest, without FEC
 * @param {!Uint8Array} bytes
 * @param {!Object} descriptor hashtree_descriptor's
 * @param {number} image_size
 * @param {number} tree_size
 * @param {!Uint8Array} root
 */
export function set_hashtree(bytes, descriptor, image_size, tree_size, root)
{
    const d = descriptor.at;
    put64be(bytes, d + 20, image_size);
    put64be(bytes, d + 28, image_size);
    put64be(bytes, d + 36, tree_size);
    // (no FEC)
    put32be(bytes, d + 52, 0);
    put64be(bytes, d + 56, 0);
    put64be(bytes, d + 64, 0);
    bytes.set(root, descriptor.digest);
}
