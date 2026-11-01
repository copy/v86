// Prepare a private diagnostic replay. Never changes production renderer code,
// game inputs, the frozen golden image or the finite pixel policy.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
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
const query = new URLSearchParams({ prefix, policy: "frozen", label: "legacy-unorm-" + Date.now() });
process.stdout.write("../../build/d3d-review/replay_legacy_unorm.html?" + query + "\n");
