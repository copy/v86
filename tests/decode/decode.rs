use super::*;

fn d(bytes: &[u8], mode32: bool) -> DecodedInstruction {
    decode(bytes, GuestEip(0xFFFE), LinearAddress(0x1FFFE), mode32).unwrap()
}

#[test]
fn prefixes_boundaries_and_missing_page() {
    let i = d(&[0x66, 0x66, 0x67, 0x64, 0x65, 0xB8, 0x34, 0x12], true);
    assert_eq!(i.length, 8);
    assert_eq!(i.operand_size, 16);
    assert_eq!(i.address_size, 16);
    assert_eq!(i.prefixes.segment, Some(5));
    assert_eq!(i.immediate, Some(0x1234));
    assert_eq!(i.next_pc, GuestEip(0x10006));
    assert_eq!(
        decode(&[0xB8, 1], GuestEip(4095), LinearAddress(4095), true).unwrap_err(),
        DecodeStop::Incomplete { available: 2 }
    );
    assert_eq!(d(&[0xB8, 1, 2, 3, 4], true).length, 5);
    let mut bytes = vec![0x66; 14];
    bytes.push(0x90);
    assert_eq!(d(&bytes, true).length, 15);
    bytes.insert(0, 0x66);
    assert_eq!(
        decode(&bytes, GuestEip(0), LinearAddress(0), true).unwrap_err(),
        DecodeStop::TooLong
    );
    assert_eq!(
        d(&[0xF3, 0xF2, 0x0F, 0x10, 0xC0], true).encoding.opcode,
        0xF20F10
    );
    // F2/F3 take precedence over 66 (decode_rules::mandatory_variant)
    assert_eq!(
        d(&[0xF2, 0x66, 0x0F, 0x10, 0xC0], true).encoding.opcode,
        0xF20F10
    );
    assert!(d(&[0xF0, 0x01, 0x00], true).prefixes.lock);
    assert!(d(&[0x8D, 0xC0], true).baseline_ud);
    assert_eq!(d(&[0x0F, 0x20, 0x04], true).length, 3); // ignore_mod, no SIB
    assert_eq!(
        d(&[0x9A, 1, 2, 3, 4, 5, 6], true).extra_immediate,
        Some(0x605)
    );
    assert_eq!(d(&[0xC8, 1, 2, 3], true).extra_immediate, Some(3));
}

