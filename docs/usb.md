# USB

`usb: { controller: "uhci" | "ehci" | "xhci", tablet: true, mass_storage: [...] }`
gives a PC machine a USB host controller and its devices: the tablet, USB
disks. It is
a plugin, `build/v86-usb.js` (loaded beside the bundle, or from
`usb.plugin_path`); the source is in [`src/usb/`](../src/usb/). The virt
machine has no USB: its input devices are virtio-input.

| Part | File | What it is |
| --- | --- | --- |
| Transactions | `usb.js` | speeds, PIDs, outcomes (data, NAK, STALL), the standard requests and descriptors |
| Device | `usb_device.js` | address, configuration, endpoint 0's control transfers and the standard requests, halted endpoints |
| HID tablet | `hid_tablet.js` | the absolute pointer |
| USB disk | `mass_storage.js` | a disk image as a USB stick: Bulk-Only Transport, SCSI |
| UHCI | `uhci.js` | the USB 1.1 controller, alone or one of EHCI's companions |
| EHCI | `ehci.js` | the USB 2.0 controller: the high-speed devices; the others to its companions |
| xHCI | `xhci.js` | the USB 3 controller: rings and contexts, USB 3 and USB 2 root ports |
| Plugin | `machine.js`, `plugin.js` | the machine handle with the bus and the disks' block backends, the devices on their ports, `usb_plug`, USB disks attached and detached |

A controller hands a device transactions (SETUP, IN, OUT) for an endpoint;
the device answers with data, NAK or STALL. There is no electrical
signalling: the transaction is the unit. The device layer knows nothing of
the controller, so that UHCI, EHCI and xHCI (U1 to U4 of
[modern-pc-devices-plan.md](modern-pc-devices-plan.md)) use the same
devices. A device has its speeds (the tablet full speed, a USB disk full,
high and SuperSpeed) and runs at its port's: the descriptors are that
speed's; a device of full and high speed describes the other in its device
qualifier and other speed configuration; at SuperSpeed its device
descriptor is USB 3's (endpoint 0's packets 2^9 = 512 bytes) and it has a
BOS (a USB 2.0 extension without LPM, the SuperSpeed capability without
U1/U2 exit latencies: the host leaves U1/U2 off); it takes SET_SEL and
SET_ISOCH_DELAY.

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

## EHCI

