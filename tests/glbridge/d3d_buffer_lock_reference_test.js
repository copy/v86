"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),{spawnSync}=require("node:child_process"),r=require("./fixtures/d3d_buffer_lock_reference.json");
(async()=>{
 const {site_directory}=await import("../lib/site.mjs"),root=path.resolve(__dirname,"../.."),site=site_directory(root),generated=spawnSync(process.execPath,[root+"/tools/gen_d3d_buffer_lock_reference.mjs"],{encoding:"utf8"});assert.equal(generated.status,0,generated.stderr);assert.equal(fs.readFileSync(site+"/glbridge/tests/native/d3d_buffer_lock_reference.h","utf8"),generated.stdout);
 assert.equal(r.contexts.length,12);assert.deepEqual(r.flags,[0,16,4096,4112,8192,8208,12288,12304]);assert.equal(new Set(r.contexts.map(c=>c.pool+"/"+c.usage)).size,12);for(const c of r.contexts){assert.equal(c.effective.length,8);for(const f of c.effective)assert([0,16,4096,8192].includes(f));}assert.equal(r.windowsXP.length,7);for(const c of r.windowsXP)assert.equal(c.hresult,0);assert.equal(r.sources.length,8);for(const source of r.sources){assert.match(source.blobSha,/^[a-f0-9]{40}$/);assert.match(source.sha256,/^[a-f0-9]{64}$/);}
 console.log("PASS frozen buffer Lock reference: seven XP HRESULT observations, 96 independent access/streaming cases, eight pinned Wine blobs and generated guest facts");
})().catch(error=>{console.error(error);process.exitCode=1;});
