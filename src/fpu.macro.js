"use strict";

/** @const */
var FPU_LOG_OP = false;

/**
 * @constructor
 */
function FPU(io)
{
    this.is_fpu = 1;

    // TODO:
    // - Precision Control
    // - QNaN, unordered comparison
    // - Exceptions

    var 
        /** @const */
        C0 = 0x100,
        /** @const */
        C1 = 0x200,
        /** @const */
        C2 = 0x400,
        /** @const */
        C3 = 0x4000,
        /** @const */
        RESULT_FLAGS = C0 | C1 | C2 | C3,
        /** @const */
        STACK_TOP = 0x3800;

    var 
        // precision, round & infinity control
        /** @const */
        PC = 3 << 8,
        /** @const */
        RC = 3 << 10,
        /** @const */
        IF = 1 << 12;

    // exception bits in the status word
    var EX_SF = 1 << 6,
        EX_P = 1 << 5,
        EX_U = 1 << 4,
        EX_O = 1 << 3,
        EX_Z = 1 << 2,
        EX_D = 1 << 1,
        EX_I = 1 << 0;

    var 
        // Why no Float80Array :-(
        st = new Float64Array(8),
        st8 = new Uint8Array(st.buffer),
        st32 = new Uint32Array(st.buffer),

        // bitmap of which stack registers are empty
        stack_empty = 0xff,
        stack_ptr = 0,

        // used for conversion
        float32 = new Float32Array(1),
        float32_byte = new Uint8Array(float32.buffer),
        float32_int = new Uint32Array(float32.buffer),

        float64 = new Float64Array(1),
        float64_byte = new Uint8Array(float64.buffer),
        float64_int = new Uint32Array(float64.buffer),

        float80_int = new Uint8Array(10),


        control_word = 0x37F,
        status_word = 0,
        fpu_ip = 0,
        fpu_ip_selector = 0,
        fpu_opcode = 0,
        fpu_dp = 0,
        fpu_dp_selector = 0,


        /** @const */
        indefinite_nan = NaN;


    var constants = new Float64Array([
        1, Math.log(10) / Math.LN2, Math.LOG2E, Math.PI,
        Math.log(2) / Math.LN10, Math.LN2, 0
    ]);

    function fpu_unimpl()
    {
        dbg_trace();
        if(DEBUG) throw "fpu: unimplemented";
        else trigger_ud();
    }

    function stack_fault()
    {
        // TODO: Interrupt
        status_word |= EX_SF | EX_I;
    }

    function invalid_arithmatic()
    {
        status_word |= EX_I;
    }

    function fcom(y)
    {
        var x = get_st0();

        status_word &= ~RESULT_FLAGS;

        if(x > y)
        {
        }
        else if(y > x)
        {
            status_word |= C0;
        }
        else if(x === y)
        {
            status_word |= C3;
        }
        else
        {
            status_word |= C0 | C2 | C3;
        }
    }

    function fucom(y)
    {
        // TODO
        fcom(y);
    }


    function fcomi(y)
    {
        var x = st[stack_ptr];

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

    function fucomi(y)
    {
        // TODO
        fcomi(y);
    }

    function ftst()
    {
        var st0 = get_st0();

        status_word &= ~RESULT_FLAGS;

        if(isNaN(st0))
        {
            status_word |= C3 | C2 | C0;
        }
        else if(st0 === 0)
        {
            status_word |= C3;
        }
        else if(st0 < 0)
        {
            status_word |= C0;
        }

        // TODO: unordered (st0 is nan, etc)
    }

    function fxam()
    {
        var x = get_st0();

        status_word &= ~RESULT_FLAGS;
        status_word |= sign(0) << 9;

        if(stack_empty >> stack_ptr & 1)
        {
            status_word |= C3 | C0;
        }
        else if(isNaN(x))
        {
            status_word |= C0;
        }
        else if(x === 0)
        {
            status_word |= C3;
        }
        else if(x === Infinity || x === -Infinity)
        {
            status_word |= C2 | C0;
        }
        else
        {
            status_word |= C2;
        }
        // TODO:
        // Unsupported, Denormal
    }

    function finit()
    {
        control_word = 0x37F;
        status_word = 0;
        fpu_ip = 0;
        fpu_dp = 0;
        fpu_opcode = 0;

        stack_empty = 0xFF;
        stack_ptr = 0;
    }

    function load_status_word()
    {
        return status_word & ~(7 << 11) | stack_ptr << 11;
    }

    function safe_status_word(sw)
    {
        status_word = sw & ~(7 << 11);
        stack_ptr = sw >> 11 & 7;
    }

    function load_tag_word()
    {
        var tag_word = 0,
            value;

        for(var i = 0; i < 8; i++)
        {
            value = st[i];

            if(stack_empty >> i & 1)
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

        //dbg_log("load  tw=" + h(tag_word) + " se=" + h(stack_empty) + " sp=" + stack_ptr, LOG_FPU);

        return tag_word;
    }

    function safe_tag_word(tag_word)
    {
        stack_empty = 0;

        for(var i = 0; i < 8; i++)
        {
            stack_empty |= (tag_word >> i) & (tag_word >> i + 1) & 1 << i;
        }

        //dbg_log("safe  tw=" + h(tag_word) + " se=" + h(stack_empty), LOG_FPU);
    }

    function fstenv(addr)
    {
        if(operand_size_32)
        {
            safe_write16(addr, control_word);

            safe_write16(addr + 4, load_status_word());
            safe_write16(addr + 8, load_tag_word());

            safe_write32(addr + 12, fpu_ip);
            safe_write16(addr + 16, fpu_ip_selector);
            safe_write16(addr + 18, fpu_opcode);
            safe_write32(addr + 20, fpu_dp);
            safe_write16(addr + 24, fpu_dp_selector);
        }
        else
        {
            fpu_unimpl();
        }
    }

    function fldenv(addr)
    {
        if(operand_size_32)
        {
            control_word = safe_read16(addr);

            safe_status_word(safe_read16(addr + 4));
            safe_tag_word(safe_read16(addr + 8));
            
            fpu_ip = safe_read32(addr + 12);
            fpu_ip_selector = safe_read16(addr + 16);
            fpu_opcode = safe_read16(addr + 18);
            fpu_dp = safe_read32(addr + 20);
            fpu_dp_selector = safe_read16(addr + 24);
        }
        else
        {
            fpu_unimpl();
        }
    }

    function fsave(addr)
    {
        fstenv(addr);
        addr += 28;

        for(var i = 0; i < 8; i++)
        {
            store_m80(addr, i - stack_ptr & 7);
            addr += 10;
        }

        //dbg_log("save " + [].slice.call(st), LOG_FPU);

        finit();
    }

    function frstor(addr)
    {
        fldenv(addr);
        addr += 28;

        for(var i = 0; i < 8; i++)
        {
            st[i] = load_m80(addr);
            addr += 10;
        }

        //dbg_log("rstor " + [].slice.call(st), LOG_FPU);
    }

    function integer_round(f)
    {
        var rc = control_word >> 10 & 3;

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
            // rc=3 is truncate -> floor for positive numbers
        else if(rc === 1 || (rc === 3 && f > 0))
        {
            return Math.floor(f);
        }
        else 
        {
            return Math.ceil(f);
        }
    }

    function truncate(x)
    {
        return x > 0 ? Math.floor(x) : Math.ceil(x);
    }

    function push(x)
    {
        stack_ptr = stack_ptr - 1 & 7;

        if(stack_empty >> stack_ptr & 1)
        {
            status_word &= ~C1;
            stack_empty &= ~(1 << stack_ptr);
            st[stack_ptr] = x;
        }
        else
        {
            status_word |= C1;
            stack_fault();
            st[stack_ptr] = indefinite_nan;
        }
    }

    function pop()
    {
        stack_empty |= 1 << stack_ptr;
        stack_ptr = stack_ptr + 1 & 7;
    }

    function get_sti(i)
    {
        dbg_assert(typeof i === "number" && i >= 0 && i < 8);

        i = i + stack_ptr & 7;

        if(stack_empty >> i & 1)
        {
            status_word &= ~C1;
            stack_fault();
            return indefinite_nan;
        }
        else
        {
            return st[i];
        }
    }

    function get_st0()
    {
        if(stack_empty >> stack_ptr & 1)
        {
            status_word &= ~C1;
            stack_fault();
            return indefinite_nan;
        }
        else
        {
            return st[stack_ptr];
        }
    }

    function assert_not_empty(i)
    {
        if(stack_empty >> (i + stack_ptr & 7) & 1)
        {
            status_word &= ~C1;
        }
        else
        {
        }
    }

    function load_m80(addr)
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
        //console.log("s: " + sign);
        //console.log("f: " + mantissa * Math.pow(2, exponent - 63));

        // Simply compute the 64 bit floating point number.
        // An alternative write the mantissa, sign and exponent in the
        // float64_byte and return float64[0]

        return mantissa * Math.pow(2, exponent - 63);
    }

    function store_m80(addr, i)
    {
        float64[0] = st[stack_ptr + i & 7];

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

    function load_m64(addr)
    {
        float64_int[0] = safe_read32s(addr);
        float64_int[1] = safe_read32s(addr + 4);

        return float64[0];
    };

    function store_m64(addr, i)
    {
        // protect against writing only a single dword
        // and then page-faulting
        translate_address_write(addr + 7);

        float64[0] = get_sti(i);

        safe_write32(addr, float64_int[0]);
        safe_write32(addr + 4, float64_int[1]);
    };

    function load_m32(addr)
    {
        float32_int[0] = safe_read32s(addr);

        return float32[0];
    };

    function store_m32(addr, i)
    {
        float32[0] = get_sti(i);

        safe_write32(addr, float32_int[0]);
    };

    // sign of a number on the stack
    function sign(i)
    {
        return st8[(stack_ptr + i & 7) << 3 | 7] >> 7;
    };


    function dbg_log_fpu_op(op, imm8)
    {
        if(!FPU_LOG_OP)
        {
            return;
        }

        if(imm8 >= 0xC0)
        {
            dbg_log(h(op, 2) + " " + h(imm8, 2) + "/" + (imm8 >> 3 & 7) + "/" + (imm8 & 7) +
                    " @" + h(instruction_pointer >>> 0, 8) + " sp=" + stack_ptr + " st=" + h(stack_empty, 2), LOG_FPU);
        }
        else
        {
            dbg_log(h(op, 2) + " /" + (imm8 >> 3 & 7) + 
                    "     @" + h(instruction_pointer >>> 0, 8) + " sp=" + stack_ptr + " st=" + h(stack_empty, 2), LOG_FPU);
        }
    }


    this.fwait = function()
    {
        // TODO:
        // Exceptions
    };


    this.op_D8_reg = function(imm8)
    {
        dbg_log_fpu_op(0xD8, imm8);

        var mod = imm8 >> 3 & 7,
            low = imm8 & 7,
            sti = get_sti(low),
            st0 = get_st0();

        switch(mod)
        {
            case 0:
                // fadd
                st[stack_ptr] = st0 + sti;
                break;
            case 1:
                // fmul
                st[stack_ptr] = st0 * sti;
                break;
            case 2:
                // fcom
                fcom(sti);
                break;
            case 3:
                // fcomp
                fcom(sti);
                pop();
                break;
            case 4:
                // fsub
                st[stack_ptr] = st0 - sti;
                break;
            case 5:
                // fsubr
                st[stack_ptr] = sti - st0;
                break;
            case 6:
                // fdiv
                st[stack_ptr] = st0 / sti;
                break;
            case 7:
                // fdivr
                st[stack_ptr] = sti / st0;
                break;
            default:
                dbg_log(mod); 
                fpu_unimpl();
        }
    };

    this.op_D8_mem = function(imm8, addr)
    {
        dbg_log_fpu_op(0xD8, imm8);

        var mod = imm8 >> 3 & 7,
            m32 = load_m32(addr);

        var st0 = get_st0();

        switch(mod)
        {
            case 0:
                // fadd
                st[stack_ptr] = st0 + m32;
                break;
            case 1:
                // fmul
                st[stack_ptr] = st0 * m32;
                break;
            case 2:
                // fcom
                fcom(m32);
                break;
            case 3:
                // fcomp
                fcom(m32);
                pop();
                break;
            case 4:
                // fsub
                st[stack_ptr] = st0 - m32;
                break;
            case 5:
                // fsubr
                st[stack_ptr] = m32 - st0;
                break;
            case 6:
                // fdiv
                st[stack_ptr] = st0 / m32;
                break;
            case 7:
                // fdivr
                st[stack_ptr] = m32 / st0;
                break;
            default:
                dbg_log(mod); 
                fpu_unimpl();
        }
    };

    this.op_D9_reg = function(imm8)
    {
        dbg_log_fpu_op(0xD9, imm8);

        var mod = imm8 >> 3 & 7,
            low = imm8 & 7;

        switch(mod)
        {
            case 0:
                // fld
                var sti = get_sti(low);
                push(sti);
                break;
            case 1:
                // fxch
                var sti = get_sti(low);

                st[stack_ptr + low & 7] = get_st0();
                st[stack_ptr] = sti;
                break;
            case 4:
                switch(low)
                {
                    case 0:
                        // fchs
                        st[stack_ptr] = -get_st0();
                        break;
                    case 1:
                        // fabs
                        st[stack_ptr] = Math.abs(get_st0());
                        break;
                    case 4:
                        ftst();
                        break;
                    case 5:
                        fxam();
                        break;
                    default:
                        dbg_log(low); fpu_unimpl();
                }
                break;
            case 5:
                push(constants[low]);
                break;
            case 6:
                switch(low)
                {
                    case 0:
                        // f2xm1
                        st[stack_ptr] = Math.pow(2, get_st0()) - 1;
                        break;
                    case 1:
                        // fyl2x
                        st[stack_ptr + 1 & 7] = get_sti(1) * Math.log(get_st0()) / Math.LN2;
                        pop();
                        break;
                    case 2:
                        // fptan
                        st[stack_ptr] = Math.tan(get_st0());
                        push(1); // no bug: push constant 1
                        break;
                    case 3:
                        // fpatan
                        //st[stack_ptr + 1 & 7] = Math.atan(get_sti(1) / get_st0());
                        st[stack_ptr + 1 & 7] = Math.atan2(get_sti(1), get_st0());
                        pop();
                        break;
                    case 5:
                        // fprem1
                        st[stack_ptr] = get_st0() % get_sti(1);
                        break;
                    default:
                        dbg_log(low); fpu_unimpl();
                }
                break;
            case 7:
                switch(low)
                {
                    case 0:
                        // fprem
                        st[stack_ptr] = get_st0() % get_sti(1);
                        break;
                    case 1:
                        // fyl2xp1: y * log2(x+1) and pop
                        st[stack_ptr + 1 & 7] = get_sti(1) * Math.log(get_st0() + 1) / Math.LN2;
                        pop();
                        break;
                    case 2:
                        st[stack_ptr] = Math.sqrt(get_st0());
                        break;
                    case 3:
                        var st0 = get_st0();

                        st[stack_ptr] = Math.sin(st0);
                        push(Math.cos(st0));
                        break;
                    case 4:
                        // frndint
                        st[stack_ptr] = integer_round(get_st0());
                        break;
                    case 5:
                        // fscale
                        st[stack_ptr] = get_st0() * Math.pow(2, truncate(get_sti(1)));
                        break;
                    case 6:
                        st[stack_ptr] = Math.sin(get_st0());
                        break;
                    case 7:
                        st[stack_ptr] = Math.cos(get_st0());
                        break;
                    default:
                        dbg_log(low); fpu_unimpl();
                }
                break;
            default:
                dbg_log(mod); 
                fpu_unimpl();
        }
    };

    this.op_D9_mem = function(imm8, addr)
    {
        dbg_log_fpu_op(0xD9, imm8);

        var mod = imm8 >> 3 & 7;

        switch(mod)
        {
            case 0:
                var data = load_m32(addr);

                push(data);
                break;
            case 2:
                store_m32(addr, 0);
                break;
            case 3:
                store_m32(addr, 0);
                pop();
                break;
            case 4:
                fldenv(addr);
                break;
            case 5:
                var word = safe_read16(addr);
                control_word = word;
                break;
            case 6:
                fstenv(addr);
                break;
            case 7:
                safe_write16(addr, control_word);
                break;
            default:
                dbg_log(mod); 
                fpu_unimpl();
        }
    };

    this.op_DA_reg = function(imm8)
    {
        dbg_log_fpu_op(0xDA, imm8);

        var mod = imm8 >> 3 & 7,
            low = imm8 & 7;

        switch(mod)
        {
            case 0:
                // fcmovb
                if(test_b())
                {
                    st[stack_ptr] = get_sti(low);
                    stack_empty &= ~(1 << stack_ptr);
                }
                break;
            case 1:
                // fcmove
                if(test_z())
                {
                    st[stack_ptr] = get_sti(low);
                    stack_empty &= ~(1 << stack_ptr);
                }
                break;
            case 2:
                // fcmovbe
                if(test_be())
                {
                    st[stack_ptr] = get_sti(low);
                    stack_empty &= ~(1 << stack_ptr);
                }
                break;
            case 3:
                // fcmovu
                if(test_p())
                {
                    st[stack_ptr] = get_sti(low);
                    stack_empty &= ~(1 << stack_ptr);
                }
                break;
            case 5:
                if(low === 1)
                {
                    // fucompp
                    fucom(get_sti(1));
                    pop();
                    pop();
                }
                else
                {
                    dbg_log(mod); fpu_unimpl();
                }
                break;
            default:
                dbg_log(mod); 
                fpu_unimpl();
        }
    };

    this.op_DA_mem = function(imm8, addr)
    {
        dbg_log_fpu_op(0xDA, imm8);

        var mod = imm8 >> 3 & 7,
            m32 = safe_read32s(addr);

        var st0 = get_st0();

        switch(mod)
        {
            case 0:
                // fadd
                st[stack_ptr] = st0 + m32;
                break;
            case 1:
                // fmul
                st[stack_ptr] = st0 * m32;
                break;
            case 2:
                // fcom
                fcom(m32);
                break;
            case 3:
                // fcomp
                fcom(m32);
                pop();
                break;
            case 4:
                // fsub
                st[stack_ptr] = st0 - m32;
                break;
            case 5:
                // fsubr
                st[stack_ptr] = m32 - st0;
                break;
            case 6:
                // fdiv
                st[stack_ptr] = st0 / m32;
                break;
            case 7:
                // fdivr
                st[stack_ptr] = m32 / st0;
                break;
            default:
                dbg_log(mod); 
                fpu_unimpl();
        }
    };

    this.op_DB_reg = function(imm8)
    {
        dbg_log_fpu_op(0xDB, imm8);

        var mod = imm8 >> 3 & 7,
            low = imm8 & 7;

        switch(mod)
        {
            case 0:
                // fcmovnb
                if(!test_b())
                {
                    st[stack_ptr] = get_sti(low);
                    stack_empty &= ~(1 << stack_ptr);
                }
                break;
            case 1:
                // fcmovne
                if(!test_z())
                {
                    st[stack_ptr] = get_sti(low);
                    stack_empty &= ~(1 << stack_ptr);
                }
                break;
            case 2:
                // fcmovnbe
                if(!test_be())
                {
                    st[stack_ptr] = get_sti(low);
                    stack_empty &= ~(1 << stack_ptr);
                }
                break;
            case 3:
                // fcmovnu
                if(!test_p())
                {
                    st[stack_ptr] = get_sti(low);
                    stack_empty &= ~(1 << stack_ptr);
                }
                break;
            case 4:
                if(imm8 === 0xE3)
                {
                    finit();
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
                    status_word = 0;
                }
                else
                {
                    dbg_log(h(imm8));
                    fpu_unimpl();
                }
                break;
            case 5:
                fucomi(get_sti(low));
                break;
            case 6:
                fcomi(get_sti(low));
                break;
            default:
                dbg_log(mod); 
                fpu_unimpl();
        }
    };

    this.op_DB_mem = function(imm8, addr)
    {
        dbg_log_fpu_op(0xDB, imm8);

        var mod = imm8 >> 3 & 7;

        switch(mod)
        {
            case 0:
                // fild
                var int32 = safe_read32s(addr);
                push(int32);
                break;
            case 2:
                // fist
                var st0 = get_st0();
                if(st0 <= 0x7FFFFFFF && st0 >= -0x80000000)
                {
                    // TODO: Invalid operation
                    safe_write32(addr, integer_round(st0));
                }
                else
                {
                    invalid_arithmatic();
                    safe_write32(addr, 0x80000000);
                }
                break;
            case 3:
                // fistp
                var st0 = get_st0();
                if(st0 <= 0x7FFFFFFF && st0 >= -0x80000000)
                {
                    safe_write32(addr, integer_round(st0));
                }
                else
                {
                    invalid_arithmatic();
                    safe_write32(addr, 0x80000000);
                }
                pop();
                break;
            case 5:
                // fld
                push(load_m80(addr));
                break;
            case 7:
                // fstp
                store_m80(addr, 0);
                pop();
                break;
            default:
                dbg_log(mod); 
                fpu_unimpl();
        }
    };

    this.op_DC_reg = function(imm8)
    {
        dbg_log_fpu_op(0xDC, imm8);

        var mod = imm8 >> 3 & 7,
            low = imm8 & 7,
            low_ptr = stack_ptr + low & 7,
            sti = get_sti(low),
            st0 = get_st0();

        switch(mod)
        {
            case 0:
                // fadd
                st[low_ptr] = sti + st0;
                break;
            case 1:
                // fmul
                st[low_ptr] = sti * st0;
                break;
            case 2:
                // fcom
                fcom(sti);
                break;
            case 3:
                // fcomp
                fcom(sti);
                pop();
                break;
            case 4:
                // fsubr
                st[low_ptr] = st0 - sti;
                break;
            case 5:
                // fsub
                st[low_ptr] = sti - st0;
                break;
            case 6:
                // fdivr
                st[low_ptr] = st0 / sti;
                break;
            case 7:
                // fdiv
                st[low_ptr] = sti / st0;
                break;
            default:
                dbg_log(mod); 
                fpu_unimpl();
        }
    };

    this.op_DC_mem = function(imm8, addr)
    {
        dbg_log_fpu_op(0xDC, imm8);

        var
            mod = imm8 >> 3 & 7,
            m64 = load_m64(addr);

        var st0 = get_st0();

        switch(mod)
        {
            case 0:
                // fadd
                st[stack_ptr] = st0 + m64;
                break;
            case 1:
                // fmul
                st[stack_ptr] = st0 * m64;
                break;
            case 2:
                // fcom
                fcom(m64);
                break;
            case 3:
                // fcomp
                fcom(m64);
                pop();
                break;
            case 4:
                // fsub
                st[stack_ptr] = st0 - m64;
                break;
            case 5:
                // fsubr
                st[stack_ptr] = m64 - st0;
                break;
            case 6:
                // fdiv
                st[stack_ptr] = st0 / m64;
                break;
            case 7:
                // fdivr
                st[stack_ptr] = m64 / st0;
                break;
            default:
                dbg_log(mod); 
                fpu_unimpl();
        }
    };

    this.op_DD_reg = function(imm8)
    {
        dbg_log_fpu_op(0xDD, imm8);

        var mod = imm8 >> 3 & 7,
            low = imm8 & 7;

        switch(mod)
        {
            case 0:
                // ffree
                stack_empty |= 1 << (stack_ptr + low & 7);
                break;
            case 2:
                // fst
                st[stack_ptr + low & 7] = get_st0();
                break;
            case 3:
                // fstp
                if(low === 0)
                {
                    pop();
                }
                else 
                {
                    st[stack_ptr + low & 7] = get_st0();
                    pop();
                }
                break;
            case 4:
                fucom(get_sti(low));
                break;
            case 5:
                // fucomp
                fucom(get_sti(low));
                pop();
                break;
            default:
                dbg_log(mod); 
                fpu_unimpl();
        }
    };

    this.op_DD_mem = function(imm8, addr)
    {
        dbg_log_fpu_op(0xDD, imm8);

        var mod = imm8 >> 3 & 7;

        switch(mod)
        {
            case 0:
                // fld
                var data = load_m64(addr);
                push(data);
                break;
            case 2:
                // fst
                store_m64(addr, 0);
                break;
            case 3:
                // fstp
                store_m64(addr, 0);
                pop();
                break;
            case 4:
                frstor(addr);
                break;
            case 6:
                // fsave
                fsave(addr);
                break;
            case 7:
                // fnstsw / store status word
                safe_write16(addr, load_status_word());
                break;
            default:
                dbg_log(mod); 
                fpu_unimpl();
        }
    };


    this.op_DE_reg = function(imm8)
    {
        dbg_log_fpu_op(0xDE, imm8);

        var mod = imm8 >> 3 & 7,
            low = imm8 & 7,
            low_ptr = stack_ptr + low & 7,
            sti = get_sti(low),
            st0 = get_st0();

        switch(mod)
        {
            case 0:
                // faddp
                st[low_ptr] = sti + st0;
                break;
            case 1:
                // fmulp
                st[low_ptr] = sti * st0;
                break;
            case 2:
                // fcomp
                fcom(sti);
                break;
            case 3:
                // fcompp
                if(low === 1)
                {
                    fcom(st[low_ptr]);
                    pop();
                }
                else
                {
                    // not a valid encoding
                    dbg_log(mod); 
                    fpu_unimpl();
                }
                break;
            case 4:
                // fsubrp
                st[low_ptr] = st0 - sti;
                break;
            case 5:
                // fsubp
                st[low_ptr] = sti - st0;
                break;
            case 6:
                // fdivrp
                st[low_ptr] = st0 / sti;
                break;
            case 7:
                // fdivp
                st[low_ptr] = sti / st0;
                break;
            default:
                dbg_log(mod); 
                fpu_unimpl();
        }

        pop();
    };

    this.op_DE_mem = function(imm8, addr)
    {
        dbg_log_fpu_op(0xDE, imm8);

        var mod = imm8 >> 3 & 7,
            m16 = safe_read16s(addr);

        var st0 = get_st0();

        switch(mod)
        {
            case 0:
                // fadd
                st[stack_ptr] = st0 + m16;
                break;
            case 1:
                // fmul
                st[stack_ptr] = st0 * m16;
                break;
            case 2:
                // fcom
                fcom(m16);
                break;
            case 3:
                // fcomp
                fcom(m16);
                pop();
                break;
            case 4:
                // fsub
                st[stack_ptr] = st0 - m16;
                break;
            case 5:
                // fsubr
                st[stack_ptr] = m16 - st0;
                break;
            case 6:
                // fdiv
                st[stack_ptr] = st0 / m16;
                break;
            case 7:
                // fdivr
                st[stack_ptr] = m16 / st0;
                break;
            default:
                dbg_log(mod); 
                fpu_unimpl();
        }
    };

    this.op_DF_reg = function(imm8)
    {
        dbg_log_fpu_op(0xDF, imm8);

        var mod = imm8 >> 3 & 7,
            low = imm8 & 7;

        switch(mod)
        {
            case 4:
                if(imm8 === 0xE0)
                {
                    // fnstsw
                    reg16[reg_ax] = load_status_word();
                }
                else
                {
                    dbg_log(imm8);
                    fpu_unimpl();
                }
                break;
            case 5:
                // fucomip
                fucomi(get_sti(low));
                pop();
                break;
            default:
                dbg_log(mod); 
                fpu_unimpl();
        }
    };

    this.op_DF_mem = function(imm8, addr)
    {
        dbg_log_fpu_op(0xDF, imm8);

        var mod = imm8 >> 3 & 7;

        switch(mod)
        {
            case 0:
                var m16 = safe_read16s(addr);

                push(m16);
                break;
            case 2:
                // fist
                var st0 = get_st0();
                if(st0 <= 0x7FFF && st0 >= -0x8000)
                {
                    safe_write16(addr, integer_round(st0));
                }
                else
                {
                    invalid_arithmatic();
                    safe_write16(addr, 0x8000);
                }
                break;
            case 3:
                // fistp
                var st0 = get_st0();
                if(st0 <= 0x7FFF && st0 >= -0x8000)
                {
                    safe_write16(addr, integer_round(st0));
                }
                else
                {
                    invalid_arithmatic();
                    safe_write16(addr, 0x8000);
                }
                pop();
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

                push(m64);
                break;
            case 7:
                // fistp
                var st0 = integer_round(get_st0());

                if(!(st0 <= 0x7FFFFFFFFFFFFFFF && st0 >= -0x8000000000000000))
                {
                    st0 = 0x8000000000000000;
                    invalid_arithmatic();
                }
                pop();
                safe_write32(addr, st0);

                st0 /= 0x100000000;

                if(st0 < 0 && st0 > -1)
                    st0 = -1;

                safe_write32(addr + 4, st0);
                break;
            default:
                dbg_log(mod); 
                fpu_unimpl();
        }
    };
}
