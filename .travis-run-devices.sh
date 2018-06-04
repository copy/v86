#!/usr/bin/env bash
set -e
mkdir -p images
(cd images && curl --compressed -O https://copy.sh/v86/images/linux4.iso)
make devices-test
