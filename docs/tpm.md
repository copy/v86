# TPM 2.0

`tpm: { version: "2.0", interface: "crb", state }` gives a PC machine a TPM
2.0: libtpms, the TPM 2.0 reference implementation with OpenSSL's
cryptography, in WebAssembly, behind the Command Response Buffer (CRB)
interface that Windows (`tpm.inf`, `ACPI\MSFT0101`) and Linux (`tpm_crb`)
drive. It is a plugin, `build/v86-tpm.js`, with the module
`build/libtpms.wasm` beside it; the source is in [`src/tpm/`](../src/tpm/).
Stages T1 and T2 of [modern-pc-devices-plan.md](modern-pc-devices-plan.md).

```js
new V86({
    // ...
    acpi: true,
    tpm: {
        version: "2.0",
        // the TPM's permanent state, kept (optional; else in memory)
        state: { url: "tpm-state.img", disk_option: "read_write" },
    },
});
```

| Part | File | What it is |
| --- | --- | --- |
| The TPM | `bios/libtpms.wasm`, [`tools/libtpms/`](../tools/libtpms/) | libtpms 0.10.2 (TPM 2.0 only) with OpenSSL 3.5.9's libcrypto, built by Emscripten; `v86_tpm.c` its interface |
| Its host | `libtpms.js` | the module's imports (the host's randomness and clock, the state stores), a command in and a response out |
| The interface | `crb.js` | the CRB registers of five localities at 0xFED40000, the data buffer |
| The state | `store.js` | the permanent state in a store of two slots |
| Plugin | `plugin.js` | a new TPM's manufacture, the memory map, reset, snapshots |

## The TPM

[`tools/libtpms/build.sh`](../tools/libtpms/build.sh) fetches the pinned
sources (libtpms 0.10.2, SHA-256 `edac0368…`; OpenSSL 3.5.9, `603f5602…`, the
release's own hash), applies one patch (libtpms's byte order check knows
Emscripten) and builds libcrypto (no assembler, threads, sockets, modules),
libtpms (`--with-tpm2 --without-tpm1`, longjmp as WebAssembly exceptions)
and the module (function pointer casts emulated: libtpms calls OpenSSL's
hash functions through pointers of other signatures, on which WebAssembly's
typed indirect calls trap): `bios/libtpms.wasm`, committed (an Emscripten SDK is not
part of v86's build; the script reproduces it: SHA-256
`90be68ea3cb48371fa70bcbe52f06e482f9939165e20ac5dd5feacd8c2bc2f5f` with
Emscripten 6.0.0), its licenses in `bios/LIBTPMS-LICENSES.txt`. The
Makefile copies it beside the plugin. The module has no JavaScript glue:
its imports are WASI's random_get (crypto.getRandomValues), clock_time_get,
fd_write (libtpms's messages, kept in the plugin's log) and stubs, and the
state callbacks. It is compiled asynchronously before the machine starts
(browsers refuse to compile large modules synchronously on the page's
thread); commands run synchronously.

A TPM without a state manufactures itself (new seeds from the host's
randomness: a new identity), then, as swtpm_setup does by default, is
started, has its SHA-256 PCR bank allocated and the SHA-1, SHA-384 and
SHA-512 banks not, and is shut down. Its manufacturer is libtpms's ("IBM").

## The interface