#[test]
fn prefix_product_and_missing_groups_are_explicit() {
    use crate::decode_rules::{
        apply_prefix, mandatory_variant, Variant, REFINING_ALL, REFINING_REP,
    };
    use crate::prefix::*;
    // The mandatory-prefix rule, against an independent statement of it: the
    // last F2/F3 before 66; a refining prefix (all three in the SSE maps,
    // F2/F3 at MOVBE/CRC32) without a row is #UD, other prefixes are ignored
    // or set the operand size.
    for flags in 0..256u16 {
        let flags = flags as u8;
        if flags & PREFIX_F2 != 0 && flags & PREFIX_F3 != 0 {
            continue; // apply_prefix keeps only the last of the two
        }
        for available in 0..8 {
            let mask = (if available & 1 != 0 { PREFIX_66 } else { 0 })
                | (if available & 2 != 0 { PREFIX_F2 } else { 0 })
                | (if available & 4 != 0 { PREFIX_F3 } else { 0 });
            for refining in [0, REFINING_REP, REFINING_ALL] {
                let rep = flags & (PREFIX_F2 | PREFIX_F3);
                let expected = if rep != 0 && mask & rep != 0 {
                    Variant::Prefixed(rep)
                }
                else if refining & rep != 0 {
                    Variant::Undefined
                }
                else if refining & PREFIX_66 != 0 && flags & PREFIX_66 != 0 {
                    if mask & PREFIX_66 != 0 {
                        Variant::Prefixed(PREFIX_66)
                    }
                    else {
                        Variant::Undefined
                    }
                }
                else {
                    Variant::Plain
                };
                assert_eq!(mandatory_variant(flags, mask, refining), expected);
            }
        }
    }
    // of F2 and F3 the last one counts, in either order
    assert_eq!(
        apply_prefix(apply_prefix(0, 0xF2).unwrap(), 0xF3),
        Some(PREFIX_F3)
    );
    assert_eq!(
        apply_prefix(apply_prefix(0, 0xF3).unwrap(), 0xF2),
        Some(PREFIX_F2)
    );
    for a in [
        0x26, 0x2E, 0x36, 0x3E, 0x64, 0x65, 0x66, 0x67, 0xF0, 0xF2, 0xF3,
    ] {
        for b in [
            0x26, 0x2E, 0x36, 0x3E, 0x64, 0x65, 0x66, 0x67, 0xF0, 0xF2, 0xF3,
        ] {
            for mode in [false, true] {
                let mut bytes = vec![a, b, a, 0x0F, 0x10, 0xC0];
                let decoded = d(&bytes, mode);
                let flags = [a, b, a]
                    .into_iter()
                    .fold(0, |f, p| apply_prefix(f, p).unwrap());
                // 0F 10 has rows for all of 66, F2 and F3
                let expected =
                    match mandatory_variant(flags, PREFIX_66 | PREFIX_F2 | PREFIX_F3, REFINING_ALL)
                    {
                        Variant::Prefixed(PREFIX_66) => 0x660F10,
                        Variant::Prefixed(PREFIX_F2) => 0xF20F10,
                        Variant::Prefixed(PREFIX_F3) => 0xF30F10,
                        variant => {
                            assert_eq!(variant, Variant::Plain);
                            0x0F10
                        },
                    };
                assert_eq!(decoded.encoding.opcode, expected);
                assert!(!decoded.early_ud);
                // No read past the supplied snapshot, including prefix and ModRM boundaries.
                for n in 0..bytes.len() {
                    assert!(matches!(
                        decode(&bytes[..n], GuestEip(4094), LinearAddress(4094), mode),
                        Err(DecodeStop::Incomplete { .. })
                    ));
                }
                bytes[4] = 0x71;
                bytes[5] = 0x00;
                if matches!(decode(&bytes, GuestEip(0),LinearAddress(0),mode),Ok(ref i) if i.encoding.group_ud)
                {
                    let i = d(&bytes, mode);
                    assert!(i.baseline_ud);
                    assert!(i.ea.is_none());
                    assert!(i.immediate.is_none());
                }
            }
        }
    }
    // 66 with F3 is an operand-size prefix: MOVSS, as iced-x86 and XED decode
    assert_eq!(
        d(&[0x66, 0xF3, 0x0F, 0x10, 0xC1], true).encoding.opcode,
        0xF30F10
    );
    assert_eq!(
        d(&[0xF3, 0x66, 0x0F, 0x10, 0xC1], true).encoding.opcode,
        0xF30F10
    );
    // A mandatory prefix without a row: #UD after ModRM, without SIB,
    // displacement or immediate (F3 0F 2B is AMD's MOVNTSS, 66 0F C3 not MOVNTI)
    for bytes in [
        &[0xF3, 0x0F, 0x2B, 0x04, 0x24][..],
        &[0x66, 0x0F, 0xC3, 0x04, 0x24],
        &[0xF2, 0x0F, 0x77],
    ] {
        let i = d(bytes, true);
        assert!(
            i.baseline_ud && i.early_ud && i.ea.is_none(),
            "{bytes:02X?}"
        );
        assert_eq!(
            i.length as usize,
            bytes.len() - if bytes.len() > 3 { 1 } else { 0 },
            "{bytes:02X?}"
        );
    }
    // Outside the SSE maps F2/F3 are plain repeat prefixes
    let i = d(&[0xF3, 0x0F, 0xAF, 0xC1], true);
    assert!(i.encoding.opcode == 0x0FAF && !i.baseline_ud);
    for e in encodings().iter().filter(|e| e.group_ud) {
        let mut bytes = Vec::new();
        if e.opcode > 0xFFFF {
            bytes.push((e.opcode >> 16) as u8);
        }
        if e.opcode > 0xFF {
            bytes.push((e.opcode >> 8) as u8);
        }
        bytes.extend([e.opcode as u8, (e.group as u8) << 3 | 4]);
        let i = d(&bytes, true);
        assert!(i.baseline_ud && i.ea.is_none());
        assert_eq!(
            i.length as usize,
            bytes.len(),
            "missing /g must not fetch SIB/displacement/immediate"
        );
    }
}

#[test]
fn ea_and_wrapping() {
    let gpr = [0xFFFFFFFF, 0x1111, 0x2222, 0xFFFF, 0x100, 0xFFFE, 3, 5];
    let i = d(&[0x8B, 0x44, 0x88, 0xFC], true); // [eax + ecx*4 - 4]
    let ea = i.ea.unwrap();
    assert_eq!(ea.offset(&gpr), 0x443F);
    assert_eq!(ea.segment, 3);
    let i = d(&[0x8B, 0x46, 0x04], false); // [bp+4], 16-bit wrap
    assert_eq!(i.ea.unwrap().offset(&gpr), 2);
    assert_eq!(i.ea.unwrap().segment, 2);
    let i = d(&[0x8B, 0x04, 0xED, 1, 0, 0, 0], true); // [ebp*8 + 1], no base => DS
    assert_eq!(i.ea.unwrap().segment, 3);
    assert_eq!(i.ea.unwrap().offset(&gpr), 0x7FFF1);
    let i = d(&[0x8B, 0x06, 0xFF, 0xFF], false);
    assert_eq!(i.ea.unwrap().offset(&gpr), 65535);
    assert_eq!(i.ea.unwrap().segment, 3);
}

/// The opcode bytes of a catalogue key: mandatory prefix, escapes, opcode
fn catalogue_bytes(opcode: u32) -> Vec<u8> {
    if matches!(opcode >> 8 & 0xFFFF, 0x0F38 | 0x0F3A) {
        let mut bytes = if opcode >> 24 != 0 { vec![(opcode >> 24) as u8] } else { vec![] };
        bytes.extend([0x0F, (opcode >> 8) as u8, opcode as u8]);
        return bytes;
    }
    let mut bytes = Vec::new();
    if opcode > 0xFFFF {
        bytes.push((opcode >> 16) as u8);
    }
    if opcode > 0xFF {
        bytes.push((opcode >> 8) as u8);
    }
    bytes.push(opcode as u8);
    bytes
}

