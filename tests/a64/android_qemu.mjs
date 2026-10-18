// The Android 16 reference on QEMU (docs/arm64-virt-android16-plan.md
// P10.3): the machine of the Alpine reference (QEMU 9.2.0, virt-9.2 with
// GICv3 and high ECAM, cortex-a35, P0) with Cuttlefish's devices as its
// launcher gives them to QEMU (host/libs/vm_manager/qemu_manager.cpp:
// virtio-pci, 18 virtconsole ports with the kernel's console on hvc0 and
// logcat on hvc2, the GPU at 00:02.0 where Cuttlefish's sepolicy expects it,
// three NICs), booting tools/a64_android.mjs's Image, initrd.img and disk.img
// directly (no U-Boot). The Android console is on the PL011 (ttyAMA0),
// driven through a Unix socket.
import fs from "node:fs";
import net from "node:net";
import { QEMU_MACHINE, QEMU_CPU, smp } from "./guest_runner.mjs";
import { save_png } from "../lib/picture_sink.mjs";

/**
 * QEMU's arguments
 * @param {string} out tools/a64_android.mjs's output directory (with a slash)
 * @param {{accel?: string, memory_mb: number, cores: number, console_socket: string, kernel_log: string,
 *     logcat: string, extract?: string, snapshot?: boolean, monitor_socket?: string, adb_port?: number}} o
 *     accel "tcg" (the reference: cortex-a35) or "hvf" (the host's CPU, for
 *     quick runs); extract: the Unix socket of a virtserialport named
 *     org.v86.extract (a socket: a file's backend never opens the port for
 *     the guest, whose writes then block); monitor_socket: the human monitor
 *     on a Unix socket (screendump); adb_port: the host's port forwarded to
 *     adbd's tcp:5555 on the third NIC, the one under Cuttlefish's Wi-Fi
 *     (VirtWifi; DHCP gives it 10.0.3.15)
 */
export function android_qemu_args(out, o)
{
    const cmdline = fs.readFileSync(out + "cmdline.txt", "utf8").trim();
    const consoles = [];
    for(let i = 0; i < 18; i++)
    {
        // hvc0 the kernel's console, hvc2 logcat (Cuttlefish's seriallogging);
        // the others' host ends (keymint, gatekeeper, ...) are sinks: the guest
        // uses its own nonsecure HALs (bootconfig)
        const file = i === 0 ? o.kernel_log : i === 2 ? o.logcat : null;
        consoles.push("-chardev", file ? `file,id=hvc${i},path=${file}` : `null,id=hvc${i}`,
            "-device", `virtconsole,bus=virtio-serial.0,chardev=hvc${i}`);
    }
    return [
        "-machine", QEMU_MACHINE,
        ...(o.accel === "hvf" ? ["-accel", "hvf", "-cpu", "host"] : ["-accel", "tcg,thread=multi", "-cpu", QEMU_CPU]),
        "-m", o.memory_mb + "M", "-smp", smp(o.cores),
        "-kernel", out + "Image", "-initrd", out + "initrd.img", "-append", cmdline,
        "-drive", `if=none,id=disk0,file=${out}disk.img,format=raw${o.snapshot === false ? "" : ",snapshot=on"}`,
        "-device", "virtio-blk-pci-non-transitional,drive=disk0,addr=01.0",
        "-device", "virtio-gpu-pci,xres=720,yres=1280,addr=02.0",
        "-device", "virtio-serial-pci-non-transitional,max_ports=31,id=virtio-serial,addr=03.0", ...consoles,
        ...(o.extract ? ["-chardev", `socket,id=extract,path=${o.extract},server=on,wait=off`,
            "-device", "virtserialport,bus=virtio-serial.0,chardev=extract,name=org.v86.extract,nr=30"] : []),
        "-device", "virtio-rng-pci-non-transitional,addr=04.0",
        // (a touch screen: QEMU's virtio-multitouch, as v86's)
        "-device", "virtio-keyboard-pci,addr=05.0", "-device", "virtio-multitouch-pci,addr=06.0",
        // (eth0, eth1, eth2: Cuttlefish's mobile, ethernet and wifi; init renames eth0 and eth2)
        "-netdev", "user,id=n0,net=10.0.1.0/24,restrict=on", "-device", "virtio-net-pci-non-transitional,netdev=n0,addr=07.0,romfile=",
        "-netdev", "user,id=n1,net=10.0.2.0/24,restrict=on", "-device", "virtio-net-pci-non-transitional,netdev=n1,addr=08.0,romfile=",
        "-netdev", "user,id=n2,net=10.0.3.0/24,restrict=on" + (o.adb_port ? `,hostfwd=tcp:127.0.0.1:${o.adb_port}-10.0.3.15:5555` : ""),
        "-device", "virtio-net-pci-non-transitional,netdev=n2,addr=09.0,romfile=",
        "-display", "none", "-monitor", o.monitor_socket ? `unix:${o.monitor_socket},server,nowait` : "none",
        "-chardev", `socket,id=ser0,path=${o.console_socket},server=on,wait=off`, "-serial", "chardev:ser0",
        // (a reboot restarts the machine with the disk's writes kept: snapshot=on's overlay lives as long as QEMU)
    ];
}

