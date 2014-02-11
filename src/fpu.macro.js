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

/*
 * used for conversion
 */
var 
    /** @const */
    float32 = new Float32Array(1),
    /** @const */
    float32_byte = new Uint8Array(float32.buffer),
    /** @const */
    float32_int = new Uint32Array(float32.buffer),

    /** @const */
    float64 = new Float64Array(1),
    /** @const */
    float64_byte = new Uint8Array(float64.buffer),
    /** @const */
    float64_int = new Uint32Array(float64.buffer),

    /** @const */
    float80_int = new Uint8Array(10);


/** @const */
var indefinite_nan = NaN;


/** @const */
var fpu_constants = new Float64Array([
    1, Math.log(10) / Math.LN2, Math.LOG2E, Math.PI,
    Math.log(2) / Math.LN10, Math.LN2, 0
]);

/**
 * @constructor
 */
function FPU(io)
{
    // TODO:
    // - Precision Control
    // - QNaN, unordered comparison
    // - Exceptions

    // Why no Float80Array :-(
    this._st = new Float64Array(8);
    this._st8 = new Uint8Array(this._st.buffer);
    this._st32 = new Uint32Array(this._st.buffer);

    // bitmap of which stack registers are empty
    this._stack_empty = 0xff;
    this._stack_ptr = 0;

    this._control_word = 0x37F;
    this._status_word = 0;
    this._fpu_ip = 0;
    this._fpu_ip_selector = 0;
    this._fpu_opcode = 0;
    this._fpu_dp = 0;
    this._fpu_dp_selector = 0;

}

FPU.prototype._fpu_unimpl = function()
{
    dbg_trace();
    if(DEBUG) throw "fpu: unimplemented";
    else trigger_ud();
}

FPU.prototype._stack_fault = function()
{
    // TODO: Interrupt
    this._status_word |= FPU_EX_SF | FPU_EX_I;
}

FPU.prototype._invalid_arithmatic = function()
{
    this._status_word |= FPU_EX_I;
}

FPU.prototype._fcom = function(y)
{
    var x = this._get_st0();

    this._status_word &= ~FPU_RESULT_FLAGS;

    if(x > y)
    {
    }
    else if(y > x)
    {
        this._status_word |= FPU_C0;
    }
    else if(x === y)
    {
        this._status_word |= FPU_C3;
    }
    else
    {
        this._status_word |= FPU_C0 | FPU_C2 | FPU_C3;
    }
}

FPU.prototype._fucom = function(y)
{
    // TODO
    this._fcom(y);
}


FPU.prototype._fcomi = function(y)
{
    var x = this._st[this._stack_ptr];

    flags_changed &= ~(1 | flag_parity | flag_zero);
    flags &= ~(1 | flag_parity | flag_zero);

    if(x > y)
    {
    }
    else if(y > x)
    {
        flags |= 1;
    }
    else if(x === y)
    {
        flags |= flag_zero;
    }
    else
    {
        flags |= 1 | flag_parity | flag_zero;
    }
}

FPU.prototype._fucomi = function(y)
{
    // TODO
    this._fcomi(y);
}

FPU.prototype._ftst = function()
{
    var st0 = this._get_st0();

    this._status_word &= ~FPU_RESULT_FLAGS;

    if(isNaN(st0))
    {
        this._status_word |= FPU_C3 | FPU_C2 | FPU_C0;
    }
    else if(st0 === 0)
    {
        this._status_word |= FPU_C3;
    }
    else if(st0 < 0)
    {
        this._status_word |= FPU_C0;
    }

    // TODO: unordered (st0 is nan, etc)
}

FPU.prototype._fxam = function()
{
    var x = this._get_st0();

    this._status_word &= ~FPU_RESULT_FLAGS;
    this._status_word |= this._sign(0) << 9;

    if(this._stack_empty >> this._stack_ptr & 1)
    {
        this._status_word |= FPU_C3 | FPU_C0;
    }
    else if(isNaN(x))
    {
        this._status_word |= FPU_C0;
    }
    else if(x === 0)
    {
        this._status_word |= FPU_C3;
    }
    else if(x === Infinity || x === -Infinity)
    {
        this._status_word |= FPU_C2 | FPU_C0;
    }
    else
    {
        this._status_word |= FPU_C2;
    }
    // TODO:
    // Unsupported, Denormal
}

