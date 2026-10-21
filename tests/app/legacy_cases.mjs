// The old page's starts that tests/app/legacy_options.mjs records
// (docs/vm-manager-plan.md U0): query arguments and form inputs.

import fs from "node:fs";
import path from "node:path";

/** Query arguments: custom images and every argument start_emulation reads, alone and with profiles */
export const QUERY_CASES = [
    "profile=custom&hda.url=images/msdos622.img",
    "profile=custom&cdrom.url=images/linux4.iso&cdrom.size=7731200&m=512",
    "profile=custom&fda.url=images/freedos722.img&fda.size=737280",
    "profile=custom&hda.url=a.img&hda.size=1048576&hdb.url=b.img&hdb.size=2097152&chunk_size=1000",
    "profile=custom&hda.url=a.img&chunk_size=9999999",
    "profile=custom&hda.url=http://127.0.0.1:8471/a.img&hda.disk_option=read_write&hda.disk_error=report&hdb.url=b.img&hdb.disk_option=read_only",
    "profile=custom&hda.empty=1048576&hdb.empty=0&cdrom.url=c.iso",
    "profile=custom&cdrom.url=c.iso&m=4096",
    "profile=custom&cdrom.url=c.iso&m=3001&cpu_type=x86_64&cores=4&parallel=0",
    "profile=custom&cdrom.url=c.iso&m=99999999",
    "profile=custom&cdrom.url=c.iso&m=8",
    "profile=custom&cdrom.url=c.iso&cpu_type=arm64&m=2048&graphics_adapter=virtio_gpu&displays=2&cmdline=console%3DttyAMA0",
    "profile=custom&cdrom.url=c.iso&cpu_type=arm64&m=512",
    "profile=custom&cdrom.url=c.iso&cpu_type=arm64&machine_type=i440fx&graphics_adapter=bochs_vga",
    "profile=custom&cdrom.url=c.iso&cpu_type=arm64&disable_jit=1&hda.url=d.img",
    "profile=custom&cdrom.url=c.iso&cpu_type=x86&machine_type=virt",
    "profile=custom&hda.url=h.img&machine_type=q35&hpet=0&smbus=0&root_ports=3",
    "profile=custom&hda.url=h.img&machine_type=q35&root_ports=99",
    "profile=custom&hda.url=h.img&machine_type=q35&cores=2&acpi=0",
    "profile=custom&cdrom.url=c.iso&vram=300&graphics_adapter=vmware_svga",
    "profile=custom&cdrom.url=c.iso&vram=5&displays=9",
    "profile=custom&cdrom.url=c.iso&acpi=1&bios=bochs&boot_order=213",
    "profile=custom&cdrom.url=c.iso&net_device_type=virtio&mtu=9000&relay_url=fetch:https://proxy.invalid/&mute=1&disable_jit=1&modem=2",
    "profile=custom&cdrom.url=c.iso&relay_url=wisps://wisp.invalid/&modem=7&mtu=abc",
    "profile=custom&cdrom.url=c.iso&kernel.url=k.bin&initrd.url=i.bin&cmdline=console%3DttyS0",
    "profile=custom&cdrom.url=c.iso&cpu_worker=0&ir_tier0=0&x87_fast_math=0&x87_jit_cache=0",
    "profile=custom&cdrom.url=c.iso&cores=2&acpi=0&parallel=1",
    "profile=custom&cdrom.url=c.iso&cpu_type=bogus&machine_type=bogus",
    "profile=custom&hda.url=h.img&fda.url=f.img&fda.disk_option=read_write&fda.disk_error=report&hdb.disk_option=read_write",
    "profile=custom&cdrom.url=c.iso&c=dir&s=ls&theatre=1&graphics_proxy=0",
    "profile=freedos&m=256&cores=2&vram=16",
    "profile=windows98&acpi=1&mute=1&relay_url=inbrowser&disable_jit=1",
    "profile=archlinux&hda.url=x.img&m=1024",
    "profile=linux4&cpu_type=x86_64&machine_type=q35",
    "profile=freedos&graphics_adapter=none&net_device_type=none&modem=0",
    "profile=freedos&hda.url=h.img&hda.disk_option=read_write&cdn=https://cdn.invalid/",
    "profile=linux4&cdn=https://cdn.invalid/images/",
];

