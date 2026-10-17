#!/usr/bin/env node
// Linux kernels of other configurations for the ARM core
// (docs/arm64-virt-android16-plan.md P8.6: the 16 and 64 KiB page kernels;
// P9.1, P9.2: the androidish kernel, with binder, and the test programs
// built against its headers):
// linux-6.18.35, the stock kernel's release (its tarball's sha256 pinned),
// with the virt ISO's own config-6.18.35-0-virt and one fragment per
// variant on top (the drivers the Alpine stages need built in, no debug
// information, no module signing; the variant's page size). They are built
// natively in an Alpine 3.24 aarch64 VM (Homebrew QEMU with HVF: macOS lacks
// the kernel's host tools), with Alpine's GCC from the local repository of
// `node tools/alpine_repo.mjs --arch aarch64 --set kbuild`; the VM gets the
// ISO, that repository, the source and a script on virtio-blk disks found
// by their serials, builds on an ext4 scratch disk, and writes the Images
// and configs as a tar to an output disk.
//
// Writes build/a64-kernel/<variant>/Image and config, and
// build/a64-kernel/manifest.json (the hashes of the source, the base config,
// the fragments and the results, the toolchain). tests/a64/linux_boot.mjs
// boots them with A64_KERNEL=<variant>. For androidish also the images its
// P9.2 tests use, made in the VM with Alpine's tools: policy.33 (the binary
// of tests/a64/minimal.cil, by tests/a64/cil2bin.c and libsepol: Alpine has
// no checkpolicy), erofs.img (mkfs.erofs) and f2fs.img.gz (mkfs.f2fs with
// the encrypt feature, 64 MiB, compressed).
//
//   node tools/a64_kernel.mjs [--variants 16k,64k] [--programs-only]
//   (--programs-only: the configs, the programs and the images again, the Images kept)
//   (QEMU_HVF: a qemu-system-aarch64 with hvf, default /opt/homebrew/bin's; A64_KBUILD_CPUS its vCPUs, 8;
//   the source tarball in build/a64-kernel/dl/, from cdn.kernel.org)
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createHash as create_hash } from "node:crypto";
import { prepare, ROOT } from "../tests/lib/alpine_image.mjs";
import { KBUILD_PACKAGES } from "./alpine_repo.mjs";

const VERSION = "6.18.35";
const SOURCE = ROOT + `build/a64-kernel/dl/linux-${VERSION}.tar.xz`;
/** cdn.kernel.org's sha256sums.asc for linux-6.18.35.tar.xz */
const SOURCE_SHA256 = "f78602932219125e211c5f5bfd84edcfd4ec5ce88fc944f8248413f665bef236";
const OUT = ROOT + "build/a64-kernel/";
const REPO = ROOT + "build/a64-linux/kbuild-repo.tar";
const QEMU = process.env.QEMU_HVF || "/opt/homebrew/bin/qemu-system-aarch64";

/** Every variant: what the Alpine stages need built in (the stock kernel's
 * modules are for its own build), no debug information. No module is built
 * (only the Image): module signing stays as the stock config has it, with a
 * throwaway key instead of Alpine's (the stock config names its builder's) */
