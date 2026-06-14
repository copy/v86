# MS-DOS / FreeDOS guest setup

> [!NOTE]
> **CPU Idling:** For historical reasons, DOS-like systems do not support power-saving operations. One effect is that the CPU is running in a busy spin-loop when simply waiting for user input. *CPU Idling* aims to avoid this by making use of the [`HLT`](https://en.wikipedia.org/wiki/HLT_(x86_instruction)) instruction under certain conditions to reduce CPU power consumption (and thus heat).
>
> If you plan to install MS-DOS as the base OS for Windows you have the option to enable CPU Idling (a) exclusively under DOS, (b) exclusively under Windows or (c) under both (depending on how you plan to use the installation).
>
> Enabling support for CPU Idling is recommended, but not required.

## 1. Installing MS-DOS 6.22

Download:

* **[Microsoft DOS 6.22.zip](https://archive.org/download/MS_DOS_6.22_MICROSOFT)** [3.5 MB]  
  MS-DOS 6.22 Setup floppy images, unpack to folder **`dos622/`**

Go to https://copy.sh/v86/ and select custom settings:

* **Floppy disk image:** `dos622/Disk 1.img`
* **Hard disk image:** select ***create empty hard disk*** to create a blank disk of 64 MB (for example)

Boot v86, follow the instructions and select defaults. Use the v86 **Eject floppy image** / **Insert floppy image** button to swap floppies `dos622/Disk 2.img` and `dos622/Disk 3.img` when the installer asks for it.

When finished, export hard disk image `C:` using v86 button **Get hard disk image**.

### 1.1 CPU Idling

Download:

* **[DOSID251.zip](https://www.vogons.org/viewtopic.php?p=438763#p438763)** [28,9 KB]  
  CPUidle for DOS (DOSidle), extract `DOSIDLE.EXE` to floppy image **`dosidle.img`**

Boot v86, insert floppy image `dosidle.img` and install `DOSIDLE.EXE` using:

```
COPY A:DOSIDLE.EXE C:\
```

Eject the floppy image, then open `AUTOEXEC.BAT` in an editor using:

```
EDIT C:\AUTOEXEC.BAT
```

and append new line:

```
C:\DOSIDLE
```

Save and exit, export you hard disk image and reboot.

## 2. Installing FreeDOS 1.4

Download from the [FreeDOS Homepage](https://www.freedos.org/):

* **[FD14-LiveCD.zip](https://download.freedos.org/1.4/FD14-LiveCD.zip)** [280 MB]  
  FreeDOS for everyone 1.4, unpack **`FD14LIVE.iso`** [301 MB]

There are more optional packages on the Bonus CD [FD14-BonusCD.zip](https://download.freedos.org/1.4/FD14-BonusCD.zip).

Go to https://copy.sh/v86 and select custom settings:

* **CD image:** `FD14LIVE.iso`
* **Hard disk image:** select ***create empty hard disk*** to create a blank disk of 64 MB (for example)

Boot v86, follow the installation instructions and select defaults, export your HD image when done.

To install extra packages, insert Live CD `FD14LIVE.iso` (or Bonus CD `FD14BNS.iso`) and run the FreeDOS package manager:

```
FDIMPLES
```

### 2.1 CPU Idling

FreeDOS provides a tool [`FDAPM`](https://help.fdos.org/en/hhstndrd/base/fdapm.htm) to control Advanced Power Management (APM) settings.

Run `EDIT C:\FDAUTO.BAT` and append line (after `END:`):

```
FDAPM APMDOS
```

Save and exit, then reboot.

[Source](https://freedos-user.narkive.com/UGrcO8wU/does-freedos-make-cpu-sleep-when-idle)

### 2.2 Networking

For networking support add these packages from Live CD `FD14LIVE.iso`:

```
[+] Networking
    [X] FDNET     Basic networking support package
    [X] MTCP      A collection of TCP/IP tools
```

Click OK to install the packages and to close the package manager, then create `C:\net\fdnet\fdnetpd.bat` (FreeDOS doesn't auto-detect v86's NIC):

```
ECHO NE2000.COM 0x60 0xA 0x300 > NET\FDNET\FDNETPD.BAT
```

Reboot, wait for a DHCP lease and then test networking with:

```
NET\MTCP\HTGET.EXE http://copy.sh/v86/
```

## 3. FAT-formatted disk images

You need a bootable DOS-floppy image that contains `FDISK.EXE` and `FORMAT.COM` (or something similar) in order to create floppy and hard disk images using v86, for example **`msdos622-boot-fd.img`** (TODO: upload to copy.sh website).

### 3.1 Creating FAT-formatted floppy disks

Go to https://copy.sh/v86 and select custom settings:

* **Floppy disk image:** `msdos622-boot-fd.img`
* **Second floppy disk image:** select ***create empty floppy disk*** to create a blank disk image

Boot v86. In order to format the empty floppy disk in `B:` enter:

```
FORMAT B:
```

When finished, export the floppy disk image in `B:` using v86 button **Get second floppy image**.

### 3.2 Creating DOS-partitioned and FAT-formatted hard disks

Go to https://copy.sh/v86 and select custom settings:

* **Floppy disk image:** `msdos622-boot-fd.img`
* **Hard disk image:** select ***create empty hard disk*** to create a blank disk image
* **Boot order:** select ***Floppy / Hard disk / CD***

Boot v86. In order to partition the empty hard disk, enter at the command prompt:

```
FDISK
```

Use the defaults to create a single partition that fills the entire hard disk, reboot.

Next, to format the new partition `C:` enter:

```
FORMAT C:
```

When finished, export the hard disk image `C:` using v86 button **Get hard disk image**.

### 3.3 Editing FAT-formatted disk images

#### 3.3.1 Windows

Use [WinImage](https://www.winimage.com/winimage.htm) for floppy and hard disk images (and other image types).

#### 3.3.2 Linux

**Floppy disks**

Use [`mtools`](https://linux.die.net/man/1/mtools) to directly copy files from/to floppy images using the `-i` command line flag, for example (in mtools, `::` is the drive name of the image file mounted using `-i`):

```bash
# copy file1.txt from floppy-disk.img to current working directory
mcopy -i floppy-disk.img ::file1.txt .

# copy file2.txt from current working directory to floppy-disk.img
mcopy -i floppy-disk.img file2.txt ::
```

**Hard disks**

Mount example hard disk image `hard-disk.img` into directory `/mnt`:

```bash
# attach loop device 0 to image file "hard-disk.img"
sudo losetup -P /dev/loop0 hard-disk.img
# mount first partition into directory "/mnt"
sudo mount /dev/loop0p1 /mnt
```

Now perform file operations on `/mnt`. When done umount the image again using:

```bash
# unmount partition from directory
sudo umount /mnt
# detach loop device from disk image
sudo losetup -d /dev/loop0
```