#[test]
fn catalogue_lengths_and_all_modrm_sib_forms() {
    let mut count = 0;
    // (VEX rows: vex_rows_decode_from_their_own_encodings)
    for encoding in encodings().iter().filter(|e| e.vex == 0) {
        for mode32 in [false, true] {
            for m in 0..if encoding.fetch_modrm { 256 } else { 1 } {
                if encoding.group >= 0 && (m >> 3 & 7) != encoding.group as u32 {
                    continue;
                }
                // (LES/LDS with a register ModRM byte: a VEX prefix; TZCNT
                // and LZCNT without their features: BSF and BSR, see
                // tzcnt_and_lzcnt_are_bsf_and_bsr_without_their_features)
                if matches!(encoding.opcode, 0xC4 | 0xC5) && m >= 0xC0
                    || matches!(encoding.opcode, 0xF30FBC | 0xF30FBD) && !encoding.exists()
                {
                    continue;
                }
                let mut bytes = catalogue_bytes(encoding.opcode);
                let op_size32 = mode32 != bytes.contains(&0x66);
                if encoding.fetch_modrm {
                    bytes.push(m as u8);
                }
                // A row whose semantics come later (or whose feature is
                // absent) is #UD right after its ModRM byte
                if encoding.unimplemented || !encoding.exists() {
                    let decoded = d(&bytes, mode32);
                    assert!(
                        decoded.early_ud && decoded.baseline_ud && decoded.ea.is_none(),
                        "{:x} {m:x}",
                        encoding.opcode
                    );
                    assert_eq!(
                        (decoded.encoding.id, decoded.length as usize),
                        (encoding.id, bytes.len()),
                        "{:x} {m:x}",
                        encoding.opcode
                    );
                    count += 1;
                    continue;
                }
                let sib_count =
                    if mode32 && encoding.e && !encoding.ignore_mod && m < 0xC0 && m & 7 == 4 {
                        256
                    }
                    else {
                        1
                    };
                for sib in 0..sib_count {
                    let mut sample = bytes.clone();
                    let mut displacement = 0;
                    if encoding.e && !encoding.ignore_mod && m < 0xC0 {
                        if mode32 && m & 7 == 4 {
                            sample.push(sib as u8);
                        }
                        displacement = match m >> 6 {
                            1 => 1,
                            2 => {
                                if mode32 {
                                    4
                                }
                                else {
                                    2
                                }
                            },
                            _ if mode32 && (m & 7 == 5 || m & 7 == 4 && sib & 7 == 5) => 4,
                            _ if !mode32 && m & 7 == 6 => 2,
                            _ => 0,
                        };
                    }
                    let imm = match encoding.immediate {
                        ImmediateKind::None => 0,
                        ImmediateKind::Byte | ImmediateKind::SignedByte => 1,
                        ImmediateKind::Word => 2,
                        ImmediateKind::Operand => {
                            if op_size32 {
                                4
                            }
                            else {
                                2
                            }
                        },
                        ImmediateKind::Address => {
                            if mode32 {
                                4
                            }
                            else {
                                2
                            }
                        },
                    };
                    sample.resize(
                        sample.len() + displacement + imm + encoding.extra_bytes as usize,
                        0x25,
                    );
                    let decoded = d(&sample, mode32);
                    assert_eq!(
                        decoded.encoding.id, encoding.id,
                        "{:x} {m:x}",
                        encoding.opcode
                    );
                    assert_eq!(
                        decoded.length as usize,
                        sample.len(),
                        "{:x} {m:x}",
                        encoding.opcode
                    );
                    for cut in 0..sample.len() {
                        assert!(
                            decode(&sample[..cut], GuestEip(0), LinearAddress(0), mode32).is_err()
                        );
                    }
                    count += 1;
                }
            }
        }
    }
    // Repeat, conflicting and address/segment prefixes against every catalogue
    // opcode in both modes. Padding allows prefix selection to change its form.
    let prefix_sets: &[&[u8]] = &[
        &[0x66],
        &[0x67],
        &[0x66, 0x67],
        &[0xF0],
        &[0xF2],
        &[0xF3],
        &[0xF2, 0xF3],
        &[0xF3, 0xF2],
        &[0x66, 0xF2, 0xF3],
        &[0xF3, 0x66, 0xF2],
        &[0x26, 0x36, 0x64, 0x65],
        &[0x66, 0x66, 0x67, 0x67],
        &[0xF3, 0xF3],
    ];
    for encoding in encodings() {
        for mode32 in [false, true] {
            for prefixes in prefix_sets {
                for memory in [false, true] {
                    let mut sample = prefixes.to_vec();
                    if encoding.opcode > 0xFFFF {
                        sample.push((encoding.opcode >> 16) as u8);
                    }
                    if encoding.opcode > 0xFF {
                        sample.push((encoding.opcode >> 8) as u8);
                    }
                    sample.push(encoding.opcode as u8);
                    if encoding.fetch_modrm {
                        sample.push(
                            (if memory { 4 } else { 0xC0 }) | (encoding.group.max(0) as u8) << 3,
                        );
                        if memory {
                            sample.push(0x9D);
                        }
                    }
                    sample.resize(15, 0x25);
                    if decode(&sample, GuestEip(0), LinearAddress(0), mode32).is_ok() {
                        count += 1;
                    }
                }
            }
        }
    }
    assert!(count > 1_000_000);
    println!("Checked {count} encoding/ModRM/SIB forms and all truncated prefixes");
}

