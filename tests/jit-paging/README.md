# About

These tests map 2 adjacent pages to the exact same physical frame. Code is
written to one page and executed from the other, then overwritten and executed
again, in order to trigger cache activity. Unlike `/tests/jit/`, this folder is
meant to test the JIT in protected mode with paging setup, not in real-mode.

# Run

- Obtain the `linux3.iso` image (see [Readme.md](../../Readme.md))
- Run `make jitpagingtests` in the root of the project
