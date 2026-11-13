# NV40 VGA/VBE firmware

This ROM is built from SeaVGABIOS rel-1.16.2, with an extended ROM header
and original BIT, initialization, DCB and I2C tables. The NV backend programs
CRTC, PRAMDAC and the real-mode aperture directly. It exposes 640×480 through
1280×1024 at 8/15/16/32 bpp, banked and linear access, pitch/display start,
DAC format and VGA/VBE save/restore. No Bochs DISPI interface is used.

`node tests/devices/geforce_6800_vbe.js` assembles a boot sector and exercises
real INT 10h calls, including 1024×768×32, banked writes, framebuffer clearing
and a save/restore round trip through DOS text mode. It requires NASM.
PLL limit tables and complete XP/Win98 driver acceptance are still in progress.

Run `bios/fetch-and-build-seabios.sh` to obtain the pinned SeaBIOS checkout,
then `python3 bios/nv40/build.py --cross-prefix x86_64-elf-`. An existing
checkout can be supplied with `--seabios`. On macOS use an ELF cross compiler,
not the system's Mach-O compiler. The script builds a clean exported copy,
reserves the DCB pointer in the header before linking, and fixes both the BIT
and option ROM checksums. The log is `build/nv40-bios-build.log`.

SeaVGABIOS is LGPL-3.0; its source is pinned to
`ea1b7a0733906b8425d948ae94fba63c32b1d425` at
<https://github.com/coreboot/seabios>. `build.py` contains the complete source
transformation; `nv40.c` / `nv40.h` contain the backend and `tables.S` the
added table source. Table layouts are
documented by envytools and the MIT-licensed Nouveau BIOS parser:
<https://github.com/torvalds/linux/tree/master/drivers/gpu/drm/nouveau/nvkm/subdev/bios>.
No NVIDIA or board vendor firmware bytes are included.
