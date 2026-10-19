// A9's acceptance on a booted Android 16 (docs/arm64-virt-android16-plan.md
// P11), over adb, the same steps on the QEMU reference and on v86
// (tests/a64/android_boot.mjs A64_ANDROID_SCENARIO=a9):
//
// - the desktop: SELinux enforcing, no keyguard, Launcher3 resumed, a
//   screenshot of it (SurfaceFlinger composing SwiftShader's frames, P11.1);
// - the network (P11.2): Wi-Fi on Cuttlefish's VirtWifi (on the third NIC)
//   gets an address by DHCP; on v86 also DNS and an HTTP request through the
//   fetch adapter to the test's own server (http://<port>.external/), again
//   after Wi-Fi was turned off and on;
// - touch (v86): the virtio multitouch screen is a touch screen, a tap on
//   Gallery's icon opens it;
// - an app (tests/a64/apk.mjs) pushed, installed and started (am start -W);
// - a reboot (PSCI SYSTEM_RESET; the disk's writes kept): boot_completed
//   again, the app and a file in /data still there (P11.3);
// - no service restarting over and over (init's "exited 4 times").
//
// Also A10's (a10_scenario, below) and P12.1's native APK record
// (pagesize_scenario, A64_ANDROID_SCENARIO=pagesize).
import assert from "node:assert/strict";
import { createHash as create_hash } from "node:crypto";
import fs from "node:fs";
import { build_apk, build_native_lib, APK_PACKAGE } from "./apk.mjs";

const hash = bytes => create_hash("sha256").update(bytes).digest("hex");

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * A WAV for the sound step: 16-bit stereo PCM at 48 kHz, two seconds of two
 * tones in which neighbouring samples differ, then half a second of silence
 * (the last period, which a closing tinyplay may not play)
 * @return {{wav: !Buffer, tone: !Buffer}} the file, and the tone's bytes in it
 */
export function sound_wav()
{
    const rate = 48000, frames = rate * 2, silence = rate / 2;
    const data = Buffer.alloc((frames + silence) * 4);
    for(let i = 0; i < frames; i++)
    {
        data.writeInt16LE(Math.round(12000 * Math.sin(2 * Math.PI * 440 * i / rate)) + (i & 7), i * 4);
        data.writeInt16LE(Math.round(9000 * Math.sin(2 * Math.PI * 660 * i / rate)) - (i & 3), i * 4 + 2);
    }
    const header = Buffer.alloc(44);
    header.write("RIFF", 0, "latin1");
    header.writeUInt32LE(36 + data.length, 4);
    header.write("WAVEfmt ", 8, "latin1");
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(2, 22);
    header.writeUInt32LE(rate, 24);
    header.writeUInt32LE(rate * 4, 28);
    header.writeUInt16LE(4, 32);
    header.writeUInt16LE(16, 34);
    header.write("data", 36, "latin1");
    header.writeUInt32LE(data.length, 40);
    return { wav: Buffer.concat([header, data]), tone: data.subarray(0, frames * 4) };
}

/**
 * The tone in what the card played (48 kHz stereo S16, the left channel):
 * the loud part (samples beyond 1/8 of the peak), its length, its frequency
 * from its zero crossings, its peak
 * @param {!Buffer} pcm
 * @return {{bytes: number, peak: number, seconds: number, frequency: number}}
 */
export function tone_of(pcm)
{
    const frames = pcm.length >> 2;
    let peak = 0;
    for(let i = 0; i < frames; i++) peak = Math.max(peak, Math.abs(pcm.readInt16LE(i * 4)));
    const loud = Math.max(1, peak >> 3);
    let first = -1, last = -1, crossings = 0, previous = 0;
    for(let i = 0; i < frames; i++)
    {
        const v = pcm.readInt16LE(i * 4);
        if(Math.abs(v) >= loud)
        {
            if(first < 0) first = i;
            last = i;
        }
        if(first >= 0 && v !== 0)
        {
            if(previous && (v > 0) !== (previous > 0)) crossings++;
            previous = v;
        }
    }
    const seconds = first < 0 ? 0 : (last - first + 1) / 48000;
    return { bytes: pcm.length, peak, seconds: Math.round(seconds * 1000) / 1000, frequency: seconds ? Math.round(crossings / 2 / seconds) : 0 };
}

/**
 * The device's settings for the test, retried until the services answer: on
 * v86 as soon as adb answers, long before SystemUI starts.
 * - The lock screen off (locksettings set-disabled). SystemUI sets up its
 *   keyguard as showing unless the lock screen is disabled; on v86's slow
 *   first boot its SYSTEM_READY then never shows it (no SHOW: provisioning
 *   had not finished), so its mediator ignores every dismissal while the
 *   window manager keeps the keyguard's sleep token, and the home activity
 *   stays paused. QEMU's TCG boot usually shows and dismisses it in time,
 *   but not always (2026-10-19): there the console sets these while
 *   booting (tests/a64/android_boot.mjs).
 * - No window, transition or animator animations: SwiftShader draws every
 *   frame on the CPU, and on v86 Launcher3's first frames took minutes (its
 *   ReferenceQueueDaemon then timed out, ART's finalizer watchdog killed it),
 *   as test setups do (CTS turns the animations off). Blur is asked off too,
 *   unchecked: "wm disable-blur true" leaves this build's window manager
 *   reporting "Blur enabled: true".
 * - No bug reports from UWB's device errors (DeviceConfig uwb's
 *   device_error_bugreport_enabled false; the session one is not on the
 *   shell's allowlist): Cuttlefish's UWB HAL talks to the host's pica on
 *   hvc9, which neither v86 nor the reference has, so UWB's initialisation
 *   times out, and on a userdebug build UwbServiceCore then asks for a full
 *   bug report: dumpstate for minutes on v86 (every process's native
 *   stacks), Android barely moving meanwhile.
 * @param {function(string, number=): !Promise<string>} adb
 * @return {!Promise<void>}
 */
