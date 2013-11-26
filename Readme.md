[Live demo](http://copy.sh/v24/).


How does it work?
-

v86 emulates an x86-compatible CPU and hardware. Here's a list of emulated hardware:

- An x86 compatible CPU. The instruction set is around Pentium 1 level. Some
  features are missing, more specifically:
  - Task gates, far calls in protected mode
  - 16 bit protected mode features and Virtual 8086 mode
  - Single stepping
  - MMX, SSE
  - A bunch of FPU instructions, FPU exceptions
  - Some other exceptions
- A floating point unit (FPU). Calculations are done with JavaScript's double
  precision numbers (64 bit), so they are not as precise as calculations on a
  real FPU (80 bit).
- An ISA bus.
- A floppy disk controller (8272A).
- A DMA (direct memory access) controller, currently only used by the FDC.
- An 8042 Keyboard Controller, PS2. With mouse support.
- An 8254 Programmable Interval Timer (PIT).
- An 8259 Programmable Interrupt Controller (PIC).
- A CMOS Real Time Clock (RTC).
- A VGA controller with SVGA support and Bochs VBE Extensions. This includes
  support for large resolutions.
- A PCI bus. This one is partly incomplete and not used by every device.
- An IDE disk controller.


How to build, run and embed?
-

- In order to build the `cpu.js` file, you need `make` and `cpp` (the C preprocessor).
  Run: `make src/cpu.js`.
- If you want a compressed and fast (ie, with debug code removed) version, you
  need Closure Compiler. 
  Set the path to `compiler.jar` in the Makefile and run `make v86_all.js`.
- For more details on how to customize the behaviour and interface, see [docs/adapters.md](docs/adapters.md).


Why? 
- 

Similiar projects have been done before, but I decided to work on this as a fun
project and learn something about the x86 architecture. It has grown pretty
advanced and I just got Linux and KolibriOS working recently and
there might be some actual uses.

If you build something interesting, let me know. However, keep in mind that the project
is not very stable at the moment.


How can I contribute?
-

- Someone who could work on hardware devices, such as a modem or the AT
  controller.  I'll write an overview for that at a later point, if people are
  interested. 
- Donate. Since Bitcoin is the new cool thing, here's my address:
  `14KBXSoewGzbQY8VoznJ5MZXGxoia8RxC9`

License
-

Simplified BSD License, see [LICENSE](LICENSE), unless otherwise noted.


Credits
-

- Test cases via QEMU, http://wiki.qemu.org/Main_Page 
- https://github.com/creationix/node-sdl
- ascii.ttf (used in node) from http://www.apollosoft.de/ASCII/indexen.htm 


More questions?
-

Shoot me an email to `copy@copy.sh`. Please don't tell about bugs via mail,
create a bug report on github instead.


Author
-

Fabian Hemmer (http://copy.sh/, `copy@copy.sh`)
