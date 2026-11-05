These are unmodified Wine D3D8 and D3D9 stateblock test suites and their
standalone test headers, pinned to commit
`415a275e3844c252ad385b46023095e9401ca234`. `manifest.json` records upstream
URLs, SHA-256 checksums and Git blob identities. The files retain their
copyright notices and LGPL-2.1-or-later license; see `COPYING.LIB`.

Run from the v86 root:

```
GL_SWIFTSHADER=1 node tests/glbridge/d3d_wine_stateblock_xp.mjs
```

The harness verifies source hashes, builds with MinGW, places the current
proxy DLLs beside the test executables, and runs both complete suites in the
installed-driver XP image with a real browser GPU. Windows expectations are
selected explicitly. Test bodies, assertions, expected values and skips are
not patched. `STANDALONE` supplies Wine's main function; the empty
`DECLSPEC_EXPORT` definition bridges a header spelling unavailable in MinGW.

A pass requires both completion summaries, more than 1,000 executed checks
per suite, zero failures/todos/flaky failures/skips, successful process exit,
and two clean owner releases. Missing input or skipped execution is a failure.
Use `D3D_WINE_OUT` to select an artifact directory, `XP_IMAGE` for a compatible
local XP image, and `GL_SWIFTSHADER=0` for the default hardware GPU. All image
writes remain in RAM overlays. Results describe these stateblock suites;
they do not claim the whole Wine device/visual/DirectDraw test collection.
