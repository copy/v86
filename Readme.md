[Live demo](http://copy.sh/v24/).


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
- A VGA controller with SVGA support and Bochs VBE Extensions. This includes
  support for large resolutions.
- A PCI bus. This one is partly incomplete and not used by every device.
- An IDE disk controller.
- An NE2000 (8390) PCI network card.


How to build, run and embed?
-

- In order to build the `cpu.js` file, you need `make` and `cpp` (the C preprocessor).
  Run: `make src/cpu.js`.
- If you want a compressed and fast (i.e. with debug code removed) version, you
  need Closure Compiler. Pull the submodule using 
  `git submodule update --init --recursive closure-compiler` and run `make v86_all.js`.
- ROM and disk images are loaded via XHR, so if you want to try out `index.html`
  locally, make sure to serve it from a local webserver.
- For more details on how to customize the behaviour and interface, see [docs/adapters.md](docs/adapters.md).
- If you want only want to embed v86 on website you can use libv86.js. For
  usage, check out [basic.html](docs/sample/basic.html).


Why? 
- 

Similiar projects have been done before, but I decided to work on this as a fun
project and learn something about the x86 architecture. It has grown pretty
advanced and I got Linux and KolibriOS working, so there might be some actual
uses.

If you build something interesting, let me know.


Compatibility
-

Here's an overview of the operating systems supported in v86:

- Linux works pretty well. Graphical boot fails in many versions, but you
  mostly get a shell. The mouse is often not detected automatically.
  - Damn Small Linux (2.4 Kernel): Run with `lowram` and choose PS2 mouse in
    xsetup. Takes circa 10 minutes to boot.
  - Tinycore (3.0 kernel): `udev` and `X` fail, but you get a
    terminal.
  - Nanolinux works.
  - Archlinux works. Add `atkbd` to `MODULES` in `/etc/mkinitcpio.conf`.
- FreeDOS and Windows 1.01 run very well. 
- KolibriOS works. A few applications need SSE.
- Haiku boots, but takes very long (around 30 minutes). Set the memory size to 128MB.
- ReactOS doesn't work.
- No Android version seems to work, you still get a shell.

You can get some infos on the disk images here: https://github.com/copy/v86/tree/master/images


How can I contribute?
-

- Add new features (hardware devices, fill holes in the CPU), fix bugs. Check
  out the issues section and concact me if you need help.
- Report bugs.
- Donate. Via Bitcoin:
  [`14KBXSoewGzbQY8VoznJ5MZXGxoia8RxC9`](https://blockchain.info/address/14KBXSoewGzbQY8VoznJ5MZXGxoia8RxC9).
  If you want to donate elsewhere, let me know.

License
-

Simplified BSD License, see [LICENSE](LICENSE), unless otherwise noted.


Credits
-

- Test cases via QEMU, http://wiki.qemu.org/Main_Page 
- https://github.com/creationix/node-sdl
- ascii.ttf (used in node) from http://www.apollosoft.de/ASCII/indexen.htm 
- [Disk Images](https://github.com/copy/images)


More questions?
-

Shoot me an email to `copy@copy.sh`. Please don't tell about bugs via mail,
create a bug report on GitHub instead.


Author
-

Fabian Hemmer (http://copy.sh/, `copy@copy.sh`)

