// Deterministic test-map variant for the stock Tremulous GPP renderer. Stock
// Tremulous maps contain no flare surfaces; retain geometry/collision except
// one nearby rendered face, converted to a valid BSP flare in the human base.
import fs from "node:fs";
import crypto from "node:crypto";
import { execFileSync as run } from "node:child_process";
const hash = data => crypto.createHash("sha256").update(data).digest("hex");
function crc32(data)
{
    let crc = 0xFFFFFFFF;
    for(const byte of data) { crc ^= byte;for(let i = 0; i < 8; i++) crc = crc >>> 1 ^ (crc & 1 ? 0xEDB88320 : 0); }
    return (crc ^ 0xFFFFFFFF) >>> 0;
}
function zip(name, data)
{
    const text = Buffer.from(name), crc = crc32(data), head = Buffer.alloc(30), central = Buffer.alloc(46), end = Buffer.alloc(22);
    head.writeUInt32LE(0x04034B50);head.writeUInt16LE(20, 4);head.writeUInt32LE(crc, 14);head.writeUInt32LE(data.length, 18);head.writeUInt32LE(data.length, 22);head.writeUInt16LE(text.length, 26);
    central.writeUInt32LE(0x02014B50);central.writeUInt16LE(20, 4);central.writeUInt16LE(20, 6);central.writeUInt32LE(crc, 16);central.writeUInt32LE(data.length, 20);central.writeUInt32LE(data.length, 24);central.writeUInt16LE(text.length, 28);
    end.writeUInt32LE(0x06054B50);end.writeUInt16LE(1, 8);end.writeUInt16LE(1, 10);end.writeUInt32LE(central.length + text.length, 12);end.writeUInt32LE(head.length + text.length + data.length, 16);
    return Buffer.concat([head, text, data, central, text, end]);
}
export function prepare_scene(map_pak, output)
{
    const original = run("7zz", ["e", "-so", map_pak, "maps/atcs.bsp"], { maxBuffer: 16 << 20 }), bsp = Buffer.from(original);
    if(bsp.subarray(0, 4).toString() !== "IBSP" || bsp.readInt32LE(4) !== 46) throw new Error("Unexpected ATCS BSP version");
    const lump = index => {
        const start = bsp.readUInt32LE(8 + index * 8), length = bsp.readUInt32LE(12 + index * 8);
        if(start < 144 || start + length > bsp.length) throw new Error("Invalid BSP lump");return { start, length };
    };
    const entities = lump(0), text = bsp.subarray(entities.start, entities.start + entities.length).toString("utf8"),
        spawn_entity = text.match(/{[^{}]*"classname"\s+"team_human_spawn"[^{}]*}/)?.[0];
    if(!spawn_entity) throw new Error("ATCS human spawn missing");
    const spawn = spawn_entity.match(/"origin"\s+"([^"]+)"/)?.[1].trim().split(/\s+/).map(Number);
    if(!spawn || spawn.length !== 3 || spawn.some(x => !Number.isFinite(x))) throw new Error("Invalid human spawn");
    const shaders = lump(1), vertices = lump(10), surfaces = lump(13), models = lump(7), names = [],
        first_world = bsp.readUInt32LE(models.start + 24), world_count = bsp.readUInt32LE(models.start + 28);
    for(let i = shaders.start; i < shaders.start + shaders.length; i += 72)
        names.push({ name: bsp.subarray(i, i + 64).toString().split("\0")[0], flags: bsp.readUInt32LE(i + 64) });
    let selected = -1, best = Infinity;
    if((first_world + world_count) * 104 > surfaces.length) throw new Error("Invalid world surface range");
    for(let i = first_world; i < first_world + world_count; i++) {
        const at = surfaces.start + i * 104, shader = names[bsp.readUInt32LE(at)], first = bsp.readUInt32LE(at + 12), count = bsp.readUInt32LE(at + 16);
        if(bsp.readUInt32LE(at + 8) !== 1 || !count || !shader || shader.flags & 0x80 || (first + count) * 44 > vertices.length) continue;
        const center = [0, 0, 0];for(let v = 0; v < count; v++) for(let axis = 0; axis < 3; axis++) center[axis] += bsp.readFloatLE(vertices.start + (first + v) * 44 + axis * 4) / count;
        const distance = center.reduce((n, x, j) => n + (x - spawn[j]) ** 2, 0);
        if(distance < best) { best = distance;selected = i; }
    }
    if(selected < 0) throw new Error("No visible human-base surface");
    const at = surfaces.start + selected * 104, origin = [spawn[0] + 128, spawn[1], spawn[2] + 96], normal = [-1, 0, 0], color = [1, .75, .25];
    bsp.writeInt32LE(4, at + 8);
    for(const [offset, vector] of [[48, origin], [60, color], [84, normal]]) for(let i = 0; i < 3; i++) bsp.writeFloatLE(vector[i], at + offset + i * 4);
    // Lump offsets, leaf membership, all other surfaces and collision stay
    // byte-exact. The new override lives in its own pk3; originals are retained.
    for(let i = 0; i < bsp.length; i++) if((i < at || i >= at + 104) && bsp[i] !== original[i]) throw new Error("Unrelated map bytes changed");
    const packed = zip("maps/atcs.bsp", bsp);fs.writeFileSync(output, packed);
    run("7zz", ["t", output], { stdio: "pipe" });
    return { map: "atcs", sourcePakSha256: hash(fs.readFileSync(map_pak)), originalBspSha256: hash(original), bspSha256: hash(bsp), pk3Sha256: hash(packed), surface: selected,
        originalShader: names[bsp.readUInt32LE(at)].name, spawn, origin, normal, color, camera: [spawn[0], spawn[1], spawn[2] + 48, 0],
        scope: "One planar surface becomes a flare; separate test-only pk3. Stock engine, source map, collision and remaining map bytes unchanged." };
}
