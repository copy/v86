// Real D9WG rendering for RAM-only XP probes. Serialize batches so the existing
// remote transport's write packets always belong to the active generation.
import assert from "node:assert/strict";
import {create_remote_renderer} from "../x64/gpu_remote_renderer.mjs";
export async function create_d3d_live_renderer(options = {}) {
    const stats = {batches:0, releases:0, writes:0, snapshot:null};
    const remote = await create_remote_renderer({page:"d3d_remote_renderer.html", timeout:options.timeout,
        on_log(line) {stats.snapshot = JSON.parse(line);}});
    return attach_d3d_live_renderer(remote, options, stats);
}

export function attach_d3d_live_renderer(remote, options = {}, stats = {batches:0, releases:0, writes:0, snapshot:null}) {
    let active = null, sequence = 0, closed = false, failure = null;
    let queue = Promise.resolve();
    remote.renderer.listen(message => {
        if (closed) return;
        if (message.type === "lost") {
            stats.failure = message.reason;
            failure = new Error(message.reason); if (active) active.reject(failure); return;
        }
        if (!active) {failure = new Error("Unexpected GPU response without an active batch");return;}
        if (message.type === "write") {
            try {stats.writes++;active.write(message.offset,message.bytes);}
            catch(error) {failure=error;active.reject(error);}
        }
        if (message.type === "done") {
            if (message.seq !== active.seq) active.reject(new Error("GPU completion sequence mismatch"));
            else active.resolve();
        }
    });
    function send(owner, flags, bytes, write) {
        assert(Number.isInteger(owner) && owner > 0 && owner <= 0xffffffff);
        const work = queue.then(async () => {
            if (failure) throw failure;
            if (closed) throw new Error("GPU renderer is closed");
            const seq = ++sequence, head = Buffer.alloc(8);head.writeUInt32LE(owner);head.writeUInt32LE(flags >>> 0,4);
            let timer;
            try {
                await new Promise((resolve,reject) => {
                    active = {seq,write,resolve,reject};
                    timer = setTimeout(() => reject(new Error("GPU batch timed out")), options.batch_timeout || 30000);
                    remote.renderer.post({type:"submit",seq,bytes:Buffer.concat([head,bytes])});
                });
            } finally {clearTimeout(timer);active=null;}
        });
        queue = work.catch(error => {failure = error;});
        return work;
    }
    return {
        stats,
        submit(message,write) {stats.batches++;return send(message.ownerToken,message.flags||0,Buffer.from(message.bytes),write);},
        release(owner) {stats.releases++;return send(owner,0xffffffff,Buffer.alloc(0),()=>{throw new Error("Unexpected write during owner release");});},
        async idle() {await queue;if(failure) throw failure;},
        close() {closed=true;if(active)active.reject(new Error("GPU renderer closed"));return remote.close();},
    };
}
