#!/usr/bin/env node
// The crypto extension against QEMU and known answers
// (docs/arm64-virt-android16-plan.md P2.11): AESE/AESD/AESMC/AESIMC,
// SHA1C/P/M/H/SU0/SU1, SHA256H/H2/SU0/SU1 and PMULL/PMULL2 (8- and 64-bit) as
// random single-instruction cases (tests/a64/vector_oracle.mjs), then a
// guest that computes FIPS-197's AES-128 example (encrypt and decrypt), the
// FIPS 180-4 digests of "abc" (SHA-1, SHA-256) and the tag of GCM test case 2
// (AES-128 and GHASH through PMULL) with the instructions, on QEMU and v86.
//
//   node tests/a64/crypto_oracle.mjs [--cases N] [--seed S] [--filter mnemonic]
import assert from "node:assert/strict";
import fs from "node:fs";
import { options, run } from "./vector_oracle.mjs";
import { build, reference, actual, root } from "./guest_runner.mjs";

const MNEMONICS = ["aese", "aesd", "aesmc", "aesimc", "sha1c", "sha1p", "sha1m", "sha1su0", "sha256h", "sha256h2", "sha256su1",
    "sha1h", "sha1su1", "sha256su0", "pmull", "pmull2"];
const { differences } = await run({ name: "crypto", classes: ["aes", "sha3", "sha2", "three_different"], mnemonics: MNEMONICS,
    ...options({ cases: 1600 }) });

