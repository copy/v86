# UEFI

`firmware: { type: "uefi", code, vars }` gives a PC machine UEFI firmware in
place of SeaBIOS: OVMF, the X64 build of edk2's virtual machine firmware, as
QEMU runs it. It needs `cpu_type: "x86_64"`, `acpi: true` and, on i440FX,
`qemu_compatible: true` (below); it takes the place of `bios` and
`vga_bios`. Stages F1 and F2 (Secure Boot, below) of
[modern-pc-devices-plan.md](modern-pc-devices-plan.md).

```js
new V86({
    cpu_type: "x86_64",
    machine_type: "q35",
    acpi: true,
    memory_size: 512 << 20,
    firmware: {
        type: "uefi",
        code: { url: "bios/ovmf-code.fd" },
        vars: { url: "bios/ovmf-vars.fd" },
    },
    // ...
});
```

## The firmware

`bios/ovmf-code.fd` and `bios/ovmf-vars.fd` are `edk2-x86_64-code.fd` and
`edk2-i386-vars.fd` of the QEMU 9.2.0 release tarball (`pc-bios/`):
edk2-stable202408, built by QEMU's `roms/edk2-build.py` from
`OvmfPkg/OvmfPkgX64.dsc`, DEBUG, with QEMU's options (network, TLS, TPM 2.0;
no Secure Boot, no SMM; the UEFI Shell built in).
[`bios/fetch-ovmf.sh`](../bios/fetch-ovmf.sh) extracts them from the tarball
and checks them:

| File | Size | SHA-256 |
| --- | --- | --- |
| `ovmf-code.fd` | 3568 KiB (0x37C000) | `33090cc07675baa5190d9f1e84bf5176b33bcbfa9bacac522961150cdb6dbb2a` |
| `ovmf-vars.fd` | 528 KiB (0x84000) | `5d2ac383371b408398accee7ec27c8c09ea5b74a0de0ceea6513388b15be5d1e` |
| `ovmf-secure-code.fd` | 3568 KiB | `32807682a9e5c0e2d192ecb6077941d4be8bcfa6b9cd6e60830c3a9f48c0555a` |
| `ovmf-vars-ms.fd` | 528 KiB | `939b65c9cde1c802fa5fee66c76e83b9da3ad0bc27c17d03a9a6da9f710e6253` |

`ovmf-secure-code.fd` is the tarball's `edk2-x86_64-secure-code.fd`, the same
build with `SECURE_BOOT_ENABLE` and `SMM_REQUIRE` (no Shell); it uses the
same template. `ovmf-vars-ms.fd` is that template with Microsoft's keys
enrolled (Secure Boot, below).

Their licenses (edk2's BSD-2-Clause-Patent and those of the libraries in
the build, OpenSSL among them) are in `bios/OVMF-LICENSES.txt`.

## The flash

The variable store and the code, in this order, end at 4 GiB: 4 MiB from
0xFFC00000, where QEMU maps its pflash units 1 and 0; the reset vector is
the code's last 16 bytes. Both are device memory
([`src/rust/cpu/mmio_ram.rs`](../src/rust/cpu/mmio_ram.rs)) that is
read-only: the CPU reads it at memory speed, writes go to the memory map.
The code drops them. The last 128 KiB of the code also appear at 0xE0000,
as QEMU's isa-bios alias. Given `code` alone (an `OVMF.fd` holding both),
all of it is read-only: OVMF then keeps its variables in RAM
(EmuVariableFvbRuntimeDxe).