#[test]
fn independent_disassembler_corpus() {
    use std::fs;
    fs::create_dir_all("build/ir-decode").unwrap();
    for mode32 in [false, true] {
        let mut bytes = Vec::new();
        let mut starts = Vec::new();
        let mut seed = 0x12345678u32;
        for i in 0..8192 {
            let mut instruction = Vec::new();
            // Restrict oracle corpus to instructions NDISASM and the baseline both implement.
            if i % 5 == 0 {
                instruction.push(0x66);
            }
            if i % 7 == 0 {
                instruction.push(0x67);
            }
            if i % 11 == 0 {
                instruction.push(0x64);
            }
            instruction.push([0x8B, 0x89, 0x01, 0x29, 0x31, 0x39][i % 6]);
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            let m = (seed >> 16) as u8;
            instruction.push(m);
            let size32 = mode32 != instruction.contains(&0x67);
            let sib = seed as u8;
            let mut displacement = 0;
            if m < 0xC0 {
                if size32 && m & 7 == 4 {
                    instruction.push(sib);
                }
                displacement = match m >> 6 {
                    1 => 1,
                    2 => {
                        if size32 {
                            4
                        }
                        else {
                            2
                        }
                    },
                    _ if size32 && (m & 7 == 5 || m & 7 == 4 && sib & 7 == 5) => 4,
                    _ if !size32 && m & 7 == 6 => 2,
                    _ => 0,
                };
            }
            instruction.extend_from_slice(&seed.to_le_bytes()[..displacement]);
            assert_eq!(d(&instruction, mode32).length as usize, instruction.len());
            starts.push(bytes.len().to_string());
            bytes.extend(instruction);
        }
        let size = if mode32 { 32 } else { 16 };
        fs::write(format!("build/ir-decode/oracle-{size}.bin"), bytes).unwrap();
        fs::write(
            format!("build/ir-decode/oracle-{size}.json"),
            format!("[{}]", starts.join(",")),
        )
        .unwrap();
    }
}

#[test]
fn legacy_dispatch_boundary_and_invalid_form_fetch() {
    // A non-custom ModRM helper is an observer/block boundary even without
    // block_boundary set in the catalogue (e.g. BOUND).
    let bound = d(&[0x62, 0x00], true);
    assert_eq!(bound.flow, Flow::Boundary);
    // The baseline dispatch reads ModRM before selecting the invalid unprefixed
    // SSE3 form, then delivers UD without consuming an EA displacement.
    let bare = d(&[0x0F, 0x7C, 0x05], true);
    assert_eq!(bare.length, 3);
    assert!(bare.ea.is_none());
    assert!(matches!(
        decode(&[0x0F, 0x7C], GuestEip(0), LinearAddress(0), true),
        Err(DecodeStop::Incomplete { .. })
    ));
    let prefixed = d(&[0x66, 0x0F, 0x7C, 0x05, 1, 2, 3, 4], true);
    assert_eq!(prefixed.length, 8);
    assert!(prefixed.ea.is_some());
}

#[test]
fn lock_requires_a_supported_memory_destination() {
    use crate::decode_rules::lock_allowed;
    use crate::prefix::PREFIX_LOCK;
    assert_eq!(
        crate::decode_rules::apply_prefix(0, 0xF0),
        Some(PREFIX_LOCK)
    );
    for opcode in [
        0x00, 0x01, 0x08, 0x09, 0x10, 0x11, 0x18, 0x19, 0x20, 0x21, 0x28, 0x29, 0x30, 0x31, 0x86,
        0x87, 0x0FAB, 0x0FB0, 0x0FB1, 0x0FB3, 0x0FBB, 0x0FC0, 0x0FC1,
    ] {
        for modrm in 0..=255 {
            assert_eq!(lock_allowed(opcode, Some(modrm)), modrm < 0xC0);
        }
    }
    for (opcode, groups) in [
        (0x80, 0x7F),
        (0x81, 0x7F),
        (0x82, 0x7F),
        (0x83, 0x7F),
        (0xF6, 0x0C),
        (0xF7, 0x0C),
        (0xFE, 3),
        (0xFF, 3),
        (0x0FBA, 0xE0),
        (0x0FC7, 2),
    ] {
        for modrm in 0..=255 {
            assert_eq!(
                lock_allowed(opcode, Some(modrm)),
                modrm < 0xC0 && groups >> (modrm >> 3 & 7) & 1 != 0
            );
        }
    }
    for bytes in [
        &[0xF0, 0x90][..],
        &[0xF0, 0x01, 0xD8],
        &[0xF0, 0x89, 0x07],
        &[0xF0, 0x0F, 0xC7, 0xC8],
        &[0xF0, 0x83, 0x3F, 1],
        &[0xF0, 0x0F, 0xBA, 0x27, 1],
        &[0xF0, 0x03, 0x07],
    ] {
        assert!(d(bytes, true).baseline_ud, "{bytes:02x?}");
    }
    for bytes in [
        &[0xF0, 0x01, 0x07][..],
        &[0xF0, 0x66, 0xFF, 0x07],
        &[0x66, 0xF0, 0xFF, 0x07],
        &[0xF0, 0x0F, 0xC7, 0x0F],
    ] {
        assert!(!d(bytes, true).baseline_ud, "{bytes:02x?}");
    }
}

