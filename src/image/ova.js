// OVF packages (docs/disk-image-formats-plan.md P4): an OVA is a TAR archive
// of an OVF descriptor (XML), its disks and other files. The importer reads
// the descriptor, the disks it names (each one opened by the disk image
// readers, inside the archive: a disk's descriptor gets archive_member) and
// the hardware it describes, mapped to v86's options where v86 has the
// hardware, with a note for each part it has not (architecture, firmware,
// controllers, devices). The disks come first; the options are a proposal.

import { DiskImageError } from "./source.js";

/**
 * A part of a source (a file in an archive)
 * @constructor
 * @param {?} source
 * @param {number} offset
 * @param {number} length
 * @param {string} name
 */
export function SliceSource(source, offset, length, name)
{
    this.inner = source;
    this.offset = offset;
    this.byteLength = length;
    this.name = name;
    this.sync = source.sync;
    this.stats = source.stats;
}

/** @param {function((Error|undefined))} callback */
SliceSource.prototype.open = function(callback)
{
    callback(undefined);
};

/**
 * @param {number} offset
 * @param {number} length
 * @param {function((!Uint8Array|undefined), (Error|undefined)=)} callback
 * @param {AbortSignal=} signal
 */
SliceSource.prototype.read = function(offset, length, callback, signal)
{
    if(offset < 0 || length < 0 || offset + length > this.byteLength)
    {
        throw new DiskImageError(this.name + ": read of " + length + " bytes at " + offset + " outside of the file (" +
            this.byteLength + " bytes)", "corrupt");
    }
    this.inner.read(this.offset + offset, length, callback, signal);
};

/**
 * @param {?} source
 * @param {number} offset
 * @param {number} length
 * @return {!Promise<!Uint8Array>}
 */
function read(source, offset, length)
{
    return new Promise((resolve, reject) => source.read(offset, length, (data, error) => error ? reject(error) : resolve(data)));
}

/**
 * A number of a TAR header: octal, or base-256 for large ones (GNU)
 * @param {!Uint8Array} bytes
 * @return {number}
 */
function tar_number(bytes)
{
    if(bytes[0] & 0x80)
    {
        let value = bytes[0] & 0x7F;
        for(let i = 1; i < bytes.length; i++) value = value * 256 + bytes[i];
        return value;
    }
    const text = String.fromCharCode(...bytes).replace(/\0.*$/, "").trim();
    return text ? parseInt(text, 8) : 0;
}

/**
 * @param {!Uint8Array} bytes
 * @return {string}
 */
function tar_string(bytes)
{
    const end = bytes.indexOf(0);
    return new TextDecoder().decode(end < 0 ? bytes : bytes.subarray(0, end));
}

/**
 * The files of a TAR archive (ustar, with GNU long names and PAX headers)
 * @param {?} source
 * @return {!Promise<!Array<{name: string, offset: number, size: number}>>}
 */