FPU.prototype._finit = function()
{
    this._control_word = 0x37F;
    this._status_word = 0;
    this._fpu_ip = 0;
    this._fpu_dp = 0;
    this._fpu_opcode = 0;

    this._stack_empty = 0xFF;
    this._stack_ptr = 0;
}

FPU.prototype._load_status_word = function()
{
    return this._status_word & ~(7 << 11) | this._stack_ptr << 11;
}

FPU.prototype._safe_status_word = function(sw)
{
    this._status_word = sw & ~(7 << 11);
    this._stack_ptr = sw >> 11 & 7;
}

FPU.prototype._load_tag_word = function()
{
    var tag_word = 0,
        value;

    for(var i = 0; i < 8; i++)
    {
        value = this._st[i];

        if(this._stack_empty >> i & 1)
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

    //dbg_log("load  tw=" + h(tag_word) + " se=" + h(this._stack_empty) + " sp=" + this._stack_ptr, LOG_FPU);

    return tag_word;
}

FPU.prototype._safe_tag_word = function(tag_word)
{
    this._stack_empty = 0;

    for(var i = 0; i < 8; i++)
    {
        this._stack_empty |= (tag_word >> i) & (tag_word >> i + 1) & 1 << i;
    }

    //dbg_log("safe  tw=" + h(tag_word) + " se=" + h(this._stack_empty), LOG_FPU);
}

FPU.prototype._fstenv = function(addr)
{
    if(operand_size_32)
    {
        safe_write16(addr, this._control_word);

        safe_write16(addr + 4, this._load_status_word());
        safe_write16(addr + 8, this._load_tag_word());

        safe_write32(addr + 12, this._fpu_ip);
        safe_write16(addr + 16, this._fpu_ip_selector);
        safe_write16(addr + 18, this._fpu_opcode);
        safe_write32(addr + 20, this._fpu_dp);
        safe_write16(addr + 24, this._fpu_dp_selector);
    }
    else
    {
        this._fpu_unimpl();
    }
}

FPU.prototype._fldenv = function(addr)
{
    if(operand_size_32)
    {
        this._control_word = safe_read16(addr);

        this._safe_status_word(safe_read16(addr + 4));
        this._safe_tag_word(safe_read16(addr + 8));
        
        this._fpu_ip = safe_read32(addr + 12);
        this._fpu_ip_selector = safe_read16(addr + 16);
        this._fpu_opcode = safe_read16(addr + 18);
        this._fpu_dp = safe_read32(addr + 20);
        this._fpu_dp_selector = safe_read16(addr + 24);
    }
    else
    {
        this._fpu_unimpl();
    }
}

FPU.prototype._fsave = function(addr)
{
    this._fstenv(addr);
    addr += 28;

    for(var i = 0; i < 8; i++)
    {
        this._store_m80(addr, i - this._stack_ptr & 7);
        addr += 10;
    }

    //dbg_log("save " + [].slice.call(this._st), LOG_FPU);

    this._finit();
}

FPU.prototype._frstor = function(addr)
{
    this._fldenv(addr);
    addr += 28;

    for(var i = 0; i < 8; i++)
    {
        this._st[i] = this._load_m80(addr);
        addr += 10;
    }

    //dbg_log("rstor " + [].slice.call(this._st), LOG_FPU);
}

FPU.prototype._integer_round = function(f)
{
    var rc = this._control_word >> 10 & 3;

    if(rc === 0)
    {
        // Round to nearest, or even if equidistant
        var rounded = Math.round(f);

        if(rounded - f === 0.5 && (rounded & 1))
        {
            // Special case: Math.round rounds to positive infinity
            // if equidistant
            rounded--;
        }

        return rounded;
    }
        // rc=3 is this._truncate -> floor for positive numbers
    else if(rc === 1 || (rc === 3 && f > 0))
    {
        return Math.floor(f);
    }
    else 
    {
        return Math.ceil(f);
    }
}

FPU.prototype._truncate = function(x)
{
    return x > 0 ? Math.floor(x) : Math.ceil(x);
}

FPU.prototype._push = function(x)
{
    this._stack_ptr = this._stack_ptr - 1 & 7;

    if(this._stack_empty >> this._stack_ptr & 1)
    {
        this._status_word &= ~FPU_C1;
        this._stack_empty &= ~(1 << this._stack_ptr);
        this._st[this._stack_ptr] = x;
    }
    else
    {
        this._status_word |= FPU_C1;
        this._stack_fault();
        this._st[this._stack_ptr] = indefinite_nan;
    }
}

FPU.prototype._pop = function()
{
    this._stack_empty |= 1 << this._stack_ptr;
    this._stack_ptr = this._stack_ptr + 1 & 7;
}

FPU.prototype._get_sti = function(i)
{
    dbg_assert(typeof i === "number" && i >= 0 && i < 8);

    i = i + this._stack_ptr & 7;

    if(this._stack_empty >> i & 1)
    {
        this._status_word &= ~FPU_C1;
        this._stack_fault();
        return indefinite_nan;
    }
    else
    {
        return this._st[i];
    }
}

FPU.prototype._get_st0 = function()
{
    if(this._stack_empty >> this._stack_ptr & 1)
    {
        this._status_word &= ~FPU_C1;
        this._stack_fault();
        return indefinite_nan;
    }
    else
    {
        return this._st[this._stack_ptr];
    }
}

FPU.prototype._assert_not_empty = function(i)
{
    if(this._stack_empty >> (i + this._stack_ptr & 7) & 1)
    {
        this._status_word &= ~FPU_C1;
    }
    else
    {
    }
}

FPU.prototype._load_m80 = function(addr)
{
    var exponent = safe_read16(addr + 8),
        sign,

        low = safe_read32(addr), 
        high = safe_read32(addr + 4);

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
        float64_byte[7] = 0x7F | sign << 7;
        float64_byte[6] = 0xF0 | high >> 30 << 3 & 0x08;

        float64_byte[5] = 0;
        float64_byte[4] = 0;

        float64_int[0] = 0;

        return float64[0];
    }

    // Note: some bits might be lost at this point
    var mantissa = low + 0x100000000 * high;
    
    if(sign)
    {
        mantissa = -mantissa;
    }

    //console.log("m: " + mantissa);
    //console.log("e: " + exponent);
    //console.log("s: " + this._sign);
    //console.log("f: " + mantissa * Math.pow(2, exponent - 63));

    // Simply compute the 64 bit floating point number.
    // An alternative write the mantissa, this._sign and exponent in the
    // float64_byte and return float64[0]

    return mantissa * Math.pow(2, exponent - 63);
}

