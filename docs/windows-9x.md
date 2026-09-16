# Microsoft Windows 9x guest setup

This guide leads through the process of creating v86 guest images for Windows 9x branch (Windows 95, 98 and ME).

## 1. Installing

Recommended versions:
 - Windows 95 OSR2(.5)
 - Windows 98 Second Edition (SE)

### 1.1 Installing using QEMU (recommended)

1. Create a disk image (up to 2 GB):
```sh
qemu-img create -f raw hdd.img <size in megabytes>M
```

2. Run QEMU with the following settings:
```sh
qemu-system-i386 -m 128 -M pc,acpi=off -drive file=hdd.img,format=raw
```
 - add `-cdrom /path/to/installCD.iso`, if you use a CD version.
 - add `-fda /path/to/boot_floppy.img -boot a`, if you use a floppy version or your install CD is non-bootable.
 - (optionally) add `-device sb16` to enable sound
 - (optionally) add `-nic user,model=ne2k_pci` or `-device ne2k_pci,netdev=<...>` to enable networking

3. For Windows 98: select "Start Windows 98 Setup from CD-ROM". For Windows 95: select "Load NEC IDE CDROM driver" and run `fdisk` to create partition, restart the emulator, run `format c:` and `D:\WIN95\SETUP`.

4. To change floppy disk, press *Ctrl+Alt+2* to switch to the QEMU Monitor, run `change floppy0 /path/to/new_floppy_image` and press *Ctrl+Alt+1* to switch to VGA.

5. Follow the installation guide on the screen.

