# Desktop OpenGL on WebGPU

The CPU `GLShadow` owns GL state, errors, object names, queries and link metadata.
This directory executes accepted records and owns GPU resources and asynchronous
pixel/query results. See [architecture](../../../../docs/glbridge.md) and the
[implementation plan](../../../../docs/opengl-webgpu-plan.md).

## Retained rendering differences

These are explicit limits, rather than native-conformance passes. The S3 audit
keeps both Apple and Mesa raw results; its browser test separately checks the
current implementation's named differences. Guest deployment and application
acceptance are still stages F6/G.

| Id | Behavior | Evidence / scope |
| --- | --- | --- |
| D-05 | Filled primitives apply user planes with fragment discard. Line/point polygon modes geometrically clip complete vertex outputs first. | `gl_clip_planes_*`, `gl_polygon_clip_*`. Fill clipping can differ in multisample edge coverage/early depth behavior. All six planes are stored and evaluated; non-invariant ARB vertex programs disable user clipping as the extension specifies. |
| D-07 | Occlusion reports a visible predicate as a saturated count, rather than the precise number of passed samples. | WebGPU guarantees visibility, not a GL sample count; query lifetime/availability and generation reuse are tested. |
| D-14 | Drawables are RGBA; color-index rendering is unavailable. | CPU index state/queries are retained; framebuffer format queries report RGBA. |
| D-19 | Explicit `TexImage` border=1 image texels currently participate in the stored image dimensions; border-aware interior dimensions are not implemented. | `gl_s3_render_*: explicit_image_border` checks the current blue edge against native red. This is separate from constant border colors, which are implemented for fixed/GLSL/ARB sampling. |
| D-20 | Widened fixed-point storage can change render/copy precision. Low-bit uploads are quantized, but writes to widened attachments use their WebGPU precision; larger normalized formats use eight-bit storage. | `rgba4_fbo_precision` explicitly records native `[34,68,153,255]` versus current `[26,76,153,255]`. Float formats retain their selected float storage. Defined format identity remains distinct for completeness. |
| D-21 | Ordinary point, line and polygon smoothing is not implemented. Point fade-threshold alpha is stored but not applied. | `smooth_point` checks the square aliased coverage and its difference from native alpha coverage. Multisampled ordinary points have fractional-size circles; point sprites have squares (`gl_single_sample_*`). |
| D-22 | Linear fog with start=end chooses fog factor zero. | The native singular results disagree, including opposite sides of the threshold. `fog_singular_*` retains both and checks the chosen constant-fog behavior explicitly. |
| D-23 | Native BC-backed compressed mip generation is refused by the host. CPU mip metadata is still generated; the renderer's missing levels leave the chain incomplete. | `compressed_mipmap` explicitly requires the `glGenerateMipmap:a compressed level cannot be downsampled` host refusal and resulting green untextured pixel. GL's public error remains CPU-owned. Applications can supply the compressed mip chain. CPU-decoded storage can be downsampled. |
| D-24 | One polygon larger than the temporary GPU storage budget is explicitly refused. Draws containing many smaller polygons split at polygon boundaries. | The S3 Node audit forces the refusal before allocation; `gl_polygon_clip_*` checks bounded batches, ordering and capture leases. |
| D-25 | Rendering to an sRGB texture uses its sRGB WebGPU attachment view, so writes are encoded. A disabled framebuffer-sRGB path is not implemented. | `srgb_fbo_encoding` explicitly checks the encoded pixel against both native drivers' unencoded default. No framebuffer-sRGB extension is advertised. |
| D-26 | WGL interval 0 removes proxy refresh waits; browser compositing can still synchronize display. Positive intervals use real host refresh callbacks, with an implementation maximum of 4. | Actual-C window/default/error tests plus `gl_wgl_swap_*` GPU pixels, callback pacing and cold restore. |
| D-27 | WGL sharing can merge only a target group whose contexts have never been current. An already shared pair is accepted. Used namespaces are refused with `ERROR_BUSY` rather than silently losing objects. | Actual-C context-operations fixture covers whole-group migration, existing sharing and refusal. |
| D-28 | Nonzero `wglCopyContext` masks are explicitly unsupported (`ERROR_CALL_NOT_IMPLEMENTED`); no state-copy success is reported. A zero mask still validates handles, pixel format and destination ownership. | Actual-C context operations plus a mutant that falsely acknowledges a copy. |
| D-29 | WGL outline fonts are explicitly unsupported; bitmap glyphs that GDI cannot produce fail instead of substituting box geometry. Undefined glyphs produce empty lists. | Actual-C A/W glyph bytes, missing/blank glyphs, OOM/GDI failures, unpack/PBO restoration; XP probe compares a Unicode glyph pixel-for-pixel against GDI. |

[The S3 audit](../../../../tests/glbridge/gl_s3_render_browser_test.html) includes
native results for homogeneous eye/light positions, directional spotlights,
point attenuation, RGB DXT1's opaque alpha and polygon-stipple scope. Those
behaviors pass their selected native checks. RGB/RGBA DXT1 changes on the same
shader object update sampling semantics without relinking.

The earlier D-02 separate stencil banks, D-03 constant borders, D-04 wide lines,
D-06 per-draw multisample toggles/readback, D-08 front-buffer presentation,
D-13 finish wait, D-15 depth/stencil pixel operations, D-16 line stipple and
D-18 fixed vertex/ARB fragment pairing have dedicated acceptance fixtures.
Driver differences used by those fixtures are recorded in the plan, rather than
silently widening all pixel tolerances.


## Actual-game replay repeatability

The D5 Warcraft III recording has 14 positions whose RGBA differs across repeated replays of the same pre-D5 executor on this host. Their cause remains unidentified. The performance comparison requires every other pixel to be exact and permits only RGBA tuples observed at each such position in the baseline repeats; current runs introduce no additional values. Positions, tuples, hashes and raw frame times are retained in `tests/glbridge/performance/game_traces_20261031.json`. This is an observed replay limitation, with a strict comparison-policy test and reproducible game capture harness; it is not an assertion of native pixel equivalence for the game.