FPU.prototype._store_m80 = function(addr, i)
{
    float64[0] = this._st[this._stack_ptr + i & 7];

    var sign = float64_byte[7] & 0x80,
        exponent = (float64_byte[7] & 0x7f) << 4 | float64_byte[6] >> 4,
        low,
        high;

    if(exponent === 0x7FF)
    {
        // all bits set (NaN and infinity)
        exponent = 0x7FFF;
        low = 0;
        high = 0x80000000 | (float64_int[1] & 0x80000) << 11;
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
        low = float64_int[0] << 11;
        high = 0x80000000 | (float64_int[1] & 0xFFFFF) << 11 | (float64_int[0] >>> 21);
    }

    dbg_assert(exponent >= 0 && exponent < 0x8000);

    safe_write32(addr, low);
    safe_write32(addr + 4, high);

    safe_write16(addr + 8, sign << 8 | exponent);
}

FPU.prototype._load_m64 = function(addr)
{
    float64_int[0] = safe_read32s(addr);
    float64_int[1] = safe_read32s(addr + 4);

    return float64[0];
};

FPU.prototype._store_m64 = function(addr, i)
{
    // protect against writing only a single dword
    // and then page-faulting
    translate_address_write(addr + 7);

    float64[0] = this._get_sti(i);

    safe_write32(addr, float64_int[0]);
    safe_write32(addr + 4, float64_int[1]);
};

FPU.prototype._load_m32 = function(addr)
{
    float32_int[0] = safe_read32s(addr);

    return float32[0];
};

FPU.prototype._store_m32 = function(addr, i)
{
    float32[0] = this._get_sti(i);

    safe_write32(addr, float32_int[0]);
};

// this._sign of a number on the stack
FPU.prototype._sign = function(i)
{
    return this._st8[(this._stack_ptr + i & 7) << 3 | 7] >> 7;
};


