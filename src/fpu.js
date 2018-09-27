"use strict";

/** @const */
var FPU_LOG_OP = false;

var
    /** @const */
    FPU_C0 = 0x100,
    /** @const */
    FPU_C1 = 0x200,
    /** @const */
    FPU_C2 = 0x400,
    /** @const */
    FPU_C3 = 0x4000,
    /** @const */
    FPU_RESULT_FLAGS = FPU_C0 | FPU_C1 | FPU_C2 | FPU_C3,
    /** @const */
    FPU_STACK_TOP = 0x3800;

var
    // precision, round & infinity control
    /** @const */
    FPU_PC = 3 << 8,
    /** @const */
    FPU_RC = 3 << 10,
    /** @const */
    FPU_IF = 1 << 12;

// exception bits in the status word
var
    /** @const */
    FPU_EX_SF = 1 << 6,
    /** @const */
    FPU_EX_P = 1 << 5,
    /** @const */
    FPU_EX_U = 1 << 4,
    /** @const */
    FPU_EX_O = 1 << 3,
    /** @const */
    FPU_EX_Z = 1 << 2,
    /** @const */
    FPU_EX_D = 1 << 1,
    /** @const */
    FPU_EX_I = 1 << 0;

var
    /** @const */
    TWO_POW_63 =  0x8000000000000000;

/**
 * @constructor
 * @param {CPU} cpu
 */
function FPU(cpu)
{
    // TODO:
    // - Precision Control
    // - QNaN, unordered comparison
    // - Exceptions

    this.cpu = cpu;

    // Why no Float80Array :-(
    this.st = new Float64Array(8);

    // used for conversion
    /** @const */ this.float32 = new Float32Array(1);
    /** @const */ this.float32_byte = new Uint8Array(this.float32.buffer);
    /** @const */ this.float32_int = new Int32Array(this.float32.buffer);
    /** @const */ this.float64 = new Float64Array(1);
    /** @const */ this.float64_byte = new Uint8Array(this.float64.buffer);
    /** @const */ this.float64_int = new Int32Array(this.float64.buffer);

    /** @const */ this.st8 = new Uint8Array(this.st.buffer);
    /** @const */ this.st32 = new Int32Array(this.st.buffer);


    // bitmap of which stack registers are empty
    this.stack_empty = 0xff;
    this.stack_ptr = 0;

    this.control_word = 0x37F;
    this.status_word = 0;
    this.fpu_ip = 0;
    this.fpu_ip_selector = 0;
    this.fpu_opcode = 0;
    this.fpu_dp = 0;
    this.fpu_dp_selector = 0;

    /** @const */
    this.indefinite_nan = NaN;

    /** @const */
    this.constants = new Float64Array([
        1, Math.log(10) / Math.LN2, Math.LOG2E, Math.PI,
        Math.log(2) / Math.LN10, Math.LN2, 0
    ]);

}

FPU.prototype.get_state = function()
{
    var state = [];

    state[0] = this.st;
    state[1] = this.stack_empty;
    state[2] = this.stack_ptr;
    state[3] = this.control_word;
    state[4] = this.fpu_dp_selector;
    state[5] = this.fpu_ip;
    state[6] = this.fpu_ip_selector;
    state[7] = this.fpu_dp;
    state[8] = this.fpu_dp_selector;
    state[9] = this.fpu_opcode;

    return state;
};

FPU.prototype.set_state = function(state)
{
    this.st.set(state[0]);
    this.stack_empty = state[1];
    this.stack_ptr = state[2];
    this.control_word = state[3];
    this.fpu_dp_selector = state[4];
    this.fpu_ip = state[5];
    this.fpu_ip_selector = state[6];
    this.fpu_dp = state[7];
    this.fpu_dp_selector = state[8];
    this.fpu_opcode = state[9];
};

FPU.prototype.fpu_unimpl = function()
{
    dbg_trace();
    if(DEBUG) throw "fpu: unimplemented";
    else this.cpu.trigger_ud();
}

FPU.prototype.stack_fault = function()
{
    // TODO: Interrupt
    this.status_word |= FPU_EX_SF | FPU_EX_I;
}

FPU.prototype.invalid_arithmatic = function()
{
    this.status_word |= FPU_EX_I;
}

FPU.prototype.fcom = function(y)
{
    var x = this.get_st0();

    this.status_word &= ~FPU_RESULT_FLAGS;

    if(x > y)
    {
    }
    else if(y > x)
    {
        this.status_word |= FPU_C0;
    }
    else if(x === y)
    {
        this.status_word |= FPU_C3;
    }
    else
    {
        this.status_word |= FPU_C0 | FPU_C2 | FPU_C3;
    }
}

FPU.prototype.fucom = function(y)
{
    // TODO
    this.fcom(y);
}


