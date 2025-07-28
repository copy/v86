# Forge example

This directory contains a minimal Atlassian Forge app that embeds the `v86` WASM PC emulator in a Confluence macro.

The `static/index.html` page loads `libv86.js` from a CDN and starts an instance using the provided BIOS and disk images. See `manifest.yml` for the module definitions.
