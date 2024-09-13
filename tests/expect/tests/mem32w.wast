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
  (type $t15 (func (param f32 i32)))
  (type $t16 (func (param i32 i32 i32) (result i32)))
  (type $t17 (func (param i64 i32 i32)))
  (type $t18 (func (param i32 i64 i32)))
  (type $t19 (func (param i32 i64 i32) (result i32)))
  (type $t20 (func (param i32 i64 i64 i32) (result i32)))
  (import "e" "trigger_gp_jit" (func $e.trigger_gp_jit (type $t2)))
  (import "e" "safe_write32_slow_jit" (func $e.safe_write32_slow_jit (type $t16)))
  (import "e" "instr_F4" (func $e.instr_F4 (type $t0)))
  (import "e" "trigger_fault_end_jit" (func $e.trigger_fault_end_jit (type $t0)))
  (import "e" "m" (memory {normalised output}))
  (func $f (export "f") (type $t1) (param $p0 i32)
    (local $l0 i32) (local $l1 i32) (local $l2 i32) (local $l3 i32) (local $l4 i32) (local $l5 i32) (local $l6 i32) (local $l7 i32) (local $l8 i32) (local $l9 i32) (local $l10 i32)
    (set_local $l0
      (i32.load
        (i32.const 64)))
    (set_local $l1
      (i32.load
        (i32.const 68)))
    (set_local $l2
      (i32.load
        (i32.const 72)))
    (set_local $l3
      (i32.load
        (i32.const 76)))
    (set_local $l4
      (i32.load
        (i32.const 80)))
    (set_local $l5
      (i32.load
        (i32.const 84)))
    (set_local $l6
      (i32.load
        (i32.const 88)))
    (set_local $l7
      (i32.load
        (i32.const 92)))
    (set_local $l8
      (i32.const 0))
    (block $B0
      (block $B1
        (loop $L2
          (br_if $B0
            (i32.ge_u
              (get_local $l8)
              (i32.const 100003)))
          (block $B3
            (block $B4
            )
            (set_local $l8
              (i32.add
                (get_local $l8)
                (i32.const 2)))
            (i32.add
              (get_local $l3)
              (i32.const 123456789))
            (if $I5
              (i32.load8_u
                (i32.const 727))
              (then
                (call $e.trigger_gp_jit
                  (i32.const 0)
                  (i32.const 0))
                (br $B1)))
            (i32.load
              (i32.const 748))
            (i32.add)
            (set_local $l9)
            (block $B6
              (br_if $B6
                (i32.and
                  (i32.eq
                    (i32.and
                      (tee_local $l10
                        (i32.load offset={normalised output}
                          (i32.shl
                            (i32.shr_u
                              (get_local $l9)
                              (i32.const 12))
                            (i32.const 2))))
                      (i32.const 4075))
                    (i32.const 1))
                  (i32.le_s
                    (i32.and
                      (get_local $l9)
                      (i32.const 4095))
                    (i32.const 4092))))
              (br_if $B1
                (i32.and
                  (tee_local $l10
                    (call $e.safe_write32_slow_jit
                      (get_local $l9)
                      (get_local $l0)
                      (i32.const 0)))
                  (i32.const 1))))
            (i32.store align=1
              (i32.xor
                (i32.and
                  (get_local $l10)
                  (i32.const -4096))
                (get_local $l9))
              (get_local $l0))
            (i32.store
              (i32.const 560)
              (i32.or
                (i32.and
                  (i32.load
                    (i32.const 556))
                  (i32.const -4096))
                (i32.const 6)))
            (i32.store
              (i32.const 556)
              (i32.or
                (i32.and
                  (i32.load
                    (i32.const 556))
                  (i32.const -4096))
                (i32.const 7)))
            (i32.store
              (i32.const 64)
              (get_local $l0))
            (i32.store
              (i32.const 68)
              (get_local $l1))
            (i32.store
              (i32.const 72)
              (get_local $l2))
            (i32.store
              (i32.const 76)
              (get_local $l3))
            (i32.store
              (i32.const 80)
              (get_local $l4))
            (i32.store
              (i32.const 84)
              (get_local $l5))
            (i32.store
              (i32.const 88)
              (get_local $l6))
            (i32.store
              (i32.const 92)
              (get_local $l7))
            (call $e.instr_F4)
            (set_local $l0
              (i32.load
                (i32.const 64)))
            (set_local $l1
              (i32.load
                (i32.const 68)))
            (set_local $l2
              (i32.load
                (i32.const 72)))
            (set_local $l3
              (i32.load
                (i32.const 76)))
            (set_local $l4
              (i32.load
                (i32.const 80)))
            (set_local $l5
              (i32.load
                (i32.const 84)))
            (set_local $l6
              (i32.load
                (i32.const 88)))
            (set_local $l7
              (i32.load
                (i32.const 92)))
            (br $B0))
          (unreachable)))
      (i32.store
        (i32.const 64)
        (get_local $l0))
      (i32.store
        (i32.const 68)
        (get_local $l1))
      (i32.store
        (i32.const 72)
        (get_local $l2))
      (i32.store
        (i32.const 76)
        (get_local $l3))
      (i32.store
        (i32.const 80)
        (get_local $l4))
      (i32.store
        (i32.const 84)
        (get_local $l5))
      (i32.store
        (i32.const 88)
        (get_local $l6))
      (i32.store
        (i32.const 92)
        (get_local $l7))
      (call $e.trigger_fault_end_jit)
      (i32.store
        (i32.const 664)
        (i32.add
          (i32.load
            (i32.const 664))
          (get_local $l8)))
      (return))
    (i32.store
      (i32.const 64)
      (get_local $l0))
    (i32.store
      (i32.const 68)
      (get_local $l1))
    (i32.store
      (i32.const 72)
      (get_local $l2))
    (i32.store
      (i32.const 76)
      (get_local $l3))
    (i32.store
      (i32.const 80)
      (get_local $l4))
    (i32.store
      (i32.const 84)
      (get_local $l5))
    (i32.store
      (i32.const 88)
      (get_local $l6))
    (i32.store
      (i32.const 92)
      (get_local $l7))
    (i32.store
      (i32.const 664)
      (i32.add
        (i32.load
          (i32.const 664))
        (get_local $l8)))))
