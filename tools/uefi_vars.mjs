#!/usr/bin/env node
// The UEFI firmware's variable store (docs/uefi.md): OVMF's flash image of
// variables (bios/ovmf-vars.fd: a firmware volume holding edk2's
// authenticated variable store, MdeModulePkg/Include/Guid/VariableFormat.h)
// with variables written into it before the firmware runs, as a vendor
// enrolls its Secure Boot keys: PK, KEK, db, dbx as EFI signature lists. The
// firmware trusts its store; from then on its SMM code alone changes them,
// each change verified against the keys (src/pflash.js: secure). Also reads a
// store's variables (tests).
//
//   node tools/uefi_vars.mjs microsoft <secureboot_objects> <template> <out>
// writes Microsoft's keys (bios/make-ovmf-vars-ms.sh): the PK Microsoft gives
// OEM devices, its KEKs, the db certificates of Windows, third-party UEFI
// software and option ROMs, and the dbx of its signed update.

import fs from "node:fs";
import path from "node:path";
import url from "node:url";

/** @param {string} text a GUID in its usual form @return {!Uint8Array} its bytes (the first three fields little endian) */
export function guid(text)
{
    const hex = text.replace(/-/g, "");
    const bytes = Uint8Array.from(hex.match(/../g), byte => parseInt(byte, 16));
    bytes.subarray(0, 4).reverse();
    bytes.subarray(4, 6).reverse();
    bytes.subarray(6, 8).reverse();
    return bytes;
}

/** @param {!Uint8Array} bytes @return {string} */
export function guid_text(bytes)
{
    const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0"));
    const le = (from, to) => hex.slice(from, to).reverse().join("");
    return [le(0, 4), le(4, 6), le(6, 8), hex.slice(8, 10).join(""), hex.slice(10).join("")].join("-");
}

export const GLOBAL_VARIABLE = "8be4df61-93ca-11d2-aa0d-00e098032b8c";
export const IMAGE_SECURITY_DATABASE = "d719b2cb-3d3a-4596-a3bc-dad00e67656f";
export const CERT_X509 = "a5c059a1-94e4-4aa7-87b5-ab155c2bf072";
export const CERT_SHA256 = "c1c41626-504c-4092-aca9-41f936934328";
export const MICROSOFT = "77fa9abd-0359-4d32-bd60-28f4e78f784b";
const AUTHENTICATED_VARIABLE_STORE = "aaf32c78-947b-439a-a180-2e144ec37792";

/** EFI variable attributes */
export const NV = 1, BS = 2, RT = 4, TIME_AUTH = 0x20, APPEND = 0x40;
/** PK, KEK, db, dbx */
export const SECURE_BOOT_ATTRIBUTES = NV | BS | RT | TIME_AUTH;

const STORE_HEADER = 0x48;
const STORE_HEADER_SIZE = 28;
const VARIABLE_HEADER_SIZE = 60;
const VARIABLE_DATA = 0x55AA;
const VAR_ADDED = 0x3F;

/**
 * An EFI_SIGNATURE_LIST
 * @param {string} type CERT_X509, CERT_SHA256
 * @param {!Array<!Uint8Array>} signatures each the same size (one certificate per list)
 * @param {string} owner
 * @return {!Uint8Array}
 */
export function signature_list(type, signatures, owner)
{
    const size = 16 + signatures[0].length;
    const list = new Uint8Array(28 + signatures.length * size);
    const view = new DataView(list.buffer);
    list.set(guid(type), 0);
    view.setUint32(16, list.length, true);
    view.setUint32(20, 0, true);
    view.setUint32(24, size, true);
    signatures.forEach((signature, i) => {
        list.set(guid(owner), 28 + i * size);
        list.set(signature, 28 + i * size + 16);
    });
    return list;
}

/** @param {!Uint8Array} der @param {string} owner @return {!Uint8Array} */
export const x509_list = (der, owner) => signature_list(CERT_X509, [der], owner);

/**
 * The signed data of an authenticated variable update
 * (EFI_VARIABLE_AUTHENTICATION_2: EFI_TIME, then WIN_CERTIFICATE_UEFI_GUID)
 * @param {!Uint8Array} update
 * @return {{time: !Uint8Array, data: !Uint8Array}}
 */
export function update_data(update)
{
    const length = new DataView(update.buffer, update.byteOffset).getUint32(16, true);
    return { time: update.subarray(0, 16), data: update.subarray(16 + length) };
}

/**
 * The variables of a store image
 * @param {!Uint8Array} image
 * @return {!Array<{name: string, guid: string, attributes: number, time: !Uint8Array, data: !Uint8Array}>}
 */
export function read_variables(image)
{
    const view = new DataView(image.buffer, image.byteOffset);
    const end = STORE_HEADER + view.getUint32(STORE_HEADER + 16, true);
    const variables = [];
    let at = STORE_HEADER + STORE_HEADER_SIZE;
    while(at + VARIABLE_HEADER_SIZE <= end && view.getUint16(at, true) === VARIABLE_DATA)
    {
        const name_size = view.getUint32(at + 36, true), data_size = view.getUint32(at + 40, true);
        const name_at = at + VARIABLE_HEADER_SIZE;
        if(image[at + 2] === VAR_ADDED)
        {
            variables.push({
                name: String.fromCharCode(...new Uint16Array(image.slice(name_at, name_at + name_size - 2).buffer)),
                guid: guid_text(image.subarray(at + 44, at + 60)),
                attributes: view.getUint32(at + 4, true),
                time: image.slice(at + 16, at + 32),
                data: image.slice(name_at + name_size, name_at + name_size + data_size),
            });
        }
        at = name_at + name_size + data_size + 3 & ~3;
    }
    return variables;
}

