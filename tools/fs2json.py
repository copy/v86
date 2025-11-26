#!/usr/bin/env python3

# Note:
# - Hardlinks are copied
# - The size of symlinks and directories is meaningless, it depends on whatever
#   the filesystem/tar file reports

import argparse
import json
import os
import stat
import sys
import itertools
import logging
import hashlib
import tarfile

VERSION = 3

IDX_NAME = 0
IDX_SIZE = 1
IDX_MTIME = 2
IDX_MODE = 3
IDX_UID = 4
IDX_GID = 5

# target for symbolic links
# child nodes for directories
# filename for files
IDX_TARGET = 6
IDX_FILENAME = 6

HASH_LENGTH = 8

S_IFLNK = 0xA000
S_IFREG = 0x8000
S_IFDIR = 0x4000

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
    logger = logging.getLogger("fs2json")
    logger.setLevel(logging.DEBUG)

    args = argparse.ArgumentParser(description="Create filesystem JSON. Example:\n"
                                               "    ./fs2json.py --exclude /boot/ --out fs.json /mnt/",
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
                      metavar="path-or-tar",
                      help="Base path or tar file to include in JSON")
    args.add_argument("--zstd", action="store_true",
                      help="Use Zstandard compression")

    args = args.parse_args()

    path = os.path.normpath(args.path)

    if os.path.isfile(path):
        tar = tarfile.open(path, "r")
    else:
        tar = None

    if tar:
        (root, total_size) = handle_tar(logger, tar, args.zstd)
    else:
        (root, total_size) = handle_dir(logger, path, args.exclude, args.zstd)

    if False:
        # normalize the order of children, useful to debug differences between
        # the tar and filesystem reader
        def sort_children(children):
            for c in children:
                if isinstance(c[IDX_TARGET], list):
                    sort_children(c[IDX_TARGET])
            children.sort()

        sort_children(root)

    result = {
        "fsroot": root,
        "version": VERSION,
        "size": total_size,
    }

    logger.info("Creating json ...")
    json.dump(result, args.out, check_circular=False, separators=(',', ':'))

def handle_dir(logger, path, exclude, use_compression):
    path = path + "/"
    exclude = exclude or []
    exclude = [os.path.join("/", os.path.normpath(p)) for p in exclude]
    exclude = set(exclude)

    def onerror(oserror):
        logger.warning(oserror)

    rootdepth = path.count("/")
    files = os.walk(path, onerror=onerror)
    prevpath = []

    mainroot = []
    filename_to_hash = {}
    total_size = 0
    rootstack = [mainroot]

    def make_node(st, name):
        obj = [None] * 7

        obj[IDX_NAME] = name
        obj[IDX_SIZE] = st.st_size
        obj[IDX_MTIME] = int(st.st_mtime)
        obj[IDX_MODE] = int(st.st_mode)

        obj[IDX_UID] = st.st_uid
        obj[IDX_GID] = st.st_gid

        nonlocal total_size
        total_size += st.st_size

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

        for _name in prevpath[depth:]:
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
                file_hash = hash_file(absname)
                filename = file_hash[0:HASH_LENGTH] + (".bin.zst" if use_compression else ".bin")
                existing = filename_to_hash.get(filename)
                assert existing is None or existing == file_hash, "Collision in short hash (%s and %s)" % (existing, file_hash)
                filename_to_hash[filename] = file_hash
                obj[IDX_FILENAME] = filename

            while obj[-1] is None:
                obj.pop()

            root.append(obj)

        prevpath = pathparts

    return (mainroot, total_size)

def handle_tar(logger, tar, use_compression):
    mainroot = []
    filename_to_hash = {}
    total_size = 0

    for member in tar.getmembers():
        parts = member.name.split("/")
        name = parts.pop()

        dir = mainroot

        for p in parts:
            for c in dir:
                if c[IDX_NAME] == p:
                    dir = c[IDX_TARGET]

        obj = [None] * 7
        obj[IDX_NAME] = name
        obj[IDX_SIZE] = member.size
        obj[IDX_MTIME] = member.mtime
        obj[IDX_MODE] = member.mode
        obj[IDX_UID] = member.uid
        obj[IDX_GID] = member.gid

        if member.isfile() or member.islnk():
            obj[IDX_MODE] |= S_IFREG
            f = tar.extractfile(member)
            file_hash = hash_fileobj(f)
            filename = file_hash[0:HASH_LENGTH] + (".bin.zst" if use_compression else ".bin")
            existing = filename_to_hash.get(filename)
            assert existing is None or existing == file_hash, "Collision in short hash (%s and %s)" % (existing, file_hash)
            filename_to_hash[filename] = file_hash
            obj[IDX_FILENAME] = filename
            if member.islnk():
                # fix size for hard links
                f.seek(0, os.SEEK_END)
                obj[IDX_SIZE] = int(f.tell())
        elif member.isdir():
            obj[IDX_MODE] |= S_IFDIR
            obj[IDX_TARGET] = []
        elif member.issym():
            obj[IDX_MODE] |= S_IFLNK
            obj[IDX_TARGET] = member.linkname
        else:
            logger.error("Unsupported type: {} ({})".format(member.type, name))

        total_size += obj[IDX_SIZE]

        while obj[-1] is None:
            obj.pop()

        dir.append(obj)

    return mainroot, total_size


if __name__ == "__main__":
    main()
