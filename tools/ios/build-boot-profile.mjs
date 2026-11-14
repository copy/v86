// Build the optional test-only classic CPU Worker. Production stays untouched.
import { build } from "esbuild";
await build({
    entryPoints: ["tests/ios/boot-profile-worker.js"],
    outfile: "build/ios-boot-profile-worker.js", bundle: true, minify: true,
    format: "iife", target: "es2022",
    define: { DEBUG: "false", V86_BUNDLE: "true", "import.meta.url": "self.location.href" },
    external: ["node:*", "fs", "crypto", "path", "perf_hooks"],
    logOverride: { "commonjs-variable-in-esm": "silent" },
});
