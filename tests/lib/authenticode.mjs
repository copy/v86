// Signing for Secure Boot tests (tests/uefi/secure_boot.mjs): test keys and
// certificates (the openssl command line makes them; their private keys stay
// in the test's directory), Authenticode signatures of PE images (the
// PKCS #7 SignedData of an SpcIndirectDataContent over the image's hash, in
// the image's certificate table) and signed variable updates
// (EFI_VARIABLE_AUTHENTICATION_2: a detached SignedData over the name, GUID,
// attributes, time and data). A small DER encoder and reader; RSA with
// SHA-256 from node:crypto.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { guid } from "../../tools/uefi_vars.mjs";

// --- DER

function length_bytes(n)
{
    if(n < 0x80) return [n];
    const bytes = [];
    for(; n; n >>>= 8) bytes.unshift(n & 0xFF);
    return [0x80 | bytes.length, ...bytes];
}
/** @param {number} tag @param {...(Uint8Array|Array<number>)} parts */
export function tlv(tag, ...parts)
{
    const content = Buffer.concat(parts.map(part => Buffer.from(part)));
    return Buffer.concat([Buffer.from([tag, ...length_bytes(content.length)]), content]);
}
const seq = (...parts) => tlv(0x30, ...parts);
const set = (...parts) => tlv(0x31, ...parts);
const octets = bytes => tlv(0x04, bytes);
const explicit = (n, ...parts) => tlv(0xA0 | n, ...parts);
const integer = n => tlv(0x02, [n]);
const NULL = Buffer.from([0x05, 0x00]);
function oid(text)
{
    const [a, b, ...rest] = text.split(".").map(Number);
    const bytes = [40 * a + b];
    for(const n of rest)
    {
        const part = [n & 0x7F];
        for(let v = Math.floor(n / 128); v; v = Math.floor(v / 128)) part.unshift(0x80 | v & 0x7F);
        bytes.push(...part);
    }
    return tlv(0x06, bytes);
}
const OID_SIGNED_DATA = "1.2.840.113549.1.7.2";
const OID_DATA = "1.2.840.113549.1.7.1";
const OID_SHA256 = "2.16.840.1.101.3.4.2.1";
const OID_RSA = "1.2.840.113549.1.1.1";
const OID_CONTENT_TYPE = "1.2.840.113549.1.9.3";
const OID_MESSAGE_DIGEST = "1.2.840.113549.1.9.4";
const OID_SPC_INDIRECT_DATA = "1.3.6.1.4.1.311.2.1.4";
const OID_SPC_PE_IMAGE_DATA = "1.3.6.1.4.1.311.2.1.15";
const SHA256 = seq(oid(OID_SHA256), NULL);

/** The children of a DER constructed value: [tag, header and content] each */
function children(bytes)
{
    const result = [];
    let at = 0;
    while(at < bytes.length)
    {
        const tag = bytes[at];
        let length = bytes[at + 1], header = 2;
        if(length & 0x80)
        {
            const n = length & 0x7F;
            length = 0;
            for(let i = 0; i < n; i++) length = length * 256 + bytes[at + 2 + i];
            header += n;
        }
        result.push({ tag, whole: bytes.subarray(at, at + header + length), content: bytes.subarray(at + header, at + header + length) });
        at += header + length;
    }
    return result;
}

/** A certificate's issuer and serial number (DER) */
function issuer_and_serial(certificate)
{
    const tbs = children(children(certificate)[0].content)[0].content;
    const fields = children(tbs);
    // ([0] version, serialNumber, signature, issuer, ...)
    const start = fields[0].tag === 0xA0 ? 1 : 0;
    return seq(fields[start + 2].whole, fields[start].whole);
}

/**
 * A PKCS #7 SignedData (version 1, SHA-256, RSA)
 * @param {{content_type: string, content: ?Uint8Array, digest_of: !Uint8Array, attributes: boolean, key: !crypto.KeyObject, certificate: !Uint8Array}} o
 *     content: the encapsulated content's bytes (null: detached); digest_of:
 *     what is signed; attributes: with authenticated attributes (content type, message digest)
 */
