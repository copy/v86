# Desktop GLSL code-generation experiment (E0)

`desktop_spirv_20261031.json` records the actual glslang 16.6.0 experiment:
source/library/compiler/output hashes, per-case logs and warm timings.
The corpus is 36 literal Cube 2 r6889 pairs and 21 GLSL 1.20 pairs, all accepted
by the production desktop linker. Undefined math requires compilation only.

Both prototypes are isolated from `bios/glslang.wasm`. Route 2 patches relaxed
legacy parsing and built-ins; route 6 parses desktop GLSL, then lowers typed IR
(legacy IO, ftransform, two-sided colors, shared std140 state). Neither rewrites
GLSL text. The patches/header are experiments, not production code.

Route 2 passes 2/57 pairs; route 6 passes 52/57 through SPIR-V and independent
Naga validation. Actual Chrome Tint accepts 38/38 and 108/109 emitted modules,
respectively. Module counts include successful halves of failed pairs.
The AST misses are depth-1D sampling, projected shadow sampling with bias,
opaque aggregate uniforms, and folded Infinity/NaN. Tint independently rejects
`texture_depth_1d`. The complete compiler gate fails: no pixel gate was entered
and no pixel or performance equivalence is claimed. The plan's fallback
applies: retain desktop glslang validation/reflection, repair manual generation
in E1. This measures these prototypes, not a future complete AST compiler.

Reproduce from a pinned `tools/glslang/build.sh` cache, with Emscripten on PATH
(no download, production compiler/cache unchanged):

```sh
sh tools/glslang/build_desktop_spirv_prototype.sh build/wt-refactor/build/glslang
node tools/glslang/desktop_spirv_probe.mjs build/gl-e0-repro/desktop_spirv.wasm
node tests/glbridge/gl_multipass_browser_runner.js gl_desktop_spirv_probe_browser_test.html
```

Use a fresh WORK argument on rebuild. Probe outputs: `build/gl-e0-results`;
Tint output: `build/browser-test-output/gl-e0-tint.json`.
Route timings measure warm SPIR-V generation per pair; GLES reference samples
also include translation. Raw diagnostics are not a timing-gate pass claim.
