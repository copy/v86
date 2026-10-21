#!/usr/bin/env node
// The disk service's list and create (docs/vm-manager-plan.md "磁盘服务的创建
// 与列出", U3; tools/disk-service.mjs) and the VM manager's client
// (src/app/disk_service_client.js): every rule of create (--allow-create,
// the name, an existing file, the size, the free space, the token, the
// origin), list, the probe; then a Linux guest (images/linux4.iso) formats a
// new image as its hda with disk_option "read_write", writes a file and
// syncs, and the service's file has it.
//   node tests/app/disk_service_create.mjs [guest=0]

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import url from "node:url";
import { create_disk_service, DEFAULT_MAX_SIZE } from "../../tools/disk-service.mjs";
import { list_images, create_image, probe, image_url, new_image_name, ServiceError } from "../../src/app/disk_service_client.js";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
const ROOT = path.resolve(__dirname, "../..") + "/";
const GUEST = !process.argv.includes("guest=0");
process.on("unhandledRejection", exn => { throw exn; });

let passed = 0;
async function test(name, fn)
{
    await fn();
    passed++;
    console.log("ok - " + name);
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "v86-disk-service-create-"));
const PAGE = "http://page.invalid:8000";

/** A service on a directory of its own; free: the volume's free bytes it sees */
async function start(options = {})
{
    const dir = fs.mkdtempSync(path.join(temp, "dir-"));
    const service = create_disk_service(Object.assign({ dir, origins: [PAGE], lease_ms: 2000 }, options));
    await new Promise(resolve => service.server.listen(0, "127.0.0.1", resolve));
    const base = "http://127.0.0.1:" + service.server.address().port + "/";
    return { service, dir, base };
}

/** A POST of the protocol, its status and JSON */
async function post(base, name, headers)
{
    const response = await fetch(base + name, { method: "POST", headers });
    return { status: response.status, body: await response.json().catch(() => null), headers: response.headers };
}

await test("without --allow-create: list answers (create: false), create is refused", async () =>
{
    const { service, base } = await start();
    const list = await post(base, "", { "X-V86-Disk-Op": "list" });
    assert.equal(list.status, 200);
    assert.deepEqual(list.body, { images: [], create: false, max_size: DEFAULT_MAX_SIZE });
    assert.equal(list.headers.get("X-V86-Disk-Protocol"), "1");
    const created = await post(base, "a.img", { "X-V86-Disk-Op": "create", "X-V86-Disk-Size": "1048576" });
    assert.equal(created.status, 403);
    assert.equal(created.body.code, "create");
    await service.close();
});

await test("create: the names it refuses", async () =>
{
    const { service, base } = await start({ allow_create: true });
    for(const name of ["x.iso", ".hidden.img", "-dash.img", "_under.img", "space name.img", "%2E%2E%2Fup.img", "sub%2Fx.img",
        "a".repeat(125) + ".img", "x.img.tmp", "UPPER.IMG"])
    {
        const r = await post(base, name, { "X-V86-Disk-Op": "create", "X-V86-Disk-Size": "512" });
        assert.equal(r.status, 400, name);
        assert.equal(r.body.code, "name", name);
    }
    const longest = "b".repeat(124) + ".img";
    assert.equal((await post(base, longest, { "X-V86-Disk-Op": "create", "X-V86-Disk-Size": "512" })).status, 201, "128 characters");
    await service.close();
});

await test("create: the sizes it refuses (not whole sectors, none, above --max-size, above the free space)", async () =>
{
    const { service, dir, base } = await start({ allow_create: true, max_size: 1 << 20, free_space: () => 64 << 10 });
    for(const size of [undefined, "0", "-512", "511", "513", "abc", "1.5", String((1 << 20) + 512)])
    {
        const headers = { "X-V86-Disk-Op": "create" };
        if(size !== undefined) headers["X-V86-Disk-Size"] = size;
        const r = await post(base, "s.img", headers);
        assert.equal(r.status, 400, "size " + size);
        assert.equal(r.body.code, "size", "size " + size);
    }
    const full = await post(base, "s.img", { "X-V86-Disk-Op": "create", "X-V86-Disk-Size": String(128 << 10) });
    assert.equal(full.status, 507);
    assert.equal(full.body.code, "no_space");
    assert(!fs.existsSync(path.join(dir, "s.img")), "nothing made");
    await service.close();
});

