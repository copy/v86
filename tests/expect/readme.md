Expect tests
------------

These so-called "expect tests" test the code generation, i.e. the translation
of x86 assembly to Web Assembly. Use the following workflow:

1. Hack on the code generator
2. Run make `expect-tests`
3. For each failing test:
    - Manually verify that the generated code changes are as expected by the diff
    - If so, accept the new code by copying the .actual.wast file over the .wast file
      and checking the new .wast file into git

In order to add a new expect test:

1. Create a new .asm file in tests/
2. Run make `expect-tests`
3. Verify the generated code and use the printed cp command to accept the test

Note that .asm files are translated to flat binaries, not elf files, so a .data
section may be meaningless.


For more information, see https://blog.janestreet.com/testing-with-expectations/
