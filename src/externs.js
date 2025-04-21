var global = {};
var process = { hrtime: function() {} };

/**
 * @param {string} name
 * @param {function()} processor
 */
var registerProcessor = function(name, processor) {};

const sampleRate = 0;

var WabtModule = {
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
};
