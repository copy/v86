// @ts-check
// The VM manager's only way to the emulator (docs/vm-manager-plan.md G1):
// new V86() and its public methods and events (v86.d.ts), as build/libv86.mjs
// gives them; the page's options of a start (src/browser/vm_options.js); the
// graphics proxy's bundle.

import { V86 } from "v86";

/** app_debug.html: the library's debug build and the firmware's (its <html data-debug>) */
export const DEBUG_PAGE = document.documentElement.hasAttribute("data-debug");

/** The page is not copy.sh's: the images in images/, KolibriOS from its own builds there */
export const ON_LOCALHOST = !location.hostname.endsWith("copy.sh");

/**
 * The files' version (?<commit>, for the browser's cache): the page's #version
 * @return {string}
 */
export function query_append()
{
    const version = document.getElementById("version");
    return version ? "?" + version.textContent : "";
}

/**
 * The page's part of the options (settings_to_options's env): its builds,
 * the files' version, the graphics proxy's option, the screen
 * @param {HTMLElement} screen_container
 * @param {boolean} graphics_proxy
 * @param {(message: string) => void} on_proxy_error
 */
export function page_env(screen_container, graphics_proxy, on_proxy_error)
{
    return {
        debug: DEBUG_PAGE,
        query_append: query_append(),
        graphics_proxy: graphics_proxy && {
            "onError": error =>
            {
                console.error("Graphics proxy initialization failed", error);
                on_proxy_error("Graphics proxy failed; VGA remains available: " + error.message);
            },
        },
        screen_container,
    };
}

/**
 * The WebGPU graphics proxy's bundle (build/glbridge), loaded once
 * @return {Promise<void>}
 */
export async function load_graphics_proxy()
{
    if(!(/** @type {any} */ (navigator).gpu))
    {
        throw new Error("WebGPU is unavailable. Use a WebGPU-capable browser over HTTPS or localhost.");
    }
    if(typeof (/** @type {any} */ (window)).V86GraphicsProxy === "function") return;

    // Fetch the current revision so the bundle and shader workers use matching assets.
    const response = await fetch("build/glbridge/manifest.json", { cache: "no-store" });
    if(!response.ok) throw new Error("Graphics bundle is missing. Run make glbridge and reload.");
    const manifest = await response.json();
    await new Promise((resolve, reject) =>
    {
        const script = document.createElement("script");
        script.src = "build/glbridge/libv86-webgpu.js?v=" + encodeURIComponent(manifest["revision"]);
        script.onload = () => resolve(undefined);
        script.onerror = () =>
        {
            script.remove();
            reject(new Error("Could not load the graphics bundle. Run make glbridge and reload."));
        };
        document.head.appendChild(script);
    });
    if(typeof (/** @type {any} */ (window)).V86GraphicsProxy !== "function")
    {
        throw new Error("Graphics bundle did not initialize. Check the browser console and rebuild with make glbridge.");
    }
}

/**
 * Start the emulator with the options; null when a test records the options
 * instead (window.v86_record_options, as the old page's start_emulation)
 * @param {Object} options
 * @return {V86 | null}
 */
export function create_emulator(options)
{
    const record = /** @type {any} */ (window).v86_record_options;
    if(typeof record === "function")
    {
        record(options);
        return null;
    }
    return new V86(/** @type {any} */ (options));
}
