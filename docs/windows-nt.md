
 - [Windows NT 3.1](#windows-nt-31) / [3.51](#windows-nt-351) / [4.0](#windows-nt-40)
 - [Windows 2000/XP](#windows-2000xp)
 - [Windows Vista and newer](#windows-vista-and-newer)

------------------------
## Windows NT 3.1

### Installing using QEMU

1. Install MS-DOS and [Oak CD-ROM Driver](https://www.dosdays.co.uk/topics/Software/optical_downloads.php).
2. Create 4 blank floppy disk images:

 - run `qemu-img create -f raw floppy.img 1440K`
 - mount (`-fda floppy.img`) and run `format A:` in a VM

3. Run QEMU with the following settings for installation:

```sh
qemu-system-i386 -m 64 -hda hdd.img -cpu pentium -M pc,acpi=off -cdrom InstallCD.iso
```

4. Run `xcopy /v <CD-ROM letter>:\I386\ C:\install\` in a VM to copy all files, disable the CD-ROM driver.
5. Run QEMU with the following settings: 

```sh
qemu-system-i386 -m 64 -hda hdd.img -cpu pentium -M pc,acpi=off
```

6. Run `C:\install\winnt /F /C` in a VM.
7. Follow the setup instructions. To change floppy disk, press *Ctrl+Alt+2* to switch to the QEMU Monitor, run `change floppy0 /path/to/new_floppy_image` and press *Ctrl+Alt+1* to switch to VGA.


## Windows NT 3.51

### Installing 

> [!NOTE]
> In newer versions of QEMU, the Windows Setup may not work, you can use an older version of QEMU, PCem, 86Box or PCBox instead.

1. If you install via MS-DOS, install [the Oak CD-ROM Driver](https://www.dosdays.co.uk/topics/Software/optical_downloads.php) and run `<CD-ROM letter>:\I386\WINNT /B`.
2. Follow the setup instructions.
3. After installing, download NT 3.51 SuperPack ([here](https://bearwindows.zcm.com.au/winnt351.htm#4) or [here](https://alter.org.ua/en/soft/nt_spack/nt3/)), unpack the archive into a Windows and copy files from `FAT32` (`SYS\FAT32`) and `RENEW` (`SYS\RENEW`) folders in `C:\WINNT35\system32\drivers` with replacing.

### Enabling networking

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


## Windows NT 4.0

Recommended version: Windows NT 4.0 SP1

### Installing using QEMU

1. Run QEMU with the following settings for installation: 

```sh
qemu-system-i386 -m 64 -hda hdd.img -cdrom InstallCD.iso -cpu pentium -M pc,acpi=off
```

2. On setup startup, press F5 and select "Standard PC".
3. Follow the setup instructions.

### Running in v86

Due to a problem with CPUID, you need to add `cpuid_level: 2` and `acpi: false` to the V86 constructor (not supported in the UI):

```js
var emulator = new V86({
    ...
    cpuid_level: 2,
    acpi: false
});
```


## Windows 2000/XP

### Installing using QEMU

1. Run QEMU with the following settings for installation: 

```sh
qemu-system-i386 -m 512 -hda hdd.img -cdrom InstallCD.iso
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

### Enabling True Color (for Windows 2000)

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

### Enabling sound

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


## Windows Vista and newer

### Installing using QEMU

1. Run QEMU with the following settings for installation: 

```sh
qemu-system-i386 -m 1024 -hda hdd.img -cdrom InstallCD.iso
```

Optionally add `-accel kvm` (for Linux host), `-accel whpx` (for Windows host) or `-accel hvf` (for MacOS host) to use hypervisor acceleration.

2. Follow the setup instructions.

### Running in v86

Enable ACPI and set the memory size to 512 MB or more.

### Enabling networking (ne2k)

*Source: https://phaq.phunsites.net/2007/05/21/vista-on-xen-using-ne2000-in-favor-to-rtl8139/*

1. Download https://phaq.phunsites.net/files/2007/05/drivercd.iso_.zip, unpack the archive, mount the ISO to the VM (`-cdrom path/to/drivercd.iso` or `change ide1-cd0 path/to/drivercd.iso` in QEMU Monitor), unpack the archive from CDROM into Windows.
2. Open Start Menu > "Control Panel" > "System" > "Device Manager"
3. Right-click on "Ethernet Controller" > "Update Driver Software", press "Browse my computer for driver software".
4. Click "Browse" and go to folder with unpacked driver, select `WIN2000` folder, press "Install this driver software anyway".