FPU.prototype.fcomi = function(y)
{
    var x = this.st[this.stack_ptr];

    this.cpu.flags_changed &= ~(1 | flag_parity | flag_zero);
    this.cpu.flags &= ~(1 | flag_parity | flag_zero);

    if(x > y)
    {
    }
    else if(y > x)
    {
        this.cpu.flags |= 1;
    }
    else if(x === y)
    {
        this.cpu.flags |= flag_zero;
    }
    else
    {
        this.cpu.flags |= 1 | flag_parity | flag_zero;
    }
}

FPU.prototype.fucomi = function(y)
{
    // TODO
    this.fcomi(y);
}

FPU.prototype.ftst = function(x)
{
    this.status_word &= ~FPU_RESULT_FLAGS;

    if(isNaN(x))
    {
        this.status_word |= FPU_C3 | FPU_C2 | FPU_C0;
    }
    else if(x === 0)
    {
        this.status_word |= FPU_C3;
    }
    else if(x < 0)
    {
        this.status_word |= FPU_C0;
    }

    // TODO: unordered (x is nan, etc)
}

FPU.prototype.fxam = function(x)
{
    this.status_word &= ~FPU_RESULT_FLAGS;
    this.status_word |= this.sign(0) << 9;

    if(this.stack_empty >> this.stack_ptr & 1)
    {
        this.status_word |= FPU_C3 | FPU_C0;
    }
    else if(isNaN(x))
    {
        this.status_word |= FPU_C0;
    }
    else if(x === 0)
    {
        this.status_word |= FPU_C3;
    }
    else if(x === Infinity || x === -Infinity)
    {
        this.status_word |= FPU_C2 | FPU_C0;
    }
    else
    {
        this.status_word |= FPU_C2;
    }
    // TODO:
    // Unsupported, Denormal
}

FPU.prototype.finit = function()
{
    this.control_word = 0x37F;
    this.status_word = 0;
    this.fpu_ip = 0;
    this.fpu_dp = 0;
    this.fpu_opcode = 0;

    this.stack_empty = 0xFF;
    this.stack_ptr = 0;
}

FPU.prototype.load_status_word = function()
{
    return this.status_word & ~(7 << 11) | this.stack_ptr << 11;
}

FPU.prototype.set_status_word = function(sw)
{
    this.status_word = sw & ~(7 << 11);
    this.stack_ptr = sw >> 11 & 7;
}

FPU.prototype.load_tag_word = function()
{
    var tag_word = 0,
        value;

    for(var i = 0; i < 8; i++)
    {
        value = this.st[i];

        if(this.stack_empty >> i & 1)
        {
            tag_word |= 3 << (i << 1);
        }
        else if(value === 0)
        {
            tag_word |= 1 << (i << 1);
        }
        else if(!isFinite(value))
        {
            tag_word |= 2 << (i << 1);
        }
    }

    //dbg_log("load  tw=" + h(tag_word) + " se=" + h(this.stack_empty) + " sp=" + this.stack_ptr, LOG_FPU);

    return tag_word;
}

FPU.prototype.set_tag_word = function(tag_word)
{
    this.stack_empty = 0;

    for(var i = 0; i < 8; i++)
    {
        this.stack_empty |= (tag_word >> i) & (tag_word >> i + 1) & 1 << i;
    }

    //dbg_log("set_tag_word  tw=" + h(tag_word) + " se=" + h(this.stack_empty), LOG_FPU);
}

FPU.prototype.fstenv = function(addr)
{
    if(this.cpu.is_osize_32())
    {
        this.cpu.writable_or_pagefault(addr, 26);

        this.cpu.safe_write16(addr, this.control_word);

        this.cpu.safe_write16(addr + 4, this.load_status_word());
        this.cpu.safe_write16(addr + 8, this.load_tag_word());

        this.cpu.safe_write32(addr + 12, this.fpu_ip);
        this.cpu.safe_write16(addr + 16, this.fpu_ip_selector);
        this.cpu.safe_write16(addr + 18, this.fpu_opcode);
        this.cpu.safe_write32(addr + 20, this.fpu_dp);
        this.cpu.safe_write16(addr + 24, this.fpu_dp_selector);
    }
    else
    {
        this.fpu_unimpl();
    }
}

FPU.prototype.fldenv = function(addr)
{
    if(this.cpu.is_osize_32())
    {
        this.control_word = this.cpu.safe_read16(addr);

        this.set_status_word(this.cpu.safe_read16(addr + 4));
        this.set_tag_word(this.cpu.safe_read16(addr + 8));

        this.fpu_ip = this.cpu.safe_read32s(addr + 12);
        this.fpu_ip_selector = this.cpu.safe_read16(addr + 16);
        this.fpu_opcode = this.cpu.safe_read16(addr + 18);
        this.fpu_dp = this.cpu.safe_read32s(addr + 20);
        this.fpu_dp_selector = this.cpu.safe_read16(addr + 24);
    }
    else
    {
        this.fpu_unimpl();
    }
}

FPU.prototype.fsave = function(addr)
{
    this.cpu.writable_or_pagefault(addr, 108);

    this.fstenv(addr);
    addr += 28;

    for(var i = 0; i < 8; i++)
    {
        this.store_m80(addr, this.st[this.stack_ptr + i & 7]);
        addr += 10;
    }

    //dbg_log("save st=" + this.stack_ptr + " " + [].slice.call(this.st), LOG_FPU);

    this.finit();
}

