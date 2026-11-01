// Session-owned upload storage. Only staging buffers are written through the
// queue; destination copies are replayed between draws in guest command order.
(function(global) {
    "use strict";
    const align = (n, a) => Math.ceil(n / a) * a;
    class D9WGUploads {
        constructor(device, retire, stats) {
            this.device = device;
            this.retire = retire;
            this.stats = stats;
            this.chunks = [];
            this.reset();
        }
        reset() {
            this.index = 0;
            this.cursor = 0;
            this.bytesUsed = 0;
            for (const chunk of this.chunks) chunk.used = 0;
        }
        reserve(bytes) {
            const size = align(bytes, 4);
            let offset = align(this.cursor, 256), chunk = this.chunks[this.index];
            if (chunk && offset + size > chunk.data.length && this.cursor) {
                ++this.index;offset = 0;chunk = this.chunks[this.index];
            }
            if (!chunk || size > chunk.data.length) {
                if (chunk) this.retire(chunk.buffer);
                const capacity = Math.max(4 << 20, align(size, 256));
                chunk = { buffer: this.device.createBuffer({ label: "D3D9 ordered upload staging",
                    size: capacity, usage: 0x4 | 0x8 }), data: new Uint8Array(capacity), used: 0 };
                this.chunks[this.index] = chunk;
                this.stats.uploadChunksAllocated = (this.stats.uploadChunksAllocated || 0) + 1;
            }
            this.cursor = offset + size;
            chunk.used = Math.max(chunk.used, this.cursor);
            this.bytesUsed += size;
            return { buffer: chunk.buffer, offset, data: chunk.data.subarray(offset, offset + size) };
        }
        buffer(destination, destinationOffset, source) {
            const allocation = this.reserve(source.byteLength);
            allocation.data.set(source);
            return { kind: "buffer-upload", source: allocation.buffer, sourceOffset: allocation.offset,
                destination, destinationOffset, size: allocation.data.length };
        }
        texture(destination, source, layout, size) {
            const pitch = align(layout.bytesPerRow, 256), rows = layout.rowsPerImage;
            const allocation = this.reserve(pitch * rows * size.depthOrArrayLayers);
            allocation.data.fill(0);
            for (let slice = 0; slice < size.depthOrArrayLayers; ++slice) {
                for (let row = 0; row < rows; ++row) {
                    const at = (slice * rows + row) * layout.bytesPerRow;
                    allocation.data.set(source.subarray(at, at + layout.bytesPerRow), (slice * rows + row) * pitch);
                }
            }
            return { kind: "texture-upload", source: { buffer: allocation.buffer, offset: allocation.offset,
                bytesPerRow: pitch, rowsPerImage: rows }, destination, size };
        }
        flush() {
            for (const chunk of this.chunks) {
                if (!chunk.used) continue;
                this.device.queue.writeBuffer(chunk.buffer, 0, chunk.data, 0, align(chunk.used, 4));
                this.stats.uploadStagingUploads = (this.stats.uploadStagingUploads || 0) + 1;
            }
        }
        replay(encoder, op) {
            if (op.kind === "buffer-upload") {
                encoder.copyBufferToBuffer(op.source, op.sourceOffset, op.destination, op.destinationOffset, op.size);
                return true;
            }
            if (op.kind === "texture-upload") {
                encoder.copyBufferToTexture(op.source, op.destination, op.size);
                return true;
            }
            return false;
        }
        release() {
            for (const chunk of this.chunks) this.retire(chunk.buffer);
            this.chunks = [];
            this.reset();
        }
    }
    global.D9WGUploads = D9WGUploads;
    if (typeof module !== "undefined" && module.exports) module.exports = D9WGUploads;
})(typeof globalThis !== "undefined" ? globalThis : this);
