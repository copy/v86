# USB

`usb: { controller: "uhci", tablet: true, mass_storage: [...] }` gives a PC
machine a USB host controller and its devices: the tablet, USB disks. It is
a plugin, `build/v86-usb.js` (loaded beside the bundle, or from
`usb.plugin_path`); the source is in [`src/usb/`](../src/usb/). The virt
machine has no USB: its input devices are virtio-input.

| Part | File | What it is |
| --- | --- | --- |
| Transactions | `usb.js` | speeds, PIDs, outcomes (data, NAK, STALL), the standard requests and descriptors |
| Device | `usb_device.js` | address, configuration, endpoint 0's control transfers and the standard requests, halted endpoints |
| HID tablet | `hid_tablet.js` | the absolute pointer |
| USB disk | `mass_storage.js` | a disk image as a USB stick: Bulk-Only Transport, SCSI |
| UHCI | `uhci.js` | the USB 1.1 controller |
| Plugin | `machine.js`, `plugin.js` | the machine handle with the bus and the disks' block backends, the devices on their ports, `usb_plug`, USB disks attached and detached |

A controller hands a device transactions (SETUP, IN, OUT) for an endpoint;
the device answers with data, NAK or STALL. There is no electrical
signalling: the transaction is the unit. The device layer knows nothing of
the controller, so that EHCI and xHCI (U3, U4 of
[modern-pc-devices-plan.md](modern-pc-devices-plan.md)) use the same devices.

## UHCI

- **Identity.** PIIX3's UHCI (`8086:7020`, INTD) on i440FX, ICH9's first
  (`8086:2934`, INTA) on Q35, as QEMU's `piix3-usb-uhci` and
  `ich9-usb-uhci1`; class 0C/03/00 (Windows binds `usbport.inf` by it, Linux
  `uhci-hcd`); PIIX3's at 00:01.2 (PIIX3's own place, and where QEMU's
  `-usb` puts it: SeaBIOS's PCI IRQ routing table, which Windows without
  ACPI goes by, covers devices 1 to 6 only), ICH9's at 00:1d.0; BAR4, 32 I/O
  ports; SBRN 1.0; LEGSUP's PIRQ enable set (v86 has no USB legacy SMI: its
  trap bits do nothing).
- **Registers.** USBCMD (RS, HCRESET, GRESET, EGSM, FGR), USBSTS (write one
  to clear; HCHalted follows RS), USBINTR, FRNUM (written only while
  halted), FLBASEADD, SOFMOD, two PORTSC (connect and enable changes, port
  reset, low speed, suspend; bit 7 reads 1, by which drivers count ports).
