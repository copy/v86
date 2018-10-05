#!/usr/bin/env bash
set -veu

if [ $(id -u) != "0" ]
then
    echo "Please run as root"
    exit 1
fi

OUT_ROOTFS=$(dirname "$0")/../../images/debian-9p-rootfs
OUT_ROOTFS_FLAT=$(dirname "$0")/../../images/debian-9p-rootfs-flat
OUT_FSJSON=$(dirname "$0")/../../images/debian-base-fs.json
CONTAINER_NAME=debian-full

rm -rf $OUT_ROOTFS/ && mkdir $OUT_ROOTFS/
docker export $CONTAINER_NAME | tar -xvC $OUT_ROOTFS/

$(dirname "$0")/../../tools/fs2json.py --out $OUT_FSJSON $OUT_ROOTFS/
chmod 644 $OUT_FSJSON

# Note: Not deleting old files here
$(dirname "$0")/../../tools/copy-to-sha256.py $OUT_ROOTFS $OUT_ROOTFS_FLAT

#find $OUT_ROOTFS/ -type d -exec chmod 755 {} ";"
#find $OUT_ROOTFS/ -type f -exec chmod 644 {} ";"

echo $OUT_ROOTFS and $OUT_ROOTFS_FLAT created.
