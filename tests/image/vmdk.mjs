#!/usr/bin/env node
// VMDK and OVA (docs/disk-image-formats-plan.md P4) against qemu-img: each
// subformat qemu-img makes (monolithicSparse, streamOptimized,
// monolithicFlat, twoGbMaxExtentSparse, twoGbMaxExtentFlat), zeroed grains,
// a child with its parent (CID), large sparse disks and extents across 2 GiB;
// damaged descriptors, headers, tables and grains; OVA archives (ustar and
// pax) of an OVF descriptor and a streamOptimized disk: the disk read in the
// archive as qemu-img reads the VMDK, the hardware mapped with notes.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { make_samples, SAMPLES_DIR } from "./samples.mjs";
import { sample_file, sample_files, settings, read, open_sample, open_bytes, rejects, compare,
    check_against_reference, check_writes } from "./helpers.mjs";
import { open_image, import_ova } from "../../src/image/factory.js";
import { parse_xml, read_ovf } from "../../src/image/ova.js";

process.on("unhandledRejection", exn => { throw exn; });

const manifest = make_samples();
const base = fs.readFileSync(sample_file("base.raw"));
let compared = 0;

for(const name of ["sparse.vmdk", "stream.vmdk", "flat.vmdk", "2gbsparse.vmdk", "2gbflat.vmdk", "zeroed.vmdk"])
{
    const files = sample_files(manifest.samples[name]);
    compared += await check_against_reference(manifest, name, "vmdk", { files });
    const reader = await open_sample(name, "auto", "url", { files });
    assert.equal(reader.format, "vmdk", name + ": auto");
    console.log("ok - " + name + " (" + reader.create_type + "): as qemu-img reads it, whole and in ranges");
}
{
    const zeroed = await open_sample("zeroed.vmdk", "vmdk", "url");
    const extents = await new Promise(resolve => zeroed.map(0, 131072, resolve));
    assert.deepEqual(extents.map(e => e.type), [1], "zeroed grains (GTE 1) read as zeros");
}
for(const name of ["5g-sparse.vmdk", "5g-flat.vmdk"])
{
    await check_writes(manifest, name, "vmdk", { files: sample_files(manifest.samples[name]) });
}
await check_writes(manifest, "100g.vmdk", "vmdk");
console.log("ok - VMDK: 2 GiB extents (sparse and flat) written across an extent's end, 100 GiB beyond 4 GiB");

