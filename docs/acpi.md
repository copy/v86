# ACPI

With `acpi: true`, v86 gives the guest a complete ACPI platform. v86 generates the
tables and SeaBIOS installs them. The PIIX4 fixed hardware is emulated: PM1
registers, PM timer, GPE0, SCI, SMI_CMD, power button and reset register.
Interrupts are routed for both PIC and IOAPIC mode, and the guest can use the
sleep states S3, S4 and S5.

| | |
| --- | --- |
| Option | `acpi: true` (still labelled experimental in `v86.d.ts`; it also enables the local APICs and the IOAPIC) |
| Verified guests | Linux 4.16 i386 (IOAPIC routing) and Linux 6.8 i386 (PIC routing); Alpine 3.24 x86_64 (Linux 6.18); Windows 8.1 x64 boots with its ACPI HAL |
| Sleep states | S3, S4 and S5: 20 S3 + 20 S4 cycles each on 32-bit Linux (1/2/4 cores with JIT, 1/2 cores interpreted, 4 cores host-parallel) and on x86_64 Linux (1/2 cores) |
| Not verified | Windows S3/S4 (the local Windows image is read-only); Windows XP/2000 ACPI HAL (no image) |

## Design

**One platform description.** [`src/platform.js`](../src/platform.js) is the
single source for ports, IRQs, the PCI memory window, sleep states and the core
count. The ACPI tables, the firmware inputs (fw_cfg, CMOS) and the device setup
all read from it, so the tables cannot disagree with the hardware.
`check_platform` rejects overlapping I/O ranges. Debug builds also assert that
every port in the description has a device behind it.

**v86 generates the tables and SeaBIOS installs them.** SeaBIOS's built-in
tables describe QEMU's board, not v86's. They put the PM device at 00:01.3 and
VGA at 00:02.0, and list a COM2 that does not exist. They also have no XSDT, a
revision 1 FADT without a reset register, and they advertised an S3 that v86 did
not implement. So v86 builds its own tables in
[`src/acpi_tables.js`](../src/acpi_tables.js), which contains a small AML
encoder. It hands them to the firmware through the same fw_cfg interface QEMU
uses: `etc/acpi/tables`, `etc/acpi/rsdp`, `etc/table-loader` and
`etc/system-states` (with a TPM also `etc/tpm/log`, the TPM2 table's log
area: [tpm.md](tpm.md)). SeaBIOS (pinned to `rel-1.16.2`, ROM unchanged) allocates
memory, patches the pointers, computes the checksums and places the RSDP. v86
never patches guest memory after boot and never edits the ROM binary.

**Only real hardware goes in the tables.** The DSDT lists only devices v86
actually has. Object paths follow SeaBIOS (`\_SB.PCI0`, `PCI0.ISA.KBD`, ...), so
guests that are already installed see few changes. v86 does not advertise
HPET, MCFG/ECAM, EC, battery, thermal zones, S1/S2, x2APIC, NUMA or S4BIOS. A
sleep state goes into the tables only after it has passed its tests. If the
guest writes an unsupported `SLP_TYP`, the device sets `WAK_STS` at once, so the
guest never hangs waiting to wake up.

**The fixed hardware follows the ACPI specification, not the old code.** Every
register is named, and write-1-to-clear, read-only and reserved bits behave as
the specification says for byte, word and dword accesses. Status bits are
separate from enable bits. The SCI is a level: it is recomputed after every
change and stays asserted while any enabled status bit is set. The device
handles ACPI enable and disable on `SMI_CMD` itself, because SeaBIOS's SMM path
never runs in v86 (port 0xB3 reads 0).

**Shared interrupt lines combine their sources with OR.** With
`CPU.set_shared_irq_level(irq, source, level)`, the SCI and each PCI INTx pin
have their own source ID. Lowering one source never lowers the line while
another source still holds it. PCI remembers which line it raised, so it lowers
the right one even if the guest changes the PIRQ routing while the interrupt is
asserted.

