// GL 2.1 permits different convex interpolation for polygons with >3 edges
// (§3.5.1), and fixed-point alpha precision >= the framebuffer's (§2.14.9,
// §4.1.4). Only these named tiles may use the other driver's actual pixels.
"use strict";
(function(global) {
    const entries = {
        flat_provoking: ["QUADS SMOOTH (gradient)"],
        primitives: ["QUADS x2", "QUADS x2 (2nd)", "QUADS + 3 leftover vertices"],
        glsl_semantics: ["gl_Color interpolation"],
        alpha_test: ["GREATER 0.5, alpha 128/255", "EQUAL 0.5, alpha 128/255", "LEQUAL 0.5, alpha 128/255",
            "NOTEQUAL 0.5, alpha 128/255", "GEQUAL 0.502, alpha 128/255=0.50196"],
    };
    function alternative(scene, primary, other) {
        const names = entries[scene.name]; if (!names) return primary;
        const rgba = Uint8Array.from(primary.rgba);
        for (const name of names) {
            const tile = scene.tiles.find(tile => tile.label === name); if (!tile) throw new Error("Stale oracle policy: " + scene.name + ": " + name);
            for (let y = tile.y; y < tile.y + tile.h; ++y) for (let x = tile.x; x < tile.x + tile.w; ++x) {
                const at = (y * 64 + x) * 4; rgba.set(other.rgba.subarray(at, at + 4), at);
            }
        }
        return { ...primary, rgba };
    }
    const api = { entries, alternative }; global.GLConformanceOraclePolicy = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
