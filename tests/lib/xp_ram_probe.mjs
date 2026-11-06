// Headless real-XP driver/API probe. Graphics batches are acknowledged without
// rendering by default; graphics_renderer supplies actual GPU replies when set.
// The user's image is read-only; all writes use RAM sector overlays.
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire as create_require } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { deflateSync as deflate_sync, crc32 } from "node:zlib";
import { MemoryDisk, ReadOnlyOverlayDisk, make_fat16, read_fat16 } from "../smp/disk_fixture.mjs";
export async function run_xp_ram_probe({ root, image, out, files, result_file = "OWNER.TXT",
    success, log_files = [], log_completion = {}, binary_files = [], capture_graphics = false, expected_releases = null,
    rendering = "not exercised", simulated_host_features = null, observe_batch = null, graphics_renderer = null,
    probe_timeout_seconds = 180, inspect })
{
    assert(Number.isInteger(probe_timeout_seconds) && probe_timeout_seconds > 0 && probe_timeout_seconds <= 10800,
        "Invalid XP probe execution timeout");
    assert(!graphics_renderer || (!observe_batch && simulated_host_features === null), "A live GPU cannot be combined with simulated replies/capabilities");
    let graphics_work = Promise.resolve(), graphics_error = null, graphics_active = true;
    const before = fs.statSync(image);
    assert(simulated_host_features === null || (Number.isInteger(simulated_host_features) && simulated_host_features >= 0 && simulated_host_features <= 15));
    const caps_protocol = simulated_host_features === null ? null : create_require(import.meta.url)("../../src/browser/glbridge/d3d9-webgpu/d9wg_protocol.js");
    const tools = new MemoryDisk(make_fat16(files)), disk = new ReadOnlyOverlayDisk(image);
    const require = create_require(import.meta.url), { createV86GLDevice: create_device } = require("../../src/browser/glbridge/v86gl_device.js");
    const handlers = [null, null];
    // An asynchronous browser must own a copy before the guest reuses its DMA arena.
    const end = (self, other) => ({ remote: !!graphics_renderer, post(message) { handlers[other]?.(message); }, listen(handler) { handlers[self] = handler; } });
    const channel = { device: end(0, 1), host: end(1, 0) };
    let batches = 0;const releases = [], owners = new Set();
    const captured = [];let capture_bytes = 0, capture_error;
    const descriptor = create_device(channel.device);
    channel.host.listen(message => {
        if(message.type === "batch") {
            batches++;owners.add(message.ownerToken || 0);
            if(capture_graphics && !capture_error) {
                capture_bytes += 12 + message.bytes.length;
                if(capture_bytes > (32 << 20)) capture_error = "probe graphics capture exceeds 32 MiB";
                else {
                    const header = Buffer.alloc(12);header.writeUInt32LE(message.ownerToken || 0);
                    header.writeUInt32LE((message.flags || 0) >>> 0, 4);header.writeUInt32LE(message.bytes.length, 8);
                    captured.push(header, Buffer.from(message.bytes));
                }
            }
            if(graphics_renderer) {
                graphics_work = graphics_work.then(async () => {
                    await graphics_renderer.submit(message, (offset, bytes) => {
                        if(graphics_active) channel.host.post({type:"write",generation:message.generation,offset,bytes});
                    });
                    if(graphics_active) channel.host.post({type:"done",id:message.id});
                }).catch(error => {graphics_error = error;});
                return;
            }
            if(observe_batch) observe_batch(message, name => read_fat16(tools.bytes, name), (offset, bytes) => {
                channel.host.post({type: "write", generation: message.generation, offset, bytes});
            });
            if(caps_protocol) {
                const bytes = caps_protocol.encode("HostCapabilities", {feature_bits: simulated_host_features, version: 1, magic: 0x50414348});
                channel.host.post({type: "write", generation: message.generation, offset: (16 << 20) - 12, bytes});
            }
            channel.host.post({ type: "done", id: message.id });
        }
        else if(message.type === "released") {
            releases.push(message.ownerToken);
            if(graphics_renderer) graphics_work = graphics_work.then(() => graphics_renderer.release(message.ownerToken)).catch(error => {graphics_error = error;});
        }
    });
    channel.host.post({ type: "available", value: true });
    const { V86 } = await import("../../src/main.js");
    const vm = new V86({ bios: { url: root + "bios/seabios.bin" }, vga_bios: { url: root + "bios/vgabios.bin" },
        hda: disk, hdb: tools, memory_size: 512 << 20, vram_size: 16 << 20,
        graphics_adapter: "bochs_vga", acpi: false, net_device: { type: "none" },
        virtio_devices: [descriptor], autostart: true, disable_speaker: true, boot_order: 0x213, log_level: 0 });
    const started = performance.now(), elapsed = () => Math.round((performance.now() - started) / 1000);
    const result_text = () => { const data = read_fat16(tools.bytes, result_file);return data ? Buffer.from(data).toString("ascii") : ""; };
    assert(Object.keys(log_completion).every(name => log_files.includes(name)), "Completion logs must be captured");
    const completed = (text, logs) => text.includes(success) && Object.entries(log_completion).every(([name, marker]) => logs[name].includes(marker));
    const read_logs = () => Object.fromEntries(log_files.map(name => {
        const data = read_fat16(tools.bytes, name);return [name, data ? Buffer.from(data).toString("ascii") : ""];
    }));
    function frame()
    {
        const vga = vm.v86.cpu.devices.vga;
        if(!vga.svga_enabled || ![16, 24, 32].includes(vga.svga_bpp)) return null;
        const width = vga.svga_width, height = vga.svga_height, bpp = vga.svga_bpp / 8;
        const pixels = new Uint8Array(vm.v86.cpu.wasm_memory.buffer, vga.svga_memory.byteOffset, vga.vga_memory_size);
        const raw = Buffer.alloc(height * (width * 3 + 1)), offset = vga.svga_offset * bpp;
        for(let y = 0; y < height; y++) for(let x = 0; x < width; x++)
        {
            const from = offset + (y * width + x) * bpp, to = y * (width * 3 + 1) + 1 + x * 3;
            if(bpp === 2) { const value = pixels[from] | pixels[from + 1] << 8;raw[to] = (value >> 11 & 31) << 3;raw[to + 1] = (value >> 5 & 63) << 2;raw[to + 2] = (value & 31) << 3; }
            else { raw[to] = pixels[from + 2];raw[to + 1] = pixels[from + 1];raw[to + 2] = pixels[from]; }
        }
        return { width, height, raw };
    }
    function save_frame(name, picture)
    {
        if(!picture) return;
        const chunk = (tag, data) => {
            const body = Buffer.concat([Buffer.from(tag), data]), result = Buffer.alloc(data.length + 12);
            result.writeUInt32BE(data.length);body.copy(result, 4);result.writeUInt32BE(crc32(body), body.length + 4);return result;
        };
        const header = Buffer.alloc(13);header.writeUInt32BE(picture.width);header.writeUInt32BE(picture.height, 4);header[8] = 8;header[9] = 2;
        fs.writeFileSync(out + "/" + name, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflate_sync(picture.raw)), chunk("IEND", Buffer.alloc(0))]));
    }
    try
    {
        await new Promise(resolve => vm.add_listener("emulator-loaded", resolve));
        let last = null, stable_since = performance.now();
        for(; elapsed() < 210;)
        {
            await delay(2000);
            const picture = frame(), key = picture && picture.width + "x" + picture.height + ":" + crc32(picture.raw);
            if(key !== last) { last = key;stable_since = performance.now(); }
            if(elapsed() % 10 < 2) console.log("XP boot", elapsed(), "s", picture ? picture.width + "x" + picture.height : "VGA");
            if(picture && elapsed() >= 60 && performance.now() - stable_since > 20000) break;
        }
        save_frame("probe-desktop.png", frame());
        for(let attempt = 0; attempt < 3 && !completed(result_text(), read_logs()); attempt++)
        {
            const launchBatches = batches;
            console.log("launch RAM probe", elapsed(), "s", "attempt", attempt + 1);
            for(let cancel = 0; cancel < 3; cancel++) { await vm.keyboard_send_scancodes([1, 129], 30);await delay(1000); }
            await vm.keyboard_send_scancodes([0xE0, 0x5B, 0x13, 0x93, 0xE0, 0xDB], 30);await delay(2000);
            await vm.keyboard_send_text("cmd /c for %d in (d e f g h i j k) do @if exist %d:\\probe.cmd %d:\\probe.cmd", 30);
            await vm.keyboard_send_scancodes([28, 156], 30);
            for(let poll = 0; poll < probe_timeout_seconds; poll++)
            {
                await delay(1000);if(graphics_error) throw graphics_error;const text = result_text();
                const logs = read_logs();
                if(text.includes("FAIL ") || Object.values(logs).some(text => text.includes("FAIL ")))
                    throw new Error(JSON.stringify({ text, logs }));
                // An open redirected log may not have a flushed FAT directory
                // entry yet. Actual graphics traffic already proves the test
                // launched; never start a second copy while it is running.
                if(poll === 29 && batches === launchBatches && !text && Object.values(logs).every(text => !text)) break;
                if(completed(text, logs)) break;
                // A loader/modal error can leave a redirected log unchanged.
                // Preserve a current guest picture so a long suite cannot hide
                // that failure behind an apparently active timeout loop.
                if(poll % 30 === 29) save_frame("probe-progress.png", frame());
                if(poll % 10 === 9) console.log("waiting", elapsed(), "s", JSON.stringify({ text: text.trim(), batches,
                    logs: Object.fromEntries(Object.entries(logs).map(([name,log]) => [name,log.slice(-4096)])) }));
            }
            // Retry only a missed launch. Starting another process after an
            // active suite times out would corrupt its log and GPU ownership.
            if(!completed(result_text(), read_logs()) && (batches > launchBatches || result_text() || Object.values(read_logs()).some(Boolean)))
                throw new Error("XP probe execution timed out after starting");
        }
        const text = result_text();assert(completed(text, read_logs()), "Owner probe did not finish: " + text);
        // A flushed success marker can precede ExitProcess and DLL detach.
        // Keep running the VM until the requested transport owners retire.
        if(expected_releases !== null) {
            for(let poll = 0; poll < 50 && releases.length < expected_releases; poll++) await delay(100);
            assert.equal(releases.length, expected_releases, "Guest transport owners did not retire");
        }
        await graphics_work; if(graphics_error) throw graphics_error;
        const after = fs.statSync(image);assert.equal(after.mtimeMs, before.mtimeMs);assert.equal(after.size, before.size);
        const artifacts = {};
        if(capture_graphics) {
            assert(!capture_error, capture_error);
            const data = Buffer.concat(captured);fs.writeFileSync(out + "/graphics.bin", data);
            artifacts["graphics.bin"] = { bytes: data.length, crc32: crc32(data).toString(16).padStart(8, "0") };
        }
        for(const name of binary_files)
        {
            assert(/^[a-z0-9_.-]+$/i.test(name), "invalid probe artifact name");
            const data = read_fat16(tools.bytes, name);assert(data?.length, "missing probe artifact " + name);
            fs.writeFileSync(out + "/" + name, data);
            artifacts[name] = { bytes: data.length, crc32: crc32(data).toString(16).padStart(8, "0") };
        }
        const result = { status: "PASS", seconds: elapsed(), batches, releases, owners: Array.from(owners),
            text, logs: read_logs(), diskWrites: "RAM sector overlay only", rendering,
            ...(simulated_host_features === null ? {} : {simulatedHostFeatures: simulated_host_features}),
            ...(binary_files.length || capture_graphics ? { artifacts } : {}) };
        if(inspect) inspect(result);
        fs.writeFileSync(out + "/probe-result.json", JSON.stringify(result, null, 2) + "\n");
        save_frame("probe-complete.png", frame());return result;
    }
    catch(error)
    {
        save_frame("probe-failure.png", frame());
        fs.writeFileSync(out + "/probe-failure.json", JSON.stringify({ text: result_text(), logs: read_logs() }, null, 2));
        throw error;
    }
    finally
    {
        graphics_active = false;
        await vm.stop();await vm.destroy();fs.closeSync(disk.fd);
    }
}
