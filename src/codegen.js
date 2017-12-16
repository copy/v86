"use strict";

if(typeof module !== "undefined")
{
    module.exports = Codegen;
}

/** @constructor */
function Codegen(wm)
{
    this.wm = wm;
    this.wm.funcs["_gen_init"]();
}

Codegen.prototype.reset = function()
{
    this.wm.funcs["_gen_reset"]();
}

Codegen.OUTPUT_OFFSET = 2048;
Codegen.STR_INPUT_OFFSET = Codegen.OUTPUT_OFFSET + 1024 - 32;

Codegen.prototype.str_input = function(str)
{
    if (str.length > 32) {
        throw new Error("Max string length for crossing boundary is 32");
    }
    const view = new Uint8Array(this.wm.mem.buffer, Codegen.STR_INPUT_OFFSET, 32);
    for (let i = 0; i < str.length; i++)
    {
        view[i] = str.charCodeAt(i);
    }
};

Codegen.prototype.fn0 = function(fn)
{
    this.str_input(fn);
    this.wm.funcs["_gen_fn0"](Codegen.STR_INPUT_OFFSET, fn.length);
};

Codegen.prototype.fn1 = function(fn, arg0)
{
    this.str_input(fn);
    this.wm.funcs["_gen_fn1"](Codegen.STR_INPUT_OFFSET, fn.length, arg0);
};

Codegen.prototype.fn2 = function(fn, arg0, arg1)
{
    this.str_input(fn);
    this.wm.funcs["_gen_fn2"](Codegen.STR_INPUT_OFFSET, fn.length, arg0, arg1);
};

Codegen.prototype.modrm_fn0 = function(fn, modrm_byte, arg)
{
    this.str_input(fn);
    this.wm.funcs["_gen_modrm_fn0"](Codegen.STR_INPUT_OFFSET, fn.length, modrm_byte, arg);
};

Codegen.prototype.modrm_fn1 = function(fn, modrm_byte)
{
    this.str_input(fn);
    this.wm.funcs["_gen_modrm_fn1"](Codegen.STR_INPUT_OFFSET, fn.length, modrm_byte);
};

Codegen.prototype.jit_resolve_modrm16 = function(modrm_byte)
{
    this.wm.funcs["_gen_resolve_modrm16"](modrm_byte);
};

Codegen.prototype.jit_resolve_modrm32 = function(modrm_byte)
{
    this.wm.funcs["_gen_resolve_modrm32"](modrm_byte);
};

Codegen.prototype.increment_instruction_pointer = function(n)
{
    this.wm.funcs["_gen_increment_instruction_pointer"](n);
};

Codegen.prototype.set_previous_eip = function()
{
    this.wm.funcs["_gen_set_previous_eip"]();
};

Codegen.prototype.finish = function()
{
    return this.wm.funcs["_gen_finish"]();
};

Codegen.prototype.get_module_code = function()
{
    const final_offset = this.wm.funcs["_gen_get_final_offset"]();

    // extract wasm module
    const output_buffer_view = new Uint8Array(this.wm.mem.buffer,
                                              Codegen.OUTPUT_OFFSET,
                                              final_offset - Codegen.OUTPUT_OFFSET);
    return output_buffer_view;
};

