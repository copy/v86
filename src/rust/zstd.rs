use std::alloc;

extern "C" {
    fn ZSTD_createDStream() -> u32;
    fn ZSTD_freeDStream(ctx: u32) -> i32;
    fn ZSTD_decompressStream_simpleArgs(
        ctx: u32,
        dst: *mut u8,
        dstCapacity: u32,
        dstPos: *mut u32,
        src: *const u8,
        srcSize: u32,
        srcPos: *mut u32,
    ) -> i32;

    fn ZSTD_isError(err: i32) -> bool;
}

const MALLOC_ALIGN: usize = 16;

// malloc and free are needed by the zstd library
#[no_mangle]
pub unsafe fn v86_malloc(size: u32) -> u32 {
    let layout = alloc::Layout::from_size_align(size as usize + 4, MALLOC_ALIGN).unwrap();
    let addr = alloc::alloc(layout);
    *(addr as *mut u32) = size as u32;
    addr as u32 + 4
}
#[no_mangle]
pub unsafe fn v86_free(addr: u32) {
    let size = *((addr - 4) as *mut u32);
    let layout = alloc::Layout::from_size_align(size as usize + 4, MALLOC_ALIGN).unwrap();
    alloc::dealloc((addr - 4) as *mut u8, layout)
}

pub struct ZstdContext {
    ctx: u32,
    src: *mut u8,
    src_size: u32,
    src_pos: u32,
}

#[no_mangle]
pub unsafe fn zstd_create_ctx(src_size: u32) -> *mut ZstdContext {
    let src = alloc::alloc(alloc::Layout::from_size_align(src_size as usize, 1).unwrap());
    let ctx = ZSTD_createDStream();
    let result = alloc::alloc(alloc::Layout::new::<ZstdContext>()) as *mut ZstdContext;
    *result = ZstdContext {
        ctx,
        src,
        src_size,
        src_pos: 0,
    };
    result
}

#[no_mangle]
pub unsafe fn zstd_get_src_ptr(ctx: *mut ZstdContext) -> *mut u8 { (*ctx).src }

#[no_mangle]
pub unsafe fn zstd_free_ctx(ctx: *mut ZstdContext) {
    alloc::dealloc(
        (*ctx).src,
        alloc::Layout::from_size_align((*ctx).src_size as usize, 1).unwrap(),
    );
    ZSTD_freeDStream((*ctx).ctx);
    std::ptr::drop_in_place(ctx);
}

#[no_mangle]
pub unsafe fn zstd_read(ctx: *mut ZstdContext, length: u32) -> *mut u8 {
    let dst = alloc::alloc(alloc::Layout::from_size_align(length as usize, 1).unwrap());
    let mut dst_pos = 0;
    let result = ZSTD_decompressStream_simpleArgs(
        (*ctx).ctx,
        dst,
        length,
        &mut dst_pos,
        (*ctx).src,
        (*ctx).src_size,
        &mut (*ctx).src_pos,
    );
    if ZSTD_isError(result) {
        dbg_log!(
            "ZSTD_decompressStream_simpleArgs returned error: {}",
            result
        );
        dbg_assert!(false);
        zstd_read_free(dst, length);
        return std::ptr::null_mut::<u8>();
    }
    if dst_pos != length {
        dbg_assert!(false, "ZSTD: Partial read");
        zstd_read_free(dst, length);
        return std::ptr::null_mut::<u8>();
    }
    dst
}
#[no_mangle]
pub unsafe fn zstd_read_free(ptr: *mut u8, length: u32) {
    alloc::dealloc(
        ptr,
        alloc::Layout::from_size_align(length as usize, 1).unwrap(),
    );
}