function signed_data({ content_type, content, digest_of, attributes, key, certificate })
{
    const digest = crypto.createHash("sha256").update(digest_of).digest();
    let signer_attributes = Buffer.alloc(0), signature;
    if(attributes)
    {
        const attrs = [seq(oid(OID_CONTENT_TYPE), set(oid(content_type))), seq(oid(OID_MESSAGE_DIGEST), set(octets(digest)))];
        // (signed as a SET, carried as [0] IMPLICIT)
        signature = crypto.sign("sha256", set(...attrs), key);
        signer_attributes = tlv(0xA0, ...attrs);
    }
    else
    {
        signature = crypto.sign("sha256", digest_of, key);
    }
    const signer = seq(integer(1), issuer_and_serial(certificate), SHA256, signer_attributes, seq(oid(OID_RSA), NULL), octets(signature));
    return seq(integer(1), set(SHA256), seq(oid(content_type), ...content ? [explicit(0, content)] : []),
        explicit(0, certificate), set(signer));
}

// --- keys

/**
 * A test key and its self-signed certificate, made once in a directory
 * @param {string} directory
 * @param {string} name
 * @return {{key: !crypto.KeyObject, certificate: !Uint8Array, name: string}}
 */
export function test_key(directory, name)
{
    fs.mkdirSync(directory, { recursive: true });
    const key_file = path.join(directory, name + ".key"), cert_file = path.join(directory, name + ".der");
    if(!fs.existsSync(cert_file))
    {
        const result = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key_file, "-outform", "DER", "-out", cert_file,
            "-days", "3650", "-subj", "/CN=v86 Secure Boot test " + name, "-sha256"], { encoding: "utf8" });
        if(result.status !== 0) throw new Error("openssl: " + result.stderr);
    }
    return { key: crypto.createPrivateKey(fs.readFileSync(key_file)), certificate: new Uint8Array(fs.readFileSync(cert_file)), name };
}

// --- PE images

/** A PE image's layout: its checksum and certificate table directory entry, headers, sections */
function pe_layout(image)
{
    const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
    const pe = view.getUint32(0x3C, true);
    if(view.getUint32(pe, true) !== 0x4550) throw new Error("not a PE image");
    const sections = view.getUint16(pe + 6, true), optional_size = view.getUint16(pe + 20, true);
    const optional = pe + 24;
    const magic = view.getUint16(optional, true);
    const directories = optional + (magic === 0x20B ? 112 : 96);
    return {
        checksum: optional + 64,
        security: directories + 4 * 8,
        headers: view.getUint32(optional + 60, true),
        table: pe + 24 + optional_size,
        sections,
        view,
    };
}

/**
 * The Authenticode SHA-256 of a PE image (its certificate table and checksum
 * left out), as the firmware computes it
 * @param {!Uint8Array} image
 */
export function pe_hash(image)
{
    const { checksum, security, headers, table, sections, view } = pe_layout(image);
    const hash = crypto.createHash("sha256");
    hash.update(image.subarray(0, checksum));
    hash.update(image.subarray(checksum + 4, security));
    hash.update(image.subarray(security + 8, headers));
    let hashed = headers;
    const raw = [];
    for(let i = 0; i < sections; i++)
    {
        const at = table + i * 40;
        const size = view.getUint32(at + 16, true), pointer = view.getUint32(at + 20, true);
        if(size) raw.push([pointer, size]);
    }
    raw.sort((a, b) => a[0] - b[0]);
    for(const [pointer, size] of raw)
    {
        hash.update(image.subarray(pointer, pointer + size));
        hashed += size;
    }
    const certificates = view.getUint32(security + 4, true);
    if(image.length > hashed + certificates) hash.update(image.subarray(hashed, image.length - certificates));
    return hash.digest();
}

