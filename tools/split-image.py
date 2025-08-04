#!/usr/bin/env python3

import sys
import subprocess
import os.path

args = sys.argv

zstd = "--zstd" in args
gzip = "--gzip" in args
if zstd: args.remove("--zstd")
if gzip: args.remove("--gzip")

if len(args) != 4:
    print("Usage: split-image.py [--zstd|--gzip] partsize filename-in filename-out-with-%d-%d")
    exit(1)

(_, partsize_raw, infile, outfile) = sys.argv
partsize_raw = partsize_raw.lower()
if partsize_raw.endswith("m") or partsize_raw.endswith("mb"):
    partsize_base = 1024 * 1024
    partsize_raw = partsize_raw.removesuffix("mb").removesuffix("m")
elif partsize_raw.endswith("k") or partsize_raw.endswith("k"):
    partsize_base = 1024
    partsize_raw = partsize_raw.removesuffix("k").removesuffix("k")
else:
    partsize_base = 1
partsize = partsize_base * int(partsize_raw)

with open(infile, "rb") as f:
    readf = f.read()

size = len(readf)
if len(readf) % partsize != 0:
    print("Warning: size % partsize != 0")

unit = "B"
if size % 1024 == 0: size //= 1024; unit = "kB"
if size % 1024 == 0: size //= 1024; unit = "mB"

print("Size: %d %s, creating %d chunks" % (size, unit, len(readf) / partsize))

try:
    os.mkdir(os.path.dirname(outfile))
except FileExistsError:
    pass

for i in range(0, len(readf), partsize):
    part_name = outfile % (i, i + partsize)
    with open(part_name, "wb") as f:
        chunk = readf[i:i + partsize]
        f.write(chunk)
        if len(chunk) < partsize:
            # last chunk
            f.write(bytes(partsize - len(chunk)))
    if zstd: subprocess.run(["zstd", "-19", "-f", "--rm", part_name], check=True)
    elif gzip: subprocess.run(["gzip", "-9", "-f", part_name], check=True)
