// Both transports use the production CPU barrier and asynchronous result path.
"use strict";
(function(root) {
    function connect(cpu, gpu, copied) {
        let nextBatch = 0;
        const memories = new Map(), results = [];
        cpu.requireGPUProgramValidation = true;
        cpu.writeResponse = (target, bytes) => memories.get(target.batchId).set(bytes, target.offset);
        gpu.options.writeGuestMemory = (offset, bytes, metadata) => memories.get(metadata.batchId).set(bytes, offset + metadata.baseOffset);
        const forward = (bytes, segments, metadata) => {
            for (const segment of segments || [{offset: 0, length: bytes.length}]) {
                const part = segment.bytes || bytes.subarray(segment.offset, segment.offset + segment.length);
                gpu.submit(copied ? part.slice() : part, {batchId: metadata.batchId,
                    baseOffset: (metadata.offset || 0) + (segment.bytes ? 0 : segment.offset),
                    onProgramLink: result => {results.push(result);cpu.completeProgramLink(result);}});
            }
        };
        cpu.onCPUResume = forward;
        const start = stream => {
            const bytes = stream.bytes(), metadata = {generation: 1, batchId: ++nextBatch, root: true, offset: 0};
            memories.set(metadata.batchId, bytes);forward(bytes, cpu.process(bytes, metadata), metadata);
        };
        return {start, results, async send(stream) {start(stream);await gpu.idle();}};
    }
    if (typeof module === "object") module.exports = {connect};
    else root.GLProgramLinkHarness = {connect};
})(typeof globalThis === "object" ? globalThis : this);
