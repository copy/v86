(module
  (type $t0 (func))
  (type $t1 (func (param i32)))
  (type $t2 (func (param i32 i32)))
  (type $t3 (func (param i32 i32 i32)))
  (type $t4 (func (result i32)))
  (type $t5 (func (param i32) (result i32)))
  (type $t6 (func (param i32 i32) (result i32)))
  (import "e" "get_seg" (func $e.get_seg (type $t5)))
  (import "e" "instr32_B8" (func $e.instr32_B8 (type $t1)))
  (import "e" "instr32_B9" (func $e.instr32_B9 (type $t1)))
  (import "e" "instr32_BA" (func $e.instr32_BA (type $t1)))
  (import "e" "instr32_BB" (func $e.instr32_BB (type $t1)))
  (import "e" "instr32_89_mem" (func $e.instr32_89_mem (type $t2)))
  (import "e" "instr32_8B_mem" (func $e.instr32_8B_mem (type $t2)))
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
          (i32.add
            (i32.load
              (i32.const 556))
            (i32.const 20)))
        (call $e.instr32_B8
          (i32.const -889270259))
        (call $e.instr32_B9
          (i32.const -1091583778))
        (call $e.instr32_BA
          (i32.const 0))
        (call $e.instr32_BB
          (i32.const 0))
        (call $e.instr32_89_mem
          (i32.add
            (i32.add
              (i32.load
                (i32.const 16))
              (i32.const 60))
            (call $e.get_seg
              (i32.const 3)))
          (i32.const 0))
        (i32.store
          (i32.const 560)
          (i32.add
            (i32.load
              (i32.const 556))
            (i32.const 26)))
        (call $e.instr32_89_mem
          (i32.add
            (i32.add
              (i32.load
                (i32.const 12))
              (i32.const 56))
            (call $e.get_seg
              (i32.const 3)))
          (i32.const 1))
        (i32.store
          (i32.const 560)
          (i32.add
            (i32.load
              (i32.const 556))
            (i32.const 32)))
        (call $e.instr32_8B_mem
          (i32.add
            (i32.add
              (i32.load
                (i32.const 16))
              (i32.const 56))
            (call $e.get_seg
              (i32.const 3)))
          (i32.const 6))
        (i32.store
          (i32.const 560)
          (i32.add
            (i32.load
              (i32.const 556))
            (i32.const 38)))
        (call $e.instr32_8B_mem
          (i32.add
            (i32.add
              (i32.load
                (i32.const 12))
              (i32.const 60))
            (call $e.get_seg
              (i32.const 3)))
          (i32.const 7))
        (i32.store
          (i32.const 560)
          (i32.add
            (i32.load
              (i32.const 556))
            (i32.const 52)))
        (i32.store
          (i32.const 556)
          (i32.add
            (i32.load
              (i32.const 556))
            (i32.const 53)))
        (i32.store
          (i32.const 8)
          (i32.load
            (i32.const 28)))
        (i32.store
          (i32.const 12)
          (i32.load
            (i32.const 32)))
        (i32.store
          (i32.const 12)
          (i32.load
            (i32.const 4)))
        (i32.store
          (i32.const 4)
          (i32.load
            (i32.const 8)))
        (call $e.instr_F4)
        (i32.store
          (i32.const 664)
          (i32.add
            (i32.load
              (i32.const 664))
            (i32.const 13)))
        (return))
      (unreachable))))
