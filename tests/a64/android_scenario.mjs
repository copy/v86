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
import assert from "node:assert/strict";
import { build_apk, APK_PACKAGE } from "./apk.mjs";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * The device's settings for the test, retried until the services answer: on
 * v86 as soon as adb answers, long before SystemUI starts.
 * - The lock screen off (locksettings set-disabled). SystemUI sets up its
 *   keyguard as showing unless the lock screen is disabled; on v86's slow
 *   first boot its SYSTEM_READY then never shows it (no SHOW: provisioning
 *   had not finished), so its mediator ignores every dismissal while the
 *   window manager keeps the keyguard's sleep token, and the home activity
 *   stays paused. QEMU's boot is fast enough to show and dismiss it.
 * - No window, transition or animator animations: SwiftShader draws every
 *   frame on the CPU, and on v86 Launcher3's first frames took minutes (its
 *   ReferenceQueueDaemon then timed out, ART's finalizer watchdog killed it),
 *   as test setups do (CTS turns the animations off). Blur is asked off too,
 *   unchecked: "wm disable-blur true" leaves this build's window manager
 *   reporting "Blur enabled: true".
 * @param {function(string, number=): !Promise<string>} adb
 * @return {!Promise<void>}
 */
export async function prepare_device(adb, ms = 3600000)
{
    const deadline = Date.now() + ms;
    const command = "locksettings set-disabled true >/dev/null 2>&1; " +
        "for s in window_animation_scale transition_animation_scale animator_duration_scale; do settings put global $s 0 >/dev/null 2>&1; done; " +
        "settings put global disable_window_blurs 1 >/dev/null 2>&1; wm disable-blur true >/dev/null 2>&1; " +
        "echo L=$(locksettings get-disabled 2>&1) W=$(settings get global window_animation_scale 2>&1) " +
        "T=$(settings get global transition_animation_scale 2>&1) A=$(settings get global animator_duration_scale 2>&1)";
    for(let output; ; await sleep(15000))
    {
        output = await adb(command);
        if(/L=true W=0(\.0)? T=0(\.0)? A=0(\.0)?\s*$/.test(output)) return;
        assert.ok(Date.now() < deadline, "the device's settings: " + JSON.stringify(output.slice(-300)));
    }
}

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
