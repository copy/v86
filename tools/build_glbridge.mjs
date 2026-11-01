#!/usr/bin/env node
import { readFile as read_file, mkdir, writeFile as write_file, copyFile as copy_file } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHash as create_hash } from "node:crypto";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const source = new URL("src/browser/glbridge/", root);
const output = new URL("build/glbridge/", root);
// Keep this order explicit: the existing modules bind dependencies at load time.
const files = [
    "webgpu_host.js",
    "d3d9-webgpu/d3d9_shader_pipeline.js", "d3d9-webgpu/d9wg_protocol.js", "d3d9-webgpu/d9wg_wire.js", "d3d9-webgpu/d9wg_state.js", "d3d9-webgpu/d9wg_formats.js", "d3d9-webgpu/d3d9_executor.js",
    "d3d9-webgpu/ddraw_ops.js", "gl-webgpu/gl_protocol.js",
    "gl-webgpu/gl_constants.js", "gl-webgpu/gl_caps.js", "gl-webgpu/gl_glslang.js", "gl-webgpu/gl_math.js", "gl-webgpu/gl_client_arrays.js", "gl-webgpu/gl_image_formats.js", "gl-webgpu/gl_texture_parameters.js", "gl-webgpu/gl_framebuffer_state.js", "gl-webgpu/gl_pixel_maps.js", "gl-webgpu/gl_shadow.js",
    "gl-webgpu/gl_shadow_glsl.js", "gl-webgpu/gl_shadow_objects.js", "gl-webgpu/gl_shadow_state.js", "gl-webgpu/gl_shadow_raster.js", "gl-webgpu/gl_shadow_fixed.js", "gl-webgpu/gl_shadow_misc.js", "gl-webgpu/gl_shadow_rasterpos.js", "gl-webgpu/gl_shadow_pixelmaps.js", "gl-webgpu/gl_shadow_stipple.js", "gl-webgpu/gl_shadow_images.js", "gl-webgpu/gl_shadow_textures.js", "gl-webgpu/gl_shadow_buffers.js", "gl-webgpu/gl_shadow_arrays.js", "gl-webgpu/gl_shadow_names.js", "gl-webgpu/gl_shadow_queries.js", "gl-webgpu/gl_list_arrays.js", "gl-webgpu/gl_shadow_lists.js", "gl-webgpu/gl_shadow_stencil_ext.js", "gl-webgpu/gl_shadow_render.js", "gl-webgpu/gl_select_geometry.js", "gl-webgpu/gl_shadow_select.js", "gl-webgpu/gl_shadow_evaluators.js", "gl-webgpu/gl_state_layout.js",
    "gl-webgpu/gl_shader_translator.js", "gl-webgpu/gl_cache_keys.js", "gl-webgpu/gl_program_geometry.js", "gl-webgpu/gl_polygon_clip.js", "gl-webgpu/gl_single_sample.js", "gl-webgpu/gl_bind_layouts.js", "gl-webgpu/gl_fixed_function.js",
    "gl-webgpu/gl_arb_program.js", "gl-webgpu/gl_shadow_arb.js", "gl-webgpu/gl_snapshot_codec.js", "gl-webgpu/gl_gpu_snapshot.js", "gl-webgpu/gl_renderer_snapshot.js", "gl-webgpu/gl_executor.js",
    "graphics_journal.js", "v86_network_bridge.js", "webgpu_compositor.js", "v86gl_device.js", "graphics_proxy.js",
    "shader_ir/dxbc_frontend.js", "shader_ir/wgsl_emitter.js", "gx/tessellator_wgsl.js", "gx/gx_executor.js",
    "vx/vx_executor.js", "svga_renderer.js",
];
const contents = await Promise.all(files.map(file => read_file(new URL(file, source), "utf8")));
// GX's format table, from the device's (tools/svga_gx_formats.mjs)
const { gx_formats } = await import(new URL("tools/svga_gx_formats.mjs", root));
const formats = "globalThis.V86SVGADXFormats = " + JSON.stringify(gx_formats()) + ";\n" +
    // VX's, the Venus device's (src/graphics_adapters/virtio_gpu/venus_device_info.js)
    "globalThis.V86VenusFormats = " + JSON.stringify((await import(new URL("src/graphics_adapters/virtio_gpu/venus_device_info.js", root))).FORMATS) + ";";
