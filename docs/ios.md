# iPhone 4 in v86

The experimental `s5l8930` machine models the GSM iPhone 4 (`iPhone3,1`,
N90AP) with one Cortex-A8, 512 MiB of RAM, a 640 × 960 display and a
16 GB NAND layout. The supported restore is iOS 6.1.3, build 10B329.
See [the implementation plan](iphone4-plan.md) for the current acceptance
results.

## Import in the VM manager

1. Open **New virtual machine…** and choose **iPhone 4 (GSM) · iOS 6.1.3 (.ipsw)**
   in **Source**. Choose or drop your original `iPhone3,1_6.1.3_10B329_Restore.ipsw`.
2. In **Keys**, follow the link to [The Apple Wiki’s iPhone3,1 (10B329) keys page](https://theapplewiki.com/wiki/Keys:BrightonMaps_10B329_(iPhone3,1)).
   Click **Keys** in the **JSON** row, save the file, and select it in the wizard.
   The browser verifies it against your IPSW. You can also paste the full JSON
   and click **Verify keys**. Existing `v86-ios-keys` files are supported.
3. Name the machine and review its NAND settings and summary. Finish the
   import. The browser verifies the package, builds the data
   volume, and saves a NAND disk in this site's private storage. The keys
   are discarded. The NAND holds its own boot files; the original system
   volume is kept separately so data can be reset without the keys.

For graphics, build the v86 guest adapter from your own 10B329 dyld cache:

```sh
make ios-guest IPHONE4_DYLD_CACHE=/path/to/dyld_shared_cache_armv7
```

The importer reads `build/ios-guest/libv86gles.dylib` or a copy you select
in the wizard. It links the two local display daemons, Safari and Photos
to the adapter and adds the updated executables and library to the kernel's
trust cache. Safari and Photos load the copy on the read-only system
volume. Build the current adapter and import the firmware again to pick up
the application fixes on a previously imported phone.
The graphics path needs WebGPU and the `make glbridge` assets. Boot
without the graphics adapter only for serial diagnostics.
The guest clock runs at wall-clock speed (1.0×) by default, including
with graphics enabled. API callers can set `cpu_clock.rate` for diagnostics.

The browser prepares the simulated phone for offline use. It selects
10B329 lockdownd's existing local activation path and seeds the Setup
Assistant preferences on the new data volume. The original phone's
activation service, SIM and credentials are unnecessary. This changes
only the copy of the supplied firmware and retains native code signature
checks.

The console has Home, Lock, volume, Silent and Rotate controls. Esc is
Home; Command-L sends Lock when the browser delivers it to the page.
Drag for one finger, hold Option while starting a drag for two fingers,
or touch directly on a touchscreen. Settings includes the boot terminal,
initial orientation, WebGPU and NAND reset. Power off before using
**Erase All Content and Settings**. The original system stays; the
writable data volume and the suspended state are replaced.

Browser NAND is packed by written ranges. Its logical geometry is fixed;
the actual host file grows as the guest writes new ranges. Browser disk
exports contain Apple system files and are for personal backup.

## Local tools and checks

`tools/ios/ipsw.mjs` checks and extracts the supplied firmware.
`system-volume.mjs` prepares a copy of its HFSX system volume,
`data-volume.mjs` builds its matching data volume, and
`nand_build.mjs volumes` writes a raw sparse NAND image. The data volume
builder also runs without macOS utilities. With graphics, pass
`--gles-library` and the adapter path to both volume builders, then prepare
the matching kernel with `graphics-kernel.mjs`. Add `--offline` to
`system-volume.mjs` and `graphics-kernel.mjs` for the browser's offline
setup behavior; the data builder detects that prepared system.

Run `make ios-tests` without Apple files. Original kernel and system
tests in `tests/ios` take the owner's locally prepared firmware and NAND.
With a graphics-enabled system, `tests/ios/system.mjs` accepts
`--panel-power` to check two cycles of Lock and Home against the LCD
pixels.
The VM manager's `ios_dialog` browser test checks the experimental
entry, firmware rejection and fixed hardware settings.

The model does not emulate the boot ROM or iBoot, the cellular modem,
Wi-Fi, Bluetooth or the SGX hardware. Native audio control is present;
PCM output is not implemented. A NAND cold boot has displayed the
original iOS lock screen and accepted a touch swipe to SpringBoard's
home screen on the simulated LCD. The plan tracks app interactions and
guest rotation separately.
