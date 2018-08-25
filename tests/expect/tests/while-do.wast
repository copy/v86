(module
  (type $t0 (func))
  (type $t1 (func (param i32)))
  (type $t2 (func (param i32 i32)))
  (type $t3 (func (param i32 i32 i32)))
  (type $t4 (func (result i32)))
  (type $t5 (func (param i32) (result i32)))
  (type $t6 (func (param i32 i32) (result i32)))
  (import "e" "get_seg" (func $e.get_seg (type $t5)))
  (import "e" "cmp32" (func $e.cmp32 (type $t2)))
  (import "e" "test_z" (func $e.test_z (type $t4)))
  (import "e" "instr32_43" (func $e.instr32_43 (type $t0)))
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
            (block $B4
              (br_table $B4 $B3 $B2 $B1
                (get_local $p0)))
            (call $e.cmp32
              (i32.load
                (i32.const 4))
              (i32.const 10))
            (i32.store
              (i32.const 560)
              (i32.add
                (i32.load
                  (i32.const 556))
                (i32.const 3)))
            (i32.store
              (i32.const 556)
              (i32.add
                (i32.load
                  (i32.const 556))
                (i32.const 5)))
            (i32.store
              (i32.const 664)
              (i32.add
                (i32.load
                  (i32.const 664))
                (i32.const 2)))
            (if $I5
              (call $e.test_z)
              (then
                (i32.store
                  (i32.const 556)
                  (i32.add
                    (i32.load
                      (i32.const 556))
                    (i32.const 3)))
                (set_local $p0
                  (i32.const 2)))
              (else
                (set_local $p0
                  (i32.const 1))))
            (br $L0))
          (call $e.instr32_43)
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
              (i32.const 3)))
          (i32.store
            (i32.const 664)
            (i32.add
              (i32.load
                (i32.const 664))
              (i32.const 2)))
          (i32.store
            (i32.const 556)
            (i32.add
              (i32.load
                (i32.const 556))
              (i32.const -8)))
          (set_local $p0
            (i32.const 0))
          (br $L0))
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
        (i32.store
          (i32.const 664)
          (i32.add
            (i32.load
              (i32.const 664))
            (i32.const 1)))
        (call $e.instr_F4)
        (return))
      (unreachable))))
