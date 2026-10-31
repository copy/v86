# Desktop GL guest acceptance

Prepare the current driver, diagnostic DLL and CRT-free probe, then cold-boot the owner's XP/Cube 2 images. The HTTP image endpoints are read-only; disk writes, including driver installation and replacing the game DLL, remain in the VM's memory. No saved machine state is used.

```sh
make build/libv86.js build/v86.wasm build/cpu-worker.js build/v86-bochs-vga.js glbridge
node tools/gl_guest_acceptance.mjs
TIMEOUT_MS=1000000 node tests/app/browser_runner.mjs tests/glbridge/gl_guest_acceptance.html isolated=1 webgpu=1 worker=1
```

`worker=0` runs the same page with the CPU on the page. Images are `windowsxp/windowsxp_multidisk_C_4G.img` and `game/cube2.img` in the sibling site checkout. `build/gl-guest/tools.iso` is a separate test CD. The script updates the service in the memory overlay, checks current `GL_VENDOR`/`GL_VERSION`, compiles and links GLSL 1.20 through the guest ABI, draws a triangle and checks `glGetError`. Only a successful probe permits Cube 2 to launch. It copies the DLL beside `bin/sauerbraten.exe`, rather than the portable launcher.

The page waits for XP's cold boot, cancels its hardware wizard, declines its restart prompt and runs the CD's installer. It distinguishes Cube 2's menu assets/shaders from the probe, enters `/map complex`, then requires the map's larger asset/shader set and four more rendering samples with zero renderer refusals, host errors or validation failures. Screenshots and JSON evidence are written to `build/browser-test-output/cube2-{worker,local}-*`.

Different XP images may show different first-boot dialogs. `BROWSER_DEBUG_PORT` exposes the isolated test browser for diagnosing them; `window.runSetup()` retries after dismissing a prompt. A failure to launch is a failed run, not a skipped acceptance test. Serial output is supplementary: an image need not have a working guest COM1 driver.

2026-10-31: current source-built virtio driver and proxy passed a cold XP worker boot, probe and Complex map. The first interactive run recorded 1,027,247 draws and 233 links, with zero refusals, rejected pipelines/frames or host errors. The prepared entry point was then rerun from cold boot. This closes C's real worker render check. Game save/restore, cross-game sequences, other programs and performance remain G acceptance; deployed site images still await F6.
