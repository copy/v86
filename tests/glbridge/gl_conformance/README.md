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
