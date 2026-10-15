#!/usr/bin/env node
// The FP, AdvSIMD and crypto cases on real arm64 hardware (docs/arm64-virt-android16-plan.md
// P2.12): the owner's Mac (Apple M1 Pro: AES, PMULL, SHA1, SHA256) runs the
// cases of simd_oracle, fp_oracle and crypto_oracle natively (the same
// seeds; FPCR set per case, the 16 RMode/FZ/DN combinations per mnemonic for
// scalar FP) and v86 must match it bit for bit: the third oracle beside
// QEMU and the .ref files. The host has more features than profile v1; the
// cases use v1's encodings only.
//
//   node tests/a64/native_oracle.mjs [--cases N] [--seed S] [--filter class|mnemonic]
import { options, run } from "./vector_oracle.mjs";

const opts = options({ cases: 8000 });
let differences = 0;
differences += (await run({ name: "native-simd", against: "native", classes: ["table", "permute", "extract", "copy", "three_same",
    "three_different", "two_misc", "across", "modified_immediate", "shift_immediate", "indexed", "scalar_copy", "scalar_three_same",
    "scalar_three_different", "scalar_two_misc", "scalar_pairwise", "scalar_shift_immediate", "scalar_indexed", "structure", "memory"], ...opts })).differences;
const fpcr = (n, r) => BigInt(r & 3) << 22n | BigInt(r >> 2 & 1) << 24n | BigInt(r >> 3 & 1) << 25n | BigInt(r >> 4 & 1) << 26n;
differences += (await run({ name: "native-fp", against: "native", fpcr, classes: ["fp_fixed", "fp_int", "fp_dp1", "fp_compare", "fp_imm",
    "fp_cond_compare", "fp_dp2", "fp_cond_select", "fp_dp3"], ...opts, cases: Math.ceil(opts.cases * 0.6) })).differences;
differences += (await run({ name: "native-crypto", against: "native", classes: ["aes", "sha3", "sha2", "three_different"],
    mnemonics: ["aese", "aesd", "aesmc", "aesimc", "sha1c", "sha1p", "sha1m", "sha1su0", "sha256h", "sha256h2", "sha256su1", "sha1h",
        "sha1su1", "sha256su0", "pmull", "pmull2"], ...opts, cases: Math.ceil(opts.cases * 0.2) })).differences;
process.exit(differences ? 1 : 0);
