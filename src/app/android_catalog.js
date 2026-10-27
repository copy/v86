// @ts-check
// The Android catalog (docs/android-images-plan.md I7): systems verified on
// v64 or its reference (QEMU) with the files each needs, where to download them
// (the official pages: the site hosts none, the owner's 2026-10-23
// decision), their sizes and SHA-256. The wizard lists them; dropped files
// are matched to their parts by size and SHA-256. tools/android_catalog.mjs
// checks the entries against local copies or the servers.

/**
 * @typedef {{name: string, role: "device" | "gsi" | "debug_ramdisk", page: string, url: string, size: number, sha256: string,
 *     optional?: boolean}} CatalogPart
 * @typedef {{id: string, title: string, android: string, api: number, abi: string, kind: "cuttlefish" | "gsi" | "emulator", device: string,
 *     parts: CatalogPart[], gpu: string, verified: string, license: string, notes: string}} CatalogEntry
 */

const CF_BUILD = "15581820";
const CF_PAGE = `https://ci.android.com/builds/submitted/${CF_BUILD}/aosp_cf_arm64_only_phone-userdebug/latest`;
const GSI_PAGE = "https://developer.android.com/topic/generic-system-image/releases";

/** @type {CatalogPart} the Cuttlefish arm64-only phone's images */
const CF_DEVICE = { name: `aosp_cf_arm64_only_phone-img-${CF_BUILD}.zip`, role: "device", page: CF_PAGE,
    url: CF_PAGE + `/raw/aosp_cf_arm64_only_phone-img-${CF_BUILD}.zip`, size: 1046288463,
    sha256: "d56b75f00cd4a0005d54175fdf9bafb48c4b4f8c1a20ee4ac062b019080ef506" };
/** @type {CatalogPart} its debug vendor ramdisk (the settings' Vendor ramdisk: debug) */
const CF_DEBUG_RAMDISK = { name: "vendor_ramdisk-debug.img", role: "debug_ramdisk", page: CF_PAGE, url: CF_PAGE + "/raw/vendor_ramdisk-debug.img",
    size: 18797343, sha256: "b9a00cd701d93acdb7fe3787d6674741e5373e0137777e0b3b68e5812ba65665", optional: true };

const AOSP_LICENSE = "Android Open Source Project builds (Apache 2.0 and the licenses of their parts: the build's NOTICE)";

const SDK_REPOSITORY = "https://dl.google.com/android/repository/sys-img/google_apis/";
const SDK_PAGE = "https://developer.android.com/studio/run/managing-avds";

/**
 * One entry per Android version that boots on v64, newest first (the
 * owner's 2026-10-27 choice: no list of every release). A GSI runs only on
 * a vendor of its Android version or older, and v64's one device is the
 * Android 16 Cuttlefish phone; Android 8.0 to 15 have no image that boots
 * here (their emulator images draw only through the emulator's host GLES,
 * docs/android-images-plan.md I6.3), Android 1 to 6 none either (the old
 * goldfish board).
 * @type {{version: number, entries: CatalogEntry[], default_entry: string}}
 */
export const ANDROID_CATALOG = {
    version: 2,
    default_entry: "android16-cuttlefish",
    entries: [
        {
            id: "android17-gsi-cp3a", title: "Android 17", android: "17 QPR1", api: 37,
            abi: "arm64-v8a", kind: "gsi", device: "cf_arm64_only_phone", gpu: "swiftshader",
            parts: [{ name: "aosp_arm64-exp-CP3A.260905.010-16176746-4a869a69.zip", role: "gsi", page: GSI_PAGE,
                url: "https://dl.google.com/developers/android/cinnamonbun/images/gsi/aosp_arm64-exp-CP3A.260905.010-16176746-4a869a69.zip", size: 1166864309,
                sha256: "4a869a6959a50fee15ff871ce378853ced4485f2aa456eb64dbdbf7a2c0408aa" }, CF_DEVICE],
            verified: "QEMU (HVF): boot_completed in 22 s (docs/android-images-plan.md I0.2)", license: AOSP_LICENSE + "; the GSI under the terms on its release page",
            notes: "Google's Generic System Image (QPR1, CP3A.260905.010) on the Android 16 phone: both files. 64-bit apps.",
        },
        {
            id: "android16-cuttlefish", title: "Android 16", android: "16 QPR2", api: 36, abi: "arm64-v8a",
            kind: "cuttlefish", device: "cf_arm64_only_phone", parts: [CF_DEVICE, CF_DEBUG_RAMDISK], gpu: "swiftshader",
            verified: "QEMU (HVF): boot_completed in 19-29 s; v64: docs/android-images-plan.md I3", license: AOSP_LICENSE,
            notes: "AOSP's phone for virtual machines (QPR2, build " + CF_BUILD + "). 64-bit apps.",
        },
        {
            id: "android7-emulator", title: "Android 7.1 (32-bit)", android: "7.1.1", api: 25, abi: "armeabi-v7a",
            kind: "emulator", device: "ranchu_25_armeabi_v7a", gpu: "guest",
            parts: [{ name: "armeabi-v7a-25_r18.zip", role: "device", page: SDK_PAGE, url: SDK_REPOSITORY + "armeabi-v7a-25_r18.zip",
                size: 952973150, sha256: "0e888e3141ec4bf55494cbbb268e91fab60de7bf5163f85a40a4bab7e31032ff" }],
            verified: "v64: boot_completed (docs/aarch32-plan.md R7.1)", license: "Android SDK system image (Google APIs): the Android SDK License Agreement",
            notes: "The Android Emulator's system image (Google APIs). The guest draws with the CPU.",
        },
    ],
};

/**
 * The catalog's part a file is, by its size and SHA-256 (the hash only
 * when a size matches)
 * @param {{size: number}} file
 * @param {string} [sha256] the file's, when known
 * @return {CatalogPart[]} the parts of that size (and hash, given one)
 */
export function catalog_parts_of(file, sha256)
{
    const parts = ANDROID_CATALOG.entries.flatMap(e => e.parts).filter(p => p.size === file.size && (!sha256 || p.sha256 === sha256));
    return parts.filter((p, i) => parts.findIndex(q => q.sha256 === p.sha256) === i);
}