FPU.prototype.frstor = function(addr)
{
    this.fldenv(addr);
    addr += 28;

    for(var i = 0; i < 8; i++)
    {
        this.st[(i + this.stack_ptr) & 7] = this.load_m80(addr);
        addr += 10;
    }

    //dbg_log("rstor st=" + this.stack_ptr + " " + [].slice.call(this.st), LOG_FPU);
}

FPU.prototype.fxtract = function()
{
    this.float64[0] = this.get_st0();

    var exponent = ((this.float64_byte[7] & 0x7F) << 4 | this.float64_byte[6] >> 4) - 0x3FF;

    this.float64_byte[7] = 0x3F | (this.float64_byte[7] & 0x80);
    this.float64_byte[6] |= 0xF0;

    this.st[this.stack_ptr] = exponent;
    this.push(this.float64[0]);
};

FPU.prototype.integer_round = function(f)
{
    var rc = this.control_word >> 10 & 3;
    return this.cpu.integer_round(f, rc);
}

FPU.prototype.truncate = function(x)
{
    return x > 0 ? Math.floor(x) : Math.ceil(x);
}

FPU.prototype.push = function(x)
{
    this.stack_ptr = this.stack_ptr - 1 & 7;

    if(this.stack_empty >> this.stack_ptr & 1)
    {
        this.status_word &= ~FPU_C1;
        this.stack_empty &= ~(1 << this.stack_ptr);
        this.st[this.stack_ptr] = x;
    }
    else
    {
        this.status_word |= FPU_C1;
        this.stack_fault();
        this.st[this.stack_ptr] = this.indefinite_nan;
    }
}

FPU.prototype.pop = function()
{
    this.stack_empty |= 1 << this.stack_ptr;
    this.stack_ptr = this.stack_ptr + 1 & 7;
}

FPU.prototype.get_sti = function(i)
{
    dbg_assert(typeof i === "number" && i >= 0 && i < 8);

    i = i + this.stack_ptr & 7;

    if(this.stack_empty >> i & 1)
    {
        this.status_word &= ~FPU_C1;
        this.stack_fault();
        return this.indefinite_nan;
    }
    else
    {
        return this.st[i];
    }
}

FPU.prototype.get_st0 = function()
{
    if(this.stack_empty >> this.stack_ptr & 1)
    {
        this.status_word &= ~FPU_C1;
        this.stack_fault();
        return this.indefinite_nan;
    }
    else
    {
        return this.st[this.stack_ptr];
    }
}

FPU.prototype.load_m80 = function(addr)
{
    var exponent = this.cpu.safe_read16(addr + 8),
        sign,
        low = this.cpu.safe_read32s(addr) >>> 0,
        high = this.cpu.safe_read32s(addr + 4) >>> 0;

    sign = exponent >> 15;
    exponent &= ~0x8000;

    if(exponent === 0)
    {
        // TODO: denormal numbers
        return 0;
    }

    if(exponent < 0x7FFF)
    {
        exponent -= 0x3FFF;
    }
    else
    {
        // TODO: NaN, Infinity
        //dbg_log("Load m80 TODO", LOG_FPU);
        this.float64_byte[7] = 0x7F | sign << 7;
        this.float64_byte[6] = 0xF0 | high >> 30 << 3 & 0x08;

        this.float64_byte[5] = 0;
        this.float64_byte[4] = 0;

        this.float64_int[0] = 0;

        return this.float64[0];
    }

    // Note: some bits might be lost at this point
    var mantissa = low + 0x100000000 * high;

    if(sign)
    {
        mantissa = -mantissa;
    }

    //console.log("m: " + mantissa);
    //console.log("e: " + exponent);
    //console.log("s: " + this.sign);
    //console.log("f: " + mantissa * Math.pow(2, exponent - 63));

    // Simply compute the 64 bit floating point number.
    // An alternative write the mantissa, sign and exponent in the
    // float64_byte and return float64[0]

    return mantissa * Math.pow(2, exponent - 63);
}

FPU.prototype.store_m80 = function(addr, n)
{
    this.float64[0] = n;

    var sign = this.float64_byte[7] & 0x80,
        exponent = (this.float64_byte[7] & 0x7f) << 4 | this.float64_byte[6] >> 4,
        low,
        high;

    if(exponent === 0x7FF)
    {
        // all bits set (NaN and infinity)
        exponent = 0x7FFF;
        low = 0;
        high = 0x80000000 | (this.float64_int[1] & 0x80000) << 11;
    }
    else if(exponent === 0)
    {
        // zero and denormal numbers
        // Just assume zero for now
        low = 0;
        high = 0;
    }
    else
    {
        exponent += 0x3FFF - 0x3FF;

        // does the mantissa need to be adjusted?
        low = this.float64_int[0] << 11;
        high = 0x80000000 | (this.float64_int[1] & 0xFFFFF) << 11 | (this.float64_int[0] >>> 21);
    }

    dbg_assert(exponent >= 0 && exponent < 0x8000);

    this.cpu.safe_write32(addr, low);
    this.cpu.safe_write32(addr + 4, high);

    this.cpu.safe_write16(addr + 8, sign << 8 | exponent);
}

