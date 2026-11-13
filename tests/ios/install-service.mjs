import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { IOSInstallService } from "../../src/ios/install_service.js";
import { INSTALL_OP as OP, INSTALL_SERVICE, install_frame, install_frame_reader, install_proof } from "../../src/ios/install_protocol.js";
import { save_state } from "../../src/state.js";
import { IOS_STATIC_TRUST_HEAD,IOS_TRUST_ARENA_BYTES } from "../../src/ios/runtime_trust.js";

const json = value => new TextEncoder().encode(JSON.stringify(value));
function setup()
{
    const events = [], token = "42".repeat(32), state = { format: "v86-ios-install-state", version: 1, build: "10B329",
        generation: 1, token, system_hashes: ["01".repeat(20)], apps: [], pending: null };
    const host = new IOSInstallService({ send: (name, value) => events.push([name, value]) }, { install: state, kernel: new Uint8Array(0) });
    const pipe = host.service(INSTALL_SERVICE), received = [];
    const read = install_frame_reader((op, sequence, payload) => received.push({ op, sequence, payload }));
    function drain() { while(pipe.available()) read(pipe.read(7)); return received.splice(0); }
    const challenge = drain()[0];
    return { host, pipe, events, state, challenge, drain };
}
function authenticate(s,features={})
{
    const packet = signed(s, OP.HELLO, 0, { protocol: 1, build: "10B329", phase: "idle",...features });
    for(let at = 0; at < packet.length; at += 3) s.pipe.write(packet.subarray(at, at + 3));
    return s.drain();
}
function signed(s, op, sequence, value)
{
    const body = json(value), prefix = Buffer.alloc(40); prefix.set(s.challenge.payload);
    prefix.writeUInt32LE(op, 32); prefix.writeUInt32LE(sequence, 36);
    const proof = createHmac("sha256", Buffer.from(s.state.token, "hex")).update(prefix).update(body).digest();
    return install_frame(op, sequence, Buffer.concat([proof, body]));
}
test("installer handshake matches independent HMAC and supports fragmented reads/writes", () => {
    const s = setup(); assert.equal(s.challenge.op, OP.CHALLENGE);
    assert.deepEqual(Buffer.from(install_proof(s.state.token, s.challenge.payload)),
        createHmac("sha256", Buffer.from(s.state.token, "hex")).update(s.challenge.payload).digest());
    assert.equal(authenticate(s)[0].op, OP.READY); assert.equal(s.host.status().available, true);
    assert.ok(!("token" in s.host.status())); assert.equal(s.host.service(INSTALL_SERVICE), null);
    assert.deepEqual(s.host.get_state(), [2, 1, null, ["01".repeat(20)]]);
});
test("application launch requires capability and a persisted local application",async()=>{
    const s=setup();authenticate(s,{can_launch:true});
    assert.throws(()=>s.host.launch("com.apple.Preferences"),/installed application list/);
    s.host.state.apps.push({bundle_id:"org.v86.Test",hashes:["02".repeat(20)],version:"1"});
    const pending=s.host.launch("org.v86.Test"),command=s.drain()[0];
    assert.equal(command.op,OP.LAUNCH);assert.equal(new TextDecoder().decode(command.payload),"org.v86.Test");
    s.pipe.write(signed(s,OP.REPLY,command.sequence,{ok:true,phase:"installed",status:"Application launch requested",installed:true}));
    assert.equal((await pending).status,"Application launch requested");
    const old=setup();authenticate(old);assert.throws(()=>old.host.launch("org.v86.Test"),/cannot open/);
});
test("installation arena round-trips through the real snapshot serializer",()=>{
    globalThis.DEBUG=false;
    const s=setup(),arena={physical:0x41000000,virtual:0x81000000,size:IOS_TRUST_ARENA_BYTES,used:0,head:IOS_STATIC_TRUST_HEAD};
    s.host.set_arena(arena);
    class Snapshot { get_state(){return[s.host.get_state()];} }
    const bytes=save_state(new Snapshot()),v=new DataView(bytes);
    const meta=JSON.parse(new TextDecoder().decode(new Uint8Array(bytes,16,v.getUint32(12,true))));
    s.host.set_state(meta.state[0]);assert.deepEqual(s.host.arena,arena);
    assert.throws(()=>s.host.check_state([2,1,[1,2,3,4],[]]),/arena/);
    s.host.check_state([1,1,null,["01".repeat(20)]]);
});
test("invalid authentication and malformed frames disconnect without crashing the VM", () => {
    const s = setup(), hello = json({ protocol: 1, build: "10B329" }), payload = new Uint8Array(32 + hello.length); payload.set(hello, 32);
    assert.doesNotThrow(() => s.pipe.write(install_frame(OP.HELLO, 0, payload)));
    assert.equal(s.host.status().available, false);
    const other = setup(); assert.doesNotThrow(() => other.pipe.write(new Uint8Array(16)));
    assert.equal(other.host.status().available, false);
});
test("native replies resolve only their request and progress is observable", async () => {
    const s = setup(); authenticate(s);
    const pending = s.host.lookup("org.v86.Test"), command = s.drain()[0];
    assert.equal(command.op, OP.LOOKUP);
    s.pipe.write(signed(s, OP.PROGRESS, command.sequence, { phase: "verifying", install_id: "task" }));
    assert.throws(() => s.host.get_state(), /before saving/);
    s.pipe.write(signed(s, OP.REPLY, command.sequence, { ok: true, installed: true, phase: "installed" }));
    assert.equal((await pending).installed, true); assert.equal(s.host.status().phase, "installed");
    assert.ok(s.events.some(([, event]) => event.phase === "verifying"));
    assert.throws(() => s.host.check_state([1, 2]), /different/);
    const another = s.host.lookup("org.v86.Test"); s.pipe.close(); await assert.rejects(another, /disconnected/);
});
