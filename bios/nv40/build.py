#!/usr/bin/env python3
"""Build the G0 NV40 probe ROM from a pinned, unmodified SeaBIOS checkout.

Requires an ELF x86 GCC/binutils toolchain, make and a host C compiler.
Example: python3 bios/nv40/build.py --seabios /path/to/seabios --cross-prefix x86_64-elf-
Compiler overrides CC, AS, LD, OBJCOPY, OBJDUMP, STRIP and HOSTCC are respected.
Builds in a temporary directory; never modifies the supplied checkout.
"""
import argparse
import hashlib
import io
import os
import re
from pathlib import Path
import subprocess
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[2]
COMMIT = "ea1b7a0733906b8425d948ae94fba63c32b1d425"  # rel-1.16.2


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seabios", type=Path, default=ROOT / "bios/seabios")
    parser.add_argument("--cross-prefix", default=os.environ.get("CROSS_PREFIX", ""))
    parser.add_argument("--output", type=Path, default=ROOT / "bios/vgabios-geforce6800.bin")
    args = parser.parse_args()
    source = args.seabios.resolve()
    commit = subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD"], text=True).strip()
    if commit != COMMIT:
        raise SystemExit("Expected SeaBIOS rel-1.16.2 (" + COMMIT + "), got " + commit)
    archive = subprocess.check_output(["git", "-C", str(source), "archive", COMMIT])
    with tempfile.TemporaryDirectory(prefix="v86-nv40-") as directory:
        build = Path(directory)
        with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
            tar.extractall(build, filter="data")
        (build / ".version").write_text("rel-1.16.2\n")
        entry = build / "vgasrc/vgaentry.S"
        text = entry.read_text()
        marker = '        .asciz "IBM"'
        if text.count(marker) != 1:
            raise SystemExit("Unexpected SeaVGABIOS ROM header")
        entry.write_text(text.replace(marker, marker + '\n#include "nv40-tables.S"'))
        (build / "vgasrc/nv40-tables.S").write_bytes((Path(__file__).parent / "tables.S").read_bytes())
        for name in ["nv40.c", "nv40.h"]:
            (build / "vgasrc" / name).write_bytes((Path(__file__).parent / name).read_bytes())
        hardware = build / "vgasrc/vgahw.h"
        dispatch = hardware.read_text().replace('#include "types.h"', '#include "nv40.h"\n#include "types.h"')
        hooks = {"find_mode": "mode", "set_mode": "vmode_g, flags", "list_modes": "seg, dest, last", "setup": "",
                 "get_window": "vmode_g, window", "set_window": "vmode_g, window, val",
                 "get_linelength": "vmode_g", "set_linelength": "vmode_g, val",
                 "get_displaystart": "vmode_g", "set_displaystart": "vmode_g, val",
                 "get_dacformat": "vmode_g", "set_dacformat": "vmode_g, val", "save_restore": "cmd, seg, data"}
        for name, arguments in hooks.items():
            pattern = r'(static inline [^{]+?vgahw_' + name + r'\([^{}]*\)\s*\{)'
            dispatch, count = re.subn(pattern, lambda match: match[1] + '\n    return nv40_' + name + '(' + arguments + ');', dispatch)
            if count != 1:
                raise SystemExit("Unexpected SeaVGABIOS hardware hook " + name)
        hardware.write_text(dispatch)
        with (build / "Makefile").open("a") as makefile:
            makefile.write("\nSRCVGA += vgasrc/nv40.c\n")
        (build / ".config").write_text("""CONFIG_QEMU=y
CONFIG_VGA_STANDARD_VGA=y
CONFIG_VGA_PCI=y
CONFIG_OVERRIDE_PCI_ID=y
CONFIG_VGA_VID=0x10de
CONFIG_VGA_DID=0x0045
CONFIG_DEBUG_LEVEL=0
""")
        command = ["make", "CROSS_PREFIX=" + args.cross_prefix, "PYTHON=python3", "EXTRAVERSION=-v86-nv40"]
        for name in ["CC", "AS", "LD", "OBJCOPY", "OBJDUMP", "STRIP", "HOSTCC", "CPP"]:
            if name in os.environ:
                command.append(name + "=" + os.environ[name])
        if "CPP" not in os.environ:
            command.append("CPP=" + args.cross_prefix + "cpp")
        log_path = ROOT / "build/nv40-bios-build.log"
        log_path.parent.mkdir(parents=True, exist_ok=True)
        with log_path.open("wb") as log:
            for target in ["olddefconfig", "out/vgabios.bin"]:
                result = subprocess.run(command + [target], cwd=build, stdout=log, stderr=subprocess.STDOUT)
                if result.returncode:
                    raise SystemExit("SeaVGABIOS build failed; see " + str(log_path))
        rom = bytearray((build / "out/vgabios.bin").read_bytes())
        bit = rom.index(b"\xff\xb8BIT\0")
        rom[bit + 11] = -sum(rom[bit:bit + 12]) & 255
        rom[6] = 0
        rom[6] = -sum(rom[:rom[2] * 512]) & 255
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_bytes(rom)
        print(str(args.output) + " " + str(len(rom)) + " bytes sha256=" + hashlib.sha256(rom).hexdigest())


if __name__ == "__main__":
    main()