> [!TIP]
> For transfer files from host to guest, use [genisoimage](https://wiki.debian.org/genisoimage) ([UltraISO](https://www.ultraiso.com/) and [PowerISO](https://www.poweriso.com/) for Windows and Mac) for creating CD-ISO image or [dosfstools](https://github.com/dosfstools/dosfstools) ([WinImage](https://www.winimage.com/download.htm) for Windows) for creating floppy disk images, then mount the created image to QEMU.

### 1.2 Installing using v86

*Source: [#1553](https://github.com/copy/v86/discussions/1553#discussioncomment-16893976)*

> [!NOTE]
> Due to [#1556](https://github.com/copy/v86/issues/1556), you will have problems with original Retail CD images.
> You can modify your CD image (delete the `ADMIN`, `DATALINK`, `DEMOS`, `FUNSTUFF`, `HELP`, `OTHER` and `SAMPLER` folders to reduce the size, and apply Pather9x) or use [ready converted HD images](https://github.com/copy/v86/discussions/1553#discussioncomment-16893976).

1. Go to https://copy.sh/v86/ and set the following settings:

| Option                      | File                                                              |
|:----------------------------|:------------------------------------------------------------------|
| Floppy disk image           | [Patcher9x boot floppy](https://github.com/JHRobotics/patcher9x/) |
| Hard disk image             | Create an empty disk (recommended size: 256 - 2048 MB)            |
| Second hard disk image / CD | Installation CD/HD                                                |

2. Boot the emulator, select `1 - FreeDOS EMS/XMS with CD-ROM (default)` (or `2 - FreeDOS EMS/CMS without CD-ROM` if you use installation HD) and run `fdisk` to create partition. Restart the emulator (press the "Send Ctrl + Alt + Del" button at the top) and run `D:\SETUP`.

3. Follow the installation guide on the screen. On the "Analyzing Your Computer" screen, uncheck all devices. Before reboot, do not remove the floppy disk.

4. Run `edit C:CONFIG.SYS` and add the following lines:

```
DEVICE=c:\windows\himem.sys
LASTDRIVE=F
```

5. Save and exit, export the HD image (press the "Get hard disk image" button at the top). Restart the emulator and finish the setup procedure.

## 2. Troubleshooting

### 2.1 "Windows protection" errors during startup

Apply [FIX95CPU](http://lonecrusader.x10host.com/fix95cpu.html) or [patcher9x](https://github.com/JHRobotics/patcher9x#installation).

### 2.2 "VFBACKUP could no load VFD.VXD" on startup (Windows 95)

**Workaround #1**:
*Source: [#1185](https://github.com/copy/v86/issues/1185)*

1. Mount the installation CD (or `Disk 3` for the RTM version on floppy disks).
2. Open the "MS-DOS prompt" and run:

For the CD version:
```bat
extract /a /l C:\Windows\System <cd-rom letter>:\WIN95\WIN95_02.CAB vfd.vxd
```

For the floppy version:
```bat
extract /a /l C:\Windows\System <floppy drive letter>:\WIN95_03.CAB vfd.vxd
```

**Workaround #2**:
*Source: [#289](https://github.com/copy/v86/issues/289)*

1. Open the Start menu, click on "Run" and run `sysedit`.
2. Find `C:\AUTOEXEC.BAT` and add `smartdrv` to the top of the file.
3. Press File -> Save.

### 2.3 "It is now safe to turn off your computer" on startup (disabling ScanDisk)

*Source: https://www.pro-face.com/otasuke/qa/can/pl/scandisk.htm*

1. Open Explorer, click "View" -> "Folder Options" -> "View", select "Show all files" in "Hidden files".
2. Go to `C:`, right-click on `MSDOS.SYS`, select "Properties", untick "Archive" and "Read-only", press "OK".
3. Right-click on `MSDOS.SYS` again, select "Open With..." -> "Notepad".
4. Add (or change) `AutoScan=0` in `[Options]` and save the changes.

## 3. Install optional components

### 3.1 Floppy disk support

Currently, the floppy drive in v86 works only with MS-DOS compatibility mode.

To check this: open the Start menu, click on "Control Panel" and "System", select "Performance" tab.
If it says *"Drive A is using MS-DOS compatibility mode file system"*, the floppy drive should work properly in v86. If not, try this solution:

1. Click on "Device Manager" in "System Properties".
2. Open "Floppy disk controllers", select "Standard Floppy Disk Controller" and press "Remove" at the bottom.
3. Restart Windows.

### 3.2 Enabling True Color (32 bpp)

The default VGA display driver only supports 640x480x4 video mode, to fix this, you can install **Universal VBE9x Video Display Driver** or **VMDisp9x**.

#### 3.2.1 Universal VBE9x Video Display Driver

> [!WARNING]
> After installing, DOS Mode (and other programs and games that require it) may not work properly.
> This is a problem in VBE9x, not v86, see [#110](https://github.com/copy/v86/issues/110).
> Also, this driver doesn't support DirectX, DirectDraw and OpenGL.

1. Download driver from https://bearwindows.zcm.com.au/vbe9x.htm and unpack into Windows.
2. Right-click on the Desktop, click on "Properties".
3. Click "Advanced" > "Adapter" > "Change".
4. Press "Next", select "Display a of all the drivers in a specific location..." and press again "Next".
5. Press "Have Disk...", click "Browse" and go to folder with unpacked driver. Inside the folder with driver, should be folders like `032mb`, `064mb`, `128mb`. Choose a version based on needed video memory size (for example, `032mb`), then select `vbemp.inf` inside.
6. Select "VBE Miniport" adapter, press "OK" and "Next".
7. After installing, restart Windows.

#### 3.2.2 VMDisp9x (Windows 95)

> [!WARNING]
> This driver can run DOS Mode with some graphical glitches. However, DirectX and/or DirectDraw may not work properly with this driver.
> Also, this driver doesn't support OpenGL.

1. Download `vmdisp9x-<...>-driver-2d.img` from https://github.com/JHRobotics/vmdisp9x/releases.
2. Mount as floppy image, right-click on the Desktop, click on "Properties".
3. Click "Advanced" > "Adapter" > "Change".
4. Press "Have Disk...", click "Browse" and go to the floppy.
5. Select "VESA ISA" adapter and press "OK".
6. After installing, restart Windows.

### 3.3 Enabling absolute mouse positioning (VBMOUSE)

v86 emulates the VMware absolute pointing device. With an absolute mouse driver installed in the guest, the guest cursor follows the host cursor directly, without having to lock the mouse.

[VBADOS](https://git.javispedro.com/cgit/vbados.git/about/) provides VBMOUSE, an open-source DOS mouse driver with VMware mouse support, together with a 16-bit Windows mouse driver on top of it that Windows 9x can use.

1. Download [vbados.flp](https://depot.javispedro.com/vbox/vbados/vbados.flp) and mount it as a floppy image (or copy its contents into the guest in some other way).
2. Copy `VBMOUSE.EXE` from the floppy to the hard disk (for example to `C:\VBADOS`) and `VBMOUSE.DRV` to `C:\WINDOWS\SYSTEM`.
3. Add `C:\VBADOS\VBMOUSE.EXE` to `C:\AUTOEXEC.BAT`, so the DOS part of the driver is loaded before Windows starts.
4. In `C:\WINDOWS\SYSTEM.INI`, change the `mouse.drv` line in the `[boot]` section to `mouse.drv=vbmouse.drv`.
5. Restart Windows.

### 3.4 CPU idling on Windows 95

1. Download [`amnhltm.zip`](https://web.archive.org/web/20060212132151/http://www.user.cityline.ru/~maxamn/amnhltm.zip) and unzip the archive in any location.

> [!NOTE]
> If you have installed VBE9x, restart Windows, press F8 on boot, select *Command prompt only*, run `cd C:\path\to\amnhlt\`, and follow to the next step.

2. Run `AMNHLT.BAT`.
3. Restart Windows, and AmnHLT will start automatically on next boot (you can safely delete archive and unpacked folder).

### 3.5 Enabling networking on Windows 95 (requires install CD)

1. Open the Start menu, click on "Control Panel" and "Add New Hardware".
2. Press "Next", select "No" and select next options:

| Option        | Value             |
|:--------------|:------------------|
| Hardware type | Network adapters  |
| Manufacturers | Novell            |
| Models        | NE2000 Compatible |

3. Press "Next" and restart Windows.
4. After restarting, right-click on "My computer", select "Propeties".
5. Open "Device Manager" tab, select "NE2000 Compatible" (in "Network adapters") and press "Properties"
6. Open "Resources", change values by selecting the properties and click on "Change Setting":

| Option             | Value       |
|:-------------------|:------------|
| Interrupt Request  | 10          |
| Input/Output Range | 0300 - 031F |

7. In "Control Panel", open "Network", click on "Add", choose "Protocol" and select the following options:

| Option            | Value     |
|:------------------|:----------|
| Manufacturers     | Microsoft |
| Network Protocols | TCP/IP    |

8. (optionally) Set "Primary Network Logon" to `Windows Logon`.

### 3.6 Enabling sound manually

> [!NOTE]
> If you don't have an install CD, use the Sound Blaster 16 driver from https://web.archive.org/web/20210814023225/https://www.claunia.com/qemu/drivers/index.html (unpack `sbw9xup.exe` as a zip archive).

1. Open "Start" menu, click on "Control Panel" and "Add New Hardware".
2. Press "Next", select "No" and select the following options:

| Option        | Value                                    |
|:--------------|:-----------------------------------------|
| Hardware type | Sound, video and game cotrollers         |
| Manufacturers | Creative Labs                            |
| Models        | Creative Labs Sound Blaster 16 or AWE-32 |

3. Restart Windows.
