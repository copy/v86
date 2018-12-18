(module
  (type $t0 (func))
  (type $t1 (func (param i32)))
  (type $t2 (func (param i32 i32)))
  (type $t3 (func (param i32 i32 i32)))
  (type $t4 (func (result i32)))
  (type $t5 (func (param i32) (result i32)))
  (type $t6 (func (param i32 i32) (result i32)))
  (type $t7 (func (param i32) (result f64)))
  (type $t8 (func (param i32 f64)))
  (type $t9 (func (param f64)))
  (type $t10 (func (param i32) (result i64)))
  (type $t11 (func (param i32 i64)))
  (type $t12 (func (param f64) (result i32)))
  (type $t13 (func (param f64) (result i64)))
  (type $t14 (func (param i32 i32 i32) (result i32)))
  (type $t15 (func (param i32 i64 i64)))
  (import "e" "safe_read32s_slow_jit" (func $e.safe_read32s_slow_jit (type $t5)))
  (import "e" "instr_F4" (func $e.instr_F4 (type $t0)))
  (import "e" "m" (memory $e.m 256))
  (func $f (export "f") (type $t1) (param $p0 i32)
    (local $l0 i32) (local $l1 i32) (local $l2 i32) (local $l3 i32) (local $l4 i32)
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
        (i32.const 4)
        (if $I4 (result i32)
          (i32.and
            (i32.eq
              (i32.and
                (tee_local $l4
                  (i32.load offset=4194304
                    (i32.shl
                      (i32.shr_u
                        (tee_local $l3
                          (i32.add
                            (tee_local $l2
                              (i32.load
                                (i32.const 20)))
                            (i32.load
                              (i32.const 744))))
                        (i32.const 12))
                      (i32.const 2))))
                (i32.const 4041))
              (i32.const 1))
            (i32.le_s
              (i32.and
                (get_local $l3)
                (i32.const 4095))
              (i32.const 4092)))
          (then
            (i32.load offset={normalised output} align=1
              (i32.xor
                (i32.and
                  (get_local $l4)
                  (i32.const -4096))
                (get_local $l3))))
          (else
            (i32.store
              (i32.const 560)
              (i32.or
                (i32.and
                  (i32.load
                    (i32.const 556))
                  (i32.const -4096))
                (i32.const 0)))
            (call $e.safe_read32s_slow_jit
              (get_local $l3))
            (if $I5
              (i32.load8_u
                (i32.const 540))
              (then
                (return)))))
        (i32.store
          (i32.const 20)
          (i32.add
            (get_local $l2)
            (i32.const 4)))
        (i32.store)
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
