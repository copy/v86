//! Read-only code capture. This never calls the CPU's MMIO-capable page walker.
use super::compile::{CodeDependency, CodeMapping, ImmutableCodeSnapshot};
use crate::cpu::{cpu, global_pointers as gp, memory};
use crate::ir::frontend::decode::{LinearAddress, PhysicalAddress};
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CaptureError {
    Size,
    Unreadable,
    NonRam,
    UnsupportedPaging,
}
unsafe fn ram(address: u32, bytes: usize) -> Result<&'static [u8], CaptureError> {
    let last = address
        .checked_add(bytes as u32 - 1)
        .ok_or(CaptureError::NonRam)?;
    if memory::mem8.is_null() || memory::in_mapped_range(address) || memory::in_mapped_range(last) {
        return Err(CaptureError::NonRam);
    }
    Ok(std::slice::from_raw_parts(
        memory::mem8.add(address as usize),
        bytes,
    ))
}
unsafe fn table(address: u32, pae: bool) -> Result<u32, CaptureError> {
    let bytes = ram(address, if pae { 8 } else { 4 })?;
    if pae && bytes[4..].iter().any(|b| *b != 0) {
        return Err(CaptureError::UnsupportedPaging);
    }
    Ok(u32::from_le_bytes(bytes[..4].try_into().unwrap()))
}
pub unsafe fn translate(linear: u32) -> Result<u32, CaptureError> {
    let user = *gp::cpl == 3;
    let cached = cpu::tlb_data[(linear >> 12) as usize];
    if cached & (cpu::TLB_VALID | cpu::TLB_IA32E_DATA | if user { cpu::TLB_NO_USER } else { 0 })
        == cpu::TLB_VALID
    {
        return Ok(((cached as u32 & !4095) ^ linear).wrapping_sub(memory::mem8 as u32));
    }
    // Compatibility mode: 4-level paging with NX, read without side effects
    if crate::x64::state::efer() & crate::x64::state::EFER_LMA != 0 {
        let translation = crate::x64::memory::snapshot_translation(
            linear as u64,
            crate::x64::paging::Access::Execute,
        )
        .ok_or(CaptureError::Unreadable)?;
        return crate::x64::jac::ram_backing(translation.physical.0)
            .map(|backing| backing | linear & 4095)
            .ok_or(CaptureError::NonRam);
    }
    let cr0 = *gp::cr;
    if cr0 & cpu::CR0_PG == 0 {
        return Ok(linear);
    }
    let cr4 = *gp::cr.add(4);
    let pae = cr4 & cpu::CR4_PAE != 0;
    let directory = if pae {
        let pdpte = *gp::reg_pdpte.add((linear >> 30) as usize);
        if pdpte >> 32 != 0 {
            return Err(CaptureError::UnsupportedPaging);
        }
        if pdpte & 1 == 0 {
            return Err(CaptureError::Unreadable);
        }
        (pdpte as u32 & !4095).wrapping_add((linear >> 21 & 511) * 8)
    }
    else {
        // Match the baseline's CR3 low-bit policy, including its unmasked addition.
        (*gp::cr.add(3) as u32).wrapping_add((linear >> 22) * 4)
    };
    let pde = table(directory, pae)?;
    if pde & 1 == 0 || user && pde & 4 == 0 {
        return Err(CaptureError::Unreadable);
    }
    if pde & 128 != 0 && cr4 & cpu::CR4_PSE != 0 {
        return Ok(if pae {
            pde & 0xFFE00000 | linear & 0x1FFFFF
        }
        else {
            pde & 0xFFC00000 | linear & 0x3FFFFF
        });
    }
    let offset = if pae { (linear >> 12 & 511) * 8 } else { (linear >> 12 & 1023) * 4 };
    let pte = table((pde & !4095).wrapping_add(offset), pae)?;
    if pte & 1 == 0 || user && pte & 4 == 0 {
        return Err(CaptureError::Unreadable);
    }
    Ok(pte & !4095 | linear & 4095)
}
/// Online execution may skip instruction-byte reads only after the CPU has
/// established every covered page's visible translation. Do not eagerly walk
/// secondary/unreachable pages and alter their accessed bits during admission.
#[inline(always)]
pub unsafe fn mappings_cached(snapshot: &ImmutableCodeSnapshot) -> bool {
    mapping_list_cached(&snapshot.mappings)
}
/// One mapping's translation is in the CPU TLB (as mappings_cached).
pub unsafe fn mapping_cached(mapping: &CodeMapping) -> bool {
    mapping_list_cached(std::slice::from_ref(mapping))
}
#[inline(always)]
unsafe fn mapping_list_cached(mappings: &[CodeMapping]) -> bool {
    let mask =
        cpu::TLB_VALID | cpu::TLB_IA32E_DATA | if *gp::cpl == 3 { cpu::TLB_NO_USER } else { 0 };
    mappings.iter().all(|mapping| {
        let cached = cpu::tlb_data[(mapping.linear.0 >> 12) as usize];
        cached & mask == cpu::TLB_VALID
            && ((cached as u32 & !4095) ^ mapping.linear.0).wrapping_sub(memory::mem8 as u32)
                == mapping.physical.0
    })
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CachedMatch {
    Match,
    Unavailable,
    Stale,
}

#[derive(Debug)]
struct ValidationSpan {
    linear: u32,
    physical: u32,
    bytes: Vec<u8>,
}
/// Cold-owned validation of exactly the union of overlapping source windows.
/// Original snapshots/dependencies remain authoritative. A failed fast check
/// falls back to their original order, retaining Stale/Unavailable precedence.
#[derive(Debug)]
pub(super) struct MergedValidation {
    mappings: Vec<CodeMapping>,
    spans: Vec<ValidationSpan>,
    pub(super) saved_bytes: u32,
}
impl MergedValidation {
    pub(super) fn build<'a>(
        sources: impl IntoIterator<Item = (u32, &'a ImmutableCodeSnapshot)>,
    ) -> Option<Self> {
        let mut mappings: Vec<CodeMapping> = Vec::new();
        let mut spans = Vec::new();
        let mut original_bytes = 0usize;
        let mut source_count = 0;
        for (linear, source) in sources {
            source_count += 1;
            if source_count > 4 || source.bytes.is_empty() || source.bytes.len() > 15 * 128 {
                return None;
            }
            original_bytes += source.bytes.len();
            let mut offset = 0;
            for mapping in &source.mappings {
                if offset >= source.bytes.len() || mapping.physical.0 & 4095 != 0 {
                    return None;
                }
                let address = linear.wrapping_add(offset as u32);
                if mapping.linear.0 != address & !4095 {
                    return None;
                }
                if let Some(existing) = mappings.iter().find(|m| m.linear == mapping.linear) {
                    if existing.physical != mapping.physical {
                        return None;
                    }
                }
                else {
                    mappings.push(*mapping);
                }
                let page_offset = address & 4095;
                let length = (4096 - page_offset as usize).min(source.bytes.len() - offset);
                let physical = mapping.physical.0.checked_add(page_offset)?;
                physical.checked_add(length as u32 - 1)?;
                spans.push(ValidationSpan {
                    linear: address,
                    physical,
                    bytes: source.bytes[offset..offset + length].to_vec(),
                });
                offset += length;
            }
            if offset != source.bytes.len() {
                return None;
            }
        }
        if source_count < 2 {
            return None;
        }
        spans.sort_by_key(|span| span.linear);
        let mut merged: Vec<ValidationSpan> = Vec::with_capacity(spans.len());
        for span in spans {
            if let Some(previous) = merged.last_mut() {
                let end = previous.linear as u64 + previous.bytes.len() as u64;
                if previous.linear & !4095 == span.linear & !4095
                    && previous.physical & !4095 == span.physical & !4095
                    && (span.linear as u64) < end
                {
                    let start = (span.linear - previous.linear) as usize;
                    let overlap = (previous.bytes.len() - start).min(span.bytes.len());
                    if !same_bytes(
                        &previous.bytes[start..start + overlap],
                        &span.bytes[..overlap],
                    ) {
                        return None;
                    }
                    previous.bytes.extend_from_slice(&span.bytes[overlap..]);
                    continue;
                }
            }
            merged.push(span);
        }
        let unique_bytes: usize = merged.iter().map(|span| span.bytes.len()).sum();
        if unique_bytes >= original_bytes {
            return None;
        }
        Some(Self {
            mappings,
            spans: merged,
            saved_bytes: (original_bytes - unique_bytes) as u32,
        })
    }
    #[inline(always)]
    pub(super) unsafe fn mappings_cached(&self) -> bool { mapping_list_cached(&self.mappings) }
    pub(super) unsafe fn matches(&self) -> bool {
        self.mappings_cached()
            && self.spans.iter().all(|span| {
                ram(span.physical, span.bytes.len())
                    .is_ok_and(|current| same_bytes(current, &span.bytes))
            })
    }
}
/// Exact comparison of CPU-owned, non-shared bytes. Rust's generic Wasm memcmp
/// is costly on this admission path. Compare complete unaligned words/vectors
/// instead, without hashing, ignoring bytes, or reading beyond either slice.
#[inline]
pub(super) fn same_bytes(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let length = left.len();
    let mut at = 0;
    unsafe {
        #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
        {
            use core::arch::wasm32::{v128_any_true, v128_load, v128_xor};
            while length - at >= 16 {
                let a = v128_load(left.as_ptr().add(at).cast());
                let b = v128_load(right.as_ptr().add(at).cast());
                if v128_any_true(v128_xor(a, b)) {
                    return false;
                }
                at += 16;
            }
        }
        while length - at >= 8 {
            let a = left.as_ptr().add(at).cast::<u64>().read_unaligned();
            let b = right.as_ptr().add(at).cast::<u64>().read_unaligned();
            if a != b {
                return false;
            }
            at += 8;
        }
        while at < length {
            if *left.get_unchecked(at) != *right.get_unchecked(at) {
                return false;
            }
            at += 1;
        }
    }
    true
}
/// Fast execution-time validation for already-visible code pages. This preserves
/// raw/unnotified SMC detection by comparing the authoritative physical RAM bytes,
/// but avoids allocating a new snapshot or walking page tables on a hot admission.
/// A missing cached translation is not stale: callers may fall back to capture()
/// before the architectural fetch, or simply decline admission afterward.
pub unsafe fn cached_match(linear: u32, snapshot: &ImmutableCodeSnapshot) -> CachedMatch {
    if !mappings_cached(snapshot) {
        return CachedMatch::Unavailable;
    }
    // Most captures fit one page. Keep mapping admission first, then compare
    // that page directly without the generic chunk loop or per-owner metadata.
    if let [mapping] = snapshot.mappings.as_slice() {
        let page_offset = linear & 4095;
        if snapshot.bytes.is_empty()
            || snapshot.bytes.len() > (4096 - page_offset) as usize
            || mapping.linear.0 != linear & !4095
        {
            return CachedMatch::Stale;
        }
        let Some(physical) = mapping.physical.0.checked_add(page_offset)
        else {
            return CachedMatch::Stale;
        };
        return match ram(physical, snapshot.bytes.len()) {
            Ok(current) if same_bytes(current, &snapshot.bytes) => CachedMatch::Match,
            _ => CachedMatch::Stale,
        };
    }
    let mut offset = 0usize;
    for mapping in &snapshot.mappings {
        if offset >= snapshot.bytes.len() {
            return CachedMatch::Stale;
        }
        let address = linear.wrapping_add(offset as u32);
        if mapping.linear.0 != address & !4095 {
            return CachedMatch::Stale;
        }
        let page_offset = (address & 4095) as usize;
        let chunk = (4096 - page_offset).min(snapshot.bytes.len() - offset);
        let Some(physical) = mapping.physical.0.checked_add(page_offset as u32)
        else {
            return CachedMatch::Stale;
        };
        let Ok(current) = ram(physical, chunk)
        else {
            return CachedMatch::Stale;
        };
        if !same_bytes(current, &snapshot.bytes[offset..offset + chunk]) {
            return CachedMatch::Stale;
        }
        offset += chunk;
    }
    if offset == snapshot.bytes.len() {
        CachedMatch::Match
    }
    else {
        CachedMatch::Stale
    }
}
pub unsafe fn capture(linear: u32, length: usize) -> Result<ImmutableCodeSnapshot, CaptureError> {
    if length == 0 || length > crate::ir::frontend::region::CfgLimits::PAGE.source_bytes {
        return Err(CaptureError::Size);
    }
    let mut snapshot = ImmutableCodeSnapshot {
        bytes: Vec::with_capacity(length),
        dependencies: vec![],
        mappings: vec![],
    };
    while snapshot.bytes.len() < length {
        let address = linear.wrapping_add(snapshot.bytes.len() as u32);
        let physical = translate(address)?;
        let chunk = (4096 - (address & 4095) as usize).min(length - snapshot.bytes.len());
        let page = PhysicalAddress(physical & !4095);
        snapshot.mappings.push(CodeMapping {
            linear: LinearAddress(address & !4095),
            physical: page,
        });
        if !snapshot.dependencies.iter().any(|d| d.page == page) {
            snapshot
                .dependencies
                .push(CodeDependency { page, version: 1 });
        }
        snapshot.bytes.extend_from_slice(ram(physical, chunk)?);
    }
    Ok(snapshot)
}

/// Exactly one code page from its base. Admission then needs one TLB-visible
/// mapping; a final instruction straddling into the next page is left to the
/// interpreter (the page lifter declines what it cannot decode in full).
pub unsafe fn capture_page(linear: u32) -> Result<ImmutableCodeSnapshot, CaptureError> {
    capture(linear & !4095, 4096)
}

/// Test hook (tests/ir/decode/snapshot.mjs): bytes captured at `linear`, or
/// 0 where capture declines (MMIO, unallocated RAM).
#[cfg(feature = "ir-test-hooks")]
#[no_mangle]
pub unsafe fn ir_test_snapshot_length(linear: u32, length: u32) -> u32 {
    capture(linear, length as usize).map_or(0, |snapshot| snapshot.bytes.len() as u32)
}
/// Test hook: decode the instruction at `linear` from its page's capture_page
/// snapshot. 1 decoded, 2 incomplete (it continues on the next page), 3 other
/// stop, 0 no capture.
#[cfg(feature = "ir-test-hooks")]
#[no_mangle]
pub unsafe fn ir_test_snapshot_decode(linear: u32) -> u32 {
    use crate::ir::frontend::decode::{decode, DecodeStop, GuestEip};
    let Ok(snapshot) = capture_page(linear)
    else {
        return 0;
    };
    let bytes = &snapshot.bytes[(linear & 4095) as usize..];
    match decode(bytes, GuestEip(linear), LinearAddress(linear), true) {
        Ok(_) => 1,
        Err(DecodeStop::Incomplete { .. }) => 2,
        Err(_) => 3,
    }
}

#[cfg(test)]
#[path = "../../../../tests/ir/semantics/overlap_validation.rs"]
mod overlap_tests;

#[cfg(test)]
mod tests {
    use super::same_bytes;

    #[test]
    fn exact_bytes_match_at_every_alignment_and_word_tail() {
        let lengths = [
            0, 1, 7, 8, 9, 15, 16, 17, 31, 32, 33, 63, 64, 65, 127, 128, 129, 383, 384, 385, 1919,
            1920,
        ];
        for left_offset in 0..32 {
            for right_offset in 0..32 {
                for length in lengths {
                    let mut left = vec![0x55; left_offset + length + 32];
                    let mut right = vec![0xAA; right_offset + length + 32];
                    for at in 0..length {
                        let byte = (at * 173 + 11) as u8;
                        left[left_offset + at] = byte;
                        right[right_offset + at] = byte;
                    }
                    let a = &left[left_offset..left_offset + length];
                    let b = &mut right[right_offset..right_offset + length];
                    assert!(
                        same_bytes(a, b),
                        "length={length}, alignment={left_offset}/{right_offset}"
                    );
                    assert_eq!(same_bytes(a, &b[..length.saturating_sub(1)]), length == 0);
                    for at in 0..length {
                        // Exhaust every byte for short inputs and vector tails;
                        // probe long captures at both ends and each word boundary.
                        if length > 129 && at != 0 && at + 1 != length && at % 8 != 0 {
                            continue;
                        }
                        b[at] ^= 1;
                        assert!(!same_bytes(a, b), "mismatch={at}, length={length}");
                        b[at] ^= 1;
                    }
                }
            }
        }
    }
}