#[test]
fn three_byte_maps_decode_and_stay_undefined_without_their_features() {
    use crate::cpu::features::{ALL, TEST_FEATURES};
    for features in [0, ALL] {
        TEST_FEATURES.with(|f| f.set(features));
        for (bytes, key) in [
            (&[0x0F, 0x38, 0xF1, 0x04, 0x24][..], 0x0F38F1), // movbe [esp]
            (&[0x0F, 0x38, 0xF0, 0x00], 0x0F38F0),           // movbe
            (&[0x66, 0x0F, 0x38, 0xF1, 0x00], 0x0F38F1),     // movbe m16 (66: operand size)
        ] {
            // without MOVBE #UD after the ModRM byte (no SIB read); with it
            // (P10) the whole memory operand
            let i = d(bytes, true);
            let length =
                if features == 0 && bytes[3] == 0x04 { bytes.len() - 1 } else { bytes.len() };
            assert_eq!(
                (i.early_ud, i.baseline_ud, i.ea.is_none()),
                (features == 0, features == 0, features == 0),
                "{bytes:02X?}"
            );
            assert!(i.immediate.is_none(), "{bytes:02X?}");
            assert_eq!(
                (i.encoding.opcode, i.length as usize),
                (key, length),
                "{bytes:02X?}"
            );
        }
        // F3 at MOVBE/CRC32 and 66 at the MOVBE rows' CRC32 are refused; an
        // unprefixed 0F 38 10 has no row
        for bytes in [
            &[0xF3, 0x0F, 0x38, 0xF0, 0x00][..],
            &[0x0F, 0x38, 0x10, 0xC1],
        ] {
            let i = d(bytes, true);
            assert!(
                i.early_ud && i.length as usize == bytes.len(),
                "{bytes:02X?}"
            );
        }
        // an opcode byte without rows is unknown (#UD at that byte when run)
        assert_eq!(
            decode(
                &[0x0F, 0x38, 0xFF, 0xC1],
                GuestEip(0),
                LinearAddress(0),
                true
            )
            .unwrap_err(),
            DecodeStop::UnknownEncoding { opcode: 0x0F38FF }
        );
        // the escape and third byte belong to the instruction
        assert!(matches!(
            decode(&[0x66, 0x0F, 0x38], GuestEip(0), LinearAddress(0), true),
            Err(DecodeStop::Incomplete { .. })
        ));
    }
    TEST_FEATURES.with(|f| f.set(0));
}

#[test]
fn sse42_rows_decode_with_their_feature() {
    use crate::cpu::features::{SSE4_1, SSE4_2, SSSE3, TEST_FEATURES};
    for features in [SSSE3 | SSE4_1, SSSE3 | SSE4_1 | SSE4_2] {
        TEST_FEATURES.with(|f| f.set(features));
        for mode32 in [false, true] {
            let w32 = if mode32 { 32 } else { 16 };
            // (the operand size: CRC32's source; none for PCMPxSTRx, whose 66 is mandatory)
            for (bytes, key, memory, imm8, operand_size) in [
                (
                    &[0x66, 0x0F, 0x3A, 0x63, 0xC1, 0x0C][..],
                    0x660F3A63,
                    false,
                    Some(0x0C),
                    None,
                ), // pcmpistri
                (
                    &[0x66, 0x0F, 0x3A, 0x60, 0x07, 0x40],
                    0x660F3A60,
                    true,
                    Some(0x40),
                    None,
                ), // pcmpestrm [..]
                (
                    &[0xF2, 0x0F, 0x38, 0xF0, 0xC1],
                    0xF20F38F0,
                    false,
                    None,
                    Some(w32),
                ), // crc32 r32, r/m8
                (
                    &[0xF2, 0x0F, 0x38, 0xF1, 0x07],
                    0xF20F38F1,
                    true,
                    None,
                    Some(w32),
                ), // crc32 r32, [..]
                // (66 is the operand size)
                (
                    &[0x66, 0xF2, 0x0F, 0x38, 0xF1, 0xC1],
                    0xF20F38F1,
                    false,
                    None,
                    Some(48 - w32),
                ),
            ] {
                let i = d(bytes, mode32);
                assert_eq!(i.encoding.opcode, key, "{bytes:02X?}");
                if features & SSE4_2 == 0 {
                    // #UD right after the ModRM byte: no EA, no immediate
                    assert!(i.early_ud && i.baseline_ud && i.ea.is_none() && i.immediate.is_none());
                    assert_eq!(i.length as usize, bytes.len() - imm8.map_or(0, |_| 1));
                    continue;
                }
                assert!(!i.early_ud && !i.baseline_ud, "{bytes:02X?}");
                assert_eq!(
                    (i.length as usize, i.ea.is_some(), i.immediate),
                    (bytes.len(), memory, imm8),
                    "{bytes:02X?}"
                );
                assert!(operand_size.is_none_or(|size| i.operand_size == size));
            }
            // F3 selects no CRC32
            assert!(d(&[0xF3, 0x0F, 0x38, 0xF1, 0xC1], mode32).early_ud);
        }
    }
    TEST_FEATURES.with(|f| f.set(0));
}

