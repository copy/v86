'use strict';var $JSCompiler_prototypeAlias$$;
function $IO$$($memory$$) {
  function $empty_port_read$$() {
    return 255;
  }
  function $empty_port_write$$() {
  }
  for (var $memory_size$$ = $memory$$.size, $read_callbacks$$ = Array(65539), $write_callbacks$$ = Array(65539), $i$$1$$ = 0;65539 > $i$$1$$;$i$$1$$++) {
    $read_callbacks$$[$i$$1$$] = $empty_port_read$$, $write_callbacks$$[$i$$1$$] = $empty_port_write$$;
  }
  this.register_read = function $this$register_read$($port_addr$$2$$, $callback$$35$$, $device$$) {
    void 0 !== $device$$ && ($callback$$35$$ = $callback$$35$$.bind($device$$));
    $read_callbacks$$[$port_addr$$2$$] = $callback$$35$$;
  };
  this.register_write = function $this$register_write$($port_addr$$3$$, $callback$$36$$, $device$$1$$) {
    void 0 !== $device$$1$$ && ($callback$$36$$ = $callback$$36$$.bind($device$$1$$));
    $write_callbacks$$[$port_addr$$3$$] = $callback$$36$$;
  };
  this.mmap_read32_shim = function $this$mmap_read32_shim$($addr$$1$$) {
    var $fn$$ = $memory$$.memory_map_read8[$addr$$1$$ >>> 14];
    return $fn$$($addr$$1$$) | $fn$$($addr$$1$$ + 1) << 8 | $fn$$($addr$$1$$ + 2) << 16 | $fn$$($addr$$1$$ + 3) << 24;
  };
  this.mmap_write32_shim = function $this$mmap_write32_shim$($addr$$2$$, $value$$38$$) {
    var $fn$$1$$ = $memory$$.memory_map_write8[$addr$$2$$ >>> 14];
    $fn$$1$$($addr$$2$$, $value$$38$$ & 255);
    $fn$$1$$($addr$$2$$ + 1, $value$$38$$ >> 8 & 255);
    $fn$$1$$($addr$$2$$ + 2, $value$$38$$ >> 16 & 255);
    $fn$$1$$($addr$$2$$ + 3, $value$$38$$ >>> 24);
  };
  this.mmap_register = function $this$mmap_register$($addr$$3_aligned_addr$$2$$, $size$$11$$, $read_func8$$, $write_func8$$, $read_func32$$, $write_func32$$) {
    $read_func32$$ || ($read_func32$$ = this.mmap_read32_shim.bind(this));
    $write_func32$$ || ($write_func32$$ = this.mmap_write32_shim.bind(this));
    for ($addr$$3_aligned_addr$$2$$ >>>= 14;0 < $size$$11$$;$addr$$3_aligned_addr$$2$$++) {
      $memory$$.memory_map_registered[$addr$$3_aligned_addr$$2$$] = 1, $memory$$.memory_map_read8[$addr$$3_aligned_addr$$2$$] = $read_func8$$, $memory$$.memory_map_write8[$addr$$3_aligned_addr$$2$$] = $write_func8$$, $memory$$.memory_map_read32[$addr$$3_aligned_addr$$2$$] = $read_func32$$, $memory$$.memory_map_write32[$addr$$3_aligned_addr$$2$$] = $write_func32$$, $size$$11$$ -= 16384;
    }
  };
  for ($i$$1$$ = 0;$i$$1$$ << 14 < $memory_size$$;$i$$1$$++) {
    $memory$$.memory_map_read8[$i$$1$$] = $memory$$.memory_map_write8[$i$$1$$] = void 0, $memory$$.memory_map_read32[$i$$1$$] = $memory$$.memory_map_write32[$i$$1$$] = void 0;
  }
  this.mmap_register($memory_size$$, 4294967296 - $memory_size$$, function() {
    return 255;
  }, function() {
  });
  this.in_mmap_range = function $this$in_mmap_range$($start$$5$$, $count$$8$$) {
    $start$$5$$ >>>= 0;
    var $end$$2$$ = $start$$5$$ + ($count$$8$$ >>> 0);
    if ($end$$2$$ >= $memory_size$$) {
      return!0;
    }
    for ($start$$5$$ &= -16384;$start$$5$$ < $end$$2$$;) {
      if ($memory$$.memory_map_registered[$start$$5$$ >> 14]) {
        return!0;
      }
      $start$$5$$ += 16384;
    }
    return!1;
  };
  this.port_write8 = function $this$port_write8$($port_addr$$4$$, $out_byte$$1$$) {
    $write_callbacks$$[$port_addr$$4$$]($out_byte$$1$$, $port_addr$$4$$);
  };
  this.port_write16 = function $this$port_write16$($port_addr$$5$$, $out_byte$$2$$) {
    $write_callbacks$$[$port_addr$$5$$]($out_byte$$2$$ & 255, $port_addr$$5$$);
    $write_callbacks$$[$port_addr$$5$$ + 1]($out_byte$$2$$ >> 8, $port_addr$$5$$);
  };
  this.port_write32 = function $this$port_write32$($port_addr$$6$$, $out_byte$$3$$) {
    $write_callbacks$$[$port_addr$$6$$]($out_byte$$3$$ & 255, $port_addr$$6$$);
    $write_callbacks$$[$port_addr$$6$$ + 1]($out_byte$$3$$ >> 8 & 255, $port_addr$$6$$);
    $write_callbacks$$[$port_addr$$6$$ + 2]($out_byte$$3$$ >> 16 & 255, $port_addr$$6$$);
    $write_callbacks$$[$port_addr$$6$$ + 3]($out_byte$$3$$ >>> 24, $port_addr$$6$$);
  };
  this.port_read8 = function $this$port_read8$($port_addr$$7$$) {
    return $read_callbacks$$[$port_addr$$7$$]($port_addr$$7$$);
  };
  this.port_read16 = function $this$port_read16$($port_addr$$8$$) {
    return $read_callbacks$$[$port_addr$$8$$]($port_addr$$8$$) | $read_callbacks$$[$port_addr$$8$$ + 1]($port_addr$$8$$) << 8;
  };
  this.port_read32 = function $this$port_read32$($port_addr$$9$$) {
    return $read_callbacks$$[$port_addr$$9$$]($port_addr$$9$$) | $read_callbacks$$[$port_addr$$9$$ + 1]($port_addr$$9$$) << 8 | $read_callbacks$$[$port_addr$$9$$ + 2]($port_addr$$9$$) << 16 | $read_callbacks$$[$port_addr$$9$$ + 3]($port_addr$$9$$) << 24;
  };
}
;function $v86$$() {
  this.memory_size = 0;
  this.segment_is_null = [];
  this.segment_offsets = [];
  this.segment_limits = [];
  this.segment_infos = [];
  this.tlb_data = [];
  this.tlb_info = [];
  this.tlb_info_global = [];
  this.protected_mode = !1;
  this.gdtr_offset = this.gdtr_size = this.idtr_offset = this.idtr_size = 0;
  this.page_fault = !1;
  this.page_size_extensions = this.cpl = this.cr4 = this.cr3 = this.cr2 = this.cr0 = 0;
  this.stopped = this.running = this.in_hlt = this.address_size_32 = this.operand_size_32 = this.is_32 = !1;
  this.devices = {};
  this.last_result = this.last_add_result = this.last_op_size = this.last_op2 = this.last_op1 = this.flags_changed = this.flags = this.repeat_string_prefix = this.eip_phys = this.last_virt_eip = 0;
  this.regv = this.reg16;
  this.reg_vdi = this.reg_vsi = this.reg_vcx = 0;
  this.table = [];
  this.table0F = [];
  this.current_settings = {};
  this.paging = !1;
  this.timestamp_counter = this.previous_ip = this.instruction_pointer = 0;
  this.reg32s = new Int32Array(8);
  this.reg32 = new Uint32Array(this.reg32s.buffer);
  this.reg16s = new Int16Array(this.reg32s.buffer);
  this.reg16 = new Uint16Array(this.reg32s.buffer);
  this.reg8s = new Int8Array(this.reg32s.buffer);
  this.reg8 = new Uint8Array(this.reg32s.buffer);
  this.sreg = new Uint16Array(8);
  this.dreg = new Int32Array(8);
  this.stack_reg = this.reg16;
  this.reg_vbp = this.reg_vsp = 0;
  this.memory = null;
  this.segment_prefix = -1;
  this.last_instr_jump = !1;
  this.first_init = !0;
  this.next_tick = function $this$next_tick$() {
  };
  this.fpu = this.io = void 0;
  "use strict";
  var $debug$$inline_10$$ = {};
  this.debug = $debug$$inline_10$$;
  $debug$$inline_10$$.step_mode = !1;
  $debug$$inline_10$$.ops = {};
  $debug$$inline_10$$.show = function $$debug$$inline_10$$$show$($x$$inline_11$$) {
    if ("undefined" !== typeof document) {
      var $el$$inline_12$$ = document.getElementById("log");
      if ($el$$inline_12$$) {
        $el$$inline_12$$.textContent += $x$$inline_11$$ + "\n";
        $el$$inline_12$$.style.display = "block";
        $el$$inline_12$$.scrollTop = 1E9;
        return;
      }
    }
    console.log($el$$inline_12$$);
  };
  $debug$$inline_10$$.init = function $$debug$$inline_10$$$init$() {
  };
  $debug$$inline_10$$.dump_regs = function dump_regs$$inline_13() {
  };
  $debug$$inline_10$$.dump_instructions = function dump_instructions$$inline_14() {
  };
  $debug$$inline_10$$.dump_regs_short = function dump_regs_short$$inline_15() {
  };
  $debug$$inline_10$$.dump_stack = function dump_stack$$inline_16() {
  };
  $debug$$inline_10$$.dump_page_directory = function dump_page_directory$$inline_17() {
  };
  $debug$$inline_10$$.dump_gdt_ldt = function dump_gdt_ldt$$inline_18() {
  };
  $debug$$inline_10$$.dump_idt = function dump_idt$$inline_19() {
  };
  $debug$$inline_10$$.get_memory_dump = function get_memory_dump$$inline_20() {
  };
  $debug$$inline_10$$.memory_hex_dump = function memory_hex_dump$$inline_21() {
  };
  $debug$$inline_10$$.used_memory_dump = function used_memory_dump$$inline_22() {
  };
  $debug$$inline_10$$.step = function step$$inline_23() {
  };
  $debug$$inline_10$$.run_until = function run_until$$inline_24() {
  };
  $debug$$inline_10$$.debugger = function $$debug$$inline_10$$$debugger$() {
  };
  $debug$$inline_10$$.unimpl = function $$debug$$inline_10$$$unimpl$($msg$$inline_25_s$$inline_26$$) {
    $msg$$inline_25_s$$inline_26$$ = "Unimplemented" + ($msg$$inline_25_s$$inline_26$$ ? ": " + $msg$$inline_25_s$$inline_26$$ : "");
    $debug$$inline_10$$.show($msg$$inline_25_s$$inline_26$$);
    $debug$$inline_10$$.show("Execution stopped");
    return $msg$$inline_25_s$$inline_26$$;
  };
  $debug$$inline_10$$.logop = function $$debug$$inline_10$$$logop$() {
  };
  Object.preventExtensions(this);
}
"use strict";
$v86$$.prototype.modrm_table16 = Array(192);
$v86$$.prototype.modrm_table32 = Array(192);
$v86$$.prototype.sib_table = Array(256);
$v86$$.prototype.modrm_table16[0] = function $$v86$$$$modrm_table16$0$($cpu$$inline_32$$) {
  return $cpu$$inline_32$$.get_seg_prefix(3) + ($cpu$$inline_32$$.reg16[6] + $cpu$$inline_32$$.reg16[12] & 65535) | 0;
};
$v86$$.prototype.modrm_table16[64] = function $$v86$$$$modrm_table16$64$($cpu$$inline_33$$) {
  return $cpu$$inline_33$$.get_seg_prefix(3) + ($cpu$$inline_33$$.reg16[6] + $cpu$$inline_33$$.reg16[12] + $cpu$$inline_33$$.read_imm8s() & 65535) | 0;
};
$v86$$.prototype.modrm_table16[128] = function $$v86$$$$modrm_table16$128$($cpu$$inline_34$$) {
  return $cpu$$inline_34$$.get_seg_prefix(3) + ($cpu$$inline_34$$.reg16[6] + $cpu$$inline_34$$.reg16[12] + $cpu$$inline_34$$.read_imm16() & 65535) | 0;
};
$v86$$.prototype.modrm_table16[1] = function $$v86$$$$modrm_table16$1$($cpu$$inline_35$$) {
  return $cpu$$inline_35$$.get_seg_prefix(3) + ($cpu$$inline_35$$.reg16[6] + $cpu$$inline_35$$.reg16[14] & 65535) | 0;
};
$v86$$.prototype.modrm_table16[65] = function $$v86$$$$modrm_table16$65$($cpu$$inline_36$$) {
  return $cpu$$inline_36$$.get_seg_prefix(3) + ($cpu$$inline_36$$.reg16[6] + $cpu$$inline_36$$.reg16[14] + $cpu$$inline_36$$.read_imm8s() & 65535) | 0;
};
$v86$$.prototype.modrm_table16[129] = function $$v86$$$$modrm_table16$129$($cpu$$inline_37$$) {
  return $cpu$$inline_37$$.get_seg_prefix(3) + ($cpu$$inline_37$$.reg16[6] + $cpu$$inline_37$$.reg16[14] + $cpu$$inline_37$$.read_imm16() & 65535) | 0;
};
$v86$$.prototype.modrm_table16[2] = function $$v86$$$$modrm_table16$2$($cpu$$inline_38$$) {
  return $cpu$$inline_38$$.get_seg_prefix(2) + ($cpu$$inline_38$$.reg16[10] + $cpu$$inline_38$$.reg16[12] & 65535) | 0;
};
$v86$$.prototype.modrm_table16[66] = function $$v86$$$$modrm_table16$66$($cpu$$inline_39$$) {
  return $cpu$$inline_39$$.get_seg_prefix(2) + ($cpu$$inline_39$$.reg16[10] + $cpu$$inline_39$$.reg16[12] + $cpu$$inline_39$$.read_imm8s() & 65535) | 0;
};
$v86$$.prototype.modrm_table16[130] = function $$v86$$$$modrm_table16$130$($cpu$$inline_40$$) {
  return $cpu$$inline_40$$.get_seg_prefix(2) + ($cpu$$inline_40$$.reg16[10] + $cpu$$inline_40$$.reg16[12] + $cpu$$inline_40$$.read_imm16() & 65535) | 0;
};
$v86$$.prototype.modrm_table16[3] = function $$v86$$$$modrm_table16$3$($cpu$$inline_41$$) {
  return $cpu$$inline_41$$.get_seg_prefix(2) + ($cpu$$inline_41$$.reg16[10] + $cpu$$inline_41$$.reg16[14] & 65535) | 0;
};
$v86$$.prototype.modrm_table16[67] = function $$v86$$$$modrm_table16$67$($cpu$$inline_42$$) {
  return $cpu$$inline_42$$.get_seg_prefix(2) + ($cpu$$inline_42$$.reg16[10] + $cpu$$inline_42$$.reg16[14] + $cpu$$inline_42$$.read_imm8s() & 65535) | 0;
};
$v86$$.prototype.modrm_table16[131] = function $$v86$$$$modrm_table16$131$($cpu$$inline_43$$) {
  return $cpu$$inline_43$$.get_seg_prefix(2) + ($cpu$$inline_43$$.reg16[10] + $cpu$$inline_43$$.reg16[14] + $cpu$$inline_43$$.read_imm16() & 65535) | 0;
};
$v86$$.prototype.modrm_table16[4] = function $$v86$$$$modrm_table16$4$($cpu$$inline_44$$) {
  return $cpu$$inline_44$$.get_seg_prefix(3) + ($cpu$$inline_44$$.reg16[12] & 65535) | 0;
};
$v86$$.prototype.modrm_table16[68] = function $$v86$$$$modrm_table16$68$($cpu$$inline_45$$) {
  return $cpu$$inline_45$$.get_seg_prefix(3) + ($cpu$$inline_45$$.reg16[12] + $cpu$$inline_45$$.read_imm8s() & 65535) | 0;
};
$v86$$.prototype.modrm_table16[132] = function $$v86$$$$modrm_table16$132$($cpu$$inline_46$$) {
  return $cpu$$inline_46$$.get_seg_prefix(3) + ($cpu$$inline_46$$.reg16[12] + $cpu$$inline_46$$.read_imm16() & 65535) | 0;
};
$v86$$.prototype.modrm_table16[5] = function $$v86$$$$modrm_table16$5$($cpu$$inline_47$$) {
  return $cpu$$inline_47$$.get_seg_prefix(3) + ($cpu$$inline_47$$.reg16[14] & 65535) | 0;
};
$v86$$.prototype.modrm_table16[69] = function $$v86$$$$modrm_table16$69$($cpu$$inline_48$$) {
  return $cpu$$inline_48$$.get_seg_prefix(3) + ($cpu$$inline_48$$.reg16[14] + $cpu$$inline_48$$.read_imm8s() & 65535) | 0;
};
$v86$$.prototype.modrm_table16[133] = function $$v86$$$$modrm_table16$133$($cpu$$inline_49$$) {
  return $cpu$$inline_49$$.get_seg_prefix(3) + ($cpu$$inline_49$$.reg16[14] + $cpu$$inline_49$$.read_imm16() & 65535) | 0;
};
$v86$$.prototype.modrm_table16[6] = function $$v86$$$$modrm_table16$6$($cpu$$inline_50$$) {
  return $cpu$$inline_50$$.get_seg_prefix(2) + ($cpu$$inline_50$$.reg16[10] & 65535) | 0;
};
$v86$$.prototype.modrm_table16[70] = function $$v86$$$$modrm_table16$70$($cpu$$inline_51$$) {
  return $cpu$$inline_51$$.get_seg_prefix(2) + ($cpu$$inline_51$$.reg16[10] + $cpu$$inline_51$$.read_imm8s() & 65535) | 0;
};
$v86$$.prototype.modrm_table16[134] = function $$v86$$$$modrm_table16$134$($cpu$$inline_52$$) {
  return $cpu$$inline_52$$.get_seg_prefix(2) + ($cpu$$inline_52$$.reg16[10] + $cpu$$inline_52$$.read_imm16() & 65535) | 0;
};
$v86$$.prototype.modrm_table16[7] = function $$v86$$$$modrm_table16$7$($cpu$$inline_53$$) {
  return $cpu$$inline_53$$.get_seg_prefix(3) + ($cpu$$inline_53$$.reg16[6] & 65535) | 0;
};
$v86$$.prototype.modrm_table16[71] = function $$v86$$$$modrm_table16$71$($cpu$$inline_54$$) {
  return $cpu$$inline_54$$.get_seg_prefix(3) + ($cpu$$inline_54$$.reg16[6] + $cpu$$inline_54$$.read_imm8s() & 65535) | 0;
};
$v86$$.prototype.modrm_table16[135] = function $$v86$$$$modrm_table16$135$($cpu$$inline_55$$) {
  return $cpu$$inline_55$$.get_seg_prefix(3) + ($cpu$$inline_55$$.reg16[6] + $cpu$$inline_55$$.read_imm16() & 65535) | 0;
};
$v86$$.prototype.modrm_table32[0] = function $$v86$$$$modrm_table32$0$($cpu$$inline_56$$) {
  return $cpu$$inline_56$$.get_seg_prefix(3) + $cpu$$inline_56$$.reg32s[0] | 0;
};
$v86$$.prototype.modrm_table32[64] = function $$v86$$$$modrm_table32$64$($cpu$$inline_57$$) {
  return $cpu$$inline_57$$.get_seg_prefix(3) + $cpu$$inline_57$$.reg32s[0] + $cpu$$inline_57$$.read_imm8s() | 0;
};
$v86$$.prototype.modrm_table32[128] = function $$v86$$$$modrm_table32$128$($cpu$$inline_58$$) {
  return $cpu$$inline_58$$.get_seg_prefix(3) + $cpu$$inline_58$$.reg32s[0] + $cpu$$inline_58$$.read_imm32s() | 0;
};
$v86$$.prototype.modrm_table32[1] = function $$v86$$$$modrm_table32$1$($cpu$$inline_59$$) {
  return $cpu$$inline_59$$.get_seg_prefix(3) + $cpu$$inline_59$$.reg32s[1] | 0;
};
$v86$$.prototype.modrm_table32[65] = function $$v86$$$$modrm_table32$65$($cpu$$inline_60$$) {
  return $cpu$$inline_60$$.get_seg_prefix(3) + $cpu$$inline_60$$.reg32s[1] + $cpu$$inline_60$$.read_imm8s() | 0;
};
$v86$$.prototype.modrm_table32[129] = function $$v86$$$$modrm_table32$129$($cpu$$inline_61$$) {
  return $cpu$$inline_61$$.get_seg_prefix(3) + $cpu$$inline_61$$.reg32s[1] + $cpu$$inline_61$$.read_imm32s() | 0;
};
$v86$$.prototype.modrm_table32[2] = function $$v86$$$$modrm_table32$2$($cpu$$inline_62$$) {
  return $cpu$$inline_62$$.get_seg_prefix(3) + $cpu$$inline_62$$.reg32s[2] | 0;
};
$v86$$.prototype.modrm_table32[66] = function $$v86$$$$modrm_table32$66$($cpu$$inline_63$$) {
  return $cpu$$inline_63$$.get_seg_prefix(3) + $cpu$$inline_63$$.reg32s[2] + $cpu$$inline_63$$.read_imm8s() | 0;
};
$v86$$.prototype.modrm_table32[130] = function $$v86$$$$modrm_table32$130$($cpu$$inline_64$$) {
  return $cpu$$inline_64$$.get_seg_prefix(3) + $cpu$$inline_64$$.reg32s[2] + $cpu$$inline_64$$.read_imm32s() | 0;
};
$v86$$.prototype.modrm_table32[3] = function $$v86$$$$modrm_table32$3$($cpu$$inline_65$$) {
  return $cpu$$inline_65$$.get_seg_prefix(3) + $cpu$$inline_65$$.reg32s[3] | 0;
};
$v86$$.prototype.modrm_table32[67] = function $$v86$$$$modrm_table32$67$($cpu$$inline_66$$) {
  return $cpu$$inline_66$$.get_seg_prefix(3) + $cpu$$inline_66$$.reg32s[3] + $cpu$$inline_66$$.read_imm8s() | 0;
};
$v86$$.prototype.modrm_table32[131] = function $$v86$$$$modrm_table32$131$($cpu$$inline_67$$) {
  return $cpu$$inline_67$$.get_seg_prefix(3) + $cpu$$inline_67$$.reg32s[3] + $cpu$$inline_67$$.read_imm32s() | 0;
};
$v86$$.prototype.modrm_table32[4] = function $$v86$$$$modrm_table32$4$($cpu$$inline_68$$) {
  return $cpu$$inline_68$$.sib_table[$cpu$$inline_68$$.read_imm8()]($cpu$$inline_68$$, !1) | 0;
};
$v86$$.prototype.modrm_table32[68] = function $$v86$$$$modrm_table32$68$($cpu$$inline_69$$) {
  return $cpu$$inline_69$$.sib_table[$cpu$$inline_69$$.read_imm8()]($cpu$$inline_69$$, !1) + $cpu$$inline_69$$.read_imm8s() | 0;
};
$v86$$.prototype.modrm_table32[132] = function $$v86$$$$modrm_table32$132$($cpu$$inline_70$$) {
  return $cpu$$inline_70$$.sib_table[$cpu$$inline_70$$.read_imm8()]($cpu$$inline_70$$, !1) + $cpu$$inline_70$$.read_imm32s() | 0;
};
$v86$$.prototype.modrm_table32[5] = function $$v86$$$$modrm_table32$5$($cpu$$inline_71$$) {
  return $cpu$$inline_71$$.get_seg_prefix(2) + $cpu$$inline_71$$.reg32s[5] | 0;
};
$v86$$.prototype.modrm_table32[69] = function $$v86$$$$modrm_table32$69$($cpu$$inline_72$$) {
  return $cpu$$inline_72$$.get_seg_prefix(2) + $cpu$$inline_72$$.reg32s[5] + $cpu$$inline_72$$.read_imm8s() | 0;
};
$v86$$.prototype.modrm_table32[133] = function $$v86$$$$modrm_table32$133$($cpu$$inline_73$$) {
  return $cpu$$inline_73$$.get_seg_prefix(2) + $cpu$$inline_73$$.reg32s[5] + $cpu$$inline_73$$.read_imm32s() | 0;
};
$v86$$.prototype.modrm_table32[6] = function $$v86$$$$modrm_table32$6$($cpu$$inline_74$$) {
  return $cpu$$inline_74$$.get_seg_prefix(3) + $cpu$$inline_74$$.reg32s[6] | 0;
};
$v86$$.prototype.modrm_table32[70] = function $$v86$$$$modrm_table32$70$($cpu$$inline_75$$) {
  return $cpu$$inline_75$$.get_seg_prefix(3) + $cpu$$inline_75$$.reg32s[6] + $cpu$$inline_75$$.read_imm8s() | 0;
};
$v86$$.prototype.modrm_table32[134] = function $$v86$$$$modrm_table32$134$($cpu$$inline_76$$) {
  return $cpu$$inline_76$$.get_seg_prefix(3) + $cpu$$inline_76$$.reg32s[6] + $cpu$$inline_76$$.read_imm32s() | 0;
};
$v86$$.prototype.modrm_table32[7] = function $$v86$$$$modrm_table32$7$($cpu$$inline_77$$) {
  return $cpu$$inline_77$$.get_seg_prefix(3) + $cpu$$inline_77$$.reg32s[7] | 0;
};
$v86$$.prototype.modrm_table32[71] = function $$v86$$$$modrm_table32$71$($cpu$$inline_78$$) {
  return $cpu$$inline_78$$.get_seg_prefix(3) + $cpu$$inline_78$$.reg32s[7] + $cpu$$inline_78$$.read_imm8s() | 0;
};
$v86$$.prototype.modrm_table32[135] = function $$v86$$$$modrm_table32$135$($cpu$$inline_79$$) {
  return $cpu$$inline_79$$.get_seg_prefix(3) + $cpu$$inline_79$$.reg32s[7] + $cpu$$inline_79$$.read_imm32s() | 0;
};
$v86$$.prototype.modrm_table16[6] = function $$v86$$$$modrm_table16$6$($cpu$$inline_80$$) {
  return $cpu$$inline_80$$.get_seg_prefix(3) + $cpu$$inline_80$$.read_imm16() | 0;
};
$v86$$.prototype.modrm_table32[5] = function $$v86$$$$modrm_table32$5$($cpu$$inline_81$$) {
  return $cpu$$inline_81$$.get_seg_prefix(3) + $cpu$$inline_81$$.read_imm32s() | 0;
};
$v86$$.prototype.modrm_table32[4] = function $$v86$$$$modrm_table32$4$($cpu$$inline_82$$) {
  return $cpu$$inline_82$$.sib_table[$cpu$$inline_82$$.read_imm8()]($cpu$$inline_82$$, !1) | 0;
};
$v86$$.prototype.modrm_table32[68] = function $$v86$$$$modrm_table32$68$($cpu$$inline_83$$) {
  return $cpu$$inline_83$$.sib_table[$cpu$$inline_83$$.read_imm8()]($cpu$$inline_83$$, !0) + $cpu$$inline_83$$.read_imm8s() | 0;
};
$v86$$.prototype.modrm_table32[132] = function $$v86$$$$modrm_table32$132$($cpu$$inline_84$$) {
  return $cpu$$inline_84$$.sib_table[$cpu$$inline_84$$.read_imm8()]($cpu$$inline_84$$, !0) + $cpu$$inline_84$$.read_imm32s() | 0;
};
for (var $low$$inline_28$$ = 0;8 > $low$$inline_28$$;$low$$inline_28$$++) {
  for (var $high$$inline_29$$ = 0;3 > $high$$inline_29$$;$high$$inline_29$$++) {
    for (var $x$$inline_30$$ = $low$$inline_28$$ | $high$$inline_29$$ << 6, $i$$inline_31$$ = 1;8 > $i$$inline_31$$;$i$$inline_31$$++) {
      $v86$$.prototype.modrm_table32[$x$$inline_30$$ | $i$$inline_31$$ << 3] = $v86$$.prototype.modrm_table32[$x$$inline_30$$], $v86$$.prototype.modrm_table16[$x$$inline_30$$ | $i$$inline_31$$ << 3] = $v86$$.prototype.modrm_table16[$x$$inline_30$$];
    }
  }
}
$v86$$.prototype.sib_table[0] = function $$v86$$$$sib_table$0$($cpu$$inline_85$$) {
  return $cpu$$inline_85$$.reg32s[0] + $cpu$$inline_85$$.get_seg_prefix(3) + $cpu$$inline_85$$.reg32s[0] | 0;
};
$v86$$.prototype.sib_table[1] = function $$v86$$$$sib_table$1$($cpu$$inline_86$$) {
  return $cpu$$inline_86$$.reg32s[0] + $cpu$$inline_86$$.get_seg_prefix(3) + $cpu$$inline_86$$.reg32s[1] | 0;
};
$v86$$.prototype.sib_table[2] = function $$v86$$$$sib_table$2$($cpu$$inline_87$$) {
  return $cpu$$inline_87$$.reg32s[0] + $cpu$$inline_87$$.get_seg_prefix(3) + $cpu$$inline_87$$.reg32s[2] | 0;
};
$v86$$.prototype.sib_table[3] = function $$v86$$$$sib_table$3$($cpu$$inline_88$$) {
  return $cpu$$inline_88$$.reg32s[0] + $cpu$$inline_88$$.get_seg_prefix(3) + $cpu$$inline_88$$.reg32s[3] | 0;
};
$v86$$.prototype.sib_table[4] = function $$v86$$$$sib_table$4$($cpu$$inline_89$$) {
  return $cpu$$inline_89$$.reg32s[0] + $cpu$$inline_89$$.get_seg_prefix(2) + $cpu$$inline_89$$.reg32s[4] | 0;
};
$v86$$.prototype.sib_table[5] = function $$v86$$$$sib_table$5$($cpu$$inline_90$$, $mod$$inline_91$$) {
  return $cpu$$inline_90$$.reg32s[0] + ($mod$$inline_91$$ ? $cpu$$inline_90$$.get_seg_prefix(2) + $cpu$$inline_90$$.reg32s[5] : $cpu$$inline_90$$.get_seg_prefix(3) + $cpu$$inline_90$$.read_imm32s()) | 0;
};
$v86$$.prototype.sib_table[6] = function $$v86$$$$sib_table$6$($cpu$$inline_92$$) {
  return $cpu$$inline_92$$.reg32s[0] + $cpu$$inline_92$$.get_seg_prefix(3) + $cpu$$inline_92$$.reg32s[6] | 0;
};
$v86$$.prototype.sib_table[7] = function $$v86$$$$sib_table$7$($cpu$$inline_93$$) {
  return $cpu$$inline_93$$.reg32s[0] + $cpu$$inline_93$$.get_seg_prefix(3) + $cpu$$inline_93$$.reg32s[7] | 0;
};
$v86$$.prototype.sib_table[64] = function $$v86$$$$sib_table$64$($cpu$$inline_94$$) {
  return($cpu$$inline_94$$.reg32s[0] << 1) + $cpu$$inline_94$$.get_seg_prefix(3) + $cpu$$inline_94$$.reg32s[0] | 0;
};
$v86$$.prototype.sib_table[65] = function $$v86$$$$sib_table$65$($cpu$$inline_95$$) {
  return($cpu$$inline_95$$.reg32s[0] << 1) + $cpu$$inline_95$$.get_seg_prefix(3) + $cpu$$inline_95$$.reg32s[1] | 0;
};
$v86$$.prototype.sib_table[66] = function $$v86$$$$sib_table$66$($cpu$$inline_96$$) {
  return($cpu$$inline_96$$.reg32s[0] << 1) + $cpu$$inline_96$$.get_seg_prefix(3) + $cpu$$inline_96$$.reg32s[2] | 0;
};
$v86$$.prototype.sib_table[67] = function $$v86$$$$sib_table$67$($cpu$$inline_97$$) {
  return($cpu$$inline_97$$.reg32s[0] << 1) + $cpu$$inline_97$$.get_seg_prefix(3) + $cpu$$inline_97$$.reg32s[3] | 0;
};
$v86$$.prototype.sib_table[68] = function $$v86$$$$sib_table$68$($cpu$$inline_98$$) {
  return($cpu$$inline_98$$.reg32s[0] << 1) + $cpu$$inline_98$$.get_seg_prefix(2) + $cpu$$inline_98$$.reg32s[4] | 0;
};
$v86$$.prototype.sib_table[69] = function $$v86$$$$sib_table$69$($cpu$$inline_99$$, $mod$$inline_100$$) {
  return($cpu$$inline_99$$.reg32s[0] << 1) + ($mod$$inline_100$$ ? $cpu$$inline_99$$.get_seg_prefix(2) + $cpu$$inline_99$$.reg32s[5] : $cpu$$inline_99$$.get_seg_prefix(3) + $cpu$$inline_99$$.read_imm32s()) | 0;
};
$v86$$.prototype.sib_table[70] = function $$v86$$$$sib_table$70$($cpu$$inline_101$$) {
  return($cpu$$inline_101$$.reg32s[0] << 1) + $cpu$$inline_101$$.get_seg_prefix(3) + $cpu$$inline_101$$.reg32s[6] | 0;
};
$v86$$.prototype.sib_table[71] = function $$v86$$$$sib_table$71$($cpu$$inline_102$$) {
  return($cpu$$inline_102$$.reg32s[0] << 1) + $cpu$$inline_102$$.get_seg_prefix(3) + $cpu$$inline_102$$.reg32s[7] | 0;
};
$v86$$.prototype.sib_table[128] = function $$v86$$$$sib_table$128$($cpu$$inline_103$$) {
  return($cpu$$inline_103$$.reg32s[0] << 2) + $cpu$$inline_103$$.get_seg_prefix(3) + $cpu$$inline_103$$.reg32s[0] | 0;
};
$v86$$.prototype.sib_table[129] = function $$v86$$$$sib_table$129$($cpu$$inline_104$$) {
  return($cpu$$inline_104$$.reg32s[0] << 2) + $cpu$$inline_104$$.get_seg_prefix(3) + $cpu$$inline_104$$.reg32s[1] | 0;
};
$v86$$.prototype.sib_table[130] = function $$v86$$$$sib_table$130$($cpu$$inline_105$$) {
  return($cpu$$inline_105$$.reg32s[0] << 2) + $cpu$$inline_105$$.get_seg_prefix(3) + $cpu$$inline_105$$.reg32s[2] | 0;
};
$v86$$.prototype.sib_table[131] = function $$v86$$$$sib_table$131$($cpu$$inline_106$$) {
  return($cpu$$inline_106$$.reg32s[0] << 2) + $cpu$$inline_106$$.get_seg_prefix(3) + $cpu$$inline_106$$.reg32s[3] | 0;
};
$v86$$.prototype.sib_table[132] = function $$v86$$$$sib_table$132$($cpu$$inline_107$$) {
  return($cpu$$inline_107$$.reg32s[0] << 2) + $cpu$$inline_107$$.get_seg_prefix(2) + $cpu$$inline_107$$.reg32s[4] | 0;
};
$v86$$.prototype.sib_table[133] = function $$v86$$$$sib_table$133$($cpu$$inline_108$$, $mod$$inline_109$$) {
  return($cpu$$inline_108$$.reg32s[0] << 2) + ($mod$$inline_109$$ ? $cpu$$inline_108$$.get_seg_prefix(2) + $cpu$$inline_108$$.reg32s[5] : $cpu$$inline_108$$.get_seg_prefix(3) + $cpu$$inline_108$$.read_imm32s()) | 0;
};
$v86$$.prototype.sib_table[134] = function $$v86$$$$sib_table$134$($cpu$$inline_110$$) {
  return($cpu$$inline_110$$.reg32s[0] << 2) + $cpu$$inline_110$$.get_seg_prefix(3) + $cpu$$inline_110$$.reg32s[6] | 0;
};
$v86$$.prototype.sib_table[135] = function $$v86$$$$sib_table$135$($cpu$$inline_111$$) {
  return($cpu$$inline_111$$.reg32s[0] << 2) + $cpu$$inline_111$$.get_seg_prefix(3) + $cpu$$inline_111$$.reg32s[7] | 0;
};
$v86$$.prototype.sib_table[192] = function $$v86$$$$sib_table$192$($cpu$$inline_112$$) {
  return($cpu$$inline_112$$.reg32s[0] << 3) + $cpu$$inline_112$$.get_seg_prefix(3) + $cpu$$inline_112$$.reg32s[0] | 0;
};
$v86$$.prototype.sib_table[193] = function $$v86$$$$sib_table$193$($cpu$$inline_113$$) {
  return($cpu$$inline_113$$.reg32s[0] << 3) + $cpu$$inline_113$$.get_seg_prefix(3) + $cpu$$inline_113$$.reg32s[1] | 0;
};
$v86$$.prototype.sib_table[194] = function $$v86$$$$sib_table$194$($cpu$$inline_114$$) {
  return($cpu$$inline_114$$.reg32s[0] << 3) + $cpu$$inline_114$$.get_seg_prefix(3) + $cpu$$inline_114$$.reg32s[2] | 0;
};
$v86$$.prototype.sib_table[195] = function $$v86$$$$sib_table$195$($cpu$$inline_115$$) {
  return($cpu$$inline_115$$.reg32s[0] << 3) + $cpu$$inline_115$$.get_seg_prefix(3) + $cpu$$inline_115$$.reg32s[3] | 0;
};
$v86$$.prototype.sib_table[196] = function $$v86$$$$sib_table$196$($cpu$$inline_116$$) {
  return($cpu$$inline_116$$.reg32s[0] << 3) + $cpu$$inline_116$$.get_seg_prefix(2) + $cpu$$inline_116$$.reg32s[4] | 0;
};
$v86$$.prototype.sib_table[197] = function $$v86$$$$sib_table$197$($cpu$$inline_117$$, $mod$$inline_118$$) {
  return($cpu$$inline_117$$.reg32s[0] << 3) + ($mod$$inline_118$$ ? $cpu$$inline_117$$.get_seg_prefix(2) + $cpu$$inline_117$$.reg32s[5] : $cpu$$inline_117$$.get_seg_prefix(3) + $cpu$$inline_117$$.read_imm32s()) | 0;
};
$v86$$.prototype.sib_table[198] = function $$v86$$$$sib_table$198$($cpu$$inline_119$$) {
  return($cpu$$inline_119$$.reg32s[0] << 3) + $cpu$$inline_119$$.get_seg_prefix(3) + $cpu$$inline_119$$.reg32s[6] | 0;
};
$v86$$.prototype.sib_table[199] = function $$v86$$$$sib_table$199$($cpu$$inline_120$$) {
  return($cpu$$inline_120$$.reg32s[0] << 3) + $cpu$$inline_120$$.get_seg_prefix(3) + $cpu$$inline_120$$.reg32s[7] | 0;
};
$v86$$.prototype.sib_table[8] = function $$v86$$$$sib_table$8$($cpu$$inline_121$$) {
  return $cpu$$inline_121$$.reg32s[1] + $cpu$$inline_121$$.get_seg_prefix(3) + $cpu$$inline_121$$.reg32s[0] | 0;
};
$v86$$.prototype.sib_table[9] = function $$v86$$$$sib_table$9$($cpu$$inline_122$$) {
  return $cpu$$inline_122$$.reg32s[1] + $cpu$$inline_122$$.get_seg_prefix(3) + $cpu$$inline_122$$.reg32s[1] | 0;
};
$v86$$.prototype.sib_table[10] = function $$v86$$$$sib_table$10$($cpu$$inline_123$$) {
  return $cpu$$inline_123$$.reg32s[1] + $cpu$$inline_123$$.get_seg_prefix(3) + $cpu$$inline_123$$.reg32s[2] | 0;
};
$v86$$.prototype.sib_table[11] = function $$v86$$$$sib_table$11$($cpu$$inline_124$$) {
  return $cpu$$inline_124$$.reg32s[1] + $cpu$$inline_124$$.get_seg_prefix(3) + $cpu$$inline_124$$.reg32s[3] | 0;
};
$v86$$.prototype.sib_table[12] = function $$v86$$$$sib_table$12$($cpu$$inline_125$$) {
  return $cpu$$inline_125$$.reg32s[1] + $cpu$$inline_125$$.get_seg_prefix(2) + $cpu$$inline_125$$.reg32s[4] | 0;
};
$v86$$.prototype.sib_table[13] = function $$v86$$$$sib_table$13$($cpu$$inline_126$$, $mod$$inline_127$$) {
  return $cpu$$inline_126$$.reg32s[1] + ($mod$$inline_127$$ ? $cpu$$inline_126$$.get_seg_prefix(2) + $cpu$$inline_126$$.reg32s[5] : $cpu$$inline_126$$.get_seg_prefix(3) + $cpu$$inline_126$$.read_imm32s()) | 0;
};
$v86$$.prototype.sib_table[14] = function $$v86$$$$sib_table$14$($cpu$$inline_128$$) {
  return $cpu$$inline_128$$.reg32s[1] + $cpu$$inline_128$$.get_seg_prefix(3) + $cpu$$inline_128$$.reg32s[6] | 0;
};
$v86$$.prototype.sib_table[15] = function $$v86$$$$sib_table$15$($cpu$$inline_129$$) {
  return $cpu$$inline_129$$.reg32s[1] + $cpu$$inline_129$$.get_seg_prefix(3) + $cpu$$inline_129$$.reg32s[7] | 0;
};
$v86$$.prototype.sib_table[72] = function $$v86$$$$sib_table$72$($cpu$$inline_130$$) {
  return($cpu$$inline_130$$.reg32s[1] << 1) + $cpu$$inline_130$$.get_seg_prefix(3) + $cpu$$inline_130$$.reg32s[0] | 0;
};
$v86$$.prototype.sib_table[73] = function $$v86$$$$sib_table$73$($cpu$$inline_131$$) {
  return($cpu$$inline_131$$.reg32s[1] << 1) + $cpu$$inline_131$$.get_seg_prefix(3) + $cpu$$inline_131$$.reg32s[1] | 0;
};
$v86$$.prototype.sib_table[74] = function $$v86$$$$sib_table$74$($cpu$$inline_132$$) {
  return($cpu$$inline_132$$.reg32s[1] << 1) + $cpu$$inline_132$$.get_seg_prefix(3) + $cpu$$inline_132$$.reg32s[2] | 0;
};
$v86$$.prototype.sib_table[75] = function $$v86$$$$sib_table$75$($cpu$$inline_133$$) {
  return($cpu$$inline_133$$.reg32s[1] << 1) + $cpu$$inline_133$$.get_seg_prefix(3) + $cpu$$inline_133$$.reg32s[3] | 0;
};
$v86$$.prototype.sib_table[76] = function $$v86$$$$sib_table$76$($cpu$$inline_134$$) {
  return($cpu$$inline_134$$.reg32s[1] << 1) + $cpu$$inline_134$$.get_seg_prefix(2) + $cpu$$inline_134$$.reg32s[4] | 0;
};
$v86$$.prototype.sib_table[77] = function $$v86$$$$sib_table$77$($cpu$$inline_135$$, $mod$$inline_136$$) {
  return($cpu$$inline_135$$.reg32s[1] << 1) + ($mod$$inline_136$$ ? $cpu$$inline_135$$.get_seg_prefix(2) + $cpu$$inline_135$$.reg32s[5] : $cpu$$inline_135$$.get_seg_prefix(3) + $cpu$$inline_135$$.read_imm32s()) | 0;
};
$v86$$.prototype.sib_table[78] = function $$v86$$$$sib_table$78$($cpu$$inline_137$$) {
  return($cpu$$inline_137$$.reg32s[1] << 1) + $cpu$$inline_137$$.get_seg_prefix(3) + $cpu$$inline_137$$.reg32s[6] | 0;
};
$v86$$.prototype.sib_table[79] = function $$v86$$$$sib_table$79$($cpu$$inline_138$$) {
  return($cpu$$inline_138$$.reg32s[1] << 1) + $cpu$$inline_138$$.get_seg_prefix(3) + $cpu$$inline_138$$.reg32s[7] | 0;
};
$v86$$.prototype.sib_table[136] = function $$v86$$$$sib_table$136$($cpu$$inline_139$$) {
  return($cpu$$inline_139$$.reg32s[1] << 2) + $cpu$$inline_139$$.get_seg_prefix(3) + $cpu$$inline_139$$.reg32s[0] | 0;
};
$v86$$.prototype.sib_table[137] = function $$v86$$$$sib_table$137$($cpu$$inline_140$$) {
  return($cpu$$inline_140$$.reg32s[1] << 2) + $cpu$$inline_140$$.get_seg_prefix(3) + $cpu$$inline_140$$.reg32s[1] | 0;
};
$v86$$.prototype.sib_table[138] = function $$v86$$$$sib_table$138$($cpu$$inline_141$$) {
  return($cpu$$inline_141$$.reg32s[1] << 2) + $cpu$$inline_141$$.get_seg_prefix(3) + $cpu$$inline_141$$.reg32s[2] | 0;
};
$v86$$.prototype.sib_table[139] = function $$v86$$$$sib_table$139$($cpu$$inline_142$$) {
  return($cpu$$inline_142$$.reg32s[1] << 2) + $cpu$$inline_142$$.get_seg_prefix(3) + $cpu$$inline_142$$.reg32s[3] | 0;
};
$v86$$.prototype.sib_table[140] = function $$v86$$$$sib_table$140$($cpu$$inline_143$$) {
  return($cpu$$inline_143$$.reg32s[1] << 2) + $cpu$$inline_143$$.get_seg_prefix(2) + $cpu$$inline_143$$.reg32s[4] | 0;
};
$v86$$.prototype.sib_table[141] = function $$v86$$$$sib_table$141$($cpu$$inline_144$$, $mod$$inline_145$$) {
  return($cpu$$inline_144$$.reg32s[1] << 2) + ($mod$$inline_145$$ ? $cpu$$inline_144$$.get_seg_prefix(2) + $cpu$$inline_144$$.reg32s[5] : $cpu$$inline_144$$.get_seg_prefix(3) + $cpu$$inline_144$$.read_imm32s()) | 0;
};
$v86$$.prototype.sib_table[142] = function $$v86$$$$sib_table$142$($cpu$$inline_146$$) {
  return($cpu$$inline_146$$.reg32s[1] << 2) + $cpu$$inline_146$$.get_seg_prefix(3) + $cpu$$inline_146$$.reg32s[6] | 0;
};
$v86$$.prototype.sib_table[143] = function $$v86$$$$sib_table$143$($cpu$$inline_147$$) {
  return($cpu$$inline_147$$.reg32s[1] << 2) + $cpu$$inline_147$$.get_seg_prefix(3) + $cpu$$inline_147$$.reg32s[7] | 0;
};
$v86$$.prototype.sib_table[200] = function $$v86$$$$sib_table$200$($cpu$$inline_148$$) {
  return($cpu$$inline_148$$.reg32s[1] << 3) + $cpu$$inline_148$$.get_seg_prefix(3) + $cpu$$inline_148$$.reg32s[0] | 0;
};
$v86$$.prototype.sib_table[201] = function $$v86$$$$sib_table$201$($cpu$$inline_149$$) {
  return($cpu$$inline_149$$.reg32s[1] << 3) + $cpu$$inline_149$$.get_seg_prefix(3) + $cpu$$inline_149$$.reg32s[1] | 0;
};
$v86$$.prototype.sib_table[202] = function $$v86$$$$sib_table$202$($cpu$$inline_150$$) {
  return($cpu$$inline_150$$.reg32s[1] << 3) + $cpu$$inline_150$$.get_seg_prefix(3) + $cpu$$inline_150$$.reg32s[2] | 0;
};
$v86$$.prototype.sib_table[203] = function $$v86$$$$sib_table$203$($cpu$$inline_151$$) {
  return($cpu$$inline_151$$.reg32s[1] << 3) + $cpu$$inline_151$$.get_seg_prefix(3) + $cpu$$inline_151$$.reg32s[3] | 0;
};
$v86$$.prototype.sib_table[204] = function $$v86$$$$sib_table$204$($cpu$$inline_152$$) {
  return($cpu$$inline_152$$.reg32s[1] << 3) + $cpu$$inline_152$$.get_seg_prefix(2) + $cpu$$inline_152$$.reg32s[4] | 0;
};
$v86$$.prototype.sib_table[205] = function $$v86$$$$sib_table$205$($cpu$$inline_153$$, $mod$$inline_154$$) {
  return($cpu$$inline_153$$.reg32s[1] << 3) + ($mod$$inline_154$$ ? $cpu$$inline_153$$.get_seg_prefix(2) + $cpu$$inline_153$$.reg32s[5] : $cpu$$inline_153$$.get_seg_prefix(3) + $cpu$$inline_153$$.read_imm32s()) | 0;
};
$v86$$.prototype.sib_table[206] = function $$v86$$$$sib_table$206$($cpu$$inline_155$$) {
  return($cpu$$inline_155$$.reg32s[1] << 3) + $cpu$$inline_155$$.get_seg_prefix(3) + $cpu$$inline_155$$.reg32s[6] | 0;
};
$v86$$.prototype.sib_table[207] = function $$v86$$$$sib_table$207$($cpu$$inline_156$$) {
  return($cpu$$inline_156$$.reg32s[1] << 3) + $cpu$$inline_156$$.get_seg_prefix(3) + $cpu$$inline_156$$.reg32s[7] | 0;
};
$v86$$.prototype.sib_table[16] = function $$v86$$$$sib_table$16$($cpu$$inline_157$$) {
  return $cpu$$inline_157$$.reg32s[2] + $cpu$$inline_157$$.get_seg_prefix(3) + $cpu$$inline_157$$.reg32s[0] | 0;
};
$v86$$.prototype.sib_table[17] = function $$v86$$$$sib_table$17$($cpu$$inline_158$$) {
  return $cpu$$inline_158$$.reg32s[2] + $cpu$$inline_158$$.get_seg_prefix(3) + $cpu$$inline_158$$.reg32s[1] | 0;
};
$v86$$.prototype.sib_table[18] = function $$v86$$$$sib_table$18$($cpu$$inline_159$$) {
  return $cpu$$inline_159$$.reg32s[2] + $cpu$$inline_159$$.get_seg_prefix(3) + $cpu$$inline_159$$.reg32s[2] | 0;
};
$v86$$.prototype.sib_table[19] = function $$v86$$$$sib_table$19$($cpu$$inline_160$$) {
  return $cpu$$inline_160$$.reg32s[2] + $cpu$$inline_160$$.get_seg_prefix(3) + $cpu$$inline_160$$.reg32s[3] | 0;
};
$v86$$.prototype.sib_table[20] = function $$v86$$$$sib_table$20$($cpu$$inline_161$$) {
  return $cpu$$inline_161$$.reg32s[2] + $cpu$$inline_161$$.get_seg_prefix(2) + $cpu$$inline_161$$.reg32s[4] | 0;
};
$v86$$.prototype.sib_table[21] = function $$v86$$$$sib_table$21$($cpu$$inline_162$$, $mod$$inline_163$$) {
  return $cpu$$inline_162$$.reg32s[2] + ($mod$$inline_163$$ ? $cpu$$inline_162$$.get_seg_prefix(2) + $cpu$$inline_162$$.reg32s[5] : $cpu$$inline_162$$.get_seg_prefix(3) + $cpu$$inline_162$$.read_imm32s()) | 0;
};
$v86$$.prototype.sib_table[22] = function $$v86$$$$sib_table$22$($cpu$$inline_164$$) {
  return $cpu$$inline_164$$.reg32s[2] + $cpu$$inline_164$$.get_seg_prefix(3) + $cpu$$inline_164$$.reg32s[6] | 0;
};
$v86$$.prototype.sib_table[23] = function $$v86$$$$sib_table$23$($cpu$$inline_165$$) {
  return $cpu$$inline_165$$.reg32s[2] + $cpu$$inline_165$$.get_seg_prefix(3) + $cpu$$inline_165$$.reg32s[7] | 0;
};
$v86$$.prototype.sib_table[80] = function $$v86$$$$sib_table$80$($cpu$$inline_166$$) {
  return($cpu$$inline_166$$.reg32s[2] << 1) + $cpu$$inline_166$$.get_seg_prefix(3) + $cpu$$inline_166$$.reg32s[0] | 0;
};
$v86$$.prototype.sib_table[81] = function $$v86$$$$sib_table$81$($cpu$$inline_167$$) {
  return($cpu$$inline_167$$.reg32s[2] << 1) + $cpu$$inline_167$$.get_seg_prefix(3) + $cpu$$inline_167$$.reg32s[1] | 0;
};
$v86$$.prototype.sib_table[82] = function $$v86$$$$sib_table$82$($cpu$$inline_168$$) {
  return($cpu$$inline_168$$.reg32s[2] << 1) + $cpu$$inline_168$$.get_seg_prefix(3) + $cpu$$inline_168$$.reg32s[2] | 0;
};
$v86$$.prototype.sib_table[83] = function $$v86$$$$sib_table$83$($cpu$$inline_169$$) {
  return($cpu$$inline_169$$.reg32s[2] << 1) + $cpu$$inline_169$$.get_seg_prefix(3) + $cpu$$inline_169$$.reg32s[3] | 0;
};
$v86$$.prototype.sib_table[84] = function $$v86$$$$sib_table$84$($cpu$$inline_170$$) {
  return($cpu$$inline_170$$.reg32s[2] << 1) + $cpu$$inline_170$$.get_seg_prefix(2) + $cpu$$inline_170$$.reg32s[4] | 0;
};
$v86$$.prototype.sib_table[85] = function $$v86$$$$sib_table$85$($cpu$$inline_171$$, $mod$$inline_172$$) {
  return($cpu$$inline_171$$.reg32s[2] << 1) + ($mod$$inline_172$$ ? $cpu$$inline_171$$.get_seg_prefix(2) + $cpu$$inline_171$$.reg32s[5] : $cpu$$inline_171$$.get_seg_prefix(3) + $cpu$$inline_171$$.read_imm32s()) | 0;
};
$v86$$.prototype.sib_table[86] = function $$v86$$$$sib_table$86$($cpu$$inline_173$$) {
  return($cpu$$inline_173$$.reg32s[2] << 1) + $cpu$$inline_173$$.get_seg_prefix(3) + $cpu$$inline_173$$.reg32s[6] | 0;
};
$v86$$.prototype.sib_table[87] = function $$v86$$$$sib_table$87$($cpu$$inline_174$$) {
  return($cpu$$inline_174$$.reg32s[2] << 1) + $cpu$$inline_174$$.get_seg_prefix(3) + $cpu$$inline_174$$.reg32s[7] | 0;
};
$v86$$.prototype.sib_table[144] = function $$v86$$$$sib_table$144$($cpu$$inline_175$$) {
  return($cpu$$inline_175$$.reg32s[2] << 2) + $cpu$$inline_175$$.get_seg_prefix(3) + $cpu$$inline_175$$.reg32s[0] | 0;
};
$v86$$.prototype.sib_table[145] = function $$v86$$$$sib_table$145$($cpu$$inline_176$$) {
  return($cpu$$inline_176$$.reg32s[2] << 2) + $cpu$$inline_176$$.get_seg_prefix(3) + $cpu$$inline_176$$.reg32s[1] | 0;
};
$v86$$.prototype.sib_table[146] = function $$v86$$$$sib_table$146$($cpu$$inline_177$$) {
  return($cpu$$inline_177$$.reg32s[2] << 2) + $cpu$$inline_177$$.get_seg_prefix(3) + $cpu$$inline_177$$.reg32s[2] | 0;
};
$v86$$.prototype.sib_table[147] = function $$v86$$$$sib_table$147$($cpu$$inline_178$$) {
  return($cpu$$inline_178$$.reg32s[2] << 2) + $cpu$$inline_178$$.get_seg_prefix(3) + $cpu$$inline_178$$.reg32s[3] | 0;
};
$v86$$.prototype.sib_table[148] = function $$v86$$$$sib_table$148$($cpu$$inline_179$$) {
  return($cpu$$inline_179$$.reg32s[2] << 2) + $cpu$$inline_179$$.get_seg_prefix(2) + $cpu$$inline_179$$.reg32s[4] | 0;
};
$v86$$.prototype.sib_table[149] = function $$v86$$$$sib_table$149$($cpu$$inline_180$$, $mod$$inline_181$$) {
  return($cpu$$inline_180$$.reg32s[2] << 2) + ($mod$$inline_181$$ ? $cpu$$inline_180$$.get_seg_prefix(2) + $cpu$$inline_180$$.reg32s[5] : $cpu$$inline_180$$.get_seg_prefix(3) + $cpu$$inline_180$$.read_imm32s()) | 0;
};
$v86$$.prototype.sib_table[150] = function $$v86$$$$sib_table$150$($cpu$$inline_182$$) {
  return($cpu$$inline_182$$.reg32s[2] << 2) + $cpu$$inline_182$$.get_seg_prefix(3) + $cpu$$inline_182$$.reg32s[6] | 0;
};
$v86$$.prototype.sib_table[151] = function $$v86$$$$sib_table$151$($cpu$$inline_183$$) {
  return($cpu$$inline_183$$.reg32s[2] << 2) + $cpu$$inline_183$$.get_seg_prefix(3) + $cpu$$inline_183$$.reg32s[7] | 0;
};
$v86$$.prototype.sib_table[208] = function $$v86$$$$sib_table$208$($cpu$$inline_184$$) {
  return($cpu$$inline_184$$.reg32s[2] << 3) + $cpu$$inline_184$$.get_seg_prefix(3) + $cpu$$inline_184$$.reg32s[0] | 0;
};
$v86$$.prototype.sib_table[209] = function $$v86$$$$sib_table$209$($cpu$$inline_185$$) {
  return($cpu$$inline_185$$.reg32s[2] << 3) + $cpu$$inline_185$$.get_seg_prefix(3) + $cpu$$inline_185$$.reg32s[1] | 0;
};
$v86$$.prototype.sib_table[210] = function $$v86$$$$sib_table$210$($cpu$$inline_186$$) {
  return($cpu$$inline_186$$.reg32s[2] << 3) + $cpu$$inline_186$$.get_seg_prefix(3) + $cpu$$inline_186$$.reg32s[2] | 0;
};
$v86$$.prototype.sib_table[211] = function $$v86$$$$sib_table$211$($cpu$$inline_187$$) {
  return($cpu$$inline_187$$.reg32s[2] << 3) + $cpu$$inline_187$$.get_seg_prefix(3) + $cpu$$inline_187$$.reg32s[3] | 0;
};
$v86$$.prototype.sib_table[212] = function $$v86$$$$sib_table$212$($cpu$$inline_188$$) {
  return($cpu$$inline_188$$.reg32s[2] << 3) + $cpu$$inline_188$$.get_seg_prefix(2) + $cpu$$inline_188$$.reg32s[4] | 0;
};
$v86$$.prototype.sib_table[213] = function $$v86$$$$sib_table$213$($cpu$$inline_189$$, $mod$$inline_190$$) {
  return($cpu$$inline_189$$.reg32s[2] << 3) + ($mod$$inline_190$$ ? $cpu$$inline_189$$.get_seg_prefix(2) + $cpu$$inline_189$$.reg32s[5] : $cpu$$inline_189$$.get_seg_prefix(3) + $cpu$$inline_189$$.read_imm32s()) | 0;
};
$v86$$.prototype.sib_table[214] = function $$v86$$$$sib_table$214$($cpu$$inline_191$$) {
  return($cpu$$inline_191$$.reg32s[2] << 3) + $cpu$$inline_191$$.get_seg_prefix(3) + $cpu$$inline_191$$.reg32s[6] | 0;
};
$v86$$.prototype.sib_table[215] = function $$v86$$$$sib_table$215$($cpu$$inline_192$$) {
  return($cpu$$inline_192$$.reg32s[2] << 3) + $cpu$$inline_192$$.get_seg_prefix(3) + $cpu$$inline_192$$.reg32s[7] | 0;
};
$v86$$.prototype.sib_table[24] = function $$v86$$$$sib_table$24$($cpu$$inline_193$$) {
  return $cpu$$inline_193$$.reg32s[3] + $cpu$$inline_193$$.get_seg_prefix(3) + $cpu$$inline_193$$.reg32s[0] | 0;
};
$v86$$.prototype.sib_table[25] = function $$v86$$$$sib_table$25$($cpu$$inline_194$$) {
  return $cpu$$inline_194$$.reg32s[3] + $cpu$$inline_194$$.get_seg_prefix(3) + $cpu$$inline_194$$.reg32s[1] | 0;
};
$v86$$.prototype.sib_table[26] = function $$v86$$$$sib_table$26$($cpu$$inline_195$$) {
  return $cpu$$inline_195$$.reg32s[3] + $cpu$$inline_195$$.get_seg_prefix(3) + $cpu$$inline_195$$.reg32s[2] | 0;
};
$v86$$.prototype.sib_table[27] = function $$v86$$$$sib_table$27$($cpu$$inline_196$$) {
  return $cpu$$inline_196$$.reg32s[3] + $cpu$$inline_196$$.get_seg_prefix(3) + $cpu$$inline_196$$.reg32s[3] | 0;
};
$v86$$.prototype.sib_table[28] = function $$v86$$$$sib_table$28$($cpu$$inline_197$$) {
  return $cpu$$inline_197$$.reg32s[3] + $cpu$$inline_197$$.get_seg_prefix(2) + $cpu$$inline_197$$.reg32s[4] | 0;
};
$v86$$.prototype.sib_table[29] = function $$v86$$$$sib_table$29$($cpu$$inline_198$$, $mod$$inline_199$$) {
  return $cpu$$inline_198$$.reg32s[3] + ($mod$$inline_199$$ ? $cpu$$inline_198$$.get_seg_prefix(2) + $cpu$$inline_198$$.reg32s[5] : $cpu$$inline_198$$.get_seg_prefix(3) + $cpu$$inline_198$$.read_imm32s()) | 0;
};
$v86$$.prototype.sib_table[30] = function $$v86$$$$sib_table$30$($cpu$$inline_200$$) {
  return $cpu$$inline_200$$.reg32s[3] + $cpu$$inline_200$$.get_seg_prefix(3) + $cpu$$inline_200$$.reg32s[6] | 0;
};
$v86$$.prototype.sib_table[31] = function $$v86$$$$sib_table$31$($cpu$$inline_201$$) {
  return $cpu$$inline_201$$.reg32s[3] + $cpu$$inline_201$$.get_seg_prefix(3) + $cpu$$inline_201$$.reg32s[7] | 0;
};
$v86$$.prototype.sib_table[88] = function $$v86$$$$sib_table$88$($cpu$$inline_202$$) {
  return($cpu$$inline_202$$.reg32s[3] << 1) + $cpu$$inline_202$$.get_seg_prefix(3) + $cpu$$inline_202$$.reg32s[0] | 0;
};
$v86$$.prototype.sib_table[89] = function $$v86$$$$sib_table$89$($cpu$$inline_203$$) {
  return($cpu$$inline_203$$.reg32s[3] << 1) + $cpu$$inline_203$$.get_seg_prefix(3) + $cpu$$inline_203$$.reg32s[1] | 0;
};
$v86$$.prototype.sib_table[90] = function $$v86$$$$sib_table$90$($cpu$$inline_204$$) {
  return($cpu$$inline_204$$.reg32s[3] << 1) + $cpu$$inline_204$$.get_seg_prefix(3) + $cpu$$inline_204$$.reg32s[2] | 0;
};
$v86$$.prototype.sib_table[91] = function $$v86$$$$sib_table$91$($cpu$$inline_205$$) {
  return($cpu$$inline_205$$.reg32s[3] << 1) + $cpu$$inline_205$$.get_seg_prefix(3) + $cpu$$inline_205$$.reg32s[3] | 0;
};
$v86$$.prototype.sib_table[92] = function $$v86$$$$sib_table$92$($cpu$$inline_206$$) {
  return($cpu$$inline_206$$.reg32s[3] << 1) + $cpu$$inline_206$$.get_seg_prefix(2) + $cpu$$inline_206$$.reg32s[4] | 0;
};
$v86$$.prototype.sib_table[93] = function $$v86$$$$sib_table$93$($cpu$$inline_207$$, $mod$$inline_208$$) {
  return($cpu$$inline_207$$.reg32s[3] << 1) + ($mod$$inline_208$$ ? $cpu$$inline_207$$.get_seg_prefix(2) + $cpu$$inline_207$$.reg32s[5] : $cpu$$inline_207$$.get_seg_prefix(3) + $cpu$$inline_207$$.read_imm32s()) | 0;
};
$v86$$.prototype.sib_table[94] = function $$v86$$$$sib_table$94$($cpu$$inline_209$$) {
  return($cpu$$inline_209$$.reg32s[3] << 1) + $cpu$$inline_209$$.get_seg_prefix(3) + $cpu$$inline_209$$.reg32s[6] | 0;
};
$v86$$.prototype.sib_table[95] = function $$v86$$$$sib_table$95$($cpu$$inline_210$$) {
  return($cpu$$inline_210$$.reg32s[3] << 1) + $cpu$$inline_210$$.get_seg_prefix(3) + $cpu$$inline_210$$.reg32s[7] | 0;
};
$v86$$.prototype.sib_table[152] = function $$v86$$$$sib_table$152$($cpu$$inline_211$$) {
  return($cpu$$inline_211$$.reg32s[3] << 2) + $cpu$$inline_211$$.get_seg_prefix(3) + $cpu$$inline_211$$.reg32s[0] | 0;
};
$v86$$.prototype.sib_table[153] = function $$v86$$$$sib_table$153$($cpu$$inline_212$$) {
  return($cpu$$inline_212$$.reg32s[3] << 2) + $cpu$$inline_212$$.get_seg_prefix(3) + $cpu$$inline_212$$.reg32s[1] | 0;
};
$v86$$.prototype.sib_table[154] = function $$v86$$$$sib_table$154$($cpu$$inline_213$$) {
  return($cpu$$inline_213$$.reg32s[3] << 2) + $cpu$$inline_213$$.get_seg_prefix(3) + $cpu$$inline_213$$.reg32s[2] | 0;
};
$v86$$.prototype.sib_table[155] = function $$v86$$$$sib_table$155$($cpu$$inline_214$$) {
  return($cpu$$inline_214$$.reg32s[3] << 2) + $cpu$$inline_214$$.get_seg_prefix(3) + $cpu$$inline_214$$.reg32s[3] | 0;
};
$v86$$.prototype.sib_table[156] = function $$v86$$$$sib_table$156$($cpu$$inline_215$$) {
  return($cpu$$inline_215$$.reg32s[3] << 2) + $cpu$$inline_215$$.get_seg_prefix(2) + $cpu$$inline_215$$.reg32s[4] | 0;
};
$v86$$.prototype.sib_table[157] = function $$v86$$$$sib_table$157$($cpu$$inline_216$$, $mod$$inline_217$$) {
  return($cpu$$inline_216$$.reg32s[3] << 2) + ($mod$$inline_217$$ ? $cpu$$inline_216$$.get_seg_prefix(2) + $cpu$$inline_216$$.reg32s[5] : $cpu$$inline_216$$.get_seg_prefix(3) + $cpu$$inline_216$$.read_imm32s()) | 0;
};
$v86$$.prototype.sib_table[158] = function $$v86$$$$sib_table$158$($cpu$$inline_218$$) {
  return($cpu$$inline_218$$.reg32s[3] << 2) + $cpu$$inline_218$$.get_seg_prefix(3) + $cpu$$inline_218$$.reg32s[6] | 0;
};
$v86$$.prototype.sib_table[159] = function $$v86$$$$sib_table$159$($cpu$$inline_219$$) {
  return($cpu$$inline_219$$.reg32s[3] << 2) + $cpu$$inline_219$$.get_seg_prefix(3) + $cpu$$inline_219$$.reg32s[7] | 0;
};
$v86$$.prototype.sib_table[216] = function $$v86$$$$sib_table$216$($cpu$$inline_220$$) {
  return($cpu$$inline_220$$.reg32s[3] << 3) + $cpu$$inline_220$$.get_seg_prefix(3) + $cpu$$inline_220$$.reg32s[0] | 0;
};
$v86$$.prototype.sib_table[217] = function $$v86$$$$sib_table$217$($cpu$$inline_221$$) {
  return($cpu$$inline_221$$.reg32s[3] << 3) + $cpu$$inline_221$$.get_seg_prefix(3) + $cpu$$inline_221$$.reg32s[1] | 0;
};
$v86$$.prototype.sib_table[218] = function $$v86$$$$sib_table$218$($cpu$$inline_222$$) {
  return($cpu$$inline_222$$.reg32s[3] << 3) + $cpu$$inline_222$$.get_seg_prefix(3) + $cpu$$inline_222$$.reg32s[2] | 0;
};
$v86$$.prototype.sib_table[219] = function $$v86$$$$sib_table$219$($cpu$$inline_223$$) {
  return($cpu$$inline_223$$.reg32s[3] << 3) + $cpu$$inline_223$$.get_seg_prefix(3) + $cpu$$inline_223$$.reg32s[3] | 0;
};
$v86$$.prototype.sib_table[220] = function $$v86$$$$sib_table$220$($cpu$$inline_224$$) {
  return($cpu$$inline_224$$.reg32s[3] << 3) + $cpu$$inline_224$$.get_seg_prefix(2) + $cpu$$inline_224$$.reg32s[4] | 0;
};
$v86$$.prototype.sib_table[221] = function $$v86$$$$sib_table$221$($cpu$$inline_225$$, $mod$$inline_226$$) {
  return($cpu$$inline_225$$.reg32s[3] << 3) + ($mod$$inline_226$$ ? $cpu$$inline_225$$.get_seg_prefix(2) + $cpu$$inline_225$$.reg32s[5] : $cpu$$inline_225$$.get_seg_prefix(3) + $cpu$$inline_225$$.read_imm32s()) | 0;
};
$v86$$.prototype.sib_table[222] = function $$v86$$$$sib_table$222$($cpu$$inline_227$$) {
  return($cpu$$inline_227$$.reg32s[3] << 3) + $cpu$$inline_227$$.get_seg_prefix(3) + $cpu$$inline_227$$.reg32s[6] | 0;
};
$v86$$.prototype.sib_table[223] = function $$v86$$$$sib_table$223$($cpu$$inline_228$$) {
  return($cpu$$inline_228$$.reg32s[3] << 3) + $cpu$$inline_228$$.get_seg_prefix(3) + $cpu$$inline_228$$.reg32s[7] | 0;
};
$v86$$.prototype.sib_table[32] = function $$v86$$$$sib_table$32$($cpu$$inline_229$$) {
  return 0 + $cpu$$inline_229$$.get_seg_prefix(3) + $cpu$$inline_229$$.reg32s[0] | 0;
};
$v86$$.prototype.sib_table[33] = function $$v86$$$$sib_table$33$($cpu$$inline_230$$) {
  return 0 + $cpu$$inline_230$$.get_seg_prefix(3) + $cpu$$inline_230$$.reg32s[1] | 0;
};
$v86$$.prototype.sib_table[34] = function $$v86$$$$sib_table$34$($cpu$$inline_231$$) {
  return 0 + $cpu$$inline_231$$.get_seg_prefix(3) + $cpu$$inline_231$$.reg32s[2] | 0;
};
$v86$$.prototype.sib_table[35] = function $$v86$$$$sib_table$35$($cpu$$inline_232$$) {
  return 0 + $cpu$$inline_232$$.get_seg_prefix(3) + $cpu$$inline_232$$.reg32s[3] | 0;
};
$v86$$.prototype.sib_table[36] = function $$v86$$$$sib_table$36$($cpu$$inline_233$$) {
  return 0 + $cpu$$inline_233$$.get_seg_prefix(2) + $cpu$$inline_233$$.reg32s[4] | 0;
};
$v86$$.prototype.sib_table[37] = function $$v86$$$$sib_table$37$($cpu$$inline_234$$, $mod$$inline_235$$) {
  return 0 + ($mod$$inline_235$$ ? $cpu$$inline_234$$.get_seg_prefix(2) + $cpu$$inline_234$$.reg32s[5] : $cpu$$inline_234$$.get_seg_prefix(3) + $cpu$$inline_234$$.read_imm32s()) | 0;
};
$v86$$.prototype.sib_table[38] = function $$v86$$$$sib_table$38$($cpu$$inline_236$$) {
  return 0 + $cpu$$inline_236$$.get_seg_prefix(3) + $cpu$$inline_236$$.reg32s[6] | 0;
};
$v86$$.prototype.sib_table[39] = function $$v86$$$$sib_table$39$($cpu$$inline_237$$) {
  return 0 + $cpu$$inline_237$$.get_seg_prefix(3) + $cpu$$inline_237$$.reg32s[7] | 0;
};
$v86$$.prototype.sib_table[96] = function $$v86$$$$sib_table$96$($cpu$$inline_238$$) {
  return 0 + $cpu$$inline_238$$.get_seg_prefix(3) + $cpu$$inline_238$$.reg32s[0] | 0;
};
$v86$$.prototype.sib_table[97] = function $$v86$$$$sib_table$97$($cpu$$inline_239$$) {
  return 0 + $cpu$$inline_239$$.get_seg_prefix(3) + $cpu$$inline_239$$.reg32s[1] | 0;
};
$v86$$.prototype.sib_table[98] = function $$v86$$$$sib_table$98$($cpu$$inline_240$$) {
  return 0 + $cpu$$inline_240$$.get_seg_prefix(3) + $cpu$$inline_240$$.reg32s[2] | 0;
};
$v86$$.prototype.sib_table[99] = function $$v86$$$$sib_table$99$($cpu$$inline_241$$) {
  return 0 + $cpu$$inline_241$$.get_seg_prefix(3) + $cpu$$inline_241$$.reg32s[3] | 0;
};
$v86$$.prototype.sib_table[100] = function $$v86$$$$sib_table$100$($cpu$$inline_242$$) {
  return 0 + $cpu$$inline_242$$.get_seg_prefix(2) + $cpu$$inline_242$$.reg32s[4] | 0;
};
$v86$$.prototype.sib_table[101] = function $$v86$$$$sib_table$101$($cpu$$inline_243$$, $mod$$inline_244$$) {
  return 0 + ($mod$$inline_244$$ ? $cpu$$inline_243$$.get_seg_prefix(2) + $cpu$$inline_243$$.reg32s[5] : $cpu$$inline_243$$.get_seg_prefix(3) + $cpu$$inline_243$$.read_imm32s()) | 0;
};
$v86$$.prototype.sib_table[102] = function $$v86$$$$sib_table$102$($cpu$$inline_245$$) {
  return 0 + $cpu$$inline_245$$.get_seg_prefix(3) + $cpu$$inline_245$$.reg32s[6] | 0;
};
$v86$$.prototype.sib_table[103] = function $$v86$$$$sib_table$103$($cpu$$inline_246$$) {
  return 0 + $cpu$$inline_246$$.get_seg_prefix(3) + $cpu$$inline_246$$.reg32s[7] | 0;
};
$v86$$.prototype.sib_table[160] = function $$v86$$$$sib_table$160$($cpu$$inline_247$$) {
  return 0 + $cpu$$inline_247$$.get_seg_prefix(3) + $cpu$$inline_247$$.reg32s[0] | 0;
};
$v86$$.prototype.sib_table[161] = function $$v86$$$$sib_table$161$($cpu$$inline_248$$) {
  return 0 + $cpu$$inline_248$$.get_seg_prefix(3) + $cpu$$inline_248$$.reg32s[1] | 0;
};
$v86$$.prototype.sib_table[162] = function $$v86$$$$sib_table$162$($cpu$$inline_249$$) {
  return 0 + $cpu$$inline_249$$.get_seg_prefix(3) + $cpu$$inline_249$$.reg32s[2] | 0;
};
$v86$$.prototype.sib_table[163] = function $$v86$$$$sib_table$163$($cpu$$inline_250$$) {
  return 0 + $cpu$$inline_250$$.get_seg_prefix(3) + $cpu$$inline_250$$.reg32s[3] | 0;
};
$v86$$.prototype.sib_table[164] = function $$v86$$$$sib_table$164$($cpu$$inline_251$$) {
  return 0 + $cpu$$inline_251$$.get_seg_prefix(2) + $cpu$$inline_251$$.reg32s[4] | 0;
};
$v86$$.prototype.sib_table[165] = function $$v86$$$$sib_table$165$($cpu$$inline_252$$, $mod$$inline_253$$) {
  return 0 + ($mod$$inline_253$$ ? $cpu$$inline_252$$.get_seg_prefix(2) + $cpu$$inline_252$$.reg32s[5] : $cpu$$inline_252$$.get_seg_prefix(3) + $cpu$$inline_252$$.read_imm32s()) | 0;
};
$v86$$.prototype.sib_table[166] = function $$v86$$$$sib_table$166$($cpu$$inline_254$$) {
  return 0 + $cpu$$inline_254$$.get_seg_prefix(3) + $cpu$$inline_254$$.reg32s[6] | 0;
};
$v86$$.prototype.sib_table[167] = function $$v86$$$$sib_table$167$($cpu$$inline_255$$) {
  return 0 + $cpu$$inline_255$$.get_seg_prefix(3) + $cpu$$inline_255$$.reg32s[7] | 0;
};
$v86$$.prototype.sib_table[224] = function $$v86$$$$sib_table$224$($cpu$$inline_256$$) {
  return 0 + $cpu$$inline_256$$.get_seg_prefix(3) + $cpu$$inline_256$$.reg32s[0] | 0;
};
$v86$$.prototype.sib_table[225] = function $$v86$$$$sib_table$225$($cpu$$inline_257$$) {
  return 0 + $cpu$$inline_257$$.get_seg_prefix(3) + $cpu$$inline_257$$.reg32s[1] | 0;
};
$v86$$.prototype.sib_table[226] = function $$v86$$$$sib_table$226$($cpu$$inline_258$$) {
  return 0 + $cpu$$inline_258$$.get_seg_prefix(3) + $cpu$$inline_258$$.reg32s[2] | 0;
};
$v86$$.prototype.sib_table[227] = function $$v86$$$$sib_table$227$($cpu$$inline_259$$) {
  return 0 + $cpu$$inline_259$$.get_seg_prefix(3) + $cpu$$inline_259$$.reg32s[3] | 0;
};
$v86$$.prototype.sib_table[228] = function $$v86$$$$sib_table$228$($cpu$$inline_260$$) {
  return 0 + $cpu$$inline_260$$.get_seg_prefix(2) + $cpu$$inline_260$$.reg32s[4] | 0;
};
$v86$$.prototype.sib_table[229] = function $$v86$$$$sib_table$229$($cpu$$inline_261$$, $mod$$inline_262$$) {
  return 0 + ($mod$$inline_262$$ ? $cpu$$inline_261$$.get_seg_prefix(2) + $cpu$$inline_261$$.reg32s[5] : $cpu$$inline_261$$.get_seg_prefix(3) + $cpu$$inline_261$$.read_imm32s()) | 0;
};
$v86$$.prototype.sib_table[230] = function $$v86$$$$sib_table$230$($cpu$$inline_263$$) {
  return 0 + $cpu$$inline_263$$.get_seg_prefix(3) + $cpu$$inline_263$$.reg32s[6] | 0;
};
$v86$$.prototype.sib_table[231] = function $$v86$$$$sib_table$231$($cpu$$inline_264$$) {
  return 0 + $cpu$$inline_264$$.get_seg_prefix(3) + $cpu$$inline_264$$.reg32s[7] | 0;
};
$v86$$.prototype.sib_table[40] = function $$v86$$$$sib_table$40$($cpu$$inline_265$$) {
  return $cpu$$inline_265$$.reg32s[5] + $cpu$$inline_265$$.get_seg_prefix(3) + $cpu$$inline_265$$.reg32s[0] | 0;
};
$v86$$.prototype.sib_table[41] = function $$v86$$$$sib_table$41$($cpu$$inline_266$$) {
  return $cpu$$inline_266$$.reg32s[5] + $cpu$$inline_266$$.get_seg_prefix(3) + $cpu$$inline_266$$.reg32s[1] | 0;
};
$v86$$.prototype.sib_table[42] = function $$v86$$$$sib_table$42$($cpu$$inline_267$$) {
  return $cpu$$inline_267$$.reg32s[5] + $cpu$$inline_267$$.get_seg_prefix(3) + $cpu$$inline_267$$.reg32s[2] | 0;
};
$v86$$.prototype.sib_table[43] = function $$v86$$$$sib_table$43$($cpu$$inline_268$$) {
  return $cpu$$inline_268$$.reg32s[5] + $cpu$$inline_268$$.get_seg_prefix(3) + $cpu$$inline_268$$.reg32s[3] | 0;
};
$v86$$.prototype.sib_table[44] = function $$v86$$$$sib_table$44$($cpu$$inline_269$$) {
  return $cpu$$inline_269$$.reg32s[5] + $cpu$$inline_269$$.get_seg_prefix(2) + $cpu$$inline_269$$.reg32s[4] | 0;
};
$v86$$.prototype.sib_table[45] = function $$v86$$$$sib_table$45$($cpu$$inline_270$$, $mod$$inline_271$$) {
  return $cpu$$inline_270$$.reg32s[5] + ($mod$$inline_271$$ ? $cpu$$inline_270$$.get_seg_prefix(2) + $cpu$$inline_270$$.reg32s[5] : $cpu$$inline_270$$.get_seg_prefix(3) + $cpu$$inline_270$$.read_imm32s()) | 0;
};
$v86$$.prototype.sib_table[46] = function $$v86$$$$sib_table$46$($cpu$$inline_272$$) {
  return $cpu$$inline_272$$.reg32s[5] + $cpu$$inline_272$$.get_seg_prefix(3) + $cpu$$inline_272$$.reg32s[6] | 0;
};
$v86$$.prototype.sib_table[47] = function $$v86$$$$sib_table$47$($cpu$$inline_273$$) {
  return $cpu$$inline_273$$.reg32s[5] + $cpu$$inline_273$$.get_seg_prefix(3) + $cpu$$inline_273$$.reg32s[7] | 0;
};
$v86$$.prototype.sib_table[104] = function $$v86$$$$sib_table$104$($cpu$$inline_274$$) {
  return($cpu$$inline_274$$.reg32s[5] << 1) + $cpu$$inline_274$$.get_seg_prefix(3) + $cpu$$inline_274$$.reg32s[0] | 0;
};
$v86$$.prototype.sib_table[105] = function $$v86$$$$sib_table$105$($cpu$$inline_275$$) {
  return($cpu$$inline_275$$.reg32s[5] << 1) + $cpu$$inline_275$$.get_seg_prefix(3) + $cpu$$inline_275$$.reg32s[1] | 0;
};
$v86$$.prototype.sib_table[106] = function $$v86$$$$sib_table$106$($cpu$$inline_276$$) {
  return($cpu$$inline_276$$.reg32s[5] << 1) + $cpu$$inline_276$$.get_seg_prefix(3) + $cpu$$inline_276$$.reg32s[2] | 0;
};
$v86$$.prototype.sib_table[107] = function $$v86$$$$sib_table$107$($cpu$$inline_277$$) {
  return($cpu$$inline_277$$.reg32s[5] << 1) + $cpu$$inline_277$$.get_seg_prefix(3) + $cpu$$inline_277$$.reg32s[3] | 0;
};
$v86$$.prototype.sib_table[108] = function $$v86$$$$sib_table$108$($cpu$$inline_278$$) {
  return($cpu$$inline_278$$.reg32s[5] << 1) + $cpu$$inline_278$$.get_seg_prefix(2) + $cpu$$inline_278$$.reg32s[4] | 0;
};
$v86$$.prototype.sib_table[109] = function $$v86$$$$sib_table$109$($cpu$$inline_279$$, $mod$$inline_280$$) {
  return($cpu$$inline_279$$.reg32s[5] << 1) + ($mod$$inline_280$$ ? $cpu$$inline_279$$.get_seg_prefix(2) + $cpu$$inline_279$$.reg32s[5] : $cpu$$inline_279$$.get_seg_prefix(3) + $cpu$$inline_279$$.read_imm32s()) | 0;
};
$v86$$.prototype.sib_table[110] = function $$v86$$$$sib_table$110$($cpu$$inline_281$$) {
  return($cpu$$inline_281$$.reg32s[5] << 1) + $cpu$$inline_281$$.get_seg_prefix(3) + $cpu$$inline_281$$.reg32s[6] | 0;
};
$v86$$.prototype.sib_table[111] = function $$v86$$$$sib_table$111$($cpu$$inline_282$$) {
  return($cpu$$inline_282$$.reg32s[5] << 1) + $cpu$$inline_282$$.get_seg_prefix(3) + $cpu$$inline_282$$.reg32s[7] | 0;
};
$v86$$.prototype.sib_table[168] = function $$v86$$$$sib_table$168$($cpu$$inline_283$$) {
  return($cpu$$inline_283$$.reg32s[5] << 2) + $cpu$$inline_283$$.get_seg_prefix(3) + $cpu$$inline_283$$.reg32s[0] | 0;
};
$v86$$.prototype.sib_table[169] = function $$v86$$$$sib_table$169$($cpu$$inline_284$$) {
  return($cpu$$inline_284$$.reg32s[5] << 2) + $cpu$$inline_284$$.get_seg_prefix(3) + $cpu$$inline_284$$.reg32s[1] | 0;
};
$v86$$.prototype.sib_table[170] = function $$v86$$$$sib_table$170$($cpu$$inline_285$$) {
  return($cpu$$inline_285$$.reg32s[5] << 2) + $cpu$$inline_285$$.get_seg_prefix(3) + $cpu$$inline_285$$.reg32s[2] | 0;
};
$v86$$.prototype.sib_table[171] = function $$v86$$$$sib_table$171$($cpu$$inline_286$$) {
  return($cpu$$inline_286$$.reg32s[5] << 2) + $cpu$$inline_286$$.get_seg_prefix(3) + $cpu$$inline_286$$.reg32s[3] | 0;
};
$v86$$.prototype.sib_table[172] = function $$v86$$$$sib_table$172$($cpu$$inline_287$$) {
  return($cpu$$inline_287$$.reg32s[5] << 2) + $cpu$$inline_287$$.get_seg_prefix(2) + $cpu$$inline_287$$.reg32s[4] | 0;
};
$v86$$.prototype.sib_table[173] = function $$v86$$$$sib_table$173$($cpu$$inline_288$$, $mod$$inline_289$$) {
  return($cpu$$inline_288$$.reg32s[5] << 2) + ($mod$$inline_289$$ ? $cpu$$inline_288$$.get_seg_prefix(2) + $cpu$$inline_288$$.reg32s[5] : $cpu$$inline_288$$.get_seg_prefix(3) + $cpu$$inline_288$$.read_imm32s()) | 0;
};
$v86$$.prototype.sib_table[174] = function $$v86$$$$sib_table$174$($cpu$$inline_290$$) {
  return($cpu$$inline_290$$.reg32s[5] << 2) + $cpu$$inline_290$$.get_seg_prefix(3) + $cpu$$inline_290$$.reg32s[6] | 0;
};
$v86$$.prototype.sib_table[175] = function $$v86$$$$sib_table$175$($cpu$$inline_291$$) {
  return($cpu$$inline_291$$.reg32s[5] << 2) + $cpu$$inline_291$$.get_seg_prefix(3) + $cpu$$inline_291$$.reg32s[7] | 0;
};
$v86$$.prototype.sib_table[232] = function $$v86$$$$sib_table$232$($cpu$$inline_292$$) {
  return($cpu$$inline_292$$.reg32s[5] << 3) + $cpu$$inline_292$$.get_seg_prefix(3) + $cpu$$inline_292$$.reg32s[0] | 0;
};
$v86$$.prototype.sib_table[233] = function $$v86$$$$sib_table$233$($cpu$$inline_293$$) {
  return($cpu$$inline_293$$.reg32s[5] << 3) + $cpu$$inline_293$$.get_seg_prefix(3) + $cpu$$inline_293$$.reg32s[1] | 0;
};
$v86$$.prototype.sib_table[234] = function $$v86$$$$sib_table$234$($cpu$$inline_294$$) {
  return($cpu$$inline_294$$.reg32s[5] << 3) + $cpu$$inline_294$$.get_seg_prefix(3) + $cpu$$inline_294$$.reg32s[2] | 0;
};
$v86$$.prototype.sib_table[235] = function $$v86$$$$sib_table$235$($cpu$$inline_295$$) {
  return($cpu$$inline_295$$.reg32s[5] << 3) + $cpu$$inline_295$$.get_seg_prefix(3) + $cpu$$inline_295$$.reg32s[3] | 0;
};
$v86$$.prototype.sib_table[236] = function $$v86$$$$sib_table$236$($cpu$$inline_296$$) {
  return($cpu$$inline_296$$.reg32s[5] << 3) + $cpu$$inline_296$$.get_seg_prefix(2) + $cpu$$inline_296$$.reg32s[4] | 0;
};
$v86$$.prototype.sib_table[237] = function $$v86$$$$sib_table$237$($cpu$$inline_297$$, $mod$$inline_298$$) {
  return($cpu$$inline_297$$.reg32s[5] << 3) + ($mod$$inline_298$$ ? $cpu$$inline_297$$.get_seg_prefix(2) + $cpu$$inline_297$$.reg32s[5] : $cpu$$inline_297$$.get_seg_prefix(3) + $cpu$$inline_297$$.read_imm32s()) | 0;
};
$v86$$.prototype.sib_table[238] = function $$v86$$$$sib_table$238$($cpu$$inline_299$$) {
  return($cpu$$inline_299$$.reg32s[5] << 3) + $cpu$$inline_299$$.get_seg_prefix(3) + $cpu$$inline_299$$.reg32s[6] | 0;
};
$v86$$.prototype.sib_table[239] = function $$v86$$$$sib_table$239$($cpu$$inline_300$$) {
  return($cpu$$inline_300$$.reg32s[5] << 3) + $cpu$$inline_300$$.get_seg_prefix(3) + $cpu$$inline_300$$.reg32s[7] | 0;
};
$v86$$.prototype.sib_table[48] = function $$v86$$$$sib_table$48$($cpu$$inline_301$$) {
  return $cpu$$inline_301$$.reg32s[6] + $cpu$$inline_301$$.get_seg_prefix(3) + $cpu$$inline_301$$.reg32s[0] | 0;
};
$v86$$.prototype.sib_table[49] = function $$v86$$$$sib_table$49$($cpu$$inline_302$$) {
  return $cpu$$inline_302$$.reg32s[6] + $cpu$$inline_302$$.get_seg_prefix(3) + $cpu$$inline_302$$.reg32s[1] | 0;
};
$v86$$.prototype.sib_table[50] = function $$v86$$$$sib_table$50$($cpu$$inline_303$$) {
  return $cpu$$inline_303$$.reg32s[6] + $cpu$$inline_303$$.get_seg_prefix(3) + $cpu$$inline_303$$.reg32s[2] | 0;
};
$v86$$.prototype.sib_table[51] = function $$v86$$$$sib_table$51$($cpu$$inline_304$$) {
  return $cpu$$inline_304$$.reg32s[6] + $cpu$$inline_304$$.get_seg_prefix(3) + $cpu$$inline_304$$.reg32s[3] | 0;
};
$v86$$.prototype.sib_table[52] = function $$v86$$$$sib_table$52$($cpu$$inline_305$$) {
  return $cpu$$inline_305$$.reg32s[6] + $cpu$$inline_305$$.get_seg_prefix(2) + $cpu$$inline_305$$.reg32s[4] | 0;
};
$v86$$.prototype.sib_table[53] = function $$v86$$$$sib_table$53$($cpu$$inline_306$$, $mod$$inline_307$$) {
  return $cpu$$inline_306$$.reg32s[6] + ($mod$$inline_307$$ ? $cpu$$inline_306$$.get_seg_prefix(2) + $cpu$$inline_306$$.reg32s[5] : $cpu$$inline_306$$.get_seg_prefix(3) + $cpu$$inline_306$$.read_imm32s()) | 0;
};
$v86$$.prototype.sib_table[54] = function $$v86$$$$sib_table$54$($cpu$$inline_308$$) {
  return $cpu$$inline_308$$.reg32s[6] + $cpu$$inline_308$$.get_seg_prefix(3) + $cpu$$inline_308$$.reg32s[6] | 0;
};
$v86$$.prototype.sib_table[55] = function $$v86$$$$sib_table$55$($cpu$$inline_309$$) {
  return $cpu$$inline_309$$.reg32s[6] + $cpu$$inline_309$$.get_seg_prefix(3) + $cpu$$inline_309$$.reg32s[7] | 0;
};
$v86$$.prototype.sib_table[112] = function $$v86$$$$sib_table$112$($cpu$$inline_310$$) {
  return($cpu$$inline_310$$.reg32s[6] << 1) + $cpu$$inline_310$$.get_seg_prefix(3) + $cpu$$inline_310$$.reg32s[0] | 0;
};
$v86$$.prototype.sib_table[113] = function $$v86$$$$sib_table$113$($cpu$$inline_311$$) {
  return($cpu$$inline_311$$.reg32s[6] << 1) + $cpu$$inline_311$$.get_seg_prefix(3) + $cpu$$inline_311$$.reg32s[1] | 0;
};
$v86$$.prototype.sib_table[114] = function $$v86$$$$sib_table$114$($cpu$$inline_312$$) {
  return($cpu$$inline_312$$.reg32s[6] << 1) + $cpu$$inline_312$$.get_seg_prefix(3) + $cpu$$inline_312$$.reg32s[2] | 0;
};
$v86$$.prototype.sib_table[115] = function $$v86$$$$sib_table$115$($cpu$$inline_313$$) {
  return($cpu$$inline_313$$.reg32s[6] << 1) + $cpu$$inline_313$$.get_seg_prefix(3) + $cpu$$inline_313$$.reg32s[3] | 0;
};
$v86$$.prototype.sib_table[116] = function $$v86$$$$sib_table$116$($cpu$$inline_314$$) {
  return($cpu$$inline_314$$.reg32s[6] << 1) + $cpu$$inline_314$$.get_seg_prefix(2) + $cpu$$inline_314$$.reg32s[4] | 0;
};
$v86$$.prototype.sib_table[117] = function $$v86$$$$sib_table$117$($cpu$$inline_315$$, $mod$$inline_316$$) {
  return($cpu$$inline_315$$.reg32s[6] << 1) + ($mod$$inline_316$$ ? $cpu$$inline_315$$.get_seg_prefix(2) + $cpu$$inline_315$$.reg32s[5] : $cpu$$inline_315$$.get_seg_prefix(3) + $cpu$$inline_315$$.read_imm32s()) | 0;
};
$v86$$.prototype.sib_table[118] = function $$v86$$$$sib_table$118$($cpu$$inline_317$$) {
  return($cpu$$inline_317$$.reg32s[6] << 1) + $cpu$$inline_317$$.get_seg_prefix(3) + $cpu$$inline_317$$.reg32s[6] | 0;
};
$v86$$.prototype.sib_table[119] = function $$v86$$$$sib_table$119$($cpu$$inline_318$$) {
  return($cpu$$inline_318$$.reg32s[6] << 1) + $cpu$$inline_318$$.get_seg_prefix(3) + $cpu$$inline_318$$.reg32s[7] | 0;
};
$v86$$.prototype.sib_table[176] = function $$v86$$$$sib_table$176$($cpu$$inline_319$$) {
  return($cpu$$inline_319$$.reg32s[6] << 2) + $cpu$$inline_319$$.get_seg_prefix(3) + $cpu$$inline_319$$.reg32s[0] | 0;
};
$v86$$.prototype.sib_table[177] = function $$v86$$$$sib_table$177$($cpu$$inline_320$$) {
  return($cpu$$inline_320$$.reg32s[6] << 2) + $cpu$$inline_320$$.get_seg_prefix(3) + $cpu$$inline_320$$.reg32s[1] | 0;
};
$v86$$.prototype.sib_table[178] = function $$v86$$$$sib_table$178$($cpu$$inline_321$$) {
  return($cpu$$inline_321$$.reg32s[6] << 2) + $cpu$$inline_321$$.get_seg_prefix(3) + $cpu$$inline_321$$.reg32s[2] | 0;
};
$v86$$.prototype.sib_table[179] = function $$v86$$$$sib_table$179$($cpu$$inline_322$$) {
  return($cpu$$inline_322$$.reg32s[6] << 2) + $cpu$$inline_322$$.get_seg_prefix(3) + $cpu$$inline_322$$.reg32s[3] | 0;
};
$v86$$.prototype.sib_table[180] = function $$v86$$$$sib_table$180$($cpu$$inline_323$$) {
  return($cpu$$inline_323$$.reg32s[6] << 2) + $cpu$$inline_323$$.get_seg_prefix(2) + $cpu$$inline_323$$.reg32s[4] | 0;
};
$v86$$.prototype.sib_table[181] = function $$v86$$$$sib_table$181$($cpu$$inline_324$$, $mod$$inline_325$$) {
  return($cpu$$inline_324$$.reg32s[6] << 2) + ($mod$$inline_325$$ ? $cpu$$inline_324$$.get_seg_prefix(2) + $cpu$$inline_324$$.reg32s[5] : $cpu$$inline_324$$.get_seg_prefix(3) + $cpu$$inline_324$$.read_imm32s()) | 0;
};
$v86$$.prototype.sib_table[182] = function $$v86$$$$sib_table$182$($cpu$$inline_326$$) {
  return($cpu$$inline_326$$.reg32s[6] << 2) + $cpu$$inline_326$$.get_seg_prefix(3) + $cpu$$inline_326$$.reg32s[6] | 0;
};
$v86$$.prototype.sib_table[183] = function $$v86$$$$sib_table$183$($cpu$$inline_327$$) {
  return($cpu$$inline_327$$.reg32s[6] << 2) + $cpu$$inline_327$$.get_seg_prefix(3) + $cpu$$inline_327$$.reg32s[7] | 0;
};
$v86$$.prototype.sib_table[240] = function $$v86$$$$sib_table$240$($cpu$$inline_328$$) {
  return($cpu$$inline_328$$.reg32s[6] << 3) + $cpu$$inline_328$$.get_seg_prefix(3) + $cpu$$inline_328$$.reg32s[0] | 0;
};
$v86$$.prototype.sib_table[241] = function $$v86$$$$sib_table$241$($cpu$$inline_329$$) {
  return($cpu$$inline_329$$.reg32s[6] << 3) + $cpu$$inline_329$$.get_seg_prefix(3) + $cpu$$inline_329$$.reg32s[1] | 0;
};
$v86$$.prototype.sib_table[242] = function $$v86$$$$sib_table$242$($cpu$$inline_330$$) {
  return($cpu$$inline_330$$.reg32s[6] << 3) + $cpu$$inline_330$$.get_seg_prefix(3) + $cpu$$inline_330$$.reg32s[2] | 0;
};
$v86$$.prototype.sib_table[243] = function $$v86$$$$sib_table$243$($cpu$$inline_331$$) {
  return($cpu$$inline_331$$.reg32s[6] << 3) + $cpu$$inline_331$$.get_seg_prefix(3) + $cpu$$inline_331$$.reg32s[3] | 0;
};
$v86$$.prototype.sib_table[244] = function $$v86$$$$sib_table$244$($cpu$$inline_332$$) {
  return($cpu$$inline_332$$.reg32s[6] << 3) + $cpu$$inline_332$$.get_seg_prefix(2) + $cpu$$inline_332$$.reg32s[4] | 0;
};
$v86$$.prototype.sib_table[245] = function $$v86$$$$sib_table$245$($cpu$$inline_333$$, $mod$$inline_334$$) {
  return($cpu$$inline_333$$.reg32s[6] << 3) + ($mod$$inline_334$$ ? $cpu$$inline_333$$.get_seg_prefix(2) + $cpu$$inline_333$$.reg32s[5] : $cpu$$inline_333$$.get_seg_prefix(3) + $cpu$$inline_333$$.read_imm32s()) | 0;
};
$v86$$.prototype.sib_table[246] = function $$v86$$$$sib_table$246$($cpu$$inline_335$$) {
  return($cpu$$inline_335$$.reg32s[6] << 3) + $cpu$$inline_335$$.get_seg_prefix(3) + $cpu$$inline_335$$.reg32s[6] | 0;
};
$v86$$.prototype.sib_table[247] = function $$v86$$$$sib_table$247$($cpu$$inline_336$$) {
  return($cpu$$inline_336$$.reg32s[6] << 3) + $cpu$$inline_336$$.get_seg_prefix(3) + $cpu$$inline_336$$.reg32s[7] | 0;
};
$v86$$.prototype.sib_table[56] = function $$v86$$$$sib_table$56$($cpu$$inline_337$$) {
  return $cpu$$inline_337$$.reg32s[7] + $cpu$$inline_337$$.get_seg_prefix(3) + $cpu$$inline_337$$.reg32s[0] | 0;
};
$v86$$.prototype.sib_table[57] = function $$v86$$$$sib_table$57$($cpu$$inline_338$$) {
  return $cpu$$inline_338$$.reg32s[7] + $cpu$$inline_338$$.get_seg_prefix(3) + $cpu$$inline_338$$.reg32s[1] | 0;
};
$v86$$.prototype.sib_table[58] = function $$v86$$$$sib_table$58$($cpu$$inline_339$$) {
  return $cpu$$inline_339$$.reg32s[7] + $cpu$$inline_339$$.get_seg_prefix(3) + $cpu$$inline_339$$.reg32s[2] | 0;
};
$v86$$.prototype.sib_table[59] = function $$v86$$$$sib_table$59$($cpu$$inline_340$$) {
  return $cpu$$inline_340$$.reg32s[7] + $cpu$$inline_340$$.get_seg_prefix(3) + $cpu$$inline_340$$.reg32s[3] | 0;
};
$v86$$.prototype.sib_table[60] = function $$v86$$$$sib_table$60$($cpu$$inline_341$$) {
  return $cpu$$inline_341$$.reg32s[7] + $cpu$$inline_341$$.get_seg_prefix(2) + $cpu$$inline_341$$.reg32s[4] | 0;
};
$v86$$.prototype.sib_table[61] = function $$v86$$$$sib_table$61$($cpu$$inline_342$$, $mod$$inline_343$$) {
  return $cpu$$inline_342$$.reg32s[7] + ($mod$$inline_343$$ ? $cpu$$inline_342$$.get_seg_prefix(2) + $cpu$$inline_342$$.reg32s[5] : $cpu$$inline_342$$.get_seg_prefix(3) + $cpu$$inline_342$$.read_imm32s()) | 0;
};
$v86$$.prototype.sib_table[62] = function $$v86$$$$sib_table$62$($cpu$$inline_344$$) {
  return $cpu$$inline_344$$.reg32s[7] + $cpu$$inline_344$$.get_seg_prefix(3) + $cpu$$inline_344$$.reg32s[6] | 0;
};
$v86$$.prototype.sib_table[63] = function $$v86$$$$sib_table$63$($cpu$$inline_345$$) {
  return $cpu$$inline_345$$.reg32s[7] + $cpu$$inline_345$$.get_seg_prefix(3) + $cpu$$inline_345$$.reg32s[7] | 0;
};
$v86$$.prototype.sib_table[120] = function $$v86$$$$sib_table$120$($cpu$$inline_346$$) {
  return($cpu$$inline_346$$.reg32s[7] << 1) + $cpu$$inline_346$$.get_seg_prefix(3) + $cpu$$inline_346$$.reg32s[0] | 0;
};
$v86$$.prototype.sib_table[121] = function $$v86$$$$sib_table$121$($cpu$$inline_347$$) {
  return($cpu$$inline_347$$.reg32s[7] << 1) + $cpu$$inline_347$$.get_seg_prefix(3) + $cpu$$inline_347$$.reg32s[1] | 0;
};
$v86$$.prototype.sib_table[122] = function $$v86$$$$sib_table$122$($cpu$$inline_348$$) {
  return($cpu$$inline_348$$.reg32s[7] << 1) + $cpu$$inline_348$$.get_seg_prefix(3) + $cpu$$inline_348$$.reg32s[2] | 0;
};
$v86$$.prototype.sib_table[123] = function $$v86$$$$sib_table$123$($cpu$$inline_349$$) {
  return($cpu$$inline_349$$.reg32s[7] << 1) + $cpu$$inline_349$$.get_seg_prefix(3) + $cpu$$inline_349$$.reg32s[3] | 0;
};
$v86$$.prototype.sib_table[124] = function $$v86$$$$sib_table$124$($cpu$$inline_350$$) {
  return($cpu$$inline_350$$.reg32s[7] << 1) + $cpu$$inline_350$$.get_seg_prefix(2) + $cpu$$inline_350$$.reg32s[4] | 0;
};
$v86$$.prototype.sib_table[125] = function $$v86$$$$sib_table$125$($cpu$$inline_351$$, $mod$$inline_352$$) {
  return($cpu$$inline_351$$.reg32s[7] << 1) + ($mod$$inline_352$$ ? $cpu$$inline_351$$.get_seg_prefix(2) + $cpu$$inline_351$$.reg32s[5] : $cpu$$inline_351$$.get_seg_prefix(3) + $cpu$$inline_351$$.read_imm32s()) | 0;
};
$v86$$.prototype.sib_table[126] = function $$v86$$$$sib_table$126$($cpu$$inline_353$$) {
  return($cpu$$inline_353$$.reg32s[7] << 1) + $cpu$$inline_353$$.get_seg_prefix(3) + $cpu$$inline_353$$.reg32s[6] | 0;
};
$v86$$.prototype.sib_table[127] = function $$v86$$$$sib_table$127$($cpu$$inline_354$$) {
  return($cpu$$inline_354$$.reg32s[7] << 1) + $cpu$$inline_354$$.get_seg_prefix(3) + $cpu$$inline_354$$.reg32s[7] | 0;
};
$v86$$.prototype.sib_table[184] = function $$v86$$$$sib_table$184$($cpu$$inline_355$$) {
  return($cpu$$inline_355$$.reg32s[7] << 2) + $cpu$$inline_355$$.get_seg_prefix(3) + $cpu$$inline_355$$.reg32s[0] | 0;
};
$v86$$.prototype.sib_table[185] = function $$v86$$$$sib_table$185$($cpu$$inline_356$$) {
  return($cpu$$inline_356$$.reg32s[7] << 2) + $cpu$$inline_356$$.get_seg_prefix(3) + $cpu$$inline_356$$.reg32s[1] | 0;
};
$v86$$.prototype.sib_table[186] = function $$v86$$$$sib_table$186$($cpu$$inline_357$$) {
  return($cpu$$inline_357$$.reg32s[7] << 2) + $cpu$$inline_357$$.get_seg_prefix(3) + $cpu$$inline_357$$.reg32s[2] | 0;
};
$v86$$.prototype.sib_table[187] = function $$v86$$$$sib_table$187$($cpu$$inline_358$$) {
  return($cpu$$inline_358$$.reg32s[7] << 2) + $cpu$$inline_358$$.get_seg_prefix(3) + $cpu$$inline_358$$.reg32s[3] | 0;
};
$v86$$.prototype.sib_table[188] = function $$v86$$$$sib_table$188$($cpu$$inline_359$$) {
  return($cpu$$inline_359$$.reg32s[7] << 2) + $cpu$$inline_359$$.get_seg_prefix(2) + $cpu$$inline_359$$.reg32s[4] | 0;
};
$v86$$.prototype.sib_table[189] = function $$v86$$$$sib_table$189$($cpu$$inline_360$$, $mod$$inline_361$$) {
  return($cpu$$inline_360$$.reg32s[7] << 2) + ($mod$$inline_361$$ ? $cpu$$inline_360$$.get_seg_prefix(2) + $cpu$$inline_360$$.reg32s[5] : $cpu$$inline_360$$.get_seg_prefix(3) + $cpu$$inline_360$$.read_imm32s()) | 0;
};
$v86$$.prototype.sib_table[190] = function $$v86$$$$sib_table$190$($cpu$$inline_362$$) {
  return($cpu$$inline_362$$.reg32s[7] << 2) + $cpu$$inline_362$$.get_seg_prefix(3) + $cpu$$inline_362$$.reg32s[6] | 0;
};
$v86$$.prototype.sib_table[191] = function $$v86$$$$sib_table$191$($cpu$$inline_363$$) {
  return($cpu$$inline_363$$.reg32s[7] << 2) + $cpu$$inline_363$$.get_seg_prefix(3) + $cpu$$inline_363$$.reg32s[7] | 0;
};
$v86$$.prototype.sib_table[248] = function $$v86$$$$sib_table$248$($cpu$$inline_364$$) {
  return($cpu$$inline_364$$.reg32s[7] << 3) + $cpu$$inline_364$$.get_seg_prefix(3) + $cpu$$inline_364$$.reg32s[0] | 0;
};
$v86$$.prototype.sib_table[249] = function $$v86$$$$sib_table$249$($cpu$$inline_365$$) {
  return($cpu$$inline_365$$.reg32s[7] << 3) + $cpu$$inline_365$$.get_seg_prefix(3) + $cpu$$inline_365$$.reg32s[1] | 0;
};
$v86$$.prototype.sib_table[250] = function $$v86$$$$sib_table$250$($cpu$$inline_366$$) {
  return($cpu$$inline_366$$.reg32s[7] << 3) + $cpu$$inline_366$$.get_seg_prefix(3) + $cpu$$inline_366$$.reg32s[2] | 0;
};
$v86$$.prototype.sib_table[251] = function $$v86$$$$sib_table$251$($cpu$$inline_367$$) {
  return($cpu$$inline_367$$.reg32s[7] << 3) + $cpu$$inline_367$$.get_seg_prefix(3) + $cpu$$inline_367$$.reg32s[3] | 0;
};
$v86$$.prototype.sib_table[252] = function $$v86$$$$sib_table$252$($cpu$$inline_368$$) {
  return($cpu$$inline_368$$.reg32s[7] << 3) + $cpu$$inline_368$$.get_seg_prefix(2) + $cpu$$inline_368$$.reg32s[4] | 0;
};
$v86$$.prototype.sib_table[253] = function $$v86$$$$sib_table$253$($cpu$$inline_369$$, $mod$$inline_370$$) {
  return($cpu$$inline_369$$.reg32s[7] << 3) + ($mod$$inline_370$$ ? $cpu$$inline_369$$.get_seg_prefix(2) + $cpu$$inline_369$$.reg32s[5] : $cpu$$inline_369$$.get_seg_prefix(3) + $cpu$$inline_369$$.read_imm32s()) | 0;
};
$v86$$.prototype.sib_table[254] = function $$v86$$$$sib_table$254$($cpu$$inline_371$$) {
  return($cpu$$inline_371$$.reg32s[7] << 3) + $cpu$$inline_371$$.get_seg_prefix(3) + $cpu$$inline_371$$.reg32s[6] | 0;
};
$v86$$.prototype.sib_table[255] = function $$v86$$$$sib_table$255$($cpu$$inline_372$$) {
  return($cpu$$inline_372$$.reg32s[7] << 3) + $cpu$$inline_372$$.get_seg_prefix(3) + $cpu$$inline_372$$.reg32s[7] | 0;
};
$v86$$.prototype.modrm_resolve = function $$v86$$$$modrm_resolve$($modrm_byte$$inline_373$$) {
  return(this.address_size_32 ? this.modrm_table32 : this.modrm_table16)[$modrm_byte$$inline_373$$](this);
};
"use strict";
$JSCompiler_prototypeAlias$$ = $v86$$.prototype;
$JSCompiler_prototypeAlias$$.add = function $$JSCompiler_prototypeAlias$$$add$($dest_operand$$, $source_operand$$, $op_size$$) {
  this.last_op1 = $dest_operand$$;
  this.last_op2 = $source_operand$$;
  this.last_add_result = this.last_result = $dest_operand$$ + $source_operand$$ | 0;
  this.last_op_size = $op_size$$;
  this.flags_changed = 2261;
  return this.last_result;
};
$JSCompiler_prototypeAlias$$.adc = function $$JSCompiler_prototypeAlias$$$adc$($dest_operand$$1$$, $source_operand$$1$$, $op_size$$1$$) {
  var $cf$$ = this.getcf();
  this.last_op1 = $dest_operand$$1$$;
  this.last_op2 = $source_operand$$1$$;
  this.last_add_result = this.last_result = ($dest_operand$$1$$ + $source_operand$$1$$ | 0) + $cf$$ | 0;
  this.last_op_size = $op_size$$1$$;
  this.flags_changed = 2261;
  return this.last_result;
};
$JSCompiler_prototypeAlias$$.sub = function $$JSCompiler_prototypeAlias$$$sub$($dest_operand$$3$$, $source_operand$$3$$, $op_size$$3$$) {
  this.last_add_result = $dest_operand$$3$$;
  this.last_op2 = $source_operand$$3$$;
  this.last_op1 = this.last_result = $dest_operand$$3$$ - $source_operand$$3$$ | 0;
  this.last_op_size = $op_size$$3$$;
  this.flags_changed = 2261;
  return this.last_result;
};
$JSCompiler_prototypeAlias$$.sbb = function $$JSCompiler_prototypeAlias$$$sbb$($dest_operand$$4$$, $source_operand$$4$$, $op_size$$4$$) {
  var $cf$$1$$ = this.getcf();
  this.last_add_result = $dest_operand$$4$$;
  this.last_op2 = $source_operand$$4$$;
  this.last_op1 = this.last_result = $dest_operand$$4$$ - $source_operand$$4$$ - $cf$$1$$ | 0;
  this.last_op_size = $op_size$$4$$;
  this.flags_changed = 2261;
  return this.last_result;
};
$JSCompiler_prototypeAlias$$.inc = function $$JSCompiler_prototypeAlias$$$inc$($dest_operand$$5$$, $op_size$$5$$) {
  this.flags = this.flags & -2 | this.getcf();
  this.last_op1 = $dest_operand$$5$$;
  this.last_op2 = 1;
  this.last_add_result = this.last_result = $dest_operand$$5$$ + 1 | 0;
  this.last_op_size = $op_size$$5$$;
  this.flags_changed = 2260;
  return this.last_result;
};
$JSCompiler_prototypeAlias$$.dec = function $$JSCompiler_prototypeAlias$$$dec$($dest_operand$$6$$, $op_size$$6$$) {
  this.flags = this.flags & -2 | this.getcf();
  this.last_add_result = $dest_operand$$6$$;
  this.last_op2 = 1;
  this.last_op1 = this.last_result = $dest_operand$$6$$ - 1 | 0;
  this.last_op_size = $op_size$$6$$;
  this.flags_changed = 2260;
  return this.last_result;
};
$JSCompiler_prototypeAlias$$.neg = function $$JSCompiler_prototypeAlias$$$neg$($dest_operand$$7$$, $op_size$$7$$) {
  this.last_op1 = this.last_result = -$dest_operand$$7$$ | 0;
  this.flags_changed = 2261;
  this.last_add_result = 0;
  this.last_op2 = $dest_operand$$7$$;
  this.last_op_size = $op_size$$7$$;
  return this.last_result;
};
$JSCompiler_prototypeAlias$$.mul8 = function $$JSCompiler_prototypeAlias$$$mul8$($result_source_operand$$5$$) {
  $result_source_operand$$5$$ = $result_source_operand$$5$$ * this.reg8[0];
  this.reg16[0] = $result_source_operand$$5$$;
  this.flags = 256 > $result_source_operand$$5$$ ? this.flags & -2050 : this.flags | 2049;
  this.flags_changed = 0;
};
$JSCompiler_prototypeAlias$$.imul8 = function $$JSCompiler_prototypeAlias$$$imul8$($result$$1_source_operand$$6$$) {
  $result$$1_source_operand$$6$$ = $result$$1_source_operand$$6$$ * this.reg8s[0];
  this.reg16[0] = $result$$1_source_operand$$6$$;
  this.flags = 127 < $result$$1_source_operand$$6$$ || -128 > $result$$1_source_operand$$6$$ ? this.flags | 2049 : this.flags & -2050;
  this.flags_changed = 0;
};
$JSCompiler_prototypeAlias$$.mul16 = function $$JSCompiler_prototypeAlias$$$mul16$($result$$2_source_operand$$7$$) {
  $result$$2_source_operand$$7$$ = $result$$2_source_operand$$7$$ * this.reg16[0];
  var $high_result$$ = $result$$2_source_operand$$7$$ >>> 16;
  this.reg16[0] = $result$$2_source_operand$$7$$;
  this.reg16[4] = $high_result$$;
  this.flags = 0 === $high_result$$ ? this.flags & -2050 : this.flags | 2049;
  this.flags_changed = 0;
};
$JSCompiler_prototypeAlias$$.imul16 = function $$JSCompiler_prototypeAlias$$$imul16$($result$$3_source_operand$$8$$) {
  $result$$3_source_operand$$8$$ = $result$$3_source_operand$$8$$ * this.reg16s[0];
  this.reg16[0] = $result$$3_source_operand$$8$$;
  this.reg16[4] = $result$$3_source_operand$$8$$ >> 16;
  this.flags = 32767 < $result$$3_source_operand$$8$$ || -32768 > $result$$3_source_operand$$8$$ ? this.flags | 2049 : this.flags & -2050;
  this.flags_changed = 0;
};
$JSCompiler_prototypeAlias$$.imul_reg16 = function $$JSCompiler_prototypeAlias$$$imul_reg16$($operand1$$, $operand2$$) {
  var $result$$4$$ = $operand1$$ * $operand2$$;
  this.flags = 32767 < $result$$4$$ || -32768 > $result$$4$$ ? this.flags | 2049 : this.flags & -2050;
  this.flags_changed = 0;
  return $result$$4$$;
};
$JSCompiler_prototypeAlias$$.mul32 = function $$JSCompiler_prototypeAlias$$$mul32$($b16_source_operand$$9$$) {
  var $a16_dest_operand$$8$$ = this.reg32s[0], $a00$$ = $a16_dest_operand$$8$$ & 65535, $a16_dest_operand$$8$$ = $a16_dest_operand$$8$$ >>> 16, $b00_mid$$ = $b16_source_operand$$9$$ & 65535;
  $b16_source_operand$$9$$ = $b16_source_operand$$9$$ >>> 16;
  var $low_result$$ = $a00$$ * $b00_mid$$, $b00_mid$$ = ($low_result$$ >>> 16) + ($a16_dest_operand$$8$$ * $b00_mid$$ | 0) | 0, $high_result$$1$$ = $b00_mid$$ >>> 16, $b00_mid$$ = ($b00_mid$$ & 65535) + ($a00$$ * $b16_source_operand$$9$$ | 0) | 0, $high_result$$1$$ = (($b00_mid$$ >>> 16) + ($a16_dest_operand$$8$$ * $b16_source_operand$$9$$ | 0) | 0) + $high_result$$1$$ | 0;
  this.reg32s[0] = $b00_mid$$ << 16 | $low_result$$ & 65535;
  this.reg32s[2] = $high_result$$1$$;
  this.flags = 0 === $high_result$$1$$ ? this.flags & -2050 : this.flags | 2049;
  this.flags_changed = 0;
};
$JSCompiler_prototypeAlias$$.imul32 = function $$JSCompiler_prototypeAlias$$$imul32$($b16$$1_source_operand$$10$$) {
  var $a16$$1_dest_operand$$9$$ = this.reg32s[0], $is_neg$$ = !1;
  0 > $a16$$1_dest_operand$$9$$ && ($is_neg$$ = !0, $a16$$1_dest_operand$$9$$ = -$a16$$1_dest_operand$$9$$ | 0);
  0 > $b16$$1_source_operand$$10$$ && ($is_neg$$ = !$is_neg$$, $b16$$1_source_operand$$10$$ = -$b16$$1_source_operand$$10$$ | 0);
  var $a00$$1$$ = $a16$$1_dest_operand$$9$$ & 65535, $a16$$1_dest_operand$$9$$ = $a16$$1_dest_operand$$9$$ >>> 16, $b00$$1_mid$$1$$ = $b16$$1_source_operand$$10$$ & 65535;
  $b16$$1_source_operand$$10$$ = $b16$$1_source_operand$$10$$ >>> 16;
  var $low_result$$1$$ = $a00$$1$$ * $b00$$1_mid$$1$$, $b00$$1_mid$$1$$ = ($low_result$$1$$ >>> 16) + ($a16$$1_dest_operand$$9$$ * $b00$$1_mid$$1$$ | 0) | 0, $high_result$$2$$ = $b00$$1_mid$$1$$ >>> 16, $b00$$1_mid$$1$$ = ($b00$$1_mid$$1$$ & 65535) + ($a00$$1$$ * $b16$$1_source_operand$$10$$ | 0) | 0, $low_result$$1$$ = $b00$$1_mid$$1$$ << 16 | $low_result$$1$$ & 65535, $high_result$$2$$ = (($b00$$1_mid$$1$$ >>> 16) + ($a16$$1_dest_operand$$9$$ * $b16$$1_source_operand$$10$$ | 0) | 0) + $high_result$$2$$ | 
  0;
  $is_neg$$ && ($low_result$$1$$ = -$low_result$$1$$ | 0, $high_result$$2$$ = ~$high_result$$2$$ + !$low_result$$1$$ | 0);
  this.reg32s[0] = $low_result$$1$$;
  this.reg32s[2] = $high_result$$2$$;
  this.flags = $high_result$$2$$ === $low_result$$1$$ >> 31 ? this.flags & -2050 : this.flags | 2049;
  this.flags_changed = 0;
};
$JSCompiler_prototypeAlias$$.imul_reg32 = function $$JSCompiler_prototypeAlias$$$imul_reg32$($operand1$$1$$, $operand2$$1$$) {
  var $is_neg$$1$$ = !1;
  0 > $operand1$$1$$ && ($is_neg$$1$$ = !0, $operand1$$1$$ = -$operand1$$1$$ | 0);
  0 > $operand2$$1$$ && ($is_neg$$1$$ = !$is_neg$$1$$, $operand2$$1$$ = -$operand2$$1$$ | 0);
  var $a00$$2$$ = $operand1$$1$$ & 65535, $a16$$2$$ = $operand1$$1$$ >>> 16, $b00$$2_mid$$2$$ = $operand2$$1$$ & 65535, $b16$$2$$ = $operand2$$1$$ >>> 16, $low_result$$2$$ = $a00$$2$$ * $b00$$2_mid$$2$$, $b00$$2_mid$$2$$ = ($low_result$$2$$ >>> 16) + ($a16$$2$$ * $b00$$2_mid$$2$$ | 0) | 0, $high_result$$3$$ = $b00$$2_mid$$2$$ >>> 16, $b00$$2_mid$$2$$ = ($b00$$2_mid$$2$$ & 65535) + ($a00$$2$$ * $b16$$2$$ | 0) | 0, $low_result$$2$$ = $b00$$2_mid$$2$$ << 16 | $low_result$$2$$ & 65535, $high_result$$3$$ = 
  (($b00$$2_mid$$2$$ >>> 16) + ($a16$$2$$ * $b16$$2$$ | 0) | 0) + $high_result$$3$$ | 0;
  $is_neg$$1$$ && ($low_result$$2$$ = -$low_result$$2$$ | 0, $high_result$$3$$ = ~$high_result$$3$$ + !$low_result$$2$$ | 0);
  this.flags = $high_result$$3$$ === $low_result$$2$$ >> 31 ? this.flags & -2050 : this.flags | 2049;
  this.flags_changed = 0;
  return $low_result$$2$$;
};
$JSCompiler_prototypeAlias$$.div8 = function $$JSCompiler_prototypeAlias$$$div8$($source_operand$$11$$) {
  var $target_operand$$ = this.reg16[0], $result$$5$$ = $target_operand$$ / $source_operand$$11$$ | 0;
  256 <= $result$$5$$ || 0 === $source_operand$$11$$ ? this.trigger_de() : (this.reg8[0] = $result$$5$$, this.reg8[1] = $target_operand$$ % $source_operand$$11$$);
};
$JSCompiler_prototypeAlias$$.idiv8 = function $$JSCompiler_prototypeAlias$$$idiv8$($source_operand$$12$$) {
  var $target_operand$$1$$ = this.reg16s[0], $result$$6$$ = $target_operand$$1$$ / $source_operand$$12$$ | 0;
  128 <= $result$$6$$ || -129 >= $result$$6$$ || 0 === $source_operand$$12$$ ? this.trigger_de() : (this.reg8[0] = $result$$6$$, this.reg8[1] = $target_operand$$1$$ % $source_operand$$12$$);
};
$JSCompiler_prototypeAlias$$.div16 = function $$JSCompiler_prototypeAlias$$$div16$($source_operand$$13$$) {
  var $target_operand$$2$$ = (this.reg16[0] | this.reg16[4] << 16) >>> 0, $result$$7$$ = $target_operand$$2$$ / $source_operand$$13$$ | 0;
  65536 <= $result$$7$$ || 0 > $result$$7$$ || 0 === $source_operand$$13$$ ? this.trigger_de() : (this.reg16[0] = $result$$7$$, this.reg16[4] = $target_operand$$2$$ % $source_operand$$13$$);
};
$JSCompiler_prototypeAlias$$.idiv16 = function $$JSCompiler_prototypeAlias$$$idiv16$($source_operand$$14$$) {
  var $target_operand$$3$$ = this.reg16[0] | this.reg16[4] << 16, $result$$8$$ = $target_operand$$3$$ / $source_operand$$14$$ | 0;
  32768 <= $result$$8$$ || -32769 >= $result$$8$$ || 0 === $source_operand$$14$$ ? this.trigger_de() : (this.reg16[0] = $result$$8$$, this.reg16[4] = $target_operand$$3$$ % $source_operand$$14$$);
};
$JSCompiler_prototypeAlias$$.div32 = function $$JSCompiler_prototypeAlias$$$div32$($source_operand$$15$$) {
  var $dest_operand_low_div$$ = this.reg32[0], $dest_operand_high_mod$$256$$ = this.reg32[2];
  ($dest_operand_high_mod$$256$$ >= $source_operand$$15$$ || !$source_operand$$15$$) && this.trigger_de();
  var $result$$9$$ = 0;
  if (1048576 < $dest_operand_high_mod$$256$$) {
    for (var $i$$12$$ = 32, $q$$ = $source_operand$$15$$;$q$$ > $dest_operand_high_mod$$256$$;) {
      $q$$ >>>= 1, $i$$12$$--;
    }
    for (;1048576 < $dest_operand_high_mod$$256$$;) {
      if ($dest_operand_high_mod$$256$$ >= $q$$) {
        var $dest_operand_high_mod$$256$$ = $dest_operand_high_mod$$256$$ - $q$$, $sub$$ = $source_operand$$15$$ << $i$$12$$ >>> 0;
        $sub$$ > $dest_operand_low_div$$ && $dest_operand_high_mod$$256$$--;
        $dest_operand_low_div$$ = $dest_operand_low_div$$ - $sub$$ >>> 0;
        $result$$9$$ |= 1 << $i$$12$$;
      }
      $i$$12$$--;
      $q$$ >>= 1;
    }
    $result$$9$$ >>>= 0;
  }
  $dest_operand_low_div$$ += 4294967296 * $dest_operand_high_mod$$256$$;
  $dest_operand_high_mod$$256$$ = $dest_operand_low_div$$ % $source_operand$$15$$;
  $result$$9$$ += $dest_operand_low_div$$ / $source_operand$$15$$ | 0;
  4294967296 <= $result$$9$$ || 0 === $source_operand$$15$$ ? this.trigger_de() : (this.reg32s[0] = $result$$9$$, this.reg32s[2] = $dest_operand_high_mod$$256$$);
};
$JSCompiler_prototypeAlias$$.idiv32 = function $$JSCompiler_prototypeAlias$$$idiv32$($source_operand$$16$$) {
  var $dest_operand_low$$1_div$$1$$ = this.reg32[0], $dest_operand_high$$1_mod$$257$$ = this.reg32s[2], $div_is_neg$$ = !1, $is_neg$$2$$ = !1;
  0 > $source_operand$$16$$ && ($is_neg$$2$$ = !0, $source_operand$$16$$ = -$source_operand$$16$$);
  0 > $dest_operand_high$$1_mod$$257$$ && ($div_is_neg$$ = !0, $is_neg$$2$$ = !$is_neg$$2$$, $dest_operand_low$$1_div$$1$$ = -$dest_operand_low$$1_div$$1$$ | 0, $dest_operand_high$$1_mod$$257$$ = ~$dest_operand_high$$1_mod$$257$$ + !$dest_operand_low$$1_div$$1$$);
  ($dest_operand_high$$1_mod$$257$$ >= $source_operand$$16$$ || !$source_operand$$16$$) && this.trigger_de();
  var $result$$10$$ = 0;
  if (1048576 < $dest_operand_high$$1_mod$$257$$) {
    for (var $i$$13$$ = 32, $q$$1$$ = $source_operand$$16$$;$q$$1$$ > $dest_operand_high$$1_mod$$257$$;) {
      $q$$1$$ >>>= 1, $i$$13$$--;
    }
    for (;1048576 < $dest_operand_high$$1_mod$$257$$;) {
      if ($dest_operand_high$$1_mod$$257$$ >= $q$$1$$) {
        var $dest_operand_high$$1_mod$$257$$ = $dest_operand_high$$1_mod$$257$$ - $q$$1$$, $sub$$1$$ = $source_operand$$16$$ << $i$$13$$ >>> 0;
        $sub$$1$$ > $dest_operand_low$$1_div$$1$$ && $dest_operand_high$$1_mod$$257$$--;
        $dest_operand_low$$1_div$$1$$ = $dest_operand_low$$1_div$$1$$ - $sub$$1$$ >>> 0;
        $result$$10$$ |= 1 << $i$$13$$;
      }
      $i$$13$$--;
      $q$$1$$ >>= 1;
    }
    $result$$10$$ >>>= 0;
  }
  $dest_operand_low$$1_div$$1$$ += 4294967296 * $dest_operand_high$$1_mod$$257$$;
  $dest_operand_high$$1_mod$$257$$ = $dest_operand_low$$1_div$$1$$ % $source_operand$$16$$;
  $result$$10$$ += $dest_operand_low$$1_div$$1$$ / $source_operand$$16$$ | 0;
  $is_neg$$2$$ && ($result$$10$$ = -$result$$10$$ | 0);
  $div_is_neg$$ && ($dest_operand_high$$1_mod$$257$$ = -$dest_operand_high$$1_mod$$257$$ | 0);
  2147483648 <= $result$$10$$ || -2147483649 >= $result$$10$$ || 0 === $source_operand$$16$$ ? this.trigger_de() : (this.reg32s[0] = $result$$10$$, this.reg32s[2] = $dest_operand_high$$1_mod$$257$$);
};
$JSCompiler_prototypeAlias$$.xadd8 = function $$JSCompiler_prototypeAlias$$$xadd8$($source_operand$$17$$, $reg$$) {
  var $tmp$$ = this.reg8[$reg$$];
  this.reg8[$reg$$] = $source_operand$$17$$;
  return this.add($source_operand$$17$$, $tmp$$, 7);
};
$JSCompiler_prototypeAlias$$.xadd16 = function $$JSCompiler_prototypeAlias$$$xadd16$($source_operand$$18$$, $reg$$1$$) {
  var $tmp$$1$$ = this.reg16[$reg$$1$$];
  this.reg16[$reg$$1$$] = $source_operand$$18$$;
  return this.add($source_operand$$18$$, $tmp$$1$$, 15);
};
$JSCompiler_prototypeAlias$$.xadd32 = function $$JSCompiler_prototypeAlias$$$xadd32$($source_operand$$19$$, $reg$$2$$) {
  var $tmp$$2$$ = this.reg32s[$reg$$2$$];
  this.reg32s[$reg$$2$$] = $source_operand$$19$$;
  return this.add($source_operand$$19$$, $tmp$$2$$, 31);
};
$JSCompiler_prototypeAlias$$.bcd_daa = function $$JSCompiler_prototypeAlias$$$bcd_daa$() {
  var $old_al$$ = this.reg8[0], $old_cf$$ = this.getcf(), $old_af$$ = this.getaf();
  this.flags &= -18;
  if (9 < ($old_al$$ & 15) || $old_af$$) {
    this.reg8[0] += 6, this.flags |= 16;
  }
  if (153 < $old_al$$ || $old_cf$$) {
    this.reg8[0] += 96, this.flags |= 1;
  }
  this.last_result = this.reg8[0];
  this.last_op_size = 7;
  this.last_op1 = this.last_op2 = 0;
  this.flags_changed = 196;
};
$JSCompiler_prototypeAlias$$.bcd_das = function $$JSCompiler_prototypeAlias$$$bcd_das$() {
  var $old_al$$1$$ = this.reg8[0], $old_cf$$1$$ = this.getcf();
  this.flags &= -2;
  9 < ($old_al$$1$$ & 15) || this.getaf() ? (this.reg8[0] -= 6, this.flags |= 16, this.flags = this.flags & -2 | $old_cf$$1$$ | this.reg8[0] >> 7) : this.flags &= -17;
  if (153 < $old_al$$1$$ || $old_cf$$1$$) {
    this.reg8[0] -= 96, this.flags |= 1;
  }
  this.last_result = this.reg8[0];
  this.last_op_size = 7;
  this.last_op1 = this.last_op2 = 0;
  this.flags_changed = 196;
};
$JSCompiler_prototypeAlias$$.bcd_aam = function $$JSCompiler_prototypeAlias$$$bcd_aam$() {
  var $imm8$$ = this.read_imm8();
  if (0 === $imm8$$) {
    this.trigger_de();
  } else {
    var $temp$$ = this.reg8[0];
    this.reg8[1] = $temp$$ / $imm8$$;
    this.reg8[0] = $temp$$ % $imm8$$;
    this.last_result = this.reg8[0];
    this.flags_changed = 196;
    this.flags &= -2066;
  }
};
$JSCompiler_prototypeAlias$$.bcd_aad = function $$JSCompiler_prototypeAlias$$$bcd_aad$() {
  var $imm8$$1$$ = this.read_imm8();
  this.last_result = this.reg8[0] + this.reg8[1] * $imm8$$1$$;
  this.reg16[0] = this.last_result & 255;
  this.last_op_size = 7;
  this.flags_changed = 196;
  this.flags &= -2066;
};
$JSCompiler_prototypeAlias$$.bcd_aaa = function $$JSCompiler_prototypeAlias$$$bcd_aaa$() {
  9 < (this.reg8[0] & 15) || this.getaf() ? (this.reg16[0] += 6, this.reg8[1] += 1, this.flags |= 17) : this.flags &= -18;
  this.reg8[0] &= 15;
  this.flags_changed &= -18;
};
$JSCompiler_prototypeAlias$$.bcd_aas = function $$JSCompiler_prototypeAlias$$$bcd_aas$() {
  9 < (this.reg8[0] & 15) || this.getaf() ? (this.reg16[0] -= 6, this.reg8[1] -= 1, this.flags |= 17) : this.flags &= -18;
  this.reg8[0] &= 15;
  this.flags_changed &= -18;
};
$JSCompiler_prototypeAlias$$.and = function $$JSCompiler_prototypeAlias$$$and$($dest_operand$$10$$, $source_operand$$20$$, $op_size$$8$$) {
  this.last_result = $dest_operand$$10$$ & $source_operand$$20$$;
  this.last_op_size = $op_size$$8$$;
  this.flags &= -2066;
  this.flags_changed = 196;
  return this.last_result;
};
$JSCompiler_prototypeAlias$$.or = function $$JSCompiler_prototypeAlias$$$or$($dest_operand$$11$$, $source_operand$$21$$, $op_size$$9$$) {
  this.last_result = $dest_operand$$11$$ | $source_operand$$21$$;
  this.last_op_size = $op_size$$9$$;
  this.flags &= -2066;
  this.flags_changed = 196;
  return this.last_result;
};
$JSCompiler_prototypeAlias$$.xor = function $$JSCompiler_prototypeAlias$$$xor$($dest_operand$$12$$, $source_operand$$22$$, $op_size$$10$$) {
  this.last_result = $dest_operand$$12$$ ^ $source_operand$$22$$;
  this.last_op_size = $op_size$$10$$;
  this.flags &= -2066;
  this.flags_changed = 196;
  return this.last_result;
};
$JSCompiler_prototypeAlias$$.rol8 = function $$JSCompiler_prototypeAlias$$$rol8$($dest_operand$$13$$, $count$$10$$) {
  if (!$count$$10$$) {
    return $dest_operand$$13$$;
  }
  $count$$10$$ &= 7;
  var $result$$11$$ = $dest_operand$$13$$ << $count$$10$$ | $dest_operand$$13$$ >> 8 - $count$$10$$;
  this.flags_changed &= -2050;
  this.flags = this.flags & -2050 | $result$$11$$ & 1 | ($result$$11$$ << 11 ^ $result$$11$$ << 4) & 2048;
  return $result$$11$$;
};
$JSCompiler_prototypeAlias$$.rol16 = function $$JSCompiler_prototypeAlias$$$rol16$($dest_operand$$14$$, $count$$11$$) {
  if (!$count$$11$$) {
    return $dest_operand$$14$$;
  }
  $count$$11$$ &= 15;
  var $result$$12$$ = $dest_operand$$14$$ << $count$$11$$ | $dest_operand$$14$$ >> 16 - $count$$11$$;
  this.flags_changed &= -2050;
  this.flags = this.flags & -2050 | $result$$12$$ & 1 | ($result$$12$$ << 11 ^ $result$$12$$ >> 4) & 2048;
  return $result$$12$$;
};
$JSCompiler_prototypeAlias$$.rol32 = function $$JSCompiler_prototypeAlias$$$rol32$($dest_operand$$15$$, $count$$12$$) {
  if (!$count$$12$$) {
    return $dest_operand$$15$$;
  }
  var $result$$13$$ = $dest_operand$$15$$ << $count$$12$$ | $dest_operand$$15$$ >>> 32 - $count$$12$$;
  this.flags_changed &= -2050;
  this.flags = this.flags & -2050 | $result$$13$$ & 1 | ($result$$13$$ << 11 ^ $result$$13$$ >> 20) & 2048;
  return $result$$13$$;
};
$JSCompiler_prototypeAlias$$.rcl8 = function $$JSCompiler_prototypeAlias$$$rcl8$($dest_operand$$16$$, $count$$13$$) {
  $count$$13$$ %= 9;
  if (!$count$$13$$) {
    return $dest_operand$$16$$;
  }
  var $result$$14$$ = $dest_operand$$16$$ << $count$$13$$ | this.getcf() << $count$$13$$ - 1 | $dest_operand$$16$$ >> 9 - $count$$13$$;
  this.flags_changed &= -2050;
  this.flags = this.flags & -2050 | $result$$14$$ >> 8 & 1 | ($result$$14$$ << 3 ^ $result$$14$$ << 4) & 2048;
  return $result$$14$$;
};
$JSCompiler_prototypeAlias$$.rcl16 = function $$JSCompiler_prototypeAlias$$$rcl16$($dest_operand$$17$$, $count$$14$$) {
  $count$$14$$ %= 17;
  if (!$count$$14$$) {
    return $dest_operand$$17$$;
  }
  var $result$$15$$ = $dest_operand$$17$$ << $count$$14$$ | this.getcf() << $count$$14$$ - 1 | $dest_operand$$17$$ >> 17 - $count$$14$$;
  this.flags_changed &= -2050;
  this.flags = this.flags & -2050 | $result$$15$$ >> 16 & 1 | ($result$$15$$ >> 5 ^ $result$$15$$ >> 4) & 2048;
  return $result$$15$$;
};
$JSCompiler_prototypeAlias$$.rcl32 = function $$JSCompiler_prototypeAlias$$$rcl32$($dest_operand$$18$$, $count$$15$$) {
  if (!$count$$15$$) {
    return $dest_operand$$18$$;
  }
  var $result$$16$$ = $dest_operand$$18$$ << $count$$15$$ | this.getcf() << $count$$15$$ - 1;
  1 < $count$$15$$ && ($result$$16$$ |= $dest_operand$$18$$ >>> 33 - $count$$15$$);
  this.flags_changed &= -2050;
  this.flags = this.flags & -2050 | $dest_operand$$18$$ >>> 32 - $count$$15$$ & 1;
  this.flags |= (this.flags << 11 ^ $result$$16$$ >> 20) & 2048;
  return $result$$16$$;
};
$JSCompiler_prototypeAlias$$.ror8 = function $$JSCompiler_prototypeAlias$$$ror8$($dest_operand$$19$$, $count$$16$$) {
  $count$$16$$ &= 7;
  if (!$count$$16$$) {
    return $dest_operand$$19$$;
  }
  var $result$$17$$ = $dest_operand$$19$$ >> $count$$16$$ | $dest_operand$$19$$ << 8 - $count$$16$$;
  this.flags_changed &= -2050;
  this.flags = this.flags & -2050 | $result$$17$$ >> 7 & 1 | ($result$$17$$ << 4 ^ $result$$17$$ << 5) & 2048;
  return $result$$17$$;
};
$JSCompiler_prototypeAlias$$.ror16 = function $$JSCompiler_prototypeAlias$$$ror16$($dest_operand$$20$$, $count$$17$$) {
  $count$$17$$ &= 15;
  if (!$count$$17$$) {
    return $dest_operand$$20$$;
  }
  var $result$$18$$ = $dest_operand$$20$$ >> $count$$17$$ | $dest_operand$$20$$ << 16 - $count$$17$$;
  this.flags_changed &= -2050;
  this.flags = this.flags & -2050 | $result$$18$$ >> 15 & 1 | ($result$$18$$ >> 4 ^ $result$$18$$ >> 3) & 2048;
  return $result$$18$$;
};
$JSCompiler_prototypeAlias$$.ror32 = function $$JSCompiler_prototypeAlias$$$ror32$($dest_operand$$21$$, $count$$18$$) {
  if (!$count$$18$$) {
    return $dest_operand$$21$$;
  }
  var $result$$19$$ = $dest_operand$$21$$ >>> $count$$18$$ | $dest_operand$$21$$ << 32 - $count$$18$$;
  this.flags_changed &= -2050;
  this.flags = this.flags & -2050 | $result$$19$$ >> 31 & 1 | ($result$$19$$ >> 20 ^ $result$$19$$ >> 19) & 2048;
  return $result$$19$$;
};
$JSCompiler_prototypeAlias$$.rcr8 = function $$JSCompiler_prototypeAlias$$$rcr8$($dest_operand$$22$$, $count$$19$$) {
  $count$$19$$ %= 9;
  if (!$count$$19$$) {
    return $dest_operand$$22$$;
  }
  var $result$$20$$ = $dest_operand$$22$$ >> $count$$19$$ | this.getcf() << 8 - $count$$19$$ | $dest_operand$$22$$ << 9 - $count$$19$$;
  this.flags_changed &= -2050;
  this.flags = this.flags & -2050 | $result$$20$$ >> 8 & 1 | ($result$$20$$ << 4 ^ $result$$20$$ << 5) & 2048;
  return $result$$20$$;
};
$JSCompiler_prototypeAlias$$.rcr16 = function $$JSCompiler_prototypeAlias$$$rcr16$($dest_operand$$23$$, $count$$20$$) {
  $count$$20$$ %= 17;
  if (!$count$$20$$) {
    return $dest_operand$$23$$;
  }
  var $result$$21$$ = $dest_operand$$23$$ >> $count$$20$$ | this.getcf() << 16 - $count$$20$$ | $dest_operand$$23$$ << 17 - $count$$20$$;
  this.flags_changed &= -2050;
  this.flags = this.flags & -2050 | $result$$21$$ >> 16 & 1 | ($result$$21$$ >> 4 ^ $result$$21$$ >> 3) & 2048;
  return $result$$21$$;
};
$JSCompiler_prototypeAlias$$.rcr32 = function $$JSCompiler_prototypeAlias$$$rcr32$($dest_operand$$24$$, $count$$21$$) {
  if (!$count$$21$$) {
    return $dest_operand$$24$$;
  }
  var $result$$22$$ = $dest_operand$$24$$ >>> $count$$21$$ | this.getcf() << 32 - $count$$21$$;
  1 < $count$$21$$ && ($result$$22$$ |= $dest_operand$$24$$ << 33 - $count$$21$$);
  this.flags_changed &= -2050;
  this.flags = this.flags & -2050 | $dest_operand$$24$$ >> $count$$21$$ - 1 & 1 | ($result$$22$$ >> 20 ^ $result$$22$$ >> 19) & 2048;
  return $result$$22$$;
};
$JSCompiler_prototypeAlias$$.shl8 = function $$JSCompiler_prototypeAlias$$$shl8$($dest_operand$$25$$, $count$$22$$) {
  if (0 === $count$$22$$) {
    return $dest_operand$$25$$;
  }
  this.last_result = $dest_operand$$25$$ << $count$$22$$;
  this.last_op_size = 7;
  this.flags_changed = 212;
  this.flags = this.flags & -2050 | this.last_result >> 8 & 1 | (this.last_result << 3 ^ this.last_result << 4) & 2048;
  return this.last_result;
};
$JSCompiler_prototypeAlias$$.shl16 = function $$JSCompiler_prototypeAlias$$$shl16$($dest_operand$$26$$, $count$$23$$) {
  if (0 === $count$$23$$) {
    return $dest_operand$$26$$;
  }
  this.last_result = $dest_operand$$26$$ << $count$$23$$;
  this.last_op_size = 15;
  this.flags_changed = 212;
  this.flags = this.flags & -2050 | this.last_result >> 16 & 1 | (this.last_result >> 5 ^ this.last_result >> 4) & 2048;
  return this.last_result;
};
$JSCompiler_prototypeAlias$$.shl32 = function $$JSCompiler_prototypeAlias$$$shl32$($dest_operand$$27$$, $count$$24$$) {
  if (0 === $count$$24$$) {
    return $dest_operand$$27$$;
  }
  this.last_result = $dest_operand$$27$$ << $count$$24$$;
  this.last_op_size = 31;
  this.flags_changed = 212;
  this.flags = this.flags & -2050 | $dest_operand$$27$$ >>> 32 - $count$$24$$ & 1;
  this.flags |= (this.flags & 1 ^ this.last_result >> 31 & 1) << 11 & 2048;
  return this.last_result;
};
$JSCompiler_prototypeAlias$$.shr8 = function $$JSCompiler_prototypeAlias$$$shr8$($dest_operand$$28$$, $count$$25$$) {
  if (0 === $count$$25$$) {
    return $dest_operand$$28$$;
  }
  this.last_result = $dest_operand$$28$$ >> $count$$25$$;
  this.last_op_size = 7;
  this.flags_changed = 212;
  this.flags = this.flags & -2050 | $dest_operand$$28$$ >> $count$$25$$ - 1 & 1 | ($dest_operand$$28$$ >> 7 & 1) << 11 & 2048;
  return this.last_result;
};
$JSCompiler_prototypeAlias$$.shr16 = function $$JSCompiler_prototypeAlias$$$shr16$($dest_operand$$29$$, $count$$26$$) {
  if (0 === $count$$26$$) {
    return $dest_operand$$29$$;
  }
  this.last_result = $dest_operand$$29$$ >> $count$$26$$;
  this.last_op_size = 15;
  this.flags_changed = 212;
  this.flags = this.flags & -2050 | $dest_operand$$29$$ >> $count$$26$$ - 1 & 1 | $dest_operand$$29$$ >> 4 & 2048;
  return this.last_result;
};
$JSCompiler_prototypeAlias$$.shr32 = function $$JSCompiler_prototypeAlias$$$shr32$($dest_operand$$30$$, $count$$27$$) {
  if (0 === $count$$27$$) {
    return $dest_operand$$30$$;
  }
  this.last_result = $dest_operand$$30$$ >>> $count$$27$$;
  this.last_op_size = 31;
  this.flags_changed = 212;
  this.flags = this.flags & -2050 | $dest_operand$$30$$ >>> $count$$27$$ - 1 & 1 | $dest_operand$$30$$ >> 20 & 2048;
  return this.last_result;
};
$JSCompiler_prototypeAlias$$.sar8 = function $$JSCompiler_prototypeAlias$$$sar8$($dest_operand$$31$$, $count$$28$$) {
  if (0 === $count$$28$$) {
    return $dest_operand$$31$$;
  }
  this.last_result = $dest_operand$$31$$ >> $count$$28$$;
  this.last_op_size = 7;
  this.flags_changed = 212;
  this.flags = this.flags & -2050 | $dest_operand$$31$$ >> $count$$28$$ - 1 & 1;
  return this.last_result;
};
$JSCompiler_prototypeAlias$$.sar16 = function $$JSCompiler_prototypeAlias$$$sar16$($dest_operand$$32$$, $count$$29$$) {
  if (0 === $count$$29$$) {
    return $dest_operand$$32$$;
  }
  this.last_result = $dest_operand$$32$$ >> $count$$29$$;
  this.last_op_size = 15;
  this.flags_changed = 212;
  this.flags = this.flags & -2050 | $dest_operand$$32$$ >> $count$$29$$ - 1 & 1;
  return this.last_result;
};
$JSCompiler_prototypeAlias$$.sar32 = function $$JSCompiler_prototypeAlias$$$sar32$($dest_operand$$33$$, $count$$30$$) {
  if (0 === $count$$30$$) {
    return $dest_operand$$33$$;
  }
  this.last_result = $dest_operand$$33$$ >> $count$$30$$;
  this.last_op_size = 31;
  this.flags_changed = 212;
  this.flags = this.flags & -2050 | $dest_operand$$33$$ >>> $count$$30$$ - 1 & 1;
  return this.last_result;
};
$JSCompiler_prototypeAlias$$.shrd16 = function $$JSCompiler_prototypeAlias$$$shrd16$($dest_operand$$34$$, $source_operand$$23$$, $count$$31$$) {
  if (0 === $count$$31$$) {
    return $dest_operand$$34$$;
  }
  16 >= $count$$31$$ ? (this.last_result = $dest_operand$$34$$ >> $count$$31$$ | $source_operand$$23$$ << 16 - $count$$31$$, this.flags = this.flags & -2 | $dest_operand$$34$$ >> $count$$31$$ - 1 & 1) : (this.last_result = $dest_operand$$34$$ << 32 - $count$$31$$ | $source_operand$$23$$ >> $count$$31$$ - 16, this.flags = this.flags & -2 | $source_operand$$23$$ >> $count$$31$$ - 17 & 1);
  this.last_op_size = 15;
  this.flags_changed = 212;
  this.flags = this.flags & -2049 | (this.last_result ^ $dest_operand$$34$$) >> 4 & 2048;
  return this.last_result;
};
$JSCompiler_prototypeAlias$$.shrd32 = function $$JSCompiler_prototypeAlias$$$shrd32$($dest_operand$$35$$, $source_operand$$24$$, $count$$32$$) {
  if (0 === $count$$32$$) {
    return $dest_operand$$35$$;
  }
  this.last_result = $dest_operand$$35$$ >>> $count$$32$$ | $source_operand$$24$$ << 32 - $count$$32$$;
  this.last_op_size = 31;
  this.flags_changed = 212;
  this.flags = this.flags & -2 | $dest_operand$$35$$ >>> $count$$32$$ - 1 & 1;
  this.flags = this.flags & -2049 | (this.last_result ^ $dest_operand$$35$$) >> 20 & 2048;
  return this.last_result;
};
$JSCompiler_prototypeAlias$$.shld16 = function $$JSCompiler_prototypeAlias$$$shld16$($dest_operand$$36$$, $source_operand$$25$$, $count$$33$$) {
  if (0 === $count$$33$$) {
    return $dest_operand$$36$$;
  }
  16 >= $count$$33$$ ? (this.last_result = $dest_operand$$36$$ << $count$$33$$ | $source_operand$$25$$ >>> 16 - $count$$33$$, this.flags = this.flags & -2 | $dest_operand$$36$$ >>> 16 - $count$$33$$ & 1) : (this.last_result = $dest_operand$$36$$ >> 32 - $count$$33$$ | $source_operand$$25$$ << $count$$33$$ - 16, this.flags = this.flags & -2 | $source_operand$$25$$ >>> 32 - $count$$33$$ & 1);
  this.last_op_size = 15;
  this.flags_changed = 212;
  this.flags = this.flags & -2049 | (this.flags & 1 ^ this.last_result >> 15 & 1) << 11;
  return this.last_result;
};
$JSCompiler_prototypeAlias$$.shld32 = function $$JSCompiler_prototypeAlias$$$shld32$($dest_operand$$37$$, $source_operand$$26$$, $count$$34$$) {
  if (0 === $count$$34$$) {
    return $dest_operand$$37$$;
  }
  this.last_result = $dest_operand$$37$$ << $count$$34$$ | $source_operand$$26$$ >>> 32 - $count$$34$$;
  this.last_op_size = 31;
  this.flags_changed = 212;
  this.flags = this.flags & -2 | $dest_operand$$37$$ >>> 32 - $count$$34$$ & 1;
  this.flags = this.flags & -2049 | (this.flags & 1 ^ this.last_result >> 31 & 1) << 11;
  return this.last_result;
};
$JSCompiler_prototypeAlias$$.bt_reg = function $$JSCompiler_prototypeAlias$$$bt_reg$($bit_base$$, $bit_offset$$) {
  this.flags = this.flags & -2 | $bit_base$$ >> $bit_offset$$ & 1;
  this.flags_changed &= -2;
};
$JSCompiler_prototypeAlias$$.btc_reg = function $$JSCompiler_prototypeAlias$$$btc_reg$($bit_base$$1$$, $bit_offset$$1$$) {
  this.flags = this.flags & -2 | $bit_base$$1$$ >> $bit_offset$$1$$ & 1;
  this.flags_changed &= -2;
  return $bit_base$$1$$ ^ 1 << $bit_offset$$1$$;
};
$JSCompiler_prototypeAlias$$.bts_reg = function $$JSCompiler_prototypeAlias$$$bts_reg$($bit_base$$2$$, $bit_offset$$2$$) {
  this.flags = this.flags & -2 | $bit_base$$2$$ >> $bit_offset$$2$$ & 1;
  this.flags_changed &= -2;
  return $bit_base$$2$$ | 1 << $bit_offset$$2$$;
};
$JSCompiler_prototypeAlias$$.btr_reg = function $$JSCompiler_prototypeAlias$$$btr_reg$($bit_base$$3$$, $bit_offset$$3$$) {
  this.flags = this.flags & -2 | $bit_base$$3$$ >> $bit_offset$$3$$ & 1;
  this.flags_changed &= -2;
  return $bit_base$$3$$ & ~(1 << $bit_offset$$3$$);
};
$JSCompiler_prototypeAlias$$.bt_mem = function $$JSCompiler_prototypeAlias$$$bt_mem$($virt_addr$$, $bit_offset$$4$$) {
  var $bit_base$$4$$ = this.safe_read8($virt_addr$$ + ($bit_offset$$4$$ >> 3));
  this.flags = this.flags & -2 | $bit_base$$4$$ >> ($bit_offset$$4$$ & 7) & 1;
  this.flags_changed &= -2;
};
$JSCompiler_prototypeAlias$$.btc_mem = function $$JSCompiler_prototypeAlias$$$btc_mem$($virt_addr$$1$$, $bit_offset$$5$$) {
  var $phys_addr$$ = this.translate_address_write($virt_addr$$1$$ + ($bit_offset$$5$$ >> 3)), $bit_base$$5$$ = this.memory.read8($phys_addr$$);
  $bit_offset$$5$$ &= 7;
  this.flags = this.flags & -2 | $bit_base$$5$$ >> $bit_offset$$5$$ & 1;
  this.flags_changed &= -2;
  this.memory.write8($phys_addr$$, $bit_base$$5$$ ^ 1 << $bit_offset$$5$$);
};
$JSCompiler_prototypeAlias$$.btr_mem = function $$JSCompiler_prototypeAlias$$$btr_mem$($virt_addr$$2$$, $bit_offset$$6$$) {
  var $phys_addr$$1$$ = this.translate_address_write($virt_addr$$2$$ + ($bit_offset$$6$$ >> 3)), $bit_base$$6$$ = this.memory.read8($phys_addr$$1$$);
  $bit_offset$$6$$ &= 7;
  this.flags = this.flags & -2 | $bit_base$$6$$ >> $bit_offset$$6$$ & 1;
  this.flags_changed &= -2;
  this.memory.write8($phys_addr$$1$$, $bit_base$$6$$ & ~(1 << $bit_offset$$6$$));
};
$JSCompiler_prototypeAlias$$.bts_mem = function $$JSCompiler_prototypeAlias$$$bts_mem$($virt_addr$$3$$, $bit_offset$$7$$) {
  var $phys_addr$$2$$ = this.translate_address_write($virt_addr$$3$$ + ($bit_offset$$7$$ >> 3)), $bit_base$$7$$ = this.memory.read8($phys_addr$$2$$);
  $bit_offset$$7$$ &= 7;
  this.flags = this.flags & -2 | $bit_base$$7$$ >> $bit_offset$$7$$ & 1;
  this.flags_changed &= -2;
  this.memory.write8($phys_addr$$2$$, $bit_base$$7$$ | 1 << $bit_offset$$7$$);
};
$JSCompiler_prototypeAlias$$.bsf16 = function $$JSCompiler_prototypeAlias$$$bsf16$($old$$, $bit_base$$8$$) {
  this.flags_changed = 0;
  if (0 === $bit_base$$8$$) {
    return this.flags |= 64, $old$$;
  }
  this.flags &= -65;
  return Math.int_log2(-$bit_base$$8$$ & $bit_base$$8$$);
};
$JSCompiler_prototypeAlias$$.bsf32 = function $$JSCompiler_prototypeAlias$$$bsf32$($old$$1$$, $bit_base$$9$$) {
  this.flags_changed = 0;
  if (0 === $bit_base$$9$$) {
    return this.flags |= 64, $old$$1$$;
  }
  this.flags &= -65;
  return Math.int_log2((-$bit_base$$9$$ & $bit_base$$9$$) >>> 0);
};
$JSCompiler_prototypeAlias$$.bsr16 = function $$JSCompiler_prototypeAlias$$$bsr16$($old$$2$$, $bit_base$$10$$) {
  this.flags_changed = 0;
  if (0 === $bit_base$$10$$) {
    return this.flags |= 64, $old$$2$$;
  }
  this.flags &= -65;
  return Math.int_log2($bit_base$$10$$);
};
$JSCompiler_prototypeAlias$$.bsr32 = function $$JSCompiler_prototypeAlias$$$bsr32$($old$$3$$, $bit_base$$11$$) {
  this.flags_changed = 0;
  if (0 === $bit_base$$11$$) {
    return this.flags |= 64, $old$$3$$;
  }
  this.flags &= -65;
  return Math.int_log2($bit_base$$11$$ >>> 0);
};
"use strict";
"use strict";
var $table16$$ = [], $table32$$ = [], $table0F_16$$ = [], $table0F_32$$ = [];
$v86$$.prototype.table16 = $table16$$;
$v86$$.prototype.table32 = $table32$$;
$v86$$.prototype.table0F_16 = $table0F_16$$;
$v86$$.prototype.table0F_32 = $table0F_32$$;
$table16$$[0] = $table32$$[0] = function $$table32$$$0$($cpu$$331$$) {
  var $modrm_byte$$1$$ = $cpu$$331$$.read_imm8(), $data$$25_result$$23$$, $addr$$9$$;
  192 > $modrm_byte$$1$$ ? ($addr$$9$$ = $cpu$$331$$.translate_address_write($cpu$$331$$.modrm_resolve($modrm_byte$$1$$)), $data$$25_result$$23$$ = $cpu$$331$$.memory.read8($addr$$9$$)) : $data$$25_result$$23$$ = $cpu$$331$$.reg8[$modrm_byte$$1$$ << 2 & 12 | $modrm_byte$$1$$ >> 2 & 1];
  $data$$25_result$$23$$ = $cpu$$331$$.add($data$$25_result$$23$$, $cpu$$331$$.reg8[$modrm_byte$$1$$ >> 1 & 12 | $modrm_byte$$1$$ >> 5 & 1], 7);
  192 > $modrm_byte$$1$$ ? $cpu$$331$$.memory.write8($addr$$9$$, $data$$25_result$$23$$) : $cpu$$331$$.reg8[$modrm_byte$$1$$ << 2 & 12 | $modrm_byte$$1$$ >> 2 & 1] = $data$$25_result$$23$$;
};
$table16$$[1] = function $$table16$$$1$($cpu$$332$$) {
  var $modrm_byte$$2$$ = $cpu$$332$$.read_imm8(), $data$$26_result$$24_virt_addr$$4$$, $phys_addr$$3$$, $phys_addr_high$$ = 0;
  192 > $modrm_byte$$2$$ ? ($data$$26_result$$24_virt_addr$$4$$ = $cpu$$332$$.modrm_resolve($modrm_byte$$2$$), $phys_addr$$3$$ = $cpu$$332$$.translate_address_write($data$$26_result$$24_virt_addr$$4$$), $cpu$$332$$.paging && 4095 === ($data$$26_result$$24_virt_addr$$4$$ & 4095) ? ($phys_addr_high$$ = $cpu$$332$$.translate_address_write($data$$26_result$$24_virt_addr$$4$$ + 1), $data$$26_result$$24_virt_addr$$4$$ = $cpu$$332$$.virt_boundary_read16($phys_addr$$3$$, $phys_addr_high$$)) : $data$$26_result$$24_virt_addr$$4$$ = 
  $cpu$$332$$.memory.read16($phys_addr$$3$$)) : $data$$26_result$$24_virt_addr$$4$$ = $cpu$$332$$.reg16[$modrm_byte$$2$$ << 1 & 14];
  $data$$26_result$$24_virt_addr$$4$$ = $cpu$$332$$.add($data$$26_result$$24_virt_addr$$4$$, $cpu$$332$$.reg16[$modrm_byte$$2$$ >> 2 & 14], 15);
  192 > $modrm_byte$$2$$ ? $phys_addr_high$$ ? $cpu$$332$$.virt_boundary_write16($phys_addr$$3$$, $phys_addr_high$$, $data$$26_result$$24_virt_addr$$4$$) : $cpu$$332$$.memory.write16($phys_addr$$3$$, $data$$26_result$$24_virt_addr$$4$$) : $cpu$$332$$.reg16[$modrm_byte$$2$$ << 1 & 14] = $data$$26_result$$24_virt_addr$$4$$;
};
$table32$$[1] = function $$table32$$$1$($cpu$$333$$) {
  var $modrm_byte$$3$$ = $cpu$$333$$.read_imm8(), $data$$27_result$$25_virt_addr$$5$$, $phys_addr$$4$$, $phys_addr_high$$1$$ = 0;
  192 > $modrm_byte$$3$$ ? ($data$$27_result$$25_virt_addr$$5$$ = $cpu$$333$$.modrm_resolve($modrm_byte$$3$$), $phys_addr$$4$$ = $cpu$$333$$.translate_address_write($data$$27_result$$25_virt_addr$$5$$), $cpu$$333$$.paging && 4093 <= ($data$$27_result$$25_virt_addr$$5$$ & 4095) ? ($phys_addr_high$$1$$ = $cpu$$333$$.translate_address_write($data$$27_result$$25_virt_addr$$5$$ + 3), $data$$27_result$$25_virt_addr$$5$$ = $cpu$$333$$.virt_boundary_read32s($phys_addr$$4$$, $phys_addr_high$$1$$)) : $data$$27_result$$25_virt_addr$$5$$ = 
  $cpu$$333$$.memory.read32s($phys_addr$$4$$)) : $data$$27_result$$25_virt_addr$$5$$ = $cpu$$333$$.reg32s[$modrm_byte$$3$$ & 7];
  $data$$27_result$$25_virt_addr$$5$$ = $cpu$$333$$.add($data$$27_result$$25_virt_addr$$5$$, $cpu$$333$$.reg32s[$modrm_byte$$3$$ >> 3 & 7], 31);
  192 > $modrm_byte$$3$$ ? $phys_addr_high$$1$$ ? $cpu$$333$$.virt_boundary_write32($phys_addr$$4$$, $phys_addr_high$$1$$, $data$$27_result$$25_virt_addr$$5$$) : $cpu$$333$$.memory.write32($phys_addr$$4$$, $data$$27_result$$25_virt_addr$$5$$) : $cpu$$333$$.reg32s[$modrm_byte$$3$$ & 7] = $data$$27_result$$25_virt_addr$$5$$;
};
$table16$$[2] = $table32$$[2] = function $$table32$$$2$($cpu$$334$$) {
  var $modrm_byte$$4$$ = $cpu$$334$$.read_imm8(), $data$$28$$ = 192 > $modrm_byte$$4$$ ? $cpu$$334$$.safe_read8($cpu$$334$$.modrm_resolve($modrm_byte$$4$$)) : $cpu$$334$$.reg8[$modrm_byte$$4$$ << 2 & 12 | $modrm_byte$$4$$ >> 2 & 1];
  $cpu$$334$$.reg8[$modrm_byte$$4$$ >> 1 & 12 | $modrm_byte$$4$$ >> 5 & 1] = $cpu$$334$$.add($cpu$$334$$.reg8[$modrm_byte$$4$$ >> 1 & 12 | $modrm_byte$$4$$ >> 5 & 1], $data$$28$$, 7);
};
$table16$$[3] = function $$table16$$$3$($cpu$$335$$) {
  var $modrm_byte$$5$$ = $cpu$$335$$.read_imm8(), $data$$29$$ = 192 > $modrm_byte$$5$$ ? $cpu$$335$$.safe_read16($cpu$$335$$.modrm_resolve($modrm_byte$$5$$)) : $cpu$$335$$.reg16[$modrm_byte$$5$$ << 1 & 14];
  $cpu$$335$$.reg16[$modrm_byte$$5$$ >> 2 & 14] = $cpu$$335$$.add($cpu$$335$$.reg16[$modrm_byte$$5$$ >> 2 & 14], $data$$29$$, 15);
};
$table32$$[3] = function $$table32$$$3$($cpu$$336$$) {
  var $modrm_byte$$6$$ = $cpu$$336$$.read_imm8(), $data$$30$$ = 192 > $modrm_byte$$6$$ ? $cpu$$336$$.safe_read32s($cpu$$336$$.modrm_resolve($modrm_byte$$6$$)) : $cpu$$336$$.reg32s[$modrm_byte$$6$$ & 7];
  $cpu$$336$$.reg32s[$modrm_byte$$6$$ >> 3 & 7] = $cpu$$336$$.add($cpu$$336$$.reg32s[$modrm_byte$$6$$ >> 3 & 7], $data$$30$$, 31);
};
$table16$$[4] = $table32$$[4] = function $$table32$$$4$($cpu$$337$$) {
  $cpu$$337$$.reg8[0] = $cpu$$337$$.add($cpu$$337$$.reg8[0], $cpu$$337$$.read_imm8(), 7);
};
$table16$$[5] = function $$table16$$$5$($cpu$$338$$) {
  $cpu$$338$$.reg16[0] = $cpu$$338$$.add($cpu$$338$$.reg16[0], $cpu$$338$$.read_imm16(), 15);
};
$table32$$[5] = function $$table32$$$5$($cpu$$339$$) {
  $cpu$$339$$.reg32s[0] = $cpu$$339$$.add($cpu$$339$$.reg32s[0], $cpu$$339$$.read_imm32s(), 31);
};
$table16$$[6] = function $$table16$$$6$($cpu$$340$$) {
  $cpu$$340$$.push16($cpu$$340$$.sreg[0]);
};
$table32$$[6] = function $$table32$$$6$($cpu$$341$$) {
  $cpu$$341$$.push32($cpu$$341$$.sreg[0]);
};
$table16$$[7] = function $$table16$$$7$($cpu$$342$$) {
  $cpu$$342$$.switch_seg(0, $cpu$$342$$.safe_read16($cpu$$342$$.get_stack_pointer(0)));
  $cpu$$342$$.stack_reg[$cpu$$342$$.reg_vsp] += 2;
};
$table32$$[7] = function $$table32$$$7$($cpu$$343$$) {
  $cpu$$343$$.switch_seg(0, $cpu$$343$$.safe_read16($cpu$$343$$.get_stack_pointer(0)));
  $cpu$$343$$.stack_reg[$cpu$$343$$.reg_vsp] += 4;
};
$table16$$[8] = $table32$$[8] = function $$table32$$$8$($cpu$$344$$) {
  var $modrm_byte$$7$$ = $cpu$$344$$.read_imm8(), $data$$31_result$$26$$, $addr$$10$$;
  192 > $modrm_byte$$7$$ ? ($addr$$10$$ = $cpu$$344$$.translate_address_write($cpu$$344$$.modrm_resolve($modrm_byte$$7$$)), $data$$31_result$$26$$ = $cpu$$344$$.memory.read8($addr$$10$$)) : $data$$31_result$$26$$ = $cpu$$344$$.reg8[$modrm_byte$$7$$ << 2 & 12 | $modrm_byte$$7$$ >> 2 & 1];
  $data$$31_result$$26$$ = $cpu$$344$$.or($data$$31_result$$26$$, $cpu$$344$$.reg8[$modrm_byte$$7$$ >> 1 & 12 | $modrm_byte$$7$$ >> 5 & 1], 7);
  192 > $modrm_byte$$7$$ ? $cpu$$344$$.memory.write8($addr$$10$$, $data$$31_result$$26$$) : $cpu$$344$$.reg8[$modrm_byte$$7$$ << 2 & 12 | $modrm_byte$$7$$ >> 2 & 1] = $data$$31_result$$26$$;
};
$table16$$[9] = function $$table16$$$9$($cpu$$345$$) {
  var $modrm_byte$$8$$ = $cpu$$345$$.read_imm8(), $data$$32_result$$27_virt_addr$$6$$, $phys_addr$$5$$, $phys_addr_high$$2$$ = 0;
  192 > $modrm_byte$$8$$ ? ($data$$32_result$$27_virt_addr$$6$$ = $cpu$$345$$.modrm_resolve($modrm_byte$$8$$), $phys_addr$$5$$ = $cpu$$345$$.translate_address_write($data$$32_result$$27_virt_addr$$6$$), $cpu$$345$$.paging && 4095 === ($data$$32_result$$27_virt_addr$$6$$ & 4095) ? ($phys_addr_high$$2$$ = $cpu$$345$$.translate_address_write($data$$32_result$$27_virt_addr$$6$$ + 1), $data$$32_result$$27_virt_addr$$6$$ = $cpu$$345$$.virt_boundary_read16($phys_addr$$5$$, $phys_addr_high$$2$$)) : $data$$32_result$$27_virt_addr$$6$$ = 
  $cpu$$345$$.memory.read16($phys_addr$$5$$)) : $data$$32_result$$27_virt_addr$$6$$ = $cpu$$345$$.reg16[$modrm_byte$$8$$ << 1 & 14];
  $data$$32_result$$27_virt_addr$$6$$ = $cpu$$345$$.or($data$$32_result$$27_virt_addr$$6$$, $cpu$$345$$.reg16[$modrm_byte$$8$$ >> 2 & 14], 15);
  192 > $modrm_byte$$8$$ ? $phys_addr_high$$2$$ ? $cpu$$345$$.virt_boundary_write16($phys_addr$$5$$, $phys_addr_high$$2$$, $data$$32_result$$27_virt_addr$$6$$) : $cpu$$345$$.memory.write16($phys_addr$$5$$, $data$$32_result$$27_virt_addr$$6$$) : $cpu$$345$$.reg16[$modrm_byte$$8$$ << 1 & 14] = $data$$32_result$$27_virt_addr$$6$$;
};
$table32$$[9] = function $$table32$$$9$($cpu$$346$$) {
  var $modrm_byte$$9$$ = $cpu$$346$$.read_imm8(), $data$$33_result$$28_virt_addr$$7$$, $phys_addr$$6$$, $phys_addr_high$$3$$ = 0;
  192 > $modrm_byte$$9$$ ? ($data$$33_result$$28_virt_addr$$7$$ = $cpu$$346$$.modrm_resolve($modrm_byte$$9$$), $phys_addr$$6$$ = $cpu$$346$$.translate_address_write($data$$33_result$$28_virt_addr$$7$$), $cpu$$346$$.paging && 4093 <= ($data$$33_result$$28_virt_addr$$7$$ & 4095) ? ($phys_addr_high$$3$$ = $cpu$$346$$.translate_address_write($data$$33_result$$28_virt_addr$$7$$ + 3), $data$$33_result$$28_virt_addr$$7$$ = $cpu$$346$$.virt_boundary_read32s($phys_addr$$6$$, $phys_addr_high$$3$$)) : $data$$33_result$$28_virt_addr$$7$$ = 
  $cpu$$346$$.memory.read32s($phys_addr$$6$$)) : $data$$33_result$$28_virt_addr$$7$$ = $cpu$$346$$.reg32s[$modrm_byte$$9$$ & 7];
  $data$$33_result$$28_virt_addr$$7$$ = $cpu$$346$$.or($data$$33_result$$28_virt_addr$$7$$, $cpu$$346$$.reg32s[$modrm_byte$$9$$ >> 3 & 7], 31);
  192 > $modrm_byte$$9$$ ? $phys_addr_high$$3$$ ? $cpu$$346$$.virt_boundary_write32($phys_addr$$6$$, $phys_addr_high$$3$$, $data$$33_result$$28_virt_addr$$7$$) : $cpu$$346$$.memory.write32($phys_addr$$6$$, $data$$33_result$$28_virt_addr$$7$$) : $cpu$$346$$.reg32s[$modrm_byte$$9$$ & 7] = $data$$33_result$$28_virt_addr$$7$$;
};
$table16$$[10] = $table32$$[10] = function $$table32$$$10$($cpu$$347$$) {
  var $modrm_byte$$10$$ = $cpu$$347$$.read_imm8(), $data$$34$$ = 192 > $modrm_byte$$10$$ ? $cpu$$347$$.safe_read8($cpu$$347$$.modrm_resolve($modrm_byte$$10$$)) : $cpu$$347$$.reg8[$modrm_byte$$10$$ << 2 & 12 | $modrm_byte$$10$$ >> 2 & 1];
  $cpu$$347$$.reg8[$modrm_byte$$10$$ >> 1 & 12 | $modrm_byte$$10$$ >> 5 & 1] = $cpu$$347$$.or($cpu$$347$$.reg8[$modrm_byte$$10$$ >> 1 & 12 | $modrm_byte$$10$$ >> 5 & 1], $data$$34$$, 7);
};
$table16$$[11] = function $$table16$$$11$($cpu$$348$$) {
  var $modrm_byte$$11$$ = $cpu$$348$$.read_imm8(), $data$$35$$ = 192 > $modrm_byte$$11$$ ? $cpu$$348$$.safe_read16($cpu$$348$$.modrm_resolve($modrm_byte$$11$$)) : $cpu$$348$$.reg16[$modrm_byte$$11$$ << 1 & 14];
  $cpu$$348$$.reg16[$modrm_byte$$11$$ >> 2 & 14] = $cpu$$348$$.or($cpu$$348$$.reg16[$modrm_byte$$11$$ >> 2 & 14], $data$$35$$, 15);
};
$table32$$[11] = function $$table32$$$11$($cpu$$349$$) {
  var $modrm_byte$$12$$ = $cpu$$349$$.read_imm8(), $data$$36$$ = 192 > $modrm_byte$$12$$ ? $cpu$$349$$.safe_read32s($cpu$$349$$.modrm_resolve($modrm_byte$$12$$)) : $cpu$$349$$.reg32s[$modrm_byte$$12$$ & 7];
  $cpu$$349$$.reg32s[$modrm_byte$$12$$ >> 3 & 7] = $cpu$$349$$.or($cpu$$349$$.reg32s[$modrm_byte$$12$$ >> 3 & 7], $data$$36$$, 31);
};
$table16$$[12] = $table32$$[12] = function $$table32$$$12$($cpu$$350$$) {
  $cpu$$350$$.reg8[0] = $cpu$$350$$.or($cpu$$350$$.reg8[0], $cpu$$350$$.read_imm8(), 7);
};
$table16$$[13] = function $$table16$$$13$($cpu$$351$$) {
  $cpu$$351$$.reg16[0] = $cpu$$351$$.or($cpu$$351$$.reg16[0], $cpu$$351$$.read_imm16(), 15);
};
$table32$$[13] = function $$table32$$$13$($cpu$$352$$) {
  $cpu$$352$$.reg32s[0] = $cpu$$352$$.or($cpu$$352$$.reg32s[0], $cpu$$352$$.read_imm32s(), 31);
};
$table16$$[14] = function $$table16$$$14$($cpu$$353$$) {
  $cpu$$353$$.push16($cpu$$353$$.sreg[1]);
};
$table32$$[14] = function $$table32$$$14$($cpu$$354$$) {
  $cpu$$354$$.push32($cpu$$354$$.sreg[1]);
};
$table16$$[15] = $table32$$[15] = function $$table32$$$15$($cpu$$355$$) {
  $cpu$$355$$.table0F[$cpu$$355$$.read_imm8()]($cpu$$355$$);
};
$table16$$[16] = $table32$$[16] = function $$table32$$$16$($cpu$$356$$) {
  var $modrm_byte$$13$$ = $cpu$$356$$.read_imm8(), $data$$37_result$$29$$, $addr$$11$$;
  192 > $modrm_byte$$13$$ ? ($addr$$11$$ = $cpu$$356$$.translate_address_write($cpu$$356$$.modrm_resolve($modrm_byte$$13$$)), $data$$37_result$$29$$ = $cpu$$356$$.memory.read8($addr$$11$$)) : $data$$37_result$$29$$ = $cpu$$356$$.reg8[$modrm_byte$$13$$ << 2 & 12 | $modrm_byte$$13$$ >> 2 & 1];
  $data$$37_result$$29$$ = $cpu$$356$$.adc($data$$37_result$$29$$, $cpu$$356$$.reg8[$modrm_byte$$13$$ >> 1 & 12 | $modrm_byte$$13$$ >> 5 & 1], 7);
  192 > $modrm_byte$$13$$ ? $cpu$$356$$.memory.write8($addr$$11$$, $data$$37_result$$29$$) : $cpu$$356$$.reg8[$modrm_byte$$13$$ << 2 & 12 | $modrm_byte$$13$$ >> 2 & 1] = $data$$37_result$$29$$;
};
$table16$$[17] = function $$table16$$$17$($cpu$$357$$) {
  var $modrm_byte$$14$$ = $cpu$$357$$.read_imm8(), $data$$38_result$$30_virt_addr$$8$$, $phys_addr$$7$$, $phys_addr_high$$4$$ = 0;
  192 > $modrm_byte$$14$$ ? ($data$$38_result$$30_virt_addr$$8$$ = $cpu$$357$$.modrm_resolve($modrm_byte$$14$$), $phys_addr$$7$$ = $cpu$$357$$.translate_address_write($data$$38_result$$30_virt_addr$$8$$), $cpu$$357$$.paging && 4095 === ($data$$38_result$$30_virt_addr$$8$$ & 4095) ? ($phys_addr_high$$4$$ = $cpu$$357$$.translate_address_write($data$$38_result$$30_virt_addr$$8$$ + 1), $data$$38_result$$30_virt_addr$$8$$ = $cpu$$357$$.virt_boundary_read16($phys_addr$$7$$, $phys_addr_high$$4$$)) : $data$$38_result$$30_virt_addr$$8$$ = 
  $cpu$$357$$.memory.read16($phys_addr$$7$$)) : $data$$38_result$$30_virt_addr$$8$$ = $cpu$$357$$.reg16[$modrm_byte$$14$$ << 1 & 14];
  $data$$38_result$$30_virt_addr$$8$$ = $cpu$$357$$.adc($data$$38_result$$30_virt_addr$$8$$, $cpu$$357$$.reg16[$modrm_byte$$14$$ >> 2 & 14], 15);
  192 > $modrm_byte$$14$$ ? $phys_addr_high$$4$$ ? $cpu$$357$$.virt_boundary_write16($phys_addr$$7$$, $phys_addr_high$$4$$, $data$$38_result$$30_virt_addr$$8$$) : $cpu$$357$$.memory.write16($phys_addr$$7$$, $data$$38_result$$30_virt_addr$$8$$) : $cpu$$357$$.reg16[$modrm_byte$$14$$ << 1 & 14] = $data$$38_result$$30_virt_addr$$8$$;
};
$table32$$[17] = function $$table32$$$17$($cpu$$358$$) {
  var $modrm_byte$$15$$ = $cpu$$358$$.read_imm8(), $data$$39_result$$31_virt_addr$$9$$, $phys_addr$$8$$, $phys_addr_high$$5$$ = 0;
  192 > $modrm_byte$$15$$ ? ($data$$39_result$$31_virt_addr$$9$$ = $cpu$$358$$.modrm_resolve($modrm_byte$$15$$), $phys_addr$$8$$ = $cpu$$358$$.translate_address_write($data$$39_result$$31_virt_addr$$9$$), $cpu$$358$$.paging && 4093 <= ($data$$39_result$$31_virt_addr$$9$$ & 4095) ? ($phys_addr_high$$5$$ = $cpu$$358$$.translate_address_write($data$$39_result$$31_virt_addr$$9$$ + 3), $data$$39_result$$31_virt_addr$$9$$ = $cpu$$358$$.virt_boundary_read32s($phys_addr$$8$$, $phys_addr_high$$5$$)) : $data$$39_result$$31_virt_addr$$9$$ = 
  $cpu$$358$$.memory.read32s($phys_addr$$8$$)) : $data$$39_result$$31_virt_addr$$9$$ = $cpu$$358$$.reg32s[$modrm_byte$$15$$ & 7];
  $data$$39_result$$31_virt_addr$$9$$ = $cpu$$358$$.adc($data$$39_result$$31_virt_addr$$9$$, $cpu$$358$$.reg32s[$modrm_byte$$15$$ >> 3 & 7], 31);
  192 > $modrm_byte$$15$$ ? $phys_addr_high$$5$$ ? $cpu$$358$$.virt_boundary_write32($phys_addr$$8$$, $phys_addr_high$$5$$, $data$$39_result$$31_virt_addr$$9$$) : $cpu$$358$$.memory.write32($phys_addr$$8$$, $data$$39_result$$31_virt_addr$$9$$) : $cpu$$358$$.reg32s[$modrm_byte$$15$$ & 7] = $data$$39_result$$31_virt_addr$$9$$;
};
$table16$$[18] = $table32$$[18] = function $$table32$$$18$($cpu$$359$$) {
  var $modrm_byte$$16$$ = $cpu$$359$$.read_imm8(), $data$$40$$ = 192 > $modrm_byte$$16$$ ? $cpu$$359$$.safe_read8($cpu$$359$$.modrm_resolve($modrm_byte$$16$$)) : $cpu$$359$$.reg8[$modrm_byte$$16$$ << 2 & 12 | $modrm_byte$$16$$ >> 2 & 1];
  $cpu$$359$$.reg8[$modrm_byte$$16$$ >> 1 & 12 | $modrm_byte$$16$$ >> 5 & 1] = $cpu$$359$$.adc($cpu$$359$$.reg8[$modrm_byte$$16$$ >> 1 & 12 | $modrm_byte$$16$$ >> 5 & 1], $data$$40$$, 7);
};
$table16$$[19] = function $$table16$$$19$($cpu$$360$$) {
  var $modrm_byte$$17$$ = $cpu$$360$$.read_imm8(), $data$$41$$ = 192 > $modrm_byte$$17$$ ? $cpu$$360$$.safe_read16($cpu$$360$$.modrm_resolve($modrm_byte$$17$$)) : $cpu$$360$$.reg16[$modrm_byte$$17$$ << 1 & 14];
  $cpu$$360$$.reg16[$modrm_byte$$17$$ >> 2 & 14] = $cpu$$360$$.adc($cpu$$360$$.reg16[$modrm_byte$$17$$ >> 2 & 14], $data$$41$$, 15);
};
$table32$$[19] = function $$table32$$$19$($cpu$$361$$) {
  var $modrm_byte$$18$$ = $cpu$$361$$.read_imm8(), $data$$42$$ = 192 > $modrm_byte$$18$$ ? $cpu$$361$$.safe_read32s($cpu$$361$$.modrm_resolve($modrm_byte$$18$$)) : $cpu$$361$$.reg32s[$modrm_byte$$18$$ & 7];
  $cpu$$361$$.reg32s[$modrm_byte$$18$$ >> 3 & 7] = $cpu$$361$$.adc($cpu$$361$$.reg32s[$modrm_byte$$18$$ >> 3 & 7], $data$$42$$, 31);
};
$table16$$[20] = $table32$$[20] = function $$table32$$$20$($cpu$$362$$) {
  $cpu$$362$$.reg8[0] = $cpu$$362$$.adc($cpu$$362$$.reg8[0], $cpu$$362$$.read_imm8(), 7);
};
$table16$$[21] = function $$table16$$$21$($cpu$$363$$) {
  $cpu$$363$$.reg16[0] = $cpu$$363$$.adc($cpu$$363$$.reg16[0], $cpu$$363$$.read_imm16(), 15);
};
$table32$$[21] = function $$table32$$$21$($cpu$$364$$) {
  $cpu$$364$$.reg32s[0] = $cpu$$364$$.adc($cpu$$364$$.reg32s[0], $cpu$$364$$.read_imm32s(), 31);
};
$table16$$[22] = function $$table16$$$22$($cpu$$365$$) {
  $cpu$$365$$.push16($cpu$$365$$.sreg[2]);
};
$table32$$[22] = function $$table32$$$22$($cpu$$366$$) {
  $cpu$$366$$.push32($cpu$$366$$.sreg[2]);
};
$table16$$[23] = function $$table16$$$23$($cpu$$367$$) {
  $cpu$$367$$.switch_seg(2, $cpu$$367$$.safe_read16($cpu$$367$$.get_stack_pointer(0)));
  $cpu$$367$$.stack_reg[$cpu$$367$$.reg_vsp] += 2;
};
$table32$$[23] = function $$table32$$$23$($cpu$$368$$) {
  $cpu$$368$$.switch_seg(2, $cpu$$368$$.safe_read16($cpu$$368$$.get_stack_pointer(0)));
  $cpu$$368$$.stack_reg[$cpu$$368$$.reg_vsp] += 4;
};
$table16$$[24] = $table32$$[24] = function $$table32$$$24$($cpu$$369$$) {
  var $modrm_byte$$19$$ = $cpu$$369$$.read_imm8(), $data$$43_result$$32$$, $addr$$12$$;
  192 > $modrm_byte$$19$$ ? ($addr$$12$$ = $cpu$$369$$.translate_address_write($cpu$$369$$.modrm_resolve($modrm_byte$$19$$)), $data$$43_result$$32$$ = $cpu$$369$$.memory.read8($addr$$12$$)) : $data$$43_result$$32$$ = $cpu$$369$$.reg8[$modrm_byte$$19$$ << 2 & 12 | $modrm_byte$$19$$ >> 2 & 1];
  $data$$43_result$$32$$ = $cpu$$369$$.sbb($data$$43_result$$32$$, $cpu$$369$$.reg8[$modrm_byte$$19$$ >> 1 & 12 | $modrm_byte$$19$$ >> 5 & 1], 7);
  192 > $modrm_byte$$19$$ ? $cpu$$369$$.memory.write8($addr$$12$$, $data$$43_result$$32$$) : $cpu$$369$$.reg8[$modrm_byte$$19$$ << 2 & 12 | $modrm_byte$$19$$ >> 2 & 1] = $data$$43_result$$32$$;
};
$table16$$[25] = function $$table16$$$25$($cpu$$370$$) {
  var $modrm_byte$$20$$ = $cpu$$370$$.read_imm8(), $data$$44_result$$33_virt_addr$$10$$, $phys_addr$$9$$, $phys_addr_high$$6$$ = 0;
  192 > $modrm_byte$$20$$ ? ($data$$44_result$$33_virt_addr$$10$$ = $cpu$$370$$.modrm_resolve($modrm_byte$$20$$), $phys_addr$$9$$ = $cpu$$370$$.translate_address_write($data$$44_result$$33_virt_addr$$10$$), $cpu$$370$$.paging && 4095 === ($data$$44_result$$33_virt_addr$$10$$ & 4095) ? ($phys_addr_high$$6$$ = $cpu$$370$$.translate_address_write($data$$44_result$$33_virt_addr$$10$$ + 1), $data$$44_result$$33_virt_addr$$10$$ = $cpu$$370$$.virt_boundary_read16($phys_addr$$9$$, $phys_addr_high$$6$$)) : 
  $data$$44_result$$33_virt_addr$$10$$ = $cpu$$370$$.memory.read16($phys_addr$$9$$)) : $data$$44_result$$33_virt_addr$$10$$ = $cpu$$370$$.reg16[$modrm_byte$$20$$ << 1 & 14];
  $data$$44_result$$33_virt_addr$$10$$ = $cpu$$370$$.sbb($data$$44_result$$33_virt_addr$$10$$, $cpu$$370$$.reg16[$modrm_byte$$20$$ >> 2 & 14], 15);
  192 > $modrm_byte$$20$$ ? $phys_addr_high$$6$$ ? $cpu$$370$$.virt_boundary_write16($phys_addr$$9$$, $phys_addr_high$$6$$, $data$$44_result$$33_virt_addr$$10$$) : $cpu$$370$$.memory.write16($phys_addr$$9$$, $data$$44_result$$33_virt_addr$$10$$) : $cpu$$370$$.reg16[$modrm_byte$$20$$ << 1 & 14] = $data$$44_result$$33_virt_addr$$10$$;
};
$table32$$[25] = function $$table32$$$25$($cpu$$371$$) {
  var $modrm_byte$$21$$ = $cpu$$371$$.read_imm8(), $data$$45_result$$34_virt_addr$$11$$, $phys_addr$$10$$, $phys_addr_high$$7$$ = 0;
  192 > $modrm_byte$$21$$ ? ($data$$45_result$$34_virt_addr$$11$$ = $cpu$$371$$.modrm_resolve($modrm_byte$$21$$), $phys_addr$$10$$ = $cpu$$371$$.translate_address_write($data$$45_result$$34_virt_addr$$11$$), $cpu$$371$$.paging && 4093 <= ($data$$45_result$$34_virt_addr$$11$$ & 4095) ? ($phys_addr_high$$7$$ = $cpu$$371$$.translate_address_write($data$$45_result$$34_virt_addr$$11$$ + 3), $data$$45_result$$34_virt_addr$$11$$ = $cpu$$371$$.virt_boundary_read32s($phys_addr$$10$$, $phys_addr_high$$7$$)) : 
  $data$$45_result$$34_virt_addr$$11$$ = $cpu$$371$$.memory.read32s($phys_addr$$10$$)) : $data$$45_result$$34_virt_addr$$11$$ = $cpu$$371$$.reg32s[$modrm_byte$$21$$ & 7];
  $data$$45_result$$34_virt_addr$$11$$ = $cpu$$371$$.sbb($data$$45_result$$34_virt_addr$$11$$, $cpu$$371$$.reg32s[$modrm_byte$$21$$ >> 3 & 7], 31);
  192 > $modrm_byte$$21$$ ? $phys_addr_high$$7$$ ? $cpu$$371$$.virt_boundary_write32($phys_addr$$10$$, $phys_addr_high$$7$$, $data$$45_result$$34_virt_addr$$11$$) : $cpu$$371$$.memory.write32($phys_addr$$10$$, $data$$45_result$$34_virt_addr$$11$$) : $cpu$$371$$.reg32s[$modrm_byte$$21$$ & 7] = $data$$45_result$$34_virt_addr$$11$$;
};
$table16$$[26] = $table32$$[26] = function $$table32$$$26$($cpu$$372$$) {
  var $modrm_byte$$22$$ = $cpu$$372$$.read_imm8(), $data$$46$$ = 192 > $modrm_byte$$22$$ ? $cpu$$372$$.safe_read8($cpu$$372$$.modrm_resolve($modrm_byte$$22$$)) : $cpu$$372$$.reg8[$modrm_byte$$22$$ << 2 & 12 | $modrm_byte$$22$$ >> 2 & 1];
  $cpu$$372$$.reg8[$modrm_byte$$22$$ >> 1 & 12 | $modrm_byte$$22$$ >> 5 & 1] = $cpu$$372$$.sbb($cpu$$372$$.reg8[$modrm_byte$$22$$ >> 1 & 12 | $modrm_byte$$22$$ >> 5 & 1], $data$$46$$, 7);
};
$table16$$[27] = function $$table16$$$27$($cpu$$373$$) {
  var $modrm_byte$$23$$ = $cpu$$373$$.read_imm8(), $data$$47$$ = 192 > $modrm_byte$$23$$ ? $cpu$$373$$.safe_read16($cpu$$373$$.modrm_resolve($modrm_byte$$23$$)) : $cpu$$373$$.reg16[$modrm_byte$$23$$ << 1 & 14];
  $cpu$$373$$.reg16[$modrm_byte$$23$$ >> 2 & 14] = $cpu$$373$$.sbb($cpu$$373$$.reg16[$modrm_byte$$23$$ >> 2 & 14], $data$$47$$, 15);
};
$table32$$[27] = function $$table32$$$27$($cpu$$374$$) {
  var $modrm_byte$$24$$ = $cpu$$374$$.read_imm8(), $data$$48$$ = 192 > $modrm_byte$$24$$ ? $cpu$$374$$.safe_read32s($cpu$$374$$.modrm_resolve($modrm_byte$$24$$)) : $cpu$$374$$.reg32s[$modrm_byte$$24$$ & 7];
  $cpu$$374$$.reg32s[$modrm_byte$$24$$ >> 3 & 7] = $cpu$$374$$.sbb($cpu$$374$$.reg32s[$modrm_byte$$24$$ >> 3 & 7], $data$$48$$, 31);
};
$table16$$[28] = $table32$$[28] = function $$table32$$$28$($cpu$$375$$) {
  $cpu$$375$$.reg8[0] = $cpu$$375$$.sbb($cpu$$375$$.reg8[0], $cpu$$375$$.read_imm8(), 7);
};
$table16$$[29] = function $$table16$$$29$($cpu$$376$$) {
  $cpu$$376$$.reg16[0] = $cpu$$376$$.sbb($cpu$$376$$.reg16[0], $cpu$$376$$.read_imm16(), 15);
};
$table32$$[29] = function $$table32$$$29$($cpu$$377$$) {
  $cpu$$377$$.reg32s[0] = $cpu$$377$$.sbb($cpu$$377$$.reg32s[0], $cpu$$377$$.read_imm32s(), 31);
};
$table16$$[30] = function $$table16$$$30$($cpu$$378$$) {
  $cpu$$378$$.push16($cpu$$378$$.sreg[3]);
};
$table32$$[30] = function $$table32$$$30$($cpu$$379$$) {
  $cpu$$379$$.push32($cpu$$379$$.sreg[3]);
};
$table16$$[31] = function $$table16$$$31$($cpu$$380$$) {
  $cpu$$380$$.switch_seg(3, $cpu$$380$$.safe_read16($cpu$$380$$.get_stack_pointer(0)));
  $cpu$$380$$.stack_reg[$cpu$$380$$.reg_vsp] += 2;
};
$table32$$[31] = function $$table32$$$31$($cpu$$381$$) {
  $cpu$$381$$.switch_seg(3, $cpu$$381$$.safe_read16($cpu$$381$$.get_stack_pointer(0)));
  $cpu$$381$$.stack_reg[$cpu$$381$$.reg_vsp] += 4;
};
$table16$$[32] = $table32$$[32] = function $$table32$$$32$($cpu$$382$$) {
  var $modrm_byte$$25$$ = $cpu$$382$$.read_imm8(), $data$$49_result$$35$$, $addr$$13$$;
  192 > $modrm_byte$$25$$ ? ($addr$$13$$ = $cpu$$382$$.translate_address_write($cpu$$382$$.modrm_resolve($modrm_byte$$25$$)), $data$$49_result$$35$$ = $cpu$$382$$.memory.read8($addr$$13$$)) : $data$$49_result$$35$$ = $cpu$$382$$.reg8[$modrm_byte$$25$$ << 2 & 12 | $modrm_byte$$25$$ >> 2 & 1];
  $data$$49_result$$35$$ = $cpu$$382$$.and($data$$49_result$$35$$, $cpu$$382$$.reg8[$modrm_byte$$25$$ >> 1 & 12 | $modrm_byte$$25$$ >> 5 & 1], 7);
  192 > $modrm_byte$$25$$ ? $cpu$$382$$.memory.write8($addr$$13$$, $data$$49_result$$35$$) : $cpu$$382$$.reg8[$modrm_byte$$25$$ << 2 & 12 | $modrm_byte$$25$$ >> 2 & 1] = $data$$49_result$$35$$;
};
$table16$$[33] = function $$table16$$$33$($cpu$$383$$) {
  var $modrm_byte$$26$$ = $cpu$$383$$.read_imm8(), $data$$50_result$$36_virt_addr$$12$$, $phys_addr$$11$$, $phys_addr_high$$8$$ = 0;
  192 > $modrm_byte$$26$$ ? ($data$$50_result$$36_virt_addr$$12$$ = $cpu$$383$$.modrm_resolve($modrm_byte$$26$$), $phys_addr$$11$$ = $cpu$$383$$.translate_address_write($data$$50_result$$36_virt_addr$$12$$), $cpu$$383$$.paging && 4095 === ($data$$50_result$$36_virt_addr$$12$$ & 4095) ? ($phys_addr_high$$8$$ = $cpu$$383$$.translate_address_write($data$$50_result$$36_virt_addr$$12$$ + 1), $data$$50_result$$36_virt_addr$$12$$ = $cpu$$383$$.virt_boundary_read16($phys_addr$$11$$, $phys_addr_high$$8$$)) : 
  $data$$50_result$$36_virt_addr$$12$$ = $cpu$$383$$.memory.read16($phys_addr$$11$$)) : $data$$50_result$$36_virt_addr$$12$$ = $cpu$$383$$.reg16[$modrm_byte$$26$$ << 1 & 14];
  $data$$50_result$$36_virt_addr$$12$$ = $cpu$$383$$.and($data$$50_result$$36_virt_addr$$12$$, $cpu$$383$$.reg16[$modrm_byte$$26$$ >> 2 & 14], 15);
  192 > $modrm_byte$$26$$ ? $phys_addr_high$$8$$ ? $cpu$$383$$.virt_boundary_write16($phys_addr$$11$$, $phys_addr_high$$8$$, $data$$50_result$$36_virt_addr$$12$$) : $cpu$$383$$.memory.write16($phys_addr$$11$$, $data$$50_result$$36_virt_addr$$12$$) : $cpu$$383$$.reg16[$modrm_byte$$26$$ << 1 & 14] = $data$$50_result$$36_virt_addr$$12$$;
};
$table32$$[33] = function $$table32$$$33$($cpu$$384$$) {
  var $modrm_byte$$27$$ = $cpu$$384$$.read_imm8(), $data$$51_result$$37_virt_addr$$13$$, $phys_addr$$12$$, $phys_addr_high$$9$$ = 0;
  192 > $modrm_byte$$27$$ ? ($data$$51_result$$37_virt_addr$$13$$ = $cpu$$384$$.modrm_resolve($modrm_byte$$27$$), $phys_addr$$12$$ = $cpu$$384$$.translate_address_write($data$$51_result$$37_virt_addr$$13$$), $cpu$$384$$.paging && 4093 <= ($data$$51_result$$37_virt_addr$$13$$ & 4095) ? ($phys_addr_high$$9$$ = $cpu$$384$$.translate_address_write($data$$51_result$$37_virt_addr$$13$$ + 3), $data$$51_result$$37_virt_addr$$13$$ = $cpu$$384$$.virt_boundary_read32s($phys_addr$$12$$, $phys_addr_high$$9$$)) : 
  $data$$51_result$$37_virt_addr$$13$$ = $cpu$$384$$.memory.read32s($phys_addr$$12$$)) : $data$$51_result$$37_virt_addr$$13$$ = $cpu$$384$$.reg32s[$modrm_byte$$27$$ & 7];
  $data$$51_result$$37_virt_addr$$13$$ = $cpu$$384$$.and($data$$51_result$$37_virt_addr$$13$$, $cpu$$384$$.reg32s[$modrm_byte$$27$$ >> 3 & 7], 31);
  192 > $modrm_byte$$27$$ ? $phys_addr_high$$9$$ ? $cpu$$384$$.virt_boundary_write32($phys_addr$$12$$, $phys_addr_high$$9$$, $data$$51_result$$37_virt_addr$$13$$) : $cpu$$384$$.memory.write32($phys_addr$$12$$, $data$$51_result$$37_virt_addr$$13$$) : $cpu$$384$$.reg32s[$modrm_byte$$27$$ & 7] = $data$$51_result$$37_virt_addr$$13$$;
};
$table16$$[34] = $table32$$[34] = function $$table32$$$34$($cpu$$385$$) {
  var $modrm_byte$$28$$ = $cpu$$385$$.read_imm8(), $data$$52$$ = 192 > $modrm_byte$$28$$ ? $cpu$$385$$.safe_read8($cpu$$385$$.modrm_resolve($modrm_byte$$28$$)) : $cpu$$385$$.reg8[$modrm_byte$$28$$ << 2 & 12 | $modrm_byte$$28$$ >> 2 & 1];
  $cpu$$385$$.reg8[$modrm_byte$$28$$ >> 1 & 12 | $modrm_byte$$28$$ >> 5 & 1] = $cpu$$385$$.and($cpu$$385$$.reg8[$modrm_byte$$28$$ >> 1 & 12 | $modrm_byte$$28$$ >> 5 & 1], $data$$52$$, 7);
};
$table16$$[35] = function $$table16$$$35$($cpu$$386$$) {
  var $modrm_byte$$29$$ = $cpu$$386$$.read_imm8(), $data$$53$$ = 192 > $modrm_byte$$29$$ ? $cpu$$386$$.safe_read16($cpu$$386$$.modrm_resolve($modrm_byte$$29$$)) : $cpu$$386$$.reg16[$modrm_byte$$29$$ << 1 & 14];
  $cpu$$386$$.reg16[$modrm_byte$$29$$ >> 2 & 14] = $cpu$$386$$.and($cpu$$386$$.reg16[$modrm_byte$$29$$ >> 2 & 14], $data$$53$$, 15);
};
$table32$$[35] = function $$table32$$$35$($cpu$$387$$) {
  var $modrm_byte$$30$$ = $cpu$$387$$.read_imm8(), $data$$54$$ = 192 > $modrm_byte$$30$$ ? $cpu$$387$$.safe_read32s($cpu$$387$$.modrm_resolve($modrm_byte$$30$$)) : $cpu$$387$$.reg32s[$modrm_byte$$30$$ & 7];
  $cpu$$387$$.reg32s[$modrm_byte$$30$$ >> 3 & 7] = $cpu$$387$$.and($cpu$$387$$.reg32s[$modrm_byte$$30$$ >> 3 & 7], $data$$54$$, 31);
};
$table16$$[36] = $table32$$[36] = function $$table32$$$36$($cpu$$388$$) {
  $cpu$$388$$.reg8[0] = $cpu$$388$$.and($cpu$$388$$.reg8[0], $cpu$$388$$.read_imm8(), 7);
};
$table16$$[37] = function $$table16$$$37$($cpu$$389$$) {
  $cpu$$389$$.reg16[0] = $cpu$$389$$.and($cpu$$389$$.reg16[0], $cpu$$389$$.read_imm16(), 15);
};
$table32$$[37] = function $$table32$$$37$($cpu$$390$$) {
  $cpu$$390$$.reg32s[0] = $cpu$$390$$.and($cpu$$390$$.reg32s[0], $cpu$$390$$.read_imm32s(), 31);
};
$table16$$[38] = $table32$$[38] = function $$table32$$$38$($cpu$$391$$) {
  $cpu$$391$$.seg_prefix(0);
};
$table16$$[39] = $table32$$[39] = function $$table32$$$39$($cpu$$392$$) {
  $cpu$$392$$.bcd_daa();
};
$table16$$[40] = $table32$$[40] = function $$table32$$$40$($cpu$$393$$) {
  var $modrm_byte$$31$$ = $cpu$$393$$.read_imm8(), $data$$55_result$$38$$, $addr$$14$$;
  192 > $modrm_byte$$31$$ ? ($addr$$14$$ = $cpu$$393$$.translate_address_write($cpu$$393$$.modrm_resolve($modrm_byte$$31$$)), $data$$55_result$$38$$ = $cpu$$393$$.memory.read8($addr$$14$$)) : $data$$55_result$$38$$ = $cpu$$393$$.reg8[$modrm_byte$$31$$ << 2 & 12 | $modrm_byte$$31$$ >> 2 & 1];
  $data$$55_result$$38$$ = $cpu$$393$$.sub($data$$55_result$$38$$, $cpu$$393$$.reg8[$modrm_byte$$31$$ >> 1 & 12 | $modrm_byte$$31$$ >> 5 & 1], 7);
  192 > $modrm_byte$$31$$ ? $cpu$$393$$.memory.write8($addr$$14$$, $data$$55_result$$38$$) : $cpu$$393$$.reg8[$modrm_byte$$31$$ << 2 & 12 | $modrm_byte$$31$$ >> 2 & 1] = $data$$55_result$$38$$;
};
$table16$$[41] = function $$table16$$$41$($cpu$$394$$) {
  var $modrm_byte$$32$$ = $cpu$$394$$.read_imm8(), $data$$56_result$$39_virt_addr$$14$$, $phys_addr$$13$$, $phys_addr_high$$10$$ = 0;
  192 > $modrm_byte$$32$$ ? ($data$$56_result$$39_virt_addr$$14$$ = $cpu$$394$$.modrm_resolve($modrm_byte$$32$$), $phys_addr$$13$$ = $cpu$$394$$.translate_address_write($data$$56_result$$39_virt_addr$$14$$), $cpu$$394$$.paging && 4095 === ($data$$56_result$$39_virt_addr$$14$$ & 4095) ? ($phys_addr_high$$10$$ = $cpu$$394$$.translate_address_write($data$$56_result$$39_virt_addr$$14$$ + 1), $data$$56_result$$39_virt_addr$$14$$ = $cpu$$394$$.virt_boundary_read16($phys_addr$$13$$, $phys_addr_high$$10$$)) : 
  $data$$56_result$$39_virt_addr$$14$$ = $cpu$$394$$.memory.read16($phys_addr$$13$$)) : $data$$56_result$$39_virt_addr$$14$$ = $cpu$$394$$.reg16[$modrm_byte$$32$$ << 1 & 14];
  $data$$56_result$$39_virt_addr$$14$$ = $cpu$$394$$.sub($data$$56_result$$39_virt_addr$$14$$, $cpu$$394$$.reg16[$modrm_byte$$32$$ >> 2 & 14], 15);
  192 > $modrm_byte$$32$$ ? $phys_addr_high$$10$$ ? $cpu$$394$$.virt_boundary_write16($phys_addr$$13$$, $phys_addr_high$$10$$, $data$$56_result$$39_virt_addr$$14$$) : $cpu$$394$$.memory.write16($phys_addr$$13$$, $data$$56_result$$39_virt_addr$$14$$) : $cpu$$394$$.reg16[$modrm_byte$$32$$ << 1 & 14] = $data$$56_result$$39_virt_addr$$14$$;
};
$table32$$[41] = function $$table32$$$41$($cpu$$395$$) {
  var $modrm_byte$$33$$ = $cpu$$395$$.read_imm8(), $data$$57_result$$40_virt_addr$$15$$, $phys_addr$$14$$, $phys_addr_high$$11$$ = 0;
  192 > $modrm_byte$$33$$ ? ($data$$57_result$$40_virt_addr$$15$$ = $cpu$$395$$.modrm_resolve($modrm_byte$$33$$), $phys_addr$$14$$ = $cpu$$395$$.translate_address_write($data$$57_result$$40_virt_addr$$15$$), $cpu$$395$$.paging && 4093 <= ($data$$57_result$$40_virt_addr$$15$$ & 4095) ? ($phys_addr_high$$11$$ = $cpu$$395$$.translate_address_write($data$$57_result$$40_virt_addr$$15$$ + 3), $data$$57_result$$40_virt_addr$$15$$ = $cpu$$395$$.virt_boundary_read32s($phys_addr$$14$$, $phys_addr_high$$11$$)) : 
  $data$$57_result$$40_virt_addr$$15$$ = $cpu$$395$$.memory.read32s($phys_addr$$14$$)) : $data$$57_result$$40_virt_addr$$15$$ = $cpu$$395$$.reg32s[$modrm_byte$$33$$ & 7];
  $data$$57_result$$40_virt_addr$$15$$ = $cpu$$395$$.sub($data$$57_result$$40_virt_addr$$15$$, $cpu$$395$$.reg32s[$modrm_byte$$33$$ >> 3 & 7], 31);
  192 > $modrm_byte$$33$$ ? $phys_addr_high$$11$$ ? $cpu$$395$$.virt_boundary_write32($phys_addr$$14$$, $phys_addr_high$$11$$, $data$$57_result$$40_virt_addr$$15$$) : $cpu$$395$$.memory.write32($phys_addr$$14$$, $data$$57_result$$40_virt_addr$$15$$) : $cpu$$395$$.reg32s[$modrm_byte$$33$$ & 7] = $data$$57_result$$40_virt_addr$$15$$;
};
$table16$$[42] = $table32$$[42] = function $$table32$$$42$($cpu$$396$$) {
  var $modrm_byte$$34$$ = $cpu$$396$$.read_imm8(), $data$$58$$ = 192 > $modrm_byte$$34$$ ? $cpu$$396$$.safe_read8($cpu$$396$$.modrm_resolve($modrm_byte$$34$$)) : $cpu$$396$$.reg8[$modrm_byte$$34$$ << 2 & 12 | $modrm_byte$$34$$ >> 2 & 1];
  $cpu$$396$$.reg8[$modrm_byte$$34$$ >> 1 & 12 | $modrm_byte$$34$$ >> 5 & 1] = $cpu$$396$$.sub($cpu$$396$$.reg8[$modrm_byte$$34$$ >> 1 & 12 | $modrm_byte$$34$$ >> 5 & 1], $data$$58$$, 7);
};
$table16$$[43] = function $$table16$$$43$($cpu$$397$$) {
  var $modrm_byte$$35$$ = $cpu$$397$$.read_imm8(), $data$$59$$ = 192 > $modrm_byte$$35$$ ? $cpu$$397$$.safe_read16($cpu$$397$$.modrm_resolve($modrm_byte$$35$$)) : $cpu$$397$$.reg16[$modrm_byte$$35$$ << 1 & 14];
  $cpu$$397$$.reg16[$modrm_byte$$35$$ >> 2 & 14] = $cpu$$397$$.sub($cpu$$397$$.reg16[$modrm_byte$$35$$ >> 2 & 14], $data$$59$$, 15);
};
$table32$$[43] = function $$table32$$$43$($cpu$$398$$) {
  var $modrm_byte$$36$$ = $cpu$$398$$.read_imm8(), $data$$60$$ = 192 > $modrm_byte$$36$$ ? $cpu$$398$$.safe_read32s($cpu$$398$$.modrm_resolve($modrm_byte$$36$$)) : $cpu$$398$$.reg32s[$modrm_byte$$36$$ & 7];
  $cpu$$398$$.reg32s[$modrm_byte$$36$$ >> 3 & 7] = $cpu$$398$$.sub($cpu$$398$$.reg32s[$modrm_byte$$36$$ >> 3 & 7], $data$$60$$, 31);
};
$table16$$[44] = $table32$$[44] = function $$table32$$$44$($cpu$$399$$) {
  $cpu$$399$$.reg8[0] = $cpu$$399$$.sub($cpu$$399$$.reg8[0], $cpu$$399$$.read_imm8(), 7);
};
$table16$$[45] = function $$table16$$$45$($cpu$$400$$) {
  $cpu$$400$$.reg16[0] = $cpu$$400$$.sub($cpu$$400$$.reg16[0], $cpu$$400$$.read_imm16(), 15);
};
$table32$$[45] = function $$table32$$$45$($cpu$$401$$) {
  $cpu$$401$$.reg32s[0] = $cpu$$401$$.sub($cpu$$401$$.reg32s[0], $cpu$$401$$.read_imm32s(), 31);
};
$table16$$[46] = $table32$$[46] = function $$table32$$$46$($cpu$$402$$) {
  $cpu$$402$$.seg_prefix(1);
};
$table16$$[47] = $table32$$[47] = function $$table32$$$47$($cpu$$403$$) {
  $cpu$$403$$.bcd_das();
};
$table16$$[48] = $table32$$[48] = function $$table32$$$48$($cpu$$404$$) {
  var $modrm_byte$$37$$ = $cpu$$404$$.read_imm8(), $data$$61_result$$41$$, $addr$$15$$;
  192 > $modrm_byte$$37$$ ? ($addr$$15$$ = $cpu$$404$$.translate_address_write($cpu$$404$$.modrm_resolve($modrm_byte$$37$$)), $data$$61_result$$41$$ = $cpu$$404$$.memory.read8($addr$$15$$)) : $data$$61_result$$41$$ = $cpu$$404$$.reg8[$modrm_byte$$37$$ << 2 & 12 | $modrm_byte$$37$$ >> 2 & 1];
  $data$$61_result$$41$$ = $cpu$$404$$.xor($data$$61_result$$41$$, $cpu$$404$$.reg8[$modrm_byte$$37$$ >> 1 & 12 | $modrm_byte$$37$$ >> 5 & 1], 7);
  192 > $modrm_byte$$37$$ ? $cpu$$404$$.memory.write8($addr$$15$$, $data$$61_result$$41$$) : $cpu$$404$$.reg8[$modrm_byte$$37$$ << 2 & 12 | $modrm_byte$$37$$ >> 2 & 1] = $data$$61_result$$41$$;
};
$table16$$[49] = function $$table16$$$49$($cpu$$405$$) {
  var $modrm_byte$$38$$ = $cpu$$405$$.read_imm8(), $data$$62_result$$42_virt_addr$$16$$, $phys_addr$$15$$, $phys_addr_high$$12$$ = 0;
  192 > $modrm_byte$$38$$ ? ($data$$62_result$$42_virt_addr$$16$$ = $cpu$$405$$.modrm_resolve($modrm_byte$$38$$), $phys_addr$$15$$ = $cpu$$405$$.translate_address_write($data$$62_result$$42_virt_addr$$16$$), $cpu$$405$$.paging && 4095 === ($data$$62_result$$42_virt_addr$$16$$ & 4095) ? ($phys_addr_high$$12$$ = $cpu$$405$$.translate_address_write($data$$62_result$$42_virt_addr$$16$$ + 1), $data$$62_result$$42_virt_addr$$16$$ = $cpu$$405$$.virt_boundary_read16($phys_addr$$15$$, $phys_addr_high$$12$$)) : 
  $data$$62_result$$42_virt_addr$$16$$ = $cpu$$405$$.memory.read16($phys_addr$$15$$)) : $data$$62_result$$42_virt_addr$$16$$ = $cpu$$405$$.reg16[$modrm_byte$$38$$ << 1 & 14];
  $data$$62_result$$42_virt_addr$$16$$ = $cpu$$405$$.xor($data$$62_result$$42_virt_addr$$16$$, $cpu$$405$$.reg16[$modrm_byte$$38$$ >> 2 & 14], 15);
  192 > $modrm_byte$$38$$ ? $phys_addr_high$$12$$ ? $cpu$$405$$.virt_boundary_write16($phys_addr$$15$$, $phys_addr_high$$12$$, $data$$62_result$$42_virt_addr$$16$$) : $cpu$$405$$.memory.write16($phys_addr$$15$$, $data$$62_result$$42_virt_addr$$16$$) : $cpu$$405$$.reg16[$modrm_byte$$38$$ << 1 & 14] = $data$$62_result$$42_virt_addr$$16$$;
};
$table32$$[49] = function $$table32$$$49$($cpu$$406$$) {
  var $modrm_byte$$39$$ = $cpu$$406$$.read_imm8(), $data$$63_result$$43_virt_addr$$17$$, $phys_addr$$16$$, $phys_addr_high$$13$$ = 0;
  192 > $modrm_byte$$39$$ ? ($data$$63_result$$43_virt_addr$$17$$ = $cpu$$406$$.modrm_resolve($modrm_byte$$39$$), $phys_addr$$16$$ = $cpu$$406$$.translate_address_write($data$$63_result$$43_virt_addr$$17$$), $cpu$$406$$.paging && 4093 <= ($data$$63_result$$43_virt_addr$$17$$ & 4095) ? ($phys_addr_high$$13$$ = $cpu$$406$$.translate_address_write($data$$63_result$$43_virt_addr$$17$$ + 3), $data$$63_result$$43_virt_addr$$17$$ = $cpu$$406$$.virt_boundary_read32s($phys_addr$$16$$, $phys_addr_high$$13$$)) : 
  $data$$63_result$$43_virt_addr$$17$$ = $cpu$$406$$.memory.read32s($phys_addr$$16$$)) : $data$$63_result$$43_virt_addr$$17$$ = $cpu$$406$$.reg32s[$modrm_byte$$39$$ & 7];
  $data$$63_result$$43_virt_addr$$17$$ = $cpu$$406$$.xor($data$$63_result$$43_virt_addr$$17$$, $cpu$$406$$.reg32s[$modrm_byte$$39$$ >> 3 & 7], 31);
  192 > $modrm_byte$$39$$ ? $phys_addr_high$$13$$ ? $cpu$$406$$.virt_boundary_write32($phys_addr$$16$$, $phys_addr_high$$13$$, $data$$63_result$$43_virt_addr$$17$$) : $cpu$$406$$.memory.write32($phys_addr$$16$$, $data$$63_result$$43_virt_addr$$17$$) : $cpu$$406$$.reg32s[$modrm_byte$$39$$ & 7] = $data$$63_result$$43_virt_addr$$17$$;
};
$table16$$[50] = $table32$$[50] = function $$table32$$$50$($cpu$$407$$) {
  var $modrm_byte$$40$$ = $cpu$$407$$.read_imm8(), $data$$64$$ = 192 > $modrm_byte$$40$$ ? $cpu$$407$$.safe_read8($cpu$$407$$.modrm_resolve($modrm_byte$$40$$)) : $cpu$$407$$.reg8[$modrm_byte$$40$$ << 2 & 12 | $modrm_byte$$40$$ >> 2 & 1];
  $cpu$$407$$.reg8[$modrm_byte$$40$$ >> 1 & 12 | $modrm_byte$$40$$ >> 5 & 1] = $cpu$$407$$.xor($cpu$$407$$.reg8[$modrm_byte$$40$$ >> 1 & 12 | $modrm_byte$$40$$ >> 5 & 1], $data$$64$$, 7);
};
$table16$$[51] = function $$table16$$$51$($cpu$$408$$) {
  var $modrm_byte$$41$$ = $cpu$$408$$.read_imm8(), $data$$65$$ = 192 > $modrm_byte$$41$$ ? $cpu$$408$$.safe_read16($cpu$$408$$.modrm_resolve($modrm_byte$$41$$)) : $cpu$$408$$.reg16[$modrm_byte$$41$$ << 1 & 14];
  $cpu$$408$$.reg16[$modrm_byte$$41$$ >> 2 & 14] = $cpu$$408$$.xor($cpu$$408$$.reg16[$modrm_byte$$41$$ >> 2 & 14], $data$$65$$, 15);
};
$table32$$[51] = function $$table32$$$51$($cpu$$409$$) {
  var $modrm_byte$$42$$ = $cpu$$409$$.read_imm8(), $data$$66$$ = 192 > $modrm_byte$$42$$ ? $cpu$$409$$.safe_read32s($cpu$$409$$.modrm_resolve($modrm_byte$$42$$)) : $cpu$$409$$.reg32s[$modrm_byte$$42$$ & 7];
  $cpu$$409$$.reg32s[$modrm_byte$$42$$ >> 3 & 7] = $cpu$$409$$.xor($cpu$$409$$.reg32s[$modrm_byte$$42$$ >> 3 & 7], $data$$66$$, 31);
};
$table16$$[52] = $table32$$[52] = function $$table32$$$52$($cpu$$410$$) {
  $cpu$$410$$.reg8[0] = $cpu$$410$$.xor($cpu$$410$$.reg8[0], $cpu$$410$$.read_imm8(), 7);
};
$table16$$[53] = function $$table16$$$53$($cpu$$411$$) {
  $cpu$$411$$.reg16[0] = $cpu$$411$$.xor($cpu$$411$$.reg16[0], $cpu$$411$$.read_imm16(), 15);
};
$table32$$[53] = function $$table32$$$53$($cpu$$412$$) {
  $cpu$$412$$.reg32s[0] = $cpu$$412$$.xor($cpu$$412$$.reg32s[0], $cpu$$412$$.read_imm32s(), 31);
};
$table16$$[54] = $table32$$[54] = function $$table32$$$54$($cpu$$413$$) {
  $cpu$$413$$.seg_prefix(2);
};
$table16$$[55] = $table32$$[55] = function $$table32$$$55$($cpu$$414$$) {
  $cpu$$414$$.bcd_aaa();
};
$table16$$[56] = $table32$$[56] = function $$table32$$$56$($cpu$$415$$) {
  var $modrm_byte$$43$$ = $cpu$$415$$.read_imm8(), $data$$67$$ = 192 > $modrm_byte$$43$$ ? $cpu$$415$$.safe_read8($cpu$$415$$.modrm_resolve($modrm_byte$$43$$)) : $cpu$$415$$.reg8[$modrm_byte$$43$$ << 2 & 12 | $modrm_byte$$43$$ >> 2 & 1];
  $cpu$$415$$.sub($data$$67$$, $cpu$$415$$.reg8[$modrm_byte$$43$$ >> 1 & 12 | $modrm_byte$$43$$ >> 5 & 1], 7);
};
$table16$$[57] = function $$table16$$$57$($cpu$$416$$) {
  var $modrm_byte$$44$$ = $cpu$$416$$.read_imm8(), $data$$68$$ = 192 > $modrm_byte$$44$$ ? $cpu$$416$$.safe_read16($cpu$$416$$.modrm_resolve($modrm_byte$$44$$)) : $cpu$$416$$.reg16[$modrm_byte$$44$$ << 1 & 14];
  $cpu$$416$$.sub($data$$68$$, $cpu$$416$$.reg16[$modrm_byte$$44$$ >> 2 & 14], 15);
};
$table32$$[57] = function $$table32$$$57$($cpu$$417$$) {
  var $modrm_byte$$45$$ = $cpu$$417$$.read_imm8(), $data$$69$$ = 192 > $modrm_byte$$45$$ ? $cpu$$417$$.safe_read32s($cpu$$417$$.modrm_resolve($modrm_byte$$45$$)) : $cpu$$417$$.reg32s[$modrm_byte$$45$$ & 7];
  $cpu$$417$$.sub($data$$69$$, $cpu$$417$$.reg32s[$modrm_byte$$45$$ >> 3 & 7], 31);
};
$table16$$[58] = $table32$$[58] = function $$table32$$$58$($cpu$$418$$) {
  var $modrm_byte$$46$$ = $cpu$$418$$.read_imm8(), $data$$70$$ = 192 > $modrm_byte$$46$$ ? $cpu$$418$$.safe_read8($cpu$$418$$.modrm_resolve($modrm_byte$$46$$)) : $cpu$$418$$.reg8[$modrm_byte$$46$$ << 2 & 12 | $modrm_byte$$46$$ >> 2 & 1];
  $cpu$$418$$.sub($cpu$$418$$.reg8[$modrm_byte$$46$$ >> 1 & 12 | $modrm_byte$$46$$ >> 5 & 1], $data$$70$$, 7);
};
$table16$$[59] = function $$table16$$$59$($cpu$$419$$) {
  var $modrm_byte$$47$$ = $cpu$$419$$.read_imm8(), $data$$71$$ = 192 > $modrm_byte$$47$$ ? $cpu$$419$$.safe_read16($cpu$$419$$.modrm_resolve($modrm_byte$$47$$)) : $cpu$$419$$.reg16[$modrm_byte$$47$$ << 1 & 14];
  $cpu$$419$$.sub($cpu$$419$$.reg16[$modrm_byte$$47$$ >> 2 & 14], $data$$71$$, 15);
};
$table32$$[59] = function $$table32$$$59$($cpu$$420$$) {
  var $modrm_byte$$48$$ = $cpu$$420$$.read_imm8(), $data$$72$$ = 192 > $modrm_byte$$48$$ ? $cpu$$420$$.safe_read32s($cpu$$420$$.modrm_resolve($modrm_byte$$48$$)) : $cpu$$420$$.reg32s[$modrm_byte$$48$$ & 7];
  $cpu$$420$$.sub($cpu$$420$$.reg32s[$modrm_byte$$48$$ >> 3 & 7], $data$$72$$, 31);
};
$table16$$[60] = $table32$$[60] = function $$table32$$$60$($cpu$$421$$) {
  $cpu$$421$$.sub($cpu$$421$$.reg8[0], $cpu$$421$$.read_imm8(), 7);
};
$table16$$[61] = function $$table16$$$61$($cpu$$422$$) {
  $cpu$$422$$.sub($cpu$$422$$.reg16[0], $cpu$$422$$.read_imm16(), 15);
};
$table32$$[61] = function $$table32$$$61$($cpu$$423$$) {
  $cpu$$423$$.sub($cpu$$423$$.reg32s[0], $cpu$$423$$.read_imm32s(), 31);
};
$table16$$[62] = $table32$$[62] = function $$table32$$$62$($cpu$$424$$) {
  $cpu$$424$$.seg_prefix(3);
};
$table16$$[63] = $table32$$[63] = function $$table32$$$63$($cpu$$425$$) {
  $cpu$$425$$.bcd_aas();
};
$table16$$[64] = function $$table16$$$64$($cpu$$426$$) {
  $cpu$$426$$.reg16[0] = $cpu$$426$$.inc($cpu$$426$$.reg16[0], 15);
};
$table32$$[64] = function $$table32$$$64$($cpu$$427$$) {
  $cpu$$427$$.reg32s[0] = $cpu$$427$$.inc($cpu$$427$$.reg32s[0], 31);
};
$table16$$[65] = function $$table16$$$65$($cpu$$428$$) {
  $cpu$$428$$.reg16[2] = $cpu$$428$$.inc($cpu$$428$$.reg16[2], 15);
};
$table32$$[65] = function $$table32$$$65$($cpu$$429$$) {
  $cpu$$429$$.reg32s[1] = $cpu$$429$$.inc($cpu$$429$$.reg32s[1], 31);
};
$table16$$[66] = function $$table16$$$66$($cpu$$430$$) {
  $cpu$$430$$.reg16[4] = $cpu$$430$$.inc($cpu$$430$$.reg16[4], 15);
};
$table32$$[66] = function $$table32$$$66$($cpu$$431$$) {
  $cpu$$431$$.reg32s[2] = $cpu$$431$$.inc($cpu$$431$$.reg32s[2], 31);
};
$table16$$[67] = function $$table16$$$67$($cpu$$432$$) {
  $cpu$$432$$.reg16[6] = $cpu$$432$$.inc($cpu$$432$$.reg16[6], 15);
};
$table32$$[67] = function $$table32$$$67$($cpu$$433$$) {
  $cpu$$433$$.reg32s[3] = $cpu$$433$$.inc($cpu$$433$$.reg32s[3], 31);
};
$table16$$[68] = function $$table16$$$68$($cpu$$434$$) {
  $cpu$$434$$.reg16[8] = $cpu$$434$$.inc($cpu$$434$$.reg16[8], 15);
};
$table32$$[68] = function $$table32$$$68$($cpu$$435$$) {
  $cpu$$435$$.reg32s[4] = $cpu$$435$$.inc($cpu$$435$$.reg32s[4], 31);
};
$table16$$[69] = function $$table16$$$69$($cpu$$436$$) {
  $cpu$$436$$.reg16[10] = $cpu$$436$$.inc($cpu$$436$$.reg16[10], 15);
};
$table32$$[69] = function $$table32$$$69$($cpu$$437$$) {
  $cpu$$437$$.reg32s[5] = $cpu$$437$$.inc($cpu$$437$$.reg32s[5], 31);
};
$table16$$[70] = function $$table16$$$70$($cpu$$438$$) {
  $cpu$$438$$.reg16[12] = $cpu$$438$$.inc($cpu$$438$$.reg16[12], 15);
};
$table32$$[70] = function $$table32$$$70$($cpu$$439$$) {
  $cpu$$439$$.reg32s[6] = $cpu$$439$$.inc($cpu$$439$$.reg32s[6], 31);
};
$table16$$[71] = function $$table16$$$71$($cpu$$440$$) {
  $cpu$$440$$.reg16[14] = $cpu$$440$$.inc($cpu$$440$$.reg16[14], 15);
};
$table32$$[71] = function $$table32$$$71$($cpu$$441$$) {
  $cpu$$441$$.reg32s[7] = $cpu$$441$$.inc($cpu$$441$$.reg32s[7], 31);
};
$table16$$[72] = function $$table16$$$72$($cpu$$442$$) {
  $cpu$$442$$.reg16[0] = $cpu$$442$$.dec($cpu$$442$$.reg16[0], 15);
};
$table32$$[72] = function $$table32$$$72$($cpu$$443$$) {
  $cpu$$443$$.reg32s[0] = $cpu$$443$$.dec($cpu$$443$$.reg32s[0], 31);
};
$table16$$[73] = function $$table16$$$73$($cpu$$444$$) {
  $cpu$$444$$.reg16[2] = $cpu$$444$$.dec($cpu$$444$$.reg16[2], 15);
};
$table32$$[73] = function $$table32$$$73$($cpu$$445$$) {
  $cpu$$445$$.reg32s[1] = $cpu$$445$$.dec($cpu$$445$$.reg32s[1], 31);
};
$table16$$[74] = function $$table16$$$74$($cpu$$446$$) {
  $cpu$$446$$.reg16[4] = $cpu$$446$$.dec($cpu$$446$$.reg16[4], 15);
};
$table32$$[74] = function $$table32$$$74$($cpu$$447$$) {
  $cpu$$447$$.reg32s[2] = $cpu$$447$$.dec($cpu$$447$$.reg32s[2], 31);
};
$table16$$[75] = function $$table16$$$75$($cpu$$448$$) {
  $cpu$$448$$.reg16[6] = $cpu$$448$$.dec($cpu$$448$$.reg16[6], 15);
};
$table32$$[75] = function $$table32$$$75$($cpu$$449$$) {
  $cpu$$449$$.reg32s[3] = $cpu$$449$$.dec($cpu$$449$$.reg32s[3], 31);
};
$table16$$[76] = function $$table16$$$76$($cpu$$450$$) {
  $cpu$$450$$.reg16[8] = $cpu$$450$$.dec($cpu$$450$$.reg16[8], 15);
};
$table32$$[76] = function $$table32$$$76$($cpu$$451$$) {
  $cpu$$451$$.reg32s[4] = $cpu$$451$$.dec($cpu$$451$$.reg32s[4], 31);
};
$table16$$[77] = function $$table16$$$77$($cpu$$452$$) {
  $cpu$$452$$.reg16[10] = $cpu$$452$$.dec($cpu$$452$$.reg16[10], 15);
};
$table32$$[77] = function $$table32$$$77$($cpu$$453$$) {
  $cpu$$453$$.reg32s[5] = $cpu$$453$$.dec($cpu$$453$$.reg32s[5], 31);
};
$table16$$[78] = function $$table16$$$78$($cpu$$454$$) {
  $cpu$$454$$.reg16[12] = $cpu$$454$$.dec($cpu$$454$$.reg16[12], 15);
};
$table32$$[78] = function $$table32$$$78$($cpu$$455$$) {
  $cpu$$455$$.reg32s[6] = $cpu$$455$$.dec($cpu$$455$$.reg32s[6], 31);
};
$table16$$[79] = function $$table16$$$79$($cpu$$456$$) {
  $cpu$$456$$.reg16[14] = $cpu$$456$$.dec($cpu$$456$$.reg16[14], 15);
};
$table32$$[79] = function $$table32$$$79$($cpu$$457$$) {
  $cpu$$457$$.reg32s[7] = $cpu$$457$$.dec($cpu$$457$$.reg32s[7], 31);
};
$table16$$[80] = function $$table16$$$80$($cpu$$458$$) {
  $cpu$$458$$.push16($cpu$$458$$.reg16[0]);
};
$table32$$[80] = function $$table32$$$80$($cpu$$459$$) {
  $cpu$$459$$.push32($cpu$$459$$.reg32s[0]);
};
$table16$$[81] = function $$table16$$$81$($cpu$$460$$) {
  $cpu$$460$$.push16($cpu$$460$$.reg16[2]);
};
$table32$$[81] = function $$table32$$$81$($cpu$$461$$) {
  $cpu$$461$$.push32($cpu$$461$$.reg32s[1]);
};
$table16$$[82] = function $$table16$$$82$($cpu$$462$$) {
  $cpu$$462$$.push16($cpu$$462$$.reg16[4]);
};
$table32$$[82] = function $$table32$$$82$($cpu$$463$$) {
  $cpu$$463$$.push32($cpu$$463$$.reg32s[2]);
};
$table16$$[83] = function $$table16$$$83$($cpu$$464$$) {
  $cpu$$464$$.push16($cpu$$464$$.reg16[6]);
};
$table32$$[83] = function $$table32$$$83$($cpu$$465$$) {
  $cpu$$465$$.push32($cpu$$465$$.reg32s[3]);
};
$table16$$[84] = function $$table16$$$84$($cpu$$466$$) {
  $cpu$$466$$.push16($cpu$$466$$.reg16[8]);
};
$table32$$[84] = function $$table32$$$84$($cpu$$467$$) {
  $cpu$$467$$.push32($cpu$$467$$.reg32s[4]);
};
$table16$$[85] = function $$table16$$$85$($cpu$$468$$) {
  $cpu$$468$$.push16($cpu$$468$$.reg16[10]);
};
$table32$$[85] = function $$table32$$$85$($cpu$$469$$) {
  $cpu$$469$$.push32($cpu$$469$$.reg32s[5]);
};
$table16$$[86] = function $$table16$$$86$($cpu$$470$$) {
  $cpu$$470$$.push16($cpu$$470$$.reg16[12]);
};
$table32$$[86] = function $$table32$$$86$($cpu$$471$$) {
  $cpu$$471$$.push32($cpu$$471$$.reg32s[6]);
};
$table16$$[87] = function $$table16$$$87$($cpu$$472$$) {
  $cpu$$472$$.push16($cpu$$472$$.reg16[14]);
};
$table32$$[87] = function $$table32$$$87$($cpu$$473$$) {
  $cpu$$473$$.push32($cpu$$473$$.reg32s[7]);
};
$table16$$[88] = function $$table16$$$88$($cpu$$474$$) {
  $cpu$$474$$.reg16[0] = $cpu$$474$$.pop16();
};
$table32$$[88] = function $$table32$$$88$($cpu$$475$$) {
  $cpu$$475$$.reg32s[0] = $cpu$$475$$.pop32s();
};
$table16$$[89] = function $$table16$$$89$($cpu$$476$$) {
  $cpu$$476$$.reg16[2] = $cpu$$476$$.pop16();
};
$table32$$[89] = function $$table32$$$89$($cpu$$477$$) {
  $cpu$$477$$.reg32s[1] = $cpu$$477$$.pop32s();
};
$table16$$[90] = function $$table16$$$90$($cpu$$478$$) {
  $cpu$$478$$.reg16[4] = $cpu$$478$$.pop16();
};
$table32$$[90] = function $$table32$$$90$($cpu$$479$$) {
  $cpu$$479$$.reg32s[2] = $cpu$$479$$.pop32s();
};
$table16$$[91] = function $$table16$$$91$($cpu$$480$$) {
  $cpu$$480$$.reg16[6] = $cpu$$480$$.pop16();
};
$table32$$[91] = function $$table32$$$91$($cpu$$481$$) {
  $cpu$$481$$.reg32s[3] = $cpu$$481$$.pop32s();
};
$table16$$[92] = function $$table16$$$92$($cpu$$482$$) {
  $cpu$$482$$.reg16[8] = $cpu$$482$$.pop16();
};
$table32$$[92] = function $$table32$$$92$($cpu$$483$$) {
  $cpu$$483$$.reg32s[4] = $cpu$$483$$.pop32s();
};
$table16$$[93] = function $$table16$$$93$($cpu$$484$$) {
  $cpu$$484$$.reg16[10] = $cpu$$484$$.pop16();
};
$table32$$[93] = function $$table32$$$93$($cpu$$485$$) {
  $cpu$$485$$.reg32s[5] = $cpu$$485$$.pop32s();
};
$table16$$[94] = function $$table16$$$94$($cpu$$486$$) {
  $cpu$$486$$.reg16[12] = $cpu$$486$$.pop16();
};
$table32$$[94] = function $$table32$$$94$($cpu$$487$$) {
  $cpu$$487$$.reg32s[6] = $cpu$$487$$.pop32s();
};
$table16$$[95] = function $$table16$$$95$($cpu$$488$$) {
  $cpu$$488$$.reg16[14] = $cpu$$488$$.pop16();
};
$table32$$[95] = function $$table32$$$95$($cpu$$489$$) {
  $cpu$$489$$.reg32s[7] = $cpu$$489$$.pop32s();
};
$table16$$[96] = function $$table16$$$96$($cpu$$490$$) {
  $cpu$$490$$.pusha16();
};
$table32$$[96] = function $$table32$$$96$($cpu$$491$$) {
  $cpu$$491$$.pusha32();
};
$table16$$[97] = function $$table16$$$97$($cpu$$492$$) {
  $cpu$$492$$.popa16();
};
$table32$$[97] = function $$table32$$$97$($cpu$$493$$) {
  $cpu$$493$$.popa32();
};
$table16$$[98] = $table32$$[98] = function $$table32$$$98$($cpu$$494$$) {
  throw $cpu$$494$$.debug.unimpl("bound instruction");
};
$table16$$[99] = $table32$$[99] = function $$table32$$$99$($cpu$$495$$) {
  var $modrm_byte$$49$$ = $cpu$$495$$.read_imm8(), $data$$73_result$$44_virt_addr$$18$$, $phys_addr$$17$$, $phys_addr_high$$14$$ = 0;
  192 > $modrm_byte$$49$$ ? ($data$$73_result$$44_virt_addr$$18$$ = $cpu$$495$$.modrm_resolve($modrm_byte$$49$$), $phys_addr$$17$$ = $cpu$$495$$.translate_address_write($data$$73_result$$44_virt_addr$$18$$), $cpu$$495$$.paging && 4095 === ($data$$73_result$$44_virt_addr$$18$$ & 4095) ? ($phys_addr_high$$14$$ = $cpu$$495$$.translate_address_write($data$$73_result$$44_virt_addr$$18$$ + 1), $data$$73_result$$44_virt_addr$$18$$ = $cpu$$495$$.virt_boundary_read16($phys_addr$$17$$, $phys_addr_high$$14$$)) : 
  $data$$73_result$$44_virt_addr$$18$$ = $cpu$$495$$.memory.read16($phys_addr$$17$$)) : $data$$73_result$$44_virt_addr$$18$$ = $cpu$$495$$.reg16[$modrm_byte$$49$$ << 1 & 14];
  $data$$73_result$$44_virt_addr$$18$$ = $cpu$$495$$.arpl($data$$73_result$$44_virt_addr$$18$$, $modrm_byte$$49$$ >> 2 & 14);
  192 > $modrm_byte$$49$$ ? $phys_addr_high$$14$$ ? $cpu$$495$$.virt_boundary_write16($phys_addr$$17$$, $phys_addr_high$$14$$, $data$$73_result$$44_virt_addr$$18$$) : $cpu$$495$$.memory.write16($phys_addr$$17$$, $data$$73_result$$44_virt_addr$$18$$) : $cpu$$495$$.reg16[$modrm_byte$$49$$ << 1 & 14] = $data$$73_result$$44_virt_addr$$18$$;
};
$table16$$[100] = $table32$$[100] = function $$table32$$$100$($cpu$$496$$) {
  $cpu$$496$$.seg_prefix(4);
};
$table16$$[101] = $table32$$[101] = function $$table32$$$101$($cpu$$497$$) {
  $cpu$$497$$.seg_prefix(5);
};
$table16$$[102] = $table32$$[102] = function $$table32$$$102$($cpu$$498$$) {
  $cpu$$498$$.operand_size_32 = !$cpu$$498$$.is_32;
  $cpu$$498$$.update_operand_size();
  $cpu$$498$$.table[$cpu$$498$$.read_imm8()]($cpu$$498$$);
  $cpu$$498$$.operand_size_32 = $cpu$$498$$.is_32;
  $cpu$$498$$.update_operand_size();
};
$table16$$[103] = $table32$$[103] = function $$table32$$$103$($cpu$$499$$) {
  $cpu$$499$$.address_size_32 = !$cpu$$499$$.is_32;
  $cpu$$499$$.update_address_size();
  $cpu$$499$$.table[$cpu$$499$$.read_imm8()]($cpu$$499$$);
  $cpu$$499$$.address_size_32 = $cpu$$499$$.is_32;
  $cpu$$499$$.update_address_size();
};
$table16$$[104] = function $$table16$$$104$($cpu$$500$$) {
  $cpu$$500$$.push16($cpu$$500$$.read_imm16());
};
$table32$$[104] = function $$table32$$$104$($cpu$$501$$) {
  $cpu$$501$$.push32($cpu$$501$$.read_imm32s());
};
$table16$$[105] = function $$table16$$$105$($cpu$$502$$) {
  var $modrm_byte$$50$$ = $cpu$$502$$.read_imm8(), $data$$74$$ = 192 > $modrm_byte$$50$$ ? $cpu$$502$$.safe_read16($cpu$$502$$.modrm_resolve($modrm_byte$$50$$)) << 16 >> 16 : $cpu$$502$$.reg16s[$modrm_byte$$50$$ << 1 & 14];
  $cpu$$502$$.reg16[$modrm_byte$$50$$ >> 2 & 14] = $cpu$$502$$.imul_reg16($cpu$$502$$.read_imm16s(), $data$$74$$);
};
$table32$$[105] = function $$table32$$$105$($cpu$$503$$) {
  var $modrm_byte$$51$$ = $cpu$$503$$.read_imm8(), $data$$75$$ = 192 > $modrm_byte$$51$$ ? $cpu$$503$$.safe_read32s($cpu$$503$$.modrm_resolve($modrm_byte$$51$$)) : $cpu$$503$$.reg32s[$modrm_byte$$51$$ & 7];
  $cpu$$503$$.reg32s[$modrm_byte$$51$$ >> 3 & 7] = $cpu$$503$$.imul_reg32($cpu$$503$$.read_imm32s(), $data$$75$$);
};
$table16$$[106] = function $$table16$$$106$($cpu$$504$$) {
  $cpu$$504$$.push16($cpu$$504$$.read_imm8s());
};
$table32$$[106] = function $$table32$$$106$($cpu$$505$$) {
  $cpu$$505$$.push32($cpu$$505$$.read_imm8s());
};
$table16$$[107] = function $$table16$$$107$($cpu$$506$$) {
  var $modrm_byte$$52$$ = $cpu$$506$$.read_imm8(), $data$$76$$ = 192 > $modrm_byte$$52$$ ? $cpu$$506$$.safe_read16($cpu$$506$$.modrm_resolve($modrm_byte$$52$$)) << 16 >> 16 : $cpu$$506$$.reg16s[$modrm_byte$$52$$ << 1 & 14];
  $cpu$$506$$.reg16[$modrm_byte$$52$$ >> 2 & 14] = $cpu$$506$$.imul_reg16($cpu$$506$$.read_imm8s(), $data$$76$$);
};
$table32$$[107] = function $$table32$$$107$($cpu$$507$$) {
  var $modrm_byte$$53$$ = $cpu$$507$$.read_imm8(), $data$$77$$ = 192 > $modrm_byte$$53$$ ? $cpu$$507$$.safe_read32s($cpu$$507$$.modrm_resolve($modrm_byte$$53$$)) : $cpu$$507$$.reg32s[$modrm_byte$$53$$ & 7];
  $cpu$$507$$.reg32s[$modrm_byte$$53$$ >> 3 & 7] = $cpu$$507$$.imul_reg32($cpu$$507$$.read_imm8s(), $data$$77$$);
};
$table16$$[108] = $table32$$[108] = function $$table32$$$108$($cpu$$508$$) {
  a: {
    var $port$$inline_376$$ = $cpu$$508$$.reg16[4];
    $cpu$$508$$.test_privileges_for_io($port$$inline_376$$, 1);
    var $dest$$inline_377_phys_dest$$inline_378$$, $size$$inline_379$$ = $cpu$$508$$.flags & 1024 ? -1 : 1, $cont$$inline_380$$ = !1;
    $dest$$inline_377_phys_dest$$inline_378$$ = $cpu$$508$$.get_seg(0) + $cpu$$508$$.regv[$cpu$$508$$.reg_vdi] | 0;
    if (0 !== $cpu$$508$$.repeat_string_prefix) {
      var $count$$inline_381$$ = $cpu$$508$$.regv[$cpu$$508$$.reg_vcx] >>> 0, $start_count$$inline_382$$ = $count$$inline_381$$;
      if (0 === $count$$inline_381$$) {
        break a;
      }
      var $next_cycle$$inline_383$$ = 16384, $single_size$$inline_384$$ = $size$$inline_379$$ >> 31 | 1;
      $cpu$$508$$.paging && ($next_cycle$$inline_383$$ = Math.min($next_cycle$$inline_383$$, ($single_size$$inline_384$$ >> 1 ^ ~$dest$$inline_377_phys_dest$$inline_378$$) & 4095), $dest$$inline_377_phys_dest$$inline_378$$ = $cpu$$508$$.translate_address_write($dest$$inline_377_phys_dest$$inline_378$$));
      do {
        $cpu$$508$$.memory.write8($dest$$inline_377_phys_dest$$inline_378$$, $cpu$$508$$.io.port_read8($port$$inline_376$$)), $dest$$inline_377_phys_dest$$inline_378$$ += $single_size$$inline_384$$, $cont$$inline_380$$ = 0 !== --$count$$inline_381$$ && !0;
      } while ($cont$$inline_380$$ && $next_cycle$$inline_383$$--);
      $cpu$$508$$.regv[$cpu$$508$$.reg_vdi] += $size$$inline_379$$ * ($start_count$$inline_382$$ - $count$$inline_381$$) | 0;
      $cpu$$508$$.regv[$cpu$$508$$.reg_vcx] = $count$$inline_381$$;
      $cpu$$508$$.timestamp_counter += $start_count$$inline_382$$ - $count$$inline_381$$;
    } else {
      $dest$$inline_377_phys_dest$$inline_378$$ = $cpu$$508$$.translate_address_write($dest$$inline_377_phys_dest$$inline_378$$), $cpu$$508$$.memory.write8($dest$$inline_377_phys_dest$$inline_378$$, $cpu$$508$$.io.port_read8($port$$inline_376$$)), $cpu$$508$$.regv[$cpu$$508$$.reg_vdi] += $size$$inline_379$$;
    }
    $cont$$inline_380$$ && ($cpu$$508$$.instruction_pointer = $cpu$$508$$.previous_ip);
  }
};
$table16$$[109] = function $$table16$$$109$($cpu$$509$$) {
  a: {
    var $port$$inline_387$$ = $cpu$$509$$.reg16[4];
    $cpu$$509$$.test_privileges_for_io($port$$inline_387$$, 2);
    var $dest$$inline_388_phys_dest$$inline_389$$, $size$$inline_390$$ = $cpu$$509$$.flags & 1024 ? -2 : 2, $cont$$inline_391$$ = !1;
    $dest$$inline_388_phys_dest$$inline_389$$ = $cpu$$509$$.get_seg(0) + $cpu$$509$$.regv[$cpu$$509$$.reg_vdi] | 0;
    if (0 !== $cpu$$509$$.repeat_string_prefix) {
      var $count$$inline_392$$ = $cpu$$509$$.regv[$cpu$$509$$.reg_vcx] >>> 0, $start_count$$inline_393$$ = $count$$inline_392$$;
      if (0 === $count$$inline_392$$) {
        break a;
      }
      var $next_cycle$$inline_394$$ = 16384;
      if ($dest$$inline_388_phys_dest$$inline_389$$ & 1) {
        do {
          $cpu$$509$$.safe_write16($dest$$inline_388_phys_dest$$inline_389$$, $cpu$$509$$.io.port_read16($port$$inline_387$$)), $dest$$inline_388_phys_dest$$inline_389$$ += $size$$inline_390$$, $cpu$$509$$.regv[$cpu$$509$$.reg_vdi] += $size$$inline_390$$, $cont$$inline_391$$ = 0 !== --$cpu$$509$$.regv[$cpu$$509$$.reg_vcx] && !0;
        } while ($cont$$inline_391$$ && $next_cycle$$inline_394$$--);
      } else {
        var $single_size$$inline_395$$ = $size$$inline_390$$ >> 31 | 1;
        $cpu$$509$$.paging && ($next_cycle$$inline_394$$ = Math.min($next_cycle$$inline_394$$, ($single_size$$inline_395$$ >> 1 ^ ~$dest$$inline_388_phys_dest$$inline_389$$) & 4095), $dest$$inline_388_phys_dest$$inline_389$$ = $cpu$$509$$.translate_address_write($dest$$inline_388_phys_dest$$inline_389$$), $next_cycle$$inline_394$$ >>= 1);
        $dest$$inline_388_phys_dest$$inline_389$$ >>>= 1;
        do {
          $cpu$$509$$.memory.write_aligned16($dest$$inline_388_phys_dest$$inline_389$$, $cpu$$509$$.io.port_read16($port$$inline_387$$)), $dest$$inline_388_phys_dest$$inline_389$$ += $single_size$$inline_395$$, $cont$$inline_391$$ = 0 !== --$count$$inline_392$$ && !0;
        } while ($cont$$inline_391$$ && $next_cycle$$inline_394$$--);
        $cpu$$509$$.regv[$cpu$$509$$.reg_vdi] += $size$$inline_390$$ * ($start_count$$inline_393$$ - $count$$inline_392$$) | 0;
        $cpu$$509$$.regv[$cpu$$509$$.reg_vcx] = $count$$inline_392$$;
        $cpu$$509$$.timestamp_counter += $start_count$$inline_393$$ - $count$$inline_392$$;
      }
    } else {
      $cpu$$509$$.safe_write16($dest$$inline_388_phys_dest$$inline_389$$, $cpu$$509$$.io.port_read16($port$$inline_387$$)), $cpu$$509$$.regv[$cpu$$509$$.reg_vdi] += $size$$inline_390$$;
    }
    $cont$$inline_391$$ && ($cpu$$509$$.instruction_pointer = $cpu$$509$$.previous_ip);
  }
};
$table32$$[109] = function $$table32$$$109$($cpu$$510$$) {
  a: {
    var $port$$inline_398$$ = $cpu$$510$$.reg16[4];
    $cpu$$510$$.test_privileges_for_io($port$$inline_398$$, 4);
    var $dest$$inline_399_phys_dest$$inline_400$$, $size$$inline_401$$ = $cpu$$510$$.flags & 1024 ? -4 : 4, $cont$$inline_402$$ = !1;
    $dest$$inline_399_phys_dest$$inline_400$$ = $cpu$$510$$.get_seg(0) + $cpu$$510$$.regv[$cpu$$510$$.reg_vdi] | 0;
    if (0 !== $cpu$$510$$.repeat_string_prefix) {
      var $count$$inline_403$$ = $cpu$$510$$.regv[$cpu$$510$$.reg_vcx] >>> 0, $start_count$$inline_404$$ = $count$$inline_403$$;
      if (0 === $count$$inline_403$$) {
        break a;
      }
      var $next_cycle$$inline_405$$ = 16384;
      if ($dest$$inline_399_phys_dest$$inline_400$$ & 3) {
        do {
          $cpu$$510$$.safe_write32($dest$$inline_399_phys_dest$$inline_400$$, $cpu$$510$$.io.port_read32($port$$inline_398$$)), $dest$$inline_399_phys_dest$$inline_400$$ += $size$$inline_401$$, $cpu$$510$$.regv[$cpu$$510$$.reg_vdi] += $size$$inline_401$$, $cont$$inline_402$$ = 0 !== --$cpu$$510$$.regv[$cpu$$510$$.reg_vcx] && !0;
        } while ($cont$$inline_402$$ && $next_cycle$$inline_405$$--);
      } else {
        var $single_size$$inline_406$$ = $size$$inline_401$$ >> 31 | 1;
        $cpu$$510$$.paging && ($next_cycle$$inline_405$$ = Math.min($next_cycle$$inline_405$$, ($single_size$$inline_406$$ >> 1 ^ ~$dest$$inline_399_phys_dest$$inline_400$$) & 4095), $dest$$inline_399_phys_dest$$inline_400$$ = $cpu$$510$$.translate_address_write($dest$$inline_399_phys_dest$$inline_400$$), $next_cycle$$inline_405$$ >>= 2);
        $dest$$inline_399_phys_dest$$inline_400$$ >>>= 2;
        do {
          $cpu$$510$$.memory.write_aligned32($dest$$inline_399_phys_dest$$inline_400$$, $cpu$$510$$.io.port_read32($port$$inline_398$$)), $dest$$inline_399_phys_dest$$inline_400$$ += $single_size$$inline_406$$, $cont$$inline_402$$ = 0 !== --$count$$inline_403$$ && !0;
        } while ($cont$$inline_402$$ && $next_cycle$$inline_405$$--);
        $cpu$$510$$.regv[$cpu$$510$$.reg_vdi] += $size$$inline_401$$ * ($start_count$$inline_404$$ - $count$$inline_403$$) | 0;
        $cpu$$510$$.regv[$cpu$$510$$.reg_vcx] = $count$$inline_403$$;
        $cpu$$510$$.timestamp_counter += $start_count$$inline_404$$ - $count$$inline_403$$;
      }
    } else {
      $cpu$$510$$.safe_write32($dest$$inline_399_phys_dest$$inline_400$$, $cpu$$510$$.io.port_read32($port$$inline_398$$)), $cpu$$510$$.regv[$cpu$$510$$.reg_vdi] += $size$$inline_401$$;
    }
    $cont$$inline_402$$ && ($cpu$$510$$.instruction_pointer = $cpu$$510$$.previous_ip);
  }
};
$table16$$[110] = $table32$$[110] = function $$table32$$$110$($cpu$$511$$) {
  a: {
    var $port$$inline_409$$ = $cpu$$511$$.reg16[4];
    $cpu$$511$$.test_privileges_for_io($port$$inline_409$$, 1);
    var $phys_src$$inline_411_src$$inline_410$$, $size$$inline_412$$ = $cpu$$511$$.flags & 1024 ? -1 : 1, $cont$$inline_413$$ = !1;
    $phys_src$$inline_411_src$$inline_410$$ = $cpu$$511$$.get_seg_prefix(3) + $cpu$$511$$.regv[$cpu$$511$$.reg_vsi] | 0;
    if (0 !== $cpu$$511$$.repeat_string_prefix) {
      var $count$$inline_414$$ = $cpu$$511$$.regv[$cpu$$511$$.reg_vcx] >>> 0, $start_count$$inline_415$$ = $count$$inline_414$$;
      if (0 === $count$$inline_414$$) {
        break a;
      }
      var $next_cycle$$inline_416$$ = 16384, $single_size$$inline_417$$ = $size$$inline_412$$ >> 31 | 1;
      $cpu$$511$$.paging && ($next_cycle$$inline_416$$ = ($single_size$$inline_417$$ >> 1 ^ ~$phys_src$$inline_411_src$$inline_410$$) & 4095, $phys_src$$inline_411_src$$inline_410$$ = $cpu$$511$$.translate_address_read($phys_src$$inline_411_src$$inline_410$$));
      do {
        $cpu$$511$$.io.port_write8($port$$inline_409$$, $cpu$$511$$.memory.read8($phys_src$$inline_411_src$$inline_410$$)), $phys_src$$inline_411_src$$inline_410$$ += $single_size$$inline_417$$, $cont$$inline_413$$ = 0 !== --$count$$inline_414$$ && !0;
      } while ($cont$$inline_413$$ && $next_cycle$$inline_416$$--);
      $cpu$$511$$.regv[$cpu$$511$$.reg_vsi] += $size$$inline_412$$ * ($start_count$$inline_415$$ - $count$$inline_414$$) | 0;
      $cpu$$511$$.regv[$cpu$$511$$.reg_vcx] = $count$$inline_414$$;
      $cpu$$511$$.timestamp_counter += $start_count$$inline_415$$ - $count$$inline_414$$;
    } else {
      $phys_src$$inline_411_src$$inline_410$$ = $cpu$$511$$.translate_address_read($phys_src$$inline_411_src$$inline_410$$), $cpu$$511$$.io.port_write8($port$$inline_409$$, $cpu$$511$$.memory.read8($phys_src$$inline_411_src$$inline_410$$)), $cpu$$511$$.regv[$cpu$$511$$.reg_vsi] += $size$$inline_412$$;
    }
    $cont$$inline_413$$ && ($cpu$$511$$.instruction_pointer = $cpu$$511$$.previous_ip);
  }
};
$table16$$[111] = function $$table16$$$111$($cpu$$512$$) {
  a: {
    var $port$$inline_420$$ = $cpu$$512$$.reg16[4];
    $cpu$$512$$.test_privileges_for_io($port$$inline_420$$, 2);
    var $phys_src$$inline_422_src$$inline_421$$, $size$$inline_423$$ = $cpu$$512$$.flags & 1024 ? -2 : 2, $cont$$inline_424$$ = !1;
    $phys_src$$inline_422_src$$inline_421$$ = $cpu$$512$$.get_seg_prefix(3) + $cpu$$512$$.regv[$cpu$$512$$.reg_vsi] | 0;
    if (0 !== $cpu$$512$$.repeat_string_prefix) {
      var $count$$inline_425$$ = $cpu$$512$$.regv[$cpu$$512$$.reg_vcx] >>> 0, $start_count$$inline_426$$ = $count$$inline_425$$;
      if (0 === $count$$inline_425$$) {
        break a;
      }
      var $next_cycle$$inline_427$$ = 16384;
      if ($phys_src$$inline_422_src$$inline_421$$ & 1) {
        do {
          $cpu$$512$$.io.port_write16($port$$inline_420$$, $cpu$$512$$.safe_read16($phys_src$$inline_422_src$$inline_421$$)), $phys_src$$inline_422_src$$inline_421$$ += $size$$inline_423$$, $cpu$$512$$.regv[$cpu$$512$$.reg_vsi] += $size$$inline_423$$, $cont$$inline_424$$ = 0 !== --$cpu$$512$$.regv[$cpu$$512$$.reg_vcx] && !0;
        } while ($cont$$inline_424$$ && $next_cycle$$inline_427$$--);
      } else {
        var $single_size$$inline_428$$ = $size$$inline_423$$ >> 31 | 1;
        $cpu$$512$$.paging && ($next_cycle$$inline_427$$ = ($single_size$$inline_428$$ >> 1 ^ ~$phys_src$$inline_422_src$$inline_421$$) & 4095, $phys_src$$inline_422_src$$inline_421$$ = $cpu$$512$$.translate_address_read($phys_src$$inline_422_src$$inline_421$$), $next_cycle$$inline_427$$ >>= 1);
        $phys_src$$inline_422_src$$inline_421$$ >>>= 1;
        do {
          $cpu$$512$$.io.port_write16($port$$inline_420$$, $cpu$$512$$.memory.read_aligned16($phys_src$$inline_422_src$$inline_421$$)), $phys_src$$inline_422_src$$inline_421$$ += $single_size$$inline_428$$, $cont$$inline_424$$ = 0 !== --$count$$inline_425$$ && !0;
        } while ($cont$$inline_424$$ && $next_cycle$$inline_427$$--);
        $cpu$$512$$.regv[$cpu$$512$$.reg_vsi] += $size$$inline_423$$ * ($start_count$$inline_426$$ - $count$$inline_425$$) | 0;
        $cpu$$512$$.regv[$cpu$$512$$.reg_vcx] = $count$$inline_425$$;
        $cpu$$512$$.timestamp_counter += $start_count$$inline_426$$ - $count$$inline_425$$;
      }
    } else {
      $cpu$$512$$.io.port_write16($port$$inline_420$$, $cpu$$512$$.safe_read16($phys_src$$inline_422_src$$inline_421$$)), $cpu$$512$$.regv[$cpu$$512$$.reg_vsi] += $size$$inline_423$$;
    }
    $cont$$inline_424$$ && ($cpu$$512$$.instruction_pointer = $cpu$$512$$.previous_ip);
  }
};
$table32$$[111] = function $$table32$$$111$($cpu$$513$$) {
  a: {
    var $port$$inline_431$$ = $cpu$$513$$.reg16[4];
    $cpu$$513$$.test_privileges_for_io($port$$inline_431$$, 4);
    var $phys_src$$inline_433_src$$inline_432$$, $size$$inline_434$$ = $cpu$$513$$.flags & 1024 ? -4 : 4, $cont$$inline_435$$ = !1;
    $phys_src$$inline_433_src$$inline_432$$ = $cpu$$513$$.get_seg_prefix(3) + $cpu$$513$$.regv[$cpu$$513$$.reg_vsi] | 0;
    if (0 !== $cpu$$513$$.repeat_string_prefix) {
      var $count$$inline_436$$ = $cpu$$513$$.regv[$cpu$$513$$.reg_vcx] >>> 0, $start_count$$inline_437$$ = $count$$inline_436$$;
      if (0 === $count$$inline_436$$) {
        break a;
      }
      var $next_cycle$$inline_438$$ = 16384;
      if ($phys_src$$inline_433_src$$inline_432$$ & 3) {
        do {
          $cpu$$513$$.io.port_write32($port$$inline_431$$, $cpu$$513$$.safe_read32s($phys_src$$inline_433_src$$inline_432$$)), $phys_src$$inline_433_src$$inline_432$$ += $size$$inline_434$$, $cpu$$513$$.regv[$cpu$$513$$.reg_vsi] += $size$$inline_434$$, $cont$$inline_435$$ = 0 !== --$cpu$$513$$.regv[$cpu$$513$$.reg_vcx] && !0;
        } while ($cont$$inline_435$$ && $next_cycle$$inline_438$$--);
      } else {
        var $single_size$$inline_439$$ = $size$$inline_434$$ >> 31 | 1;
        $cpu$$513$$.paging && ($next_cycle$$inline_438$$ = ($single_size$$inline_439$$ >> 1 ^ ~$phys_src$$inline_433_src$$inline_432$$) & 4095, $phys_src$$inline_433_src$$inline_432$$ = $cpu$$513$$.translate_address_read($phys_src$$inline_433_src$$inline_432$$), $next_cycle$$inline_438$$ >>= 2);
        $phys_src$$inline_433_src$$inline_432$$ >>>= 2;
        do {
          $cpu$$513$$.io.port_write32($port$$inline_431$$, $cpu$$513$$.memory.read_aligned32($phys_src$$inline_433_src$$inline_432$$)), $phys_src$$inline_433_src$$inline_432$$ += $single_size$$inline_439$$, $cont$$inline_435$$ = 0 !== --$count$$inline_436$$ && !0;
        } while ($cont$$inline_435$$ && $next_cycle$$inline_438$$--);
        $cpu$$513$$.regv[$cpu$$513$$.reg_vsi] += $size$$inline_434$$ * ($start_count$$inline_437$$ - $count$$inline_436$$) | 0;
        $cpu$$513$$.regv[$cpu$$513$$.reg_vcx] = $count$$inline_436$$;
        $cpu$$513$$.timestamp_counter += $start_count$$inline_437$$ - $count$$inline_436$$;
      }
    } else {
      $cpu$$513$$.io.port_write32($port$$inline_431$$, $cpu$$513$$.safe_read32s($phys_src$$inline_433_src$$inline_432$$)), $cpu$$513$$.regv[$cpu$$513$$.reg_vsi] += $size$$inline_434$$;
    }
    $cont$$inline_435$$ && ($cpu$$513$$.instruction_pointer = $cpu$$513$$.previous_ip);
  }
};
$table16$$[112] = $table32$$[112] = function $$table32$$$112$($cpu$$514$$) {
  $cpu$$514$$.test_o() && ($cpu$$514$$.instruction_pointer = $cpu$$514$$.instruction_pointer + $cpu$$514$$.read_imm8s() | 0);
  $cpu$$514$$.instruction_pointer++;
  $cpu$$514$$.last_instr_jump = !0;
};
$table16$$[113] = $table32$$[113] = function $$table32$$$113$($cpu$$515$$) {
  $cpu$$515$$.test_o() || ($cpu$$515$$.instruction_pointer = $cpu$$515$$.instruction_pointer + $cpu$$515$$.read_imm8s() | 0);
  $cpu$$515$$.instruction_pointer++;
  $cpu$$515$$.last_instr_jump = !0;
};
$table16$$[114] = $table32$$[114] = function $$table32$$$114$($cpu$$516$$) {
  $cpu$$516$$.test_b() && ($cpu$$516$$.instruction_pointer = $cpu$$516$$.instruction_pointer + $cpu$$516$$.read_imm8s() | 0);
  $cpu$$516$$.instruction_pointer++;
  $cpu$$516$$.last_instr_jump = !0;
};
$table16$$[115] = $table32$$[115] = function $$table32$$$115$($cpu$$517$$) {
  $cpu$$517$$.test_b() || ($cpu$$517$$.instruction_pointer = $cpu$$517$$.instruction_pointer + $cpu$$517$$.read_imm8s() | 0);
  $cpu$$517$$.instruction_pointer++;
  $cpu$$517$$.last_instr_jump = !0;
};
$table16$$[116] = $table32$$[116] = function $$table32$$$116$($cpu$$518$$) {
  $cpu$$518$$.test_z() && ($cpu$$518$$.instruction_pointer = $cpu$$518$$.instruction_pointer + $cpu$$518$$.read_imm8s() | 0);
  $cpu$$518$$.instruction_pointer++;
  $cpu$$518$$.last_instr_jump = !0;
};
$table16$$[117] = $table32$$[117] = function $$table32$$$117$($cpu$$519$$) {
  $cpu$$519$$.test_z() || ($cpu$$519$$.instruction_pointer = $cpu$$519$$.instruction_pointer + $cpu$$519$$.read_imm8s() | 0);
  $cpu$$519$$.instruction_pointer++;
  $cpu$$519$$.last_instr_jump = !0;
};
$table16$$[118] = $table32$$[118] = function $$table32$$$118$($cpu$$520$$) {
  $cpu$$520$$.test_be() && ($cpu$$520$$.instruction_pointer = $cpu$$520$$.instruction_pointer + $cpu$$520$$.read_imm8s() | 0);
  $cpu$$520$$.instruction_pointer++;
  $cpu$$520$$.last_instr_jump = !0;
};
$table16$$[119] = $table32$$[119] = function $$table32$$$119$($cpu$$521$$) {
  $cpu$$521$$.test_be() || ($cpu$$521$$.instruction_pointer = $cpu$$521$$.instruction_pointer + $cpu$$521$$.read_imm8s() | 0);
  $cpu$$521$$.instruction_pointer++;
  $cpu$$521$$.last_instr_jump = !0;
};
$table16$$[120] = $table32$$[120] = function $$table32$$$120$($cpu$$522$$) {
  $cpu$$522$$.test_s() && ($cpu$$522$$.instruction_pointer = $cpu$$522$$.instruction_pointer + $cpu$$522$$.read_imm8s() | 0);
  $cpu$$522$$.instruction_pointer++;
  $cpu$$522$$.last_instr_jump = !0;
};
$table16$$[121] = $table32$$[121] = function $$table32$$$121$($cpu$$523$$) {
  $cpu$$523$$.test_s() || ($cpu$$523$$.instruction_pointer = $cpu$$523$$.instruction_pointer + $cpu$$523$$.read_imm8s() | 0);
  $cpu$$523$$.instruction_pointer++;
  $cpu$$523$$.last_instr_jump = !0;
};
$table16$$[122] = $table32$$[122] = function $$table32$$$122$($cpu$$524$$) {
  $cpu$$524$$.test_p() && ($cpu$$524$$.instruction_pointer = $cpu$$524$$.instruction_pointer + $cpu$$524$$.read_imm8s() | 0);
  $cpu$$524$$.instruction_pointer++;
  $cpu$$524$$.last_instr_jump = !0;
};
$table16$$[123] = $table32$$[123] = function $$table32$$$123$($cpu$$525$$) {
  $cpu$$525$$.test_p() || ($cpu$$525$$.instruction_pointer = $cpu$$525$$.instruction_pointer + $cpu$$525$$.read_imm8s() | 0);
  $cpu$$525$$.instruction_pointer++;
  $cpu$$525$$.last_instr_jump = !0;
};
$table16$$[124] = $table32$$[124] = function $$table32$$$124$($cpu$$526$$) {
  $cpu$$526$$.test_l() && ($cpu$$526$$.instruction_pointer = $cpu$$526$$.instruction_pointer + $cpu$$526$$.read_imm8s() | 0);
  $cpu$$526$$.instruction_pointer++;
  $cpu$$526$$.last_instr_jump = !0;
};
$table16$$[125] = $table32$$[125] = function $$table32$$$125$($cpu$$527$$) {
  $cpu$$527$$.test_l() || ($cpu$$527$$.instruction_pointer = $cpu$$527$$.instruction_pointer + $cpu$$527$$.read_imm8s() | 0);
  $cpu$$527$$.instruction_pointer++;
  $cpu$$527$$.last_instr_jump = !0;
};
$table16$$[126] = $table32$$[126] = function $$table32$$$126$($cpu$$528$$) {
  $cpu$$528$$.test_le() && ($cpu$$528$$.instruction_pointer = $cpu$$528$$.instruction_pointer + $cpu$$528$$.read_imm8s() | 0);
  $cpu$$528$$.instruction_pointer++;
  $cpu$$528$$.last_instr_jump = !0;
};
$table16$$[127] = $table32$$[127] = function $$table32$$$127$($cpu$$529$$) {
  $cpu$$529$$.test_le() || ($cpu$$529$$.instruction_pointer = $cpu$$529$$.instruction_pointer + $cpu$$529$$.read_imm8s() | 0);
  $cpu$$529$$.instruction_pointer++;
  $cpu$$529$$.last_instr_jump = !0;
};
$table16$$[128] = $table32$$[128] = function $$table32$$$128$($cpu$$530$$) {
  var $modrm_byte$$54$$ = $cpu$$530$$.read_imm8();
  if (56 === ($modrm_byte$$54$$ & 56)) {
    var $data$$78$$ = 192 > $modrm_byte$$54$$ ? $cpu$$530$$.safe_read8($cpu$$530$$.modrm_resolve($modrm_byte$$54$$)) : $cpu$$530$$.reg8[$modrm_byte$$54$$ << 2 & 12 | $modrm_byte$$54$$ >> 2 & 1];
    $cpu$$530$$.sub($data$$78$$, $cpu$$530$$.read_imm8(), 7);
  } else {
    var $data2$$, $addr$$16$$, $result$$45$$;
    192 > $modrm_byte$$54$$ ? ($addr$$16$$ = $cpu$$530$$.translate_address_write($cpu$$530$$.modrm_resolve($modrm_byte$$54$$)), $data$$78$$ = $cpu$$530$$.memory.read8($addr$$16$$)) : $data$$78$$ = $cpu$$530$$.reg8[$modrm_byte$$54$$ << 2 & 12 | $modrm_byte$$54$$ >> 2 & 1];
    $result$$45$$ = 0;
    $data2$$ = $cpu$$530$$.read_imm8();
    switch($modrm_byte$$54$$ >> 3 & 7) {
      case 0:
        $result$$45$$ = $cpu$$530$$.add($data$$78$$, $data2$$, 7);
        break;
      case 1:
        $result$$45$$ = $cpu$$530$$.or($data$$78$$, $data2$$, 7);
        break;
      case 2:
        $result$$45$$ = $cpu$$530$$.adc($data$$78$$, $data2$$, 7);
        break;
      case 3:
        $result$$45$$ = $cpu$$530$$.sbb($data$$78$$, $data2$$, 7);
        break;
      case 4:
        $result$$45$$ = $cpu$$530$$.and($data$$78$$, $data2$$, 7);
        break;
      case 5:
        $result$$45$$ = $cpu$$530$$.sub($data$$78$$, $data2$$, 7);
        break;
      case 6:
        $result$$45$$ = $cpu$$530$$.xor($data$$78$$, $data2$$, 7);
        break;
      case 7:
        $result$$45$$ = $dbg_assert$$.bind(this, 0)($data$$78$$, $data2$$);
    }
    192 > $modrm_byte$$54$$ ? $cpu$$530$$.memory.write8($addr$$16$$, $result$$45$$) : $cpu$$530$$.reg8[$modrm_byte$$54$$ << 2 & 12 | $modrm_byte$$54$$ >> 2 & 1] = $result$$45$$;
  }
};
$table16$$[129] = function $$table16$$$129$($cpu$$531$$) {
  var $modrm_byte$$55$$ = $cpu$$531$$.read_imm8();
  if (56 === ($modrm_byte$$55$$ & 56)) {
    var $data$$79_virt_addr$$19$$ = 192 > $modrm_byte$$55$$ ? $cpu$$531$$.safe_read16($cpu$$531$$.modrm_resolve($modrm_byte$$55$$)) : $cpu$$531$$.reg16[$modrm_byte$$55$$ << 1 & 14];
    $cpu$$531$$.sub($data$$79_virt_addr$$19$$, $cpu$$531$$.read_imm16(), 15);
  } else {
    var $data2$$1$$, $phys_addr$$18$$, $phys_addr_high$$15$$ = 0, $result$$46$$;
    192 > $modrm_byte$$55$$ ? ($data$$79_virt_addr$$19$$ = $cpu$$531$$.modrm_resolve($modrm_byte$$55$$), $phys_addr$$18$$ = $cpu$$531$$.translate_address_write($data$$79_virt_addr$$19$$), $cpu$$531$$.paging && 4095 === ($data$$79_virt_addr$$19$$ & 4095) ? ($phys_addr_high$$15$$ = $cpu$$531$$.translate_address_write($data$$79_virt_addr$$19$$ + 1), $data$$79_virt_addr$$19$$ = $cpu$$531$$.virt_boundary_read16($phys_addr$$18$$, $phys_addr_high$$15$$)) : $data$$79_virt_addr$$19$$ = $cpu$$531$$.memory.read16($phys_addr$$18$$)) : 
    $data$$79_virt_addr$$19$$ = $cpu$$531$$.reg16[$modrm_byte$$55$$ << 1 & 14];
    $result$$46$$ = 0;
    $data2$$1$$ = $cpu$$531$$.read_imm16();
    switch($modrm_byte$$55$$ >> 3 & 7) {
      case 0:
        $result$$46$$ = $cpu$$531$$.add($data$$79_virt_addr$$19$$, $data2$$1$$, 15);
        break;
      case 1:
        $result$$46$$ = $cpu$$531$$.or($data$$79_virt_addr$$19$$, $data2$$1$$, 15);
        break;
      case 2:
        $result$$46$$ = $cpu$$531$$.adc($data$$79_virt_addr$$19$$, $data2$$1$$, 15);
        break;
      case 3:
        $result$$46$$ = $cpu$$531$$.sbb($data$$79_virt_addr$$19$$, $data2$$1$$, 15);
        break;
      case 4:
        $result$$46$$ = $cpu$$531$$.and($data$$79_virt_addr$$19$$, $data2$$1$$, 15);
        break;
      case 5:
        $result$$46$$ = $cpu$$531$$.sub($data$$79_virt_addr$$19$$, $data2$$1$$, 15);
        break;
      case 6:
        $result$$46$$ = $cpu$$531$$.xor($data$$79_virt_addr$$19$$, $data2$$1$$, 15);
        break;
      case 7:
        $result$$46$$ = $dbg_assert$$.bind(this, 0)($data$$79_virt_addr$$19$$, $data2$$1$$);
    }
    192 > $modrm_byte$$55$$ ? $phys_addr_high$$15$$ ? $cpu$$531$$.virt_boundary_write16($phys_addr$$18$$, $phys_addr_high$$15$$, $result$$46$$) : $cpu$$531$$.memory.write16($phys_addr$$18$$, $result$$46$$) : $cpu$$531$$.reg16[$modrm_byte$$55$$ << 1 & 14] = $result$$46$$;
  }
};
$table32$$[129] = function $$table32$$$129$($cpu$$532$$) {
  var $modrm_byte$$56$$ = $cpu$$532$$.read_imm8();
  if (56 === ($modrm_byte$$56$$ & 56)) {
    var $data$$80_virt_addr$$20$$ = 192 > $modrm_byte$$56$$ ? $cpu$$532$$.safe_read32s($cpu$$532$$.modrm_resolve($modrm_byte$$56$$)) : $cpu$$532$$.reg32s[$modrm_byte$$56$$ & 7];
    $cpu$$532$$.sub($data$$80_virt_addr$$20$$, $cpu$$532$$.read_imm32s(), 31);
  } else {
    var $data2$$2$$, $phys_addr$$19$$, $phys_addr_high$$16$$ = 0, $result$$47$$;
    192 > $modrm_byte$$56$$ ? ($data$$80_virt_addr$$20$$ = $cpu$$532$$.modrm_resolve($modrm_byte$$56$$), $phys_addr$$19$$ = $cpu$$532$$.translate_address_write($data$$80_virt_addr$$20$$), $cpu$$532$$.paging && 4093 <= ($data$$80_virt_addr$$20$$ & 4095) ? ($phys_addr_high$$16$$ = $cpu$$532$$.translate_address_write($data$$80_virt_addr$$20$$ + 3), $data$$80_virt_addr$$20$$ = $cpu$$532$$.virt_boundary_read32s($phys_addr$$19$$, $phys_addr_high$$16$$)) : $data$$80_virt_addr$$20$$ = $cpu$$532$$.memory.read32s($phys_addr$$19$$)) : 
    $data$$80_virt_addr$$20$$ = $cpu$$532$$.reg32s[$modrm_byte$$56$$ & 7];
    $result$$47$$ = 0;
    $data2$$2$$ = $cpu$$532$$.read_imm32s();
    switch($modrm_byte$$56$$ >> 3 & 7) {
      case 0:
        $result$$47$$ = $cpu$$532$$.add($data$$80_virt_addr$$20$$, $data2$$2$$, 31);
        break;
      case 1:
        $result$$47$$ = $cpu$$532$$.or($data$$80_virt_addr$$20$$, $data2$$2$$, 31);
        break;
      case 2:
        $result$$47$$ = $cpu$$532$$.adc($data$$80_virt_addr$$20$$, $data2$$2$$, 31);
        break;
      case 3:
        $result$$47$$ = $cpu$$532$$.sbb($data$$80_virt_addr$$20$$, $data2$$2$$, 31);
        break;
      case 4:
        $result$$47$$ = $cpu$$532$$.and($data$$80_virt_addr$$20$$, $data2$$2$$, 31);
        break;
      case 5:
        $result$$47$$ = $cpu$$532$$.sub($data$$80_virt_addr$$20$$, $data2$$2$$, 31);
        break;
      case 6:
        $result$$47$$ = $cpu$$532$$.xor($data$$80_virt_addr$$20$$, $data2$$2$$, 31);
        break;
      case 7:
        $result$$47$$ = $dbg_assert$$.bind(this, 0)($data$$80_virt_addr$$20$$, $data2$$2$$);
    }
    192 > $modrm_byte$$56$$ ? $phys_addr_high$$16$$ ? $cpu$$532$$.virt_boundary_write32($phys_addr$$19$$, $phys_addr_high$$16$$, $result$$47$$) : $cpu$$532$$.memory.write32($phys_addr$$19$$, $result$$47$$) : $cpu$$532$$.reg32s[$modrm_byte$$56$$ & 7] = $result$$47$$;
  }
};
$table16$$[130] = $table32$$[130] = function $$table32$$$130$($cpu$$533$$) {
  $cpu$$533$$.table[128]($cpu$$533$$);
};
$table16$$[131] = function $$table16$$$131$($cpu$$534$$) {
  var $modrm_byte$$57$$ = $cpu$$534$$.read_imm8();
  if (56 === ($modrm_byte$$57$$ & 56)) {
    var $data$$81_virt_addr$$21$$ = 192 > $modrm_byte$$57$$ ? $cpu$$534$$.safe_read16($cpu$$534$$.modrm_resolve($modrm_byte$$57$$)) : $cpu$$534$$.reg16[$modrm_byte$$57$$ << 1 & 14];
    $cpu$$534$$.sub($data$$81_virt_addr$$21$$, $cpu$$534$$.read_imm8s(), 15);
  } else {
    var $data2$$3$$, $phys_addr$$20$$, $phys_addr_high$$17$$ = 0, $result$$48$$;
    192 > $modrm_byte$$57$$ ? ($data$$81_virt_addr$$21$$ = $cpu$$534$$.modrm_resolve($modrm_byte$$57$$), $phys_addr$$20$$ = $cpu$$534$$.translate_address_write($data$$81_virt_addr$$21$$), $cpu$$534$$.paging && 4095 === ($data$$81_virt_addr$$21$$ & 4095) ? ($phys_addr_high$$17$$ = $cpu$$534$$.translate_address_write($data$$81_virt_addr$$21$$ + 1), $data$$81_virt_addr$$21$$ = $cpu$$534$$.virt_boundary_read16($phys_addr$$20$$, $phys_addr_high$$17$$)) : $data$$81_virt_addr$$21$$ = $cpu$$534$$.memory.read16($phys_addr$$20$$)) : 
    $data$$81_virt_addr$$21$$ = $cpu$$534$$.reg16[$modrm_byte$$57$$ << 1 & 14];
    $result$$48$$ = 0;
    $data2$$3$$ = $cpu$$534$$.read_imm8s();
    switch($modrm_byte$$57$$ >> 3 & 7) {
      case 0:
        $result$$48$$ = $cpu$$534$$.add($data$$81_virt_addr$$21$$, $data2$$3$$, 15);
        break;
      case 1:
        $result$$48$$ = $cpu$$534$$.or($data$$81_virt_addr$$21$$, $data2$$3$$, 15);
        break;
      case 2:
        $result$$48$$ = $cpu$$534$$.adc($data$$81_virt_addr$$21$$, $data2$$3$$, 15);
        break;
      case 3:
        $result$$48$$ = $cpu$$534$$.sbb($data$$81_virt_addr$$21$$, $data2$$3$$, 15);
        break;
      case 4:
        $result$$48$$ = $cpu$$534$$.and($data$$81_virt_addr$$21$$, $data2$$3$$, 15);
        break;
      case 5:
        $result$$48$$ = $cpu$$534$$.sub($data$$81_virt_addr$$21$$, $data2$$3$$, 15);
        break;
      case 6:
        $result$$48$$ = $cpu$$534$$.xor($data$$81_virt_addr$$21$$, $data2$$3$$, 15);
        break;
      case 7:
        $result$$48$$ = $dbg_assert$$.bind(this, 0)($data$$81_virt_addr$$21$$, $data2$$3$$);
    }
    192 > $modrm_byte$$57$$ ? $phys_addr_high$$17$$ ? $cpu$$534$$.virt_boundary_write16($phys_addr$$20$$, $phys_addr_high$$17$$, $result$$48$$) : $cpu$$534$$.memory.write16($phys_addr$$20$$, $result$$48$$) : $cpu$$534$$.reg16[$modrm_byte$$57$$ << 1 & 14] = $result$$48$$;
  }
};
$table32$$[131] = function $$table32$$$131$($cpu$$535$$) {
  var $modrm_byte$$58$$ = $cpu$$535$$.read_imm8();
  if (56 === ($modrm_byte$$58$$ & 56)) {
    var $data$$82_virt_addr$$22$$ = 192 > $modrm_byte$$58$$ ? $cpu$$535$$.safe_read32s($cpu$$535$$.modrm_resolve($modrm_byte$$58$$)) : $cpu$$535$$.reg32s[$modrm_byte$$58$$ & 7];
    $cpu$$535$$.sub($data$$82_virt_addr$$22$$, $cpu$$535$$.read_imm8s(), 31);
  } else {
    var $data2$$4$$, $phys_addr$$21$$, $phys_addr_high$$18$$ = 0, $result$$49$$;
    192 > $modrm_byte$$58$$ ? ($data$$82_virt_addr$$22$$ = $cpu$$535$$.modrm_resolve($modrm_byte$$58$$), $phys_addr$$21$$ = $cpu$$535$$.translate_address_write($data$$82_virt_addr$$22$$), $cpu$$535$$.paging && 4093 <= ($data$$82_virt_addr$$22$$ & 4095) ? ($phys_addr_high$$18$$ = $cpu$$535$$.translate_address_write($data$$82_virt_addr$$22$$ + 3), $data$$82_virt_addr$$22$$ = $cpu$$535$$.virt_boundary_read32s($phys_addr$$21$$, $phys_addr_high$$18$$)) : $data$$82_virt_addr$$22$$ = $cpu$$535$$.memory.read32s($phys_addr$$21$$)) : 
    $data$$82_virt_addr$$22$$ = $cpu$$535$$.reg32s[$modrm_byte$$58$$ & 7];
    $result$$49$$ = 0;
    $data2$$4$$ = $cpu$$535$$.read_imm8s();
    switch($modrm_byte$$58$$ >> 3 & 7) {
      case 0:
        $result$$49$$ = $cpu$$535$$.add($data$$82_virt_addr$$22$$, $data2$$4$$, 31);
        break;
      case 1:
        $result$$49$$ = $cpu$$535$$.or($data$$82_virt_addr$$22$$, $data2$$4$$, 31);
        break;
      case 2:
        $result$$49$$ = $cpu$$535$$.adc($data$$82_virt_addr$$22$$, $data2$$4$$, 31);
        break;
      case 3:
        $result$$49$$ = $cpu$$535$$.sbb($data$$82_virt_addr$$22$$, $data2$$4$$, 31);
        break;
      case 4:
        $result$$49$$ = $cpu$$535$$.and($data$$82_virt_addr$$22$$, $data2$$4$$, 31);
        break;
      case 5:
        $result$$49$$ = $cpu$$535$$.sub($data$$82_virt_addr$$22$$, $data2$$4$$, 31);
        break;
      case 6:
        $result$$49$$ = $cpu$$535$$.xor($data$$82_virt_addr$$22$$, $data2$$4$$, 31);
        break;
      case 7:
        $result$$49$$ = $dbg_assert$$.bind(this, 0)($data$$82_virt_addr$$22$$, $data2$$4$$);
    }
    192 > $modrm_byte$$58$$ ? $phys_addr_high$$18$$ ? $cpu$$535$$.virt_boundary_write32($phys_addr$$21$$, $phys_addr_high$$18$$, $result$$49$$) : $cpu$$535$$.memory.write32($phys_addr$$21$$, $result$$49$$) : $cpu$$535$$.reg32s[$modrm_byte$$58$$ & 7] = $result$$49$$;
  }
};
$table16$$[132] = $table32$$[132] = function $$table32$$$132$($cpu$$536$$) {
  var $modrm_byte$$59$$ = $cpu$$536$$.read_imm8(), $data$$83$$ = 192 > $modrm_byte$$59$$ ? $cpu$$536$$.safe_read8($cpu$$536$$.modrm_resolve($modrm_byte$$59$$)) : $cpu$$536$$.reg8[$modrm_byte$$59$$ << 2 & 12 | $modrm_byte$$59$$ >> 2 & 1];
  $cpu$$536$$.and($data$$83$$, $cpu$$536$$.reg8[$modrm_byte$$59$$ >> 1 & 12 | $modrm_byte$$59$$ >> 5 & 1], 7);
};
$table16$$[133] = function $$table16$$$133$($cpu$$537$$) {
  var $modrm_byte$$60$$ = $cpu$$537$$.read_imm8(), $data$$84$$ = 192 > $modrm_byte$$60$$ ? $cpu$$537$$.safe_read16($cpu$$537$$.modrm_resolve($modrm_byte$$60$$)) : $cpu$$537$$.reg16[$modrm_byte$$60$$ << 1 & 14];
  $cpu$$537$$.and($data$$84$$, $cpu$$537$$.reg16[$modrm_byte$$60$$ >> 2 & 14], 15);
};
$table32$$[133] = function $$table32$$$133$($cpu$$538$$) {
  var $modrm_byte$$61$$ = $cpu$$538$$.read_imm8(), $data$$85$$ = 192 > $modrm_byte$$61$$ ? $cpu$$538$$.safe_read32s($cpu$$538$$.modrm_resolve($modrm_byte$$61$$)) : $cpu$$538$$.reg32s[$modrm_byte$$61$$ & 7];
  $cpu$$538$$.and($data$$85$$, $cpu$$538$$.reg32s[$modrm_byte$$61$$ >> 3 & 7], 31);
};
$table16$$[134] = $table32$$[134] = function $$table32$$$134$($cpu$$539$$) {
  var $modrm_byte$$62$$ = $cpu$$539$$.read_imm8(), $data$$86_result$$50$$, $addr$$17$$;
  192 > $modrm_byte$$62$$ ? ($addr$$17$$ = $cpu$$539$$.translate_address_write($cpu$$539$$.modrm_resolve($modrm_byte$$62$$)), $data$$86_result$$50$$ = $cpu$$539$$.memory.read8($addr$$17$$)) : $data$$86_result$$50$$ = $cpu$$539$$.reg8[$modrm_byte$$62$$ << 2 & 12 | $modrm_byte$$62$$ >> 2 & 1];
  $data$$86_result$$50$$ = $cpu$$539$$.xchg8($data$$86_result$$50$$, $modrm_byte$$62$$);
  192 > $modrm_byte$$62$$ ? $cpu$$539$$.memory.write8($addr$$17$$, $data$$86_result$$50$$) : $cpu$$539$$.reg8[$modrm_byte$$62$$ << 2 & 12 | $modrm_byte$$62$$ >> 2 & 1] = $data$$86_result$$50$$;
};
$table16$$[135] = function $$table16$$$135$($cpu$$540$$) {
  var $modrm_byte$$63$$ = $cpu$$540$$.read_imm8(), $data$$87_result$$51_virt_addr$$23$$, $phys_addr$$22$$, $phys_addr_high$$19$$ = 0;
  192 > $modrm_byte$$63$$ ? ($data$$87_result$$51_virt_addr$$23$$ = $cpu$$540$$.modrm_resolve($modrm_byte$$63$$), $phys_addr$$22$$ = $cpu$$540$$.translate_address_write($data$$87_result$$51_virt_addr$$23$$), $cpu$$540$$.paging && 4095 === ($data$$87_result$$51_virt_addr$$23$$ & 4095) ? ($phys_addr_high$$19$$ = $cpu$$540$$.translate_address_write($data$$87_result$$51_virt_addr$$23$$ + 1), $data$$87_result$$51_virt_addr$$23$$ = $cpu$$540$$.virt_boundary_read16($phys_addr$$22$$, $phys_addr_high$$19$$)) : 
  $data$$87_result$$51_virt_addr$$23$$ = $cpu$$540$$.memory.read16($phys_addr$$22$$)) : $data$$87_result$$51_virt_addr$$23$$ = $cpu$$540$$.reg16[$modrm_byte$$63$$ << 1 & 14];
  $data$$87_result$$51_virt_addr$$23$$ = $cpu$$540$$.xchg16($data$$87_result$$51_virt_addr$$23$$, $modrm_byte$$63$$);
  192 > $modrm_byte$$63$$ ? $phys_addr_high$$19$$ ? $cpu$$540$$.virt_boundary_write16($phys_addr$$22$$, $phys_addr_high$$19$$, $data$$87_result$$51_virt_addr$$23$$) : $cpu$$540$$.memory.write16($phys_addr$$22$$, $data$$87_result$$51_virt_addr$$23$$) : $cpu$$540$$.reg16[$modrm_byte$$63$$ << 1 & 14] = $data$$87_result$$51_virt_addr$$23$$;
};
$table32$$[135] = function $$table32$$$135$($cpu$$541$$) {
  var $modrm_byte$$64$$ = $cpu$$541$$.read_imm8(), $data$$88_result$$52_virt_addr$$24$$, $phys_addr$$23$$, $phys_addr_high$$20$$ = 0;
  192 > $modrm_byte$$64$$ ? ($data$$88_result$$52_virt_addr$$24$$ = $cpu$$541$$.modrm_resolve($modrm_byte$$64$$), $phys_addr$$23$$ = $cpu$$541$$.translate_address_write($data$$88_result$$52_virt_addr$$24$$), $cpu$$541$$.paging && 4093 <= ($data$$88_result$$52_virt_addr$$24$$ & 4095) ? ($phys_addr_high$$20$$ = $cpu$$541$$.translate_address_write($data$$88_result$$52_virt_addr$$24$$ + 3), $data$$88_result$$52_virt_addr$$24$$ = $cpu$$541$$.virt_boundary_read32s($phys_addr$$23$$, $phys_addr_high$$20$$)) : 
  $data$$88_result$$52_virt_addr$$24$$ = $cpu$$541$$.memory.read32s($phys_addr$$23$$)) : $data$$88_result$$52_virt_addr$$24$$ = $cpu$$541$$.reg32s[$modrm_byte$$64$$ & 7];
  $data$$88_result$$52_virt_addr$$24$$ = $cpu$$541$$.xchg32($data$$88_result$$52_virt_addr$$24$$, $modrm_byte$$64$$);
  192 > $modrm_byte$$64$$ ? $phys_addr_high$$20$$ ? $cpu$$541$$.virt_boundary_write32($phys_addr$$23$$, $phys_addr_high$$20$$, $data$$88_result$$52_virt_addr$$24$$) : $cpu$$541$$.memory.write32($phys_addr$$23$$, $data$$88_result$$52_virt_addr$$24$$) : $cpu$$541$$.reg32s[$modrm_byte$$64$$ & 7] = $data$$88_result$$52_virt_addr$$24$$;
};
$table16$$[136] = $table32$$[136] = function $$table32$$$136$($cpu$$542$$) {
  var $modrm_byte$$65$$ = $cpu$$542$$.read_imm8();
  if (192 > $modrm_byte$$65$$) {
    var $addr$$18$$ = $cpu$$542$$.modrm_resolve($modrm_byte$$65$$)
  }
  var $data$$89$$ = $cpu$$542$$.reg8[$modrm_byte$$65$$ >> 1 & 12 | $modrm_byte$$65$$ >> 5 & 1];
  192 > $modrm_byte$$65$$ ? $cpu$$542$$.safe_write8($addr$$18$$, $data$$89$$) : $cpu$$542$$.reg8[$modrm_byte$$65$$ << 2 & 12 | $modrm_byte$$65$$ >> 2 & 1] = $data$$89$$;
};
$table16$$[137] = function $$table16$$$137$($cpu$$543$$) {
  var $modrm_byte$$66$$ = $cpu$$543$$.read_imm8();
  if (192 > $modrm_byte$$66$$) {
    var $addr$$19$$ = $cpu$$543$$.modrm_resolve($modrm_byte$$66$$)
  }
  var $data$$90$$ = $cpu$$543$$.reg16[$modrm_byte$$66$$ >> 2 & 14];
  192 > $modrm_byte$$66$$ ? $cpu$$543$$.safe_write16($addr$$19$$, $data$$90$$) : $cpu$$543$$.reg16[$modrm_byte$$66$$ << 1 & 14] = $data$$90$$;
};
$table32$$[137] = function $$table32$$$137$($cpu$$544$$) {
  var $modrm_byte$$67$$ = $cpu$$544$$.read_imm8();
  if (192 > $modrm_byte$$67$$) {
    var $addr$$20$$ = $cpu$$544$$.modrm_resolve($modrm_byte$$67$$)
  }
  var $data$$91$$ = $cpu$$544$$.reg32s[$modrm_byte$$67$$ >> 3 & 7];
  192 > $modrm_byte$$67$$ ? $cpu$$544$$.safe_write32($addr$$20$$, $data$$91$$) : $cpu$$544$$.reg32[$modrm_byte$$67$$ & 7] = $data$$91$$;
};
$table16$$[138] = $table32$$[138] = function $$table32$$$138$($cpu$$545$$) {
  var $modrm_byte$$68$$ = $cpu$$545$$.read_imm8(), $data$$92$$ = 192 > $modrm_byte$$68$$ ? $cpu$$545$$.safe_read8($cpu$$545$$.modrm_resolve($modrm_byte$$68$$)) : $cpu$$545$$.reg8[$modrm_byte$$68$$ << 2 & 12 | $modrm_byte$$68$$ >> 2 & 1];
  $cpu$$545$$.reg8[$modrm_byte$$68$$ >> 1 & 12 | $modrm_byte$$68$$ >> 5 & 1] = $data$$92$$;
};
$table16$$[139] = function $$table16$$$139$($cpu$$546$$) {
  var $modrm_byte$$69$$ = $cpu$$546$$.read_imm8(), $data$$93$$ = 192 > $modrm_byte$$69$$ ? $cpu$$546$$.safe_read16($cpu$$546$$.modrm_resolve($modrm_byte$$69$$)) : $cpu$$546$$.reg16[$modrm_byte$$69$$ << 1 & 14];
  $cpu$$546$$.reg16[$modrm_byte$$69$$ >> 2 & 14] = $data$$93$$;
};
$table32$$[139] = function $$table32$$$139$($cpu$$547$$) {
  var $modrm_byte$$70$$ = $cpu$$547$$.read_imm8(), $data$$94$$ = 192 > $modrm_byte$$70$$ ? $cpu$$547$$.safe_read32s($cpu$$547$$.modrm_resolve($modrm_byte$$70$$)) : $cpu$$547$$.reg32s[$modrm_byte$$70$$ & 7];
  $cpu$$547$$.reg32s[$modrm_byte$$70$$ >> 3 & 7] = $data$$94$$;
};
$table16$$[140] = function $$table16$$$140$($cpu$$548$$) {
  var $modrm_byte$$71$$ = $cpu$$548$$.read_imm8();
  if (192 > $modrm_byte$$71$$) {
    var $addr$$21$$ = $cpu$$548$$.modrm_resolve($modrm_byte$$71$$)
  }
  var $data$$95$$ = $cpu$$548$$.sreg[$modrm_byte$$71$$ >> 3 & 7];
  192 > $modrm_byte$$71$$ ? $cpu$$548$$.safe_write16($addr$$21$$, $data$$95$$) : $cpu$$548$$.reg16[$modrm_byte$$71$$ << 1 & 14] = $data$$95$$;
};
$table32$$[140] = function $$table32$$$140$($cpu$$549$$) {
  var $modrm_byte$$72$$ = $cpu$$549$$.read_imm8();
  if (192 > $modrm_byte$$72$$) {
    var $addr$$22$$ = $cpu$$549$$.modrm_resolve($modrm_byte$$72$$)
  }
  var $data$$96$$ = $cpu$$549$$.sreg[$modrm_byte$$72$$ >> 3 & 7];
  192 > $modrm_byte$$72$$ ? $cpu$$549$$.safe_write32($addr$$22$$, $data$$96$$) : $cpu$$549$$.reg32[$modrm_byte$$72$$ & 7] = $data$$96$$;
};
$table16$$[141] = function $$table16$$$141$($cpu$$550$$) {
  var $modrm_byte$$73$$ = $cpu$$550$$.read_imm8();
  192 <= $modrm_byte$$73$$ && $cpu$$550$$.trigger_ud();
  $cpu$$550$$.segment_prefix = 9;
  $cpu$$550$$.reg16[($modrm_byte$$73$$ >> 3 & 7) << 1] = $cpu$$550$$.modrm_resolve($modrm_byte$$73$$);
  $cpu$$550$$.segment_prefix = -1;
};
$table32$$[141] = function $$table32$$$141$($cpu$$551$$) {
  var $modrm_byte$$74$$ = $cpu$$551$$.read_imm8();
  192 <= $modrm_byte$$74$$ && $cpu$$551$$.trigger_ud();
  $cpu$$551$$.segment_prefix = 9;
  $cpu$$551$$.reg32s[$modrm_byte$$74$$ >> 3 & 7] = $cpu$$551$$.modrm_resolve($modrm_byte$$74$$);
  $cpu$$551$$.segment_prefix = -1;
};
$table16$$[142] = $table32$$[142] = function $$table32$$$142$($cpu$$552$$) {
  var $data$$97_modrm_byte$$75$$ = $cpu$$552$$.read_imm8(), $mod$$260$$ = $data$$97_modrm_byte$$75$$ >> 3 & 7, $data$$97_modrm_byte$$75$$ = 192 > $data$$97_modrm_byte$$75$$ ? $cpu$$552$$.safe_read16($cpu$$552$$.modrm_resolve($data$$97_modrm_byte$$75$$)) : $cpu$$552$$.reg16[$data$$97_modrm_byte$$75$$ << 1 & 14];
  $cpu$$552$$.switch_seg($mod$$260$$, $data$$97_modrm_byte$$75$$);
};
$table16$$[143] = function $$table16$$$143$($cpu$$553$$) {
  var $addr$$23_modrm_byte$$76$$ = $cpu$$553$$.read_imm8(), $sp$$ = $cpu$$553$$.safe_read16($cpu$$553$$.get_stack_pointer(0));
  $cpu$$553$$.stack_reg[$cpu$$553$$.reg_vsp] += 2;
  192 > $addr$$23_modrm_byte$$76$$ ? ($addr$$23_modrm_byte$$76$$ = $cpu$$553$$.modrm_resolve($addr$$23_modrm_byte$$76$$), $cpu$$553$$.stack_reg[$cpu$$553$$.reg_vsp] -= 2, $cpu$$553$$.safe_write16($addr$$23_modrm_byte$$76$$, $sp$$), $cpu$$553$$.stack_reg[$cpu$$553$$.reg_vsp] += 2) : $cpu$$553$$.reg16[$addr$$23_modrm_byte$$76$$ << 1 & 14] = $sp$$;
};
$table32$$[143] = function $$table32$$$143$($cpu$$554$$) {
  var $addr$$24_modrm_byte$$77$$ = $cpu$$554$$.read_imm8(), $sp$$1$$ = $cpu$$554$$.safe_read32s($cpu$$554$$.get_stack_pointer(0));
  $cpu$$554$$.stack_reg[$cpu$$554$$.reg_vsp] += 4;
  192 > $addr$$24_modrm_byte$$77$$ ? ($addr$$24_modrm_byte$$77$$ = $cpu$$554$$.modrm_resolve($addr$$24_modrm_byte$$77$$), $cpu$$554$$.stack_reg[$cpu$$554$$.reg_vsp] -= 4, $cpu$$554$$.safe_write32($addr$$24_modrm_byte$$77$$, $sp$$1$$), $cpu$$554$$.stack_reg[$cpu$$554$$.reg_vsp] += 4) : $cpu$$554$$.reg32s[$addr$$24_modrm_byte$$77$$ & 7] = $sp$$1$$;
};
$table16$$[144] = function $$table16$$$144$($cpu$$555$$) {
  $cpu$$555$$.xchg16r(0);
};
$table32$$[144] = function $$table32$$$144$($cpu$$556$$) {
  $cpu$$556$$.xchg32r(0);
};
$table16$$[145] = function $$table16$$$145$($cpu$$557$$) {
  $cpu$$557$$.xchg16r(2);
};
$table32$$[145] = function $$table32$$$145$($cpu$$558$$) {
  $cpu$$558$$.xchg32r(1);
};
$table16$$[146] = function $$table16$$$146$($cpu$$559$$) {
  $cpu$$559$$.xchg16r(4);
};
$table32$$[146] = function $$table32$$$146$($cpu$$560$$) {
  $cpu$$560$$.xchg32r(2);
};
$table16$$[147] = function $$table16$$$147$($cpu$$561$$) {
  $cpu$$561$$.xchg16r(6);
};
$table32$$[147] = function $$table32$$$147$($cpu$$562$$) {
  $cpu$$562$$.xchg32r(3);
};
$table16$$[148] = function $$table16$$$148$($cpu$$563$$) {
  $cpu$$563$$.xchg16r(8);
};
$table32$$[148] = function $$table32$$$148$($cpu$$564$$) {
  $cpu$$564$$.xchg32r(4);
};
$table16$$[149] = function $$table16$$$149$($cpu$$565$$) {
  $cpu$$565$$.xchg16r(10);
};
$table32$$[149] = function $$table32$$$149$($cpu$$566$$) {
  $cpu$$566$$.xchg32r(5);
};
$table16$$[150] = function $$table16$$$150$($cpu$$567$$) {
  $cpu$$567$$.xchg16r(12);
};
$table32$$[150] = function $$table32$$$150$($cpu$$568$$) {
  $cpu$$568$$.xchg32r(6);
};
$table16$$[151] = function $$table16$$$151$($cpu$$569$$) {
  $cpu$$569$$.xchg16r(14);
};
$table32$$[151] = function $$table32$$$151$($cpu$$570$$) {
  $cpu$$570$$.xchg32r(7);
};
$table16$$[144] = $table32$$[144] = function $$table32$$$144$() {
};
$table16$$[152] = function $$table16$$$152$($cpu$$572$$) {
  $cpu$$572$$.reg16[0] = $cpu$$572$$.reg8s[0];
};
$table32$$[152] = function $$table32$$$152$($cpu$$573$$) {
  $cpu$$573$$.reg32s[0] = $cpu$$573$$.reg16s[0];
};
$table16$$[153] = function $$table16$$$153$($cpu$$574$$) {
  $cpu$$574$$.reg16[4] = $cpu$$574$$.reg16s[0] >> 15;
};
$table32$$[153] = function $$table32$$$153$($cpu$$575$$) {
  $cpu$$575$$.reg32s[2] = $cpu$$575$$.reg32s[0] >> 31;
};
$table16$$[154] = function $$table16$$$154$($cpu$$576$$) {
  var $new_ip$$ = $cpu$$576$$.read_imm16(), $new_cs$$ = $cpu$$576$$.read_imm16();
  $cpu$$576$$.writable_or_pagefault($cpu$$576$$.get_stack_pointer(-4), 4);
  $cpu$$576$$.push16($cpu$$576$$.sreg[1]);
  $cpu$$576$$.push16($cpu$$576$$.get_real_eip());
  $cpu$$576$$.switch_seg(1, $new_cs$$);
  $cpu$$576$$.instruction_pointer = $cpu$$576$$.get_seg(1) + $new_ip$$ | 0;
  $cpu$$576$$.last_instr_jump = !0;
};
$table32$$[154] = function $$table32$$$154$($cpu$$577$$) {
  var $new_ip$$1$$ = $cpu$$577$$.read_imm32s(), $new_cs$$1$$ = $cpu$$577$$.read_imm16();
  $cpu$$577$$.writable_or_pagefault($cpu$$577$$.get_stack_pointer(-8), 8);
  $cpu$$577$$.push32($cpu$$577$$.sreg[1]);
  $cpu$$577$$.push32($cpu$$577$$.get_real_eip());
  $cpu$$577$$.switch_seg(1, $new_cs$$1$$);
  $cpu$$577$$.instruction_pointer = $cpu$$577$$.get_seg(1) + $new_ip$$1$$ | 0;
  $cpu$$577$$.last_instr_jump = !0;
};
$table16$$[155] = $table32$$[155] = function $$table32$$$155$($cpu$$578$$) {
  10 === ($cpu$$578$$.cr0 & 10) && $cpu$$578$$.trigger_nm();
};
$table16$$[156] = function $$table16$$$156$($cpu$$579$$) {
  $cpu$$579$$.flags & 131072 && 3 > ($cpu$$579$$.flags >> 12 & 3) ? $cpu$$579$$.trigger_gp(0) : ($cpu$$579$$.load_eflags(), $cpu$$579$$.push16($cpu$$579$$.flags));
};
$table32$$[156] = function $$table32$$$156$($cpu$$580$$) {
  $cpu$$580$$.flags & 131072 && 3 > ($cpu$$580$$.flags >> 12 & 3) ? $cpu$$580$$.trigger_gp(0) : ($cpu$$580$$.load_eflags(), $cpu$$580$$.push32($cpu$$580$$.flags & -196609));
};
$table16$$[157] = function $$table16$$$157$($cpu$$581$$) {
  $cpu$$581$$.flags & 131072 && 3 > ($cpu$$581$$.flags >> 12 & 3) && $cpu$$581$$.trigger_gp(0);
  $cpu$$581$$.update_eflags($cpu$$581$$.flags & -65536 | $cpu$$581$$.pop16());
  $cpu$$581$$.handle_irqs();
};
$table32$$[157] = function $$table32$$$157$($cpu$$582$$) {
  $cpu$$582$$.flags & 131072 && 3 > ($cpu$$582$$.flags >> 12 & 3) && $cpu$$582$$.trigger_gp(0);
  $cpu$$582$$.update_eflags($cpu$$582$$.pop32s());
  $cpu$$582$$.handle_irqs();
};
$table16$$[158] = $table32$$[158] = function $$table32$$$158$($cpu$$583$$) {
  $cpu$$583$$.flags = $cpu$$583$$.flags & -256 | $cpu$$583$$.reg8[1];
  $cpu$$583$$.flags = $cpu$$583$$.flags & 4161493 | 2;
  $cpu$$583$$.flags_changed = 0;
};
$table16$$[159] = $table32$$[159] = function $$table32$$$159$($cpu$$584$$) {
  $cpu$$584$$.load_eflags();
  $cpu$$584$$.reg8[1] = $cpu$$584$$.flags;
};
$table16$$[160] = $table32$$[160] = function $$table32$$$160$($cpu$$585$$) {
  var $data$$98$$ = $cpu$$585$$.safe_read8($cpu$$585$$.read_moffs());
  $cpu$$585$$.reg8[0] = $data$$98$$;
};
$table16$$[161] = function $$table16$$$161$($cpu$$586$$) {
  var $data$$99$$ = $cpu$$586$$.safe_read16($cpu$$586$$.read_moffs());
  $cpu$$586$$.reg16[0] = $data$$99$$;
};
$table32$$[161] = function $$table32$$$161$($cpu$$587$$) {
  var $data$$100$$ = $cpu$$587$$.safe_read32s($cpu$$587$$.read_moffs());
  $cpu$$587$$.reg32s[0] = $data$$100$$;
};
$table16$$[162] = $table32$$[162] = function $$table32$$$162$($cpu$$588$$) {
  $cpu$$588$$.safe_write8($cpu$$588$$.read_moffs(), $cpu$$588$$.reg8[0]);
};
$table16$$[163] = function $$table16$$$163$($cpu$$589$$) {
  $cpu$$589$$.safe_write16($cpu$$589$$.read_moffs(), $cpu$$589$$.reg16[0]);
};
$table32$$[163] = function $$table32$$$163$($cpu$$590$$) {
  $cpu$$590$$.safe_write32($cpu$$590$$.read_moffs(), $cpu$$590$$.reg32s[0]);
};
$table16$$[164] = $table32$$[164] = function $$table32$$$164$($cpu$$591$$) {
  a: {
    var $phys_src$$inline_445_src$$inline_442$$, $dest$$inline_443_phys_dest$$inline_444$$, $diff$$inline_452_size$$inline_446$$ = $cpu$$591$$.flags & 1024 ? -1 : 1, $cont$$inline_447$$ = !1;
    $dest$$inline_443_phys_dest$$inline_444$$ = $cpu$$591$$.get_seg(0) + $cpu$$591$$.regv[$cpu$$591$$.reg_vdi] | 0;
    $phys_src$$inline_445_src$$inline_442$$ = $cpu$$591$$.get_seg_prefix(3) + $cpu$$591$$.regv[$cpu$$591$$.reg_vsi] | 0;
    if (0 !== $cpu$$591$$.repeat_string_prefix) {
      var $count$$inline_448$$ = $cpu$$591$$.regv[$cpu$$591$$.reg_vcx] >>> 0, $start_count$$inline_449$$ = $count$$inline_448$$;
      if (0 === $count$$inline_448$$) {
        break a;
      }
      var $next_cycle$$inline_450$$ = 16384, $single_size$$inline_451$$ = $diff$$inline_452_size$$inline_446$$ >> 31 | 1;
      $cpu$$591$$.paging && ($next_cycle$$inline_450$$ = ($single_size$$inline_451$$ >> 1 ^ ~$phys_src$$inline_445_src$$inline_442$$) & 4095, $phys_src$$inline_445_src$$inline_442$$ = $cpu$$591$$.translate_address_read($phys_src$$inline_445_src$$inline_442$$), $next_cycle$$inline_450$$ = Math.min($next_cycle$$inline_450$$, ($single_size$$inline_451$$ >> 1 ^ ~$dest$$inline_443_phys_dest$$inline_444$$) & 4095), $dest$$inline_443_phys_dest$$inline_444$$ = $cpu$$591$$.translate_address_write($dest$$inline_443_phys_dest$$inline_444$$));
      do {
        $cpu$$591$$.memory.write8($dest$$inline_443_phys_dest$$inline_444$$, $cpu$$591$$.memory.read8($phys_src$$inline_445_src$$inline_442$$)), $dest$$inline_443_phys_dest$$inline_444$$ += $single_size$$inline_451$$, $phys_src$$inline_445_src$$inline_442$$ += $single_size$$inline_451$$, $cont$$inline_447$$ = 0 !== --$count$$inline_448$$ && !0;
      } while ($cont$$inline_447$$ && $next_cycle$$inline_450$$--);
      $diff$$inline_452_size$$inline_446$$ = $diff$$inline_452_size$$inline_446$$ * ($start_count$$inline_449$$ - $count$$inline_448$$) | 0;
      $cpu$$591$$.regv[$cpu$$591$$.reg_vdi] += $diff$$inline_452_size$$inline_446$$;
      $cpu$$591$$.regv[$cpu$$591$$.reg_vsi] += $diff$$inline_452_size$$inline_446$$;
      $cpu$$591$$.regv[$cpu$$591$$.reg_vcx] = $count$$inline_448$$;
      $cpu$$591$$.timestamp_counter += $start_count$$inline_449$$ - $count$$inline_448$$;
    } else {
      $phys_src$$inline_445_src$$inline_442$$ = $cpu$$591$$.translate_address_read($phys_src$$inline_445_src$$inline_442$$), $dest$$inline_443_phys_dest$$inline_444$$ = $cpu$$591$$.translate_address_write($dest$$inline_443_phys_dest$$inline_444$$), $cpu$$591$$.memory.write8($dest$$inline_443_phys_dest$$inline_444$$, $cpu$$591$$.memory.read8($phys_src$$inline_445_src$$inline_442$$)), $cpu$$591$$.regv[$cpu$$591$$.reg_vdi] += $diff$$inline_452_size$$inline_446$$, $cpu$$591$$.regv[$cpu$$591$$.reg_vsi] += 
      $diff$$inline_452_size$$inline_446$$;
    }
    $cont$$inline_447$$ && ($cpu$$591$$.instruction_pointer = $cpu$$591$$.previous_ip);
  }
};
$table16$$[165] = function $$table16$$$165$($cpu$$592$$) {
  a: {
    var $phys_src$$inline_458_src$$inline_455$$, $dest$$inline_456_phys_dest$$inline_457$$, $diff$$inline_465_size$$inline_459$$ = $cpu$$592$$.flags & 1024 ? -2 : 2, $cont$$inline_460$$ = !1;
    $dest$$inline_456_phys_dest$$inline_457$$ = $cpu$$592$$.get_seg(0) + $cpu$$592$$.regv[$cpu$$592$$.reg_vdi] | 0;
    $phys_src$$inline_458_src$$inline_455$$ = $cpu$$592$$.get_seg_prefix(3) + $cpu$$592$$.regv[$cpu$$592$$.reg_vsi] | 0;
    if (0 !== $cpu$$592$$.repeat_string_prefix) {
      var $count$$inline_461$$ = $cpu$$592$$.regv[$cpu$$592$$.reg_vcx] >>> 0, $start_count$$inline_462$$ = $count$$inline_461$$;
      if (0 === $count$$inline_461$$) {
        break a;
      }
      var $next_cycle$$inline_463$$ = 16384;
      if ($dest$$inline_456_phys_dest$$inline_457$$ & 1 || $phys_src$$inline_458_src$$inline_455$$ & 1) {
        do {
          $cpu$$592$$.safe_write16($dest$$inline_456_phys_dest$$inline_457$$, $cpu$$592$$.safe_read16($phys_src$$inline_458_src$$inline_455$$)), $dest$$inline_456_phys_dest$$inline_457$$ += $diff$$inline_465_size$$inline_459$$, $cpu$$592$$.regv[$cpu$$592$$.reg_vdi] += $diff$$inline_465_size$$inline_459$$, $phys_src$$inline_458_src$$inline_455$$ += $diff$$inline_465_size$$inline_459$$, $cpu$$592$$.regv[$cpu$$592$$.reg_vsi] += $diff$$inline_465_size$$inline_459$$, $cont$$inline_460$$ = 0 !== --$cpu$$592$$.regv[$cpu$$592$$.reg_vcx] && 
          !0;
        } while ($cont$$inline_460$$ && $next_cycle$$inline_463$$--);
      } else {
        var $single_size$$inline_464$$ = $diff$$inline_465_size$$inline_459$$ >> 31 | 1;
        $cpu$$592$$.paging && ($next_cycle$$inline_463$$ = ($single_size$$inline_464$$ >> 1 ^ ~$phys_src$$inline_458_src$$inline_455$$) & 4095, $phys_src$$inline_458_src$$inline_455$$ = $cpu$$592$$.translate_address_read($phys_src$$inline_458_src$$inline_455$$), $next_cycle$$inline_463$$ = Math.min($next_cycle$$inline_463$$, ($single_size$$inline_464$$ >> 1 ^ ~$dest$$inline_456_phys_dest$$inline_457$$) & 4095), $dest$$inline_456_phys_dest$$inline_457$$ = $cpu$$592$$.translate_address_write($dest$$inline_456_phys_dest$$inline_457$$), 
        $next_cycle$$inline_463$$ >>= 1);
        $dest$$inline_456_phys_dest$$inline_457$$ >>>= 1;
        $phys_src$$inline_458_src$$inline_455$$ >>>= 1;
        do {
          $cpu$$592$$.memory.write_aligned16($dest$$inline_456_phys_dest$$inline_457$$, $cpu$$592$$.memory.read_aligned16($phys_src$$inline_458_src$$inline_455$$)), $dest$$inline_456_phys_dest$$inline_457$$ += $single_size$$inline_464$$, $phys_src$$inline_458_src$$inline_455$$ += $single_size$$inline_464$$, $cont$$inline_460$$ = 0 !== --$count$$inline_461$$ && !0;
        } while ($cont$$inline_460$$ && $next_cycle$$inline_463$$--);
        $diff$$inline_465_size$$inline_459$$ = $diff$$inline_465_size$$inline_459$$ * ($start_count$$inline_462$$ - $count$$inline_461$$) | 0;
        $cpu$$592$$.regv[$cpu$$592$$.reg_vdi] += $diff$$inline_465_size$$inline_459$$;
        $cpu$$592$$.regv[$cpu$$592$$.reg_vsi] += $diff$$inline_465_size$$inline_459$$;
        $cpu$$592$$.regv[$cpu$$592$$.reg_vcx] = $count$$inline_461$$;
        $cpu$$592$$.timestamp_counter += $start_count$$inline_462$$ - $count$$inline_461$$;
      }
    } else {
      $cpu$$592$$.safe_write16($dest$$inline_456_phys_dest$$inline_457$$, $cpu$$592$$.safe_read16($phys_src$$inline_458_src$$inline_455$$)), $cpu$$592$$.regv[$cpu$$592$$.reg_vdi] += $diff$$inline_465_size$$inline_459$$, $cpu$$592$$.regv[$cpu$$592$$.reg_vsi] += $diff$$inline_465_size$$inline_459$$;
    }
    $cont$$inline_460$$ && ($cpu$$592$$.instruction_pointer = $cpu$$592$$.previous_ip);
  }
};
$table32$$[165] = function $$table32$$$165$($cpu$$593$$) {
  a: {
    if (0 !== $cpu$$593$$.repeat_string_prefix) {
      var $phys_src$$inline_475_src$$inline_468$$ = $cpu$$593$$.get_seg_prefix(3) + $cpu$$593$$.regv[$cpu$$593$$.reg_vsi], $dest$$inline_469_phys_dest$$inline_474$$ = $cpu$$593$$.get_seg(0) + $cpu$$593$$.regv[$cpu$$593$$.reg_vdi], $count$$inline_470$$ = $cpu$$593$$.regv[$cpu$$593$$.reg_vcx] >>> 0;
      if (!$count$$inline_470$$) {
        break a;
      }
      var $align_mask$$inline_471_cont$$inline_472$$ = $cpu$$593$$.paging ? 4095 : 3;
      if (0 === ($dest$$inline_469_phys_dest$$inline_474$$ & $align_mask$$inline_471_cont$$inline_472$$) && 0 === ($phys_src$$inline_475_src$$inline_468$$ & $align_mask$$inline_471_cont$$inline_472$$) && 0 === ($cpu$$593$$.flags & 1024) && ($align_mask$$inline_471_cont$$inline_472$$ = !1, $cpu$$593$$.paging && ($phys_src$$inline_475_src$$inline_468$$ = $cpu$$593$$.translate_address_read($phys_src$$inline_475_src$$inline_468$$), $dest$$inline_469_phys_dest$$inline_474$$ = $cpu$$593$$.translate_address_write($dest$$inline_469_phys_dest$$inline_474$$), 
      1024 < $count$$inline_470$$ && ($count$$inline_470$$ = 1024, $align_mask$$inline_471_cont$$inline_472$$ = !0)), !$cpu$$593$$.io.in_mmap_range($phys_src$$inline_475_src$$inline_468$$, $count$$inline_470$$) && !$cpu$$593$$.io.in_mmap_range($dest$$inline_469_phys_dest$$inline_474$$, $count$$inline_470$$))) {
        var $diff$$inline_473_size$$inline_476$$ = $count$$inline_470$$ << 2;
        $cpu$$593$$.regv[$cpu$$593$$.reg_vcx] -= $count$$inline_470$$;
        $cpu$$593$$.regv[$cpu$$593$$.reg_vdi] += $diff$$inline_473_size$$inline_476$$;
        $cpu$$593$$.regv[$cpu$$593$$.reg_vsi] += $diff$$inline_473_size$$inline_476$$;
        $phys_src$$inline_475_src$$inline_468$$ >>= 2;
        $cpu$$593$$.memory.mem32s.set($cpu$$593$$.memory.mem32s.subarray($phys_src$$inline_475_src$$inline_468$$, $phys_src$$inline_475_src$$inline_468$$ + $count$$inline_470$$), $dest$$inline_469_phys_dest$$inline_474$$ >> 2);
        $align_mask$$inline_471_cont$$inline_472$$ && ($cpu$$593$$.instruction_pointer = $cpu$$593$$.previous_ip);
        break a;
      }
    }
    $diff$$inline_473_size$$inline_476$$ = $cpu$$593$$.flags & 1024 ? -4 : 4;
    $align_mask$$inline_471_cont$$inline_472$$ = !1;
    $dest$$inline_469_phys_dest$$inline_474$$ = $cpu$$593$$.get_seg(0) + $cpu$$593$$.regv[$cpu$$593$$.reg_vdi] | 0;
    $phys_src$$inline_475_src$$inline_468$$ = $cpu$$593$$.get_seg_prefix(3) + $cpu$$593$$.regv[$cpu$$593$$.reg_vsi] | 0;
    if (0 !== $cpu$$593$$.repeat_string_prefix) {
      var $start_count$$inline_477$$ = $count$$inline_470$$ = $cpu$$593$$.regv[$cpu$$593$$.reg_vcx] >>> 0;
      if (0 === $count$$inline_470$$) {
        break a;
      }
      var $next_cycle$$inline_478$$ = 16384;
      if ($dest$$inline_469_phys_dest$$inline_474$$ & 3 || $phys_src$$inline_475_src$$inline_468$$ & 3) {
        do {
          $cpu$$593$$.safe_write32($dest$$inline_469_phys_dest$$inline_474$$, $cpu$$593$$.safe_read32s($phys_src$$inline_475_src$$inline_468$$)), $dest$$inline_469_phys_dest$$inline_474$$ += $diff$$inline_473_size$$inline_476$$, $cpu$$593$$.regv[$cpu$$593$$.reg_vdi] += $diff$$inline_473_size$$inline_476$$, $phys_src$$inline_475_src$$inline_468$$ += $diff$$inline_473_size$$inline_476$$, $cpu$$593$$.regv[$cpu$$593$$.reg_vsi] += $diff$$inline_473_size$$inline_476$$, $align_mask$$inline_471_cont$$inline_472$$ = 
          0 !== --$cpu$$593$$.regv[$cpu$$593$$.reg_vcx] && !0;
        } while ($align_mask$$inline_471_cont$$inline_472$$ && $next_cycle$$inline_478$$--);
      } else {
        var $single_size$$inline_479$$ = $diff$$inline_473_size$$inline_476$$ >> 31 | 1;
        $cpu$$593$$.paging && ($next_cycle$$inline_478$$ = ($single_size$$inline_479$$ >> 1 ^ ~$phys_src$$inline_475_src$$inline_468$$) & 4095, $phys_src$$inline_475_src$$inline_468$$ = $cpu$$593$$.translate_address_read($phys_src$$inline_475_src$$inline_468$$), $next_cycle$$inline_478$$ = Math.min($next_cycle$$inline_478$$, ($single_size$$inline_479$$ >> 1 ^ ~$dest$$inline_469_phys_dest$$inline_474$$) & 4095), $dest$$inline_469_phys_dest$$inline_474$$ = $cpu$$593$$.translate_address_write($dest$$inline_469_phys_dest$$inline_474$$), 
        $next_cycle$$inline_478$$ >>= 2);
        $dest$$inline_469_phys_dest$$inline_474$$ >>>= 2;
        $phys_src$$inline_475_src$$inline_468$$ >>>= 2;
        do {
          $cpu$$593$$.memory.write_aligned32($dest$$inline_469_phys_dest$$inline_474$$, $cpu$$593$$.memory.read_aligned32($phys_src$$inline_475_src$$inline_468$$)), $dest$$inline_469_phys_dest$$inline_474$$ += $single_size$$inline_479$$, $phys_src$$inline_475_src$$inline_468$$ += $single_size$$inline_479$$, $align_mask$$inline_471_cont$$inline_472$$ = 0 !== --$count$$inline_470$$ && !0;
        } while ($align_mask$$inline_471_cont$$inline_472$$ && $next_cycle$$inline_478$$--);
        $diff$$inline_473_size$$inline_476$$ = $diff$$inline_473_size$$inline_476$$ * ($start_count$$inline_477$$ - $count$$inline_470$$) | 0;
        $cpu$$593$$.regv[$cpu$$593$$.reg_vdi] += $diff$$inline_473_size$$inline_476$$;
        $cpu$$593$$.regv[$cpu$$593$$.reg_vsi] += $diff$$inline_473_size$$inline_476$$;
        $cpu$$593$$.regv[$cpu$$593$$.reg_vcx] = $count$$inline_470$$;
        $cpu$$593$$.timestamp_counter += $start_count$$inline_477$$ - $count$$inline_470$$;
      }
    } else {
      $cpu$$593$$.safe_write32($dest$$inline_469_phys_dest$$inline_474$$, $cpu$$593$$.safe_read32s($phys_src$$inline_475_src$$inline_468$$)), $cpu$$593$$.regv[$cpu$$593$$.reg_vdi] += $diff$$inline_473_size$$inline_476$$, $cpu$$593$$.regv[$cpu$$593$$.reg_vsi] += $diff$$inline_473_size$$inline_476$$;
    }
    $align_mask$$inline_471_cont$$inline_472$$ && ($cpu$$593$$.instruction_pointer = $cpu$$593$$.previous_ip);
  }
};
$table16$$[166] = $table32$$[166] = function $$table32$$$166$($cpu$$594$$) {
  a: {
    var $data_src$$inline_484_src$$inline_482$$, $data_dest$$inline_485_dest$$inline_483$$;
    $data_dest$$inline_485_dest$$inline_483$$ = 0;
    var $phys_dest$$inline_486$$, $phys_src$$inline_487$$, $diff$$inline_494_size$$inline_488$$ = $cpu$$594$$.flags & 1024 ? -1 : 1, $cont$$inline_489$$ = !1;
    $data_dest$$inline_485_dest$$inline_483$$ = $cpu$$594$$.get_seg(0) + $cpu$$594$$.regv[$cpu$$594$$.reg_vdi] | 0;
    $data_src$$inline_484_src$$inline_482$$ = $cpu$$594$$.get_seg_prefix(3) + $cpu$$594$$.regv[$cpu$$594$$.reg_vsi] | 0;
    if (0 !== $cpu$$594$$.repeat_string_prefix) {
      var $count$$inline_490$$ = $cpu$$594$$.regv[$cpu$$594$$.reg_vcx] >>> 0, $start_count$$inline_491$$ = $count$$inline_490$$;
      if (0 === $count$$inline_490$$) {
        break a;
      }
      var $next_cycle$$inline_492$$ = 16384, $single_size$$inline_493$$ = $diff$$inline_494_size$$inline_488$$ >> 31 | 1;
      $cpu$$594$$.paging ? ($next_cycle$$inline_492$$ = ($single_size$$inline_493$$ >> 1 ^ ~$data_src$$inline_484_src$$inline_482$$) & 4095, $phys_src$$inline_487$$ = $cpu$$594$$.translate_address_read($data_src$$inline_484_src$$inline_482$$), $next_cycle$$inline_492$$ = Math.min($next_cycle$$inline_492$$, ($single_size$$inline_493$$ >> 1 ^ ~$data_dest$$inline_485_dest$$inline_483$$) & 4095), $phys_dest$$inline_486$$ = $cpu$$594$$.translate_address_read($data_dest$$inline_485_dest$$inline_483$$)) : 
      ($phys_dest$$inline_486$$ = $data_dest$$inline_485_dest$$inline_483$$, $phys_src$$inline_487$$ = $data_src$$inline_484_src$$inline_482$$);
      do {
        $data_dest$$inline_485_dest$$inline_483$$ = $cpu$$594$$.memory.read8($phys_dest$$inline_486$$), $data_src$$inline_484_src$$inline_482$$ = $cpu$$594$$.memory.read8($phys_src$$inline_487$$), $phys_dest$$inline_486$$ += $single_size$$inline_493$$, $phys_src$$inline_487$$ += $single_size$$inline_493$$, $cont$$inline_489$$ = 0 !== --$count$$inline_490$$ && $data_src$$inline_484_src$$inline_482$$ === $data_dest$$inline_485_dest$$inline_483$$ === (2 === $cpu$$594$$.repeat_string_prefix);
      } while ($cont$$inline_489$$ && $next_cycle$$inline_492$$--);
      $diff$$inline_494_size$$inline_488$$ = $diff$$inline_494_size$$inline_488$$ * ($start_count$$inline_491$$ - $count$$inline_490$$) | 0;
      $cpu$$594$$.regv[$cpu$$594$$.reg_vdi] += $diff$$inline_494_size$$inline_488$$;
      $cpu$$594$$.regv[$cpu$$594$$.reg_vsi] += $diff$$inline_494_size$$inline_488$$;
      $cpu$$594$$.regv[$cpu$$594$$.reg_vcx] = $count$$inline_490$$;
      $cpu$$594$$.timestamp_counter += $start_count$$inline_491$$ - $count$$inline_490$$;
    } else {
      $phys_src$$inline_487$$ = $cpu$$594$$.translate_address_read($data_src$$inline_484_src$$inline_482$$), $phys_dest$$inline_486$$ = $cpu$$594$$.translate_address_read($data_dest$$inline_485_dest$$inline_483$$), $data_dest$$inline_485_dest$$inline_483$$ = $cpu$$594$$.memory.read8($phys_dest$$inline_486$$), $data_src$$inline_484_src$$inline_482$$ = $cpu$$594$$.memory.read8($phys_src$$inline_487$$), $cpu$$594$$.regv[$cpu$$594$$.reg_vdi] += $diff$$inline_494_size$$inline_488$$, $cpu$$594$$.regv[$cpu$$594$$.reg_vsi] += 
      $diff$$inline_494_size$$inline_488$$;
    }
    $cpu$$594$$.sub($data_src$$inline_484_src$$inline_482$$, $data_dest$$inline_485_dest$$inline_483$$, 7);
    $cont$$inline_489$$ && ($cpu$$594$$.instruction_pointer = $cpu$$594$$.previous_ip);
  }
};
$table16$$[167] = function $$table16$$$167$($cpu$$595$$) {
  a: {
    var $phys_src$$inline_502_src$$inline_497$$, $dest$$inline_498_phys_dest$$inline_501$$, $data_src$$inline_499$$, $data_dest$$inline_500$$ = 0, $diff$$inline_509_size$$inline_503$$ = $cpu$$595$$.flags & 1024 ? -2 : 2, $cont$$inline_504$$ = !1;
    $dest$$inline_498_phys_dest$$inline_501$$ = $cpu$$595$$.get_seg(0) + $cpu$$595$$.regv[$cpu$$595$$.reg_vdi] | 0;
    $phys_src$$inline_502_src$$inline_497$$ = $cpu$$595$$.get_seg_prefix(3) + $cpu$$595$$.regv[$cpu$$595$$.reg_vsi] | 0;
    if (0 !== $cpu$$595$$.repeat_string_prefix) {
      var $count$$inline_505$$ = $cpu$$595$$.regv[$cpu$$595$$.reg_vcx] >>> 0, $start_count$$inline_506$$ = $count$$inline_505$$;
      if (0 === $count$$inline_505$$) {
        break a;
      }
      var $next_cycle$$inline_507$$ = 16384;
      if ($dest$$inline_498_phys_dest$$inline_501$$ & 1 || $phys_src$$inline_502_src$$inline_497$$ & 1) {
        do {
          $data_dest$$inline_500$$ = $cpu$$595$$.safe_read16($dest$$inline_498_phys_dest$$inline_501$$), $data_src$$inline_499$$ = $cpu$$595$$.safe_read16($phys_src$$inline_502_src$$inline_497$$), $dest$$inline_498_phys_dest$$inline_501$$ += $diff$$inline_509_size$$inline_503$$, $cpu$$595$$.regv[$cpu$$595$$.reg_vdi] += $diff$$inline_509_size$$inline_503$$, $phys_src$$inline_502_src$$inline_497$$ += $diff$$inline_509_size$$inline_503$$, $cpu$$595$$.regv[$cpu$$595$$.reg_vsi] += $diff$$inline_509_size$$inline_503$$, 
          $cont$$inline_504$$ = 0 !== --$cpu$$595$$.regv[$cpu$$595$$.reg_vcx] && $data_src$$inline_499$$ === $data_dest$$inline_500$$ === (2 === $cpu$$595$$.repeat_string_prefix);
        } while ($cont$$inline_504$$ && $next_cycle$$inline_507$$--);
      } else {
        var $single_size$$inline_508$$ = $diff$$inline_509_size$$inline_503$$ >> 31 | 1;
        $cpu$$595$$.paging && ($next_cycle$$inline_507$$ = ($single_size$$inline_508$$ >> 1 ^ ~$phys_src$$inline_502_src$$inline_497$$) & 4095, $phys_src$$inline_502_src$$inline_497$$ = $cpu$$595$$.translate_address_read($phys_src$$inline_502_src$$inline_497$$), $next_cycle$$inline_507$$ = Math.min($next_cycle$$inline_507$$, ($single_size$$inline_508$$ >> 1 ^ ~$dest$$inline_498_phys_dest$$inline_501$$) & 4095), $dest$$inline_498_phys_dest$$inline_501$$ = $cpu$$595$$.translate_address_read($dest$$inline_498_phys_dest$$inline_501$$), 
        $next_cycle$$inline_507$$ >>= 1);
        $dest$$inline_498_phys_dest$$inline_501$$ >>>= 1;
        $phys_src$$inline_502_src$$inline_497$$ >>>= 1;
        do {
          $data_dest$$inline_500$$ = $cpu$$595$$.memory.read_aligned16($dest$$inline_498_phys_dest$$inline_501$$), $data_src$$inline_499$$ = $cpu$$595$$.memory.read_aligned16($phys_src$$inline_502_src$$inline_497$$), $dest$$inline_498_phys_dest$$inline_501$$ += $single_size$$inline_508$$, $phys_src$$inline_502_src$$inline_497$$ += $single_size$$inline_508$$, $cont$$inline_504$$ = 0 !== --$count$$inline_505$$ && $data_src$$inline_499$$ === $data_dest$$inline_500$$ === (2 === $cpu$$595$$.repeat_string_prefix)
          ;
        } while ($cont$$inline_504$$ && $next_cycle$$inline_507$$--);
        $diff$$inline_509_size$$inline_503$$ = $diff$$inline_509_size$$inline_503$$ * ($start_count$$inline_506$$ - $count$$inline_505$$) | 0;
        $cpu$$595$$.regv[$cpu$$595$$.reg_vdi] += $diff$$inline_509_size$$inline_503$$;
        $cpu$$595$$.regv[$cpu$$595$$.reg_vsi] += $diff$$inline_509_size$$inline_503$$;
        $cpu$$595$$.regv[$cpu$$595$$.reg_vcx] = $count$$inline_505$$;
        $cpu$$595$$.timestamp_counter += $start_count$$inline_506$$ - $count$$inline_505$$;
      }
    } else {
      $data_dest$$inline_500$$ = $cpu$$595$$.safe_read16($dest$$inline_498_phys_dest$$inline_501$$), $data_src$$inline_499$$ = $cpu$$595$$.safe_read16($phys_src$$inline_502_src$$inline_497$$), $cpu$$595$$.regv[$cpu$$595$$.reg_vdi] += $diff$$inline_509_size$$inline_503$$, $cpu$$595$$.regv[$cpu$$595$$.reg_vsi] += $diff$$inline_509_size$$inline_503$$;
    }
    $cpu$$595$$.sub($data_src$$inline_499$$, $data_dest$$inline_500$$, 15);
    $cont$$inline_504$$ && ($cpu$$595$$.instruction_pointer = $cpu$$595$$.previous_ip);
  }
};
$table32$$[167] = function $$table32$$$167$($cpu$$596$$) {
  a: {
    var $phys_src$$inline_517_src$$inline_512$$, $dest$$inline_513_phys_dest$$inline_516$$, $data_src$$inline_514$$, $data_dest$$inline_515$$ = 0, $diff$$inline_524_size$$inline_518$$ = $cpu$$596$$.flags & 1024 ? -4 : 4, $cont$$inline_519$$ = !1;
    $dest$$inline_513_phys_dest$$inline_516$$ = $cpu$$596$$.get_seg(0) + $cpu$$596$$.regv[$cpu$$596$$.reg_vdi] | 0;
    $phys_src$$inline_517_src$$inline_512$$ = $cpu$$596$$.get_seg_prefix(3) + $cpu$$596$$.regv[$cpu$$596$$.reg_vsi] | 0;
    if (0 !== $cpu$$596$$.repeat_string_prefix) {
      var $count$$inline_520$$ = $cpu$$596$$.regv[$cpu$$596$$.reg_vcx] >>> 0, $start_count$$inline_521$$ = $count$$inline_520$$;
      if (0 === $count$$inline_520$$) {
        break a;
      }
      var $next_cycle$$inline_522$$ = 16384;
      if ($dest$$inline_513_phys_dest$$inline_516$$ & 3 || $phys_src$$inline_517_src$$inline_512$$ & 3) {
        do {
          $data_dest$$inline_515$$ = $cpu$$596$$.safe_read32s($dest$$inline_513_phys_dest$$inline_516$$), $data_src$$inline_514$$ = $cpu$$596$$.safe_read32s($phys_src$$inline_517_src$$inline_512$$), $dest$$inline_513_phys_dest$$inline_516$$ += $diff$$inline_524_size$$inline_518$$, $cpu$$596$$.regv[$cpu$$596$$.reg_vdi] += $diff$$inline_524_size$$inline_518$$, $phys_src$$inline_517_src$$inline_512$$ += $diff$$inline_524_size$$inline_518$$, $cpu$$596$$.regv[$cpu$$596$$.reg_vsi] += $diff$$inline_524_size$$inline_518$$, 
          $cont$$inline_519$$ = 0 !== --$cpu$$596$$.regv[$cpu$$596$$.reg_vcx] && $data_src$$inline_514$$ === $data_dest$$inline_515$$ === (2 === $cpu$$596$$.repeat_string_prefix);
        } while ($cont$$inline_519$$ && $next_cycle$$inline_522$$--);
      } else {
        var $single_size$$inline_523$$ = $diff$$inline_524_size$$inline_518$$ >> 31 | 1;
        $cpu$$596$$.paging && ($next_cycle$$inline_522$$ = ($single_size$$inline_523$$ >> 1 ^ ~$phys_src$$inline_517_src$$inline_512$$) & 4095, $phys_src$$inline_517_src$$inline_512$$ = $cpu$$596$$.translate_address_read($phys_src$$inline_517_src$$inline_512$$), $next_cycle$$inline_522$$ = Math.min($next_cycle$$inline_522$$, ($single_size$$inline_523$$ >> 1 ^ ~$dest$$inline_513_phys_dest$$inline_516$$) & 4095), $dest$$inline_513_phys_dest$$inline_516$$ = $cpu$$596$$.translate_address_read($dest$$inline_513_phys_dest$$inline_516$$), 
        $next_cycle$$inline_522$$ >>= 2);
        $dest$$inline_513_phys_dest$$inline_516$$ >>>= 2;
        $phys_src$$inline_517_src$$inline_512$$ >>>= 2;
        do {
          $data_dest$$inline_515$$ = $cpu$$596$$.memory.read_aligned32($dest$$inline_513_phys_dest$$inline_516$$), $data_src$$inline_514$$ = $cpu$$596$$.memory.read_aligned32($phys_src$$inline_517_src$$inline_512$$), $dest$$inline_513_phys_dest$$inline_516$$ += $single_size$$inline_523$$, $phys_src$$inline_517_src$$inline_512$$ += $single_size$$inline_523$$, $cont$$inline_519$$ = 0 !== --$count$$inline_520$$ && $data_src$$inline_514$$ === $data_dest$$inline_515$$ === (2 === $cpu$$596$$.repeat_string_prefix)
          ;
        } while ($cont$$inline_519$$ && $next_cycle$$inline_522$$--);
        $diff$$inline_524_size$$inline_518$$ = $diff$$inline_524_size$$inline_518$$ * ($start_count$$inline_521$$ - $count$$inline_520$$) | 0;
        $cpu$$596$$.regv[$cpu$$596$$.reg_vdi] += $diff$$inline_524_size$$inline_518$$;
        $cpu$$596$$.regv[$cpu$$596$$.reg_vsi] += $diff$$inline_524_size$$inline_518$$;
        $cpu$$596$$.regv[$cpu$$596$$.reg_vcx] = $count$$inline_520$$;
        $cpu$$596$$.timestamp_counter += $start_count$$inline_521$$ - $count$$inline_520$$;
      }
    } else {
      $data_dest$$inline_515$$ = $cpu$$596$$.safe_read32s($dest$$inline_513_phys_dest$$inline_516$$), $data_src$$inline_514$$ = $cpu$$596$$.safe_read32s($phys_src$$inline_517_src$$inline_512$$), $cpu$$596$$.regv[$cpu$$596$$.reg_vdi] += $diff$$inline_524_size$$inline_518$$, $cpu$$596$$.regv[$cpu$$596$$.reg_vsi] += $diff$$inline_524_size$$inline_518$$;
    }
    $cpu$$596$$.sub($data_src$$inline_514$$, $data_dest$$inline_515$$, 31);
    $cont$$inline_519$$ && ($cpu$$596$$.instruction_pointer = $cpu$$596$$.previous_ip);
  }
};
$table16$$[168] = $table32$$[168] = function $$table32$$$168$($cpu$$597$$) {
  $cpu$$597$$.and($cpu$$597$$.reg8[0], $cpu$$597$$.read_imm8(), 7);
};
$table16$$[169] = function $$table16$$$169$($cpu$$598$$) {
  $cpu$$598$$.and($cpu$$598$$.reg16[0], $cpu$$598$$.read_imm16(), 15);
};
$table32$$[169] = function $$table32$$$169$($cpu$$599$$) {
  $cpu$$599$$.and($cpu$$599$$.reg32s[0], $cpu$$599$$.read_imm32s(), 31);
};
$table16$$[170] = $table32$$[170] = function $$table32$$$170$($cpu$$600$$) {
  a: {
    var $data$$inline_527$$ = $cpu$$600$$.reg8[0], $dest$$inline_528_phys_dest$$inline_529$$, $size$$inline_530$$ = $cpu$$600$$.flags & 1024 ? -1 : 1, $cont$$inline_531$$ = !1;
    $dest$$inline_528_phys_dest$$inline_529$$ = $cpu$$600$$.get_seg(0) + $cpu$$600$$.regv[$cpu$$600$$.reg_vdi] | 0;
    if (0 !== $cpu$$600$$.repeat_string_prefix) {
      var $count$$inline_532$$ = $cpu$$600$$.regv[$cpu$$600$$.reg_vcx] >>> 0, $start_count$$inline_533$$ = $count$$inline_532$$;
      if (0 === $count$$inline_532$$) {
        break a;
      }
      var $next_cycle$$inline_534$$ = 16384, $single_size$$inline_535$$ = $size$$inline_530$$ >> 31 | 1;
      $cpu$$600$$.paging && ($next_cycle$$inline_534$$ = Math.min($next_cycle$$inline_534$$, ($single_size$$inline_535$$ >> 1 ^ ~$dest$$inline_528_phys_dest$$inline_529$$) & 4095), $dest$$inline_528_phys_dest$$inline_529$$ = $cpu$$600$$.translate_address_write($dest$$inline_528_phys_dest$$inline_529$$));
      do {
        $cpu$$600$$.memory.write8($dest$$inline_528_phys_dest$$inline_529$$, $data$$inline_527$$), $dest$$inline_528_phys_dest$$inline_529$$ += $single_size$$inline_535$$, $cont$$inline_531$$ = 0 !== --$count$$inline_532$$ && !0;
      } while ($cont$$inline_531$$ && $next_cycle$$inline_534$$--);
      $cpu$$600$$.regv[$cpu$$600$$.reg_vdi] += $size$$inline_530$$ * ($start_count$$inline_533$$ - $count$$inline_532$$) | 0;
      $cpu$$600$$.regv[$cpu$$600$$.reg_vcx] = $count$$inline_532$$;
      $cpu$$600$$.timestamp_counter += $start_count$$inline_533$$ - $count$$inline_532$$;
    } else {
      $dest$$inline_528_phys_dest$$inline_529$$ = $cpu$$600$$.translate_address_write($dest$$inline_528_phys_dest$$inline_529$$), $cpu$$600$$.memory.write8($dest$$inline_528_phys_dest$$inline_529$$, $data$$inline_527$$), $cpu$$600$$.regv[$cpu$$600$$.reg_vdi] += $size$$inline_530$$;
    }
    $cont$$inline_531$$ && ($cpu$$600$$.instruction_pointer = $cpu$$600$$.previous_ip);
  }
};
$table16$$[171] = function $$table16$$$171$($cpu$$601$$) {
  a: {
    var $data$$inline_538$$ = $cpu$$601$$.reg16[0], $dest$$inline_539_phys_dest$$inline_540$$, $size$$inline_541$$ = $cpu$$601$$.flags & 1024 ? -2 : 2, $cont$$inline_542$$ = !1;
    $dest$$inline_539_phys_dest$$inline_540$$ = $cpu$$601$$.get_seg(0) + $cpu$$601$$.regv[$cpu$$601$$.reg_vdi] | 0;
    if (0 !== $cpu$$601$$.repeat_string_prefix) {
      var $count$$inline_543$$ = $cpu$$601$$.regv[$cpu$$601$$.reg_vcx] >>> 0, $start_count$$inline_544$$ = $count$$inline_543$$;
      if (0 === $count$$inline_543$$) {
        break a;
      }
      var $next_cycle$$inline_545$$ = 16384;
      if ($dest$$inline_539_phys_dest$$inline_540$$ & 1) {
        do {
          $cpu$$601$$.safe_write16($dest$$inline_539_phys_dest$$inline_540$$, $data$$inline_538$$), $dest$$inline_539_phys_dest$$inline_540$$ += $size$$inline_541$$, $cpu$$601$$.regv[$cpu$$601$$.reg_vdi] += $size$$inline_541$$, $cont$$inline_542$$ = 0 !== --$cpu$$601$$.regv[$cpu$$601$$.reg_vcx] && !0;
        } while ($cont$$inline_542$$ && $next_cycle$$inline_545$$--);
      } else {
        var $single_size$$inline_546$$ = $size$$inline_541$$ >> 31 | 1;
        $cpu$$601$$.paging && ($next_cycle$$inline_545$$ = Math.min($next_cycle$$inline_545$$, ($single_size$$inline_546$$ >> 1 ^ ~$dest$$inline_539_phys_dest$$inline_540$$) & 4095), $dest$$inline_539_phys_dest$$inline_540$$ = $cpu$$601$$.translate_address_write($dest$$inline_539_phys_dest$$inline_540$$), $next_cycle$$inline_545$$ >>= 1);
        $dest$$inline_539_phys_dest$$inline_540$$ >>>= 1;
        do {
          $cpu$$601$$.memory.write_aligned16($dest$$inline_539_phys_dest$$inline_540$$, $data$$inline_538$$), $dest$$inline_539_phys_dest$$inline_540$$ += $single_size$$inline_546$$, $cont$$inline_542$$ = 0 !== --$count$$inline_543$$ && !0;
        } while ($cont$$inline_542$$ && $next_cycle$$inline_545$$--);
        $cpu$$601$$.regv[$cpu$$601$$.reg_vdi] += $size$$inline_541$$ * ($start_count$$inline_544$$ - $count$$inline_543$$) | 0;
        $cpu$$601$$.regv[$cpu$$601$$.reg_vcx] = $count$$inline_543$$;
        $cpu$$601$$.timestamp_counter += $start_count$$inline_544$$ - $count$$inline_543$$;
      }
    } else {
      $cpu$$601$$.safe_write16($dest$$inline_539_phys_dest$$inline_540$$, $data$$inline_538$$), $cpu$$601$$.regv[$cpu$$601$$.reg_vdi] += $size$$inline_541$$;
    }
    $cont$$inline_542$$ && ($cpu$$601$$.instruction_pointer = $cpu$$601$$.previous_ip);
  }
};
$table32$$[171] = function $$table32$$$171$($cpu$$602$$) {
  a: {
    var $data$$inline_549$$ = $cpu$$602$$.reg32s[0], $dest$$inline_550_phys_dest$$inline_551$$, $size$$inline_552$$ = $cpu$$602$$.flags & 1024 ? -4 : 4, $cont$$inline_553$$ = !1;
    $dest$$inline_550_phys_dest$$inline_551$$ = $cpu$$602$$.get_seg(0) + $cpu$$602$$.regv[$cpu$$602$$.reg_vdi] | 0;
    if (0 !== $cpu$$602$$.repeat_string_prefix) {
      var $count$$inline_554$$ = $cpu$$602$$.regv[$cpu$$602$$.reg_vcx] >>> 0, $start_count$$inline_555$$ = $count$$inline_554$$;
      if (0 === $count$$inline_554$$) {
        break a;
      }
      var $next_cycle$$inline_556$$ = 16384;
      if ($dest$$inline_550_phys_dest$$inline_551$$ & 3) {
        do {
          $cpu$$602$$.safe_write32($dest$$inline_550_phys_dest$$inline_551$$, $data$$inline_549$$), $dest$$inline_550_phys_dest$$inline_551$$ += $size$$inline_552$$, $cpu$$602$$.regv[$cpu$$602$$.reg_vdi] += $size$$inline_552$$, $cont$$inline_553$$ = 0 !== --$cpu$$602$$.regv[$cpu$$602$$.reg_vcx] && !0;
        } while ($cont$$inline_553$$ && $next_cycle$$inline_556$$--);
      } else {
        var $single_size$$inline_557$$ = $size$$inline_552$$ >> 31 | 1;
        $cpu$$602$$.paging && ($next_cycle$$inline_556$$ = Math.min($next_cycle$$inline_556$$, ($single_size$$inline_557$$ >> 1 ^ ~$dest$$inline_550_phys_dest$$inline_551$$) & 4095), $dest$$inline_550_phys_dest$$inline_551$$ = $cpu$$602$$.translate_address_write($dest$$inline_550_phys_dest$$inline_551$$), $next_cycle$$inline_556$$ >>= 2);
        $dest$$inline_550_phys_dest$$inline_551$$ >>>= 2;
        do {
          $cpu$$602$$.memory.write_aligned32($dest$$inline_550_phys_dest$$inline_551$$, $data$$inline_549$$), $dest$$inline_550_phys_dest$$inline_551$$ += $single_size$$inline_557$$, $cont$$inline_553$$ = 0 !== --$count$$inline_554$$ && !0;
        } while ($cont$$inline_553$$ && $next_cycle$$inline_556$$--);
        $cpu$$602$$.regv[$cpu$$602$$.reg_vdi] += $size$$inline_552$$ * ($start_count$$inline_555$$ - $count$$inline_554$$) | 0;
        $cpu$$602$$.regv[$cpu$$602$$.reg_vcx] = $count$$inline_554$$;
        $cpu$$602$$.timestamp_counter += $start_count$$inline_555$$ - $count$$inline_554$$;
      }
    } else {
      $cpu$$602$$.safe_write32($dest$$inline_550_phys_dest$$inline_551$$, $data$$inline_549$$), $cpu$$602$$.regv[$cpu$$602$$.reg_vdi] += $size$$inline_552$$;
    }
    $cont$$inline_553$$ && ($cpu$$602$$.instruction_pointer = $cpu$$602$$.previous_ip);
  }
};
$table16$$[172] = $table32$$[172] = function $$table32$$$172$($cpu$$603$$) {
  a: {
    var $phys_src$$inline_561_src$$inline_560$$, $size$$inline_562$$ = $cpu$$603$$.flags & 1024 ? -1 : 1, $cont$$inline_563$$ = !1;
    $phys_src$$inline_561_src$$inline_560$$ = $cpu$$603$$.get_seg_prefix(3) + $cpu$$603$$.regv[$cpu$$603$$.reg_vsi] | 0;
    if (0 !== $cpu$$603$$.repeat_string_prefix) {
      var $count$$inline_564$$ = $cpu$$603$$.regv[$cpu$$603$$.reg_vcx] >>> 0, $start_count$$inline_565$$ = $count$$inline_564$$;
      if (0 === $count$$inline_564$$) {
        break a;
      }
      var $next_cycle$$inline_566$$ = 16384, $single_size$$inline_567$$ = $size$$inline_562$$ >> 31 | 1;
      $cpu$$603$$.paging && ($next_cycle$$inline_566$$ = ($single_size$$inline_567$$ >> 1 ^ ~$phys_src$$inline_561_src$$inline_560$$) & 4095, $phys_src$$inline_561_src$$inline_560$$ = $cpu$$603$$.translate_address_read($phys_src$$inline_561_src$$inline_560$$));
      do {
        $cpu$$603$$.reg8[0] = $cpu$$603$$.memory.read8($phys_src$$inline_561_src$$inline_560$$), $phys_src$$inline_561_src$$inline_560$$ += $single_size$$inline_567$$, $cont$$inline_563$$ = 0 !== --$count$$inline_564$$ && !0;
      } while ($cont$$inline_563$$ && $next_cycle$$inline_566$$--);
      $cpu$$603$$.regv[$cpu$$603$$.reg_vsi] += $size$$inline_562$$ * ($start_count$$inline_565$$ - $count$$inline_564$$) | 0;
      $cpu$$603$$.regv[$cpu$$603$$.reg_vcx] = $count$$inline_564$$;
      $cpu$$603$$.timestamp_counter += $start_count$$inline_565$$ - $count$$inline_564$$;
    } else {
      $phys_src$$inline_561_src$$inline_560$$ = $cpu$$603$$.translate_address_read($phys_src$$inline_561_src$$inline_560$$), $cpu$$603$$.reg8[0] = $cpu$$603$$.memory.read8($phys_src$$inline_561_src$$inline_560$$), $cpu$$603$$.regv[$cpu$$603$$.reg_vsi] += $size$$inline_562$$;
    }
    $cont$$inline_563$$ && ($cpu$$603$$.instruction_pointer = $cpu$$603$$.previous_ip);
  }
};
$table16$$[173] = function $$table16$$$173$($cpu$$604$$) {
  a: {
    var $phys_src$$inline_571_src$$inline_570$$, $size$$inline_572$$ = $cpu$$604$$.flags & 1024 ? -2 : 2, $cont$$inline_573$$ = !1;
    $phys_src$$inline_571_src$$inline_570$$ = $cpu$$604$$.get_seg_prefix(3) + $cpu$$604$$.regv[$cpu$$604$$.reg_vsi] | 0;
    if (0 !== $cpu$$604$$.repeat_string_prefix) {
      var $count$$inline_574$$ = $cpu$$604$$.regv[$cpu$$604$$.reg_vcx] >>> 0, $start_count$$inline_575$$ = $count$$inline_574$$;
      if (0 === $count$$inline_574$$) {
        break a;
      }
      var $next_cycle$$inline_576$$ = 16384;
      if ($phys_src$$inline_571_src$$inline_570$$ & 1) {
        do {
          $cpu$$604$$.reg16[0] = $cpu$$604$$.safe_read16($phys_src$$inline_571_src$$inline_570$$), $phys_src$$inline_571_src$$inline_570$$ += $size$$inline_572$$, $cpu$$604$$.regv[$cpu$$604$$.reg_vsi] += $size$$inline_572$$, $cont$$inline_573$$ = 0 !== --$cpu$$604$$.regv[$cpu$$604$$.reg_vcx] && !0;
        } while ($cont$$inline_573$$ && $next_cycle$$inline_576$$--);
      } else {
        var $single_size$$inline_577$$ = $size$$inline_572$$ >> 31 | 1;
        $cpu$$604$$.paging && ($next_cycle$$inline_576$$ = ($single_size$$inline_577$$ >> 1 ^ ~$phys_src$$inline_571_src$$inline_570$$) & 4095, $phys_src$$inline_571_src$$inline_570$$ = $cpu$$604$$.translate_address_read($phys_src$$inline_571_src$$inline_570$$), $next_cycle$$inline_576$$ >>= 1);
        $phys_src$$inline_571_src$$inline_570$$ >>>= 1;
        do {
          $cpu$$604$$.reg16[0] = $cpu$$604$$.memory.read_aligned16($phys_src$$inline_571_src$$inline_570$$), $phys_src$$inline_571_src$$inline_570$$ += $single_size$$inline_577$$, $cont$$inline_573$$ = 0 !== --$count$$inline_574$$ && !0;
        } while ($cont$$inline_573$$ && $next_cycle$$inline_576$$--);
        $cpu$$604$$.regv[$cpu$$604$$.reg_vsi] += $size$$inline_572$$ * ($start_count$$inline_575$$ - $count$$inline_574$$) | 0;
        $cpu$$604$$.regv[$cpu$$604$$.reg_vcx] = $count$$inline_574$$;
        $cpu$$604$$.timestamp_counter += $start_count$$inline_575$$ - $count$$inline_574$$;
      }
    } else {
      $cpu$$604$$.reg16[0] = $cpu$$604$$.safe_read16($phys_src$$inline_571_src$$inline_570$$), $cpu$$604$$.regv[$cpu$$604$$.reg_vsi] += $size$$inline_572$$;
    }
    $cont$$inline_573$$ && ($cpu$$604$$.instruction_pointer = $cpu$$604$$.previous_ip);
  }
};
$table32$$[173] = function $$table32$$$173$($cpu$$605$$) {
  a: {
    var $phys_src$$inline_581_src$$inline_580$$, $size$$inline_582$$ = $cpu$$605$$.flags & 1024 ? -4 : 4, $cont$$inline_583$$ = !1;
    $phys_src$$inline_581_src$$inline_580$$ = $cpu$$605$$.get_seg_prefix(3) + $cpu$$605$$.regv[$cpu$$605$$.reg_vsi] | 0;
    if (0 !== $cpu$$605$$.repeat_string_prefix) {
      var $count$$inline_584$$ = $cpu$$605$$.regv[$cpu$$605$$.reg_vcx] >>> 0, $start_count$$inline_585$$ = $count$$inline_584$$;
      if (0 === $count$$inline_584$$) {
        break a;
      }
      var $next_cycle$$inline_586$$ = 16384;
      if ($phys_src$$inline_581_src$$inline_580$$ & 3) {
        do {
          $cpu$$605$$.reg32s[0] = $cpu$$605$$.safe_read32s($phys_src$$inline_581_src$$inline_580$$), $phys_src$$inline_581_src$$inline_580$$ += $size$$inline_582$$, $cpu$$605$$.regv[$cpu$$605$$.reg_vsi] += $size$$inline_582$$, $cont$$inline_583$$ = 0 !== --$cpu$$605$$.regv[$cpu$$605$$.reg_vcx] && !0;
        } while ($cont$$inline_583$$ && $next_cycle$$inline_586$$--);
      } else {
        var $single_size$$inline_587$$ = $size$$inline_582$$ >> 31 | 1;
        $cpu$$605$$.paging && ($next_cycle$$inline_586$$ = ($single_size$$inline_587$$ >> 1 ^ ~$phys_src$$inline_581_src$$inline_580$$) & 4095, $phys_src$$inline_581_src$$inline_580$$ = $cpu$$605$$.translate_address_read($phys_src$$inline_581_src$$inline_580$$), $next_cycle$$inline_586$$ >>= 2);
        $phys_src$$inline_581_src$$inline_580$$ >>>= 2;
        do {
          $cpu$$605$$.reg32s[0] = $cpu$$605$$.memory.read_aligned32($phys_src$$inline_581_src$$inline_580$$), $phys_src$$inline_581_src$$inline_580$$ += $single_size$$inline_587$$, $cont$$inline_583$$ = 0 !== --$count$$inline_584$$ && !0;
        } while ($cont$$inline_583$$ && $next_cycle$$inline_586$$--);
        $cpu$$605$$.regv[$cpu$$605$$.reg_vsi] += $size$$inline_582$$ * ($start_count$$inline_585$$ - $count$$inline_584$$) | 0;
        $cpu$$605$$.regv[$cpu$$605$$.reg_vcx] = $count$$inline_584$$;
        $cpu$$605$$.timestamp_counter += $start_count$$inline_585$$ - $count$$inline_584$$;
      }
    } else {
      $cpu$$605$$.reg32s[0] = $cpu$$605$$.safe_read32s($phys_src$$inline_581_src$$inline_580$$), $cpu$$605$$.regv[$cpu$$605$$.reg_vsi] += $size$$inline_582$$;
    }
    $cont$$inline_583$$ && ($cpu$$605$$.instruction_pointer = $cpu$$605$$.previous_ip);
  }
};
$table16$$[174] = $table32$$[174] = function $$table32$$$174$($cpu$$606$$) {
  a: {
    var $data_dest$$inline_592_dest$$inline_590$$, $data_src$$inline_591$$;
    $data_dest$$inline_592_dest$$inline_590$$ = 0;
    var $phys_dest$$inline_593$$, $size$$inline_594$$ = $cpu$$606$$.flags & 1024 ? -1 : 1, $cont$$inline_595$$ = !1;
    $data_src$$inline_591$$ = $cpu$$606$$.reg8[0];
    $data_dest$$inline_592_dest$$inline_590$$ = $cpu$$606$$.get_seg(0) + $cpu$$606$$.regv[$cpu$$606$$.reg_vdi] | 0;
    if (0 !== $cpu$$606$$.repeat_string_prefix) {
      var $count$$inline_596$$ = $cpu$$606$$.regv[$cpu$$606$$.reg_vcx] >>> 0, $start_count$$inline_597$$ = $count$$inline_596$$;
      if (0 === $count$$inline_596$$) {
        break a;
      }
      var $next_cycle$$inline_598$$ = 16384, $single_size$$inline_599$$ = $size$$inline_594$$ >> 31 | 1;
      $cpu$$606$$.paging ? ($next_cycle$$inline_598$$ = Math.min($next_cycle$$inline_598$$, ($single_size$$inline_599$$ >> 1 ^ ~$data_dest$$inline_592_dest$$inline_590$$) & 4095), $phys_dest$$inline_593$$ = $cpu$$606$$.translate_address_read($data_dest$$inline_592_dest$$inline_590$$)) : $phys_dest$$inline_593$$ = $data_dest$$inline_592_dest$$inline_590$$;
      do {
        $data_dest$$inline_592_dest$$inline_590$$ = $cpu$$606$$.memory.read8($phys_dest$$inline_593$$), $phys_dest$$inline_593$$ += $single_size$$inline_599$$, $cont$$inline_595$$ = 0 !== --$count$$inline_596$$ && $data_src$$inline_591$$ === $data_dest$$inline_592_dest$$inline_590$$ === (2 === $cpu$$606$$.repeat_string_prefix);
      } while ($cont$$inline_595$$ && $next_cycle$$inline_598$$--);
      $cpu$$606$$.regv[$cpu$$606$$.reg_vdi] += $size$$inline_594$$ * ($start_count$$inline_597$$ - $count$$inline_596$$) | 0;
      $cpu$$606$$.regv[$cpu$$606$$.reg_vcx] = $count$$inline_596$$;
      $cpu$$606$$.timestamp_counter += $start_count$$inline_597$$ - $count$$inline_596$$;
    } else {
      $phys_dest$$inline_593$$ = $cpu$$606$$.translate_address_read($data_dest$$inline_592_dest$$inline_590$$), $data_dest$$inline_592_dest$$inline_590$$ = $cpu$$606$$.memory.read8($phys_dest$$inline_593$$), $cpu$$606$$.regv[$cpu$$606$$.reg_vdi] += $size$$inline_594$$;
    }
    $cpu$$606$$.sub($data_src$$inline_591$$, $data_dest$$inline_592_dest$$inline_590$$, 7);
    $cont$$inline_595$$ && ($cpu$$606$$.instruction_pointer = $cpu$$606$$.previous_ip);
  }
};
$table16$$[175] = function $$table16$$$175$($cpu$$607$$) {
  a: {
    var $dest$$inline_602_phys_dest$$inline_605$$, $data_src$$inline_603$$, $data_dest$$inline_604$$ = 0, $size$$inline_606$$ = $cpu$$607$$.flags & 1024 ? -2 : 2, $cont$$inline_607$$ = !1;
    $data_src$$inline_603$$ = $cpu$$607$$.reg16[0];
    $dest$$inline_602_phys_dest$$inline_605$$ = $cpu$$607$$.get_seg(0) + $cpu$$607$$.regv[$cpu$$607$$.reg_vdi] | 0;
    if (0 !== $cpu$$607$$.repeat_string_prefix) {
      var $count$$inline_608$$ = $cpu$$607$$.regv[$cpu$$607$$.reg_vcx] >>> 0, $start_count$$inline_609$$ = $count$$inline_608$$;
      if (0 === $count$$inline_608$$) {
        break a;
      }
      var $next_cycle$$inline_610$$ = 16384;
      if ($dest$$inline_602_phys_dest$$inline_605$$ & 1) {
        do {
          $data_dest$$inline_604$$ = $cpu$$607$$.safe_read16($dest$$inline_602_phys_dest$$inline_605$$), $dest$$inline_602_phys_dest$$inline_605$$ += $size$$inline_606$$, $cpu$$607$$.regv[$cpu$$607$$.reg_vdi] += $size$$inline_606$$, $cont$$inline_607$$ = 0 !== --$cpu$$607$$.regv[$cpu$$607$$.reg_vcx] && $data_src$$inline_603$$ === $data_dest$$inline_604$$ === (2 === $cpu$$607$$.repeat_string_prefix);
        } while ($cont$$inline_607$$ && $next_cycle$$inline_610$$--);
      } else {
        var $single_size$$inline_611$$ = $size$$inline_606$$ >> 31 | 1;
        $cpu$$607$$.paging && ($next_cycle$$inline_610$$ = Math.min($next_cycle$$inline_610$$, ($single_size$$inline_611$$ >> 1 ^ ~$dest$$inline_602_phys_dest$$inline_605$$) & 4095), $dest$$inline_602_phys_dest$$inline_605$$ = $cpu$$607$$.translate_address_read($dest$$inline_602_phys_dest$$inline_605$$), $next_cycle$$inline_610$$ >>= 1);
        $dest$$inline_602_phys_dest$$inline_605$$ >>>= 1;
        do {
          $data_dest$$inline_604$$ = $cpu$$607$$.memory.read_aligned16($dest$$inline_602_phys_dest$$inline_605$$), $dest$$inline_602_phys_dest$$inline_605$$ += $single_size$$inline_611$$, $cont$$inline_607$$ = 0 !== --$count$$inline_608$$ && $data_src$$inline_603$$ === $data_dest$$inline_604$$ === (2 === $cpu$$607$$.repeat_string_prefix);
        } while ($cont$$inline_607$$ && $next_cycle$$inline_610$$--);
        $cpu$$607$$.regv[$cpu$$607$$.reg_vdi] += $size$$inline_606$$ * ($start_count$$inline_609$$ - $count$$inline_608$$) | 0;
        $cpu$$607$$.regv[$cpu$$607$$.reg_vcx] = $count$$inline_608$$;
        $cpu$$607$$.timestamp_counter += $start_count$$inline_609$$ - $count$$inline_608$$;
      }
    } else {
      $data_dest$$inline_604$$ = $cpu$$607$$.safe_read16($dest$$inline_602_phys_dest$$inline_605$$), $cpu$$607$$.regv[$cpu$$607$$.reg_vdi] += $size$$inline_606$$;
    }
    $cpu$$607$$.sub($data_src$$inline_603$$, $data_dest$$inline_604$$, 15);
    $cont$$inline_607$$ && ($cpu$$607$$.instruction_pointer = $cpu$$607$$.previous_ip);
  }
};
$table32$$[175] = function $$table32$$$175$($cpu$$608$$) {
  a: {
    var $dest$$inline_614_phys_dest$$inline_617$$, $data_src$$inline_615$$, $data_dest$$inline_616$$ = 0, $size$$inline_618$$ = $cpu$$608$$.flags & 1024 ? -4 : 4, $cont$$inline_619$$ = !1;
    $data_src$$inline_615$$ = $cpu$$608$$.reg32s[0];
    $dest$$inline_614_phys_dest$$inline_617$$ = $cpu$$608$$.get_seg(0) + $cpu$$608$$.regv[$cpu$$608$$.reg_vdi] | 0;
    if (0 !== $cpu$$608$$.repeat_string_prefix) {
      var $count$$inline_620$$ = $cpu$$608$$.regv[$cpu$$608$$.reg_vcx] >>> 0, $start_count$$inline_621$$ = $count$$inline_620$$;
      if (0 === $count$$inline_620$$) {
        break a;
      }
      var $next_cycle$$inline_622$$ = 16384;
      if ($dest$$inline_614_phys_dest$$inline_617$$ & 3) {
        do {
          $data_dest$$inline_616$$ = $cpu$$608$$.safe_read32s($dest$$inline_614_phys_dest$$inline_617$$), $dest$$inline_614_phys_dest$$inline_617$$ += $size$$inline_618$$, $cpu$$608$$.regv[$cpu$$608$$.reg_vdi] += $size$$inline_618$$, $cont$$inline_619$$ = 0 !== --$cpu$$608$$.regv[$cpu$$608$$.reg_vcx] && $data_src$$inline_615$$ === $data_dest$$inline_616$$ === (2 === $cpu$$608$$.repeat_string_prefix);
        } while ($cont$$inline_619$$ && $next_cycle$$inline_622$$--);
      } else {
        var $single_size$$inline_623$$ = $size$$inline_618$$ >> 31 | 1;
        $cpu$$608$$.paging && ($next_cycle$$inline_622$$ = Math.min($next_cycle$$inline_622$$, ($single_size$$inline_623$$ >> 1 ^ ~$dest$$inline_614_phys_dest$$inline_617$$) & 4095), $dest$$inline_614_phys_dest$$inline_617$$ = $cpu$$608$$.translate_address_read($dest$$inline_614_phys_dest$$inline_617$$), $next_cycle$$inline_622$$ >>= 2);
        $dest$$inline_614_phys_dest$$inline_617$$ >>>= 2;
        do {
          $data_dest$$inline_616$$ = $cpu$$608$$.memory.read_aligned32($dest$$inline_614_phys_dest$$inline_617$$), $dest$$inline_614_phys_dest$$inline_617$$ += $single_size$$inline_623$$, $cont$$inline_619$$ = 0 !== --$count$$inline_620$$ && $data_src$$inline_615$$ === $data_dest$$inline_616$$ === (2 === $cpu$$608$$.repeat_string_prefix);
        } while ($cont$$inline_619$$ && $next_cycle$$inline_622$$--);
        $cpu$$608$$.regv[$cpu$$608$$.reg_vdi] += $size$$inline_618$$ * ($start_count$$inline_621$$ - $count$$inline_620$$) | 0;
        $cpu$$608$$.regv[$cpu$$608$$.reg_vcx] = $count$$inline_620$$;
        $cpu$$608$$.timestamp_counter += $start_count$$inline_621$$ - $count$$inline_620$$;
      }
    } else {
      $data_dest$$inline_616$$ = $cpu$$608$$.safe_read32s($dest$$inline_614_phys_dest$$inline_617$$), $cpu$$608$$.regv[$cpu$$608$$.reg_vdi] += $size$$inline_618$$;
    }
    $cpu$$608$$.sub($data_src$$inline_615$$, $data_dest$$inline_616$$, 31);
    $cont$$inline_619$$ && ($cpu$$608$$.instruction_pointer = $cpu$$608$$.previous_ip);
  }
};
$table16$$[176] = $table32$$[176] = function $$table32$$$176$($cpu$$609$$) {
  $cpu$$609$$.reg8[0] = $cpu$$609$$.read_imm8();
};
$table16$$[177] = $table32$$[177] = function $$table32$$$177$($cpu$$610$$) {
  $cpu$$610$$.reg8[4] = $cpu$$610$$.read_imm8();
};
$table16$$[178] = $table32$$[178] = function $$table32$$$178$($cpu$$611$$) {
  $cpu$$611$$.reg8[8] = $cpu$$611$$.read_imm8();
};
$table16$$[179] = $table32$$[179] = function $$table32$$$179$($cpu$$612$$) {
  $cpu$$612$$.reg8[12] = $cpu$$612$$.read_imm8();
};
$table16$$[180] = $table32$$[180] = function $$table32$$$180$($cpu$$613$$) {
  $cpu$$613$$.reg8[1] = $cpu$$613$$.read_imm8();
};
$table16$$[181] = $table32$$[181] = function $$table32$$$181$($cpu$$614$$) {
  $cpu$$614$$.reg8[5] = $cpu$$614$$.read_imm8();
};
$table16$$[182] = $table32$$[182] = function $$table32$$$182$($cpu$$615$$) {
  $cpu$$615$$.reg8[9] = $cpu$$615$$.read_imm8();
};
$table16$$[183] = $table32$$[183] = function $$table32$$$183$($cpu$$616$$) {
  $cpu$$616$$.reg8[13] = $cpu$$616$$.read_imm8();
};
$table16$$[184] = function $$table16$$$184$($cpu$$617$$) {
  $cpu$$617$$.reg16[0] = $cpu$$617$$.read_imm16();
};
$table32$$[184] = function $$table32$$$184$($cpu$$618$$) {
  $cpu$$618$$.reg32s[0] = $cpu$$618$$.read_imm32s();
};
$table16$$[185] = function $$table16$$$185$($cpu$$619$$) {
  $cpu$$619$$.reg16[2] = $cpu$$619$$.read_imm16();
};
$table32$$[185] = function $$table32$$$185$($cpu$$620$$) {
  $cpu$$620$$.reg32s[1] = $cpu$$620$$.read_imm32s();
};
$table16$$[186] = function $$table16$$$186$($cpu$$621$$) {
  $cpu$$621$$.reg16[4] = $cpu$$621$$.read_imm16();
};
$table32$$[186] = function $$table32$$$186$($cpu$$622$$) {
  $cpu$$622$$.reg32s[2] = $cpu$$622$$.read_imm32s();
};
$table16$$[187] = function $$table16$$$187$($cpu$$623$$) {
  $cpu$$623$$.reg16[6] = $cpu$$623$$.read_imm16();
};
$table32$$[187] = function $$table32$$$187$($cpu$$624$$) {
  $cpu$$624$$.reg32s[3] = $cpu$$624$$.read_imm32s();
};
$table16$$[188] = function $$table16$$$188$($cpu$$625$$) {
  $cpu$$625$$.reg16[8] = $cpu$$625$$.read_imm16();
};
$table32$$[188] = function $$table32$$$188$($cpu$$626$$) {
  $cpu$$626$$.reg32s[4] = $cpu$$626$$.read_imm32s();
};
$table16$$[189] = function $$table16$$$189$($cpu$$627$$) {
  $cpu$$627$$.reg16[10] = $cpu$$627$$.read_imm16();
};
$table32$$[189] = function $$table32$$$189$($cpu$$628$$) {
  $cpu$$628$$.reg32s[5] = $cpu$$628$$.read_imm32s();
};
$table16$$[190] = function $$table16$$$190$($cpu$$629$$) {
  $cpu$$629$$.reg16[12] = $cpu$$629$$.read_imm16();
};
$table32$$[190] = function $$table32$$$190$($cpu$$630$$) {
  $cpu$$630$$.reg32s[6] = $cpu$$630$$.read_imm32s();
};
$table16$$[191] = function $$table16$$$191$($cpu$$631$$) {
  $cpu$$631$$.reg16[14] = $cpu$$631$$.read_imm16();
};
$table32$$[191] = function $$table32$$$191$($cpu$$632$$) {
  $cpu$$632$$.reg32s[7] = $cpu$$632$$.read_imm32s();
};
$table16$$[192] = $table32$$[192] = function $$table32$$$192$($cpu$$633$$) {
  var $modrm_byte$$78$$ = $cpu$$633$$.read_imm8(), $data2$$5$$, $data$$101$$, $addr$$25$$, $result$$53$$;
  192 > $modrm_byte$$78$$ ? ($addr$$25$$ = $cpu$$633$$.translate_address_write($cpu$$633$$.modrm_resolve($modrm_byte$$78$$)), $data$$101$$ = $cpu$$633$$.memory.read8($addr$$25$$)) : $data$$101$$ = $cpu$$633$$.reg8[$modrm_byte$$78$$ << 2 & 12 | $modrm_byte$$78$$ >> 2 & 1];
  $result$$53$$ = 0;
  $data2$$5$$ = $cpu$$633$$.read_imm8() & 31;
  switch($modrm_byte$$78$$ >> 3 & 7) {
    case 0:
      $result$$53$$ = $cpu$$633$$.rol8($data$$101$$, $data2$$5$$);
      break;
    case 1:
      $result$$53$$ = $cpu$$633$$.ror8($data$$101$$, $data2$$5$$);
      break;
    case 2:
      $result$$53$$ = $cpu$$633$$.rcl8($data$$101$$, $data2$$5$$);
      break;
    case 3:
      $result$$53$$ = $cpu$$633$$.rcr8($data$$101$$, $data2$$5$$);
      break;
    case 4:
      $result$$53$$ = $cpu$$633$$.shl8($data$$101$$, $data2$$5$$);
      break;
    case 5:
      $result$$53$$ = $cpu$$633$$.shr8($data$$101$$, $data2$$5$$);
      break;
    case 6:
      $result$$53$$ = $cpu$$633$$.shl8($data$$101$$, $data2$$5$$);
      break;
    case 7:
      $result$$53$$ = $cpu$$633$$.sar8($data$$101$$, $data2$$5$$);
  }
  192 > $modrm_byte$$78$$ ? $cpu$$633$$.memory.write8($addr$$25$$, $result$$53$$) : $cpu$$633$$.reg8[$modrm_byte$$78$$ << 2 & 12 | $modrm_byte$$78$$ >> 2 & 1] = $result$$53$$;
};
$table16$$[193] = function $$table16$$$193$($cpu$$634$$) {
  var $modrm_byte$$79$$ = $cpu$$634$$.read_imm8(), $data2$$6_virt_addr$$25$$, $data$$102$$, $phys_addr$$24$$, $phys_addr_high$$21$$ = 0, $result$$54$$;
  192 > $modrm_byte$$79$$ ? ($data2$$6_virt_addr$$25$$ = $cpu$$634$$.modrm_resolve($modrm_byte$$79$$), $phys_addr$$24$$ = $cpu$$634$$.translate_address_write($data2$$6_virt_addr$$25$$), $cpu$$634$$.paging && 4095 === ($data2$$6_virt_addr$$25$$ & 4095) ? ($phys_addr_high$$21$$ = $cpu$$634$$.translate_address_write($data2$$6_virt_addr$$25$$ + 1), $data$$102$$ = $cpu$$634$$.virt_boundary_read16($phys_addr$$24$$, $phys_addr_high$$21$$)) : $data$$102$$ = $cpu$$634$$.memory.read16($phys_addr$$24$$)) : 
  $data$$102$$ = $cpu$$634$$.reg16[$modrm_byte$$79$$ << 1 & 14];
  $result$$54$$ = 0;
  $data2$$6_virt_addr$$25$$ = $cpu$$634$$.read_imm8() & 31;
  switch($modrm_byte$$79$$ >> 3 & 7) {
    case 0:
      $result$$54$$ = $cpu$$634$$.rol16($data$$102$$, $data2$$6_virt_addr$$25$$);
      break;
    case 1:
      $result$$54$$ = $cpu$$634$$.ror16($data$$102$$, $data2$$6_virt_addr$$25$$);
      break;
    case 2:
      $result$$54$$ = $cpu$$634$$.rcl16($data$$102$$, $data2$$6_virt_addr$$25$$);
      break;
    case 3:
      $result$$54$$ = $cpu$$634$$.rcr16($data$$102$$, $data2$$6_virt_addr$$25$$);
      break;
    case 4:
      $result$$54$$ = $cpu$$634$$.shl16($data$$102$$, $data2$$6_virt_addr$$25$$);
      break;
    case 5:
      $result$$54$$ = $cpu$$634$$.shr16($data$$102$$, $data2$$6_virt_addr$$25$$);
      break;
    case 6:
      $result$$54$$ = $cpu$$634$$.shl16($data$$102$$, $data2$$6_virt_addr$$25$$);
      break;
    case 7:
      $result$$54$$ = $cpu$$634$$.sar16($data$$102$$, $data2$$6_virt_addr$$25$$);
  }
  192 > $modrm_byte$$79$$ ? $phys_addr_high$$21$$ ? $cpu$$634$$.virt_boundary_write16($phys_addr$$24$$, $phys_addr_high$$21$$, $result$$54$$) : $cpu$$634$$.memory.write16($phys_addr$$24$$, $result$$54$$) : $cpu$$634$$.reg16[$modrm_byte$$79$$ << 1 & 14] = $result$$54$$;
};
$table32$$[193] = function $$table32$$$193$($cpu$$635$$) {
  var $modrm_byte$$80$$ = $cpu$$635$$.read_imm8(), $data2$$7_virt_addr$$26$$, $data$$103$$, $phys_addr$$25$$, $phys_addr_high$$22$$ = 0, $result$$55$$;
  192 > $modrm_byte$$80$$ ? ($data2$$7_virt_addr$$26$$ = $cpu$$635$$.modrm_resolve($modrm_byte$$80$$), $phys_addr$$25$$ = $cpu$$635$$.translate_address_write($data2$$7_virt_addr$$26$$), $cpu$$635$$.paging && 4093 <= ($data2$$7_virt_addr$$26$$ & 4095) ? ($phys_addr_high$$22$$ = $cpu$$635$$.translate_address_write($data2$$7_virt_addr$$26$$ + 3), $data$$103$$ = $cpu$$635$$.virt_boundary_read32s($phys_addr$$25$$, $phys_addr_high$$22$$)) : $data$$103$$ = $cpu$$635$$.memory.read32s($phys_addr$$25$$)) : 
  $data$$103$$ = $cpu$$635$$.reg32s[$modrm_byte$$80$$ & 7];
  $result$$55$$ = 0;
  $data2$$7_virt_addr$$26$$ = $cpu$$635$$.read_imm8() & 31;
  switch($modrm_byte$$80$$ >> 3 & 7) {
    case 0:
      $result$$55$$ = $cpu$$635$$.rol32($data$$103$$, $data2$$7_virt_addr$$26$$);
      break;
    case 1:
      $result$$55$$ = $cpu$$635$$.ror32($data$$103$$, $data2$$7_virt_addr$$26$$);
      break;
    case 2:
      $result$$55$$ = $cpu$$635$$.rcl32($data$$103$$, $data2$$7_virt_addr$$26$$);
      break;
    case 3:
      $result$$55$$ = $cpu$$635$$.rcr32($data$$103$$, $data2$$7_virt_addr$$26$$);
      break;
    case 4:
      $result$$55$$ = $cpu$$635$$.shl32($data$$103$$, $data2$$7_virt_addr$$26$$);
      break;
    case 5:
      $result$$55$$ = $cpu$$635$$.shr32($data$$103$$, $data2$$7_virt_addr$$26$$);
      break;
    case 6:
      $result$$55$$ = $cpu$$635$$.shl32($data$$103$$, $data2$$7_virt_addr$$26$$);
      break;
    case 7:
      $result$$55$$ = $cpu$$635$$.sar32($data$$103$$, $data2$$7_virt_addr$$26$$);
  }
  192 > $modrm_byte$$80$$ ? $phys_addr_high$$22$$ ? $cpu$$635$$.virt_boundary_write32($phys_addr$$25$$, $phys_addr_high$$22$$, $result$$55$$) : $cpu$$635$$.memory.write32($phys_addr$$25$$, $result$$55$$) : $cpu$$635$$.reg32s[$modrm_byte$$80$$ & 7] = $result$$55$$;
};
$table16$$[194] = function $$table16$$$194$($cpu$$636$$) {
  var $imm16$$ = $cpu$$636$$.read_imm16();
  $cpu$$636$$.instruction_pointer = $cpu$$636$$.get_seg(1) + $cpu$$636$$.pop16() | 0;
  $cpu$$636$$.stack_reg[$cpu$$636$$.reg_vsp] += $imm16$$;
  $cpu$$636$$.last_instr_jump = !0;
};
$table32$$[194] = function $$table32$$$194$($cpu$$637$$) {
  var $imm16$$1$$ = $cpu$$637$$.read_imm16();
  $cpu$$637$$.instruction_pointer = $cpu$$637$$.get_seg(1) + $cpu$$637$$.pop32s() | 0;
  $cpu$$637$$.stack_reg[$cpu$$637$$.reg_vsp] += $imm16$$1$$;
  $cpu$$637$$.last_instr_jump = !0;
};
$table16$$[195] = function $$table16$$$195$($cpu$$638$$) {
  $cpu$$638$$.instruction_pointer = $cpu$$638$$.get_seg(1) + $cpu$$638$$.pop16() | 0;
  $cpu$$638$$.last_instr_jump = !0;
};
$table32$$[195] = function $$table32$$$195$($cpu$$639$$) {
  $cpu$$639$$.instruction_pointer = $cpu$$639$$.get_seg(1) + $cpu$$639$$.pop32s() | 0;
  $cpu$$639$$.last_instr_jump = !0;
};
$table16$$[196] = function $$table16$$$196$($cpu$$640$$) {
  var $modrm_byte$$81$$ = $cpu$$640$$.read_imm8();
  192 <= $modrm_byte$$81$$ && $cpu$$640$$.trigger_ud();
  $cpu$$640$$.lss16(0, $cpu$$640$$.modrm_resolve($modrm_byte$$81$$), $modrm_byte$$81$$ >> 2 & 14);
};
$table32$$[196] = function $$table32$$$196$($cpu$$641$$) {
  var $modrm_byte$$82$$ = $cpu$$641$$.read_imm8();
  192 <= $modrm_byte$$82$$ && $cpu$$641$$.trigger_ud();
  $cpu$$641$$.lss32(0, $cpu$$641$$.modrm_resolve($modrm_byte$$82$$), $modrm_byte$$82$$ >> 3 & 7);
};
$table16$$[197] = function $$table16$$$197$($cpu$$642$$) {
  var $modrm_byte$$83$$ = $cpu$$642$$.read_imm8();
  192 <= $modrm_byte$$83$$ && $cpu$$642$$.trigger_ud();
  $cpu$$642$$.lss16(3, $cpu$$642$$.modrm_resolve($modrm_byte$$83$$), $modrm_byte$$83$$ >> 2 & 14);
};
$table32$$[197] = function $$table32$$$197$($cpu$$643$$) {
  var $modrm_byte$$84$$ = $cpu$$643$$.read_imm8();
  192 <= $modrm_byte$$84$$ && $cpu$$643$$.trigger_ud();
  $cpu$$643$$.lss32(3, $cpu$$643$$.modrm_resolve($modrm_byte$$84$$), $modrm_byte$$84$$ >> 3 & 7);
};
$table16$$[198] = $table32$$[198] = function $$table32$$$198$($cpu$$644$$) {
  var $modrm_byte$$85$$ = $cpu$$644$$.read_imm8();
  if (192 > $modrm_byte$$85$$) {
    var $addr$$26$$ = $cpu$$644$$.modrm_resolve($modrm_byte$$85$$)
  }
  var $data$$104$$ = $cpu$$644$$.read_imm8();
  192 > $modrm_byte$$85$$ ? $cpu$$644$$.safe_write8($addr$$26$$, $data$$104$$) : $cpu$$644$$.reg8[$modrm_byte$$85$$ << 2 & 12 | $modrm_byte$$85$$ >> 2 & 1] = $data$$104$$;
};
$table16$$[199] = function $$table16$$$199$($cpu$$645$$) {
  var $modrm_byte$$86$$ = $cpu$$645$$.read_imm8();
  if (192 > $modrm_byte$$86$$) {
    var $addr$$27$$ = $cpu$$645$$.modrm_resolve($modrm_byte$$86$$)
  }
  var $data$$105$$ = $cpu$$645$$.read_imm16();
  192 > $modrm_byte$$86$$ ? $cpu$$645$$.safe_write16($addr$$27$$, $data$$105$$) : $cpu$$645$$.reg16[$modrm_byte$$86$$ << 1 & 14] = $data$$105$$;
};
$table32$$[199] = function $$table32$$$199$($cpu$$646$$) {
  var $modrm_byte$$87$$ = $cpu$$646$$.read_imm8();
  if (192 > $modrm_byte$$87$$) {
    var $addr$$28$$ = $cpu$$646$$.modrm_resolve($modrm_byte$$87$$)
  }
  var $data$$106$$ = $cpu$$646$$.read_imm32s();
  192 > $modrm_byte$$87$$ ? $cpu$$646$$.safe_write32($addr$$28$$, $data$$106$$) : $cpu$$646$$.reg32[$modrm_byte$$87$$ & 7] = $data$$106$$;
};
$table16$$[200] = function $$table16$$$200$($cpu$$647$$) {
  $cpu$$647$$.enter16();
};
$table32$$[200] = function $$table32$$$200$($cpu$$648$$) {
  $cpu$$648$$.enter32();
};
$table16$$[201] = function $$table16$$$201$($cpu$$649$$) {
  $cpu$$649$$.stack_reg[$cpu$$649$$.reg_vsp] = $cpu$$649$$.stack_reg[$cpu$$649$$.reg_vbp];
  $cpu$$649$$.reg16[10] = $cpu$$649$$.pop16();
};
$table32$$[201] = function $$table32$$$201$($cpu$$650$$) {
  $cpu$$650$$.stack_reg[$cpu$$650$$.reg_vsp] = $cpu$$650$$.stack_reg[$cpu$$650$$.reg_vbp];
  $cpu$$650$$.reg32s[5] = $cpu$$650$$.pop32s();
};
$table16$$[202] = function $$table16$$$202$($cpu$$651$$) {
  $cpu$$651$$.translate_address_read($cpu$$651$$.get_seg(2) + $cpu$$651$$.stack_reg[$cpu$$651$$.reg_vsp] + 4);
  var $imm16$$2$$ = $cpu$$651$$.read_imm16(), $ip$$ = $cpu$$651$$.pop16();
  $cpu$$651$$.switch_seg(1, $cpu$$651$$.pop16());
  $cpu$$651$$.instruction_pointer = $cpu$$651$$.get_seg(1) + $ip$$ | 0;
  $cpu$$651$$.stack_reg[$cpu$$651$$.reg_vsp] += $imm16$$2$$;
  $cpu$$651$$.last_instr_jump = !0;
};
$table32$$[202] = function $$table32$$$202$($cpu$$652$$) {
  $cpu$$652$$.translate_address_read($cpu$$652$$.get_seg(2) + $cpu$$652$$.stack_reg[$cpu$$652$$.reg_vsp] + 8);
  var $imm16$$3$$ = $cpu$$652$$.read_imm16(), $ip$$1$$ = $cpu$$652$$.pop32s();
  $cpu$$652$$.switch_seg(1, $cpu$$652$$.pop32s() & 65535);
  $cpu$$652$$.instruction_pointer = $cpu$$652$$.get_seg(1) + $ip$$1$$ | 0;
  $cpu$$652$$.stack_reg[$cpu$$652$$.reg_vsp] += $imm16$$3$$;
  $cpu$$652$$.last_instr_jump = !0;
};
$table16$$[203] = function $$table16$$$203$($cpu$$653$$) {
  $cpu$$653$$.translate_address_read($cpu$$653$$.get_seg(2) + $cpu$$653$$.stack_reg[$cpu$$653$$.reg_vsp] + 4);
  var $ip$$2$$ = $cpu$$653$$.pop16();
  $cpu$$653$$.switch_seg(1, $cpu$$653$$.pop16());
  $cpu$$653$$.instruction_pointer = $cpu$$653$$.get_seg(1) + $ip$$2$$ | 0;
  $cpu$$653$$.last_instr_jump = !0;
};
$table32$$[203] = function $$table32$$$203$($cpu$$654$$) {
  $cpu$$654$$.translate_address_read($cpu$$654$$.get_seg(2) + $cpu$$654$$.stack_reg[$cpu$$654$$.reg_vsp] + 8);
  var $ip$$3$$ = $cpu$$654$$.pop32s();
  $cpu$$654$$.switch_seg(1, $cpu$$654$$.pop32s() & 65535);
  $cpu$$654$$.instruction_pointer = $cpu$$654$$.get_seg(1) + $ip$$3$$ | 0;
  $cpu$$654$$.last_instr_jump = !0;
};
$table16$$[204] = $table32$$[204] = function $$table32$$$204$($cpu$$655$$) {
  $cpu$$655$$.call_interrupt_vector(3, !0, !1);
};
$table16$$[205] = $table32$$[205] = function $$table32$$$205$($cpu$$656$$) {
  var $imm8$$2$$ = $cpu$$656$$.read_imm8();
  $cpu$$656$$.call_interrupt_vector($imm8$$2$$, !0, !1);
};
$table16$$[206] = $table32$$[206] = function $$table32$$$206$($cpu$$657$$) {
  $cpu$$657$$.getof() && $cpu$$657$$.call_interrupt_vector(4, !0, !1);
};
$table16$$[207] = function $$table16$$$207$($cpu$$658$$) {
  $cpu$$658$$.iret16();
};
$table32$$[207] = function $$table32$$$207$($cpu$$659$$) {
  $cpu$$659$$.iret32();
};
$table16$$[208] = $table32$$[208] = function $$table32$$$208$($cpu$$660$$) {
  var $modrm_byte$$88$$ = $cpu$$660$$.read_imm8(), $data$$107$$, $addr$$29$$, $result$$56$$;
  192 > $modrm_byte$$88$$ ? ($addr$$29$$ = $cpu$$660$$.translate_address_write($cpu$$660$$.modrm_resolve($modrm_byte$$88$$)), $data$$107$$ = $cpu$$660$$.memory.read8($addr$$29$$)) : $data$$107$$ = $cpu$$660$$.reg8[$modrm_byte$$88$$ << 2 & 12 | $modrm_byte$$88$$ >> 2 & 1];
  $result$$56$$ = 0;
  switch($modrm_byte$$88$$ >> 3 & 7) {
    case 0:
      $result$$56$$ = $cpu$$660$$.rol8($data$$107$$, 1);
      break;
    case 1:
      $result$$56$$ = $cpu$$660$$.ror8($data$$107$$, 1);
      break;
    case 2:
      $result$$56$$ = $cpu$$660$$.rcl8($data$$107$$, 1);
      break;
    case 3:
      $result$$56$$ = $cpu$$660$$.rcr8($data$$107$$, 1);
      break;
    case 4:
      $result$$56$$ = $cpu$$660$$.shl8($data$$107$$, 1);
      break;
    case 5:
      $result$$56$$ = $cpu$$660$$.shr8($data$$107$$, 1);
      break;
    case 6:
      $result$$56$$ = $cpu$$660$$.shl8($data$$107$$, 1);
      break;
    case 7:
      $result$$56$$ = $cpu$$660$$.sar8($data$$107$$, 1);
  }
  192 > $modrm_byte$$88$$ ? $cpu$$660$$.memory.write8($addr$$29$$, $result$$56$$) : $cpu$$660$$.reg8[$modrm_byte$$88$$ << 2 & 12 | $modrm_byte$$88$$ >> 2 & 1] = $result$$56$$;
};
$table16$$[209] = function $$table16$$$209$($cpu$$661$$) {
  var $modrm_byte$$89$$ = $cpu$$661$$.read_imm8(), $data$$108_virt_addr$$27$$, $phys_addr$$26$$, $phys_addr_high$$23$$ = 0, $result$$57$$;
  192 > $modrm_byte$$89$$ ? ($data$$108_virt_addr$$27$$ = $cpu$$661$$.modrm_resolve($modrm_byte$$89$$), $phys_addr$$26$$ = $cpu$$661$$.translate_address_write($data$$108_virt_addr$$27$$), $cpu$$661$$.paging && 4095 === ($data$$108_virt_addr$$27$$ & 4095) ? ($phys_addr_high$$23$$ = $cpu$$661$$.translate_address_write($data$$108_virt_addr$$27$$ + 1), $data$$108_virt_addr$$27$$ = $cpu$$661$$.virt_boundary_read16($phys_addr$$26$$, $phys_addr_high$$23$$)) : $data$$108_virt_addr$$27$$ = $cpu$$661$$.memory.read16($phys_addr$$26$$)) : 
  $data$$108_virt_addr$$27$$ = $cpu$$661$$.reg16[$modrm_byte$$89$$ << 1 & 14];
  $result$$57$$ = 0;
  switch($modrm_byte$$89$$ >> 3 & 7) {
    case 0:
      $result$$57$$ = $cpu$$661$$.rol16($data$$108_virt_addr$$27$$, 1);
      break;
    case 1:
      $result$$57$$ = $cpu$$661$$.ror16($data$$108_virt_addr$$27$$, 1);
      break;
    case 2:
      $result$$57$$ = $cpu$$661$$.rcl16($data$$108_virt_addr$$27$$, 1);
      break;
    case 3:
      $result$$57$$ = $cpu$$661$$.rcr16($data$$108_virt_addr$$27$$, 1);
      break;
    case 4:
      $result$$57$$ = $cpu$$661$$.shl16($data$$108_virt_addr$$27$$, 1);
      break;
    case 5:
      $result$$57$$ = $cpu$$661$$.shr16($data$$108_virt_addr$$27$$, 1);
      break;
    case 6:
      $result$$57$$ = $cpu$$661$$.shl16($data$$108_virt_addr$$27$$, 1);
      break;
    case 7:
      $result$$57$$ = $cpu$$661$$.sar16($data$$108_virt_addr$$27$$, 1);
  }
  192 > $modrm_byte$$89$$ ? $phys_addr_high$$23$$ ? $cpu$$661$$.virt_boundary_write16($phys_addr$$26$$, $phys_addr_high$$23$$, $result$$57$$) : $cpu$$661$$.memory.write16($phys_addr$$26$$, $result$$57$$) : $cpu$$661$$.reg16[$modrm_byte$$89$$ << 1 & 14] = $result$$57$$;
};
$table32$$[209] = function $$table32$$$209$($cpu$$662$$) {
  var $modrm_byte$$90$$ = $cpu$$662$$.read_imm8(), $data$$109_virt_addr$$28$$, $phys_addr$$27$$, $phys_addr_high$$24$$ = 0, $result$$58$$;
  192 > $modrm_byte$$90$$ ? ($data$$109_virt_addr$$28$$ = $cpu$$662$$.modrm_resolve($modrm_byte$$90$$), $phys_addr$$27$$ = $cpu$$662$$.translate_address_write($data$$109_virt_addr$$28$$), $cpu$$662$$.paging && 4093 <= ($data$$109_virt_addr$$28$$ & 4095) ? ($phys_addr_high$$24$$ = $cpu$$662$$.translate_address_write($data$$109_virt_addr$$28$$ + 3), $data$$109_virt_addr$$28$$ = $cpu$$662$$.virt_boundary_read32s($phys_addr$$27$$, $phys_addr_high$$24$$)) : $data$$109_virt_addr$$28$$ = $cpu$$662$$.memory.read32s($phys_addr$$27$$)) : 
  $data$$109_virt_addr$$28$$ = $cpu$$662$$.reg32s[$modrm_byte$$90$$ & 7];
  $result$$58$$ = 0;
  switch($modrm_byte$$90$$ >> 3 & 7) {
    case 0:
      $result$$58$$ = $cpu$$662$$.rol32($data$$109_virt_addr$$28$$, 1);
      break;
    case 1:
      $result$$58$$ = $cpu$$662$$.ror32($data$$109_virt_addr$$28$$, 1);
      break;
    case 2:
      $result$$58$$ = $cpu$$662$$.rcl32($data$$109_virt_addr$$28$$, 1);
      break;
    case 3:
      $result$$58$$ = $cpu$$662$$.rcr32($data$$109_virt_addr$$28$$, 1);
      break;
    case 4:
      $result$$58$$ = $cpu$$662$$.shl32($data$$109_virt_addr$$28$$, 1);
      break;
    case 5:
      $result$$58$$ = $cpu$$662$$.shr32($data$$109_virt_addr$$28$$, 1);
      break;
    case 6:
      $result$$58$$ = $cpu$$662$$.shl32($data$$109_virt_addr$$28$$, 1);
      break;
    case 7:
      $result$$58$$ = $cpu$$662$$.sar32($data$$109_virt_addr$$28$$, 1);
  }
  192 > $modrm_byte$$90$$ ? $phys_addr_high$$24$$ ? $cpu$$662$$.virt_boundary_write32($phys_addr$$27$$, $phys_addr_high$$24$$, $result$$58$$) : $cpu$$662$$.memory.write32($phys_addr$$27$$, $result$$58$$) : $cpu$$662$$.reg32s[$modrm_byte$$90$$ & 7] = $result$$58$$;
};
$table16$$[210] = $table32$$[210] = function $$table32$$$210$($cpu$$663$$) {
  var $modrm_byte$$91$$ = $cpu$$663$$.read_imm8(), $data2$$11$$, $data$$110$$, $addr$$30$$, $result$$59$$;
  192 > $modrm_byte$$91$$ ? ($addr$$30$$ = $cpu$$663$$.translate_address_write($cpu$$663$$.modrm_resolve($modrm_byte$$91$$)), $data$$110$$ = $cpu$$663$$.memory.read8($addr$$30$$)) : $data$$110$$ = $cpu$$663$$.reg8[$modrm_byte$$91$$ << 2 & 12 | $modrm_byte$$91$$ >> 2 & 1];
  $result$$59$$ = 0;
  $data2$$11$$ = $cpu$$663$$.reg8[4] & 31;
  switch($modrm_byte$$91$$ >> 3 & 7) {
    case 0:
      $result$$59$$ = $cpu$$663$$.rol8($data$$110$$, $data2$$11$$);
      break;
    case 1:
      $result$$59$$ = $cpu$$663$$.ror8($data$$110$$, $data2$$11$$);
      break;
    case 2:
      $result$$59$$ = $cpu$$663$$.rcl8($data$$110$$, $data2$$11$$);
      break;
    case 3:
      $result$$59$$ = $cpu$$663$$.rcr8($data$$110$$, $data2$$11$$);
      break;
    case 4:
      $result$$59$$ = $cpu$$663$$.shl8($data$$110$$, $data2$$11$$);
      break;
    case 5:
      $result$$59$$ = $cpu$$663$$.shr8($data$$110$$, $data2$$11$$);
      break;
    case 6:
      $result$$59$$ = $cpu$$663$$.shl8($data$$110$$, $data2$$11$$);
      break;
    case 7:
      $result$$59$$ = $cpu$$663$$.sar8($data$$110$$, $data2$$11$$);
  }
  192 > $modrm_byte$$91$$ ? $cpu$$663$$.memory.write8($addr$$30$$, $result$$59$$) : $cpu$$663$$.reg8[$modrm_byte$$91$$ << 2 & 12 | $modrm_byte$$91$$ >> 2 & 1] = $result$$59$$;
};
$table16$$[211] = function $$table16$$$211$($cpu$$664$$) {
  var $modrm_byte$$92$$ = $cpu$$664$$.read_imm8(), $data2$$12_virt_addr$$29$$, $data$$111$$, $phys_addr$$28$$, $phys_addr_high$$25$$ = 0, $result$$60$$;
  192 > $modrm_byte$$92$$ ? ($data2$$12_virt_addr$$29$$ = $cpu$$664$$.modrm_resolve($modrm_byte$$92$$), $phys_addr$$28$$ = $cpu$$664$$.translate_address_write($data2$$12_virt_addr$$29$$), $cpu$$664$$.paging && 4095 === ($data2$$12_virt_addr$$29$$ & 4095) ? ($phys_addr_high$$25$$ = $cpu$$664$$.translate_address_write($data2$$12_virt_addr$$29$$ + 1), $data$$111$$ = $cpu$$664$$.virt_boundary_read16($phys_addr$$28$$, $phys_addr_high$$25$$)) : $data$$111$$ = $cpu$$664$$.memory.read16($phys_addr$$28$$)) : 
  $data$$111$$ = $cpu$$664$$.reg16[$modrm_byte$$92$$ << 1 & 14];
  $result$$60$$ = 0;
  $data2$$12_virt_addr$$29$$ = $cpu$$664$$.reg8[4] & 31;
  switch($modrm_byte$$92$$ >> 3 & 7) {
    case 0:
      $result$$60$$ = $cpu$$664$$.rol16($data$$111$$, $data2$$12_virt_addr$$29$$);
      break;
    case 1:
      $result$$60$$ = $cpu$$664$$.ror16($data$$111$$, $data2$$12_virt_addr$$29$$);
      break;
    case 2:
      $result$$60$$ = $cpu$$664$$.rcl16($data$$111$$, $data2$$12_virt_addr$$29$$);
      break;
    case 3:
      $result$$60$$ = $cpu$$664$$.rcr16($data$$111$$, $data2$$12_virt_addr$$29$$);
      break;
    case 4:
      $result$$60$$ = $cpu$$664$$.shl16($data$$111$$, $data2$$12_virt_addr$$29$$);
      break;
    case 5:
      $result$$60$$ = $cpu$$664$$.shr16($data$$111$$, $data2$$12_virt_addr$$29$$);
      break;
    case 6:
      $result$$60$$ = $cpu$$664$$.shl16($data$$111$$, $data2$$12_virt_addr$$29$$);
      break;
    case 7:
      $result$$60$$ = $cpu$$664$$.sar16($data$$111$$, $data2$$12_virt_addr$$29$$);
  }
  192 > $modrm_byte$$92$$ ? $phys_addr_high$$25$$ ? $cpu$$664$$.virt_boundary_write16($phys_addr$$28$$, $phys_addr_high$$25$$, $result$$60$$) : $cpu$$664$$.memory.write16($phys_addr$$28$$, $result$$60$$) : $cpu$$664$$.reg16[$modrm_byte$$92$$ << 1 & 14] = $result$$60$$;
};
$table32$$[211] = function $$table32$$$211$($cpu$$665$$) {
  var $modrm_byte$$93$$ = $cpu$$665$$.read_imm8(), $data2$$13_virt_addr$$30$$, $data$$112$$, $phys_addr$$29$$, $phys_addr_high$$26$$ = 0, $result$$61$$;
  192 > $modrm_byte$$93$$ ? ($data2$$13_virt_addr$$30$$ = $cpu$$665$$.modrm_resolve($modrm_byte$$93$$), $phys_addr$$29$$ = $cpu$$665$$.translate_address_write($data2$$13_virt_addr$$30$$), $cpu$$665$$.paging && 4093 <= ($data2$$13_virt_addr$$30$$ & 4095) ? ($phys_addr_high$$26$$ = $cpu$$665$$.translate_address_write($data2$$13_virt_addr$$30$$ + 3), $data$$112$$ = $cpu$$665$$.virt_boundary_read32s($phys_addr$$29$$, $phys_addr_high$$26$$)) : $data$$112$$ = $cpu$$665$$.memory.read32s($phys_addr$$29$$)) : 
  $data$$112$$ = $cpu$$665$$.reg32s[$modrm_byte$$93$$ & 7];
  $result$$61$$ = 0;
  $data2$$13_virt_addr$$30$$ = $cpu$$665$$.reg8[4] & 31;
  switch($modrm_byte$$93$$ >> 3 & 7) {
    case 0:
      $result$$61$$ = $cpu$$665$$.rol32($data$$112$$, $data2$$13_virt_addr$$30$$);
      break;
    case 1:
      $result$$61$$ = $cpu$$665$$.ror32($data$$112$$, $data2$$13_virt_addr$$30$$);
      break;
    case 2:
      $result$$61$$ = $cpu$$665$$.rcl32($data$$112$$, $data2$$13_virt_addr$$30$$);
      break;
    case 3:
      $result$$61$$ = $cpu$$665$$.rcr32($data$$112$$, $data2$$13_virt_addr$$30$$);
      break;
    case 4:
      $result$$61$$ = $cpu$$665$$.shl32($data$$112$$, $data2$$13_virt_addr$$30$$);
      break;
    case 5:
      $result$$61$$ = $cpu$$665$$.shr32($data$$112$$, $data2$$13_virt_addr$$30$$);
      break;
    case 6:
      $result$$61$$ = $cpu$$665$$.shl32($data$$112$$, $data2$$13_virt_addr$$30$$);
      break;
    case 7:
      $result$$61$$ = $cpu$$665$$.sar32($data$$112$$, $data2$$13_virt_addr$$30$$);
  }
  192 > $modrm_byte$$93$$ ? $phys_addr_high$$26$$ ? $cpu$$665$$.virt_boundary_write32($phys_addr$$29$$, $phys_addr_high$$26$$, $result$$61$$) : $cpu$$665$$.memory.write32($phys_addr$$29$$, $result$$61$$) : $cpu$$665$$.reg32s[$modrm_byte$$93$$ & 7] = $result$$61$$;
};
$table16$$[212] = $table32$$[212] = function $$table32$$$212$($cpu$$666$$) {
  $cpu$$666$$.bcd_aam();
};
$table16$$[213] = $table32$$[213] = function $$table32$$$213$($cpu$$667$$) {
  $cpu$$667$$.bcd_aad();
};
$table16$$[214] = $table32$$[214] = function $$table32$$$214$($cpu$$668$$) {
  $cpu$$668$$.reg8[0] = -$cpu$$668$$.getcf();
};
$table16$$[215] = $table32$$[215] = function $$table32$$$215$($cpu$$669$$) {
  $cpu$$669$$.reg8[0] = $cpu$$669$$.address_size_32 ? $cpu$$669$$.safe_read8($cpu$$669$$.get_seg_prefix(3) + $cpu$$669$$.reg32s[3] + $cpu$$669$$.reg8[0]) : $cpu$$669$$.safe_read8($cpu$$669$$.get_seg_prefix(3) + $cpu$$669$$.reg16[6] + $cpu$$669$$.reg8[0]);
};
$table16$$[216] = $table32$$[216] = function $$table32$$$216$($cpu$$670$$) {
  var $modrm_byte$$94$$ = $cpu$$670$$.read_imm8();
  $cpu$$670$$.cr0 & 12 && $cpu$$670$$.trigger_nm();
  192 > $modrm_byte$$94$$ ? $cpu$$670$$.fpu.op_D8_mem($modrm_byte$$94$$, $cpu$$670$$.modrm_resolve($modrm_byte$$94$$)) : $cpu$$670$$.fpu.op_D8_reg($modrm_byte$$94$$);
};
$table16$$[217] = $table32$$[217] = function $$table32$$$217$($cpu$$671$$) {
  var $modrm_byte$$95$$ = $cpu$$671$$.read_imm8();
  $cpu$$671$$.cr0 & 12 && $cpu$$671$$.trigger_nm();
  192 > $modrm_byte$$95$$ ? $cpu$$671$$.fpu.op_D9_mem($modrm_byte$$95$$, $cpu$$671$$.modrm_resolve($modrm_byte$$95$$)) : $cpu$$671$$.fpu.op_D9_reg($modrm_byte$$95$$);
};
$table16$$[218] = $table32$$[218] = function $$table32$$$218$($cpu$$672$$) {
  var $modrm_byte$$96$$ = $cpu$$672$$.read_imm8();
  $cpu$$672$$.cr0 & 12 && $cpu$$672$$.trigger_nm();
  192 > $modrm_byte$$96$$ ? $cpu$$672$$.fpu.op_DA_mem($modrm_byte$$96$$, $cpu$$672$$.modrm_resolve($modrm_byte$$96$$)) : $cpu$$672$$.fpu.op_DA_reg($modrm_byte$$96$$);
};
$table16$$[219] = $table32$$[219] = function $$table32$$$219$($cpu$$673$$) {
  var $modrm_byte$$97$$ = $cpu$$673$$.read_imm8();
  $cpu$$673$$.cr0 & 12 && $cpu$$673$$.trigger_nm();
  192 > $modrm_byte$$97$$ ? $cpu$$673$$.fpu.op_DB_mem($modrm_byte$$97$$, $cpu$$673$$.modrm_resolve($modrm_byte$$97$$)) : $cpu$$673$$.fpu.op_DB_reg($modrm_byte$$97$$);
};
$table16$$[220] = $table32$$[220] = function $$table32$$$220$($cpu$$674$$) {
  var $modrm_byte$$98$$ = $cpu$$674$$.read_imm8();
  $cpu$$674$$.cr0 & 12 && $cpu$$674$$.trigger_nm();
  192 > $modrm_byte$$98$$ ? $cpu$$674$$.fpu.op_DC_mem($modrm_byte$$98$$, $cpu$$674$$.modrm_resolve($modrm_byte$$98$$)) : $cpu$$674$$.fpu.op_DC_reg($modrm_byte$$98$$);
};
$table16$$[221] = $table32$$[221] = function $$table32$$$221$($cpu$$675$$) {
  var $modrm_byte$$99$$ = $cpu$$675$$.read_imm8();
  $cpu$$675$$.cr0 & 12 && $cpu$$675$$.trigger_nm();
  192 > $modrm_byte$$99$$ ? $cpu$$675$$.fpu.op_DD_mem($modrm_byte$$99$$, $cpu$$675$$.modrm_resolve($modrm_byte$$99$$)) : $cpu$$675$$.fpu.op_DD_reg($modrm_byte$$99$$);
};
$table16$$[222] = $table32$$[222] = function $$table32$$$222$($cpu$$676$$) {
  var $modrm_byte$$100$$ = $cpu$$676$$.read_imm8();
  $cpu$$676$$.cr0 & 12 && $cpu$$676$$.trigger_nm();
  192 > $modrm_byte$$100$$ ? $cpu$$676$$.fpu.op_DE_mem($modrm_byte$$100$$, $cpu$$676$$.modrm_resolve($modrm_byte$$100$$)) : $cpu$$676$$.fpu.op_DE_reg($modrm_byte$$100$$);
};
$table16$$[223] = $table32$$[223] = function $$table32$$$223$($cpu$$677$$) {
  var $modrm_byte$$101$$ = $cpu$$677$$.read_imm8();
  $cpu$$677$$.cr0 & 12 && $cpu$$677$$.trigger_nm();
  192 > $modrm_byte$$101$$ ? $cpu$$677$$.fpu.op_DF_mem($modrm_byte$$101$$, $cpu$$677$$.modrm_resolve($modrm_byte$$101$$)) : $cpu$$677$$.fpu.op_DF_reg($modrm_byte$$101$$);
};
$table16$$[224] = $table32$$[224] = function $$table32$$$224$($cpu$$678$$) {
  $cpu$$678$$.loopne();
};
$table16$$[225] = $table32$$[225] = function $$table32$$$225$($cpu$$679$$) {
  $cpu$$679$$.loope();
};
$table16$$[226] = $table32$$[226] = function $$table32$$$226$($cpu$$680$$) {
  $cpu$$680$$.loop();
};
$table16$$[227] = $table32$$[227] = function $$table32$$$227$($cpu$$681$$) {
  $cpu$$681$$.jcxz();
};
$table16$$[228] = $table32$$[228] = function $$table32$$$228$($cpu$$682$$) {
  var $port$$6$$ = $cpu$$682$$.read_imm8();
  $cpu$$682$$.test_privileges_for_io($port$$6$$, 1);
  $cpu$$682$$.reg8[0] = $cpu$$682$$.io.port_read8($port$$6$$);
};
$table16$$[229] = function $$table16$$$229$($cpu$$683$$) {
  var $port$$7$$ = $cpu$$683$$.read_imm8();
  $cpu$$683$$.test_privileges_for_io($port$$7$$, 2);
  $cpu$$683$$.reg16[0] = $cpu$$683$$.io.port_read16($port$$7$$);
};
$table32$$[229] = function $$table32$$$229$($cpu$$684$$) {
  var $port$$8$$ = $cpu$$684$$.read_imm8();
  $cpu$$684$$.test_privileges_for_io($port$$8$$, 4);
  $cpu$$684$$.reg32s[0] = $cpu$$684$$.io.port_read32($port$$8$$);
};
$table16$$[230] = $table32$$[230] = function $$table32$$$230$($cpu$$685$$) {
  var $port$$9$$ = $cpu$$685$$.read_imm8();
  $cpu$$685$$.test_privileges_for_io($port$$9$$, 1);
  $cpu$$685$$.io.port_write8($port$$9$$, $cpu$$685$$.reg8[0]);
};
$table16$$[231] = function $$table16$$$231$($cpu$$686$$) {
  var $port$$10$$ = $cpu$$686$$.read_imm8();
  $cpu$$686$$.test_privileges_for_io($port$$10$$, 2);
  $cpu$$686$$.io.port_write16($port$$10$$, $cpu$$686$$.reg16[0]);
};
$table32$$[231] = function $$table32$$$231$($cpu$$687$$) {
  var $port$$11$$ = $cpu$$687$$.read_imm8();
  $cpu$$687$$.test_privileges_for_io($port$$11$$, 4);
  $cpu$$687$$.io.port_write32($port$$11$$, $cpu$$687$$.reg32s[0]);
};
$table16$$[232] = function $$table16$$$232$($cpu$$688$$) {
  var $imm16s$$ = $cpu$$688$$.read_imm16s();
  $cpu$$688$$.push16($cpu$$688$$.get_real_eip());
  $cpu$$688$$.jmp_rel16($imm16s$$);
  $cpu$$688$$.last_instr_jump = !0;
};
$table32$$[232] = function $$table32$$$232$($cpu$$689$$) {
  var $imm32s$$ = $cpu$$689$$.read_imm32s();
  $cpu$$689$$.push32($cpu$$689$$.get_real_eip());
  $cpu$$689$$.instruction_pointer = $cpu$$689$$.instruction_pointer + $imm32s$$ | 0;
  $cpu$$689$$.last_instr_jump = !0;
};
$table16$$[233] = function $$table16$$$233$($cpu$$690$$) {
  var $imm16s$$1$$ = $cpu$$690$$.read_imm16s();
  $cpu$$690$$.jmp_rel16($imm16s$$1$$);
  $cpu$$690$$.last_instr_jump = !0;
};
$table32$$[233] = function $$table32$$$233$($cpu$$691$$) {
  var $imm32s$$1$$ = $cpu$$691$$.read_imm32s();
  $cpu$$691$$.instruction_pointer = $cpu$$691$$.instruction_pointer + $imm32s$$1$$ | 0;
  $cpu$$691$$.last_instr_jump = !0;
};
$table16$$[234] = function $$table16$$$234$($cpu$$692$$) {
  var $ip$$4$$ = $cpu$$692$$.read_imm16();
  $cpu$$692$$.switch_seg(1, $cpu$$692$$.read_imm16());
  $cpu$$692$$.instruction_pointer = $ip$$4$$ + $cpu$$692$$.get_seg(1) | 0;
  $cpu$$692$$.last_instr_jump = !0;
};
$table32$$[234] = function $$table32$$$234$($cpu$$693$$) {
  var $ip$$5$$ = $cpu$$693$$.read_imm32s();
  $cpu$$693$$.switch_seg(1, $cpu$$693$$.read_imm16());
  $cpu$$693$$.instruction_pointer = $ip$$5$$ + $cpu$$693$$.get_seg(1) | 0;
  $cpu$$693$$.last_instr_jump = !0;
};
$table16$$[235] = $table32$$[235] = function $$table32$$$235$($cpu$$694$$) {
  var $imm8$$3$$ = $cpu$$694$$.read_imm8s();
  $cpu$$694$$.instruction_pointer = $cpu$$694$$.instruction_pointer + $imm8$$3$$ | 0;
  $cpu$$694$$.last_instr_jump = !0;
};
$table16$$[236] = $table32$$[236] = function $$table32$$$236$($cpu$$695$$) {
  var $port$$12$$ = $cpu$$695$$.reg16[4];
  $cpu$$695$$.test_privileges_for_io($port$$12$$, 1);
  $cpu$$695$$.reg8[0] = $cpu$$695$$.io.port_read8($port$$12$$);
};
$table16$$[237] = function $$table16$$$237$($cpu$$696$$) {
  var $port$$13$$ = $cpu$$696$$.reg16[4];
  $cpu$$696$$.test_privileges_for_io($port$$13$$, 2);
  $cpu$$696$$.reg16[0] = $cpu$$696$$.io.port_read16($port$$13$$);
};
$table32$$[237] = function $$table32$$$237$($cpu$$697$$) {
  var $port$$14$$ = $cpu$$697$$.reg16[4];
  $cpu$$697$$.test_privileges_for_io($port$$14$$, 4);
  $cpu$$697$$.reg32s[0] = $cpu$$697$$.io.port_read32($port$$14$$);
};
$table16$$[238] = $table32$$[238] = function $$table32$$$238$($cpu$$698$$) {
  var $port$$15$$ = $cpu$$698$$.reg16[4];
  $cpu$$698$$.test_privileges_for_io($port$$15$$, 1);
  $cpu$$698$$.io.port_write8($port$$15$$, $cpu$$698$$.reg8[0]);
};
$table16$$[239] = function $$table16$$$239$($cpu$$699$$) {
  var $port$$16$$ = $cpu$$699$$.reg16[4];
  $cpu$$699$$.test_privileges_for_io($port$$16$$, 2);
  $cpu$$699$$.io.port_write16($port$$16$$, $cpu$$699$$.reg16[0]);
};
$table32$$[239] = function $$table32$$$239$($cpu$$700$$) {
  var $port$$17$$ = $cpu$$700$$.reg16[4];
  $cpu$$700$$.test_privileges_for_io($port$$17$$, 4);
  $cpu$$700$$.io.port_write32($port$$17$$, $cpu$$700$$.reg32s[0]);
};
$table16$$[240] = $table32$$[240] = function $$table32$$$240$($cpu$$701$$) {
  $cpu$$701$$.table[$cpu$$701$$.read_imm8()]($cpu$$701$$);
};
$table16$$[241] = $table32$$[241] = function $$table32$$$241$($cpu$$702$$) {
  throw $cpu$$702$$.debug.unimpl("int1 instruction");
};
$table16$$[242] = $table32$$[242] = function $$table32$$$242$($cpu$$703$$) {
  $cpu$$703$$.repeat_string_prefix = 1;
  $cpu$$703$$.table[$cpu$$703$$.read_imm8()]($cpu$$703$$);
  $cpu$$703$$.repeat_string_prefix = 0;
};
$table16$$[243] = $table32$$[243] = function $$table32$$$243$($cpu$$704$$) {
  $cpu$$704$$.repeat_string_prefix = 2;
  $cpu$$704$$.table[$cpu$$704$$.read_imm8()]($cpu$$704$$);
  $cpu$$704$$.repeat_string_prefix = 0;
};
$table16$$[244] = $table32$$[244] = function $$table32$$$244$($cpu$$705$$) {
  $cpu$$705$$.hlt_op();
};
$table16$$[245] = $table32$$[245] = function $$table32$$$245$($cpu$$706$$) {
  $cpu$$706$$.flags = ($cpu$$706$$.flags | 1) ^ $cpu$$706$$.getcf();
  $cpu$$706$$.flags_changed &= -2;
};
$table16$$[246] = $table32$$[246] = function $$table32$$$246$($cpu$$707$$) {
  var $modrm_byte$$102$$ = $cpu$$707$$.read_imm8();
  switch($modrm_byte$$102$$ >> 3 & 7) {
    case 0:
      var $data$$113_result$$62$$ = 192 > $modrm_byte$$102$$ ? $cpu$$707$$.safe_read8($cpu$$707$$.modrm_resolve($modrm_byte$$102$$)) : $cpu$$707$$.reg8[$modrm_byte$$102$$ << 2 & 12 | $modrm_byte$$102$$ >> 2 & 1];
      $cpu$$707$$.and($data$$113_result$$62$$, $cpu$$707$$.read_imm8(), 7);
      break;
    case 1:
      $data$$113_result$$62$$ = 192 > $modrm_byte$$102$$ ? $cpu$$707$$.safe_read8($cpu$$707$$.modrm_resolve($modrm_byte$$102$$)) : $cpu$$707$$.reg8[$modrm_byte$$102$$ << 2 & 12 | $modrm_byte$$102$$ >> 2 & 1];
      $cpu$$707$$.and($data$$113_result$$62$$, $cpu$$707$$.read_imm8(), 7);
      break;
    case 2:
      var $addr$$31$$;
      192 > $modrm_byte$$102$$ ? ($addr$$31$$ = $cpu$$707$$.translate_address_write($cpu$$707$$.modrm_resolve($modrm_byte$$102$$)), $data$$113_result$$62$$ = $cpu$$707$$.memory.read8($addr$$31$$)) : $data$$113_result$$62$$ = $cpu$$707$$.reg8[$modrm_byte$$102$$ << 2 & 12 | $modrm_byte$$102$$ >> 2 & 1];
      $data$$113_result$$62$$ = ~$data$$113_result$$62$$;
      192 > $modrm_byte$$102$$ ? $cpu$$707$$.memory.write8($addr$$31$$, $data$$113_result$$62$$) : $cpu$$707$$.reg8[$modrm_byte$$102$$ << 2 & 12 | $modrm_byte$$102$$ >> 2 & 1] = $data$$113_result$$62$$;
      break;
    case 3:
      192 > $modrm_byte$$102$$ ? ($addr$$31$$ = $cpu$$707$$.translate_address_write($cpu$$707$$.modrm_resolve($modrm_byte$$102$$)), $data$$113_result$$62$$ = $cpu$$707$$.memory.read8($addr$$31$$)) : $data$$113_result$$62$$ = $cpu$$707$$.reg8[$modrm_byte$$102$$ << 2 & 12 | $modrm_byte$$102$$ >> 2 & 1];
      $data$$113_result$$62$$ = $cpu$$707$$.neg($data$$113_result$$62$$, 7);
      192 > $modrm_byte$$102$$ ? $cpu$$707$$.memory.write8($addr$$31$$, $data$$113_result$$62$$) : $cpu$$707$$.reg8[$modrm_byte$$102$$ << 2 & 12 | $modrm_byte$$102$$ >> 2 & 1] = $data$$113_result$$62$$;
      break;
    case 4:
      $data$$113_result$$62$$ = 192 > $modrm_byte$$102$$ ? $cpu$$707$$.safe_read8($cpu$$707$$.modrm_resolve($modrm_byte$$102$$)) : $cpu$$707$$.reg8[$modrm_byte$$102$$ << 2 & 12 | $modrm_byte$$102$$ >> 2 & 1];
      $cpu$$707$$.mul8($data$$113_result$$62$$);
      break;
    case 5:
      192 > $modrm_byte$$102$$ ? $data$$113_result$$62$$ = $cpu$$707$$.safe_read8($cpu$$707$$.modrm_resolve($modrm_byte$$102$$)) << 24 >> 24 : $data$$113_result$$62$$ = $cpu$$707$$.reg8s[$modrm_byte$$102$$ << 2 & 12 | $modrm_byte$$102$$ >> 2 & 1];
      $cpu$$707$$.imul8($data$$113_result$$62$$);
      break;
    case 6:
      $data$$113_result$$62$$ = 192 > $modrm_byte$$102$$ ? $cpu$$707$$.safe_read8($cpu$$707$$.modrm_resolve($modrm_byte$$102$$)) : $cpu$$707$$.reg8[$modrm_byte$$102$$ << 2 & 12 | $modrm_byte$$102$$ >> 2 & 1];
      $cpu$$707$$.div8($data$$113_result$$62$$);
      break;
    case 7:
      192 > $modrm_byte$$102$$ ? $data$$113_result$$62$$ = $cpu$$707$$.safe_read8($cpu$$707$$.modrm_resolve($modrm_byte$$102$$)) << 24 >> 24 : $data$$113_result$$62$$ = $cpu$$707$$.reg8s[$modrm_byte$$102$$ << 2 & 12 | $modrm_byte$$102$$ >> 2 & 1], $cpu$$707$$.idiv8($data$$113_result$$62$$);
  }
};
$table16$$[247] = function $$table16$$$247$($cpu$$708$$) {
  var $modrm_byte$$103$$ = $cpu$$708$$.read_imm8();
  switch($modrm_byte$$103$$ >> 3 & 7) {
    case 0:
      var $data$$114_result$$63_virt_addr$$31$$ = 192 > $modrm_byte$$103$$ ? $cpu$$708$$.safe_read16($cpu$$708$$.modrm_resolve($modrm_byte$$103$$)) : $cpu$$708$$.reg16[$modrm_byte$$103$$ << 1 & 14];
      $cpu$$708$$.and($data$$114_result$$63_virt_addr$$31$$, $cpu$$708$$.read_imm16(), 15);
      break;
    case 1:
      $data$$114_result$$63_virt_addr$$31$$ = 192 > $modrm_byte$$103$$ ? $cpu$$708$$.safe_read16($cpu$$708$$.modrm_resolve($modrm_byte$$103$$)) : $cpu$$708$$.reg16[$modrm_byte$$103$$ << 1 & 14];
      $cpu$$708$$.and($data$$114_result$$63_virt_addr$$31$$, $cpu$$708$$.read_imm16(), 15);
      break;
    case 2:
      var $phys_addr$$30$$, $phys_addr_high$$27$$ = 0;
      192 > $modrm_byte$$103$$ ? ($data$$114_result$$63_virt_addr$$31$$ = $cpu$$708$$.modrm_resolve($modrm_byte$$103$$), $phys_addr$$30$$ = $cpu$$708$$.translate_address_write($data$$114_result$$63_virt_addr$$31$$), $cpu$$708$$.paging && 4095 === ($data$$114_result$$63_virt_addr$$31$$ & 4095) ? ($phys_addr_high$$27$$ = $cpu$$708$$.translate_address_write($data$$114_result$$63_virt_addr$$31$$ + 1), $data$$114_result$$63_virt_addr$$31$$ = $cpu$$708$$.virt_boundary_read16($phys_addr$$30$$, $phys_addr_high$$27$$)) : 
      $data$$114_result$$63_virt_addr$$31$$ = $cpu$$708$$.memory.read16($phys_addr$$30$$)) : $data$$114_result$$63_virt_addr$$31$$ = $cpu$$708$$.reg16[$modrm_byte$$103$$ << 1 & 14];
      $data$$114_result$$63_virt_addr$$31$$ = ~$data$$114_result$$63_virt_addr$$31$$;
      192 > $modrm_byte$$103$$ ? $phys_addr_high$$27$$ ? $cpu$$708$$.virt_boundary_write16($phys_addr$$30$$, $phys_addr_high$$27$$, $data$$114_result$$63_virt_addr$$31$$) : $cpu$$708$$.memory.write16($phys_addr$$30$$, $data$$114_result$$63_virt_addr$$31$$) : $cpu$$708$$.reg16[$modrm_byte$$103$$ << 1 & 14] = $data$$114_result$$63_virt_addr$$31$$;
      break;
    case 3:
      $phys_addr_high$$27$$ = 0;
      192 > $modrm_byte$$103$$ ? ($data$$114_result$$63_virt_addr$$31$$ = $cpu$$708$$.modrm_resolve($modrm_byte$$103$$), $phys_addr$$30$$ = $cpu$$708$$.translate_address_write($data$$114_result$$63_virt_addr$$31$$), $cpu$$708$$.paging && 4095 === ($data$$114_result$$63_virt_addr$$31$$ & 4095) ? ($phys_addr_high$$27$$ = $cpu$$708$$.translate_address_write($data$$114_result$$63_virt_addr$$31$$ + 1), $data$$114_result$$63_virt_addr$$31$$ = $cpu$$708$$.virt_boundary_read16($phys_addr$$30$$, $phys_addr_high$$27$$)) : 
      $data$$114_result$$63_virt_addr$$31$$ = $cpu$$708$$.memory.read16($phys_addr$$30$$)) : $data$$114_result$$63_virt_addr$$31$$ = $cpu$$708$$.reg16[$modrm_byte$$103$$ << 1 & 14];
      $data$$114_result$$63_virt_addr$$31$$ = $cpu$$708$$.neg($data$$114_result$$63_virt_addr$$31$$, 15);
      192 > $modrm_byte$$103$$ ? $phys_addr_high$$27$$ ? $cpu$$708$$.virt_boundary_write16($phys_addr$$30$$, $phys_addr_high$$27$$, $data$$114_result$$63_virt_addr$$31$$) : $cpu$$708$$.memory.write16($phys_addr$$30$$, $data$$114_result$$63_virt_addr$$31$$) : $cpu$$708$$.reg16[$modrm_byte$$103$$ << 1 & 14] = $data$$114_result$$63_virt_addr$$31$$;
      break;
    case 4:
      $data$$114_result$$63_virt_addr$$31$$ = 192 > $modrm_byte$$103$$ ? $cpu$$708$$.safe_read16($cpu$$708$$.modrm_resolve($modrm_byte$$103$$)) : $cpu$$708$$.reg16[$modrm_byte$$103$$ << 1 & 14];
      $cpu$$708$$.mul16($data$$114_result$$63_virt_addr$$31$$);
      break;
    case 5:
      192 > $modrm_byte$$103$$ ? $data$$114_result$$63_virt_addr$$31$$ = $cpu$$708$$.safe_read16($cpu$$708$$.modrm_resolve($modrm_byte$$103$$)) << 16 >> 16 : $data$$114_result$$63_virt_addr$$31$$ = $cpu$$708$$.reg16s[$modrm_byte$$103$$ << 1 & 14];
      $cpu$$708$$.imul16($data$$114_result$$63_virt_addr$$31$$);
      break;
    case 6:
      $data$$114_result$$63_virt_addr$$31$$ = 192 > $modrm_byte$$103$$ ? $cpu$$708$$.safe_read16($cpu$$708$$.modrm_resolve($modrm_byte$$103$$)) : $cpu$$708$$.reg16[$modrm_byte$$103$$ << 1 & 14];
      $cpu$$708$$.div16($data$$114_result$$63_virt_addr$$31$$);
      break;
    case 7:
      192 > $modrm_byte$$103$$ ? $data$$114_result$$63_virt_addr$$31$$ = $cpu$$708$$.safe_read16($cpu$$708$$.modrm_resolve($modrm_byte$$103$$)) << 16 >> 16 : $data$$114_result$$63_virt_addr$$31$$ = $cpu$$708$$.reg16s[$modrm_byte$$103$$ << 1 & 14], $cpu$$708$$.idiv16($data$$114_result$$63_virt_addr$$31$$);
  }
};
$table32$$[247] = function $$table32$$$247$($cpu$$709$$) {
  var $modrm_byte$$104$$ = $cpu$$709$$.read_imm8();
  switch($modrm_byte$$104$$ >> 3 & 7) {
    case 0:
      var $data$$115_result$$64_virt_addr$$32$$ = 192 > $modrm_byte$$104$$ ? $cpu$$709$$.safe_read32s($cpu$$709$$.modrm_resolve($modrm_byte$$104$$)) : $cpu$$709$$.reg32s[$modrm_byte$$104$$ & 7];
      $cpu$$709$$.and($data$$115_result$$64_virt_addr$$32$$, $cpu$$709$$.read_imm32s(), 31);
      break;
    case 1:
      $data$$115_result$$64_virt_addr$$32$$ = 192 > $modrm_byte$$104$$ ? $cpu$$709$$.safe_read32s($cpu$$709$$.modrm_resolve($modrm_byte$$104$$)) : $cpu$$709$$.reg32s[$modrm_byte$$104$$ & 7];
      $cpu$$709$$.and($data$$115_result$$64_virt_addr$$32$$, $cpu$$709$$.read_imm32s(), 31);
      break;
    case 2:
      var $phys_addr$$31$$, $phys_addr_high$$28$$ = 0;
      192 > $modrm_byte$$104$$ ? ($data$$115_result$$64_virt_addr$$32$$ = $cpu$$709$$.modrm_resolve($modrm_byte$$104$$), $phys_addr$$31$$ = $cpu$$709$$.translate_address_write($data$$115_result$$64_virt_addr$$32$$), $cpu$$709$$.paging && 4093 <= ($data$$115_result$$64_virt_addr$$32$$ & 4095) ? ($phys_addr_high$$28$$ = $cpu$$709$$.translate_address_write($data$$115_result$$64_virt_addr$$32$$ + 3), $data$$115_result$$64_virt_addr$$32$$ = $cpu$$709$$.virt_boundary_read32s($phys_addr$$31$$, $phys_addr_high$$28$$)) : 
      $data$$115_result$$64_virt_addr$$32$$ = $cpu$$709$$.memory.read32s($phys_addr$$31$$)) : $data$$115_result$$64_virt_addr$$32$$ = $cpu$$709$$.reg32s[$modrm_byte$$104$$ & 7];
      $data$$115_result$$64_virt_addr$$32$$ = ~$data$$115_result$$64_virt_addr$$32$$;
      192 > $modrm_byte$$104$$ ? $phys_addr_high$$28$$ ? $cpu$$709$$.virt_boundary_write32($phys_addr$$31$$, $phys_addr_high$$28$$, $data$$115_result$$64_virt_addr$$32$$) : $cpu$$709$$.memory.write32($phys_addr$$31$$, $data$$115_result$$64_virt_addr$$32$$) : $cpu$$709$$.reg32s[$modrm_byte$$104$$ & 7] = $data$$115_result$$64_virt_addr$$32$$;
      break;
    case 3:
      $phys_addr_high$$28$$ = 0;
      192 > $modrm_byte$$104$$ ? ($data$$115_result$$64_virt_addr$$32$$ = $cpu$$709$$.modrm_resolve($modrm_byte$$104$$), $phys_addr$$31$$ = $cpu$$709$$.translate_address_write($data$$115_result$$64_virt_addr$$32$$), $cpu$$709$$.paging && 4093 <= ($data$$115_result$$64_virt_addr$$32$$ & 4095) ? ($phys_addr_high$$28$$ = $cpu$$709$$.translate_address_write($data$$115_result$$64_virt_addr$$32$$ + 3), $data$$115_result$$64_virt_addr$$32$$ = $cpu$$709$$.virt_boundary_read32s($phys_addr$$31$$, $phys_addr_high$$28$$)) : 
      $data$$115_result$$64_virt_addr$$32$$ = $cpu$$709$$.memory.read32s($phys_addr$$31$$)) : $data$$115_result$$64_virt_addr$$32$$ = $cpu$$709$$.reg32s[$modrm_byte$$104$$ & 7];
      $data$$115_result$$64_virt_addr$$32$$ = $cpu$$709$$.neg($data$$115_result$$64_virt_addr$$32$$, 31);
      192 > $modrm_byte$$104$$ ? $phys_addr_high$$28$$ ? $cpu$$709$$.virt_boundary_write32($phys_addr$$31$$, $phys_addr_high$$28$$, $data$$115_result$$64_virt_addr$$32$$) : $cpu$$709$$.memory.write32($phys_addr$$31$$, $data$$115_result$$64_virt_addr$$32$$) : $cpu$$709$$.reg32s[$modrm_byte$$104$$ & 7] = $data$$115_result$$64_virt_addr$$32$$;
      break;
    case 4:
      192 > $modrm_byte$$104$$ ? $data$$115_result$$64_virt_addr$$32$$ = $cpu$$709$$.safe_read32s($cpu$$709$$.modrm_resolve($modrm_byte$$104$$)) >>> 0 : $data$$115_result$$64_virt_addr$$32$$ = $cpu$$709$$.reg32[$modrm_byte$$104$$ & 7];
      $cpu$$709$$.mul32($data$$115_result$$64_virt_addr$$32$$);
      break;
    case 5:
      $data$$115_result$$64_virt_addr$$32$$ = 192 > $modrm_byte$$104$$ ? $cpu$$709$$.safe_read32s($cpu$$709$$.modrm_resolve($modrm_byte$$104$$)) : $cpu$$709$$.reg32s[$modrm_byte$$104$$ & 7];
      $cpu$$709$$.imul32($data$$115_result$$64_virt_addr$$32$$);
      break;
    case 6:
      192 > $modrm_byte$$104$$ ? $data$$115_result$$64_virt_addr$$32$$ = $cpu$$709$$.safe_read32s($cpu$$709$$.modrm_resolve($modrm_byte$$104$$)) >>> 0 : $data$$115_result$$64_virt_addr$$32$$ = $cpu$$709$$.reg32[$modrm_byte$$104$$ & 7];
      $cpu$$709$$.div32($data$$115_result$$64_virt_addr$$32$$);
      break;
    case 7:
      $data$$115_result$$64_virt_addr$$32$$ = 192 > $modrm_byte$$104$$ ? $cpu$$709$$.safe_read32s($cpu$$709$$.modrm_resolve($modrm_byte$$104$$)) : $cpu$$709$$.reg32s[$modrm_byte$$104$$ & 7], $cpu$$709$$.idiv32($data$$115_result$$64_virt_addr$$32$$);
  }
};
$table16$$[248] = $table32$$[248] = function $$table32$$$248$($cpu$$710$$) {
  $cpu$$710$$.flags &= -2;
  $cpu$$710$$.flags_changed &= -2;
};
$table16$$[249] = $table32$$[249] = function $$table32$$$249$($cpu$$711$$) {
  $cpu$$711$$.flags |= 1;
  $cpu$$711$$.flags_changed &= -2;
};
$table16$$[250] = $table32$$[250] = function $$table32$$$250$($cpu$$712$$) {
  !$cpu$$712$$.protected_mode || ($cpu$$712$$.flags & 131072 ? 3 === ($cpu$$712$$.flags >> 12 & 3) : ($cpu$$712$$.flags >> 12 & 3) >= $cpu$$712$$.cpl) ? $cpu$$712$$.flags &= -513 : 3 > ($cpu$$712$$.flags >> 12 & 3) && ($cpu$$712$$.flags & 131072 ? $cpu$$712$$.cr4 & 1 : 3 === $cpu$$712$$.cpl && $cpu$$712$$.cr4 & 2) ? $cpu$$712$$.flags &= -524289 : $cpu$$712$$.trigger_gp(0);
};
$table16$$[251] = $table32$$[251] = function $$table32$$$251$($cpu$$713$$) {
  !$cpu$$713$$.protected_mode || ($cpu$$713$$.flags & 131072 ? 3 === ($cpu$$713$$.flags >> 12 & 3) : ($cpu$$713$$.flags >> 12 & 3) >= $cpu$$713$$.cpl) ? ($cpu$$713$$.flags |= 512, $cpu$$713$$.table[$cpu$$713$$.read_imm8()]($cpu$$713$$), $cpu$$713$$.handle_irqs()) : 3 > ($cpu$$713$$.flags >> 12 & 3) && 0 === ($cpu$$713$$.flags & 1048576) && ($cpu$$713$$.flags & 131072 ? $cpu$$713$$.cr4 & 1 : 3 === $cpu$$713$$.cpl && $cpu$$713$$.cr4 & 2) ? $cpu$$713$$.flags |= 524288 : $cpu$$713$$.trigger_gp(0);
};
$table16$$[252] = $table32$$[252] = function $$table32$$$252$($cpu$$714$$) {
  $cpu$$714$$.flags &= -1025;
};
$table16$$[253] = $table32$$[253] = function $$table32$$$253$($cpu$$715$$) {
  $cpu$$715$$.flags |= 1024;
};
$table16$$[254] = $table32$$[254] = function $$table32$$$254$($cpu$$716$$) {
  var $modrm_byte$$105$$ = $cpu$$716$$.read_imm8(), $data$$116_mod$$261_result$$65$$ = $modrm_byte$$105$$ & 56;
  if (0 === $data$$116_mod$$261_result$$65$$) {
    var $addr$$32$$;
    192 > $modrm_byte$$105$$ ? ($addr$$32$$ = $cpu$$716$$.translate_address_write($cpu$$716$$.modrm_resolve($modrm_byte$$105$$)), $data$$116_mod$$261_result$$65$$ = $cpu$$716$$.memory.read8($addr$$32$$)) : $data$$116_mod$$261_result$$65$$ = $cpu$$716$$.reg8[$modrm_byte$$105$$ << 2 & 12 | $modrm_byte$$105$$ >> 2 & 1];
    $data$$116_mod$$261_result$$65$$ = $cpu$$716$$.inc($data$$116_mod$$261_result$$65$$, 7);
    192 > $modrm_byte$$105$$ ? $cpu$$716$$.memory.write8($addr$$32$$, $data$$116_mod$$261_result$$65$$) : $cpu$$716$$.reg8[$modrm_byte$$105$$ << 2 & 12 | $modrm_byte$$105$$ >> 2 & 1] = $data$$116_mod$$261_result$$65$$;
  } else {
    8 === $data$$116_mod$$261_result$$65$$ ? (192 > $modrm_byte$$105$$ ? ($addr$$32$$ = $cpu$$716$$.translate_address_write($cpu$$716$$.modrm_resolve($modrm_byte$$105$$)), $data$$116_mod$$261_result$$65$$ = $cpu$$716$$.memory.read8($addr$$32$$)) : $data$$116_mod$$261_result$$65$$ = $cpu$$716$$.reg8[$modrm_byte$$105$$ << 2 & 12 | $modrm_byte$$105$$ >> 2 & 1], $data$$116_mod$$261_result$$65$$ = $cpu$$716$$.dec($data$$116_mod$$261_result$$65$$, 7), 192 > $modrm_byte$$105$$ ? $cpu$$716$$.memory.write8($addr$$32$$, 
    $data$$116_mod$$261_result$$65$$) : $cpu$$716$$.reg8[$modrm_byte$$105$$ << 2 & 12 | $modrm_byte$$105$$ >> 2 & 1] = $data$$116_mod$$261_result$$65$$) : $cpu$$716$$.trigger_ud();
  }
};
$table16$$[255] = function $$table16$$$255$($cpu$$717$$) {
  var $modrm_byte$$106_new_cs$$2$$ = $cpu$$717$$.read_imm8();
  switch($modrm_byte$$106_new_cs$$2$$ >> 3 & 7) {
    case 0:
      var $data$$117_result$$66_virt_addr$$33$$, $new_ip$$2_phys_addr$$32$$, $phys_addr_high$$29$$ = 0;
      192 > $modrm_byte$$106_new_cs$$2$$ ? ($data$$117_result$$66_virt_addr$$33$$ = $cpu$$717$$.modrm_resolve($modrm_byte$$106_new_cs$$2$$), $new_ip$$2_phys_addr$$32$$ = $cpu$$717$$.translate_address_write($data$$117_result$$66_virt_addr$$33$$), $cpu$$717$$.paging && 4095 === ($data$$117_result$$66_virt_addr$$33$$ & 4095) ? ($phys_addr_high$$29$$ = $cpu$$717$$.translate_address_write($data$$117_result$$66_virt_addr$$33$$ + 1), $data$$117_result$$66_virt_addr$$33$$ = $cpu$$717$$.virt_boundary_read16($new_ip$$2_phys_addr$$32$$, 
      $phys_addr_high$$29$$)) : $data$$117_result$$66_virt_addr$$33$$ = $cpu$$717$$.memory.read16($new_ip$$2_phys_addr$$32$$)) : $data$$117_result$$66_virt_addr$$33$$ = $cpu$$717$$.reg16[$modrm_byte$$106_new_cs$$2$$ << 1 & 14];
      $data$$117_result$$66_virt_addr$$33$$ = $cpu$$717$$.inc($data$$117_result$$66_virt_addr$$33$$, 15);
      192 > $modrm_byte$$106_new_cs$$2$$ ? $phys_addr_high$$29$$ ? $cpu$$717$$.virt_boundary_write16($new_ip$$2_phys_addr$$32$$, $phys_addr_high$$29$$, $data$$117_result$$66_virt_addr$$33$$) : $cpu$$717$$.memory.write16($new_ip$$2_phys_addr$$32$$, $data$$117_result$$66_virt_addr$$33$$) : $cpu$$717$$.reg16[$modrm_byte$$106_new_cs$$2$$ << 1 & 14] = $data$$117_result$$66_virt_addr$$33$$;
      break;
    case 1:
      $phys_addr_high$$29$$ = 0;
      192 > $modrm_byte$$106_new_cs$$2$$ ? ($data$$117_result$$66_virt_addr$$33$$ = $cpu$$717$$.modrm_resolve($modrm_byte$$106_new_cs$$2$$), $new_ip$$2_phys_addr$$32$$ = $cpu$$717$$.translate_address_write($data$$117_result$$66_virt_addr$$33$$), $cpu$$717$$.paging && 4095 === ($data$$117_result$$66_virt_addr$$33$$ & 4095) ? ($phys_addr_high$$29$$ = $cpu$$717$$.translate_address_write($data$$117_result$$66_virt_addr$$33$$ + 1), $data$$117_result$$66_virt_addr$$33$$ = $cpu$$717$$.virt_boundary_read16($new_ip$$2_phys_addr$$32$$, 
      $phys_addr_high$$29$$)) : $data$$117_result$$66_virt_addr$$33$$ = $cpu$$717$$.memory.read16($new_ip$$2_phys_addr$$32$$)) : $data$$117_result$$66_virt_addr$$33$$ = $cpu$$717$$.reg16[$modrm_byte$$106_new_cs$$2$$ << 1 & 14];
      $data$$117_result$$66_virt_addr$$33$$ = $cpu$$717$$.dec($data$$117_result$$66_virt_addr$$33$$, 15);
      192 > $modrm_byte$$106_new_cs$$2$$ ? $phys_addr_high$$29$$ ? $cpu$$717$$.virt_boundary_write16($new_ip$$2_phys_addr$$32$$, $phys_addr_high$$29$$, $data$$117_result$$66_virt_addr$$33$$) : $cpu$$717$$.memory.write16($new_ip$$2_phys_addr$$32$$, $data$$117_result$$66_virt_addr$$33$$) : $cpu$$717$$.reg16[$modrm_byte$$106_new_cs$$2$$ << 1 & 14] = $data$$117_result$$66_virt_addr$$33$$;
      break;
    case 2:
      $data$$117_result$$66_virt_addr$$33$$ = 192 > $modrm_byte$$106_new_cs$$2$$ ? $cpu$$717$$.safe_read16($cpu$$717$$.modrm_resolve($modrm_byte$$106_new_cs$$2$$)) : $cpu$$717$$.reg16[$modrm_byte$$106_new_cs$$2$$ << 1 & 14];
      $cpu$$717$$.push16($cpu$$717$$.get_real_eip());
      $cpu$$717$$.instruction_pointer = $cpu$$717$$.get_seg(1) + $data$$117_result$$66_virt_addr$$33$$ | 0;
      $cpu$$717$$.last_instr_jump = !0;
      break;
    case 3:
      192 <= $modrm_byte$$106_new_cs$$2$$ && $cpu$$717$$.trigger_ud();
      $data$$117_result$$66_virt_addr$$33$$ = $cpu$$717$$.modrm_resolve($modrm_byte$$106_new_cs$$2$$);
      $modrm_byte$$106_new_cs$$2$$ = $cpu$$717$$.safe_read16($data$$117_result$$66_virt_addr$$33$$ + 2);
      $new_ip$$2_phys_addr$$32$$ = $cpu$$717$$.safe_read16($data$$117_result$$66_virt_addr$$33$$);
      $cpu$$717$$.writable_or_pagefault($cpu$$717$$.get_stack_pointer(-4), 4);
      $cpu$$717$$.push16($cpu$$717$$.sreg[1]);
      $cpu$$717$$.push16($cpu$$717$$.get_real_eip());
      $cpu$$717$$.switch_seg(1, $modrm_byte$$106_new_cs$$2$$);
      $cpu$$717$$.instruction_pointer = $cpu$$717$$.get_seg(1) + $new_ip$$2_phys_addr$$32$$ | 0;
      $cpu$$717$$.last_instr_jump = !0;
      break;
    case 4:
      $data$$117_result$$66_virt_addr$$33$$ = 192 > $modrm_byte$$106_new_cs$$2$$ ? $cpu$$717$$.safe_read16($cpu$$717$$.modrm_resolve($modrm_byte$$106_new_cs$$2$$)) : $cpu$$717$$.reg16[$modrm_byte$$106_new_cs$$2$$ << 1 & 14];
      $cpu$$717$$.instruction_pointer = $cpu$$717$$.get_seg(1) + $data$$117_result$$66_virt_addr$$33$$ | 0;
      $cpu$$717$$.last_instr_jump = !0;
      break;
    case 5:
      192 <= $modrm_byte$$106_new_cs$$2$$ && $cpu$$717$$.trigger_ud();
      $data$$117_result$$66_virt_addr$$33$$ = $cpu$$717$$.modrm_resolve($modrm_byte$$106_new_cs$$2$$);
      $modrm_byte$$106_new_cs$$2$$ = $cpu$$717$$.safe_read16($data$$117_result$$66_virt_addr$$33$$ + 2);
      $new_ip$$2_phys_addr$$32$$ = $cpu$$717$$.safe_read16($data$$117_result$$66_virt_addr$$33$$);
      $cpu$$717$$.switch_seg(1, $modrm_byte$$106_new_cs$$2$$);
      $cpu$$717$$.instruction_pointer = $cpu$$717$$.get_seg(1) + $new_ip$$2_phys_addr$$32$$ | 0;
      $cpu$$717$$.last_instr_jump = !0;
      break;
    case 6:
      $data$$117_result$$66_virt_addr$$33$$ = 192 > $modrm_byte$$106_new_cs$$2$$ ? $cpu$$717$$.safe_read16($cpu$$717$$.modrm_resolve($modrm_byte$$106_new_cs$$2$$)) : $cpu$$717$$.reg16[$modrm_byte$$106_new_cs$$2$$ << 1 & 14];
      $cpu$$717$$.push16($data$$117_result$$66_virt_addr$$33$$);
      break;
    case 7:
      $cpu$$717$$.trigger_ud();
  }
};
$table32$$[255] = function $$table32$$$255$($cpu$$718$$) {
  var $modrm_byte$$107_new_cs$$3$$ = $cpu$$718$$.read_imm8();
  switch($modrm_byte$$107_new_cs$$3$$ >> 3 & 7) {
    case 0:
      var $data$$118_result$$67_virt_addr$$34$$, $new_ip$$3_phys_addr$$33$$, $phys_addr_high$$30$$ = 0;
      192 > $modrm_byte$$107_new_cs$$3$$ ? ($data$$118_result$$67_virt_addr$$34$$ = $cpu$$718$$.modrm_resolve($modrm_byte$$107_new_cs$$3$$), $new_ip$$3_phys_addr$$33$$ = $cpu$$718$$.translate_address_write($data$$118_result$$67_virt_addr$$34$$), $cpu$$718$$.paging && 4093 <= ($data$$118_result$$67_virt_addr$$34$$ & 4095) ? ($phys_addr_high$$30$$ = $cpu$$718$$.translate_address_write($data$$118_result$$67_virt_addr$$34$$ + 3), $data$$118_result$$67_virt_addr$$34$$ = $cpu$$718$$.virt_boundary_read32s($new_ip$$3_phys_addr$$33$$, 
      $phys_addr_high$$30$$)) : $data$$118_result$$67_virt_addr$$34$$ = $cpu$$718$$.memory.read32s($new_ip$$3_phys_addr$$33$$)) : $data$$118_result$$67_virt_addr$$34$$ = $cpu$$718$$.reg32s[$modrm_byte$$107_new_cs$$3$$ & 7];
      $data$$118_result$$67_virt_addr$$34$$ = $cpu$$718$$.inc($data$$118_result$$67_virt_addr$$34$$, 31);
      192 > $modrm_byte$$107_new_cs$$3$$ ? $phys_addr_high$$30$$ ? $cpu$$718$$.virt_boundary_write32($new_ip$$3_phys_addr$$33$$, $phys_addr_high$$30$$, $data$$118_result$$67_virt_addr$$34$$) : $cpu$$718$$.memory.write32($new_ip$$3_phys_addr$$33$$, $data$$118_result$$67_virt_addr$$34$$) : $cpu$$718$$.reg32s[$modrm_byte$$107_new_cs$$3$$ & 7] = $data$$118_result$$67_virt_addr$$34$$;
      break;
    case 1:
      $phys_addr_high$$30$$ = 0;
      192 > $modrm_byte$$107_new_cs$$3$$ ? ($data$$118_result$$67_virt_addr$$34$$ = $cpu$$718$$.modrm_resolve($modrm_byte$$107_new_cs$$3$$), $new_ip$$3_phys_addr$$33$$ = $cpu$$718$$.translate_address_write($data$$118_result$$67_virt_addr$$34$$), $cpu$$718$$.paging && 4093 <= ($data$$118_result$$67_virt_addr$$34$$ & 4095) ? ($phys_addr_high$$30$$ = $cpu$$718$$.translate_address_write($data$$118_result$$67_virt_addr$$34$$ + 3), $data$$118_result$$67_virt_addr$$34$$ = $cpu$$718$$.virt_boundary_read32s($new_ip$$3_phys_addr$$33$$, 
      $phys_addr_high$$30$$)) : $data$$118_result$$67_virt_addr$$34$$ = $cpu$$718$$.memory.read32s($new_ip$$3_phys_addr$$33$$)) : $data$$118_result$$67_virt_addr$$34$$ = $cpu$$718$$.reg32s[$modrm_byte$$107_new_cs$$3$$ & 7];
      $data$$118_result$$67_virt_addr$$34$$ = $cpu$$718$$.dec($data$$118_result$$67_virt_addr$$34$$, 31);
      192 > $modrm_byte$$107_new_cs$$3$$ ? $phys_addr_high$$30$$ ? $cpu$$718$$.virt_boundary_write32($new_ip$$3_phys_addr$$33$$, $phys_addr_high$$30$$, $data$$118_result$$67_virt_addr$$34$$) : $cpu$$718$$.memory.write32($new_ip$$3_phys_addr$$33$$, $data$$118_result$$67_virt_addr$$34$$) : $cpu$$718$$.reg32s[$modrm_byte$$107_new_cs$$3$$ & 7] = $data$$118_result$$67_virt_addr$$34$$;
      break;
    case 2:
      $data$$118_result$$67_virt_addr$$34$$ = 192 > $modrm_byte$$107_new_cs$$3$$ ? $cpu$$718$$.safe_read32s($cpu$$718$$.modrm_resolve($modrm_byte$$107_new_cs$$3$$)) : $cpu$$718$$.reg32s[$modrm_byte$$107_new_cs$$3$$ & 7];
      $cpu$$718$$.push32($cpu$$718$$.get_real_eip());
      $cpu$$718$$.instruction_pointer = $cpu$$718$$.get_seg(1) + $data$$118_result$$67_virt_addr$$34$$ | 0;
      $cpu$$718$$.last_instr_jump = !0;
      break;
    case 3:
      192 <= $modrm_byte$$107_new_cs$$3$$ && $cpu$$718$$.trigger_ud();
      $data$$118_result$$67_virt_addr$$34$$ = $cpu$$718$$.modrm_resolve($modrm_byte$$107_new_cs$$3$$);
      $modrm_byte$$107_new_cs$$3$$ = $cpu$$718$$.safe_read16($data$$118_result$$67_virt_addr$$34$$ + 4);
      $new_ip$$3_phys_addr$$33$$ = $cpu$$718$$.safe_read32s($data$$118_result$$67_virt_addr$$34$$);
      $cpu$$718$$.writable_or_pagefault($cpu$$718$$.get_stack_pointer(-8), 8);
      $cpu$$718$$.push32($cpu$$718$$.sreg[1]);
      $cpu$$718$$.push32($cpu$$718$$.get_real_eip());
      $cpu$$718$$.switch_seg(1, $modrm_byte$$107_new_cs$$3$$);
      $cpu$$718$$.instruction_pointer = $cpu$$718$$.get_seg(1) + $new_ip$$3_phys_addr$$33$$ | 0;
      $cpu$$718$$.last_instr_jump = !0;
      break;
    case 4:
      $data$$118_result$$67_virt_addr$$34$$ = 192 > $modrm_byte$$107_new_cs$$3$$ ? $cpu$$718$$.safe_read32s($cpu$$718$$.modrm_resolve($modrm_byte$$107_new_cs$$3$$)) : $cpu$$718$$.reg32s[$modrm_byte$$107_new_cs$$3$$ & 7];
      $cpu$$718$$.instruction_pointer = $cpu$$718$$.get_seg(1) + $data$$118_result$$67_virt_addr$$34$$ | 0;
      $cpu$$718$$.last_instr_jump = !0;
      break;
    case 5:
      192 <= $modrm_byte$$107_new_cs$$3$$ && $cpu$$718$$.trigger_ud();
      $data$$118_result$$67_virt_addr$$34$$ = $cpu$$718$$.modrm_resolve($modrm_byte$$107_new_cs$$3$$);
      $modrm_byte$$107_new_cs$$3$$ = $cpu$$718$$.safe_read16($data$$118_result$$67_virt_addr$$34$$ + 4);
      $new_ip$$3_phys_addr$$33$$ = $cpu$$718$$.safe_read32s($data$$118_result$$67_virt_addr$$34$$);
      $cpu$$718$$.switch_seg(1, $modrm_byte$$107_new_cs$$3$$);
      $cpu$$718$$.instruction_pointer = $cpu$$718$$.get_seg(1) + $new_ip$$3_phys_addr$$33$$ | 0;
      $cpu$$718$$.last_instr_jump = !0;
      break;
    case 6:
      $data$$118_result$$67_virt_addr$$34$$ = 192 > $modrm_byte$$107_new_cs$$3$$ ? $cpu$$718$$.safe_read32s($cpu$$718$$.modrm_resolve($modrm_byte$$107_new_cs$$3$$)) : $cpu$$718$$.reg32s[$modrm_byte$$107_new_cs$$3$$ & 7];
      $cpu$$718$$.push32($data$$118_result$$67_virt_addr$$34$$);
      break;
    case 7:
      $cpu$$718$$.trigger_ud();
  }
};
$table0F_16$$[0] = $table0F_32$$[0] = function $$table0F_32$$$0$($cpu$$719$$) {
  var $modrm_byte$$108$$ = $cpu$$719$$.read_imm8();
  $cpu$$719$$.protected_mode || $cpu$$719$$.trigger_ud();
  $cpu$$719$$.cpl && $cpu$$719$$.trigger_gp(0);
  switch($modrm_byte$$108$$ >> 3 & 7) {
    case 0:
      if (192 > $modrm_byte$$108$$) {
        var $addr$$33$$ = $cpu$$719$$.modrm_resolve($modrm_byte$$108$$)
      }
      var $data$$119$$ = $cpu$$719$$.sreg[7];
      192 > $modrm_byte$$108$$ ? $cpu$$719$$.safe_write16($addr$$33$$, $data$$119$$) : $cpu$$719$$.reg16[$modrm_byte$$108$$ << 1 & 14] = $data$$119$$;
      break;
    case 1:
      192 > $modrm_byte$$108$$ && ($addr$$33$$ = $cpu$$719$$.modrm_resolve($modrm_byte$$108$$));
      $data$$119$$ = $cpu$$719$$.sreg[6];
      192 > $modrm_byte$$108$$ ? $cpu$$719$$.safe_write16($addr$$33$$, $data$$119$$) : $cpu$$719$$.reg16[$modrm_byte$$108$$ << 1 & 14] = $data$$119$$;
      break;
    case 2:
      $data$$119$$ = 192 > $modrm_byte$$108$$ ? $cpu$$719$$.safe_read16($cpu$$719$$.modrm_resolve($modrm_byte$$108$$)) : $cpu$$719$$.reg16[$modrm_byte$$108$$ << 1 & 14];
      $cpu$$719$$.load_ldt($data$$119$$);
      break;
    case 3:
      $data$$119$$ = 192 > $modrm_byte$$108$$ ? $cpu$$719$$.safe_read16($cpu$$719$$.modrm_resolve($modrm_byte$$108$$)) : $cpu$$719$$.reg16[$modrm_byte$$108$$ << 1 & 14];
      $cpu$$719$$.load_tr($data$$119$$);
      break;
    default:
      $cpu$$719$$.trigger_ud();
  }
};
$table0F_16$$[1] = $table0F_32$$[1] = function $$table0F_32$$$1$($cpu$$720$$) {
  var $modrm_byte$$109_size$$35$$ = $cpu$$720$$.read_imm8();
  $cpu$$720$$.cpl && $cpu$$720$$.trigger_gp(0);
  var $data$$120_mod$$262$$ = $modrm_byte$$109_size$$35$$ >> 3 & 7;
  if (4 === $data$$120_mod$$262$$) {
    if (192 > $modrm_byte$$109_size$$35$$) {
      var $addr$$34_offset$$15$$ = $cpu$$720$$.modrm_resolve($modrm_byte$$109_size$$35$$)
    }
    $data$$120_mod$$262$$ = $cpu$$720$$.cr0;
    192 > $modrm_byte$$109_size$$35$$ ? $cpu$$720$$.safe_write16($addr$$34_offset$$15$$, $data$$120_mod$$262$$) : $cpu$$720$$.reg16[$modrm_byte$$109_size$$35$$ << 1 & 14] = $data$$120_mod$$262$$;
  } else {
    if (6 === $data$$120_mod$$262$$) {
      $data$$120_mod$$262$$ = 192 > $modrm_byte$$109_size$$35$$ ? $cpu$$720$$.safe_read16($cpu$$720$$.modrm_resolve($modrm_byte$$109_size$$35$$)) : $cpu$$720$$.reg16[$modrm_byte$$109_size$$35$$ << 1 & 14], $cpu$$720$$.cr0 = $cpu$$720$$.cr0 & -16 | $data$$120_mod$$262$$ & 15, $cpu$$720$$.protected_mode && ($cpu$$720$$.cr0 |= 1), $cpu$$720$$.cr0_changed();
    } else {
      switch(192 <= $modrm_byte$$109_size$$35$$ && $cpu$$720$$.trigger_ud(), 2 !== $data$$120_mod$$262$$ && 3 !== $data$$120_mod$$262$$ || !$cpu$$720$$.protected_mode || ($cpu$$720$$.segment_prefix = 9), $addr$$34_offset$$15$$ = $cpu$$720$$.modrm_resolve($modrm_byte$$109_size$$35$$), $cpu$$720$$.segment_prefix = -1, $data$$120_mod$$262$$) {
        case 0:
          $cpu$$720$$.writable_or_pagefault($addr$$34_offset$$15$$, 6);
          $cpu$$720$$.safe_write16($addr$$34_offset$$15$$, $cpu$$720$$.gdtr_size);
          $cpu$$720$$.safe_write32($addr$$34_offset$$15$$ + 2, $cpu$$720$$.gdtr_offset);
          break;
        case 1:
          $cpu$$720$$.writable_or_pagefault($addr$$34_offset$$15$$, 6);
          $cpu$$720$$.safe_write16($addr$$34_offset$$15$$, $cpu$$720$$.idtr_size);
          $cpu$$720$$.safe_write32($addr$$34_offset$$15$$ + 2, $cpu$$720$$.idtr_offset);
          break;
        case 2:
          $modrm_byte$$109_size$$35$$ = $cpu$$720$$.safe_read16($addr$$34_offset$$15$$);
          $addr$$34_offset$$15$$ = $cpu$$720$$.safe_read32s($addr$$34_offset$$15$$ + 2);
          $cpu$$720$$.gdtr_size = $modrm_byte$$109_size$$35$$;
          $cpu$$720$$.gdtr_offset = $addr$$34_offset$$15$$;
          $cpu$$720$$.operand_size_32 || ($cpu$$720$$.gdtr_offset &= 16777215);
          break;
        case 3:
          $modrm_byte$$109_size$$35$$ = $cpu$$720$$.safe_read16($addr$$34_offset$$15$$);
          $addr$$34_offset$$15$$ = $cpu$$720$$.safe_read32s($addr$$34_offset$$15$$ + 2);
          $cpu$$720$$.idtr_size = $modrm_byte$$109_size$$35$$;
          $cpu$$720$$.idtr_offset = $addr$$34_offset$$15$$;
          $cpu$$720$$.operand_size_32 || ($cpu$$720$$.idtr_offset &= 16777215);
          break;
        case 7:
          $cpu$$720$$.invlpg($addr$$34_offset$$15$$);
          break;
        default:
          $cpu$$720$$.trigger_ud();
      }
    }
  }
};
$table0F_16$$[2] = $table0F_32$$[2] = function $$table0F_32$$$2$($cpu$$721$$) {
  $cpu$$721$$.read_imm8();
  $cpu$$721$$.trigger_ud();
};
$table0F_16$$[3] = $table0F_32$$[3] = function $$table0F_32$$$3$($cpu$$722$$) {
  $cpu$$722$$.read_imm8();
  $cpu$$722$$.trigger_ud();
};
$table0F_16$$[4] = $table0F_32$$[4] = function $$table0F_32$$$4$($cpu$$723$$) {
  $cpu$$723$$.trigger_ud();
};
$table0F_16$$[5] = $table0F_32$$[5] = function $$table0F_32$$$5$($cpu$$724$$) {
  $cpu$$724$$.trigger_ud();
};
$table0F_16$$[6] = $table0F_32$$[6] = function $$table0F_32$$$6$($cpu$$725$$) {
  $cpu$$725$$.cpl ? $cpu$$725$$.trigger_gp(0) : $cpu$$725$$.cr0 &= -9;
};
$table0F_16$$[7] = $table0F_32$$[7] = function $$table0F_32$$$7$($cpu$$726$$) {
  $cpu$$726$$.trigger_ud();
};
$table0F_16$$[8] = $table0F_32$$[8] = function $$table0F_32$$$8$($cpu$$727$$) {
  $cpu$$727$$.trigger_ud();
};
$table0F_16$$[9] = $table0F_32$$[9] = function $$table0F_32$$$9$($cpu$$728$$) {
  $cpu$$728$$.cpl && $cpu$$728$$.trigger_gp(0);
};
$table0F_16$$[10] = $table0F_32$$[10] = function $$table0F_32$$$10$($cpu$$729$$) {
  $cpu$$729$$.trigger_ud();
};
$table0F_16$$[11] = $table0F_32$$[11] = function $$table0F_32$$$11$($cpu$$730$$) {
  $cpu$$730$$.trigger_ud();
};
$table0F_16$$[12] = $table0F_32$$[12] = function $$table0F_32$$$12$($cpu$$731$$) {
  $cpu$$731$$.trigger_ud();
};
$table0F_16$$[13] = $table0F_32$$[13] = function $$table0F_32$$$13$($cpu$$732$$) {
  $cpu$$732$$.trigger_ud();
};
$table0F_16$$[14] = $table0F_32$$[14] = function $$table0F_32$$$14$($cpu$$733$$) {
  $cpu$$733$$.trigger_ud();
};
$table0F_16$$[15] = $table0F_32$$[15] = function $$table0F_32$$$15$($cpu$$734$$) {
  $cpu$$734$$.trigger_ud();
};
$table0F_16$$[16] = $table0F_32$$[16] = function $$table0F_32$$$16$($cpu$$735$$) {
  $cpu$$735$$.trigger_ud();
};
$table0F_16$$[17] = $table0F_32$$[17] = function $$table0F_32$$$17$($cpu$$736$$) {
  $cpu$$736$$.trigger_ud();
};
$table0F_16$$[18] = $table0F_32$$[18] = function $$table0F_32$$$18$($cpu$$737$$) {
  $cpu$$737$$.trigger_ud();
};
$table0F_16$$[19] = $table0F_32$$[19] = function $$table0F_32$$$19$($cpu$$738$$) {
  $cpu$$738$$.trigger_ud();
};
$table0F_16$$[20] = $table0F_32$$[20] = function $$table0F_32$$$20$($cpu$$739$$) {
  $cpu$$739$$.trigger_ud();
};
$table0F_16$$[21] = $table0F_32$$[21] = function $$table0F_32$$$21$($cpu$$740$$) {
  $cpu$$740$$.trigger_ud();
};
$table0F_16$$[22] = $table0F_32$$[22] = function $$table0F_32$$$22$($cpu$$741$$) {
  $cpu$$741$$.trigger_ud();
};
$table0F_16$$[23] = $table0F_32$$[23] = function $$table0F_32$$$23$($cpu$$742$$) {
  $cpu$$742$$.trigger_ud();
};
$table0F_16$$[24] = $table0F_32$$[24] = function $$table0F_32$$$24$($cpu$$743$$) {
  var $modrm_byte$$112$$ = $cpu$$743$$.read_imm8();
  192 > $modrm_byte$$112$$ && $cpu$$743$$.modrm_resolve($modrm_byte$$112$$);
};
$table0F_16$$[25] = $table0F_32$$[25] = function $$table0F_32$$$25$($cpu$$744$$) {
  $cpu$$744$$.trigger_ud();
};
$table0F_16$$[26] = $table0F_32$$[26] = function $$table0F_32$$$26$($cpu$$745$$) {
  $cpu$$745$$.trigger_ud();
};
$table0F_16$$[27] = $table0F_32$$[27] = function $$table0F_32$$$27$($cpu$$746$$) {
  $cpu$$746$$.trigger_ud();
};
$table0F_16$$[28] = $table0F_32$$[28] = function $$table0F_32$$$28$($cpu$$747$$) {
  $cpu$$747$$.trigger_ud();
};
$table0F_16$$[29] = $table0F_32$$[29] = function $$table0F_32$$$29$($cpu$$748$$) {
  $cpu$$748$$.trigger_ud();
};
$table0F_16$$[30] = $table0F_32$$[30] = function $$table0F_32$$$30$($cpu$$749$$) {
  $cpu$$749$$.trigger_ud();
};
$table0F_16$$[31] = $table0F_32$$[31] = function $$table0F_32$$$31$($cpu$$750$$) {
  $cpu$$750$$.trigger_ud();
};
$table0F_16$$[32] = $table0F_32$$[32] = function $$table0F_32$$$32$($cpu$$751$$) {
  var $modrm_byte$$113$$ = $cpu$$751$$.read_imm8();
  $cpu$$751$$.cpl && $cpu$$751$$.trigger_gp(0);
  switch($modrm_byte$$113$$ >> 3 & 7) {
    case 0:
      $cpu$$751$$.reg32s[$modrm_byte$$113$$ & 7] = $cpu$$751$$.cr0;
      break;
    case 2:
      $cpu$$751$$.reg32s[$modrm_byte$$113$$ & 7] = $cpu$$751$$.cr2;
      break;
    case 3:
      $cpu$$751$$.reg32s[$modrm_byte$$113$$ & 7] = $cpu$$751$$.cr3;
      break;
    case 4:
      $cpu$$751$$.reg32s[$modrm_byte$$113$$ & 7] = $cpu$$751$$.cr4;
      break;
    default:
      $cpu$$751$$.trigger_ud();
  }
};
$table0F_16$$[33] = $table0F_32$$[33] = function $$table0F_32$$$33$($cpu$$752$$) {
  var $modrm_byte$$114$$ = $cpu$$752$$.read_imm8();
  $cpu$$752$$.cpl && $cpu$$752$$.trigger_gp(0);
  $cpu$$752$$.reg32s[$modrm_byte$$114$$ & 7] = $cpu$$752$$.dreg[$modrm_byte$$114$$ >> 3 & 7];
};
$table0F_16$$[34] = $table0F_32$$[34] = function $$table0F_32$$$34$($cpu$$753$$) {
  var $modrm_byte$$115$$ = $cpu$$753$$.read_imm8();
  $cpu$$753$$.cpl && $cpu$$753$$.trigger_gp(0);
  var $data$$121$$ = $cpu$$753$$.reg32s[$modrm_byte$$115$$ & 7];
  switch($modrm_byte$$115$$ >> 3 & 7) {
    case 0:
      $cpu$$753$$.cr0 = $data$$121$$;
      if (-2147483648 === ($cpu$$753$$.cr0 & -2147483647)) {
        throw $cpu$$753$$.debug.unimpl("#GP handler");
      }
      $cpu$$753$$.cr0_changed();
      break;
    case 2:
      $cpu$$753$$.cr2 = $data$$121$$;
      break;
    case 3:
      $cpu$$753$$.cr3 = $data$$121$$;
      $cpu$$753$$.clear_tlb();
      break;
    case 4:
      $data$$121$$ & -3565568 && $cpu$$753$$.trigger_gp(0);
      ($cpu$$753$$.cr4 ^ $data$$121$$) & 128 && ($data$$121$$ & 128 ? $cpu$$753$$.clear_tlb() : $cpu$$753$$.full_clear_tlb());
      $cpu$$753$$.cr4 = $data$$121$$;
      $cpu$$753$$.page_size_extensions = $cpu$$753$$.cr4 & 16 ? 128 : 0;
      if ($cpu$$753$$.cr4 & 32) {
        throw $cpu$$753$$.debug.unimpl("PAE");
      }
      break;
    default:
      $cpu$$753$$.trigger_ud();
  }
};
$table0F_16$$[35] = $table0F_32$$[35] = function $$table0F_32$$$35$($cpu$$754$$) {
  var $modrm_byte$$116$$ = $cpu$$754$$.read_imm8();
  $cpu$$754$$.cpl && $cpu$$754$$.trigger_gp(0);
  $cpu$$754$$.dreg[$modrm_byte$$116$$ >> 3 & 7] = $cpu$$754$$.reg32s[$modrm_byte$$116$$ & 7];
};
$table0F_16$$[36] = $table0F_32$$[36] = function $$table0F_32$$$36$($cpu$$755$$) {
  $cpu$$755$$.trigger_ud();
};
$table0F_16$$[37] = $table0F_32$$[37] = function $$table0F_32$$$37$($cpu$$756$$) {
  $cpu$$756$$.trigger_ud();
};
$table0F_16$$[38] = $table0F_32$$[38] = function $$table0F_32$$$38$($cpu$$757$$) {
  $cpu$$757$$.trigger_ud();
};
$table0F_16$$[39] = $table0F_32$$[39] = function $$table0F_32$$$39$($cpu$$758$$) {
  $cpu$$758$$.trigger_ud();
};
$table0F_16$$[40] = $table0F_32$$[40] = function $$table0F_32$$$40$($cpu$$759$$) {
  $cpu$$759$$.trigger_ud();
};
$table0F_16$$[41] = $table0F_32$$[41] = function $$table0F_32$$$41$($cpu$$760$$) {
  $cpu$$760$$.trigger_ud();
};
$table0F_16$$[42] = $table0F_32$$[42] = function $$table0F_32$$$42$($cpu$$761$$) {
  $cpu$$761$$.trigger_ud();
};
$table0F_16$$[43] = $table0F_32$$[43] = function $$table0F_32$$$43$($cpu$$762$$) {
  $cpu$$762$$.trigger_ud();
};
$table0F_16$$[44] = $table0F_32$$[44] = function $$table0F_32$$$44$($cpu$$763$$) {
  $cpu$$763$$.trigger_ud();
};
$table0F_16$$[45] = $table0F_32$$[45] = function $$table0F_32$$$45$($cpu$$764$$) {
  $cpu$$764$$.trigger_ud();
};
$table0F_16$$[46] = $table0F_32$$[46] = function $$table0F_32$$$46$($cpu$$765$$) {
  $cpu$$765$$.trigger_ud();
};
$table0F_16$$[47] = $table0F_32$$[47] = function $$table0F_32$$$47$($cpu$$766$$) {
  $cpu$$766$$.trigger_ud();
};
$table0F_16$$[48] = $table0F_32$$[48] = function $$table0F_32$$$48$($cpu$$767$$) {
  $cpu$$767$$.trigger_ud();
};
$table0F_16$$[48] = $table0F_32$$[48] = function $$table0F_32$$$48$() {
};
$table0F_16$$[49] = $table0F_32$$[49] = function $$table0F_32$$$49$($cpu$$769$$) {
  $cpu$$769$$.protected_mode && $cpu$$769$$.cpl && $cpu$$769$$.cr4 & 4 ? $cpu$$769$$.trigger_gp(0) : ($cpu$$769$$.reg32s[0] = $cpu$$769$$.timestamp_counter, $cpu$$769$$.reg32s[2] = $cpu$$769$$.timestamp_counter / 4294967296);
};
$table0F_16$$[50] = $table0F_32$$[50] = function $$table0F_32$$$50$($cpu$$770$$) {
  $cpu$$770$$.reg32s[0] = 0;
  $cpu$$770$$.reg32s[2] = 0;
};
$table0F_16$$[51] = $table0F_32$$[51] = function $$table0F_32$$$51$($cpu$$771$$) {
  $cpu$$771$$.trigger_ud();
};
$table0F_16$$[52] = $table0F_32$$[52] = function $$table0F_32$$$52$($cpu$$772$$) {
  $cpu$$772$$.trigger_ud();
};
$table0F_16$$[53] = $table0F_32$$[53] = function $$table0F_32$$$53$($cpu$$773$$) {
  $cpu$$773$$.trigger_ud();
};
$table0F_16$$[54] = $table0F_32$$[54] = function $$table0F_32$$$54$($cpu$$774$$) {
  $cpu$$774$$.trigger_ud();
};
$table0F_16$$[55] = $table0F_32$$[55] = function $$table0F_32$$$55$($cpu$$775$$) {
  $cpu$$775$$.trigger_ud();
};
$table0F_16$$[56] = $table0F_32$$[56] = function $$table0F_32$$$56$($cpu$$776$$) {
  $cpu$$776$$.trigger_ud();
};
$table0F_16$$[57] = $table0F_32$$[57] = function $$table0F_32$$$57$($cpu$$777$$) {
  $cpu$$777$$.trigger_ud();
};
$table0F_16$$[58] = $table0F_32$$[58] = function $$table0F_32$$$58$($cpu$$778$$) {
  $cpu$$778$$.trigger_ud();
};
$table0F_16$$[59] = $table0F_32$$[59] = function $$table0F_32$$$59$($cpu$$779$$) {
  $cpu$$779$$.trigger_ud();
};
$table0F_16$$[60] = $table0F_32$$[60] = function $$table0F_32$$$60$($cpu$$780$$) {
  $cpu$$780$$.trigger_ud();
};
$table0F_16$$[61] = $table0F_32$$[61] = function $$table0F_32$$$61$($cpu$$781$$) {
  $cpu$$781$$.trigger_ud();
};
$table0F_16$$[62] = $table0F_32$$[62] = function $$table0F_32$$$62$($cpu$$782$$) {
  $cpu$$782$$.trigger_ud();
};
$table0F_16$$[63] = $table0F_32$$[63] = function $$table0F_32$$$63$($cpu$$783$$) {
  $cpu$$783$$.trigger_ud();
};
$table0F_16$$[64] = function $$table0F_16$$$64$($cpu$$784$$) {
  var $modrm_byte$$117$$ = $cpu$$784$$.read_imm8(), $data$$122$$ = 192 > $modrm_byte$$117$$ ? $cpu$$784$$.safe_read16($cpu$$784$$.modrm_resolve($modrm_byte$$117$$)) : $cpu$$784$$.reg16[$modrm_byte$$117$$ << 1 & 14];
  $cpu$$784$$.test_o() && ($cpu$$784$$.reg16[$modrm_byte$$117$$ >> 2 & 14] = $data$$122$$);
};
$table0F_32$$[64] = function $$table0F_32$$$64$($cpu$$785$$) {
  var $modrm_byte$$118$$ = $cpu$$785$$.read_imm8(), $data$$123$$ = 192 > $modrm_byte$$118$$ ? $cpu$$785$$.safe_read32s($cpu$$785$$.modrm_resolve($modrm_byte$$118$$)) : $cpu$$785$$.reg32s[$modrm_byte$$118$$ & 7];
  $cpu$$785$$.test_o() && ($cpu$$785$$.reg32s[$modrm_byte$$118$$ >> 3 & 7] = $data$$123$$);
};
$table0F_16$$[65] = function $$table0F_16$$$65$($cpu$$786$$) {
  var $modrm_byte$$119$$ = $cpu$$786$$.read_imm8(), $data$$124$$ = 192 > $modrm_byte$$119$$ ? $cpu$$786$$.safe_read16($cpu$$786$$.modrm_resolve($modrm_byte$$119$$)) : $cpu$$786$$.reg16[$modrm_byte$$119$$ << 1 & 14];
  $cpu$$786$$.test_o() || ($cpu$$786$$.reg16[$modrm_byte$$119$$ >> 2 & 14] = $data$$124$$);
};
$table0F_32$$[65] = function $$table0F_32$$$65$($cpu$$787$$) {
  var $modrm_byte$$120$$ = $cpu$$787$$.read_imm8(), $data$$125$$ = 192 > $modrm_byte$$120$$ ? $cpu$$787$$.safe_read32s($cpu$$787$$.modrm_resolve($modrm_byte$$120$$)) : $cpu$$787$$.reg32s[$modrm_byte$$120$$ & 7];
  $cpu$$787$$.test_o() || ($cpu$$787$$.reg32s[$modrm_byte$$120$$ >> 3 & 7] = $data$$125$$);
};
$table0F_16$$[66] = function $$table0F_16$$$66$($cpu$$788$$) {
  var $modrm_byte$$121$$ = $cpu$$788$$.read_imm8(), $data$$126$$ = 192 > $modrm_byte$$121$$ ? $cpu$$788$$.safe_read16($cpu$$788$$.modrm_resolve($modrm_byte$$121$$)) : $cpu$$788$$.reg16[$modrm_byte$$121$$ << 1 & 14];
  $cpu$$788$$.test_b() && ($cpu$$788$$.reg16[$modrm_byte$$121$$ >> 2 & 14] = $data$$126$$);
};
$table0F_32$$[66] = function $$table0F_32$$$66$($cpu$$789$$) {
  var $modrm_byte$$122$$ = $cpu$$789$$.read_imm8(), $data$$127$$ = 192 > $modrm_byte$$122$$ ? $cpu$$789$$.safe_read32s($cpu$$789$$.modrm_resolve($modrm_byte$$122$$)) : $cpu$$789$$.reg32s[$modrm_byte$$122$$ & 7];
  $cpu$$789$$.test_b() && ($cpu$$789$$.reg32s[$modrm_byte$$122$$ >> 3 & 7] = $data$$127$$);
};
$table0F_16$$[67] = function $$table0F_16$$$67$($cpu$$790$$) {
  var $modrm_byte$$123$$ = $cpu$$790$$.read_imm8(), $data$$128$$ = 192 > $modrm_byte$$123$$ ? $cpu$$790$$.safe_read16($cpu$$790$$.modrm_resolve($modrm_byte$$123$$)) : $cpu$$790$$.reg16[$modrm_byte$$123$$ << 1 & 14];
  $cpu$$790$$.test_b() || ($cpu$$790$$.reg16[$modrm_byte$$123$$ >> 2 & 14] = $data$$128$$);
};
$table0F_32$$[67] = function $$table0F_32$$$67$($cpu$$791$$) {
  var $modrm_byte$$124$$ = $cpu$$791$$.read_imm8(), $data$$129$$ = 192 > $modrm_byte$$124$$ ? $cpu$$791$$.safe_read32s($cpu$$791$$.modrm_resolve($modrm_byte$$124$$)) : $cpu$$791$$.reg32s[$modrm_byte$$124$$ & 7];
  $cpu$$791$$.test_b() || ($cpu$$791$$.reg32s[$modrm_byte$$124$$ >> 3 & 7] = $data$$129$$);
};
$table0F_16$$[68] = function $$table0F_16$$$68$($cpu$$792$$) {
  var $modrm_byte$$125$$ = $cpu$$792$$.read_imm8(), $data$$130$$ = 192 > $modrm_byte$$125$$ ? $cpu$$792$$.safe_read16($cpu$$792$$.modrm_resolve($modrm_byte$$125$$)) : $cpu$$792$$.reg16[$modrm_byte$$125$$ << 1 & 14];
  $cpu$$792$$.test_z() && ($cpu$$792$$.reg16[$modrm_byte$$125$$ >> 2 & 14] = $data$$130$$);
};
$table0F_32$$[68] = function $$table0F_32$$$68$($cpu$$793$$) {
  var $modrm_byte$$126$$ = $cpu$$793$$.read_imm8(), $data$$131$$ = 192 > $modrm_byte$$126$$ ? $cpu$$793$$.safe_read32s($cpu$$793$$.modrm_resolve($modrm_byte$$126$$)) : $cpu$$793$$.reg32s[$modrm_byte$$126$$ & 7];
  $cpu$$793$$.test_z() && ($cpu$$793$$.reg32s[$modrm_byte$$126$$ >> 3 & 7] = $data$$131$$);
};
$table0F_16$$[69] = function $$table0F_16$$$69$($cpu$$794$$) {
  var $modrm_byte$$127$$ = $cpu$$794$$.read_imm8(), $data$$132$$ = 192 > $modrm_byte$$127$$ ? $cpu$$794$$.safe_read16($cpu$$794$$.modrm_resolve($modrm_byte$$127$$)) : $cpu$$794$$.reg16[$modrm_byte$$127$$ << 1 & 14];
  $cpu$$794$$.test_z() || ($cpu$$794$$.reg16[$modrm_byte$$127$$ >> 2 & 14] = $data$$132$$);
};
$table0F_32$$[69] = function $$table0F_32$$$69$($cpu$$795$$) {
  var $modrm_byte$$128$$ = $cpu$$795$$.read_imm8(), $data$$133$$ = 192 > $modrm_byte$$128$$ ? $cpu$$795$$.safe_read32s($cpu$$795$$.modrm_resolve($modrm_byte$$128$$)) : $cpu$$795$$.reg32s[$modrm_byte$$128$$ & 7];
  $cpu$$795$$.test_z() || ($cpu$$795$$.reg32s[$modrm_byte$$128$$ >> 3 & 7] = $data$$133$$);
};
$table0F_16$$[70] = function $$table0F_16$$$70$($cpu$$796$$) {
  var $modrm_byte$$129$$ = $cpu$$796$$.read_imm8(), $data$$134$$ = 192 > $modrm_byte$$129$$ ? $cpu$$796$$.safe_read16($cpu$$796$$.modrm_resolve($modrm_byte$$129$$)) : $cpu$$796$$.reg16[$modrm_byte$$129$$ << 1 & 14];
  $cpu$$796$$.test_be() && ($cpu$$796$$.reg16[$modrm_byte$$129$$ >> 2 & 14] = $data$$134$$);
};
$table0F_32$$[70] = function $$table0F_32$$$70$($cpu$$797$$) {
  var $modrm_byte$$130$$ = $cpu$$797$$.read_imm8(), $data$$135$$ = 192 > $modrm_byte$$130$$ ? $cpu$$797$$.safe_read32s($cpu$$797$$.modrm_resolve($modrm_byte$$130$$)) : $cpu$$797$$.reg32s[$modrm_byte$$130$$ & 7];
  $cpu$$797$$.test_be() && ($cpu$$797$$.reg32s[$modrm_byte$$130$$ >> 3 & 7] = $data$$135$$);
};
$table0F_16$$[71] = function $$table0F_16$$$71$($cpu$$798$$) {
  var $modrm_byte$$131$$ = $cpu$$798$$.read_imm8(), $data$$136$$ = 192 > $modrm_byte$$131$$ ? $cpu$$798$$.safe_read16($cpu$$798$$.modrm_resolve($modrm_byte$$131$$)) : $cpu$$798$$.reg16[$modrm_byte$$131$$ << 1 & 14];
  $cpu$$798$$.test_be() || ($cpu$$798$$.reg16[$modrm_byte$$131$$ >> 2 & 14] = $data$$136$$);
};
$table0F_32$$[71] = function $$table0F_32$$$71$($cpu$$799$$) {
  var $modrm_byte$$132$$ = $cpu$$799$$.read_imm8(), $data$$137$$ = 192 > $modrm_byte$$132$$ ? $cpu$$799$$.safe_read32s($cpu$$799$$.modrm_resolve($modrm_byte$$132$$)) : $cpu$$799$$.reg32s[$modrm_byte$$132$$ & 7];
  $cpu$$799$$.test_be() || ($cpu$$799$$.reg32s[$modrm_byte$$132$$ >> 3 & 7] = $data$$137$$);
};
$table0F_16$$[72] = function $$table0F_16$$$72$($cpu$$800$$) {
  var $modrm_byte$$133$$ = $cpu$$800$$.read_imm8(), $data$$138$$ = 192 > $modrm_byte$$133$$ ? $cpu$$800$$.safe_read16($cpu$$800$$.modrm_resolve($modrm_byte$$133$$)) : $cpu$$800$$.reg16[$modrm_byte$$133$$ << 1 & 14];
  $cpu$$800$$.test_s() && ($cpu$$800$$.reg16[$modrm_byte$$133$$ >> 2 & 14] = $data$$138$$);
};
$table0F_32$$[72] = function $$table0F_32$$$72$($cpu$$801$$) {
  var $modrm_byte$$134$$ = $cpu$$801$$.read_imm8(), $data$$139$$ = 192 > $modrm_byte$$134$$ ? $cpu$$801$$.safe_read32s($cpu$$801$$.modrm_resolve($modrm_byte$$134$$)) : $cpu$$801$$.reg32s[$modrm_byte$$134$$ & 7];
  $cpu$$801$$.test_s() && ($cpu$$801$$.reg32s[$modrm_byte$$134$$ >> 3 & 7] = $data$$139$$);
};
$table0F_16$$[73] = function $$table0F_16$$$73$($cpu$$802$$) {
  var $modrm_byte$$135$$ = $cpu$$802$$.read_imm8(), $data$$140$$ = 192 > $modrm_byte$$135$$ ? $cpu$$802$$.safe_read16($cpu$$802$$.modrm_resolve($modrm_byte$$135$$)) : $cpu$$802$$.reg16[$modrm_byte$$135$$ << 1 & 14];
  $cpu$$802$$.test_s() || ($cpu$$802$$.reg16[$modrm_byte$$135$$ >> 2 & 14] = $data$$140$$);
};
$table0F_32$$[73] = function $$table0F_32$$$73$($cpu$$803$$) {
  var $modrm_byte$$136$$ = $cpu$$803$$.read_imm8(), $data$$141$$ = 192 > $modrm_byte$$136$$ ? $cpu$$803$$.safe_read32s($cpu$$803$$.modrm_resolve($modrm_byte$$136$$)) : $cpu$$803$$.reg32s[$modrm_byte$$136$$ & 7];
  $cpu$$803$$.test_s() || ($cpu$$803$$.reg32s[$modrm_byte$$136$$ >> 3 & 7] = $data$$141$$);
};
$table0F_16$$[74] = function $$table0F_16$$$74$($cpu$$804$$) {
  var $modrm_byte$$137$$ = $cpu$$804$$.read_imm8(), $data$$142$$ = 192 > $modrm_byte$$137$$ ? $cpu$$804$$.safe_read16($cpu$$804$$.modrm_resolve($modrm_byte$$137$$)) : $cpu$$804$$.reg16[$modrm_byte$$137$$ << 1 & 14];
  $cpu$$804$$.test_p() && ($cpu$$804$$.reg16[$modrm_byte$$137$$ >> 2 & 14] = $data$$142$$);
};
$table0F_32$$[74] = function $$table0F_32$$$74$($cpu$$805$$) {
  var $modrm_byte$$138$$ = $cpu$$805$$.read_imm8(), $data$$143$$ = 192 > $modrm_byte$$138$$ ? $cpu$$805$$.safe_read32s($cpu$$805$$.modrm_resolve($modrm_byte$$138$$)) : $cpu$$805$$.reg32s[$modrm_byte$$138$$ & 7];
  $cpu$$805$$.test_p() && ($cpu$$805$$.reg32s[$modrm_byte$$138$$ >> 3 & 7] = $data$$143$$);
};
$table0F_16$$[75] = function $$table0F_16$$$75$($cpu$$806$$) {
  var $modrm_byte$$139$$ = $cpu$$806$$.read_imm8(), $data$$144$$ = 192 > $modrm_byte$$139$$ ? $cpu$$806$$.safe_read16($cpu$$806$$.modrm_resolve($modrm_byte$$139$$)) : $cpu$$806$$.reg16[$modrm_byte$$139$$ << 1 & 14];
  $cpu$$806$$.test_p() || ($cpu$$806$$.reg16[$modrm_byte$$139$$ >> 2 & 14] = $data$$144$$);
};
$table0F_32$$[75] = function $$table0F_32$$$75$($cpu$$807$$) {
  var $modrm_byte$$140$$ = $cpu$$807$$.read_imm8(), $data$$145$$ = 192 > $modrm_byte$$140$$ ? $cpu$$807$$.safe_read32s($cpu$$807$$.modrm_resolve($modrm_byte$$140$$)) : $cpu$$807$$.reg32s[$modrm_byte$$140$$ & 7];
  $cpu$$807$$.test_p() || ($cpu$$807$$.reg32s[$modrm_byte$$140$$ >> 3 & 7] = $data$$145$$);
};
$table0F_16$$[76] = function $$table0F_16$$$76$($cpu$$808$$) {
  var $modrm_byte$$141$$ = $cpu$$808$$.read_imm8(), $data$$146$$ = 192 > $modrm_byte$$141$$ ? $cpu$$808$$.safe_read16($cpu$$808$$.modrm_resolve($modrm_byte$$141$$)) : $cpu$$808$$.reg16[$modrm_byte$$141$$ << 1 & 14];
  $cpu$$808$$.test_l() && ($cpu$$808$$.reg16[$modrm_byte$$141$$ >> 2 & 14] = $data$$146$$);
};
$table0F_32$$[76] = function $$table0F_32$$$76$($cpu$$809$$) {
  var $modrm_byte$$142$$ = $cpu$$809$$.read_imm8(), $data$$147$$ = 192 > $modrm_byte$$142$$ ? $cpu$$809$$.safe_read32s($cpu$$809$$.modrm_resolve($modrm_byte$$142$$)) : $cpu$$809$$.reg32s[$modrm_byte$$142$$ & 7];
  $cpu$$809$$.test_l() && ($cpu$$809$$.reg32s[$modrm_byte$$142$$ >> 3 & 7] = $data$$147$$);
};
$table0F_16$$[77] = function $$table0F_16$$$77$($cpu$$810$$) {
  var $modrm_byte$$143$$ = $cpu$$810$$.read_imm8(), $data$$148$$ = 192 > $modrm_byte$$143$$ ? $cpu$$810$$.safe_read16($cpu$$810$$.modrm_resolve($modrm_byte$$143$$)) : $cpu$$810$$.reg16[$modrm_byte$$143$$ << 1 & 14];
  $cpu$$810$$.test_l() || ($cpu$$810$$.reg16[$modrm_byte$$143$$ >> 2 & 14] = $data$$148$$);
};
$table0F_32$$[77] = function $$table0F_32$$$77$($cpu$$811$$) {
  var $modrm_byte$$144$$ = $cpu$$811$$.read_imm8(), $data$$149$$ = 192 > $modrm_byte$$144$$ ? $cpu$$811$$.safe_read32s($cpu$$811$$.modrm_resolve($modrm_byte$$144$$)) : $cpu$$811$$.reg32s[$modrm_byte$$144$$ & 7];
  $cpu$$811$$.test_l() || ($cpu$$811$$.reg32s[$modrm_byte$$144$$ >> 3 & 7] = $data$$149$$);
};
$table0F_16$$[78] = function $$table0F_16$$$78$($cpu$$812$$) {
  var $modrm_byte$$145$$ = $cpu$$812$$.read_imm8(), $data$$150$$ = 192 > $modrm_byte$$145$$ ? $cpu$$812$$.safe_read16($cpu$$812$$.modrm_resolve($modrm_byte$$145$$)) : $cpu$$812$$.reg16[$modrm_byte$$145$$ << 1 & 14];
  $cpu$$812$$.test_le() && ($cpu$$812$$.reg16[$modrm_byte$$145$$ >> 2 & 14] = $data$$150$$);
};
$table0F_32$$[78] = function $$table0F_32$$$78$($cpu$$813$$) {
  var $modrm_byte$$146$$ = $cpu$$813$$.read_imm8(), $data$$151$$ = 192 > $modrm_byte$$146$$ ? $cpu$$813$$.safe_read32s($cpu$$813$$.modrm_resolve($modrm_byte$$146$$)) : $cpu$$813$$.reg32s[$modrm_byte$$146$$ & 7];
  $cpu$$813$$.test_le() && ($cpu$$813$$.reg32s[$modrm_byte$$146$$ >> 3 & 7] = $data$$151$$);
};
$table0F_16$$[79] = function $$table0F_16$$$79$($cpu$$814$$) {
  var $modrm_byte$$147$$ = $cpu$$814$$.read_imm8(), $data$$152$$ = 192 > $modrm_byte$$147$$ ? $cpu$$814$$.safe_read16($cpu$$814$$.modrm_resolve($modrm_byte$$147$$)) : $cpu$$814$$.reg16[$modrm_byte$$147$$ << 1 & 14];
  $cpu$$814$$.test_le() || ($cpu$$814$$.reg16[$modrm_byte$$147$$ >> 2 & 14] = $data$$152$$);
};
$table0F_32$$[79] = function $$table0F_32$$$79$($cpu$$815$$) {
  var $modrm_byte$$148$$ = $cpu$$815$$.read_imm8(), $data$$153$$ = 192 > $modrm_byte$$148$$ ? $cpu$$815$$.safe_read32s($cpu$$815$$.modrm_resolve($modrm_byte$$148$$)) : $cpu$$815$$.reg32s[$modrm_byte$$148$$ & 7];
  $cpu$$815$$.test_le() || ($cpu$$815$$.reg32s[$modrm_byte$$148$$ >> 3 & 7] = $data$$153$$);
};
$table0F_16$$[80] = $table0F_32$$[80] = function $$table0F_32$$$80$($cpu$$816$$) {
  $cpu$$816$$.trigger_ud();
};
$table0F_16$$[81] = $table0F_32$$[81] = function $$table0F_32$$$81$($cpu$$817$$) {
  $cpu$$817$$.trigger_ud();
};
$table0F_16$$[82] = $table0F_32$$[82] = function $$table0F_32$$$82$($cpu$$818$$) {
  $cpu$$818$$.trigger_ud();
};
$table0F_16$$[83] = $table0F_32$$[83] = function $$table0F_32$$$83$($cpu$$819$$) {
  $cpu$$819$$.trigger_ud();
};
$table0F_16$$[84] = $table0F_32$$[84] = function $$table0F_32$$$84$($cpu$$820$$) {
  $cpu$$820$$.trigger_ud();
};
$table0F_16$$[85] = $table0F_32$$[85] = function $$table0F_32$$$85$($cpu$$821$$) {
  $cpu$$821$$.trigger_ud();
};
$table0F_16$$[86] = $table0F_32$$[86] = function $$table0F_32$$$86$($cpu$$822$$) {
  $cpu$$822$$.trigger_ud();
};
$table0F_16$$[87] = $table0F_32$$[87] = function $$table0F_32$$$87$($cpu$$823$$) {
  $cpu$$823$$.trigger_ud();
};
$table0F_16$$[88] = $table0F_32$$[88] = function $$table0F_32$$$88$($cpu$$824$$) {
  $cpu$$824$$.trigger_ud();
};
$table0F_16$$[89] = $table0F_32$$[89] = function $$table0F_32$$$89$($cpu$$825$$) {
  $cpu$$825$$.trigger_ud();
};
$table0F_16$$[90] = $table0F_32$$[90] = function $$table0F_32$$$90$($cpu$$826$$) {
  $cpu$$826$$.trigger_ud();
};
$table0F_16$$[91] = $table0F_32$$[91] = function $$table0F_32$$$91$($cpu$$827$$) {
  $cpu$$827$$.trigger_ud();
};
$table0F_16$$[92] = $table0F_32$$[92] = function $$table0F_32$$$92$($cpu$$828$$) {
  $cpu$$828$$.trigger_ud();
};
$table0F_16$$[93] = $table0F_32$$[93] = function $$table0F_32$$$93$($cpu$$829$$) {
  $cpu$$829$$.trigger_ud();
};
$table0F_16$$[94] = $table0F_32$$[94] = function $$table0F_32$$$94$($cpu$$830$$) {
  $cpu$$830$$.trigger_ud();
};
$table0F_16$$[95] = $table0F_32$$[95] = function $$table0F_32$$$95$($cpu$$831$$) {
  $cpu$$831$$.trigger_ud();
};
$table0F_16$$[96] = $table0F_32$$[96] = function $$table0F_32$$$96$($cpu$$832$$) {
  $cpu$$832$$.trigger_ud();
};
$table0F_16$$[97] = $table0F_32$$[97] = function $$table0F_32$$$97$($cpu$$833$$) {
  $cpu$$833$$.trigger_ud();
};
$table0F_16$$[98] = $table0F_32$$[98] = function $$table0F_32$$$98$($cpu$$834$$) {
  $cpu$$834$$.trigger_ud();
};
$table0F_16$$[99] = $table0F_32$$[99] = function $$table0F_32$$$99$($cpu$$835$$) {
  $cpu$$835$$.trigger_ud();
};
$table0F_16$$[100] = $table0F_32$$[100] = function $$table0F_32$$$100$($cpu$$836$$) {
  $cpu$$836$$.trigger_ud();
};
$table0F_16$$[101] = $table0F_32$$[101] = function $$table0F_32$$$101$($cpu$$837$$) {
  $cpu$$837$$.trigger_ud();
};
$table0F_16$$[102] = $table0F_32$$[102] = function $$table0F_32$$$102$($cpu$$838$$) {
  $cpu$$838$$.trigger_ud();
};
$table0F_16$$[103] = $table0F_32$$[103] = function $$table0F_32$$$103$($cpu$$839$$) {
  $cpu$$839$$.trigger_ud();
};
$table0F_16$$[104] = $table0F_32$$[104] = function $$table0F_32$$$104$($cpu$$840$$) {
  $cpu$$840$$.trigger_ud();
};
$table0F_16$$[105] = $table0F_32$$[105] = function $$table0F_32$$$105$($cpu$$841$$) {
  $cpu$$841$$.trigger_ud();
};
$table0F_16$$[106] = $table0F_32$$[106] = function $$table0F_32$$$106$($cpu$$842$$) {
  $cpu$$842$$.trigger_ud();
};
$table0F_16$$[107] = $table0F_32$$[107] = function $$table0F_32$$$107$($cpu$$843$$) {
  $cpu$$843$$.trigger_ud();
};
$table0F_16$$[108] = $table0F_32$$[108] = function $$table0F_32$$$108$($cpu$$844$$) {
  $cpu$$844$$.trigger_ud();
};
$table0F_16$$[109] = $table0F_32$$[109] = function $$table0F_32$$$109$($cpu$$845$$) {
  $cpu$$845$$.trigger_ud();
};
$table0F_16$$[110] = $table0F_32$$[110] = function $$table0F_32$$$110$($cpu$$846$$) {
  $cpu$$846$$.trigger_ud();
};
$table0F_16$$[111] = $table0F_32$$[111] = function $$table0F_32$$$111$($cpu$$847$$) {
  $cpu$$847$$.trigger_ud();
};
$table0F_16$$[112] = $table0F_32$$[112] = function $$table0F_32$$$112$($cpu$$848$$) {
  $cpu$$848$$.trigger_ud();
};
$table0F_16$$[113] = $table0F_32$$[113] = function $$table0F_32$$$113$($cpu$$849$$) {
  $cpu$$849$$.trigger_ud();
};
$table0F_16$$[114] = $table0F_32$$[114] = function $$table0F_32$$$114$($cpu$$850$$) {
  $cpu$$850$$.trigger_ud();
};
$table0F_16$$[115] = $table0F_32$$[115] = function $$table0F_32$$$115$($cpu$$851$$) {
  $cpu$$851$$.trigger_ud();
};
$table0F_16$$[116] = $table0F_32$$[116] = function $$table0F_32$$$116$($cpu$$852$$) {
  $cpu$$852$$.trigger_ud();
};
$table0F_16$$[117] = $table0F_32$$[117] = function $$table0F_32$$$117$($cpu$$853$$) {
  $cpu$$853$$.trigger_ud();
};
$table0F_16$$[118] = $table0F_32$$[118] = function $$table0F_32$$$118$($cpu$$854$$) {
  $cpu$$854$$.trigger_ud();
};
$table0F_16$$[119] = $table0F_32$$[119] = function $$table0F_32$$$119$($cpu$$855$$) {
  $cpu$$855$$.trigger_ud();
};
$table0F_16$$[120] = $table0F_32$$[120] = function $$table0F_32$$$120$($cpu$$856$$) {
  $cpu$$856$$.trigger_ud();
};
$table0F_16$$[121] = $table0F_32$$[121] = function $$table0F_32$$$121$($cpu$$857$$) {
  $cpu$$857$$.trigger_ud();
};
$table0F_16$$[122] = $table0F_32$$[122] = function $$table0F_32$$$122$($cpu$$858$$) {
  $cpu$$858$$.trigger_ud();
};
$table0F_16$$[123] = $table0F_32$$[123] = function $$table0F_32$$$123$($cpu$$859$$) {
  $cpu$$859$$.trigger_ud();
};
$table0F_16$$[124] = $table0F_32$$[124] = function $$table0F_32$$$124$($cpu$$860$$) {
  $cpu$$860$$.trigger_ud();
};
$table0F_16$$[125] = $table0F_32$$[125] = function $$table0F_32$$$125$($cpu$$861$$) {
  $cpu$$861$$.trigger_ud();
};
$table0F_16$$[126] = $table0F_32$$[126] = function $$table0F_32$$$126$($cpu$$862$$) {
  $cpu$$862$$.trigger_ud();
};
$table0F_16$$[127] = $table0F_32$$[127] = function $$table0F_32$$$127$($cpu$$863$$) {
  $cpu$$863$$.trigger_ud();
};
$table0F_16$$[128] = function $$table0F_16$$$128$($cpu$$864$$) {
  $cpu$$864$$.jmpcc16($cpu$$864$$.test_o());
};
$table0F_32$$[128] = function $$table0F_32$$$128$($cpu$$865$$) {
  $cpu$$865$$.jmpcc32($cpu$$865$$.test_o());
};
$table0F_16$$[129] = function $$table0F_16$$$129$($cpu$$866$$) {
  $cpu$$866$$.jmpcc16(!$cpu$$866$$.test_o());
};
$table0F_32$$[129] = function $$table0F_32$$$129$($cpu$$867$$) {
  $cpu$$867$$.jmpcc32(!$cpu$$867$$.test_o());
};
$table0F_16$$[130] = function $$table0F_16$$$130$($cpu$$868$$) {
  $cpu$$868$$.jmpcc16($cpu$$868$$.test_b());
};
$table0F_32$$[130] = function $$table0F_32$$$130$($cpu$$869$$) {
  $cpu$$869$$.jmpcc32($cpu$$869$$.test_b());
};
$table0F_16$$[131] = function $$table0F_16$$$131$($cpu$$870$$) {
  $cpu$$870$$.jmpcc16(!$cpu$$870$$.test_b());
};
$table0F_32$$[131] = function $$table0F_32$$$131$($cpu$$871$$) {
  $cpu$$871$$.jmpcc32(!$cpu$$871$$.test_b());
};
$table0F_16$$[132] = function $$table0F_16$$$132$($cpu$$872$$) {
  $cpu$$872$$.jmpcc16($cpu$$872$$.test_z());
};
$table0F_32$$[132] = function $$table0F_32$$$132$($cpu$$873$$) {
  $cpu$$873$$.jmpcc32($cpu$$873$$.test_z());
};
$table0F_16$$[133] = function $$table0F_16$$$133$($cpu$$874$$) {
  $cpu$$874$$.jmpcc16(!$cpu$$874$$.test_z());
};
$table0F_32$$[133] = function $$table0F_32$$$133$($cpu$$875$$) {
  $cpu$$875$$.jmpcc32(!$cpu$$875$$.test_z());
};
$table0F_16$$[134] = function $$table0F_16$$$134$($cpu$$876$$) {
  $cpu$$876$$.jmpcc16($cpu$$876$$.test_be());
};
$table0F_32$$[134] = function $$table0F_32$$$134$($cpu$$877$$) {
  $cpu$$877$$.jmpcc32($cpu$$877$$.test_be());
};
$table0F_16$$[135] = function $$table0F_16$$$135$($cpu$$878$$) {
  $cpu$$878$$.jmpcc16(!$cpu$$878$$.test_be());
};
$table0F_32$$[135] = function $$table0F_32$$$135$($cpu$$879$$) {
  $cpu$$879$$.jmpcc32(!$cpu$$879$$.test_be());
};
$table0F_16$$[136] = function $$table0F_16$$$136$($cpu$$880$$) {
  $cpu$$880$$.jmpcc16($cpu$$880$$.test_s());
};
$table0F_32$$[136] = function $$table0F_32$$$136$($cpu$$881$$) {
  $cpu$$881$$.jmpcc32($cpu$$881$$.test_s());
};
$table0F_16$$[137] = function $$table0F_16$$$137$($cpu$$882$$) {
  $cpu$$882$$.jmpcc16(!$cpu$$882$$.test_s());
};
$table0F_32$$[137] = function $$table0F_32$$$137$($cpu$$883$$) {
  $cpu$$883$$.jmpcc32(!$cpu$$883$$.test_s());
};
$table0F_16$$[138] = function $$table0F_16$$$138$($cpu$$884$$) {
  $cpu$$884$$.jmpcc16($cpu$$884$$.test_p());
};
$table0F_32$$[138] = function $$table0F_32$$$138$($cpu$$885$$) {
  $cpu$$885$$.jmpcc32($cpu$$885$$.test_p());
};
$table0F_16$$[139] = function $$table0F_16$$$139$($cpu$$886$$) {
  $cpu$$886$$.jmpcc16(!$cpu$$886$$.test_p());
};
$table0F_32$$[139] = function $$table0F_32$$$139$($cpu$$887$$) {
  $cpu$$887$$.jmpcc32(!$cpu$$887$$.test_p());
};
$table0F_16$$[140] = function $$table0F_16$$$140$($cpu$$888$$) {
  $cpu$$888$$.jmpcc16($cpu$$888$$.test_l());
};
$table0F_32$$[140] = function $$table0F_32$$$140$($cpu$$889$$) {
  $cpu$$889$$.jmpcc32($cpu$$889$$.test_l());
};
$table0F_16$$[141] = function $$table0F_16$$$141$($cpu$$890$$) {
  $cpu$$890$$.jmpcc16(!$cpu$$890$$.test_l());
};
$table0F_32$$[141] = function $$table0F_32$$$141$($cpu$$891$$) {
  $cpu$$891$$.jmpcc32(!$cpu$$891$$.test_l());
};
$table0F_16$$[142] = function $$table0F_16$$$142$($cpu$$892$$) {
  $cpu$$892$$.jmpcc16($cpu$$892$$.test_le());
};
$table0F_32$$[142] = function $$table0F_32$$$142$($cpu$$893$$) {
  $cpu$$893$$.jmpcc32($cpu$$893$$.test_le());
};
$table0F_16$$[143] = function $$table0F_16$$$143$($cpu$$894$$) {
  $cpu$$894$$.jmpcc16(!$cpu$$894$$.test_le());
};
$table0F_32$$[143] = function $$table0F_32$$$143$($cpu$$895$$) {
  $cpu$$895$$.jmpcc32(!$cpu$$895$$.test_le());
};
$table0F_16$$[144] = $table0F_32$$[144] = function $$table0F_32$$$144$($cpu$$896$$) {
  var $modrm_byte$$149$$ = $cpu$$896$$.read_imm8();
  if (192 > $modrm_byte$$149$$) {
    var $addr$$35$$ = $cpu$$896$$.modrm_resolve($modrm_byte$$149$$)
  }
  var $data$$154$$ = !$cpu$$896$$.test_o() ^ 1;
  192 > $modrm_byte$$149$$ ? $cpu$$896$$.safe_write8($addr$$35$$, $data$$154$$) : $cpu$$896$$.reg8[$modrm_byte$$149$$ << 2 & 12 | $modrm_byte$$149$$ >> 2 & 1] = $data$$154$$;
};
$table0F_16$$[145] = $table0F_32$$[145] = function $$table0F_32$$$145$($cpu$$897$$) {
  var $modrm_byte$$150$$ = $cpu$$897$$.read_imm8();
  if (192 > $modrm_byte$$150$$) {
    var $addr$$36$$ = $cpu$$897$$.modrm_resolve($modrm_byte$$150$$)
  }
  var $data$$155$$ = !!$cpu$$897$$.test_o() ^ 1;
  192 > $modrm_byte$$150$$ ? $cpu$$897$$.safe_write8($addr$$36$$, $data$$155$$) : $cpu$$897$$.reg8[$modrm_byte$$150$$ << 2 & 12 | $modrm_byte$$150$$ >> 2 & 1] = $data$$155$$;
};
$table0F_16$$[146] = $table0F_32$$[146] = function $$table0F_32$$$146$($cpu$$898$$) {
  var $modrm_byte$$151$$ = $cpu$$898$$.read_imm8();
  if (192 > $modrm_byte$$151$$) {
    var $addr$$37$$ = $cpu$$898$$.modrm_resolve($modrm_byte$$151$$)
  }
  var $data$$156$$ = !$cpu$$898$$.test_b() ^ 1;
  192 > $modrm_byte$$151$$ ? $cpu$$898$$.safe_write8($addr$$37$$, $data$$156$$) : $cpu$$898$$.reg8[$modrm_byte$$151$$ << 2 & 12 | $modrm_byte$$151$$ >> 2 & 1] = $data$$156$$;
};
$table0F_16$$[147] = $table0F_32$$[147] = function $$table0F_32$$$147$($cpu$$899$$) {
  var $modrm_byte$$152$$ = $cpu$$899$$.read_imm8();
  if (192 > $modrm_byte$$152$$) {
    var $addr$$38$$ = $cpu$$899$$.modrm_resolve($modrm_byte$$152$$)
  }
  var $data$$157$$ = !!$cpu$$899$$.test_b() ^ 1;
  192 > $modrm_byte$$152$$ ? $cpu$$899$$.safe_write8($addr$$38$$, $data$$157$$) : $cpu$$899$$.reg8[$modrm_byte$$152$$ << 2 & 12 | $modrm_byte$$152$$ >> 2 & 1] = $data$$157$$;
};
$table0F_16$$[148] = $table0F_32$$[148] = function $$table0F_32$$$148$($cpu$$900$$) {
  var $modrm_byte$$153$$ = $cpu$$900$$.read_imm8();
  if (192 > $modrm_byte$$153$$) {
    var $addr$$39$$ = $cpu$$900$$.modrm_resolve($modrm_byte$$153$$)
  }
  var $data$$158$$ = !$cpu$$900$$.test_z() ^ 1;
  192 > $modrm_byte$$153$$ ? $cpu$$900$$.safe_write8($addr$$39$$, $data$$158$$) : $cpu$$900$$.reg8[$modrm_byte$$153$$ << 2 & 12 | $modrm_byte$$153$$ >> 2 & 1] = $data$$158$$;
};
$table0F_16$$[149] = $table0F_32$$[149] = function $$table0F_32$$$149$($cpu$$901$$) {
  var $modrm_byte$$154$$ = $cpu$$901$$.read_imm8();
  if (192 > $modrm_byte$$154$$) {
    var $addr$$40$$ = $cpu$$901$$.modrm_resolve($modrm_byte$$154$$)
  }
  var $data$$159$$ = !!$cpu$$901$$.test_z() ^ 1;
  192 > $modrm_byte$$154$$ ? $cpu$$901$$.safe_write8($addr$$40$$, $data$$159$$) : $cpu$$901$$.reg8[$modrm_byte$$154$$ << 2 & 12 | $modrm_byte$$154$$ >> 2 & 1] = $data$$159$$;
};
$table0F_16$$[150] = $table0F_32$$[150] = function $$table0F_32$$$150$($cpu$$902$$) {
  var $modrm_byte$$155$$ = $cpu$$902$$.read_imm8();
  if (192 > $modrm_byte$$155$$) {
    var $addr$$41$$ = $cpu$$902$$.modrm_resolve($modrm_byte$$155$$)
  }
  var $data$$160$$ = !$cpu$$902$$.test_be() ^ 1;
  192 > $modrm_byte$$155$$ ? $cpu$$902$$.safe_write8($addr$$41$$, $data$$160$$) : $cpu$$902$$.reg8[$modrm_byte$$155$$ << 2 & 12 | $modrm_byte$$155$$ >> 2 & 1] = $data$$160$$;
};
$table0F_16$$[151] = $table0F_32$$[151] = function $$table0F_32$$$151$($cpu$$903$$) {
  var $modrm_byte$$156$$ = $cpu$$903$$.read_imm8();
  if (192 > $modrm_byte$$156$$) {
    var $addr$$42$$ = $cpu$$903$$.modrm_resolve($modrm_byte$$156$$)
  }
  var $data$$161$$ = !!$cpu$$903$$.test_be() ^ 1;
  192 > $modrm_byte$$156$$ ? $cpu$$903$$.safe_write8($addr$$42$$, $data$$161$$) : $cpu$$903$$.reg8[$modrm_byte$$156$$ << 2 & 12 | $modrm_byte$$156$$ >> 2 & 1] = $data$$161$$;
};
$table0F_16$$[152] = $table0F_32$$[152] = function $$table0F_32$$$152$($cpu$$904$$) {
  var $modrm_byte$$157$$ = $cpu$$904$$.read_imm8();
  if (192 > $modrm_byte$$157$$) {
    var $addr$$43$$ = $cpu$$904$$.modrm_resolve($modrm_byte$$157$$)
  }
  var $data$$162$$ = !$cpu$$904$$.test_s() ^ 1;
  192 > $modrm_byte$$157$$ ? $cpu$$904$$.safe_write8($addr$$43$$, $data$$162$$) : $cpu$$904$$.reg8[$modrm_byte$$157$$ << 2 & 12 | $modrm_byte$$157$$ >> 2 & 1] = $data$$162$$;
};
$table0F_16$$[153] = $table0F_32$$[153] = function $$table0F_32$$$153$($cpu$$905$$) {
  var $modrm_byte$$158$$ = $cpu$$905$$.read_imm8();
  if (192 > $modrm_byte$$158$$) {
    var $addr$$44$$ = $cpu$$905$$.modrm_resolve($modrm_byte$$158$$)
  }
  var $data$$163$$ = !!$cpu$$905$$.test_s() ^ 1;
  192 > $modrm_byte$$158$$ ? $cpu$$905$$.safe_write8($addr$$44$$, $data$$163$$) : $cpu$$905$$.reg8[$modrm_byte$$158$$ << 2 & 12 | $modrm_byte$$158$$ >> 2 & 1] = $data$$163$$;
};
$table0F_16$$[154] = $table0F_32$$[154] = function $$table0F_32$$$154$($cpu$$906$$) {
  var $modrm_byte$$159$$ = $cpu$$906$$.read_imm8();
  if (192 > $modrm_byte$$159$$) {
    var $addr$$45$$ = $cpu$$906$$.modrm_resolve($modrm_byte$$159$$)
  }
  var $data$$164$$ = !$cpu$$906$$.test_p() ^ 1;
  192 > $modrm_byte$$159$$ ? $cpu$$906$$.safe_write8($addr$$45$$, $data$$164$$) : $cpu$$906$$.reg8[$modrm_byte$$159$$ << 2 & 12 | $modrm_byte$$159$$ >> 2 & 1] = $data$$164$$;
};
$table0F_16$$[155] = $table0F_32$$[155] = function $$table0F_32$$$155$($cpu$$907$$) {
  var $modrm_byte$$160$$ = $cpu$$907$$.read_imm8();
  if (192 > $modrm_byte$$160$$) {
    var $addr$$46$$ = $cpu$$907$$.modrm_resolve($modrm_byte$$160$$)
  }
  var $data$$165$$ = !!$cpu$$907$$.test_p() ^ 1;
  192 > $modrm_byte$$160$$ ? $cpu$$907$$.safe_write8($addr$$46$$, $data$$165$$) : $cpu$$907$$.reg8[$modrm_byte$$160$$ << 2 & 12 | $modrm_byte$$160$$ >> 2 & 1] = $data$$165$$;
};
$table0F_16$$[156] = $table0F_32$$[156] = function $$table0F_32$$$156$($cpu$$908$$) {
  var $modrm_byte$$161$$ = $cpu$$908$$.read_imm8();
  if (192 > $modrm_byte$$161$$) {
    var $addr$$47$$ = $cpu$$908$$.modrm_resolve($modrm_byte$$161$$)
  }
  var $data$$166$$ = !$cpu$$908$$.test_l() ^ 1;
  192 > $modrm_byte$$161$$ ? $cpu$$908$$.safe_write8($addr$$47$$, $data$$166$$) : $cpu$$908$$.reg8[$modrm_byte$$161$$ << 2 & 12 | $modrm_byte$$161$$ >> 2 & 1] = $data$$166$$;
};
$table0F_16$$[157] = $table0F_32$$[157] = function $$table0F_32$$$157$($cpu$$909$$) {
  var $modrm_byte$$162$$ = $cpu$$909$$.read_imm8();
  if (192 > $modrm_byte$$162$$) {
    var $addr$$48$$ = $cpu$$909$$.modrm_resolve($modrm_byte$$162$$)
  }
  var $data$$167$$ = !!$cpu$$909$$.test_l() ^ 1;
  192 > $modrm_byte$$162$$ ? $cpu$$909$$.safe_write8($addr$$48$$, $data$$167$$) : $cpu$$909$$.reg8[$modrm_byte$$162$$ << 2 & 12 | $modrm_byte$$162$$ >> 2 & 1] = $data$$167$$;
};
$table0F_16$$[158] = $table0F_32$$[158] = function $$table0F_32$$$158$($cpu$$910$$) {
  var $modrm_byte$$163$$ = $cpu$$910$$.read_imm8();
  if (192 > $modrm_byte$$163$$) {
    var $addr$$49$$ = $cpu$$910$$.modrm_resolve($modrm_byte$$163$$)
  }
  var $data$$168$$ = !$cpu$$910$$.test_le() ^ 1;
  192 > $modrm_byte$$163$$ ? $cpu$$910$$.safe_write8($addr$$49$$, $data$$168$$) : $cpu$$910$$.reg8[$modrm_byte$$163$$ << 2 & 12 | $modrm_byte$$163$$ >> 2 & 1] = $data$$168$$;
};
$table0F_16$$[159] = $table0F_32$$[159] = function $$table0F_32$$$159$($cpu$$911$$) {
  var $modrm_byte$$164$$ = $cpu$$911$$.read_imm8();
  if (192 > $modrm_byte$$164$$) {
    var $addr$$50$$ = $cpu$$911$$.modrm_resolve($modrm_byte$$164$$)
  }
  var $data$$169$$ = !!$cpu$$911$$.test_le() ^ 1;
  192 > $modrm_byte$$164$$ ? $cpu$$911$$.safe_write8($addr$$50$$, $data$$169$$) : $cpu$$911$$.reg8[$modrm_byte$$164$$ << 2 & 12 | $modrm_byte$$164$$ >> 2 & 1] = $data$$169$$;
};
$table0F_16$$[160] = function $$table0F_16$$$160$($cpu$$912$$) {
  $cpu$$912$$.push16($cpu$$912$$.sreg[4]);
};
$table0F_32$$[160] = function $$table0F_32$$$160$($cpu$$913$$) {
  $cpu$$913$$.push32($cpu$$913$$.sreg[4]);
};
$table0F_16$$[161] = function $$table0F_16$$$161$($cpu$$914$$) {
  $cpu$$914$$.switch_seg(4, $cpu$$914$$.safe_read16($cpu$$914$$.get_stack_pointer(0)));
  $cpu$$914$$.stack_reg[$cpu$$914$$.reg_vsp] += 2;
};
$table0F_32$$[161] = function $$table0F_32$$$161$($cpu$$915$$) {
  $cpu$$915$$.switch_seg(4, $cpu$$915$$.safe_read16($cpu$$915$$.get_stack_pointer(0)));
  $cpu$$915$$.stack_reg[$cpu$$915$$.reg_vsp] += 4;
};
$table0F_16$$[162] = $table0F_32$$[162] = function $$table0F_32$$$162$($cpu$$916$$) {
  $cpu$$916$$.cpuid();
};
$table0F_16$$[163] = function $$table0F_16$$$163$($cpu$$917$$) {
  var $modrm_byte$$165$$ = $cpu$$917$$.read_imm8();
  192 > $modrm_byte$$165$$ ? $cpu$$917$$.bt_mem($cpu$$917$$.modrm_resolve($modrm_byte$$165$$), $cpu$$917$$.reg16s[$modrm_byte$$165$$ >> 2 & 14]) : $cpu$$917$$.bt_reg($cpu$$917$$.reg16[$modrm_byte$$165$$ << 1 & 14], $cpu$$917$$.reg16[$modrm_byte$$165$$ >> 2 & 14] & 15);
};
$table0F_32$$[163] = function $$table0F_32$$$163$($cpu$$918$$) {
  var $modrm_byte$$166$$ = $cpu$$918$$.read_imm8();
  192 > $modrm_byte$$166$$ ? $cpu$$918$$.bt_mem($cpu$$918$$.modrm_resolve($modrm_byte$$166$$), $cpu$$918$$.reg32s[$modrm_byte$$166$$ >> 3 & 7]) : $cpu$$918$$.bt_reg($cpu$$918$$.reg32s[$modrm_byte$$166$$ & 7], $cpu$$918$$.reg32s[$modrm_byte$$166$$ >> 3 & 7] & 31);
};
$table0F_16$$[164] = function $$table0F_16$$$164$($cpu$$919$$) {
  var $modrm_byte$$167$$ = $cpu$$919$$.read_imm8(), $data$$170_result$$68_virt_addr$$35$$, $phys_addr$$34$$, $phys_addr_high$$31$$ = 0;
  192 > $modrm_byte$$167$$ ? ($data$$170_result$$68_virt_addr$$35$$ = $cpu$$919$$.modrm_resolve($modrm_byte$$167$$), $phys_addr$$34$$ = $cpu$$919$$.translate_address_write($data$$170_result$$68_virt_addr$$35$$), $cpu$$919$$.paging && 4095 === ($data$$170_result$$68_virt_addr$$35$$ & 4095) ? ($phys_addr_high$$31$$ = $cpu$$919$$.translate_address_write($data$$170_result$$68_virt_addr$$35$$ + 1), $data$$170_result$$68_virt_addr$$35$$ = $cpu$$919$$.virt_boundary_read16($phys_addr$$34$$, $phys_addr_high$$31$$)) : 
  $data$$170_result$$68_virt_addr$$35$$ = $cpu$$919$$.memory.read16($phys_addr$$34$$)) : $data$$170_result$$68_virt_addr$$35$$ = $cpu$$919$$.reg16[$modrm_byte$$167$$ << 1 & 14];
  $data$$170_result$$68_virt_addr$$35$$ = $cpu$$919$$.shld16($data$$170_result$$68_virt_addr$$35$$, $cpu$$919$$.reg16[$modrm_byte$$167$$ >> 2 & 14], $cpu$$919$$.read_imm8() & 31);
  192 > $modrm_byte$$167$$ ? $phys_addr_high$$31$$ ? $cpu$$919$$.virt_boundary_write16($phys_addr$$34$$, $phys_addr_high$$31$$, $data$$170_result$$68_virt_addr$$35$$) : $cpu$$919$$.memory.write16($phys_addr$$34$$, $data$$170_result$$68_virt_addr$$35$$) : $cpu$$919$$.reg16[$modrm_byte$$167$$ << 1 & 14] = $data$$170_result$$68_virt_addr$$35$$;
};
$table0F_32$$[164] = function $$table0F_32$$$164$($cpu$$920$$) {
  var $modrm_byte$$168$$ = $cpu$$920$$.read_imm8(), $data$$171_result$$69_virt_addr$$36$$, $phys_addr$$35$$, $phys_addr_high$$32$$ = 0;
  192 > $modrm_byte$$168$$ ? ($data$$171_result$$69_virt_addr$$36$$ = $cpu$$920$$.modrm_resolve($modrm_byte$$168$$), $phys_addr$$35$$ = $cpu$$920$$.translate_address_write($data$$171_result$$69_virt_addr$$36$$), $cpu$$920$$.paging && 4093 <= ($data$$171_result$$69_virt_addr$$36$$ & 4095) ? ($phys_addr_high$$32$$ = $cpu$$920$$.translate_address_write($data$$171_result$$69_virt_addr$$36$$ + 3), $data$$171_result$$69_virt_addr$$36$$ = $cpu$$920$$.virt_boundary_read32s($phys_addr$$35$$, $phys_addr_high$$32$$)) : 
  $data$$171_result$$69_virt_addr$$36$$ = $cpu$$920$$.memory.read32s($phys_addr$$35$$)) : $data$$171_result$$69_virt_addr$$36$$ = $cpu$$920$$.reg32s[$modrm_byte$$168$$ & 7];
  $data$$171_result$$69_virt_addr$$36$$ = $cpu$$920$$.shld32($data$$171_result$$69_virt_addr$$36$$, $cpu$$920$$.reg32s[$modrm_byte$$168$$ >> 3 & 7], $cpu$$920$$.read_imm8() & 31);
  192 > $modrm_byte$$168$$ ? $phys_addr_high$$32$$ ? $cpu$$920$$.virt_boundary_write32($phys_addr$$35$$, $phys_addr_high$$32$$, $data$$171_result$$69_virt_addr$$36$$) : $cpu$$920$$.memory.write32($phys_addr$$35$$, $data$$171_result$$69_virt_addr$$36$$) : $cpu$$920$$.reg32s[$modrm_byte$$168$$ & 7] = $data$$171_result$$69_virt_addr$$36$$;
};
$table0F_16$$[165] = function $$table0F_16$$$165$($cpu$$921$$) {
  var $modrm_byte$$169$$ = $cpu$$921$$.read_imm8(), $data$$172_result$$70_virt_addr$$37$$, $phys_addr$$36$$, $phys_addr_high$$33$$ = 0;
  192 > $modrm_byte$$169$$ ? ($data$$172_result$$70_virt_addr$$37$$ = $cpu$$921$$.modrm_resolve($modrm_byte$$169$$), $phys_addr$$36$$ = $cpu$$921$$.translate_address_write($data$$172_result$$70_virt_addr$$37$$), $cpu$$921$$.paging && 4095 === ($data$$172_result$$70_virt_addr$$37$$ & 4095) ? ($phys_addr_high$$33$$ = $cpu$$921$$.translate_address_write($data$$172_result$$70_virt_addr$$37$$ + 1), $data$$172_result$$70_virt_addr$$37$$ = $cpu$$921$$.virt_boundary_read16($phys_addr$$36$$, $phys_addr_high$$33$$)) : 
  $data$$172_result$$70_virt_addr$$37$$ = $cpu$$921$$.memory.read16($phys_addr$$36$$)) : $data$$172_result$$70_virt_addr$$37$$ = $cpu$$921$$.reg16[$modrm_byte$$169$$ << 1 & 14];
  $data$$172_result$$70_virt_addr$$37$$ = $cpu$$921$$.shld16($data$$172_result$$70_virt_addr$$37$$, $cpu$$921$$.reg16[$modrm_byte$$169$$ >> 2 & 14], $cpu$$921$$.reg8[4] & 31);
  192 > $modrm_byte$$169$$ ? $phys_addr_high$$33$$ ? $cpu$$921$$.virt_boundary_write16($phys_addr$$36$$, $phys_addr_high$$33$$, $data$$172_result$$70_virt_addr$$37$$) : $cpu$$921$$.memory.write16($phys_addr$$36$$, $data$$172_result$$70_virt_addr$$37$$) : $cpu$$921$$.reg16[$modrm_byte$$169$$ << 1 & 14] = $data$$172_result$$70_virt_addr$$37$$;
};
$table0F_32$$[165] = function $$table0F_32$$$165$($cpu$$922$$) {
  var $modrm_byte$$170$$ = $cpu$$922$$.read_imm8(), $data$$173_result$$71_virt_addr$$38$$, $phys_addr$$37$$, $phys_addr_high$$34$$ = 0;
  192 > $modrm_byte$$170$$ ? ($data$$173_result$$71_virt_addr$$38$$ = $cpu$$922$$.modrm_resolve($modrm_byte$$170$$), $phys_addr$$37$$ = $cpu$$922$$.translate_address_write($data$$173_result$$71_virt_addr$$38$$), $cpu$$922$$.paging && 4093 <= ($data$$173_result$$71_virt_addr$$38$$ & 4095) ? ($phys_addr_high$$34$$ = $cpu$$922$$.translate_address_write($data$$173_result$$71_virt_addr$$38$$ + 3), $data$$173_result$$71_virt_addr$$38$$ = $cpu$$922$$.virt_boundary_read32s($phys_addr$$37$$, $phys_addr_high$$34$$)) : 
  $data$$173_result$$71_virt_addr$$38$$ = $cpu$$922$$.memory.read32s($phys_addr$$37$$)) : $data$$173_result$$71_virt_addr$$38$$ = $cpu$$922$$.reg32s[$modrm_byte$$170$$ & 7];
  $data$$173_result$$71_virt_addr$$38$$ = $cpu$$922$$.shld32($data$$173_result$$71_virt_addr$$38$$, $cpu$$922$$.reg32s[$modrm_byte$$170$$ >> 3 & 7], $cpu$$922$$.reg8[4] & 31);
  192 > $modrm_byte$$170$$ ? $phys_addr_high$$34$$ ? $cpu$$922$$.virt_boundary_write32($phys_addr$$37$$, $phys_addr_high$$34$$, $data$$173_result$$71_virt_addr$$38$$) : $cpu$$922$$.memory.write32($phys_addr$$37$$, $data$$173_result$$71_virt_addr$$38$$) : $cpu$$922$$.reg32s[$modrm_byte$$170$$ & 7] = $data$$173_result$$71_virt_addr$$38$$;
};
$table0F_16$$[166] = $table0F_32$$[166] = function $$table0F_32$$$166$($cpu$$923$$) {
  $cpu$$923$$.trigger_ud();
};
$table0F_16$$[167] = $table0F_32$$[167] = function $$table0F_32$$$167$($cpu$$924$$) {
  $cpu$$924$$.trigger_ud();
};
$table0F_16$$[168] = function $$table0F_16$$$168$($cpu$$925$$) {
  $cpu$$925$$.push16($cpu$$925$$.sreg[5]);
};
$table0F_32$$[168] = function $$table0F_32$$$168$($cpu$$926$$) {
  $cpu$$926$$.push32($cpu$$926$$.sreg[5]);
};
$table0F_16$$[169] = function $$table0F_16$$$169$($cpu$$927$$) {
  $cpu$$927$$.switch_seg(5, $cpu$$927$$.safe_read16($cpu$$927$$.get_stack_pointer(0)));
  $cpu$$927$$.stack_reg[$cpu$$927$$.reg_vsp] += 2;
};
$table0F_32$$[169] = function $$table0F_32$$$169$($cpu$$928$$) {
  $cpu$$928$$.switch_seg(5, $cpu$$928$$.safe_read16($cpu$$928$$.get_stack_pointer(0)));
  $cpu$$928$$.stack_reg[$cpu$$928$$.reg_vsp] += 4;
};
$table0F_16$$[170] = $table0F_32$$[170] = function $$table0F_32$$$170$($cpu$$929$$) {
  $cpu$$929$$.trigger_ud();
};
$table0F_16$$[171] = function $$table0F_16$$$171$($cpu$$930$$) {
  var $modrm_byte$$171$$ = $cpu$$930$$.read_imm8();
  192 > $modrm_byte$$171$$ ? $cpu$$930$$.bts_mem($cpu$$930$$.modrm_resolve($modrm_byte$$171$$), $cpu$$930$$.reg16s[$modrm_byte$$171$$ >> 2 & 14]) : $cpu$$930$$.reg16[$modrm_byte$$171$$ << 1 & 14] = $cpu$$930$$.bts_reg($cpu$$930$$.reg16[$modrm_byte$$171$$ << 1 & 14], $cpu$$930$$.reg16s[$modrm_byte$$171$$ >> 2 & 14] & 15);
};
$table0F_32$$[171] = function $$table0F_32$$$171$($cpu$$931$$) {
  var $modrm_byte$$172$$ = $cpu$$931$$.read_imm8();
  192 > $modrm_byte$$172$$ ? $cpu$$931$$.bts_mem($cpu$$931$$.modrm_resolve($modrm_byte$$172$$), $cpu$$931$$.reg32s[$modrm_byte$$172$$ >> 3 & 7]) : $cpu$$931$$.reg32s[$modrm_byte$$172$$ & 7] = $cpu$$931$$.bts_reg($cpu$$931$$.reg32s[$modrm_byte$$172$$ & 7], $cpu$$931$$.reg32s[$modrm_byte$$172$$ >> 3 & 7] & 31);
};
$table0F_16$$[172] = function $$table0F_16$$$172$($cpu$$932$$) {
  var $modrm_byte$$173$$ = $cpu$$932$$.read_imm8(), $data$$174_result$$72_virt_addr$$39$$, $phys_addr$$38$$, $phys_addr_high$$35$$ = 0;
  192 > $modrm_byte$$173$$ ? ($data$$174_result$$72_virt_addr$$39$$ = $cpu$$932$$.modrm_resolve($modrm_byte$$173$$), $phys_addr$$38$$ = $cpu$$932$$.translate_address_write($data$$174_result$$72_virt_addr$$39$$), $cpu$$932$$.paging && 4095 === ($data$$174_result$$72_virt_addr$$39$$ & 4095) ? ($phys_addr_high$$35$$ = $cpu$$932$$.translate_address_write($data$$174_result$$72_virt_addr$$39$$ + 1), $data$$174_result$$72_virt_addr$$39$$ = $cpu$$932$$.virt_boundary_read16($phys_addr$$38$$, $phys_addr_high$$35$$)) : 
  $data$$174_result$$72_virt_addr$$39$$ = $cpu$$932$$.memory.read16($phys_addr$$38$$)) : $data$$174_result$$72_virt_addr$$39$$ = $cpu$$932$$.reg16[$modrm_byte$$173$$ << 1 & 14];
  $data$$174_result$$72_virt_addr$$39$$ = $cpu$$932$$.shrd16($data$$174_result$$72_virt_addr$$39$$, $cpu$$932$$.reg16[$modrm_byte$$173$$ >> 2 & 14], $cpu$$932$$.read_imm8() & 31);
  192 > $modrm_byte$$173$$ ? $phys_addr_high$$35$$ ? $cpu$$932$$.virt_boundary_write16($phys_addr$$38$$, $phys_addr_high$$35$$, $data$$174_result$$72_virt_addr$$39$$) : $cpu$$932$$.memory.write16($phys_addr$$38$$, $data$$174_result$$72_virt_addr$$39$$) : $cpu$$932$$.reg16[$modrm_byte$$173$$ << 1 & 14] = $data$$174_result$$72_virt_addr$$39$$;
};
$table0F_32$$[172] = function $$table0F_32$$$172$($cpu$$933$$) {
  var $modrm_byte$$174$$ = $cpu$$933$$.read_imm8(), $data$$175_result$$73_virt_addr$$40$$, $phys_addr$$39$$, $phys_addr_high$$36$$ = 0;
  192 > $modrm_byte$$174$$ ? ($data$$175_result$$73_virt_addr$$40$$ = $cpu$$933$$.modrm_resolve($modrm_byte$$174$$), $phys_addr$$39$$ = $cpu$$933$$.translate_address_write($data$$175_result$$73_virt_addr$$40$$), $cpu$$933$$.paging && 4093 <= ($data$$175_result$$73_virt_addr$$40$$ & 4095) ? ($phys_addr_high$$36$$ = $cpu$$933$$.translate_address_write($data$$175_result$$73_virt_addr$$40$$ + 3), $data$$175_result$$73_virt_addr$$40$$ = $cpu$$933$$.virt_boundary_read32s($phys_addr$$39$$, $phys_addr_high$$36$$)) : 
  $data$$175_result$$73_virt_addr$$40$$ = $cpu$$933$$.memory.read32s($phys_addr$$39$$)) : $data$$175_result$$73_virt_addr$$40$$ = $cpu$$933$$.reg32s[$modrm_byte$$174$$ & 7];
  $data$$175_result$$73_virt_addr$$40$$ = $cpu$$933$$.shrd32($data$$175_result$$73_virt_addr$$40$$, $cpu$$933$$.reg32s[$modrm_byte$$174$$ >> 3 & 7], $cpu$$933$$.read_imm8() & 31);
  192 > $modrm_byte$$174$$ ? $phys_addr_high$$36$$ ? $cpu$$933$$.virt_boundary_write32($phys_addr$$39$$, $phys_addr_high$$36$$, $data$$175_result$$73_virt_addr$$40$$) : $cpu$$933$$.memory.write32($phys_addr$$39$$, $data$$175_result$$73_virt_addr$$40$$) : $cpu$$933$$.reg32s[$modrm_byte$$174$$ & 7] = $data$$175_result$$73_virt_addr$$40$$;
};
$table0F_16$$[173] = function $$table0F_16$$$173$($cpu$$934$$) {
  var $modrm_byte$$175$$ = $cpu$$934$$.read_imm8(), $data$$176_result$$74_virt_addr$$41$$, $phys_addr$$40$$, $phys_addr_high$$37$$ = 0;
  192 > $modrm_byte$$175$$ ? ($data$$176_result$$74_virt_addr$$41$$ = $cpu$$934$$.modrm_resolve($modrm_byte$$175$$), $phys_addr$$40$$ = $cpu$$934$$.translate_address_write($data$$176_result$$74_virt_addr$$41$$), $cpu$$934$$.paging && 4095 === ($data$$176_result$$74_virt_addr$$41$$ & 4095) ? ($phys_addr_high$$37$$ = $cpu$$934$$.translate_address_write($data$$176_result$$74_virt_addr$$41$$ + 1), $data$$176_result$$74_virt_addr$$41$$ = $cpu$$934$$.virt_boundary_read16($phys_addr$$40$$, $phys_addr_high$$37$$)) : 
  $data$$176_result$$74_virt_addr$$41$$ = $cpu$$934$$.memory.read16($phys_addr$$40$$)) : $data$$176_result$$74_virt_addr$$41$$ = $cpu$$934$$.reg16[$modrm_byte$$175$$ << 1 & 14];
  $data$$176_result$$74_virt_addr$$41$$ = $cpu$$934$$.shrd16($data$$176_result$$74_virt_addr$$41$$, $cpu$$934$$.reg16[$modrm_byte$$175$$ >> 2 & 14], $cpu$$934$$.reg8[4] & 31);
  192 > $modrm_byte$$175$$ ? $phys_addr_high$$37$$ ? $cpu$$934$$.virt_boundary_write16($phys_addr$$40$$, $phys_addr_high$$37$$, $data$$176_result$$74_virt_addr$$41$$) : $cpu$$934$$.memory.write16($phys_addr$$40$$, $data$$176_result$$74_virt_addr$$41$$) : $cpu$$934$$.reg16[$modrm_byte$$175$$ << 1 & 14] = $data$$176_result$$74_virt_addr$$41$$;
};
$table0F_32$$[173] = function $$table0F_32$$$173$($cpu$$935$$) {
  var $modrm_byte$$176$$ = $cpu$$935$$.read_imm8(), $data$$177_result$$75_virt_addr$$42$$, $phys_addr$$41$$, $phys_addr_high$$38$$ = 0;
  192 > $modrm_byte$$176$$ ? ($data$$177_result$$75_virt_addr$$42$$ = $cpu$$935$$.modrm_resolve($modrm_byte$$176$$), $phys_addr$$41$$ = $cpu$$935$$.translate_address_write($data$$177_result$$75_virt_addr$$42$$), $cpu$$935$$.paging && 4093 <= ($data$$177_result$$75_virt_addr$$42$$ & 4095) ? ($phys_addr_high$$38$$ = $cpu$$935$$.translate_address_write($data$$177_result$$75_virt_addr$$42$$ + 3), $data$$177_result$$75_virt_addr$$42$$ = $cpu$$935$$.virt_boundary_read32s($phys_addr$$41$$, $phys_addr_high$$38$$)) : 
  $data$$177_result$$75_virt_addr$$42$$ = $cpu$$935$$.memory.read32s($phys_addr$$41$$)) : $data$$177_result$$75_virt_addr$$42$$ = $cpu$$935$$.reg32s[$modrm_byte$$176$$ & 7];
  $data$$177_result$$75_virt_addr$$42$$ = $cpu$$935$$.shrd32($data$$177_result$$75_virt_addr$$42$$, $cpu$$935$$.reg32s[$modrm_byte$$176$$ >> 3 & 7], $cpu$$935$$.reg8[4] & 31);
  192 > $modrm_byte$$176$$ ? $phys_addr_high$$38$$ ? $cpu$$935$$.virt_boundary_write32($phys_addr$$41$$, $phys_addr_high$$38$$, $data$$177_result$$75_virt_addr$$42$$) : $cpu$$935$$.memory.write32($phys_addr$$41$$, $data$$177_result$$75_virt_addr$$42$$) : $cpu$$935$$.reg32s[$modrm_byte$$176$$ & 7] = $data$$177_result$$75_virt_addr$$42$$;
};
$table0F_16$$[174] = $table0F_32$$[174] = function $$table0F_32$$$174$($cpu$$936$$) {
  $cpu$$936$$.trigger_ud();
};
$table0F_16$$[175] = function $$table0F_16$$$175$($cpu$$937$$) {
  var $modrm_byte$$177$$ = $cpu$$937$$.read_imm8(), $data$$178$$ = 192 > $modrm_byte$$177$$ ? $cpu$$937$$.safe_read16($cpu$$937$$.modrm_resolve($modrm_byte$$177$$)) << 16 >> 16 : $cpu$$937$$.reg16s[$modrm_byte$$177$$ << 1 & 14];
  $cpu$$937$$.reg16[$modrm_byte$$177$$ >> 2 & 14] = $cpu$$937$$.imul_reg16($cpu$$937$$.reg16s[$modrm_byte$$177$$ >> 2 & 14], $data$$178$$);
};
$table0F_32$$[175] = function $$table0F_32$$$175$($cpu$$938$$) {
  var $modrm_byte$$178$$ = $cpu$$938$$.read_imm8(), $data$$179$$ = 192 > $modrm_byte$$178$$ ? $cpu$$938$$.safe_read32s($cpu$$938$$.modrm_resolve($modrm_byte$$178$$)) : $cpu$$938$$.reg32s[$modrm_byte$$178$$ & 7];
  $cpu$$938$$.reg32s[$modrm_byte$$178$$ >> 3 & 7] = $cpu$$938$$.imul_reg32($cpu$$938$$.reg32s[$modrm_byte$$178$$ >> 3 & 7], $data$$179$$);
};
$table0F_16$$[176] = $table0F_32$$[176] = function $$table0F_32$$$176$($cpu$$939$$) {
  var $modrm_byte$$179$$ = $cpu$$939$$.read_imm8();
  if (192 > $modrm_byte$$179$$) {
    var $virt_addr$$43$$ = $cpu$$939$$.modrm_resolve($modrm_byte$$179$$);
    $cpu$$939$$.writable_or_pagefault($virt_addr$$43$$, 1);
    var $data$$180$$ = $cpu$$939$$.safe_read8($virt_addr$$43$$);
  } else {
    $data$$180$$ = $cpu$$939$$.reg8[$modrm_byte$$179$$ << 2 & 12 | $modrm_byte$$179$$ >> 2 & 1];
  }
  $cpu$$939$$.sub($data$$180$$, $cpu$$939$$.reg8[0], 7);
  $cpu$$939$$.getzf() ? 192 > $modrm_byte$$179$$ ? $cpu$$939$$.safe_write8($virt_addr$$43$$, $cpu$$939$$.reg8[$modrm_byte$$179$$ >> 1 & 12 | $modrm_byte$$179$$ >> 5 & 1]) : $cpu$$939$$.reg8[$modrm_byte$$179$$ << 2 & 12 | $modrm_byte$$179$$ >> 2 & 1] = $cpu$$939$$.reg8[$modrm_byte$$179$$ >> 1 & 12 | $modrm_byte$$179$$ >> 5 & 1] : $cpu$$939$$.reg8[0] = $data$$180$$;
};
$table0F_16$$[177] = function $$table0F_16$$$177$($cpu$$940$$) {
  var $modrm_byte$$180$$ = $cpu$$940$$.read_imm8();
  if (192 > $modrm_byte$$180$$) {
    var $virt_addr$$44$$ = $cpu$$940$$.modrm_resolve($modrm_byte$$180$$);
    $cpu$$940$$.writable_or_pagefault($virt_addr$$44$$, 2);
    var $data$$181$$ = $cpu$$940$$.safe_read16($virt_addr$$44$$);
  } else {
    $data$$181$$ = $cpu$$940$$.reg16[$modrm_byte$$180$$ << 1 & 14];
  }
  $cpu$$940$$.sub($data$$181$$, $cpu$$940$$.reg16[0], 15);
  $cpu$$940$$.getzf() ? 192 > $modrm_byte$$180$$ ? $cpu$$940$$.safe_write16($virt_addr$$44$$, $cpu$$940$$.reg16[$modrm_byte$$180$$ >> 2 & 14]) : $cpu$$940$$.reg16[$modrm_byte$$180$$ << 1 & 14] = $cpu$$940$$.reg16[$modrm_byte$$180$$ >> 2 & 14] : $cpu$$940$$.reg16[0] = $data$$181$$;
};
$table0F_32$$[177] = function $$table0F_32$$$177$($cpu$$941$$) {
  var $modrm_byte$$181$$ = $cpu$$941$$.read_imm8();
  if (192 > $modrm_byte$$181$$) {
    var $virt_addr$$45$$ = $cpu$$941$$.modrm_resolve($modrm_byte$$181$$);
    $cpu$$941$$.writable_or_pagefault($virt_addr$$45$$, 4);
    var $data$$182$$ = $cpu$$941$$.safe_read32s($virt_addr$$45$$);
  } else {
    $data$$182$$ = $cpu$$941$$.reg32s[$modrm_byte$$181$$ & 7];
  }
  $cpu$$941$$.sub($data$$182$$, $cpu$$941$$.reg32s[0], 31);
  $cpu$$941$$.getzf() ? 192 > $modrm_byte$$181$$ ? $cpu$$941$$.safe_write32($virt_addr$$45$$, $cpu$$941$$.reg32s[$modrm_byte$$181$$ >> 3 & 7]) : $cpu$$941$$.reg32s[$modrm_byte$$181$$ & 7] = $cpu$$941$$.reg32s[$modrm_byte$$181$$ >> 3 & 7] : $cpu$$941$$.reg32s[0] = $data$$182$$;
};
$table0F_16$$[178] = function $$table0F_16$$$178$($cpu$$942$$) {
  var $modrm_byte$$182$$ = $cpu$$942$$.read_imm8();
  192 <= $modrm_byte$$182$$ && $cpu$$942$$.trigger_ud();
  $cpu$$942$$.lss16(2, $cpu$$942$$.modrm_resolve($modrm_byte$$182$$), $modrm_byte$$182$$ >> 2 & 14);
};
$table0F_32$$[178] = function $$table0F_32$$$178$($cpu$$943$$) {
  var $modrm_byte$$183$$ = $cpu$$943$$.read_imm8();
  192 <= $modrm_byte$$183$$ && $cpu$$943$$.trigger_ud();
  $cpu$$943$$.lss32(2, $cpu$$943$$.modrm_resolve($modrm_byte$$183$$), $modrm_byte$$183$$ >> 3 & 7);
};
$table0F_16$$[179] = function $$table0F_16$$$179$($cpu$$944$$) {
  var $modrm_byte$$184$$ = $cpu$$944$$.read_imm8();
  192 > $modrm_byte$$184$$ ? $cpu$$944$$.btr_mem($cpu$$944$$.modrm_resolve($modrm_byte$$184$$), $cpu$$944$$.reg16s[$modrm_byte$$184$$ >> 2 & 14]) : $cpu$$944$$.reg16[$modrm_byte$$184$$ << 1 & 14] = $cpu$$944$$.btr_reg($cpu$$944$$.reg16[$modrm_byte$$184$$ << 1 & 14], $cpu$$944$$.reg16s[$modrm_byte$$184$$ >> 2 & 14] & 15);
};
$table0F_32$$[179] = function $$table0F_32$$$179$($cpu$$945$$) {
  var $modrm_byte$$185$$ = $cpu$$945$$.read_imm8();
  192 > $modrm_byte$$185$$ ? $cpu$$945$$.btr_mem($cpu$$945$$.modrm_resolve($modrm_byte$$185$$), $cpu$$945$$.reg32s[$modrm_byte$$185$$ >> 3 & 7]) : $cpu$$945$$.reg32s[$modrm_byte$$185$$ & 7] = $cpu$$945$$.btr_reg($cpu$$945$$.reg32s[$modrm_byte$$185$$ & 7], $cpu$$945$$.reg32s[$modrm_byte$$185$$ >> 3 & 7] & 31);
};
$table0F_16$$[180] = function $$table0F_16$$$180$($cpu$$946$$) {
  var $modrm_byte$$186$$ = $cpu$$946$$.read_imm8();
  192 <= $modrm_byte$$186$$ && $cpu$$946$$.trigger_ud();
  $cpu$$946$$.lss16(4, $cpu$$946$$.modrm_resolve($modrm_byte$$186$$), $modrm_byte$$186$$ >> 2 & 14);
};
$table0F_32$$[180] = function $$table0F_32$$$180$($cpu$$947$$) {
  var $modrm_byte$$187$$ = $cpu$$947$$.read_imm8();
  192 <= $modrm_byte$$187$$ && $cpu$$947$$.trigger_ud();
  $cpu$$947$$.lss32(4, $cpu$$947$$.modrm_resolve($modrm_byte$$187$$), $modrm_byte$$187$$ >> 3 & 7);
};
$table0F_16$$[181] = function $$table0F_16$$$181$($cpu$$948$$) {
  var $modrm_byte$$188$$ = $cpu$$948$$.read_imm8();
  192 <= $modrm_byte$$188$$ && $cpu$$948$$.trigger_ud();
  $cpu$$948$$.lss16(5, $cpu$$948$$.modrm_resolve($modrm_byte$$188$$), $modrm_byte$$188$$ >> 2 & 14);
};
$table0F_32$$[181] = function $$table0F_32$$$181$($cpu$$949$$) {
  var $modrm_byte$$189$$ = $cpu$$949$$.read_imm8();
  192 <= $modrm_byte$$189$$ && $cpu$$949$$.trigger_ud();
  $cpu$$949$$.lss32(5, $cpu$$949$$.modrm_resolve($modrm_byte$$189$$), $modrm_byte$$189$$ >> 3 & 7);
};
$table0F_16$$[182] = function $$table0F_16$$$182$($cpu$$950$$) {
  var $modrm_byte$$190$$ = $cpu$$950$$.read_imm8(), $data$$183$$ = 192 > $modrm_byte$$190$$ ? $cpu$$950$$.safe_read8($cpu$$950$$.modrm_resolve($modrm_byte$$190$$)) : $cpu$$950$$.reg8[$modrm_byte$$190$$ << 2 & 12 | $modrm_byte$$190$$ >> 2 & 1];
  $cpu$$950$$.reg16[$modrm_byte$$190$$ >> 2 & 14] = $data$$183$$;
};
$table0F_32$$[182] = function $$table0F_32$$$182$($cpu$$951$$) {
  var $modrm_byte$$191$$ = $cpu$$951$$.read_imm8(), $data$$184$$ = 192 > $modrm_byte$$191$$ ? $cpu$$951$$.safe_read8($cpu$$951$$.modrm_resolve($modrm_byte$$191$$)) : $cpu$$951$$.reg8[$modrm_byte$$191$$ << 2 & 12 | $modrm_byte$$191$$ >> 2 & 1];
  $cpu$$951$$.reg32s[$modrm_byte$$191$$ >> 3 & 7] = $data$$184$$;
};
$table0F_16$$[183] = $table0F_32$$[183] = function $$table0F_32$$$183$($cpu$$952$$) {
  var $modrm_byte$$192$$ = $cpu$$952$$.read_imm8(), $data$$185$$ = 192 > $modrm_byte$$192$$ ? $cpu$$952$$.safe_read16($cpu$$952$$.modrm_resolve($modrm_byte$$192$$)) : $cpu$$952$$.reg16[$modrm_byte$$192$$ << 1 & 14];
  $cpu$$952$$.reg32s[$modrm_byte$$192$$ >> 3 & 7] = $data$$185$$;
};
$table0F_16$$[184] = $table0F_32$$[184] = function $$table0F_32$$$184$($cpu$$953$$) {
  $cpu$$953$$.trigger_ud();
};
$table0F_16$$[185] = $table0F_32$$[185] = function $$table0F_32$$$185$($cpu$$954$$) {
  $cpu$$954$$.trigger_ud();
};
$table0F_16$$[186] = function $$table0F_16$$$186$($cpu$$955$$) {
  var $modrm_byte$$193$$ = $cpu$$955$$.read_imm8();
  switch($modrm_byte$$193$$ >> 3 & 7) {
    case 4:
      192 > $modrm_byte$$193$$ ? $cpu$$955$$.bt_mem($cpu$$955$$.modrm_resolve($modrm_byte$$193$$), $cpu$$955$$.read_imm8() & 15) : $cpu$$955$$.bt_reg($cpu$$955$$.reg16[$modrm_byte$$193$$ << 1 & 14], $cpu$$955$$.read_imm8() & 15);
      break;
    case 5:
      192 > $modrm_byte$$193$$ ? $cpu$$955$$.bts_mem($cpu$$955$$.modrm_resolve($modrm_byte$$193$$), $cpu$$955$$.read_imm8()) : $cpu$$955$$.reg16[$modrm_byte$$193$$ << 1 & 14] = $cpu$$955$$.bts_reg($cpu$$955$$.reg16[$modrm_byte$$193$$ << 1 & 14], $cpu$$955$$.read_imm8() & 15);
      break;
    case 6:
      192 > $modrm_byte$$193$$ ? $cpu$$955$$.btr_mem($cpu$$955$$.modrm_resolve($modrm_byte$$193$$), $cpu$$955$$.read_imm8()) : $cpu$$955$$.reg16[$modrm_byte$$193$$ << 1 & 14] = $cpu$$955$$.btr_reg($cpu$$955$$.reg16[$modrm_byte$$193$$ << 1 & 14], $cpu$$955$$.read_imm8() & 15);
      break;
    case 7:
      192 > $modrm_byte$$193$$ ? $cpu$$955$$.btc_mem($cpu$$955$$.modrm_resolve($modrm_byte$$193$$), $cpu$$955$$.read_imm8()) : $cpu$$955$$.reg16[$modrm_byte$$193$$ << 1 & 14] = $cpu$$955$$.btc_reg($cpu$$955$$.reg16[$modrm_byte$$193$$ << 1 & 14], $cpu$$955$$.read_imm8() & 15);
      break;
    default:
      $cpu$$955$$.trigger_ud();
  }
};
$table0F_32$$[186] = function $$table0F_32$$$186$($cpu$$956$$) {
  var $modrm_byte$$194$$ = $cpu$$956$$.read_imm8();
  switch($modrm_byte$$194$$ >> 3 & 7) {
    case 4:
      192 > $modrm_byte$$194$$ ? $cpu$$956$$.bt_mem($cpu$$956$$.modrm_resolve($modrm_byte$$194$$), $cpu$$956$$.read_imm8() & 31) : $cpu$$956$$.bt_reg($cpu$$956$$.reg32s[$modrm_byte$$194$$ & 7], $cpu$$956$$.read_imm8() & 31);
      break;
    case 5:
      192 > $modrm_byte$$194$$ ? $cpu$$956$$.bts_mem($cpu$$956$$.modrm_resolve($modrm_byte$$194$$), $cpu$$956$$.read_imm8()) : $cpu$$956$$.reg32s[$modrm_byte$$194$$ & 7] = $cpu$$956$$.bts_reg($cpu$$956$$.reg32s[$modrm_byte$$194$$ & 7], $cpu$$956$$.read_imm8() & 31);
      break;
    case 6:
      192 > $modrm_byte$$194$$ ? $cpu$$956$$.btr_mem($cpu$$956$$.modrm_resolve($modrm_byte$$194$$), $cpu$$956$$.read_imm8()) : $cpu$$956$$.reg32s[$modrm_byte$$194$$ & 7] = $cpu$$956$$.btr_reg($cpu$$956$$.reg32s[$modrm_byte$$194$$ & 7], $cpu$$956$$.read_imm8() & 31);
      break;
    case 7:
      192 > $modrm_byte$$194$$ ? $cpu$$956$$.btc_mem($cpu$$956$$.modrm_resolve($modrm_byte$$194$$), $cpu$$956$$.read_imm8()) : $cpu$$956$$.reg32s[$modrm_byte$$194$$ & 7] = $cpu$$956$$.btc_reg($cpu$$956$$.reg32s[$modrm_byte$$194$$ & 7], $cpu$$956$$.read_imm8() & 31);
      break;
    default:
      $cpu$$956$$.trigger_ud();
  }
};
$table0F_16$$[187] = function $$table0F_16$$$187$($cpu$$957$$) {
  var $modrm_byte$$195$$ = $cpu$$957$$.read_imm8();
  192 > $modrm_byte$$195$$ ? $cpu$$957$$.btc_mem($cpu$$957$$.modrm_resolve($modrm_byte$$195$$), $cpu$$957$$.reg16s[$modrm_byte$$195$$ >> 2 & 14]) : $cpu$$957$$.reg16[$modrm_byte$$195$$ << 1 & 14] = $cpu$$957$$.btc_reg($cpu$$957$$.reg16[$modrm_byte$$195$$ << 1 & 14], $cpu$$957$$.reg16s[$modrm_byte$$195$$ >> 2 & 14] & 15);
};
$table0F_32$$[187] = function $$table0F_32$$$187$($cpu$$958$$) {
  var $modrm_byte$$196$$ = $cpu$$958$$.read_imm8();
  192 > $modrm_byte$$196$$ ? $cpu$$958$$.btc_mem($cpu$$958$$.modrm_resolve($modrm_byte$$196$$), $cpu$$958$$.reg32s[$modrm_byte$$196$$ >> 3 & 7]) : $cpu$$958$$.reg32s[$modrm_byte$$196$$ & 7] = $cpu$$958$$.btc_reg($cpu$$958$$.reg32s[$modrm_byte$$196$$ & 7], $cpu$$958$$.reg32s[$modrm_byte$$196$$ >> 3 & 7] & 31);
};
$table0F_16$$[188] = function $$table0F_16$$$188$($cpu$$959$$) {
  var $modrm_byte$$197$$ = $cpu$$959$$.read_imm8(), $data$$186$$ = 192 > $modrm_byte$$197$$ ? $cpu$$959$$.safe_read16($cpu$$959$$.modrm_resolve($modrm_byte$$197$$)) : $cpu$$959$$.reg16[$modrm_byte$$197$$ << 1 & 14];
  $cpu$$959$$.reg16[$modrm_byte$$197$$ >> 2 & 14] = $cpu$$959$$.bsf16($cpu$$959$$.reg16[$modrm_byte$$197$$ >> 2 & 14], $data$$186$$);
};
$table0F_32$$[188] = function $$table0F_32$$$188$($cpu$$960$$) {
  var $modrm_byte$$198$$ = $cpu$$960$$.read_imm8(), $data$$187$$ = 192 > $modrm_byte$$198$$ ? $cpu$$960$$.safe_read32s($cpu$$960$$.modrm_resolve($modrm_byte$$198$$)) : $cpu$$960$$.reg32s[$modrm_byte$$198$$ & 7];
  $cpu$$960$$.reg32s[$modrm_byte$$198$$ >> 3 & 7] = $cpu$$960$$.bsf32($cpu$$960$$.reg32s[$modrm_byte$$198$$ >> 3 & 7], $data$$187$$);
};
$table0F_16$$[189] = function $$table0F_16$$$189$($cpu$$961$$) {
  var $modrm_byte$$199$$ = $cpu$$961$$.read_imm8(), $data$$188$$ = 192 > $modrm_byte$$199$$ ? $cpu$$961$$.safe_read16($cpu$$961$$.modrm_resolve($modrm_byte$$199$$)) : $cpu$$961$$.reg16[$modrm_byte$$199$$ << 1 & 14];
  $cpu$$961$$.reg16[$modrm_byte$$199$$ >> 2 & 14] = $cpu$$961$$.bsr16($cpu$$961$$.reg16[$modrm_byte$$199$$ >> 2 & 14], $data$$188$$);
};
$table0F_32$$[189] = function $$table0F_32$$$189$($cpu$$962$$) {
  var $modrm_byte$$200$$ = $cpu$$962$$.read_imm8(), $data$$189$$ = 192 > $modrm_byte$$200$$ ? $cpu$$962$$.safe_read32s($cpu$$962$$.modrm_resolve($modrm_byte$$200$$)) : $cpu$$962$$.reg32s[$modrm_byte$$200$$ & 7];
  $cpu$$962$$.reg32s[$modrm_byte$$200$$ >> 3 & 7] = $cpu$$962$$.bsr32($cpu$$962$$.reg32s[$modrm_byte$$200$$ >> 3 & 7], $data$$189$$);
};
$table0F_16$$[190] = function $$table0F_16$$$190$($cpu$$963$$) {
  var $modrm_byte$$201$$ = $cpu$$963$$.read_imm8(), $data$$190$$ = 192 > $modrm_byte$$201$$ ? $cpu$$963$$.safe_read8($cpu$$963$$.modrm_resolve($modrm_byte$$201$$)) << 24 >> 24 : $cpu$$963$$.reg8s[$modrm_byte$$201$$ << 2 & 12 | $modrm_byte$$201$$ >> 2 & 1];
  $cpu$$963$$.reg16[$modrm_byte$$201$$ >> 2 & 14] = $data$$190$$;
};
$table0F_32$$[190] = function $$table0F_32$$$190$($cpu$$964$$) {
  var $modrm_byte$$202$$ = $cpu$$964$$.read_imm8(), $data$$191$$ = 192 > $modrm_byte$$202$$ ? $cpu$$964$$.safe_read8($cpu$$964$$.modrm_resolve($modrm_byte$$202$$)) << 24 >> 24 : $cpu$$964$$.reg8s[$modrm_byte$$202$$ << 2 & 12 | $modrm_byte$$202$$ >> 2 & 1];
  $cpu$$964$$.reg32s[$modrm_byte$$202$$ >> 3 & 7] = $data$$191$$;
};
$table0F_16$$[191] = $table0F_32$$[191] = function $$table0F_32$$$191$($cpu$$965$$) {
  var $modrm_byte$$203$$ = $cpu$$965$$.read_imm8(), $data$$192$$ = 192 > $modrm_byte$$203$$ ? $cpu$$965$$.safe_read16($cpu$$965$$.modrm_resolve($modrm_byte$$203$$)) << 16 >> 16 : $cpu$$965$$.reg16s[$modrm_byte$$203$$ << 1 & 14];
  $cpu$$965$$.reg32s[$modrm_byte$$203$$ >> 3 & 7] = $data$$192$$;
};
$table0F_16$$[192] = $table0F_32$$[192] = function $$table0F_32$$$192$($cpu$$966$$) {
  var $modrm_byte$$204$$ = $cpu$$966$$.read_imm8(), $data$$193_result$$76$$, $addr$$51$$;
  192 > $modrm_byte$$204$$ ? ($addr$$51$$ = $cpu$$966$$.translate_address_write($cpu$$966$$.modrm_resolve($modrm_byte$$204$$)), $data$$193_result$$76$$ = $cpu$$966$$.memory.read8($addr$$51$$)) : $data$$193_result$$76$$ = $cpu$$966$$.reg8[$modrm_byte$$204$$ << 2 & 12 | $modrm_byte$$204$$ >> 2 & 1];
  $data$$193_result$$76$$ = $cpu$$966$$.xadd8($data$$193_result$$76$$, $modrm_byte$$204$$ >> 1 & 12 | $modrm_byte$$204$$ >> 5 & 1);
  192 > $modrm_byte$$204$$ ? $cpu$$966$$.memory.write8($addr$$51$$, $data$$193_result$$76$$) : $cpu$$966$$.reg8[$modrm_byte$$204$$ << 2 & 12 | $modrm_byte$$204$$ >> 2 & 1] = $data$$193_result$$76$$;
};
$table0F_16$$[193] = function $$table0F_16$$$193$($cpu$$967$$) {
  var $modrm_byte$$205$$ = $cpu$$967$$.read_imm8(), $data$$194_result$$77_virt_addr$$46$$, $phys_addr$$42$$, $phys_addr_high$$39$$ = 0;
  192 > $modrm_byte$$205$$ ? ($data$$194_result$$77_virt_addr$$46$$ = $cpu$$967$$.modrm_resolve($modrm_byte$$205$$), $phys_addr$$42$$ = $cpu$$967$$.translate_address_write($data$$194_result$$77_virt_addr$$46$$), $cpu$$967$$.paging && 4095 === ($data$$194_result$$77_virt_addr$$46$$ & 4095) ? ($phys_addr_high$$39$$ = $cpu$$967$$.translate_address_write($data$$194_result$$77_virt_addr$$46$$ + 1), $data$$194_result$$77_virt_addr$$46$$ = $cpu$$967$$.virt_boundary_read16($phys_addr$$42$$, $phys_addr_high$$39$$)) : 
  $data$$194_result$$77_virt_addr$$46$$ = $cpu$$967$$.memory.read16($phys_addr$$42$$)) : $data$$194_result$$77_virt_addr$$46$$ = $cpu$$967$$.reg16[$modrm_byte$$205$$ << 1 & 14];
  $data$$194_result$$77_virt_addr$$46$$ = $cpu$$967$$.xadd16($data$$194_result$$77_virt_addr$$46$$, $modrm_byte$$205$$ >> 2 & 14);
  192 > $modrm_byte$$205$$ ? $phys_addr_high$$39$$ ? $cpu$$967$$.virt_boundary_write16($phys_addr$$42$$, $phys_addr_high$$39$$, $data$$194_result$$77_virt_addr$$46$$) : $cpu$$967$$.memory.write16($phys_addr$$42$$, $data$$194_result$$77_virt_addr$$46$$) : $cpu$$967$$.reg16[$modrm_byte$$205$$ << 1 & 14] = $data$$194_result$$77_virt_addr$$46$$;
};
$table0F_32$$[193] = function $$table0F_32$$$193$($cpu$$968$$) {
  var $modrm_byte$$206$$ = $cpu$$968$$.read_imm8(), $data$$195_result$$78_virt_addr$$47$$, $phys_addr$$43$$, $phys_addr_high$$40$$ = 0;
  192 > $modrm_byte$$206$$ ? ($data$$195_result$$78_virt_addr$$47$$ = $cpu$$968$$.modrm_resolve($modrm_byte$$206$$), $phys_addr$$43$$ = $cpu$$968$$.translate_address_write($data$$195_result$$78_virt_addr$$47$$), $cpu$$968$$.paging && 4093 <= ($data$$195_result$$78_virt_addr$$47$$ & 4095) ? ($phys_addr_high$$40$$ = $cpu$$968$$.translate_address_write($data$$195_result$$78_virt_addr$$47$$ + 3), $data$$195_result$$78_virt_addr$$47$$ = $cpu$$968$$.virt_boundary_read32s($phys_addr$$43$$, $phys_addr_high$$40$$)) : 
  $data$$195_result$$78_virt_addr$$47$$ = $cpu$$968$$.memory.read32s($phys_addr$$43$$)) : $data$$195_result$$78_virt_addr$$47$$ = $cpu$$968$$.reg32s[$modrm_byte$$206$$ & 7];
  $data$$195_result$$78_virt_addr$$47$$ = $cpu$$968$$.xadd32($data$$195_result$$78_virt_addr$$47$$, $modrm_byte$$206$$ >> 3 & 7);
  192 > $modrm_byte$$206$$ ? $phys_addr_high$$40$$ ? $cpu$$968$$.virt_boundary_write32($phys_addr$$43$$, $phys_addr_high$$40$$, $data$$195_result$$78_virt_addr$$47$$) : $cpu$$968$$.memory.write32($phys_addr$$43$$, $data$$195_result$$78_virt_addr$$47$$) : $cpu$$968$$.reg32s[$modrm_byte$$206$$ & 7] = $data$$195_result$$78_virt_addr$$47$$;
};
$table0F_16$$[194] = $table0F_32$$[194] = function $$table0F_32$$$194$($cpu$$969$$) {
  $cpu$$969$$.trigger_ud();
};
$table0F_16$$[195] = $table0F_32$$[195] = function $$table0F_32$$$195$($cpu$$970$$) {
  $cpu$$970$$.trigger_ud();
};
$table0F_16$$[196] = $table0F_32$$[196] = function $$table0F_32$$$196$($cpu$$971$$) {
  $cpu$$971$$.trigger_ud();
};
$table0F_16$$[197] = $table0F_32$$[197] = function $$table0F_32$$$197$($cpu$$972$$) {
  $cpu$$972$$.trigger_ud();
};
$table0F_16$$[198] = $table0F_32$$[198] = function $$table0F_32$$$198$($cpu$$973$$) {
  $cpu$$973$$.trigger_ud();
};
$table0F_16$$[199] = $table0F_32$$[199] = function $$table0F_32$$$199$($cpu$$974$$) {
  var $addr$$52_modrm_byte$$207$$ = $cpu$$974$$.read_imm8();
  192 <= $addr$$52_modrm_byte$$207$$ && $cpu$$974$$.trigger_ud();
  $addr$$52_modrm_byte$$207$$ = $cpu$$974$$.modrm_resolve($addr$$52_modrm_byte$$207$$);
  $cpu$$974$$.writable_or_pagefault($addr$$52_modrm_byte$$207$$, 8);
  var $m64_low$$ = $cpu$$974$$.safe_read32s($addr$$52_modrm_byte$$207$$), $m64_high$$ = $cpu$$974$$.safe_read32s($addr$$52_modrm_byte$$207$$ + 4);
  $cpu$$974$$.reg32s[0] === $m64_low$$ && $cpu$$974$$.reg32s[2] === $m64_high$$ ? ($cpu$$974$$.flags |= 64, $cpu$$974$$.safe_write32($addr$$52_modrm_byte$$207$$, $cpu$$974$$.reg32s[3]), $cpu$$974$$.safe_write32($addr$$52_modrm_byte$$207$$ + 4, $cpu$$974$$.reg32s[1])) : ($cpu$$974$$.flags &= -65, $cpu$$974$$.reg32s[0] = $m64_low$$, $cpu$$974$$.reg32s[2] = $m64_high$$);
  $cpu$$974$$.flags_changed &= -65;
};
$table0F_16$$[200] = $table0F_32$$[200] = function $$table0F_32$$$200$($cpu$$975$$) {
  $cpu$$975$$.bswap(0);
};
$table0F_16$$[201] = $table0F_32$$[201] = function $$table0F_32$$$201$($cpu$$976$$) {
  $cpu$$976$$.bswap(1);
};
$table0F_16$$[202] = $table0F_32$$[202] = function $$table0F_32$$$202$($cpu$$977$$) {
  $cpu$$977$$.bswap(2);
};
$table0F_16$$[203] = $table0F_32$$[203] = function $$table0F_32$$$203$($cpu$$978$$) {
  $cpu$$978$$.bswap(3);
};
$table0F_16$$[204] = $table0F_32$$[204] = function $$table0F_32$$$204$($cpu$$979$$) {
  $cpu$$979$$.bswap(4);
};
$table0F_16$$[205] = $table0F_32$$[205] = function $$table0F_32$$$205$($cpu$$980$$) {
  $cpu$$980$$.bswap(5);
};
$table0F_16$$[206] = $table0F_32$$[206] = function $$table0F_32$$$206$($cpu$$981$$) {
  $cpu$$981$$.bswap(6);
};
$table0F_16$$[207] = $table0F_32$$[207] = function $$table0F_32$$$207$($cpu$$982$$) {
  $cpu$$982$$.bswap(7);
};
$table0F_16$$[208] = $table0F_32$$[208] = function $$table0F_32$$$208$($cpu$$983$$) {
  $cpu$$983$$.trigger_ud();
};
$table0F_16$$[209] = $table0F_32$$[209] = function $$table0F_32$$$209$($cpu$$984$$) {
  $cpu$$984$$.trigger_ud();
};
$table0F_16$$[210] = $table0F_32$$[210] = function $$table0F_32$$$210$($cpu$$985$$) {
  $cpu$$985$$.trigger_ud();
};
$table0F_16$$[211] = $table0F_32$$[211] = function $$table0F_32$$$211$($cpu$$986$$) {
  $cpu$$986$$.trigger_ud();
};
$table0F_16$$[212] = $table0F_32$$[212] = function $$table0F_32$$$212$($cpu$$987$$) {
  $cpu$$987$$.trigger_ud();
};
$table0F_16$$[213] = $table0F_32$$[213] = function $$table0F_32$$$213$($cpu$$988$$) {
  $cpu$$988$$.trigger_ud();
};
$table0F_16$$[214] = $table0F_32$$[214] = function $$table0F_32$$$214$($cpu$$989$$) {
  $cpu$$989$$.trigger_ud();
};
$table0F_16$$[215] = $table0F_32$$[215] = function $$table0F_32$$$215$($cpu$$990$$) {
  $cpu$$990$$.trigger_ud();
};
$table0F_16$$[216] = $table0F_32$$[216] = function $$table0F_32$$$216$($cpu$$991$$) {
  $cpu$$991$$.trigger_ud();
};
$table0F_16$$[217] = $table0F_32$$[217] = function $$table0F_32$$$217$($cpu$$992$$) {
  $cpu$$992$$.trigger_ud();
};
$table0F_16$$[218] = $table0F_32$$[218] = function $$table0F_32$$$218$($cpu$$993$$) {
  $cpu$$993$$.trigger_ud();
};
$table0F_16$$[219] = $table0F_32$$[219] = function $$table0F_32$$$219$($cpu$$994$$) {
  $cpu$$994$$.trigger_ud();
};
$table0F_16$$[220] = $table0F_32$$[220] = function $$table0F_32$$$220$($cpu$$995$$) {
  $cpu$$995$$.trigger_ud();
};
$table0F_16$$[221] = $table0F_32$$[221] = function $$table0F_32$$$221$($cpu$$996$$) {
  $cpu$$996$$.trigger_ud();
};
$table0F_16$$[222] = $table0F_32$$[222] = function $$table0F_32$$$222$($cpu$$997$$) {
  $cpu$$997$$.trigger_ud();
};
$table0F_16$$[223] = $table0F_32$$[223] = function $$table0F_32$$$223$($cpu$$998$$) {
  $cpu$$998$$.trigger_ud();
};
$table0F_16$$[224] = $table0F_32$$[224] = function $$table0F_32$$$224$($cpu$$999$$) {
  $cpu$$999$$.trigger_ud();
};
$table0F_16$$[225] = $table0F_32$$[225] = function $$table0F_32$$$225$($cpu$$1000$$) {
  $cpu$$1000$$.trigger_ud();
};
$table0F_16$$[226] = $table0F_32$$[226] = function $$table0F_32$$$226$($cpu$$1001$$) {
  $cpu$$1001$$.trigger_ud();
};
$table0F_16$$[227] = $table0F_32$$[227] = function $$table0F_32$$$227$($cpu$$1002$$) {
  $cpu$$1002$$.trigger_ud();
};
$table0F_16$$[228] = $table0F_32$$[228] = function $$table0F_32$$$228$($cpu$$1003$$) {
  $cpu$$1003$$.trigger_ud();
};
$table0F_16$$[229] = $table0F_32$$[229] = function $$table0F_32$$$229$($cpu$$1004$$) {
  $cpu$$1004$$.trigger_ud();
};
$table0F_16$$[230] = $table0F_32$$[230] = function $$table0F_32$$$230$($cpu$$1005$$) {
  $cpu$$1005$$.trigger_ud();
};
$table0F_16$$[231] = $table0F_32$$[231] = function $$table0F_32$$$231$($cpu$$1006$$) {
  $cpu$$1006$$.trigger_ud();
};
$table0F_16$$[232] = $table0F_32$$[232] = function $$table0F_32$$$232$($cpu$$1007$$) {
  $cpu$$1007$$.trigger_ud();
};
$table0F_16$$[233] = $table0F_32$$[233] = function $$table0F_32$$$233$($cpu$$1008$$) {
  $cpu$$1008$$.trigger_ud();
};
$table0F_16$$[234] = $table0F_32$$[234] = function $$table0F_32$$$234$($cpu$$1009$$) {
  $cpu$$1009$$.trigger_ud();
};
$table0F_16$$[235] = $table0F_32$$[235] = function $$table0F_32$$$235$($cpu$$1010$$) {
  $cpu$$1010$$.trigger_ud();
};
$table0F_16$$[236] = $table0F_32$$[236] = function $$table0F_32$$$236$($cpu$$1011$$) {
  $cpu$$1011$$.trigger_ud();
};
$table0F_16$$[237] = $table0F_32$$[237] = function $$table0F_32$$$237$($cpu$$1012$$) {
  $cpu$$1012$$.trigger_ud();
};
$table0F_16$$[238] = $table0F_32$$[238] = function $$table0F_32$$$238$($cpu$$1013$$) {
  $cpu$$1013$$.trigger_ud();
};
$table0F_16$$[239] = $table0F_32$$[239] = function $$table0F_32$$$239$($cpu$$1014$$) {
  $cpu$$1014$$.trigger_ud();
};
$table0F_16$$[240] = $table0F_32$$[240] = function $$table0F_32$$$240$($cpu$$1015$$) {
  $cpu$$1015$$.trigger_ud();
};
$table0F_16$$[241] = $table0F_32$$[241] = function $$table0F_32$$$241$($cpu$$1016$$) {
  $cpu$$1016$$.trigger_ud();
};
$table0F_16$$[242] = $table0F_32$$[242] = function $$table0F_32$$$242$($cpu$$1017$$) {
  $cpu$$1017$$.trigger_ud();
};
$table0F_16$$[243] = $table0F_32$$[243] = function $$table0F_32$$$243$($cpu$$1018$$) {
  $cpu$$1018$$.trigger_ud();
};
$table0F_16$$[244] = $table0F_32$$[244] = function $$table0F_32$$$244$($cpu$$1019$$) {
  $cpu$$1019$$.trigger_ud();
};
$table0F_16$$[245] = $table0F_32$$[245] = function $$table0F_32$$$245$($cpu$$1020$$) {
  $cpu$$1020$$.trigger_ud();
};
$table0F_16$$[246] = $table0F_32$$[246] = function $$table0F_32$$$246$($cpu$$1021$$) {
  $cpu$$1021$$.trigger_ud();
};
$table0F_16$$[247] = $table0F_32$$[247] = function $$table0F_32$$$247$($cpu$$1022$$) {
  $cpu$$1022$$.trigger_ud();
};
$table0F_16$$[248] = $table0F_32$$[248] = function $$table0F_32$$$248$($cpu$$1023$$) {
  $cpu$$1023$$.trigger_ud();
};
$table0F_16$$[249] = $table0F_32$$[249] = function $$table0F_32$$$249$($cpu$$1024$$) {
  $cpu$$1024$$.trigger_ud();
};
$table0F_16$$[250] = $table0F_32$$[250] = function $$table0F_32$$$250$($cpu$$1025$$) {
  $cpu$$1025$$.trigger_ud();
};
$table0F_16$$[251] = $table0F_32$$[251] = function $$table0F_32$$$251$($cpu$$1026$$) {
  $cpu$$1026$$.trigger_ud();
};
$table0F_16$$[252] = $table0F_32$$[252] = function $$table0F_32$$$252$($cpu$$1027$$) {
  $cpu$$1027$$.trigger_ud();
};
$table0F_16$$[253] = $table0F_32$$[253] = function $$table0F_32$$$253$($cpu$$1028$$) {
  $cpu$$1028$$.trigger_ud();
};
$table0F_16$$[254] = $table0F_32$$[254] = function $$table0F_32$$$254$($cpu$$1029$$) {
  $cpu$$1029$$.trigger_ud();
};
$table0F_16$$[255] = $table0F_32$$[255] = function $$table0F_32$$$255$($cpu$$1030$$) {
  $cpu$$1030$$.trigger_ud();
};
"use strict";
$JSCompiler_prototypeAlias$$ = $v86$$.prototype;
$JSCompiler_prototypeAlias$$.jmp_rel16 = function $$JSCompiler_prototypeAlias$$$jmp_rel16$($rel16$$) {
  var $current_cs$$ = this.get_seg(1);
  this.instruction_pointer -= $current_cs$$;
  this.instruction_pointer = this.instruction_pointer + $rel16$$ & 65535;
  this.instruction_pointer = this.instruction_pointer + $current_cs$$ | 0;
  this.last_instr_jump = !0;
};
$JSCompiler_prototypeAlias$$.jmpcc16 = function $$JSCompiler_prototypeAlias$$$jmpcc16$($condition$$1$$) {
  $condition$$1$$ ? this.jmp_rel16(this.read_imm16()) : this.instruction_pointer = this.instruction_pointer + 2 | 0;
  this.last_instr_jump = !0;
};
$JSCompiler_prototypeAlias$$.jmpcc32 = function $$JSCompiler_prototypeAlias$$$jmpcc32$($condition$$2_imm32s$$2$$) {
  $condition$$2_imm32s$$2$$ ? ($condition$$2_imm32s$$2$$ = this.read_imm32s(), this.instruction_pointer = this.instruction_pointer + $condition$$2_imm32s$$2$$ | 0) : this.instruction_pointer = this.instruction_pointer + 4 | 0;
  this.last_instr_jump = !0;
};
$JSCompiler_prototypeAlias$$.loopne = function $$JSCompiler_prototypeAlias$$$loopne$() {
  if (--this.regv[this.reg_vcx] && !this.getzf()) {
    var $imm8s$$ = this.read_imm8s();
    this.instruction_pointer = this.instruction_pointer + $imm8s$$ | 0;
  } else {
    this.instruction_pointer++;
  }
  this.last_instr_jump = !0;
};
$JSCompiler_prototypeAlias$$.loope = function $$JSCompiler_prototypeAlias$$$loope$() {
  if (--this.regv[this.reg_vcx] && this.getzf()) {
    var $imm8s$$1$$ = this.read_imm8s();
    this.instruction_pointer = this.instruction_pointer + $imm8s$$1$$ | 0;
  } else {
    this.instruction_pointer++;
  }
  this.last_instr_jump = !0;
};
$JSCompiler_prototypeAlias$$.loop = function $$JSCompiler_prototypeAlias$$$loop$() {
  if (--this.regv[this.reg_vcx]) {
    var $imm8s$$2$$ = this.read_imm8s();
    this.instruction_pointer = this.instruction_pointer + $imm8s$$2$$ | 0;
  } else {
    this.instruction_pointer++;
  }
  this.last_instr_jump = !0;
};
$JSCompiler_prototypeAlias$$.jcxz = function $$JSCompiler_prototypeAlias$$$jcxz$() {
  var $imm8s$$3$$ = this.read_imm8s();
  0 === this.regv[this.reg_vcx] && (this.instruction_pointer = this.instruction_pointer + $imm8s$$3$$ | 0);
  this.last_instr_jump = !0;
};
$JSCompiler_prototypeAlias$$.getcf = function $$JSCompiler_prototypeAlias$$$getcf$() {
  return this.flags_changed & 1 ? (this.last_op1 ^ (this.last_op1 ^ this.last_op2) & (this.last_op2 ^ this.last_add_result)) >>> this.last_op_size & 1 : this.flags & 1;
};
$JSCompiler_prototypeAlias$$.getpf = function $$JSCompiler_prototypeAlias$$$getpf$() {
  return this.flags_changed & 4 ? 154020 >> ((this.last_result ^ this.last_result >> 4) & 15) & 4 : this.flags & 4;
};
$JSCompiler_prototypeAlias$$.getaf = function $$JSCompiler_prototypeAlias$$$getaf$() {
  return this.flags_changed & 16 ? (this.last_op1 ^ this.last_op2 ^ this.last_add_result) & 16 : this.flags & 16;
};
$JSCompiler_prototypeAlias$$.getzf = function $$JSCompiler_prototypeAlias$$$getzf$() {
  return this.flags_changed & 64 ? (~this.last_result & this.last_result - 1) >>> this.last_op_size & 1 : this.flags & 64;
};
$JSCompiler_prototypeAlias$$.getsf = function $$JSCompiler_prototypeAlias$$$getsf$() {
  return this.flags_changed & 128 ? this.last_result >>> this.last_op_size & 1 : this.flags & 128;
};
$JSCompiler_prototypeAlias$$.getof = function $$JSCompiler_prototypeAlias$$$getof$() {
  return this.flags_changed & 2048 ? ((this.last_op1 ^ this.last_add_result) & (this.last_op2 ^ this.last_add_result)) >>> this.last_op_size & 1 : this.flags & 2048;
};
$JSCompiler_prototypeAlias$$.test_o = $v86$$.prototype.getof;
$JSCompiler_prototypeAlias$$.test_b = $v86$$.prototype.getcf;
$JSCompiler_prototypeAlias$$.test_z = $v86$$.prototype.getzf;
$JSCompiler_prototypeAlias$$.test_s = $v86$$.prototype.getsf;
$JSCompiler_prototypeAlias$$.test_p = $v86$$.prototype.getpf;
$JSCompiler_prototypeAlias$$.test_be = function $$JSCompiler_prototypeAlias$$$test_be$() {
  return this.getcf() || this.getzf();
};
$JSCompiler_prototypeAlias$$.test_l = function $$JSCompiler_prototypeAlias$$$test_l$() {
  return!this.getsf() !== !this.getof();
};
$JSCompiler_prototypeAlias$$.test_le = function $$JSCompiler_prototypeAlias$$$test_le$() {
  return this.getzf() || !this.getsf() !== !this.getof();
};
$JSCompiler_prototypeAlias$$.push16 = function $$JSCompiler_prototypeAlias$$$push16$($imm16$$4$$) {
  var $sp$$2$$ = this.get_stack_pointer(-2);
  this.safe_write16($sp$$2$$, $imm16$$4$$);
  this.stack_reg[this.reg_vsp] -= 2;
};
$JSCompiler_prototypeAlias$$.push32 = function $$JSCompiler_prototypeAlias$$$push32$($imm32$$) {
  var $sp$$3$$ = this.get_stack_pointer(-4);
  this.safe_write32($sp$$3$$, $imm32$$);
  this.stack_reg[this.reg_vsp] -= 4;
};
$JSCompiler_prototypeAlias$$.pop16 = function $$JSCompiler_prototypeAlias$$$pop16$() {
  var $result$$79_sp$$4$$ = this.get_seg(2) + this.stack_reg[this.reg_vsp] | 0, $result$$79_sp$$4$$ = this.safe_read16($result$$79_sp$$4$$);
  this.stack_reg[this.reg_vsp] += 2;
  return $result$$79_sp$$4$$;
};
$JSCompiler_prototypeAlias$$.pop32s = function $$JSCompiler_prototypeAlias$$$pop32s$() {
  var $result$$80_sp$$5$$ = this.get_seg(2) + this.stack_reg[this.reg_vsp] | 0, $result$$80_sp$$5$$ = this.safe_read32s($result$$80_sp$$5$$);
  this.stack_reg[this.reg_vsp] += 4;
  return $result$$80_sp$$5$$;
};
$JSCompiler_prototypeAlias$$.pusha16 = function $$JSCompiler_prototypeAlias$$$pusha16$() {
  var $temp$$1$$ = this.reg16[8];
  this.translate_address_write(this.get_seg(2) + $temp$$1$$ - 15 | 0);
  this.push16(this.reg16[0]);
  this.push16(this.reg16[2]);
  this.push16(this.reg16[4]);
  this.push16(this.reg16[6]);
  this.push16($temp$$1$$);
  this.push16(this.reg16[10]);
  this.push16(this.reg16[12]);
  this.push16(this.reg16[14]);
};
$JSCompiler_prototypeAlias$$.pusha32 = function $$JSCompiler_prototypeAlias$$$pusha32$() {
  var $temp$$2$$ = this.reg32s[4];
  this.translate_address_write(this.get_seg(2) + $temp$$2$$ - 31 | 0);
  this.push32(this.reg32s[0]);
  this.push32(this.reg32s[1]);
  this.push32(this.reg32s[2]);
  this.push32(this.reg32s[3]);
  this.push32($temp$$2$$);
  this.push32(this.reg32s[5]);
  this.push32(this.reg32s[6]);
  this.push32(this.reg32s[7]);
};
$JSCompiler_prototypeAlias$$.popa16 = function $$JSCompiler_prototypeAlias$$$popa16$() {
  this.translate_address_read(this.get_seg(2) + this.stack_reg[this.reg_vsp] + 15 | 0);
  this.reg16[14] = this.pop16();
  this.reg16[12] = this.pop16();
  this.reg16[10] = this.pop16();
  this.stack_reg[this.reg_vsp] += 2;
  this.reg16[6] = this.pop16();
  this.reg16[4] = this.pop16();
  this.reg16[2] = this.pop16();
  this.reg16[0] = this.pop16();
};
$JSCompiler_prototypeAlias$$.popa32 = function $$JSCompiler_prototypeAlias$$$popa32$() {
  this.translate_address_read(this.get_seg(2) + this.stack_reg[this.reg_vsp] + 31 | 0);
  this.reg32s[7] = this.pop32s();
  this.reg32s[6] = this.pop32s();
  this.reg32s[5] = this.pop32s();
  this.stack_reg[this.reg_vsp] += 4;
  this.reg32s[3] = this.pop32s();
  this.reg32s[2] = this.pop32s();
  this.reg32s[1] = this.pop32s();
  this.reg32s[0] = this.pop32s();
};
$JSCompiler_prototypeAlias$$.xchg8 = function $$JSCompiler_prototypeAlias$$$xchg8$($memory_data$$, $modrm_byte$$208$$) {
  var $mod$$263$$ = $modrm_byte$$208$$ >> 1 & 12 | $modrm_byte$$208$$ >> 5 & 1, $tmp$$3$$ = this.reg8[$mod$$263$$];
  this.reg8[$mod$$263$$] = $memory_data$$;
  return $tmp$$3$$;
};
$JSCompiler_prototypeAlias$$.xchg16 = function $$JSCompiler_prototypeAlias$$$xchg16$($memory_data$$1$$, $modrm_byte$$209$$) {
  var $mod$$264$$ = $modrm_byte$$209$$ >> 2 & 14, $tmp$$4$$ = this.reg16[$mod$$264$$];
  this.reg16[$mod$$264$$] = $memory_data$$1$$;
  return $tmp$$4$$;
};
$JSCompiler_prototypeAlias$$.xchg16r = function $$JSCompiler_prototypeAlias$$$xchg16r$($operand$$) {
  var $temp$$3$$ = this.reg16[0];
  this.reg16[0] = this.reg16[$operand$$];
  this.reg16[$operand$$] = $temp$$3$$;
};
$JSCompiler_prototypeAlias$$.xchg32 = function $$JSCompiler_prototypeAlias$$$xchg32$($memory_data$$2$$, $modrm_byte$$210$$) {
  var $mod$$265$$ = $modrm_byte$$210$$ >> 3 & 7, $tmp$$5$$ = this.reg32s[$mod$$265$$];
  this.reg32s[$mod$$265$$] = $memory_data$$2$$;
  return $tmp$$5$$;
};
$JSCompiler_prototypeAlias$$.xchg32r = function $$JSCompiler_prototypeAlias$$$xchg32r$($operand$$1$$) {
  var $temp$$4$$ = this.reg32s[0];
  this.reg32s[0] = this.reg32s[$operand$$1$$];
  this.reg32s[$operand$$1$$] = $temp$$4$$;
};
$JSCompiler_prototypeAlias$$.lss16 = function $$JSCompiler_prototypeAlias$$$lss16$($seg$$, $addr$$53_new_seg$$, $mod$$266$$) {
  var $new_reg$$ = this.safe_read16($addr$$53_new_seg$$);
  $addr$$53_new_seg$$ = this.safe_read16($addr$$53_new_seg$$ + 2 | 0);
  this.switch_seg($seg$$, $addr$$53_new_seg$$);
  this.reg16[$mod$$266$$] = $new_reg$$;
};
$JSCompiler_prototypeAlias$$.lss32 = function $$JSCompiler_prototypeAlias$$$lss32$($seg$$1$$, $addr$$54_new_seg$$1$$, $mod$$267$$) {
  var $new_reg$$1$$ = this.safe_read32s($addr$$54_new_seg$$1$$);
  $addr$$54_new_seg$$1$$ = this.safe_read16($addr$$54_new_seg$$1$$ + 4 | 0);
  this.switch_seg($seg$$1$$, $addr$$54_new_seg$$1$$);
  this.reg32s[$mod$$267$$] = $new_reg$$1$$;
};
$JSCompiler_prototypeAlias$$.enter16 = function $$JSCompiler_prototypeAlias$$$enter16$() {
  var $size$$36$$ = this.read_imm16(), $nesting_level$$ = this.read_imm8() & 31, $frame_temp$$, $tmp_ebp$$;
  this.push16(this.reg16[10]);
  $frame_temp$$ = this.reg16[8];
  if (0 < $nesting_level$$) {
    $tmp_ebp$$ = this.reg16[5];
    for (var $i$$14$$ = 1;$i$$14$$ < $nesting_level$$;$i$$14$$++) {
      $tmp_ebp$$ -= 2, this.push16(this.safe_read16(this.get_seg(2) + $tmp_ebp$$ | 0));
    }
    this.push16($frame_temp$$);
  }
  this.reg16[10] = $frame_temp$$;
  this.reg16[8] -= $size$$36$$;
};
$JSCompiler_prototypeAlias$$.enter32 = function $$JSCompiler_prototypeAlias$$$enter32$() {
  var $size$$37$$ = this.read_imm16(), $nesting_level$$1$$ = this.read_imm8() & 31, $frame_temp$$1$$, $tmp_ebp$$1$$;
  this.push32(this.reg32s[5]);
  $frame_temp$$1$$ = this.reg32s[4];
  if (0 < $nesting_level$$1$$) {
    $tmp_ebp$$1$$ = this.reg32s[5];
    for (var $i$$15$$ = 1;$i$$15$$ < $nesting_level$$1$$;$i$$15$$++) {
      $tmp_ebp$$1$$ -= 4, this.push32(this.safe_read32s(this.get_seg(2) + $tmp_ebp$$1$$ | 0));
    }
    this.push32($frame_temp$$1$$);
  }
  this.reg32s[5] = $frame_temp$$1$$;
  this.reg32s[4] -= $size$$37$$;
};
$JSCompiler_prototypeAlias$$.bswap = function $$JSCompiler_prototypeAlias$$$bswap$($reg$$3$$) {
  var $temp$$5$$ = this.reg32s[$reg$$3$$];
  this.reg32s[$reg$$3$$] = $temp$$5$$ >>> 24 | $temp$$5$$ << 24 | $temp$$5$$ >> 8 & 65280 | $temp$$5$$ << 8 & 16711680;
};
$JSCompiler_prototypeAlias$$.run = function $$JSCompiler_prototypeAlias$$$run$() {
  this.running || this.next_tick();
};
$JSCompiler_prototypeAlias$$.main_run = function $$JSCompiler_prototypeAlias$$$main_run$() {
  if (this.stopped) {
    this.stopped = this.running = !1;
  } else {
    this.running = !0;
    try {
      this.in_hlt ? this.hlt_loop() : this.do_run();
    } catch ($e$$13$$) {
      this.exception_cleanup($e$$13$$);
    }
  }
};
$JSCompiler_prototypeAlias$$.v86_prototype$stop = function $$JSCompiler_prototypeAlias$$$v86_prototype$stop$() {
  this.running && (this.stopped = !0);
};
$JSCompiler_prototypeAlias$$.exception_cleanup = function $$JSCompiler_prototypeAlias$$$exception_cleanup$($e$$14$$) {
  if (233495534 === $e$$14$$) {
    this.page_fault = !1, this.repeat_string_prefix = 0, this.segment_prefix = -1, this.address_size_32 = this.is_32, this.update_address_size(), this.operand_size_32 = this.is_32, this.update_operand_size(), this.next_tick();
  } else {
    throw this.running = !1, console.log($e$$14$$), console.log($e$$14$$.stack), $e$$14$$;
  }
};
$JSCompiler_prototypeAlias$$.reboot_internal = function $$JSCompiler_prototypeAlias$$$reboot_internal$() {
  this.init(this.current_settings);
  throw 233495534;
};
$JSCompiler_prototypeAlias$$.lazy_init = function $$JSCompiler_prototypeAlias$$$lazy_init$() {
  var $cpu$$1032$$ = this;
  "undefined" !== typeof setImmediate ? this.next_tick = function $this$next_tick$() {
    setImmediate(function() {
      $cpu$$1032$$.main_run();
    });
  } : "undefined" !== typeof window && "undefined" !== typeof postMessage ? (window.addEventListener("message", function($e$$15$$) {
    $e$$15$$.source === window && 43605 === $e$$15$$.data && $cpu$$1032$$.main_run();
  }, !1), this.next_tick = function $this$next_tick$() {
    window.postMessage(43605, "*");
  }) : this.next_tick = function $this$next_tick$() {
    setTimeout(this.main_run, 0);
  };
};
$JSCompiler_prototypeAlias$$.init = function $$JSCompiler_prototypeAlias$$$init$($settings$$) {
  this.first_init && (this.first_init = !1, this.lazy_init());
  this.current_settings = $settings$$;
  this.memory_size = $settings$$.memory_size || 67108864;
  this.memory = new $Memory$$(new ArrayBuffer(this.memory_size), this.memory_size);
  this.segment_is_null = new Uint8Array(8);
  this.segment_limits = new Uint32Array(8);
  this.segment_infos = new Uint32Array(8);
  this.segment_offsets = new Int32Array(8);
  this.tlb_data = new Int32Array(1048576);
  this.tlb_info = new Uint8Array(1048576);
  this.tlb_info_global = new Uint8Array(1048576);
  this.reg32 = new Uint32Array(8);
  this.reg32s = new Int32Array(this.reg32.buffer);
  this.reg16 = new Uint16Array(this.reg32.buffer);
  this.reg16s = new Int16Array(this.reg32.buffer);
  this.reg8 = new Uint8Array(this.reg32.buffer);
  this.reg8s = new Int8Array(this.reg32.buffer);
  this.sreg = new Uint16Array(8);
  this.dreg = new Int32Array(8);
  this.protected_mode = !1;
  this.gdtr_offset = this.gdtr_size = this.idtr_offset = this.idtr_size = 0;
  this.page_fault = !1;
  this.cr0 = 1610612752;
  this.cr4 = this.cr3 = this.cr2 = 0;
  this.dreg[6] = -61456;
  this.dreg[7] = 1024;
  this.cpl = 0;
  this.paging = !1;
  this.page_size_extensions = 0;
  this.address_size_32 = this.operand_size_32 = this.is_32 = !1;
  this.paging_changed();
  this.update_operand_size();
  this.update_address_size();
  this.stack_reg = this.reg16;
  this.reg_vsp = 8;
  this.reg_vbp = 10;
  this.previous_ip = this.timestamp_counter = 0;
  this.stopped = this.running = this.in_hlt = !1;
  this.segment_prefix = -1;
  this.repeat_string_prefix = 0;
  this.flags = 2;
  this.last_op_size = this.last_op2 = this.last_op1 = this.last_add_result = this.last_result = this.flags_changed = 0;
  var $devices_io$$ = new $IO$$(this.memory);
  this.io = this.devices.io = $devices_io$$;
  var $bios$$ = $settings$$.bios, $vga_bios$$ = $settings$$.vga_bios;
  if ($bios$$) {
    var $data$$196$$ = new Uint8Array($bios$$);
    this.memory.mem8.set($data$$196$$, 1048576 - $bios$$.byteLength);
    $vga_bios$$ && ($data$$196$$ = new Uint8Array($vga_bios$$), this.memory.mem8.set($data$$196$$, 786432));
    $devices_io$$.mmap_register(4293918720, 1048576, function($addr$$55$$) {
      return this.memory.mem8[$addr$$55$$ & 1048575];
    }.bind(this), function($addr$$56$$, $value$$40$$) {
      this.memory.mem8[$addr$$56$$ & 1048575] = $value$$40$$;
    }.bind(this));
    this.instruction_pointer = 1048560;
    this.switch_seg(2, 48);
    this.reg16[8] = 256;
  } else {
    $settings$$.linux ? (this.instruction_pointer = 65536, this.memory.write_blob(new Uint8Array($settings$$.linux.vmlinux), 1048576), this.memory.write_blob(new Uint8Array($settings$$.linux.linuxstart), this.instruction_pointer), $settings$$.linux.root && (this.memory.write_blob(new Uint8Array($settings$$.linux.root), 4194304), this.reg32s[3] = $settings$$.linux.root.byteLength), this.memory.write_string($settings$$.linux.cmdline), this.reg32s[0] = this.memory_size, this.reg32s[1] = 63488, this.switch_seg(1, 
    0), this.switch_seg(2, 0), this.switch_seg(3, 0), this.switch_seg(0, 0), this.switch_seg(5, 0), this.switch_seg(4, 0), this.protected_mode = this.operand_size_32 = this.address_size_32 = this.is_32 = !0, this.update_operand_size(), this.update_address_size(), this.regv = this.reg32s, this.reg_vsp = 4, this.reg_vbp = 5, this.cr0 = 1) : (this.switch_seg(2, 48), this.reg16[8] = 256, this.instruction_pointer = 0);
  }
  var $a20_byte$$ = 0;
  $devices_io$$.register_read(146, function() {
    return $a20_byte$$;
  });
  $devices_io$$.register_write(146, function($out_byte$$5$$) {
    $a20_byte$$ = $out_byte$$5$$;
  });
  this.devices = {};
  $settings$$.load_devices && ($devices_io$$ = this.devices, $devices_io$$.pic = new $PIC$$(this), $devices_io$$.pci = new $PCI$$(this), $devices_io$$.dma = new $DMA$$(this), $devices_io$$.acpi = new $ACPI$$, this.devices.vga = new $VGAScreen$$(this, $settings$$.screen_adapter, $settings$$.vga_memory_size || 8388608), this.devices.ps2 = new $PS2$$(this, $settings$$.keyboard_adapter, $settings$$.mouse_adapter), this.fpu = new $FPU$$(this), $devices_io$$.uart = $settings$$.serial_adapter ? new $UART$$(this, 
  $settings$$.serial_adapter) : new $UART$$(this, {put_line:function() {
  }, init:function() {
  }}), this.devices.fdc = new $FloppyController$$(this, $settings$$.fda), $settings$$.cdrom && (this.devices.cdrom = new $IDEDevice$$(this, $settings$$.cdrom, !0, 1)), $settings$$.hda && (this.devices.hda = new $IDEDevice$$(this, $settings$$.hda, !1, 0)), $devices_io$$.pit = new $PIT$$(this), $devices_io$$.rtc = new $RTC$$(this, $devices_io$$.fdc.type, $settings$$.boot_order || 531));
};
$JSCompiler_prototypeAlias$$.do_run = function $$JSCompiler_prototypeAlias$$$do_run$() {
  var $start$$9$$ = Date.now(), $k_now$$1$$ = $start$$9$$;
  for (this.devices.vga.timer($k_now$$1$$);33 > $k_now$$1$$ - $start$$9$$;) {
    this.devices.pit.timer($k_now$$1$$, !1);
    this.devices.rtc.timer($k_now$$1$$, !1);
    this.handle_irqs();
    for ($k_now$$1$$ = 11001;$k_now$$1$$--;) {
      this.cycle();
    }
    $k_now$$1$$ = Date.now();
  }
  this.next_tick();
};
"undefined" !== typeof window && (window.__no_inline1 = $v86$$.prototype.do_run, window.__no_inline2 = $v86$$.prototype.exception_cleanup, window.__no_inline3 = $v86$$.prototype.hlt_loop);
$JSCompiler_prototypeAlias$$ = $v86$$.prototype;
$JSCompiler_prototypeAlias$$.cycle = function $$JSCompiler_prototypeAlias$$$cycle$() {
  this.timestamp_counter++;
  this.previous_ip = this.instruction_pointer;
  var $opcode$$ = this.read_imm8();
  this.table[$opcode$$](this);
};
$JSCompiler_prototypeAlias$$.hlt_loop = function $$JSCompiler_prototypeAlias$$$hlt_loop$() {
  var $now$$2$$ = Date.now();
  this.devices.pit.timer($now$$2$$, !1);
  this.devices.rtc.timer($now$$2$$, !1);
  this.devices.vga.timer($now$$2$$);
  if (this.in_hlt) {
    var $me$$ = this;
    setTimeout(function() {
      $me$$.hlt_loop();
    }, 0);
  } else {
    this.next_tick();
  }
};
$JSCompiler_prototypeAlias$$.cr0_changed = function $$JSCompiler_prototypeAlias$$$cr0_changed$() {
  var $new_paging$$ = -2147483648 === (this.cr0 & -2147483648);
  this.fpu || (this.cr0 |= 4);
  this.cr0 |= 16;
  $new_paging$$ !== this.paging && (this.paging = $new_paging$$, this.full_clear_tlb());
};
$JSCompiler_prototypeAlias$$.paging_changed = function $$JSCompiler_prototypeAlias$$$paging_changed$() {
  this.last_virt_eip = -1;
};
$JSCompiler_prototypeAlias$$.cpl_changed = function $$JSCompiler_prototypeAlias$$$cpl_changed$() {
  this.last_virt_eip = -1;
};
$JSCompiler_prototypeAlias$$.read_imm8 = function $$JSCompiler_prototypeAlias$$$read_imm8$() {
  this.instruction_pointer & -4096 ^ this.last_virt_eip && (this.eip_phys = this.translate_address_read(this.instruction_pointer) ^ this.instruction_pointer, this.last_virt_eip = this.instruction_pointer & -4096);
  var $data8$$ = this.memory.mem8[this.eip_phys ^ this.instruction_pointer] | 0;
  this.instruction_pointer = this.instruction_pointer + 1 | 0;
  return $data8$$;
};
$JSCompiler_prototypeAlias$$.read_imm8s = function $$JSCompiler_prototypeAlias$$$read_imm8s$() {
  return this.read_imm8() << 24 >> 24;
};
$JSCompiler_prototypeAlias$$.read_imm16 = function $$JSCompiler_prototypeAlias$$$read_imm16$() {
  if (4094 < (this.instruction_pointer ^ this.last_virt_eip) >>> 0) {
    return this.read_imm8() | this.read_imm8() << 8;
  }
  var $data16$$ = this.memory.read16(this.eip_phys ^ this.instruction_pointer);
  this.instruction_pointer = this.instruction_pointer + 2 | 0;
  return $data16$$;
};
$JSCompiler_prototypeAlias$$.read_imm16s = function $$JSCompiler_prototypeAlias$$$read_imm16s$() {
  return this.read_imm16() << 16 >> 16;
};
$JSCompiler_prototypeAlias$$.read_imm32s = function $$JSCompiler_prototypeAlias$$$read_imm32s$() {
  if (4092 < (this.instruction_pointer ^ this.last_virt_eip) >>> 0) {
    return this.read_imm16() | this.read_imm16() << 16;
  }
  var $data32$$ = this.memory.read32s(this.eip_phys ^ this.instruction_pointer);
  this.instruction_pointer = this.instruction_pointer + 4 | 0;
  return $data32$$;
};
$JSCompiler_prototypeAlias$$.virt_boundary_read16 = function $$JSCompiler_prototypeAlias$$$virt_boundary_read16$($low$$1$$, $high$$1$$) {
  return this.memory.read8($low$$1$$) | this.memory.read8($high$$1$$) << 8;
};
$JSCompiler_prototypeAlias$$.virt_boundary_read32s = function $$JSCompiler_prototypeAlias$$$virt_boundary_read32s$($low$$2$$, $high$$2$$) {
  var $mid$$3$$;
  $mid$$3$$ = $low$$2$$ & 1 ? $low$$2$$ & 2 ? this.memory.read_aligned16($high$$2$$ - 2 >> 1) : this.memory.read_aligned16($low$$2$$ + 1 >> 1) : this.virt_boundary_read16($low$$2$$ + 1, $high$$2$$ - 1);
  return this.memory.read8($low$$2$$) | $mid$$3$$ << 8 | this.memory.read8($high$$2$$) << 24;
};
$JSCompiler_prototypeAlias$$.virt_boundary_write16 = function $$JSCompiler_prototypeAlias$$$virt_boundary_write16$($low$$3$$, $high$$3$$, $value$$41$$) {
  this.memory.write8($low$$3$$, $value$$41$$);
  this.memory.write8($high$$3$$, $value$$41$$ >> 8);
};
$JSCompiler_prototypeAlias$$.virt_boundary_write32 = function $$JSCompiler_prototypeAlias$$$virt_boundary_write32$($low$$4$$, $high$$4$$, $value$$42$$) {
  this.memory.write8($low$$4$$, $value$$42$$);
  this.memory.write8($high$$4$$, $value$$42$$ >> 24);
  $low$$4$$ & 1 ? $low$$4$$ & 2 ? (this.memory.write8($high$$4$$ - 2, $value$$42$$ >> 8), this.memory.write8($high$$4$$ - 1, $value$$42$$ >> 16)) : (this.memory.write8($low$$4$$ + 1, $value$$42$$ >> 8), this.memory.write8($low$$4$$ + 2, $value$$42$$ >> 16)) : (this.memory.write8($low$$4$$ + 1, $value$$42$$ >> 8), this.memory.write8($high$$4$$ - 1, $value$$42$$ >> 16));
};
$JSCompiler_prototypeAlias$$.safe_read8 = function $$JSCompiler_prototypeAlias$$$safe_read8$($addr$$57$$) {
  return this.memory.read8(this.translate_address_read($addr$$57$$));
};
$JSCompiler_prototypeAlias$$.safe_read16 = function $$JSCompiler_prototypeAlias$$$safe_read16$($addr$$58$$) {
  return this.paging && 4095 === ($addr$$58$$ & 4095) ? this.safe_read8($addr$$58$$) | this.safe_read8($addr$$58$$ + 1) << 8 : this.memory.read16(this.translate_address_read($addr$$58$$));
};
$JSCompiler_prototypeAlias$$.safe_read32s = function $$JSCompiler_prototypeAlias$$$safe_read32s$($addr$$59$$) {
  return this.paging && 4093 <= ($addr$$59$$ & 4095) ? this.safe_read16($addr$$59$$) | this.safe_read16($addr$$59$$ + 2) << 16 : this.memory.read32s(this.translate_address_read($addr$$59$$));
};
$JSCompiler_prototypeAlias$$.safe_write8 = function $$JSCompiler_prototypeAlias$$$safe_write8$($addr$$60$$, $value$$43$$) {
  this.memory.write8(this.translate_address_write($addr$$60$$), $value$$43$$);
};
$JSCompiler_prototypeAlias$$.safe_write16 = function $$JSCompiler_prototypeAlias$$$safe_write16$($addr$$61$$, $value$$44$$) {
  var $phys_low$$ = this.translate_address_write($addr$$61$$);
  4095 === ($addr$$61$$ & 4095) ? this.virt_boundary_write16($phys_low$$, this.translate_address_write($addr$$61$$ + 1), $value$$44$$) : this.memory.write16($phys_low$$, $value$$44$$);
};
$JSCompiler_prototypeAlias$$.safe_write32 = function $$JSCompiler_prototypeAlias$$$safe_write32$($addr$$62$$, $value$$45$$) {
  var $phys_low$$1$$ = this.translate_address_write($addr$$62$$);
  4093 <= ($addr$$62$$ & 4095) ? this.virt_boundary_write32($phys_low$$1$$, this.translate_address_write($addr$$62$$ + 3), $value$$45$$) : this.memory.write32($phys_low$$1$$, $value$$45$$);
};
$JSCompiler_prototypeAlias$$.read_moffs = function $$JSCompiler_prototypeAlias$$$read_moffs$() {
  return this.address_size_32 ? this.get_seg_prefix(3) + this.read_imm32s() | 0 : this.get_seg_prefix(3) + this.read_imm16() | 0;
};
$JSCompiler_prototypeAlias$$.get_eflags = function $$JSCompiler_prototypeAlias$$$get_eflags$() {
  return this.flags & -2262 | !!this.getcf() | !!this.getpf() << 2 | !!this.getaf() << 4 | !!this.getzf() << 6 | !!this.getsf() << 7 | !!this.getof() << 11;
};
$JSCompiler_prototypeAlias$$.load_eflags = function $$JSCompiler_prototypeAlias$$$load_eflags$() {
  this.flags = this.get_eflags();
  this.flags_changed = 0;
};
$JSCompiler_prototypeAlias$$.update_eflags = function $$JSCompiler_prototypeAlias$$$update_eflags$($new_flags$$) {
  var $mask$$5$$ = 1769472, $clear$$ = 2588629;
  this.flags & 131072 ? ($mask$$5$$ |= 12288, $clear$$ |= 1572864) : this.cpl && ($mask$$5$$ |= 12288, this.cpl > (this.flags >> 12 & 3) && ($mask$$5$$ |= 512));
  this.flags = ($new_flags$$ ^ (this.flags ^ $new_flags$$) & $mask$$5$$) & $clear$$ | 2;
  this.flags_changed = 0;
};
$JSCompiler_prototypeAlias$$.get_stack_pointer = function $$JSCompiler_prototypeAlias$$$get_stack_pointer$($mod$$268$$) {
  return this.get_seg(2) + this.stack_reg[this.reg_vsp] + $mod$$268$$ | 0;
};
$JSCompiler_prototypeAlias$$.get_real_eip = function $$JSCompiler_prototypeAlias$$$get_real_eip$() {
  return this.instruction_pointer - this.get_seg(1) | 0;
};
$JSCompiler_prototypeAlias$$.call_interrupt_vector = function $$JSCompiler_prototypeAlias$$$call_interrupt_vector$($interrupt_nr_is_trap$$, $info_is_software_int$$, $error_code$$) {
  this.in_hlt = !1;
  $info_is_software_int$$ || (this.previous_ip = this.instruction_pointer);
  if (this.protected_mode) {
    if (this.flags & 131072 && this.cr4 & 1) {
      throw this.debug.unimpl("VME");
    }
    this.flags & 131072 && $info_is_software_int$$ && 3 > (this.flags >> 12 & 3) && this.trigger_gp(0);
    if (($interrupt_nr_is_trap$$ << 3 | 7) > this.idtr_size) {
      throw this.debug.unimpl("#GP handler");
    }
    var $addr$$63_old_flags_type$$53$$ = this.idtr_offset + ($interrupt_nr_is_trap$$ << 3) | 0;
    this.paging && ($addr$$63_old_flags_type$$53$$ = this.translate_address_system_read($addr$$63_old_flags_type$$53$$));
    var $base$$3$$ = this.memory.read16($addr$$63_old_flags_type$$53$$) | this.memory.read16($addr$$63_old_flags_type$$53$$ + 6) << 16, $selector$$1$$ = this.memory.read16($addr$$63_old_flags_type$$53$$ + 2), $addr$$63_old_flags_type$$53$$ = this.memory.read8($addr$$63_old_flags_type$$53$$ + 5), $dpl$$2_new_esp$$ = $addr$$63_old_flags_type$$53$$ >> 5 & 3;
    if (0 === ($addr$$63_old_flags_type$$53$$ & 128)) {
      throw this.debug.unimpl("#NP handler");
    }
    $info_is_software_int$$ && $dpl$$2_new_esp$$ < this.cpl && this.trigger_gp($interrupt_nr_is_trap$$ << 3 | 2);
    $addr$$63_old_flags_type$$53$$ &= 31;
    if (14 === $addr$$63_old_flags_type$$53$$) {
      $interrupt_nr_is_trap$$ = !1;
    } else {
      if (15 === $addr$$63_old_flags_type$$53$$) {
        $interrupt_nr_is_trap$$ = !0;
      } else {
        if (5 === $addr$$63_old_flags_type$$53$$) {
          throw this.debug.unimpl("call int to task gate");
        }
        if (6 === $addr$$63_old_flags_type$$53$$) {
          throw this.debug.unimpl("16 bit interrupt gate");
        }
        if (7 === $addr$$63_old_flags_type$$53$$) {
          throw this.debug.unimpl("16 bit trap gate");
        }
        throw this.debug.unimpl("#GP handler");
      }
    }
    $info_is_software_int$$ = this.lookup_segment_selector($selector$$1$$);
    if ($info_is_software_int$$.is_null) {
      throw this.debug.unimpl("#GP handler");
    }
    if (!$info_is_software_int$$.is_executable || $info_is_software_int$$.dpl > this.cpl) {
      throw this.debug.unimpl("#GP handler");
    }
    if (!$info_is_software_int$$.is_present) {
      throw this.debug.unimpl("#NP handler");
    }
    this.load_eflags();
    $addr$$63_old_flags_type$$53$$ = this.flags;
    if (!$info_is_software_int$$.dc_bit && $info_is_software_int$$.dpl < this.cpl) {
      var $new_ss_tss_stack_addr$$ = ($info_is_software_int$$.dpl << 3) + 4;
      if ($new_ss_tss_stack_addr$$ + 5 > this.segment_limits[6]) {
        throw this.debug.unimpl("#TS handler");
      }
      $new_ss_tss_stack_addr$$ = $new_ss_tss_stack_addr$$ + this.segment_offsets[6] | 0;
      this.paging && ($new_ss_tss_stack_addr$$ = this.translate_address_system_read($new_ss_tss_stack_addr$$));
      var $dpl$$2_new_esp$$ = this.memory.read32s($new_ss_tss_stack_addr$$), $new_ss_tss_stack_addr$$ = this.memory.read16($new_ss_tss_stack_addr$$ + 4), $old_esp_ss_info$$ = this.lookup_segment_selector($new_ss_tss_stack_addr$$);
      if ($old_esp_ss_info$$.is_null) {
        throw this.debug.unimpl("#TS handler");
      }
      if ($old_esp_ss_info$$.rpl !== $info_is_software_int$$.dpl) {
        throw this.debug.unimpl("#TS handler");
      }
      if ($old_esp_ss_info$$.dpl !== $info_is_software_int$$.dpl || !$old_esp_ss_info$$.rw_bit) {
        throw this.debug.unimpl("#TS handler");
      }
      if (!$old_esp_ss_info$$.is_present) {
        throw this.debug.unimpl("#TS handler");
      }
      var $old_esp_ss_info$$ = this.reg32s[4], $old_ss$$ = this.sreg[2];
      this.cpl = $info_is_software_int$$.dpl;
      this.cpl_changed();
      this.is_32 !== $info_is_software_int$$.size && this.update_cs_size($info_is_software_int$$.size);
      this.flags &= -196609;
      this.reg32s[4] = $dpl$$2_new_esp$$;
      this.switch_seg(2, $new_ss_tss_stack_addr$$);
      $addr$$63_old_flags_type$$53$$ & 131072 && (this.push32(this.sreg[5]), this.push32(this.sreg[4]), this.push32(this.sreg[3]), this.push32(this.sreg[0]));
      this.push32($old_ss$$);
      this.push32($old_esp_ss_info$$);
    } else {
      ($info_is_software_int$$.dc_bit || $info_is_software_int$$.dpl === this.cpl) && this.flags & 131072 && this.trigger_gp($selector$$1$$ & -4);
    }
    this.push32($addr$$63_old_flags_type$$53$$);
    this.push32(this.sreg[1]);
    this.push32(this.get_real_eip());
    $addr$$63_old_flags_type$$53$$ & 131072 && (this.switch_seg(5, 0), this.switch_seg(4, 0), this.switch_seg(3, 0), this.switch_seg(0, 0));
    !1 !== $error_code$$ && this.push32($error_code$$);
    this.sreg[1] = $selector$$1$$;
    this.is_32 !== $info_is_software_int$$.size && this.update_cs_size($info_is_software_int$$.size);
    this.segment_limits[1] = $info_is_software_int$$.real_limit;
    this.segment_offsets[1] = $info_is_software_int$$.base;
    this.instruction_pointer = this.get_seg(1) + $base$$3$$ | 0;
    $interrupt_nr_is_trap$$ ? setTimeout(function() {
      this.handle_irqs();
    }.bind(this), 0) : this.flags &= -513;
  } else {
    this.load_eflags(), this.push16(this.flags), this.push16(this.sreg[1]), this.push16(this.get_real_eip()), this.flags &= -513, this.switch_seg(1, this.memory.read16(($interrupt_nr_is_trap$$ << 2) + 2)), this.instruction_pointer = this.get_seg(1) + this.memory.read16($interrupt_nr_is_trap$$ << 2) | 0;
  }
  this.last_instr_jump = !0;
};
$JSCompiler_prototypeAlias$$.iret16 = function $$JSCompiler_prototypeAlias$$$iret16$() {
  if (!this.protected_mode || this.flags & 131072 && 3 === (this.flags >> 12 & 3)) {
    var $ip$$6$$ = this.pop16();
    this.switch_seg(1, this.pop16());
    var $new_flags$$1$$ = this.pop16();
    this.instruction_pointer = $ip$$6$$ + this.get_seg(1) | 0;
    this.update_eflags($new_flags$$1$$);
    this.handle_irqs();
  } else {
    throw this.flags & 131072 && this.trigger_gp(0), this.debug.unimpl("16 bit iret in protected mode");
  }
  this.last_instr_jump = !0;
};
$JSCompiler_prototypeAlias$$.iret32 = function $$JSCompiler_prototypeAlias$$$iret32$() {
  if (!this.protected_mode || this.flags & 131072 && 3 === (this.flags >> 12 & 3)) {
    var $ip$$7_temp_esp$$ = this.pop32s();
    this.switch_seg(1, this.pop32s() & 65535);
    var $new_flags$$2$$ = this.pop32s();
    this.instruction_pointer = $ip$$7_temp_esp$$ + this.get_seg(1) | 0;
    this.update_eflags($new_flags$$2$$);
    this.handle_irqs();
  } else {
    this.flags & 131072 && this.trigger_gp(0);
    this.instruction_pointer = this.pop32s();
    this.sreg[1] = this.pop32s();
    $new_flags$$2$$ = this.pop32s();
    if ($new_flags$$2$$ & 131072) {
      if (0 === this.cpl) {
        this.update_eflags($new_flags$$2$$);
        this.flags |= 131072;
        this.switch_seg(1, this.sreg[1]);
        this.instruction_pointer = this.instruction_pointer + this.get_seg(1) | 0;
        var $ip$$7_temp_esp$$ = this.pop32s(), $temp_ss$$ = this.pop32s();
        this.switch_seg(0, this.pop32s() & 65535);
        this.switch_seg(3, this.pop32s() & 65535);
        this.switch_seg(4, this.pop32s() & 65535);
        this.switch_seg(5, this.pop32s() & 65535);
        this.reg32s[4] = $ip$$7_temp_esp$$;
        this.switch_seg(2, $temp_ss$$ & 65535);
        this.cpl = 3;
        this.update_cs_size(!1);
        return;
      }
      $new_flags$$2$$ &= -131073;
    }
    var $info$$1$$ = this.lookup_segment_selector(this.sreg[1]);
    if ($info$$1$$.is_null) {
      throw this.debug.unimpl("is null");
    }
    if (!$info$$1$$.is_present) {
      throw this.debug.unimpl("not present");
    }
    if (!$info$$1$$.is_executable) {
      throw this.debug.unimpl("not exec");
    }
    if ($info$$1$$.rpl < this.cpl) {
      throw this.debug.unimpl("rpl < cpl");
    }
    if ($info$$1$$.dc_bit && $info$$1$$.dpl > $info$$1$$.rpl) {
      throw this.debug.unimpl("conforming and dpl > rpl");
    }
    $info$$1$$.rpl > this.cpl ? ($ip$$7_temp_esp$$ = this.pop32s(), $temp_ss$$ = this.pop32s(), this.reg32s[4] = $ip$$7_temp_esp$$, this.update_eflags($new_flags$$2$$), this.cpl = $info$$1$$.rpl, this.switch_seg(2, $temp_ss$$ & 65535), this.cpl_changed()) : this.update_eflags($new_flags$$2$$);
    $info$$1$$.size !== this.is_32 && this.update_cs_size($info$$1$$.size);
    this.segment_limits[1] = $info$$1$$.real_limit;
    this.segment_offsets[1] = $info$$1$$.base;
    this.instruction_pointer = this.instruction_pointer + this.get_seg(1) | 0;
    this.handle_irqs();
    this.last_instr_jump = !0;
  }
};
$JSCompiler_prototypeAlias$$.hlt_op = function $$JSCompiler_prototypeAlias$$$hlt_op$() {
  this.cpl && this.trigger_gp(0);
  if (0 === (this.flags & 512)) {
    throw this.debug.show("cpu halted"), this.stopped = !0, "HALT";
  }
  this.in_hlt = !0;
  throw 233495534;
};
$JSCompiler_prototypeAlias$$.raise_exception = function $$JSCompiler_prototypeAlias$$$raise_exception$($interrupt_nr$$1$$) {
  this.call_interrupt_vector($interrupt_nr$$1$$, !1, !1);
  throw 233495534;
};
$JSCompiler_prototypeAlias$$.raise_exception_with_code = function $$JSCompiler_prototypeAlias$$$raise_exception_with_code$($interrupt_nr$$2$$, $error_code$$1$$) {
  this.call_interrupt_vector($interrupt_nr$$2$$, !1, $error_code$$1$$);
  throw 233495534;
};
$JSCompiler_prototypeAlias$$.trigger_de = function $$JSCompiler_prototypeAlias$$$trigger_de$() {
  this.instruction_pointer = this.previous_ip;
  this.raise_exception(0);
};
$JSCompiler_prototypeAlias$$.trigger_ud = function $$JSCompiler_prototypeAlias$$$trigger_ud$() {
  this.instruction_pointer = this.previous_ip;
  this.raise_exception(6);
};
$JSCompiler_prototypeAlias$$.trigger_nm = function $$JSCompiler_prototypeAlias$$$trigger_nm$() {
  this.instruction_pointer = this.previous_ip;
  this.raise_exception(7);
};
$JSCompiler_prototypeAlias$$.trigger_gp = function $$JSCompiler_prototypeAlias$$$trigger_gp$($code$$2$$) {
  this.instruction_pointer = this.previous_ip;
  this.raise_exception_with_code(13, $code$$2$$);
};
$JSCompiler_prototypeAlias$$.trigger_np = function $$JSCompiler_prototypeAlias$$$trigger_np$($code$$3$$) {
  this.instruction_pointer = this.previous_ip;
  this.raise_exception_with_code(11, $code$$3$$);
};
$JSCompiler_prototypeAlias$$.trigger_ss = function $$JSCompiler_prototypeAlias$$$trigger_ss$($code$$4$$) {
  this.instruction_pointer = this.previous_ip;
  this.raise_exception_with_code(12, $code$$4$$);
};
$JSCompiler_prototypeAlias$$.seg_prefix = function $$JSCompiler_prototypeAlias$$$seg_prefix$($seg$$2$$) {
  this.segment_prefix = $seg$$2$$;
  this.table[this.read_imm8()](this);
  this.segment_prefix = -1;
};
$JSCompiler_prototypeAlias$$.get_seg_prefix = function $$JSCompiler_prototypeAlias$$$get_seg_prefix$($default_segment$$) {
  return-1 === this.segment_prefix ? this.get_seg($default_segment$$) : 9 === this.segment_prefix ? 0 : this.get_seg(this.segment_prefix);
};
$JSCompiler_prototypeAlias$$.get_seg = function $$JSCompiler_prototypeAlias$$$get_seg$($segment$$) {
  return this.segment_offsets[$segment$$];
};
$JSCompiler_prototypeAlias$$.handle_irqs = function $$JSCompiler_prototypeAlias$$$handle_irqs$() {
  this.devices.pic && this.flags & 512 && !this.page_fault && this.devices.pic.check_irqs();
};
$JSCompiler_prototypeAlias$$.test_privileges_for_io = function $$JSCompiler_prototypeAlias$$$test_privileges_for_io$($port$$18$$, $size$$38$$) {
  if (this.protected_mode && (this.cpl > (this.flags >> 12 & 3) || this.flags & 131072)) {
    var $mask$$6_tsr_size$$ = this.segment_limits[6], $addr$$64_tsr_offset$$ = this.segment_offsets[6];
    if (103 <= $mask$$6_tsr_size$$) {
      var $iomap_base$$ = this.memory.read16(this.translate_address_system_read($addr$$64_tsr_offset$$ + 100 + 2));
      if ($mask$$6_tsr_size$$ >= $iomap_base$$ + ($port$$18$$ + $size$$38$$ - 1 >> 3) && ($mask$$6_tsr_size$$ = (1 << $size$$38$$) - 1 << ($port$$18$$ & 7), $addr$$64_tsr_offset$$ = this.translate_address_system_read($addr$$64_tsr_offset$$ + $iomap_base$$ + ($port$$18$$ >> 3)), !(($mask$$6_tsr_size$$ & 65280 ? this.memory.read16($addr$$64_tsr_offset$$) : this.memory.read8($addr$$64_tsr_offset$$)) & $mask$$6_tsr_size$$))) {
        return;
      }
    }
    this.trigger_gp(0);
  }
};
$JSCompiler_prototypeAlias$$.cpuid = function $$JSCompiler_prototypeAlias$$$cpuid$() {
  var $id$$1$$ = this.reg32s[0];
  0 === ($id$$1$$ & 2147483647) ? (this.reg32s[0] = 2, 0 === $id$$1$$ && (this.reg32s[3] = 1970169159, this.reg32s[2] = 1231384169, this.reg32s[1] = 1818588270)) : 1 === $id$$1$$ ? (this.reg32s[0] = 3939, this.reg32s[3] = 0, this.reg32s[1] = 0, this.reg32s[2] = void 0 !== this.fpu | 41274) : 2 === $id$$1$$ ? (this.reg32s[0] = 1717260289, this.reg32s[3] = 0, this.reg32s[1] = 0, this.reg32s[2] = 8024064) : -2138701824 === $id$$1$$ ? (this.reg32s[0] = 0, this.reg32s[3] = 0, this.reg32s[1] = 0, this.reg32s[2] = 
  0) : 1073741824 === ($id$$1$$ & -1073741824) && (this.reg32s[0] = 0, this.reg32s[3] = 0, this.reg32s[1] = 0, this.reg32s[2] = 0);
};
$JSCompiler_prototypeAlias$$.update_cs_size = function $$JSCompiler_prototypeAlias$$$update_cs_size$($new_size$$) {
  this.is_32 = this.operand_size_32 = this.address_size_32 = $new_size$$;
  this.update_operand_size();
  this.update_address_size();
};
$JSCompiler_prototypeAlias$$.update_operand_size = function $$JSCompiler_prototypeAlias$$$update_operand_size$() {
  this.operand_size_32 ? (this.table = this.table32, this.table0F = this.table0F_32) : (this.table = this.table16, this.table0F = this.table0F_16);
};
$JSCompiler_prototypeAlias$$.update_address_size = function $$JSCompiler_prototypeAlias$$$update_address_size$() {
  this.address_size_32 ? (this.regv = this.reg32s, this.reg_vcx = 1, this.reg_vsi = 6, this.reg_vdi = 7) : (this.regv = this.reg16, this.reg_vcx = 2, this.reg_vsi = 12, this.reg_vdi = 14);
};
$JSCompiler_prototypeAlias$$.lookup_segment_selector = function $$JSCompiler_prototypeAlias$$$lookup_segment_selector$($info$$2_selector$$2$$) {
  var $is_gdt_table_offset$$ = 0 === ($info$$2_selector$$2$$ & 4), $selector_offset$$ = $info$$2_selector$$2$$ & -8, $table_limit$$;
  $info$$2_selector$$2$$ = {rpl:$info$$2_selector$$2$$ & 3, from_gdt:$is_gdt_table_offset$$, is_null:!1, is_valid:!0, base:0, access:0, flags:0, limit:0, type:0, dpl:0, is_system:!1, is_present:!1, is_executable:!1, rw_bit:!1, dc_bit:!1, size:!1, granularity:!1, real_limit:!1, is_writable:!1, is_readable:!1, table_offset:0};
  $is_gdt_table_offset$$ ? ($is_gdt_table_offset$$ = this.gdtr_offset, $table_limit$$ = this.gdtr_size) : ($is_gdt_table_offset$$ = this.segment_offsets[7], $table_limit$$ = this.segment_limits[7]);
  if (0 === $selector_offset$$) {
    return $info$$2_selector$$2$$.is_null = !0, $info$$2_selector$$2$$;
  }
  if ($selector_offset$$ >> 3 > $table_limit$$) {
    return $info$$2_selector$$2$$.is_valid = !1, $info$$2_selector$$2$$;
  }
  $is_gdt_table_offset$$ = $is_gdt_table_offset$$ + $selector_offset$$ | 0;
  this.paging && ($is_gdt_table_offset$$ = this.translate_address_system_read($is_gdt_table_offset$$));
  $info$$2_selector$$2$$.table_offset = $is_gdt_table_offset$$;
  $info$$2_selector$$2$$.base = this.memory.read16($is_gdt_table_offset$$ + 2) | this.memory.read8($is_gdt_table_offset$$ + 4) << 16 | this.memory.read8($is_gdt_table_offset$$ + 7) << 24;
  $info$$2_selector$$2$$.access = this.memory.read8($is_gdt_table_offset$$ + 5);
  $info$$2_selector$$2$$.flags = this.memory.read8($is_gdt_table_offset$$ + 6) >> 4;
  $info$$2_selector$$2$$.limit = this.memory.read16($is_gdt_table_offset$$) | (this.memory.read8($is_gdt_table_offset$$ + 6) & 15) << 16;
  $info$$2_selector$$2$$.type = $info$$2_selector$$2$$.access & 15;
  $info$$2_selector$$2$$.dpl = $info$$2_selector$$2$$.access >> 5 & 3;
  $info$$2_selector$$2$$.is_system = 0 === ($info$$2_selector$$2$$.access & 16);
  $info$$2_selector$$2$$.is_present = 128 === ($info$$2_selector$$2$$.access & 128);
  $info$$2_selector$$2$$.is_executable = 8 === ($info$$2_selector$$2$$.access & 8);
  $info$$2_selector$$2$$.rw_bit = 2 === ($info$$2_selector$$2$$.access & 2);
  $info$$2_selector$$2$$.dc_bit = 4 === ($info$$2_selector$$2$$.access & 4);
  $info$$2_selector$$2$$.size = 4 === ($info$$2_selector$$2$$.flags & 4);
  $info$$2_selector$$2$$.granularity = 8 === ($info$$2_selector$$2$$.flags & 8);
  $info$$2_selector$$2$$.real_limit = $info$$2_selector$$2$$.gr_bit ? ($info$$2_selector$$2$$.limit << 12 | 4095) >>> 0 : $info$$2_selector$$2$$.limit;
  $info$$2_selector$$2$$.is_writable = $info$$2_selector$$2$$.rw_bit && !$info$$2_selector$$2$$.is_executable;
  $info$$2_selector$$2$$.is_readable = $info$$2_selector$$2$$.rw_bit || !$info$$2_selector$$2$$.is_executable;
  return $info$$2_selector$$2$$;
};
$JSCompiler_prototypeAlias$$.switch_seg = function $$JSCompiler_prototypeAlias$$$switch_seg$($reg$$4$$, $selector$$3$$) {
  1 === $reg$$4$$ && (this.protected_mode = 1 === (this.cr0 & 1));
  if (!this.protected_mode || this.flags & 131072) {
    this.sreg[$reg$$4$$] = $selector$$3$$, this.segment_is_null[$reg$$4$$] = 0, this.segment_limits[$reg$$4$$] = 1048575, this.segment_offsets[$reg$$4$$] = $selector$$3$$ << 4;
  } else {
    var $info$$3$$ = this.lookup_segment_selector($selector$$3$$);
    if (2 === $reg$$4$$) {
      if ($info$$3$$.is_null) {
        this.trigger_gp(0);
        return;
      }
      if (!$info$$3$$.is_valid || $info$$3$$.is_system || $info$$3$$.rpl !== this.cpl || !$info$$3$$.is_writable || $info$$3$$.dpl !== this.cpl) {
        this.trigger_gp($selector$$3$$ & -4);
        return;
      }
      if (!$info$$3$$.is_present) {
        this.trigger_ss($selector$$3$$ & -4);
        return;
      }
      $info$$3$$.size ? (this.stack_reg = this.reg32s, this.reg_vsp = 4, this.reg_vbp = 5) : (this.stack_reg = this.reg16, this.reg_vsp = 8, this.reg_vbp = 10);
    } else {
      if (1 === $reg$$4$$) {
        if (!$info$$3$$.is_executable) {
          throw this.debug.unimpl("#GP handler");
        }
        if ($info$$3$$.is_system) {
          throw this.debug.unimpl("load system segment descriptor, type = " + ($info$$3$$.access & 15));
        }
        if ($info$$3$$.rpl !== this.cpl) {
          throw this.debug.unimpl("privilege change");
        }
        if (!$info$$3$$.dc_bit && $info$$3$$.dpl < this.cpl) {
          throw this.debug.unimpl("inter privilege call");
        }
        if (!$info$$3$$.dc_bit && $info$$3$$.dpl !== this.cpl) {
          throw this.debug.unimpl("#GP handler");
        }
        $info$$3$$.size !== this.is_32 && this.update_cs_size($info$$3$$.size);
      } else {
        if ($info$$3$$.is_null) {
          this.sreg[$reg$$4$$] = $selector$$3$$;
          this.segment_is_null[$reg$$4$$] = 1;
          return;
        }
        if (!$info$$3$$.is_valid || $info$$3$$.is_system || !$info$$3$$.is_readable || (!$info$$3$$.is_executable || !$info$$3$$.dc_bit) && $info$$3$$.rpl > $info$$3$$.dpl && this.cpl > $info$$3$$.dpl) {
          this.trigger_gp($selector$$3$$ & -4);
          return;
        }
        if (!$info$$3$$.is_present) {
          this.trigger_np($selector$$3$$ & -4);
          return;
        }
      }
    }
    this.segment_is_null[$reg$$4$$] = 0;
    this.segment_limits[$reg$$4$$] = $info$$3$$.real_limit;
    this.segment_infos[$reg$$4$$] = 0;
    this.segment_offsets[$reg$$4$$] = $info$$3$$.base;
    this.sreg[$reg$$4$$] = $selector$$3$$;
  }
};
$JSCompiler_prototypeAlias$$.load_tr = function $$JSCompiler_prototypeAlias$$$load_tr$($selector$$4$$) {
  var $info$$4$$ = this.lookup_segment_selector($selector$$4$$);
  if (!$info$$4$$.from_gdt) {
    throw this.debug.unimpl("TR can only be loaded from GDT");
  }
  if ($info$$4$$.is_null) {
    throw this.debug.unimpl("#GP handler");
  }
  if (!$info$$4$$.is_present) {
    throw this.debug.unimpl("#GP handler");
  }
  if (!$info$$4$$.is_system) {
    throw this.debug.unimpl("#GP handler");
  }
  if (9 !== $info$$4$$.type) {
    throw this.debug.unimpl("#GP handler");
  }
  this.segment_offsets[6] = $info$$4$$.base;
  this.segment_limits[6] = $info$$4$$.limit;
  this.sreg[6] = $selector$$4$$;
  this.memory.write8($info$$4$$.table_offset + 5, this.memory.read8($info$$4$$.table_offset + 5) | 2);
};
$JSCompiler_prototypeAlias$$.load_ldt = function $$JSCompiler_prototypeAlias$$$load_ldt$($selector$$5$$) {
  var $info$$5$$ = this.lookup_segment_selector($selector$$5$$);
  if ($info$$5$$.is_null) {
    this.segment_offsets[7] = 0, this.segment_limits[7] = 0;
  } else {
    if (!$info$$5$$.from_gdt) {
      throw this.debug.unimpl("LDTR can only be loaded from GDT");
    }
    if (!$info$$5$$.is_present) {
      throw this.debug.unimpl("#GP handler");
    }
    if (!$info$$5$$.is_system) {
      throw this.debug.unimpl("#GP handler");
    }
    if (2 !== $info$$5$$.type) {
      throw this.debug.unimpl("#GP handler");
    }
    this.segment_offsets[7] = $info$$5$$.base;
    this.segment_limits[7] = $info$$5$$.limit;
    this.sreg[7] = $selector$$5$$;
  }
};
$JSCompiler_prototypeAlias$$.arpl = function $$JSCompiler_prototypeAlias$$$arpl$($seg$$3$$, $r16$$) {
  this.flags_changed &= -65;
  if (($seg$$3$$ & 3) < (this.reg16[$r16$$] & 3)) {
    return this.flags |= 64, $seg$$3$$ & -4 | this.reg16[$r16$$] & 3;
  }
  this.flags &= -65;
  return $seg$$3$$;
};
$JSCompiler_prototypeAlias$$.clear_tlb = function $$JSCompiler_prototypeAlias$$$clear_tlb$() {
  this.last_virt_eip = -1;
  this.tlb_info.set(this.tlb_info_global);
};
$JSCompiler_prototypeAlias$$.full_clear_tlb = function $$JSCompiler_prototypeAlias$$$full_clear_tlb$() {
  for (var $buf32$$ = new Int32Array(this.tlb_info_global.buffer), $i$$16$$ = 0;262144 > $i$$16$$;) {
    $buf32$$[$i$$16$$++] = $buf32$$[$i$$16$$++] = $buf32$$[$i$$16$$++] = $buf32$$[$i$$16$$++] = 0;
  }
  this.clear_tlb();
};
$JSCompiler_prototypeAlias$$.invlpg = function $$JSCompiler_prototypeAlias$$$invlpg$($addr$$65_page$$) {
  $addr$$65_page$$ = $addr$$65_page$$ >>> 12;
  this.tlb_info[$addr$$65_page$$] = 0;
  this.tlb_info_global[$addr$$65_page$$] = 0;
  this.last_virt_eip = -1;
};
$JSCompiler_prototypeAlias$$.translate_address_read = function $$JSCompiler_prototypeAlias$$$translate_address_read$($addr$$66$$) {
  return this.paging ? 3 === this.cpl ? this.translate_address_user_read($addr$$66$$) : this.translate_address_system_read($addr$$66$$) : $addr$$66$$;
};
$JSCompiler_prototypeAlias$$.translate_address_write = function $$JSCompiler_prototypeAlias$$$translate_address_write$($addr$$67$$) {
  return this.paging ? 3 === this.cpl ? this.translate_address_user_write($addr$$67$$) : this.translate_address_system_write($addr$$67$$) : $addr$$67$$;
};
$JSCompiler_prototypeAlias$$.translate_address_user_write = function $$JSCompiler_prototypeAlias$$$translate_address_user_write$($addr$$68$$) {
  var $base$$4$$ = $addr$$68$$ >>> 12;
  return this.tlb_info[$base$$4$$] & 8 ? this.tlb_data[$base$$4$$] ^ $addr$$68$$ : this.do_page_translation($addr$$68$$, 1, 1) | $addr$$68$$ & 4095;
};
$JSCompiler_prototypeAlias$$.translate_address_user_read = function $$JSCompiler_prototypeAlias$$$translate_address_user_read$($addr$$69$$) {
  var $base$$5$$ = $addr$$69$$ >>> 12;
  return this.tlb_info[$base$$5$$] & 4 ? this.tlb_data[$base$$5$$] ^ $addr$$69$$ : this.do_page_translation($addr$$69$$, 0, 1) | $addr$$69$$ & 4095;
};
$JSCompiler_prototypeAlias$$.translate_address_system_write = function $$JSCompiler_prototypeAlias$$$translate_address_system_write$($addr$$70$$) {
  var $base$$6$$ = $addr$$70$$ >>> 12;
  return this.tlb_info[$base$$6$$] & 2 ? this.tlb_data[$base$$6$$] ^ $addr$$70$$ : this.do_page_translation($addr$$70$$, 1, 0) | $addr$$70$$ & 4095;
};
$JSCompiler_prototypeAlias$$.translate_address_system_read = function $$JSCompiler_prototypeAlias$$$translate_address_system_read$($addr$$71$$) {
  var $base$$7$$ = $addr$$71$$ >>> 12;
  return this.tlb_info[$base$$7$$] & 1 ? this.tlb_data[$base$$7$$] ^ $addr$$71$$ : this.do_page_translation($addr$$71$$, 0, 0) | $addr$$71$$ & 4095;
};
$JSCompiler_prototypeAlias$$.do_page_translation = function $$JSCompiler_prototypeAlias$$$do_page_translation$($addr$$72_high$$5$$, $for_writing$$, $user$$) {
  var $page$$1$$ = $addr$$72_high$$5$$ >>> 12, $page_dir_addr$$ = (this.cr3 >>> 2) + ($page$$1$$ >> 10), $global$$1_page_dir_entry$$ = this.memory.mem32s[$page_dir_addr$$], $allowed_flag_can_write$$ = !0, $allow_user$$ = !0;
  $global$$1_page_dir_entry$$ & 1 || (this.cr2 = $addr$$72_high$$5$$, this.trigger_pagefault($for_writing$$, $user$$, 0));
  0 === ($global$$1_page_dir_entry$$ & 2) && ($allowed_flag_can_write$$ = !1, $for_writing$$ && ($user$$ || this.cr0 & 65536) && (this.cr2 = $addr$$72_high$$5$$, this.trigger_pagefault($for_writing$$, $user$$, 1)));
  0 === ($global$$1_page_dir_entry$$ & 4) && ($allow_user$$ = !1, $user$$ && (this.cr2 = $addr$$72_high$$5$$, this.trigger_pagefault($for_writing$$, $user$$, 1)));
  if ($global$$1_page_dir_entry$$ & this.page_size_extensions) {
    this.memory.mem32s[$page_dir_addr$$] = $global$$1_page_dir_entry$$ | 32 | $for_writing$$ << 6, $addr$$72_high$$5$$ = $global$$1_page_dir_entry$$ & 4290772992 | $addr$$72_high$$5$$ & 4190208, $global$$1_page_dir_entry$$ = $global$$1_page_dir_entry$$ & 256;
  } else {
    var $page_table_addr$$ = (($global$$1_page_dir_entry$$ & 4294963200) >>> 2) + ($page$$1$$ & 1023), $page_table_entry$$ = this.memory.mem32s[$page_table_addr$$];
    0 === ($page_table_entry$$ & 1) && (this.cr2 = $addr$$72_high$$5$$, this.trigger_pagefault($for_writing$$, $user$$, 0));
    0 === ($page_table_entry$$ & 2) && ($allowed_flag_can_write$$ = !1, $for_writing$$ && ($user$$ || this.cr0 & 65536) && (this.cr2 = $addr$$72_high$$5$$, this.trigger_pagefault($for_writing$$, $user$$, 1)));
    0 === ($page_table_entry$$ & 4) && ($allow_user$$ = !1, $user$$ && (this.cr2 = $addr$$72_high$$5$$, this.trigger_pagefault($for_writing$$, $user$$, 1)));
    this.memory.mem32s[$page_dir_addr$$] = $global$$1_page_dir_entry$$ | 32;
    this.memory.mem32s[$page_table_addr$$] = $page_table_entry$$ | 32 | $for_writing$$ << 6;
    $addr$$72_high$$5$$ = $page_table_entry$$ & 4294963200;
    $global$$1_page_dir_entry$$ = $page_table_entry$$ & 256;
  }
  this.tlb_data[$page$$1$$] = $addr$$72_high$$5$$ ^ $page$$1$$ << 12;
  $allowed_flag_can_write$$ = $allow_user$$ ? $allowed_flag_can_write$$ ? 15 : 5 : $allowed_flag_can_write$$ ? 3 : 1;
  this.tlb_info[$page$$1$$] = $allowed_flag_can_write$$;
  $global$$1_page_dir_entry$$ && this.cr4 & 128 && (this.tlb_info_global[$page$$1$$] = $allowed_flag_can_write$$);
  return $addr$$72_high$$5$$;
};
$JSCompiler_prototypeAlias$$.writable_or_pagefault = function $$JSCompiler_prototypeAlias$$$writable_or_pagefault$($addr$$73$$, $size$$39$$) {
  if (this.paging) {
    var $user$$1$$ = 3 === this.cpl ? 1 : 0, $mask$$7$$ = $user$$1$$ ? 8 : 2, $page$$2$$ = $addr$$73$$ >>> 12;
    0 === (this.tlb_info[$page$$2$$] & $mask$$7$$) && this.do_page_translation($addr$$73$$, 1, $user$$1$$);
    4096 <= ($addr$$73$$ & 4095) + $size$$39$$ - 1 && 0 === (this.tlb_info[$page$$2$$ + 1] & $mask$$7$$) && this.do_page_translation($addr$$73$$ + $size$$39$$ - 1, 1, $user$$1$$);
  }
};
$JSCompiler_prototypeAlias$$.trigger_pagefault = function $$JSCompiler_prototypeAlias$$$trigger_pagefault$($write$$, $user$$2$$, $present$$) {
  if (this.page_fault) {
    throw this.debug.unimpl("Double fault");
  }
  var $page$$3$$ = this.cr2 >>> 12;
  this.tlb_info[$page$$3$$] = 0;
  this.tlb_info_global[$page$$3$$] = 0;
  this.instruction_pointer = this.previous_ip;
  this.page_fault = !0;
  this.call_interrupt_vector(14, !1, $user$$2$$ << 2 | $write$$ << 1 | $present$$);
  throw 233495534;
};
"object" === typeof window && (window.v86 = $v86$$, $v86$$.prototype.run = $v86$$.prototype.run, $v86$$.prototype.stop = $v86$$.prototype.v86_prototype$stop);
Object.fromList = function $Object$fromList$($xs$$) {
  for (var $result$$81$$ = {}, $i$$17$$ = 0;$i$$17$$ < $xs$$.length;$i$$17$$++) {
    $result$$81$$[$xs$$[$i$$17$$][0]] = $xs$$[$i$$17$$][1];
  }
  return $result$$81$$;
};
function $dbg_assert$$() {
}
String.pads = function $String$pads$($str$$7$$, $len$$) {
  for ($str$$7$$ = $str$$7$$ ? $str$$7$$ + "" : "";$str$$7$$.length < $len$$;) {
    $str$$7$$ = $str$$7$$ + " ";
  }
  return $str$$7$$;
};
String.pad0 = function $String$pad0$() {
  for (var $str$$8$$ = "", $str$$8$$ = $str$$8$$ ? $str$$8$$ + "" : "";1 > $str$$8$$.length;) {
    $str$$8$$ = "0" + $str$$8$$;
  }
  return $str$$8$$;
};
function $SyncBuffer$$($buffer$$8$$) {
  this.byteLength = $buffer$$8$$.byteLength;
  this.get = function $this$get$($start$$10$$, $len$$3$$, $fn$$3$$) {
    $fn$$3$$(new Uint8Array($buffer$$8$$, $start$$10$$, $len$$3$$));
  };
  this.set = function $this$set$($start$$11$$, $slice$$, $fn$$4$$) {
    (new Uint8Array($buffer$$8$$, $start$$11$$, $slice$$.byteLength)).set($slice$$);
    $fn$$4$$();
  };
}
"object" === typeof window && (window.SyncBuffer = $SyncBuffer$$);
Math.int_log2 = function $Math$int_log2$($x$$54$$) {
  return Math.log($x$$54$$) / Math.LN2 | 0;
};
function $ByteQueue$$($size$$41$$) {
  var $data$$198$$ = new Uint8Array($size$$41$$), $start$$12$$, $end$$4$$;
  this.length = 0;
  this.ByteQueue$push = function $this$ByteQueue$push$($item$$1$$) {
    this.length !== $size$$41$$ && this.length++;
    $data$$198$$[$end$$4$$] = $item$$1$$;
    $end$$4$$ = $end$$4$$ + 1 & $size$$41$$ - 1;
  };
  this.ByteQueue$shift = function $this$ByteQueue$shift$() {
    if (this.length) {
      var $item$$2$$ = $data$$198$$[$start$$12$$];
      $start$$12$$ = $start$$12$$ + 1 & $size$$41$$ - 1;
      this.length--;
      return $item$$2$$;
    }
    return-1;
  };
  this.ByteQueue$clear = function $this$ByteQueue$clear$() {
    this.length = $end$$4$$ = $start$$12$$ = 0;
  };
  this.ByteQueue$clear();
}
;function $FPU$$($cpu$$1033$$) {
  this.cpu = $cpu$$1033$$;
  this._st = new Float64Array(8);
  this._st8 = new Uint8Array(this._st.buffer);
  new Int32Array(this._st.buffer);
  this._stack_empty = 255;
  this._stack_ptr = 0;
  this._control_word = 895;
  this._fpu_dp_selector = this._fpu_dp = this._fpu_opcode = this._fpu_ip_selector = this._fpu_ip = this._status_word = 0;
  this.float32 = new Float32Array(1);
  new Uint8Array(this.float32.buffer);
  this.float32_int = new Int32Array(this.float32.buffer);
  this.float64 = new Float64Array(1);
  this.float64_byte = new Uint8Array(this.float64.buffer);
  this.float64_int = new Int32Array(this.float64.buffer);
  new Uint8Array(10);
  this.indefinite_nan = NaN;
  this.constants = new Float64Array([1, Math.log(10) / Math.LN2, Math.LOG2E, Math.PI, Math.log(2) / Math.LN10, Math.LN2, 0]);
}
$JSCompiler_prototypeAlias$$ = $FPU$$.prototype;
$JSCompiler_prototypeAlias$$._fpu_unimpl = function $$JSCompiler_prototypeAlias$$$_fpu_unimpl$() {
  this.cpu.trigger_ud();
};
$JSCompiler_prototypeAlias$$._stack_fault = function $$JSCompiler_prototypeAlias$$$_stack_fault$() {
  this._status_word |= 65;
};
$JSCompiler_prototypeAlias$$._invalid_arithmatic = function $$JSCompiler_prototypeAlias$$$_invalid_arithmatic$() {
  this._status_word |= 1;
};
$JSCompiler_prototypeAlias$$._fcom = function $$JSCompiler_prototypeAlias$$$_fcom$($y$$34$$) {
  var $x$$55$$ = this._get_st0();
  this._status_word &= -18177;
  $x$$55$$ > $y$$34$$ || (this._status_word = $y$$34$$ > $x$$55$$ ? this._status_word | 256 : $x$$55$$ === $y$$34$$ ? this._status_word | 16384 : this._status_word | 17664);
};
$JSCompiler_prototypeAlias$$._fucom = function $$JSCompiler_prototypeAlias$$$_fucom$($y$$35$$) {
  this._fcom($y$$35$$);
};
$JSCompiler_prototypeAlias$$._fcomi = function $$JSCompiler_prototypeAlias$$$_fcomi$($y$$36$$) {
  var $x$$56$$ = this._st[this._stack_ptr];
  this.cpu.flags_changed &= -70;
  this.cpu.flags &= -70;
  $x$$56$$ > $y$$36$$ || (this.cpu.flags = $y$$36$$ > $x$$56$$ ? this.cpu.flags | 1 : $x$$56$$ === $y$$36$$ ? this.cpu.flags | 64 : this.cpu.flags | 69);
};
$JSCompiler_prototypeAlias$$._fucomi = function $$JSCompiler_prototypeAlias$$$_fucomi$($y$$37$$) {
  this._fcomi($y$$37$$);
};
$JSCompiler_prototypeAlias$$._ftst = function $$JSCompiler_prototypeAlias$$$_ftst$($x$$57$$) {
  this._status_word &= -18177;
  isNaN($x$$57$$) ? this._status_word |= 17664 : 0 === $x$$57$$ ? this._status_word |= 16384 : 0 > $x$$57$$ && (this._status_word |= 256);
};
$JSCompiler_prototypeAlias$$._fxam = function $$JSCompiler_prototypeAlias$$$_fxam$($x$$58$$) {
  this._status_word &= -18177;
  this._status_word |= this._sign() << 9;
  this._status_word = this._stack_empty >> this._stack_ptr & 1 ? this._status_word | 16640 : isNaN($x$$58$$) ? this._status_word | 256 : 0 === $x$$58$$ ? this._status_word | 16384 : Infinity === $x$$58$$ || -Infinity === $x$$58$$ ? this._status_word | 1280 : this._status_word | 1024;
};
$JSCompiler_prototypeAlias$$._finit = function $$JSCompiler_prototypeAlias$$$_finit$() {
  this._control_word = 895;
  this._fpu_opcode = this._fpu_dp = this._fpu_ip = this._status_word = 0;
  this._stack_empty = 255;
  this._stack_ptr = 0;
};
$JSCompiler_prototypeAlias$$._load_status_word = function $$JSCompiler_prototypeAlias$$$_load_status_word$() {
  return this._status_word & -14337 | this._stack_ptr << 11;
};
$JSCompiler_prototypeAlias$$._safe_status_word = function $$JSCompiler_prototypeAlias$$$_safe_status_word$($sw$$2$$) {
  this._status_word = $sw$$2$$ & -14337;
  this._stack_ptr = $sw$$2$$ >> 11 & 7;
};
$JSCompiler_prototypeAlias$$._load_tag_word = function $$JSCompiler_prototypeAlias$$$_load_tag_word$() {
  for (var $tag_word$$ = 0, $value$$46$$, $i$$18$$ = 0;8 > $i$$18$$;$i$$18$$++) {
    $value$$46$$ = this._st[$i$$18$$], this._stack_empty >> $i$$18$$ & 1 ? $tag_word$$ |= 3 << ($i$$18$$ << 1) : 0 === $value$$46$$ ? $tag_word$$ |= 1 << ($i$$18$$ << 1) : isFinite($value$$46$$) || ($tag_word$$ |= 2 << ($i$$18$$ << 1));
  }
  return $tag_word$$;
};
$JSCompiler_prototypeAlias$$._safe_tag_word = function $$JSCompiler_prototypeAlias$$$_safe_tag_word$($tag_word$$1$$) {
  for (var $i$$19$$ = this._stack_empty = 0;8 > $i$$19$$;$i$$19$$++) {
    this._stack_empty |= $tag_word$$1$$ >> $i$$19$$ & $tag_word$$1$$ >> $i$$19$$ + 1 & 1 << $i$$19$$;
  }
};
$JSCompiler_prototypeAlias$$._fstenv = function $$JSCompiler_prototypeAlias$$$_fstenv$($addr$$74$$) {
  this.cpu.operand_size_32 ? (this.cpu.writable_or_pagefault($addr$$74$$, 26), this.cpu.safe_write16($addr$$74$$, this._control_word), this.cpu.safe_write16($addr$$74$$ + 4, this._load_status_word()), this.cpu.safe_write16($addr$$74$$ + 8, this._load_tag_word()), this.cpu.safe_write32($addr$$74$$ + 12, this._fpu_ip), this.cpu.safe_write16($addr$$74$$ + 16, this._fpu_ip_selector), this.cpu.safe_write16($addr$$74$$ + 18, this._fpu_opcode), this.cpu.safe_write32($addr$$74$$ + 20, this._fpu_dp), this.cpu.safe_write16($addr$$74$$ + 
  24, this._fpu_dp_selector)) : this._fpu_unimpl();
};
$JSCompiler_prototypeAlias$$._fldenv = function $$JSCompiler_prototypeAlias$$$_fldenv$($addr$$75$$) {
  this.cpu.operand_size_32 ? (this._control_word = this.cpu.safe_read16($addr$$75$$), this._safe_status_word(this.cpu.safe_read16($addr$$75$$ + 4)), this._safe_tag_word(this.cpu.safe_read16($addr$$75$$ + 8)), this._fpu_ip = this.cpu.safe_read32s($addr$$75$$ + 12), this._fpu_ip_selector = this.cpu.safe_read16($addr$$75$$ + 16), this._fpu_opcode = this.cpu.safe_read16($addr$$75$$ + 18), this._fpu_dp = this.cpu.safe_read32s($addr$$75$$ + 20), this._fpu_dp_selector = this.cpu.safe_read16($addr$$75$$ + 
  24)) : this._fpu_unimpl();
};
$JSCompiler_prototypeAlias$$._fsave = function $$JSCompiler_prototypeAlias$$$_fsave$($addr$$76$$) {
  this.cpu.writable_or_pagefault($addr$$76$$, 108);
  this._fstenv($addr$$76$$);
  $addr$$76$$ += 28;
  for (var $i$$20$$ = 0;8 > $i$$20$$;$i$$20$$++) {
    this._store_m80($addr$$76$$, $i$$20$$ - this._stack_ptr & 7), $addr$$76$$ += 10;
  }
  this._finit();
};
$JSCompiler_prototypeAlias$$._frstor = function $$JSCompiler_prototypeAlias$$$_frstor$($addr$$77$$) {
  this._fldenv($addr$$77$$);
  $addr$$77$$ += 28;
  for (var $i$$21$$ = 0;8 > $i$$21$$;$i$$21$$++) {
    this._st[$i$$21$$] = this._load_m80($addr$$77$$), $addr$$77$$ += 10;
  }
};
$JSCompiler_prototypeAlias$$._integer_round = function $$JSCompiler_prototypeAlias$$$_integer_round$($f$$) {
  var $rc_rounded$$ = this._control_word >> 10 & 3;
  return 0 === $rc_rounded$$ ? ($rc_rounded$$ = Math.round($f$$), 0.5 === $rc_rounded$$ - $f$$ && $rc_rounded$$ % 2 && $rc_rounded$$--, $rc_rounded$$) : 1 === $rc_rounded$$ || 3 === $rc_rounded$$ && 0 < $f$$ ? Math.floor($f$$) : Math.ceil($f$$);
};
$JSCompiler_prototypeAlias$$._truncate = function $$JSCompiler_prototypeAlias$$$_truncate$($x$$59$$) {
  return 0 < $x$$59$$ ? Math.floor($x$$59$$) : Math.ceil($x$$59$$);
};
$JSCompiler_prototypeAlias$$._push = function $$JSCompiler_prototypeAlias$$$_push$($x$$60$$) {
  this._stack_ptr = this._stack_ptr - 1 & 7;
  this._stack_empty >> this._stack_ptr & 1 ? (this._status_word &= -513, this._stack_empty &= ~(1 << this._stack_ptr), this._st[this._stack_ptr] = $x$$60$$) : (this._status_word |= 512, this._stack_fault(), this._st[this._stack_ptr] = this.indefinite_nan);
};
$JSCompiler_prototypeAlias$$._pop = function $$JSCompiler_prototypeAlias$$$_pop$() {
  this._stack_empty |= 1 << this._stack_ptr;
  this._stack_ptr = this._stack_ptr + 1 & 7;
};
$JSCompiler_prototypeAlias$$._get_sti = function $$JSCompiler_prototypeAlias$$$_get_sti$($i$$22$$) {
  $i$$22$$ = $i$$22$$ + this._stack_ptr & 7;
  return this._stack_empty >> $i$$22$$ & 1 ? (this._status_word &= -513, this._stack_fault(), this.indefinite_nan) : this._st[$i$$22$$];
};
$JSCompiler_prototypeAlias$$._get_st0 = function $$JSCompiler_prototypeAlias$$$_get_st0$() {
  return this._stack_empty >> this._stack_ptr & 1 ? (this._status_word &= -513, this._stack_fault(), this.indefinite_nan) : this._st[this._stack_ptr];
};
$JSCompiler_prototypeAlias$$._load_m80 = function $$JSCompiler_prototypeAlias$$$_load_m80$($addr$$78_sign$$) {
  var $exponent$$ = this.cpu.safe_read16($addr$$78_sign$$ + 8), $low$$5_mantissa$$ = this.cpu.safe_read32s($addr$$78_sign$$) >>> 0, $high$$6$$ = this.cpu.safe_read32s($addr$$78_sign$$ + 4) >>> 0;
  $addr$$78_sign$$ = $exponent$$ >> 15;
  $exponent$$ &= -32769;
  if (0 === $exponent$$) {
    return 0;
  }
  if (!(32767 > $exponent$$)) {
    return this.float64_byte[7] = 127 | $addr$$78_sign$$ << 7, this.float64_byte[6] = 240 | $high$$6$$ >> 30 << 3 & 8, this.float64_byte[5] = 0, this.float64_byte[4] = 0, this.float64_int[0] = 0, this.float64[0];
  }
  $low$$5_mantissa$$ += 4294967296 * $high$$6$$;
  $addr$$78_sign$$ && ($low$$5_mantissa$$ = -$low$$5_mantissa$$);
  return $low$$5_mantissa$$ * Math.pow(2, $exponent$$ - 16383 - 63);
};
$JSCompiler_prototypeAlias$$._store_m80 = function $$JSCompiler_prototypeAlias$$$_store_m80$($addr$$79$$, $i$$23$$) {
  this.float64[0] = this._st[this._stack_ptr + $i$$23$$ & 7];
  var $sign$$1$$ = this.float64_byte[7] & 128, $exponent$$1$$ = (this.float64_byte[7] & 127) << 4 | this.float64_byte[6] >> 4, $low$$6$$, $high$$7$$;
  2047 === $exponent$$1$$ ? ($exponent$$1$$ = 32767, $low$$6$$ = 0, $high$$7$$ = 2147483648 | (this.float64_int[1] & 524288) << 11) : 0 === $exponent$$1$$ ? $high$$7$$ = $low$$6$$ = 0 : ($exponent$$1$$ += 15360, $low$$6$$ = this.float64_int[0] << 11, $high$$7$$ = 2147483648 | (this.float64_int[1] & 1048575) << 11 | this.float64_int[0] >>> 21);
  this.cpu.safe_write32($addr$$79$$, $low$$6$$);
  this.cpu.safe_write32($addr$$79$$ + 4, $high$$7$$);
  this.cpu.safe_write16($addr$$79$$ + 8, $sign$$1$$ << 8 | $exponent$$1$$);
};
$JSCompiler_prototypeAlias$$._load_m64 = function $$JSCompiler_prototypeAlias$$$_load_m64$($addr$$80_high$$8$$) {
  var $low$$7$$ = this.cpu.safe_read32s($addr$$80_high$$8$$);
  $addr$$80_high$$8$$ = this.cpu.safe_read32s($addr$$80_high$$8$$ + 4);
  this.float64_int[0] = $low$$7$$;
  this.float64_int[1] = $addr$$80_high$$8$$;
  return this.float64[0];
};
$JSCompiler_prototypeAlias$$._store_m64 = function $$JSCompiler_prototypeAlias$$$_store_m64$($addr$$81$$) {
  this.cpu.writable_or_pagefault($addr$$81$$, 8);
  this.float64[0] = this._get_sti(0);
  this.cpu.safe_write32($addr$$81$$, this.float64_int[0]);
  this.cpu.safe_write32($addr$$81$$ + 4, this.float64_int[1]);
};
$JSCompiler_prototypeAlias$$._load_m32 = function $$JSCompiler_prototypeAlias$$$_load_m32$($addr$$82$$) {
  this.float32_int[0] = this.cpu.safe_read32s($addr$$82$$);
  return this.float32[0];
};
$JSCompiler_prototypeAlias$$._store_m32 = function $$JSCompiler_prototypeAlias$$$_store_m32$($addr$$83$$, $x$$61$$) {
  this.float32[0] = $x$$61$$;
  this.cpu.safe_write32($addr$$83$$, this.float32_int[0]);
};
$JSCompiler_prototypeAlias$$._sign = function $$JSCompiler_prototypeAlias$$$_sign$() {
  return this._st8[(this._stack_ptr + 0 & 7) << 3 | 7] >> 7;
};
$JSCompiler_prototypeAlias$$.op_D8_reg = function $$JSCompiler_prototypeAlias$$$op_D8_reg$($imm8$$5_sti$$) {
  var $mod$$269$$ = $imm8$$5_sti$$ >> 3 & 7;
  $imm8$$5_sti$$ = this._get_sti($imm8$$5_sti$$ & 7);
  var $st0$$ = this._get_st0();
  switch($mod$$269$$) {
    case 0:
      this._st[this._stack_ptr] = $st0$$ + $imm8$$5_sti$$;
      break;
    case 1:
      this._st[this._stack_ptr] = $st0$$ * $imm8$$5_sti$$;
      break;
    case 2:
      this._fcom($imm8$$5_sti$$);
      break;
    case 3:
      this._fcom($imm8$$5_sti$$);
      this._pop();
      break;
    case 4:
      this._st[this._stack_ptr] = $st0$$ - $imm8$$5_sti$$;
      break;
    case 5:
      this._st[this._stack_ptr] = $imm8$$5_sti$$ - $st0$$;
      break;
    case 6:
      this._st[this._stack_ptr] = $st0$$ / $imm8$$5_sti$$;
      break;
    case 7:
      this._st[this._stack_ptr] = $imm8$$5_sti$$ / $st0$$;
  }
};
$JSCompiler_prototypeAlias$$.op_D8_mem = function $$JSCompiler_prototypeAlias$$$op_D8_mem$($imm8$$6$$, $addr$$84$$) {
  var $mod$$270$$ = $imm8$$6$$ >> 3 & 7, $m32$$ = this._load_m32($addr$$84$$), $st0$$1$$ = this._get_st0();
  switch($mod$$270$$) {
    case 0:
      this._st[this._stack_ptr] = $st0$$1$$ + $m32$$;
      break;
    case 1:
      this._st[this._stack_ptr] = $st0$$1$$ * $m32$$;
      break;
    case 2:
      this._fcom($m32$$);
      break;
    case 3:
      this._fcom($m32$$);
      this._pop();
      break;
    case 4:
      this._st[this._stack_ptr] = $st0$$1$$ - $m32$$;
      break;
    case 5:
      this._st[this._stack_ptr] = $m32$$ - $st0$$1$$;
      break;
    case 6:
      this._st[this._stack_ptr] = $st0$$1$$ / $m32$$;
      break;
    case 7:
      this._st[this._stack_ptr] = $m32$$ / $st0$$1$$;
  }
};
$JSCompiler_prototypeAlias$$.op_D9_reg = function $$JSCompiler_prototypeAlias$$$op_D9_reg$($imm8$$7_st0$$2_sti$$1$$) {
  var $low$$9$$ = $imm8$$7_st0$$2_sti$$1$$ & 7;
  switch($imm8$$7_st0$$2_sti$$1$$ >> 3 & 7) {
    case 0:
      $imm8$$7_st0$$2_sti$$1$$ = this._get_sti($low$$9$$);
      this._push($imm8$$7_st0$$2_sti$$1$$);
      break;
    case 1:
      $imm8$$7_st0$$2_sti$$1$$ = this._get_sti($low$$9$$);
      this._st[this._stack_ptr + $low$$9$$ & 7] = this._get_st0();
      this._st[this._stack_ptr] = $imm8$$7_st0$$2_sti$$1$$;
      break;
    case 2:
      switch($low$$9$$) {
        case 0:
          break;
        default:
          this._fpu_unimpl();
      }
      break;
    case 3:
      this._fpu_unimpl();
      break;
    case 4:
      $imm8$$7_st0$$2_sti$$1$$ = this._get_st0();
      switch($low$$9$$) {
        case 0:
          this._st[this._stack_ptr] = -$imm8$$7_st0$$2_sti$$1$$;
          break;
        case 1:
          this._st[this._stack_ptr] = Math.abs($imm8$$7_st0$$2_sti$$1$$);
          break;
        case 4:
          this._ftst($imm8$$7_st0$$2_sti$$1$$);
          break;
        case 5:
          this._fxam($imm8$$7_st0$$2_sti$$1$$);
          break;
        default:
          this._fpu_unimpl();
      }
      break;
    case 5:
      this._push(this.constants[$low$$9$$]);
      break;
    case 6:
      $imm8$$7_st0$$2_sti$$1$$ = this._get_st0();
      switch($low$$9$$) {
        case 0:
          this._st[this._stack_ptr] = Math.pow(2, $imm8$$7_st0$$2_sti$$1$$) - 1;
          break;
        case 1:
          this._st[this._stack_ptr + 1 & 7] = this._get_sti(1) * Math.log($imm8$$7_st0$$2_sti$$1$$) / Math.LN2;
          this._pop();
          break;
        case 2:
          this._st[this._stack_ptr] = Math.tan($imm8$$7_st0$$2_sti$$1$$);
          this._push(1);
          break;
        case 3:
          this._st[this._stack_ptr + 1 & 7] = Math.atan2(this._get_sti(1), $imm8$$7_st0$$2_sti$$1$$);
          this._pop();
          break;
        case 4:
          this._fpu_unimpl();
          break;
        case 5:
          this._st[this._stack_ptr] = $imm8$$7_st0$$2_sti$$1$$ % this._get_sti(1);
          break;
        case 6:
          this._fpu_unimpl();
          break;
        case 7:
          this._fpu_unimpl();
      }
      break;
    case 7:
      switch($imm8$$7_st0$$2_sti$$1$$ = this._get_st0(), $low$$9$$) {
        case 0:
          this._st[this._stack_ptr] = $imm8$$7_st0$$2_sti$$1$$ % this._get_sti(1);
          break;
        case 1:
          this._st[this._stack_ptr + 1 & 7] = this._get_sti(1) * Math.log($imm8$$7_st0$$2_sti$$1$$ + 1) / Math.LN2;
          this._pop();
          break;
        case 2:
          this._st[this._stack_ptr] = Math.sqrt($imm8$$7_st0$$2_sti$$1$$);
          break;
        case 3:
          this._st[this._stack_ptr] = Math.sin($imm8$$7_st0$$2_sti$$1$$);
          this._push(Math.cos($imm8$$7_st0$$2_sti$$1$$));
          break;
        case 4:
          this._st[this._stack_ptr] = this._integer_round($imm8$$7_st0$$2_sti$$1$$);
          break;
        case 5:
          this._st[this._stack_ptr] = $imm8$$7_st0$$2_sti$$1$$ * Math.pow(2, this._truncate(this._get_sti(1)));
          break;
        case 6:
          this._st[this._stack_ptr] = Math.sin($imm8$$7_st0$$2_sti$$1$$);
          break;
        case 7:
          this._st[this._stack_ptr] = Math.cos($imm8$$7_st0$$2_sti$$1$$);
      }
    ;
  }
};
$JSCompiler_prototypeAlias$$.op_D9_mem = function $$JSCompiler_prototypeAlias$$$op_D9_mem$($imm8$$8$$, $addr$$85$$) {
  switch($imm8$$8$$ >> 3 & 7) {
    case 0:
      var $data$$199$$ = this._load_m32($addr$$85$$);
      this._push($data$$199$$);
      break;
    case 1:
      this._fpu_unimpl();
      break;
    case 2:
      this._store_m32($addr$$85$$, this._get_st0());
      break;
    case 3:
      this._store_m32($addr$$85$$, this._get_st0());
      this._pop();
      break;
    case 4:
      this._fldenv($addr$$85$$);
      break;
    case 5:
      this._control_word = this.cpu.safe_read16($addr$$85$$);
      break;
    case 6:
      this._fstenv($addr$$85$$);
      break;
    case 7:
      this.cpu.safe_write16($addr$$85$$, this._control_word);
  }
};
$JSCompiler_prototypeAlias$$.op_DA_reg = function $$JSCompiler_prototypeAlias$$$op_DA_reg$($imm8$$9$$) {
  var $low$$10$$ = $imm8$$9$$ & 7;
  switch($imm8$$9$$ >> 3 & 7) {
    case 0:
      this.cpu.test_b() && (this._st[this._stack_ptr] = this._get_sti($low$$10$$), this._stack_empty &= ~(1 << this._stack_ptr));
      break;
    case 1:
      this.cpu.test_z() && (this._st[this._stack_ptr] = this._get_sti($low$$10$$), this._stack_empty &= ~(1 << this._stack_ptr));
      break;
    case 2:
      this.cpu.test_be() && (this._st[this._stack_ptr] = this._get_sti($low$$10$$), this._stack_empty &= ~(1 << this._stack_ptr));
      break;
    case 3:
      this.cpu.test_p() && (this._st[this._stack_ptr] = this._get_sti($low$$10$$), this._stack_empty &= ~(1 << this._stack_ptr));
      break;
    case 5:
      1 === $low$$10$$ ? (this._fucom(this._get_sti(1)), this._pop(), this._pop()) : this._fpu_unimpl();
      break;
    default:
      this._fpu_unimpl();
  }
};
$JSCompiler_prototypeAlias$$.op_DA_mem = function $$JSCompiler_prototypeAlias$$$op_DA_mem$($imm8$$10$$, $addr$$86$$) {
  var $mod$$274$$ = $imm8$$10$$ >> 3 & 7, $m32$$1$$ = this.cpu.safe_read32s($addr$$86$$), $st0$$3$$ = this._get_st0();
  switch($mod$$274$$) {
    case 0:
      this._st[this._stack_ptr] = $st0$$3$$ + $m32$$1$$;
      break;
    case 1:
      this._st[this._stack_ptr] = $st0$$3$$ * $m32$$1$$;
      break;
    case 2:
      this._fcom($m32$$1$$);
      break;
    case 3:
      this._fcom($m32$$1$$);
      this._pop();
      break;
    case 4:
      this._st[this._stack_ptr] = $st0$$3$$ - $m32$$1$$;
      break;
    case 5:
      this._st[this._stack_ptr] = $m32$$1$$ - $st0$$3$$;
      break;
    case 6:
      this._st[this._stack_ptr] = $st0$$3$$ / $m32$$1$$;
      break;
    case 7:
      this._st[this._stack_ptr] = $m32$$1$$ / $st0$$3$$;
  }
};
$JSCompiler_prototypeAlias$$.op_DB_reg = function $$JSCompiler_prototypeAlias$$$op_DB_reg$($imm8$$11$$) {
  var $low$$11$$ = $imm8$$11$$ & 7;
  switch($imm8$$11$$ >> 3 & 7) {
    case 0:
      this.cpu.test_b() || (this._st[this._stack_ptr] = this._get_sti($low$$11$$), this._stack_empty &= ~(1 << this._stack_ptr));
      break;
    case 1:
      this.cpu.test_z() || (this._st[this._stack_ptr] = this._get_sti($low$$11$$), this._stack_empty &= ~(1 << this._stack_ptr));
      break;
    case 2:
      this.cpu.test_be() || (this._st[this._stack_ptr] = this._get_sti($low$$11$$), this._stack_empty &= ~(1 << this._stack_ptr));
      break;
    case 3:
      this.cpu.test_p() || (this._st[this._stack_ptr] = this._get_sti($low$$11$$), this._stack_empty &= ~(1 << this._stack_ptr));
      break;
    case 4:
      227 === $imm8$$11$$ ? this._finit() : 228 !== $imm8$$11$$ && 225 !== $imm8$$11$$ && (226 === $imm8$$11$$ ? this._status_word = 0 : this._fpu_unimpl());
      break;
    case 5:
      this._fucomi(this._get_sti($low$$11$$));
      break;
    case 6:
      this._fcomi(this._get_sti($low$$11$$));
      break;
    default:
      this._fpu_unimpl();
  }
};
$JSCompiler_prototypeAlias$$.op_DB_mem = function $$JSCompiler_prototypeAlias$$$op_DB_mem$($imm8$$12$$, $addr$$87$$) {
  switch($imm8$$12$$ >> 3 & 7) {
    case 0:
      var $int32_st0$$4$$ = this.cpu.safe_read32s($addr$$87$$);
      this._push($int32_st0$$4$$);
      break;
    case 2:
      $int32_st0$$4$$ = this._integer_round(this._get_st0());
      2147483647 >= $int32_st0$$4$$ && -2147483648 <= $int32_st0$$4$$ ? this.cpu.safe_write32($addr$$87$$, $int32_st0$$4$$) : (this._invalid_arithmatic(), this.cpu.safe_write32($addr$$87$$, -2147483648));
      break;
    case 3:
      $int32_st0$$4$$ = this._integer_round(this._get_st0());
      2147483647 >= $int32_st0$$4$$ && -2147483648 <= $int32_st0$$4$$ ? this.cpu.safe_write32($addr$$87$$, $int32_st0$$4$$) : (this._invalid_arithmatic(), this.cpu.safe_write32($addr$$87$$, -2147483648));
      this._pop();
      break;
    case 5:
      this._push(this._load_m80($addr$$87$$));
      break;
    case 7:
      this.cpu.writable_or_pagefault($addr$$87$$, 10);
      this._store_m80($addr$$87$$, 0);
      this._pop();
      break;
    default:
      this._fpu_unimpl();
  }
};
$JSCompiler_prototypeAlias$$.op_DC_reg = function $$JSCompiler_prototypeAlias$$$op_DC_reg$($imm8$$13_low_ptr$$) {
  var $mod$$277$$ = $imm8$$13_low_ptr$$ >> 3 & 7, $low$$12_sti$$2$$ = $imm8$$13_low_ptr$$ & 7;
  $imm8$$13_low_ptr$$ = this._stack_ptr + $low$$12_sti$$2$$ & 7;
  var $low$$12_sti$$2$$ = this._get_sti($low$$12_sti$$2$$), $st0$$5$$ = this._get_st0();
  switch($mod$$277$$) {
    case 0:
      this._st[$imm8$$13_low_ptr$$] = $low$$12_sti$$2$$ + $st0$$5$$;
      break;
    case 1:
      this._st[$imm8$$13_low_ptr$$] = $low$$12_sti$$2$$ * $st0$$5$$;
      break;
    case 2:
      this._fcom($low$$12_sti$$2$$);
      break;
    case 3:
      this._fcom($low$$12_sti$$2$$);
      this._pop();
      break;
    case 4:
      this._st[$imm8$$13_low_ptr$$] = $st0$$5$$ - $low$$12_sti$$2$$;
      break;
    case 5:
      this._st[$imm8$$13_low_ptr$$] = $low$$12_sti$$2$$ - $st0$$5$$;
      break;
    case 6:
      this._st[$imm8$$13_low_ptr$$] = $st0$$5$$ / $low$$12_sti$$2$$;
      break;
    case 7:
      this._st[$imm8$$13_low_ptr$$] = $low$$12_sti$$2$$ / $st0$$5$$;
  }
};
$JSCompiler_prototypeAlias$$.op_DC_mem = function $$JSCompiler_prototypeAlias$$$op_DC_mem$($imm8$$14$$, $addr$$88$$) {
  var $mod$$278$$ = $imm8$$14$$ >> 3 & 7, $m64$$ = this._load_m64($addr$$88$$), $st0$$6$$ = this._get_st0();
  switch($mod$$278$$) {
    case 0:
      this._st[this._stack_ptr] = $st0$$6$$ + $m64$$;
      break;
    case 1:
      this._st[this._stack_ptr] = $st0$$6$$ * $m64$$;
      break;
    case 2:
      this._fcom($m64$$);
      break;
    case 3:
      this._fcom($m64$$);
      this._pop();
      break;
    case 4:
      this._st[this._stack_ptr] = $st0$$6$$ - $m64$$;
      break;
    case 5:
      this._st[this._stack_ptr] = $m64$$ - $st0$$6$$;
      break;
    case 6:
      this._st[this._stack_ptr] = $st0$$6$$ / $m64$$;
      break;
    case 7:
      this._st[this._stack_ptr] = $m64$$ / $st0$$6$$;
  }
};
$JSCompiler_prototypeAlias$$.op_DD_reg = function $$JSCompiler_prototypeAlias$$$op_DD_reg$($imm8$$15$$) {
  var $low$$13$$ = $imm8$$15$$ & 7;
  switch($imm8$$15$$ >> 3 & 7) {
    case 0:
      this._stack_empty |= 1 << (this._stack_ptr + $low$$13$$ & 7);
      break;
    case 2:
      this._st[this._stack_ptr + $low$$13$$ & 7] = this._get_st0();
      break;
    case 3:
      0 !== $low$$13$$ && (this._st[this._stack_ptr + $low$$13$$ & 7] = this._get_st0());
      this._pop();
      break;
    case 4:
      this._fucom(this._get_sti($low$$13$$));
      break;
    case 5:
      this._fucom(this._get_sti($low$$13$$));
      this._pop();
      break;
    default:
      this._fpu_unimpl();
  }
};
$JSCompiler_prototypeAlias$$.op_DD_mem = function $$JSCompiler_prototypeAlias$$$op_DD_mem$($imm8$$16$$, $addr$$89$$) {
  switch($imm8$$16$$ >> 3 & 7) {
    case 0:
      var $data$$200$$ = this._load_m64($addr$$89$$);
      this._push($data$$200$$);
      break;
    case 1:
      this._fpu_unimpl();
      break;
    case 2:
      this._store_m64($addr$$89$$);
      break;
    case 3:
      this._store_m64($addr$$89$$);
      this._pop();
      break;
    case 4:
      this._frstor($addr$$89$$);
      break;
    case 5:
      this._fpu_unimpl();
      break;
    case 6:
      this._fsave($addr$$89$$);
      break;
    case 7:
      this.cpu.safe_write16($addr$$89$$, this._load_status_word());
  }
};
$JSCompiler_prototypeAlias$$.op_DE_reg = function $$JSCompiler_prototypeAlias$$$op_DE_reg$($imm8$$17_low$$14$$) {
  var $mod$$281$$ = $imm8$$17_low$$14$$ >> 3 & 7;
  $imm8$$17_low$$14$$ = $imm8$$17_low$$14$$ & 7;
  var $low_ptr$$1$$ = this._stack_ptr + $imm8$$17_low$$14$$ & 7, $sti$$3$$ = this._get_sti($imm8$$17_low$$14$$), $st0$$7$$ = this._get_st0();
  switch($mod$$281$$) {
    case 0:
      this._st[$low_ptr$$1$$] = $sti$$3$$ + $st0$$7$$;
      break;
    case 1:
      this._st[$low_ptr$$1$$] = $sti$$3$$ * $st0$$7$$;
      break;
    case 2:
      this._fcom($sti$$3$$);
      break;
    case 3:
      1 === $imm8$$17_low$$14$$ ? (this._fcom(this._st[$low_ptr$$1$$]), this._pop()) : this._fpu_unimpl();
      break;
    case 4:
      this._st[$low_ptr$$1$$] = $st0$$7$$ - $sti$$3$$;
      break;
    case 5:
      this._st[$low_ptr$$1$$] = $sti$$3$$ - $st0$$7$$;
      break;
    case 6:
      this._st[$low_ptr$$1$$] = $st0$$7$$ / $sti$$3$$;
      break;
    case 7:
      this._st[$low_ptr$$1$$] = $sti$$3$$ / $st0$$7$$;
  }
  this._pop();
};
$JSCompiler_prototypeAlias$$.op_DE_mem = function $$JSCompiler_prototypeAlias$$$op_DE_mem$($imm8$$18$$, $addr$$90$$) {
  var $mod$$282$$ = $imm8$$18$$ >> 3 & 7, $m16$$ = this.cpu.safe_read16($addr$$90$$) << 16 >> 16, $st0$$8$$ = this._get_st0();
  switch($mod$$282$$) {
    case 0:
      this._st[this._stack_ptr] = $st0$$8$$ + $m16$$;
      break;
    case 1:
      this._st[this._stack_ptr] = $st0$$8$$ * $m16$$;
      break;
    case 2:
      this._fcom($m16$$);
      break;
    case 3:
      this._fcom($m16$$);
      this._pop();
      break;
    case 4:
      this._st[this._stack_ptr] = $st0$$8$$ - $m16$$;
      break;
    case 5:
      this._st[this._stack_ptr] = $m16$$ - $st0$$8$$;
      break;
    case 6:
      this._st[this._stack_ptr] = $st0$$8$$ / $m16$$;
      break;
    case 7:
      this._st[this._stack_ptr] = $m16$$ / $st0$$8$$;
  }
};
$JSCompiler_prototypeAlias$$.op_DF_reg = function $$JSCompiler_prototypeAlias$$$op_DF_reg$($imm8$$19$$) {
  var $low$$15$$ = $imm8$$19$$ & 7;
  switch($imm8$$19$$ >> 3 & 7) {
    case 4:
      224 === $imm8$$19$$ ? this.cpu.reg16[0] = this._load_status_word() : this._fpu_unimpl();
      break;
    case 5:
      this._fucomi(this._get_sti($low$$15$$));
      this._pop();
      break;
    case 6:
      this._fcomi(this._get_sti($low$$15$$));
      this._pop();
      break;
    default:
      this._fpu_unimpl();
  }
};
$JSCompiler_prototypeAlias$$.op_DF_mem = function $$JSCompiler_prototypeAlias$$$op_DF_mem$($imm8$$20$$, $addr$$91$$) {
  switch($imm8$$20$$ >> 3 & 7) {
    case 0:
      var $high$$9_m16$$1_st0$$9$$ = this.cpu.safe_read16($addr$$91$$) << 16 >> 16;
      this._push($high$$9_m16$$1_st0$$9$$);
      break;
    case 1:
      this._fpu_unimpl();
      break;
    case 2:
      $high$$9_m16$$1_st0$$9$$ = this._integer_round(this._get_st0());
      32767 >= $high$$9_m16$$1_st0$$9$$ && -32768 <= $high$$9_m16$$1_st0$$9$$ ? this.cpu.safe_write16($addr$$91$$, $high$$9_m16$$1_st0$$9$$) : (this._invalid_arithmatic(), this.cpu.safe_write16($addr$$91$$, 32768));
      break;
    case 3:
      $high$$9_m16$$1_st0$$9$$ = this._integer_round(this._get_st0());
      32767 >= $high$$9_m16$$1_st0$$9$$ && -32768 <= $high$$9_m16$$1_st0$$9$$ ? this.cpu.safe_write16($addr$$91$$, $high$$9_m16$$1_st0$$9$$) : (this._invalid_arithmatic(), this.cpu.safe_write16($addr$$91$$, 32768));
      this._pop();
      break;
    case 4:
      this._fpu_unimpl();
      break;
    case 5:
      var $low$$16_m64$$1_st0_low$$ = this.cpu.safe_read32s($addr$$91$$) >>> 0, $high$$9_m16$$1_st0$$9$$ = this.cpu.safe_read32s($addr$$91$$ + 4) >>> 0, $low$$16_m64$$1_st0_low$$ = $low$$16_m64$$1_st0_low$$ + 4294967296 * $high$$9_m16$$1_st0$$9$$;
      $high$$9_m16$$1_st0$$9$$ >> 31 && ($low$$16_m64$$1_st0_low$$ -= 1.8446744073709552E19);
      this._push($low$$16_m64$$1_st0_low$$);
      break;
    case 6:
      this._fpu_unimpl();
      break;
    case 7:
      this.cpu.writable_or_pagefault($addr$$91$$, 8);
      var $high$$9_m16$$1_st0$$9$$ = this._integer_round(this._get_st0()), $st0_high$$;
      9223372036854775E3 > $high$$9_m16$$1_st0$$9$$ && -9223372036854775E3 <= $high$$9_m16$$1_st0$$9$$ ? ($low$$16_m64$$1_st0_low$$ = $high$$9_m16$$1_st0$$9$$ | 0, $st0_high$$ = $high$$9_m16$$1_st0$$9$$ / 4294967296 | 0, 0 === $st0_high$$ && 0 > $high$$9_m16$$1_st0$$9$$ && ($st0_high$$ = -1)) : ($low$$16_m64$$1_st0_low$$ = 0, $st0_high$$ = -2147483648, this._invalid_arithmatic());
      this.cpu.safe_write32($addr$$91$$, $low$$16_m64$$1_st0_low$$);
      this.cpu.safe_write32($addr$$91$$ + 4, $st0_high$$);
      this._pop();
  }
};
function $IDEDevice$$($cpu$$1034$$, $buffer$$9$$, $is_cd$$, $nr$$) {
  function $push_irq$$() {
    0 === ($device_control$$ & 2) && ($dma_status$$ |= 4, $pic$$.push_irq($me$$1$$.irq));
  }
  function $atapi_handle$$() {
    $bytecount$$ = 2;
    switch($data_port_buffer$$[0]) {
      case 0:
        $status$$ = 64;
        $cylinder_low$$ = 8;
        $cylinder_high$$ = 0;
        $push_irq$$();
        break;
      case 3:
        $pio_data$$ = new Uint8Array(Math.min($data_port_buffer$$[4], 15));
        $status$$ = 88;
        $pio_data$$[0] = 240;
        $pio_data$$[7] = 8;
        $data_pointer$$ = 0;
        $bytecount$$ = 2;
        $cylinder_low$$ = 8;
        $cylinder_high$$ = 0;
        $push_irq$$();
        break;
      case 18:
        $pio_data$$ = new Uint8Array(Math.min($data_port_buffer$$[4], 36));
        $status$$ = 88;
        $pio_data$$.set([5, 128, 1, 49, 0, 0, 0, 0, 83, 79, 78, 89, 32, 32, 32, 32, 67, 68, 45, 82, 79, 77, 32, 67, 68, 85, 45, 49, 48, 48, 48, 32, 49, 46, 49, 97]);
        $data_pointer$$ = 0;
        $bytecount$$ = 2;
        $push_irq$$();
        break;
      case 30:
        $pio_data$$ = new Uint8Array(0);
        $status$$ = 80;
        $data_pointer$$ = 0;
        $bytecount$$ = 2;
        $push_irq$$();
        break;
      case 37:
        $pio_data$$ = new Uint8Array([$me$$1$$.sector_count >> 24 & 255, $me$$1$$.sector_count >> 16 & 255, $me$$1$$.sector_count >> 8 & 255, $me$$1$$.sector_count & 255, 0, 0, $me$$1$$.sector_size >> 8 & 255, $me$$1$$.sector_size & 255]);
        $status$$ = 88;
        $data_pointer$$ = 0;
        $bytecount$$ = 2;
        $cylinder_low$$ = 8;
        $cylinder_high$$ = 0;
        $push_irq$$();
        break;
      case 40:
        if ($lba_count$$ & 1) {
          var $byte_count$$inline_629$$ = ($data_port_buffer$$[7] << 8 | $data_port_buffer$$[8]) * $me$$1$$.sector_size, $start$$inline_630_start$$inline_644$$ = ($data_port_buffer$$[2] << 24 | $data_port_buffer$$[3] << 16 | $data_port_buffer$$[4] << 8 | $data_port_buffer$$[5]) * $me$$1$$.sector_size;
          $start$$inline_630_start$$inline_644$$ >= $buffer$$9$$.byteLength ? ($status$$ = 255, $push_irq$$()) : ($byte_count$$inline_629$$ = Math.min($byte_count$$inline_629$$, $buffer$$9$$.byteLength - $start$$inline_630_start$$inline_644$$), $status$$ = 128, $me$$1$$.buffer.get($start$$inline_630_start$$inline_644$$, $byte_count$$inline_629$$, function($data$$inline_631$$) {
            var $prdt_start$$inline_632$$ = $prdt_addr$$, $offset$$inline_633$$ = 0;
            do {
              var $addr$$inline_634$$ = $memory$$1$$.read32s($prdt_start$$inline_632$$), $count$$inline_635$$ = $memory$$1$$.read16($prdt_start$$inline_632$$ + 4), $end$$inline_636$$ = $memory$$1$$.read8($prdt_start$$inline_632$$ + 7) & 128;
              $count$$inline_635$$ || ($count$$inline_635$$ = 65536);
              $memory$$1$$.write_blob($data$$inline_631$$.subarray($offset$$inline_633$$, $offset$$inline_633$$ + $count$$inline_635$$), $addr$$inline_634$$);
              $offset$$inline_633$$ += $count$$inline_635$$;
              $prdt_start$$inline_632$$ += 8;
            } while (!$end$$inline_636$$);
            $status$$ = 80;
            $dma_status$$ &= -4;
            $dma_status$$ |= 4;
            $push_irq$$();
            $me$$1$$.IDEDevice$stats.sectors_read += $byte_count$$inline_629$$ / $me$$1$$.sector_size | 0;
            $me$$1$$.IDEDevice$stats.bytes_read += $byte_count$$inline_629$$;
          }));
        } else {
          var $byte_count$$inline_641$$ = ($data_port_buffer$$[7] << 8 | $data_port_buffer$$[8]) * $me$$1$$.sector_size, $max_drq_size$$inline_642_transfered_ata_blocks$$inline_643$$ = ($cylinder_high$$ & 255) << 8 | $cylinder_low$$ & 255, $start$$inline_630_start$$inline_644$$ = ($data_port_buffer$$[2] << 24 | $data_port_buffer$$[3] << 16 | $data_port_buffer$$[4] << 8 | $data_port_buffer$$[5]) * $me$$1$$.sector_size;
          $max_drq_size$$inline_642_transfered_ata_blocks$$inline_643$$ || ($max_drq_size$$inline_642_transfered_ata_blocks$$inline_643$$ = 32768);
          $max_drq_size$$inline_642_transfered_ata_blocks$$inline_643$$ = Math.min($byte_count$$inline_641$$, $max_drq_size$$inline_642_transfered_ata_blocks$$inline_643$$);
          $cylinder_low$$ = $max_drq_size$$inline_642_transfered_ata_blocks$$inline_643$$ & 255;
          $cylinder_high$$ = $max_drq_size$$inline_642_transfered_ata_blocks$$inline_643$$ >> 8 & 255;
          $start$$inline_630_start$$inline_644$$ >= $buffer$$9$$.byteLength ? ($status$$ = 255, $push_irq$$()) : ($byte_count$$inline_641$$ = Math.min($byte_count$$inline_641$$, $buffer$$9$$.byteLength - $start$$inline_630_start$$inline_644$$), $status$$ = 128, $me$$1$$.buffer.get($start$$inline_630_start$$inline_644$$, $byte_count$$inline_641$$, function($data$$inline_645$$) {
            $pio_data$$ = $data$$inline_645$$;
            $status$$ = 88;
            $data_pointer$$ = 0;
            $push_irq$$();
            $me$$1$$.IDEDevice$stats.sectors_read += $byte_count$$inline_641$$ / $me$$1$$.sector_size | 0;
            $me$$1$$.IDEDevice$stats.bytes_read += $byte_count$$inline_641$$;
          }));
        }
        break;
      case 67:
        $pio_data$$ = new Uint8Array(2048);
        $pio_data$$[0] = 0;
        $pio_data$$[1] = 10;
        $pio_data$$[2] = 1;
        $pio_data$$[3] = 1;
        $status$$ = 88;
        $data_pointer$$ = 0;
        $bytecount$$ = 2;
        $cylinder_high$$ = 8;
        $cylinder_low$$ = 0;
        $push_irq$$();
        break;
      case 70:
        $pio_data$$ = new Uint8Array($data_port_buffer$$[8] | $data_port_buffer$$[7] << 8);
        $status$$ = 88;
        $data_pointer$$ = 0;
        $bytecount$$ = 2;
        $push_irq$$();
        break;
      case 74:
        $pio_data$$ = new Uint8Array($data_port_buffer$$[8] | $data_port_buffer$$[7] << 8);
        $status$$ = 88;
        $data_pointer$$ = 0;
        $bytecount$$ = 2;
        $push_irq$$();
        break;
      case 81:
        $pio_data$$ = new Uint8Array(0);
        $status$$ = 80;
        $data_pointer$$ = 0;
        $bytecount$$ = 2;
        $push_irq$$();
        break;
      case 90:
        $push_irq$$();
        $status$$ = 80;
        break;
      default:
        $status$$ = 80;
    }
  }
  function $do_write$$() {
    $status$$ = 80;
    $me$$1$$.buffer.set($write_dest$$, $data_port_buffer$$.subarray(0, $data_port_count$$), function() {
      $push_irq$$();
    });
    $me$$1$$.IDEDevice$stats.sectors_written += $data_port_count$$ / $me$$1$$.sector_size | 0;
    $me$$1$$.IDEDevice$stats.bytes_written += $data_port_count$$;
  }
  function $read_status$$() {
    var $ret$$ = $status$$;
    0 <= $next_status$$ && ($status$$ = $next_status$$, $next_status$$ = -1);
    return $ret$$;
  }
  function $write_control$$($data$$202$$) {
    $device_control$$ = $data$$202$$;
    $data$$202$$ & 4 && ($me$$1$$.is_atapi ? ($status$$ = 81, $sector$$ = $lba_count$$ = $bytecount$$ = 1, $cylinder_low$$ = 20, $cylinder_high$$ = 235) : ($status$$ = 81, $sector$$ = $lba_count$$ = $bytecount$$ = 1, $cylinder_low$$ = 60, $cylinder_high$$ = 195));
  }
  function $allocate_in_buffer$$($size$$42$$) {
    $size$$42$$ > $data_port_buffer$$.length && ($data_port_buffer$$ = new Uint8Array($size$$42$$));
    $data_port_count$$ = $size$$42$$;
    $data_port_current$$ = 0;
  }
  function $read_data_port$$($JSCompiler_inline_result$$8_port_addr$$10_remaining$$inline_647$$) {
    if ($JSCompiler_inline_result$$8_port_addr$$10_remaining$$inline_647$$ === $me$$1$$.ata_port) {
      return $data_pointer$$ < $pio_data$$.length ? (0 !== ($data_pointer$$ + 1) % (512 * $sectors_per_drq$$) && $data_pointer$$ + 1 !== $pio_data$$.length || $push_irq$$(), $cylinder_low$$ ? $cylinder_low$$-- : $cylinder_high$$ && ($cylinder_high$$--, $cylinder_low$$ = 255), $cylinder_low$$ || $cylinder_high$$ || ($JSCompiler_inline_result$$8_port_addr$$10_remaining$$inline_647$$ = $pio_data$$.length - $data_pointer$$ - 1, 65536 <= $JSCompiler_inline_result$$8_port_addr$$10_remaining$$inline_647$$ ? 
      ($cylinder_high$$ = 240, $cylinder_low$$ = 0) : ($cylinder_high$$ = $JSCompiler_inline_result$$8_port_addr$$10_remaining$$inline_647$$ >> 8, $cylinder_low$$ = $JSCompiler_inline_result$$8_port_addr$$10_remaining$$inline_647$$)), $data_pointer$$ + 1 >= $pio_data$$.length && ($status$$ = 80), $JSCompiler_inline_result$$8_port_addr$$10_remaining$$inline_647$$ = $pio_data$$[$data_pointer$$++]) : ($data_pointer$$++, $JSCompiler_inline_result$$8_port_addr$$10_remaining$$inline_647$$ = 0), $JSCompiler_inline_result$$8_port_addr$$10_remaining$$inline_647$$
      ;
    }
    if ($JSCompiler_inline_result$$8_port_addr$$10_remaining$$inline_647$$ === ($me$$1$$.ata_port | 1)) {
      return $lba_count$$ & 255;
    }
    if ($JSCompiler_inline_result$$8_port_addr$$10_remaining$$inline_647$$ === ($me$$1$$.ata_port | 2)) {
      return $bytecount$$ & 255;
    }
    if ($JSCompiler_inline_result$$8_port_addr$$10_remaining$$inline_647$$ === ($me$$1$$.ata_port | 3)) {
      return $sector$$ & 255;
    }
  }
  function $write_data_port$$($data$$205$$, $port_addr$$11$$) {
    $port_addr$$11$$ === $me$$1$$.ata_port ? $data_port_current$$ >= $data_port_count$$ || ($data_port_buffer$$[$data_port_current$$++] = $data$$205$$, 0 === $data_port_current$$ % (512 * $sectors_per_drq$$) && $push_irq$$(), $data_port_current$$ === $data_port_count$$ && $data_port_callback$$()) : $port_addr$$11$$ === ($me$$1$$.ata_port | 1) ? $lba_count$$ = ($lba_count$$ << 8 | $data$$205$$) & 65535 : $port_addr$$11$$ === ($me$$1$$.ata_port | 2) ? $bytecount$$ = ($bytecount$$ << 8 | $data$$205$$) & 
    65535 : $port_addr$$11$$ === ($me$$1$$.ata_port | 3) && ($sector$$ = ($sector$$ << 8 | $data$$205$$) & 65535);
  }
  function $get_chs$$() {
    return(($cylinder_low$$ & 255 | $cylinder_high$$ << 8 & 65280) * $me$$1$$.head_count + $head$$) * $me$$1$$.IDEDevice$sectors_per_track + ($sector$$ & 255) - 1;
  }
  function $get_lba28$$() {
    return $sector$$ & 255 | $cylinder_low$$ << 8 & 65280 | $cylinder_high$$ << 16 & 16711680;
  }
  function $get_lba48$$() {
    return($sector$$ & 255 | $cylinder_low$$ << 8 & 65280 | $cylinder_high$$ << 16 & 16711680 | $sector$$ >> 8 << 24 & 4278190080) >>> 0;
  }
  function $create_identify_packet$$() {
    $data_pointer$$ = 0;
    $drive_head$$ & 16 ? $pio_data$$ = new Uint8Array(0) : ($pio_data$$ = new Uint8Array([64, $me$$1$$.is_atapi ? 133 : 0, $me$$1$$.cylinder_count, $me$$1$$.cylinder_count >> 8, 0, 0, $me$$1$$.head_count, $me$$1$$.head_count >> 8, 0, 0, 0, 0, $me$$1$$.IDEDevice$sectors_per_track, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0, 2, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 
    32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 255, 0, 1, 0, 0, 3, 0, 0, 0, 2, 0, 2, 7, 0, $me$$1$$.cylinder_count, $me$$1$$.cylinder_count >> 8, $me$$1$$.head_count, $me$$1$$.head_count >> 8, $me$$1$$.IDEDevice$sectors_per_track, 0, $me$$1$$.sector_count & 255, $me$$1$$.sector_count >> 8 & 255, $me$$1$$.sector_count >> 16 & 255, $me$$1$$.sector_count >> 24 & 255, 0, 0, $me$$1$$.sector_count & 255, $me$$1$$.sector_count >> 8 & 255, $me$$1$$.sector_count >> 16 & 255, $me$$1$$.sector_count >> 
    24 & 255, 0, 0, 0, 4, 0, 0, 30, 0, 30, 0, 30, 0, 30, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 126, 0, 0, 0, 0, 0, 0, 116, 0, 64, 0, 64, 0, 116, 0, 64, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 96, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, $me$$1$$.sector_count & 255, $me$$1$$.sector_count >> 8 & 255, $me$$1$$.sector_count >> 16 & 255, $me$$1$$.sector_count >> 24 & 255]), 16383 < $me$$1$$.cylinder_count && ($pio_data$$[2] = $pio_data$$[108] = 255, $pio_data$$[3] = $pio_data$$[109] = 
    63));
  }
  var $pic$$ = $cpu$$1034$$.devices.pic, $memory$$1$$ = $cpu$$1034$$.memory, $me$$1$$ = this;
  0 === $nr$$ ? (this.ata_port = 496, this.irq = 14, this.pci_id = 240) : (this.ata_port = 496, this.irq = 14, this.pci_id = 248);
  this.ata_port_high = this.ata_port | 516;
  this.io = $cpu$$1034$$.io;
  this.pic = $cpu$$1034$$.devices.pic;
  this.pci = $cpu$$1034$$.devices.pci;
  this.sector_size = $is_cd$$ ? 2048 : 512;
  this.buffer = $buffer$$9$$;
  this.is_atapi = $is_cd$$;
  $buffer$$9$$ ? (this.sector_count = $me$$1$$.buffer.byteLength / this.sector_size, this.sector_size !== (this.sector_size | 0) && (this.sector_count = Math.ceil(this.sector_count)), $is_cd$$ ? (this.head_count = 1, this.IDEDevice$sectors_per_track = 0) : (this.head_count = 255, this.IDEDevice$sectors_per_track = 63), this.cylinder_count = this.sector_count / (this.head_count + 1) / (this.IDEDevice$sectors_per_track + 1), this.cylinder_count !== (this.cylinder_count | 0) && (this.cylinder_count = 
  Math.ceil(this.cylinder_count))) : this.cylinder_count = this.IDEDevice$sectors_per_track = this.head_count = this.sector_count = 0;
  this.IDEDevice$stats = {sectors_read:0, sectors_written:0, bytes_read:0, bytes_written:0};
  this.pci_space = [134, 128, 32, 58, 5, 0, 160, 2, 0, 143, 1, 1, 0, 0, 0, 0, this.ata_port & 255 | 1, this.ata_port >> 8, 0, 0, this.ata_port_high & 255 | 1, this.ata_port_high >> 8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 192, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 67, 16, 212, 130, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, this.irq, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  this.pci_bars = [{size:8}, {size:4}, !1, !1, {size:16}];
  $cpu$$1034$$.devices.pci.register_device(this);
  this.io.register_read(this.ata_port | 7, $read_status$$);
  this.io.register_read(this.ata_port_high | 2, $read_status$$);
  this.io.register_write(this.ata_port | 7, $write_control$$);
  this.io.register_write(this.ata_port_high | 2, $write_control$$);
  var $device_control$$ = 2, $data_pointer$$ = 0, $pio_data$$ = new Uint8Array(0), $is_lba$$ = 0, $bytecount$$ = 0, $sector$$ = 0, $lba_count$$ = 0, $cylinder_low$$ = 0, $cylinder_high$$ = 0, $head$$ = 0, $drive_head$$ = 0, $status$$ = 80, $sectors_per_drq$$ = 1, $write_dest$$, $data_port_count$$ = 0, $data_port_current$$ = 0, $data_port_buffer$$ = [], $data_port_callback$$, $next_status$$ = -1;
  this.io.register_read($me$$1$$.ata_port | 0, $read_data_port$$);
  this.io.register_read($me$$1$$.ata_port | 1, $read_data_port$$);
  this.io.register_read($me$$1$$.ata_port | 2, $read_data_port$$);
  this.io.register_read($me$$1$$.ata_port | 3, $read_data_port$$);
  this.io.register_read($me$$1$$.ata_port | 4, function() {
    return $cylinder_low$$ & 255;
  });
  this.io.register_read($me$$1$$.ata_port | 5, function() {
    return $cylinder_high$$ & 255;
  });
  this.io.register_read($me$$1$$.ata_port | 6, function() {
    return $drive_head$$;
  });
  this.io.register_write($me$$1$$.ata_port | 0, $write_data_port$$);
  this.io.register_write($me$$1$$.ata_port | 1, $write_data_port$$);
  this.io.register_write($me$$1$$.ata_port | 2, $write_data_port$$);
  this.io.register_write($me$$1$$.ata_port | 3, $write_data_port$$);
  this.io.register_write($me$$1$$.ata_port | 4, function($data$$212$$) {
    $cylinder_low$$ = ($cylinder_low$$ << 8 | $data$$212$$) & 65535;
  });
  this.io.register_write($me$$1$$.ata_port | 5, function($data$$213$$) {
    $cylinder_high$$ = ($cylinder_high$$ << 8 | $data$$213$$) & 65535;
  });
  this.io.register_write($me$$1$$.ata_port | 6, function($data$$214$$) {
    $data$$214$$ & 16 || ($drive_head$$ = $data$$214$$, $is_lba$$ = $data$$214$$ >> 6 & 1, $head$$ = $data$$214$$ & 15);
  });
  this.io.register_write($me$$1$$.ata_port | 7, function($cmd$$6_offset$$inline_680$$) {
    switch($cmd$$6_offset$$inline_680$$) {
      case 0:
        $push_irq$$();
        $status$$ = 80;
        break;
      case 8:
        $data_pointer$$ = 0;
        $pio_data$$ = new Uint8Array(0);
        $status$$ = 80;
        $push_irq$$();
        break;
      case 16:
        $push_irq$$();
        break;
      case 39:
        $push_irq$$();
        $pio_data$$ = new Uint8Array([0, 0, 0, 0, $me$$1$$.buffer.byteLength & 255, $me$$1$$.buffer.byteLength >> 8 & 255, $me$$1$$.buffer.byteLength >> 16 & 255, $me$$1$$.buffer.byteLength >> 24 & 255, 0, 0, 0, 0]);
        $status$$ = 88;
        break;
      case 32:
      ;
      case 41:
      ;
      case 36:
      ;
      case 196:
        if (32 === $cmd$$6_offset$$inline_680$$ || 196 === $cmd$$6_offset$$inline_680$$) {
          var $byte_count$$inline_659_count$$inline_650_start$$inline_665_start$$inline_676$$ = $bytecount$$ & 255, $lba$$inline_651_prd_addr$$inline_681$$ = $is_lba$$ ? $get_lba28$$() : $get_chs$$();
          0 === $byte_count$$inline_659_count$$inline_650_start$$inline_665_start$$inline_676$$ && ($byte_count$$inline_659_count$$inline_650_start$$inline_665_start$$inline_676$$ = 256);
        } else {
          if (36 === $cmd$$6_offset$$inline_680$$ || 41 === $cmd$$6_offset$$inline_680$$) {
            $byte_count$$inline_659_count$$inline_650_start$$inline_665_start$$inline_676$$ = $bytecount$$, $lba$$inline_651_prd_addr$$inline_681$$ = $get_lba48$$(), 0 === $byte_count$$inline_659_count$$inline_650_start$$inline_665_start$$inline_676$$ && ($byte_count$$inline_659_count$$inline_650_start$$inline_665_start$$inline_676$$ = 65536);
          }
        }
        var $byte_count$$inline_652$$ = $byte_count$$inline_659_count$$inline_650_start$$inline_665_start$$inline_676$$ * $me$$1$$.sector_size, $byte_count$$inline_675_count$$inline_657_count$$inline_662_start$$inline_653$$ = $lba$$inline_651_prd_addr$$inline_681$$ * $me$$1$$.sector_size;
        $cylinder_low$$ += $byte_count$$inline_659_count$$inline_650_start$$inline_665_start$$inline_676$$;
        $byte_count$$inline_675_count$$inline_657_count$$inline_662_start$$inline_653$$ + $byte_count$$inline_652$$ > $buffer$$9$$.byteLength ? ($status$$ = 255, $push_irq$$()) : ($status$$ = 128, $me$$1$$.buffer.get($byte_count$$inline_675_count$$inline_657_count$$inline_662_start$$inline_653$$, $byte_count$$inline_652$$, function($data$$inline_654$$) {
          $pio_data$$ = $data$$inline_654$$;
          $status$$ = 88;
          $data_pointer$$ = 0;
          $push_irq$$();
          $me$$1$$.IDEDevice$stats.sectors_read += $byte_count$$inline_652$$ / $me$$1$$.sector_size | 0;
          $me$$1$$.IDEDevice$stats.bytes_read += $byte_count$$inline_652$$;
        }));
        break;
      case 48:
      ;
      case 52:
      ;
      case 57:
        if (48 === $cmd$$6_offset$$inline_680$$) {
          var $byte_count$$inline_675_count$$inline_657_count$$inline_662_start$$inline_653$$ = $bytecount$$ & 255, $count$$inline_673_lba$$inline_658_prdt_start$$inline_677_start$$inline_660$$ = $is_lba$$ ? $get_lba28$$() : $get_chs$$();
          0 === $byte_count$$inline_675_count$$inline_657_count$$inline_662_start$$inline_653$$ && ($byte_count$$inline_675_count$$inline_657_count$$inline_662_start$$inline_653$$ = 256);
        } else {
          if (52 === $cmd$$6_offset$$inline_680$$ || 57 === $cmd$$6_offset$$inline_680$$) {
            $byte_count$$inline_675_count$$inline_657_count$$inline_662_start$$inline_653$$ = $bytecount$$, $count$$inline_673_lba$$inline_658_prdt_start$$inline_677_start$$inline_660$$ = $get_lba48$$(), 0 === $byte_count$$inline_675_count$$inline_657_count$$inline_662_start$$inline_653$$ && ($byte_count$$inline_675_count$$inline_657_count$$inline_662_start$$inline_653$$ = 65536);
          }
        }
        $byte_count$$inline_659_count$$inline_650_start$$inline_665_start$$inline_676$$ = $byte_count$$inline_675_count$$inline_657_count$$inline_662_start$$inline_653$$ * $me$$1$$.sector_size;
        $count$$inline_673_lba$$inline_658_prdt_start$$inline_677_start$$inline_660$$ = $count$$inline_673_lba$$inline_658_prdt_start$$inline_677_start$$inline_660$$ * $me$$1$$.sector_size;
        $cylinder_low$$ += $byte_count$$inline_675_count$$inline_657_count$$inline_662_start$$inline_653$$;
        $count$$inline_673_lba$$inline_658_prdt_start$$inline_677_start$$inline_660$$ + $byte_count$$inline_659_count$$inline_650_start$$inline_665_start$$inline_676$$ > $buffer$$9$$.byteLength ? $status$$ = 255 : ($status$$ = 80, $next_status$$ = 88, $allocate_in_buffer$$($byte_count$$inline_659_count$$inline_650_start$$inline_665_start$$inline_676$$), $write_dest$$ = $count$$inline_673_lba$$inline_658_prdt_start$$inline_677_start$$inline_660$$, $data_port_callback$$ = $do_write$$);
        $push_irq$$();
        break;
      case 144:
        $push_irq$$();
        $lba_count$$ = 257;
        $status$$ = 80;
        break;
      case 145:
        $push_irq$$();
        break;
      case 160:
        $me$$1$$.is_atapi && ($status$$ = 88, $allocate_in_buffer$$(12), $data_port_callback$$ = $atapi_handle$$, $bytecount$$ = 1, $push_irq$$());
        break;
      case 161:
        $me$$1$$.is_atapi ? ($create_identify_packet$$(), $status$$ = 88) : $status$$ = 80;
        $push_irq$$();
        break;
      case 198:
        $sectors_per_drq$$ = $bytecount$$;
        $push_irq$$();
        break;
      case 200:
        var $byte_count$$inline_675_count$$inline_657_count$$inline_662_start$$inline_653$$ = $bytecount$$ & 255, $byte_count$$inline_664$$ = $byte_count$$inline_675_count$$inline_657_count$$inline_662_start$$inline_653$$ * $me$$1$$.sector_size, $byte_count$$inline_659_count$$inline_650_start$$inline_665_start$$inline_676$$ = $get_lba28$$() * $me$$1$$.sector_size;
        $cylinder_low$$ += $byte_count$$inline_675_count$$inline_657_count$$inline_662_start$$inline_653$$;
        $byte_count$$inline_659_count$$inline_650_start$$inline_665_start$$inline_676$$ + $byte_count$$inline_664$$ > $buffer$$9$$.byteLength ? ($status$$ = 255, $push_irq$$()) : ($status$$ = 128, $dma_status$$ |= 1, $me$$1$$.buffer.get($byte_count$$inline_659_count$$inline_650_start$$inline_665_start$$inline_676$$, $byte_count$$inline_664$$, function($data$$inline_666$$) {
          var $prdt_start$$inline_667$$ = $prdt_addr$$, $offset$$inline_668$$ = 0;
          do {
            var $addr$$inline_669$$ = $memory$$1$$.read32s($prdt_start$$inline_667$$), $count$$inline_670$$ = $memory$$1$$.read16($prdt_start$$inline_667$$ + 4), $end$$inline_671$$ = $memory$$1$$.read8($prdt_start$$inline_667$$ + 7) & 128;
            $count$$inline_670$$ || ($count$$inline_670$$ = 65536);
            $memory$$1$$.write_blob($data$$inline_666$$.subarray($offset$$inline_668$$, $offset$$inline_668$$ + $count$$inline_670$$), $addr$$inline_669$$);
            $offset$$inline_668$$ += $count$$inline_670$$;
            $prdt_start$$inline_667$$ += 8;
          } while (!$end$$inline_671$$);
          $status$$ = 80;
          $dma_status$$ &= -4;
          $dma_status$$ |= 4;
          $push_irq$$();
          $me$$1$$.IDEDevice$stats.sectors_read += $byte_count$$inline_664$$ / $me$$1$$.sector_size | 0;
          $me$$1$$.IDEDevice$stats.bytes_read += $byte_count$$inline_664$$;
        }));
        break;
      case 202:
        $count$$inline_673_lba$$inline_658_prdt_start$$inline_677_start$$inline_660$$ = $bytecount$$ & 255;
        $byte_count$$inline_675_count$$inline_657_count$$inline_662_start$$inline_653$$ = $count$$inline_673_lba$$inline_658_prdt_start$$inline_677_start$$inline_660$$ * $me$$1$$.sector_size;
        $byte_count$$inline_659_count$$inline_650_start$$inline_665_start$$inline_676$$ = $get_lba28$$() * $me$$1$$.sector_size;
        $cylinder_low$$ += $count$$inline_673_lba$$inline_658_prdt_start$$inline_677_start$$inline_660$$;
        if ($byte_count$$inline_659_count$$inline_650_start$$inline_665_start$$inline_676$$ + $byte_count$$inline_675_count$$inline_657_count$$inline_662_start$$inline_653$$ > $buffer$$9$$.byteLength) {
          $status$$ = 255, $push_irq$$();
        } else {
          $status$$ = 128;
          $dma_status$$ |= 1;
          var $count$$inline_673_lba$$inline_658_prdt_start$$inline_677_start$$inline_660$$ = $prdt_addr$$, $prdt_count$$inline_678$$ = 0, $prdt_write_count$$inline_679$$ = 0;
          $cmd$$6_offset$$inline_680$$ = 0;
          do {
            var $lba$$inline_651_prd_addr$$inline_681$$ = $memory$$1$$.read32s($count$$inline_673_lba$$inline_658_prdt_start$$inline_677_start$$inline_660$$), $prd_count$$inline_682$$ = $memory$$1$$.read16($count$$inline_673_lba$$inline_658_prdt_start$$inline_677_start$$inline_660$$ + 4), $end$$inline_683$$ = $memory$$1$$.read8($count$$inline_673_lba$$inline_658_prdt_start$$inline_677_start$$inline_660$$ + 7) & 128;
            $prd_count$$inline_682$$ || ($prd_count$$inline_682$$ = 65536);
            $me$$1$$.buffer.set($byte_count$$inline_659_count$$inline_650_start$$inline_665_start$$inline_676$$ + $cmd$$6_offset$$inline_680$$, $memory$$1$$.mem8.subarray($lba$$inline_651_prd_addr$$inline_681$$, $lba$$inline_651_prd_addr$$inline_681$$ + $prd_count$$inline_682$$), function() {
              $prdt_write_count$$inline_679$$++;
              $prdt_write_count$$inline_679$$ === $prdt_count$$inline_678$$ && ($status$$ = 80, $push_irq$$(), $dma_status$$ &= -4, $dma_status$$ |= 4);
            });
            $cmd$$6_offset$$inline_680$$ += $prd_count$$inline_682$$;
            $count$$inline_673_lba$$inline_658_prdt_start$$inline_677_start$$inline_660$$ += 8;
            $prdt_count$$inline_678$$++;
          } while (!$end$$inline_683$$);
          $prdt_write_count$$inline_679$$ === $prdt_count$$inline_678$$ && ($status$$ = 80, $push_irq$$(), $dma_status$$ &= -4, $dma_status$$ |= 4);
          $me$$1$$.IDEDevice$stats.sectors_written += $byte_count$$inline_675_count$$inline_657_count$$inline_662_start$$inline_653$$ / $me$$1$$.sector_size | 0;
          $me$$1$$.IDEDevice$stats.bytes_written += $byte_count$$inline_675_count$$inline_657_count$$inline_662_start$$inline_653$$;
        }
        break;
      case 225:
        $push_irq$$();
        break;
      case 236:
        if ($me$$1$$.is_atapi) {
          break;
        }
        $create_identify_packet$$();
        $status$$ = 88;
        $push_irq$$();
        break;
      case 234:
        $push_irq$$();
        break;
      case 239:
        $push_irq$$();
        break;
      default:
        $lba_count$$ = 4;
    }
  });
  var $prdt_addr$$ = 0, $dma_status$$;
  this.io.register_read(49156, function dma_read_addr0() {
    return $prdt_addr$$ & 255;
  });
  this.io.register_read(49157, function dma_read_addr1() {
    return $prdt_addr$$ >> 8 & 255;
  });
  this.io.register_read(49158, function dma_read_addr2() {
    return $prdt_addr$$ >> 16 & 255;
  });
  this.io.register_read(49159, function dma_read_addr3() {
    return $prdt_addr$$ >> 24 & 255;
  });
  this.io.register_write(49156, function dma_set_addr0($data$$208$$) {
    $prdt_addr$$ = $prdt_addr$$ & -256 | $data$$208$$;
  });
  this.io.register_write(49157, function dma_set_addr1($data$$209$$) {
    $prdt_addr$$ = $prdt_addr$$ & -65281 | $data$$209$$ << 8;
  });
  this.io.register_write(49158, function dma_set_addr2($data$$210$$) {
    $prdt_addr$$ = $prdt_addr$$ & -16711681 | $data$$210$$ << 16;
  });
  this.io.register_write(49159, function dma_set_addr3($data$$211$$) {
    $prdt_addr$$ = $prdt_addr$$ & 16777215 | $data$$211$$ << 24;
  });
  this.io.register_read(49154, function dma_read_status() {
    return $dma_status$$;
  });
  this.io.register_write(49154, function dma_write_status($value$$47$$) {
    $dma_status$$ &= ~$value$$47$$;
  });
  this.io.register_read(49152, function dma_read_command() {
    return 1;
  });
  this.io.register_write(49152, function dma_write_command($value$$48$$) {
    $value$$48$$ & 1 && $push_irq$$();
  });
}
;function $PCI$$($cpu$$1035_io$$1$$) {
  function $pci_write_byte$$($bar_nr_byte_pos$$) {
    var $bars_bdf$$1_device$$3$$ = $pci_addr$$[2] << 8 | $pci_addr$$[1], $addr$$95$$ = $pci_addr$$[0] & 252, $space$$ = $device_spaces$$[$bars_bdf$$1_device$$3$$], $bars_bdf$$1_device$$3$$ = $devices$$1$$[$bars_bdf$$1_device$$3$$];
    $space$$ && 3 === $bar_nr_byte_pos$$ && 16 <= $addr$$95$$ && 40 > $addr$$95$$ && ($bar_nr_byte_pos$$ = $addr$$95$$ - 16 >> 2, $bars_bdf$$1_device$$3$$ = $bars_bdf$$1_device$$3$$.pci_bars, $bar_nr_byte_pos$$ < $bars_bdf$$1_device$$3$$.length && $bars_bdf$$1_device$$3$$[$bar_nr_byte_pos$$] || ($space$$[$addr$$95$$ >> 2] = 0));
  }
  $cpu$$1035_io$$1$$ = $cpu$$1035_io$$1$$.io;
  var $pci_addr$$ = new Uint8Array(4), $pci_response$$ = new Uint8Array(4), $pci_status$$ = new Uint8Array(4);
  new Int32Array($pci_addr$$.buffer);
  var $pci_response32$$ = new Int32Array($pci_response$$.buffer), $pci_status32$$ = new Int32Array($pci_status$$.buffer), $device_spaces$$ = Array(65536), $devices$$1$$ = Array(65536);
  $cpu$$1035_io$$1$$.register_write(3324, function() {
    $pci_write_byte$$(0);
  });
  $cpu$$1035_io$$1$$.register_write(3325, function() {
    $pci_write_byte$$(1);
  });
  $cpu$$1035_io$$1$$.register_write(3326, function() {
    $pci_write_byte$$(2);
  });
  $cpu$$1035_io$$1$$.register_write(3327, function() {
    $pci_write_byte$$(3);
  });
  $cpu$$1035_io$$1$$.register_read(3324, function() {
    return $pci_response$$[0];
  });
  $cpu$$1035_io$$1$$.register_read(3325, function() {
    return $pci_response$$[1];
  });
  $cpu$$1035_io$$1$$.register_read(3326, function() {
    return $pci_response$$[2];
  });
  $cpu$$1035_io$$1$$.register_read(3327, function() {
    return $pci_response$$[3];
  });
  $cpu$$1035_io$$1$$.register_read(3320, function() {
    return $pci_status$$[0];
  });
  $cpu$$1035_io$$1$$.register_read(3321, function() {
    return $pci_status$$[1];
  });
  $cpu$$1035_io$$1$$.register_read(3322, function() {
    return $pci_status$$[2];
  });
  $cpu$$1035_io$$1$$.register_read(3323, function() {
    return $pci_status$$[3];
  });
  $cpu$$1035_io$$1$$.register_write(3320, function($out_byte$$11$$) {
    $pci_addr$$[0] = $out_byte$$11$$;
  });
  $cpu$$1035_io$$1$$.register_write(3321, function($out_byte$$12$$) {
    $pci_addr$$[1] = $out_byte$$12$$;
  });
  $cpu$$1035_io$$1$$.register_write(3322, function($out_byte$$13$$) {
    $pci_addr$$[2] = $out_byte$$13$$;
  });
  $cpu$$1035_io$$1$$.register_write(3323, function($addr$$inline_687_out_byte$$14$$) {
    $pci_addr$$[3] = $addr$$inline_687_out_byte$$14$$;
    $addr$$inline_687_out_byte$$14$$ = $pci_addr$$[0] & 252;
    var $device$$inline_688$$ = $device_spaces$$[$pci_addr$$[2] << 8 | $pci_addr$$[1]];
    void 0 !== $device$$inline_688$$ ? ($pci_status32$$[0] = -2147483648, $pci_response32$$[0] = $addr$$inline_687_out_byte$$14$$ < $device$$inline_688$$.byteLength ? $device$$inline_688$$[$addr$$inline_687_out_byte$$14$$ >> 2] : -1) : ($pci_response32$$[0] = -1, $pci_status32$$[0] = 0);
  });
  this.register_device = function $this$register_device$($device$$4$$) {
    var $device_id$$ = $device$$4$$.pci_id;
    $device_spaces$$[$device_id$$] = new Int32Array((new Uint8Array($device$$4$$.pci_space)).buffer);
    $devices$$1$$[$device_id$$] = $device$$4$$;
  };
  this.register_device({pci_id:0, pci_space:[134, 128, 55, 18, 0, 0, 0, 0, 2, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], pci_bars:[]});
  this.register_device({pci_id:8, pci_space:[134, 128, 0, 112, 7, 0, 0, 2, 0, 0, 1, 6, 0, 0, 128, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], pci_bars:[]});
}
;function $FloppyController$$($cpu$$1036$$, $fda_image$$) {
  this.io = $cpu$$1036$$.io;
  this.pic = $cpu$$1036$$.devices.pic;
  this.dma = $cpu$$1036$$.devices.dma;
  this.bytes_expecting = 0;
  this.receiving_command = new Uint8Array(10);
  this.receiving_index = 0;
  this.next_command = null;
  this.response_data = new Uint8Array(10);
  this.floppy_size = this.response_length = this.response_index = 0;
  this.fda_image = $fda_image$$;
  this.last_cylinder = 0;
  if ($fda_image$$) {
    this.floppy_size = $fda_image$$.byteLength;
    var $sectors_per_track$$, $floppy_type_number_of_heads$$;
    if (($floppy_type_number_of_heads$$ = {160:{type:1, tracks:40, sectors:8, heads:1}, 180:{type:1, tracks:40, sectors:9, heads:1}, 200:{type:1, tracks:40, sectors:10, heads:1}, 320:{type:1, tracks:40, sectors:8, heads:2}, 360:{type:1, tracks:40, sectors:9, heads:2}, 400:{type:1, tracks:40, sectors:10, heads:2}, 720:{type:3, tracks:80, sectors:9, heads:2}, 1200:{type:2, tracks:80, sectors:15, heads:2}, 1440:{type:4, tracks:80, sectors:18, heads:2}, 1722:{type:5, tracks:82, sectors:21, heads:2}, 
    2880:{type:5, tracks:80, sectors:36, heads:2}}[this.floppy_size >> 10]) && 0 === (this.floppy_size & 1023)) {
      this.type = $floppy_type_number_of_heads$$.type, $sectors_per_track$$ = $floppy_type_number_of_heads$$.sectors, $floppy_type_number_of_heads$$ = $floppy_type_number_of_heads$$.heads;
    } else {
      throw "Unknown floppy size: " + ($fda_image$$.byteLength ? $fda_image$$.byteLength.toString(16).toUpperCase() : String.pad0());
    }
    this.FloppyController$sectors_per_track = $sectors_per_track$$;
    this.number_of_heads = $floppy_type_number_of_heads$$;
    this.io.register_read(1008, this.port3F0_read, this);
    this.io.register_read(1010, this.port3F2_read, this);
    this.io.register_read(1012, this.port3F4_read, this);
    this.io.register_read(1013, this.port3F5_read, this);
    this.io.register_read(1015, this.port3F7_read, this);
    this.io.register_write(1010, this.port3F2_write, this);
    this.io.register_write(1013, this.port3F5_write, this);
  } else {
    this.type = 4;
  }
}
$JSCompiler_prototypeAlias$$ = $FloppyController$$.prototype;
$JSCompiler_prototypeAlias$$.port3F0_read = function $$JSCompiler_prototypeAlias$$$port3F0_read$() {
  return 0;
};
$JSCompiler_prototypeAlias$$.port3F4_read = function $$JSCompiler_prototypeAlias$$$port3F4_read$() {
  var $return_byte$$ = 128;
  this.response_index < this.response_length && ($return_byte$$ |= 80);
  0 === ($dor$$ & 8) && ($return_byte$$ |= 32);
  return $return_byte$$;
};
$JSCompiler_prototypeAlias$$.port3F7_read = function $$JSCompiler_prototypeAlias$$$port3F7_read$() {
  return 0;
};
$JSCompiler_prototypeAlias$$.port3F5_read = function $$JSCompiler_prototypeAlias$$$port3F5_read$() {
  return this.response_index < this.response_length ? this.response_data[this.response_index++] : 255;
};
$JSCompiler_prototypeAlias$$.port3F5_write = function $$JSCompiler_prototypeAlias$$$port3F5_write$($reg_byte$$) {
  if (0 < this.bytes_expecting) {
    this.receiving_command[this.receiving_index++] = $reg_byte$$, this.bytes_expecting--, 0 === this.bytes_expecting && this.next_command.call(this, this.receiving_command);
  } else {
    switch($reg_byte$$) {
      case 3:
        this.next_command = this.fix_drive_data;
        this.bytes_expecting = 2;
        break;
      case 4:
        this.next_command = this.check_drive_status;
        this.bytes_expecting = 1;
        break;
      case 5:
      ;
      case 197:
        this.next_command = function $this$next_command$($args$$) {
          this.do_sector(!0, $args$$);
        };
        this.bytes_expecting = 8;
        break;
      case 230:
        this.next_command = function $this$next_command$($args$$1$$) {
          this.do_sector(!1, $args$$1$$);
        };
        this.bytes_expecting = 8;
        break;
      case 7:
        this.next_command = this.calibrate;
        this.bytes_expecting = 1;
        break;
      case 8:
        this.check_interrupt_status();
        break;
      case 74:
        this.next_command = this.read_sector_id;
        this.bytes_expecting = 1;
        break;
      case 15:
        this.bytes_expecting = 2;
        this.next_command = this.FloppyController_prototype$seek;
        break;
      case 14:
        this.response_data[0] = 128, this.response_index = 0, this.response_length = 1, this.bytes_expecting = 0;
    }
    this.receiving_index = 0;
  }
};
var $dor$$ = 0;
$JSCompiler_prototypeAlias$$ = $FloppyController$$.prototype;
$JSCompiler_prototypeAlias$$.port3F2_read = function $$JSCompiler_prototypeAlias$$$port3F2_read$() {
  return $dor$$;
};
$JSCompiler_prototypeAlias$$.port3F2_write = function $$JSCompiler_prototypeAlias$$$port3F2_write$($value$$50$$) {
  4 === ($value$$50$$ & 4) && 0 === ($dor$$ & 4) && this.pic.push_irq(6);
  $dor$$ = $value$$50$$;
};
$JSCompiler_prototypeAlias$$.check_drive_status = function $$JSCompiler_prototypeAlias$$$check_drive_status$() {
  this.response_index = 0;
  this.response_length = 1;
  this.response_data[0] = 32;
};
$JSCompiler_prototypeAlias$$.FloppyController_prototype$seek = function $$JSCompiler_prototypeAlias$$$FloppyController_prototype$seek$($args$$3$$) {
  this.last_cylinder = $args$$3$$[1];
  $dor$$ & 8 && this.pic.push_irq(6);
};
$JSCompiler_prototypeAlias$$.calibrate = function $$JSCompiler_prototypeAlias$$$calibrate$() {
  $dor$$ & 8 && this.pic.push_irq(6);
};
$JSCompiler_prototypeAlias$$.check_interrupt_status = function $$JSCompiler_prototypeAlias$$$check_interrupt_status$() {
  this.response_index = 0;
  this.response_length = 2;
  this.response_data[0] = 32;
  this.response_data[1] = this.last_cylinder;
};
$JSCompiler_prototypeAlias$$.do_sector = function $$JSCompiler_prototypeAlias$$$do_sector$($is_write$$, $args$$5$$) {
  var $head$$1$$ = $args$$5$$[2], $cylinder$$ = $args$$5$$[1], $sector$$1$$ = $args$$5$$[3], $read_offset$$ = (($head$$1$$ + this.number_of_heads * $cylinder$$) * this.FloppyController$sectors_per_track + $sector$$1$$ - 1) * (128 << $args$$5$$[4]);
  $is_write$$ ? this.dma.do_write(this.fda_image, $read_offset$$, this.done.bind(this, $args$$5$$, $cylinder$$, $head$$1$$, $sector$$1$$)) : this.dma.do_read(this.fda_image, $read_offset$$, this.done.bind(this, $args$$5$$, $cylinder$$, $head$$1$$, $sector$$1$$));
};
$JSCompiler_prototypeAlias$$.done = function $$JSCompiler_prototypeAlias$$$done$($cylinder$$1$$, $args$$6$$, $head$$2$$, $sector$$2$$, $error$$3$$) {
  $error$$3$$ || ($sector$$2$$++, $sector$$2$$ > this.FloppyController$sectors_per_track && ($sector$$2$$ = 1, $head$$2$$++, $head$$2$$ >= this.number_of_heads && ($head$$2$$ = 0, $cylinder$$1$$++)), this.last_cylinder = $cylinder$$1$$, this.response_index = 0, this.response_length = 7, this.response_data[0] = $head$$2$$ << 2 | 32, this.response_data[1] = 0, this.response_data[2] = 0, this.response_data[3] = $cylinder$$1$$, this.response_data[4] = $head$$2$$, this.response_data[5] = $sector$$2$$, 
  this.response_data[6] = $args$$6$$[4], $dor$$ & 8 && this.pic.push_irq(6));
};
$JSCompiler_prototypeAlias$$.fix_drive_data = function $$JSCompiler_prototypeAlias$$$fix_drive_data$() {
};
$JSCompiler_prototypeAlias$$.read_sector_id = function $$JSCompiler_prototypeAlias$$$read_sector_id$() {
  this.response_index = 0;
  this.response_length = 7;
  this.response_data[0] = 0;
  this.response_data[1] = 0;
  this.response_data[2] = 0;
  this.response_data[3] = 0;
  this.response_data[4] = 0;
  this.response_data[5] = 0;
  this.response_data[6] = 0;
  $dor$$ & 8 && this.pic.push_irq(6);
};
function $Memory$$($buffer$$10$$, $memory_size$$1$$) {
  var $mem8$$ = new Uint8Array($buffer$$10$$), $mem16$$ = new Uint16Array($buffer$$10$$), $mem32s$$ = new Int32Array($buffer$$10$$);
  this.mem8 = $mem8$$;
  this.mem16 = $mem16$$;
  this.mem32s = $mem32s$$;
  this.buffer = $buffer$$10$$;
  this.size = $memory_size$$1$$;
  this.memory_map_registered = new Uint8Array(262144);
  this.memory_map_read8 = [];
  this.memory_map_write8 = [];
  this.memory_map_read32 = [];
  this.memory_map_write32 = [];
}
$JSCompiler_prototypeAlias$$ = $Memory$$.prototype;
$JSCompiler_prototypeAlias$$.mmap_read8 = function $$JSCompiler_prototypeAlias$$$mmap_read8$($addr$$98$$) {
  return this.memory_map_read8[$addr$$98$$ >>> 14]($addr$$98$$);
};
$JSCompiler_prototypeAlias$$.mmap_write8 = function $$JSCompiler_prototypeAlias$$$mmap_write8$($addr$$99$$, $value$$52$$) {
  this.memory_map_write8[$addr$$99$$ >>> 14]($addr$$99$$, $value$$52$$);
};
$JSCompiler_prototypeAlias$$.mmap_read16 = function $$JSCompiler_prototypeAlias$$$mmap_read16$($addr$$100$$) {
  return this.mmap_read8($addr$$100$$) | this.mmap_read8($addr$$100$$ + 1) << 8;
};
$JSCompiler_prototypeAlias$$.mmap_write16 = function $$JSCompiler_prototypeAlias$$$mmap_write16$($addr$$101$$, $value$$53$$) {
  this.mmap_write8($addr$$101$$, $value$$53$$ & 255);
  this.mmap_write8($addr$$101$$ + 1, $value$$53$$ >> 8 & 255);
};
$JSCompiler_prototypeAlias$$.mmap_read32 = function $$JSCompiler_prototypeAlias$$$mmap_read32$($addr$$102$$) {
  return this.memory_map_read32[$addr$$102$$ >>> 14]($addr$$102$$);
};
$JSCompiler_prototypeAlias$$.mmap_write32 = function $$JSCompiler_prototypeAlias$$$mmap_write32$($addr$$103$$, $value$$54$$) {
  this.memory_map_write32[$addr$$103$$ >>> 14]($addr$$103$$, $value$$54$$);
};
$JSCompiler_prototypeAlias$$.read8 = function $$JSCompiler_prototypeAlias$$$read8$($addr$$104$$) {
  return this.memory_map_registered[$addr$$104$$ >>> 14] ? this.mmap_read8($addr$$104$$) : this.mem8[$addr$$104$$];
};
$JSCompiler_prototypeAlias$$.read16 = function $$JSCompiler_prototypeAlias$$$read16$($addr$$105$$) {
  return this.memory_map_registered[$addr$$105$$ >>> 14] ? this.mmap_read16($addr$$105$$) : this.mem8[$addr$$105$$] | this.mem8[$addr$$105$$ + 1] << 8;
};
$JSCompiler_prototypeAlias$$.read_aligned16 = function $$JSCompiler_prototypeAlias$$$read_aligned16$($addr$$106$$) {
  return this.memory_map_registered[$addr$$106$$ >>> 13] ? this.mmap_read16($addr$$106$$ << 1) : this.mem16[$addr$$106$$];
};
$JSCompiler_prototypeAlias$$.read32s = function $$JSCompiler_prototypeAlias$$$read32s$($addr$$107$$) {
  return this.memory_map_registered[$addr$$107$$ >>> 14] ? this.mmap_read32($addr$$107$$) : this.mem8[$addr$$107$$] | this.mem8[$addr$$107$$ + 1] << 8 | this.mem8[$addr$$107$$ + 2] << 16 | this.mem8[$addr$$107$$ + 3] << 24;
};
$JSCompiler_prototypeAlias$$.read_aligned32 = function $$JSCompiler_prototypeAlias$$$read_aligned32$($addr$$108$$) {
  return this.memory_map_registered[$addr$$108$$ >>> 12] ? this.mmap_read32($addr$$108$$ << 2) : this.mem32s[$addr$$108$$];
};
$JSCompiler_prototypeAlias$$.write8 = function $$JSCompiler_prototypeAlias$$$write8$($addr$$109$$, $value$$55$$) {
  this.memory_map_registered[$addr$$109$$ >>> 14] ? this.mmap_write8($addr$$109$$, $value$$55$$) : this.mem8[$addr$$109$$] = $value$$55$$;
};
$JSCompiler_prototypeAlias$$.write16 = function $$JSCompiler_prototypeAlias$$$write16$($addr$$110$$, $value$$56$$) {
  this.memory_map_registered[$addr$$110$$ >>> 14] ? this.mmap_write16($addr$$110$$, $value$$56$$) : (this.mem8[$addr$$110$$] = $value$$56$$, this.mem8[$addr$$110$$ + 1] = $value$$56$$ >> 8);
};
$JSCompiler_prototypeAlias$$.write_aligned16 = function $$JSCompiler_prototypeAlias$$$write_aligned16$($addr$$111$$, $value$$57$$) {
  this.memory_map_registered[$addr$$111$$ >>> 13] ? this.mmap_write16($addr$$111$$ << 1, $value$$57$$) : this.mem16[$addr$$111$$] = $value$$57$$;
};
$JSCompiler_prototypeAlias$$.write32 = function $$JSCompiler_prototypeAlias$$$write32$($addr$$112$$, $value$$58$$) {
  this.memory_map_registered[$addr$$112$$ >>> 14] ? this.mmap_write32($addr$$112$$, $value$$58$$) : (this.mem8[$addr$$112$$] = $value$$58$$, this.mem8[$addr$$112$$ + 1] = $value$$58$$ >> 8, this.mem8[$addr$$112$$ + 2] = $value$$58$$ >> 16, this.mem8[$addr$$112$$ + 3] = $value$$58$$ >> 24);
};
$JSCompiler_prototypeAlias$$.write_aligned32 = function $$JSCompiler_prototypeAlias$$$write_aligned32$($addr$$113$$, $value$$59$$) {
  this.memory_map_registered[$addr$$113$$ >>> 12] ? this.mmap_write32($addr$$113$$ << 2, $value$$59$$) : this.mem32s[$addr$$113$$] = $value$$59$$;
};
$JSCompiler_prototypeAlias$$.write_blob = function $$JSCompiler_prototypeAlias$$$write_blob$($blob$$7$$, $offset$$19$$) {
  this.mem8.set($blob$$7$$, $offset$$19$$);
};
$JSCompiler_prototypeAlias$$.write_string = function $$JSCompiler_prototypeAlias$$$write_string$($str$$10$$) {
  for (var $i$$27$$ = 0;$i$$27$$ < $str$$10$$.length;$i$$27$$++) {
    this.write8(63488 + $i$$27$$, $str$$10$$.charCodeAt($i$$27$$));
  }
};
function $DMA$$($dev$$1$$) {
  this.io = $dev$$1$$.io;
  this.memory = $dev$$1$$.memory;
  this.channels = [{address:0, count:0}, {address:0, count:0}, {address:0, count:0}, {address:0, count:0}];
  this.lsb_msb_flipflop = 0;
  this.io.register_write(4, this.port_write.bind(this, 4));
  this.io.register_write(5, this.port_write.bind(this, 5));
  this.io.register_write(10, this.portA_write.bind(this));
  this.io.register_write(11, this.portB_write.bind(this));
  this.io.register_write(12, this.portC_write.bind(this));
  this.io.register_write(129, this.port81_write.bind(this));
}
$JSCompiler_prototypeAlias$$ = $DMA$$.prototype;
$JSCompiler_prototypeAlias$$.port_write = function $$JSCompiler_prototypeAlias$$$port_write$($port$$21$$, $data_byte$$1$$) {
  if (8 > $port$$21$$) {
    var $channel$$ = $port$$21$$ >> 1;
    $port$$21$$ & 1 ? this.channels[$channel$$].count = this.flipflop_get(this.channels[$channel$$].count, $data_byte$$1$$) : this.channels[$channel$$].address = this.flipflop_get(this.channels[$channel$$].address, $data_byte$$1$$);
  }
};
$JSCompiler_prototypeAlias$$.portA_write = function $$JSCompiler_prototypeAlias$$$portA_write$() {
};
$JSCompiler_prototypeAlias$$.portB_write = function $$JSCompiler_prototypeAlias$$$portB_write$() {
};
$JSCompiler_prototypeAlias$$.portC_write = function $$JSCompiler_prototypeAlias$$$portC_write$() {
  this.lsb_msb_flipflop = 0;
};
$JSCompiler_prototypeAlias$$.port81_write = function $$JSCompiler_prototypeAlias$$$port81_write$($data_byte$$5$$) {
  this.channels[2].address = this.channels[2].address & 65535 | $data_byte$$5$$ << 16;
};
$JSCompiler_prototypeAlias$$.do_read = function $$JSCompiler_prototypeAlias$$$do_read$($buffer$$11$$, $start$$19$$, $fn$$7$$) {
  var $read_count$$1$$ = this.channels[2].count + 1, $addr$$116$$ = this.channels[2].address;
  if ($start$$19$$ + $read_count$$1$$ > $buffer$$11$$.byteLength) {
    $fn$$7$$(!0);
  } else {
    var $memory$$2$$ = this.memory;
    this.channels[2].address += $read_count$$1$$;
    $buffer$$11$$.get($start$$19$$, $read_count$$1$$, function($data$$215$$) {
      $memory$$2$$.write_blob($data$$215$$, $addr$$116$$);
      $fn$$7$$(!1);
    });
  }
};
$JSCompiler_prototypeAlias$$.do_write = function $$JSCompiler_prototypeAlias$$$do_write$($buffer$$12$$, $start$$20$$, $fn$$8$$) {
  var $read_count$$2$$ = this.channels[2].count, $addr$$117$$ = this.channels[2].address;
  $start$$20$$ + $read_count$$2$$ > $buffer$$12$$.byteLength ? $fn$$8$$(!0) : (this.channels[2].address += $read_count$$2$$, $buffer$$12$$.set($start$$20$$, new Uint8Array(this.memory.buffer, $addr$$117$$, $read_count$$2$$ + 1), function() {
    $fn$$8$$(!1);
  }));
};
$JSCompiler_prototypeAlias$$.flipflop_get = function $$JSCompiler_prototypeAlias$$$flipflop_get$($old_dword$$, $new_byte$$) {
  return(this.lsb_msb_flipflop ^= 1) ? $old_dword$$ & -256 | $new_byte$$ : $old_dword$$ & -65281 | $new_byte$$ << 8;
};
function $PIT$$($cpu$$1037$$) {
  function $counter_read$$($i$$28$$) {
    var $latch_next_low$$ = $counter_latch$$[$i$$28$$];
    if ($latch_next_low$$) {
      return $counter_latch$$[$i$$28$$]--, 2 === $latch_next_low$$ ? $counter_latch_value$$[$i$$28$$] & 255 : $counter_latch_value$$[$i$$28$$] >> 8;
    }
    $latch_next_low$$ = $counter_next_low$$[$i$$28$$];
    3 === $counter_mode$$[$i$$28$$] && ($counter_next_low$$[$i$$28$$] ^= 1);
    return $latch_next_low$$ ? $counter_current$$[$i$$28$$] & 255 : $counter_current$$[$i$$28$$] >> 8;
  }
  function $counter_write$$($i$$29$$, $value$$60$$) {
    $counter_reload$$[$i$$29$$] = $counter_next_low$$[$i$$29$$] ? $counter_reload$$[$i$$29$$] & -256 | $value$$60$$ : $counter_reload$$[$i$$29$$] & 255 | $value$$60$$ << 8;
    3 === $counter_read_mode$$[$i$$29$$] && $counter_next_low$$[$i$$29$$] || ($counter_reload$$[$i$$29$$] || ($counter_reload$$[$i$$29$$] = 65535), $counter_current$$[$i$$29$$] = $counter_reload$$[$i$$29$$], $counter_enabled$$[$i$$29$$] = !0);
    3 === $counter_read_mode$$[$i$$29$$] && ($counter_next_low$$[$i$$29$$] ^= 1);
  }
  var $io$$2$$ = $cpu$$1037$$.io, $pic$$1$$ = $cpu$$1037$$.devices.pic, $next_tick$$ = Date.now(), $counter_next_low$$ = new Uint8Array(3), $counter_enabled$$ = new Uint8Array(3), $counter_mode$$ = new Uint8Array(3), $counter_read_mode$$ = new Uint8Array(3), $counter_latch$$ = new Uint8Array(3), $counter_latch_value$$ = new Uint16Array(3), $counter_reload$$ = new Uint16Array(3), $counter_current$$ = new Uint16Array(3), $counter2_out$$ = 0, $parity$$ = 0;
  $io$$2$$.register_read(97, function() {
    $parity$$ ^= 16;
    return $parity$$ | $counter2_out$$ << 5;
  });
  this.timer = function $this$timer$($time$$, $no_irq$$) {
    var $current$$, $mode$$12$$, $steps$$ = 1193.1816666 * ($time$$ - $next_tick$$) >>> 0;
    if ($steps$$) {
      $next_tick$$ += $steps$$ / 1193.1816666;
      if (!$no_irq$$ && $counter_enabled$$[0] && ($current$$ = $counter_current$$[0] -= $steps$$, 0 >= $current$$)) {
        if ($pic$$1$$.push_irq(0), $mode$$12$$ = $counter_mode$$[0], 0 === $mode$$12$$) {
          $counter_enabled$$[0] = 0, $counter_current$$[0] = 0;
        } else {
          if (3 === $mode$$12$$ || 2 === $mode$$12$$) {
            $counter_current$$[0] = $counter_reload$$[0] + $current$$ % $counter_reload$$[0];
          }
        }
      }
      $counter_enabled$$[2] && ($current$$ = $counter_current$$[2] -= $steps$$, 0 >= $current$$ && ($mode$$12$$ = $counter_mode$$[2], 0 === $mode$$12$$ ? ($counter2_out$$ = 1, $counter_enabled$$[2] = 0, $counter_current$$[2] = 0) : 2 === $mode$$12$$ ? ($counter2_out$$ = 1, $counter_current$$[2] = $counter_reload$$[2] + $current$$ % $counter_reload$$[2]) : 3 === $mode$$12$$ && ($counter2_out$$ ^= 1, $counter_current$$[2] = $counter_reload$$[2] + $current$$ % $counter_reload$$[2])));
    }
  };
  $io$$2$$.register_read(64, function() {
    return $counter_read$$(0);
  });
  $io$$2$$.register_read(65, function() {
    return $counter_read$$(1);
  });
  $io$$2$$.register_read(66, function() {
    return $counter_read$$(2);
  });
  $io$$2$$.register_write(64, function($value$$61$$) {
    $counter_write$$(0, $value$$61$$);
  });
  $io$$2$$.register_write(65, function($value$$62$$) {
    $counter_write$$(1, $value$$62$$);
  });
  $io$$2$$.register_write(66, function($value$$63$$) {
    $counter_write$$(2, $value$$63$$);
  });
  $io$$2$$.register_write(67, function port43_write($read_mode_reg_byte$$1$$) {
    var $mode$$11$$ = $read_mode_reg_byte$$1$$ >> 1 & 7, $i$$30$$ = $read_mode_reg_byte$$1$$ >> 6 & 3;
    $read_mode_reg_byte$$1$$ = $read_mode_reg_byte$$1$$ >> 4 & 3;
    3 !== $i$$30$$ && (0 === $read_mode_reg_byte$$1$$ ? ($counter_latch$$[$i$$30$$] = 2, $counter_latch_value$$[$i$$30$$] = $counter_current$$[$i$$30$$]) : (6 <= $mode$$11$$ && ($mode$$11$$ &= -5), $counter_next_low$$[$i$$30$$] = 1 === $read_mode_reg_byte$$1$$ ? 0 : 1, $counter_mode$$[$i$$30$$] = $mode$$11$$, $counter_read_mode$$[$i$$30$$] = $read_mode_reg_byte$$1$$, 2 === $i$$30$$ && ($counter2_out$$ = 0 === $mode$$11$$ ? 0 : 1)));
  });
}
;function $VGAScreen$$($cpu$$1038$$, $adapter$$, $vga_memory_size$$) {
  var $dev$$2$$ = $cpu$$1038$$.devices, $io$$3$$ = $cpu$$1038$$.io, $cursor_address$$ = 0, $cursor_scanline_start$$ = 14, $cursor_scanline_end$$ = 15, $screen$$1$$ = this, $max_cols$$, $max_rows$$, $screen_width$$, $screen_height$$, $start_address$$ = 0, $graphical_mode_is_linear$$ = !0, $graphical_mode$$ = !1, $do_complete_redraw$$ = !1, $vga256_palette$$ = new Int32Array(256), $latch0$$ = 0, $latch1$$ = 0, $latch2$$ = 0, $latch3$$ = 0, $svga_width$$ = 0, $svga_height$$ = 0, $plane0$$, $plane1$$, 
  $plane2$$, $plane3$$;
  void 0 === $adapter$$ && ($adapter$$ = new $VGADummyAdapter$$);
  this.svga_memory32 = this.svga_memory16 = this.svga_memory = this.vga_memory = null;
  this.svga_enabled = !1;
  this.adapter = $adapter$$;
  this.svga_offset = this.svga_bpp = 0;
  this.pci_space = [222, 16, 32, 10, 7, 0, 0, 0, 162, 0, 0, 3, 0, 0, 128, 0, 8, 0, 0, 224, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 10, 1, 0, 0];
  this.pci_id = 144;
  this.pci_bars = [{size:$vga_memory_size$$}];
  $dev$$2$$.pci.register_device(this);
  this.VGAScreen$stats = {is_graphical:!1, res_x:0, res_y:0, bpp:0};
  this.init = function $this$init$() {
    void 0 === $vga_memory_size$$ || 262144 > $vga_memory_size$$ ? $vga_memory_size$$ = 262144 : $vga_memory_size$$ & 65535 && ($vga_memory_size$$ |= 65535, $vga_memory_size$$++);
    this.svga_memory = new Uint8Array($vga_memory_size$$);
    this.svga_memory16 = new Uint16Array(this.svga_memory.buffer);
    this.svga_memory32 = new Int32Array(this.svga_memory.buffer);
    this.vga_memory = new Uint8Array(this.svga_memory.buffer, 0, 262144);
    $plane0$$ = new Uint8Array(this.svga_memory.buffer, 0, 65536);
    $plane1$$ = new Uint8Array(this.svga_memory.buffer, 65536, 65536);
    $plane2$$ = new Uint8Array(this.svga_memory.buffer, 131072, 65536);
    $plane3$$ = new Uint8Array(this.svga_memory.buffer, 196608, 65536);
    this.set_size_text(80, 25);
    this.update_cursor_scanline();
    $io$$3$$.mmap_register(655360, 131072, this.vga_memory_read, this.vga_memory_write);
    $io$$3$$.mmap_register(3758096384, $vga_memory_size$$, this.svga_memory_read8.bind(this), this.svga_memory_write8.bind(this), this.svga_memory_read32.bind(this), this.svga_memory_write32.bind(this));
  };
  this.vga_memory_read = function $this$vga_memory_read$($addr$$118$$) {
    $addr$$118$$ -= 655360;
    if (!$graphical_mode$$ || $graphical_mode_is_linear$$) {
      return $screen$$1$$.vga_memory[$addr$$118$$];
    }
    $addr$$118$$ &= 65535;
    $latch0$$ = $plane0$$[$addr$$118$$];
    $latch1$$ = $plane1$$[$addr$$118$$];
    $latch2$$ = $plane2$$[$addr$$118$$];
    $latch3$$ = $plane3$$[$addr$$118$$];
    return $screen$$1$$.vga_memory[$plane_read$$ << 16 | $addr$$118$$];
  };
  this.vga_memory_write = function $this$vga_memory_write$($addr$$119$$, $value$$74$$) {
    $addr$$119$$ -= 655360;
    $graphical_mode$$ ? $graphical_mode_is_linear$$ ? $screen$$1$$.vga_memory_write_graphical_linear($addr$$119$$, $value$$74$$) : $screen$$1$$.vga_memory_write_graphical_planar($addr$$119$$, $value$$74$$) : $screen$$1$$.vga_memory_write_text_mode($addr$$119$$, $value$$74$$);
  };
  this.vga_memory_write_graphical_linear = function $this$vga_memory_write_graphical_linear$($addr$$120$$, $value$$75$$) {
    var $offset$$21$$ = $addr$$120$$ << 2, $color$$3$$ = $vga256_palette$$[$value$$75$$];
    this.adapter.put_pixel_linear($offset$$21$$ | 2, $color$$3$$ >> 16 & 255);
    this.adapter.put_pixel_linear($offset$$21$$ | 1, $color$$3$$ >> 8 & 255);
    this.adapter.put_pixel_linear($offset$$21$$, $color$$3$$ & 255);
    this.vga_memory[$addr$$120$$] = $value$$75$$;
  };
  this.vga_memory_write_graphical_planar = function $this$vga_memory_write_graphical_planar$($addr$$121$$, $value$$76$$) {
    if (!(65535 < $addr$$121$$)) {
      var $plane0_byte$$, $plane1_byte$$, $plane2_byte$$, $plane3_byte$$, $offset$$22_write_mode$$ = $planar_mode$$ & 3;
      0 === $offset$$22_write_mode$$ ? $plane0_byte$$ = $plane1_byte$$ = $plane2_byte$$ = $plane3_byte$$ = $value$$76$$ : 2 === $offset$$22_write_mode$$ && ($plane_write_bm$$ & 1 && ($plane0_byte$$ = $latch0$$ & ~$planar_bitmap$$ | ($value$$76$$ & 1 ? 255 : 0) & $planar_bitmap$$), $plane_write_bm$$ & 2 && ($plane1_byte$$ = $latch1$$ & ~$planar_bitmap$$ | ($value$$76$$ & 2 ? 255 : 0) & $planar_bitmap$$), $plane_write_bm$$ & 4 && ($plane2_byte$$ = $latch2$$ & ~$planar_bitmap$$ | ($value$$76$$ & 4 ? 
      255 : 0) & $planar_bitmap$$), $plane_write_bm$$ & 8 && ($plane3_byte$$ = $latch3$$ & ~$planar_bitmap$$ | ($value$$76$$ & 8 ? 255 : 0) & $planar_bitmap$$));
      if (0 === $offset$$22_write_mode$$ || 2 === $offset$$22_write_mode$$) {
        switch($planar_rotate_reg$$ & 24) {
          case 8:
            $plane0_byte$$ &= $latch0$$;
            $plane1_byte$$ &= $latch1$$;
            $plane2_byte$$ &= $latch2$$;
            $plane3_byte$$ &= $latch3$$;
            break;
          case 16:
            $plane0_byte$$ |= $latch0$$;
            $plane1_byte$$ |= $latch1$$;
            $plane2_byte$$ |= $latch2$$;
            $plane3_byte$$ |= $latch3$$;
            break;
          case 24:
            $plane0_byte$$ ^= $latch0$$, $plane1_byte$$ ^= $latch1$$, $plane2_byte$$ ^= $latch2$$, $plane3_byte$$ ^= $latch3$$;
        }
        $plane_write_bm$$ & 1 && ($plane0_byte$$ = $latch0$$ & ~$planar_bitmap$$ | $plane0_byte$$ & $planar_bitmap$$);
        $plane_write_bm$$ & 2 && ($plane1_byte$$ = $latch1$$ & ~$planar_bitmap$$ | $plane1_byte$$ & $planar_bitmap$$);
        $plane_write_bm$$ & 4 && ($plane2_byte$$ = $latch2$$ & ~$planar_bitmap$$ | $plane2_byte$$ & $planar_bitmap$$);
        $plane_write_bm$$ & 8 && ($plane3_byte$$ = $latch3$$ & ~$planar_bitmap$$ | $plane3_byte$$ & $planar_bitmap$$);
      } else {
        1 === $offset$$22_write_mode$$ && ($plane0_byte$$ = $latch0$$, $plane1_byte$$ = $latch1$$, $plane2_byte$$ = $latch2$$, $plane3_byte$$ = $latch3$$);
      }
      $plane_write_bm$$ & 1 ? $plane0$$[$addr$$121$$] = $plane0_byte$$ : $plane0_byte$$ = $plane0$$[$addr$$121$$];
      $plane_write_bm$$ & 2 ? $plane1$$[$addr$$121$$] = $plane1_byte$$ : $plane1_byte$$ = $plane1$$[$addr$$121$$];
      $plane_write_bm$$ & 4 ? $plane2$$[$addr$$121$$] = $plane2_byte$$ : $plane2_byte$$ = $plane2$$[$addr$$121$$];
      $plane_write_bm$$ & 8 ? $plane3$$[$addr$$121$$] = $plane3_byte$$ : $plane3_byte$$ = $plane3$$[$addr$$121$$];
      if (!($addr$$121$$ >= $screen_width$$ * $screen_height$$ << 3)) {
        $plane1_byte$$ <<= 1;
        $plane2_byte$$ <<= 2;
        $plane3_byte$$ <<= 3;
        for (var $offset$$22_write_mode$$ = ($addr$$121$$ << 3 | 7) << 2, $i$$31$$ = 0;8 > $i$$31$$;$i$$31$$++) {
          var $color$$4$$ = $vga256_palette$$[$dac_map$$[$plane0_byte$$ >> $i$$31$$ & 1 | $plane1_byte$$ >> $i$$31$$ & 2 | $plane2_byte$$ >> $i$$31$$ & 4 | $plane3_byte$$ >> $i$$31$$ & 8]];
          this.adapter.put_pixel_linear($offset$$22_write_mode$$ | 2, $color$$4$$ >> 16);
          this.adapter.put_pixel_linear($offset$$22_write_mode$$ | 1, $color$$4$$ >> 8 & 255);
          this.adapter.put_pixel_linear($offset$$22_write_mode$$, $color$$4$$ & 255);
          $offset$$22_write_mode$$ -= 4;
        }
      }
    }
  };
  this.text_mode_redraw = function $this$text_mode_redraw$() {
    for (var $addr$$122$$ = 98304 | $start_address$$ << 1, $chr$$, $color$$5$$, $row$$1$$ = 0;$row$$1$$ < $max_rows$$;$row$$1$$++) {
      for (var $col$$ = 0;$col$$ < $max_cols$$;$col$$++) {
        $chr$$ = this.vga_memory[$addr$$122$$], $color$$5$$ = this.vga_memory[$addr$$122$$ | 1], this.adapter.put_char($row$$1$$, $col$$, $chr$$, $vga256_palette$$[$color$$5$$ >> 4 & 15], $vga256_palette$$[$color$$5$$ & 15]), $addr$$122$$ += 2;
      }
    }
  };
  this.graphical_planar_redraw = function $this$graphical_planar_redraw$() {
    for (var $addr$$123$$ = 0, $y$$38$$ = 0;$y$$38$$ < $screen_height$$;$y$$38$$++) {
      for (var $x$$62$$ = 0;$x$$62$$ < $screen_width$$;$x$$62$$ += 8) {
        for (var $i$$32$$ = 0;8 > $i$$32$$;$i$$32$$++) {
          this.adapter.put_pixel_linear32($y$$38$$ * $screen_width$$ + $x$$62$$ << 2, $vga256_palette$$[$dac_map$$[$plane0$$[$addr$$123$$] >> $i$$32$$ & 1 | $plane1$$[$addr$$123$$] >> $i$$32$$ << 1 & 2 | $plane2$$[$addr$$123$$] >> $i$$32$$ << 2 & 4 | $plane3$$[$addr$$123$$] >> $i$$32$$ << 3 & 8]]);
        }
        $addr$$123$$++;
      }
    }
  };
  this.vga_memory_write_text_mode = function $this$vga_memory_write_text_mode$($addr$$124$$, $value$$77$$) {
    if (!(98304 > $addr$$124$$)) {
      var $col$$1_memory_start$$ = ($addr$$124$$ - 98304 >> 1) - $start_address$$, $row$$2$$ = $col$$1_memory_start$$ / $max_cols$$ | 0, $col$$1_memory_start$$ = $col$$1_memory_start$$ % $max_cols$$, $chr$$1$$, $color$$7$$;
      $addr$$124$$ & 1 ? ($color$$7$$ = $value$$77$$, $chr$$1$$ = this.vga_memory[$addr$$124$$ & -2]) : ($chr$$1$$ = $value$$77$$, $color$$7$$ = this.vga_memory[$addr$$124$$ | 1]);
      this.adapter.put_char($row$$2$$, $col$$1_memory_start$$, $chr$$1$$, $vga256_palette$$[$color$$7$$ >> 4 & 15], $vga256_palette$$[$color$$7$$ & 15]);
      this.vga_memory[$addr$$124$$] = $value$$77$$;
    }
  };
  this.update_cursor = function $this$update_cursor$() {
    var $row$$3$$ = ($cursor_address$$ - $start_address$$) / $max_cols$$ | 0, $col$$2$$ = ($cursor_address$$ - $start_address$$) % $max_cols$$, $row$$3$$ = Math.min($max_rows$$ - 1, $row$$3$$);
    this.adapter.update_cursor($row$$3$$, $col$$2$$);
  };
  this.svga_memory_read8 = function $this$svga_memory_read8$($addr$$125$$) {
    return this.svga_memory[$addr$$125$$ & 268435455];
  };
  this.svga_memory_read32 = function $this$svga_memory_read32$($addr$$126$$) {
    $addr$$126$$ &= 268435455;
    return $addr$$126$$ & 3 ? this.svga_memory[$addr$$126$$] | this.svga_memory[$addr$$126$$ + 1] << 8 | this.svga_memory[$addr$$126$$ + 2] << 16 | this.svga_memory[$addr$$126$$ + 3] << 24 : this.svga_memory32[$addr$$126$$ >> 2];
  };
  this.svga_memory_write8 = function $this$svga_memory_write8$($addr$$127$$, $value$$78$$) {
    $addr$$127$$ &= 268435455;
    this.svga_memory[$addr$$127$$] = $value$$78$$;
    if (this.svga_enabled && ($addr$$127$$ -= this.svga_offset, !(0 > $addr$$127$$))) {
      switch(this.svga_bpp) {
        case 32:
          3 !== ($addr$$127$$ & 3) && this.adapter.put_pixel_linear($addr$$127$$, $value$$78$$);
          break;
        case 24:
          this.adapter.put_pixel_linear(($addr$$127$$ << 2) / 3 | 0, $value$$78$$);
          break;
        case 16:
          if ($addr$$127$$ & 1) {
            var $red$$3_word$$1$$ = this.svga_memory16[$addr$$127$$ >> 1], $color$$8_green$$3$$, $blue$$3_offset$$23$$;
            $blue$$3_offset$$23$$ = 255 * ($value$$78$$ >> 3 & 31) / 31 | 0;
            $color$$8_green$$3$$ = 255 * ($red$$3_word$$1$$ >> 5 & 63) / 63 | 0;
            $red$$3_word$$1$$ = 255 * ($red$$3_word$$1$$ & 31) / 31 | 0;
            $addr$$127$$ <<= 1;
            this.adapter.put_pixel_linear($addr$$127$$, $red$$3_word$$1$$);
            this.adapter.put_pixel_linear($addr$$127$$ - 1, $color$$8_green$$3$$);
            this.adapter.put_pixel_linear($addr$$127$$ - 2, $blue$$3_offset$$23$$);
          }
          break;
        case 8:
          $color$$8_green$$3$$ = $vga256_palette$$[$value$$78$$], $blue$$3_offset$$23$$ = $addr$$127$$ << 2, this.adapter.put_pixel_linear($blue$$3_offset$$23$$, $color$$8_green$$3$$ >> 16 & 255), this.adapter.put_pixel_linear($blue$$3_offset$$23$$ | 1, $color$$8_green$$3$$ >> 8 & 255), this.adapter.put_pixel_linear($blue$$3_offset$$23$$ | 2, $color$$8_green$$3$$ & 255);
      }
    }
  };
  this.svga_memory_write32 = function $this$svga_memory_write32$($addr$$128$$, $value$$79$$) {
    $addr$$128$$ &= 268435455;
    if ($addr$$128$$ & 3 || 32 !== this.svga_bpp) {
      this.svga_memory_write8($addr$$128$$, $value$$79$$ & 255), this.svga_memory_write8($addr$$128$$ + 1, $value$$79$$ >> 8 & 255), this.svga_memory_write8($addr$$128$$ + 2, $value$$79$$ >> 16 & 255), this.svga_memory_write8($addr$$128$$ + 3, $value$$79$$ >> 24 & 255);
    } else {
      if (this.svga_memory32[$addr$$128$$ >> 2] = $value$$79$$, this.svga_enabled && ($addr$$128$$ -= this.svga_offset, !(0 > $addr$$128$$))) {
        switch(this.svga_bpp) {
          case 32:
            this.adapter.put_pixel_linear32($addr$$128$$, $value$$79$$);
        }
      }
    }
  };
  this.svga_redraw = function $this$svga_redraw$() {
    var $addr$$129$$ = this.svga_offset, $count$$64$$ = $svga_height$$ * $svga_width$$, $pixel$$ = 0;
    if (32 === this.svga_bpp) {
      for (var $buf32$$1$$ = new Int32Array(this.svga_memory.buffer), $addr$$129$$ = $addr$$129$$ >> 2, $count$$64$$ = $count$$64$$ << 2;$pixel$$ < $count$$64$$;) {
        this.adapter.put_pixel_linear32($pixel$$, $buf32$$1$$[$addr$$129$$++]), $pixel$$ += 4;
      }
    } else {
      if (24 === this.svga_bpp) {
        for ($count$$64$$ <<= 2;$pixel$$ < $count$$64$$;) {
          this.adapter.put_pixel_linear($pixel$$++, this.svga_memory[$addr$$129$$++]), this.adapter.put_pixel_linear($pixel$$++, this.svga_memory[$addr$$129$$++]), this.adapter.put_pixel_linear($pixel$$++, this.svga_memory[$addr$$129$$++]), $pixel$$++;
        }
      }
    }
  };
  this.timer = function $this$timer$() {
    $do_complete_redraw$$ && ($do_complete_redraw$$ = !1, this.svga_enabled ? this.svga_redraw() : $graphical_mode$$ ? $graphical_mode_is_linear$$ || this.graphical_planar_redraw() : this.text_mode_redraw());
    this.adapter.timer();
  };
  this.set_size_text = function $this$set_size_text$($cols_count$$, $rows_count$$) {
    $max_cols$$ = $cols_count$$;
    $max_rows$$ = $rows_count$$;
    this.adapter.set_size_text($cols_count$$, $rows_count$$);
  };
  this.set_size_graphical = function $this$set_size_graphical$($width$$13$$, $height$$12$$) {
    this.adapter.set_size_graphical($width$$13$$, $height$$12$$);
  };
  this.update_cursor_scanline = function $this$update_cursor_scanline$() {
    this.adapter.update_cursor_scanline($cursor_scanline_start$$, $cursor_scanline_end$$);
  };
  this.set_video_mode = function $this$set_video_mode$($mode$$13$$) {
    var $is_graphical$$ = !1;
    switch($mode$$13$$) {
      case 3:
        this.set_size_text(80, 25);
        break;
      case 16:
        $screen_width$$ = 640;
        $screen_height$$ = 350;
        $is_graphical$$ = !0;
        $graphical_mode_is_linear$$ = !1;
        break;
      case 18:
        $screen_width$$ = 640;
        $screen_height$$ = 480;
        $is_graphical$$ = !0;
        $graphical_mode_is_linear$$ = !1;
        break;
      case 19:
        $screen_width$$ = 320, $screen_height$$ = 200, $graphical_mode_is_linear$$ = $is_graphical$$ = !0;
    }
    this.adapter.set_mode($is_graphical$$);
    if (this.VGAScreen$stats.is_graphical = $is_graphical$$) {
      this.set_size_graphical($screen_width$$, $screen_height$$), this.VGAScreen$stats.res_x = $screen_width$$, this.VGAScreen$stats.res_y = $screen_height$$, this.VGAScreen$stats.bpp = 8;
    }
    $graphical_mode$$ = $is_graphical$$;
  };
  var $index_crtc$$ = 0, $dac_color_index$$ = 0;
  $io$$3$$.register_write(967, function port3C7_write() {
  });
  $io$$3$$.register_write(968, function port3C8_write($index$$47$$) {
    $dac_color_index$$ = 3 * $index$$47$$;
  });
  $io$$3$$.register_write(969, function port3C9_write($color_byte$$) {
    var $index$$48$$ = $dac_color_index$$ / 3 | 0, $offset$$20$$ = $dac_color_index$$ % 3, $color$$2$$ = $vga256_palette$$[$index$$48$$];
    $color_byte$$ = 255 * $color_byte$$ / 63 & 255;
    $vga256_palette$$[$index$$48$$] = 0 === $offset$$20$$ ? $color$$2$$ & -16711681 | $color_byte$$ << 16 : 1 === $offset$$20$$ ? $color$$2$$ & -65281 | $color_byte$$ << 8 : $color$$2$$ & -256 | $color_byte$$;
    $dac_color_index$$++;
    $do_complete_redraw$$ = !0;
  });
  var $max_scan_line$$ = 0;
  $io$$3$$.register_write(980, function port3D4_write($register$$) {
    $index_crtc$$ = $register$$;
  });
  $io$$3$$.register_write(981, function port3D5_write($value$$64$$) {
    switch($index_crtc$$) {
      case 9:
        $max_scan_line$$ = $value$$64$$;
        7 === ($value$$64$$ & 31) ? this.set_size_text(80, 50) : this.set_size_text(80, 25);
        break;
      case 10:
        $cursor_scanline_start$$ = $value$$64$$;
        this.update_cursor_scanline();
        break;
      case 11:
        $cursor_scanline_end$$ = $value$$64$$;
        this.update_cursor_scanline();
        break;
      case 12:
        $start_address$$ = $start_address$$ & 255 | $value$$64$$ << 8;
        $do_complete_redraw$$ = !0;
        break;
      case 13:
        $start_address$$ = $start_address$$ & 65280 | $value$$64$$;
        $do_complete_redraw$$ = !0;
        break;
      case 14:
        $cursor_address$$ = $cursor_address$$ & 255 | $value$$64$$ << 8;
        this.update_cursor();
        break;
      case 15:
        $cursor_address$$ = $cursor_address$$ & 65280 | $value$$64$$, this.update_cursor();
    }
  }, this);
  $io$$3$$.register_read(981, function port3D5_read() {
    return 9 === $index_crtc$$ ? $max_scan_line$$ : 10 === $index_crtc$$ ? $cursor_scanline_start$$ : 11 === $index_crtc$$ ? $cursor_scanline_end$$ : 14 === $index_crtc$$ ? $cursor_address$$ >> 8 : 15 === $index_crtc$$ ? $cursor_address$$ & 255 : 0;
  });
  var $miscellaneous_output_register$$ = 255;
  $io$$3$$.register_read(972, function port3CC_read() {
    return $miscellaneous_output_register$$;
  });
  $io$$3$$.register_write(962, function port3C2_write($value$$65$$) {
    $miscellaneous_output_register$$ = $value$$65$$;
    103 === $value$$65$$ ? $screen$$1$$.set_video_mode(3) : 227 === $value$$65$$ ? $screen$$1$$.set_video_mode(18) : 99 === $value$$65$$ ? $screen$$1$$.set_video_mode(19) : 163 === $value$$65$$ ? $screen$$1$$.set_video_mode(16) : $screen$$1$$.set_video_mode(3);
  });
  var $port_3DA_value$$ = 255;
  $io$$3$$.register_read(986, function port3DA_read() {
    return $port_3DA_value$$ ^= 8;
  });
  var $attribute_controller_index$$ = -1;
  $io$$3$$.register_read(961, function port3C1_read() {
    return $attribute_controller_index$$ = -1;
  });
  var $dac_map$$ = new Uint8Array(16);
  $io$$3$$.register_write(960, function port3C0_write($value$$66$$) {
    -1 === $attribute_controller_index$$ ? $attribute_controller_index$$ = $value$$66$$ : (16 > $attribute_controller_index$$ && ($dac_map$$[$attribute_controller_index$$] = $value$$66$$), $attribute_controller_index$$ = -1);
  });
  $io$$3$$.register_read(960, function port3C0_read() {
    var $result$$82$$ = $attribute_controller_index$$;
    $attribute_controller_index$$ = -1;
    return $result$$82$$;
  });
  var $sequencer_index$$ = -1;
  $io$$3$$.register_write(964, function port3C4_write($value$$67$$) {
    $sequencer_index$$ = $value$$67$$;
  });
  $io$$3$$.register_read(964, function port3C4_read() {
    return $sequencer_index$$;
  });
  var $plane_write_bm$$ = 15, $sequencer_memory_mode$$ = 0;
  $io$$3$$.register_write(965, function port3C5_write($value$$68$$) {
    switch($sequencer_index$$) {
      case 2:
        $plane_write_bm$$ = $value$$68$$;
        break;
      case 4:
        $sequencer_memory_mode$$ = $value$$68$$;
    }
  });
  $io$$3$$.register_read(965, function port3C5_read() {
    switch($sequencer_index$$) {
      case 2:
        return $plane_write_bm$$;
      case 4:
        return $sequencer_memory_mode$$;
      case 6:
        return 18;
    }
    return 0;
  });
  var $graphics_index$$ = -1;
  $io$$3$$.register_write(974, function port3CE_write($value$$69$$) {
    $graphics_index$$ = $value$$69$$;
  });
  $io$$3$$.register_read(974, function port3CE_read() {
    return $graphics_index$$;
  });
  var $plane_read$$ = 0, $planar_mode$$ = 0, $planar_rotate_reg$$ = 0, $planar_bitmap$$ = 255;
  $io$$3$$.register_write(975, function port3CF_write($value$$70$$) {
    switch($graphics_index$$) {
      case 3:
        $planar_rotate_reg$$ = $value$$70$$;
        break;
      case 4:
        $plane_read$$ = $value$$70$$;
        break;
      case 5:
        $planar_mode$$ = $value$$70$$;
        break;
      case 8:
        $planar_bitmap$$ = $value$$70$$;
    }
  });
  $io$$3$$.register_read(975, function port3CF_read() {
    switch($graphics_index$$) {
      case 3:
        return $planar_rotate_reg$$;
      case 4:
        return $plane_read$$;
      case 5:
        return $planar_mode$$;
      case 8:
        return $planar_bitmap$$;
    }
    return 0;
  });
  var $dispi_index$$ = -1, $dispi_value$$ = -1, $dispi_enable_value$$ = 0;
  this.svga_bytes_per_line = function $this$svga_bytes_per_line$() {
    return $svga_width$$ * (15 === this.svga_bpp ? 16 : this.svga_bpp) / 8;
  };
  $io$$3$$.register_write(462, function port1CE_write($value$$71$$) {
    $dispi_index$$ = $value$$71$$;
  });
  $io$$3$$.register_write(463, function port1CF_write($value$$72$$, $low_port$$) {
    462 === $low_port$$ ? $dispi_index$$ = $dispi_index$$ & 255 | $value$$72$$ << 8 : $dispi_value$$ = $value$$72$$;
  });
  $io$$3$$.register_write(464, function port1D0_write($value$$73$$) {
    $dispi_value$$ = $dispi_value$$ & 255 | $value$$73$$ << 8;
    switch($dispi_index$$) {
      case 1:
        $svga_width$$ = $dispi_value$$;
        2560 < $svga_width$$ && ($svga_width$$ = 2560);
        break;
      case 2:
        $svga_height$$ = $dispi_value$$;
        1600 < $svga_height$$ && ($svga_height$$ = 1600);
        break;
      case 3:
        this.svga_bpp = $dispi_value$$;
        break;
      case 4:
        this.svga_enabled = 1 === ($dispi_value$$ & 1);
        $dispi_enable_value$$ = $dispi_value$$;
        break;
      case 9:
        this.svga_offset = $dispi_value$$ * this.svga_bytes_per_line(), $do_complete_redraw$$ = !0;
    }
    !this.svga_enabled || $svga_width$$ && $svga_width$$ || (this.svga_enabled = !1);
    this.svga_enabled && 4 === $dispi_index$$ && ($screen$$1$$.set_size_graphical($svga_width$$, $svga_height$$), this.adapter.set_mode(!0), $screen$$1$$.VGAScreen$stats.bpp = this.svga_bpp, $screen$$1$$.VGAScreen$stats.is_graphical = !0, $screen$$1$$.VGAScreen$stats.res_x = $svga_width$$, $screen$$1$$.VGAScreen$stats.res_y = $svga_height$$);
  }, this);
  this.svga_register_read = function $this$svga_register_read$($n$$2$$) {
    switch($n$$2$$) {
      case 0:
        return 45248;
      case 1:
        return $dispi_value$$ & 2 ? 2560 : $svga_width$$;
      case 2:
        return $dispi_value$$ & 2 ? 1600 : $svga_height$$;
      case 3:
        return $dispi_value$$ & 2 ? 32 : this.svga_bpp;
      case 4:
        return $dispi_enable_value$$;
      case 6:
        return $svga_width$$;
      case 10:
        return $vga_memory_size$$ / 65536 | 0;
    }
    return 255;
  };
  $io$$3$$.register_read(463, function port1CF_read() {
    return this.svga_register_read($dispi_index$$);
  }, this);
  $io$$3$$.register_read(464, function port1D0_read() {
    return this.svga_register_read($dispi_index$$) >> 8;
  }, this);
  this.init();
}
function $VGADummyAdapter$$() {
  this.put_pixel_linear = function $this$put_pixel_linear$() {
  };
  this.put_pixel_linear32 = function $this$put_pixel_linear32$() {
  };
  this.put_char = function $this$put_char$() {
  };
  this.set_mode = function $this$set_mode$() {
  };
  this.set_size_graphical = function $this$set_size_graphical$() {
  };
  this.set_size_text = function $this$set_size_text$() {
  };
  this.update_cursor = function $this$update_cursor$() {
  };
  this.update_cursor_scanline = function $this$update_cursor_scanline$() {
  };
  this.timer = function $this$timer$() {
  };
}
;function $PS2$$($cpu$$1039$$, $keyboard$$, $mouse$$) {
  function $mouse_irq$$() {
    $command_register$$ & 2 && $pic$$2$$.push_irq(12);
  }
  function $kbd_irq$$() {
    $command_register$$ & 1 && $pic$$2$$.push_irq(1);
  }
  function $kbd_send_code$$($code$$5$$) {
    $cpu$$1039$$.running && $enable_keyboard_stream$$ && ($kbd_buffer$$.ByteQueue$push($code$$5$$), $kbd_irq$$());
  }
  function $mouse_send_delta$$($delta_x$$, $delta_y$$) {
    if ($cpu$$1039$$.running && $have_mouse$$ && $enable_mouse$$ && ($mouse_delta_x$$ += $delta_x$$ * $resolution$$, $mouse_delta_y$$ += $delta_y$$ * $resolution$$, $enable_mouse_stream$$)) {
      var $change_x$$ = $mouse_delta_x$$ | 0, $change_y$$ = $mouse_delta_y$$ | 0;
      !$change_x$$ && !$change_y$$ || Date.now() - $last_mouse_packet$$ < 1E3 / $sample_rate$$ || ($mouse_delta_x$$ -= $change_x$$, $mouse_delta_y$$ -= $change_y$$, $send_mouse_packet$$($change_x$$, $change_y$$));
    }
  }
  function $mouse_send_click$$($left$$3$$, $middle$$, $right$$3$$) {
    $have_mouse$$ && $enable_mouse$$ && ($mouse_clicks$$ = $left$$3$$ | $right$$3$$ << 1 | $middle$$ << 2, $enable_mouse_stream$$ && $send_mouse_packet$$(0, 0));
  }
  function $send_mouse_packet$$($dx$$4$$, $dy$$4$$) {
    var $info_byte$$ = (0 > $dy$$4$$) << 5 | (0 > $dx$$4$$) << 4 | 8 | $mouse_clicks$$, $delta_x$$1$$ = $dx$$4$$, $delta_y$$1$$ = $dy$$4$$;
    $last_mouse_packet$$ = Date.now();
    $scaling2$$ && ($delta_x$$1$$ = $apply_scaling2$$($delta_x$$1$$), $delta_y$$1$$ = $apply_scaling2$$($delta_y$$1$$));
    $mouse_buffer$$.ByteQueue$push($info_byte$$);
    $mouse_buffer$$.ByteQueue$push($delta_x$$1$$);
    $mouse_buffer$$.ByteQueue$push($delta_y$$1$$);
    $mouse_irq$$();
  }
  function $apply_scaling2$$($n$$3$$) {
    var $sign$$2$$ = $n$$3$$ >> 31;
    switch(Math.abs($n$$3$$)) {
      case 0:
      ;
      case 1:
      ;
      case 3:
        return $n$$3$$;
      case 2:
        return $sign$$2$$;
      case 4:
        return 6 * $sign$$2$$;
      case 5:
        return 9 * $sign$$2$$;
      default:
        return $n$$3$$ << 1;
    }
  }
  var $io$$4$$ = $cpu$$1039$$.io, $pic$$2$$ = $cpu$$1039$$.devices.pic, $enable_mouse_stream$$ = !1, $enable_mouse$$ = !1, $have_mouse$$ = !1, $mouse_delta_x$$ = 0, $mouse_delta_y$$ = 0, $mouse_clicks$$ = 0, $enable_keyboard_stream$$ = !1, $next_is_mouse_command$$ = !1, $next_read_sample$$ = !1, $next_read_led$$ = !1, $next_handle_scan_code_set$$ = !1, $next_read_rate$$ = !1, $next_read_resolution$$ = !1, $kbd_buffer$$ = new $ByteQueue$$(32), $last_port60_byte$$ = 0, $sample_rate$$ = 100, $resolution$$ = 
  4, $scaling2$$ = !1, $last_mouse_packet$$ = -1, $mouse_buffer$$ = new $ByteQueue$$(32);
  $keyboard$$ && $keyboard$$.init($kbd_send_code$$);
  $mouse$$ && ($have_mouse$$ = !0, $mouse$$.init($mouse_send_click$$, $mouse_send_delta$$));
  var $command_register$$ = 5, $read_output_register$$ = !1, $read_command_register$$ = !1;
  $io$$4$$.register_read(96, function port60_read() {
    if (!$kbd_buffer$$.length && !$mouse_buffer$$.length) {
      return $last_port60_byte$$;
    }
    ($kbd_buffer$$.length && $mouse_buffer$$.length ? 0 !== ($pic$$2$$.get_isr() & 2) : $kbd_buffer$$.length) ? ($last_port60_byte$$ = $kbd_buffer$$.ByteQueue$shift(), 1 <= $kbd_buffer$$.length && $kbd_irq$$()) : ($last_port60_byte$$ = $mouse_buffer$$.ByteQueue$shift(), 1 <= $mouse_buffer$$.length && $mouse_irq$$());
    return $last_port60_byte$$;
  });
  $io$$4$$.register_read(100, function port64_read() {
    var $status_byte$$ = 16;
    if ($mouse_buffer$$.length || $kbd_buffer$$.length) {
      $status_byte$$ |= 1;
    }
    $mouse_buffer$$.length && ($status_byte$$ |= 32);
    return $status_byte$$;
  });
  $io$$4$$.register_write(96, function port60_write($write_byte$$) {
    if ($read_command_register$$) {
      $kbd_irq$$(), $command_register$$ = $write_byte$$, $read_command_register$$ = !1;
    } else {
      if ($read_output_register$$) {
        $read_output_register$$ = !1, $mouse_buffer$$.ByteQueue$clear(), $mouse_buffer$$.ByteQueue$push($write_byte$$), $mouse_irq$$();
      } else {
        if ($next_read_sample$$) {
          $next_read_sample$$ = !1, $mouse_buffer$$.ByteQueue$clear(), $mouse_buffer$$.ByteQueue$push(250), $sample_rate$$ = $write_byte$$, $mouse_irq$$();
        } else {
          if ($next_read_resolution$$) {
            $next_read_resolution$$ = !1, $mouse_buffer$$.ByteQueue$clear(), $mouse_buffer$$.ByteQueue$push(250), $resolution$$ = 3 < $write_byte$$ ? 4 : 1 << $write_byte$$, $mouse_irq$$();
          } else {
            if ($next_read_led$$) {
              $next_read_led$$ = !1, $kbd_buffer$$.ByteQueue$push(250), $kbd_irq$$();
            } else {
              if ($next_handle_scan_code_set$$) {
                $next_handle_scan_code_set$$ = !1, $kbd_buffer$$.ByteQueue$push(250), $kbd_irq$$(), $write_byte$$ || $kbd_buffer$$.ByteQueue$push(2);
              } else {
                if ($next_read_rate$$) {
                  $next_read_rate$$ = !1, $kbd_buffer$$.ByteQueue$push(250), $kbd_irq$$();
                } else {
                  if ($next_is_mouse_command$$) {
                    if ($next_is_mouse_command$$ = !1, $have_mouse$$) {
                      $kbd_buffer$$.ByteQueue$clear();
                      $mouse_buffer$$.ByteQueue$clear();
                      $mouse_buffer$$.ByteQueue$push(250);
                      switch($write_byte$$) {
                        case 230:
                          $scaling2$$ = !1;
                          break;
                        case 231:
                          $scaling2$$ = !0;
                          break;
                        case 232:
                          $next_read_resolution$$ = !0;
                          break;
                        case 233:
                          $send_mouse_packet$$(0, 0);
                          break;
                        case 242:
                          $mouse_buffer$$.ByteQueue$push(0);
                          $mouse_buffer$$.ByteQueue$push(0);
                          $mouse_clicks$$ = $mouse_delta_x$$ = $mouse_delta_y$$ = 0;
                          break;
                        case 243:
                          $next_read_sample$$ = !0;
                          break;
                        case 244:
                          $enable_mouse$$ = $enable_mouse_stream$$ = !0;
                          $mouse$$.enabled = !0;
                          $mouse_clicks$$ = $mouse_delta_x$$ = $mouse_delta_y$$ = 0;
                          break;
                        case 245:
                          $enable_mouse_stream$$ = !1;
                          break;
                        case 246:
                          $enable_mouse_stream$$ = !1;
                          $sample_rate$$ = 100;
                          $scaling2$$ = !1;
                          $resolution$$ = 4;
                          break;
                        case 255:
                          $mouse_buffer$$.ByteQueue$push(170), $mouse_buffer$$.ByteQueue$push(0), $enable_mouse_stream$$ = !1, $sample_rate$$ = 100, $scaling2$$ = !1, $resolution$$ = 4, $mouse_clicks$$ = $mouse_delta_x$$ = $mouse_delta_y$$ = 0;
                      }
                      $mouse_irq$$();
                    }
                  } else {
                    $mouse_buffer$$.ByteQueue$clear();
                    $kbd_buffer$$.ByteQueue$clear();
                    $kbd_buffer$$.ByteQueue$push(250);
                    switch($write_byte$$) {
                      case 237:
                        $next_read_led$$ = !0;
                        break;
                      case 240:
                        $next_handle_scan_code_set$$ = !0;
                        break;
                      case 242:
                        $kbd_buffer$$.ByteQueue$push(171);
                        $kbd_buffer$$.ByteQueue$push(83);
                        break;
                      case 243:
                        $next_read_rate$$ = !0;
                        break;
                      case 244:
                        $enable_keyboard_stream$$ = !0;
                        break;
                      case 245:
                        $enable_keyboard_stream$$ = !1;
                        break;
                      case 255:
                        $kbd_buffer$$.ByteQueue$clear(), $kbd_buffer$$.ByteQueue$push(250), $kbd_buffer$$.ByteQueue$push(170);
                    }
                    $kbd_irq$$();
                  }
                }
              }
            }
          }
        }
      }
    }
  });
  $io$$4$$.register_write(100, function port64_write($write_byte$$1$$) {
    switch($write_byte$$1$$) {
      case 32:
        $kbd_buffer$$.ByteQueue$clear();
        $mouse_buffer$$.ByteQueue$clear();
        $kbd_buffer$$.ByteQueue$push($command_register$$);
        break;
      case 96:
        $read_command_register$$ = !0;
        break;
      case 211:
        $read_output_register$$ = !0;
        break;
      case 212:
        $next_is_mouse_command$$ = !0;
        break;
      case 167:
        $command_register$$ |= 32;
        break;
      case 168:
        $command_register$$ &= -33;
        break;
      case 169:
        $kbd_buffer$$.ByteQueue$clear();
        $mouse_buffer$$.ByteQueue$clear();
        $kbd_buffer$$.ByteQueue$push(0);
        break;
      case 170:
        $kbd_buffer$$.ByteQueue$clear();
        $mouse_buffer$$.ByteQueue$clear();
        $kbd_buffer$$.ByteQueue$push(85);
        break;
      case 171:
        $kbd_buffer$$.ByteQueue$clear();
        $mouse_buffer$$.ByteQueue$clear();
        $kbd_buffer$$.ByteQueue$push(0);
        break;
      case 173:
        $command_register$$ |= 16;
        break;
      case 174:
        $command_register$$ &= -17;
        break;
      case 254:
        $cpu$$1039$$.reboot_internal();
    }
  });
}
;function $PIC$$($cpu$$1040$$, $master$$) {
  var $io$$5$$ = $cpu$$1040$$.io, $irq_mask$$ = 0, $irq_map$$ = 0, $isr$$ = 0, $irr$$ = 0, $is_master$$ = void 0 === $master$$, $slave$$2$$;
  $is_master$$ ? ($slave$$2$$ = new $PIC$$($cpu$$1040$$, this), this.check_irqs = function $this$check_irqs$() {
    var $enabled_irr_irq$$ = $irr$$ & $irq_mask$$;
    if (!$enabled_irr_irq$$) {
      return $slave$$2$$.check_irqs();
    }
    $enabled_irr_irq$$ &= -$enabled_irr_irq$$;
    if ($isr$$ && ($isr$$ & -$isr$$) <= $enabled_irr_irq$$) {
      return!1;
    }
    var $irq_number$$ = Math.int_log2($enabled_irr_irq$$), $enabled_irr_irq$$ = 1 << $irq_number$$;
    $irr$$ &= ~$enabled_irr_irq$$;
    if (4 === $enabled_irr_irq$$) {
      return $slave$$2$$.check_irqs();
    }
    $auto_eoi$$ || ($isr$$ |= $enabled_irr_irq$$);
    $cpu$$1040$$.call_interrupt_vector($irq_map$$ | $irq_number$$, !1, !1);
    return!0;
  }) : this.check_irqs = function $this$check_irqs$() {
    var $enabled_irr$$1_irq$$1$$ = $irr$$ & $irq_mask$$;
    if (!$enabled_irr$$1_irq$$1$$) {
      return!1;
    }
    $enabled_irr$$1_irq$$1$$ &= -$enabled_irr$$1_irq$$1$$;
    if ($isr$$ && ($isr$$ & -$isr$$) <= $enabled_irr$$1_irq$$1$$) {
      return!1;
    }
    var $irq_number$$1$$ = Math.int_log2($enabled_irr$$1_irq$$1$$), $enabled_irr$$1_irq$$1$$ = 1 << $irq_number$$1$$;
    $irr$$ &= ~$enabled_irr$$1_irq$$1$$;
    $isr$$ |= $enabled_irr$$1_irq$$1$$;
    $cpu$$1040$$.call_interrupt_vector($irq_map$$ | $irq_number$$1$$, !1, !1);
    $irr$$ && $master$$.push_irq(2);
    $auto_eoi$$ || ($isr$$ &= ~$enabled_irr$$1_irq$$1$$);
    return!0;
  };
  this.dump = function $this$dump$() {
    $is_master$$ && $slave$$2$$.dump();
  };
  var $expect_icw4$$, $state$$ = 0, $read_irr$$ = 1, $io_base$$, $auto_eoi$$;
  $io_base$$ = $is_master$$ ? 32 : 160;
  $io$$5$$.register_write($io_base$$, function port20_write($data_byte$$6$$) {
    if ($data_byte$$6$$ & 16) {
      $expect_icw4$$ = $data_byte$$6$$ & 1, $state$$ = 1;
    } else {
      if ($data_byte$$6$$ & 8) {
        $read_irr$$ = $data_byte$$6$$ & 1;
      } else {
        var $eoi_type$$ = $data_byte$$6$$ >> 5;
        1 === $eoi_type$$ ? $isr$$ &= $isr$$ - 1 : 3 === $eoi_type$$ && ($isr$$ &= ~(1 << ($data_byte$$6$$ & 7)));
      }
    }
  });
  $io$$5$$.register_read($io_base$$, function port20_read() {
    return $read_irr$$ ? $irr$$ : $isr$$;
  });
  $io$$5$$.register_write($io_base$$ | 1, function port21_write($data_byte$$7$$) {
    0 === $state$$ ? $expect_icw4$$ ? ($expect_icw4$$ = !1, $auto_eoi$$ = $data_byte$$7$$ & 2) : $irq_mask$$ = ~$data_byte$$7$$ : 1 === $state$$ ? ($irq_map$$ = $data_byte$$7$$, $state$$++) : 2 === $state$$ && ($state$$ = 0);
  });
  $io$$5$$.register_read($io_base$$ | 1, function port21_read() {
    return~$irq_mask$$ & 255;
  });
  this.push_irq = $is_master$$ ? function($irq_number$$2$$) {
    8 <= $irq_number$$2$$ && ($slave$$2$$.push_irq($irq_number$$2$$ - 8), $irq_number$$2$$ = 2);
    $irr$$ |= 1 << $irq_number$$2$$;
    $cpu$$1040$$.handle_irqs();
  } : function($irq_number$$3$$) {
    $irr$$ |= 1 << $irq_number$$3$$;
  };
  this.get_isr = function $this$get_isr$() {
    return $isr$$;
  };
}
;function $RTC$$($cpu$$1041$$, $diskette_type$$, $boot_order$$) {
  function $encode_time$$($JSCompiler_temp$$9_n$$inline_695_t$$) {
    if (!($cmos_b$$ & 4)) {
      for (var $i$$inline_696$$ = 0, $result$$inline_697$$ = 0, $digit$$inline_698$$;$JSCompiler_temp$$9_n$$inline_695_t$$;) {
        $digit$$inline_698$$ = $JSCompiler_temp$$9_n$$inline_695_t$$ % 10, $result$$inline_697$$ |= $digit$$inline_698$$ << 4 * $i$$inline_696$$, $i$$inline_696$$++, $JSCompiler_temp$$9_n$$inline_695_t$$ = ($JSCompiler_temp$$9_n$$inline_695_t$$ - $digit$$inline_698$$) / 10;
      }
      $JSCompiler_temp$$9_n$$inline_695_t$$ = $result$$inline_697$$;
    }
    return $JSCompiler_temp$$9_n$$inline_695_t$$;
  }
  var $io$$6$$ = $cpu$$1041$$.io, $pic$$3$$ = $cpu$$1041$$.devices.pic, $memory_size$$2$$ = $cpu$$1041$$.memory.size, $cmos_index$$ = 0, $me$$5$$ = this, $rtc_time$$ = Date.now(), $last_update$$ = $rtc_time$$, $next_interrupt$$ = 0, $cmos_c_was_read$$ = !0, $periodic_interrupt$$ = !1, $periodic_interrupt_time$$ = 0.9765625, $cmos_a$$ = 38, $cmos_b$$ = 2, $cmos_c$$ = 0;
  this.nmi_disabled = 0;
  this.timer = function $this$timer$($time$$2$$) {
    $periodic_interrupt$$ && $cmos_c_was_read$$ && $next_interrupt$$ < $time$$2$$ && ($cmos_c_was_read$$ = !1, $pic$$3$$.push_irq(8), $cmos_c$$ |= 64, $next_interrupt$$ += $periodic_interrupt_time$$ * Math.ceil(($time$$2$$ - $next_interrupt$$) / $periodic_interrupt_time$$));
    $rtc_time$$ += $time$$2$$ - $last_update$$;
    $last_update$$ = $time$$2$$;
  };
  $io$$6$$.register_write(112, function($out_byte$$15$$) {
    $cmos_index$$ = $out_byte$$15$$ & 127;
    $me$$5$$.nmi_disabled = $out_byte$$15$$ >> 7;
  });
  $io$$6$$.register_write(113, function cmos_write($data_byte$$8$$) {
    switch($cmos_index$$) {
      case 10:
        $cmos_a$$ = $data_byte$$8$$ & 127;
        $periodic_interrupt_time$$ = 1E3 / (32768 >> ($cmos_a$$ & 15) - 1);
        break;
      case 11:
        $cmos_b$$ = $data_byte$$8$$, $cmos_b$$ & 64 && ($next_interrupt$$ = Date.now());
    }
    $periodic_interrupt$$ = 64 === ($cmos_b$$ & 64) && 0 < ($cmos_a$$ & 15);
  });
  $io$$6$$.register_read(113, function cmos_read() {
    switch($cmos_index$$) {
      case 0:
        return $encode_time$$((new Date($rtc_time$$)).getUTCSeconds());
      case 2:
        return $encode_time$$((new Date($rtc_time$$)).getUTCMinutes());
      case 4:
        return $encode_time$$((new Date($rtc_time$$)).getUTCHours());
      case 7:
        return $encode_time$$((new Date($rtc_time$$)).getUTCDate());
      case 8:
        return $encode_time$$((new Date($rtc_time$$)).getUTCMonth() + 1);
      case 9:
        return $encode_time$$((new Date($rtc_time$$)).getUTCFullYear() % 100);
      case 10:
        return $cmos_a$$;
      case 11:
        return $cmos_b$$;
      case 14:
        return 0;
      case 12:
        return $cmos_c_was_read$$ = !0, $cmos_c$$;
      case 15:
        return 0;
      case 16:
        return $diskette_type$$;
      case 20:
        return 45;
      case 50:
        return $encode_time$$((new Date($rtc_time$$)).getUTCFullYear() / 100 | 0);
      case 52:
        return $memory_size$$2$$ - 16777216 >> 16 & 255;
      case 53:
        return $memory_size$$2$$ - 16777216 >> 24 & 255;
      case 56:
        return 1 | $boot_order$$ >> 4 & 240;
      case 61:
        return $boot_order$$ & 255;
      case 91:
      ;
      case 92:
      ;
      case 93:
        return 0;
    }
    return 255;
  });
}
;function $UART$$($cpu$$1042$$, $adapter$$1$$) {
  var $io$$7$$ = $cpu$$1042$$.io, $pic$$4$$ = $cpu$$1042$$.devices.pic, $baud_rate$$ = 0, $line_control$$ = 0, $interrupt_enable$$ = 0, $iir$$ = 1, $modem_control$$ = 0, $scratch_register$$ = 0, $irq$$2$$ = 0, $input$$ = new $ByteQueue$$(4096), $irq$$2$$ = 4;
  $adapter$$1$$.init(function data_received($data$$216$$) {
    $input$$.ByteQueue$push($data$$216$$);
    $interrupt_enable$$ & 1 && $pic$$4$$.push_irq($irq$$2$$);
  });
  $io$$7$$.register_write(1016, function($out_byte$$16$$) {
    $line_control$$ & 128 ? $baud_rate$$ = $baud_rate$$ & -256 | $out_byte$$16$$ : 255 !== $out_byte$$16$$ && $adapter$$1$$ && ($adapter$$1$$.put_line || $adapter$$1$$.put_str(String.fromCharCode($out_byte$$16$$)));
  });
  $io$$7$$.register_write(1017, function($out_byte$$17$$) {
    $line_control$$ & 128 ? $baud_rate$$ = $baud_rate$$ & 255 | $out_byte$$17$$ << 8 : $interrupt_enable$$ = $out_byte$$17$$;
  });
  $io$$7$$.register_read(1016, function() {
    return $line_control$$ & 128 ? $baud_rate$$ & 255 : $input$$.ByteQueue$shift();
  });
  $io$$7$$.register_read(1017, function() {
    return $line_control$$ & 128 ? $baud_rate$$ >> 8 : $interrupt_enable$$;
  });
  $io$$7$$.register_read(1018, function() {
    var $ret$$1$$ = $iir$$;
    $iir$$ ^= 1;
    return $ret$$1$$;
  });
  $io$$7$$.register_write(1018, function() {
  });
  $io$$7$$.register_read(1019, function() {
    return $line_control$$;
  });
  $io$$7$$.register_write(1019, function($out_byte$$19$$) {
    $line_control$$ = $out_byte$$19$$;
  });
  $io$$7$$.register_read(1020, function() {
    return $modem_control$$;
  });
  $io$$7$$.register_write(1020, function($out_byte$$20$$) {
    $modem_control$$ = $out_byte$$20$$;
  });
  $io$$7$$.register_read(1021, function() {
    var $line_status$$1$$ = 0;
    $input$$.length && ($line_status$$1$$ |= 1);
    return $line_status$$1$$ | 96;
  });
  $io$$7$$.register_write(1021, function() {
  });
  $io$$7$$.register_read(1022, function() {
    return 0;
  });
  $io$$7$$.register_write(1022, function() {
  });
  $io$$7$$.register_read(1023, function() {
    return $scratch_register$$;
  });
  $io$$7$$.register_write(1023, function($out_byte$$23$$) {
    $scratch_register$$ = $out_byte$$23$$;
  });
}
;function $ACPI$$() {
}
;
