# Microsoft Windows NT guest setup

 - [Windows NT 3.1](#1-windows-nt-31) / [3.51](#2-windows-nt-351) / [4.0](#3-windows-nt-40)
 - [Windows 2000/XP](#4-windows-2000xp)
 - [Windows Vista and newer](#5-windows-vista-and-newer)

## 1. Windows NT 3.1

### 1.1 Installing using QEMU

1. Install MS-DOS and [Oak CD-ROM Driver](https://www.dosdays.co.uk/topics/Software/optical_downloads.php).
2. Create 4 blank floppy disk images:

 - run `qemu-img create -f raw floppy.img 1440K`
 - mount (`-fda floppy.img`) and run `format A:` in a VM

3. Run QEMU with the following settings for installation:

```sh
qemu-system-i386 -m 64 -drive file=hdd.img,format=raw -cpu pentium -M pc,acpi=off -cdrom InstallCD.iso
```

4. Run `xcopy /v <CD-ROM letter>:\I386\ C:\install\` in a VM to copy all files, disable the CD-ROM driver.
5. Run QEMU with the following settings:

```sh
qemu-system-i386 -m 64 -drive file=hdd.img,format=raw -cpu pentium -M pc,acpi=off
```

6. Run `C:\install\winnt /F /C` in a VM.
7. Follow the setup instructions. To change floppy disk, press *Ctrl+Alt+2* to switch to the QEMU Monitor, run `change floppy0 /path/to/new_floppy_image` and press *Ctrl+Alt+1* to switch to VGA.


## 2. Windows NT 3.51

### 2.1 Installing

> [!NOTE]
> In newer versions of QEMU, the Windows Setup may not work, you can use an older version of QEMU, PCem, 86Box or PCBox instead.

1. If you install via MS-DOS, install [the Oak CD-ROM Driver](https://www.dosdays.co.uk/topics/Software/optical_downloads.php) and run `<CD-ROM letter>:\I386\WINNT /B`.
2. Follow the setup instructions.
3. After installing, download NT 3.51 SuperPack ([here](https://bearwindows.zcm.com.au/winnt351.htm#4) or [here](https://alter.org.ua/en/soft/nt_spack/nt3/)), unpack the archive into a Windows and copy files from `FAT32` (`SYS\FAT32`) and `RENEW` (`SYS\RENEW`) folders in `C:\WINNT35\system32\drivers` with replacing.

### 2.2 Enabling networking

1. Open "Control Panel" > "Network", install Windows NT Networking (installation CD required).
2. In "Network Adapter Card Detection", press Continue three times, set `Network Adapter Card: Novell NE2000 Compatible Adapter`.
3. Set the following settings and click Continue:

```
IRQ Level: 10
I/O Port Address: 0x300
```

4. In "Bus Location", press OK. Check the boxes "TCP/IP Transport" and "Enable Automatic DHCP Configuration" in the next window.
5. In "TCP/IP Configuration", check the box "Enable Automatic DHCP Configuration".
6. Restart the VM.


## 3. Windows NT 4.0

Recommended version: Windows NT 4.0 SP1

### 3.1 Installing using QEMU

1. Run QEMU with the following settings for installation:

```sh
qemu-system-i386 -m 64 -drive file=hdd.img,format=raw -cdrom InstallCD.iso -cpu pentium -M pc,acpi=off
```

2. On setup startup, press F5 and select "Standard PC".
3. Follow the setup instructions.

### 3.2 Running in v86

Due to a problem with CPUID, you need to add `cpuid_level: 2` and `acpi: false` to the V86 constructor (not supported in the UI):

```js
var emulator = new V86({
    graphics_adapter: "bochs_vga",
    ...
    cpuid_level: 2,
    acpi: false
});
```

### 3.3 Enable True Color

*Source: https://computernewb.com/wiki/QEMU/Guests/Windows_NT_4.0*

1. Download driver (version `2010.07.09`) from https://bearwindows.zcm.com.au/vbemp.htm and unpack into Windows.
2. Right-click on the Desktop, click on "Properties".
3. Click "Settings" > "Display Type" > "Change".
4. Press "Have disk", click "Browse" and go to folder with unpacked driver. Go to `VBE20\NT4`, then select `vbemp4.inf` inside.
5. Select "AnaPa Corp VBE Miniport" adapter, press "Yes" and "OK".
6. After installing, restart the VM.

### 3.4 Enabling absolute mouse positioning

1. Download [VMware Tools 6.0](https://archive.org/download/vmware-tools-collection/vmware-tools-600-win.iso) and mount the ISO to the VM.
2. Open Start menu, select "Settings" -> "Control Panel".
3. Open "Mouse", press "General" -> "Change"
4. Press "Have disk" and "Browse". Go to `<CD letter>:\program files\VMware\VMware Tools\Drivers\mouse\winnt` and select `vmmouse.inf`.
5. Press "OK" and restart the VM.


## 4. Windows 2000/XP

### 4.1 Installing

Recommended versions:
 - Windows 2000 SP4
 - Windows XP SP3

#### 4.1.1 Installing using QEMU

1. Run QEMU with the following settings for installation:

```sh
qemu-system-i386 -m 512 -drive file=hdd.img,format=raw -cdrom InstallCD.iso
```

Optional:
 - add `-device sb16` to enable sound
 - add `-nic user,model=ne2k_pci` or `-device ne2k_pci,netdev=<...>` to enable networking

2. Follow the setup instructions.
3. This step fixes the error `Uncaught RangeError: Maximum call stack size exceeded` in Chromium during Windows 2000/XP startup in v86.

After installation, change the computer type to "Standard PC" as described [here](http://web.archive.org/web/20220528021535/https://www.scm-pc-card.de/file/manual/FAQ/acpi_uninstallation_windows_xp_english.pdf):
1. Open Start menu, right-click on "My Computer", select "Manage"
2. Open Device Manager, open Computer, right-click on "ACPI Uniprocessor PC"
3. Select "Update Driver..." > "No, not this time"
4. Select "Install from a list or specific location (Advanced)" > Next > "Don't search. I will choose the driver to install."
5. Choose "Standard PC", press Next > Finish.
6. Restart the VM, follow multiple "Found New Hardware Wizard" dialogs with default options.

#### 4.1.2 Installing using v86

1. Open the debug page (`debug.html`, which `make run` serves) and set the following settings:

| Option          | Value/File                                              |
|:----------------|:--------------------------------------------------------|
| Memory size     | 256 - 1024 MB                                           |
| CD image        | Installation CD                                         |
| Hard disk image | Create an empty disk (recommended size: 1024 - 2048 MB) |

2. Boot the emulator, press F5 and select "Standard PC".
3. Follow the setup instructions.
4. Shut down Windows and export the HD image (press the "Get hard disk image" button at the top).

### 4.2 Enabling True Color (for Windows 2000)

> [!NOTE]
> This driver doesn't support DirectX, DirectDraw and OpenGL.

1. Download driver from https://bearwindows.zcm.com.au/vbemp.htm and unpack into Windows.
2. Open Start menu, right-click on "My Computer", select "Manage"
3. Open Device Manager, open Computer and right-click on "Video Controller".
4. Press "Properties", select "Driver" tab and press "Update Driver".
5. Select "Display a list of the known drivers for this device...", choose "Display adapters".
5. Press "Have Disk...", click "Browse" and go to folder with unpacked driver. Go to `VBE20\W2K\PNP`, then select `vbemppnp.inf` inside.
6. Select "VBE Miniport" adapter, press "Yes" and "Next".
7. After installing, restart the VM.

### 4.3 Enabling sound

*Source: [#1049](https://github.com/copy/v86/issues/1049)*

1. Right-click on "My computer" > "System Properties", select "Hardware" tab, press "Hardware Wizard"
2. Press "Next" > "Add/Troubleshoot a device" > "Add a new device"
3. Select "No, I want to select the hardware from a list" > "Sound, video and game controllers"
4. Select the following options and press "Next":

```
Hardware type: Sound, video and game cotrollers
Manufacturers: Creative Technology Ltd.
Models: Sound Blaster 16 or AWE32 or compatible (WDM)
```

> [!NOTE]
> For Windows Server 2003: you will need to [extract](https://www.betaarchive.com/forum/viewtopic.php?t=37969) the `ctlsb16.sys` and `wdma_ctl.inf` files from the Windows XP installation CD (or download them [here](https://github.com/copy/v86/issues/1358#issuecomment-3014178756)), then press "Have disk" and select the `wdma_ctl.inf` file. After installation, enable the Windows Audio service.


## 5. Windows Vista and newer

### 5.1 Installing using QEMU

1. Run QEMU with the following settings for installation:

```sh
qemu-system-i386 -m 1024 -drive file=hdd.img,format=raw -cdrom InstallCD.iso
```

Optionally add `-accel kvm` (for Linux host), `-accel whpx` (for Windows host) or `-accel hvf` (for MacOS host) to use hypervisor acceleration.

2. Follow the setup instructions.

### 5.2 Running in v86

Enable ACPI and set the memory size to 512 MB or more.

### 5.3 Enabling networking (ne2k)

*Source: https://phaq.phunsites.net/2007/05/21/vista-on-xen-using-ne2000-in-favor-to-rtl8139/*

1. Download https://phaq.phunsites.net/files/2007/05/drivercd.iso_.zip, unpack the archive, mount the ISO to the VM (`-cdrom path/to/drivercd.iso` or `change ide1-cd0 path/to/drivercd.iso` in QEMU Monitor), unpack the archive from CDROM into Windows.
2. Open Start Menu > "Control Panel" > "System" > "Device Manager"
3. Right-click on "Ethernet Controller" > "Update Driver Software", press "Browse my computer for driver software".
4. Click "Browse" and go to folder with unpacked driver, select `WIN2000` folder, press "Install this driver software anyway".

### 5.4 Windows 8.1 x64 with VMware SVGA II or virtio-gpu

Windows 8.1 x64 runs on v86's two 3D adapters with unmodified guest drivers:
VMware's "VMware SVGA 3D" on `graphics_adapter: "vmware_svga"` (D3D9 to
D3D11) and viogpudo on `"virtio_gpu"` (2D only). This section covers the
guest setup. What the drivers need from the device, and what works, is in
[gpu-devices.md](gpu-devices.md#guest-drivers); how to measure a running
guest is in [profiling.md](profiling.md). The examples use the Windows test
harness, `tests/x64/windows_boot.mjs`, whose options are listed at the top of
that file.

#### 5.4.1 Driver packages

Neither package is in the repository; download them.

| Adapter | Package | Driver | Driver version |
| --- | --- | --- | --- |
| `vmware_svga` | VMware Tools 13.1.5 for Windows x64 (`VMware-tools-13.1.5-25544008-x64.exe`, about 140 MB) | "VMware SVGA 3D" (WDDM): `vm3d.inf`, `vm3dmp.sys` (kernel mode), `vm3dum*.dll` (user mode) | 9.17.09.0007 |
| `virtio_gpu` | virtio-win 0.1.240 (about 628 MB) | viogpudo, a display-only driver, in `viogpudo\w8.1\amd64` | 63.93.104.24000 |

- **VMware Tools 13.1.5** supports Windows 8.1 x64 only with update
  KB2919355 (Windows 8.1 Update, build 9600.17031 or later), according to
  Broadcom's guest OS compatibility list. Its Windows 8.1 drivers get only
  critical fixes. The installer embeds an MSI, and the driver files are in
  that MSI's `VmVideo.cab`, where the Windows 8 builds carry a
  `_Win8.<GUID>` suffix. To install from `vm3d.inf`, extract those files and
  remove the suffix.
- **virtio-win 0.1.240** is old on purpose. The Windows 8.1 target of
  viogpudo was removed from virtio-win/kvm-guest-drivers-windows on
  2023-10-26 (commit `c165bd54`, `viogpu/viogpudo/viogpudo.vcxproj`); newer
  releases build the driver only for Windows 10 and 11. In 0.1.240,
  `viogpudo\w8.1\amd64` holds the same files as `viogpudo\2k12R2\amd64`
  (hard links).
- **viogpudo is test signed.** Its catalog's only signature is a self-signed
  "virtio-win Dev / Red Hat Inc." certificate. The driver installs and loads
  only when test signing is on (`bcdedit /set testsigning on`, then reboot)
  and that certificate is in the local machine's `Root` and
  `TrustedPublisher` stores (`certutil -addstore`). With test signing on, the
  desktop shows "Test Mode" in its lower right corner.

#### 5.4.2 Preparing the image

Keep the installed image unchanged and do the setup on a copy (on APFS,
`cp -c windows8.img windows8-gpu.img` clones it at once) or in a harness
overlay (5.4.3). `tests/x64/windows_boot.mjs` opens its image read-only, keeps
the guest's writes in a RAM overlay (`WIN_OVERLAY_SAVE=<file>` saves it,
`WIN_OVERLAY_LOAD=<file>` boots with it again) and checks at the end that the
image's mtime did not change.

1. Check that KB2919355 is installed: `winver` shows build 9600.17031 or later.
2. Raise the TDR timeouts. WDDM resets the display driver when the GPU does
   not answer within 2 seconds. Guest time follows the host's clock in v86,
   and the host can take longer than that to compile pipelines or read back.
   Under `HKLM\System\CurrentControlSet\Control\GraphicsDrivers`, set the
   DWORD values `TdrDelay` = 60 and `TdrDdiDelay` = 60. While debugging,
   `TdrLevel` = 0 turns detection off.
3. For viogpudo, turn test signing on and add its certificate (5.4.1).
4. Optionally, turn on automatic sign-in, so that boots reach the desktop
   without a password. Otherwise the harness types the account's password
   (`WIN_USER_PASSWORD`) at the sign-in screen.
5. Turn off the background work that measurements would see: Windows Search,
   SysMain, Windows Update, Windows Defender's scheduled scan and the Software
   Protection Platform's catch-up tasks. A read-only image redoes this work at
   every boot, and it keeps the idle desktop busy for minutes. Measured on 1
   core with `WIN_IDLE=1` (2026-10-01): Search indexing (SearchIndexer,
   SearchFilterHost, SearchProtocolHost) was about 65% of the idle desktop's
   load and `sppsvc` about 19%; during 3DMark06, `sppsvc`, SysMain and
   `cbscore` took 3–4% of the host.
6. For 3DMark06, install the DirectX 9.0c redistributable (June 2010), which
   has the D3DX9 libraries 3DMark06 needs, and 3DMark06 Professional: the
   Basic edition shows its score only online. 3DMark06 can sit on a disk image
   of its own, which the harness attaches with `WIN_HDB=<image>` (read-only
   like the first; it was `D:` in the guest).

#### 5.4.3 Installing the drivers

Stage both packages in the image's driver store, from an elevated command
prompt:

```
pnputil -a vm3d.inf
pnputil -a viogpudo.inf
```

Windows then installs the driver when it finds the device. Staging works in
QEMU or in v86:

- **QEMU**: with `-vga vmware` or `-device virtio-vga`, Windows installs the
  driver at once. QEMU's vmware-svga is 2D only, so VMware's driver may report
  an error there; the package is staged all the same.
- **v86**: put the drivers on a CD image, let the harness install them, and
  keep the result as an overlay. `WIN_CDROM=<iso>` attaches the CD,
  `WIN_SETUP` runs harness commands separated by `;;` once the desktop shows
  (for example `runadmin <cmd /c line>` for an elevated command, then
  `wait <seconds>`), and `WIN_OVERLAY_SAVE=<file>` then shuts Windows down and
  saves every sector it wrote. Later runs boot with `WIN_OVERLAY_LOAD=<file>`.

v86's PCI devices sit at other places than QEMU's unless
`qemu_compatible: true` (`WIN_QEMU_COMPATIBLE=1` in the harness), so on its
first boot in v86 Windows detects the adapter again and installs it from the
store.

Run `vmware_svga` at level `dx10` or higher; the default with a 3D renderer
is `dx11-full`. At `vgpu9` and `gb9`, VMware's driver loads but Windows 8.1
shows no desktop (see [gpu-devices.md](gpu-devices.md#guest-drivers)). In
node, the harness gets a 3D renderer with `WIN_GPU_RENDERER=chrome` (a
headless Chrome with WebGPU), and `WIN_SVGA_LEVEL` pins a level.

#### 5.4.4 viogpudo: resolution and cursor

- Windows identifies the monitor from the device's EDID as
  `DISPLAY\VEM1050` (manufacturer "VEM", product 0x1050, name "v86 virtio").
  On its first boot it picked 1280x1024 by itself.
- **Live resolution changes** need viogpuap from virtio-win as well. Run it
  once without arguments; it then starts at every sign-in. Windows then
  switches resolution whenever the page's size changes
  (`V86.set_display_size`: the demo page reports its window size, and the
  harness has the command `display <width> <height>`), also after a snapshot
  restored in place. Observed (2026-10-02): 1152x864, 1024x768 and 1280x800,
  all viogpudo custom modes.
- **Cursor**: viogpudo's `HWCursor` setting is 0 by default. Windows then
  draws the pointer into the picture itself, and the device's cursor queue
  stays unused. With `HWCursor` = 1, viogpudo sends the cursor through the
  cursor queue and the device draws it over its picture.

#### 5.4.5 3DMark06 states

Measurements start from saved states, so that a scene runs again and again
without booting ([profiling.md](profiling.md)).

- **One state per adapter and level.** The PCI device is part of a snapshot:
  a restore refuses a snapshot from another `graphics_adapter` (and a
  `vmware_svga` snapshot with another `vram_size`), and it declares the level
  the snapshot was saved at again (a 3D level then needs a renderer). The guest
  driver reads the device's capabilities only when it starts. So a state
  saved on `bochs_vga` cannot be reused with `vmware_svga`, and a state for a
  newer level must come from a fresh boot at that level. Boot the prepared
  image on the target adapter and level, then save.
- **Level**: with `vmware_svga`, 3DMark06 runs every test (GT1–GT4, both HDR
  tests, the CPU tests) at `dx10` and above.

To capture a state:

1. Build with `make all`, then boot the prepared image with the release
   build, the 3DMark06 disk and the launcher:

   ```sh
   TEST_RELEASE_BUILD=1 WIN_IMAGE=windows8-gpu.img WIN_HDB=3dmark06.img \
   WIN_GRAPHICS_ADAPTER=vmware_svga WIN_GPU_RENDERER=chrome \
   WIN_NO_PROBE=1 WIN_LAUNCHER='<guest path of LAUNCH.EXE>' \
   node tests/x64/windows_boot.mjs
   ```

   `LAUNCH.EXE` (`tools/windows/launch.c`, built with the command at the top
   of that file) must be in the guest, on the CD or in the image. The harness
   starts it once the desktop shows, and it runs the command lines the
   harness sends as the signed-in user; typing into the Run dialog instead
   loses keys while the guest is busy. `WIN_NO_PROBE=1` keeps the harness's
   own Run dialog from taking the focus from full-screen programs.
2. Start 3DMark06 from `D:` with `-nosysteminfo`: write
   `launch <command line>` to `<out>/command.txt` (`WIN_OUT`, by default
   `build/x64-windows`).
3. When the guest shows what the state should hold (the main menu, or a test
   about to start), write `savestate <file>` to `<out>/command.txt`.

`savestate` writes `<file>.state` (the machine, with the GPU's contents),
`<file>.hda.ovl` and `<file>.hdb.ovl` (what the guest wrote to its disks) and
the sidecar `<file>.json`. `WIN_STATE_LOAD=<file>` starts from these instead
of booting. The `.json` is the harness's own state (signed in, whether the
launcher is ready, and its last command serial), so that `launch` keeps
working after a load. It does not hold the machine settings, and a load needs
the same `WIN_*` settings as the save: keep them with the state (in its file
name, for example), together with the driver version, the desktop resolution
and the 3DMark06 edition.