const COMMON = [
    "CONFIG_DEBUG_INFO_NONE=y",
    "# CONFIG_DEBUG_INFO_DWARF_TOOLCHAIN_DEFAULT is not set",
    "# CONFIG_DEBUG_INFO_BTF is not set",
    'CONFIG_MODULE_SIG_KEY="certs/signing_key.pem"',
    "# CONFIG_LOCALVERSION_AUTO is not set",
    "CONFIG_VIRTIO_MMIO=y",
    "CONFIG_VIRTIO_BLK=y",
    "CONFIG_VIRTIO_NET=y",
    "CONFIG_VIRTIO_INPUT=y",
    "CONFIG_HW_RANDOM=y",
    "CONFIG_HW_RANDOM_VIRTIO=y",
    "CONFIG_BLK_DEV_LOOP=y",
    "CONFIG_SQUASHFS=y",
    "CONFIG_ISO9660_FS=y",
    "CONFIG_EXT4_FS=y",
    "CONFIG_INPUT_EVDEV=y",
    "CONFIG_PACKET=y",
];
export const VARIANTS = {
    "16k": ["CONFIG_ARM64_16K_PAGES=y", "# CONFIG_ARM64_4K_PAGES is not set", "# CONFIG_ARM64_64K_PAGES is not set",
        'CONFIG_LOCALVERSION="-v86-16k"'],
    "64k": ["CONFIG_ARM64_64K_PAGES=y", "# CONFIG_ARM64_4K_PAGES is not set", "# CONFIG_ARM64_16K_PAGES is not set",
        'CONFIG_LOCALVERSION="-v86-64k"'],
    // (P9.1, P9.2) what Android needs of the kernel, in GKI's shape: binder
    // (binderfs), SELinux, userfaultfd, bootconfig, dm-verity, erofs, f2fs
    // with fscrypt, zram, PSI; a 39-bit VA, PAN emulated by switching TTBR0
    // (the profile has no PAN), pseudo-NMIs (irqchip.gicv3_pseudo_nmi=1),
    // KASLR without a seed
    "androidish": [
        "CONFIG_ANDROID_BINDER_IPC=y", "CONFIG_ANDROID_BINDERFS=y", 'CONFIG_ANDROID_BINDER_DEVICES=""',
        "CONFIG_SECURITY_SELINUX=y", "CONFIG_SECURITY_SELINUX_DEVELOP=y",
        'CONFIG_LSM="landlock,lockdown,yama,loadpin,safesetid,selinux,integrity"',
        "CONFIG_USERFAULTFD=y", "CONFIG_BOOT_CONFIG=y",
        "CONFIG_BLK_DEV_DM=y", "CONFIG_DM_VERITY=y", "CONFIG_EROFS_FS=y", "CONFIG_F2FS_FS=y", "CONFIG_FS_ENCRYPTION=y",
        "CONFIG_ZRAM=y", "CONFIG_PSI=y", "# CONFIG_PSI_DEFAULT_DISABLED is not set",
        "CONFIG_ARM64_VA_BITS_39=y", "# CONFIG_ARM64_VA_BITS_48 is not set",
        "CONFIG_ARM64_SW_TTBR0_PAN=y", "CONFIG_ARM64_PSEUDO_NMI=y", "CONFIG_RANDOMIZE_BASE=y",
        'CONFIG_LOCALVERSION="-v86-androidish"',
    ],
};
/** Test programs built with a variant, against its UAPI headers (static, musl): the binderfs selftest, P9.1's ping-pong,
 * P9.2's userfaultfd, SELinux, dm-verity, fscrypt and PSI programs */
const PROGRAMS = {
    "androidish": ["binderfs_test", "binder_pingpong", "uffd_test", "selinux_load", "dm_verity", "fscrypt_test", "psi_test"],
};
/** The images made for a variant (P9.2) */
const IMAGES = {
    "androidish": ["policy.33", "erofs.img", "f2fs.img.gz"],
};
/** What each variant's resulting .config must hold */
const EXPECT = {
    "16k": ["CONFIG_ARM64_16K_PAGES=y"],
    "64k": ["CONFIG_ARM64_64K_PAGES=y"],
    "androidish": ["CONFIG_ANDROID_BINDER_IPC=y", "CONFIG_ANDROID_BINDERFS=y", "CONFIG_SECURITY_SELINUX=y", "CONFIG_USERFAULTFD=y",
        "CONFIG_BOOT_CONFIG=y", "CONFIG_DM_VERITY=y", "CONFIG_EROFS_FS=y", "CONFIG_F2FS_FS=y", "CONFIG_FS_ENCRYPTION=y",
        "CONFIG_ZRAM=y", "CONFIG_PSI=y", "# CONFIG_PSI_DEFAULT_DISABLED is not set",
        "CONFIG_ARM64_VA_BITS_39=y", "CONFIG_ARM64_SW_TTBR0_PAN=y", "CONFIG_ARM64_PSEUDO_NMI=y", "CONFIG_RANDOMIZE_BASE=y"],
};

const EROFS_UUID = "a64e0f5a-0092-4000-8000-000000000001";

const sha256 = bytes => create_hash("sha256").update(bytes).digest("hex");

function check(result, what)
{
    if(result.status !== 0) throw new Error(what + ": " + (result.stderr || result.error));
    return result.stdout;
}

