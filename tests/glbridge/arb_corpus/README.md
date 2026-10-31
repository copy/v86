# Genuine Wine and cgc ARB programs (E2B)

`programs.json` contains ten Wine 4.0 plain-blit outputs (five targets, with
and without color keying) and ten NVIDIA Cg Tutorial samples actually compiled
by cgc 3.1.0013 to arbvp1/arbfp1. Original Cg inputs, input hashes, exact compiler
arguments, compiler hash and Wine source hash are retained. These are generated
programs, not hand-authored ARB fixtures labeled as compiler output.

`tools/gl_arb_corpus.mjs` extracts `arbfp_texture_target` and
`arbfp_gen_plain_shader` from the pinned upstream Wine file and compiles them
unchanged against a small GL/string-buffer shim. The shim captures what the
function sends to shader_arb_compile; it does not edit the assembly. It then
runs the actual cgc binary on the selected original Cg examples.

Sources:

- [Wine 4.0 generator](https://raw.githubusercontent.com/wine-mirror/wine/wine-4.0/dlls/wined3d/arb_program_shader.c), SHA-256 `72129e9acdf4b824e9b89a9a299c7df871c74f70b95921085419ac730d774baf`; license retained as `Wine-COPYING.LIB`.
- [NVIDIA Cg 3.1 archive](https://developer.download.nvidia.com/cg/Cg_3.1/Cg-3.1_April2012.dmg), SHA-256 `85c7a0de82252b703191fee5fe7b29f60d357924dc7b8ca59c2badeac7af407d`; compiler SHA-256 `036110e9e78a74f858878b0f340c1546e21d79b3569d06f1343a5efc3ac11c61`. The unchanged NVIDIA license is retained alongside the data. Extraction into the build directory is sufficient; no system installation is needed.

Reproduce with these inputs in `build/gl-e2/` (the Cg extraction at `cg/`):

```sh
node tools/gl_arb_corpus.mjs
node tests/glbridge/gl_conformance/reference/gen_arb_corpus_c.js
node tests/glbridge/gl_arb_generated_test.js
node tests/glbridge/gl_multipass_browser_runner.js gl_arb_corpus_browser_test.html
```

Native C and the GPU test set identical explicit local parameters, constant
textures, attributes and coordinates. Vertex-only samples use a small ARB
fragment shell that makes alpha defined, or a constant fragment shell when
the sample writes no color. This shell is separate from the preserved compiler
output. Fragment-only samples receive the fixed vertex stage. Wine color-key
inputs use an inclusive low/exclusive high range that discards all test texels;
the corresponding plain outputs draw them. Shadow inputs have defined depth
and comparison state. All twenty compile and render on Apple GL, Mesa and
WebGPU, with identical complete RGBA images in both proxy transports.
