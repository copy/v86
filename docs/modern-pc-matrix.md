# Modern PC devices: the test matrix

What the devices of [modern-pc-devices-plan.md](modern-pc-devices-plan.md)
were verified with: the media, firmware and drivers, the guests' results,
and Windows 11's requirements against them (stage C1). Each device's own
document has the details: [networking.md](networking.md) (e1000),
[sound.md](sound.md) (HD Audio), [usb.md](usb.md), [uefi.md](uefi.md) (OVMF,
Secure Boot), [tpm.md](tpm.md).

Last updated 2026-10-27, branch `new_device`: macOS 27.0, Node.js 25.6.0,
headless Chrome 156.0.8078.48 (the VM manager's browser tests).

## Media and firmware

| Guest | Media | How it is pinned |
| --- | --- | --- |
| Alpine 3.24.0 x86_64, virt kernel and LTS kernel 6.18.35 | the virt and standard ISOs | SHA-256 in [`tests/lib/alpine_image.mjs`](../tests/lib/alpine_image.mjs) |
| Linux 4.16 (32-bit) | `images/linux4.iso` | the repository's image |
| Windows XP SP3 (x86) | the site's installed image (`windowsxp_multidisk_C_4G.img`) | read only (an overlay) |
| Windows 8.1 Pro x64, build 9600 | the owner's installed image (`images/windows8.img`: Q35, `storahci`) | read only (an overlay) |
| Windows 8.1 x64 installer | `windows81_full.iso`, SHA-256 `1a74aeea2a1aef7627ef1e2f667364a84276e5be632da12b80deca3ecbdaa559` | read only (an overlay) |
| Windows 10, Windows 11 | none here | the owner's installation media are pending |

| Firmware | Version | Pinned |
| --- | --- | --- |
| SeaBIOS | rel-1.16.2, `CONFIG_TCGBIOS` | `bios/seabios.bin` |
| OVMF | edk2-stable202408 as QEMU 9.2.0 ships it (`ovmf-code.fd`, `ovmf-secure-code.fd`) | [`bios/fetch-ovmf.sh`](../bios/fetch-ovmf.sh) |
| Secure Boot keys | microsoft/secureboot_objects `586ca947` (PK, KEK, db, dbx) | [`bios/make-ovmf-vars-ms.sh`](../bios/make-ovmf-vars-ms.sh) |
| TPM | libtpms 0.10.2 with OpenSSL 3.5.9 | [`tools/libtpms/build.sh`](../tools/libtpms/build.sh) |

## Devices by guest

| Device | Alpine 3.24 x86_64 | Linux 4.16 | Windows XP SP3 | Windows 8.1 x64 |
| --- | --- | --- | --- | --- |
| e1000 (82540EM, `8086:100E`) | — | `e1000`, 1 and 2 cores, ~9 MiB/s | (NE2000 instead) | `nete1g3e.inf` 8.4.13.0, service E1G60, DHCP and a 16 MiB HTTP download (Q35, 2 cores) |
| HD Audio (ICH6 controller, codec `1AF4:0012`) | `snd-hda-intel`, frames exact at 44.1 and 48 kHz, i440FX and Q35, 1 and 2 cores | — | (SB16 instead) | `hdaudbus.inf`, `hdaudio.inf`, "Speakers", 44.1 kHz playback (Q35, 2 cores) |
| UHCI, tablet, USB disk | `uhci_hcd`, `usbhid`, `usb-storage` | — | `usbuhci`, `HidUsb`, `mouhid`, `USBSTOR`; positions exact | the same (Q35, ICH9 UHCI) |
| EHCI with companions | `ehci_hcd`, 480 Mbit/s disk | — | `usbehci` and three `usbuhci` | the same (Q35, 00:1d) |
| xHCI (`1B36:000D`) | `xhci_hcd`, SuperSpeed disk | — | (no driver) | `USBXHCI`, `USBHUB3`, `HidUsb`, `mouhid` (Q35, 2 cores) |
| TPM 2.0 (CRB, `MSFT0101`) | `tpm_crb` under SeaBIOS (i440FX, Q35, 2 cores) and OVMF; both event logs replay to the PCRs | — | — | service TPM started; TBS: TPM 2.0, interface type 3, GetRandom (Q35, SeaBIOS) |
| UEFI (OVMF) | from a GPT disk's ESP (Q35, i440FX, 2 cores) | — | — | Setup's first page through GOP (Q35, 2 GiB) |
| Secure Boot (SMM firmware) | a signed kernel: "Secure boot enabled", 1 and 2 cores | — | — | Setup under Secure Boot with Microsoft's keys (Q35, 2 and 4 GiB) |

The old machine (i440FX, SeaBIOS, PS/2, SB16, NE2000, IDE) is what
`make ci-tests` and the site's guests run; it passed on 2026-10-27 with the
TPM and Secure Boot work in.

## Windows 11

Windows 11's published requirements against what v86 has. Windows 11 has
not been run: the plan leaves its media to the owner, and the column on the
right is what that run has to show.

| Requirement | v86 | Verified so far | Open with Windows 11 |
| --- | --- | --- | --- |
| 64-bit processor, 2 cores or more | x86_64, up to 8 cores | Windows 8.1 x64 on 2 cores | its supported-processor list: v86's model is not on it |
| SSE4.2 and POPCNT (24H2) | on by default for x86_64 ([x86-64.md](x86-64.md)) | Linux, Windows 8.1 | the instructions, CPUID leaves and MSRs its boot uses (a log of them) |
| 4 GB of memory | 2047 MiB in the heap under UEFI, the rest extended RAM above 4 GiB | Windows 8.1 Setup under Secure Boot with 4096 MB | whether 4095 MiB (the preset's 4096 MB) passes its 4 GB check |
| 64 GB of storage | an AHCI disk (the preset: 64 GB on the disk service) | Windows 8.1 on AHCI | installing onto it |
| UEFI, Secure Boot capable | OVMF's Secure Boot build, Microsoft's keys | Windows 8.1's boot manager and winload verified | `Confirm-SecureBootUEFI`, its own dbx and db updates |
| TPM 2.0 | CRB, libtpms | Windows 8.1's driver and TBS | its TPM checks, provisioning, BitLocker's sealing |
| DirectX 12 / WDDM 2.0 graphics | none (the basic display driver) | — | a WDDM 2.0 driver does not exist for v86's adapters |
| Network, sound, USB | e1000, HD Audio, xHCI | Windows 8.1's inbox drivers | Windows 11's inbox drivers for the same IDs |

The VM manager's Windows 11 preset has this machine (Q35, UEFI with Secure
Boot and Microsoft's keys, a TPM 2.0, xHCI with the tablet, e1000, HD Audio,
two cores, 4096 MB, a 64 GB disk); it is marked not verified until that run.
