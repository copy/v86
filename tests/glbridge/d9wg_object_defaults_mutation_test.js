"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os"), {spawnSync} = require("node:child_process");
(async () => {
    const {site_directory} = await import("../lib/site.mjs"), site = site_directory(path.resolve(__dirname, "../.."));
    const files = {
        header: fs.readFileSync(site + "/glbridge/runtime/d9wg_state_defaults.h", "utf8"),
        bridge: fs.readFileSync(site + "/glbridge/runtime/d9wg_state_defaults_bridge.h", "utf8"),
        source: fs.readFileSync(site + "/glbridge/d3d9proxy/d3d9_proxy.c", "utf8"),
    };
    const cases = [
        ["SDK8 alpha", "header", "case 2u: return 0x3F800000u;", "case 2u: return 0x3F800000u;\n        case 3u: return 0x3F800000u;"],
        ["SDK8 ambient", "header", "case 2u: return 0x3F800000u;", "case 2u: return 0x3F800000u;\n        case 4u: return 0x3F800000u;"],
        ["zero clip planes", "header", "const uint32_t zero = 0;", "const uint32_t zero = 0x3f800000u;"],
        ["Reset objects", "source", "d9wg_object_defaults(api, &device->material, device->clip_planes, D9_MAX_CLIP_PLANES);", "/* retain old objects */"],
        ["Reset low light definitions", "source", "ZeroMemory(device->light_set, sizeof(device->light_set));", "/* retain definitions */"],
        ["Reset low light enables", "source", "ZeroMemory(device->light_enabled, sizeof(device->light_enabled));", "/* retain enables */"],
        ["Reset sparse lights", "source", "d9wg_light_free(&device->extra_lights);\n    ZeroMemory(device->lights", "/* retain sparse lights */\n    ZeroMemory(device->lights"],
        ["API8 material patch", "bridge", "if (!different) return TRUE;", "if (different) return TRUE;"],
        ["material transport failure", "bridge", "return emit_command(D9WG_OP_SET_MATERIAL, &command, sizeof(command));", "emit_command(D9WG_OP_SET_MATERIAL, &command, sizeof(command));return TRUE;"],
    ];
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "d9wg-object-mutants-"));
    try {
        for (const [name, kind, before, after] of cases) {
            assert.equal(files[kind].split(before).length, 2, name);
            const file = path.join(directory, "mutated." + (kind === "source" ? "c" : "h")); fs.writeFileSync(file, files[kind].replace(before, after));
            const key = kind === "header" ? "D9WG_OBJECT_DEFAULTS_HEADER" : kind === "bridge" ? "D9WG_OBJECT_DEFAULTS_BRIDGE" : "D9WG_OBJECT_DEFAULTS_D9_SOURCE";
            const run = spawnSync(process.execPath, [path.join(__dirname, "d9wg_object_defaults_test.js")], {env: {...process.env, [key]: file}, encoding: "utf8"});
            assert.notEqual(run.status, 0, "survived " + name); assert.match(run.stderr, /object default line/, "runtime assertion required: " + name);
        }
    } finally { fs.rmSync(directory, {recursive: true, force: true}); }
    console.log("PASS shared object-default mutations: 9/9; material version words, plane zero, actual Reset low/sparse lights and wire failures");
})().catch(error => {console.error(error); process.exitCode = 1;});