FPU.prototype._dbg_log_fpu_op = function(op, imm8)
{
    if(!FPU_LOG_OP)
    {
        return;
    }

    if(imm8 >= 0xC0)
    {
        dbg_log(h(op, 2) + " " + h(imm8, 2) + "/" + (imm8 >> 3 & 7) + "/" + (imm8 & 7) +
                " @" + h(instruction_pointer >>> 0, 8) + " sp=" + this._stack_ptr + " this._st=" + h(this._stack_empty, 2), LOG_FPU);
    }
    else
    {
        dbg_log(h(op, 2) + " /" + (imm8 >> 3 & 7) + 
                "     @" + h(instruction_pointer >>> 0, 8) + " sp=" + this._stack_ptr + " this._st=" + h(this._stack_empty, 2), LOG_FPU);
    }
}


FPU.prototype.fwait = function()
{
    // TODO:
    // Exceptions
};


FPU.prototype.op_D8_reg = function(imm8)
{
    this._dbg_log_fpu_op(0xD8, imm8);

    var mod = imm8 >> 3 & 7,
        low = imm8 & 7,
        sti = this._get_sti(low),
        st0 = this._get_st0();

    switch(mod)
    {
        case 0:
            // fadd
            this._st[this._stack_ptr] = st0 + sti;
            break;
        case 1:
            // fmul
            this._st[this._stack_ptr] = st0 * sti;
            break;
        case 2:
            // this._fcom
            this._fcom(sti);
            break;
        case 3:
            // fcomp
            this._fcom(sti);
            this._pop();
            break;
        case 4:
            // fsub
            this._st[this._stack_ptr] = st0 - sti;
            break;
        case 5:
            // fsubr
            this._st[this._stack_ptr] = sti - st0;
            break;
        case 6:
            // fdiv
            this._st[this._stack_ptr] = st0 / sti;
            break;
        case 7:
            // fdivr
            this._st[this._stack_ptr] = sti / st0;
            break;
        default:
            dbg_log(mod); 
            this._fpu_unimpl();
    }
};

FPU.prototype.op_D8_mem = function(imm8, addr)
{
    this._dbg_log_fpu_op(0xD8, imm8);

    var mod = imm8 >> 3 & 7,
        m32 = this._load_m32(addr);

    var st0 = this._get_st0();

    switch(mod)
    {
        case 0:
            // fadd
            this._st[this._stack_ptr] = st0 + m32;
            break;
        case 1:
            // fmul
            this._st[this._stack_ptr] = st0 * m32;
            break;
        case 2:
            // this._fcom
            this._fcom(m32);
            break;
        case 3:
            // fcomp
            this._fcom(m32);
            this._pop();
            break;
        case 4:
            // fsub
            this._st[this._stack_ptr] = st0 - m32;
            break;
        case 5:
            // fsubr
            this._st[this._stack_ptr] = m32 - st0;
            break;
        case 6:
            // fdiv
            this._st[this._stack_ptr] = st0 / m32;
            break;
        case 7:
            // fdivr
            this._st[this._stack_ptr] = m32 / st0;
            break;
        default:
            dbg_log(mod); 
            this._fpu_unimpl();
    }
};