/** a screenshot through the human monitor (screendump, PPM) as <directory>/<name>.png */
export async function qemu_screendump(monitor_socket, directory, name)
{
    const ppm = directory + name + ".ppm";
    fs.rmSync(ppm, { force: true });
    await new Promise((resolve, reject) => {
        const s = net.connect(monitor_socket);
        s.on("connect", () => { s.write(`screendump ${ppm}\n`); setTimeout(() => { s.end(); resolve(); }, 1500); });
        s.on("error", reject);
    });
    for(let i = 0; i < 40 && !fs.existsSync(ppm); i++) await new Promise(resolve => setTimeout(resolve, 250));
    const bytes = fs.readFileSync(ppm);
    const m = /^P6\s+(\d+)\s+(\d+)\s+255\s/.exec(bytes.toString("latin1", 0, 40));
    const width = +m[1], height = +m[2], rgba = new Uint8Array(width * height * 4);
    for(let i = 0; i < width * height; i++)
    {
        rgba.set(bytes.subarray(m[0].length + i * 3, m[0].length + i * 3 + 3), i * 4);
        rgba[i * 4 + 3] = 255;
    }
    fs.rmSync(ppm);
    return save_png({ width, height, rgba }, directory, name);
}

/** The Android console (a shell on ttyAMA0) through QEMU's serial socket */
export class AndroidConsole
{
    constructor(socket_path)
    {
        this.socket_path = socket_path;
        this.text = "";
        this.socket = null;
    }

    async open(timeout_ms = 30000)
    {
        const deadline = Date.now() + timeout_ms;
        for(;;)
        {
            try
            {
                this.socket = await new Promise((resolve, reject) => {
                    const s = net.connect(this.socket_path);
                    s.once("connect", () => resolve(s));
                    s.once("error", reject);
                });
                break;
            }
            catch(e)
            {
                if(Date.now() > deadline) throw e;
                await new Promise(r => setTimeout(r, 200));
            }
        }
        this.socket.on("data", bytes => { this.text += bytes.toString("latin1"); });
        return this;
    }

    /** a command's output (between markers), or null when the shell does not answer in time */
    async run(command, timeout_ms = 60000)
    {
        const tag = "V86_" + Math.random().toString(36).slice(2, 10);
        const start = this.text.length;
        this.socket.write(`\necho ${tag}_B; ${command}; echo ${tag}_E $?\n`);
        const deadline = Date.now() + timeout_ms;
        const pattern = new RegExp(`\\n${tag}_B\\r?\\n([\\s\\S]*?)${tag}_E (\\d+)`);
        while(Date.now() < deadline)
        {
            const m = pattern.exec(this.text.slice(start));
            if(m) return { output: m[1].replace(/\r/g, ""), status: +m[2] };
            await new Promise(r => setTimeout(r, 200));
        }
        return null;
    }

    close()
    {
        this.socket?.destroy();
    }
}