FPU.prototype.load_m64 = function(addr)
{
    var low = this.cpu.safe_read32s(addr),
        high = this.cpu.safe_read32s(addr + 4);

    this.float64_int[0] = low;
    this.float64_int[1] = high;

    return this.float64[0];
};

FPU.prototype.store_m64 = function(addr, i)
{
    this.cpu.writable_or_pagefault(addr, 8);

    this.float64[0] = this.get_sti(i);

    this.cpu.safe_write32(addr, this.float64_int[0]);
    this.cpu.safe_write32(addr + 4, this.float64_int[1]);
};

FPU.prototype.load_m32 = function(addr)
{
    this.float32_int[0] = this.cpu.safe_read32s(addr);

    return this.float32[0];
};

FPU.prototype.store_m32 = function(addr, x)
{
    this.float32[0] = x;

    this.cpu.safe_write32(addr, this.float32_int[0]);
};

// sign of a number on the stack
FPU.prototype.sign = function(i)
{
    return this.st8[(this.stack_ptr + i & 7) << 3 | 7] >> 7;
};


FPU.prototype.dbg_log_fpu_op = function(op, imm8)
{
    if(!FPU_LOG_OP)
    {
        return;
    }

    if(imm8 >= 0xC0)
    {
        dbg_log(h(op, 2) + " " + h(imm8, 2) + "/" + (imm8 >> 3 & 7) + "/" + (imm8 & 7) +
                " @" + h(this.cpu.instruction_pointer >>> 0, 8) + " sp=" + this.stack_ptr + " st=" + h(this.stack_empty, 2), LOG_FPU);
    }
    else
    {
        dbg_log(h(op, 2) + " /" + (imm8 >> 3 & 7) +
                "     @" + h(this.cpu.instruction_pointer >>> 0, 8) + " sp=" + this.stack_ptr + " st=" + h(this.stack_empty, 2), LOG_FPU);
    }
}


FPU.prototype.fwait = function()
{
    // NOP unless FPU instructions run in parallel with CPU instructions
};


FPU.prototype.op_D8_reg = function(imm8)
{
    this.dbg_log_fpu_op(0xD8, imm8);

    var mod = imm8 >> 3 & 7,
        low = imm8 & 7,
        sti = this.get_sti(low),
        st0 = this.get_st0();

    switch(mod)
    {
        case 0:
            // fadd
            this.st[this.stack_ptr] = st0 + sti;
            break;
        case 1:
            // fmul
            this.st[this.stack_ptr] = st0 * sti;
            break;
        case 2:
            // fcom
            this.fcom(sti);
            break;
        case 3:
            // fcomp
            this.fcom(sti);
            this.pop();
            break;
        case 4:
            // fsub
            this.st[this.stack_ptr] = st0 - sti;
            break;
        case 5:
            // fsubr
            this.st[this.stack_ptr] = sti - st0;
            break;
        case 6:
            // fdiv
            this.st[this.stack_ptr] = st0 / sti;
            break;
        case 7:
            // fdivr
            this.st[this.stack_ptr] = sti / st0;
            break;
        default:
            dbg_assert(false);
    }
};

FPU.prototype.op_D8_mem = function(imm8, addr)
{
    this.dbg_log_fpu_op(0xD8, imm8);

    var mod = imm8 >> 3 & 7,
        m32 = this.load_m32(addr);

    var st0 = this.get_st0();

    switch(mod)
    {
        case 0:
            // fadd
            this.st[this.stack_ptr] = st0 + m32;
            break;
        case 1:
            // fmul
            this.st[this.stack_ptr] = st0 * m32;
            break;
        case 2:
            // fcom
            this.fcom(m32);
            break;
        case 3:
            // fcomp
            this.fcom(m32);
            this.pop();
            break;
        case 4:
            // fsub
            this.st[this.stack_ptr] = st0 - m32;
            break;
        case 5:
            // fsubr
            this.st[this.stack_ptr] = m32 - st0;
            break;
        case 6:
            // fdiv
            this.st[this.stack_ptr] = st0 / m32;
            break;
        case 7:
            // fdivr
            this.st[this.stack_ptr] = m32 / st0;
            break;
        default:
            dbg_assert(false);
    }
};