/** The script the VM runs (/work/build.sh): the toolchain, the scratch disk, each variant */
function build_script(variants)
{
    return `#!/bin/sh
set -e
disk() { for d in /sys/block/vd*; do [ "$(cat $d/serial 2>/dev/null)" = "$1" ] && echo /dev/\${d##*/}; done; return 0; }
echo A64_KERNEL_STEP toolchain
mkdir -p /mnt/repo && tar -xf $(disk a64krepo) -C /mnt/repo
apk add --no-network --quiet --repository /mnt/repo/main --repository /mnt/repo/community ${KBUILD_PACKAGES.join(" ")}
mkfs.ext4 -q -F $(disk a64kscratch)
modprobe ext4
mkdir -p /build && mount -t ext4 $(disk a64kscratch) /build
echo A64_KERNEL_STEP unpack
tar -xJf /work/linux-${VERSION}.tar.xz -C /build
cd /build/linux-${VERSION}
for v in ${variants.join(" ")}; do
    echo A64_KERNEL_STEP config $v
    mkdir -p /build/o-$v
    # (later assignments override: kconfig takes the fragments after the base)
    cat /work/config-base /work/fragment-common /work/fragment-$v > /build/o-$v/.config
    make -s O=/build/o-$v olddefconfig 2>&1 | grep -v "override: reassigning\\|^\\.config:[0-9]*:warning: override" || true
    mkdir -p /build/result/$v
    if [ ! -f /work/programs-only ]; then
        echo A64_KERNEL_STEP build $v
        make -s O=/build/o-$v -j$(nproc) Image
        cp /build/o-$v/arch/arm64/boot/Image /build/result/$v/
    fi
    cp /build/o-$v/.config /build/result/$v/
    if [ -f /work/programs-$v ]; then
        echo A64_KERNEL_STEP programs $v
        make -s O=/build/o-$v headers
        H="-isystem /build/o-$v/usr/include"
        for p in $(cat /work/programs-$v); do
            case $p in
            # (the harness's 30 s per test is too short for binderfs_stress with 4 GiB of RAM, 3 of it extended: 300 s)
            binderfs_test) sed -i 's/^#define TEST_TIMEOUT_DEFAULT 30$/#define TEST_TIMEOUT_DEFAULT 300/' tools/testing/selftests/kselftest_harness.h
                grep -q '^#define TEST_TIMEOUT_DEFAULT 300$' tools/testing/selftests/kselftest_harness.h
                gcc -static -O2 $H -I tools/testing/selftests -o /build/result/$v/$p \
                tools/testing/selftests/filesystems/binderfs/binderfs_test.c -lpthread ;;
            *) gcc -static -O2 -Wall $H -o /build/result/$v/$p /work/$p.c -lpthread ;;
            esac
        done
    fi
    if [ -f /work/images-$v ]; then
        echo A64_KERNEL_STEP images $v
        # (the SELinux policy, version 33; the erofs image's files, its time and UUID fixed; f2fs with encryption)
        gcc -O2 -Wall -o /build/cil2bin /work/cil2bin.c -lsepol
        /build/cil2bin /work/minimal.cil /build/result/$v/policy.33 33
        rm -rf /build/erofs-root && mkdir -p /build/erofs-root
        seq 1 40000 > /build/erofs-root/payload.txt
        echo A64_EROFS_HELLO > /build/erofs-root/hello.txt
        mkfs.erofs --quiet -T0 -U ${EROFS_UUID} --all-root /build/result/$v/erofs.img /build/erofs-root
        rm -f /build/f2fs.img && truncate -s 64M /build/f2fs.img
        mkfs.f2fs -q -f -O encrypt -l a64f2fs /build/f2fs.img
        gzip -9 -c /build/f2fs.img > /build/result/$v/f2fs.img.gz
    fi
done
{ gcc --version | head -1; ld --version | head -1; } > /build/result/toolchain
tar -cf $(disk a64kout) -C /build/result .
sync
`;
}

