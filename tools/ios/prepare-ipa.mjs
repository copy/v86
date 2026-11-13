import fs from "node:fs";
import { prepare_ipa } from "../../src/ios/ipa_prepare.js";

const [input, output, option, ...extra] = process.argv.slice(2);
if(!output || extra.length || option && option !== "--no-graphics")
    throw new Error("usage: prepare-ipa.mjs input.ipa new-output.ipa [--no-graphics]");
const source = fs.openSync(input, "r"), destination = fs.openSync(output, "wx");
let success = false;
try
{
    const size = fs.fstatSync(source).size;
    const manifest = await prepare_ipa((at, count) => {
        const bytes = new Uint8Array(count);
        if(fs.readSync(source, bytes, 0, count, at) !== count) throw new Error("Short IPA read");
        return bytes;
    }, size, bytes => {
        if(fs.writeSync(destination, bytes) !== bytes.length) throw new Error("Short IPA write");
    }, { graphics: option !== "--no-graphics" });
    fs.fsyncSync(destination);
    fs.writeFileSync(output + ".json", JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
    success = true;
    console.log(manifest.bundle_id + " " + manifest.version + ": " + manifest.prepared_size + " bytes, " + manifest.trusted.length + " code images");
}
finally { fs.closeSync(source); fs.closeSync(destination); if(!success) fs.unlinkSync(output); }