FPU.prototype.op_D9_reg = function(imm8)
{
    this._dbg_log_fpu_op(0xD9, imm8);

    var mod = imm8 >> 3 & 7,
        low = imm8 & 7;

    switch(mod)
    {
        case 0:
            // fld
            var sti = this._get_sti(low);
            this._push(sti);
            break;
        case 1:
            // fxch
            var sti = this._get_sti(low);

            this._st[this._stack_ptr + low & 7] = this._get_st0();
            this._st[this._stack_ptr] = sti;
            break;
        case 4:
            switch(low)
            {
                case 0:
                    // fchs
                    this._st[this._stack_ptr] = -this._get_st0();
                    break;
                case 1:
                    // fabs
                    this._st[this._stack_ptr] = Math.abs(this._get_st0());
                    break;
                case 4:
                    this._ftst();
                    break;
                case 5:
                    this._fxam();
                    break;
                default:
                    dbg_log(low); this._fpu_unimpl();
            }
            break;
        case 5:
            this._push(fpu_constants[low]);
            break;
        case 6:
            switch(low)
            {
                case 0:
                    // f2xm1
                    this._st[this._stack_ptr] = Math.pow(2, this._get_st0()) - 1;
                    break;
                case 1:
                    // fyl2x
                    this._st[this._stack_ptr + 1 & 7] = this._get_sti(1) * Math.log(this._get_st0()) / Math.LN2;
                    this._pop();
                    break;
                case 2:
                    // fptan
                    this._st[this._stack_ptr] = Math.tan(this._get_st0());
                    this._push(1); // no bug: this._push constant 1
                    break;
                case 3:
                    // fpatan
                    //this._st[this._stack_ptr + 1 & 7] = Math.atan(this._get_sti(1) / this._get_st0());
                    this._st[this._stack_ptr + 1 & 7] = Math.atan2(this._get_sti(1), this._get_st0());
                    this._pop();
                    break;
                case 5:
                    // fprem1
                    this._st[this._stack_ptr] = this._get_st0() % this._get_sti(1);
                    break;
                default:
                    dbg_log(low); this._fpu_unimpl();
            }
            break;
        case 7:
            switch(low)
            {
                case 0:
                    // fprem
                    this._st[this._stack_ptr] = this._get_st0() % this._get_sti(1);
                    break;
                case 1:
                    // fyl2xp1: y * log2(x+1) and this._pop
                    this._st[this._stack_ptr + 1 & 7] = this._get_sti(1) * Math.log(this._get_st0() + 1) / Math.LN2;
                    this._pop();
                    break;
                case 2:
                    this._st[this._stack_ptr] = Math.sqrt(this._get_st0());
                    break;
                case 3:
                    var st0 = this._get_st0();

                    this._st[this._stack_ptr] = Math.sin(st0);
                    this._push(Math.cos(st0));
                    break;
                case 4:
                    // frndint
                    this._st[this._stack_ptr] = this._integer_round(this._get_st0());
                    break;
                case 5:
                    // fscale
                    this._st[this._stack_ptr] = this._get_st0() * Math.pow(2, this._truncate(this._get_sti(1)));
                    break;
                case 6:
                    this._st[this._stack_ptr] = Math.sin(this._get_st0());
                    break;
                case 7:
                    this._st[this._stack_ptr] = Math.cos(this._get_st0());
                    break;
                default:
                    dbg_log(low); this._fpu_unimpl();
            }
            break;
        default:
            dbg_log(mod); 
            this._fpu_unimpl();
    }
};

FPU.prototype.op_D9_mem = function(imm8, addr)
{
    this._dbg_log_fpu_op(0xD9, imm8);

    var mod = imm8 >> 3 & 7;

    switch(mod)
    {
        case 0:
            var data = this._load_m32(addr);

            this._push(data);
            break;
        case 2:
            this._store_m32(addr, 0);
            break;
        case 3:
            this._store_m32(addr, 0);
            this._pop();
            break;
        case 4:
            this._fldenv(addr);
            break;
        case 5:
            var word = safe_read16(addr);
            this._control_word = word;
            break;
        case 6:
            this._fstenv(addr);
            break;
        case 7:
            safe_write16(addr, this._control_word);
            break;
        default:
            dbg_log(mod); 
            this._fpu_unimpl();
    }
};

FPU.prototype.op_DA_reg = function(imm8)
{
    this._dbg_log_fpu_op(0xDA, imm8);

    var mod = imm8 >> 3 & 7,
        low = imm8 & 7;

    switch(mod)
    {
        case 0:
            // fcmovb
            if(test_b())
            {
                this._st[this._stack_ptr] = this._get_sti(low);
                this._stack_empty &= ~(1 << this._stack_ptr);
            }
            break;
        case 1:
            // fcmove
            if(test_z())
            {
                this._st[this._stack_ptr] = this._get_sti(low);
                this._stack_empty &= ~(1 << this._stack_ptr);
            }
            break;
        case 2:
            // fcmovbe
            if(test_be())
            {
                this._st[this._stack_ptr] = this._get_sti(low);
                this._stack_empty &= ~(1 << this._stack_ptr);
            }
            break;
        case 3:
            // fcmovu
            if(test_p())
            {
                this._st[this._stack_ptr] = this._get_sti(low);
                this._stack_empty &= ~(1 << this._stack_ptr);
            }
            break;
        case 5:
            if(low === 1)
            {
                // fucompp
                this._fucom(this._get_sti(1));
                this._pop();
                this._pop();
            }
            else
            {
                dbg_log(mod); this._fpu_unimpl();
            }
            break;
        default:
            dbg_log(mod); 
            this._fpu_unimpl();
    }
};