export async function build(variants, programs_only = false)
{
    for(const v of variants) if(!VARIANTS[v]) throw new Error("no variant " + v);
    if(!fs.existsSync(SOURCE)) throw new Error(SOURCE + " is missing (cdn.kernel.org's linux-" + VERSION + ".tar.xz)");
    const source = fs.readFileSync(SOURCE);
    if(sha256(source) !== SOURCE_SHA256) throw new Error(SOURCE + ": not the pinned sha256");
    if(!fs.existsSync(REPO)) throw new Error(REPO + " is missing: node tools/alpine_repo.mjs --arch aarch64 --set kbuild");
    const config_name = `boot/config-${VERSION}-0-virt`;
    const prepared = await prepare("aarch64-virt", ["boot/vmlinuz-virt", "boot/initramfs-virt", "boot/modloop-virt", config_name]);
    const base_config = fs.readFileSync(prepared.directory + config_name);

    // the work disk: the source, the base config, the fragments, the script
    const work = OUT + "work/";
    fs.rmSync(work, { recursive: true, force: true });
    fs.mkdirSync(work, { recursive: true });
    fs.symlinkSync(SOURCE, work + `linux-${VERSION}.tar.xz`);
    fs.writeFileSync(work + "config-base", base_config);
    fs.writeFileSync(work + "fragment-common", COMMON.join("\n") + "\n");
    for(const v of variants)
    {
        fs.writeFileSync(work + "fragment-" + v, VARIANTS[v].join("\n") + "\n");
        if(!PROGRAMS[v]) continue;
        fs.writeFileSync(work + "programs-" + v, PROGRAMS[v].join("\n") + "\n");
        for(const p of PROGRAMS[v]) if(fs.existsSync(ROOT + `tests/a64/${p}.c`)) fs.copyFileSync(ROOT + `tests/a64/${p}.c`, work + p + ".c");
        if(!IMAGES[v]) continue;
        fs.writeFileSync(work + "images-" + v, IMAGES[v].join("\n") + "\n");
        for(const file of ["cil2bin.c", "minimal.cil"]) fs.copyFileSync(ROOT + "tests/a64/" + file, work + file);
    }
    fs.writeFileSync(work + "build.sh", build_script(variants));
    if(programs_only) fs.writeFileSync(work + "programs-only", "");
    const work_tar = OUT + "work.tar";
    check(spawnSync("bsdtar", ["--format", "ustar", "-L", "--no-xattrs", "--no-mac-metadata", "--uid", "0", "--gid", "0",
        "-cf", work_tar, "-C", work, "."], { encoding: "utf8" }), "bsdtar (work)");
    const scratch = OUT + "scratch.raw", output = OUT + "out.raw";
    for(const [file, size] of [[scratch, 16 * 2 ** 30], [output, 512 * 2 ** 20]])
    {
        fs.rmSync(file, { force: true });
        fs.closeSync(fs.openSync(file, "w"));
        fs.truncateSync(file, size);
    }

    const disk = (file, serial, readonly) => ["-drive", `file=${file},if=none,id=${serial},format=raw${readonly ? ",readonly=on" : ""}`,
        "-device", `virtio-blk-pci,drive=${serial}${serial === "iso" ? "" : ",serial=" + serial}`];
    // (A64_KBUILD_CPUS: fewer vCPUs while other tests run)
    const args = ["-machine", "virt,highmem=on", "-accel", "hvf", "-cpu", "host", "-smp", process.env.A64_KBUILD_CPUS || "8", "-m", "6144",
        "-kernel", prepared.directory + "boot/vmlinuz-virt", "-initrd", prepared.directory + "boot/initramfs-virt",
        "-append", "console=ttyAMA0 modules=loop,squashfs,sd-mod,usb-storage",
        ...disk(prepared.iso, "iso", true), ...disk(REPO, "a64krepo", true), ...disk(work_tar, "a64kwork", true),
        ...disk(scratch, "a64kscratch", false), ...disk(output, "a64kout", false),
        "-nic", "none", "-display", "none", "-serial", "stdio", "-monitor", "none", "-no-reboot"];
    const log = fs.openSync(OUT + "build.log", "w");
    const started = performance.now();
    const qemu = spawn(QEMU, args, { stdio: ["pipe", "pipe", "pipe"] });
    let transcript = "";
    qemu.stdout.on("data", data => {
        const text = data.toString("latin1");
        transcript += text;
        fs.writeSync(log, text);
        for(const step of text.match(/A64_KERNEL_STEP [^\r\n]*/g) || [])
        {
            console.log(`${((performance.now() - started) / 1000).toFixed(0)} s: ${step.slice(16)}`);
        }
    });
    qemu.stderr.on("data", data => fs.writeSync(log, data.toString("latin1")));
    const exited = new Promise(resolve => qemu.on("exit", code => resolve(code)));
    const wait = (pattern, what, ms) => new Promise((resolve, reject) => {
        const from = transcript.length;
        const timer = setTimeout(() => { clearInterval(poll); reject(new Error(`no ${what} after ${ms} ms (build/a64-kernel/build.log)`)); }, ms);
        const poll = setInterval(() => {
            const match = transcript.slice(from).match(pattern);
            if(match)
            {
                clearInterval(poll);
                clearTimeout(timer);
                resolve(match);
            }
        }, 100);
    });
    try
    {
        await wait(/login: ?$/m, "login prompt", 300000);
        qemu.stdin.write("root\n");
        await wait(/# ?(\x1b\[[0-9;]*[A-Za-z])*$/m, "shell", 60000);
        qemu.stdin.write("W=; for d in /sys/block/vd*; do [ \"$(cat $d/serial 2>/dev/null)\" = a64kwork ] && W=/dev/${d##*/}; done; " +
            "mkdir -p /work && tar -xf $W -C /work && sh /work/build.sh; echo A64_KERNEL_EXIT=$?\n");
        const [, status] = await wait(/A64_KERNEL_EXIT=(\d+)/, "build's end", 3 * 3600000);
        if(status !== "0") throw new Error("the build failed (exit " + status + ", build/a64-kernel/build.log)");
        qemu.stdin.write("poweroff\n");
        await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 60000))]);
    }
    finally
    {
        qemu.kill("SIGKILL");
        fs.closeSync(log);
    }

    // the results, checked
    const result = OUT + "result/";
    fs.rmSync(result, { recursive: true, force: true });
    fs.mkdirSync(result, { recursive: true });
    check(spawnSync("bsdtar", ["-xf", output, "-C", result], { encoding: "utf8" }), "bsdtar (result)");
    const manifest = {
        source: { file: path.basename(SOURCE), sha256: SOURCE_SHA256 },
        base_config: { file: path.basename(config_name), sha256: sha256(base_config) },
        fragment_common: { sha256: sha256(COMMON.join("\n") + "\n") },
        toolchain: fs.readFileSync(result + "toolchain", "utf8").trim().split("\n"),
        [programs_only ? "programs_seconds" : "build_seconds"]: Math.round((performance.now() - started) / 1000),
        variants: {},
    };
    for(const v of variants)
    {
        const config = fs.readFileSync(result + v + "/.config", "utf8");
        for(const line of [...EXPECT[v], ...COMMON.filter(l => l.endsWith("=y"))])
        {
            if(!config.split("\n").includes(line)) throw new Error(`${v}: the built config lacks ${line}`);
        }
        fs.mkdirSync(OUT + v, { recursive: true });
        // (--programs-only: the Image built before, with this config)
        if(programs_only && fs.readFileSync(OUT + v + "/config", "utf8") !== config) throw new Error(v + ": the config changed, build the Image");
        const image = programs_only ? fs.readFileSync(OUT + v + "/Image") : fs.readFileSync(result + v + "/Image");
        fs.writeFileSync(OUT + v + "/Image", image);
        fs.writeFileSync(OUT + v + "/config", config);
        manifest.variants[v] = { fragment_sha256: sha256(VARIANTS[v].join("\n") + "\n"), image_sha256: sha256(image),
            image_bytes: image.length, config_sha256: sha256(config) };
        for(const p of PROGRAMS[v] || [])
        {
            const program = fs.readFileSync(result + v + "/" + p);
            fs.writeFileSync(OUT + v + "/" + p, program, { mode: 0o755 });
            (manifest.variants[v].programs ||= {})[p] = sha256(program);
        }
        for(const file of IMAGES[v] || [])
        {
            const bytes = fs.readFileSync(result + v + "/" + file);
            fs.writeFileSync(OUT + v + "/" + file, bytes);
            (manifest.variants[v].images ||= {})[file] = sha256(bytes);
        }
    }
    // (the scratch disk is 16 GiB, sparse: dropped)
    fs.rmSync(scratch, { force: true });
    const manifest_file = OUT + "manifest.json";
    const previous = fs.existsSync(manifest_file) ? JSON.parse(fs.readFileSync(manifest_file, "utf8")) : {};
    const merged = { ...previous, ...manifest, variants: { ...(previous.variants || {}), ...manifest.variants } };
    fs.writeFileSync(manifest_file, JSON.stringify(merged, null, 2) + "\n");
    return merged;
}

if(process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname)
{
    const args = process.argv.slice(2);
    const i = args.indexOf("--variants");
    const variants = (i >= 0 ? args[i + 1] : "16k,64k").split(",");
    const manifest = await build(variants, args.includes("--programs-only"));
    console.log(JSON.stringify(manifest, null, 2));
}
