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
  (import "e" "inc32" (func $e.inc32 (type $t5)))
  (import "e" "instr_F4" (func $e.instr_F4 (type $t0)))
  (import "e" "trigger_pagefault_end_jit" (func $e.trigger_pagefault_end_jit (type $t0)))
  (import "e" "m" (memory $e.m 256))
  (func $f (export "f") (type $t1) (param $p0 i32)
    (local $l0 i32) (local $l1 i32) (local $l2 i32) (local $l3 i32) (local $l4 i32) (local $l5 i32) (local $l6 i32) (local $l7 i32) (local $l8 i32) (local $l9 i32) (local $l10 i32) (local $l11 i32) (local $l12 i32)
    (set_local $l0
      (get_local $p0))
    (set_local $l1
      (i32.const 10000))
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
    (loop $L0
      (set_local $l1
        (i32.add
          (get_local $l1)
          (i32.const -1)))
      (if $I1
        (i32.eqz
          (get_local $l1))
        (then
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
          (return)))
      (block $B2
        (block $B3
          (block $B4
            (block $B5
              (br_table $B5 $B4 $B3 $B2
                (get_local $l0)))
            (set_local $l5
              (call $e.inc32
                (get_local $l5)))
            (get_local $l2)
            (set_local $l10
              (i32.const 10))
            (set_local $l11)
            (set_local $l12
              (i32.sub
                (get_local $l11)
                (get_local $l10)))
            (i32.store
              (i32.const 96)
              (get_local $l12))
            (i32.store
              (i32.const 100)
              (get_local $l10))
            (i32.store
              (i32.const 108)
              (get_local $l11))
            (i32.store
              (i32.const 112)
              (get_local $l12))
            (i32.store
              (i32.const 104)
              (i32.const 31))
            (i32.store
              (i32.const 116)
              (i32.const 2261))
            (i32.store
              (i32.const 560)
              (i32.add
                (i32.load
                  (i32.const 556))
                (i32.const 4)))
            (i32.store
              (i32.const 556)
              (i32.add
                (i32.load
                  (i32.const 556))
                (i32.const 6)))
            (i32.store
              (i32.const 664)
              (i32.add
                (i32.load
                  (i32.const 664))
                (i32.const 3)))
            (if $I7
              (i32.eqz
                (if $I6 (result i32)
                  (i32.and
                    (i32.load
                      (i32.const 116))
                    (i32.const 64))
                  (then
                    (i32.and
                      (i32.shr_u
                        (i32.and
                          (i32.xor
                            (tee_local $l12
                              (i32.load
                                (i32.const 112)))
                            (i32.const -1))
                          (i32.sub
                            (get_local $l12)
                            (i32.const 1)))
                        (i32.load
                          (i32.const 104)))
                      (i32.const 1)))
                  (else
                    (i32.and
                      (i32.load
                        (i32.const 120))
                      (i32.const 64)))))
              (then
                (i32.store
                  (i32.const 556)
                  (i32.add
                    (i32.load
                      (i32.const 556))
                    (i32.const -6)))
                (set_local $l0
                  (i32.const 0)))
              (else
                (set_local $l0
                  (i32.const 1))))
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
          (i32.store
            (i32.const 664)
            (i32.add
              (i32.load
                (i32.const 664))
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
          (return))
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
        (call $e.trigger_pagefault_end_jit)
        (i32.store
          (i32.const 648)
          (i32.const 0))
        (return))
      (unreachable))))
