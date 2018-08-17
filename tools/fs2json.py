#!/usr/bin/env python

import argparse
import json
import os
import stat
import sys
import itertools
import logging
import hashlib

VERSION = 3

IDX_NAME = 0
IDX_SIZE = 1
IDX_MTIME = 2
IDX_MODE = 3
IDX_UID = 4
IDX_GID = 5

# target for symbolic links
# child nodes for directories
# sha256 for files
IDX_TARGET = 6
IDX_SHA256 = 6


def hash_file(filename):
    h = hashlib.sha256()
    with open(filename, "rb", buffering=0) as f:
        for b in iter(lambda : f.read(128*1024), b""):
            h.update(b)
    return h.hexdigest()


def main():
    logging.basicConfig(format="%(message)s")
    logger = logging.getLogger("fs2json")
    logger.setLevel(logging.DEBUG)

    args = argparse.ArgumentParser(description="Create filesystem JSON. Example:\n"
                                               "    ./fs2xml.py --exclude /boot/ --out fs.json /mnt/",
                                   formatter_class=argparse.RawTextHelpFormatter
                                  )
    args.add_argument("--exclude",
                      action="append",
                      metavar="path",
                      help="Path to exclude (relative to base path). Can be specified multiple times.")
    args.add_argument("--out",
                      metavar="out",
                      nargs="?",
                      type=argparse.FileType("w"),
                      help="File to write to (defaults to stdout)",
                      default=sys.stdout)
    args.add_argument("path",
                      metavar="path",
                      help="Base path to include in JSON")

    args = args.parse_args()

    path = os.path.normpath(args.path)
    path = path + "/"
    exclude = args.exclude or []
    exclude = [os.path.join("/", os.path.normpath(p)) for p in exclude]
    exclude = set(exclude)

    def onerror(oserror):
        logger.warning(oserror)

    rootdepth = path.count("/")
    files = os.walk(path, onerror=onerror)
    prevpath = []

    mainroot = []
    result = {
        "fsroot": mainroot,
        "version": VERSION,
        "size": 0,
    }
    rootstack = [mainroot]

    def make_node(st, name):
        obj = [None] * 7

        obj[IDX_NAME] = name
        obj[IDX_SIZE] = st.st_size
        obj[IDX_MTIME] = int(st.st_mtime)
        obj[IDX_MODE] = int(st.st_mode)

        obj[IDX_UID] = st.st_uid
        obj[IDX_GID] = st.st_gid

        result["size"] += st.st_size

        # Missing:
        #     int(st.st_atime),
        #     int(st.st_ctime),

        return obj

    logger.info("Creating file tree ...")

    for f in files:
        dirpath, dirnames, filenames = f
        pathparts = dirpath.split("/")
        pathparts = pathparts[rootdepth:]
        fullpath = os.path.join("/", *pathparts)

        if fullpath in exclude:
            dirnames[:] = []
            continue

        depth = 0
        for this, prev in zip(pathparts, prevpath):
            if this != prev:
                break
            depth += 1

        for name in prevpath[depth:]:
            rootstack.pop()

        oldroot = rootstack[-1]

        assert len(pathparts[depth:]) == 1
        openname = pathparts[-1]

        if openname == "":
            root = mainroot
        else:
            root = []
            st = os.stat(dirpath)
            rootobj = make_node(st, openname)
            rootobj[IDX_TARGET] = root
            oldroot.append(rootobj)

        rootstack.append(root)

        for filename in itertools.chain(filenames, dirnames):
            absname = os.path.join(dirpath, filename)

            st = os.lstat(absname)
            isdir = stat.S_ISDIR(st.st_mode)
            islink = stat.S_ISLNK(st.st_mode)

            isfile = stat.S_ISREG(st.st_mode)

            if isdir and not islink:
                continue

            obj = make_node(st, filename)

            if islink:
                target = os.readlink(absname)
                obj[IDX_TARGET] = target
            elif isfile:
                obj[IDX_SHA256] = hash_file(absname)

            while obj[-1] is None:
                obj.pop()

            root.append(obj)

        prevpath = pathparts

    logger.info("Creating json ...")

    json.dump(result, args.out, check_circular=False, separators=(',', ':'))

if __name__ == "__main__":
    main()
