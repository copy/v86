#!/bin/env bash
set -ve

if [ $(id -u) != "0" ]
then
    echo "Please run as root"
    exit 1
fi

OUTFILE=$(dirname "$0")/../../build/debian-bench.img
CONTAINER_NAME=debian-bench

dd if=/dev/zero of=$OUTFILE bs=1k count=600k

(
echo o # Create a new empty DOS partition table
echo n # Add a new partition
echo p # Primary partition
echo 1 # Partition number
echo 2048 # First sector
echo   # Last sector (Accept default: varies)
echo a # make bootable
echo w # Write changes
echo q # quit
) | fdisk $OUTFILE

# 1048576 is 2048 (first sector) * 512 (sector size)
mkfs.ext4 -F -E offset=1048576 $OUTFILE

kpartx -a -v $OUTFILE
function finish_kpartx {
    kpartx -d $OUTFILE
}
trap finish_kpartx EXIT

# XXX: Assumes loop0

mount /dev/mapper/loop0p1 /mnt
function finish_mount {
    umount /mnt
    finish_kpartx
}
trap finish_mount EXIT

docker export $CONTAINER_NAME | tar -xvC /mnt/

grub-install --recheck --target=i386-pc --locales= --themes= --fonts= --root-directory /mnt/ /dev/loop0

cat > /mnt/boot/grub/grub.cfg << 'EOF'
set root='hd0' # XXX: I believe this has no significance, but is required to exist by grub

set timeout_style=menu
set timeout=0

menuentry 'Linux' {
    #insmod ext2
    #insmod gzio
    #insmod fat
    set root='hd0,msdos1'

    echo      'Loading Linux linux ...'
    linux    /vmlinuz rw root=/dev/sda1 rootfstype=ext4 init=/bin/systemd
    #linux    /boot/vmlinuz debug verbose rw root=/dev/sda1 rootfstype=ext4
    #linux     /boot/vmlinuz-virthardened nosplash debug verbose rw root=/dev/sda1 rootfstype=ext4

    echo      'Loading initial ramdisk ...'
    initrd   /initrd.img
    #initrd   /boot/initramfs-vanilla
    #initrd    /boot/initramfs-virthardened
}
EOF

echo $OUTFILE created.
