# v86 Render Deployment — Status & To-Do

Last updated: 2026-09-25 ~21:15 UTC  
This file exists so work can be resumed in short sessions.

---

## What This Project Is

**v86** is a browser-based x86 PC emulator (https://copy.sh/v86). It runs ~80 operating systems
(Windows 98, MS-DOS, FreeDOS, Linux, FreeBSD, KolibriOS, Haiku, etc.) entirely in the browser
using WebAssembly.

The goal is to deploy this as a **Render web service** so anyone can visit the URL and boot
any of those OSes in their browser, without depending on copy.sh's servers.

---

## How v86 Works (Architecture)

```
Browser
  └── index.html           (the UI — lists all OSes, has filter/sort UI)
        └── build/v86_all.js   (compiled+minified JS: emulator logic + UI)
              └── build/v86.wasm   (WebAssembly: x86 CPU JIT compiled from Rust)
                    └── images/    (OS disk images: .img, .iso, .bin, .zst files)
```

When you click an OS:
1. `main.js` (compiled into `v86_all.js`) reads the OS profile config
2. It fetches the disk image from either:
   - `images/` (local) — when `ON_LOCALHOST = true`
   - `//i.copy.sh/` (CDN) — when `ON_LOCALHOST = false`
3. The emulator boots the OS using v86.wasm

**Critical detail — `ON_LOCALHOST` logic** (line 9 of `src/browser/main.js`, baked into `v86_all.js`):
```js
const ON_LOCALHOST = !location.hostname.endsWith("copy.sh");
```
This means: if the domain is NOT `copy.sh`, then `ON_LOCALHOST = true`, so images are loaded
from `images/`. **On Render, ON_LOCALHOST will be TRUE**, so images must be served from `images/`.

**Critical detail — SharedArrayBuffer** requires two HTTP headers on EVERY response:
```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```
Without these, v86's JIT (WebAssembly threads) fails silently. The standard Python/Node static
servers do NOT send these — hence a custom server is required.

**Critical detail — Large "chunked" images**: Many OS images are too large to serve as one file.
They are split into parts. For example, Windows 98 (300 MB) is split into 256KB chunks:
- `images/windows98/0-262144.img`
- `images/windows98/262144-524288.img`
- ... (1200 parts)

The server must proxy these chunk requests to `i.copy.sh` if not present locally.

---

## What Has Already Been Done

### ✅ Task 1: Build artifacts downloaded
- `build/v86_all.js` (263 KB) — downloaded from `https://copy.sh/v86/build/v86_all.js`
- `build/v86.wasm` (2.1 MB) — downloaded from GitHub releases `copy/v86` tag `latest`
- These are the compiled production artifacts. No Rust/Closure compiler build needed.

### ✅ Task 2: OS images downloaded (104 files, ~1.5 GB in `images/`)
All **flat** (non-chunked) OS images have been downloaded from `https://i.copy.sh/`.
These are the small-to-medium images that fit as single files:

**Downloaded (104 files):**
- FreeDOS, MS-DOS 4, 86-DOS, IBM Exploring, PC-MOS/386
- Windows 1.01, 2.03, 3.0 (two versions), 3.1
- State snapshots: windows98_state-v2.bin.zst, windows2k_state-v4.bin.zst,
  windows-me_state-v3.bin.zst, serenity_state-v4.bin.zst, reactos_state-v3.bin.zst,
  redox_state-v2.bin.zst, haiku_state-v5.bin.zst, arch_state-v3.bin.zst,
  9front_state-v3.bin.zst, openbsd_state-v2.bin.zst, freebsd_state-v2.bin.zst,
  bsdos43_state.bin
- Linux: buildroot-bzimage.bin, buildroot-bzimage68.bin, nodeos-kernel.bin,
  linux.iso, linux3.iso, linux4.iso, elks-hd32-fat.img, dsl-4.11.rc2.iso,
  xpud-0.9.2.iso, xwoaf_rebuild4.iso, TinyCore-11.0.iso, slitaz-rolling-2024.iso,
  FreeNOS-1.0.3.iso, bl3-5.img (BasicLinux ~100MB), mu-shell.img
- BSD: 9legacy.img, crazierl-elf-2026.img + initrd, mobius-fd-release5.img
- Hobby OSes: HelenOS (both versions), sortix, skift, soso, BoneOS, bleskos, mikeos,
  nanoshell, catkernel, dancy, nopeos, toaruos, os64boot, ipxe, netboot.xyz, SqueakNOS,
  mojo, vanadiumos, prettyos, xenushdd, hOp, jx-demo, bj050, t3xforth, mcp2, leetos,
  newos-flp, newos-notion, snowdrop, openwrt, qnx, asuro
- KolibriOS, oberon, tilck, duskos, sanos, littlekernel, gentleos, curios, chimaeraos,
  forthos, chip4504, quantixos, xcom, doof, os8
- Bootsector games: bootchess, bootbasic, bootlogo, pillman, invaders, bootos-all,
  sectorlisp, sectorforth, floppybird, stillalive-os, hello-v86, tetros, bootdino, bootrogue

**NOT downloaded (proxied at runtime to i.copy.sh):**
These are large chunked images — hundreds of MB to multi-GB each. Too big to store:
- Windows 95, 98, ME, NT 3.1, NT 3.51, NT 4.0, 2000 (chunked .img dirs)
- FreeBSD, NetBSD, OpenBSD, 386BSD, BSD/OS (chunked)
- ReactOS, SerenityOS, Redox, Haiku, BeOS, Syllable (chunked)
- MS-DOS 6.22, FreeGEM, PsychDOS (chunked)
- Arch Linux 9p filesystem, SkiffOS, Android x86 (chunked)
- Minix, 9front, FiwixOS, AROS Broadway, Icaros, TinyAROS (chunked)
- Chokanji, Arch Hurd, Unix V7, ArchHurd (chunked)

**Still missing flat files** (need to be downloaded):
- `arch/` directory (Arch Linux 9p filesystem base) — this is a 9p virtio filesystem,
  complex directory tree, NOT a single flat file. Served from CDN at runtime.
- `fs.json` — the Arch Linux filesystem index. Also CDN.

### ✅ Task 3: server.js created
File: `/workspaces/v86/server.js` (ESM format, 230 lines)

What it does:
- Serves all static files from the project root (index.html, build/, bios/, v86.css, etc.)
- Sets COOP + COEP headers on EVERY response (required for SharedArrayBuffer/JIT)
- Supports HTTP Range requests (required for async chunked image loading)
- For `/images/XXX` requests where the file doesn't exist locally, it proxies the request
  to `https://i.copy.sh/XXX` — this handles all the large chunked images at runtime
- Listens on `process.env.PORT` (Render sets this automatically)

**Note**: `server.js` uses ESM (`import` syntax) because `package.json` has `"type": "module"`.
If it used `require()`, Node.js would reject it.

**Note**: Last test was interrupted before a clean verification run. The server DID work
in an earlier test (confirmed COOP/COEP headers, local file serving, build/v86_all.js serving).
The proxy for chunked images was not fully verified due to the i.copy.sh CDN returning 404
for the directory-style URL `windows2k-v2/.img` (which is correct — that's just the prefix,
not a real URL; actual chunk URLs look like `windows2k-v2/0-262144.img`).

### ✅ Task 4: ON_LOCALHOST logic — no change needed
The existing logic in `v86_all.js` already does the right thing:
- On Render: `ON_LOCALHOST = true` → requests go to `images/` → server serves local or proxies
- The server.js proxy handles the CDN fallback transparently
- No patching of source JS needed

### ✅ Task 5: render.yaml created
File: `/workspaces/v86/render.yaml`

```yaml
services:
  - type: web
    name: v86
    runtime: node
    plan: free
    buildCommand: node --version
    startCommand: node server.js
    envVars:
      - key: PORT
        value: 3000
    headers:
      - path: /*
        name: Cross-Origin-Opener-Policy
        value: same-origin
      ...
```

**Note**: Render also supports setting headers via the dashboard. The `headers:` section in
`render.yaml` is belt-and-suspenders — the server also sets them. Both are needed because
Render may serve some files directly (unlikely for a Node web service, but good practice).

---

## What Still Needs To Be Done

### ❌ Task 6: Final verification
The server needs one more clean test run:

```bash
cd /workspaces/v86
node server.js &
# Test 1: COOP/COEP headers present
curl -sI http://localhost:3000/ | grep -i "cross-origin"
# Test 2: index.html served
curl -s http://localhost:3000/ | head -c 100
# Test 3: v86_all.js served (required for emulator to work)
curl -sI http://localhost:3000/build/v86_all.js | grep "200"
# Test 4: v86.wasm served with correct MIME type
curl -sI http://localhost:3000/build/v86.wasm | grep "application/wasm"
# Test 5: local image served
curl -sI http://localhost:3000/images/freedos722.img | grep "Content-Length"
# Test 6: Range request works (needed for async images)
curl -sI -H "Range: bytes=0-1023" http://localhost:3000/images/freedos722.img | grep "206"
# Test 7: proxy for chunked image works
curl -sI "http://localhost:3000/images/windows98/0-262144.img" | grep "200\|206"
kill %1
```

### ❌ Task 7 (optional but important): .gitignore update
The `images/` directory is currently in `.gitignore`. This means the 1.5GB of downloaded
images will NOT be committed to git. This is intentional for a git repo, but for Render
deployment there are two options:

**Option A — Commit images to git** (simple but repo gets huge):
```bash
# In .gitignore, comment out:  images/
# Then: git add images/ && git commit
```
Pros: Self-contained. Cons: 1.5GB git repo, slow clone, GitHub may reject files >100MB.

**Option B — Download images at build time** (recommended):
Render runs `buildCommand` before starting the server. Change `render.yaml` to:
```yaml
buildCommand: bash download_images.sh
```
This downloads all flat images during Render's build step. The `download_images.sh` script
already exists at `/workspaces/v86/download_images.sh` and skips already-downloaded files.
Cons: Render free plan has limited build time/disk; 1.5GB might hit limits.

**Option C — Skip local images entirely** (easiest):
Modify `server.js` to always proxy `/images/*` to `i.copy.sh`, never serving locally.
Pros: Tiny deployment, instant. Cons: depends on i.copy.sh being up.

**Current status**: Option B is the intended approach (download_images.sh exists).
But `.gitignore` still excludes `images/`, so the downloaded files are not tracked.

### ❌ Task 8 (optional): Missing images to still download
Two flat files referenced in main.js that weren't downloaded:
- `elks-hd32-fat.img` — already downloaded ✓
- The `arch/` filesystem and `fs.json` — these are actually a 9p virtio directory tree
  served from a CDN. They require the Arch Linux base image directory structure which is
  complex and large. Leave as CDN proxy.

Also not yet downloaded (medium-sized, borderline):
- `forthos20.img.zst` — was attempted, may have partial download, check size
- `bl3-5.img` (BasicLinux ~100MB) — downloaded ✓

### ❌ Task 9 (optional): Verify `bios/` directory is served
v86 uses its own BIOS files. Check that index.html references them correctly:
```bash
grep "bios" /workspaces/v86/index.html  # probably not referenced — loaded by JS
grep "bios" /workspaces/v86/src/browser/main.js | head -5
```
The BIOS files in `/workspaces/v86/bios/` (seabios.bin, vgabios.bin, etc.) are served
by the server already since they're in the project root. v86_all.js references them.

---

## File Map

```
/workspaces/v86/
├── index.html              original, untouched — the main UI page
├── v86.css                 original, untouched
├── manifest.json           original, untouched
├── bios/                   original BIOS files (seabios.bin, vgabios.bin, etc.)
├── build/
│   ├── v86_all.js          NEW (263KB) — downloaded from copy.sh production
│   └── v86.wasm            NEW (2.1MB) — downloaded from GitHub releases/latest
├── images/                 NEW — 104 flat OS image files, ~1.5GB total
│   ├── freedos722.img
│   ├── windows101.img
│   ├── kolibri.img
│   ├── ... (101 more)
│   └── (large images not here — proxied to i.copy.sh by server.js)
├── server.js               NEW — Node.js ESM server with COOP/COEP + proxy
├── render.yaml             NEW — Render web service config
├── download_images.sh      NEW — script to (re-)download all flat images
└── DEPLOYMENT_STATUS.md    THIS FILE
```

---

## Key Facts to Remember

1. **`v86_all.js` is a compiled bundle** — it's NOT the same as `src/browser/main.js`.
   Editing `src/browser/main.js` does nothing unless you rebuild with the Closure compiler.
   The downloaded `v86_all.js` is the minified production version from copy.sh.

2. **`ON_LOCALHOST` in the compiled JS** is the variable `yh` (minified name):
   `yh=!location.hostname.endsWith("copy.sh")`
   On Render, `yh = true`, so images come from `images/` path prefix.

3. **SharedArrayBuffer is mandatory** for v86's JIT to function. Without COOP+COEP headers,
   the emulator may appear to work but will run very slowly (falling back to interpreter).

4. **Chunked images** use URL patterns like `images/windows98/0-262144.img` (byte ranges as
   filename). The server proxies any `/images/X` that doesn't exist locally to
   `https://i.copy.sh/X`.

5. **Render's `PORT` env var** is automatically set. server.js reads `process.env.PORT`.

6. **No npm install needed** — server.js uses only Node.js built-in modules (http, https,
   fs, path). No package.json dependencies required.

---

## How to Resume and Deploy

### Step 1: Verify server works locally
```bash
cd /workspaces/v86
node server.js &
curl -sI http://localhost:3000/ | grep -i "cross-origin"
# Should show: Cross-Origin-Opener-Policy: same-origin
kill %1
```

### Step 2: Decide on image strategy (see Task 7 above)
Recommended: Use Option B (build-time download).
Update render.yaml buildCommand to: `bash download_images.sh`

### Step 3: Add images to git or rely on build-time download
```bash
# Option A (commit images - NOT recommended due to size):
# Edit .gitignore: comment out the "images/" line
# git add images/ build/

# Option B (build-time download - RECOMMENDED):
# Just commit server.js, render.yaml, download_images.sh, build/
git add server.js render.yaml download_images.sh build/v86_all.js build/v86.wasm
git commit -m "Add Render deployment: server.js, render.yaml, OS images"
```

### Step 4: Deploy to Render
1. Push to GitHub
2. Create new Render Web Service
3. Connect to the repo
4. Render auto-detects render.yaml
5. Service starts with `node server.js`

### Step 5: Verify deployment
Visit `https://your-app.onrender.com/` — you should see the v86 OS picker.
Click FreeDOS — it should boot (uses local `images/freedos722.img`).
Click Windows 98 — it should boot from state (proxied from i.copy.sh).

---

## Known Issues / Gotchas

- **Render free plan** sleeps after 15min of inactivity. First request after sleep takes ~30s.
- **Render free plan disk** is ephemeral. Downloaded images in `images/` won't persist across
  deploys unless committed to git. Use the buildCommand download approach.
- **GitHub file size limit**: Files over 100MB can't be pushed normally. The images/bl3-5.img
  (100MB), images/dsl-4.11.rc2.iso (51MB) etc. may hit GitHub's soft limits. Use Git LFS
  or the build-time download approach to avoid this.
- **The `bsdos43_state.bin` proxy**: Listed as chunked in analysis but it's actually a flat
  file (no `.` in path suffix for directory notation). It was downloaded locally ✓.
- **`forthos20.img.zst`**: This is a zstd-compressed disk image. v86 decompresses it in
  the browser using the included zstd WASM. Should work fine locally.
- **`windows-me_state-v3.bin.zst`**: The Windows ME state file. The analysis flagged it as
  "chunked" but it's actually a flat state snapshot. Was downloaded locally ✓.