#[test]
fn ssse3_rows_decode_with_their_feature() {
    use crate::cpu::features::{SSSE3, TEST_FEATURES};
    for features in [0, SSSE3] {
        TEST_FEATURES.with(|f| f.set(features));
        for mode32 in [false, true] {
            for (bytes, key, memory, imm8) in [
                (&[0x66, 0x0F, 0x38, 0x00, 0xC1][..], 0x660F3800, false, None), // pshufb xmm
                (&[0x0F, 0x38, 0x04, 0xC1], 0x0F3804, false, None),             // pmaddubsw mm
                (&[0x0F, 0x38, 0x1C, 0x07], 0x0F381C, true, None),              // pabsb mm, [..]
                (
                    &[0x66, 0x0F, 0x3A, 0x0F, 0xC1, 0x11],
                    0x660F3A0F,
                    false,
                    Some(0x11),
                ), // palignr
                (&[0x0F, 0x3A, 0x0F, 0x07, 0x80], 0x0F3A0F, true, Some(0x80)),
            ] {
                let i = d(bytes, mode32);
                assert_eq!(i.encoding.opcode, key, "{bytes:02X?}");
                if features == 0 {
                    // #UD right after the ModRM byte: no EA, no immediate
                    assert!(i.early_ud && i.baseline_ud && i.ea.is_none() && i.immediate.is_none());
                    assert_eq!(i.length as usize, bytes.len() - imm8.map_or(0, |_| 1));
                    continue;
                }
                assert!(!i.early_ud && !i.baseline_ud, "{bytes:02X?}");
                assert_eq!(i.length as usize, bytes.len());
                assert_eq!(i.ea.is_some(), memory);
                assert_eq!(i.immediate, imm8);
            }
            // F2/F3 select no SSSE3 form
            for bytes in [
                &[0xF3, 0x0F, 0x38, 0x00, 0xC1][..],
                &[0xF2, 0x0F, 0x3A, 0x0F, 0xC1],
            ] {
                assert!(d(bytes, mode32).early_ud, "{bytes:02X?}");
            }
        }
    }
    TEST_FEATURES.with(|f| f.set(0));
}

/// The bytes of a C4 VEX prefix and opcode for `row` (a VEX row): its map
/// and pp, VEX.L and VEX.W as given, VEX.vvvv (not inverted) and R/X/B 0
fn vex3_bytes(row: &Encoding, vvvv: u8, l: bool, w: bool) -> Vec<u8> {
    let (map, pp) = ((row.opcode >> 16) as u8, (row.opcode >> 8 & 3) as u8);
    vec![
        0xC4,
        0xE0 | map,
        (w as u8) << 7 | (!vvvv & 15) << 3 | (l as u8) << 2 | pp,
        row.opcode as u8,
    ]
}

#[test]
fn vex_or_les_lds_prefixes_and_fields() {
    use crate::cpu::features::{ALL, TEST_FEATURES};
    use crate::decode_rules::Vex;
    TEST_FEATURES.with(|f| f.set(ALL));
    for mode32 in [false, true] {
        // a memory ModRM byte: LES/LDS
        let les = d(
            &[
                0xC4,
                if mode32 { 0x05 } else { 0x06 },
                0x34,
                0x12,
                0x56,
                0x78,
            ],
            mode32,
        );
        assert_eq!((les.encoding.opcode, les.vex), (0xC4, None));
        assert_eq!(les.length, if mode32 { 6 } else { 4 });
        assert_eq!(d(&[0xC5, 0x00], mode32).encoding.opcode, 0xC5);
        // a register one: VEX (VZEROUPPER; VZEROALL, without semantics yet)
        for (bytes, name) in [
            (&[0xC5, 0xF8, 0x77][..], "VEX_Vzeroupper"),
            (&[0xC5, 0xFC, 0x77], "VEX_Vzeroall"),
            (&[0xC4, 0xE1, 0x7C, 0x77], "VEX_Vzeroall"),
            // W and the ignored B are free in 32-bit mode
            (&[0xC4, 0xC1, 0xFC, 0x77], "VEX_Vzeroall"),
            (&[0x2E, 0x67, 0xC5, 0xF8, 0x77], "VEX_Vzeroupper"),
        ] {
            let i = d(bytes, mode32);
            assert_eq!(form(i.encoding), name, "{bytes:02X?}");
            assert!(i.vex.is_some(), "{bytes:02X?}");
            assert_eq!(
                (i.early_ud, i.baseline_ud),
                (i.encoding.unimplemented, i.encoding.unimplemented),
                "{bytes:02X?}"
            );
            assert_eq!(i.length as usize, bytes.len(), "{bytes:02X?}");
        }
        // 66, F2, F3 and LOCK: #UD at the first VEX byte
        for prefix in [0x66, 0xF2, 0xF3, 0xF0] {
            let i = d(&[prefix, 0xC5, 0xF8, 0x77], mode32);
            assert!(i.early_ud && i.baseline_ud && i.vex.is_none() && i.length == 3);
            let i = d(&[prefix, 0xC4, 0xE1, 0x7C, 0x77], mode32);
            assert!(i.early_ud && i.length == 3 && i.encoding.opcode == 0xC4);
        }
        // reserved maps and opcodes without rows: unknown, after the opcode byte
        for (bytes, key) in [
            (&[0xC4, 0xE0, 0x78, 0x77][..], 0xC4000077),
            (&[0xC4, 0xE4, 0x78, 0x77], 0xC4040077),
            (&[0xC4, 0xFF, 0x78, 0x77], 0xC41F0077),
            (&[0xC5, 0xF8, 0x00], 0xC4010000),
            (&[0xC4, 0xE2, 0x78, 0x00], 0xC4020000),
        ] {
            assert_eq!(
                decode(bytes, GuestEip(0), LinearAddress(0), mode32).unwrap_err(),
                DecodeStop::UnknownEncoding { opcode: key }
            );
        }
        // every byte up to the ModRM belongs to the instruction
        let bytes = [0xC4, 0xE2, 0x79, 0x18, 0xC1];
        for n in 1..bytes.len() {
            assert!(matches!(
                decode(&bytes[..n], GuestEip(0), LinearAddress(0), mode32),
                Err(DecodeStop::Incomplete { .. })
            ));
        }
        let mut long = vec![0x2E; 12];
        long.extend([0xC4, 0xE1, 0x7C, 0x77]);
        assert_eq!(
            decode(&long, GuestEip(0), LinearAddress(0), mode32).unwrap_err(),
            DecodeStop::TooLong
        );
    }
    // the fields, inverted where the encoding inverts them; R, X and B are
    // ignored outside 64-bit mode, where VEX.vvvv names 8 registers
    let v = Vex::three(0x42, 0x85 ^ 0x78 ^ 0x48, true);
    assert_eq!(
        v,
        Vex {
            map: 2,
            pp: 1,
            l: true,
            w: true,
            vvvv: 9,
            r: true,
            x: false,
            b: true
        }
    );
    // (outside 64-bit mode the three-byte prefix's top VEX.vvvv bit is ignored)
    assert_eq!(Vex::three(0x42, 0x85 ^ 0x78 ^ 0x48, false).vvvv, 1);
    assert_eq!(Vex::three(0x62, 0x85, false).r, false);
    assert_eq!(
        Vex::two(0x7D, true),
        Vex {
            map: 1,
            pp: 1,
            l: true,
            w: false,
            vvvv: 0,
            r: true,
            x: false,
            b: false
        }
    );
    assert_eq!(Vex::two(0xC5, false).vvvv, 7);
    assert_eq!(Vex::three(0xE3, 0x79, false).key(0x4A), 0xC403014A);
    TEST_FEATURES.with(|f| f.set(0));
}

