# UEFI

`firmware: { type: "uefi", code, vars }` gives a PC machine UEFI firmware in
place of SeaBIOS: OVMF, the X64 build of edk2's virtual machine firmware, as
QEMU runs it. It needs `cpu_type: "x86_64"`, `acpi: true` and, on i440FX,
`qemu_compatible: true` (below); it takes the place of `bios` and
`vga_bios`. Stage F1 of [modern-pc-devices-plan.md](modern-pc-devices-plan.md).

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

Their licenses (edk2's BSD-2-Clause-Patent and those of the libraries in
the build, OpenSSL among them) are in `bios/OVMF-LICENSES.txt`.

## The flash

The variable store and the code, in this order, end at 4 GiB: 4 MiB from
0xFFC00000, where QEMU maps its pflash units 1 and 0; the reset vector is
the code's last 16 bytes. The memory is device memory
([`src/rust/cpu/mmio_ram.rs`](../src/rust/cpu/mmio_ram.rs)) that is
read-only: the CPU reads it at memory speed, and writes go to the memory map,
which drops them. The last 128 KiB of the code also appear at 0xE0000, as
QEMU's isa-bios alias.

OVMF tells flash from ROM by writing to it: on ROM it keeps its variables in
RAM (EmuVariableFvbRuntimeDxe), so for now variables do not outlive the
machine. Writable variables are CFI flash (to come).

SEC runs in place from the flash in long mode and decompresses the rest of
the firmware into RAM. The x64 page tier compiles that code: pages of
read-only device memory in the top 16 MiB have their own keys
(`DEVICE_KEY_BASE` in [`src/rust/x64/pages.rs`](../src/rust/x64/pages.rs)),
compiled from a copy of the page, retired when device memory is mapped,
unmapped or made writable. Interpreted, SEC took about 4 minutes (541
million instructions); compiled, the Shell is reached in about 10 s.

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

## Differences from QEMU

| QEMU | v86 | Effect |
| --- | --- | --- |
| fw_cfg DMA (revision 3) | I/O ports only (revision 1) | slower fw_cfg reads (the ACPI tables, SMBIOS) |
| CPUID 0x80000000 gives the vendor | zero there, as Intel CPUs | OVMF calls the address width from CPUID "not valid" and takes it from the memory map |
| stdvga MMIO BAR with EDID | port I/O, no EDID | OVMF's default resolution instead of EDID's 1280x800 |
| `etc/e820` reserves 0xFEFFC000 (KVM's TSS) | no reserved entry | none |
| S3 advertised on i440FX | S5 only | no suspend to RAM under UEFI for now |

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

`MACHINE=i440fx`, `CPU_CORES=2`, `TEST_RELEASE_BUILD=1` for both; `make
uefi-tests` runs them all, `make ci-tests` the Shell on the release build.
The reference is QEMU with the same firmware (the disk on QEMU's SATA:
`-drive file=build/uefi/alpine-esp.img,format=raw,if=none,id=d0 -device
ide-hd,drive=d0,bus=ide.0 -snapshot` boots it the same way):

```sh
cat bios/ovmf-vars.fd bios/ovmf-code.fd > OVMF.fd
qemu-system-x86_64 -machine q35 -m 512 -bios OVMF.fd -display none -serial stdio \
    -debugcon file:debug.log -global isa-debugcon.iobase=0x402 -net none
```
