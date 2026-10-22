[![Discord](https://img.shields.io/badge/Discord-join%20the%20chat-5865F2?logo=discord&logoColor=white)](https://discord.gg/re5CY3MbfW)

# v64

v64 runs x86 (32- and 64-bit) and ARM64 virtual machines in the browser.
Machine code is compiled to WebAssembly at runtime, one 4 KiB page of guest
code at a time ([JIT design](docs/ir-design.md)). Its JavaScript API keeps the
names it started with: `V86`, `libv86.js`.

**Try it: [v64-2ys.pages.dev](https://v64-2ys.pages.dev)**, the virtual
machine manager: make a machine with a preset that says whether it was
verified, install a system from a CD or floppy, keep its disks in the browser,
suspend it and start it again later ([how to use it](docs/vm-manager.md)).

## Showcase: Retro Gaming Site

**[retrogaming.dpdns.org](https://retrogaming.dpdns.org/)** runs classic PC
games on v64, ready to play in the browser: Heroes of Might and Magic III,
StarCraft, Diablo I and II, Red Alert 2, Age of Empires II, Warcraft III,
MapleStory, KartRider and more, on Windows 98 and Windows XP. Its Direct3D,
DirectDraw and OpenGL games draw through v64's [graphics proxy](docs/glbridge.md)
on WebGPU. Join its [Discord](https://discord.gg/re5CY3MbfW).

## Emulated hardware

- **x86 CPU** (`cpu_type: "x86"`, the default, or `"x86_64"`):
  - 32-bit protected mode with x87, MMX and SSE to SSE3; with `"x86_64"`, also
    long and compatibility mode with NX, 2 MiB pages, SYSCALL/SYSRET and
    CMPXCHG16B ([x86-64](docs/x86-64.md)), and more RAM than WebAssembly's 4 GiB
    memory with `extended_memory_size`.
  - `"x86_64"` reports SSSE3, SSE4.1, SSE4.2, AVX, AVX2, FMA, F16C, BMI1,
    BMI2, LZCNT, MOVBE and XSAVE, XSAVEOPT, XSAVEC, XSAVES by default;
    `cpu_features` chooses others (for example `"x86-64-v2"`, or `[]` for none).
  - The x87 FPU computes with Berkeley SoftFloat (exact 80-bit results), or,
    with `x87_fast_math` (the default), adds, subtracts, multiplies and divides
    in native 64-bit floats; trigonometric and log functions use 64-bit floats.
  - Up to 8 cores (`cpu_cores`, with `acpi: true`), taking turns on one thread,
    or each in its own Worker when the page is cross-origin isolated
    ([multicore](docs/multicore.md)).
  - Not implemented: the trap flag in 32-bit code, JMP through a call gate,
    AVX-512, AES-NI, SHA, PCID, VMX/SVM, x2APIC.
- **PC machines** (`machine_type`):
  - `i440fx` (the default): i440FX and PIIX, an IDE controller.
  - `q35`: Q35 and ICH9 with AHCI (6 SATA ports, NCQ, hot plug), PCIe root
    ports with hot plug, HPET, SMBus, SMM ([Q35](docs/q35.md),
    [AHCI](docs/ahci.md)); it needs ACPI.
  - ACPI (`acpi: true`): generated tables, sleep states (S3/S4/S5 on i440FX),
    local APICs and an IOAPIC ([ACPI](docs/acpi.md)); an 8259 PIC, an 8254 PIT and a CMOS RTC
    always.
- **ARM64** (`cpu_type: "arm64"`, `machine_type: "virt"`): Armv8.0-A at EL0/EL1
  with AES, SHA, CRC32 and PAN, on a copy of QEMU's `virt` board: GICv3, PL011
  UART, PL031 RTC, PSCI, PCIe, and virtio over MMIO or PCI (block, network,
  entropy, console, input, vsock, sound, GPU). It boots a Linux kernel
  directly with a device tree ([ARM64](docs/aarch64.md), [virt](docs/virt.md)).
- **Devices** of the PC machines: a floppy disk controller (8272A); IDE with a
  built-in ISO 9660 CD-ROM generator (Joliet); a PS/2 keyboard and mouse;
  serial ports COM1–COM4 and parallel ports; an NE2000 or virtio network card;
  a virtio 9p filesystem, console and balloon; a SoundBlaster 16 and the PC
  speaker; a Hayes-compatible dial-up modem ([modem](docs/modem.md)); and
  [custom virtio devices](docs/custom-virtio-devices.md).
- **Display** (`graphics_adapter`, [GPU devices](docs/gpu-devices.md)):
  - `bochs_vga`: a generic VGA card with SVGA support and Bochs VBE Extensions.
  - `vmware_svga`: VMware SVGA II. With WebGPU (`libv86-webgpu.js`) it runs the
    guest's 3D: Direct3D 9–11 through VMware's Windows 8.1 driver, OpenGL 4.3
    through Mesa.
  - `virtio_gpu`: virtio-gpu (as virtio-vga on PC). With WebGPU it runs OpenGL
    4.3 (virgl) and Vulkan 1.1 (Venus) through Mesa.
  - The [graphics proxy](docs/glbridge.md) (`graphics_proxy: true`): OpenGL,
    DirectDraw, Direct3D 8 and Direct3D 9 for Windows 2000/XP programs, through
    proxy DLLs and a guest driver, rendered with WebGPU.
- **Disks**: RAW images and QCOW2, VHD, VDI, VMDK and VHDX, OVA import, export
  to QCOW2 or RAW ([formats](docs/disk-image-formats-plan.md)); with
  `disk_option: "read_write"` a RAW disk is written back to a disk service, a
  local file in Node, or a disk kept in the browser
  ([persistence](docs/disk-persistence-plan.md)).

## Documentation

[The virtual machine manager](docs/vm-manager.md) —
[JIT design](docs/ir-design.md) —
[x86-64](docs/x86-64.md) —
[Multicore](docs/multicore.md) —
[Q35](docs/q35.md) —
[AHCI](docs/ahci.md) —
[SATA](docs/sata.md) —
[ACPI](docs/acpi.md) —
[ARM64](docs/aarch64.md) —
[virt machine](docs/virt.md) —
[GPU devices: VMware SVGA II and virtio-gpu](docs/gpu-devices.md) —
[GPU deviations from hardware](docs/gpu-deviations.md) —
[Display design](docs/display-design.md) —
[Graphics proxy](docs/glbridge.md) —
[Custom virtio devices](docs/custom-virtio-devices.md) —
[Disk image formats](docs/disk-image-formats-plan.md) —
[Disk persistence](docs/disk-persistence-plan.md) —
[Networking](docs/networking.md) —
[Dial-up modem networking](docs/modem.md) —
[9p filesystem](docs/filesystem.md) —
[Linux rootfs on 9p](docs/linux-9p-image.md) —
[Alpine Linux guest setup](tools/docker/alpine/) —
[Arch Linux guest setup](docs/archlinux.md) —
[Debian with xfce guest setup](tools/docker/debian/) —
[MS-DOS/FreeDOS guest setup](docs/dos.md) —
[Windows 3.1x guest setup](docs/windows-31x.md) —
[Windows 9x guest setup](docs/windows-9x.md) —
[Windows NT guest setup](docs/windows-nt.md) —
[Profiling](docs/profiling.md)

## Compatibility

Verified, each with the machine the VM manager's preset gives it:

- MS-DOS 6.22 and FreeDOS; Windows 3.x ([guide](docs/windows-31x.md)).
- Windows 95, 98 and ME ([guide](docs/windows-9x.md)); Windows NT 4 and 2000
  ([guide](docs/windows-nt.md)).
- Windows XP, on the 32-bit CPU with one core (with `"x86_64"` it uses its PAE
  kernel).
- Windows 8.1 x64, booted from an installed image on 1, 2 or 4 cores, on
  i440FX or Q35, with Direct3D 9–11 on `vmware_svga`; installing it from its CD
  was not verified.
- 32-bit Linux (4.16, 6.8, 6.18) and 64-bit Linux (Alpine 3.24 x86_64), on up
  to 8 and 4 cores.
- ARM64: Alpine 3.24 aarch64 (Linux 6.18) on 1, 2 or 4 cores, and Android 16
  (Cuttlefish, 4 cores) to its desktop, with Vulkan (Venus), touch, Wi-Fi,
  sound and snapshots.

Not verified: Windows Vista (its installation CD only starts), 7 and 10.

Known to work on the 32-bit CPU: ReactOS, KolibriOS, Haiku, Android-x86 up to
4.4-r2, FreeBSD, 9front, QNX, SerenityOS (32-bit versions),
[SkiftOS](https://skiftos.org/), Arch Linux 32 ([guide](docs/archlinux.md)) and
many hobby operating systems; [Buildroot](https://buildroot.org/) and
[SkiffOS](https://github.com/skiffos/SkiffOS/tree/master/configs/browser/v86)
build minimal Linux images. OpenBSD needs `boot -c`, then `disable mpbios` and
`exit` at the `UKC>` prompt; NetBSD needs a custom kernel. Plan 9 and OS/2 do
not work.

## How to build, run and embed?

You need:

- make
- Rust with the wasm32-unknown-unknown target
- A version of clang compatible with Rust
- java (for Closure Compiler, not necessary when using `debug.html?cpu_worker=0`)
- nodejs (a recent version is required, v24.16 is known to be working) and
  npm (the page's build tools, TypeScript and esbuild: `npm ci`, which make
  runs when they are missing)
- To run tests: nasm, gdb, qemu-system, gcc, libc-i386 and rustfmt

See [tools/docker/test-image/Dockerfile](tools/docker/test-image/Dockerfile)
for a full setup on Debian or
[WSL](https://docs.microsoft.com/en-us/windows/wsl/install).

- Run `make all-debug` to build the debug build (at `debug.html`: the old
  page's form with the debugger). Like `index.html`, it runs the CPU in a
  Worker, `build/cpu-worker.js` (a release bundle). `debug.html?cpu_worker=0`
  runs the CPU in the page from the source tree, with the register dumps, the
  debug panel and debug logs; it needs only `make`.
- Run `make all` to build the optimized build (at `index.html`, the
  [virtual machine manager](docs/vm-manager.md): `build/v86_app.js` with
  `build/libv86.mjs`; `app_debug.html` loads its source). It includes
  `build/v86-parallel.wasm` and `build/vcpu-worker.js`, with which `index.html`
  runs a guest with more than one CPU core in host threads (one per core). That
  needs a cross-origin isolated page: serve it with the headers
  `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp`. Without them, or with the
  processor's "Run the cores in host threads" setting off (`?parallel=0`), the
  cores take turns on one thread as before; the console's details say which.
- ROM and disk images are loaded via XHR, so if you want to try out `index.html`
  locally, make sure to serve it from a local webserver. You can use `make run`
  to serve the files using Python's http module (it sends the COOP/COEP headers
  mentioned above, answers Range requests, and starts the local disk service
  for `images/`).
- Run `make pages` to put `index.html` and everything it loads into
  `build/pages/`, a static site with those headers (`_headers`) that any static
  host can serve; [.github/workflows/pages.yml](.github/workflows/pages.yml)
  deploys it to Cloudflare Pages on every push to `master`
  ([Deployment](docs/vm-manager.md#deployment)).
- If you only want to embed v86 in a webpage you can use `libv86.js`. For usage,
  check out the [examples](examples/).

### Alternatively, to build using Docker

- If you have Docker installed, you can run the whole system inside a container.
- See `tools/docker/exec` to find the Dockerfile required for this.
- You can run `docker build -f tools/docker/exec/Dockerfile -t v86:alpine-3.19 .` from the root directory to generate docker image.
- Then you can simply run `docker run -it -p 8000:8000 v86:alpine-3.19` to start the server.
- Check `localhost:8000` for hosted server.

### Running via Dev Container

- If you are using an IDE that supports Dev Containers, such as GitHub Codespaces, the Visual Studio Code Remote Container extension, or possibly others such as Jetbrains' IntelliJ IDEA, you can setup the development environment in a Dev Container.
- Follow the instructions from your development environment to setup the container.

## Testing

The disk images for testing are not included in this repository: the tests
read them from `images/` (each test names the files it needs). `make ci-tests`
runs the tests that need no images; it is what CI (`.github/workflows/ci.yml`)
runs, with eslint and the builds.

Run integration tests: `make tests`

Run all tests: `make jshint rustfmt kvm-unit-test nasmtests nasmtests-force-jit expect-tests jitpagingtests qemutests rust-test tests`

See [tests/Readme.md](tests/Readme.md) for more information.

## API examples

- [Basic](examples/basic.html)
- [Programatically using the serial terminal](examples/serial.html)
- [A Lua interpreter](examples/lua.html)
- [Two instances in one window](examples/two_instances.html)
- [Networking between browser windows/tabs using the Broadcast Channel API](examples/broadcast-network.html)
- [TCP Terminal (fetch-based networking)](examples/tcp_terminal.html)
- [Saving and restoring emulator state](examples/save_restore.html)

Using v86 for your own purposes is as easy as:

```javascript
var emulator = new V86({
    graphics_adapter: "bochs_vga",
    screen_container: document.getElementById("screen_container"),
    bios: {
        url: "../../bios/seabios.bin",
    },
    vga_bios: {
        url: "../../bios/vgabios.bin",
    },
    cdrom: {
        url: "../../images/linux.iso",
    },
    autostart: true,
});
```

See [v86.d.ts](v86.d.ts) for TypeScript definitions. You can use `make doc` (TypeDoc) or `make denodoc` (Deno) to generate HTML documentation in `./docs/api/`.

## License

v64 is distributed under the terms of the Simplified BSD License, see
[LICENSE](LICENSE) (it began as v86, whose contributors hold its
copyright). The following third-party dependencies are
included in the repository under their own licenses:

- [`lib/softfloat/softfloat.c`](lib/softfloat/softfloat.c)
- [`lib/zstd/zstddeclib.c`](lib/zstd/zstddeclib.c)
- [`tests/kvm-unit-tests/`](tests/kvm-unit-tests)
- [`tests/qemu/`](tests/qemu)
- [`src/floppy.js/`](src/floppy.js) contains parts ported from qemu under the MIT license, see LICENSE.MIT.

## Credits

- CPU test cases via [QEMU](https://wiki.qemu.org/Main_Page)
- More tests via [kvm-unit-tests](https://www.linux-kvm.org/page/KVM-unit-tests)
- [zstd](https://github.com/facebook/zstd) support is included for better compression of state images
- [Berkeley SoftFloat](http://www.jhauser.us/arithmetic/SoftFloat.html) is included to precisely emulate 80-bit floating point numbers
- [The jor1k project](https://github.com/s-macke/jor1k) for 9p, filesystem and uart drivers
- [WinWorld](https://winworldpc.com/) sources of some old operating systems
- [OS/2 Museum](https://www.os2museum.com/) sources of some old operating systems
- [ArchiveOS](https://archiveos.org/) sources of several operating systems

## More questions?

Ask on [Discord](https://discord.gg/re5CY3MbfW), or report bugs on GitHub:
https://github.com/speedyHKjournalist/v64/issues