FPU.prototype.op_D9_reg = function(imm8)
{
    this.dbg_log_fpu_op(0xD9, imm8);

    var mod = imm8 >> 3 & 7,
        low = imm8 & 7;

    switch(mod)
    {
        case 0:
            // fld
            var sti = this.get_sti(low);
            this.push(sti);
            break;
        case 1:
            // fxch
            var sti = this.get_sti(low);

            this.st[this.stack_ptr + low & 7] = this.get_st0();
            this.st[this.stack_ptr] = sti;
            break;
        case 2:
            switch(low)
            {
                case 0:
                    // fnop
                    break;
                default:
                    dbg_log(low);
                    this.fpu_unimpl();
            }
            break;
        case 3:
            // fstp1
            this.fpu_unimpl();
            break;
        case 4:
            var st0 = this.get_st0();

            switch(low)
            {
                case 0:
                    // fchs
                    this.st[this.stack_ptr] = -st0;
                    break;
                case 1:
                    // fabs
                    this.st[this.stack_ptr] = Math.abs(st0);
                    break;
                case 4:
                    this.ftst(st0);
                    break;
                case 5:
                    this.fxam(st0);
                    break;
                default:
                    dbg_log(low);
                    this.fpu_unimpl();
            }
            break;
        case 5:
            this.push(this.constants[low]);
            break;
        case 6:
            var st0 = this.get_st0();

            switch(low)
            {
                case 0:
                    // f2xm1
                    this.st[this.stack_ptr] = Math.pow(2, st0) - 1;
                    break;
                case 1:
                    // fyl2x
                    this.st[this.stack_ptr + 1 & 7] = this.get_sti(1) * Math.log(st0) / Math.LN2;
                    this.pop();
                    break;
                case 2:
                    // fptan
                    this.st[this.stack_ptr] = Math.tan(st0);
                    this.push(1); // no bug: push constant 1
                    break;
                case 3:
                    // fpatan
                    this.st[this.stack_ptr + 1 & 7] = Math.atan2(this.get_sti(1), st0);
                    this.pop();
                    break;
                case 4:
                    this.fxtract();
                    break;
                case 5:
                    // fprem1
                    this.st[this.stack_ptr] = st0 % this.get_sti(1);
                    break;
                case 6:
                    // fdecstp
                    this.stack_ptr = this.stack_ptr - 1 & 7;
                    this.status_word &= ~FPU_C1;
                    break;
                case 7:
                    // fincstp
                    this.stack_ptr = this.stack_ptr + 1 & 7;
                    this.status_word &= ~FPU_C1;
                    break;
                default:
                    dbg_assert(false);
            }
            break;
        case 7:
            var st0 = this.get_st0();

            switch(low)
            {
                case 0:
                    // fprem
                    var st1 = this.get_sti(1);
                    var fprem_quotient = Math.trunc(st0 / st1);
                    this.st[this.stack_ptr] = st0 % st1;

                    this.status_word &= ~(FPU_C0 | FPU_C1 | FPU_C3);
                    if (fprem_quotient & 1) {
                        this.status_word |= FPU_C1;
                    }
                    if (fprem_quotient & (1 << 1)) {
                        this.status_word |= FPU_C3;
                    }
                    if (fprem_quotient & (1 << 2)) {
                        this.status_word |= FPU_C0;
                    }

                    this.status_word &= ~FPU_C2;
                    break;
                case 1:
                    // fyl2xp1: y * log2(x+1) and pop
                    this.st[this.stack_ptr + 1 & 7] = this.get_sti(1) * Math.log(st0 + 1) / Math.LN2;
                    this.pop();
                    break;
                case 2:
                    this.st[this.stack_ptr] = Math.sqrt(st0);
                    break;
                case 3:
                    this.st[this.stack_ptr] = Math.sin(st0);
                    this.push(Math.cos(st0));
                    break;
                case 4:
                    // frndint
                    this.st[this.stack_ptr] = this.integer_round(st0);
                    break;
                case 5:
                    // fscale
                    this.st[this.stack_ptr] = st0 * Math.pow(2, this.truncate(this.get_sti(1)));
                    break;
                case 6:
                    this.st[this.stack_ptr] = Math.sin(st0);
                    break;
                case 7:
                    this.st[this.stack_ptr] = Math.cos(st0);
                    break;
                default:
                    dbg_assert(false);
            }
            break;
        default:
            dbg_assert(false);
    }
};

FPU.prototype.op_D9_mem = function(imm8, addr)
{
    this.dbg_log_fpu_op(0xD9, imm8);

    var mod = imm8 >> 3 & 7;

    switch(mod)
    {
        case 0:
            // fld
            var data = this.load_m32(addr);
            this.push(data);
            break;
        case 1:
            // not defined
            this.fpu_unimpl();
            break;
        case 2:
            // fst
            this.store_m32(addr, this.get_st0());
            break;
        case 3:
            // fstp
            this.store_m32(addr, this.get_st0());
            this.pop();
            break;
        case 4:
            this.fldenv(addr);
            break;
        case 5:
            // fldcw
            var word = this.cpu.safe_read16(addr);
            this.control_word = word;
            break;
        case 6:
            this.fstenv(addr);
            break;
        case 7:
            // fstcw
            this.cpu.safe_write16(addr, this.control_word);
            break;
        default:
            dbg_assert(false);
    }
};

