// Direct handoff to the 32-bit N90 kernel (10B329). XNU constructs its first
// translation tables at topOfKernelData, after all the objects left by iBoot.
import { configure_nand_tree } from "./nand.js";
import { N90_VIDEO } from "./clcd.js";
import { macho_parse, CPU_TYPE_ARM } from "./macho.js";
import { dt_parse, dt_serialize, dt_find, dt_name, dt_property, dt_strings, dt_set } from "./devicetree.js";

const PHYS = 0x40000000, VIRT = 0x80000000;
const page = n => Math.ceil(n / 4096) * 4096;

function cells(...values)
{
    const bytes = new Uint8Array(values.length * 4);
    const view = new DataView(bytes.buffer);
    values.forEach((value, i) => view.setUint32(i * 4, value, true));
    return bytes;
}

/** Populate guest RAM and return the physical PC and r0 used at reset. */
export function load_n90_kernel(ram, kernelcache, devicetree, ramdisk, cmdline, nand = false, gles = false)
{
    const kernel = macho_parse(kernelcache);
    if(kernel.is64 || kernel.cputype !== CPU_TYPE_ARM || kernel.filetype !== 2 ||
        !kernel.segments.some(s => s.initprot & 4 && kernel.entry >= s.vmaddr && kernel.entry < s.vmaddr + s.filesize))
    {
        throw new Error("N90 boot needs an executable ARM kernelcache with a mapped entry");
    }
    const tree = dt_parse(devicetree);
    if(nand) configure_nand_tree(tree);
    const compatible = dt_property(tree, "compatible");
    if(!compatible || !dt_strings(compatible.value).includes("N90AP")) throw new Error("expected N90AP device tree");

    const required = path => {
        const node = dt_find(tree, path);
        if(!node) throw new Error("missing N90 device-tree node " + path);
        return node;
    };
    // This board has the internal LCD. External video, camera codecs,
    // USB, cellular and radio peripherals have no emulated endpoints.
    const io = required("/arm-io");
    tree.children = tree.children.filter(child => dt_name(child) !== "baseband");
    io.children = io.children.filter(child => !["sdio", "spi2", "tv-out", "rgbout", "displayport", "isp",
        "venc", "vxd", "jpeg", "scaler", "usb-complex", "otgphyctrl"].includes(dt_name(child)));
    // iBoot would identify the internal panel before XNU starts. The
    // restore tree carries a zero placeholder, which ApplePinotLCD rejects.
    const lcd = dt_find(tree, "/arm-io/mipi-dsim/lcd");
    if(lcd)
    {
        const id = dt_property(lcd, "lcd-panel-id");
        if(!id || (id.value.length === 4 && id.value.every(byte => byte === 0)))
            dt_set(lcd, "lcd-panel-id", cells(1)); // emulated Pinot class 1
    }
    const uart3 = dt_find(tree, "/arm-io/uart3");
    if(uart3) uart3.children = uart3.children.filter(child => dt_name(child) !== "bluetooth");
    // UIKit reads this iBoot property as an integer point-to-pixel ratio.
    // N90's 640x960 panel has a 320x480 point coordinate space.
    const chosen = required("/chosen"), scale = dt_property(chosen, "display-scale");
    if(!scale || (scale.value.length === 4 && scale.value.every(byte => byte === 0)))
        dt_set(chosen, "display-scale", cells(2));
    const cpu = required("/cpus/cpu0");
    for(const [name, hz] of Object.entries({ "timebase-frequency": 24000000, "fixed-frequency": 24000000,
        "clock-frequency": 800000000, "bus-frequency": 200000000, "memory-frequency": 200000000,
        "peripheral-frequency": 100000000 }))
    {
        dt_set(cpu, name, cells(hz));
    }
    dt_set(tree, "clock-frequency", cells(24000000));
    // iBoot fills these device-clock slots. A zero pclk/nclk makes the
    // original Samsung SPI driver reject the controller before mapping it.
    const clock_property = dt_property(io, "clock-frequencies");
    if(clock_property && clock_property.value.length >= 0x31 * 4)
    {
        const clocks = clock_property.value.slice(), view = new DataView(clocks.buffer, clocks.byteOffset);
        for(const [slot, hz] of [[0x22, 100000000], [0x2f, 24000000], [0x30, 24000000]])
            if(!view.getUint32(slot * 4, true)) view.setUint32(slot * 4, hz, true);
        dt_set(io, "clock-frequencies", clocks);
    }
    // The restore tree leaves iBoot's per-device accelerometer calibration
    // empty. This simulated sensor has unit gain and no cross-axis error;
    // the native driver requires a nonzero 16.16 calibration matrix.
    const accelerometer = dt_find(tree, "/arm-io/i2c2/accelerometer");
    if(accelerometer)
    {
        const calibration = dt_property(accelerometer, "accel-sensitivity-calibration");
        if(!calibration || calibration.value.every(byte => byte === 0))
        {
            const matrix = new Uint8Array(Math.max(40, calibration?.value.length || 0));
            const view = new DataView(matrix.buffer);
            for(const at of [0, 16, 32]) view.setUint32(at, 0x10000, true);
            dt_set(accelerometer, "accel-sensitivity-calibration", matrix);
        }
    }

    // IODTNVRAM walks 16-byte units in the 8 KiB iBoot proxy. The zero
    // placeholder has a zero-length partition and the walk never advances.
    const nvram = new Uint8Array(8192);
    nvram[0] = 0x70;
    new DataView(nvram.buffer).setUint16(2, nvram.length / 16, true);
    nvram.set(new TextEncoder().encode("common"), 4);
    let sum = nvram.subarray(0, 16).reduce((total, byte) => total + byte, 0);
    while(sum > 255) sum = (sum & 255) + (sum >>> 8);
    nvram[1] = sum;
    dt_set(required("/chosen"), "nvram-proxy-data", nvram);
    dt_set(required("/chosen"), "firmware-version", new TextEncoder().encode("v86 direct boot\0"));
    const command = new TextEncoder().encode(cmdline ?? (nand && !ramdisk ? "-v serial=3 rd=disk0s1s1" : "-v serial=3"));
    if(command.includes(0) || command.length >= 256) throw new Error("invalid iOS boot command line");
    let end = 0;
    for(const s of kernel.segments)
    {
        const offset = s.vmaddr - VIRT;
        if(offset < 0 || offset + s.vmsize > ram.length || s.filesize > s.vmsize ||
            s.fileoff + s.filesize > kernelcache.length) throw new Error("invalid kernel segment " + s.name);
        end = Math.max(end, offset + s.vmsize);
    }
    const disk = page(end);
    const pram = page(disk + (ramdisk?.length || 0));
    const treeOffset = pram + 0x4000;
    dt_set(required("/pram"), "reg", cells(PHYS + pram, 0x4000));
    const usable = Math.min(ram.length, N90_VIDEO.base - PHYS);
    dt_set(required("/memory"), "reg", cells(PHYS, usable));
    dt_set(required("/vram"), "reg", cells(N90_VIDEO.base, N90_VIDEO.height * N90_VIDEO.stride));
    dt_set(required("/chosen"), "chip-id", cells(0x8930));
    if(gles) dt_set(required("/chosen"), "v86,gles-backdoor", cells(1));
    if(ramdisk) dt_set(required("/chosen/memory-map"), "RAMDisk", cells(PHYS + disk, ramdisk.length));
    const dt = dt_serialize(tree);
    const args = page(treeOffset + dt.length);
    const tables = Math.ceil((args + 4096) / 16384) * 16384;
    if(tables + 0xA000 > usable) throw new Error("iOS boot data exceeds RAM");
    for(const s of kernel.segments)
    {
        const offset = s.vmaddr - VIRT;
        ram.set(kernelcache.subarray(s.fileoff, s.fileoff + s.filesize), offset);
        ram.fill(0, offset + s.filesize, offset + s.vmsize);
    }
    if(ramdisk) ram.set(ramdisk, disk);
    ram.set(dt, treeOffset);
    ram.fill(0, args, args + 4096);
    ram.set(cells(3 << 16 | 1, VIRT, PHYS, usable, PHYS + tables), args);
    ram.set(cells(N90_VIDEO.base, 0, N90_VIDEO.stride, N90_VIDEO.width, N90_VIDEO.height, 32), args + 0x14);
    ram.set(cells(VIRT + treeOffset, dt.length), args + 0x30);
    ram.set(command, args + 0x38);
    const diskNode = dt_find(tree, "/arm-io/flash-controller0/disk");
    const chipIDs = diskNode && dt_property(diskNode, "dbg-chipids");
    return { entry: PHYS + kernel.entry - VIRT, r0: PHYS + args, chip_ids: chipIDs ? chipIDs.value : null };
}
