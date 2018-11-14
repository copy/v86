(module
  (type $t0 (func))
  (type $t1 (func (param i32)))
  (type $t2 (func (param i32 i32)))
  (type $t3 (func (param i32 i32 i32)))
  (type $t4 (func (result i32)))
  (type $t5 (func (param i32) (result i32)))
  (type $t6 (func (param i32 i32) (result i32)))
  (import "e" "get_seg" (func $e.get_seg (type $t5)))
  (import "e" "safe_write32_slow_jit" (func $e.safe_write32_slow_jit (type $t2)))
  (import "e" "safe_read32s_slow_jit" (func $e.safe_read32s_slow_jit (type $t5)))
  (import "e" "instr_F4" (func $e.instr_F4 (type $t0)))
  (import "e" "m" (memory $e.m 256))
  (func $f (export "f") (type $t1) (param $p0 i32)
    (local $l0 i32) (local $l1 i32) (local $l2 i32) (local $l3 i32) (local $l4 i32)
    (set_local $p0
      (get_local $p0))
    (set_local $l0
      (i32.const 10000))
    (loop $L0
      (set_local $l0
        (i32.add
          (get_local $l0)
          (i32.const -1)))
      (if $I1
        (i32.eqz
          (get_local $l0))
        (then
          (return)))
      (block $B2
        (block $B3
          (br_table $B3 $B2
            (get_local $p0)))
        (set_local $l1
          (i32.add
            (i32.add
              (i32.load
                (i32.const 16))
              (i32.const 32))
            (call $e.get_seg
              (i32.const 3))))
        (set_local $l2
          (i32.load
            (i32.const 4)))
        (if $I4
          (i32.and
            (i32.eq
              (i32.and
                (tee_local $l3
                  (i32.load offset=4194304
                    (i32.shl
                      (i32.shr_u
                        (get_local $l1)
                        (i32.const 12))
                      (i32.const 2))))
                (i32.const 4075))
              (i32.const 1))
            (i32.le_s
              (i32.and
                (get_local $l1)
                (i32.const 4095))
              (i32.const 4092)))
          (then
            (i32.store offset={normalised output} align=1
              (i32.xor
                (i32.and
                  (get_local $l3)
                  (i32.const -4096))
                (get_local $l1))
              (get_local $l2)))
          (else
            (i32.store
              (i32.const 560)
              (i32.or
                (i32.and
                  (i32.load
                    (i32.const 556))
                  (i32.const -4096))
                (i32.const 0)))
            (call $e.safe_write32_slow_jit
              (get_local $l1)
              (get_local $l2))
            (if $I5
              (i32.load8_u
                (i32.const 540))
              (then
                (return)))))
        (set_local $l2
          (i32.add
            (i32.add
              (i32.load
                (i32.const 12))
              (i32.const 28))
            (call $e.get_seg
              (i32.const 3))))
        (set_local $l1
          (i32.load
            (i32.const 8)))
        (if $I6
          (i32.and
            (i32.eq
              (i32.and
                (tee_local $l3
                  (i32.load offset=4194304
                    (i32.shl
                      (i32.shr_u
                        (get_local $l2)
                        (i32.const 12))
                      (i32.const 2))))
                (i32.const 4075))
              (i32.const 1))
            (i32.le_s
              (i32.and
                (get_local $l2)
                (i32.const 4095))
              (i32.const 4092)))
          (then
            (i32.store offset={normalised output} align=1
              (i32.xor
                (i32.and
                  (get_local $l3)
                  (i32.const -4096))
                (get_local $l2))
              (get_local $l1)))
          (else
            (i32.store
              (i32.const 560)
              (i32.or
                (i32.and
                  (i32.load
                    (i32.const 556))
                  (i32.const -4096))
                (i32.const 6)))
            (call $e.safe_write32_slow_jit
              (get_local $l2)
              (get_local $l1))
            (if $I7
              (i32.load8_u
                (i32.const 540))
              (then
                (return)))))
        (i32.store
          (i32.const 28)
          (if $I8 (result i32)
            (i32.and
              (i32.eq
                (i32.and
                  (tee_local $l2
                    (i32.load offset=4194304
                      (i32.shl
                        (i32.shr_u
                          (tee_local $l1
                            (i32.add
                              (i32.add
                                (i32.load
                                  (i32.const 16))
                                (i32.const 28))
                              (call $e.get_seg
                                (i32.const 3))))
                          (i32.const 12))
                        (i32.const 2))))
                  (i32.const 4041))
                (i32.const 1))
              (i32.le_s
                (i32.and
                  (get_local $l1)
                  (i32.const 4095))
                (i32.const 4092)))
            (then
              (i32.load offset={normalised output} align=1
                (i32.xor
                  (i32.and
                    (get_local $l2)
                    (i32.const -4096))
                  (get_local $l1))))
            (else
              (i32.store
                (i32.const 560)
                (i32.or
                  (i32.and
                    (i32.load
                      (i32.const 556))
                    (i32.const -4096))
                  (i32.const 12)))
              (call $e.safe_read32s_slow_jit
                (get_local $l1))
              (if $I9
                (i32.load8_u
                  (i32.const 540))
                (then
                  (return))))))
        (i32.store
          (i32.const 32)
          (if $I10 (result i32)
            (i32.and
              (i32.eq
                (i32.and
                  (tee_local $l1
                    (i32.load offset=4194304
                      (i32.shl
                        (i32.shr_u
                          (tee_local $l2
                            (i32.add
                              (i32.add
                                (i32.load
                                  (i32.const 12))
                                (i32.const 32))
                              (call $e.get_seg
                                (i32.const 3))))
                          (i32.const 12))
                        (i32.const 2))))
                  (i32.const 4041))
                (i32.const 1))
              (i32.le_s
                (i32.and
                  (get_local $l2)
                  (i32.const 4095))
                (i32.const 4092)))
            (then
              (i32.load offset={normalised output} align=1
                (i32.xor
                  (i32.and
                    (get_local $l1)
                    (i32.const -4096))
                  (get_local $l2))))
            (else
              (i32.store
                (i32.const 560)
                (i32.or
                  (i32.and
                    (i32.load
                      (i32.const 556))
                    (i32.const -4096))
                  (i32.const 18)))
              (call $e.safe_read32s_slow_jit
                (get_local $l2))
              (if $I11
                (i32.load8_u
                  (i32.const 540))
                (then
                  (return))))))
        (i32.store
          (i32.const 560)
          (i32.add
            (i32.load
              (i32.const 556))
            (i32.const 24)))
        (i32.store
          (i32.const 556)
          (i32.add
            (i32.load
              (i32.const 556))
            (i32.const 25)))
        (call $e.instr_F4)
        (i32.store
          (i32.const 664)
          (i32.add
            (i32.load
              (i32.const 664))
            (i32.const 5)))
        (return))
      (unreachable))))
