// @ts-check
// The Android catalog (docs/android-images-plan.md I7): systems verified on
// v64's reference (QEMU) with the files each needs, where to download them
// (the official pages: the site hosts none, the owner's 2026-10-23
// decision), their sizes and SHA-256. The wizard lists them; dropped files
// are matched to their parts by size and SHA-256. tools/android_catalog.mjs
// checks the entries against local copies or the servers.

/**
 * @typedef {{name: string, role: "device" | "gsi" | "debug_ramdisk", page: string, url: string, size: number, sha256: string,
 *     optional?: boolean}} CatalogPart
 * @typedef {{id: string, title: string, android: string, api: number, abi: string, kind: "cuttlefish" | "gsi", device: string,
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

/** @type {{version: number, entries: CatalogEntry[]}} */
export const ANDROID_CATALOG = {
    version: 1,
    entries: [
        {
            id: "android16-cuttlefish", title: "Android 16 QPR2 (Cuttlefish phone, build " + CF_BUILD + ")", android: "16 QPR2", api: 36, abi: "arm64-v8a",
            kind: "cuttlefish", device: "cf_arm64_only_phone", parts: [CF_DEVICE, CF_DEBUG_RAMDISK], gpu: "swiftshader",
            verified: "QEMU (HVF): boot_completed in 19-29 s; v64: docs/android-images-plan.md I3", license: AOSP_LICENSE,
            notes: "AOSP's own phone for virtual machines: the arm64-only phone (64-bit apps). SwiftShader draws until gfxstream (docs/gfxstream-plan.md).",
        },
        {
            id: "android16-gsi-bp4a", title: "Android 16 QPR2 GSI (BP4A.251205.006) on the Cuttlefish phone", android: "16 QPR2", api: 36, abi: "arm64-v8a",
            kind: "gsi", device: "cf_arm64_only_phone", gpu: "swiftshader",
            parts: [{ name: "aosp_arm64-exp-BP4A.251205.006-14401865-2171cf0e.zip", role: "gsi", page: GSI_PAGE,
                url: "https://dl.google.com/developers/android/baklava/images/gsi/aosp_arm64-exp-BP4A.251205.006-14401865-2171cf0e.zip", size: 905400114,
                sha256: "2171cf0ea849f8eaa399f4bad2165fab80b0fd9e98d37723a705dca6c41e49ea" }, CF_DEVICE],
            verified: "QEMU (HVF): boot_completed in 23-35 s (docs/android-images-plan.md I0.2, I5)", license: AOSP_LICENSE + "; the GSI under the terms on its release page",
            notes: "Google's Generic System Image (a user build) on Cuttlefish's vendor of the same release. 64-bit apps only: the device runs the 64-bit zygote (docs/aarch32-plan.md Q0.1).",
        },
        {
            id: "android17-gsi-cp3a", title: "Android 17 QPR1 GSI (CP3A.260905.010) on the Cuttlefish phone (Android 16 vendor)", android: "17 QPR1", api: 37,
            abi: "arm64-v8a", kind: "gsi", device: "cf_arm64_only_phone", gpu: "swiftshader",
            parts: [{ name: "aosp_arm64-exp-CP3A.260905.010-16176746-4a869a69.zip", role: "gsi", page: GSI_PAGE,
                url: "https://dl.google.com/developers/android/cinnamonbun/images/gsi/aosp_arm64-exp-CP3A.260905.010-16176746-4a869a69.zip", size: 1166864309,
                sha256: "4a869a6959a50fee15ff871ce378853ced4485f2aa456eb64dbdbf7a2c0408aa" }, CF_DEVICE],
            verified: "QEMU (HVF): boot_completed in 22 s (docs/android-images-plan.md I0.2)", license: AOSP_LICENSE + "; the GSI under the terms on its release page",
            notes: "A newer system on the Android 16 vendor (Treble). 64-bit apps only: the device runs the 64-bit zygote (docs/aarch32-plan.md Q0.1).",
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
