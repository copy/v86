#!/usr/bin/env node

// The e1000 network card with a real driver: Linux 4.16's e1000 (built into
// images/linux4.iso) on net_device.type "e1000", the fetch backend's network
// (docs/modern-pc-devices-plan.md, N1, "验收"). The driver probes the card
// (EEPROM, PHY), the link comes up, DHCP, ARP, ICMP and DNS go through it;
// TCP both ways against an endpoint in this test, checked by MD5 (the
// guest's md5sum); the link down and up, a reboot and a snapshot. Prints the
// throughput and the card's interrupt rate.
//
// CPU_CORES=2 (with ACPI: the I/O APIC routes INTA), TRANSFER_MB (8; the
// plan's long run is 1024), DISABLE_JIT=1, SHOW_LOGS=1.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import url from "node:url";
import { tcp_endpoint } from "./tcp_endpoint.mjs";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));
process.on("unhandledRejection", exn => { throw exn; });

const TEST_RELEASE_BUILD = +process.env.TEST_RELEASE_BUILD;
const SHOW_LOGS = +process.env.SHOW_LOGS;
const CPU_CORES = +process.env.CPU_CORES || 1;
const TRANSFER_MB = +process.env.TRANSFER_MB || 8;
const { V86 } = await import(TEST_RELEASE_BUILD ? "../../build/libv86.mjs" : "../../src/main.js");

/**
 * A file from an ISO9660 image (plain names)
 * @param {string} path
 * @param {!Array<string>} names
 * @return {!ArrayBuffer}
 */
function iso_file(path, names)
{
    const iso = fs.readFileSync(path);
    let extent = iso.readUInt32LE(16 * 2048 + 156 + 2), size = iso.readUInt32LE(16 * 2048 + 156 + 10);
    for(const name of names)
    {
        let found = false;
        for(let at = extent * 2048; at < extent * 2048 + size;)
        {
            const length = iso[at];
            if(!length) { at = (Math.floor(at / 2048) + 1) * 2048; continue; }
            const entry = iso.toString("latin1", at + 33, at + 33 + iso[at + 32]).replace(/;\d+$/, "").replace(/\.$/, "");
            if(entry === name)
            {
                extent = iso.readUInt32LE(at + 2);
                size = iso.readUInt32LE(at + 10);
                found = true;
                break;
            }
            at += length;
        }
        assert.ok(found, name + " in " + path);
    }
    return iso.buffer.slice(iso.byteOffset + extent * 2048, iso.byteOffset + extent * 2048 + size);
}

const ISO = __dirname + "/../../images/linux4.iso";
const emulator = new V86({
    graphics_adapter: "bochs_vga",
    bios: { url: __dirname + "/../../bios/seabios.bin" },
    vga_bios: { url: __dirname + "/../../bios/vgabios.bin" },
    cdrom: { url: ISO },
    bzimage: { buffer: iso_file(ISO, ["BOOT", "BZIMAGE"]) },
    cmdline: "root=/dev/sr0",
    memory_size: 256 * 1024 * 1024,
    acpi: CPU_CORES > 1,
    cpu_cores: CPU_CORES,
    experimental_smp_jit: CPU_CORES > 1 && !+process.env.DISABLE_JIT,
    disable_jit: +process.env.DISABLE_JIT,
    net_device: { type: "e1000", relay_url: "fetch" },
    autostart: true,
    log_level: 0,
});

const overall_timeout = setTimeout(() => {
    console.log("\nTimeout. Serial output since the last command:\n" + serial);
    process.exit(1);
}, (300 + TRANSFER_MB * 4) * 1000);

let serial = "";
let waiter = null;
emulator.add_listener("serial0-output-byte", byte =>
{
    const chr = String.fromCharCode(byte);
    if(SHOW_LOGS) process.stdout.write(chr);
    serial += chr;
    if(waiter && waiter.pattern.test(serial))
    {
        const { resolve } = waiter;
        waiter = null;
        resolve(serial);
    }
});

const PROMPT = /~% $/;