// VX's opcodes: the executor's table is the device's (renderer_protocol.js)
{
    const { VX } = await import(new URL("src/graphics_adapters/renderer_protocol.js", root));
    const executor = contents[files.indexOf("vx/vx_executor.js")];
    const table = executor.slice(executor.indexOf("const VX = {"), executor.indexOf("};", executor.indexOf("const VX = {")));
    const theirs = Object.fromEntries([...table.matchAll(/([A-Z_]+): (\d+)/g)].map(m => [m[1], +m[2]]));
    for(const [name, op] of Object.entries(VX))
    {
        if(theirs[name] !== op) throw new Error("vx_executor.js: VX." + name + " is " + theirs[name] + ", renderer_protocol.js says " + op);
    }
}
// The GLES executor (src/gles/page/, ES modules; docs/gles-proxy-plan.md E3),
// bundled by esbuild after the scripts: its GLSL front end is theirs (the two
// scripts' imports stand for nothing here)
{
    const esbuild = await import("esbuild");
    const scripts = new Set(["gl_state_layout.js", "gl_shader_translator.js"]);
    const built = await esbuild.build({
        entryPoints: [fileURLToPath(new URL("src/gles/page/entry.js", root))], bundle: true, write: false, format: "iife",
        target: "es2020", legalComments: "none",
        plugins: [{ name: "glbridge-scripts", setup(build)
        {
            build.onResolve({ filter: /gl-webgpu\/gl_(state_layout|shader_translator)\.js$/ }, args =>
                scripts.has(args.path.split("/").pop()) ? { path: args.path, namespace: "glbridge-script" } : undefined);
            build.onLoad({ filter: /.*/, namespace: "glbridge-script" }, () => ({ contents: "", loader: "js" }));
        } }],
    });
    contents.splice(files.indexOf("svga_renderer.js"), 0, built.outputFiles[0].text);
    files.splice(files.indexOf("svga_renderer.js"), 0, "gles_executor (src/gles/page)");
}
const worker = await read_file(new URL("d3d9-webgpu/d3d9_shader_worker.js", source), "utf8");
const journal_worker = await read_file(new URL("graphics_journal_worker.js", source), "utf8");
// The device half alone, for the CPU worker (importScripts): the device and
// the GL shadow it answers the guest's queries with
const device = ["gl-webgpu/gl_protocol.js", "gl-webgpu/gl_constants.js", "gl-webgpu/gl_caps.js", "gl-webgpu/gl_glslang.js",
    "gl-webgpu/gl_math.js", "gl-webgpu/gl_client_arrays.js", "gl-webgpu/gl_image_formats.js", "gl-webgpu/gl_texture_parameters.js", "gl-webgpu/gl_framebuffer_state.js", "gl-webgpu/gl_pixel_maps.js", "gl-webgpu/gl_shadow.js", "gl-webgpu/gl_shadow_glsl.js", "gl-webgpu/gl_shadow_objects.js", "gl-webgpu/gl_shadow_state.js", "gl-webgpu/gl_shadow_raster.js", "gl-webgpu/gl_shadow_fixed.js", "gl-webgpu/gl_shadow_misc.js", "gl-webgpu/gl_shadow_rasterpos.js", "gl-webgpu/gl_shadow_pixelmaps.js", "gl-webgpu/gl_shadow_stipple.js", "gl-webgpu/gl_shadow_images.js", "gl-webgpu/gl_shadow_textures.js", "gl-webgpu/gl_shadow_buffers.js", "gl-webgpu/gl_shadow_arrays.js", "gl-webgpu/gl_shadow_names.js", "gl-webgpu/gl_shadow_queries.js", "gl-webgpu/gl_list_arrays.js", "gl-webgpu/gl_shadow_lists.js", "gl-webgpu/gl_shadow_stencil_ext.js", "gl-webgpu/gl_shadow_render.js", "gl-webgpu/gl_select_geometry.js", "gl-webgpu/gl_shadow_select.js", "gl-webgpu/gl_shadow_evaluators.js",
    "gl-webgpu/gl_state_layout.js", "gl-webgpu/gl_shader_translator.js", "gl-webgpu/gl_arb_program.js",
    "gl-webgpu/gl_shadow_arb.js", "v86gl_device.js"]
    .map(file => contents[files.indexOf(file)])
    .join("\n;\n");
const revision = create_hash("sha256").update(contents.join("\n") + worker + journal_worker).digest("hex").slice(0, 20);
const prefix = `globalThis.V86GL_BUILD_REVISION = ${JSON.stringify(revision)};\n`;
await mkdir(output, { recursive: true });
// Isolate CommonJS detection from a consuming page's module/require globals.
const bundle = prefix + "(function(module, require) {\n" + [formats, ...contents].join("\n;\n") + "\n})();\n";
await write_file(new URL("libv86-webgpu.js", output), bundle);
await write_file(new URL("d3d9_shader_worker.js", output), prefix + worker);
await write_file(new URL("d3d9_shader_pipeline.js", output),
    prefix + contents[files.indexOf("d3d9-webgpu/d3d9_shader_pipeline.js")]);
await write_file(new URL("graphics_journal_worker.js", output), prefix + journal_worker);
await write_file(new URL("v86gl-device.js", output), prefix + device);
// the GL shadow's GLSL front end (the GLES host's glslang, with its desktop entry points)
await copy_file(new URL("bios/glslang.wasm", root), new URL("glslang.wasm", output));
// VX's SPIR-V to WGSL (naga, src/browser/glbridge/vx/naga): built with cargo
// (from its cache when it can), next to the bundle, which loads it when a
// Venus context first makes a shader
const naga = fileURLToPath(new URL("src/browser/glbridge/vx/naga/", root));
const cargo_args = ["build", "--release", "--target", "wasm32-unknown-unknown"];
let built = spawnSync("cargo", [...cargo_args, "--offline"], { cwd: naga, stdio: "inherit" }).status === 0 ||
    spawnSync("cargo", cargo_args, { cwd: naga, stdio: "inherit" }).status === 0;
if(built) await copy_file(new URL("build/wasm32-unknown-unknown/release/vx_naga.wasm", root), new URL("vx_naga.wasm", output));
else console.warn("cargo failed: build/glbridge/vx_naga.wasm (Venus's shaders) is not built");
await write_file(new URL("manifest.json", output), JSON.stringify({ revision, files: [
    "libv86-webgpu.js", "d3d9_shader_worker.js", "d3d9_shader_pipeline.js", "graphics_journal_worker.js",
    "v86gl-device.js", "glslang.wasm", ...(built ? ["vx_naga.wasm"] : []),
] }, null, 2) + "\n");
console.log(`Built WebGPU graphics ${revision} in ${fileURLToPath(output)}`);
