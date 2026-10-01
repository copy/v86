#!/usr/bin/env bash
# Downloads all small/flat OS images from i.copy.sh to the images/ directory.
# Large chunked images (use_parts: true) are NOT downloaded - they are proxied
# by server.js to i.copy.sh at runtime.
set -euo pipefail

CDN="https://i.copy.sh"
OUT="$(dirname "$0")/images"
BIOSOUT="$(dirname "$0")/bios"
mkdir -p "$OUT" "$BIOSOUT"

download() {
    local name="$1"
    local dest="$OUT/$name"
    if [ -f "$dest" ]; then
        echo "  [skip] $name (already exists)"
        return
    fi
    echo "  [download] $name"
    curl -fsSL --retry 3 --retry-delay 2 -o "$dest" "$CDN/$name" || {
        echo "  [WARN] Failed to download $name" >&2
        rm -f "$dest"
    }
}

download_bios() {
    # Download a BIOS/firmware file to the bios/ directory from a direct URL.
    # Usage: download_bios <filename> <url>
    local name="$1"
    local url="$2"
    local dest="$BIOSOUT/$name"
    if [ -f "$dest" ]; then
        echo "  [skip] bios/$name (already exists)"
        return
    fi
    echo "  [download] bios/$name"
    curl -fsSL --retry 3 --retry-delay 2 -o "$dest" "$url" || {
        echo "  [WARN] Failed to download bios/$name" >&2
        rm -f "$dest"
    }
}

echo "=== Downloading flat OS images to images/ ==="

# Linux / BSD kernels and small images
download "buildroot-bzimage.bin"
download "buildroot-bzimage68.bin"
download "nodeos-kernel.bin"
download "linux.iso"
download "linux3.iso"
download "linux4.iso"
download "elks-hd32-fat.img"
download "bl3-5.img"
download "dsl-4.11.rc2.iso"
download "xpud-0.9.2.iso"
download "xwoaf_rebuild4.iso"
download "TinyCore-11.0.iso"
download "slitaz-rolling-2024.iso"
download "FreeNOS-1.0.3.iso"

# Arch Linux state (small zst state snapshot)
download "arch_state-v3.bin.zst"

# FreeBSD/BSD state files
download "freebsd_state-v2.bin.zst"
download "openbsd_state-v2.bin.zst"
download "bsdos43_state.bin"

# BSD small images
download "9legacy.img"
download "crazierl-elf-2026.img"
download "crazierl-initrd-2026.img"
download "mobius-fd-release5.img"

# DOS images
download "freedos722.img"
download "msdos4.img"
# msdos622 is chunked (directory of parts) — proxied at runtime, skip
download "pc86dos.img"
download "ibm-exploring.img"
download "PCMOS386-9-user-patched.img"
download "doof-1440.img"
download "xcom144.img"
# freegem is chunked — proxied at runtime, skip

# Windows small images
download "windows101.img"
download "windows2.img"
download "Win30.iso"
download "windows30.img"
download "win31.img"

# Windows state files (small)
download "windows98_state-v2.bin.zst"
download "windows-me_state-v3.bin.zst"
download "windows2k_state-v4.bin.zst"
download "serenity_state-v4.bin.zst"
download "redox_state-v2.bin.zst"
download "haiku_state-v5.bin.zst"
download "reactos_state-v3.bin.zst"
download "arch_state-v3.bin.zst"
download "9front_state-v3.bin.zst"

# ReactOS, SerenityOS, Redox, Haiku state files already done above

# Hobby OSes - small ISOs and images
download "HelenOS-0.14.1-ia32.iso"
download "HelenOS-0.11.2-ia32.iso"
download "sortix-1.0-i686.iso"
download "skift-20200910.iso"
download "kolibri.img"
download "oberon.img"
download "mu-shell.img"
download "os8.img"
download "tilck.img"
download "gentleos16-fd1440.img"
download "gentleos32-disk.img"
download "duskos.img"
download "sanos-flp.img"
download "littlekernel-multiboot.img"
download "quantixos.iso"
download "chip4504.img"
download "chimaeraos.img"
download "forthos20.img.zst"
download "curios.img"
download "os64boot.iso"
download "ipxe.iso"
download "netboot.xyz.iso"
download "SqueakNOS.iso"
download "soso.iso"
download "nanoshell.iso"
download "toaruos-1.6.1-core.iso"
download "nopeos-0.1.iso"
download "catkernel.iso"
download "dancy.iso"
download "BoneOS.iso"
download "bleskos_2024u32.iso"
download "mikeos.iso"
download "asuro.iso"
download "mojo-0.2.2.iso"
download "vanadiumos.iso"
download "prettyos.img"
download "xenushdd.img"
download "hOp-0.8.img"
download "jx-demo.img"
download "bj050.img"
download "t3xforth.img"
download "mcp2.img"
download "leetos.img"
download "newos-flp.img"
download "newos-notion.img"
download "snowdrop.img"
download "openwrt-18.06.1-x86-legacy-combined-squashfs.img"
download "qnx-demo-network-4.05.img"

# Bootsector games and demos
download "bootchess.img"
download "bootbasic.img"
download "bootlogo.img"
download "pillman.img"
download "invaders.img"
download "bootos-all.img"
download "sectorlisp-friendly.bin"
download "sectorforth.img"
download "floppybird.img"
download "stillalive-os.img"
download "hello-v86.img"
download "tetros.img"
download "bootdino.img"
download "bootrogue.img"

echo ""
echo "=== Download complete ==="
ls -lh "$OUT" | tail -5
echo "Total files: $(ls "$OUT" | wc -l)"

# ── UEFI / x64 BIOS ──────────────────────────────────────────────────────────
# OVMF.fd is the EDK2 UEFI firmware required to boot 64-bit (x86-64) OSes.
# It replaces SeaBIOS for profiles that need UEFI instead of legacy BIOS.
# Source: pre-built binary from the EDK2 SourceForge archive.
# Size: ~1 MB (OVMF-X64-r15214, code + variable store combined image).
#
# Usage in a v86 profile:
#   bios: { url: "bios/OVMF.fd" }
#   vga_bios: <omit — OVMF provides its own GOP framebuffer, no VGA BIOS needed>
#
# NOTE: The current v86_all.js (Feb 2021 build, commit 98e7110c2) does NOT
# implement EFER / long mode, so 64-bit OSes will triple-fault on startup even
# with OVMF present. This downloads the file so the infrastructure is in place
# for when long mode support is added. See TODO.md for full details.
echo ""
echo "=== Downloading UEFI BIOS to bios/ ==="
download_bios "OVMF.fd" "https://downloads.sourceforge.net/project/edk2/OVMF/OVMF-X64-r15214.zip"
# Note: the above downloads a .zip — we need to unzip it. Handle that here:
if [ -f "$BIOSOUT/OVMF.fd" ] && unzip -t "$BIOSOUT/OVMF.fd" >/dev/null 2>&1; then
    # It's a zip masquerading as .fd — extract the real OVMF.fd from it
    tmp_dir=$(mktemp -d)
    unzip -o "$BIOSOUT/OVMF.fd" OVMF.fd -d "$tmp_dir" 2>/dev/null && mv "$tmp_dir/OVMF.fd" "$BIOSOUT/OVMF.fd"
    rm -rf "$tmp_dir"
    echo "  [extract] bios/OVMF.fd extracted from zip"
fi
echo "Total bios files: $(ls "$BIOSOUT" | wc -l)"