function wait_serial(pattern, what, timeout_ms)
{
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timed out waiting for " + what + ":\n" + serial.slice(-3000))), timeout_ms);
        waiter = { pattern, resolve: text => { clearTimeout(timer); resolve(text); } };
        if(pattern.test(serial))
        {
            waiter = null;
            clearTimeout(timer);
            resolve(serial);
        }
    });
}

async function command(cmd, timeout_ms = 60000)
{
    serial = "";
    emulator.serial0_send(cmd + "\n");
    const output = await wait_serial(PROMPT, JSON.stringify(cmd), timeout_ms);
    return output.slice(cmd.length).replace(PROMPT, "");
}

/**
 * After a boot: the init script may still write after the shell's first
 * prompt (on two cores it does); wait until an empty line gets a prompt
 * and nothing else for a while
 */
async function settle()
{
    await wait_serial(PROMPT, "the shell", 240000);
    for(let attempt = 0; attempt < 30; attempt++)
    {
        await new Promise(resolve => setTimeout(resolve, 1500));
        serial = "";
        emulator.serial0_send("\n");
        await wait_serial(PROMPT, "the shell", 30000);
        await new Promise(resolve => setTimeout(resolve, 1000));
        if(/^\s*~% $/.test(serial)) return;
    }
    throw new Error("the shell does not settle:\n" + serial);
}

let passed = 0;
async function step(name, f)
{
    const start = Date.now();
    await f();
    passed++;
    console.log("ok - " + name + " (" + ((Date.now() - start) / 1000).toFixed(1) + " s)");
}

/** The card's interrupts so far (/proc/interrupts, all CPUs) */
async function card_interrupts()
{
    const line = (await command("grep eth0 /proc/interrupts")).trim();
    return line.split(/\s+/).slice(1, 1 + CPU_CORES).reduce((sum, n) => sum + +n, 0);
}

// The endpoints (tests/devices/tcp_endpoint.mjs, at the router's address):
// port 5000 answers any request with TRANSFER_MB of a pattern (HTTP, for
// wget); port 5001 takes what comes (telnet: a newline arrives as CR LF)
const pattern = new Uint8Array(TRANSFER_MB << 20);
for(let i = 0; i < pattern.length; i++) pattern[i] = (i * 2654435761 >>> 24) ^ i >>> 12;
let upload = null;
// (the network adapter exists once the emulator is ready)
emulator.add_listener("emulator-ready", () => tcp_endpoint(emulator, {
    5000: { serve: () => Buffer.concat([Buffer.from("HTTP/1.0 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: " +
        pattern.length + "\r\n\r\n"), pattern]) },
    5001: { sink: data => { upload && upload(data); upload = null; } },
}));

const md5 = bytes => crypto.createHash("md5").update(bytes).digest("hex");

async function bring_up()
{
    // (the kernel's messages go to the VGA console: dmesg, and the carrier)
    const link = await command("ifconfig eth0 up; for i in $(seq 50); do [ \"$(cat /sys/class/net/eth0/carrier)\" = 1 ] && break; " +
        "sleep 0.2; done; cat /sys/class/net/eth0/carrier; dmesg | grep 'Link is Up' | tail -1", 30000);
    assert.match(link, /(^|\n)1\r?\n/, "carrier");
    assert.match(link, /NIC Link is Up 1000 Mbps Full Duplex/);
    const lease = await command("udhcpc -i eth0 -n -q 2>&1", 60000);
    assert.match(lease, /lease of 192\.168\.86\.100 obtained/);
}

console.log("Booting linux4.iso with an e1000 (" + CPU_CORES + " core" + (CPU_CORES > 1 ? "s" : "") + ")");
await settle();

