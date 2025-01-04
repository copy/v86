## Installing using QEMU

Recommended versions:
 - Windows 95 OSR2(.5)
 - Windows 98 Second Edition (SE)

-------------

1. Create a disk image (up to 2 GB): 
```sh
qemu-img create -f raw hdd.img <size in megabytes>M
```
2. Run QEMU with the following settings:
```sh
qemu-system-i386 -m 128 -M pc,acpi=off -hda hdd.img
```
 - add `-cdrom /path/to/installCD.iso`, if you use a CD version.
 - add `-fda /path/to/boot_floppy.img -boot a`, if you use a floppy version or your install CD is non-bootable.
 - (optionally) add `-device sb16` to enable sound
 - (optionally) add `-nic user,model=ne2k_pci` or `-device ne2k_pci,netdev=<...>` to enable networking

3. For Windows 98: select "Start Windows 98 Setup from CD-ROM". For Windows 95: select "Load NEC IDE CDROM driver" and run `fdisk` to create partition, restart emulator, run `format c:` and `D:\WIN95\SETUP`.

4. To change floppy disk, press *Ctrl+Alt+2* to switch to the QEMU Monitor, run `change floppy0 /path/to/new_floppy_image` and press *Ctrl+Alt+1* to switch to VGA.
5. Follow the installation guide on the screen.
6. (optionally) If "Windows protection" errors appears on startup, apply [FIX95CPU](http://lonecrusader.x10host.com/fix95cpu.html) or [patcher9x](https://github.com/JHRobotics/patcher9x#installation).

> [!TIP]
> For transfer files from host to guest, use [genisoimage](https://wiki.debian.org/genisoimage) ([UltraISO](https://www.ultraiso.com/) and [PowerISO](https://www.poweriso.com/) for Windows and Mac) for creating CD-ISO image or [dosfstools](https://github.com/dosfstools/dosfstools) ([WinImage](https://www.winimage.com/download.htm) for Windows) for creating floppy disk images, then mount the created image to QEMU.

## Floppy disk support

Currently, the floppy drive in v86 works only with MS-DOS compatibility mode.

To check this: open the Start menu, click on "Control Panel" and "System", select "Performance" tab. 
If it says *"Drive A is using MS-DOS compatibility mode file system"*, the floppy drive should work properly in v86. If not, try this solution:

1. Click on "Device Manager" in "System Properties".
2. Open "Floppy disk controllers", select "Standard Floppy Disk Controller" and press "Remove" at the bottom.
3. Restart Windows.

## Enabling True Color (32 bpp)

The default VGA display driver only supports 640x480x8 video mode, to fix this, install **Universal VBE9x Video Display Driver**.

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

## CPU idling on Windows 95
See about [installing AmnHLT](cpu-idling.md#windows-9x-using-amnhlt).

## Enabling networking on Windows 95 (requires install CD)

1. Open the Start menu, click on "Control Panel" and "Add New Hardware".
2. Press "Next", select "No" and select next options:

```
Hardware type: Network adapters
Manufacturers: Novell
Models: NE2000 Compatible
```

3. Press "Next" and restart Windows.
4. After restarting, right-click on "My computer", select "Propeties".
5. Open "Device Manager" tab, select "NE2000 Compatible" (in "Network adapters") and press "Properties"
6. Open "Resources", change values by selecting the properties and click on "Change Setting":

```
Interrupt Request: 10
Input/Output Range: 0300 - 031F
```

7. In "Control Panel", open "Network", click on "Add", choose "Protocol" and select the following options:

```
Manufacturers: Microsoft
Network Protocols: TCP/IP
```

8. (optionally) Set "Primary Network Logon" to `Windows Logon`.

## Enabling sound manually

> [!NOTE]
> If you don't have an install CD, use the Sound Blaster 16 driver from https://www.claunia.com/qemu/drivers/index.html.

1. Open "Start" menu, click on "Control Panel" and "Add New Hardware".
2. Press "Next", select "No" and select the following options:

```
Hardware type: Sound, video and game cotrollers
Manufacturers: Creative Labs
Models: Creative Labs Sound Blaster 16 or AWE-32
```

3. Restart Windows.
