ALL:= arith.rs cpu.rs fpu.rs instructions_0f.rs instructions.rs \
    memory.rs misc_instr.rs modrm.rs shared.rs sse_instr.rs string.rs \
    global_pointers.rs profiler.rs

all: $(ALL)

profiler.rs: profiler/profiler.rs
	cp profiler/profiler.rs profiler.rs

%.rs:
	#citrus --api=rust $< -I ../../native/ ../../native/profiler/ > $@.tmp
	#cat import-prefix $@.tmp | grep -v cpu2::$(basename $@):: > $@
	#rm $@.tmp
	#sed -i 's/assert(/assert!(/' $@
	#sed -i 's/dbg_assert(/dbg_assert!(/' $@
	#sed -i 's/dbg_log(/dbg_log!(/' $@
	#sed -i 's/%x/{:x}/g' $@
	#sed -i 's/%d/{}/g' $@
	#sed -i '/:.*= ()/d' $@
	#sed -i 's/!= 0 != 0//' $@
	#sed -i 's/fn(,/fn(i32,/' $@
	#sed -i 's/is_32 != 0/is_32/' $@
	#sed -i 's/SAFE_READ_WRITE8/SAFE_READ_WRITE8!/' $@
	#sed -i 's/SAFE_READ_WRITE16/SAFE_READ_WRITE16!/' $@
	#sed -i 's/SAFE_READ_WRITE32/SAFE_READ_WRITE32!/' $@
	#sed -i 's/pub fn SAFE_READ_WRITE8!();//' $@
	#sed -i 's/pub fn SAFE_READ_WRITE16!();//' $@
	#sed -i 's/pub fn SAFE_READ_WRITE32!();//' $@

	cp ~/DL/c2rust/scripts/v86/src/native/$@ $@
	#cat import-prefix $@.tmp | grep -v cpu2::$(basename $@):: > $@
	#cat $@.tmp | grep -v cpu2::$(basename $@):: > $@
	-rm $@.tmp

	#sed -i 's/assert(/assert_c!(/' $@
	##sed -i 's/dbg_assert(/dbg_assert!(/' $@
	#sed -i 's/dbg_log(/dbg_log_c!(/' $@
	##sed -i 's/pub unsafe extern "C" fn assert_c!() -> () { }//' $@
	##sed -i 's/pub unsafe extern "C" fn dbg_assert_c!() -> () { }//' $@
	##sed -i 's/pub unsafe extern "C" fn dbg_log_c!() -> () { }//' $@

	#sed -i 's/fn assert_c!() -> ();//' $@
	#sed -i 's/fn dbg_assert_c!() -> ();//' $@
	#sed -i 's/fn dbg_log_c!() -> ();//' $@

	#sed -i 's/fn assert_c!/fn assert_c/' $@
	#sed -i 's/fn dbg_assert_c!/fn dbg_assert_c/' $@
	#sed -i 's/fn dbg_log_c!/fn dbg_log_c/' $@

	sed -i 's/libc::c_char/i8/g' $@
	sed -i 's/libc::c_double/f64/g' $@
	sed -i 's/libc::c_float/f32/g' $@
	sed -i 's/libc::c_int/i32/g' $@
	sed -i 's/libc::c_longlong/i64/g' $@
	sed -i 's/libc::c_long/i64/g' $@
	sed -i 's/libc::c_schar/i8/g' $@
	sed -i 's/libc::c_short/i16/g' $@
	sed -i 's/libc::c_uchar/u8/g' $@
	sed -i 's/libc::c_uint/u32/g' $@
	sed -i 's/libc::c_ulonglong/u64/g' $@
	sed -i 's/libc::c_ulong/u64/g' $@
	sed -i 's/libc::c_ushort/u16/g' $@

	sed -i 's/pub type double_t = f64;//' $@
	sed -i 's/pub type float_t = f32;//' $@
	sed -i 's/pub type uint64_t = u64;//' $@
	sed -i 's/pub type int64_t = i64;//' $@
	sed -i 's/pub type int32_t = i32;//' $@
	sed -i 's/pub type uint32_t = u32;//' $@
	sed -i 's/pub type int16_t = i16;//' $@
	sed -i 's/pub type uint16_t = u16;//' $@
	sed -i 's/pub type int8_t = i8;//' $@
	sed -i 's/pub type uint8_t = u8;//' $@

	sed -i 's/double_t/f64/g' $@
	sed -i 's/float_t/f32/g' $@
	sed -i 's/uint64_t/u64/g' $@
	sed -i 's/int64_t/i64/g' $@
	sed -i 's/uint32_t/u32/g' $@
	sed -i 's/int32_t/i32/g' $@
	sed -i 's/uint16_t/u16/g' $@
	sed -i 's/int16_t/i16/g' $@
	sed -i 's/uint8_t/u8/g' $@
	sed -i 's/int8_t/i8/g' $@

	sed -i 's/SAFE_READ_WRITE8/SAFE_READ_WRITE8!/' $@
	sed -i 's/SAFE_READ_WRITE16/SAFE_READ_WRITE16!/' $@
	sed -i 's/SAFE_READ_WRITE32/SAFE_READ_WRITE32!/' $@
	sed -i 's/fn SAFE_READ_WRITE8!() -> ();//' $@
	sed -i 's/fn SAFE_READ_WRITE16!() -> ();//' $@
	sed -i 's/fn SAFE_READ_WRITE32!() -> ();//' $@

	sed -i 's/pub type _IO_FILE;//' $@
	sed -i 's/pub type FILE = _IO_FILE;//' $@
	sed -i ':a;N;$$!ba;s/#\[no_mangle]\n    static stdin: \*mut FILE;//' $@
	sed -i ':a;N;$$!ba;s/#\[no_mangle]\n    static stdout: \*mut FILE;//' $@
	sed -i ':a;N;$$!ba;s/#\[no_mangle]\n    static stderr: \*mut FILE;//' $@

	sed -i ':a;N;$$!ba;s/#\[no_mangle]\n    static mut ___: i32;//' $@

	sed -i 's/SAFE_READ_WRITE8!(/SAFE_READ_WRITE8!(___, /' $@
	sed -i 's/SAFE_READ_WRITE16!(/SAFE_READ_WRITE16!(___, /' $@
	sed -i 's/SAFE_READ_WRITE32!(/SAFE_READ_WRITE32!(___, /' $@

	sed -i 's/extern crate libc;//' $@

	sed -i 's/.as_mut_ptr()//' $@
	sed -i ':a;N;$$!ba;s/\*::std::mem::transmute::<&\[u8; [0-9]\+],[ \n]\+&mut \[i8; [0-9]\+]>//g' $@
	sed -i 's/\\x00//' $@

	sed -i 's/dbg_log[0-9]\?((/dbg_log_c!((/' $@
	sed -i 's/    dbg_assert_message(/    dbg_assert_message!(/' $@
	sed -i 's/    c_comment(/    c_comment!(/' $@


clean:
	-rm $(ALL)
	-rm profiler/profiler.rs
