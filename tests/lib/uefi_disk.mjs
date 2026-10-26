// A GPT disk with an EFI System Partition that boots Alpine 3.24 x86_64
// under UEFI from the disk alone (docs/uefi.md; the plan's F1, GPT/ESP cold
// boot): the pinned virt ISO's tree (tests/lib/alpine_image.mjs) on a FAT32
// ESP. Its GRUB (efi/boot/bootx64.efi, what the boot manager starts from a
// disk without boot entries) searches for the ISO's volume label, finds none,
// and reads /boot/grub/grub.cfg of the ESP it was loaded from: here, with the
// serial console. Alpine's initramfs then finds its packages and modloop on
// the ESP, as on a USB stick. hdiutil (macOS) makes the FAT32 volume.

import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { prepare as prepare_alpine, ROOT } from "./alpine_image.mjs";
import { gpt_writes } from "../../src/android/gpt.js";

export const ESP_TYPE = "C12A7328-F81F-11D2-BA4B-00A0C93EC93B";
const MiB = 1 << 20;
const VOLUME_SIZE = 128 * MiB;

const GRUB_CFG = `set timeout=1
menuentry "Alpine virt (UEFI, from the ESP)" {
linux /boot/vmlinuz-virt console=ttyS0,115200 loglevel=4 modules=loop,squashfs,sd-mod,vfat,nls_cp437,nls_iso8859-1
initrd /boot/initramfs-virt
}
`;

function run(program, args)
{
    const result = spawnSync(program, args, { encoding: "utf8" });
    if(result.status !== 0) throw new Error(program + " " + args.join(" ") + ": " + (result.stderr || result.error));
}

/**
 * The disk (built once, in build/uefi/): its path
 * @return {Promise<string>}
 */
export async function prepare_esp_disk()
{
    const directory = ROOT + "build/uefi/";
    const disk = directory + "alpine-esp.img";
    if(fs.existsSync(disk)) return disk;
    const alpine = await prepare_alpine("x86_64-virt");
    fs.mkdirSync(directory, { recursive: true });

    const tree = directory + "esp/";
    fs.rmSync(tree, { recursive: true, force: true });
    fs.mkdirSync(tree);
    run("bsdtar", ["-xf", alpine.iso, "-C", tree]);
    run("chmod", ["-R", "u+w", tree]);
    // (BIOS boot, and the CD's El Torito image of the loader)
    fs.rmSync(tree + "boot/syslinux", { recursive: true });
    fs.rmSync(tree + "boot/grub/efi.img");
    fs.writeFileSync(tree + "boot/grub/grub.cfg", GRUB_CFG);

    run("hdiutil", ["create", "-quiet", "-size", VOLUME_SIZE / MiB + "m", "-fs", "MS-DOS FAT32", "-volname", "ALPINE", "-srcfolder", tree,
        "-format", "UDTO", "-layout", "NONE", "-ov", directory + "esp-volume"]);
    const volume = fs.readFileSync(directory + "esp-volume.cdr");
    fs.rmSync(directory + "esp-volume.cdr");
    fs.rmSync(tree, { recursive: true });

    const disk_size = MiB + volume.length + MiB;
    const bytes = Buffer.alloc(disk_size);
    for(const { offset, bytes: write } of gpt_writes(disk_size, [{ name: "ESP", start: MiB, size: volume.length, type: ESP_TYPE }]))
    {
        bytes.set(write, offset);
    }
    bytes.set(volume, MiB);
    fs.writeFileSync(disk + ".part", bytes);
    fs.renameSync(disk + ".part", disk);
    return disk;
}
