// Create fresh disposable media and exercise the original IOP's descriptor
// refill path through native Darwin read/write. Requires the --nand shell.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
if(args.length !== 3) throw new Error("usage: nand-roundtrip.mjs kernel device-tree debug-ramdisk");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "n90-raw-write-"));
try
{
    const files = ["system", "scratch"].map((name, i) => {
        const file = path.join(dir, name);
        const bytes = Buffer.alloc((i ? 8 : 1) * 1024 * 1024);
        if(i) bytes.write("v86-N90-disposable-IO-test");
        bytes.write("HX", 1024);
        bytes.writeUInt32BE(4096, 1064);
        bytes.writeUInt32BE(bytes.length / 4096, 1068);
        fs.writeFileSync(file, bytes);
        return file;
    });
    const flash = path.join(dir, "flash.img");
    const run = (script, rest) => execFileSync(process.execPath,
        [fileURLToPath(new URL(script, import.meta.url)), ...rest], { stdio: "inherit" });
    run("../../tools/ios/nand_build.mjs", ["volumes", flash, ...files]);
    run("./recovery.mjs", [...args, "--scratch", flash]);
}
finally { fs.rmSync(dir, { recursive: true, force: true }); }