`usb.controller: "ehci"`: ICH9's EHCI1 (`8086:293A`, class 0C/03/20,
function 7, INTD) with its three UHCI companions (`8086:2934`, `2935`,
`2936`, functions 0 to 2, INTA to INTC), as QEMU's `ich9-usb-ehci1` with
`ich9-usb-uhci1..3`: at 00:1d on Q35 (and on i440FX with
`qemu_compatible`, QEMU's example), at 00:06 on v86's i440FX layout
(inside SeaBIOS's PCI IRQ routing table, for Windows without ACPI). Windows
binds `usbport.inf` by the classes, Linux `ehci-pci` and `uhci-hcd`. The
plugin's PCI function is the EHCI's; the companions are functions of the
same device (the handle's `function`). Six root ports, two for each
companion: no plugin with UHCI alone takes another place.

- **Registers.** BAR0, 4 KiB of memory: CAPLENGTH 0x20, HCIVERSION 1.0,
  HCSPARAMS (6 ports, N_PCC 2, N_CC 3, no port power control), HCCPARAMS
  (64-bit addressing, a whole frame's isochronous threshold, EECP 0x68: the
  legacy support capability, whose OS owned semaphore takes the BIOS owned
  one at once: v86 has no USB SMI); USBCMD (RS, HCRESET, PSE, ASE, IAAD,
  ITC; the frame list's size stays 1024), USBSTS, USBINTR, FRINDEX,
  CTRLDSSEGMENT, PERIODICLISTBASE, ASYNCLISTADDR, CONFIGFLAG, PORTSC.
- **Ports and their owners.** With CONFIGFLAG clear every port is its
  companion's; setting it gives them to the EHCI (Port Owner clear), and
  the devices move: the companion sees them leave, the EHCI sees them
  arrive (line status J for full speed, K for low). A reset enables a
  high-speed device's port (the device runs at 480 Mbit/s); a full-speed
  device's stays disabled, and the driver's Port Owner hands it to the
  companion (12 Mbit/s). A device that leaves a companion's port gives the
  port back to the EHCI (EHCI 4.2.2).
- **Schedules.** Micro-frames of 125 µs (FRINDEX, Frame List Rollover),
  caught up a millisecond at a time (4 per timer round; more than 100 ms
  behind are skipped). Each micro-frame: its frame list entry's periodic
  schedule (queue heads by their S-mask, at most Mult transactions; iTDs,
  siTDs and FSTNs skipped by their links). Each millisecond: the
  asynchronous ring from ASYNCLISTADDR, pass after pass while transactions
  happen, at most 256 KiB and 512 queue heads; ASYNCLISTADDR follows. A
  queue head's overlay takes its next qTD (the alternate one after a short
  packet; the data toggle the queue head's unless DTC; the NAK counter
  reloaded); a qTD's transactions go over its five pages, max packet at a
  time: NAK leaves it active (a high-speed OUT marks the ping state), STALL
  and babble halt it, no device at the address (or a full- or low-speed
  endpoint: no split transactions without hubs) counts CERR down and
  halts it at 0; done, its token goes back to the qTD, IOC or a short
  packet raise USBINT, an error USBERRINT.
- **Interrupt on Async Advance** is answered at once: no queue head is
  kept between passes, so the one the driver took out is free when it
  asks.
- **Not emulated.** Isochronous and split transactions, hubs, port power
  control, the debug port.
- **Throughput.** Alpine wrote 1 GiB through a USB disk in 29 s (35.3
  MiB/s) and read it in 52 s (19.7 MiB/s): five times UHCI's.

## xHCI

`usb.controller: "xhci"`: QEMU's `qemu-xhci` (`1B36:000D`, class
0C/03/30, INTA, PM and single-vector MSI capabilities) at 00:14.0, where
Intel's PCHs have their xHCI (00:05.0 in QEMU's PC layout). Windows 8 and
later bind `usbxhci.inf` by the class (Windows 7 has no xHCI driver: the
settings say so), Linux `xhci-pci`. Four physical ports, each a USB 3 root
port (1 to 4: a SuperSpeed device, at 5 Gbit/s) and a USB 2 one (5 to 8:
the others; a high-speed device at 480 Mbit/s, the tablet at 12).

- **Registers.** BAR0, 16 KiB of memory (32-bit: v86's PC host bus has no
  64-bit BARs): the capability registers (32 slots, one interrupter, 8
  ports, one event ring segment, no scratchpad, 64-bit addresses, 32-byte
  contexts), the operational registers (USBCMD, USBSTS, PAGESIZE 4 KiB,
  CRCR, DCBAAP, CONFIG; PORTSC at 0x400), the runtime registers at 0x1000
  (MFINDEX from the machine clock, the interrupter: IMAN, IMOD, ERSTSZ,
  ERSTBA, ERDP with EHB), the doorbells at 0x2000, the extended
  capabilities at 0x3000 (USB legacy support, handed over at once; the two
  supported protocols).
- **Ports.** A SuperSpeed device's USB 3 port connects with its link in U0
  and enabled; the others' USB 2 port connects polling, and a port reset
  enables it. Changes (connect, reset, link state, warm reset) are W1C bits
  and Port Status Change Events; suspend (U3) and resume by the link state.
- **Commands** (doorbell 0, run at once, a Command Completion Event each):
  Enable and Disable Slot, Address Device (the slot's ID as the device's
  address; BSR: the default state), Configure Endpoint (add and drop flags,
  deconfigure), Evaluate Context (exit latency, interrupter, endpoint 0's
  max packet), Reset Endpoint (a halted one), Stop Endpoint (a TD under way
  gets a Stopped Transfer Event at its TRB), Set TR Dequeue Pointer, Reset
  Device, Get Port Bandwidth, No Op; others are TRB errors; a command ring
  stopped or aborted answers Command Ring Stopped.
- **Transfers.** A slot's doorbell runs the endpoint's ring: TDs of Normal,
  Setup, Data, Status, Event Data and No Op TRBs (Link TRBs followed, their
  toggle cycle), max packet at a time with the device in the slot's port,
  up to a budget (64 KiB a doorbell, 1 MiB a millisecond); a stopped
  endpoint runs again. A NAK leaves the TD where it is, tried again each
  millisecond. Transfer Events as QEMU's: the first TRB with IOC, or with
  ISP after a short packet (Short Packet and the bytes left), a control
  transfer's Status stage again, Event Data TRBs with the bytes so far (ED);
  STALL, babble, no device and DMA errors halt the endpoint at the TD.
- **Events and interrupts.** The event ring's one segment from ERSTBA,
  cycle bit by cycle bit; a full ring drops events, its last entry an
  Event Ring Full Error. An event sets EHB, IP and EINT and interrupts
  unless EHB was set: an MSI message (IP clears when it is sent) or INTA
  (IP, IE and INTE); clearing EHB with events left interrupts again.
- **Not emulated.** Hubs (route strings), streams, isochronous transfers,
  U1/U2, the debug capability, more interrupters, MSI-X, interrupt
  moderation, the controller's save and restore state.
- **Throughput.** Alpine wrote 1 GiB through a USB disk at SuperSpeed in 5
  s (205 MiB/s) and read it in 32 s (the guest's SHA-256 is most of it).

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

`state[107]`: the controller's registers (EHCI's with its companions'; an
xHCI's rings, slots, endpoints and the TD each has under way), which
devices are in their ports, each device's state (address, configuration, control transfer, the tablet's
pointer, a USB disk's command under way: its phase, the data read ahead,
the piece being written). `state[108]`: the USB disks' buffers by their ids
(the guest's writes, as a hard disk's state has them). A snapshot restores
only into a machine that has USB, and a machine with USB only takes a
snapshot that has it. A USB disk the snapshot has and the machine has not
(by id, in the same port) leaves when it is restored; one the machine has
and the snapshot has not arrives.

## Tests

`make usb-tests`: `tests/devices/usb.js`, `tests/devices/usb_storage.js` and
`tests/devices/usb_ehci.js` and `tests/devices/usb_xhci.js` drive the
controllers through their registers, schedules and rings in guest memory
(all in ci-tests): the tablet, then a USB disk's enumeration, transport,
commands, errors, a read-only disk, a disk whose reads come later, hot plug
and snapshots; EHCI (the PCI functions, the legacy handoff, the ports'
owners, the asynchronous and periodic schedules, IAA, hot plug,
snapshots); xHCI (the capabilities, the ports, the commands, control,
bulk and interrupt transfers at SuperSpeed and full speed, short packets,
Event Data, STALL and its recovery, Stop Endpoint, the event ring's wrap
and full ring, MSI, hot plug, snapshots, HCRST); `tests/devices/usb_guest.mjs` boots Alpine 3.24 x86_64
(`uhci-hcd`, `usbhid`) on i440FX and Q35, one and two cores: the tablet
enumerated, its events at the corners, the centre and a 5x5 grid exactly
where the page's pointer was, the buttons, the wheel, out of its port and
back, a snapshot; `tests/devices/usb_storage_guest.mjs` (`usb-storage`): the
disk seen, data through it checked by SHA-256 on both sides, a FAT file
system, a read-only disk attached and detached, out of its port and back, a
snapshot, an eject (`USB_WRITE_MB`: the large write with its times). Both
take `USB_CONTROLLER=ehci` (`ehci-pci`: the tablet at 12M on a companion,
the disk at 480M on the EHCI) and `USB_CONTROLLER=xhci` (`xhci-pci`: the
tablet at 12M on a USB 2 port, the disk at 5000M on a USB 3 port).

Windows, with their images (not in `usb-tests`):
`tests/devices/usb_windows_xp.mjs` boots the site's XP (i440FX, IDE, no
ACPI) with the tablet and a USB disk; `tests/x64/windows_boot.mjs` with
`WIN_USB=1` (`WIN_USB=ehci`, `WIN_USB_DISK=1`, the `pointergrid`,
`usbdiskfile` and `usbdevices` verbs) does Windows 8.1; `XP_USB_CONTROLLER=ehci`
the XP one on EHCI. Both run `tests/x64/windows_usb.c`, which writes the
devices' problem codes, the USB disk's file and the cursor's positions to
the tools disk.