export async function read_tar(source)
{
    const files = [];
    let long_name = "";
    let pax = Object.create(null);
    for(let offset = 0; offset + 512 <= source.byteLength;)
    {
        const header = (await read(source, offset, 512)).slice();
        if(header.every(b => b === 0)) break;
        let sum = 0;
        for(let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : header[i];
        if(sum !== tar_number(header.subarray(148, 156)))
        {
            throw new DiskImageError(source.name + ": the TAR header at " + offset + " has a wrong checksum", "corrupt");
        }
        const type = String.fromCharCode(header[156]);
        let size = tar_number(header.subarray(124, 136));
        if(pax["size"] !== undefined) size = +pax["size"];
        let name = tar_string(header.subarray(0, 100));
        if(String.fromCharCode(...header.subarray(257, 262)) === "ustar")
        {
            const prefix = tar_string(header.subarray(345, 500));
            if(prefix) name = prefix + "/" + name;
        }
        if(long_name) name = long_name;
        if(pax["path"] !== undefined) name = pax["path"];
        const data = offset + 512;
        if(!Number.isSafeInteger(size) || data + size > source.byteLength)
        {
            throw new DiskImageError(source.name + ": the TAR member " + JSON.stringify(name) + " (" + size +
                " bytes) runs past the end of the archive", "corrupt");
        }
        if(type === "L")
        {
            long_name = tar_string(await read(source, data, size));
        }
        else if(type === "x")
        {
            const text = new TextDecoder().decode(await read(source, data, size));
            for(const record of text.split("\n"))
            {
                const match = /^\d+ ([^=]+)=(.*)$/.exec(record);
                if(match) pax[match[1]] = match[2];
            }
        }
        else if(type === "g")
        {
            // (global PAX headers: nothing that matters here)
        }
        else
        {
            if(type === "0" || type === "\0" || type === "7")
            {
                files.push({ name: name.replace(/^\.\//, ""), offset: data, size });
            }
            long_name = "";
            pax = Object.create(null);
        }
        offset = data + Math.ceil(size / 512) * 512;
    }
    return files;
}

/**
 * A small XML parser for OVF descriptors: elements by their local name
 * (namespace prefixes dropped), attributes likewise, and text
 * @param {string} text
 * @return {!Object} the root element: {name, attributes, children, text}
 */
export function parse_xml(text)
{
    const root = { name: "", attributes: Object.create(null), children: [], text: "" };
    const stack = [root];
    const local = name => name.replace(/^[^:]*:/, "");
    const unescape = s => s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (m, e) =>
        e === "lt" ? "<" : e === "gt" ? ">" : e === "amp" ? "&" : e === "quot" ? "\"" : e === "apos" ? "'" :
        String.fromCodePoint(e[1] === "x" ? parseInt(e.substring(2), 16) : parseInt(e.substring(1), 10)));
    const tag = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<!DOCTYPE[^>]*>|<(\/?)([^\s>\/]+)((?:\s+[^\s=>\/]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
    for(let match; (match = tag.exec(text));)
    {
        const top = stack[stack.length - 1];
        if(match[1] !== undefined)
        {
            top.text += match[1];
        }
        else if(match[6] !== undefined)
        {
            top.text += unescape(match[6]);
        }
        else if(match[3] !== undefined)
        {
            if(match[2])
            {
                if(stack.length === 1 || top.name !== local(match[3]))
                {
                    throw new DiskImageError("OVF: the XML closes " + match[3] + " where " + (top.name || "nothing") + " is open", "corrupt");
                }
                stack.pop();
                continue;
            }
            const element = { name: local(match[3]), attributes: Object.create(null), children: [], text: "" };
            for(const attribute of (match[4] || "").matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g))
            {
                element.attributes[local(attribute[1])] = unescape(attribute[2] !== undefined ? attribute[2] : attribute[3]);
            }
            top.children.push(element);
            if(!match[5]) stack.push(element);
        }
    }
    if(stack.length !== 1) throw new DiskImageError("OVF: the XML ends with " + stack[stack.length - 1].name + " open", "corrupt");
    return root;
}

/**
 * @param {!Object} element
 * @param {string} name
 * @return {!Array<!Object>} the descendants of that name
 */
function find_all(element, name)
{
    const result = [];
    const visit = e =>
    {
        for(const child of e.children)
        {
            if(child.name === name) result.push(child);
            visit(child);
        }
    };
    visit(element);
    return result;
}

/**
 * @param {!Object} element
 * @param {string} name
 * @return {string|undefined} the text of a child
 */
function child_text(element, name)
{
    const child = element.children.find(c => c.name === name);
    return child ? child.text.trim() : undefined;
}

/**
 * Bytes from an OVF quantity and its units ("byte * 2^20", "MegaBytes", ...)
 * @param {number} value
 * @param {string|undefined} units
 * @return {number}
 */
export function ovf_bytes(value, units)
{
    if(!units) return value;
    const u = units.replace(/\s+/g, "").toLowerCase();
    const power = /^byte\*2\^(\d+)$/.exec(u);
    if(power) return value * 2 ** +power[1];
    const table = { "byte": 1, "bytes": 1, "kilobytes": 2 ** 10, "kb": 2 ** 10, "megabytes": 2 ** 20, "mb": 2 ** 20,
        "gigabytes": 2 ** 30, "gb": 2 ** 30, "terabytes": 2 ** 40 };
    if(table[u] !== undefined) return value * table[u];
    throw new DiskImageError("OVF: unknown allocation units " + JSON.stringify(units), "unsupported");
}

// OVF/CIM ResourceType (DMTF CIM_ResourceAllocationSettingData)
const RESOURCE = {
    PROCESSOR: 3, MEMORY: 4, IDE: 5, SCSI: 6, ETHERNET: 10, FLOPPY: 14, CD: 15, DVD: 16, DISK: 17,
    USB: 23, GRAPHICS: 24, SOUND: 35, SATA: 20,
};

/**
 * What an OVF descriptor says: its disks (the file each is in, its
 * controller), the hardware as v86 options, notes for what v86 does not have
 * @param {string} text the descriptor
 * @return {{disks: !Array<!Object>, options: !Object, notes: !Array<string>}}
 */
export function read_ovf(text)
{
    const root = parse_xml(text);
    const envelope = root.children.find(c => c.name === "Envelope");
    if(!envelope) throw new DiskImageError("OVF: no Envelope", "corrupt");
    const notes = [];
    const files = new Map(find_all(envelope, "References").flatMap(r => r.children.filter(c => c.name === "File"))
        .map(f => [f.attributes["id"], f.attributes]));
    const disks = [];
    for(const disk of find_all(envelope, "DiskSection").flatMap(s => s.children.filter(c => c.name === "Disk")))
    {
        const a = disk.attributes;
        const file = a["fileRef"] && files.get(a["fileRef"]);
        const capacity = ovf_bytes(+a["capacity"], a["capacityAllocationUnits"]);
        const format_uri = a["format"] || "";
        const format = /vmdk/i.test(format_uri) ? "vmdk" : /vhdx/i.test(format_uri) ? "vhdx" : /vhd/i.test(format_uri) ? "vhd" :
            /qcow/i.test(format_uri) ? "qcow2" : "auto";
        if(!file && a["fileRef"]) notes.push("disk " + a["diskId"] + ": its file " + a["fileRef"] + " is not in References");
        disks.push({
            id: a["diskId"], file: file ? file["href"] : "", format, format_uri, capacity, controller: "",
            compression: file && file["compression"] || "",
        });
    }

    const options = Object.create(null);
    const system = find_all(envelope, "VirtualSystem")[0];
    if(!system) throw new DiskImageError("OVF: no VirtualSystem", "corrupt");
    if(find_all(envelope, "VirtualSystem").length > 1) notes.push("several virtual systems: the first one is read");
    const os = find_all(system, "OperatingSystemSection")[0];
    if(os)
    {
        const description = child_text(os, "Description") || os.attributes["osType"] || "id " + os.attributes["id"];
        notes.push("the guest: " + description);
        if(/64/.test(os.attributes["osType"] || description)) options["cpu_type"] = "x86-64";
        if(/arm|aarch/i.test(os.attributes["osType"] || description))
        {
            notes.push("an ARM guest: v86 emulates x86 (and the arm64 virt machine, cpu_type \"arm64\", for Linux)");
        }
    }
    const hardware = find_all(system, "VirtualHardwareSection")[0];
    const items = hardware ? hardware.children.filter(c => c.name === "Item" || c.name === "StorageItem" || c.name === "EthernetPortItem") : [];
    const controllers = new Map();
    for(const item of items)
    {
        const type = +child_text(item, "ResourceType");
        const id = child_text(item, "InstanceID");
        const subtype = child_text(item, "ResourceSubType") || "";
        if(type === RESOURCE.IDE) controllers.set(id, "ide");
        else if(type === RESOURCE.SATA) controllers.set(id, "sata");
        else if(type === RESOURCE.SCSI) controllers.set(id, "scsi" + (subtype ? " (" + subtype + ")" : ""));
    }
    for(const item of items)
    {
        const type = +child_text(item, "ResourceType");
        const quantity = +(child_text(item, "VirtualQuantity") || 0);
        const subtype = child_text(item, "ResourceSubType") || "";
        const name = child_text(item, "ElementName") || "";
        if(type === RESOURCE.PROCESSOR)
        {
            options["cpu_cores"] = Math.max(1, quantity);
        }
        else if(type === RESOURCE.MEMORY)
        {
            options["memory_size"] = ovf_bytes(quantity, child_text(item, "AllocationUnits"));
        }
        else if(type === RESOURCE.DISK)
        {
            const resource = child_text(item, "HostResource") || "";
            const disk = disks.find(d => resource.endsWith("/" + d.id) || resource === d.id);
            if(disk) disk.controller = controllers.get(child_text(item, "Parent")) || "";
        }
        else if(type === RESOURCE.ETHERNET)
        {
            notes.push("network adapter " + (subtype || name) + ": v86 has an NE2000 and virtio-net (net_device), not this one");
        }
        else if(type === RESOURCE.SOUND)
        {
            notes.push("sound " + (subtype || name) + ": v86 has a Sound Blaster 16");
        }
        else if(type === RESOURCE.USB)
        {
            notes.push("USB " + (subtype || name) + ": v86 has no USB controller");
        }
    }
    for(const [, controller] of controllers)
    {
        if(controller.startsWith("scsi")) notes.push("a SCSI controller " + controller + ": v86 has IDE and AHCI (SATA): its disks go there");
    }
    if(disks.some(d => d.controller === "sata")) options["machine_type"] = "q35";
    // firmware: VMware's "firmware" config, VirtualBox's Firmware element
    const firmware = find_all(system, "Config").find(c => c.attributes["key"] === "firmware");
    const vbox_firmware = find_all(system, "Firmware")[0];
    if(firmware && firmware.attributes["value"] === "efi" || vbox_firmware && /efi/i.test(vbox_firmware.attributes["type"] || ""))
    {
        notes.push("the system boots with EFI: v86's firmware is a BIOS (SeaBIOS); it boots only if the disk can boot from a BIOS too");
    }
    if(disks.filter(d => d.file).length > 2 && options["machine_type"] !== "q35")
    {
        notes.push(disks.length + " disks: i440FX has hda and hdb (machine_type \"q35\" has six SATA ports)");
    }
    return { disks, options, notes };
}

/**
 * Read an OVA: its OVF descriptor and the disks in it
 * @param {?} source the archive
 * @return {!Promise<!Object>} ovf, members, disks, options, notes
 */
export async function read_ova(source)
{
    const members = await read_tar(source);
    const ovf_member = members.find(m => /\.ovf$/i.test(m.name));
    if(!ovf_member) throw new DiskImageError(source.name + ": no OVF descriptor (.ovf) in the archive", "corrupt");
    if(ovf_member.size > 16 * 1024 * 1024) throw new DiskImageError(source.name + ": the OVF descriptor is too large", "unsupported");
    const ovf = new TextDecoder().decode(await read(source, ovf_member.offset, ovf_member.size));
    const result = read_ovf(ovf);
    for(const disk of result.disks)
    {
        if(!disk.file) continue;
        const member = members.find(m => m.name === disk.file || m.name.replace(/^.*\//, "") === disk.file);
        if(!member)
        {
            result.notes.push("disk " + disk.id + ": its file " + disk.file + " is not in the archive");
            disk.missing = true;
            continue;
        }
        if(disk.compression)
        {
            result.notes.push("disk " + disk.id + ": its file is compressed (" + disk.compression + "): not supported");
            disk.missing = true;
        }
        disk.member = member.name;
        disk.offset = member.offset;
        disk.size = member.size;
    }
    return { ovf, members, ...result };
}
