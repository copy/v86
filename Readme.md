v86 emulates an x86-compatible CPU and hardware. Machine code is translated to
WebAssembly modules at runtime in order to achieve decent performance. Here's a
list of emulated hardware:

- An x86-compatible CPU. The instruction set is around Pentium 4 level,
  including full SSE3 support. Some features are missing, in particular:
  - Task gates, far calls in protected mode
  - Some 16 bit protected mode features
  - Single stepping (trap flag, debug registers)
  - Some exceptions, especially floating point and SSE
  - Multicore
  - 64-bit extensions
- A floating point unit (FPU). Calculations are done using the Berkeley
  SoftFloat library and therefore should be precise (but slow). Trigonometric
  and log functions are emulated using 64-bit floats and may be less precise.
  Not all FPU exceptions are supported.
- A floppy disk controller (8272A).
- An 8042 Keyboard Controller, PS2. With mouse support.
- An 8254 Programmable Interval Timer (PIT).
- An 8259 Programmable Interrupt Controller (PIC).
- Partial APIC support.
- A CMOS Real Time Clock (RTC).
- A display adapter, chosen with `graphics_adapter`
  ([GPU devices](docs/gpu-devices.md)):
  - A generic VGA card with SVGA support and Bochs VBE Extensions
    (`bochs_vga`).
  - VMware SVGA II (`vmware_svga`). With WebGPU (`libv86-webgpu.js`), it
    runs the guest's 3D: Direct3D 9–11 through VMware's Windows driver,
    OpenGL 4.3 through Mesa.
  - virtio-gpu as virtio-vga (`virtio_gpu`). With WebGPU, it runs OpenGL 4.3
    (virgl) and Vulkan 1.1 (Venus) through Mesa.
- A PCI bus. This one is partly incomplete and not used by every device.
- An IDE disk controller.
  - A built-in ISO 9660 CD-ROM generator with Joliet support.
- An NE2000 (RTL8390) PCI network card.
- Various virtio devices: Filesystem, network, balloon and GPU.
- A SoundBlaster 16 sound card.
- A hayes-compatible dial-up Modem.

## Documentation

[The virtual machine manager](docs/vm-manager.md) —
[How it works](docs/how-it-works.md) —
[Networking](docs/networking.md) —
[Dial-up modem networking](docs/modem.md) —
[Alpine Linux guest setup](tools/docker/alpine/) —
[Arch Linux guest setup](docs/archlinux.md) —
[Debian with xfce guest setup](tools/docker/debian/) —
[MS-DOS/FreeDOS guest setup](docs/dos.md) —
[Windows 3.1x guest setup](docs/windows-31x.md) —
[Windows 9x guest setup](docs/windows-9x.md) —
[Windows NT guest setup](docs/windows-nt.md) —
[9p filesystem](docs/filesystem.md) —
[Linux rootfs on 9p](docs/linux-9p-image.md) —
[GPU devices: VMware SVGA II and virtio-gpu](docs/gpu-devices.md) —
[GPU deviations from hardware](docs/gpu-deviations.md) —
[Display design](docs/display-design.md) —
[Graphics proxy](docs/glbridge.md) —
[Custom virtio devices](docs/custom-virtio-devices.md) —
[Profiling](docs/profiling.md)

## Compatibility

Here's an overview of the operating systems supported in v86:

- Linux works pretty well. 64-bit kernels are not supported.
  - [Buildroot](https://buildroot.org/) can be used to build a minimal image.
    [humphd/browser-vm](https://github.com/humphd/browser-vm) and
    [darin755/browser-buildroot](https://github.com/Darin755/browser-buildroot) have some useful scripts for building one.
  - [SkiffOS](https://github.com/skiffos/SkiffOS/tree/master/configs/browser/v86) (based on Buildroot) can cross-compile a custom image.
  - Ubuntu and other Debian derivatives works up to the latest version that supported i386 (16.04 LTS or 18.04 LTS for some variants).
  - Alpine Linux works. An image can be built from a Dockerfile, see [tools/docker/alpine/](tools/docker/alpine/).
  - Arch Linux 32 works. See [archlinux.md](docs/archlinux.md) for building an image.
- ReactOS works.
- FreeDOS, Windows 1.01 and MS-DOS run very well.
- KolibriOS works.
- Haiku works.
- Android-x86 has been tested up to 4.4-r2.
- Windows 1, 3.x, 95, 98, ME, NT and 2000 work reasonably well.
  - In Windows 2000 and higher the PC type has to be changed from ACPI PC to Standard PC
  - There are some known boot issues ([#250](https://github.com/copy/v86/issues/250), [#433](https://github.com/copy/v86/issues/433), [#507](https://github.com/copy/v86/issues/507), [#555](https://github.com/copy/v86/issues/555), [#620](https://github.com/copy/v86/issues/620), [#645](https://github.com/copy/v86/issues/645))
  - See [Windows 9x guest setup](docs/windows-9x.md)
- Windows XP, Vista and 8 work under certain conditions (see [#86](https://github.com/copy/v86/issues/86), [#208](https://github.com/copy/v86/issues/208))
  - See [Windows NT guest setup](docs/windows-nt.md)
- Many hobby operating systems work.
- 9front works.
- Plan 9 doesn't work.
- QNX works.
- OS/2 doesn't work.
- FreeBSD works.
- OpenBSD works with a specific boot configuration. At the `boot>` prompt type
  `boot -c`, then at the `UKC>` prompt `disable mpbios` and `exit`.
- NetBSD works only with a custom kernel, see [#350](https://github.com/copy/v86/issues/350).
- SerenityOS works (only 32-bit versions).
- [SkiftOS](https://skiftos.org/) works.

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

## Generative AI

At this time, v86 does not accept pull requests or issues written partially or entirely by generative AI tools.
Exceptions may be made on a case-by-case basis.

## License

v86 is distributed under the terms of the Simplified BSD License, see
[LICENSE](LICENSE). The following third-party dependencies are included in the
repository under their own licenses:

- [`lib/softfloat/softfloat.c`](lib/softfloat/softfloat.c)
- [`lib/zstd/zstddeclib.c`](lib/zstd/zstddeclib.c)
- [`tests/kvm-unit-tests/`](tests/kvm-unit-tests)
- [`tests/qemutests/`](tests/qemutests)
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

Please report bugs on GitHub: https://github.com/speedyHKjournalist/v64/issues