FPU.prototype.op_DA_mem = function(imm8, addr)
{
    this._dbg_log_fpu_op(0xDA, imm8);

    var mod = imm8 >> 3 & 7,
        m32 = safe_read32s(addr);

    var st0 = this._get_st0();

    switch(mod)
    {
        case 0:
            // fadd
            this._st[this._stack_ptr] = st0 + m32;
            break;
        case 1:
            // fmul
            this._st[this._stack_ptr] = st0 * m32;
            break;
        case 2:
            // this._fcom
            this._fcom(m32);
            break;
        case 3:
            // fcomp
            this._fcom(m32);
            this._pop();
            break;
        case 4:
            // fsub
            this._st[this._stack_ptr] = st0 - m32;
            break;
        case 5:
            // fsubr
            this._st[this._stack_ptr] = m32 - st0;
            break;
        case 6:
            // fdiv
            this._st[this._stack_ptr] = st0 / m32;
            break;
        case 7:
            // fdivr
            this._st[this._stack_ptr] = m32 / st0;
            break;
        default:
            dbg_log(mod); 
            this._fpu_unimpl();
    }
};

FPU.prototype.op_DB_reg = function(imm8)
{
    this._dbg_log_fpu_op(0xDB, imm8);

    var mod = imm8 >> 3 & 7,
        low = imm8 & 7;

    switch(mod)
    {
        case 0:
            // fcmovnb
            if(!test_b())
            {
                this._st[this._stack_ptr] = this._get_sti(low);
                this._stack_empty &= ~(1 << this._stack_ptr);
            }
            break;
        case 1:
            // fcmovne
            if(!test_z())
            {
                this._st[this._stack_ptr] = this._get_sti(low);
                this._stack_empty &= ~(1 << this._stack_ptr);
            }
            break;
        case 2:
            // fcmovnbe
            if(!test_be())
            {
                this._st[this._stack_ptr] = this._get_sti(low);
                this._stack_empty &= ~(1 << this._stack_ptr);
            }
            break;
        case 3:
            // fcmovnu
            if(!test_p())
            {
                this._st[this._stack_ptr] = this._get_sti(low);
                this._stack_empty &= ~(1 << this._stack_ptr);
            }
            break;
        case 4:
            if(imm8 === 0xE3)
            {
                this._finit();
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
                this._status_word = 0;
            }
            else
            {
                dbg_log(h(imm8));
                this._fpu_unimpl();
            }
            break;
        case 5:
            this._fucomi(this._get_sti(low));
            break;
        case 6:
            this._fcomi(this._get_sti(low));
            break;
        default:
            dbg_log(mod); 
            this._fpu_unimpl();
    }
};

FPU.prototype.op_DB_mem = function(imm8, addr)
{
    this._dbg_log_fpu_op(0xDB, imm8);

    var mod = imm8 >> 3 & 7;

    switch(mod)
    {
        case 0:
            // fild
            var int32 = safe_read32s(addr);
            this._push(int32);
            break;
        case 2:
            // fist
            var st0 = this._get_st0();
            if(st0 <= 0x7FFFFFFF && st0 >= -0x80000000)
            {
                // TODO: Invalid operation
                safe_write32(addr, this._integer_round(st0));
            }
            else
            {
                this._invalid_arithmatic();
                safe_write32(addr, 0x80000000);
            }
            break;
        case 3:
            // fistp
            var st0 = this._get_st0();
            if(st0 <= 0x7FFFFFFF && st0 >= -0x80000000)
            {
                safe_write32(addr, this._integer_round(st0));
            }
            else
            {
                this._invalid_arithmatic();
                safe_write32(addr, 0x80000000);
            }
            this._pop();
            break;
        case 5:
            // fld
            this._push(this._load_m80(addr));
            break;
        case 7:
            // fstp
            this._store_m80(addr, 0);
            this._pop();
            break;
        default:
            dbg_log(mod); 
            this._fpu_unimpl();
    }
};

