(module
  (type $t0 (func))
  (type $t1 (func (param i32)))
  (type $t2 (func (param i32 i32)))
  (type $t3 (func (param i32 i32 i32)))
  (type $t4 (func (result i32)))
  (type $t5 (func (param i32) (result i32)))
  (type $t6 (func (param i32 i32) (result i32)))
  (import "e" "get_seg" (func $e.get_seg (type $t5)))
  (import "e" "push32_ss32" (func $e.push32_ss32 (type $t1)))
  (import "e" "instr_F4" (func $e.instr_F4 (type $t0)))
  (import "e" "m" (memory $e.m 256))
  (func $f (export "f") (type $t1) (param $p0 i32)
    (local $l0 i32) (local $l1 i32) (local $l2 i32) (local $l3 i32)
    (set_local $l0
      (get_local $p0))
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
        (call $e.push32_ss32
          (i32.load
            (i32.const 4)))
        (i32.store
          (i32.const 560)
          (i32.add
            (i32.load
              (i32.const 556))
            (i32.const 1)))
        (i32.store
          (i32.const 556)
          (i32.add
            (i32.load
              (i32.const 556))
            (i32.const 2)))
        (call $e.instr_F4)
        (i32.store
          (i32.const 664)
          (i32.add
            (i32.load
              (i32.const 664))
            (i32.const 2)))
        (return))
      (unreachable))))