await step("the driver: e1000 at the NE2000's slot, the EEPROM's address, PRO/1000", async () => {
    const dmesg = await command("dmesg | grep -i e1000");
    const mac = Array.from(emulator.v86.cpu.devices.net.device["card"].mac, b => b.toString(16).padStart(2, "0")).join(":");
    assert.match(dmesg, /e1000 0000:00:05\.0 eth0: \(PCI:33MHz:32-bit\) /);
    assert.ok(dmesg.includes("eth0: " + "(PCI:33MHz:32-bit) " + mac), "the address " + mac + " in " + dmesg);
    assert.match(dmesg, /Intel\(R\) PRO\/1000 Network Connection/);
    assert.doesNotMatch(dmesg, /EEPROM Checksum Is Not Valid|Invalid MAC Address|PHY/);
    const lspci = await command("lspci -k | grep -A1 8086:100e");
    assert.match(lspci, /e1000/);
});

await step("link up, DHCP", bring_up);

await step("ICMP to the router and beyond, ARP, DNS", async () => {
    assert.match(await command("ping -c 3 192.168.86.1"), /3 packets transmitted, 3 packets received, 0% packet loss/);
    assert.match(await command("ping -c 2 1.2.3.4"), /2 packets transmitted, 2 packets received/);
    assert.match(await command("arp -a"), /\(192\.168\.86\.1\) at 52:54:00:01:02:03 \[ether\] {2}on eth0/);
    assert.match(await command("nslookup example.org 2>&1"), /Address/);
});

await step("TCP to the guest: " + TRANSFER_MB + " MiB (HTTP), by MD5", async () => {
    const before = await card_interrupts();
    const start = Date.now();
    const output = await command("wget -q -O - http://192.168.86.1:5000/ | md5sum", TRANSFER_MB * 4000 + 30000);
    const seconds = (Date.now() - start) / 1000;
    assert.ok(output.includes(md5(pattern)), "MD5 " + md5(pattern) + " in " + output);
    const interrupts = await card_interrupts() - before;
    console.log("    " + (TRANSFER_MB / seconds).toFixed(2) + " MiB/s, " + interrupts + " interrupts (" +
        (interrupts / seconds).toFixed(0) + "/s, " + (pattern.length / 1448 / interrupts).toFixed(1) + " segments each)");
});

await step("TCP from the guest: " + TRANSFER_MB + " MiB (telnet), by MD5", async () => {
    // a pattern of lines without the bytes telnet treats specially (IAC, ^])
    const lines = Math.ceil((TRANSFER_MB << 20) / 64);
    const received = new Promise(resolve => { upload = resolve; });
    const start = Date.now();
    const sum = await command("seq -w 1 " + lines + " | sed 's/$/ abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTU/' | tee /tmp/up | md5sum; " +
        "telnet 192.168.86.1 5001 < /tmp/up > /dev/null; rm /tmp/up", TRANSFER_MB * 8000 + 30000);
    const data = await received;
    const seconds = (Date.now() - start) / 1000;
    // (telnet sends a newline as CR LF)
    const text = data.toString("latin1").replace(/\r\n/g, "\n");
    assert.ok(sum.includes(md5(Buffer.from(text, "latin1"))), "MD5 of " + text.length + " bytes in " + sum);
    console.log("    " + (text.length / 1048576 / seconds).toFixed(2) + " MiB/s (with making the data)");
});

await step("the link down and up", async () => {
    await command("ifconfig eth0 down");
    assert.match(await command("ifconfig eth0"), /^((?!UP).)*$/s);
    await bring_up();
    assert.match(await command("ping -c 2 192.168.86.1"), /2 packets received/);
});

await step("a snapshot: the guest's network goes on after restoring it", async () => {
    const state = await emulator.save_state();
    await command("ifconfig eth0 down");
    await emulator.restore_state(state);
    serial = "";
    emulator.serial0_send("\n");
    await wait_serial(PROMPT, "the shell after restoring", 30000);
    assert.match(await command("ping -c 2 192.168.86.1"), /2 packets transmitted, 2 packets received/);
});

await step("a reboot: the driver finds the card again", async () => {
    // (the old shell prints no prompt after "reboot": the next is the new one's)
    serial = "";
    emulator.serial0_send("reboot\n");
    await settle();
    await bring_up();
    assert.match(await command("ping -c 2 192.168.86.1"), /2 packets received/);
});

clearTimeout(overall_timeout);
await emulator.destroy();
console.log("PASS: " + passed + " steps");
process.exit(0);
