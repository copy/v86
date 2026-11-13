// The host half of the authenticated native installer pipe. Only bounded
// protocol data crosses it; guest files are always written by the helper.
import { INSTALL_SERVICE, INSTALL_OP as OP, install_frame, install_frame_reader, install_message_mac, install_job, INSTALL_CHUNK } from "./install_protocol.js";
import { validate_install_state, stage_install_trust, finish_install_trust, install_hashes } from "./install_trust.js";
import { runtime_trust_node, publish_runtime_trust, validate_runtime_arena, IOS_TRUST_ARENA_BYTES } from "./runtime_trust.js";

function snapshot_arena(saved)
{
    const data=saved[2];
    if(saved[0]===1 || data===null)return data;
    if(!Array.isArray(data)||data.length!==5)throw new Error("Invalid iPhone snapshot code trust arena");
    return {physical:data[0],virtual:data[1],size:data[2],used:data[3],head:data[4]};
}

export class IOSInstallService
{
    constructor(bus, boot)
    {
        validate_install_state(boot.install);
        this.bus = bus; this.boot = boot;
        this.state = JSON.parse(JSON.stringify(boot.install));
        this.sequence = 0; this.pending = new Map(); this.connection = null;
        this.peer = null; this.next_boot = null;
        this.arena = null; this.trusted = new Set(install_hashes(this.state));
    }
    status()
    {
        return { ...this.peer, available: !!this.connection?.authenticated, protocol: 1, build: "10B329", generation: this.state.generation,
            phase: this.peer?.phase || "waiting" };
    }
    progress(value)
    {
        this.peer = { ...this.peer, ...value };
        this.bus.send("ios-install-progress", this.status());
    }
    reset()
    {
        this.connection?.close(); this.peer = null;
    }
    service(name)
    {
        if(name !== INSTALL_SERVICE) return null;
        // A second unauthenticated process cannot evict the active helper.
        if(this.connection?.authenticated) return null;
        this.connection?.close();
        const challenge = globalThis.crypto.getRandomValues(new Uint8Array(32));
        const queue = [install_frame(OP.CHALLENGE, 0, challenge)]; let offset = 0, closed = false;
        const session = {
            authenticated: false,
            available: () => !closed && !!queue.length,
            read: maximum => {
                if(closed || !queue.length) return new Uint8Array(0);
                const bytes = queue[0], count = Math.min(maximum, bytes.length - offset), result = bytes.slice(offset, offset + count);
                offset += count; if(offset === bytes.length) { queue.shift(); offset = 0; }
                return result;
            },
            send: bytes => { if(closed) throw new Error("iPhone installer connection closed"); queue.push(bytes); },
            close: () => {
                if(closed) return;
                closed = true; queue.length = 0;
                if(this.connection === session) this.connection = null;
                for(const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error("iPhone installer disconnected")); }
                this.pending.clear();
            },
            get_state: () => null, // Reconnect and query durable guest state after restoring an idle snapshot.
        };
        const incoming = install_frame_reader((op, sequence, payload) => {
            if(payload.length < 34) throw new Error("Unsigned native installer response");
            const body = payload.subarray(32), expected = install_message_mac(this.state.token, challenge, op, sequence, body);
            let different = 0; for(let i = 0; i < 32; i++) different |= expected[i] ^ payload[i];
            if(different) throw new Error("iPhone installer authentication failed");
            if(!session.authenticated)
            {
                if(op !== OP.HELLO || sequence !== 0) throw new Error("iPhone installer did not authenticate");
                const hello = JSON.parse(new TextDecoder().decode(body));
                if(hello.protocol !== 1 || hello.build !== "10B329") throw new Error("Unsupported native installer version");
                session.authenticated = true;
                const ready = new Uint8Array(4); new DataView(ready.buffer).setUint32(0, this.state.generation, true);
                session.send(install_frame(OP.READY, 0, ready)); this.progress(hello); return;
            }
            if(op !== OP.REPLY && op !== OP.PROGRESS) throw new Error("Unexpected native installer message");
            const value = JSON.parse(new TextDecoder().decode(body));
            if(!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid native installer response");
            this.progress(value);
            const request = this.pending.get(sequence);
            if(!request) return;
            if(op === OP.PROGRESS) { request.touch(); return; }
            this.pending.delete(sequence); clearTimeout(request.timer);
            if(value.ok === false) request.reject(new Error(value.error || "Native iOS installation failed"));
            else request.resolve(value);
        });
        session.write = bytes => { try { incoming(bytes); } catch(error) { session.close(); this.progress({ phase: "disconnected", error: error.message }); } };
        this.connection = session; return session;
    }
    request(op, payload = new Uint8Array(0), timeout = 120000)
    {
        const session = this.connection;
        if(!session?.authenticated) return Promise.reject(new Error("Waiting for the native iPhone installer"));
        if(this.pending.size >= 4) return Promise.reject(new Error("Too many pending iPhone installation requests"));
        const id = this.sequence = this.sequence % 0xFFFFFFFE + 1;
        return new Promise((resolve, reject) => {
            const request = { resolve, reject, timer: null, touch: () => {
                clearTimeout(request.timer);
                request.timer = setTimeout(() => { this.pending.delete(id); reject(new Error("iPhone installation request timed out; query its status before retrying")); }, timeout);
            } };
            this.pending.set(id, request); request.touch();
            session.send(install_frame(op, id, payload));
        });
    }
    async begin(manifest, install_id)
    {
        if(this.pending.size) throw new Error("An iPhone installer operation is already running");
        let state = this.state;
        if(state.pending && this.peer?.install_id === state.pending.install_id && ["installed", "failed", "cancelled", "interrupted"].includes(this.peer.phase))
            state = finish_install_trust(state, this.peer.phase === "installed");
        const next = stage_install_trust(this.boot.kernel, state, manifest, install_id);
        const added = install_hashes(next.state).filter(h => !this.trusted.has(h));
        if(added.length) runtime_trust_node(this.arena, added); // Reserve capacity before touching guest files.
        this.next_boot = { ...this.boot, ...next, install: next.state };
        const result = await this.request(OP.BEGIN, install_job(manifest, next.state, install_id));
        return { ...result, install_id, target_generation: next.state.generation };
    }
    write(install_id, at, bytes)
    {
        if(install_id !== this.peer?.install_id || !(bytes instanceof Uint8Array) || bytes.length > INSTALL_CHUNK ||
            !Number.isSafeInteger(at) || at < 0 || at > 2 * 1024 ** 3) throw new Error("Invalid IPA upload block");
        const payload = new Uint8Array(4 + bytes.length); new DataView(payload.buffer).setUint32(0, at, true); payload.set(bytes, 4);
        return this.request(OP.WRITE, payload);
    }
    async stage(install_id)
    {
        if(install_id !== this.peer?.install_id) throw new Error("Unknown iPhone installation task");
        return this.request(OP.STAGE);
    }
    commit(install_id)
    {
        if(install_id !== this.peer?.install_id) throw new Error("Unknown iPhone installation task");
        if(this.peer.job_generation !== this.state.generation) throw new Error("The staged IPA belongs to a different code trust generation; reopen the iPhone before retrying");
        return this.request(OP.COMMIT, new Uint8Array(0), 1200000);
    }
    cancel(install_id)
    {
        if(install_id !== this.peer?.install_id || !["transferring", "staged", "interrupted"].includes(this.peer.phase))
            throw new Error("This installation cannot be cancelled now");
        return this.request(OP.CANCEL);
    }
    lookup(bundle_id)
    {
        if(typeof bundle_id !== "string" || !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(bundle_id)) throw new Error("Invalid application identifier");
        return this.request(OP.LOOKUP, new TextEncoder().encode(bundle_id));
    }
    launch(bundle_id)
    {
        if(!this.peer?.can_launch)throw new Error("This iPhone helper cannot open applications");
        if(!this.state.apps.some(a=>a.bundle_id===bundle_id))throw new Error("The application is not in this iPhone's installed application list");
        if(!/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(bundle_id))throw new Error("Invalid application identifier");
        return this.request(OP.LAUNCH,new TextEncoder().encode(bundle_id));
    }
    get_state()
    {
        if(this.pending.size || ["transferring", "staged", "installing", "verifying", "restarting"].includes(this.peer?.phase))
            throw new Error("Finish or cancel the IPA installation before saving a snapshot");
        const a=this.arena;
        return [2,this.state.generation,a?[a.physical,a.virtual,a.size,a.used,a.head]:null,[...this.trusted]];
    }
    set_state(saved)
    {
        this.check_state(saved);
        this.reset();
        this.arena=saved[2]===null?null:{...snapshot_arena(saved)};
        if(saved[3]) this.trusted = new Set(saved[3]);
    }
    check_state(saved)
    {
        if(this.pending.size || ["transferring", "staged", "installing", "verifying"].includes(this.peer?.phase))
            throw new Error("Finish or cancel the IPA installation before loading a snapshot");
        if(!saved || ![1,2].includes(saved[0]) || saved[1] !== this.state.generation)
            throw new Error("The snapshot belongs to a different iPhone application generation");
        const arena=snapshot_arena(saved);if(arena!==null)validate_runtime_arena(arena);
        if(!Array.isArray(saved[3]) || saved[3].length > 189 + Math.floor(IOS_TRUST_ARENA_BYTES / 20) || saved[3].some(h => !/^[0-9a-f]{40}$/.test(h)))
            throw new Error("Invalid iPhone snapshot code trust state");
    }
    load_boot(boot)
    {
        validate_install_state(boot.install);
        this.reset(); this.boot = boot; this.state = JSON.parse(JSON.stringify(boot.install)); this.next_boot = null;
    }
    set_arena(arena)
    {
        this.arena = validate_runtime_arena(arena); this.trusted = new Set(install_hashes(this.state));
    }
    publish_trust(cpu)
    {
        if(!this.next_boot) throw new Error("No staged iPhone code trust update");
        const hashes = install_hashes(this.next_boot.install), added = hashes.filter(h => !this.trusted.has(h));
        if(added.length) publish_runtime_trust(cpu, this.arena, added);
        hashes.forEach(h => this.trusted.add(h));
        this.boot = this.next_boot; this.state = this.next_boot.install; this.next_boot = null;
        const generation = new Uint8Array(4); new DataView(generation.buffer).setUint32(0, this.state.generation, true);
        this.connection?.send(install_frame(OP.READY, 0, generation));
    }
}