// a child: the parent given, a VMDK whose CID is the child's parentCID
compared += await check_against_reference(manifest, "child.vmdk", "vmdk", { backing: { url: sample_file("sparse.vmdk"), async: true } });
await rejects(open_sample("child.vmdk", "vmdk", "url"), /continues in a parent image/, "config");
await rejects(open_sample("child.vmdk", "vmdk", "url", { backing: { url: sample_file("stream.vmdk") } }), /the parent's CID is .*: not its parent/, "config");
await rejects(open_sample("child.vmdk", "vmdk", "url", { backing: { url: sample_file("v3.qcow2") } }), /a VMDK's parent is a VMDK/, "config");
console.log("ok - VMDK: a child with its parent; missing, another CID, another format: refused");

// damaged descriptors, headers, tables, grains
{
    const text = fs.readFileSync(sample_file("flat.vmdk"), "utf8");
    const descriptor = (t, files = sample_files(manifest.samples["flat.vmdk"])) =>
        open_image("hda", { buffer: new TextEncoder().encode(t).buffer, format: "vmdk", files }, settings);
    await rejects(descriptor(text.replace("monolithicFlat", "vmfsSparse")), /createType vmfsSparse is not supported/, "unsupported");
    await rejects(descriptor(text.replace(/^RW /m, "NOACCESS ")), /NOACCESS/, "unsupported");
    await rejects(descriptor(text.replace(" FLAT ", " VMFSRDM ")), /VMFSRDM are not supported/, "unsupported");
    await rejects(descriptor(text.replace(" FLAT ", " BOGUS ")), /an extent line that is not understood/, "unsupported");
    await rejects(descriptor(text, {}), /"flat-flat.vmdk" is not given: name it in files/, "config");
    await rejects(descriptor(text, { "flat-flat.vmdk": { buffer: new ArrayBuffer(1 << 20) } }), /the flat extent .* past the end of its file/, "corrupt");
    // createType vmfs: a flat extent of type VMFS (ESX); a ZERO extent
    const vmfs = await descriptor('# Disk DescriptorFile\nversion=1\nCID=12345678\nparentCID=ffffffff\ncreateType="vmfs"\n' +
        'RW 65536 VMFS "base-flat.vmdk"\nRW 2048 ZERO\nRW 65536 FLAT "base-flat.vmdk" 65536\n', { "base-flat.vmdk": { url: sample_file("base.raw") } });
    assert.equal(vmfs.virtual_size, (65536 + 2048 + 65536) * 512);
    compare(await read(vmfs, 0, 65536 * 512), base.subarray(0, 65536 * 512), "a VMFS extent");
    compare(await read(vmfs, 65536 * 512, 2048 * 512), new Uint8Array(2048 * 512), "a ZERO extent");
    compare(await read(vmfs, (65536 + 2048) * 512, 65536 * 512), base.subarray(65536 * 512, 2 * 65536 * 512), "a FLAT extent at an offset");
    compare(await read(vmfs, 65536 * 512 - 4096, 8192 + 2048 * 512), Buffer.concat([base.subarray(65536 * 512 - 4096, 65536 * 512),
        new Uint8Array(2048 * 512), base.subarray(65536 * 512, 65536 * 512 + 4096)]), "a read across three extents");
    // a file named with a directory is found by its name
    const named = await descriptor(text, { "elsewhere/flat-flat.vmdk": { url: sample_file("flat-flat.vmdk") } });
    compare(await read(named, 0, 1 << 20), base.subarray(0, 1 << 20), "an extent by its name without the directory");

    const sparse = fs.readFileSync(sample_file("sparse.vmdk"));
    const sv = new DataView(sparse.buffer, sparse.byteOffset, sparse.length);
    const patched = patch => { const b = new Uint8Array(sparse); patch(new DataView(b.buffer), b); return b; };
    await rejects(open_bytes(patched(v => v.setUint32(4, 4, true)), "vmdk"), /sparse version 4 is not supported/, "unsupported");
    await rejects(open_bytes(patched(v => v.setBigUint64(20, 7n, true)), "vmdk"), /grain size 7 sectors is invalid/, "corrupt");
    await rejects(open_bytes(patched(v => v.setUint32(44, 1024, true)), "vmdk"), /1024 entries per grain table is invalid/, "corrupt");
    const gd = Number(sv.getBigUint64(56, true)) * 512;
    await rejects(open_bytes(sparse.subarray(0, gd + 4), "vmdk"), /grain directory .* past the end/, "corrupt");
    const gt = sv.getUint32(gd, true) * 512;
    const no_gt = await open_bytes(patched(v => v.setUint32(gd, (sparse.length >> 9) + 100, true)), "vmdk");
    await rejects(read(no_gt, 0, 512), /grain table at \d+ is past the end/, "corrupt");
    void gt;

    // a stream with its grain directory's place in a footer (GD_AT_END, as
    // VMware writes them; qemu-img writes it into the header): the footer
    // marker, the footer (the header with the place), the end-of-stream marker
    const qemu_stream = fs.readFileSync(sample_file("stream.vmdk"));
    const stream = new Uint8Array(qemu_stream.length + 1536);
    stream.set(qemu_stream);
    const footer = new DataView(stream.buffer, qemu_stream.length);
    footer.setBigUint64(0, 1n, true);
    footer.setUint32(12, 3, true);
    stream.set(qemu_stream.subarray(0, 512), qemu_stream.length + 512);
    new DataView(stream.buffer).setBigUint64(56, 0xFFFFFFFFFFFFFFFFn, true);
    const with_footer = await open_bytes(stream, "vmdk");
    for(let offset = 0; offset < base.length; offset += 4 << 20)
    {
        compare(await read(with_footer, offset, 1 << 20), base.subarray(offset, offset + (1 << 20)), "GD_AT_END at " + offset);
    }
    const streamed = patch => { const b = new Uint8Array(stream); patch(b); return b; };
    await rejects(open_bytes(streamed(b => { b[b.length - 1536 + 12] = 7; }), "vmdk"), /the stream's footer is invalid/, "corrupt");
    await rejects(open_bytes(streamed(b => { b[b.length - 512 + 12] = 1; }), "vmdk"), /the stream's footer is invalid/, "corrupt");
    // the first compressed grain: its data damaged, its checksum wrong
    const stv = new DataView(stream.buffer, stream.byteOffset, stream.length);
    const footer_gd = Number(stv.getBigUint64(stream.length - 1024 + 56, true)) * 512;
    const first_gt = stv.getUint32(footer_gd, true) * 512;
    let grain = 0;
    while(!stv.getUint32(first_gt + grain * 4, true)) grain++;
    const marker = stv.getUint32(first_gt + grain * 4, true) * 512;
    const size = stv.getUint32(marker + 8, true);
    const bad_sum = await open_bytes(streamed(b => { b[marker + 12 + size - 1] ^= 0xFF; }), "vmdk");
    await rejects(read(bad_sum, grain * 65536, 512), /wrong Adler-32 checksum|is not zlib data|invalid/, "corrupt");
    const bad_size = await open_bytes(streamed(b => new DataView(b.buffer).setUint32(marker + 8, 1 << 30, true)), "vmdk");
    await rejects(read(bad_size, grain * 65536, 512), /grain marker .* has the size/, "corrupt");
    compare(await read(bad_sum, (grain + 32) * 65536, 65536), base.subarray((grain + 32) * 65536, (grain + 33) * 65536), "the other grains");
    console.log("ok - VMDK: damaged descriptors, sparse headers, tables, streams and grains: refused with what is wrong");
}

// OVA: an OVF descriptor and the streamOptimized disk in a TAR archive
const ovf = `<?xml version="1.0" encoding="UTF-8"?>
<!-- a VMware-like descriptor -->
<Envelope vmw:buildId="build-1" xmlns="http://schemas.dmtf.org/ovf/envelope/1" xmlns:ovf="http://schemas.dmtf.org/ovf/envelope/1"
    xmlns:rasd="http://schemas.dmtf.org/wbem/wscim/1/cim-schema/2/CIM_ResourceAllocationSettingData" xmlns:vmw="http://www.vmware.com/schema/ovf"
    xmlns:vssd="http://schemas.dmtf.org/wbem/wscim/1/cim-schema/2/CIM_VirtualSystemSettingData">
  <References>
    <File ovf:href="disk1.vmdk" ovf:id="file1" ovf:size="${fs.statSync(sample_file("stream.vmdk")).size}"/>
    <File ovf:href="missing.vmdk" ovf:id="file2"/>
  </References>
  <DiskSection>
    <Info>Virtual disk information</Info>
    <Disk ovf:capacity="64" ovf:capacityAllocationUnits="byte * 2^20" ovf:diskId="vmdisk1" ovf:fileRef="file1"
        ovf:format="http://www.vmware.com/interfaces/specifications/vmdk.html#streamOptimized"/>
    <Disk ovf:capacity="1" ovf:capacityAllocationUnits="byte * 2^30" ovf:diskId="vmdisk2" ovf:fileRef="file2"
        ovf:format="http://www.vmware.com/interfaces/specifications/vmdk.html#streamOptimized"/>
  </DiskSection>
  <VirtualSystem ovf:id="dos">
    <Info>A virtual machine &amp; its hardware</Info>
    <OperatingSystemSection ovf:id="1" vmw:osType="dosGuest"><Info>The guest</Info><Description>MS-DOS</Description></OperatingSystemSection>
    <VirtualHardwareSection>
      <Info>Virtual hardware requirements</Info>
      <Item><rasd:InstanceID>1</rasd:InstanceID><rasd:ResourceType>3</rasd:ResourceType><rasd:VirtualQuantity>2</rasd:VirtualQuantity></Item>
      <Item><rasd:AllocationUnits>byte * 2^20</rasd:AllocationUnits><rasd:InstanceID>2</rasd:InstanceID><rasd:ResourceType>4</rasd:ResourceType><rasd:VirtualQuantity>32</rasd:VirtualQuantity></Item>
      <Item><rasd:ElementName>IDE 0</rasd:ElementName><rasd:InstanceID>3</rasd:InstanceID><rasd:ResourceType>5</rasd:ResourceType></Item>
      <Item><rasd:ElementName>SCSI controller 0</rasd:ElementName><rasd:InstanceID>4</rasd:InstanceID><rasd:ResourceSubType>lsilogic</rasd:ResourceSubType><rasd:ResourceType>6</rasd:ResourceType></Item>
      <Item><rasd:HostResource>ovf:/disk/vmdisk1</rasd:HostResource><rasd:InstanceID>5</rasd:InstanceID><rasd:Parent>3</rasd:Parent><rasd:ResourceType>17</rasd:ResourceType></Item>
      <Item><rasd:HostResource>ovf:/disk/vmdisk2</rasd:HostResource><rasd:InstanceID>6</rasd:InstanceID><rasd:Parent>4</rasd:Parent><rasd:ResourceType>17</rasd:ResourceType></Item>
      <Item><rasd:ElementName>Ethernet 1</rasd:ElementName><rasd:InstanceID>7</rasd:InstanceID><rasd:ResourceSubType>E1000</rasd:ResourceSubType><rasd:ResourceType>10</rasd:ResourceType></Item>
      <vmw:Config ovf:required="false" vmw:key="firmware" vmw:value="efi"/>
    </VirtualHardwareSection>
  </VirtualSystem>
</Envelope>
`;
const ova_dir = path.join(SAMPLES_DIR, "ova");
fs.mkdirSync(ova_dir, { recursive: true });
fs.writeFileSync(path.join(ova_dir, "dos.ovf"), ovf);
fs.copyFileSync(sample_file("stream.vmdk"), path.join(ova_dir, "disk1.vmdk"));
for(const format of ["ustar", "pax"])
{
    const ova = path.join(SAMPLES_DIR, "dos-" + format + ".ova");
    execFileSync("tar", ["-cf", ova, "--format", format, "-C", ova_dir, "dos.ovf", "disk1.vmdk"]);
    const result = await import_ova({ url: ova, async: true }, settings);
    assert.deepEqual(result.files, ["dos.ovf", "disk1.vmdk"], format + ": the archive's files");
    assert.equal(result.disks.length, 2);
    assert.equal(result.disks[0].controller, "ide");
    assert.equal(result.disks[0].capacity, 64 << 20);
    assert.equal(result.disks[1].descriptor, null, "the disk whose file is not in the archive");
    assert.equal(result.options.memory_size, 32 << 20);
    assert.equal(result.options.cpu_cores, 2);
    assert.deepEqual(result.options.hda, { url: ova, buffer: undefined, async: true, size: undefined, archive_member: "disk1.vmdk", format: "vmdk" });
    for(const note of [/missing\.vmdk is not in the archive/, /SCSI controller scsi \(lsilogic\)/, /E1000/, /EFI/, /MS-DOS/])
    {
        assert.ok(result.notes.some(n => note.test(n)), format + ": a note " + note + " in " + JSON.stringify(result.notes));
    }
    const disk = await open_image("hda", result.options.hda, settings);
    for(let offset = 0; offset < base.length; offset += 1 << 20)
    {
        compare(await read(disk, offset, 1 << 20), base.subarray(offset, offset + (1 << 20)), format + " OVA disk at " + offset);
    }
    const from_memory = await open_image("hda", { buffer: new Uint8Array(fs.readFileSync(ova)).buffer, archive_member: "disk1.vmdk", format: "auto" }, settings);
    compare(await read(from_memory, 0, 1 << 20), base.subarray(0, 1 << 20), "from memory");
    await rejects(open_image("hda", { url: ova, archive_member: "nothing.vmdk", format: "vmdk" }, settings), /has no file "nothing.vmdk"/, "config");
    console.log("ok - OVA (" + format + "): the OVF's disks and hardware, notes; the disk read in the archive as qemu-img reads the VMDK");
}
{
    // OVF details: units, an OVF without disks, damaged XML, VirtualBox's EFI
    assert.throws(() => parse_xml("<a><b></a>"), /closes a where b is open/);
    assert.throws(() => read_ovf("<x/>"), /no Envelope/);
    const vbox = read_ovf(`<Envelope><DiskSection/><VirtualSystem><VirtualHardwareSection>
        <Item><ResourceType>4</ResourceType><VirtualQuantity>2</VirtualQuantity><AllocationUnits>GigaBytes</AllocationUnits></Item>
        </VirtualHardwareSection><vbox:Machine><Hardware><Firmware type="EFI"/></Hardware></vbox:Machine></VirtualSystem></Envelope>`);
    assert.equal(vbox.options.memory_size, 2 * 1024 ** 3);
    assert.ok(vbox.notes.some(n => /EFI/.test(n)));
    console.log("ok - OVF: allocation units, VirtualBox's firmware, damaged XML");
}
console.log("VMDK and OVA tests passed (" + (compared >> 20) + " MiB compared)");