/**
 * A store with variables written into it: the template's store must be
 * empty (a new machine's, bios/ovmf-vars.fd)
 * @param {!Uint8Array} template
 * @param {!Array<{name: string, guid: string, attributes: number, data: !Uint8Array, time?: !Uint8Array}>} variables
 * @return {!Uint8Array}
 */
export function write_variables(template, variables)
{
    const image = template.slice();
    const view = new DataView(image.buffer);
    if(guid_text(image.subarray(STORE_HEADER, STORE_HEADER + 16)) !== AUTHENTICATED_VARIABLE_STORE)
    {
        throw new Error("not an authenticated variable store (edk2's, at 0x48)");
    }
    const end = STORE_HEADER + view.getUint32(STORE_HEADER + 16, true);
    let at = STORE_HEADER + STORE_HEADER_SIZE;
    if(image.subarray(at, end).some(byte => byte !== 0xFF))
    {
        throw new Error("the template's store is not empty");
    }
    for(const { name, guid: vendor, attributes, data, time } of variables)
    {
        const name_bytes = new Uint8Array(new Uint16Array(Array.from(name + "\0", c => c.charCodeAt(0))).buffer);
        const next = at + VARIABLE_HEADER_SIZE + name_bytes.length + data.length + 3 & ~3;
        if(next > end) throw new Error("the variables do not fit the store");
        image.fill(0, at, at + VARIABLE_HEADER_SIZE);
        view.setUint16(at, VARIABLE_DATA, true);
        image[at + 2] = VAR_ADDED;
        view.setUint32(at + 4, attributes, true);
        // (MonotonicCount 0; the time of a time-based variable: zero unless
        // given, so that any signed update is later)
        if(time) image.set(time, at + 16);
        view.setUint32(at + 36, name_bytes.length, true);
        view.setUint32(at + 40, data.length, true);
        image.set(guid(vendor), at + 44);
        image.set(name_bytes, at + VARIABLE_HEADER_SIZE);
        image.set(data, at + VARIABLE_HEADER_SIZE + name_bytes.length);
        // (the alignment padding stays erased)
        at = next;
    }
    return image;
}

/**
 * The Secure Boot variables: PK, KEK, db, dbx from their signature lists
 * @param {{pk: !Uint8Array, kek: !Uint8Array, db: !Uint8Array, dbx: !Uint8Array}} lists
 */
export function secure_boot_variables({ pk, kek, db, dbx })
{
    return [
        { name: "PK", guid: GLOBAL_VARIABLE, attributes: SECURE_BOOT_ATTRIBUTES, data: pk },
        { name: "KEK", guid: GLOBAL_VARIABLE, attributes: SECURE_BOOT_ATTRIBUTES, data: kek },
        { name: "db", guid: IMAGE_SECURITY_DATABASE, attributes: SECURE_BOOT_ATTRIBUTES, data: db },
        { name: "dbx", guid: IMAGE_SECURITY_DATABASE, attributes: SECURE_BOOT_ATTRIBUTES, data: dbx },
    ];
}

/** The files of microsoft/secureboot_objects this store is made of */
export const MICROSOFT_FILES = {
    pk: ["PreSignedObjects/PK/Certificate/WindowsOEMDevicesPK.der"],
    kek: ["PreSignedObjects/KEK/Certificates/MicCorKEKCA2011_2011-06-24.der",
        "PreSignedObjects/KEK/Certificates/microsoft corporation kek 2k ca 2023.der"],
    db: ["PreSignedObjects/DB/Certificates/MicWinProPCA2011_2011-10-19.der",
        "PreSignedObjects/DB/Certificates/MicCorUEFCA2011_2011-06-27.der",
        "PreSignedObjects/DB/Certificates/windows uefi ca 2023.der",
        "PreSignedObjects/DB/Certificates/microsoft uefi ca 2023.der",
        "PreSignedObjects/DB/Certificates/microsoft option rom uefi ca 2023.der"],
    dbx: ["PostSignedObjects/DBX/amd64/DBXUpdate.bin"],
};

/**
 * Microsoft's keys, from a checkout of microsoft/secureboot_objects
 * @param {string} directory
 */
export function microsoft_lists(directory)
{
    const read = file => new Uint8Array(fs.readFileSync(path.join(directory, file)));
    const certificates = files => concat(files.map(file => x509_list(read(file), MICROSOFT)));
    return {
        pk: certificates(MICROSOFT_FILES.pk),
        kek: certificates(MICROSOFT_FILES.kek),
        db: certificates(MICROSOFT_FILES.db),
        // (the signature lists of Microsoft's signed dbx update)
        dbx: update_data(read(MICROSOFT_FILES.dbx[0])).data,
    };
}

/** @param {!Array<!Uint8Array>} parts */
function concat(parts)
{
    const result = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
    let at = 0;
    for(const part of parts)
    {
        result.set(part, at);
        at += part.length;
    }
    return result;
}

if(process.argv[1] && url.pathToFileURL(process.argv[1]).href === import.meta.url)
{
    const [command, objects, template, out] = process.argv.slice(2);
    if(command !== "microsoft" || !out)
    {
        console.error("usage: node tools/uefi_vars.mjs microsoft <secureboot_objects> <template> <out>");
        process.exit(2);
    }
    const image = write_variables(new Uint8Array(fs.readFileSync(template)), secure_boot_variables(microsoft_lists(objects)));
    fs.writeFileSync(out, image);
    for(const variable of read_variables(image)) console.log(variable.name + ": " + variable.data.length + " bytes");
}
