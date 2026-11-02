"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os"), {spawnSync} = require("node:child_process");
(async () => {
    const {site_directory} = await import("../lib/site.mjs"), site = site_directory(path.resolve(__dirname, "../..")), sources = {header: fs.readFileSync(site + "/glbridge/runtime/d9wg_format_queries.h", "utf8"), frontend: fs.readFileSync(site + "/glbridge/d3d9proxy/d3d9_proxy.c", "utf8")};
    const cases = [
        ["BC storage availability", "header", "if ((info & 32u) && !(host_features & 4u)) return 0;", "if (0 && (info & 32u) && !(host_features & 4u)) return 0;"],
        ["BC host discovery for plain queries", "frontend", "if ((info & 32u) || ((info & 4u)", "if ((0 && (info & 32u)) || ((info & 4u)"],
        ["float32 filter bit", "header", "!(host_features & 1u)", "!(host_features & 2u)"],
        ["float32 blend bit", "header", "!(host_features & 2u)", "!(host_features & 1u)"],
        ["false sRGB float view", "header", "case 114u: return 5u;", "case 114u: return 7u;"],
        ["raw depth filtering", "header", "((info & 8u) && !(info & 16u))", "(0 && (info & 8u) && !(info & 16u))"],
        ["SM2 vertex textures", "header", "shader_model < 3u", "shader_model < 2u"],
        ["volume color output", "header", "type == 1u || type == 3u || type == 5u", "type == 1u || type == 3u || type == 4u || type == 5u"],
        ["software shader textures", "header", "if (usage & 0x10u) return 0;", "if (0 && (usage & 0x10u)) return 0;"],
        ["compound requests", "header", "uint32_t query = usage & D9WG_FORMAT_QUERY_MASK;", "uint32_t query = usage & D9WG_FORMAT_QUERY_MASK;query &= 0u-query;"],
        ["all optional host features", "frontend", "host_features, shader_model_version(), renderable);", "(host_features | D9WG_HOST_FEATURE_MASK), shader_model_version(), renderable);"],
        ["color target predicate", "frontend", "BOOL renderable = supported_render_target_format(format);", "BOOL renderable = supported_render_target_format(format) || 1;"],
    ];
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "d9wg-format-query-mutants-"));
    try {
        for (const [name, kind, before, after] of cases) {
            assert.equal(sources[kind].split(before).length, 2, name); const file = path.join(directory, kind === "header" ? "mutated.h" : "mutated.c"); fs.writeFileSync(file, sources[kind].replace(before, after));
            const run = spawnSync(process.execPath, [path.join(__dirname, "d9wg_format_queries_test.js")], {env: {...process.env, [kind === "header" ? "D9WG_FORMAT_QUERY_HEADER" : "D9WG_FORMAT_QUERY_D9_SOURCE"]: file}, encoding: "utf8"});
            assert.notEqual(run.status, 0, "survived " + name); assert.match(run.stderr, /format query line/, "native runtime assertion required: " + name);
        }
    } finally {fs.rmSync(directory, {recursive: true, force: true});}
    console.log("PASS format query mutations: 12/12 host filter/blend bits, sRGB/depth/profile/resource restrictions, compound queries and actual frontend capability gating");
})().catch(error => {console.error(error); process.exitCode = 1;});
