// Describe the owned WGSL resource ABI once per shader pair. Explicit layouts
// let compatible pipelines share groups, and group 1 uniforms select slices
// with dynamic offsets rather than allocating a new group for each draw.
(function(global) {
    "use strict";
    function describe(vertex, fragment, vertexActive, fragmentActive) {
        const groups = [], resources = new Map(), dynamicUniforms = [];
        for (const [code, active, visibility] of [[vertex, vertexActive, 1], [fragment, fragmentActive, 2]]) {
            const declarations = /@group\((\d+)\)\s+@binding\((\d+)\)\s+var(?:<([^>]+)>)?\s+\w+\s*:\s*([^;]+);/g;
            for (const match of code.matchAll(declarations)) {
                const group = +match[1], binding = +match[2], key = group + ":" + binding;
                if (!active.has(key)) continue;
                const address = match[3]?.replace(/\s+/g, ""), type = match[4].replace(/\s+/g, ""), old = resources.get(key);
                if (old) {old.visibility |= visibility;continue;}
                const entry = { binding, visibility };
                if (address) {
                    const uniform = address === "uniform";
                    entry.buffer = { type: uniform ? "uniform" : address.includes("read_write") ? "storage" : "read-only-storage",
                        hasDynamicOffset: uniform && group === 1 };
                    if (entry.buffer.hasDynamicOffset) dynamicUniforms.push(binding);
                } else if (type === "sampler" || type === "sampler_comparison") {
                    entry.sampler = { type: type === "sampler_comparison" ? "comparison" : "filtering" };
                } else if (type.startsWith("texture_storage_")) {
                    const storage = type.match(/^texture_storage_(\w+)<([^,]+),([^>]+)>$/);
                    if (!storage) throw new Error("unknown storage texture ABI " + type);
                    entry.storageTexture = { viewDimension: storage[1].replace(/_/g, "-"), format: storage[2],
                        access: storage[3] === "write" ? "write-only" : storage[3] === "read" ? "read-only" : "read-write" };
                } else {
                    const texture = type.match(/^texture_(depth_)?(multisampled_)?(1d|2d|2d_array|3d|cube|cube_array)(?:<([fiu]32)>)?$/);
                    if (!texture) throw new Error("unknown sampled texture ABI " + type);
                    entry.texture = { sampleType: texture[1] ? "depth" : texture[4] === "i32" ? "sint" : texture[4] === "u32" ? "uint" : "float",
                        viewDimension: texture[3].replace(/_/g, "-"), multisampled: !!texture[2] };
                }
                resources.set(key, entry);if (!groups[group]) groups[group] = [];groups[group].push(entry);
            }
        }
        for (let i = 0; i < groups.length; ++i) groups[i] = (groups[i] || []).sort((a, b) => a.binding - b.binding);
        return { groups, dynamicUniforms: dynamicUniforms.sort((a, b) => a - b), active: new Set([...vertexActive, ...fragmentActive]) };
    }
    const api = { describe };global.GLBindLayouts = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
