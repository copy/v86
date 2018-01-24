#!/usr/bin/env bash
set -e
mkdir -p images
(cd images && curl --compressed -OOOOOOOOOO https://copy.sh/v86/images/{linux.iso,linux3.iso,kolibri.img,windows101.img,os8.dsk,freedos722.img,openbsd.img,oberon.dsk,oberon-boot.dsk})
make build/libv86.js useacpi=true
tests/full/run.js
