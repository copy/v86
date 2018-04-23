target datalayout = "e-p:32:32-i64:64-v128:32:128-n32-S128"
target triple = "asmjs-unknown-emscripten"

define void @call_indirect(void ()* %callee) {
  call void %callee()
  ret void
}

define void @call_indirect1(void (i32)* %callee, i32 %arg) {
  call void %callee(i32 %arg)
  ret void
}
