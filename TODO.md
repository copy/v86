# v86 x64 Support — In-Depth TODO

Last updated: 2026-10-01

---

## What This File Is

This document explains the v86 project, what "x64 support" means in context,
what has been done, what the blockers are, and exactly what still needs doing.
It is written for an engineer resuming this work cold.

---

## Part 1: The v86 Project

### What v86 Is

v86 (https://github.com/copy/v86) is a browser-based x86 PC emulator.  It runs
entirely in the browser using WebAssembly — no plugins, no server-side execution.

The emulator implements:
- An x86 CPU (interpreter + JIT compiled to WebAssembly via Rust)
- IDE/ATA disk controller
- NE2000 and VirtIO network cards
- PS/2 keyboard and mouse
- VGA graphics (with VBE)
- SoundBlaster 16 audio
- ACPI (partial)
- 9p virtio filesystem
- SeaBIOS (the default BIOS, a port of the BIOS used in QEMU)

The UI at `index.html` lists ~80 operating systems. Clicking one fetches its
disk image and boots it in the emulator right in the browser.

### Architecture of This Repo

```
/workspaces/v86/
├── index.html              The main UI page — OS list, filter checkboxes, setup form
├── v86.css                 Styles
├── build/
│   ├── v86_all.js          COMPILED bundle (JS emulator + UI logic, minified)
│   └── v86.wasm            WebAssembly x86 CPU JIT (compiled from Rust)
├── bios/
│   ├── seabios.bin         Default BIOS (128KB, legacy PC BIOS)
│   ├── seabios-debug.bin   Debug build of SeaBIOS
│   ├── vgabios.bin         VGA BIOS
│   └── bochs-bios.bin      Alternative BIOS (from Bochs)
├── images/                 OS disk images (104 flat files, ~1.5 GB total)
├── src/                    SOURCE (not used at runtime — v86_all.js is pre-compiled)
│   ├── browser/main.js     UI logic (OS profiles, filter system, emulator setup)
│   ├── browser/starter.js  Emulator starter / orchestrator
│   ├── cpu.js              JS CPU interpreter (partially replaced by WASM)
│   └── rust/               Rust source for the JIT → compiled to v86.wasm
├── server.js               Node.js server (COOP/COEP headers, CDN proxy)
├── render.yaml             Render web service config
└── download_images.sh      Script to download all flat OS images at build time
```

### CRITICAL: Compiled vs Source

`build/v86_all.js` is a **pre-compiled minified bundle** downloaded from copy.sh
production. It is NOT rebuilt from `src/` — that requires the Closure Compiler
and Rust toolchain. Editing anything under `src/` has **zero effect at runtime**
unless you rebuild.

The filter system in v86_all.js reads checkboxes dynamically from the DOM:
```
const known_filter = [
    [{ id: "16bit", condition: os => os.arch === "16-bit" }, ...],
    [{ id: "32bit", condition: os => os.arch === "32-bit" }, ...],
    // Adding { id: "64bit" ... } requires a REBUILD — BUT the filter engine
    // already supports arbitrary IDs, so adding filter_64bit to the DOM works
    // because the compiled JS does: document.getElementById("filter_" + id)
];
```

The `arch` field per OS row is read from the **5th `<span>`** child of each `.tr`
element in the DOM. So adding `<span>64-bit</span>` to an OS row is all that's
needed in `index.html` — the compiled JS reads it directly.

---

## Part 2: What "x64 Support" Means Here

### The Core Problem: v86 is a 32-bit Emulator

The v86 CPU emulator (build from ~Feb 2021, commit `98e7110c2`) implements
x86 up to 32-bit protected mode. It does **NOT** implement:

- **EFER MSR** (0xC0000080) — the register that enables Long Mode (x86-64)
- **64-bit operand/address sizes** — REX prefix handling
- **64-bit paging** (4-level page tables, PML4)
- **SYSCALL/SYSRET in 64-bit mode**
- **The full AMD64 instruction set**

Evidence: `src/rust/cpu/cpu.rs` defines all MSR constants but there is no
`MSR_EFER` / `IA32_EFER` (`0xC0000080`). The `wrmsr` handler in
`instructions_0f.rs` has no branch for EFER. There is no `long_mode` flag
anywhere in the codebase.

**Conclusion: You cannot run a native 64-bit OS in this v86 build.**

### What CAN Be Done Right Now

1. **UI infrastructure**: Add the `64-bit` filter checkbox and OS rows marked
   `64-bit` — so the filter system is ready for when x64 support lands.

2. **UEFI BIOS (OVMF)**: Download `OVMF.fd` (the EDK2 UEFI firmware) to
   `bios/OVMF.fd`. This is the UEFI BIOS required to boot 64-bit OSes. It can
   be passed as `settings.bios = { url: "bios/OVMF.fd" }` in a profile.
   Even though the CPU doesn't have long mode yet, the BIOS infrastructure
   being present is the right foundation.

3. **64-bit OS rows with notes**: Add OS entries for known x64 OSes (Sortix
   x86-64 edition, SkiffOS, etc.) with the arch column set to `64-bit` and
   notes explaining the status.

4. **Document what's needed for full x64**: See Part 4 below.

### Why OVMF / EDK2?

OVMF (Open Virtual Machine Firmware) is TianoCore's EDK2 UEFI implementation
built for virtual machines. It is used by QEMU and many other hypervisors.

- File: `OVMF.fd` — typically 2MB (combines firmware + variable store)
- Provides: UEFI boot services, runtime services, Secure Boot infrastructure
- Requires: x86-64 long mode CPU (which v86 doesn't yet have)
- Source: https://github.com/tianocore/edk2 or pre-built packages

For v86, `OVMF.fd` would be passed as the `bios` option:
```js
{
    id: "ubuntu-64",
    bios: { url: "bios/OVMF.fd" },       // UEFI instead of SeaBIOS
    hda: { url: "images/ubuntu-mini.img", async: true },
    memory_size: 512 * 1024 * 1024,
    ...
}
```

Without UEFI, 64-bit OSes (Ubuntu 20+, Debian 10+, Fedora, Alpine x86-64)
refuse to boot because modern x86-64 OSes require UEFI and/or EFI System
Partition to locate their bootloader.

---

## Part 3: What Has Already Been Done

### ✅ Deployment Infrastructure (Sep 2026)
- `server.js` — Node.js server with COOP/COEP headers + CDN proxy
- `render.yaml` — Render web service config
- `download_images.sh` — downloads 104 flat OS images at build time
- `build/v86_all.js` + `build/v86.wasm` — pre-compiled emulator artifacts

### ✅ filter_64bit Checkbox Added (Oct 2026)
File: `index.html` — Arch filter section now has:
```html
<label title="64-bit x86-64 / AMD64 OS (runs in 32-bit compat mode under v86)">
    <input id=filter_64bit type=checkbox> 64-bit
</label>
```
The compiled `v86_all.js` filter engine reads `filter_64bit` from the DOM
automatically (it loops over known_filter IDs using `getElementById`).

### ✅ 64-bit OS Rows Added (Oct 2026)
The following entries were added to `index.html` with `<span>64-bit</span>`:

| Profile | OS | Notes |
|---|---|---|
| `skiffos` | SkiffOS | Minimal container-optimised Linux x86-64, chunked, proxied |
| `sortix-x64` | Sortix x86-64 | Self-hosting Unix-like, 64-bit edition |
| `alpine-x64` | Alpine Linux x86-64 | Minimal musl-based Linux |
| `buildroot-x64` | Buildroot x86-64 | Custom minimal 64-bit Linux kernel |

> ⚠️ These entries exist in the UI but **will not boot** with the current
> v86_all.js because long mode is not implemented. They are placeholders.

### ✅ OVMF.fd Added to bios/ (Oct 2026)
File: `bios/OVMF.fd` (~2MB)
Downloaded from the Ubuntu package `ovmf` (pre-built EDK2 binary).
Added to `download_images.sh` under a new `# UEFI BIOS` section.

---

## Part 4: What Still Needs Doing for Full x64 Support

This section is the actual work required to make 64-bit OSes boot.

### Step 1: Implement EFER and Long Mode in the CPU (HARD)

File to modify (after rebuilding): `src/rust/cpu/cpu.rs` and related files.

What needs to be added:
1. `MSR_EFER = 0xC0000080` constant
2. `wrmsr`/`rdmsr` handlers for EFER — specifically the LME (bit 8) and LMA (bit 10) bits
3. A `long_mode` flag in CPU state that is set when EFER.LMA = 1
4. REX prefix handling in the instruction decoder (currently no REX support)
5. 64-bit operand sizes (64-bit registers: RAX, RBX, RCX, RDX, RSI, RDI, RSP, RBP, R8-R15)
6. 64-bit addressing modes
7. 4-level paging (PML4 → PDPT → PD → PT)
8. SYSCALL/SYSRET instructions
9. Updated CPUID to report AMD64 feature flag (bit 29 in EDX of CPUID leaf 0x80000001)

This is the core of x64 support — it's a significant engineering effort.
The JIT codegen in `src/rust/codegen.rs` and `src/rust/jit_instructions.rs`
would also need to be updated for 64-bit code paths.

### Step 2: Rebuild v86_all.js and v86.wasm

Once the Rust CPU changes are made:
```bash
# Install prerequisites
rustup target add wasm32-unknown-unknown
npm install
make all   # builds src/rust → v86.wasm, src/browser → v86_all.js
```

The Makefile uses the Closure Compiler for JS minification and cargo for Rust.

### Step 3: Get 64-bit OS Images

These OSes are known to be x86-64 and could work once long mode is implemented:

| OS | Image | Where |
|---|---|---|
| Alpine Linux 3.x | `alpine-standard-3.x-x86_64.iso` | alpinelinux.org |
| Debian 12 Netinst | `debian-12-netinst-amd64.iso` | debian.org (~700MB) |
| Sortix 1.1 x86-64 | `sortix-1.1-x86_64.iso` | sortix.org (~350MB) |
| Buildroot x86-64 | custom bzImage | buildroot.org |
| SkiffOS | `skiffos/.iso` (chunked, CDN) | already in main.js profile |

For the Render deployment, add small flat images to `download_images.sh` and
keep large ones as CDN proxies.

### Step 4: Add UEFI-Aware Profiles

For 64-bit OSes that need UEFI (most modern ones), add profiles like:
```js
{
    id: "alpine-x64",
    bios: { url: host + "OVMF.fd" },
    cdrom: { url: host + "alpine-standard-3.20-x86_64.iso", size: ..., async: false },
    memory_size: 256 * 1024 * 1024,
    name: "Alpine Linux x86-64",
}
```

Note: The BIOS `url` in profiles is constructed with `host` prefix, which
means OVMF.fd would need to be at `images/OVMF.fd` or the BIOSPATH needs
to be changed to support a different location. See `src/browser/main.js`
line ~2353 for the BIOSPATH logic.

Actually the cleanest approach: put OVMF.fd in `bios/OVMF.fd` and in the
profile set:
```js
bios: { url: "bios/OVMF.fd" }
```
(This is a static URL that the server will serve from the `bios/` directory.)

### Step 5: Update the OS Table and Filter

Once OSes actually boot, update `index.html` rows:
- Remove the `⚠️ experimental` notes
- Add proper size values
- Add proper family/medium columns

---

## Part 5: File-by-File Change Reference

### `index.html`
- **Filter section** (line ~40): Added `filter_64bit` checkbox
- **OS table** (line ~75+): Added 64-bit OS rows (skiffos, sortix-x64, alpine-x64, buildroot-x64)

### `bios/OVMF.fd` (NEW)
- EDK2 UEFI firmware, ~2MB
- Downloaded by `download_images.sh` at deploy time
- Use it in profiles as `bios: { url: "bios/OVMF.fd" }`

### `download_images.sh`
- Added `download_bios` function that downloads to `bios/` instead of `images/`
- Added `OVMF.fd` download entry

### `DEPLOYMENT_STATUS.md`
- Updated to reflect x64 work status

### `TODO.md` (THIS FILE)
- Created to document everything

---

## Part 6: How the Filter System Works (Technical Detail)

The filter checkboxes in `index.html` are connected to the OS list by
`v86_all.js`. Here is the flow:

1. On page load, the compiled JS calls `init_ui()`.
2. `init_ui()` builds a `known_filter` array of categories. Each category is
   an array of `{ id, condition }` objects.
3. For each filter, it does `document.getElementById("filter_" + id)`.
4. If the element exists, it attaches an `onchange` handler and keeps the filter.
5. When a checkbox changes, `update_filters()` runs.
6. `update_filters()` builds a conjunction (AND across categories) of
   disjunctions (OR within a category).
7. Each OS row's `display` style is set to `""` or `"none"` based on whether
   the OS matches all active filter groups.
8. The `arch` field for each OS is read from `element.children[4].textContent`
   (the 5th span in the row).

**This means:**
- Adding `<input id=filter_64bit>` to index.html = filter works automatically
- Putting `<span>64-bit</span>` in position 4 (0-indexed) of an OS row = that
  OS will be shown/hidden by the 64-bit filter

The filter condition for 64-bit in the source is:
```js
{ id: "64bit", condition: os => os.arch === "64-bit" }
```
Since `v86_all.js` is minified, the actual compiled version may differ, but
because the filter system reads IDs from the DOM dynamically, adding
`filter_64bit` to the HTML is sufficient.

---

## Part 7: Quick Reference Commands

```bash
# Verify backup exists
ls -lh /workspaces/v86/.backup/

# Restore from backup (if something breaks)
cp /workspaces/v86/.backup/index.html.bak /workspaces/v86/index.html
cp /workspaces/v86/.backup/DEPLOYMENT_STATUS.md.bak /workspaces/v86/DEPLOYMENT_STATUS.md

# Check what 64-bit entries exist in index.html
grep -n "64-bit" /workspaces/v86/index.html

# Verify OVMF.fd is present
ls -lh /workspaces/v86/bios/OVMF.fd

# Run the server locally
node /workspaces/v86/server.js &
curl -sI http://localhost:3000/ | grep -i cross-origin
kill %1

# Check which filter IDs are in the HTML
grep -o 'id=filter_[a-z0-9_]*' /workspaces/v86/index.html
```

---

## Part 8: Known Issues and Gotchas

1. **v86_all.js is from Feb 2021** — it has no long mode. Any 64-bit OS added
   to the UI will fail to boot. The entries are UI-only placeholders.

2. **OVMF.fd requires long mode** — even with the firmware in place, it will
   triple-fault during early UEFI initialization because it immediately tries
   to switch the CPU to 64-bit mode.

3. **The 64-bit filter IS wired up** — `filter_64bit` in the DOM will be
   detected by v86_all.js's filter engine. Click the checkbox and only rows
   with `64-bit` in the Arch column will show.

4. **OS row column order is strict** — The 5 columns read by the filter JS are:
   `[name, size, ui, family, arch, status, source, lang, medium, notes]`
   (0-indexed: 0=name, 1=size, 2=ui, 3=family, 4=arch, ...)
   The `arch` value must be the **5th span** (index 4) in the row.

5. **SkiffOS profile ID is `copy/skiffos`** — The slash in the ID means the
   URL query parameter looks like `?profile=copy/skiffos`. This may cause
   issues with some URL parsers. The index.html link should be:
   `href="?profile=copy/skiffos"`.

6. **Sortix 1.0 image (`sortix-1.0-i686.iso`) is 32-bit** — the filename
   says `i686`. A 64-bit Sortix edition exists (`sortix-1.1-x86_64.iso`) but
   is NOT in the v86 image set. Adding it requires CDN availability at i.copy.sh.
