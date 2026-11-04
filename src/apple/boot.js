// Direct handoff to the 32-bit N90 kernel (10B329). XNU constructs its first
// translation tables at topOfKernelData, after all the objects left by iBoot.
import { macho_parse, CPU_TYPE_ARM } from "./macho.js";
import { dt_parse, dt_serialize, dt_find, dt_property, dt_strings, dt_set } from "./devicetree.js";

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
export function load_n90_kernel(ram, kernelcache, devicetree, ramdisk, cmdline = "-v serial=3")
{
    const kernel = macho_parse(kernelcache);
    if(kernel.is64 || kernel.cputype !== CPU_TYPE_ARM || kernel.filetype !== 2 ||
        !kernel.segments.some(s => s.initprot & 4 && kernel.entry >= s.vmaddr && kernel.entry < s.vmaddr + s.filesize))
    {
        throw new Error("N90 boot needs an executable ARM kernelcache with a mapped entry");
    }
    const tree = dt_parse(devicetree);
    const compatible = dt_property(tree, "compatible");
    if(!compatible || !dt_strings(compatible.value).includes("N90AP")) throw new Error("expected N90AP device tree");

    const required = path => {
        const node = dt_find(tree, path);
        if(!node) throw new Error("missing N90 device-tree node " + path);
        return node;
    };
    const cpu = required("/cpus/cpu0");
    for(const [name, hz] of Object.entries({ "timebase-frequency": 24000000, "fixed-frequency": 24000000,
        "clock-frequency": 800000000, "bus-frequency": 200000000, "memory-frequency": 200000000,
        "peripheral-frequency": 100000000 }))
    {
        dt_set(cpu, name, cells(hz));
    }
    dt_set(tree, "clock-frequency", cells(24000000));

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
    const command = new TextEncoder().encode(cmdline);
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
    dt_set(required("/memory"), "reg", cells(PHYS, ram.length));
    dt_set(required("/chosen"), "chip-id", cells(0x8930));
    if(ramdisk) dt_set(required("/chosen/memory-map"), "RAMDisk", cells(PHYS + disk, ramdisk.length));
    const dt = dt_serialize(tree);
    const args = page(treeOffset + dt.length);
    const tables = Math.ceil((args + 4096) / 16384) * 16384;
    if(tables + 0xA000 > ram.length) throw new Error("iOS boot data exceeds RAM");
    for(const s of kernel.segments)
    {
        const offset = s.vmaddr - VIRT;
        ram.set(kernelcache.subarray(s.fileoff, s.fileoff + s.filesize), offset);
        ram.fill(0, offset + s.filesize, offset + s.vmsize);
    }
    if(ramdisk) ram.set(ramdisk, disk);
    ram.set(dt, treeOffset);
    ram.fill(0, args, args + 4096);
    ram.set(cells(3 << 16 | 1, VIRT, PHYS, ram.length, PHYS + tables), args);
    ram.set(cells(VIRT + treeOffset, dt.length), args + 0x30);
    ram.set(command, args + 0x38);
    return { entry: PHYS + kernel.entry - VIRT, r0: PHYS + args };
}
