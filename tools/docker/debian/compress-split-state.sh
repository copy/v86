#!/bin/bash

OUTPUT_FILE="../../../images/debian-state-base.bin"
SPLIT_SIZE="20M"

rm -f "${OUTPUT_FILE}.part"*

zstd -19 "$OUTPUT_FILE" -o "${OUTPUT_FILE}".zst

split -b "$SPLIT_SIZE" "${OUTPUT_FILE}.zst" "${OUTPUT_FILE}.zst.part"

i=1
for f in "${OUTPUT_FILE}.zst.part"* ; do
    mv "$f" "${OUTPUT_FILE}.zst.part$i"
    echo "Created ${OUTPUT_FILE}.zst.part$i"
    ((i++))
done