#!/usr/bin/env bash
set -veuo pipefail

# Use 'dirname' so this script works from any folder
DIR="$(dirname "$0")"
IMAGES="$DIR"/../../../images
OUT_ROOTFS_TAR="$IMAGES"/debian-rootfs.tar
OUT_IMG="$IMAGES"/debian.img
OUT_CHUNKS="$IMAGES"/debian-chunks
MNT="$DIR"/mnt
CONTAINER_NAME=debian-xfce-build
IMAGE_NAME=local/debian-xfce-v86

mkdir -p "$IMAGES"

echo "Building Docker image..."
docker build "$DIR" --platform linux/386 --rm --tag "$IMAGE_NAME"

echo "Exporting filesystem..."
docker rm "$CONTAINER_NAME" || true
docker create --platform linux/386 --name "$CONTAINER_NAME" "$IMAGE_NAME"
docker export "$CONTAINER_NAME" > "$OUT_ROOTFS_TAR"

echo "Creating ext4 disk image..."
truncate -s 5G "$OUT_IMG"
mkfs.ext4 -F "$OUT_IMG"

echo "Mounting and transferring files..."
mkdir -p "$MNT"
sudo mount "$OUT_IMG" "$MNT"
trap 'sudo umount "$MNT"' EXIT
sudo tar -xf "$OUT_ROOTFS_TAR" -C "$MNT"

echo "Extracting kernel and initrd for v86 boot..."
cp "$MNT"/boot/vmlinuz-* "$IMAGES"/debian-bzImage
cp "$MNT"/boot/initrd.img-* "$IMAGES"/debian-initrd

sudo umount "$MNT"
trap - EXIT
rmdir "$MNT"

echo "Splitting image into 128KB chunks..."
rm -rf "$OUT_CHUNKS"
mkdir -p "$OUT_CHUNKS"
python3 "$DIR"/../../split-image.py --zstd 128k "$OUT_IMG" "$OUT_CHUNKS/chunk-%d-%d"

echo "Done. Artifacts created at $IMAGES"
echo "Chunks are ready in $OUT_CHUNKS"
