import { SHA256 } from "../image/sha256.js";

export const INSTALL_PROTOCOL = 1;
export const INSTALL_MAGIC = 0x49363856;
export const INSTALL_SERVICE = "v86.ios.install";
export const INSTALL_CHUNK = 64 << 10;
export const INSTALL_FRAME_MAX = INSTALL_CHUNK + 8192;
export const INSTALL_OP = Object.freeze({ CHALLENGE: 1, HELLO: 2, READY: 3, BEGIN: 10, WRITE: 11, STAGE: 12,
    COMMIT: 13, CANCEL: 14, LOOKUP: 15, SHUTDOWN: 16, LAUNCH: 17, PROGRESS: 30, REPLY: 31 });
const encoder = new TextEncoder();

export function install_frame(op, sequence, payload = new Uint8Array(0))
{
    if(!(payload instanceof Uint8Array) || payload.length > INSTALL_FRAME_MAX) throw new Error("Invalid iPhone install frame size");
    const bytes = new Uint8Array(16 + payload.length), v = new DataView(bytes.buffer);
    v.setUint32(0, INSTALL_MAGIC, true); v.setUint32(4, op, true); v.setUint32(8, sequence, true); v.setUint32(12, payload.length, true);
    bytes.set(payload, 16); return bytes;
}

export function install_frame_reader(consume)
{
    let buffer = new Uint8Array(0);
    return bytes => {
        if(!(bytes instanceof Uint8Array) || bytes.length > INSTALL_FRAME_MAX + 16) throw new Error("Invalid iPhone install transport write");
        const joined = new Uint8Array(buffer.length + bytes.length); joined.set(buffer); joined.set(bytes, buffer.length); buffer = joined;
        while(buffer.length >= 16)
        {
            const v = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength), length = v.getUint32(12, true);
            if(v.getUint32(0, true) !== INSTALL_MAGIC || length > INSTALL_FRAME_MAX) throw new Error("Malformed iPhone install frame");
            if(buffer.length < length + 16) break;
            const op = v.getUint32(4, true), sequence = v.getUint32(8, true), payload = buffer.slice(16, length + 16);
            buffer = buffer.slice(length + 16); consume(op, sequence, payload);
        }
    };
}

export function install_proof(token, challenge)
{
    if(!/^[0-9a-f]{64}$/.test(token) || challenge.length !== 32) throw new Error("Invalid installation handshake");
    return install_mac(token, challenge);
}

export function install_mac(token, message)
{
    if(!/^[0-9a-f]{64}$/.test(token)) throw new Error("Invalid installation key");
    const key = Uint8Array.from(token.match(/../g), x => parseInt(x, 16));
    const inner = new Uint8Array(64).fill(0x36), outer = new Uint8Array(64).fill(0x5C);
    for(let i = 0; i < key.length; i++) { inner[i] ^= key[i]; outer[i] ^= key[i]; }
    return new SHA256().update(outer).update(new SHA256().update(inner).update(message).digest()).digest();
}

export function install_message_mac(token, challenge, op, sequence, body)
{
    const bytes = new Uint8Array(40 + body.length), v = new DataView(bytes.buffer);
    bytes.set(challenge); v.setUint32(32, op, true); v.setUint32(36, sequence, true); bytes.set(body, 40);
    return install_mac(token, bytes);
}

export function install_job(manifest, state, install_id)
{
    const hashes = [...new Set([...state.apps.flatMap(a => a.hashes), ...(state.pending?.hashes || [])])].sort();
    if(!state.pending || state.pending.install_id !== install_id || state.pending.prepared_sha256 !== manifest.prepared_sha256 ||
        !Number.isSafeInteger(manifest.prepared_size) || manifest.prepared_size < 1 || manifest.prepared_size > 2 * 1024 ** 3)
        throw new Error("Prepared IPA does not match its installation task");
    const main = manifest.trusted.find(c => c.path === manifest.executable)?.cdhashes?.[0];
    if(typeof main !== "string" || !/^[0-9a-f]{40}$/.test(main)) throw new Error("Prepared IPA has no main executable identity");
    const bytes = new Uint8Array(548 + hashes.length * 20), v = new DataView(bytes.buffer);
    v.setUint32(0, 0x314A3856, true); v.setUint32(4, manifest.prepared_size, true); v.setUint32(8, state.generation, true);
    v.setUint32(12, manifest.graphics ? 1 : 0, true); v.setUint32(16, hashes.length, true);
    if(!Number.isSafeInteger(manifest.expanded_size) || manifest.expanded_size < 1 || manifest.expanded_size > 4 * 1024 ** 3)
        throw new Error("Invalid expanded IPA size");
    v.setBigUint64(20, BigInt(manifest.expanded_size), true);
    const text = (at, capacity, value) => {
        const data = encoder.encode(String(value || ""));
        if(!data.length || data.length >= capacity || data.includes(0)) throw new Error("Installation metadata field is too long");
        bytes.set(data, at);
    };
    text(32, 80, install_id); text(112, 256, manifest.bundle_id); text(368, 128, manifest.version || manifest.build || "unknown");
    bytes.set(Uint8Array.from(manifest.prepared_sha256.match(/../g), x => parseInt(x, 16)), 496);
    bytes.set(new Uint8Array(main.match(/../g).map(x => parseInt(x, 16))), 528);
    hashes.forEach((h, i) => bytes.set(Uint8Array.from(h.match(/../g), x => parseInt(x, 16)), 548 + i * 20));
    return bytes;
}