FPU.prototype.op_DC_reg = function(imm8)
{
    this._dbg_log_fpu_op(0xDC, imm8);

    var mod = imm8 >> 3 & 7,
        low = imm8 & 7,
        low_ptr = this._stack_ptr + low & 7,
        sti = this._get_sti(low),
        st0 = this._get_st0();

    switch(mod)
    {
        case 0:
            // fadd
            this._st[low_ptr] = sti + st0;
            break;
        case 1:
            // fmul
            this._st[low_ptr] = sti * st0;
            break;
        case 2:
            // this._fcom
            this._fcom(sti);
            break;
        case 3:
            // fcomp
            this._fcom(sti);
            this._pop();
            break;
        case 4:
            // fsubr
            this._st[low_ptr] = st0 - sti;
            break;
        case 5:
            // fsub
            this._st[low_ptr] = sti - st0;
            break;
        case 6:
            // fdivr
            this._st[low_ptr] = st0 / sti;
            break;
        case 7:
            // fdiv
            this._st[low_ptr] = sti / st0;
            break;
        default:
            dbg_log(mod); 
            this._fpu_unimpl();
    }
};

FPU.prototype.op_DC_mem = function(imm8, addr)
{
    this._dbg_log_fpu_op(0xDC, imm8);

    var
        mod = imm8 >> 3 & 7,
        m64 = this._load_m64(addr);

    var st0 = this._get_st0();

    switch(mod)
    {
        case 0:
            // fadd
            this._st[this._stack_ptr] = st0 + m64;
            break;
        case 1:
            // fmul
            this._st[this._stack_ptr] = st0 * m64;
            break;
        case 2:
            // this._fcom
            this._fcom(m64);
            break;
        case 3:
            // fcomp
            this._fcom(m64);
            this._pop();
            break;
        case 4:
            // fsub
            this._st[this._stack_ptr] = st0 - m64;
            break;
        case 5:
            // fsubr
            this._st[this._stack_ptr] = m64 - st0;
            break;
        case 6:
            // fdiv
            this._st[this._stack_ptr] = st0 / m64;
            break;
        case 7:
            // fdivr
            this._st[this._stack_ptr] = m64 / st0;
            break;
        default:
            dbg_log(mod); 
            this._fpu_unimpl();
    }
};

FPU.prototype.op_DD_reg = function(imm8)
{
    this._dbg_log_fpu_op(0xDD, imm8);

    var mod = imm8 >> 3 & 7,
        low = imm8 & 7;

    switch(mod)
    {
        case 0:
            // ffree
            this._stack_empty |= 1 << (this._stack_ptr + low & 7);
            break;
        case 2:
            // fst
            this._st[this._stack_ptr + low & 7] = this._get_st0();
            break;
        case 3:
            // fstp
            if(low === 0)
            {
                this._pop();
            }
            else 
            {
                this._st[this._stack_ptr + low & 7] = this._get_st0();
                this._pop();
            }
            break;
        case 4:
            this._fucom(this._get_sti(low));
            break;
        case 5:
            // fucomp
            this._fucom(this._get_sti(low));
            this._pop();
            break;
        default:
            dbg_log(mod); 
            this._fpu_unimpl();
    }
};

FPU.prototype.op_DD_mem = function(imm8, addr)
{
    this._dbg_log_fpu_op(0xDD, imm8);

    var mod = imm8 >> 3 & 7;

    switch(mod)
    {
        case 0:
            // fld
            var data = this._load_m64(addr);
            this._push(data);
            break;
        case 2:
            // fst
            this._store_m64(addr, 0);
            break;
        case 3:
            // fstp
            this._store_m64(addr, 0);
            this._pop();
            break;
        case 4:
            this._frstor(addr);
            break;
        case 6:
            // this._fsave
            this._fsave(addr);
            break;
        case 7:
            // fnstsw / store status word
            safe_write16(addr, this._load_status_word());
            break;
        default:
            dbg_log(mod); 
            this._fpu_unimpl();
    }
};


