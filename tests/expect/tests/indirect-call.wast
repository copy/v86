(module
  (type $t0 (func))
  (type $t1 (func (param i32)))
  (type $t2 (func (param i32 i32)))
  (type $t3 (func (param i32 i32 i32)))
  (type $t4 (func (result i32)))
  (type $t5 (func (param i32) (result i32)))
  (type $t6 (func (param i32 i32) (result i32)))
  (import "e" "get_seg" (func $e.get_seg (type $t5)))
  (import "e" "instr32_FF_2_mem" (func $e.instr32_FF_2_mem (type $t1)))
  (import "e" "m" (memory $e.m 256))
  (func $f (export "f") (type $t0)
    (local $l0 i32) (local $l1 i32)
    (set_local $l0
      (i32.const 0))
    (set_local $l1
      (i32.const 10000))
    (loop $L0
      (set_local $l1
        (i32.add
          (get_local $l1)
          (i32.const -1)))
      (if $I1
        (i32.eqz
          (get_local $l1))
        (then
          (return)))
      (block $B2
        (block $B3
          (br_table $B3 $B2
            (get_local $l0)))
        (i32.store
          (i32.const 560)
          (i32.load
            (i32.const 556)))
        (i32.store
          (i32.const 556)
          (i32.add
            (i32.load
              (i32.const 556))
            (i32.const 2)))
        (call $e.instr32_FF_2_mem
          (i32.add
            (i32.load
              (i32.const 4))
            (call $e.get_seg
              (i32.const 3))))
        (i32.store
          (i32.const 664)
          (i32.add
            (i32.load
              (i32.const 664))
            (i32.const 1)))
        (return))
      (unreachable))))
