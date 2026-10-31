// Collision-checked integer keys for structured render/compiler descriptors.
// No JSON strings or lossy source hashes participate in cache identity.
(function(global) {
    "use strict";
    class CacheKeys {
        constructor(hash) {
            this.hash = hash || (words => {
                let h = 2166136261;
                for (const word of words) h = Math.imul(h ^ word, 16777619);
                return h >>> 0;
            });
            this.atoms = new Map();this.references = new WeakMap();this.buckets = new Map();
            this.nextAtom = 1;this.nextReference = 1;this.nextKey = 1;
            this.entryCount = 0;
        }
        reference(object) {
            let id = this.references.get(object);
            if (!id) {
                if (this.nextReference > 0xFFFFFFFF) throw new Error("GL cache reference space exhausted");
                id = this.nextReference++;this.references.set(object, id);
            }
            return id;
        }
        atom(value) {
            let id = this.atoms.get(value);
            if (!id) {
                if (this.nextAtom > 0xFFFFFFFF) throw new Error("GL cache atom space exhausted");
                id = this.nextAtom++;this.atoms.set(value, id);
            }
            return id;
        }
        key(value) {
            const words = [];
            const visit = value => {
                if (value === null || typeof value !== "object") {words.push(0, this.atom(value));return;}
                const reference = this.references.get(value);
                if (reference) {words.push(3, reference);return;}
                if (Array.isArray(value) || ArrayBuffer.isView(value) && typeof value.length === "number") {
                    words.push(1, value.length);
                    for (const item of value) visit(item);
                    return;
                }
                if (Object.prototype.toString.call(value) !== "[object Object]") throw new Error("Unregistered GL cache object");
                const fields = Object.keys(value).filter(key => value[key] !== undefined).sort();
                words.push(2, fields.length);
                for (const key of fields) {words.push(this.atom(key));visit(value[key]);}
            };
            visit(value);
            const hash = this.hash(words), bucket = this.buckets.get(hash) || [];
            for (const entry of bucket) if (entry.words.length === words.length && entry.words.every((v, i) => v === words[i])) return entry.id;
            if (this.nextKey > 0xFFFFFFFF) throw new Error("GL cache key space exhausted");
            const id = this.nextKey++;
            ++this.entryCount;
            bucket.push({ id, words: Uint32Array.from(words) });this.buckets.set(hash, bucket);
            return id;
        }
        clearKeys(preserveIds = false) {
            this.buckets.clear();this.atoms.clear();this.nextAtom = 1;this.entryCount = 0;
            // Compiler variant IDs can outlive the lookup table in a live
            // program; trimming that table must never recycle their IDs.
            if (!preserveIds) this.nextKey = 1;
        }
    }
    const api = { CacheKeys };
    global.GLCacheKeys = api;
    if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