The variable store is CFI flash, as QEMU's `pflash_cfi01`
([`src/pflash.js`](../src/pflash.js)): in read array mode the memory; a
command written takes the store out of the address space, its reads are
the status register then, until "read array" puts it back. Program a byte
(0x10, 0x40), erase a 4 KiB block (0x20, 0xD0), clear and read the status
(0x50, 0x70), the identifiers (0x90), read array (0xFF): what OVMF's
QemuFlashFvbServices uses ("QemuFlashDetected => FD behaves as FLASH,
writable"). A reset keeps the bytes and returns to read array mode.

The bytes are in a buffer object that every program and erase updates as
well. `vars: { url, disk_option: "read_write" }` writes them back as a disk
is written back ([disk-persistence-plan.md](disk-persistence-plan.md): a local
file in Node, a browser disk, a disk service's image): the variables
outlive the machine. Read only (the default) the changes stay in memory.
A snapshot holds the store's bytes, or for a store written back its
reference (identity and generation), as for a disk: it restores only onto
the same store unchanged since (`firmware_vars` in the error otherwise).
The store is flushed with the disks.

In the VM manager a UEFI machine's store is a browser disk of its own
(`machine.uefi_vars`), copied from the template at the first power-on and
written back (with the CPU in a Worker, where the browser's synchronous file
access is); "Reset UEFI variables…" in the machine panel writes the template
over it and moves its generation on.

SEC runs in place from the flash in long mode and decompresses the rest of
the firmware into RAM. The x64 page tier compiles that code: pages of
read-only device memory in the top 16 MiB have their own keys
(`DEVICE_KEY_BASE` in [`src/rust/x64/pages.rs`](../src/rust/x64/pages.rs)),
compiled from a copy of the page, retired when device memory is mapped,
unmapped or made writable. Interpreted, SEC took about 4 minutes (541
million instructions); compiled, the Shell is reached in about 10 s.

## Secure Boot

`firmware: { type: "uefi", secure_boot: true, code: { url:
"bios/ovmf-secure-code.fd" }, vars }` on Q35: the Secure Boot build, whose
variable services run in SMM (QEMU's `-machine q35,smm=on` with
`-global driver=cfi.pflash01,property=secure,value=on`, the usual pairing).
The firmware verifies every image it loads (UEFI drivers, boot loaders, the
images they load through it) against `db` and `dbx`, and every update of
`PK`, `KEK`, `db` and `dbx` against the key above it (time-based
authenticated variables, PKCS #7): all in edk2's code, in SMM. v86 provides
what that needs and what QEMU provides:

- **SMM** (Q35, [q35.md](q35.md)): TSEG (QEMU's extended TSEG, 16 MiB),
  SMBASE relocation, SMIs through the APM port and the local APIC.
- **A store only SMM writes.** With `secure_boot` the variable store's flash
  takes writes only from a core in SMM; outside it they are dropped and reads
  see the array (`secure` in [`src/pflash.js`](../src/pflash.js); QEMU fails
  such writes with MEMTX_ERROR). The keys in the store decide what boots: code
  outside SMM, the OS's among it, cannot write them past the firmware's
  checks.
- **SMI_LOCK.** ICH9's GEN_PMCON_1 bit 4: once set, SMI_EN.GBL_SMI_EN no
  longer clears, until a reset. OVMF sets it and stops if GBL_SMI_EN still
  clears ("failed to lock down GBL_SMI_EN").
- **RAM in whole MiB.** OVMF's SMM build places TSEG at the top of low RAM
  and asserts that it is MiB aligned; with UEFI the RAM below 2 GiB is
  rounded to whole MiB (2047 MiB at most, where SeaBIOS machines have 2 GiB
  less 128 KiB).

Whether Secure Boot is on is the store's: with a PK enrolled the firmware is
in User Mode and SecureBoot is 1; the empty template leaves it in Setup Mode
(SecureBoot 0, nothing verified). `bios/ovmf-vars-ms.fd` has Microsoft's keys
([`bios/make-ovmf-vars-ms.sh`](../bios/make-ovmf-vars-ms.sh) makes it from
microsoft/secureboot_objects at a pinned commit, each file checked;
[`tools/uefi_vars.mjs`](../tools/uefi_vars.mjs) writes them as edk2's
authenticated variables; their license is in
`bios/SECUREBOOT-OBJECTS-LICENSE.txt`):

| Variable | Contents |
| --- | --- |
| PK | Windows OEM Devices PK: the platform key Microsoft gives OEM devices. v86 holds no private key: nothing here can change KEK but Microsoft's signed KEK updates (for this PK, `KEKUpdate_Microsoft_PK3d8660c0.bin`) |
| KEK | Microsoft Corporation KEK CA 2011, KEK 2K CA 2023 |
| db | Microsoft Windows Production PCA 2011, Windows UEFI CA 2023 (Windows), Microsoft Corporation UEFI CA 2011, Microsoft UEFI CA 2023 (third-party loaders: shim), Microsoft Option ROM UEFI CA 2023 |
| dbx | the 443 SHA-256 hashes of Microsoft's dbx update (`DBXUpdate.bin`, amd64) |

The time of each is zero, so that any signed update is later; Microsoft's
updates append (dbx, db) or are signed for the PK (KEK). As every vendor's
store, it grows old: Windows applies Microsoft's later dbx and db updates
itself, through the firmware's checks; a newer store for new machines is
the script again with a later commit.

The trust boundary is the page's, as for the TPM ([tpm.md](tpm.md)): the
host and whoever holds the store's image can change the keys (the
firmware trusts its flash); a snapshot or the image's earlier bytes roll
back dbx and the authenticated variables' times. Secure Boot here protects
the guest from code inside the guest, not from the host.

## The fw_cfg contract

What OVMF reads besides what SeaBIOS does, from its debug log:

- **Revision.** `FW_CFG_ID` is 1 (the traditional interface; no DMA): OVMF
  takes a revision below 1 for no fw_cfg at all. SeaBIOS only looks at the
  DMA bit.
- **`etc/e820`.** RAM below and above 4 GiB, as QEMU has it (each entry a
  64-bit address and length and a 32-bit type, 1). Only with UEFI: SeaBIOS
  would take it over CMOS.
- **SMBIOS.** `etc/smbios/smbios-anchor` (an SMBIOS 2.8 entry point whose
  table length is the tables') and `etc/smbios/smbios-tables`: system (1),
  chassis (3), processor (4, its ID from CPUID 1), memory array (16),
  memory devices (17, one per 16 GiB), address ranges (19), boot information
  (32), end (127); OVMF adds its own BIOS information (0).
  [`src/smbios.js`](../src/smbios.js). SeaBIOS builds its own tables and
  does not get these files.
- **ACPI.** OVMF runs the same `etc/table-loader` script as SeaBIOS; the
  tables are built when it reads them, after it has programmed the PM base.
- **Sleep states.** `etc/system-states` and the DSDT declare S5 only, on
  both machines: OVMF's S3 resume and its S4 path are not verified
  ("S3SaveStateDxe: Skip S3BootScript because ACPI S3 disabled").
- **Debug console.** With `debug_console: true`, port 0x402 reads 0xE9 and
  OVMF writes its debug log there (QEMU's isa-debugcon); each byte is the
  `debug-console-output-byte` event.

## The machines

- **Q35.** OVMF programs PCIEXBAR to 0xE0000000 (its
  PcdPciExpressBaseAddress), not SeaBIOS's 0xB0000000, and allocates 32-bit
  PCI memory from its Uc32Base (4 GiB less the largest power of two between
  RAM and 4 GiB: 0x80000000 up to 2 GiB of RAM) up to the ECAM window. The
  platform describes that layout with UEFI (`ovmf_pci_mmio_start`,
  `OVMF_Q35_ECAM_BASE` in [`src/platform.js`](../src/platform.js)): MCFG and
  the ECAM's motherboard resource at 0xE0000000, the root bridge's window
  around it. The MCH decodes its ECAM window before any BAR
  (`mmio_ram_reserve`): the VGA's frame buffer starts at 0xE0000000, and
  until OVMF moved it, PCI configuration reads there returned frame buffer
  bytes.
- **i440FX.** OVMF expects QEMU's PC layout: PIIX3 at 00:01.0, its IDE at
  00:01.1, the PIIX4 power management function at 00:01.3 (OVMF reads the PM
  base there and computes the ACPI timer's port from it). That is v86's
  `qemu_compatible` layout, so UEFI requires it. The primary IDE channel
  exists without drives, as QEMU's: OVMF waits 35 s for BSY to clear on a
  channel that reads as an open bus.
- **Graphics.** OVMF's QemuVideoDxe drives the Bochs VGA (`bochs_vga`)
  through its port I/O registers: v86's adapter has no MMIO BAR (QEMU's
  stdvga has one, with an EDID blob); the data register's aligned alias at
  0x1D0 is decoded as QEMU decodes it. The GOP modes go up to the VRAM's
  size; without EDID, OVMF picks its default resolution.

## Fixes the bring-up needed

- **Fetching from the top page.** Instruction fetch remembers the last
  fetched page in `last_virt_eip`, -1 when it is not plain RAM; `read_imm16`
  and `read_imm32s` compared `(eip ^ last_virt_eip) > 0xFFE`, which -1 passes
  for the page at 0xFFFFF000: immediates of code there came from stale RAM.
  They compare the page, as `read_imm8` does.
- **Legacy-mode steps of the page tier.** `run_compat_instruction`, which the
  x64 page tier also runs in legacy modes, read an opcode outside RAM from
  the RAM array unless it was in the extended RAM aperture; it reads through
  the bus as `jit_run_interpreted` does (`fetch_through_bus`).
- **Compatibility mode in device memory.** `ia32e_phys_eip` raised #GP for
  code outside RAM and extended RAM; code in device memory (the flash) runs
  from its address on the legacy bus.
- **LGDT and LIDT outside 64-bit mode** load a 32-bit base, zero-extended;
  v86 kept the upper half a long mode OS had left. OVMF's SMI entry loads its
  GDT in 16-bit code, then enables long mode: with Linux's upper half its far
  jump read the GDT from nowhere (a triple fault at the first SMI from
  Linux). The 32-bit SMM state save map's RSM zero-extends them too.
- **The registers' upper halves on SMM entry.** v86 keeps the 64-bit
  registers' upper halves apart and leaves them in 32-bit code (they are
  undefined there); processors zero-extend 32-bit writes, and OVMF's SMI
  entry sets ESP in 32-bit code, then pushes in 64-bit mode. SMM entry clears
  them (the 64-bit save map has the whole registers for RSM).

## Differences from QEMU

| QEMU | v86 | Effect |
| --- | --- | --- |
| fw_cfg DMA (revision 3) | I/O ports only (revision 1) | slower fw_cfg reads (the ACPI tables, SMBIOS) |
| CPUID 0x80000000 gives the vendor | zero there, as Intel CPUs | OVMF calls the address width from CPUID "not valid" and takes it from the memory map |
| stdvga MMIO BAR with EDID | port I/O, no EDID | OVMF's default resolution instead of EDID's 1280x800 |
| `etc/e820` reserves 0xFEFFC000 (KVM's TSS) | no reserved entry | none |
| S3 advertised on i440FX | S5 only | no suspend to RAM under UEFI for now |
| SMI broadcast negotiated over fw_cfg (`etc/smi/*`, a DMA write) | not offered | an SMI reaches the core that raised it; OVMF's relaxed AP sync (PcdCpuSmmSyncMode 1) does not wait for the others, and sends them SMI IPIs after 100 ms when it needs them |

## Tests

[`tests/uefi/shell.mjs`](../tests/uefi/shell.mjs): to the Shell on the
serial port; the debug log's fw_cfg, e820 and SMBIOS lines and no ASSERT;
QemuVideoDxe's modes and a graphics mode set; `pci`, `smbiosview` and
`memmap` in the Shell; `reset` back to the Shell; a snapshot at the Shell.
[`tests/uefi/esp_boot.mjs`](../tests/uefi/esp_boot.mjs): a cold boot from a
fixed disk. [`tests/lib/uefi_disk.mjs`](../tests/lib/uefi_disk.mjs) makes a
GPT disk whose EFI System Partition (FAT32, made by hdiutil: macOS) holds
the pinned Alpine virt ISO's tree with a `grub.cfg` for the serial console;
the ISO's GRUB, the boot manager's removable-media loader, searches for the
ISO's label, finds none and reads the ESP's config. OVMF's boot manager
starts it (Q35: SATA port 0, i440FX: the primary IDE master), GRUB starts
Linux, Alpine logs in (about 40 s); then Linux's view: 64-bit UEFI,
EDK II's variables with BootOrder and Boot0001, the ESP mounted as the boot
media, v86's SMBIOS, the ACPI tables (MCFG at 0xE0000000 on Q35), no BAR
outside the root bridge's windows, sleep states S0 and S5; a snapshot,
`reboot` back through the firmware, `poweroff` through S5.

[`tests/uefi/vars.mjs`](../tests/uefi/vars.mjs): the variable store kept. A
copy of the template written back: a variable set in the Shell is in the
file after the machine is destroyed (with OVMF's BootOrder), and a second
machine of the file reads it; its own snapshot restores, the first
machine's does not (the store was written since); read only, the changes
stay in memory and the file as it was. The Shell test sets a non-volatile
variable that a reset keeps.

[`tests/uefi/windows_setup.mjs`](../tests/uefi/windows_setup.mjs) (local:
a Windows 8.1 x64 installer ISO, `WIN_ISO`, read only): OVMF's boot
manager starts the CD's `\EFI\BOOT\BOOTX64.EFI`, its "Press any key to boot
from CD or DVD" (graphics only) gets Enter, and Windows Boot Manager,
winload and Windows PE bring Setup's first page to the screen through GOP
at 1280x800 (about 60 s).

With `SECURE_BOOT=1` the same through the Secure Boot firmware with
Microsoft's keys: Windows' boot manager and winload verified against db
(Windows Production PCA 2011) and dbx, Setup's first page as before (about
65 s).

[`tests/uefi/secure_boot.mjs`](../tests/uefi/secure_boot.mjs): the Secure
Boot firmware with a store of test keys (PK, KEK, db, and an image's hash in
dbx), made for the test with their private keys
([`tests/lib/authenticode.mjs`](../tests/lib/authenticode.mjs): openssl
makes the keys; Authenticode signatures of PE images and signed variable
updates in JavaScript), on an ESP that
[`tests/lib/fat.mjs`](../tests/lib/fat.mjs) builds in memory.
[`tests/uefi/sb_app.c`](../tests/uefi/sb_app.c), signed, is the boot
loader; it reports what the firmware does: images signed with the db key
load; unsigned, changed after signing, signed with another key, revoked in
dbx and signed with a key not yet in db are refused (EFI_ACCESS_DENIED, the
debug log's reason); a db without signature, a PK signed by KEK and a dbx
signed by another key are refused (EFI_SECURITY_VIOLATION); a direct flash
write does nothing; a db append signed by KEK is taken and the new key's
image then loads; a db replacement at T2 is taken, the same again and one
at T1 are refused. After a cold reset the store is as left (in the flash's
bytes too), and Alpine's kernel, signed with the db key, boots and reports
Secure Boot on (about 45 s).
[`tests/x64/smm_entry_state.mjs`](../tests/x64/smm_entry_state.mjs): what an
SMI handler that enters long mode itself finds (the two fixes above).

[`tests/uefi/vars_resilience.mjs`](../tests/uefi/vars_resilience.mjs): the
store under failure, where the firmware's variable driver and fault
tolerant writes do the work and v86's flash has to behave as flash.
[`tests/uefi/vars_app.c`](../tests/uefi/vars_app.c) writes and checks
variables; between machines the store is the flash's bytes. A 4 KiB variable
rewritten (about 8,100 programs and erases) with the power cut at points
through it: every store boots and holds the old or the new value whole, the
other variables intact. The store filled until the firmware answers
EFI_OUT_OF_RESOURCES (about 220 variables of 1 KiB), half of them deleted,
and the rewrite then needing their space: the firmware reclaims it (about
800,000 operations, through the fault tolerant write's spare block), and
the power cut through that leaves consistent stores too. With
`SECURE_BOOT=1` on the Secure Boot firmware (its driver in SMM).

`MACHINE=i440fx`, `CPU_CORES=2`, `TEST_RELEASE_BUILD=1` for both; `MEMORY_MB=5120`
for the Shell (extended RAM above 4 GiB); `make
uefi-tests` runs them all, `make ci-tests` the Shell on the release build.
The reference is QEMU with the same firmware (the disk on QEMU's SATA:
`-drive file=build/uefi/alpine-esp.img,format=raw,if=none,id=d0 -device
ide-hd,drive=d0,bus=ide.0 -snapshot` boots it the same way):

```sh
cat bios/ovmf-vars.fd bios/ovmf-code.fd > OVMF.fd
qemu-system-x86_64 -machine q35 -m 512 -bios OVMF.fd -display none -serial stdio \
    -debugcon file:debug.log -global isa-debugcon.iobase=0x402 -net none
```