#[test]
fn vex_rows_decode_from_their_own_encodings() {
    use crate::cpu::features::{ALL, TEST_FEATURES};
    use crate::decode_rules::vex;
    let mut count = 0;
    for row in encodings()
        .iter()
        .filter(|e| e.vex != 0 && e.vex & vex::LONG == 0)
    {
        let (l, w) = (row.vex & vex::L1 != 0, row.vex & vex::W1 != 0);
        let vvvv = if row.vex & vex::VVVV != 0 { 3 } else { 0 };
        let group = if row.group >= 0 { row.group as u8 } else { 2 };
        let vsib = row.vex & vex::VSIB != 0;
        let mut forms = Vec::new();
        if row.fetch_modrm && !row.reg_ud {
            forms.push(vec![0xC0 | group << 3 | 1]);
        }
        if row.fetch_modrm && !row.mem_ud {
            // [eax+disp8] or [bx+si+disp8], [eax+ecx*1+disp8] for VSIB
            forms.push(if vsib {
                vec![0x44 | group << 3, 0x08, 0x10]
            }
            else {
                vec![0x40 | group << 3, 0x10]
            });
        }
        if !row.fetch_modrm {
            forms.push(vec![]);
        }
        for operand in forms {
            for mode32 in [false, true] {
                if vsib && !mode32 {
                    continue; // (16-bit addressing: below)
                }
                let mut bytes = vex3_bytes(row, vvvv, l, w);
                bytes.extend(&operand);
                // (the VEX prefix, opcode and ModRM byte)
                let head = 4 + operand.len().min(1);
                if row.immediate == ImmediateKind::Byte {
                    bytes.push(0x5A);
                }
                // as if implemented, with the features: this row, whole
                TEST_FEATURES.with(|f| f.set(ALL));
                TEST_DECODE_UNIMPLEMENTED.with(|t| t.set(true));
                let i = d(&bytes, mode32);
                assert_eq!(form(i.encoding), form(row), "{bytes:02X?}");
                assert!(!i.early_ud && !i.baseline_ud, "{} {bytes:02X?}", form(row));
                assert_eq!(i.length as usize, bytes.len(), "{} {bytes:02X?}", form(row));
                assert_eq!(i.ea.is_some(), operand.first().is_some_and(|&m| m < 0xC0));
                assert_eq!(
                    i.immediate,
                    (row.immediate == ImmediateKind::Byte).then_some(0x5A)
                );
                if vsib {
                    assert_eq!(i.ea.unwrap().index, Some(1));
                }
                // the two-byte prefix where it can say the same
                if row.opcode >> 16 & 0xFF == 1 && !w {
                    let mut short = vec![
                        0xC5,
                        0x80 | (!vvvv & 15) << 3 | (l as u8) << 2 | (row.opcode >> 8 & 3) as u8,
                    ];
                    short.extend(&bytes[3..]);
                    assert_eq!(d(&short, mode32).encoding.id, row.id, "{short:02X?}");
                }
                // VEX.vvvv must be 1111b unless an operand; the three-byte
                // prefix's top bit is ignored outside 64-bit mode (SDM 2.3.5.6)
                for (bit, accepted) in [(0x40, true), (0x08, row.vex & vex::VVVV != 0)] {
                    let mut b = bytes.clone();
                    b[2] ^= bit;
                    let other = d(&b, mode32);
                    if accepted {
                        assert!(
                            other.encoding.id == row.id && !other.early_ud,
                            "{} {b:02X?}",
                            form(row)
                        );
                    }
                    else {
                        assert!(
                            other.early_ud && other.length as usize == head,
                            "{} {b:02X?}",
                            form(row)
                        );
                    }
                }
                // the other VEX.L and VEX.W select another row or none
                for (bit, rule, ignored) in [
                    (0x04, vex::L0 | vex::L1, false),
                    (0x80, vex::W0 | vex::W1, row.vex & vex::WIG32 != 0),
                ] {
                    let mut b = bytes.clone();
                    b[2] ^= bit;
                    match decode(&b, GuestEip(0), LinearAddress(0), mode32) {
                        Ok(other) if row.vex & rule != 0 && !ignored => {
                            assert!(
                                other.encoding.id != row.id || other.early_ud,
                                "{} {b:02X?}",
                                form(row)
                            )
                        },
                        Ok(other) => {
                            assert_eq!(other.encoding.id, row.id, "{} {b:02X?}", form(row))
                        },
                        Err(e) => panic!("{} {b:02X?} {e:?}", form(row)),
                    }
                }
                // without the features or the semantics: #UD after the ModRM
                // byte (a row with its semantics decodes in full)
                for (features, all) in [(0, true), (ALL, false)] {
                    TEST_FEATURES.with(|f| f.set(features));
                    TEST_DECODE_UNIMPLEMENTED.with(|t| t.set(all));
                    let i = d(&bytes, mode32);
                    assert_eq!(i.encoding.id, row.id);
                    if features == ALL && !row.unimplemented {
                        assert!(!i.early_ud && i.length as usize == bytes.len());
                        continue;
                    }
                    assert!(i.early_ud && i.baseline_ud && i.ea.is_none() && i.immediate.is_none());
                    assert_eq!(i.length as usize, head);
                }
                count += 1;
            }
        }
    }
    TEST_FEATURES.with(|f| f.set(0));
    TEST_DECODE_UNIMPLEMENTED.with(|t| t.set(false));
    assert!(count > 1000, "{count}");
}

