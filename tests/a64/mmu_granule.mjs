#!/usr/bin/env node
// The 16 and 64 KiB granules (docs/arm64-virt-android16-plan.md P3.4):
// tests/a64/mmu.mjs with every granule, on profile v1.1 (the default since
// P8.6; v1 declares 4 KiB only).
//
//   node tests/a64/mmu_granule.mjs [--cases N] [--seed S]
process.argv.push("--granules", "all");
await import("./mmu.mjs");
