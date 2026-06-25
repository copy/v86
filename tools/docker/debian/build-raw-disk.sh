#!/usr/bin/env bash
set -veu

# Use 'dirname' so this script works from any folder
IMAGES="$(dirname "$0")"/../../../images
OUT_ROOTFS_TAR="$IMAGES"/debian-rootfs.tar
OUT_IMG="$IMAGES"/debian.img
OUT_CHUNKS="$IMAGES"/debian-chunks
CONTAINER_NAME=debian-xfce-build
IMAGE_NAME=local/debian-xfce-v86

mkdir -p "$IMAGES"

echo "Building Docker image..."
# &> redirects all output to a log file to keep your terminal clean
docker build . -f Dockerfile-raw-disk --platform linux/386 --rm --tag "$IMAGE_NAME" &> build.log

echo "Exporting filesystem..."
docker rm "$CONTAINER_NAME" || true
docker create --platform linux/386 --name "$CONTAINER_NAME" "$IMAGE_NAME"
docker export "$CONTAINER_NAME" > "$OUT_ROOTFS_TAR"

echo "Creating ext4 disk image..."
truncate -s 5G "$OUT_IMG"
mkfs.ext4 -F "$OUT_IMG"

echo "Mounting and transferring files..."
mkdir -p mnt
sudo mount "$OUT_IMG" mnt
sudo tar -xf "$OUT_ROOTFS_TAR" -C mnt

echo "Extracting kernel and initrd for v86 boot..."
cp mnt/boot/vmlinuz-* "$IMAGES"/bzImage
cp mnt/boot/initrd.img-* "$IMAGES"/initrd

sudo umount mnt
rm -rf mnt

echo "Splitting image into 128KB chunks..."
rm -rf "$OUT_CHUNKS"
mkdir -p "$OUT_CHUNKS"
python3 ../../split-image.py --zstd 128k "$OUT_IMG" "$OUT_CHUNKS/chunk-%d-%d"

echo "Done. Artifacts created at $IMAGES"
echo "Chunks are ready in $OUT_CHUNKS"