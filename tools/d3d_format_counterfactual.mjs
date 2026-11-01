// Prepare a private diagnostic replay. Never changes production renderer code,
// game inputs, the frozen golden image or the finite pixel policy.
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire as create_require } from "node:module";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const legacy_textures = process.argv[3] === "--legacy-uploads";
const legacy_buffers = legacy_textures || process.argv[3] === "--legacy-buffers";
if(process.argv[3] && !legacy_buffers) throw new Error("Unknown diagnostic mode");
const prefix = process.argv[2] || "d9wg-warcraft3-worker";
if(!/^[a-z0-9_-]+$/.test(prefix)) throw new Error("Invalid local trace prefix");
const override = `// Private counterfactual: only restore pre-review narrow-UNORM widening.
(function() {
    const F = globalThis.D9WGFormats, original = F.expandRowToGPU;
    F.expandRowToGPU = function(format, source, start, count, destination, out, palette) {
        if (format !== 23 && format !== 24 && format !== 25) return original(format, source, start, count, destination, out, palette);
        for (let i = 0; i < count; i++) {
            const word = source[start + i * 2] | source[start + i * 2 + 1] << 8;
            const greenBits = format === 23 ? 6 : 5;
            destination[out + i * 4] = ((word >>> (greenBits + 5) & 31) * 255 / 31) | 0;
            destination[out + i * 4 + 1] = ((word >>> 5 & (1 << greenBits) - 1) * 255 / ((1 << greenBits) - 1)) | 0;
            destination[out + i * 4 + 2] = ((word & 31) * 255 / 31) | 0;
            destination[out + i * 4 + 3] = format === 25 ? (word >>> 15) * 255 : 255;
        }
    };
})();
`;
const directory = path.join(root, "build/d3d-review");
await fs.mkdir(directory, { recursive: true });
let html = await fs.readFile(path.join(root, "tests/glbridge/d3d_game_trace_replay_browser_test.html"), "utf8");
const original = `        document.write('<script src="' + source + file + '"><\\/script>');`;
if(!html.includes(original)) throw new Error("Replay loader changed; inspect before preparing the counterfactual");
html = html.replace(original, `    {
        document.write('<script src="' + source + file + '"><\\/script>');
        if (file === "d3d9-webgpu/d9wg_formats.js") document.write('<script src="/build/d3d-review/legacy_unorm_override.js"><\\/script>');
    }`).replace('src="d9wg_game_trace.js"', 'src="../../tests/glbridge/d9wg_game_trace.js"');
await fs.writeFile(path.join(directory, "legacy_unorm_override.js"), override);
await fs.writeFile(path.join(directory, "replay_legacy_unorm.html"), html);
if(legacy_buffers) {
    const old = execFileSync("git", ["show", "0f5641e7:src/browser/glbridge/d3d9-webgpu/d3d9_executor.js"], { cwd: root, encoding: "utf8" });
    const methods = ["applyBufferUpdate", ...(legacy_textures ? ["textureShadowFor", "updateTextureShadow", "renameTextureForUpdate", "onUpdateTexture", "uploadPalettizedRegion"] : [])];
    const overrides = methods.map(name => {
        const start = old.indexOf("        " + name + "("), end = old.indexOf("\n        }\n", start);
        if(start < 0 || end < 0) throw new Error("Missing pinned legacy method " + name);
        return "globalThis.D3D9WebGPUExecutor.prototype." + name + " = " + old.slice(start, end + 10).trim().replace(name, "function") + ";";
    }).join("\n");
    const require = create_require(import.meta.url);
    const format_names = Object.keys(require("../src/browser/glbridge/d3d9-webgpu/d9wg_formats.js"));
    const code = `(function() {
        const { ${format_names.join(",")} } = globalThis.D9WGFormats;
        const D9WG = globalThis.D9WGProtocol;
        const RESOURCE_BUFFER_INDEX = 2, BUFFER_USAGE_INDEX = 16, BUFFER_USAGE_VERTEX = 32, BUFFER_USAGE_COPY_DST = 8;
        const D3DLOCK_NOOVERWRITE = 0x1000, D3DLOCK_DISCARD = 0x2000;
        const D3DUSAGE_RENDERTARGET = 1, D3DUSAGE_DEPTHSTENCIL = 2;
        const alignUp = (v, a) => (v + a - 1) & ~(a - 1);
        ${overrides}
    })();`;
    await fs.writeFile(path.join(directory, "legacy_buffer_override.js"), code);
    html = html.replace('if (file === "d3d9-webgpu/d9wg_formats.js")',
        `if (file === "d3d9-webgpu/d3d9_executor.js") document.write('<script src="/build/d3d-review/legacy_buffer_override.js"><\\/script>');
        if (file === "d3d9-webgpu/d9wg_formats.js")`);
    await fs.writeFile(path.join(directory, "replay_legacy_unorm.html"), html);
}
const query = new URLSearchParams({ prefix, policy: "frozen", label: (legacy_textures ? "legacy-unorm-uploads-" : legacy_buffers ? "legacy-unorm-buffers-" : "legacy-unorm-") + Date.now() });
process.stdout.write("../../build/d3d-review/replay_legacy_unorm.html?" + query + "\n");
