# Desktop GL references

`references.json.gz` contains Apple hardware/software results.
`mesa_reference.json.gz` contains Mesa llvmpipe results: 60 pixel scenes and
58 state/query/shader fixtures. The Mesa archive records the driver, package
repository digest and source fingerprints. `gl_mesa_reference_test.js` rejects
stale inputs; ordinary test runs do not need Mesa installed.

On macOS, prepare the offline Alpine repository, then run its isolated VM:

```sh
node tools/alpine_repo.mjs --arch aarch64 --set glref
node tools/gl_mesa_reference.mjs --update
```

`ALPINE_CACHE` can point to an existing pinned Alpine ISO. The VM has no network,
uses read-only input disks and writes a separate results disk. Source files are
unchanged: the `mesa/OpenGL` headers replace CGL setup with a surfaceless desktop
EGL context and load the original extension names. Complete results and logs
remain in `build/gl-reference/` when an individual fixture fails.

On Linux, install Node.js, a C compiler, Mesa EGL/GL development headers and
llvmpipe, then run:

```sh
node tools/gl_mesa_reference.mjs --native --update
```

The Linux mode is also exercised inside the Alpine VM with render-error,
multi-unit shader and single-stage shader fixtures. `GLREF_ONLY` selects fixture
names for diagnosis; selected runs cannot overwrite the complete archive.

Run both pixel references with `make glbridge-gpu-tests`, or select Mesa alone:

```sh
node tests/glbridge/gl_multipass_browser_runner.js 'gl_conformance_browser_test.html?oracle=mesa'
```

`oracle_policy.js` permits the other driver's actual pixels only inside named
tiles. GL 2.1 §3.5.1 permits different convex interpolation for polygons with
more than three edges. Sections 2.14.9/4.1.4 permit different fixed-point alpha
precision above the framebuffer minimum. The rest of every image remains a
strict Mesa comparison; an independent test prevents full-image alternatives.

The following reference limitations are explicit:

- Mesa 26.1.6's quad path applies an offset after switching from fill offset to
  line-only offset. The affected tile uses GL 2.1 §3.5.5's normative red result;
  the raw Mesa output is retained in the archive.
- Neither reference has accumulation storage on the tested FBO. Accumulation
  arithmetic is a separate synthetic reference (§4.2.4); the CPU render tests
  independently reject `Accum` when no accumulation buffer exists.
- Mesa 26.1.6 crashes on the `1 << 30` proxy-width probe. The shared native
  fixture instead requests `MAX_TEXTURE_SIZE + 1`; Apple's results are unchanged.
  CPU tests retain the extreme-size probe and require a safe zero-sized result.
- Apple accepts scalar ARB operands without the grammar's required component
  selector. Pixel fixtures now use explicitly selected PARAM components, which
  both native compilers accept.
- Mesa rejects negative multi-draw counts, which Apple skips. CPU validation
  follows the error behavior; both native error tables are exercised.

The scalar fixtures deliberately retain native differences in limits, storage
selection, errors and state. They are evidence for the C/D audits; collecting
them does not establish that all scalar behavior agrees with both drivers.

Specification: [OpenGL 2.1](https://registry.khronos.org/OpenGL/specs/gl/glspec21.pdf),
[ARB vertex programs](https://registry.khronos.org/OpenGL/extensions/ARB/ARB_vertex_program.txt),
[ARB fragment programs](https://registry.khronos.org/OpenGL/extensions/ARB/ARB_fragment_program.txt).

#### FBO pixel-source errors (2026-10-31)

`reference/framebuffer_pixels.c` contributes 17 Apple/Mesa cases. Missing read depth/stencil, read buffer NONE (also at zero width), stencil writes without storage, and mismatching depth blits are CPU errors; failed reads preserve their destination. Absent buffers in a blit are ignored. Matching compares actual component formats, including fixed/float depth, rather than requested enums: DEPTH_COMPONENT24 allocates 32 bits here/Apple, 24 on Mesa; the fixture records each driver's actual bit depths.

Mesa rejects DrawPixels with depth input and no depth attachment; this profile follows Apple and GL 2.1 §§3.6.4/4.1.6 (coloured fragments, depth test passes without storage). Cross-FBO depth CopyPixels probes crashed the Apple driver and are excluded from the reproducible fixture. Sources: [GL 2.1](https://registry.khronos.org/OpenGL/specs/gl/glspec21.pdf), [EXT_framebuffer_object](https://registry.khronos.org/OpenGL/extensions/EXT/EXT_framebuffer_object.txt), [EXT_framebuffer_blit](https://registry.khronos.org/OpenGL/extensions/EXT/EXT_framebuffer_blit.txt).

#### Renderer diagnostics after D1

The raw pixel page explicitly enables `gl_renderer_diagnostics.js` to inspect its renderer fixture. This adapter exists only under `tests/` and is absent from the product bundle; the old diagnostic helpers/answers are no longer renderer APIs. Raw Node renderer unit tests opt in explicitly. CPU state, C ABI, worker, program-interface and guest acceptance tests use the product renderer without this adapter. `gl_renderer_authority_test.js` loads pristine source and the actual product bundle in isolated runtimes, checks the normal test constructor too, rejects late CPU answers and proves that renderer errors cannot poison GL state or later draws. Renderer snapshots omit and discard the retired error fields, including archives written before D1.

#### Integer pipeline identity (D2)

`gl_cache_keys_test.js` forces every bucket hash to collide and still requires exact descriptor identity. `gl_pipeline_keys_test.js` forces source-hash collisions while checking CPU program/link generations, sharing/name reuse, effective stencil state, dynamic references, colour masks and sample counts. `gl_pipeline_keys_browser_test.html` verifies the corresponding red/blue and stencil pixels on WebGPU in both memory modes. Runtime keys and fixed-function signatures are integer handles backed by complete integer vectors; descriptor fields are collected automatically. Shader modules retain full source equality; source hashes cannot substitute for an object's identity.

E2A adds arb_pipeline: nine scalar grammar probes and twelve full-image
pipeline cases. Scalar selectors are required even for inline constants by
ARB_fragment_program's grammar; Apple accepts the bare scalar POW probe,
whereas validation follows the grammar and Mesa. Each logic-op tile uses an
explicit scissor so native guardband rasterization cannot touch adjacent
tiles. All twelve images, including both MRT images, agree byte for byte
between Apple GL and Mesa before comparison with WebGPU.
