#!/usr/bin/env node
// Scalar FP against QEMU (docs/arm64-virt-android16-plan.md P2.6: results and
// FPSR bit for bit under all 16 combinations of RMode, FZ and DN; AHP random).
// Each mnemonic's cases cycle through the combinations (tests/a64/vector_oracle.mjs
// makes and runs the cases).
//
//   node tests/a64/fp_oracle.mjs [--cases N] [--seed S] [--filter class|mnemonic]
import { options, run } from "./vector_oracle.mjs";

const FP = ["fp_fixed", "fp_int", "fp_dp1", "fp_compare", "fp_imm", "fp_cond_compare", "fp_dp2", "fp_cond_select", "fp_dp3"];
// (the round-th case of a mnemonic: combination round mod 16 of RMode, FZ, DN; AHP from the next bit)
const fpcr = (n, r) => BigInt(r & 3) << 22n | BigInt(r >> 2 & 1) << 24n | BigInt(r >> 3 & 1) << 25n | BigInt(r >> 4 & 1) << 26n;
const { differences } = await run({ name: "fp", classes: FP, fpcr, ...options({ cases: 4800 }) });
process.exit(differences ? 1 : 0);
