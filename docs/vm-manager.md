# The virtual machine manager

`index.html` is a virtual machine manager in the manner of VMware
Workstation: a library of virtual machines kept in the browser, a wizard
that makes new ones, a settings dialog for their hardware, and a console
that runs one machine per tab. The plan and its implementation record are
in [vm-manager-plan.md](vm-manager-plan.md) (in Chinese).

## The library

The page without arguments shows the library: the machines on the left
(powered off, suspended, or running in another tab), the chosen one's
hardware on the right, with its buttons: power on (or resume), edit
settings, rename, export, delete.

- **New virtual machine…** opens the wizard: where the system comes from (a
  CD or floppy image, an installed hard disk image, a kernel and initrd, or
  later), the system (a preset: DOS, Windows 3.x to 8.1, Linux 32-bit,
  x86_64 and arm64, Android 16, or other), the name, the hard disk, and a
  summary. A preset sets all the hardware; it says whether that setting was
  verified, how the system is installed, the steps after the installation
  and its known problems. "Customize hardware…" opens the settings dialog
  before the machine is made.
- **Edit settings…** opens the settings dialog: the hardware list (memory,
  processor, machine and firmware, hard disks, CD/DVD, floppies, network
  adapters, sound, display, serial ports, shared folder, direct boot, the
  virt machine's devices, advanced) with Add and Remove. A control offers
  only what the machine allows; when one change implies others (the arm64
  CPU makes the machine virt, a second core needs ACPI, more than 2048 MB
  needs x86_64), the dialog makes them and says so. Before saving, the
  whole configuration is checked, and each problem shows on its item.
- **Import…** and **Export** read and write `.v86vm.json` files. Files on
  your computer are not part of an export: the console asks for them.
- **Preferences…** sets the disk service (below). **Browser disks…** lists
  the disks kept in the browser, their sizes and machines; export, delete,
  import and make them there.

The library lives in the browser's storage for this site (IndexedDB and the
origin private file system). Clearing the site's data deletes it: export
the machines and disks you want to keep.

## Disks

A hard disk's image is one of:

| Source | Kept | Written back (`read_write`) |
| --- | --- | --- |
| An image on the web (URL) | on the web | no: the guest's changes stay in memory |
| A file on this computer | on your computer | no (a browser cannot write into a file you picked): use the disk service |
| An empty disk in memory | until power off | no |
| A browser disk | in this browser, until its site data is cleared | yes |
| An image of the disk service | in the service's directory | yes |

**Read only** keeps the guest's changes in memory and leaves the image as it
was; **read write** writes them into the image (docs/disk-persistence-plan.md).
A browser disk takes its whole size of the browser's storage for this site
at once; written back, it needs the CPU in its Worker (the default).

The disk service, `node tools/disk-service.mjs --dir <directory> --origin
<page origin> [--allow-create]`, serves the images of a directory on
`http://127.0.0.1:8471/`; `make run` starts one for `images/` that may
create new images. The manager looks for it when the page is served from
this computer, or uses the one set in Preferences.

## The console

Power on opens the machine's console in a new tab (`index.html?vm=<id>`);
a machine runs in one tab at a time. Its menus: Power (pause, reset, power
off, suspend, save and power off for disks written back, save a state to a
file, load one), Keys (Ctrl+Alt+Del and other combinations), Devices (CD
and floppies in and out, the disks' images), View (full screen, zoom to
fit, scales, theatre mode, screenshot), Input (the mouse), Tools
(memory dump, network capture), and Mute. The
status bar shows the time, speed, disk and network traffic, the display
mode and the mouse; the drawers hold the serial terminal, the shared
folder's files and the details. A disk that fails with `disk_error: "stop"`
pauses the machine and asks: retry, or power off.

**Suspend** saves the machine's state in the browser; it resumes the next
time it is powered on (if its settings changed since, the console asks
first). Leaving a page with a disk written back asks first.

## Addresses

`index.html?profile=<id>` (the systems of the old page's list) and the old
page's query arguments (`?profile=custom&hda.url=…`, `m=`, `cpu_type=`, …)
open a console directly, with the options the old page gave them. Such a
session is not in the library.

## Development

- The page is ES modules in `src/app/`, outside the Closure build, driving
  only the public API of `build/libv86.mjs` (`v86.d.ts`); it shares
  `src/browser/profiles.js`, `vm_options.js` and `query_compat.js` with the
  debug page (`debug.html`, `src/browser/main.js`).
- `make app` bundles it into `build/v86_app.js` (esbuild); `make app-check`
  type-checks it with tsc against `v86.d.ts`. Both tools are dev
  dependencies (`npm ci`, which make runs when they are missing).
- `app_debug.html` loads the source directly, with `build/libv86-debug.mjs`.
- `make app-tests` runs its tests (Node and headless Chrome).

## Deployment

`make pages` builds the page and every file it loads into `build/pages/`, a
static site ([tools/pages_dist.mjs](../tools/pages_dist.mjs)): the files keep
the paths the page uses, their version (the query the page adds to them) is a
hash of the files, the footer's links to the debug pages are left out,
`_headers` makes the site cross-origin isolated (COOP/COEP, as
`tools/dev-server.py`), which the cores in host threads need, and `404.html`
makes a missing file a 404 (without it Cloudflare Pages answers any path with
`index.html`, and a wrong image URL would become a disk of HTML). Any static
host that sends those two headers can serve it.

The systems of `?profile=` addresses take their images from `images/` on any
host but copy.sh, and `images/` is not deployed (i.copy.sh does not serve other
sites): there they fail with "could not be loaded (HTTP 404)" unless their
images are deployed too, or `?cdn=<host>/` names a host that has them. The
library does not need them.

[.github/workflows/pages.yml](../.github/workflows/pages.yml) deploys it to
Cloudflare Pages, project `v64` (`https://v64-2ys.pages.dev`): a push to
master deploys the site, a pull request from this repository a preview of its
branch (`https://<branch>.v64-2ys.pages.dev`).
It builds on GitHub (Cloudflare's build environment lacks the Rust wasm target
and Java) and uploads with wrangler, so the Pages project is a Direct Upload
project. Once, in Cloudflare and GitHub:

1. Create the project: `npx wrangler pages project create v64 --production-branch master`
   (or Workers & Pages → Create → Pages → Upload assets, named `v64`).
2. Create an API token with the permission "Cloudflare Pages: Edit", and note the
   account ID.
3. Add them to the repository as the Actions secrets `CLOUDFLARE_API_TOKEN` and
   `CLOUDFLARE_ACCOUNT_ID`.

A custom domain is set in the project's Custom domains. Settle it before the
site is used: the library, its suspended machines and its browser disks live
in the browser's storage for the site's origin, so a machine made on
`v64.pages.dev` is not there on another domain.

Browsers: the browser disks' synchronous file access exists in Chromium 108,
Firefox 111 and Safari 15.2 or later (MDN, caniuse); only Chrome was tried.
