// A minimal Android app for P11's "install and start an app"
// (docs/arm64-virt-android16-plan.md P11.2): package org.v86.hello, no code
// (android:hasCode="false"), one launcher activity that is the framework's
// own android.app.Activity, which shows an empty window titled with the
// app's label. Built here without the SDK: the manifest in Android's binary
// XML, a stored zip, and the JAR signature (v1) with a key and certificate
// made by openssl (build/a64-android/apk-key/, once). targetSdkVersion 29:
// Android 16 installs from 24 on and asks for the v2 signature only from 30.
//
//   const bytes = build_apk({ label: "v86 hello" });
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash as create_hash } from "node:crypto";
import { crc32 } from "node:zlib";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..") + "/";
export const APK_PACKAGE = "org.v86.hello";
const ANDROID_NS = "http://schemas.android.com/apk/res/android";
/** android:* attributes' resource IDs (frameworks/base/core/res/res/values/public*.xml) */
const ATTR_IDS = {
    label: 0x01010001, name: 0x01010003, hasCode: 0x0101000c, exported: 0x01010010,
    minSdkVersion: 0x0101020c, versionCode: 0x0101021b, versionName: 0x0101021c, targetSdkVersion: 0x01010270,
};
const TYPE_STRING = 0x03, TYPE_INT_DEC = 0x10, TYPE_INT_BOOLEAN = 0x12;

/**
 * Binary XML (frameworks/base/libs/androidfw/include/androidfw/ResourceTypes.h)
 * of a tree [name, { attr: value }, children]; android:* attributes by name,
 * numbers as decimal integers, booleans as booleans, strings as strings
 */
export function binary_xml(tree)
{
    // the strings: the android attributes' names first (the resource map's), then the rest
    const attr_names = new Set();
    const others = new Set(["android", ANDROID_NS]);
    const walk = ([name, attributes, children]) => {
        others.add(name);
        for(const [key, value] of Object.entries(attributes))
        {
            if(key.startsWith("android:")) attr_names.add(key.slice(8));
            else others.add(key);
            if(typeof value === "string") others.add(value);
        }
        children.forEach(walk);
    };
    walk(tree);
    const mapped = [...attr_names].sort((a, b) => ATTR_IDS[a] - ATTR_IDS[b]);
    for(const name of mapped) if(!ATTR_IDS[name]) throw new Error("no resource ID for android:" + name);
    const strings = [...mapped, ...[...others].filter(s => !attr_names.has(s))];
    const index = s => { const i = strings.indexOf(s); if(i < 0) throw new Error(s); return i; };

    const u16 = v => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
    const u32 = v => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b; };
    const chunk = (type, header_size, header_rest, body) => {
        const size = 8 + header_rest.length + body.length;
        return Buffer.concat([u16(type), u16(header_size), u32(size), header_rest, body]);
    };
    // string pool, UTF-16
    const data = strings.map(s => Buffer.concat([u16(s.length), Buffer.from(s, "utf16le"), u16(0)]));
    const offsets = [];
    let at = 0;
    for(const d of data) { offsets.push(at); at += d.length; }
    let string_data = Buffer.concat(data);
    string_data = Buffer.concat([string_data, Buffer.alloc((4 - string_data.length % 4) % 4)]);
    const pool_header = 28;
    const pool = chunk(0x0001, pool_header, Buffer.concat([u32(strings.length), u32(0), u32(0),
        u32(pool_header + strings.length * 4), u32(0)]), Buffer.concat([...offsets.map(u32), string_data]));
    const resource_map = chunk(0x0180, 8, Buffer.alloc(0), Buffer.concat(mapped.map(n => u32(ATTR_IDS[n]))));

    const node = (type, body) => chunk(type, 16, Buffer.concat([u32(1), u32(0xFFFFFFFF)]), body);
    const nodes = [node(0x0100, Buffer.concat([u32(index("android")), u32(index(ANDROID_NS))]))];
    const element = ([name, attributes, children]) => {
        const attrs = Object.entries(attributes).map(([key, value]) => {
            const android = key.startsWith("android:");
            const attr_name = android ? key.slice(8) : key;
            let raw = 0xFFFFFFFF, type, data_value;
            if(typeof value === "string") { raw = index(value); type = TYPE_STRING; data_value = index(value); }
            else if(typeof value === "boolean") { type = TYPE_INT_BOOLEAN; data_value = value ? 0xFFFFFFFF : 0; }
            else { type = TYPE_INT_DEC; data_value = value; }
            return { id: android ? ATTR_IDS[attr_name] : 0, bytes: Buffer.concat([u32(android ? index(ANDROID_NS) : 0xFFFFFFFF),
                u32(index(attr_name)), u32(raw), u16(8), Buffer.from([0, type]), u32(data_value)]) };
        }).sort((a, b) => a.id - b.id);
        nodes.push(node(0x0102, Buffer.concat([u32(0xFFFFFFFF), u32(index(name)), u16(20), u16(20), u16(attrs.length),
            u16(0), u16(0), u16(0), ...attrs.map(a => a.bytes)])));
        children.forEach(element);
        nodes.push(node(0x0103, Buffer.concat([u32(0xFFFFFFFF), u32(index(name))])));
    };
    element(tree);
    nodes.push(node(0x0101, Buffer.concat([u32(index("android")), u32(index(ANDROID_NS))])));
    return chunk(0x0003, 8, Buffer.alloc(0), Buffer.concat([pool, resource_map, ...nodes]));
}

