// S4 physical medium. Page dumps are data followed by OOB. The sparse
// output initially contains only the explicitly supplied physical pages.
//   nand_build.mjs blank|bootstrap new.img [bus:ce:row:page.bin ...]
import { write_bootstrap_pages } from "./nand_layout.mjs";
import fs from "node:fs";
import path from "node:path";
import { NAND_BYTES, NAND_PAGE, NAND_SLOT, nand_offset } from "../../src/apple/nand.js";

const [command, output, ...pages] = process.argv.slice(2);
if(!["blank", "bootstrap"].includes(command) || !output) throw new Error("usage: nand_build.mjs blank|bootstrap new.img [bus:ce:row:page.bin ...]");
const dir = fs.mkdtempSync(path.join(path.dirname(path.resolve(output)), ".n90-nand-"));
const temporary = path.join(dir, "image");
const written = new Set();
try
{
    const fd = fs.openSync(temporary, "wx");
    try
    {
        fs.ftruncateSync(fd, NAND_BYTES);
        const put = (bus, ce, row, raw) => {
            const at = nand_offset(bus, ce, row);
            if(at < 0 || written.has(at)) throw new Error("invalid or duplicate page at " + [bus, ce, row].join(":"));
            if(raw.length !== NAND_PAGE) throw new Error("expected data and spare bytes in the page");
            const slot = Buffer.alloc(NAND_SLOT);
            for(let i = 0; i < raw.length; i++) slot[i] = ~raw[i];
            let done = 0;
            while(done < slot.length) done += fs.writeSync(fd, slot, done, slot.length - done, at + done);
            written.add(at);
        };
        if(command === "bootstrap") write_bootstrap_pages(put);
        for(const arg of pages)
        {
            const m = /^(\d+):(\d+):(\d+):(.+)$/.exec(arg);
            if(!m) throw new Error("invalid physical page " + arg);
            put(Number(m[1]), Number(m[2]), Number(m[3]), fs.readFileSync(m[4]));
        }
    }
    finally { fs.closeSync(fd); }
    fs.linkSync(temporary, output);
}
finally { fs.rmSync(dir, { recursive: true, force: true }); }
console.log("Created four-chip N90 NAND with " + written.size + " populated physical pages");
