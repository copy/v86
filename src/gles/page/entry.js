// The GLES executor in the page's WebGPU bundle (libv86-webgpu.js, built by
// tools/build_glbridge.mjs with esbuild): the SVGA renderer runs stream
// "gles" with it (src/browser/glbridge/svga_renderer.js). gl-webgpu's GLSL
// front end is the bundle's own (GLShaderTranslator, GLStateLayout).

import { GLESExecutor } from "./gles_executor.js";

globalThis["V86GLESExecutor"] = { "GLESExecutor": GLESExecutor };