/**
 * A PE image signed (Authenticode, one signature): the SignedData appended in
 * a WIN_CERTIFICATE, the certificate table pointing to it
 * @param {!Uint8Array} image unsigned
 * @param {{key: !crypto.KeyObject, certificate: !Uint8Array}} signer
 */
export function sign_pe(image, { key, certificate })
{
    const { security, view } = pe_layout(image);
    if(view.getUint32(security + 4, true)) throw new Error("the image is signed already");
    // (the table starts 8-byte aligned)
    const unsigned = Buffer.concat([image, Buffer.alloc(-image.length & 7)]);
    const digest = pe_hash(unsigned);
    const indirect = seq(seq(oid(OID_SPC_PE_IMAGE_DATA), seq(Buffer.from([0x03, 0x01, 0x00]), explicit(0, tlv(0xA2, tlv(0x80, Buffer.alloc(0)))))),
        seq(SHA256, octets(digest)));
    // (Authenticode signs the SpcIndirectDataContent's content, its SEQUENCE header left out)
    const pkcs7 = seq(oid(OID_SIGNED_DATA), explicit(0, signed_data({ content_type: OID_SPC_INDIRECT_DATA, content: indirect,
        digest_of: children(indirect)[0].content, attributes: true, key, certificate })));
    const certificate_length = 8 + pkcs7.length;
    const win_certificate = Buffer.alloc(certificate_length + (-certificate_length & 7));
    win_certificate.writeUInt32LE(certificate_length, 0);
    win_certificate.writeUInt16LE(0x0200, 4);
    win_certificate.writeUInt16LE(0x0002, 6);
    pkcs7.copy(win_certificate, 8);
    const signed = new Uint8Array(Buffer.concat([unsigned, win_certificate]));
    const signed_view = new DataView(signed.buffer);
    signed_view.setUint32(security, unsigned.length, true);
    signed_view.setUint32(security + 4, win_certificate.length, true);
    return signed;
}

// --- variable updates

/** EFI_TIME of a date (UTC) */
export function efi_time(date)
{
    const time = Buffer.alloc(16);
    time.writeUInt16LE(date.getUTCFullYear(), 0);
    time[2] = date.getUTCMonth() + 1;
    time[3] = date.getUTCDate();
    time[4] = date.getUTCHours();
    time[5] = date.getUTCMinutes();
    time[6] = date.getUTCSeconds();
    return time;
}

/**
 * A time-based authenticated variable update: EFI_VARIABLE_AUTHENTICATION_2
 * (its time, a WIN_CERTIFICATE_UEFI_GUID with the PKCS #7 SignedData) and the data
 * @param {{name: string, guid: string, attributes: number, time: !Date, data: !Uint8Array, signer: {key: !crypto.KeyObject, certificate: !Uint8Array}}} o
 */
export function signed_update({ name, guid: vendor, attributes, time, data, signer })
{
    const timestamp = efi_time(time);
    const attributes_bytes = Buffer.alloc(4);
    attributes_bytes.writeUInt32LE(attributes, 0);
    const signed = Buffer.concat([Buffer.from(name, "utf16le"), Buffer.from(guid(vendor)), attributes_bytes, timestamp, Buffer.from(data)]);
    // (the bare SignedData, detached; no authenticated attributes)
    const pkcs7 = signed_data({ content_type: OID_DATA, content: null, digest_of: signed, attributes: false, ...signer });
    const header = Buffer.alloc(24);
    header.writeUInt32LE(24 + pkcs7.length, 0);
    header.writeUInt16LE(0x0200, 4);
    header.writeUInt16LE(0x0EF1, 6);
    Buffer.from(guid("4aafd29d-68df-49ee-8aa9-347d375665a7")).copy(header, 8);
    return new Uint8Array(Buffer.concat([timestamp, header, pkcs7, Buffer.from(data)]));
}
