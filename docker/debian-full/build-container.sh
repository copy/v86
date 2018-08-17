#!/usr/bin/env bash
set -e

docker build . --rm --tag i386/debian-full
docker rm debian-full || true
docker create -t -i --name debian-full i386/debian-full bash