**All timers use one clock.** The PM timer runs at 3.579545 MHz and is 24 bits
wide. It reads the machine clock ([`src/machine_clock.js`](../src/machine_clock.js))
that also drives the PIT, RTC, LAPIC timers and TSC. Its value only moves
forward, reading it does not advance it, and it continues from the saved value
after a snapshot restore. SeaBIOS uses it to time POST.

**Sleep states work as on real PIIX4 hardware with SeaBIOS.**

- **S5** is soft off. The emulator stops and emits `acpi-power-off` with
  `"S5"`. The next power-on is a cold boot.
- **S4** is hibernation directed by the guest OS. For the hardware it is a soft
  off with an S4 marker. At the next cold boot, the guest restores itself from
  its swap disk. v86 does not use host `save_state` to implement S4.
- **S3** is suspend to RAM. v86 writes 0xFE to CMOS register 0x0F (SeaBIOS's
  resume marker) and stops every core. It does not just put every core into
  HLT. RAM and device state stay as they are, and the timers keep running. When
  a wake event arrives, v86 resets the CPUs and devices but keeps RAM. SeaBIOS
  then takes its resume path and jumps to the FACS waking vector. The guest
  restarts its other cores itself with INIT/SIPI.

**Reset and power cycles apply to the whole machine.** Port 0xCF9 is its own
PIIX reset control register. It accepts byte writes only and resets the machine
when the RST_CPU bit goes from 0 to 1. The FADT reset register writes 0x06 to it.
Resets requested by the guest (through 0xCF9 or the 8042) run at the next
instruction boundary. On reset, the IDE controller resets as if PCIRST# were
asserted. DMA callbacks carry a reset epoch, so a transfer that completes after
the reset cannot write to the new machine's memory. Before emitting
`acpi-power-off`, S5 waits for any asynchronous disk writes still in progress.

## Architecture

```text
  embedding page                                     guest OS (OSPM)
  new V86({ acpi: true })                            walks RSDP -> XSDT -> FADT/DSDT/MADT
  power_button()  power_state()                      writes PM1_CNT, GPE0, SMI_CMD, 0xCF9
  events: acpi-power-off / acpi-sleep / acpi-wake    runs AML (_PRT, _CRS, _Sx, ...)
        |                                                          |
        v                                                          v
 +------------------------------------ v86 machine -----------------------------------+
 |                                                                                    |
 |  src/platform.js  ports, IRQs, PCI window, cores, sleep states (single source)     |
 |        |                         |                                 |               |
 |        v                         v                                 v               |
 |  src/acpi_tables.js        fw_cfg (0x510) files           devices (cpu.js, pci.js) |
 |  AML encoder:              etc/table-loader  ----------> SeaBIOS rel-1.16.2        |
 |  RSDP rev2, RSDT, XSDT,    etc/acpi/rsdp                 - allocates tables and    |
 |  FADT rev3, FACS, DSDT,    etc/acpi/tables                 patches pointers        |
 |  MADT                      etc/system-states             - writes PMBA = 0x600     |
 |                                                          - S3 resume (CMOS 0x0F)   |
 |                                                                                    |
 |  src/acpi.js: PIIX4 power management function, PCI 00:07.0                         |
 |  +---------------------------------------------------------+                       |
 |  | PM1_STS/EN @ PMBA+0, PM1_CNT @ PMBA+4 (W1C, SCI_EN)     |                       |
 |  | PM_TMR     @ PMBA+8, 3.579545 MHz, 24 bit               | <-- MachineClock      |
 |  | GPE0_STS/EN @ 0xAFE0                                    |     (also PIT, RTC,   |
 |  | SMI_CMD    @ 0xB2 (0xF1 enable, 0xF0 disable)           |      LAPIC, TSC)      |
 |  | fixed power button, sleep state machine S3/S4/S5        |                       |
 |  +----------------------------+----------------------------+                       |
 |                               | SCI (level)                                        |
 |                               v                                                    |
 |        IRQ 9 = OR(SCI, PCI INTx sources)     IRQ 10/11 = PCI links LNKA-LNKD       |
 |                               |                                                    |
 |             +-----------------+-----------------+                                  |
 |             v                                   v                                  |
 |   8259 PIC (ELCR: level)            IOAPIC 0xFEC00000 (MADT: IRQ 9/10/11           |
 |   BSP LINT0 virtual wire            level, active high; IRQ 5 edge for SB16)       |
 |             |                                   |                                  |
 |             +-----------------+-----------------+                                  |
 |                               v                                                    |
 |                  LAPIC of the target core (0xFEE00000) --> CPU                     |
 |                                                                                    |
 |  0xCF9 PIIX reset control <- FADT RESET_REG (SystemIO 0xCF9, value 0x06)           |
 +------------------------------------------------------------------------------------+
```

