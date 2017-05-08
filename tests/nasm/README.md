# About

All tests in this folder are currently manual (i.e. you compile them
manually and run it on a real machine and compare the state of the
relevant registers to that of v86's registers). They are not
comprehensive in any way and are not currently meant to be. They're
just quick tests used for sanity-checks.

They should be automated soon.

# Compiling

- Run `make filename.img` to compile a multiboot kernel image to be used
  in v86.
- Run `make filename.bin` to compile a regular ELF binary to run on
  a real machine.

# Testing

- Run `make filename.img` (for eg. `make movq.img`)
- Open this image file as a multiboot kernel in v86
- Open `filename.asm` - at the end will be a comment showing the
  expected state of `cpu.reg_mmxs` (after being
  `JSON.stringify`'d). These are the expected values that should match
  if you're making any changes to v86 or the relevant instructions.
- Compare `cpu.reg_mmxs` to this "fixture" manually
