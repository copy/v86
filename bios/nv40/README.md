# NV40 probe firmware

This G0 ROM is built from SeaVGABIOS rel-1.16.2, with an extended ROM header
and original minimal BIT, initialization, DCB and I2C tables. It supports VGA
text and legacy VGA modes. NV40 VBE mode setting, PLL limits and full NVIDIA
driver initialization are pending G1; this is not a replacement for a card ROM.

Run `bios/fetch-and-build-seabios.sh` to obtain the pinned SeaBIOS checkout,
then `python3 bios/nv40/build.py --cross-prefix x86_64-elf-`. An existing
checkout can be supplied with `--seabios`. On macOS use an ELF cross compiler,
not the system's Mach-O compiler. The script builds a clean exported copy,
reserves the DCB pointer in the header before linking, and fixes both the BIT
and option ROM checksums. The log is `build/nv40-bios-build.log`.

SeaVGABIOS is LGPL-3.0; its source is pinned to
`ea1b7a0733906b8425d948ae94fba63c32b1d425` at
<https://github.com/coreboot/seabios>. `build.py` contains the complete source
transformation and `tables.S` the added table source. Table layouts are
documented by envytools and the MIT-licensed Nouveau BIOS parser:
<https://github.com/torvalds/linux/tree/master/drivers/gpu/drm/nouveau/nvkm/subdev/bios>.
No NVIDIA or board vendor firmware bytes are included.