await test("create: a new image of zeros, its identity, never over an existing file", async () =>
{
    const { service, dir, base } = await start({ allow_create: true });
    fs.writeFileSync(path.join(dir, "existing.img"), "data");
    const r = await post(base, "new.img", { "X-V86-Disk-Op": "create", "X-V86-Disk-Size": String(64 << 20) });
    assert.equal(r.status, 201);
    assert.deepEqual(r.body, { name: "new.img", size: 64 << 20, url: base + "new.img" });
    const file = path.join(dir, "new.img");
    const stat = fs.statSync(file);
    assert.equal(stat.size, 64 << 20);
    const fd = fs.openSync(file, "r");
    const sample = Buffer.alloc(4096);
    for(const at of [0, 32 << 20, (64 << 20) - 4096])
    {
        fs.readSync(fd, sample, 0, 4096, at);
        assert(sample.every(b => b === 0), "zeros at " + at);
    }
    fs.closeSync(fd);
    const state = JSON.parse(fs.readFileSync(path.join(dir, ".v86-disk-service.json"), "utf8"));
    assert.match(state["new.img"].uuid, /^[0-9a-f-]{36}$/);
    assert.equal(state["new.img"].generation, 1);
    console.log("    (64 MiB new.img takes " + stat.blocks * 512 + " bytes on this volume)");
    for(const name of ["new.img", "existing.img"])
    {
        const again = await post(base, name, { "X-V86-Disk-Op": "create", "X-V86-Disk-Size": "512" });
        assert.equal(again.status, 409, name);
        assert.equal(again.body.code, "exists", name);
    }
    assert.equal(fs.readFileSync(path.join(dir, "existing.img"), "utf8"), "data");
    // (a Range read of the new image, as v86 reads it)
    const read = await fetch(base + "new.img", { headers: { Range: "bytes=512-1023" } });
    assert.equal(read.status, 206);
    assert.equal((await read.arrayBuffer()).byteLength, 512);
    await service.close();
});

await test("list: name, size, time of change, writer; at the root only", async () =>
{
    const { service, dir, base } = await start({ allow_create: true });
    fs.writeFileSync(path.join(dir, "b.img"), Buffer.alloc(1024));
    fs.writeFileSync(path.join(dir, ".hidden"), "x");
    fs.mkdirSync(path.join(dir, "subdir"));
    await post(base, "a.img", { "X-V86-Disk-Op": "create", "X-V86-Disk-Size": "2048" });
    let list = (await post(base, "", { "X-V86-Disk-Op": "list" })).body;
    assert.equal(list.create, true);
    assert.deepEqual(list.images.map(i => [i.name, i.size, i.writer]), [["a.img", 2048, false], ["b.img", 1024, false]]);
    assert(!isNaN(Date.parse(list.images[0].modified)));
    const open = await post(base, "a.img", { "X-V86-Disk-Op": "open" });
    assert.equal(open.status, 200);
    list = (await post(base, "", { "X-V86-Disk-Op": "list" })).body;
    assert.equal(list.images.find(i => i.name === "a.img").writer, true, "a writer's session");
    const wrong = await post(base, "a.img", { "X-V86-Disk-Op": "list" });
    assert.equal(wrong.status, 400);
    await service.close();
});

