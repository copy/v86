#!/usr/bin/env python3

import os
import logging
import stat
import argparse
import hashlib
import shutil
import tarfile

HASH_LENGTH = 8

def hash_file(filename) -> str:
    with open(filename, "rb", buffering=0) as f:
        return hash_fileobj(f)

def hash_fileobj(f) -> str:
    h = hashlib.sha256()
    for b in iter(lambda: f.read(128*1024), b""):
        h.update(b)
    return h.hexdigest()

def main():
    logging.basicConfig(format="%(message)s")
    logger = logging.getLogger("copy")
    logger.setLevel(logging.DEBUG)

    args = argparse.ArgumentParser(description="...",
                                   formatter_class=argparse.RawTextHelpFormatter)
    args.add_argument("from_path", metavar="from", help="from")
    args.add_argument("to_path", metavar="to", help="to")

    args = args.parse_args()

    from_path = os.path.normpath(args.from_path)
    to_path = os.path.normpath(args.to_path)

    if os.path.isfile(from_path):
        tar = tarfile.open(from_path, "r")
    else:
        tar = None

    if tar:
        handle_tar(logger, tar, to_path)
    else:
        handle_dir(logger, from_path, to_path)

def handle_dir(logger, from_path: str, to_path: str):
    def onerror(oserror):
        logger.warning(oserror)

    files = os.walk(from_path, onerror=onerror)

    for f in files:
        dirpath, dirnames, filenames = f

        for filename in filenames:
            absname = os.path.join(dirpath, filename)
            st = os.lstat(absname)
            mode = st.st_mode

            assert not stat.S_ISDIR(mode)
            if stat.S_ISLNK(mode) or stat.S_ISCHR(mode) or stat.S_ISBLK(mode) or stat.S_ISFIFO(mode) or stat.S_ISSOCK(mode):
                continue

            file_hash = hash_file(absname)
            filename = file_hash[0:HASH_LENGTH] + ".bin"
            to_abs = os.path.join(to_path, filename)

            if os.path.exists(to_abs):
                logger.info("Exists, skipped {} ({})".format(to_abs, absname))
            else:
                logger.info("cp {} {}".format(absname, to_abs))
                shutil.copyfile(absname, to_abs)

def handle_tar(logger, tar, to_path: str):
    for member in tar.getmembers():
        if member.isfile() or member.islnk():
            f = tar.extractfile(member)
            file_hash = hash_fileobj(f)
            filename = file_hash[0:HASH_LENGTH] + ".bin"
            to_abs = os.path.join(to_path, filename)

            if os.path.exists(to_abs):
                logger.info("Exists, skipped {} ({})".format(to_abs, member.name))
            else:
                logger.info("Extracted {} ({})".format(to_abs, member.name))
                to_file = open(to_abs, "wb")
                f.seek(0)
                shutil.copyfileobj(f, to_file)


if __name__ == "__main__":
    main()
