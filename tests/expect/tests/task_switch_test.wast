(module
  (type $t0 (func))
  (type $t1 (func (param i32)))
  (type $t2 (func (param i32 i32)))
  (type $t3 (func (param i32 i32 i32)))
  (type $t4 (func (result i32)))
  (type $t5 (func (param i32) (result i32)))
  (type $t6 (func (param i32 i32) (result i32)))
  (import "e" "get_seg" (func $e.get_seg (type $t5)))
  (import "e" "task_switch_test_void" (func $e.task_switch_test_void (type $t0)))
  (import "e" "instr_DE_0_reg" (func $e.instr_DE_0_reg (type $t1)))
  (import "e" "instr_F4" (func $e.instr_F4 (type $t0)))
  (import "e" "m" (memory $e.m 256))
  (func $f (export "f") (type $t1) (param $p0 i32)
    (local $l0 i32)
    (set_local $p0
      (get_local $p0))
    (loop $L0
      (block $B1
        (block $B2
          (block $B3
            (br_table $B3 $B2 $B1
              (get_local $p0)))
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
          (if $I4
            (i32.and
              (i32.load
                (i32.const 580))
              (i32.const 12))
            (then
              (call $e.task_switch_test_void)
              (return)))
          (call $e.instr_DE_0_reg
            (i32.const 1))
          (i32.store
            (i32.const 664)
            (i32.add
              (i32.load
                (i32.const 664))
              (i32.const 1)))
          (return))
        (i32.store
          (i32.const 560)
          (i32.load
            (i32.const 556)))
        (i32.store
          (i32.const 556)
          (i32.add
            (i32.load
              (i32.const 556))
            (i32.const 1)))
        (call $e.instr_F4)
        (i32.store
          (i32.const 664)
          (i32.add
            (i32.load
              (i32.const 664))
            (i32.const 1)))
        (return))
      (unreachable))))