/** a zip of stored entries [[name, bytes], ...] */
export function stored_zip(entries)
{
    const local = [], central = [];
    let offset = 0;
    for(const [name, data] of entries)
    {
        const n = Buffer.from(name), crc = crc32(data);
        const header = Buffer.alloc(30);
        header.writeUInt32LE(0x04034B50, 0); header.writeUInt16LE(10, 4); header.writeUInt16LE(0x0800, 6);
        header.writeUInt32LE(crc, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22);
        header.writeUInt16LE(n.length, 26);
        local.push(header, n, data);
        const c = Buffer.alloc(46);
        c.writeUInt32LE(0x02014B50, 0); c.writeUInt16LE(10, 4); c.writeUInt16LE(10, 6); c.writeUInt16LE(0x0800, 8);
        c.writeUInt32LE(crc, 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24);
        c.writeUInt16LE(n.length, 28); c.writeUInt32LE(offset, 42);
        central.push(c, n);
        offset += 30 + n.length + data.length;
    }
    const directory = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054B50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
    return Buffer.concat([...local, directory, end]);
}

function openssl(args, input)
{
    const r = spawnSync("openssl", args, { input, maxBuffer: 1 << 24 });
    if(r.status !== 0) throw new Error("openssl " + args[0] + ": " + r.stderr);
    return r.stdout;
}

/** the test key and certificate (RSA 2048, self-signed), made once */
function signing_key()
{
    const dir = ROOT + "build/a64-android/apk-key/";
    if(!fs.existsSync(dir + "cert.pem"))
    {
        fs.mkdirSync(dir, { recursive: true });
        openssl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", dir + "key.pem", "-out", dir + "cert.pem",
            "-days", "36500", "-subj", "/CN=v86 test app", "-sha256"]);
    }
    return { key: dir + "key.pem", cert: dir + "cert.pem" };
}

/** the APK's bytes */
export function build_apk({ label = "v86 hello" } = {})
{
    const manifest = binary_xml(["manifest", { "package": APK_PACKAGE, "android:versionCode": 1, "android:versionName": "1" }, [
        ["uses-sdk", { "android:minSdkVersion": 29, "android:targetSdkVersion": 29 }, []],
        ["application", { "android:label": label, "android:hasCode": false }, [
            ["activity", { "android:name": "android.app.Activity", "android:label": label, "android:exported": true }, [
                ["intent-filter", {}, [
                    ["action", { "android:name": "android.intent.action.MAIN" }, []],
                    ["category", { "android:name": "android.intent.category.LAUNCHER" }, []],
                ]],
            ]],
        ]],
    ]]);
    // the JAR signature: MANIFEST.MF, CERT.SF, CERT.RSA (PKCS #7, detached)
    const b64 = data => create_hash("sha256").update(data).digest("base64");
    const section = `Name: AndroidManifest.xml\r\nSHA-256-Digest: ${b64(manifest)}\r\n\r\n`;
    const mf = Buffer.from(`Manifest-Version: 1.0\r\nCreated-By: v86\r\n\r\n` + section);
    const sf = Buffer.from(`Signature-Version: 1.0\r\nCreated-By: v86\r\nSHA-256-Digest-Manifest: ${b64(mf)}\r\n\r\n` +
        `Name: AndroidManifest.xml\r\nSHA-256-Digest: ${b64(Buffer.from(section))}\r\n\r\n`);
    const { key, cert } = signing_key();
    const rsa = openssl(["smime", "-sign", "-binary", "-noattr", "-md", "sha256", "-outform", "DER", "-signer", cert, "-inkey", key], sf);
    return stored_zip([["AndroidManifest.xml", manifest], ["META-INF/MANIFEST.MF", mf], ["META-INF/CERT.SF", sf], ["META-INF/CERT.RSA", rsa]]);
}
