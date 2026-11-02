// Test-only real devices with optional features deliberately left off.
"use strict";
globalThis.D3D9TestDevice = {
    async options(parameters) {
        if (!["omit_float32", "omit_float32_filter", "omit_bc"].some(name => parameters.has(name))) return {};
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) throw Error("No WebGPU adapter");
        const requiredFeatures = ["texture-compression-bc", "timestamp-query", "float32-blendable", "float32-filterable"]
            .filter(name => adapter.features.has(name) && !(parameters.has("omit_bc") && name === "texture-compression-bc")
                && !((parameters.has("omit_float32") || parameters.has("omit_float32_filter")) && name === "float32-filterable")
                && !(parameters.has("omit_float32") && name === "float32-blendable"));
        const device = await adapter.requestDevice({requiredFeatures});
        if (((parameters.has("omit_float32") || parameters.has("omit_float32_filter")) && device.features.has("float32-filterable"))
                || (parameters.has("omit_float32") && device.features.has("float32-blendable"))
                || (parameters.has("omit_bc") && device.features.has("texture-compression-bc"))) throw Error("Omitted optional feature was enabled");
        return {adapter, device};
    },
    featureBits(device) {
        return ["float32-filterable", "float32-blendable", "texture-compression-bc", "timestamp-query"].reduce((mask, name, bit) => mask | (device.features.has(name) ? 1 << bit : 0), 0);
    },
};
