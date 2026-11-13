// Single-core N90 trust publication. The boot loader reserves this memory;
// immutable nodes preserve in-flight AMFI lookups. Only the list head changes.
import { SHA256 } from "../image/sha256.js";
export const IOS_TRUST_ARENA_BYTES = 128 << 10;
export const IOS_TRUST_HEAD_PHYSICAL = 0x40423B3C;
export const IOS_STATIC_TRUST_HEAD = 0x80424120;
const decode = h => Uint8Array.from(h.match(/../g), x => parseInt(x, 16));

export function validate_runtime_arena(arena)
{
    if(!arena || !Number.isSafeInteger(arena.physical) || arena.physical < 0x40400000 ||
        arena.physical + arena.size > 0x60000000 || arena.virtual !== arena.physical + 0x40000000 ||
        arena.physical % 4096 || arena.size !== IOS_TRUST_ARENA_BYTES ||
        !Number.isInteger(arena.used) || arena.used < 0 || arena.used > arena.size || arena.used % 16 ||
        (!arena.used ? arena.head !== IOS_STATIC_TRUST_HEAD :
            !Number.isInteger(arena.head) || arena.head < arena.virtual || arena.head >= arena.virtual + arena.used || arena.head % 16))
        throw new Error("Invalid iPhone trust arena");
    return arena;
}

export function runtime_trust_node(arena, hashes)
{
    validate_runtime_arena(arena);
    if(!Array.isArray(hashes) || !hashes.length || hashes.some(h => typeof h !== "string" || !/^[0-9a-f]{40}$/.test(h)))
        throw new Error("Invalid iPhone runtime code hashes");
    const unique = [...new Set(hashes)].sort(), length = Math.ceil((24 + unique.length * 20) / 16) * 16;
    if(arena.used + length > arena.size) throw new Error("Restart the iPhone before installing more applications: runtime code trust memory is full");
    const bytes = new Uint8Array(length), v = new DataView(bytes.buffer);
    v.setUint32(0, arena.head, true); v.setUint32(20, unique.length, true);
    unique.forEach((h, i) => bytes.set(decode(h), 24 + i * 20));
    bytes.set(new SHA256().update(bytes.subarray(24, 24 + unique.length * 20)).digest().subarray(0, 16), 4);
    return { bytes, physical: arena.physical + arena.used, virtual: arena.virtual + arena.used, used: arena.used + length };
}

export function publish_runtime_trust(cpu, arena, hashes)
{
    const current = cpu.read_blob_physical(IOS_TRUST_HEAD_PHYSICAL, 4);
    if(new DataView(current.buffer, current.byteOffset, 4).getUint32(0, true) !== arena.head)
        throw new Error("The iPhone kernel's code trust head changed unexpectedly");
    const node = runtime_trust_node(arena, hashes);
    cpu.write_blob_physical(node.bytes, node.physical);
    const pointer = new Uint8Array(4); new DataView(pointer.buffer).setUint32(0, node.virtual, true);
    cpu.write_blob_physical(pointer, IOS_TRUST_HEAD_PHYSICAL);
    arena.used = node.used; arena.head = node.virtual;
}