#[test]
fn vex_vsib_and_gather_registers() {
    use crate::cpu::features::{ALL, TEST_FEATURES};
    TEST_FEATURES.with(|f| f.set(ALL));
    TEST_DECODE_UNIMPLEMENTED.with(|t| t.set(true));
    // VPGATHERDD xmm2, [eax+xmm1*4], xmm3
    let gather = [0xC4, 0xE2, 0x61, 0x90, 0x14, 0x88];
    let i = d(&gather, true);
    assert_eq!(form(i.encoding), "VEX_Vpgatherdd_xmm_vm32x_xmm");
    assert!(!i.baseline_ud && i.ea.unwrap().index == Some(1) && i.ea.unwrap().scale == 2);
    // xmm4 is an index register like the others
    let i = d(&[0xC4, 0xE2, 0x61, 0x90, 0x14, 0xA0], true);
    assert!(!i.baseline_ud && i.ea.unwrap().index == Some(4));
    // no SIB byte, a register form or 16-bit addressing: #UD after ModRM
    for (bytes, mode32) in [
        (&[0xC4, 0xE2, 0x61, 0x90, 0x10][..], true),
        (&[0xC4, 0xE2, 0x61, 0x90, 0xD1], true),
        (&[0x67, 0xC4, 0xE2, 0x61, 0x90, 0x14], true),
        (&[0xC4, 0xE2, 0x61, 0x90, 0x14], false),
    ] {
        let i = d(bytes, mode32);
        assert!(
            i.early_ud && i.length as usize == bytes.len(),
            "{bytes:02X?}"
        );
    }
    // destination, index and mask registers must differ: #UD after the SIB
    for (vvvv, sib) in [(1, 0x88), (2, 0x88), (3, 0x98)] {
        let mut bytes = gather;
        bytes[2] = (!vvvv & 15) << 3 | 1;
        bytes[5] = sib;
        let i = d(&bytes, true);
        assert!(
            i.baseline_ud && !i.early_ud && i.length == 6,
            "{bytes:02X?}"
        );
    }
    TEST_FEATURES.with(|f| f.set(0));
    TEST_DECODE_UNIMPLEMENTED.with(|t| t.set(false));
}

#[test]
fn tzcnt_and_lzcnt_are_bsf_and_bsr_without_their_features() {
    use crate::cpu::features::{BMI1, LZCNT, TEST_FEATURES};
    for features in [0, BMI1, LZCNT, BMI1 | LZCNT] {
        TEST_FEATURES.with(|f| f.set(features));
        for (byte, feature) in [(0xBC, BMI1), (0xBD, LZCNT)] {
            for prefix in [&[0xF3][..], &[0x66, 0xF3], &[0xF3, 0x66], &[0xF2, 0xF3]] {
                let mut bytes = prefix.to_vec();
                bytes.extend([0x0F, byte, 0x04, 0x24]);
                let i = d(&bytes, true);
                if features & feature != 0 {
                    // (TZCNT and LZCNT, P10)
                    assert_eq!(i.encoding.opcode, 0xF30F00 | byte as u32);
                    assert!(!i.early_ud && i.length as usize == bytes.len());
                }
                else {
                    assert_eq!(i.encoding.opcode, 0x0F00 | byte as u32);
                    assert!(!i.baseline_ud && i.length as usize == bytes.len());
                }
            }
        }
    }
    TEST_FEATURES.with(|f| f.set(0));
}