FPU.prototype.op_DE_reg = function(imm8)
{
    this._dbg_log_fpu_op(0xDE, imm8);

    var mod = imm8 >> 3 & 7,
        low = imm8 & 7,
        low_ptr = this._stack_ptr + low & 7,
        sti = this._get_sti(low),
        st0 = this._get_st0();

    switch(mod)
    {
        case 0:
            // faddp
            this._st[low_ptr] = sti + st0;
            break;
        case 1:
            // fmulp
            this._st[low_ptr] = sti * st0;
            break;
        case 2:
            // fcomp
            this._fcom(sti);
            break;
        case 3:
            // fcompp
            if(low === 1)
            {
                this._fcom(this._st[low_ptr]);
                this._pop();
            }
            else
            {
                // not a valid encoding
                dbg_log(mod); 
                this._fpu_unimpl();
            }
            break;
        case 4:
            // fsubrp
            this._st[low_ptr] = st0 - sti;
            break;
        case 5:
            // fsubp
            this._st[low_ptr] = sti - st0;
            break;
        case 6:
            // fdivrp
            this._st[low_ptr] = st0 / sti;
            break;
        case 7:
            // fdivp
            this._st[low_ptr] = sti / st0;
            break;
        default:
            dbg_log(mod); 
            this._fpu_unimpl();
    }

    this._pop();
};

FPU.prototype.op_DE_mem = function(imm8, addr)
{
    this._dbg_log_fpu_op(0xDE, imm8);

    var mod = imm8 >> 3 & 7,
        m16 = safe_read16s(addr);

    var st0 = this._get_st0();

    switch(mod)
    {
        case 0:
            // fadd
            this._st[this._stack_ptr] = st0 + m16;
            break;
        case 1:
            // fmul
            this._st[this._stack_ptr] = st0 * m16;
            break;
        case 2:
            // this._fcom
            this._fcom(m16);
            break;
        case 3:
            // fcomp
            this._fcom(m16);
            this._pop();
            break;
        case 4:
            // fsub
            this._st[this._stack_ptr] = st0 - m16;
            break;
        case 5:
            // fsubr
            this._st[this._stack_ptr] = m16 - st0;
            break;
        case 6:
            // fdiv
            this._st[this._stack_ptr] = st0 / m16;
            break;
        case 7:
            // fdivr
            this._st[this._stack_ptr] = m16 / st0;
            break;
        default:
            dbg_log(mod); 
            this._fpu_unimpl();
    }
};

FPU.prototype.op_DF_reg = function(imm8)
{
    this._dbg_log_fpu_op(0xDF, imm8);

    var mod = imm8 >> 3 & 7,
        low = imm8 & 7;

    switch(mod)
    {
        case 4:
            if(imm8 === 0xE0)
            {
                // fnstsw
                reg16[reg_ax] = this._load_status_word();
            }
            else
            {
                dbg_log(imm8);
                this._fpu_unimpl();
            }
            break;
        case 5:
            // fucomip
            this._fucomi(this._get_sti(low));
            this._pop();
            break;
        default:
            dbg_log(mod); 
            this._fpu_unimpl();
    }
};

FPU.prototype.op_DF_mem = function(imm8, addr)
{
    this._dbg_log_fpu_op(0xDF, imm8);

    var mod = imm8 >> 3 & 7;

    switch(mod)
    {
        case 0:
            var m16 = safe_read16s(addr);

            this._push(m16);
            break;
        case 2:
            // fist
            var st0 = this._get_st0();
            if(st0 <= 0x7FFF && st0 >= -0x8000)
            {
                safe_write16(addr, this._integer_round(st0));
            }
            else
            {
                this._invalid_arithmatic();
                safe_write16(addr, 0x8000);
            }
            break;
        case 3:
            // fistp
            var st0 = this._get_st0();
            if(st0 <= 0x7FFF && st0 >= -0x8000)
            {
                safe_write16(addr, this._integer_round(st0));
            }
            else
            {
                this._invalid_arithmatic();
                safe_write16(addr, 0x8000);
            }
            this._pop();
            break;
        case 5:
            // fild
            var low = safe_read32(addr);

            var high = safe_read32(addr + 4);

            var m64 = low + 0x100000000 * high;

            if(high >> 31)
            {
                m64 -= 0x10000000000000000;
            }

            this._push(m64);
            break;
        case 7:
            // fistp
            var st0 = this._integer_round(this._get_st0());

            if(!(st0 <= 0x7FFFFFFFFFFFFFFF && st0 >= -0x8000000000000000))
            {
                st0 = 0x8000000000000000;
                this._invalid_arithmatic();
            }
            this._pop();
            safe_write32(addr, st0);

            st0 /= 0x100000000;

            if(st0 < 0 && st0 > -1)
                st0 = -1;

            safe_write32(addr + 4, st0);
            break;
        default:
            dbg_log(mod); 
            this._fpu_unimpl();
    }
};