CRB per the TCG PC Client Platform TPM Profile specification: five
localities of 4 KiB from 0xFED40000, each with its locality registers
(state, control, status: request, relinquish and seize the locality); the
interface identifier (CRB, version 1, five localities, 64-byte transfers,
CRB only, vendor 0x1014 and device 0x0001 as QEMU's); the control area at
0x40 (request: command ready, go idle; status: idle; cancel; start; the
buffer's address and size) and the data buffer at 0x80 (3968 bytes), the
same in every locality. A command runs when its locality writes 1 to
start: synchronously, its response in the buffer and start reading 0 at
once. No interrupts: the ACPI tables give none and drivers poll.

ACPI: a TPM2 table (revision 4: client platform, start method 7, CRB, the
control area at 0xFED40040, a log area of 64 KiB) and a device `MSFT0101`
with the 20 KiB of the five localities. The log area is QEMU's
`etc/tpm/log`, which the firmware allocates through the table loader and
whose address it writes into the table. The platform's reset is the TPM's
(_TPM_Init): its volatile state goes, the firmware or the OS starts it.

No Physical Presence Interface: the DSDT's TPM has no `_DSM`, and fw_cfg no
`etc/tpm/config`, so an OS cannot ask the firmware to clear or reconfigure
the TPM at the next boot (Windows' TPM console says so; Linux has no
`ppi` directory). The OS can still clear it with its own lockout
authorization; the VM manager's "Clear TPM…" starts a new TPM.

## The firmware

Under UEFI (`firmware: { type: "uefi" }`, [uefi.md](uefi.md)), OVMF finds
the TPM behind the CRB (`Tcg2ConfigPei`), starts it, reads its active banks
(SHA-256) and measures the boot as the TCG PC Client firmware profile has
it: its firmware volumes into PCR 0, its configuration (SMBIOS, ACPI and
the like) into PCR 1, option ROMs 2 and 3, the boot manager and the loaders
4, the GPT 5, Secure Boot's variables 7 (no Secure Boot yet: their absence);
GRUB and Linux go on with their own measurements (PCR 8, 9) through the
TCG2 protocol. The event log is the crypto-agile one (SHA-256 digests),
which Linux reads (`/sys/kernel/security/tpm0/binary_bios_measurements`) and
Windows keeps (`C:\Windows\Logs\MeasuredBoot`).

SeaBIOS (`CONFIG_TCGBIOS`) does the same for a BIOS boot, but only with the
TPM2 table's log area (without one it leaves the TPM alone, unstarted, and
Windows' driver fails to start: Device Manager's code 10). It starts the
TPM (Startup, SelfTest), logs in the crypto-agile format, measures SMBIOS,
option ROMs and the boot sectors, closes PCRs 0 to 7 with separators and,
before the boot, sets a random platform authorization. Linux reads its log
from the TPM2 table. Its TCG BIOS interface (INT 1Ah), which Windows' BIOS
boot manager measures PCRs 8 to 11 through, is TPM 1.2's: it sends the TPM
2.0 a SHA-1 digest where a digest list belongs, the TPM answers
TPM_RC_SIZE, and SeaBIOS neither extends nor logs those events (QEMU's
SeaBIOS does the same). Windows' measured boot wants UEFI.

## Guests

| Guest | Firmware | Result |
| --- | --- | --- |
| Alpine 3.24 x86_64, LTS kernel (6.18) | SeaBIOS, i440FX and Q35, 1 and 2 cores | `tpm_crb`, `/dev/tpm0`, hwrng; SeaBIOS's log replays to the PCRs |
| the same, from a GPT disk's ESP | OVMF, Q35 and i440FX | OVMF's log (EFI configuration table) replays to the PCRs |
| Windows 8.1 x64 (Q35, AHCI) | SeaBIOS | `ACPI\MSFT0101` "Trusted Platform Module 2.0", service TPM, started; TBS: TPM 2.0, interface type 3 (hardware), GetRandom, manufacturer IBM |

## The state

The permanent state (seeds, hierarchies' authorizations, NV indices,
persistent objects, PCR allocation) is stored by libtpms at every change.
The store is a buffer object of 512 KiB, two slots of a header (magic,
format, sequence number, length, CRC-32) and the state, written
alternately, the state before its header: the newer whole slot is the
state. A store of zeros is a TPM to manufacture; a store that is neither
is refused, not replaced by a new TPM (a TPM's state holds keys, BitLocker's
among them, that a new one would not have): clearing it is the user's
explicit act. `tpm.state` with `disk_option: "read_write"` writes it back
as a disk is written back ([disk-persistence-plan.md](disk-persistence-plan.md));
without `state` the store is in memory.

A snapshot holds the CRB's registers, the TPM's volatile state and the
store's part, as a disk's: its bytes, or for a store written back its
reference (identity, generation), so that a snapshot restores only onto the
same unchanged store. Restoring powers the TPM on again from the store and
the snapshot's volatile state.

The trust boundary: the page, the host and whoever holds the store can read
and change the TPM's state. This is a TPM for software that needs one, not
a hardware root of trust: no endorsement certificate from a manufacturer, no
resistance to tampering, no remote attestation worth the name.

## Tests

`make tpm-tests`. [`tests/tpm/tpm.mjs`](../tests/tpm/tpm.mjs) (in
`ci-tests`): the CRB protocol and the TPM in Node without a guest, the ACPI
tables, the store across machines, snapshots, a damaged store refused;
[`tests/tpm/linux_tpm.mjs`](../tests/tpm/linux_tpm.mjs): Alpine's `tpm_crb`
and `/dev/tpm0` (SeaBIOS's event log replayed against the PCRs, GetRandom,
PCR_Extend read back through sysfs, a snapshot); [`tests/tpm/uefi_tpm.mjs`](../tests/tpm/uefi_tpm.mjs) (macOS):
OVMF with the TPM, Linux from a GPT disk's ESP, the event log replayed
against every PCR it names. `WIN_TPM=1` in
[`tests/x64/windows_boot.mjs`](../tests/x64/windows_boot.mjs) gives Windows a
TPM; with `WIN_USB` its checker lists the device and sends commands through
Windows' TPM Base Services. The VM manager: `tests/app/wizard_test.html`'s
`uefi` part (OVMF's TCG2 protocol through the CPU worker, the kept state,
"Clear TPM…").
