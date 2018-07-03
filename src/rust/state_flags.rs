#[derive(Copy, Clone, PartialEq, Eq)]
pub struct CachedStateFlags(u32);

impl CachedStateFlags {
    const MASK_IS_32: u32 = 1 << 0;
    const MASK_SS32: u32 = 1 << 1;
    const MASK_CPL3: u32 = 1 << 2;
    const MASK_FLAT_SEGS: u32 = 1 << 3;

    pub const EMPTY: CachedStateFlags = CachedStateFlags(0);

    pub fn of_u32(f: u32) -> CachedStateFlags { CachedStateFlags(f) }
    pub fn to_u32(&self) -> u32 { self.0 }

    pub fn cpl3(&self) -> bool { self.0 & CachedStateFlags::MASK_CPL3 != 0 }
    pub fn has_flat_segmentation(&self) -> bool { self.0 & CachedStateFlags::MASK_FLAT_SEGS != 0 }
    pub fn is_32(&self) -> bool { self.0 & CachedStateFlags::MASK_IS_32 != 0 }
    pub fn ssize_32(&self) -> bool { self.0 & CachedStateFlags::MASK_SS32 != 0 }
}