### How the tables reach the guest

```text
v86                            SeaBIOS POST                          guest
---                            ------------                          -----
fw_cfg file directory  ---->   runs etc/table-loader:
                                 ALLOCATE  RSDP in the F segment,
                                           tables in high reserved memory
                                 ADD_POINTER  RSDT/XSDT -> FADT, MADT
                                              FADT -> FACS, DSDT
                                 ADD_CHECKSUM (after all pointers are patched)
                               moves the PM base 0xB000 -> 0x600 (PMBA)
PM block follows PMBA  <----   (acpi.js remaps its ports; the tables are
                                regenerated on read with the current base)
                               parses the DSDT, finds PNP0303
                                 -> initialises the PS/2 keyboard
                               boots the OS  ---------------------->  finds the RSDP
```

The DSDT contains: the PCI root bridge (`_CRS`: buses 0 to FF, the I/O ranges,
the VGA window, and memory from the first 256 MiB boundary above RAM up to
0xFEBFFFFF), the RTC, keyboard, mouse, FDC, PIC, PIT, DMA controller, speaker
and FPU, the COM and LPT ports that are configured, PNP0C02 motherboard
resources (PM block, GPE0, SMI_CMD, fw_cfg, port 0x92), the link devices
LNKA–LNKD (`_PRS` = IRQ 10, 11), a `_PRT` for 32 slots × 4 pins, one
`Processor()` per core, and `\_S3`, `\_S4` and `\_S5`. The MADT has one LAPIC per
core, the IOAPIC (ID 0, GSI base 0), level/active-high overrides for IRQ 9, 10
and 11, and LINT1 as NMI. FADT flags: WBINVD, PROC_C1, SLP_BUTTON, FIX_RTC,
RESET_REG_SUP, USE_PLATFORM_CLOCK. PWR_BUTTON is 0, which advertises a fixed
power button.

### S3 sequence

```text
guest: echo mem > /sys/power/state
  |  sets the FACS waking vector, writes PM1_CNT = SLP_TYP(1) | SLP_EN
  v
acpi.js suspend():  sleeping = 3, CMOS[0x0F] = 0xFE
                    stop all cores (cooperative: run_cores runs nothing;
                                    parallel: stop-the-world, vCPU workers park)
                    RAM and devices kept, device timers keep running
  |                 --> event "acpi-sleep" ("S3"), power_state() = "S3"
  v
wake source: power_button()   or   RTC alarm with RTC_EN
  v
cpu.resume_from_sleep(): reboot_internal("s3-wake", keep_memory)
                         resets CPUs and devices, keeps RAM and the BIOS shadow
  v
SeaBIOS: POST already ran and CMOS 0x0F == 0xFE -> resume path -> FACS waking vector
  v
guest kernel resumes on the BSP, restarts the APs with INIT/SIPI
WAK_STS and the wake reason set --> event "acpi-wake" ("power-button" | "rtc" | "other")
```

## Example

This is written in the style of `retro-gaming-site/app.js`. It runs a Linux guest
with a power button on the page, and a second disk that the guest can use for
hibernation.

