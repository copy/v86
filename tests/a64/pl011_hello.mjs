#!/usr/bin/env node
// The first A64 program prints through the PL011 (docs/arm64-virt-android16-plan.md
// A1): a bare-metal guest writes a line to the UART's data register while
// it polls the flag register, on QEMU and on v86; both serial outputs and
// the result blocks are equal.
import assert from "node:assert/strict";
import fs from "node:fs";
import { build, reference, actual, root } from "./guest_runner.mjs";

const source = root + "build/a64-pl011-hello.c";
fs.writeFileSync(source, `#include <a64.h>
#include <stdio.h>
#define UART ((volatile unsigned *)0x09000000)
static void put(char c)
{
    while(UART[0x18 / 4] & 1 << 5) {}  // TXFF
    UART[0] = c;
}
int main(int argc, char **argv)
{
    (void)argc, (void)argv;
    unsigned fr = UART[0x18 / 4], id = UART[0xFE0 / 4] | UART[0xFE4 / 4] << 8 | UART[0xFE8 / 4] << 16;
    for(const char *s = "Hello from A64 through the PL011\\n"; *s; s++) put(*s);
    printf("fr %#x periph %#x\\n", fr & 0x90, id & 0xFFFFF);
    return 0;
}
`);
const directory = build("pl011-hello", [source], { general_regs_only: true });
const expected = await reference(directory);
const got = await actual(directory);
assert.equal(expected.status, "ok");
assert.equal(got.status, "ok");
assert.equal(got.serial, expected.serial, "serial output");
assert.equal(got.text, expected.text);
assert.match(got.serial, /^Hello from A64 through the PL011\n$/);
console.log("PASS " + JSON.stringify(got.serial) + " " + JSON.stringify(got.text) + " on QEMU and v86");