await test("the token and the origin", async () =>
{
    const { service, base } = await start({ allow_create: true, token: "secret" });
    for(const op of ["list", "create"])
    {
        const headers = { "X-V86-Disk-Op": op, "X-V86-Disk-Size": "512" };
        const r = await post(base, op === "list" ? "" : "t.img", headers);
        assert.equal(r.status, 401, op);
        assert.equal(r.body.code, "token");
        const ok = await post(base, op === "list" ? "" : "t.img", Object.assign({ Authorization: "Bearer secret" }, headers));
        assert.equal(ok.status, op === "list" ? 200 : 201, op);
    }
    const foreign = await post(base, "", { "X-V86-Disk-Op": "list", Authorization: "Bearer secret", Origin: "http://other.invalid" });
    assert.equal(foreign.status, 403);
    assert.equal(foreign.body.code, "origin");
    const page = await post(base, "", { "X-V86-Disk-Op": "list", Authorization: "Bearer secret", Origin: PAGE });
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("Access-Control-Allow-Origin"), PAGE);
    const preflight = await fetch(base + "u.img", { method: "OPTIONS", headers: { Origin: PAGE, "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "x-v86-disk-op, x-v86-disk-size, authorization" } });
    assert.equal(preflight.status, 204);
    assert.match(preflight.headers.get("Access-Control-Allow-Headers"), /X-V86-Disk-Size/);
    assert.match(preflight.headers.get("Access-Control-Expose-Headers"), /X-V86-Disk-Protocol/);
    await service.close();
});

await test("the client: list, create, its errors, the probe of a service, a static server, nothing", async () =>
{
    const { service, base } = await start({ allow_create: true, token: "t" });
    const s = { url: base.slice(0, -1), token: "t" };
    assert.deepEqual((await list_images(s)).images, []);
    const made = await create_image(s, "client.img", 4096);
    assert.deepEqual(made, { name: "client.img", size: 4096, url: base + "client.img" });
    assert.equal(image_url(s, "client.img"), base + "client.img");
    await assert.rejects(create_image(s, "client.img", 4096), e => e instanceof ServiceError && e.code === "exists" && e.status === 409);
    await assert.rejects(list_images({ url: base }), e => e.code === "token");
    const probed = await probe(s);
    assert(probed.ok && probed.list.create && probed.list.images.length === 1);
    assert.equal(new_image_name("Windows 98 (SE)", probed.list.images), "windows-98-se.img");
    assert.equal(new_image_name("client", probed.list.images), "client-2.img");
    // (a static server: no protocol; nothing listening)
    const plain = http.createServer((req, res) => res.writeHead(404).end());
    await new Promise(resolve => plain.listen(0, "127.0.0.1", resolve));
    const static_probe = await probe({ url: "http://127.0.0.1:" + plain.address().port + "/" });
    assert(!static_probe.ok && static_probe.code === "not_a_service", JSON.stringify(static_probe));
    const port = plain.address().port;
    await new Promise(resolve => plain.close(resolve));
    const nothing = await probe({ url: "http://127.0.0.1:" + port + "/" });
    assert(!nothing.ok && nothing.code === "unreachable", JSON.stringify(nothing));
    await service.close();
});

if(GUEST)
{
    await test("a Linux guest formats a new image (read_write), writes a file and syncs: the service's file has it", async () =>
    {
        const { V86 } = await import(+process.env.TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");
        const { service, dir, base } = await start({ allow_create: true, lease_ms: 30000 });
        await create_image({ url: base }, "guest.img", 32 << 20);
        const emulator = new V86({
            graphics_adapter: "bochs_vga", bios: { url: ROOT + "bios/seabios.bin" }, vga_bios: { url: ROOT + "bios/vgabios.bin" }, memory_size: 128 << 20,
            autostart: true, screen_dummy: true, log_level: 0,
            cdrom: { url: ROOT + "images/linux4.iso" }, hda: { url: base + "guest.img", disk_option: "read_write" },
        });
        let serial = "";
        emulator.add_listener("serial0-output-byte", byte => { serial += String.fromCharCode(byte); });
        const until = async (what, predicate, timeout) =>
        {
            const end = Date.now() + timeout;
            while(!predicate()) { if(Date.now() > end) throw new Error("timed out: " + what + "\n" + serial.slice(-500)); await new Promise(r => setTimeout(r, 50)); }
        };
        const PROMPT = /~% $/;
        await until("the shell", () => PROMPT.test(serial), 240000);
        const run = async command =>
        {
            serial = "";
            emulator.serial0_send(command + "\n");
            await until(command, () => PROMPT.test(serial), 120000);
            return serial;
        };
        const out = await run("mke2fs -q /dev/sda && mkdir -p /mnt && mount /dev/sda /mnt && echo NEW-IMAGE-FROM-THE-MANAGER > /mnt/note && sync && umount /mnt && echo synced");
        assert.match(out, /synced/, out);
        await emulator.destroy();
        const image = fs.readFileSync(path.join(dir, "guest.img"));
        assert(image.includes("NEW-IMAGE-FROM-THE-MANAGER"), "the text in the service's file");
        assert.equal(image.readUInt16LE(1024 + 56), 0xEF53, "an ext2 superblock");
        await service.close();
    });
}

fs.rmSync(temp, { recursive: true, force: true });
console.log(passed + " tests passed");
