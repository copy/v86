import vm from "node:vm";
import url from "node:url";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import perf_hooks from "node:perf_hooks";


const __dirname = url.fileURLToPath(new URL(".", import.meta.url));

let files = [
    "src/const.js",
    "src/config.js",
    "src/log.js",
    "src/lib.js",
    "src/virtio.js",

    "lib/9p.js",
    "lib/filesystem.js",
    "lib/jor1k.js",
    "lib/marshall.js",
];



let ctx = vm.createContext(globalThis);

Object.defineProperty(globalThis, "crypto", {value: crypto});
globalThis.require = (what) => {
    return ({
        perf_hooks,
        fs
    })[what];
};

for( let f of files ) {
    console.log(f);
    vm.runInContext(fs.readFileSync(path.join(__dirname, f), "utf8"), ctx, {
        filename: f
    });
}

console.log(globalThis);

var V86 = await import("./src/browser/starter.js");
export default V86.V86;

