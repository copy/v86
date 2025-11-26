#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

IMAGES=../../../images
OUT_ROOTFS_TAR="$IMAGES"/alpine-rootfs.tar
OUT_ROOTFS_FLAT="$IMAGES"/alpine-rootfs-flat
OUT_FSJSON="$IMAGES"/alpine-fs.json
CONTAINER_NAME=alpine-v86
IMAGE_NAME=i386/alpine-v86

mkdir -p "$IMAGES"
docker build . --platform linux/386 --rm --tag "$IMAGE_NAME"
docker rm "$CONTAINER_NAME" || true
docker create --platform linux/386 -t -i --name "$CONTAINER_NAME" "$IMAGE_NAME"

docker export "$CONTAINER_NAME" -o "$OUT_ROOTFS_TAR"

# https://github.com/iximiuz/docker-to-linux/issues/19#issuecomment-1242809707
tar -f "$OUT_ROOTFS_TAR" --delete ".dockerenv" || true

../../../tools/fs2json.py --zstd --out "$OUT_FSJSON" "$OUT_ROOTFS_TAR"

# Note: Not deleting old files here
mkdir -p "$OUT_ROOTFS_FLAT"
../../../tools/copy-to-sha256.py --zstd "$OUT_ROOTFS_TAR" "$OUT_ROOTFS_FLAT"

echo "$OUT_ROOTFS_TAR", "$OUT_ROOTFS_FLAT" and "$OUT_FSJSON" created.