FPU.prototype.op_DA_reg = function(imm8)
{
    this.dbg_log_fpu_op(0xDA, imm8);

    var mod = imm8 >> 3 & 7,
        low = imm8 & 7;

    switch(mod)
    {
        case 0:
            // fcmovb
            if(this.cpu.test_b())
            {
                this.st[this.stack_ptr] = this.get_sti(low);
                this.stack_empty &= ~(1 << this.stack_ptr);
            }
            break;
        case 1:
            // fcmove
            if(this.cpu.test_z())
            {
                this.st[this.stack_ptr] = this.get_sti(low);
                this.stack_empty &= ~(1 << this.stack_ptr);
            }
            break;
        case 2:
            // fcmovbe
            if(this.cpu.test_be())
            {
                this.st[this.stack_ptr] = this.get_sti(low);
                this.stack_empty &= ~(1 << this.stack_ptr);
            }
            break;
        case 3:
            // fcmovu
            if(this.cpu.test_p())
            {
                this.st[this.stack_ptr] = this.get_sti(low);
                this.stack_empty &= ~(1 << this.stack_ptr);
            }
            break;
        case 5:
            if(low === 1)
            {
                // fucompp
                this.fucom(this.get_sti(1));
                this.pop();
                this.pop();
            }
            else
            {
                dbg_log(mod); this.fpu_unimpl();
            }
            break;
        default:
            dbg_log(mod);
            this.fpu_unimpl();
    }
};

FPU.prototype.op_DA_mem = function(imm8, addr)
{
    this.dbg_log_fpu_op(0xDA, imm8);

    var mod = imm8 >> 3 & 7,
        m32 = this.cpu.safe_read32s(addr);

    var st0 = this.get_st0();

    switch(mod)
    {
        case 0:
            // fadd
            this.st[this.stack_ptr] = st0 + m32;
            break;
        case 1:
            // fmul
            this.st[this.stack_ptr] = st0 * m32;
            break;
        case 2:
            // fcom
            this.fcom(m32);
            break;
        case 3:
            // fcomp
            this.fcom(m32);
            this.pop();
            break;
        case 4:
            // fsub
            this.st[this.stack_ptr] = st0 - m32;
            break;
        case 5:
            // fsubr
            this.st[this.stack_ptr] = m32 - st0;
            break;
        case 6:
            // fdiv
            this.st[this.stack_ptr] = st0 / m32;
            break;
        case 7:
            // fdivr
            this.st[this.stack_ptr] = m32 / st0;
            break;
        default:
            dbg_assert(false);
    }
};

FPU.prototype.op_DB_reg = function(imm8)
{
    this.dbg_log_fpu_op(0xDB, imm8);

    var mod = imm8 >> 3 & 7,
        low = imm8 & 7;

    switch(mod)
    {
        case 0:
            // fcmovnb
            if(!this.cpu.test_b())
            {
                this.st[this.stack_ptr] = this.get_sti(low);
                this.stack_empty &= ~(1 << this.stack_ptr);
            }
            break;
        case 1:
            // fcmovne
            if(!this.cpu.test_z())
            {
                this.st[this.stack_ptr] = this.get_sti(low);
                this.stack_empty &= ~(1 << this.stack_ptr);
            }
            break;
        case 2:
            // fcmovnbe
            if(!this.cpu.test_be())
            {
                this.st[this.stack_ptr] = this.get_sti(low);
                this.stack_empty &= ~(1 << this.stack_ptr);
            }
            break;
        case 3:
            // fcmovnu
            if(!this.cpu.test_p())
            {
                this.st[this.stack_ptr] = this.get_sti(low);
                this.stack_empty &= ~(1 << this.stack_ptr);
            }
            break;
        case 4:
            if(imm8 === 0xE3)
            {
                this.finit();
            }
            else if(imm8 === 0xE4)
            {
                // fsetpm
                // treat as nop
            }
            else if(imm8 === 0xE1)
            {
                // fdisi
                // also treat as nop
            }
            else if(imm8 === 0xE2)
            {
                // fclex
                this.status_word = 0;
            }
            else
            {
                dbg_log(h(imm8));
                this.fpu_unimpl();
            }
            break;
        case 5:
            this.fucomi(this.get_sti(low));
            break;
        case 6:
            this.fcomi(this.get_sti(low));
            break;
        default:
            dbg_log(mod);
            this.fpu_unimpl();
    }
};

FPU.prototype.op_DB_mem = function(imm8, addr)
{
    this.dbg_log_fpu_op(0xDB, imm8);

    var mod = imm8 >> 3 & 7;

    switch(mod)
    {
        case 0:
            // fild
            var int32 = this.cpu.safe_read32s(addr);
            this.push(int32);
            break;
        case 2:
            // fist
            var st0 = this.integer_round(this.get_st0());
            if(st0 <= 0x7FFFFFFF && st0 >= -0x80000000)
            {
                // TODO: Invalid operation
                this.cpu.safe_write32(addr, st0);
            }
            else
            {
                this.invalid_arithmatic();
                this.cpu.safe_write32(addr, 0x80000000|0);
            }
            break;
        case 3:
            // fistp
            var st0 = this.integer_round(this.get_st0());
            if(st0 <= 0x7FFFFFFF && st0 >= -0x80000000)
            {
                this.cpu.safe_write32(addr, st0);
            }
            else
            {
                this.invalid_arithmatic();
                this.cpu.safe_write32(addr, 0x80000000|0);
            }
            this.pop();
            break;
        case 5:
            // fld
            this.push(this.load_m80(addr));
            break;
        case 7:
            // fstp
            this.cpu.writable_or_pagefault(addr, 10);
            this.store_m80(addr, this.get_st0());
            this.pop();
            break;
        default:
            dbg_log(mod);
            this.fpu_unimpl();
    }
};

