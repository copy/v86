"use strict";

var performance = {};



var global = {};
var require = function(module) {};
var process = { hrtime: function() {} };
var __dirname = "";

var exports = {};
var define = {};
var module = {};

var WebAssembly = {
    Memory() {},
    Table() {},
    instantiate() { return { instance: null, module: null }; },
    compile() {},
    Instance() {},
    Module() {},
};
WebAssembly.Module.customSections = function(module, section) {};

var wabt = {
    readWasm: function(buf, opt) {},
    generateNames: function() {},
    applyNames: function() {},
    toText: function() {},
};
var cs = {
    Capstone: function() {},
    ARCH_X86: 0,
    MODE_16: 0,
    MODE_32: 0,
    disasm: { bytes: "", mnemonic: "", op_str: "", },
};

const Buffer = {
    allocUnsafe : function(length) {},
    from : function(arrayBuffer, byteOffset, length) {},
};
