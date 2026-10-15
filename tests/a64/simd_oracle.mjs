#!/usr/bin/env node
// AdvSIMD (integer and FP, vector and scalar), the SIMD&FP loads, stores and
// moves against QEMU (docs/arm64-virt-android16-plan.md P2.5, P2.7, P2.8: at
// least 1,500 cases, 0 differences; tests/a64/vector_oracle.mjs makes and
// runs the cases, FPCR random per case).
//
//   node tests/a64/simd_oracle.mjs [--cases N] [--seed S] [--filter class|mnemonic]
import { options, run } from "./vector_oracle.mjs";

const SIMD = ["table", "permute", "extract", "copy", "three_same", "three_different", "two_misc", "across",
    "modified_immediate", "shift_immediate", "indexed", "scalar_copy", "scalar_three_same", "scalar_three_different",
    "scalar_two_misc", "scalar_pairwise", "scalar_shift_immediate", "scalar_indexed", "structure", "memory"];
const { differences } = await run({ name: "simd", classes: SIMD, ...options({ cases: 8000 }) });
process.exit(differences ? 1 : 0);
