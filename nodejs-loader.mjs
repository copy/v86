import vm from "node:vm";
import url from "node:url";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import perf_hooks from "node:perf_hooks";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));

let files = [
    "src/const.js",
    "src/config.js",
    "src/log.js",
    "src/cpu.js",
    "src/debug.js",
    "src/io.js",
    "src/main.js",
    "src/lib.js",
    "src/buffer.js",
    "src/ide.js",
    "src/pci.js",
    "src/floppy.js",
    "src/memory.js",
    "src/dma.js",
    "src/pit.js",
    "src/vga.js",
    "src/ps2.js",

    "src/rtc.js",
    "src/uart.js",

    "src/acpi.js",
    "src/apic.js",
    "src/ioapic.js",

    "src/state.js",
    "src/ne2k.js",
    "src/sb16.js",
    "src/virtio.js",
    "src/virtio_console.js",
    "src/virtio_net.js",
    "src/virtio_balloon.js",
    "src/bus.js",

    "src/debug.js",
    "src/elf.js",
    "src/kernel.js",

    "lib/9p.js",
    "lib/filesystem.js",
    "lib/jor1k.js",
    "lib/marshall.js",

    "src/browser/screen.js",
    "src/browser/keyboard.js",
    "src/browser/mouse.js",
    "src/browser/speaker.js",
    "src/browser/serial.js",
    "src/browser/network.js",
    "src/browser/fake_network.js",
    "src/browser/fetch_network.js",
    "src/browser/starter.js",
    "src/browser/worker_bus.js",
    "src/browser/dummy_screen.js",
    "src/browser/print_stats.js",
    "src/browser/filestorage.js"
];


let globals = Object.create(globalThis);
let v86 = {};

let ctx = vm.createContext(globals);
globals.DEBUG = false;
globals.module = {exports:v86};
Object.defineProperty(globals, "crypto", {value: crypto});
globals.require = (what) => {
    return ({
        perf_hooks,
        fs
    })[what];
};

for( let f of files ) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, f), "utf8"), ctx, {
        filename: f
    });
}

export let {
    FetchNetworkAdapter,
    MemoryFileStorage,
    ServerFileStorageWrapper,
} = globals;

export default V86;

