#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
tar -cf - ../../../{*.html,*.js,*.css,gen,lib,src,bios,.cargo,Cargo.toml,Makefile,tools} | \
    docker build -t v86:alpine-3.14 -f tools/docker/exec/Dockerfile -
