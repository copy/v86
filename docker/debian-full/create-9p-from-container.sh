#!/usr/bin/env bash
set -veu

if [ $(id -u) != "0" ]
then
    echo "Please run as root"
    exit 1
fi

OUTFILE=$(dirname "$0")/../../images/debian-9p-boot.img
OUT_ROOTFS=$(dirname "$0")/../../images/debian-9p-rootfs
OUT_ROOTFS_FLAT=$(dirname "$0")/../../images/debian-9p-rootfs-flat
OUT_FSJSON=$(dirname "$0")/../../images/debian-base-fs.json
CONTAINER_NAME=debian-full

# vmlinuz, initrd.img and grub take about 25M as of time of this writing, be on
# the safe side with 64M
dd if=/dev/zero of=$OUTFILE bs=1k count=64k

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

KPARTX_OUTPUT=$(kpartx -a -v $OUTFILE)
echo $KPARTX_OUTPUT
LOOP_PARTITION=$(echo $KPARTX_OUTPUT | grep -o 'loop[0-9]\+p[0-9]\+')
LOOP_DEV=$(echo $LOOP_PARTITION | grep -o 'loop[0-9]\+')
echo $LOOP_PARTITION
echo $LOOP_DEV

function finish_kpartx {
    kpartx -d $OUTFILE
}
trap finish_kpartx EXIT

ls -lah /dev/mapper/$LOOP_PARTITION
mount /dev/mapper/$LOOP_PARTITION /mnt
function finish_mount {
    umount /mnt
    finish_kpartx
}
trap finish_mount EXIT

rm -rf $OUT_ROOTFS/ && mkdir $OUT_ROOTFS/
docker export $CONTAINER_NAME | tar -xvC $OUT_ROOTFS/

$(dirname "$0")/../../tools/fs2json.py --out $OUT_FSJSON $OUT_ROOTFS/
chmod 644 $OUT_FSJSON

# Note: Not deleting old files here
$(dirname "$0")/../../tools/copy-to-sha256.py $OUT_ROOTFS $OUT_ROOTFS_FLAT

#find $OUT_ROOTFS/ -type d -exec chmod 755 {} ";"
#find $OUT_ROOTFS/ -type f -exec chmod 644 {} ";"

cp -r -av $OUT_ROOTFS/boot/ /mnt/boot/
cp -av $OUT_ROOTFS/{initrd*,vmlinuz*} /mnt/


grub-install --recheck --target=i386-pc --locales= --themes= --fonts= --root-directory /mnt/ /dev/$LOOP_DEV

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
    #linux    /vmlinuz rw root=/dev/sda1 rootfstype=ext4 init=/bin/systemd
    linux    /vmlinuz rw init=/bin/systemd root=host9p console=ttyS0
    #linux    /boot/vmlinuz debug verbose rw root=/dev/sda1 rootfstype=ext4

    echo      'Loading initial ramdisk ...'
    initrd   /initrd.img
}
EOF

echo $OUTFILE created.
