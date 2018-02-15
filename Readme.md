[![Join the chat at https://gitter.im/copy/v86](https://badges.gitter.im/Join%20Chat.svg)](https://gitter.im/copy/v86)


Demos
-

- [Windows 98](https://copy.sh/v86/?profile=windows98)
- [Linux](https://copy.sh/v86/?profile=linux26)
- [Linux 3](https://copy.sh/v86/?profile=linux3)
- [KolibriOS](https://copy.sh/v86/?profile=kolibrios)
- [FreeDOS](https://copy.sh/v86/?profile=freedos)
- [Windows 1.01](https://copy.sh/v86/?profile=windows1)
- [Archlinux](https://copy.sh/v86/?profile=archlinux)


API examples
-

- [Basic](examples/basic.html)
- [Programatically using the serial terminal](examples/serial.html)
- [A Lua interpreter](examples/lua.html)
- [Two instances in one window](examples/two_instances.html)
- [Saving and restoring emulator state](examples/save_restore.html)

Using v86 for your own purposes is as easy as:

```javascript
var emulator = new V86Starter({
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

See [API](docs/api.md).


How does it work?
-

v86 emulates an x86-compatible CPU and hardware. Here's a list of emulated hardware:

- An x86 compatible CPU. The instruction set is around Pentium 1 level. Some
  features are missing, more specifically:
  - Task gates, far calls in protected mode
  - 16 bit protected mode features
  - Single stepping
  - MMX, SSE
  - A bunch of FPU instructions
  - Some exceptions
- A floating point unit (FPU). Calculations are done with JavaScript's double
  precision numbers (64 bit), so they are not as precise as calculations on a
  real FPU (80 bit).
- A floppy disk controller (8272A).
- An 8042 Keyboard Controller, PS2. With mouse support.
- An 8254 Programmable Interval Timer (PIT).
- An 8259 Programmable Interrupt Controller (PIC).
- A CMOS Real Time Clock (RTC).
- A generic VGA card with SVGA support and Bochs VBE Extensions.
- A PCI bus. This one is partly incomplete and not used by every device.
- An IDE disk controller.
- An NE2000 (8390) PCI network card.
- A virtio filesystem.
- A SoundBlaster 16 sound card.


Testing
-

The disk images are not included in this repository. You can download them
directly from the website using:

`wget -P images/ https://copy.sh/v86/images/{linux.iso,linux3.iso,kolibri.img,windows101.img,os8.dsk,freedos722.img,openbsd.img}`.

A testsuite is available in `tests/full/`. Run it using `node tests/full/run.js`.


How to build, run and embed?
-

- Building is only necessary for releases, open debug.html and everything should load out of the box
- If you want a compressed and fast (i.e. with debug code removed) version, you
  need Closure Compiler. Download it as shown below and run `make build/v86_all.js`.
- ROM and disk images are loaded via XHR, so if you want to try out `index.html`
  locally, make sure to serve it from a local webserver. You can use `make run`
  to serve the files using Python's SimpleHTTPServer.
- If you only want to embed v86 in a webpage you can use libv86.js. For
  usage, check out the [API](docs/api.md) and [examples](examples/).
- A couple of disk images are provided for testing. You can check them out
  using `wget -P images/ https://copy.sh/v86/images/{linux.iso,linux3.iso,kolibri.img,windows101.img,os8.dsk,freedos722.img,openbsd.img}`.


**Short summary:**

```bash
# grab the main repo
git clone https://github.com/copy/v86.git && cd v86

# grab the disk images
wget -P images/ https://copy.sh/v86/images/{linux.iso,linux3.iso,kolibri.img,windows101.img,os8.dsk,freedos722.img,openbsd.img}

# grab closure compiler
wget -P closure-compiler https://dl.google.com/closure-compiler/compiler-latest.zip
unzip -d closure-compiler closure-compiler/compiler-latest.zip *.jar

# build the library
make build/libv86.js

# run the tests
./tests/full/run.js
```

Compatibility
-

Here's an overview of the operating systems supported in v86:

- Linux works pretty well.
  - Tinycore (3.16, 4.8 kernel): Works.
  - Nanolinux works.
  - Archlinux works with some caveats. See [archlinux.md](docs/archlinux.md).
  - Damn Small Linux (2.4 Kernel): Doesn't work.
- ReactOS works.
- FreeDOS, Windows 1.01 and MS-DOS run very well.
- KolibriOS works. A few applications need SSE.
- Haiku boots, but takes very long (around 30 minutes).
- No Android version seems to work, you still get a shell.
- Windows 1, 3, 95 and 98 work. Windows XP is unstable, but can work with some
  tweaks ([see this issue](https://github.com/copy/v86/issues/86)). Other
  versions might work but haven't been tested.
- Many hobby operating systems work.
- FreeBSD works.
- OS/2 doesn't work.

You can get some infos on the disk images here: https://github.com/copy/images.
The Windows images are from [WinWorld](https://winworldpc.com/).


How can I contribute?
-

- Add new features (hardware devices, fill holes in the CPU), fix bugs. Check
  out the issues section and contact me if you need help.
- Report bugs.
- If you want to donate, let me know.

License
-

- Source code and most tests: Simplified BSD License, see [LICENSE](LICENSE).
- QEMU test suite: See [tests/qemu/LICENSE](LICENSE).


Credits
-

- CPU test cases via QEMU, http://wiki.qemu.org/Main_Page
- More tests via [kvm-unit-tests](https://www.linux-kvm.org/page/KVM-unit-tests)
- [Disk Images](https://github.com/copy/images)
- [The jor1k project](https://github.com/s-macke/jor1k) for 9p, filesystem and uart drivers
- [WinWorld](https://winworldpc.com/) sources of some old operating systems


More questions?
-

Shoot me an email to `copy@copy.sh`. Please don't tell about bugs via mail,
create a bug report on GitHub instead.


Author
-

Fabian Hemmer (http://copy.sh/, `copy@copy.sh`)
