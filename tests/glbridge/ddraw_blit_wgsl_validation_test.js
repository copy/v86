#!/usr/bin/env node
// Runs every DirectDraw blit shader variant ddraw_ops.js can generate through
// `naga`, the WGSL front end wgpu and Firefox use.
//
// The executor tests prove the right variant is chosen and the right bindings
// are supplied; they cannot prove the WGSL compiles, because the fake device
// accepts any string. A blit shader that fails to compile is a black screen
// with a console message, and the whole 2D path is these shaders.
//
// naga is optional: install it with `cargo install naga-cli`.

"use strict";

const { requireNaga } = require("./naga.js");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { ddBlitShaderSource } = require("../../src/browser/glbridge/d3d9-webgpu/ddraw_ops.js");


const naga = requireNaga("ddraw_blit_wgsl_validation_test");
if (!naga) process.exit(0);

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ddraw-wgsl-"));
let checked = 0;
const failures = [];

function validate(name, source) {
    const file = path.join(directory, name.replace(/[^a-z0-9]+/gi, "_") + ".wgsl");
    fs.writeFileSync(file, source);
    const run = spawnSync(naga, [file], { encoding: "utf8" });
    ++checked;
    if (run.status !== 0)
        failures.push({ name, output: (run.stderr || run.stdout || "").trim(),
            source });
}

// Every combination the executor can ask for. The impossible ones are left
// out on purpose: a fill never resolves a source palette or tests a source
// key, and a true-colour destination is the only thing a palette resolve can
// write into. Fills can still test a destination key.
for (const sourceKind of ["float", "index", "none"]) {
    for (const destinationKind of ["float", "index"]) {
        for (const colorKey of [false, true]) {
            for (const destinationKey of [false, true]) {
                for (const paletteResolve of [false, true]) {
                    if (sourceKind === "none" && (colorKey || paletteResolve))
                        continue;
                    if (paletteResolve && (sourceKind !== "index" ||
                            destinationKind !== "float"))
                        continue;
                    const variant = { sourceKind, destinationKind, colorKey,
                        destinationKey, paletteResolve, filterPoint: true };
                    validate([sourceKind, destinationKind,
                        colorKey ? "source-key" : "no-source-key",
                        destinationKey ? "destination-key" : "no-destination-key",
                        paletteResolve ? "palette" : "nopalette"].join("-"),
                        ddBlitShaderSource(variant));
                }
            }
        }
    }
}

// Indexed sampling companions preserve RGB and turn only keyed indices transparent.
for (const paletteResolve of [false, true]) validate("indexed-key-alpha-" + paletteResolve,
    ddBlitShaderSource({ sourceKind: "index", destinationKind: "float", colorKey: true,
        keyToAlpha: true, paletteResolve, destinationKey: false, filterPoint: true }));

// The two variants the 2D path lives on, spelled out so a regression names
// itself rather than appearing as "variant 7 failed".
validate("sprite-blit-p8-into-p8-with-source-key", ddBlitShaderSource({
    sourceKind: "index", destinationKind: "index", colorKey: true,
    destinationKey: false, paletteResolve: false, filterPoint: true }));
validate("sprite-blit-rgb-with-destination-key", ddBlitShaderSource({
    sourceKind: "float", destinationKind: "float", colorKey: false,
    destinationKey: true, paletteResolve: false, filterPoint: true }));
validate("present-p8-primary-to-canvas", ddBlitShaderSource({
    sourceKind: "index", destinationKind: "float", colorKey: false,
    destinationKey: false, paletteResolve: true, filterPoint: true }));

if (failures.length) {
    for (const failure of failures) {
        console.error("FAIL " + failure.name);
        console.error(failure.output.split("\n").slice(0, 12).join("\n"));
    }
    console.error(failures.length + " of " + checked +
        " DirectDraw blit shaders failed to compile");
    process.exit(1);
}
assert.ok(checked >= 20, "the variant sweep should cover at least twenty shaders");
console.log(checked + " DirectDraw blit shaders validated with naga");
