use std::ops::RangeInclusive;

#[derive(Copy, Clone, Eq, Hash, PartialEq)]
pub struct Page(u32);
impl Page {
    pub fn page_of(address: u32) -> Page { Page(address >> 12) }
    pub fn to_address(self) -> u32 { self.0 << 12 }

    pub fn to_u32(self) -> u32 { self.0 }
    pub fn of_u32(page: u32) -> Page { Page(page) }

    pub fn address_range(self) -> RangeInclusive<u32> {
        self.to_address()..=self.to_address() + 4095
    }
}