export async function prepare_device(adb, ms = 3600000)
{
    const deadline = Date.now() + ms;
    for(let output; ; await sleep(15000))
    {
        output = await adb(PREPARE_COMMAND);
        if(device_prepared(output)) return;
        assert.ok(Date.now() < deadline, "the device's settings: " + JSON.stringify(output.slice(-300)));
    }
}

/** prepare_device's command (one try; also from QEMU's console while booting) */
export const PREPARE_COMMAND = "locksettings set-disabled true >/dev/null 2>&1; " +
    "for s in window_animation_scale transition_animation_scale animator_duration_scale; do settings put global $s 0 >/dev/null 2>&1; done; " +
    "settings put global disable_window_blurs 1 >/dev/null 2>&1; wm disable-blur true >/dev/null 2>&1; " +
    "device_config put uwb device_error_bugreport_enabled false >/dev/null 2>&1; " +
    "echo L=$(locksettings get-disabled 2>&1) W=$(settings get global window_animation_scale 2>&1) " +
    "T=$(settings get global transition_animation_scale 2>&1) A=$(settings get global animator_duration_scale 2>&1) " +
    "U=$(device_config get uwb device_error_bugreport_enabled 2>&1)";

/** whether PREPARE_COMMAND's output says every setting took */
export const device_prepared = output => /L=true W=0(\.0)? T=0(\.0)? A=0(\.0)? U=false\s*$/.test(output);

/**
 * @param {{target: string, adb: function(string, number=): !Promise<string>, push: function(string, !Buffer): !Promise<void>,
 *     reboot: function(): !Promise<void>, screenshot: function(string): !Promise<?string>, touch: ?function(number, number): !Promise<void>,
 *     http: ?{port: number, token: string}, wait_reboot: function(): !Promise<void>, log: function(string)}} env
 *     adb: a shell command's output (a new connection each time, retried while adbd is away)
 * @return {!Promise<!Object>} what it found
 */
