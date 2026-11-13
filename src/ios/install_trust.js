import { N90_TRUST_CAPACITY, n90_kernel_hashes, n90_trust_kernel } from "./guest_load.js";
import { SHA256 } from "../image/sha256.js";

const fail = message => { throw new Error("iPhone install state: " + message); };
const hex = b => [...b].map(x => x.toString(16).padStart(2, "0")).join("");
const unhex = s => Uint8Array.from(s.match(/../g), x => parseInt(x, 16));
export function install_hashes(state)
{
    validate_install_state(state);
    const all = [...state.system_hashes, ...state.apps.flatMap(a => a.hashes), ...(state.pending?.hashes || [])];
    const hashes = [...new Set(all)].sort();
    if(hashes.length > N90_TRUST_CAPACITY) fail("application code trust capacity exceeded");
    return hashes;
}

export function validate_install_state(state)
{
    if(!state || state.format !== "v86-ios-install-state" || state.version !== 1 || state.build !== "10B329" ||
        !Number.isSafeInteger(state.generation) || state.generation < 1 || state.generation > 0xFFFFFFFF ||
        typeof state.token !== "string" || !/^[0-9a-f]{64}$/.test(state.token) ||
        !Array.isArray(state.system_hashes) || !state.system_hashes.length || !Array.isArray(state.apps) || state.apps.length > N90_TRUST_CAPACITY)
        fail("invalid or unsupported state");
    const check = hashes => {
        if(!Array.isArray(hashes) || !hashes.length || hashes.length > N90_TRUST_CAPACITY || hashes.some(h => typeof h !== "string" || !/^[0-9a-f]{40}$/.test(h)))
            fail("invalid code hashes");
    };
    check(state.system_hashes);
    const ids = new Set();
    for(const app of state.apps)
    {
        if(!app || typeof app.bundle_id !== "string" || ids.has(app.bundle_id)) fail("invalid or duplicate application identity");
        ids.add(app.bundle_id); check(app.hashes);
    }
    if(state.pending)
    {
        if(typeof state.pending.install_id !== "string" || !/^[A-Za-z0-9-]{1,80}$/.test(state.pending.install_id) ||
            typeof state.pending.bundle_id !== "string" || !/^[0-9a-f]{64}$/.test(state.pending.prepared_sha256)) fail("invalid pending installation");
        check(state.pending.hashes);
    }
    return state;
}

export function initial_install_state(kernel, offline = true)
{
    const system_hashes = n90_kernel_hashes(kernel).map(hex);
    const token = hex(globalThis.crypto.getRandomValues(new Uint8Array(32)));
    return validate_install_state({ format: "v86-ios-install-state", version: 1, build: "10B329", generation: 1,
        token, offline, system_hashes, apps: [], pending: null });
}

export function stage_install_trust(kernel, state, manifest, install_id)
{
    validate_install_state(state);
    if(state.pending) fail("a previous installation must be resolved first");
    if(manifest?.format !== "v86-ios-install" || manifest.format_version !== 1 || manifest.architecture !== "armv7" ||
        !Array.isArray(manifest.trusted)) fail("invalid prepared application manifest");
    const pending = { install_id, bundle_id: manifest.bundle_id, version: manifest.version, build: manifest.build,
        prepared_sha256: manifest.prepared_sha256, hashes: manifest.trusted.flatMap(c => c.cdhashes) };
    const next = { ...state, generation: state.generation + 1, pending };
    const hashes = install_hashes(next);
    return { kernel: n90_trust_kernel(kernel, hashes.map(unhex)), state: next };
}

export function finish_install_trust(state, installed)
{
    validate_install_state(state);
    if(!state.pending) return state;
    const { install_id, ...app } = state.pending;
    const apps = installed ? [...state.apps.filter(a => a.bundle_id !== app.bundle_id), app] : state.apps;
    return { ...state, apps, pending: null };
}

export function reset_install_trust(kernel, state)
{
    validate_install_state(state);
    const next = { ...state, generation: state.generation + 1, apps: [], pending: null };
    return { kernel: n90_trust_kernel(kernel, install_hashes(next).map(unhex)), state: next };
}

export function install_allowlist(state)
{
    install_hashes(state);
    const hashes = [...new Set([...state.apps.flatMap(a => a.hashes), ...(state.pending?.hashes || [])])].sort();
    const bytes = new Uint8Array(12 + hashes.length * 20), v = new DataView(bytes.buffer);
    bytes.set(new TextEncoder().encode("V86T")); v.setUint32(4, 1, true); v.setUint32(8, hashes.length, true);
    hashes.forEach((h, i) => bytes.set(unhex(h), 12 + i * 20));
    return bytes;
}

export function install_state_digest(state)
{
    validate_install_state(state);
    return new SHA256().update(new TextEncoder().encode(JSON.stringify(state))).hex();
}
