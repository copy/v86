// Checkpoint companions must match the RAM save, including the OS pagefile.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {createHash} from "node:crypto";

export async function verify_geforce_checkpoint_bundle(options)
{
    if(!options.state)return null;
    const manifest=options.state+".bundle.json";
    if(!fs.existsSync(manifest))return null; // Legacy investigation snapshots.
    const bundle=JSON.parse(fs.readFileSync(manifest,"utf8"));
    assert.equal(bundle.status,"complete","NV40 checkpoint bundle is incomplete");
    for(const field of ["guest","vramMiB"])assert.equal(bundle[field],options[field],"NV40 checkpoint "+field+" mismatch");
    for(const field of ["osImage","gameImage"])
        assert.equal(bundle[field]?path.resolve(bundle[field]):null,options[field]?path.resolve(options[field]):null,"NV40 checkpoint "+field+" mismatch");
    for(const field of ["state","osOverlay","gameOverlay"])
    {
        const expected=bundle[field],file=options[field];
        if(!expected){assert(!file,"NV40 checkpoint has no "+field);continue;}
        assert(file,"NV40 checkpoint requires matching "+field);
        assert.equal(fs.statSync(file).size,expected.bytes,"NV40 checkpoint "+field+" size mismatch");
        const hash=createHash("sha256");
        for await(const bytes of fs.createReadStream(file,{highWaterMark:4<<20}))hash.update(bytes);
        assert.equal(hash.digest("hex"),expected.sha256,"NV40 checkpoint "+field+" SHA-256 mismatch");
    }
    return bundle;
}
