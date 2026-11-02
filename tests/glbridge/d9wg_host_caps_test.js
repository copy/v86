"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os"), {spawnSync} = require("node:child_process");
const P = require("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js"), {makeExecutor} = require("./d3d9_webgpu_executor_test.js");
(async () => {
    const {site_directory} = await import("../lib/site.mjs"), site = site_directory(path.resolve(__dirname, "../..")), {executor} = makeExecutor(); await executor.initialize();
    if (process.env.D9WG_HOST_CAPS_SOURCE) {
        const Module = require("node:module"), file = path.resolve(__dirname, "../../src/browser/glbridge/d3d9-webgpu/d3d9_executor.js"), m = new Module(file);
        m.filename = file; m.paths = Module._nodeModulePaths(path.dirname(file)); m._compile(fs.readFileSync(process.env.D9WG_HOST_CAPS_SOURCE, "utf8"), file);
        for (const name of ["hostFeatureBits", "publishHostCapabilities"]) executor[name] = m.exports.D3D9WebGPUExecutor.prototype[name];
    }
    const features = ["float32-filterable", "float32-blendable", "texture-compression-bc", "timestamp-query"], tail = P.C.D9WG_RESPONSE_REGION_BYTES - P.C.D9WG_HEARTBEAT_BYTES, absolute = (16 << 20) - P.C.D9WG_RESPONSE_REGION_BYTES + tail;
    assert.equal(P.C.D9WG_HOST_CAPS_OFFSET, tail + 4); assert.equal(P.STRUCTS.HostCapabilities.size, 12); assert.equal(P.F.HostCapabilities.magic, 8);
    const memories = new Map(), writes = new Map();
    function metadata(owner, fail = false) {
        if (!memories.has(owner)) { memories.set(owner, Buffer.alloc(16, 0xcc)); writes.set(owner, []); }
        let attempts = 0;
        return {ownerToken: owner, writeGuestMemory(offset, bytes) {
            ++attempts;
            if (fail === true || (typeof fail === "number" && attempts === fail)) throw Error("injected capability transport failure");
            assert(offset >= absolute && offset + bytes.length <= absolute + 16, "capabilities must stay in reserved owner tail");
            Buffer.from(bytes).copy(memories.get(owner), offset - absolute); writes.get(owner).push({offset: offset - absolute, bytes: Buffer.from(bytes), snapshot: Buffer.from(memories.get(owner))});
        }};
    }
    const batch = (session, hello) => P.encodeBatch(hello ? [{opcode: P.OP.HELLO, payload: P.encode("Hello", {guest_pointer_bits: 32, session_id_low: session})}] : [], {session_id_low: session});
    for (let mask = 0; mask < 16; ++mask) {
        executor.device.features = new Set(features.filter((_, bit) => mask & (1 << bit)));
        const owner = mask + 1; await executor.submit(batch(7, true), metadata(owner)); await executor.idle();
        assert.equal(executor.hostFeatureBits(), mask, "only actual enabled device features grant flags");
        const memory = memories.get(owner), events = writes.get(owner); assert.equal(events.length, 4);
        assert.deepEqual(events.map(e => [e.offset, e.bytes.length]), [[12, 4], [4, 8], [12, 4], [0, 4]], "invalidate, data, completion, unchanged heartbeat");
        assert.equal(events[0].snapshot.readUInt32LE(12), 0); assert.equal(events[1].snapshot.readUInt32LE(12), 0);
        assert.equal(memory.readUInt32LE(4), mask); assert.equal(memory.readUInt32LE(8), 1); assert.equal(memory.readUInt32LE(12), 0x50414348);
        await executor.submit(batch(7, false), metadata(owner)); await executor.idle(); assert.equal(events.length, 5, "unchanged reply needs no repeated memory writes");
    }
    // Changing enabled device features refreshes every live owner lazily.
    executor.device.features = new Set(); await executor.submit(batch(7, false), metadata(16)); await executor.idle(); assert.equal(memories.get(16).readUInt32LE(4), 0); assert.equal(writes.get(16).length, 9);
    const oldWarn = executor.warnOnce; executor.warnOnce = () => {};
    executor.device.features = new Set([features[0]]); await executor.submit(batch(7, false), metadata(10, 2)); await executor.idle(); assert.equal(memories.get(10).readUInt32LE(12), 0, "partial update invalidates its earlier completion");
    executor.device.features = new Set([features[0], features[3]]); await executor.submit(batch(7, false), metadata(10)); await executor.idle(); assert.equal(memories.get(10).readUInt32LE(12), 0x50414348, "reverting to an older feature mask must republish after a partial write");
    await executor.submit(batch(8, true), metadata(77, true)); await executor.idle(); assert(executor.stats.responseWriteFailures > 0);
    await executor.submit(batch(8, false), metadata(77)); await executor.idle(); assert.equal(memories.get(77).readUInt32LE(12), 0x50414348, "failed reply must retry next batch"); executor.warnOnce = oldWarn;
    executor.endOwnerSessions(77); assert(!executor.hostCapabilitiesByOwner.has(77));
    executor.endOwnerSessions(); assert.equal(executor.hostCapabilitiesByOwner.size, 0);
    assert.equal(executor.stats.commandsFailed, 0); assert.equal(executor.hostErrors.length, 0);
    const code = `#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include "${process.env.D9WG_HOST_CAPS_HEADER || site + "/glbridge/runtime/d9wg_host_caps.h"}"
#define CHECK(x) do{if(!(x)){fprintf(stderr,"host caps line %u: %s\\n",__LINE__,#x);return 1;}}while(0)
static uint32_t region[D9WG_RESPONSE_REGION_BYTES/4];
int main(void){D9WGHostCapabilities *reply=(D9WGHostCapabilities *)((uint8_t *)region+D9WG_HOST_CAPS_OFFSET);uint32_t out=0xccccccccu;
 CHECK(sizeof(*reply)==12&&D9WG_HOST_CAPS_OFFSET+sizeof(*reply)==D9WG_RESPONSE_REGION_BYTES);CHECK(!d9wg_host_caps_read(0,&out)&&out==0xccccccccu);CHECK(!d9wg_host_caps_read(region,0));
 for(uint32_t mask=0;mask<16;++mask){reply->feature_bits=mask;reply->version=1;reply->magic=0;out=0xccccccccu;CHECK(!d9wg_host_caps_read(region,&out)&&out==0xccccccccu);reply->magic=0x50414348u;CHECK(d9wg_host_caps_read(region,&out)&&out==mask);}
 for(uint32_t version=0;version<=2;++version){if(version==1)continue;reply->version=version;out=0xccccccccu;CHECK(!d9wg_host_caps_read(region,&out)&&out==0xccccccccu);}reply->version=1;reply->feature_bits=0xffffffffu;CHECK(d9wg_host_caps_read(region,&out)&&out==15);reply->magic=0x48434150u;out=0xccccccccu;CHECK(!d9wg_host_caps_read(region,&out)&&out==0xccccccccu);
 puts("PASS C host caps: exact reserved-tail ABI, all 16 enabled masks, absent/bad/future replies, unknown flags masked and atomic caller output");return 0;}
`;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "d9wg-host-caps-"));
    try {
        const file = path.join(directory, "caps.c"), binary = path.join(directory, "caps"); fs.writeFileSync(file, code);
        const build = spawnSync(process.env.HOST_CC || "cc", ["-std=c11", "-Os", "-Wall", "-Wextra", "-Werror", "-I", site + "/glbridge/runtime", file, "-o", binary], {encoding: "utf8"}); assert.equal(build.status, 0, build.stderr);
        const run = spawnSync(binary, [], {encoding: "utf8"}); assert.equal(run.status, 0, run.stderr); process.stdout.write(run.stdout);
    } finally { fs.rmSync(directory, {recursive: true, force: true}); }
    console.log("PASS host caps HELLO: sixteen actual device feature masks, colliding owner sessions, publication order, stable heartbeat, cached/revised replies and retry after transport failure");
})().catch(error => {console.error(error); process.exitCode = 1;});