export async function a9_scenario(env)
{
    const result = {};
    const { adb, log } = env;
    const poll = async (command, test, what, ms = 600000, every = 5000) => {
        const deadline = Date.now() + ms;
        for(let output; ; await sleep(every))
        {
            output = await adb(command, 600000);
            if(test(output)) return output;
            assert.ok(Date.now() < deadline, `${what}: ${JSON.stringify(output.slice(-300))}`);
        }
    };

    // (dumpsys gives up on a service after 10 s, on stderr; a dump of the
    // activities takes longer than that on v86)
    const top_resumed = "dumpsys -t 300 activity activities 2>&1 | grep -m1 -E 'topResumedActivity|TIMEOUT'";

    // the desktop. sys.boot_completed comes before the user is unlocked: on
    // v86's first boot the receivers of PRE_BOOT_COMPLETED and BOOT_COMPLETED
    // take another ten minutes, with FallbackHome on the screen; Launcher3
    // starts after the unlock. The lock screen is off (prepare_device, on
    // v86 already since adb answered); a keyguard that shows anyway is
    // dismissed while waiting for Launcher3
    result.selinux = (await adb("getenforce")).trim();
    assert.equal(result.selinux, "Enforcing", "SELinux enforcing");
    await prepare_device(adb);
    const booted = Date.now();
    await poll("am get-started-user-state 0 2>&1", o => /RUNNING_UNLOCKED/.test(o), "user 0 unlocked", 3600000, 15000);
    result.unlock_after_boot_ms = Date.now() - booted;
    await adb("settings put global captive_portal_mode 0; settings put global stay_on_while_plugged_in 7; " +
        "settings put system screen_off_timeout 2147483647");
    result.home = (await poll("input keyevent KEYCODE_WAKEUP; wm dismiss-keyguard; " + top_resumed,
        o => /com\.android\.launcher3\//.test(o), "Launcher3 resumed", 1200000, 15000)).trim();
    await sleep(5000);
    result.screenshots = { home: await env.screenshot("home") };
    log("desktop: " + result.home);
    // what draws (ANGLE's renderer string: SwiftShader or Venus), and frame
    // times (P11.4 V4): Launcher3's all-apps list opened by a swipe up and
    // closed by Back, once (cold: its shaders and pipelines made on the way)
    // and then three times (warm), with Launcher3's frame statistics of each;
    // pictures of the list and of the desktop (the one above can be the
    // FallbackHome's, Launcher3's first frame still to come)
    result.gles = (await adb("dumpsys -t 300 SurfaceFlinger 2>&1 | grep -m1 '^GLES'")).trim();
    const frames = async cycles => {
        await adb("dumpsys gfxinfo com.android.launcher3 reset >/dev/null 2>&1");
        for(let i = 0; i < cycles; i++)
        {
            await adb("input swipe 360 1100 360 300 300");
            await sleep(5000);
            if(cycles === 1) result.screenshots.all_apps = await env.screenshot("all-apps");
            await adb("input keyevent KEYCODE_BACK");
            await sleep(5000);
        }
        // (again after 10 s when the statistics are not in it, F6: once at
        // 16K the cold ones were missing; then the start of what it said)
        let gfxinfo = "";
        for(let attempt = 0; attempt < 2 && !/Total frames rendered: \d+/.test(gfxinfo); attempt++)
        {
            if(attempt) await sleep(10000);
            gfxinfo = await adb("dumpsys -t 300 gfxinfo com.android.launcher3 2>&1", 600000);
        }
        const stat = name => +(gfxinfo.match(new RegExp(name + ": (\\d+)"))?.[1] ?? NaN);
        return { total: stat("Total frames rendered"), janky: stat("Janky frames"), p50_ms: stat("50th percentile"),
            p90_ms: stat("90th percentile"), p99_ms: stat("99th percentile"),
            ...(/Total frames rendered: \d+/.test(gfxinfo) ? {} : { gfxinfo: gfxinfo.slice(0, 1500) }) };
    };
    result.frames_cold = await frames(1);
    result.frames = await frames(3);
    result.screenshots.desktop = await env.screenshot("desktop");
    log("frames: cold " + JSON.stringify(result.frames_cold) + ", warm " + JSON.stringify(result.frames) + ", " + result.gles);

    // the network: Cuttlefish's VirtWifi (on v86, enabled from here; the reference's harness did it before adb)
    await adb("cmd wifi set-wifi-enabled enabled");
    await poll("cmd wifi status | grep -m1 -i 'wifi is enabled'", o => /enabled/i.test(o), "Wi-Fi on", 120000);
    // (on v86 DHCP on wlan0 can fail: the network is then disabled for five
    // minutes after two failures; connecting again by hand lifts that, every
    // two minutes without an address)
    const wifi_address = async what => {
        const deadline = Date.now() + 2400000;
        for(let tries = 0; ; tries++)
        {
            if(tries % 8 === 0) await adb("cmd wifi connect-network VirtWifi open");
            const output = await adb("ip -4 -o addr show wlan0 2>&1");
            if(/inet \d+\.\d+\.\d+\.\d+/.test(output)) return output.match(/inet (\S+)/)[1];
            assert.ok(Date.now() < deadline, `${what}: ${JSON.stringify(output.slice(-300))}`);
            await sleep(15000);
        }
    };
    result.wifi_address = await wifi_address("an address on wlan0");
    log("network: wlan0 " + result.wifi_address);
    if(env.http)
    {
        const host = `${env.http.port}.external`;
        const get = `printf 'GET /v86-android HTTP/1.0\\r\\nHost: ${host}\\r\\n\\r\\n' | nc -w 30 ${host} 80`;
        const fetched = await poll(get, o => o.includes(env.http.token), "HTTP through the fetch adapter", 300000, 10000);
        assert.match(fetched, /^HTTP\/1\.[01] 200/m, "HTTP 200");
        // (recovery: Wi-Fi off and on reconnects to the saved network)
        await adb("cmd wifi set-wifi-enabled disabled");
        await poll("ip -4 -o addr show wlan0 2>&1", o => !/inet \d/.test(o), "wlan0 without an address after Wi-Fi off", 120000);
        await adb("cmd wifi set-wifi-enabled enabled");
        await wifi_address("an address on wlan0 after Wi-Fi off and on");
        await poll(get, o => o.includes(env.http.token), "HTTP again after Wi-Fi off and on", 600000, 10000);
        result.http = "ok, and after Wi-Fi off and on";
        log("network: HTTP via " + host);
    }

    // touch: the virtio multitouch screen, a tap on Gallery's icon in the
    // default workspace, once Launcher3 has drawn it (its bounds from
    // uiautomator: on v86 the first frames of the workspace come minutes
    // after Launcher3 is resumed)
    if(env.touch)
    {
        const input = await adb("dumpsys -t 300 input 2>&1", 600000);
        assert.match(input, /QEMU Virtio MultiTouch[\s\S]*?DeviceType: TOUCH_SCREEN/, "the multitouch device is a touch screen");
        const node = await poll("uiautomator dump /data/local/tmp/ui.xml >/dev/null 2>&1; grep -o 'text=\"Gallery\"[^>]*bounds=\"[^\"]*\"' /data/local/tmp/ui.xml",
            o => /bounds="\[\d+,\d+\]\[\d+,\d+\]"/.test(o), "Gallery's icon on the workspace", 1800000, 15000);
        const [x1, y1, x2, y2] = node.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/).slice(1).map(Number);
        result.gallery_icon = [x1, y1, x2, y2];
        await env.touch(Math.round((x1 + x2) / 2), Math.round((y1 + y2) / 2));
        result.touch = (await poll(top_resumed, o => /gallery/i.test(o), "Gallery opened by the tap", 600000, 15000)).trim();
        await sleep(5000);
        result.screenshots.touch = await env.screenshot("touch");
        await adb("input keyevent KEYCODE_HOME");
        log("touch: " + result.touch);
    }

    // an app: pushed, installed, started
    await env.push("/data/local/tmp/v86-hello.apk", build_apk());
    result.install = (await adb("pm install -r /data/local/tmp/v86-hello.apk 2>&1", 600000)).trim();
    assert.match(result.install, /^Success/m, "pm install");
    const started = await adb(`am start -W -n ${APK_PACKAGE}/android.app.Activity 2>&1`, 600000);
    assert.match(started, /Status: ok/, "am start: " + started);
    result.app_start_ms = +started.match(/TotalTime: (\d+)/)?.[1];
    await sleep(5000);
    result.screenshots.app = await env.screenshot("app");
    log(`app: installed, started in ${result.app_start_ms} ms`);

    // a reboot: the app and a file in /data stay
    await adb("echo v86-a9 > /data/local/tmp/v86-marker; sync");
    const rebooted = Date.now();
    await env.reboot();
    await env.wait_reboot();
    await poll("getprop sys.boot_completed", o => o.trim() === "1", "boot_completed after the reboot", 7200000, 10000);
    result.second_boot_ms = Date.now() - rebooted;
    assert.equal((await adb("cat /data/local/tmp/v86-marker")).trim(), "v86-a9", "the file in /data after the reboot");
    assert.match(await adb(`pm list packages ${APK_PACKAGE}`), new RegExp(`package:${APK_PACKAGE.replace(/\./g, "\\.")}`), "the app after the reboot");
    assert.equal((await adb("getenforce")).trim(), "Enforcing", "SELinux enforcing after the reboot");
    log(`reboot: boot_completed again after ${Math.round(result.second_boot_ms / 1000)} s, the app and /data kept`);

    // no service restarting over and over (init's "exited 4 times before boot completed"),
    // and the apps that crashed or did not respond since the reboot (for the record)
    const crashing = await adb("logcat -d -b all 2>/dev/null | grep 'exited 4 times' | sort -u | head -5");
    result.crashing = crashing.trim().split("\n").filter(Boolean);
    result.dhcp_failures = +(await adb("logcat -d -b all 2>/dev/null | grep -c 'Disable counter for network VirtWifi for reason NETWORK_SELECTION_DISABLED_DHCP_FAILURE'")).trim();
    result.app_crashes = (await adb("logcat -d -b events 2>/dev/null | grep -E 'am_crash|am_anr' | cut -c1-200 | head -20")).trim().split("\n").filter(Boolean);
    result.screenshots.after_reboot = await env.screenshot("after-reboot");
    return result;
}

/**
 * A10's runs on the desktop (P12.2, P12.3; tests/a64/android_boot.mjs
 * A64_ANDROID_SCENARIO=a10, on v86 with Venus):
 * - the desktop, as A9's, with Launcher3's first frames drawn;
 * - a snapshot of it: the first run saves it (env.snapshot,
 *   A64_ANDROID_A10_SAVE) and ends there; a second run restores it into a
 *   new machine (env.restored) and goes on: a tap (the multitouch screen)
 *   that opens Gallery, and what follows;
 * - input latency (env.tap_latency): five taps on Gallery's icon, each
 *   timed on the host from the touch to the first change of the screen's
 *   middle (Gallery's starting window), then Home (Android's own latency
 *   histograms stay empty here); a tap that opens nothing leaves the
 *   stalled guest's interrupts, run queues and UI threads' stacks
 *   (stall_diagnostics);
 * - sustained frame rate (P12.3): tests/a64/android/v86frames.c's app draws
 *   OpenGL ES frames for a minute and reports its rate;
 * - a long run: monkey for 30 minutes (env.monkey_minutes) with a fixed seed, on apps that can
 *   neither turn adb off nor call out (no Settings, Dialer, browser);
 * - sound (env.sound: v86's virtio_sound, QEMU's virtio-sound-pci into a
 *   WAV): sound_wav()'s file played with tinyplay on the virtio-snd card,
 *   the bytes the device played, as the host received them, hold the tone
 *   exactly; then v86tone.c's AAudio tone through AudioFlinger and the audio
 *   HAL, its frequency and length on the host (P12.5);
 * - memory pressure: the launcher's apps started one after another until
 *   lmkd kills a process; zram swap holds what twelve apps need, so then
 *   random bytes (zram cannot compress them) fill a tmpfs file 100 MiB at a
 *   time until it does, and the file goes;
 * - system_server, surfaceflinger and zygote64 the same processes from the
 *   desktop to the end (P10.3's budget: none of them may restart), and no
 *   service restarting over and over.
 * @param {!Object} env as a9_scenario's, with snapshot: ?function(): !Promise<!Object>,
 *     steps: the steps after the desktop to take (touch, frames, sound, monkey, memory; null: all)
 * @return {!Promise<!Object>} what it found
 */
export async function a10_scenario(env)
{
    const result = { screenshots: {} };
    const { adb, log } = env;
    const step = name => !env.steps || env.steps.includes(name);
    const poll = async (command, test, what, ms = 600000, every = 5000) => {
        const deadline = Date.now() + ms;
        for(let output; ; await sleep(every))
        {
            output = await adb(command, 600000);
            if(test(output)) return output;
            assert.ok(Date.now() < deadline, `${what}: ${JSON.stringify(output.slice(-300))}`);
        }
    };
    const top_resumed = "dumpsys -t 300 activity activities 2>&1 | grep -m1 -E 'topResumedActivity|TIMEOUT'";
    const core_pids = async () => {
        const pids = {};
        // (the oldest, the lowest pid, of each name: zygote64's prespecialized app processes have its name too)
        for(const name of ["system_server", "surfaceflinger", "zygote64"]) pids[name] = (await adb(`pidof ${name} | tr ' ' '\\n' | sort -n | head -1`)).trim();
        return pids;
    };

    // the desktop, drawn
    assert.equal((await adb("getenforce")).trim(), "Enforcing", "SELinux enforcing");
    await prepare_device(adb);
    await poll("am get-started-user-state 0 2>&1", o => /RUNNING_UNLOCKED/.test(o), "user 0 unlocked", 3600000, 15000);
    await adb("settings put global captive_portal_mode 0; settings put global stay_on_while_plugged_in 7; " +
        "settings put system screen_off_timeout 2147483647");
    result.home = (await poll("input keyevent KEYCODE_WAKEUP; wm dismiss-keyguard; " + top_resumed,
        o => /com\.android\.launcher3\//.test(o), "Launcher3 resumed", 1200000, 15000)).trim();
    await poll("dumpsys -t 300 gfxinfo com.android.launcher3 2>&1 | grep 'Total frames rendered'",
        o => /Total frames rendered: [1-9]/.test(o), "Launcher3's first frames", 1800000, 15000);
    await sleep(10000);
    result.pids = await core_pids();
    result.screenshots.desktop = await env.screenshot("desktop");
    log("desktop: drawn; " + JSON.stringify(result.pids));

    // a snapshot of the desktop: saved (the first run ends there), or restored and going on.
    // (saved when Launcher3 is quiet, its frame count the same for a minute:
    // a settled desktop. The RenderThreads that once waited for ANGLE's
    // post-link tasks for good after a restore had lost a Venus ring before
    // the save, two threads' ring ids merged, fixed in 5238279c)
    if(env.snapshot)
    {
        const frames = async () => +((await adb("dumpsys -t 300 gfxinfo com.android.launcher3 2>&1 | grep 'Total frames rendered'")).match(/(\d+)/)?.[1] ?? -1);
        for(let last = -2, same = 0, deadline = Date.now() + 900000; same < 3 && Date.now() < deadline; await sleep(20000))
        {
            const now = await frames();
            same = now === last ? same + 1 : 0;
            last = now;
        }
        result.snapshot = await env.snapshot();
        log("snapshot: " + JSON.stringify(result.snapshot));
        if(result.snapshot.saved) return result;
        result.screenshots.restored = await env.screenshot("restored");
    }
    if(env.restored) result.snapshot = { restored: env.restored };
    if(env.probe) await env.probe();
    if(env.snapshot || env.restored)
    {
        assert.match(await adb(top_resumed), /com\.android\.launcher3\//, "Launcher3 after the snapshot");
    }
    if(env.touch && step("touch"))
    {
        const node = await poll("uiautomator dump /data/local/tmp/ui.xml >/dev/null 2>&1; grep -o 'text=\"Gallery\"[^>]*bounds=\"[^\"]*\"' /data/local/tmp/ui.xml",
            o => /bounds="\[\d+,\d+\]\[\d+,\d+\]"/.test(o), "Gallery's icon on the workspace", 1800000, 15000);
        const [x1, y1, x2, y2] = node.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/).slice(1).map(Number);
        const [x, y] = [Math.round((x1 + x2) / 2), Math.round((y1 + y2) / 2)];
        const home = async () => {
            await adb("input keyevent KEYCODE_HOME");
            await poll(top_resumed, o => /com\.android\.launcher3\//.test(o), "Launcher3 again", 600000, 15000);
            await sleep(10000);
        };
        await env.touch(x, y);
        try
        {
            result.touch = (await poll(top_resumed, o => /gallery/i.test(o), "Gallery opened by the tap", 600000, 15000)).trim();
        }
        catch(e)
        {
            // (the restore stall, docs/aarch64.md: what the CPUs and the UI's threads are doing)
            result.stall = await stall_diagnostics(adb, env.directory || null);
            log("stall: " + JSON.stringify(result.stall).slice(0, 30000));
            throw e;
        }
        await home();
        log("touch: " + result.touch);

        // input latency: the tap again, timed to the screen's first change
        if(env.tap_latency)
        {
            result.input_latency_ms = [];
            for(let i = 0; i < 5; i++)
            {
                result.input_latency_ms.push(await env.tap_latency(x, y));
                await poll(top_resumed, o => /gallery/i.test(o), "Gallery opened by the timed tap", 600000, 15000);
                await home();
            }
            const sorted = result.input_latency_ms.filter(ms => ms !== null).sort((a, b) => a - b);
            result.input_latency_median_ms = sorted.length ? sorted[sorted.length >> 1] : null;
            log("input latency: " + JSON.stringify(result.input_latency_ms) + ", median " + result.input_latency_median_ms + " ms");
        }
    }

    // sustained frame rate (P12.3): tests/a64/android/v86frames.c's app, a
    // minute of OpenGL ES frames on its window (ANGLE over the guest's
    // Vulkan), its own count and rate: its swaps wait for the buffers
    // SurfaceFlinger has not released, so they are the frames that reach the
    // screen (this SurfaceFlinger has no frame counter: transaction 1013 is
    // gone)
    if(step("frames"))
    {
        const lib = build_native_lib(16384, "v86frames", ["-landroid", "-llog", "-lEGL", "-lGLESv2", "-lm"]);
        await env.push("/data/local/tmp/v86-frames.apk", build_apk({ label: "v86 frames", package_name: "org.v86.frames",
            native: { name: "v86frames", lib, extract: true, zip_align: 16384 } }));
        assert.match(await adb("pm install -r /data/local/tmp/v86-frames.apk 2>&1", 600000), /^Success/m, "pm install v86-frames.apk");
        await adb("logcat -c");
        await adb("am start -W -n org.v86.frames/android.app.NativeActivity >/dev/null 2>&1", 600000);
        const line = await poll("logcat -d -s v86frames:I 2>&1 | grep -E 'V86_FRAMES (frames|error)'", o => /V86_FRAMES (frames|error)/.test(o),
            "the frame rate app's result", 1800000, 10000);
        const m = /V86_FRAMES frames=(\d+) seconds=([\d.]+) fps=([\d.]+)/.exec(line);
        result.frame_rate = { app_frames: m ? +m[1] : null, seconds: m ? +m[2] : null, fps: m ? +m[3] : null,
            renderer: (await adb("logcat -d -s v86frames:I 2>&1 | grep -o 'renderer=.*' | head -1")).trim(),
            progress: (await adb("logcat -d -s v86frames:I 2>&1 | grep -o 'progress.*'")).trim().split("\n").filter(Boolean) };
        await adb("am force-stop org.v86.frames; pm uninstall org.v86.frames >/dev/null 2>&1; input keyevent KEYCODE_HOME");
        log("frame rate: " + JSON.stringify(result.frame_rate));
        assert.ok(m, "the frame rate app ran: " + JSON.stringify(line));
    }

    // sound: tinyplay on the virtio-snd card, the PCM compared on the host
    if(env.sound && step("sound"))
    {
        const { wav, tone } = sound_wav();
        await env.push("/data/local/tmp/v86-tone.wav", wav);
        const cards = await adb("su 0 cat /proc/asound/cards");
        const card = cards.match(/^\s*(\d+)\s+\[[^\]]*\]:\s*virtio/im)?.[1];
        assert.ok(card !== undefined, "a virtio-snd card: " + JSON.stringify(cards));
        env.sound.reset();
        const played_out = await adb(`su 0 tinyplay /data/local/tmp/v86-tone.wav -D ${card} -d 0 2>&1`, 600000);
        await sleep(3000);
        const played = env.sound.played();
        const at = played.indexOf(tone.subarray(0, 4096));
        result.sound = { card: +card, tinyplay: played_out.trim().slice(-200), bytes: played.length, tone_at: at,
            sha256: hash(played.subarray(Math.max(0, at), Math.max(0, at) + tone.length)), expected: hash(tone) };
        log("sound: " + JSON.stringify(result.sound));
        // (v86's device must play every byte; QEMU's virtio-sound-pci drops
        // samples when the emulator runs slower than real time, TCG: there
        // it is recorded)
        result.sound.exact = at >= 0 && result.sound.sha256 === result.sound.expected;
        assert.ok(result.sound.exact || env.target !== "v86" && at >= 0, "the tone played, byte for byte: " + JSON.stringify(result.sound));

        // the framework's path: tests/a64/android/v86tone.c's AAudio stream
        // through AudioFlinger and the audio HAL (tinyalsa, card 0 device 0)
        // to the card; mixed at the stream's volume, so its frequency and
        // length are checked. The HAL (AHAL_StreamPrimary) skips a transfer,
        // the frames accepted but not written, whenever its writes have
        // fallen behind real time ("a workaround for the emulator
        // implementation", b/302587331): a guest slower than real time hears
        // nothing. So the HAL must open the card; the tone must arrive whole
        // unless transfers were skipped, which is recorded with the HAL's
        // offsets (its verbose log)
        const lib = build_native_lib(16384, "v86tone", ["-landroid", "-llog", "-laaudio", "-lm"]);
        await env.push("/data/local/tmp/v86-tone.apk", build_apk({ label: "v86 tone", package_name: "org.v86.tone",
            native: { name: "v86tone", lib, extract: true, zip_align: 16384 } }));
        assert.match(await adb("pm install -r /data/local/tmp/v86-tone.apk 2>&1", 600000), /^Success/m, "pm install v86-tone.apk");
        await adb("logcat -c; setprop log.tag.AHAL_StreamPrimary V");
        env.sound.reset();
        // (A64_ANDROID_SOUND_PROFILE=1: simpleperf's cpu-clock samples of
        // every CPU while the tone plays, the report in the run's directory)
        const profile = !!process.env.A64_ANDROID_SOUND_PROFILE;
        let recording = null;
        if(profile)
        {
            // (Android hardens perf events: security.perf_harden 0 lets root sample)
            await adb("su 0 setprop security.perf_harden 0; sleep 1");
            recording = adb("su 0 simpleperf record -e cpu-clock -f 1000 -a --duration 25 " +
                "-o /data/local/tmp/sound.perf 2>&1", 900000);
            await sleep(5000);
        }
        await adb("am start -W -n org.v86.tone/android.app.NativeActivity >/dev/null 2>&1", 600000);
        const line = await poll("logcat -d -s v86tone:I 2>&1 | grep -E 'V86_TONE (frames|error)'", o => /V86_TONE (frames|error)/.test(o),
            "the tone app's result", 900000, 5000);
        await sleep(3000);
        result.sound_framework = { app: line.trim().replace(/^.*V86_TONE /s, ""), ...tone_of(env.sound.played()) };
        // (for the run's directory: the HAL's log by the guest's monotonic
        // clock, and AudioFlinger's output threads' timing statistics)
        const timing = await adb("logcat -d -v monotonic 2>&1 | grep -E 'AHAL_Stream|v86tone' | cut -c1-200; " +
            "dumpsys -t 300 media.audio_flinger 2>&1 | grep -E 'Output thread|frame count|Process time|jitter|latency stats|writes|Standby|Sample rate|underrun' | cut -c1-200", 600000);
        if(env.directory) fs.writeFileSync(env.directory + "sound-timing.txt", timing);
        if(profile)
        {
            const recorded = await recording;
            const report = recorded + await adb("su 0 sh -c '" +
                "simpleperf report -i /data/local/tmp/sound.perf --sort pid,comm --percent-limit 0.3 2>&1 | head -60; " +
                "simpleperf report -i /data/local/tmp/sound.perf --sort dso,symbol --percent-limit 0.4 2>&1 | head -100; " +
                "simpleperf report -i /data/local/tmp/sound.perf --sort tid,comm --percent-limit 0.3 2>&1 | head -60'", 900000);
            if(env.directory) fs.writeFileSync(env.directory + "sound-profile.txt", report);
            log("sound profile: " + report.split("\n").slice(0, 40).join("\n"));
        }
        const hal = await adb("logcat -d 2>&1 | grep -E 'proxy_open|skipping transfer|totalOffsetUs' | cut -c1-160");
        await adb("setprop log.tag.AHAL_StreamPrimary ''; am force-stop org.v86.tone; pm uninstall org.v86.tone >/dev/null 2>&1; input keyevent KEYCODE_HOME");
        const offsets = [...hal.matchAll(/totalOffsetUs (-?\d+)/g)].map(m => +m[1]);
        result.sound_framework.hal = { opened: /proxy_open\(card:0 device:0 PCM_OUT\)/.test(hal), skipped: (hal.match(/skipping transfer/g) || []).length,
            offsets_us: offsets.length ? [offsets[0], Math.min(...offsets), offsets.at(-1)] : [] };
        log("sound through the framework: " + JSON.stringify(result.sound_framework));
        assert.ok(result.sound_framework.hal.opened, "the audio HAL opened the virtio-snd card: " + JSON.stringify(result.sound_framework));
        const whole = Math.abs(result.sound_framework.frequency - 1000) <= 20 && result.sound_framework.seconds >= 1.5;
        assert.ok(whole || result.sound_framework.hal.skipped > 0,
            "AAudio's 1 kHz tone through AudioFlinger and the HAL: " + JSON.stringify(result.sound_framework));
    }

    // a long run: 30 minutes of monkey (seed 86), crashes and ANRs ignored and counted
    if(step("monkey"))
    {
        const monkey_apps = ["com.android.launcher3", "com.android.gallery3d", "com.android.calendar", "com.android.contacts",
            "com.android.deskclock", "com.android.messaging", "com.android.documentsui"];
        const started_monkey = Date.now();
        const minutes = env.monkey_minutes || 30;
        const monkey = await adb(`timeout ${minutes * 60} monkey -s 86 --throttle 500 --pct-syskeys 0 --pct-anyevent 0 ` +
            "--ignore-crashes --ignore-timeouts --ignore-security-exceptions " + monkey_apps.map(p => "-p " + p).join(" ") +
            " -v 1000000 2>&1 | grep -c -E '^:Sending|^    // '; echo monkey-done", (minutes + 15) * 60000);
        result.monkey = { minutes: Math.round((Date.now() - started_monkey) / 60000), lines: +(monkey.match(/^(\d+)/m)?.[1] ?? 0) };
        result.monkey.crashes = (await adb("logcat -d -b events 2>/dev/null | grep -E 'am_crash|am_anr' | cut -c1-200 | tail -20")).trim().split("\n").filter(Boolean);
        await adb("input keyevent KEYCODE_HOME");
        log("long run: " + JSON.stringify(result.monkey).slice(0, 300));
    }

    // memory pressure: the launcher's apps, one after another, until lmkd kills
    if(step("memory"))
    {
        await adb("logcat -c");
        const apps = (await adb("cmd package query-activities --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER 2>&1"))
            .split("\n").map(line => line.trim()).filter(line => /^[\w.]+\/[\w.$]+$/.test(line));
        result.memory = { apps: apps.length, started: 0, kills: 0 };
        for(let round = 0; round < 3 && !result.memory.kills; round++)
        {
            for(const app of apps)
            {
                await adb(`am start -W -n ${app} >/dev/null 2>&1`, 600000);
                result.memory.started++;
                await sleep(5000);
                result.memory.kills = +(await adb("logcat -d -s lowmemorykiller 2>/dev/null | grep -c 'Kill'")).trim() || 0;
                if(result.memory.kills) break;
            }
        }
        result.memory.hog_mib = 0;
        while(!result.memory.kills && result.memory.hog_mib < 1500)
        {
            await adb("su 0 sh -c 'dd if=/dev/urandom bs=1048576 count=100 >> /dev/v86-hog 2>/dev/null'", 900000);
            result.memory.hog_mib += 100;
            await sleep(5000);
            result.memory.kills = +(await adb("logcat -d -s lowmemorykiller 2>/dev/null | grep -c 'Kill'")).trim() || 0;
        }
        result.memory.hog_bytes = +(await adb("su 0 stat -c %s /dev/v86-hog 2>/dev/null")).trim() || 0;
        await adb("su 0 rm -f /dev/v86-hog");
        result.memory.killed = (await adb("logcat -d -s lowmemorykiller 2>/dev/null | grep 'Kill' | cut -c1-200 | head -5")).trim().split("\n").filter(Boolean);
        result.memory.meminfo = (await adb("grep -E 'MemTotal|MemAvailable|SwapTotal|SwapFree' /proc/meminfo")).trim();
        await adb("input keyevent KEYCODE_HOME");
        log("memory pressure: " + JSON.stringify({ ...result.memory, killed: result.memory.killed.length }));
        assert.ok(result.memory.kills > 0, "lmkd killed a process: " + JSON.stringify(result.memory));
    }

    // the core services kept, nothing restarting over and over
    result.pids_after = await core_pids();
    assert.deepEqual(result.pids_after, result.pids, "system_server, surfaceflinger and zygote64 not restarted");
    result.crashing = (await adb("logcat -d -b all 2>/dev/null | grep 'exited 4 times' | sort -u | head -5")).trim().split("\n").filter(Boolean);
    result.screenshots.end = await env.screenshot("end");
    return result;
}

/**
 * What a stalled guest is doing (A10's restore stall, docs/aarch64.md):
 * each CPU's interrupts (timer, IPIs) over ten seconds, the scheduler's
 * run queues (a CPU idle with runnable tasks: a wakeup lost), and the native
 * stacks of SystemUI's and Launcher3's threads that are not idle in epoll;
 * every stack in directory/stall-<process>.txt
 * @param {function(string, number=): !Promise<string>} adb
 * @param {?string} directory the run's
 * @return {!Promise<!Object>}
 */
export async function stall_diagnostics(adb, directory)
{
    const interrupts = () => adb("grep -E 'CPU0|arch_timer|IPI[0-9]' /proc/interrupts");
    const first = await interrupts();
    await sleep(10000);
    const second = await interrupts();
    const sched = await adb("su 0 sh -c 'mount -t debugfs debugfs /sys/kernel/debug 2>/dev/null; cat /sys/kernel/debug/sched/debug /proc/sched_debug 2>/dev/null' | " +
        "grep -E '^cpu#|\\.nr_running|\\.curr->pid|\\.nr_switches|^ *[>RS] ' | head -200", 300000);
    const stacks = {};
    for(const name of ["com.android.systemui", "com.android.launcher3"])
    {
        const pid = (await adb(`pidof ${name}`)).trim();
        if(!pid) continue;
        const dump = await adb(`su 0 debuggerd -b ${pid} 2>&1`, 600000);
        if(directory) fs.writeFileSync(`${directory}stall-${name}.txt`, dump);
        // (the threads drawing: the main one, hwui's, ANGLE's and the Vulkan driver's)
        stacks[name] = dump.split(/\n(?=")/).filter((t, i) => i === 1 || /RenderThread|hwui|libGLESv2|libEGL|vulkan|ANGLE|angle::/i.test(t))
            .map(t => t.split("\n").slice(0, 24).join("\n"));
    }
    return { interrupts: [first.trim(), second.trim()], sched: sched.trim(), stacks };
}

/**
 * P12.1's native APK record (A64_ANDROID_SCENARIO=pagesize, on either page
 * size's materials): the kernel, the page size, /data's file system, then an
 * app per variant of tests/a64/apk.mjs's native APK (NativeActivity, its
 * library tests/a64/android/v86native.c) installed and started: the
 * library's LOAD segments aligned to 16 or 4 KiB, stored in the APK at an
 * offset aligned to 16 or 4 KiB and loaded from there
 * (extractNativeLibs=false), or extracted at install. For each: pm install's
 * answer, whether the library ran (its V86_NATIVE_LOADED line and the page
 * size it saw), what the system logged about page sizes and compatibility,
 * the window in focus (a compatibility dialog) and a screenshot. Records,
 * asserts only that the 16 KiB variant runs.
 * @param {!Object} env as a9_scenario's
 * @return {!Promise<!Object>} what it found
 */
export async function pagesize_scenario(env)
{
    const result = { screenshots: {} };
    const { adb, log } = env;
    result.kernel = (await adb("uname -r")).trim();
    result.page_size = +(await adb("getconf PAGE_SIZE")).trim();
    result.data = (await adb("mount | grep ' /data '")).trim().split(" ").slice(0, 5).join(" ");
    await prepare_device(adb);
    for(let deadline = Date.now() + 3600000; !/RUNNING_UNLOCKED/.test(await adb("am get-started-user-state 0 2>&1")); await sleep(15000))
    {
        assert.ok(Date.now() < deadline, "user 0 unlocked");
    }
    await adb("input keyevent KEYCODE_WAKEUP; wm dismiss-keyguard; settings put system screen_off_timeout 2147483647");
    log(`kernel ${result.kernel}, page size ${result.page_size}, /data ${result.data}`);
    const variants = [
        { name: "elf16-zip16", align: 16384, extract: false, zip_align: 16384 },
        { name: "elf16-zip4", align: 16384, extract: false, zip_align: 4096 },
        { name: "elf4-zip4", align: 4096, extract: false, zip_align: 4096 },
        { name: "elf4-extracted", align: 4096, extract: true, zip_align: 4096 },
    ];
    for(const v of variants)
    {
        const pkg = "org.v86.native." + v.name.replace(/-/g, "_");
        const apk = build_apk({ label: "v86 " + v.name, package_name: pkg, native: { lib: build_native_lib(v.align), extract: v.extract, zip_align: v.zip_align } });
        await env.push(`/data/local/tmp/${v.name}.apk`, apk);
        const r = { install: (await adb(`pm install -r /data/local/tmp/${v.name}.apk 2>&1`, 600000)).trim() };
        if(/^Success/m.test(r.install))
        {
            await adb("logcat -c");
            r.start = (await adb(`am start -W -n ${pkg}/android.app.NativeActivity 2>&1`, 600000)).trim();
            await sleep(10000);
            r.loaded = (await adb("logcat -d -s v86native:I 2>&1 | grep -o 'V86_NATIVE_LOADED.*'")).trim();
            r.log = (await adb(`logcat -d 2>&1 | grep -iE '16 ?KB|page.?size|linker|nativeloader|${pkg}' | grep -vE 'V86_NATIVE_LOADED|AppCompat|Transition' | tail -12`)).trim().split("\n");
            r.focus = (await adb("dumpsys window 2>&1 | grep -m1 mCurrentFocus")).trim();
            r.warning = (await adb("logcat -d 2>&1 | grep -o 'AppWarnings.*'")).trim();
            r.crash = (await adb(`logcat -d -b crash 2>&1 | grep -A4 'Process: ${pkg}' | cut -c1-200`)).trim().split("\n").filter(Boolean);
            // (a dialog's text, such as the page size compatibility one)
            if(/Window\{\w+ u0 android\}/.test(r.focus))
            {
                r.dialog = (await adb("uiautomator dump /data/local/tmp/ui.xml >/dev/null 2>&1; grep -o 'text=\"[^\"]*\"' /data/local/tmp/ui.xml", 600000))
                    .trim().split("\n").map(t => t.slice(6, -1)).filter(Boolean);
            }
            result.screenshots[v.name] = await env.screenshot("native-" + v.name);
            await adb(`am force-stop ${pkg}; pm uninstall ${pkg} >/dev/null 2>&1; input keyevent KEYCODE_BACK; input keyevent KEYCODE_HOME`);
        }
        result[v.name] = r;
        log(`${v.name}: ${JSON.stringify(r).slice(0, 1500)}`);
    }
    assert.match(result["elf16-zip16"].loaded || "", new RegExp(`page_size=${result.page_size}`), "the 16 KiB aligned library runs");
    return result;
}
