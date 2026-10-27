// tpm: { version: "2.0", interface: "crb", state } -- a TPM 2.0 on the PC
// machines (docs/tpm.md; docs/modern-pc-devices-plan.md T1): its CRB
// interface at 0xFED40000 (src/tpm/crb.js) in front of libtpms in
// WebAssembly (src/tpm/libtpms.js), its permanent state in a store
// (src/tpm/store.js). Built into build/v86-tpm.js; from the source tree,
// src/device_plugin.js imports this file directly.
//
// A TPM not yet manufactured is made as swtpm_setup makes one by default: its
// SHA-256 PCR bank allocated, the others not. A machine reset is the TPM's
// (_TPM_Init): its volatile state goes, the firmware or the OS starts it.

import { register_device_plugin } from "../device_machine.js";
import { compile_libtpms, create_libtpms, BLOB_PERMANENT } from "./libtpms.js";
import { CRB_BASE, CRB_SIZE, TpmCrb } from "./crb.js";
import { TpmStore } from "./store.js";

/** The memory map's blocks: 128 KiB from the base */
const MAP_SIZE = 0x20000;

/**
 * A command's bytes: tag, size and code, then the rest
 * @param {number} tag
 * @param {number} code
 * @param {!Array<number>} rest
 * @return {!Uint8Array}
 */
function command(tag, code, rest)
{
    const length = 10 + rest.length;
    return new Uint8Array([tag >> 8, tag & 0xFF, length >>> 24, length >> 16 & 0xFF, length >> 8 & 0xFF, length & 0xFF,
        code >>> 24, code >> 16 & 0xFF, code >> 8 & 0xFF, code & 0xFF, ...rest]);
}

/** @param {!Uint8Array} response @return {number} its response code */
const response_code = response => (response[6] << 24 | response[7] << 16 | response[8] << 8 | response[9]) >>> 0;

const TPM_ST_NO_SESSIONS = 0x8001;
const TPM_ST_SESSIONS = 0x8002;
const TPM2_CC_STARTUP = 0x144;
const TPM2_CC_SHUTDOWN = 0x145;
const TPM2_CC_PCR_ALLOCATE = 0x12B;
const TPM_SU_CLEAR = [0, 0];
const TPM_RH_PLATFORM = [0x40, 0, 0, 0x0C];
/** The password session with an empty password: TPM_RS_PW, no nonce, no attributes, no HMAC */
const EMPTY_PASSWORD = [0, 0, 0, 9, 0x40, 0, 0, 9, 0, 0, 0, 0, 0];
/** SHA-256 for every PCR; SHA-1, SHA-384 and SHA-512 for none */
const PCR_ALLOCATION = [0, 0, 0, 4, 0, 0x04, 3, 0, 0, 0, 0, 0x0B, 3, 0xFF, 0xFF, 0xFF, 0, 0x0C, 3, 0, 0, 0, 0, 0x0D, 3, 0, 0, 0];

/**
 * A new TPM's manufacture: started, its PCR banks allocated, shut down
 * @param {!Object} tpm a powered Libtpms
 */
function allocate_pcr_banks(tpm)
{
    const steps = [
        ["Startup", command(TPM_ST_NO_SESSIONS, TPM2_CC_STARTUP, TPM_SU_CLEAR)],
        ["PCR_Allocate", command(TPM_ST_SESSIONS, TPM2_CC_PCR_ALLOCATE, [...TPM_RH_PLATFORM, ...EMPTY_PASSWORD, ...PCR_ALLOCATION])],
        ["Shutdown", command(TPM_ST_NO_SESSIONS, TPM2_CC_SHUTDOWN, TPM_SU_CLEAR)],
    ];
    for(const [name, bytes] of steps)
    {
        const code = response_code(tpm.process(bytes, 0));
        if(code !== 0) throw new Error("tpm: the new TPM's " + name + " failed (" + code.toString(16) + ")\n" + tpm.log);
    }
}

register_device_plugin("V86TpmDevices", {
    "name": "tpm",

    /**
     * Before the machine: libtpms compiled and instantiated (asynchronous)
     * @param {!Object} options "wasm": the module's bytes
     * @return {!Promise<!Object>}
     */
    "prepare": async options =>
    {
        const module = await compile_libtpms(options["wasm"]);
        return create_libtpms(module, () => {});
    },

    /**
     * @param {!Object} handle
     * @param {!Object} options "prepared": prepare's result; "state": the store's buffer object
     */
    "create": (handle, options) =>
    {
        const tpm = options["prepared"];
        const store = new TpmStore(options["state"]);
        tpm.on_store = (kind, blob) =>
        {
            if(kind === BLOB_PERMANENT && blob) store.save(blob);
        };
        const permanent = store.load();
        if(!permanent)
        {
            const result = tpm.power_on(null);
            if(result) throw new Error("tpm: the new TPM cannot be made (" + result.toString(16) + ")\n" + tpm.log);
            allocate_pcr_banks(tpm);
            tpm.power_off();
        }
        /**
         * @param {?Uint8Array} blob
         * @param {?Uint8Array=} volatile
         */
        const power_on = (blob, volatile) =>
        {
            const result = tpm.power_on(blob, volatile);
            if(result) throw new Error("tpm: the TPM cannot be powered on (" + result.toString(16) + ")\n" + tpm.log);
        };
        // (without a blob: the one libtpms stored last, which it kept)
        power_on(permanent);

        // (each command from the guest, its response and the time it took,
        // to the device's "on_command" when a host sets one: diagnostics)
        const crb = new TpmCrb((bytes, locality) =>
        {
            const on_command = device["on_command"];
            if(!on_command) return tpm.process(bytes, locality);
            const start = performance.now();
            const response = tpm.process(bytes, locality);
            on_command(bytes, response, performance.now() - start);
            return response;
        });
        const in_crb = address => (address >>> 0) - CRB_BASE < CRB_SIZE;
        handle["mmap_register"](CRB_BASE, MAP_SIZE,
            address => in_crb(address) ? crb.read8((address >>> 0) - CRB_BASE) : 0xFF,
            (address, value) => { if(in_crb(address)) crb.write8((address >>> 0) - CRB_BASE, value); },
            address => in_crb(address) ? crb.read32((address >>> 0) - CRB_BASE >>> 12, (address >>> 0) - CRB_BASE & 0xFFF) | 0 : -1,
            (address, value) => { if(in_crb(address)) crb.write32((address >>> 0) - CRB_BASE >>> 12, (address >>> 0) - CRB_BASE & 0xFFF, value >>> 0); });

        const device = {
            // (the platform's reset is the TPM's _TPM_Init)
            "reset": () =>
            {
                crb.reset();
                tpm.power_off();
                power_on(null);
            },
            "destroy": () => tpm.power_off(),
            // the CRB and the TPM's volatile state; the store's part of a
            // snapshot is the machine's (src/cpu.js, as a disk's)
            "get_state": () => [crb.get_state(), tpm.volatile_state()],
            "set_state": state =>
            {
                crb.set_state(state[0]);
                tpm.power_off();
                power_on(store.load(), state[1]);
            },
            /** libtpms's own messages */
            "log": () => tpm.log,
            /** A command from the host (tests), at a locality */
            "process": (bytes, locality) => tpm.process(bytes, locality || 0),
            /** @type {?function(!Uint8Array, !Uint8Array, number)} */
            "on_command": null,
        };
        return device;
    },
});
