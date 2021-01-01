(module
  (type $t0 (func))
  (type $t1 (func (param i32)))
  (type $t2 (func (param i32 i32)))
  (type $t3 (func (param i32 i32 i32)))
  (type $t4 (func (result i32)))
  (type $t5 (func (result i64)))
  (type $t6 (func (param i32) (result i32)))
  (type $t7 (func (param i32 i32) (result i32)))
  (type $t8 (func (param i32) (result i64)))
  (type $t9 (func (param f32) (result i32)))
  (type $t10 (func (param f64) (result i32)))
  (type $t11 (func (param i32 i64)))
  (type $t12 (func (param i64 i32)))
  (type $t13 (func (param i64 i32) (result i32)))
  (type $t14 (func (param i64 i32) (result i64)))
  (type $t15 (func (param i32 i32 i32) (result i32)))
  (type $t16 (func (param i64 i32 i32)))
  (type $t17 (func (param i32 i64 i32)))
  (type $t18 (func (param i32 i64 i32) (result i32)))
  (type $t19 (func (param i32 i64 i64 i32) (result i32)))
  (import "e" "safe_write32_slow_jit" (func $e.safe_write32_slow_jit (type $t15)))
  (import "e" "instr_F4" (func $e.instr_F4 (type $t0)))
  (import "e" "safe_read32s_slow_jit" (func $e.safe_read32s_slow_jit (type $t7)))
  (import "e" "get_phys_eip_slow_jit" (func $e.get_phys_eip_slow_jit (type $t6)))
  (import "e" "jit_find_cache_entry_in_page" (func $e.jit_find_cache_entry_in_page (type $t15)))
  (import "e" "trigger_fault_end_jit" (func $e.trigger_fault_end_jit (type $t0)))
  (import "e" "m" (memory $e.m 128))
  (func $f (export "f") (type $t1) (param $p0 i32)
    (local $l0 i32) (local $l1 i32) (local $l2 i32) (local $l3 i32) (local $l4 i32) (local $l5 i32) (local $l6 i32) (local $l7 i32) (local $l8 i32) (local $l9 i32) (local $l10 i32) (local $l11 i32) (local $l12 i32) (local $l13 i32)
    (set_local $l0
      (get_local $p0))
    (set_local $l1
      (i32.const 20011))
    (set_local $l2
      (i32.load
        (i32.const 64)))
    (set_local $l3
      (i32.load
        (i32.const 68)))
    (set_local $l4
      (i32.load
        (i32.const 72)))
    (set_local $l5
      (i32.load
        (i32.const 76)))
    (set_local $l6
      (i32.load
        (i32.const 80)))
    (set_local $l7
      (i32.load
        (i32.const 84)))
    (set_local $l8
      (i32.load
        (i32.const 88)))
    (set_local $l9
      (i32.load
        (i32.const 92)))
    (block $B0
      (loop $L1
        (block $B2
          (block $B3
            (set_local $l1
              (i32.add
                (get_local $l1)
                (i32.const -1)))
            (if $I4
              (i32.eqz
                (get_local $l1))
              (then
                (br $B0)))
            (block $B5
              (block $B6
                (block $B7
                  (br_table $B7 $B6 $B5 $B3
                    (get_local $l0)))
                (i32.store
                  (i32.const 664)
                  (i32.add
                    (i32.load
                      (i32.const 664))
                    (i32.const 1)))
                (i32.store
                  (i32.const 560)
                  (i32.load
                    (i32.const 556)))
                (i32.store
                  (i32.const 556)
                  (i32.add
                    (i32.load
                      (i32.const 556))
                    (i32.const 5)))
                (set_local $l10
                  (i32.sub
                    (i32.load
                      (i32.const 556))
                    (i32.load
                      (i32.const 740))))
                (set_local $l12
                  (i32.add
                    (tee_local $l11
                      (i32.sub
                        (get_local $l6)
                        (i32.const 4)))
                    (i32.load
                      (i32.const 744))))
                (block $B8
                  (br_if $B8
                    (i32.and
                      (i32.eq
                        (i32.and
                          (tee_local $l13
                            (i32.load offset=316208
                              (i32.shl
                                (i32.shr_u
                                  (get_local $l12)
                                  (i32.const 12))
                                (i32.const 2))))
                          (i32.const 4075))
                        (i32.const 1))
                      (i32.le_s
                        (i32.and
                          (get_local $l12)
                          (i32.const 4095))
                        (i32.const 4092))))
                  (br_if $B3
                    (i32.and
                      (tee_local $l13
                        (call $e.safe_write32_slow_jit
                          (get_local $l12)
                          (get_local $l10)
                          (i32.const 0)))
                      (i32.const 1))))
                (i32.store align=1
                  (i32.add
                    (i32.xor
                      (i32.and
                        (get_local $l13)
                        (i32.const -4096))
                      (get_local $l12))
                    (i32.const 18247680))
                  (get_local $l10))
                (set_local $l6
                  (get_local $l11))
                (i32.store
                  (i32.const 556)
                  (i32.add
                    (i32.load
                      (i32.const 556))
                    (i32.const 1)))
                (set_local $l0
                  (i32.const 2))
                (br $L1))
              (i32.store
                (i32.const 664)
                (i32.add
                  (i32.load
                    (i32.const 664))
                  (i32.const 1)))
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
                (i32.const 64)
                (get_local $l2))
              (i32.store
                (i32.const 68)
                (get_local $l3))
              (i32.store
                (i32.const 72)
                (get_local $l4))
              (i32.store
                (i32.const 76)
                (get_local $l5))
              (i32.store
                (i32.const 80)
                (get_local $l6))
              (i32.store
                (i32.const 84)
                (get_local $l7))
              (i32.store
                (i32.const 88)
                (get_local $l8))
              (i32.store
                (i32.const 92)
                (get_local $l9))
              (call $e.instr_F4)
              (set_local $l2
                (i32.load
                  (i32.const 64)))
              (set_local $l3
                (i32.load
                  (i32.const 68)))
              (set_local $l4
                (i32.load
                  (i32.const 72)))
              (set_local $l5
                (i32.load
                  (i32.const 76)))
              (set_local $l6
                (i32.load
                  (i32.const 80)))
              (set_local $l7
                (i32.load
                  (i32.const 84)))
              (set_local $l8
                (i32.load
                  (i32.const 88)))
              (set_local $l9
                (i32.load
                  (i32.const 92)))
              (br $B0))
            (i32.store
              (i32.const 664)
              (i32.add
                (i32.load
                  (i32.const 664))
                (i32.const 2)))
            (i32.store
              (i32.const 120)
              (i32.or
                (i32.and
                  (i32.load
                    (i32.const 120))
                  (i32.const -2))
                (if $I9 (result i32)
                  (i32.and
                    (tee_local $l10
                      (i32.load
                        (i32.const 116)))
                    (i32.const 1))
                  (then
                    (set_local $l10
                      (i32.shr_s
                        (get_local $l10)
                        (i32.const 31)))
                    (i32.lt_u
                      (i32.xor
                        (i32.load
                          (i32.const 112))
                        (get_local $l10))
                      (i32.xor
                        (i32.load
                          (i32.const 96))
                        (get_local $l10))))
                  (else
                    (i32.and
                      (i32.load
                        (i32.const 120))
                      (i32.const 1))))))
            (i32.store
              (i32.const 96)
              (get_local $l2))
            (set_local $l2
              (i32.add
                (get_local $l2)
                (i32.const 1)))
            (i32.store
              (i32.const 112)
              (get_local $l2))
            (i32.store
              (i32.const 104)
              (i32.const 31))
            (i32.store
              (i32.const 116)
              (i32.const 2260))
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
            (set_local $l10
              (i32.add
                (get_local $l6)
                (i32.load
                  (i32.const 744))))
            (block $B10
              (br_if $B10
                (i32.and
                  (i32.eq
                    (i32.and
                      (tee_local $l11
                        (i32.load offset=316208
                          (i32.shl
                            (i32.shr_u
                              (get_local $l10)
                              (i32.const 12))
                            (i32.const 2))))
                      (i32.const 4041))
                    (i32.const 1))
                  (i32.le_s
                    (i32.and
                      (get_local $l10)
                      (i32.const 4095))
                    (i32.const 4092))))
              (br_if $B3
                (i32.and
                  (tee_local $l11
                    (call $e.safe_read32s_slow_jit
                      (get_local $l10)
                      (i32.const 7)))
                  (i32.const 1))))
            (i32.load align=1
              (i32.add
                (i32.xor
                  (i32.and
                    (get_local $l11)
                    (i32.const -4096))
                  (get_local $l10))
                (i32.const 18247680)))
            (set_local $l6
              (i32.add
                (get_local $l6)
                (i32.const 4)))
            (i32.load
              (i32.const 740))
            (i32.add)
            (set_local $l10)
            (i32.store
              (i32.const 556)
              (get_local $l10))
            (block $B11
              (br_if $B11
                (i32.eq
                  (i32.and
                    (tee_local $l11
                      (i32.load offset=316208
                        (i32.shl
                          (i32.shr_u
                            (get_local $l10)
                            (i32.const 12))
                          (i32.const 2))))
                    (i32.const 4041))
                  (i32.const 1)))
              (br_if $B3
                (i32.and
                  (tee_local $l11
                    (call $e.get_phys_eip_slow_jit
                      (get_local $l10)))
                  (i32.const 1))))
            (if $I12
              (i32.ge_s
                (tee_local $l10
                  (call $e.jit_find_cache_entry_in_page
                    (i32.xor
                      (i32.and
                        (get_local $l11)
                        (i32.const -4096))
                      (get_local $l10))
                    (i32.const 899)
                    (i32.const 3)))
                (i32.const 0))
              (then
                (set_local $l0
                  (get_local $l10))
                (br $L1)))
            (br $B0))
          (i32.store
            (i32.const 64)
            (get_local $l2))
          (i32.store
            (i32.const 68)
            (get_local $l3))
          (i32.store
            (i32.const 72)
            (get_local $l4))
          (i32.store
            (i32.const 76)
            (get_local $l5))
          (i32.store
            (i32.const 80)
            (get_local $l6))
          (i32.store
            (i32.const 84)
            (get_local $l7))
          (i32.store
            (i32.const 88)
            (get_local $l8))
          (i32.store
            (i32.const 92)
            (get_local $l9))
          (call $e.trigger_fault_end_jit)
          (return))
        (unreachable)))
    (i32.store
      (i32.const 64)
      (get_local $l2))
    (i32.store
      (i32.const 68)
      (get_local $l3))
    (i32.store
      (i32.const 72)
      (get_local $l4))
    (i32.store
      (i32.const 76)
      (get_local $l5))
    (i32.store
      (i32.const 80)
      (get_local $l6))
    (i32.store
      (i32.const 84)
      (get_local $l7))
    (i32.store
      (i32.const 88)
      (get_local $l8))
    (i32.store
      (i32.const 92)
      (get_local $l9))))
