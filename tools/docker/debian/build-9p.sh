#!/usr/bin/env bash
set -veu

# Use 'dirname' so this script works from any folder
IMAGES="$(dirname "$0")"/../../../images
OUT_ROOTFS_TAR="$IMAGES"/debian-9p-rootfs.tar
OUT_ROOTFS_FLAT="$IMAGES"/debian-9p-rootfs-flat
OUT_FSJSON="$IMAGES"/debian-base-fs.json
CONTAINER_NAME=debian-xfce-build
IMAGE_NAME=local/debian-xfce-v86

mkdir -p "$IMAGES"

echo "Building Docker image..."
# &> redirects all output to a log file to keep your terminal clean
docker build . --platform linux/386 --rm --tag "$IMAGE_NAME" &> build.log

echo "Exporting filesystem..."
docker rm "$CONTAINER_NAME" || true
docker create --platform linux/386 --name "$CONTAINER_NAME" "$IMAGE_NAME"

docker export "$CONTAINER_NAME" > "$OUT_ROOTFS_TAR"

echo "Converting to JSON..."
"$(dirname "$0")"/../../../tools/fs2json.py --zstd --out "$OUT_FSJSON" "$OUT_ROOTFS_TAR"

echo "Creating flat filesystem..."
# Clear old files to prevent conflicts
rm -rf "$OUT_ROOTFS_FLAT"
mkdir -p "$OUT_ROOTFS_FLAT"
"$(dirname "$0")"/../../../tools/copy-to-sha256.py --zstd "$OUT_ROOTFS_TAR" "$OUT_ROOTFS_FLAT"

echo "Done. Artifacts created at $IMAGES"