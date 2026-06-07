#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));

const QEMU = "qemu-system-x86_64";

const share_dir_9p = fs.mkdtempSync("/tmp/v86-test-qemu-9p");

fs.copyFileSync(path.join(__dirname, "/test-i386"), path.join(share_dir_9p, "/test-i386"));

const qemu_version = spawnSync(QEMU, ["--version"]);
assert(qemu_version.status === 0, "QEMU not found, return code: " + qemu_version.status);
console.error("Using QEMU:");
console.error(qemu_version.stdout.toString("utf8"));

const qemu = spawn(QEMU,
    [
        "-serial", "stdio",
        "-cdrom", path.join(__dirname, "/../../images/linux4.iso"),
        "-device", "virtio-9p-pci,fsdev=fs9p,mount_tag=host9p",
        "-fsdev", `local,id=fs9p,path=${share_dir_9p},security_model=none`,
        "-display", "none",
        "-cpu", "Westmere", // default doesn't support popcnt

        //"-monitor", "telnet:127.0.0.1:1235,server,nowait",
    ]
);

let qemu_output = "";
let ran_command = false;
let finished = false;

qemu.stdout.on("data", data => {
    process.stderr.write(data);
    qemu_output += data.toString().replace(/\r/, "");

    if(!ran_command && qemu_output.endsWith("~% "))
    {
        ran_command = true;
        qemu.stdin.write("chmod +x /mnt/test-i386\n");
        qemu.stdin.write("/mnt/test-i386 > /mnt/result\n");
        qemu.stdin.write("echo test fini''shed\n");
    }

    if(ran_command && !finished && qemu_output.includes("test finished"))
    {
        const result_file = path.join(share_dir_9p, "result");

        finished = true;
        console.error("Finished");
        process.stdout.write(fs.readFileSync(result_file));

        fs.unlinkSync(result_file);
        fs.unlinkSync(path.join(share_dir_9p, "test-i386"));
        fs.rmdirSync(share_dir_9p);

        qemu.kill();
    }
});

qemu.stderr.on("data", data => {
    process.stderr.write(data);
});