FPU.prototype.op_DC_reg = function(imm8)
{
    this.dbg_log_fpu_op(0xDC, imm8);

    var mod = imm8 >> 3 & 7,
        low = imm8 & 7,
        low_ptr = this.stack_ptr + low & 7,
        sti = this.get_sti(low),
        st0 = this.get_st0();

    switch(mod)
    {
        case 0:
            // fadd
            this.st[low_ptr] = sti + st0;
            break;
        case 1:
            // fmul
            this.st[low_ptr] = sti * st0;
            break;
        case 2:
            // fcom
            this.fcom(sti);
            break;
        case 3:
            // fcomp
            this.fcom(sti);
            this.pop();
            break;
        case 4:
            // fsubr
            this.st[low_ptr] = st0 - sti;
            break;
        case 5:
            // fsub
            this.st[low_ptr] = sti - st0;
            break;
        case 6:
            // fdivr
            this.st[low_ptr] = st0 / sti;
            break;
        case 7:
            // fdiv
            this.st[low_ptr] = sti / st0;
            break;
        default:
            dbg_assert(false);
    }
};

FPU.prototype.op_DC_mem = function(imm8, addr)
{
    this.dbg_log_fpu_op(0xDC, imm8);

    var
        mod = imm8 >> 3 & 7,
        m64 = this.load_m64(addr);

    var st0 = this.get_st0();

    switch(mod)
    {
        case 0:
            // fadd
            this.st[this.stack_ptr] = st0 + m64;
            break;
        case 1:
            // fmul
            this.st[this.stack_ptr] = st0 * m64;
            break;
        case 2:
            // fcom
            this.fcom(m64);
            break;
        case 3:
            // fcomp
            this.fcom(m64);
            this.pop();
            break;
        case 4:
            // fsub
            this.st[this.stack_ptr] = st0 - m64;
            break;
        case 5:
            // fsubr
            this.st[this.stack_ptr] = m64 - st0;
            break;
        case 6:
            // fdiv
            this.st[this.stack_ptr] = st0 / m64;
            break;
        case 7:
            // fdivr
            this.st[this.stack_ptr] = m64 / st0;
            break;
        default:
            dbg_assert(false);
    }
};

FPU.prototype.op_DD_reg = function(imm8)
{
    this.dbg_log_fpu_op(0xDD, imm8);

    var mod = imm8 >> 3 & 7,
        low = imm8 & 7;

    switch(mod)
    {
        case 0:
            // ffree
            this.stack_empty |= 1 << (this.stack_ptr + low & 7);
            break;
        case 2:
            // fst
            this.st[this.stack_ptr + low & 7] = this.get_st0();
            break;
        case 3:
            // fstp
            if(low === 0)
            {
                this.pop();
            }
            else
            {
                this.st[this.stack_ptr + low & 7] = this.get_st0();
                this.pop();
            }
            break;
        case 4:
            this.fucom(this.get_sti(low));
            break;
        case 5:
            // fucomp
            this.fucom(this.get_sti(low));
            this.pop();
            break;
        default:
            dbg_log(mod);
            this.fpu_unimpl();
    }
};

FPU.prototype.op_DD_mem = function(imm8, addr)
{
    this.dbg_log_fpu_op(0xDD, imm8);

    var mod = imm8 >> 3 & 7;

    switch(mod)
    {
        case 0:
            // fld
            var data = this.load_m64(addr);
            this.push(data);
            break;
        case 1:
            // fisttp
            this.fpu_unimpl();
            break;
        case 2:
            // fst
            this.store_m64(addr, 0);
            break;
        case 3:
            // fstp
            this.store_m64(addr, 0);
            this.pop();
            break;
        case 4:
            this.frstor(addr);
            break;
        case 5:
            // nothing
            this.fpu_unimpl();
            break;
        case 6:
            // fsave
            this.fsave(addr);
            break;
        case 7:
            // fnstsw / store status word
            this.cpu.safe_write16(addr, this.load_status_word());
            break;
        default:
            dbg_assert(false);
    }
};


