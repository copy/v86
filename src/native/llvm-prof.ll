target datalayout = "e-p:32:32-i64:64-v128:32:128-n32-S128"
target triple = "asmjs-unknown-emscripten"

declare void @coverage_log(i8* %arg1, i32 %arg2, i32 %arg3)

; See:
;   - https://llvm.org/doxygen/classllvm_1_1InstrProfIncrementInst.html#details
;   - https://llvm.org/doxygen/IntrinsicInst_8h_source.html#l00715
;   - https://llvm.org/docs/CoverageMappingFormat.html#coverage-mapping-counter

; LLVM wouldn't let us redefine an intrinsic (llvm.instrprof.increment), but we can override it
; anyway because Emscripten converts it to the following:

define void @llvm_instrprof_increment(i8* %func_name, i64 %func_hash, i32 %num_counters, i32 %index)
{
  call void @coverage_log(i8* %func_name, i32 %num_counters, i32 %index)
  ret void
}
