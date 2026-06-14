# Microsoft Windows 3.1x guest setuo

This guide leads through the process of creating v86 guest images for:

* [Microsoft Windows 3.1](https://en.wikipedia.org/wiki/Windows_3.1#Windows_3.1)
* [Microsoft Windows for Workgroups 3.11](https://en.wikipedia.org/wiki/Windows_3.1#Windows_for_Workgroups_3.11)

## 1. Prerequisites

Download a set of Setup floppy disk images, either:

* **[Microsoft Windows 3.11 (Retail Full) (3.5).zip](https://archive.org/download/win-311-disk)** [9.8 MB]  
Windows 3.1 Setup floppy images, unpack to folder **`win311/`**
* **[Microsoft Windows for Workgroups 3.11a (OEM) (3.5-1.44mb).zip](https://archive.org/download/wfw311-disk)** [13.9 MB]  
Windows for Workgroups 3.11a Setup floppy images, unpack to folder **`win311/`**

## 2. Installation

Windows 3.1x is a DOS-based Operating System, so start by following the instructions in **[Installing MS-DOS 6.22](docs/dos.md)** to create a DOS installation with a suggested disk size of 128 MB.

Once MS-DOS is installed and has rebooted from HD, insert floppy disk image `win311/DISK1.IMG`, then enter:

```
a:setup
```

Follw the instructions, select defaults and swap the floppy images `win311/DISK2.IMG`, ..., `win311/DISK5.IMG` when being asked by the installer.

Once Win 3.1x is installed, eject the floppy disk image, reboot from HD and stay in the MS-DOS console.

### 2.1 CPU Idling

#### 2.1.1 WQGHLT

The WQGHLT Virtual Device Driver is a CPU load reduction tool for Windows 3.1x. It installs an idle handler that issues the HLT instruction.

Download:

* **[DOS-Drivers.zip](https://web.archive.org/web/20260430201544/https://www.kirsle.net/download?project=DOS&file=DOS-Drivers.zip)** [4.04 MB]  
  Windows 3.1x driver bundle from [kirsle.net](https://web.archive.org/web/20260430225845/https://www.kirsle.net/ms-dos-and-windows-3-1), unpack floppy image **``wqghlt.img``**

Insert floppy disk image `wqghlt.img` and copy `WQGHLT.386` into the system directory:

```
copy A:WQGHLT.386 C:\WINDOWS\SYSTEM
```

Next, edit `system.ini` and add this line in section `[386Enh]`:

```
device=WQGHLT.386
```

Save and exit, then eject the floppy disk image.

#### 2.1.2 Amn Refrigerator (AmnHLT)

Download:

* **[refr32.zip](https://www.softpedia.com/get/System/System-Info/Amn-Refrigerator.shtml)** [102 KB]  
  Amn Refrigerator (formerly AmnHLT) archive, unpack to floppy disk `amnhlt.img`

### 2.2 Increase DMA buffer size

Increase the amount of memory (in kilobytes) to be reserved for the DMA buffer to 64 (default: 16, range: 1-256). Open file `system.ini` in the text editor:

```
edit C:\WINDOWS\SYSTEM.INI
```

and add this line in section `[386Enh]`:

```
dmabuffersize=64
```

Save and exit the editor.

### 2.3 Replace Windows for Workgroups 3.11 keyboard driver

> [!NOTE]
> This step is required for Windows for Workgroups 3.11 only, skip it if you're installing Windows 3.1.

Fixes freezing of keyboard and mouse devices under v86. Download:

* **[wg0974.exe](https://www.vogons.org/download/file.php?id=13145)** [27.1 KB]  
  Windows for Workgroups 3.11 keyboard driver, unpack **`vkda.386`** and copy to floppy image `wg0974.img`

Insert floppy disk image `wg0974.img` and copy `VKDA.386` into the system directory:

```
copy A:VKDA.386 C:\WINDOWS\SYSTEM
```

Next, edit `system.ini` and in section `[386Enh]` replace line `keyboard=*vkd` with:

```
keyboard=c:\windows\system\vkda.386
```

Save and exit, then eject the floppy disk image.

Source: [vogons.org](https://www.vogons.org/viewtopic.php?t=37380)

### 2.4 Cleanup system files

Make sure that `C:\AUTOEXEC.BAT` looks like this:

```
@ECHO OFF
SET TEMP=C:\DOS
PATH C:\WINDOWS;C:\DOS
PROMPT $p$g
C:\WINDOWS\SMARTDRV.EXE
```

And your `C:\CONFIG.SYS` looks like this:

```
FILES=60
LASTDRIVE=Z
BUFFERS=20
DOS=HIGH,UMB
STACKS=9,256
DEVICE=C:\WINDOWS\HIMEM.SYS
DEVICE=C:\DOS\SETVER.EXE
DEVICE=C:\WINDOWS\SMARTDRV.EXE /DOUBLE_BUFFER
DEVICE=C:\WINDOWS\IFSHLP.SYS
```

The base installation is complete at this point, export your Win3.1x hard disk image using v86 button **Get hard disk image**.

## 3. Install optional components

### 3.1 OAK CD-ROM driver

Download:

* **[Windows 98 Second Edition Boot.img](https://winworldpc.com/product/microsoft-windows-boot-disk/98-se)** [1.4 MB]  
  Windows 98SE boot floppy, contains the OAK CD-ROM device driver

Insert floppy disk image `Windows 98 Second Edition Boot.img`, and in the MS-DOS console enter:

```
mkdir C:\CDROM
copy A:OAKCDROM.SYS C:\CDROM
copy A:MSCDEX.EXE C:\CDROM
```

Edit `CONFIG.SYS` and add new line:

```
DEVICE=C:\CDROM\OAKCDROM.SYS /D:OEMCD001
```

Edit `AUTOEXEC.BAT` and add new line:

```
LH C:\CDROM\MSCDEX.EXE /D:OEMCD001 /L:D
```

<details>
<summary>Example CONFIG.SYS and AUTOEXEC.BAT (Windows for Workgroups 3.11a)</summary>

```
# CONFIG.SYS

FILES=60
LASTDRIVE=Z
BUFFERS=20
DOS=HIGH,UMB
STACKS=9,256
DEVICE=C:\WINDOWS\HIMEM.SYS
DEVICE=C:\DOS\SETVER.EXE
DEVICE=C:\WINDOWS\SMARTDRV.EXE /DOUBLE_BUFFER
DEVICE=C:\WINDOWS\IFSHLP.SYS
DEVICE=C:\CDROM\OAKCDROM.SYS /D:OEMCD001

# AUTOEXEC.BAT

@ECHO OFF
PROMPT $p$g
PATH C:\WINDOWS;C:\DOS
SET TEMP=C:\DOS
C:\WINDOWS\SMARTDRV.EXE
LH C:\CDROM\MSCDEX.EXE /D:OEMCD001 /L:D
```
</details>

When finished, eject the floppy disk image and export your v86 HD image, then reboot.

### 3.2 Sound Blaster 16 driver

Download:

* **[Sound Blaster 16 Basic Driver (3.5" Floppy Disk).7z](https://web.archive.org/web/20251230152147/http://neonfloppy.sytes.net/articles/win3-virtualpc/files/Sound%20Blaster%2016%20Basic%20Driver%20(3.5).7z)** [1.1 MB]  
  Sound Blaster 16/AWE for DOS/Windows 3.1, unpack into folder **`sb16/`**

Insert floppy disk image `sb16/disk01.img`, and in the MS-DOS console enter:

```
a:install
```

Follow the instructions and select defaults, Setup auto-detects the v86 hardware settings (IRQ and I/O port) and modifies configuration files accordingly.

When finished, eject the floppy disk image and export your v86 HD image.

### 3.3 Generic SVGA driver

Install the Modern Generic SVGA driver for Windows 3.1 **[vbesvga](https://github.com/PluMGMK/vbesvga.drv)** to use VBE (VESA BIOS Extension) video modes. Download:

* **[vbesvga.img](https://github.com/PluMGMK/vbesvga.drv/releases)** [720 KB]  
  Modern Generic SVGA driver for Windows 3.1 floppy disk image

Insert floppy disk image `vbesvga.img`, then

* open the **Main** folder on the Windows Desktop, then open icon **Windows Setup**
* open menu item **Options** and select **Change Sytem Settings...**
* select **Other display (Requires disk from OEM)** in Dropdown **Display** and set the path to `A:`
* select any resolution, for example **Modern SVGA 1024x768 16M Small**

> [!NOTE]
> You will be asked for the Windows Setup floppies during installation, and the installer might get confused about their disk numbering. The files are there, try other floppy disk numbers when it complains about a missing file even though you inserted the requested setup disk number.

When finished, eject the floppy disk image, and export your v86 HD image in the MS-DOS console.

### 3.4 TCP/IP Networking

#### 3.4.1 Windows for Workgroups 3.11a

Windows 3.11a supports v86's NE2000 NIC, select Interrupt **`10`** (Port 0x300 is auto-detected) and install Microsoft's TCP/IP stack. Download:

* **[Microsoft TCP-IP-32 for Windows for Workgroups 3.11 (3.5).7z](https://web.archive.org/web/20251230152147/http://neonfloppy.sytes.net/articles/win3-virtualpc/files/Microsoft%20TCP-IP-32%20for%20Windows%20for%20Workgroups%203.11%20(3.5).7z)** [464 KB]  
  Microsoft TCP/IP-32 for Windows for Workgroups 3.11, unpack to folder **`mstcpip/`**

Insert floppy disk image `mstcpip/disk01.img`, and add the TCP/IP Protocol to Windows Networking. Enable DHCP.

Alternatively, you can disable Windows Networking and use the v86 Modem with Trumpet Winsock, see next chapter.

#### 3.4.2 Windows 3.1

So far all attempts to use the v86 NIC with Windows 3.1 have failed, but SLIP/PPP-based networking is possible using v86's dial-up Modem and Trumpet Winsock. Download:

* **[twsk30d.zip](https://web.archive.org/web/20240830084459/https://www.steptail.com/_media/guides:files:twsk30d.zip)** [555 KB]  
  Trumpet Winsock 3.0 revision D, unpack **`twsk30d.exe`** and copy to floppy image `twsk30d.img`

Boot v86 with the Modem device enabled (at `UART1`), insert floppy disk image `twsk30d.img`, and run `twsk30d.exe` from the Windows File Explorer. After installation has completed, open Trumpet Winsock and apply these settings to make Trumpet Winsock compatible with the example [minimal PPP WebSocket server](modem.md#example-2-ppp) in the v86 Modem guide:

* Menu: ***File -> Setup...***
  - **IP address:** "" (empty)
  - **DNS server(s):** `8.8.8.8`
  - **Driver:** [*] PPP
* Menu: ***Dialler -> Settings...***
  - **Online Status Detection:** [*] DCD (RLSD)
* Menu: ***Dialler -> Profile...***
  - **Username:** "" (empty)
  - **Password:** "" (empty)
  - **Phone:** WebSocket server IP/Port address `a.b.c.d.port` (see v86 Modem guide)
  - click button ***Modem Settings...***
    - **Dial string:** `d`
    - **[*] Hardware (DTR) hangup**
  - click button ***Server Settings...***
    - clear ALL eight fields

To connect to a WebSocket PPP server, select ***Dialler -> Profile...*** from the Trumpet Winsock main menu, enter the server address in field **Phone** and close the dialog, then select ***Dialler -> Login*** from the menu.

#### 3.4.3 Network software

* **[cc16d408.zip](https://archive.org/download/cc16d408)** [17 MB]  
  Netscape Communicator 4.08 (last release with support for Win3.1x), copy to HD or ISO image

### 3.5 Absolute mouse positioning

Part of the DOS virtualization tools [VBADOS](https://git.javispedro.com/cgit/vbados.git/about/) is a mouse driver that supports absolute mouse cursor positioning (the host's mouse position is then always identical with the guest's). Download:

* **[vbados.flp](https://depot.javispedro.com/vbox/vbados/vbados.flp)** [1.40 MB]  
  VBADOS DOS utilities

To install the DOS driver, createa folder `C:\MOUSE` and copy `VBMOUSE.EXE` from `vbados.flp` to `C:\MOUSE`. Open `C:\AUTOEXEC.BAT` and append these two lines (note that Windows 3.1x instantly freezes when using the mouse wheel, so we deactivate it):

```
C:\MOUSE\VBMOUSE.EXE
C:\MOUSE\VBMOUSE.EXE wheel off
```

Reboot the emulator, start Windows and then install the Windows driver (which requires the DOS driver) from `vbados.flp`:

* open the **Main** folder on the Windows Desktop, then open icon **Windows Setup**
* open menu item **Options** and select **Change Sytem Settings...**
* select **Other mouse (Requires disk from OEM)** in Dropdown **Mouse** and set the path to `A:`
* select **VBMOUSE int33 absolute mouse driver** (if the selection box is blank afterwards just re-select it)

When finished, eject the floppy disk image, and export your v86 HD image in the MS-DOS console.

## 4. Links

### Guides

* [Getting the most out of Windows 3.1 on Virtual PC](https://web.archive.org/web/20251230152147/http://neonfloppy.sytes.net/articles/win3-virtualpc/)
* [How to install Windows 3.1 in QEMU](https://computernewb.com/wiki/QEMU/Guests/Windows_3.1)
* [Connect Windows 3.1 to the Internet using Virtual Modem](https://www.steptail.com/guides:connecting_windows_3.1_to_the_internet)
* [Windows 3.1x keyboard problem](https://github.com/dosbox-staging/dosbox-staging/issues/2175)
* [Windows 3.1 OK? 3.11 locking up? Here is the fix!](https://www.vogons.org/viewtopic.php?t=37380)
* [Windows 3.1 SYSTEM.INI \[386ENH\] Section](https://www.infania.net/misc/win31files/83435-6.php)

### Software collections

* [Excerpts from The Microsoft Software Library](http://www.gaby.de/ftp/pub/win3x/archive/)
* [win31.de](http://win31.de/eindex.htm)
* [Windows Utilities](http://www.dcee.net/Files/Win/)