FPU.prototype.op_DE_reg = function(imm8)
{
    this.dbg_log_fpu_op(0xDE, imm8);

    var mod = imm8 >> 3 & 7,
        low = imm8 & 7,
        low_ptr = this.stack_ptr + low & 7,
        sti = this.get_sti(low),
        st0 = this.get_st0();

    switch(mod)
    {
        case 0:
            // faddp
            this.st[low_ptr] = sti + st0;
            break;
        case 1:
            // fmulp
            this.st[low_ptr] = sti * st0;
            break;
        case 2:
            // fcomp
            this.fcom(sti);
            break;
        case 3:
            // fcompp
            if(low === 1)
            {
                this.fcom(this.st[low_ptr]);
                this.pop();
            }
            else
            {
                // not a valid encoding
                dbg_log(mod);
                this.fpu_unimpl();
            }
            break;
        case 4:
            // fsubrp
            this.st[low_ptr] = st0 - sti;
            break;
        case 5:
            // fsubp
            this.st[low_ptr] = sti - st0;
            break;
        case 6:
            // fdivrp
            this.st[low_ptr] = st0 / sti;
            break;
        case 7:
            // fdivp
            this.st[low_ptr] = sti / st0;
            break;
        default:
            dbg_assert(false);
    }

    this.pop();
};

FPU.prototype.op_DE_mem = function(imm8, addr)
{
    this.dbg_log_fpu_op(0xDE, imm8);

    var mod = imm8 >> 3 & 7,
        m16 = this.cpu.safe_read16(addr) << 16 >> 16;

    var st0 = this.get_st0();

    switch(mod)
    {
        case 0:
            // fadd
            this.st[this.stack_ptr] = st0 + m16;
            break;
        case 1:
            // fmul
            this.st[this.stack_ptr] = st0 * m16;
            break;
        case 2:
            // fcom
            this.fcom(m16);
            break;
        case 3:
            // fcomp
            this.fcom(m16);
            this.pop();
            break;
        case 4:
            // fsub
            this.st[this.stack_ptr] = st0 - m16;
            break;
        case 5:
            // fsubr
            this.st[this.stack_ptr] = m16 - st0;
            break;
        case 6:
            // fdiv
            this.st[this.stack_ptr] = st0 / m16;
            break;
        case 7:
            // fdivr
            this.st[this.stack_ptr] = m16 / st0;
            break;
        default:
            dbg_assert(false);
    }
};

FPU.prototype.op_DF_reg = function(imm8)
{
    this.dbg_log_fpu_op(0xDF, imm8);

    var mod = imm8 >> 3 & 7,
        low = imm8 & 7;

    switch(mod)
    {
        case 4:
            if(imm8 === 0xE0)
            {
                // fnstsw
                this.cpu.reg16[reg_ax] = this.load_status_word();
            }
            else
            {
                dbg_log(imm8);
                this.fpu_unimpl();
            }
            break;
        case 5:
            // fucomip
            this.fucomi(this.get_sti(low));
            this.pop();
            break;
        case 6:
            // fcomip
            this.fcomi(this.get_sti(low));
            this.pop();
            break;
        default:
            dbg_log(mod);
            this.fpu_unimpl();
    }
};

FPU.prototype.op_DF_mem = function(imm8, addr)
{
    this.dbg_log_fpu_op(0xDF, imm8);

    var mod = imm8 >> 3 & 7;

    switch(mod)
    {
        case 0:
            var m16 = this.cpu.safe_read16(addr) << 16 >> 16;

            this.push(m16);
            break;
        case 1:
            // fisttp
            this.fpu_unimpl();
            break;
        case 2:
            // fist
            var st0 = this.integer_round(this.get_st0());
            if(st0 <= 0x7FFF && st0 >= -0x8000)
            {
                this.cpu.safe_write16(addr, st0);
            }
            else
            {
                this.invalid_arithmatic();
                this.cpu.safe_write16(addr, 0x8000);
            }
            break;
        case 3:
            // fistp
            var st0 = this.integer_round(this.get_st0());
            if(st0 <= 0x7FFF && st0 >= -0x8000)
            {
                this.cpu.safe_write16(addr, st0);
            }
            else
            {
                this.invalid_arithmatic();
                this.cpu.safe_write16(addr, 0x8000);
            }
            this.pop();
            break;
        case 4:
            // fbld
            this.fpu_unimpl();
            break;
        case 5:
            // fild
            var low = this.cpu.safe_read32s(addr) >>> 0,
                high = this.cpu.safe_read32s(addr + 4);

            var m64 = low + 0x100000000 * high;

            this.push(m64);
            break;
        case 6:
            // fbstp
            this.fpu_unimpl();
            break;
        case 7:
            this.cpu.writable_or_pagefault(addr, 8);

            // fistp
            var st0 = this.integer_round(this.get_st0()),
                st0_low,
                st0_high;

            if(st0 < TWO_POW_63 && st0 >= -TWO_POW_63)
            {
                st0_low = st0 | 0;
                st0_high = st0 / 0x100000000 | 0;

                if(st0_high === 0 && st0 < 0)
                    st0_high = -1;
            }
            else
            {
                // write 0x8000000000000000
                st0_low  = 0;
                st0_high = 0x80000000 | 0;
                this.invalid_arithmatic();
            }

            this.cpu.safe_write32(addr, st0_low);
            this.cpu.safe_write32(addr + 4, st0_high);

            this.pop();
            break;
        default:
            dbg_assert(false);
    }
};
