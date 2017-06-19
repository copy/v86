# About

The tests in this folder are not comprehensive by any means at the
moment.

# Automated Testing

- Run `make && ./run.js` in the root of the project

# Manual

- Run `make filename.img` to compile a multiboot kernel image to be used
  in v86.
- Run `make filename.bin` to compile a regular ELF binary to run on
  a real machine.
- Run `make filename.fixture` to run `filename.bin` through `gdb` with
  the `gdbauto` script (to extract the state of all mmx registers at
  the moment).