```js
emulator = new V86({
    graphics_adapter: "bochs_vga",
    wasm_path: "v86.wasm",
    memory_size: 512 * 1024 * 1024,
    vram_size: 16 * 1024 * 1024,
    bios: { url: "bios/seabios.bin" },
    vga_bios: { url: "bios/vgabios.bin" },
    screen_container: document.getElementById("screen_container"),
    hda: { url: "images/linux.img", async: true, size: 2 * 1024 * 1024 * 1024 },
    hdb: { url: "images/swap.img", async: true, size: 256 * 1024 * 1024 }, // S4 image (resume=/dev/sdb)
    acpi: true,                        // tables + PM hardware + LAPIC/IOAPIC
    net_device: { type: "ne2k", relay_url: "wss://relay.widgetry.org/" },
    autostart: true,
});

emulator.add_listener("acpi-power-off", state => {        // "S4" or "S5": the emulator stopped
    updateStatus(state === "S4" ? "Guest hibernated" : "Guest shut down");
});
emulator.add_listener("acpi-sleep", () => updateStatus("Suspended to RAM"));
emulator.add_listener("acpi-wake", reason => updateStatus("Woke up (" + reason + ")"));

document.getElementById("power_button").addEventListener("click", async () => {
    // S0: sends the guest a power button event (usually an orderly shutdown)
    // S3: wakes the machine;  S4/S5: powers it on again (cold boot, RAM cleared)
    await emulator.power_button();
    console.log("power state:", await emulator.power_state()); // "S0" | "S3" | "S4" | "S5"
});
```

Notes:

- `get_diagnostics()` includes the ACPI registers and the tables as the guest
  sees them. v86 finds them in guest memory the same way an OS does and verifies
  their checksums.
- Disk writes survive S4/S5 as long as the same `V86` instance is running. That
  includes the in-memory overlay of an `async` disk. To keep them after the page
  reloads, the embedding page has to store the disk itself.
- Enabling `acpi` does not change the HAL of an installed Windows. The Windows XP
  and 98 images of retro-gaming-site were installed without ACPI (XP uses the
  "Standard PC" HAL), so they keep `acpi: false`. To use ACPI, those systems
  have to be installed again with it enabled.
- Any configuration with `cpu_cores > 1` needs `acpi: true`, because it turns
  on the local APICs. See [multicore.md](multicore.md).

## Testing

| Target | What it checks |
| --- | --- |
| `make acpi-table-tests` | Runs the table loader in JS for several memory and device layouts and checks every table. With ACPICA installed (found on `PATH` or through `IASL`/`ACPIEXEC`), it also runs `iasl -d` and checks that `iasl -oa` rebuilds byte-identical AML, and uses `acpiexec` to evaluate `_STA/_CRS/_SRS/_PRS` of the link devices and `\_S3 = {1,1,0,0}`, `\_S4 = {2,2,0,0}`, `\_S5 = {0,0,0,0}`. Without ACPICA, those parts print SKIP. |
| `make acpi-device-tests` | Tests the registers without a guest, using an injected clock: latching, W1C, SCI levels on a shared IRQ 9, PMBA decoding, the reset register, snapshot round trips, and disk I/O in flight across a reset (`tests/devices/device_io_reset.mjs`). |
| `make acpi-guest-tests` | Boots buildroot Linux 6.8 (PIC routing, with and without JIT) and Linux 4.16 (IOAPIC routing). Checks the tables from the host side, that there are no ACPI errors in dmesg, that one power button press gives exactly one SCI, that the `acpi_pm` clocksource keeps time, and runs reboot and S5 power cycles. |
| `make acpi-sleep-tests` | Runs S3 and S4 cycles on 32-bit Linux, alternating wake-ups by RTC alarm and power button. Checks RAM contents, that time never goes backwards, and that every core comes back online. |
| `X64_LINUX_FLAVOR=lts X64_LINUX_SLEEP=20 node tests/x64/linux_boot.mjs` | Runs the same cycles on x86_64 Alpine (the lts kernel, which is built with `CONFIG_HIBERNATION`). |

These targets make up release level `R-ACPI` of
`make platform-release-gate` ([`tools/release_gate.mjs`](../tools/release_gate.mjs)).

**Known limits:**

- In APIC mode, PIIX's direct routing of PIRQA–PIRQD to IOAPIC inputs 16–19 is
  not modelled. PCI interrupts use ISA IRQs 10 and 11 in both modes, and the
  tables describe exactly that.
- There is no SMBIOS.
- No test covers duplicate interrupts while the guest switches between PIC and
  APIC mode.
- Windows S3/S4 has not been verified.
