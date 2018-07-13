(module
  (type $t0 (func))
  (type $t1 (func (param i32)))
  (type $t2 (func (param i32 i32)))
  (type $t3 (func (param i32 i32 i32)))
  (type $t4 (func (result i32)))
  (type $t5 (func (param i32) (result i32)))
  (type $t6 (func (param i32 i32) (result i32)))
  (import "e" "get_seg" (func $e.get_seg (type $t5)))
  (import "e" "instr16_B8" (func $e.instr16_B8 (type $t1)))
  (import "e" "instr16_8B_mem" (func $e.instr16_8B_mem (type $t2)))
  (import "e" "instr16_89_mem" (func $e.instr16_89_mem (type $t2)))
  (import "e" "instr_F4" (func $e.instr_F4 (type $t0)))
  (import "e" "m" (memory $e.m 256))
  (func $f (export "f") (type $t1) (param $p0 i32)
    (local $l0 i32) (local $l1 i32) (local $l2 i32) (local $l3 i32) (local $l4 i32)
    (set_local $l0
      (get_local $p0))
    (loop $L0
      (block $B1
        (block $B2
          (br_table $B2 $B1
            (get_local $l0)))
        (i32.store
          (i32.const 560)
          (i32.add
            (i32.load
              (i32.const 556))
            (i32.const 3)))
        (call $e.instr16_B8
          (i32.const 51966))
        (call $e.instr16_8B_mem
          (i32.add
            (i32.const 32)
            (call $e.get_seg
              (i32.const 3)))
          (i32.const 1))
        (i32.store
          (i32.const 560)
          (i32.add
            (i32.load
              (i32.const 556))
            (i32.const 7)))
        (call $e.instr16_8B_mem
          (i32.add
            (i32.const 36)
            (call $e.get_seg
              (i32.const 3)))
          (i32.const 2))
        (i32.store
          (i32.const 560)
          (i32.add
            (i32.load
              (i32.const 556))
            (i32.const 19)))
        (i32.store16
          (i32.const 32)
          (i32.const 36))
        (i32.store16
          (i32.const 28)
          (i32.const 32))
        (call $e.instr16_89_mem
          (i32.add
            (i32.and
              (i32.add
                (i32.load16_u
                  (i32.const 16))
                (i32.load16_u
                  (i32.const 32)))
              (i32.const 65535))
            (call $e.get_seg
              (i32.const 3)))
          (i32.const 0))
        (i32.store
          (i32.const 560)
          (i32.add
            (i32.load
              (i32.const 556))
            (i32.const 21)))
        (call $e.instr16_89_mem
          (i32.add
            (i32.and
              (i32.add
                (i32.load16_u
                  (i32.const 16))
                (i32.load16_u
                  (i32.const 28)))
              (i32.const 65535))
            (call $e.get_seg
              (i32.const 3)))
          (i32.const 1))
        (i32.store
          (i32.const 560)
          (i32.add
            (i32.load
              (i32.const 556))
            (i32.const 31)))
        (i32.store
          (i32.const 556)
          (i32.add
            (i32.load
              (i32.const 556))
            (i32.const 32)))
        (i32.store16
          (i32.const 8)
          (i32.load16_u
            (i32.const 28)))
        (i32.store16
          (i32.const 12)
          (i32.load16_u
            (i32.const 32)))
        (i32.store16
          (i32.const 12)
          (i32.load16_u
            (i32.const 4)))
        (i32.store16
          (i32.const 4)
          (i32.load16_u
            (i32.const 8)))
        (call $e.instr_F4)
        (i32.store
          (i32.const 664)
          (i32.add
            (i32.load
              (i32.const 664))
            (i32.const 12)))
        (return))
      (unreachable))))