const KAT = String.raw`#include <a64.h>
#include <stdio.h>
#include <arm_neon.h>

static void print(const char *name, const uint8_t *bytes, int count)
{
    printf("%s ", name);
    for(int i = 0; i < count; i++) printf("%02x", bytes[i]);
    printf("\n");
}

// ---- AES-128 (FIPS-197 appendix C.1); SubWord through AESE: every column the same word, so ShiftRows does nothing
static uint32_t sub_word(uint32_t w)
{
    uint8x16_t v = vreinterpretq_u8_u32(vdupq_n_u32(w));
    return vgetq_lane_u32(vreinterpretq_u32_u8(vaeseq_u8(v, vdupq_n_u8(0))), 0);
}
static void expand(const uint8_t key[16], uint8x16_t rk[11], uint8x16_t dk[11])
{
    uint32_t w[44];
    static const uint8_t rcon[10] = { 1, 2, 4, 8, 16, 32, 64, 128, 0x1b, 0x36 };
    for(int i = 0; i < 4; i++) w[i] = key[4 * i] | key[4 * i + 1] << 8 | key[4 * i + 2] << 16 | (uint32_t)key[4 * i + 3] << 24;
    for(int i = 4; i < 44; i++)
    {
        uint32_t t = w[i - 1];
        if(i % 4 == 0) t = sub_word(t >> 8 | t << 24) ^ rcon[i / 4 - 1];
        w[i] = w[i - 4] ^ t;
    }
    for(int r = 0; r < 11; r++) rk[r] = vreinterpretq_u8_u32(vld1q_u32(&w[4 * r]));
    dk[0] = rk[10];
    for(int r = 1; r < 10; r++) dk[r] = vaesimcq_u8(rk[10 - r]);
    dk[10] = rk[0];
}
static uint8x16_t encrypt(uint8x16_t s, const uint8x16_t rk[11])
{
    for(int r = 0; r < 9; r++) s = vaesmcq_u8(vaeseq_u8(s, rk[r]));
    return veorq_u8(vaeseq_u8(s, rk[9]), rk[10]);
}
static uint8x16_t decrypt(uint8x16_t s, const uint8x16_t dk[11])
{
    for(int r = 0; r < 9; r++) s = vaesimcq_u8(vaesdq_u8(s, dk[r]));
    return veorq_u8(vaesdq_u8(s, dk[9]), dk[10]);
}

// ---- SHA-256 and SHA-1 of "abc" (one padded block)
static const uint32_t K256[64] = {
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
};
static void block_abc(uint8_t block[64])
{
    for(int i = 0; i < 64; i++) block[i] = 0;
    block[0] = 'a', block[1] = 'b', block[2] = 'c', block[3] = 0x80, block[63] = 24;
}
static void sha256(uint8_t digest[32])
{
    uint8_t block[64];
    block_abc(block);
    uint32x4_t msg[4];
    for(int i = 0; i < 4; i++) msg[i] = vreinterpretq_u32_u8(vrev32q_u8(vld1q_u8(block + 16 * i)));
    uint32x4_t s0 = { 0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a }, s1 = { 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19 };
    uint32x4_t a = s0, b = s1;
    for(int g = 0; g < 16; g++)
    {
        uint32x4_t w = vaddq_u32(msg[g % 4], vld1q_u32(&K256[4 * g]));
        if(g < 12) msg[g % 4] = vsha256su1q_u32(vsha256su0q_u32(msg[g % 4], msg[(g + 1) % 4]), msg[(g + 2) % 4], msg[(g + 3) % 4]);
        uint32x4_t t = a;
        a = vsha256hq_u32(a, b, w);
        b = vsha256h2q_u32(b, t, w);
    }
    a = vaddq_u32(a, s0), b = vaddq_u32(b, s1);
    vst1q_u8(digest, vrev32q_u8(vreinterpretq_u8_u32(a)));
    vst1q_u8(digest + 16, vrev32q_u8(vreinterpretq_u8_u32(b)));
}
static void sha1(uint8_t digest[20])
{
    uint8_t block[64];
    block_abc(block);
    uint32x4_t msg[4];
    for(int i = 0; i < 4; i++) msg[i] = vreinterpretq_u32_u8(vrev32q_u8(vld1q_u8(block + 16 * i)));
    uint32x4_t abcd = { 0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476 }, start = abcd;
    uint32_t e = 0xc3d2e1f0, e_start = e;
    static const uint32_t k[4] = { 0x5a827999, 0x6ed9eba1, 0x8f1bbcdc, 0xca62c1d6 };
    for(int g = 0; g < 20; g++)
    {
        uint32x4_t w = vaddq_u32(msg[g % 4], vdupq_n_u32(k[g / 5]));
        uint32_t next = vsha1h_u32(vgetq_lane_u32(abcd, 0));
        if(g < 5) abcd = vsha1cq_u32(abcd, e, w);
        else if(g < 10 || g >= 15) abcd = vsha1pq_u32(abcd, e, w);
        else abcd = vsha1mq_u32(abcd, e, w);
        e = next;
        if(g < 16) msg[g % 4] = vsha1su1q_u32(vsha1su0q_u32(msg[g % 4], msg[(g + 1) % 4], msg[(g + 2) % 4]), msg[(g + 3) % 4]);
    }
    abcd = vaddq_u32(abcd, start);
    e += e_start;
    vst1q_u8(digest, vrev32q_u8(vreinterpretq_u8_u32(abcd)));
    for(int i = 0; i < 4; i++) digest[16 + i] = e >> (24 - 8 * i);
}

// ---- GHASH through PMULL (bits reflected within each byte: bit i of the integer is x^i)
static uint8x16_t gf_multiply(uint8x16_t x_block, uint8x16_t h_block)
{
    uint64x2_t x = vreinterpretq_u64_u8(vrbitq_u8(x_block)), h = vreinterpretq_u64_u8(vrbitq_u8(h_block));
    poly64_t x0 = vgetq_lane_u64(x, 0), x1 = vgetq_lane_u64(x, 1), h0 = vgetq_lane_u64(h, 0), h1 = vgetq_lane_u64(h, 1);
    uint64x2_t low = vreinterpretq_u64_p128(vmull_p64(x0, h0)), high = vreinterpretq_u64_p128(vmull_p64(x1, h1));
    uint64x2_t mid = veorq_u64(vreinterpretq_u64_p128(vmull_p64(x0, h1)), vreinterpretq_u64_p128(vmull_p64(x1, h0)));
    uint64_t p0 = vgetq_lane_u64(low, 0), p1 = vgetq_lane_u64(low, 1) ^ vgetq_lane_u64(mid, 0);
    uint64_t p2 = vgetq_lane_u64(high, 0) ^ vgetq_lane_u64(mid, 1), p3 = vgetq_lane_u64(high, 1);
    // (x^128 = x^7 + x^2 + x + 1: fold p3:p2 down twice)
    uint64x2_t r = vreinterpretq_u64_p128(vmull_p64(p2, 0x87)), s = vreinterpretq_u64_p128(vmull_p64(p3, 0x87));
    uint64_t t0 = vgetq_lane_u64(r, 0), t1 = vgetq_lane_u64(r, 1) ^ vgetq_lane_u64(s, 0), t2 = vgetq_lane_u64(s, 1);
    uint64_t u = vgetq_lane_u64(vreinterpretq_u64_p128(vmull_p64(t2, 0x87)), 0);
    uint64x2_t result = { p0 ^ t0 ^ u, p1 ^ t1 };
    return vrbitq_u8(vreinterpretq_u8_u64(result));
}

int main(int argc, char **argv)
{
    (void)argc, (void)argv;
    uint8_t key[16], plain[16], out[32];
    for(int i = 0; i < 16; i++) key[i] = i, plain[i] = 0x11 * i;
    uint8x16_t rk[11], dk[11];
    expand(key, rk, dk);
    uint8x16_t cipher = encrypt(vld1q_u8(plain), rk);
    vst1q_u8(out, cipher);
    print("aes128-encrypt", out, 16);
    vst1q_u8(out, decrypt(cipher, dk));
    print("aes128-decrypt", out, 16);
    sha256(out);
    print("sha256-abc", out, 32);
    sha1(out);
    print("sha1-abc", out, 20);
    // GCM test case 2: K = 0, P = 0^128, IV = 0^96
    for(int i = 0; i < 16; i++) key[i] = 0;
    expand(key, rk, dk);
    uint8x16_t zero = vdupq_n_u8(0);
    uint8x16_t h = encrypt(zero, rk);
    uint8_t counter[16] = { 0 };
    counter[15] = 1;
    uint8x16_t ey0 = encrypt(vld1q_u8(counter), rk);
    counter[15] = 2;
    uint8x16_t c = encrypt(vld1q_u8(counter), rk);
    uint8_t lengths[16] = { 0 };
    lengths[15] = 128;
    uint8x16_t x = gf_multiply(c, h);
    x = gf_multiply(veorq_u8(x, vld1q_u8(lengths)), h);
    vst1q_u8(out, c);
    print("gcm2-ciphertext", out, 16);
    vst1q_u8(out, veorq_u8(x, ey0));
    print("gcm2-tag", out, 16);
    return 0;
}
`;
const EXPECTED = [
    "aes128-encrypt 69c4e0d86a7b0430d8cdb78070b4c55a",
    "aes128-decrypt 00112233445566778899aabbccddeeff",
    "sha256-abc ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    "sha1-abc a9993e364706816aba3e25717850c26c9cd0d89d",
    "gcm2-ciphertext 0388dace60b6a392f328c2b971b2fe78",
    "gcm2-tag ab6e47d42cec13bdf53a67b21257bddf",
].join("\n") + "\n";

const source = root + "build/a64-crypto-kat.c";
fs.writeFileSync(source, KAT);
const directory = build("crypto-kat", [source]);
let failed = differences ? 1 : 0;
for(const [name, machine] of [["QEMU", reference], ["v86", actual]])
{
    const result = await machine(directory);
    assert.equal(result.status, "ok", name);
    if(result.text === EXPECTED)
    {
        console.log(`known answers (FIPS-197, FIPS 180-4, GCM test case 2): ${name} ok`);
    }
    else
    {
        failed = 1;
        console.log(`known answers on ${name}:\n${result.text}expected:\n${EXPECTED}`);
    }
}
process.exit(failed);
