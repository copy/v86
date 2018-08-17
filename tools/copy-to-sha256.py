#!/usr/bin/env python

import os
import logging
import stat
import argparse
import hashlib
import shutil

def hash_file(filename):
    h = hashlib.sha256()
    with open(filename, "rb", buffering=0) as f:
        for b in iter(lambda: f.read(128 * 1024), b""):
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

            sha256 = hash_file(absname)
            to_abs = os.path.join(to_path, sha256)

            if os.path.exists(to_abs):
                logger.info("Exists, skipped {}".format(to_abs))
            else:
                logger.info("cp {} {}".format(absname, to_abs))
                shutil.copyfile(absname, to_abs)

if __name__ == "__main__":
    main()
