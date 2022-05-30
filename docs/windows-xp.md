*(Most of this document also applies to Windows 2000)*

Get Windows XP Pro SP3 32-bit ISO from [here](https://archive.org/details/WinXPProSP3x86).

Use these QEMU commands to create winxp.img:
```
qemu-img create winxp.img 2G
qemu-system-x86_64 -m 512 -drive file=winxp.img,format=raw -cdrom en_windows_xp_professional_with_service_pack_3_x86_cd_vl_x14-73974.iso
```
Follow setup instructions.

*(Next step fixes `Uncaught RangeError: Maximum call stack size exceeded` in Chrome during Windows 2000/XP boot in v86)*  
After installation change computer type to "Standard PC" as described [here](http://web.archive.org/web/20220528021535/https://www.scm-pc-card.de/file/manual/FAQ/acpi_uninstallation_windows_xp_english.pdf):  
Start > RightClick "My Computer" > Manage >  
Device Manager > Computer > RightClick "ACPI Uniprocessor PC" > Properties > Driver > Update Driver... >  
No, not this time > Next > Install from a list or specific location (Advanced) > Next >  
Don't search. I will choose the driver to install. > Next > Standard PC > Next > Finish.  
Restart the VM, follow multiple "Found New Hardware Wizard" dialogs with default options.

Now winxp.img is ready for v86. Get seabios.bin and vgabios.bin from [here](https://github.com/copy/v86/tree/master/bios), get libv86.js and v86.wasm from [releases](https://github.com/copy/v86/releases/tag/latest).  
Create winxp.htm with this content (assuming all the files are in the same folder): 
```html
<!doctype html>
<script src="libv86.js"></script>

<script>
onload = function()
{
	new V86Starter({
		wasm_path: "v86.wasm",
		bios:      { url: "seabios.bin" },
		vga_bios:  { url: "vgabios.bin" },
		hda: {
			url: "winxp.img",
			size: 2 * 1024 * 1024 * 1024,
			async: true
		},
		memory_size: 512 * 1024 * 1024,
		screen_container: screen_container,
		autostart: true
	});
}
</script>

<!-- A minimal structure for the ScreenAdapter defined in browser/screen.js -->
<div id=screen_container>
	<div style="white-space: pre; font: 14px monospace"></div>
	<canvas></canvas>
</div>
```
To open this html file local http server is needed. Chrome has `--allow-file-access-from-files` command line option which allows using XHR to read local files, but it doesn't work in this case, probably because of `Range` header (`async: true`). Standard Python server `python -m SimpleHTTPServer` and Ruby server `ruby -run -e httpd` can't handle partial downloads either.  
You can use [nodejs server](https://www.npmjs.com/package/http-server) or [this python server](https://github.com/smgoller/rangehttpserver) (much slower).  
Start the server (from the same folder as winxp.htm):
```
npx http-server
```
Open http://localhost:8080/winxp.htm in the browser.

Windows XP load time (until start button becomes responsive) in Chrome on my computer:
* 3 min second time
* 4 min (first time or if cache is disabled)
* 12 min second time if Network tab in Developer Tools is open
* 17 min (first time or if cache is disabled) and Network tab in Developer Tools is open

Sometimes Windows XP hangs during boot in v86, displaying only desktop wallpaper without taskbar or desktop icons.