- **Schedule.** While RS is set, frames of 1 ms of the machine clock: the
  frame list's entry, its queue heads and TDs (depth first where a TD's link
  says so). A TD is a transaction with the device at its address on an
  enabled port: data written back, ActLen, Active cleared, IOC; NAK leaves
  it active for a later frame; STALL and babble retire it with an error; no
  device at the address is a timeout that counts C_ERR down; a short IN
  packet with SPD stops its queue (the driver goes on with it). A frame
  processes at most 256 TDs and 16 KiB, and stops at a queue head seen again
  without progress (the drivers' full-speed bandwidth reclamation loop).
  Frames that fell due while the timer was late are caught up, 16 at a time;
  more than 100 behind are skipped (an interrupt endpoint only NAKs
  meanwhile).
- **Not emulated.** Isochronous transfers, the controller's remote wakeup
  signalling, low-speed timing.

## HID tablet

A full-speed HID device (QEMU's tablet's IDs, `0627:0001`, "v86 USB
Tablet"): one interrupt IN endpoint (8 bytes, every 10 ms), a report of
three buttons, X and Y from 0 to 32767 (absolute) and a wheel (relative).
It does not claim the boot mouse protocol. Reports go out when something
changed, or after SET_IDLE's time; otherwise NAK. HID requests: GET/SET_IDLE,
GET/SET_PROTOCOL, GET_REPORT, the HID and report descriptors.

**The pointer.** The page's pointer (`mouse-absolute`: its position over
the screen; `mouse-click`, `mouse-wheel`) goes to one device of the guest.
While the guest has the tablet configured, it is the tablet's: the tablet
announces it (`usb-tablet-active`), the PS/2 mouse and the VMware backdoor
leave the pointer alone (buttons held go up when the pointer changes
hands), the page hides its own cursor over the screen and does not lock the
mouse on a click. Locking the mouse (the VM manager's Input menu, a game)
makes the movement relative: the PS/2 mouse has it then, the tablet keeps
still. A guest without USB drivers never configures the tablet, so the PS/2
mouse keeps the pointer.

**Hot plug.** `V86.usb_plug("tablet", false)` takes the tablet out of its
port, `true` puts it back: the guest sees it leave and arrive, and
enumerates it again.

## USB disks

```js
usb: { controller: "uhci", tablet: true, mass_storage: [{ id: "stick", image: { url: "stick.img", async: true }, read_only: false }] }
```

A disk image as a USB stick (QEMU's USB disk's IDs, `46F4:0001`, "v86 USB
Disk", a serial number from its id): full speed, mass storage class, SCSI
transparent command set, Bulk-Only Transport, one LUN of 512-byte sectors,
removable. Windows binds `usbstor.inf` (XP and later), Linux `usb-storage`.
The image is as hda's (a URL, a file, a buffer, a container format;
`disk_option`, `disk_error`); its name for the disk APIs is `"usb:" + id`
(`disk_buffer`, `disk_image_info`, `export_disk_image`, the "disk-error"
event). `read_only` is what the guest sees: write protected. Each disk takes
a port: UHCI has two, one of them the tablet's.

- **Transport.** A CBW on bulk OUT (`0x02`), the data on bulk IN (`0x81`) or
  OUT, a CSW with the CBW's tag. BOT's cases: data the host expects that
  the device has not is padded with zeros (the residue says how much); data
  the device has that the host did not expect, or in the other direction,
  is a phase error. An invalid CBW halts both bulk endpoints until the reset
  recovery (BOT reset, CLEAR_FEATURE of both). GET_MAX_LUN is 0.
- **Commands.** TEST UNIT READY, REQUEST SENSE (fixed format), INQUIRY (and
  the VPD pages 0x00, 0x80), READ CAPACITY (10, 16), READ FORMAT
  CAPACITIES, READ and WRITE (6, 10, 12, 16), VERIFY, MODE SENSE (6, 10:
  the caching page with the write cache on, informational exceptions; the
  write protect bit), MODE SELECT (taken, ignored), SYNCHRONIZE CACHE (after
  the writes before it are in the image), START STOP UNIT (eject: the
  "usb-disk-ejected" event; load), PREVENT ALLOW MEDIUM REMOVAL, REPORT
  LUNS; others are ILLEGAL REQUEST, INVALID COMMAND OPERATION CODE. Out of
  range: LBA OUT OF RANGE; a write to a write protected disk: DATA PROTECT;
  a failed read or write (a disk with `disk_error: "report"`): MEDIUM ERROR.
- **The image.** The core's block backend (`src/block_backend.js`, through
  the handle's `block_backend`): the image is read in pieces of 64 KiB, one
  ahead of the host; writes go in pieces of 64 KiB, two at a time. An IN
  whose data has not come, an OUT while two pieces are being written, a CSW
  whose writes are not done: NAK (the controller tries again in a later
  frame). A reset (BOT's, the port's) drops the command: reads are
  cancelled, writes issued land in the image.
- **At run time.** `V86.usb_attach_disk(id, image, { read_only })` plugs one
  into the first free port, `usb_detach_disk(id)` pulls it out (a surprise
  removal: the writes issued are in the image; a disk written back is
  flushed and closed), `usb_plug(id, false)`/`true` takes it out of its
  port and back (the same image). The guest's eject (Linux `eject -s`,
  Windows' safe removal of a removable medium) sends "usb-disk-ejected".
- **Throughput.** UHCI's frames carry at most 16 KiB each (256 TDs of 64
  bytes). Alpine (i440FX, one core) wrote 1 GiB in 154 s (6.6 MiB/s) and
  read it back in 160 s (6.4 MiB/s), every copy checked in the image
  (`USB_DISK_MB=1040 USB_WRITE_MB=1024 tests/devices/usb_storage_guest.mjs`):
  the measure EHCI and xHCI are compared with.

## Snapshots

`state[107]`: the controller's registers, which devices are in their ports,
each device's state (address, configuration, control transfer, the tablet's
pointer, a USB disk's command under way: its phase, the data read ahead,
the piece being written). `state[108]`: the USB disks' buffers by their ids
(the guest's writes, as a hard disk's state has them). A snapshot restores
only into a machine that has USB, and a machine with USB only takes a
snapshot that has it. A USB disk the snapshot has and the machine has not
(by id, in the same port) leaves when it is restored; one the machine has
and the snapshot has not arrives.

## Tests

`make usb-tests`: `tests/devices/usb.js` and `tests/devices/usb_storage.js`
drive the controller through its registers and a schedule in guest memory
(both in ci-tests): the tablet, then a USB disk's enumeration, transport,
commands, errors, a read-only disk, a disk whose reads come later, hot plug
and snapshots; `tests/devices/usb_guest.mjs` boots Alpine 3.24 x86_64
(`uhci-hcd`, `usbhid`) on i440FX and Q35, one and two cores: the tablet
enumerated, its events at the corners, the centre and a 5x5 grid exactly
where the page's pointer was, the buttons, the wheel, out of its port and
back, a snapshot; `tests/devices/usb_storage_guest.mjs` (`usb-storage`): the
disk seen, data through it checked by SHA-256 on both sides, a FAT file
system, a read-only disk attached and detached, out of its port and back, a
snapshot, an eject (`USB_WRITE_MB`: the large write with its times).

Windows, with their images (not in `usb-tests`):
`tests/devices/usb_windows_xp.mjs` boots the site's XP (i440FX, IDE, no
ACPI) with the tablet and a USB disk; `tests/x64/windows_boot.mjs` with
`WIN_USB=1` (`WIN_USB_DISK=1`, the `pointergrid` and `usbdiskfile` verbs)
does Windows 8.1. Both run `tests/x64/windows_usb.c`, which writes the
devices' problem codes, the USB disk's file and the cursor's positions to
the tools disk.

| Guest | Controller, root hub, tablet, HID mouse | Positions (30) | USB disk |
| --- | --- | --- | --- |
| Windows XP SP3 (i440FX, no ACPI, PIIX3 UHCI at 00:01.2) | started, no problem (`usbuhci`, `usbhub`, `HidUsb`, `mouhid`) | all exact | `USBSTOR`, `disk`: a removable drive; its file read, a file written into the image |
| Windows 8.1 x64 (Q35, 2 cores, ICH9 UHCI) | started, no problem (`usbuhci`, `usbhub`, `HidUsb`, `mouhid`) | exact (see below) | the same |

The XP image has no driver for Bochs VGA: its Found New Hardware wizard
for the display holds back the other devices' installs until it is
cancelled (the harness presses Esc). Windows 8.1 shows every position
exactly but the top-left corner, its hot corner (Corner navigation): the
cursor did not go there the first time and went back after the second,
while the tablet reported it at once each time (`WIN_USB_TRACE=1` logs the
reports: one per move of the page's pointer, within 10 ms).
