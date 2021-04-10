#[derive(Copy, Clone, PartialEq, Eq)]
#[repr(transparent)]
pub struct CachedStateFlags(u8);

impl CachedStateFlags {
    const MASK_IS_32: u8 = 1 << 0;
    const MASK_SS32: u8 = 1 << 1;
    const MASK_CPL3: u8 = 1 << 2;
    const MASK_FLAT_SEGS: u8 = 1 << 3;

    pub const EMPTY: CachedStateFlags = CachedStateFlags(0);

    pub fn of_u32(f: u32) -> CachedStateFlags {
        dbg_assert!(
            f as u8
                & !(Self::MASK_IS_32 | Self::MASK_SS32 | Self::MASK_CPL3 | Self::MASK_FLAT_SEGS)
                == 0
        );
        CachedStateFlags(f as u8)
    }
    pub fn to_u32(&self) -> u32 { self.0 as u32 }

    pub fn cpl3(&self) -> bool { self.0 & CachedStateFlags::MASK_CPL3 != 0 }
    pub fn has_flat_segmentation(&self) -> bool { self.0 & CachedStateFlags::MASK_FLAT_SEGS != 0 }
    pub fn is_32(&self) -> bool { self.0 & CachedStateFlags::MASK_IS_32 != 0 }
    pub fn ssize_32(&self) -> bool { self.0 & CachedStateFlags::MASK_SS32 != 0 }
}