/** Starts from the form: [name, [["value" | "check" | "click", element id, value]...]] */
export const FORM_CASES = [
    ["defaults", []],
    ["memory 4096", [["value", "memory_size", "4096"], ["value", "vga_memory_size", "32"], ["value", "graphics_adapter", "vmware_svga"]]],
    ["memory 3001", [["value", "memory_size", "3001"]]],
    ["4 cores, not parallel", [["value", "cpu_cores", "4"], ["check", "parallel", false], ["check", "acpi", false]]],
    ["arm64", [["value", "cpu_type", "arm64"], ["value", "memory_size", "2048"]]],
    ["arm64 virtio_gpu", [["value", "cpu_type", "arm64"], ["value", "graphics_adapter", "virtio_gpu"], ["value", "machine_type", "q35"]]],
    ["x86 on virt", [["value", "machine_type", "virt"]]],
    ["q35 and the rest", [["value", "machine_type", "q35"], ["value", "boot_order", "213"], ["value", "net_device_type", "virtio"],
        ["value", "mtu", "9000"], ["value", "modem", "1"], ["check", "disable_audio", true], ["value", "relay_url", "wss://relay.invalid/"]]],
    ["x86_64 q35 2 cores", [["value", "cpu_type", "x86_64"], ["value", "machine_type", "q35"], ["value", "cpu_cores", "2"]]],
    ["acpi", [["check", "acpi", true], ["value", "vga_memory_size", "3"]]],
    ["fetch relay", [["value", "relay_url", "fetch:https://cors.invalid/"]]],
    ["no relay", [["value", "relay_url", ""], ["value", "net_device_type", "none"]]],
    ["empty disks", [["click", "hda_toggle_empty_disk"], ["value", "hda_empty_size", "50"], ["click", "fda_toggle_empty_disk"],
        ["value", "fda_empty_size", "368640"]]],
    ["empty hdb", [["click", "hdb_toggle_empty_disk"], ["value", "hdb_empty_size", "99999"], ["click", "fdb_toggle_empty_disk"]]],
    ["disk urls", [["value", "hda_url", " http://127.0.0.1:8471/a.img "], ["value", "hda_disk_option", "read_write"],
        ["value", "hdb_url", "b.img"]]],
    ["read write without a url", [["value", "hda_disk_option", "read_write"]]],
    ["second read write without a url", [["value", "hda_url", "a.img"], ["value", "hdb_disk_option", "read_write"]]],
];

/**
 * The profiles' ids: profiles.js's once it exists, else main.js's list
 * @param {string} root
 */
export async function profile_ids(root)
{
    const profiles = path.join(root, "src/browser/profiles.js");
    if(fs.existsSync(profiles))
    {
        const { get_profiles } = await import(profiles);
        return get_profiles("images/", true).map(p => p.id);
    }
    const main = fs.readFileSync(path.join(root, "src/browser/main.js"), "utf8");
    const list = main.slice(main.indexOf("    const oses = ["), main.indexOf("\n    ];\n", main.indexOf("    const oses = [")));
    return Array.from(list.matchAll(/^ {12}id: "([^"]+)",$/gm), m => m[1]);
}

/**
 * The differences between two records, one line each
 * @param {!Object} expected
 * @param {!Object} actual
 * @return {!Array<string>}
 */
export function compare_records(expected, actual)
{
    const lines = [];
    const walk = (a, b, at) =>
    {
        if(a && b && typeof a === "object" && typeof b === "object" && Array.isArray(a) === Array.isArray(b))
        {
            for(const k of new Set([...Object.keys(a), ...Object.keys(b)]))
            {
                if(!(k in a)) lines.push(at + "." + k + ": only now, " + JSON.stringify(b[k]));
                else if(!(k in b)) lines.push(at + "." + k + ": missing now, was " + JSON.stringify(a[k]));
                else walk(a[k], b[k], at + "." + k);
            }
        }
        else if(JSON.stringify(a) !== JSON.stringify(b))
        {
            lines.push(at + ": " + JSON.stringify(a) + " -> " + JSON.stringify(b));
        }
    };
    for(const key of new Set([...Object.keys(expected), ...Object.keys(actual)]))
    {
        if(!(key in actual)) lines.push(key + ": not recorded now");
        else if(!(key in expected)) lines.push(key + ": new case");
        else walk(expected[key], actual[key], key);
    }
    return lines;
}
