import { write_nand_boot, read_nand_boot } from "./nand_boot.js";
import { NAND_SLOT, nand_offset } from "../apple/nand_geometry.js";
import { finish_install_trust, install_hashes } from "./install_trust.js";
import { n90_trust_kernel } from "./guest_load.js";
import { runtime_trust_node, IOS_TRUST_HEAD_PHYSICAL } from "./runtime_trust.js";
const bytes = value => value instanceof Uint8Array ? value : new Uint8Array(value || 0);
const decode = h => Uint8Array.from(h.match(/../g), x => parseInt(x, 16));
const io = (buffer, operation, ...args) => new Promise((resolve, reject) => buffer[operation](...args, error => error ? reject(error) : resolve()));
function service(emulator)
{
    const install = emulator.v86?.cpu?.devices.ios_install;
    if(!install) throw new Error("This iPhone disk has no installation helper. Import the IPSW as a new iPhone and keep this existing iPhone for its data.");
    return install;
}
function running(emulator)
{
    if(!emulator.is_running()) throw new Error("Resume the iPhone before installing an IPA");
    return service(emulator);
}
export async function persist_install_boot(emulator, install)
{
    const cpu = emulator.v86.cpu, buffer = cpu.devices.apple_nand?.buffer, next = install.next_boot;
    if(!next || !buffer?.writeback || typeof buffer.flush !== "function") throw new Error("IPA installation requires a writable, persistent iPhone NAND disk");
    const added = install_hashes(next.install).filter(h => !install.trusted.has(h));
    if(added.length) runtime_trust_node(install.arena, added);
    const head = cpu.read_blob_physical(IOS_TRUST_HEAD_PHYSICAL, 4);
    if(new DataView(head.buffer, head.byteOffset, 4).getUint32(0, true) !== install.arena.head) throw new Error("The iPhone code trust state changed unexpectedly");
    const was_running = emulator.is_running();
    await emulator.stop();
    let published = false;
    try
    {
        await io(buffer, "flush");
        const pages = [];
        write_nand_boot((bus, ce, row, raw) => {
            const slot = new Uint8Array(NAND_SLOT);
            for(let i = 0; i < raw.length; i++) slot[i] = raw[i] ^ 255;
            pages.push([nand_offset(bus, ce, row), slot]);
        }, bytes(next.kernel), bytes(next.tree), bytes(next.logo), bytes(next.library), next.install);
        const header = pages.pop();
        for(const [at, data] of pages) await io(buffer, "set", at, data);
        await io(buffer, "flush");
        await io(buffer, "set", ...header);
        await io(buffer, "flush");
        const saved = await read_nand_boot((at, length) => new Promise((resolve, reject) => buffer.get(at, length,
            (data, error) => error ? reject(error) : resolve(data))));
        if(saved.install?.generation !== next.install.generation) throw new Error("The new iPhone boot generation could not be verified");
        install.publish_trust(cpu); published = true;
        cpu.boot_files.kernel = bytes(install.boot.kernel).slice().buffer;
    }
    catch(error)
    {
        // A durable header may already exist. Keep the CPU paused until a
        // cold boot reloads that generation; never install under uncertain trust.
        install.progress({ phase: "interrupted", error: error.message + "; power off and reopen this iPhone before retrying" });
        throw error;
    }
    finally { if(published && was_running) await emulator.run(); }
}
async function finish(emulator, install, installed)
{
    if(!install.state.pending) return;
    const state = { ...finish_install_trust(install.state, installed), generation: install.state.generation + 1 };
    install.next_boot = { ...install.boot, install: state,
        kernel: n90_trust_kernel(bytes(install.boot.kernel), install_hashes(state).map(decode)) };
    await persist_install_boot(emulator, install);
}
export function attach_ios_install_api(V86)
{
    const methods = {
        async ios_install_status() {
            const install = this.v86?.cpu?.devices.ios_install;
            if(!install) return { supported: false, available: false, phase: "unsupported", error: "This iPhone needs a new IPSW import to add the installation helper. The existing iPhone and its data can be kept." };
            if(!this.v86.cpu.devices.apple_nand?.buffer.writeback) return { supported: true, available: false,
                running: this.is_running(), phase: "readonly", error: "IPA installation requires a writable, persistent iPhone NAND disk" };
            return { supported: true, running: this.is_running(), ...install.status() };
        },
        async ios_install_begin(manifest) {
            const install = running(this);
            if(!this.v86.cpu.devices.apple_nand?.buffer.writeback) throw new Error("IPA installation requires a writable, persistent iPhone NAND disk");
            return install.begin(manifest, globalThis.crypto.randomUUID());
        },
        async ios_install_write(id, offset, data) { return running(this).write(id, offset, data); },
        async ios_install_stage(id) { return running(this).stage(id); },
        async ios_install_commit(id) {
            const install = running(this);
            if(install.peer?.install_id !== id) throw new Error("Unknown iPhone installation task");
            if(install.peer.phase === "installed") {
                const result = await install.lookup(install.peer.bundle_id);
                if(!result.installed) throw new Error("The previously installed application is no longer registered");
                await finish(this, install, true); return result;
            }
            if(install.peer.phase !== "staged") throw new Error("The IPA has not finished staging");
            if(install.next_boot) await persist_install_boot(this, install);
            try {
                const result = await install.commit(id);
                if(!result.installed || result.phase !== "installed") throw new Error("The native installer did not verify the application");
                await finish(this, install, true); return result;
            }
            catch(error) { if(install.peer?.phase === "failed") await finish(this, install, false); throw error; }
        },
        async ios_install_cancel(id) {
            const install = running(this), result = await install.cancel(id);
            if(install.state.pending?.install_id === id) await finish(this, install, false);
            else install.next_boot = null;
            return result;
        },
        async ios_install_lookup(bundle) { return running(this).lookup(bundle); },
        async ios_open_application(bundle) { return running(this).launch(bundle); },
    };
    for(const [name, method] of Object.entries(methods)) V86.prototype[name] = function(...args) {
        if(this.worker_controller) return this.worker_controller.serialize(() => this.worker_controller.rpc(name, args));
        return method.apply(this, args);
    };
}
