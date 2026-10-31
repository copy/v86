# OpenGL executor measurements

The dated JSON files retain the input revision, source/harness hashes and raw
measurements. Synthetic workloads isolate individual changes. The actual-game
recordings in `game_traces_20261031.json` cover Cube 2 `complex` and Warcraft III
`Maps/(2)PlunderIsle.w3m`, captured from XP in CPU-worker mode with this proxy.
The PNG files show the captured scenes.

Each game recording starts with a portable GPU checkpoint and contains 64 frame
boundaries. Replays exclude checkpoint restoration, packet cloning and GPU
completion from the CPU timer; four frames warm up the executor, and 60 are
measured. Cube 2 uses three alternating candidate/baseline pairs, Warcraft III
five. CPU authority and VM execution are not timed by replay; D5 leaves the
CPU-authority files unchanged. The comparison covers the CPU component changed
by D5, against exact product sources from `7ac45133`.

Cube 2 has identical final pixels across all six runs. Warcraft III baseline
repeats vary at 14 of 226736 positions on this host, including boundary and
transparent pixels; the underlying cause has not been established. All stable
positions must match exactly. At each reference-variable position, a candidate
must produce an RGBA tuple actually observed there in a baseline run. The report
retains every position and tuple. It permits no component ranges or new values.
The comparison policy has an independent behavior test.

## Reproduce

1. Build the emulator and graphics bundle, then prepare the read-only installer:
   `node tools/gl_guest_acceptance.mjs` or add `--game=warcraft3`.
   The existing site system/game images are required. Installation writes only
   to the VM's in-memory disk overlay. Source image sizes/timestamps are checked.
2. Run `tests/glbridge/gl_guest_trace_capture.html` through
   `tests/app/browser_runner.mjs` with `isolated=1 webgpu=1 worker=1` and
   `game=cube2` or `game=warcraft3`. Use `TIMEOUT_MS=1000000`.
   Warcraft III startup movies are skipped while waiting for its GL context.
3. Extract `git archive 7ac45133 src/browser/glbridge tests/glbridge` into a
   separate directory. Copy only the trace replay HTML/codec from this checkout.
   The shared HTML also loads `gl_bind_layouts.js`; copying that script satisfies
   the script list, while the baseline executor does not reference it. Link the
   baseline's `build/browser-test-output` to this checkout's output directory.
4. Run `gl_game_trace_replay_browser_test.html?game=GAME&label=LABEL-N` with
   `gl_multipass_browser_runner.js`, alternating candidate/baseline directories
   and labels, never concurrently. Use labels `candidate-1`/`baseline-1`, etc.
5. Set `GL_TRACE_BASELINE_ROOT` to the extracted baseline directory and run
   `node tools/gl_game_trace_report.mjs`. The report verifies all baseline
   JavaScript product sources against git, then checks draw counts, pixels,
   errors, median and p95 at the browser's 0.1 ms timer resolution.

Large GPU checkpoints and recordings remain generated files in
`build/browser-test-output`; their byte lengths and SHA-256 values are retained
in the tracked report. `make glbridge-gpu-tests` exercises the same checkpoint,
container and replay path with a small deterministic fixture independently of
the game images. Full application acceptance, including local CPU mode and VM
save/restore, belongs to plan G.
