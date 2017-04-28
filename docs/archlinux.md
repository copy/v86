(This document also applies to other Linuxes)

The last version of Arch Linux that supports 32-bit is
[2017.02.01](https://www.archlinux.org/releng/releases/2017.02.01/). Later
versions don't work on v86.

Installation using QEMU
-----------------------


```
# create a 10 gigabyte disk image
qemu-img create arch.img 10G

# Follow the normal installation process
qemu-system-x86_64 -m 256 -drive file=arch.img,format=raw -cdrom archlinux-2017.02.01-dual.iso
```

For keyboard support it is necessary to open /etc/mkinitcpio.conf and edit the following line:

```
MODULES="atkbd i8042"
```

The resulting `arch.img` is a bootable disk image for v86.