| Guest | Controller, root hub, tablet, HID mouse | Positions (30) | USB disk |
| --- | --- | --- | --- |
| Windows XP SP3 (i440FX, no ACPI, PIIX3 UHCI at 00:01.2) | started, no problem (`usbuhci`, `usbhub`, `HidUsb`, `mouhid`) | all exact | `USBSTOR`, `disk`: a removable drive; its file read, a file written into the image |
| Windows 8.1 x64 (Q35, 2 cores, ICH9 UHCI) | started, no problem (`usbuhci`, `usbhub`, `HidUsb`, `mouhid`) | exact (see below) | the same |
| Windows XP SP3, EHCI (00:06) | EHCI (`usbehci`), its three companions (`usbuhci`), four root hubs (one USB 2.0): started, no problem | all exact (the tablet on a companion, 12 Mbit/s) | on the EHCI, 480 Mbit/s; the same |
| Windows 8.1 x64, EHCI (Q35, 00:1d) | the same (ICH9's names) | exact (see below) | the same |

The XP image has no driver for Bochs VGA: its Found New Hardware wizard
for the display holds back the other devices' installs until it is
cancelled (the harness presses Esc). Windows 8.1 shows every position
exactly but the top-left corner, its hot corner (Corner navigation): the
cursor did not go there the first time and went back after the second,
while the tablet reported it at once each time (`WIN_USB_TRACE=1` logs the
reports: one per move of the page's pointer, within 10 ms).
