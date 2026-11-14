#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {createHash} from "node:crypto";
import {verify_geforce_checkpoint_bundle} from "../lib/geforce_checkpoint.mjs";
const directory=fs.mkdtempSync(path.join(os.tmpdir(),"nv40-checkpoint-"));
try
{
    const options={guest:"xp",vramMiB:128,osImage:"/original-os.img",gameImage:"/original-game.img"},bundle={status:"complete",...options};
    for(const [field,text]of [["state","RAM at checkpoint"],["osOverlay","pagefile sectors"],["gameOverlay","project sectors"]])
    {
        const file=path.join(directory,field),bytes=Buffer.from(text);fs.writeFileSync(file,bytes);options[field]=file;
        bundle[field]={file,bytes:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex")};
    }
    const manifest=options.state+".bundle.json",save=()=>fs.writeFileSync(manifest,JSON.stringify(bundle));save();
    assert.deepEqual(await verify_geforce_checkpoint_bundle(options),bundle);
    const moved=path.join(directory,"moved-os");fs.copyFileSync(options.osOverlay,moved);
    await verify_geforce_checkpoint_bundle({...options,osOverlay:moved});
    fs.writeFileSync(moved,"later disk bytes");
    await assert.rejects(verify_geforce_checkpoint_bundle({...options,osOverlay:moved}),/osOverlay SHA-256/);
    await assert.rejects(verify_geforce_checkpoint_bundle({...options,osOverlay:null}),/requires matching osOverlay/);
    await assert.rejects(verify_geforce_checkpoint_bundle({...options,gameOverlay:null}),/requires matching gameOverlay/);
    await assert.rejects(verify_geforce_checkpoint_bundle({...options,guest:"win98"}),/guest mismatch/);
    await assert.rejects(verify_geforce_checkpoint_bundle({...options,vramMiB:256}),/vramMiB mismatch/);
    await assert.rejects(verify_geforce_checkpoint_bundle({...options,gameImage:"/other-game.img"}),/gameImage mismatch/);
    fs.writeFileSync(options.state,"different RAM!!!");
    await assert.rejects(verify_geforce_checkpoint_bundle(options),/state size mismatch/);
    bundle.status="writing";save();await assert.rejects(verify_geforce_checkpoint_bundle(options),/incomplete/);
    fs.unlinkSync(manifest);assert.equal(await verify_geforce_checkpoint_bundle(options),null);
    console.log("PASS: NV40 matching RAM/pagefile/game checkpoint bundles; wrong sectors, missing companions and guest/VRAM/image mismatches rejected");
}
finally {fs.rmSync(directory,{recursive:true,force:true});}
