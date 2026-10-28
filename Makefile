CLOSURE_DIR=closure-compiler
CLOSURE=$(CLOSURE_DIR)/compiler.jar
NASM_TEST_DIR=./tests/nasm

INSTRUCTION_TABLES=src/rust/gen/interpreter.rs src/rust/gen/interpreter0f.rs src/rust/gen/interpreter0f38.rs src/rust/gen/interpreter0f3a.rs

# Only the dependencies common to the generators
GEN_DEPENDENCIES=$(filter-out gen/generate_interpreter.js gen/generate_decoder.js gen/state_layout.js, $(wildcard gen/*.js))
INTERPRETER_DEPENDENCIES=$(GEN_DEPENDENCIES) gen/generate_interpreter.js

STRIP_DEBUG_FLAG=
ifeq ($(STRIP_DEBUG),true)
STRIP_DEBUG_FLAG=--v86-strip-debug
endif

WASM_OPT ?= false

default: build/v86-debug.wasm
# (v86-parallel.wasm and vcpu-worker.js: index.html runs more than one core in
# host threads with them where the page allows it; see `make parallel`)
all: build/cpu-worker.js build/v86_app.js build/libv86.js build/libv86.mjs build/v86.wasm build/v86-parallel.wasm build/vcpu-worker.js glbridge
all-debug: build/cpu-worker.js build/libv86-debug.js build/libv86-debug.mjs build/v86-debug.wasm glbridge
browser: build/cpu-worker.js build/v86_app.js

# CPU benchmark suite (tests/bench): one IR core against another, see docs/cpu-benchmarks.md.
.PHONY: bench-build bench bench-quick bench-same-source replay-check replay-record
bench-build:
	node tools/bench/build.mjs

bench: bench-build build/v86.wasm build/libv86.mjs
	node tests/bench/run.mjs $(BENCH_ARGS)

bench-quick: bench-build build/v86.wasm build/libv86.mjs
	node tests/bench/run.mjs --quick $(BENCH_ARGS)

# The same C sources as i686 code on Tier-0 and as x86-64 code on the x64
# page tier, alternating in one session, then the S gate
# (docs/jit-unification-plan.md P0.4, cross-phase rule 2)
bench-same-source: bench-build build/v86.wasm build/libv86.mjs
	node tests/bench/run.mjs --same-source --quick --out build/bench/same-source.json $(BENCH_ARGS)
	node tests/bench/gate.mjs --level S build/bench/same-source.json

# What .github/workflows/ci.yml runs besides eslint and the builds: the
# checks that need no disk images (the guest tests read images/, which this
# repository does not distribute: run them locally) and take minutes, not
# hours (the SIMD suites, avx-tests and the like, stay with the release gate,
# tools/release_gate.mjs)
.PHONY: ci-tests
ci-tests: rust-test test-glbridge app-check platform-contract-tests ios-tests gles-tests \
	acpi-device-tests q35-device-tests jit-switch-tests \
	cpu-optimization-tests flags-provenance-tests cpu-plan-tests jit-tiers-tests jit-disabled-tests mmx-fast-tests \
	softfloat-fast-tests x87-fast-math-tests x87-fast-tests x87-jit-cache-tests \
	build/v86-debug.wasm build/libv86.mjs build/v86.wasm build/jit-capacity.bin
	node tests/rust/bmi.mjs
	node tests/rust/fma.mjs
	node tests/rust/cvtpi2ps_x87.mjs
	node tests/app/vm_config.mjs
	node tests/app/presets.mjs
	node tests/app/machine_rules.mjs
	node tests/android/library.mjs
	TEST_RELEASE_BUILD=1 ./tests/uefi/shell.mjs
	TEST_RELEASE_BUILD=1 ./tests/tpm/tpm.mjs
	./tests/api/disk-options.js
	./tests/api/sb16-state.js
	./tests/api/sb16-dma.js
	./tests/devices/disk_error.mjs
	./tests/devices/default_cards.js
	TEST_RELEASE_BUILD=1 ./tests/devices/default_cards.js
	./tests/devices/e1000.js
	./tests/devices/hd_audio.js
	./tests/devices/usb.js
	./tests/devices/usb_storage.js
	./tests/devices/usb_ehci.js
	./tests/devices/usb_xhci.js
	./tests/persistence/response_version.mjs
	./tests/persistence/node_file.mjs
	./tests/persistence/disk_service.mjs
	./tests/persistence/disk_service_sync.mjs

.PHONY: glbridge test-glbridge
glbridge:
	node tools/build_glbridge.mjs

test-glbridge:
	node tests/glbridge/run.cjs

# Used for nodejs builds and in order to profile code.
# `debug` gives identifiers a readable name, make sure it doesn't have any side effects.
CLOSURE_READABLE=--formatting PRETTY_PRINT --debug

CLOSURE_SOURCE_MAP=\
		--source_map_format V3\
		--create_source_map '%outname%.map'

CLOSURE_FLAGS=\
		--generate_exports\
		--externs src/externs.js\
		--warning_level VERBOSE\
		--jscomp_error accessControls\
		--jscomp_error checkRegExp\
		--jscomp_error checkTypes\
		--jscomp_error checkVars\
		--jscomp_error conformanceViolations\
		--jscomp_error const\
		--jscomp_error constantProperty\
		--jscomp_error deprecated\
		--jscomp_error deprecatedAnnotations\
		--jscomp_error duplicateMessage\
		--jscomp_error es5Strict\
		--jscomp_error externsValidation\
		--jscomp_error globalThis\
		--jscomp_error invalidCasts\
		--jscomp_error misplacedTypeAnnotation\
		--jscomp_error missingProperties\
		--jscomp_error missingReturn\
		--jscomp_error msgDescriptions\
		--jscomp_error nonStandardJsDocs\
		--jscomp_error suspiciousCode\
		--jscomp_error strictModuleDepCheck\
		--jscomp_error typeInvalidation\
		--jscomp_error undefinedVars\
		--jscomp_error unknownDefines\
		--jscomp_error visibility\
		--use_types_for_optimization\
		--assume_function_wrapper\
		--summary_detail_level 3\
		--language_in ECMASCRIPT_2020\
		--language_out ECMASCRIPT_2020

CARGO_FLAGS_SAFE=\
		--target wasm32-unknown-unknown \
		-- \
		-C linker=tools/rust-lld-wrapper \
		-C link-args="--import-table --global-base=4096 $(STRIP_DEBUG_FLAG)" \
		-C link-args="build/softfloat.o" \
		-C link-args="build/zstddeclib.o" \
		--verbose

CARGO_FLAGS=$(CARGO_FLAGS_SAFE) -C target-feature=+bulk-memory -C target-feature=+multivalue -C target-feature=+simd128

# Host-parallel build (docs/multicore.md): atomics in v86's own code (the prebuilt std stays
# single-threaded, each vCPU worker has a private relocated copy of it), the
# memory imported and later marked shared by tools/parallel_wasm.mjs. Linked
# at 32 KiB (the later --global-base wins): below it are the CPU state blocks
# of the machine and of up to 7 vCPU workers (src/parallel/relocate.js).
# __heap_base and __data_end are exported explicitly: the relocation needs
# them, and newer Rust toolchains no longer export them by default
CARGO_FLAGS_PARALLEL=$(CARGO_FLAGS) -C target-feature=+atomics \
		-C link-args="--import-memory --export-memory --emit-relocs --no-check-features --max-memory=4294967296 --global-base=32768 --export=__heap_base --export=__data_end"

CORE_FILES=cjs.js const.js io.js machine_clock.js machine_options.js main.js lib.js buffer.js ide.js pci.js floppy.js \
	   dma.js pit.js display.js device_plugin.js graphics_adapter.js ps2.js rtc.js uart.js parallel.js vmware.js \
	   acpi.js acpi_tables.js smbios.js pflash.js tpm/store.js platform.js q35.js ahci.js pcie_root_port.js hpet.js smbus.js ich9_tco.js state_layout.js cpu_features.js jit_switches.js iso9660.js \
	   state.js state_io.js block_backend.js disk_options.js disk_writeback.js disk_service.js opfs_disk.js mac_address.js virtio.js virtio_console.js virtio_net.js virtio_balloon.js \
	   virtio_mmio.js virtio_blk.js virtio_rng.js virtio_input.js virtio_vsock.js virtio_snd.js \
	   virtio_devices.js \
	   bus.js log.js cpu.js \
	   elf.js kernel.js extended_memory.js \
	   parallel/relocate.js parallel/control.js parallel/machine.js \
	   arm/state_layout.js arm/cpu.js arm/backdoor_a32.js virt/platform.js virt/io.js virt/pl011.js virt/pl031.js virt/inflate.js virt/dtb.js virt/ranchu.js virt/goldfish.js virt/loader.js \
	   android/bytes.js android/gpt.js android/avb.js android/bootimg.js android/bootconfig.js android/devices.js android/boot.js android/bootloader.js android/partition_buffer.js android/cpio.js android/ramdisk_overlay.js \
	   image/sha256.js image/source.js image/overlay.js image/disk_image.js image/qcow2.js image/vhd.js image/vdi.js image/vmdk.js image/vhdx.js image/ova.js image/factory.js image/export.js image/qcow2_export.js
LIB_FILES=9p.js filesystem.js marshall.js
BROWSER_FILES=screen.js keyboard.js mouse.js speaker.js serial.js \
	      network.js starter.js wasm_paths.js worker_bus.js state_stream_transport.js cpu_worker.js dummy_screen.js ansi_screen.js \
	      inbrowser_network.js fake_network.js wisp_network.js fetch_network.js \
          print_stats.js filestorage.js modem.js

# Display adapter plugins (src/graphics_adapter.js): each its own file, loaded
# when graphics_adapter names it. Built with every bundle, which looks for
# them beside itself. The boundary to v86 uses quoted names only, so a plugin
# works with any bundle, also one compiled in Closure's ADVANCED mode.
GRAPHICS_ADAPTER_PLUGINS=build/v86-bochs-vga.js build/v86-vmware-svga.js build/v86-virtio-gpu.js
GRAPHICS_ADAPTER_COMMON=src/cjs.js src/const.js src/lib.js src/log.js src/bus.js src/display.js \
	src/device_machine.js src/graphics_adapters/machine.js src/graphics_adapters/vga_core.js src/graphics_adapters/renderer_protocol.js

# Network card plugins (src/device_plugin.js, net_device.type): the same,
# loaded when net_device.type names one (the NE2000 when it names none)
NET_ADAPTER_PLUGINS=build/v86-ne2k.js build/v86-e1000.js
NET_ADAPTER_COMMON=src/cjs.js src/const.js src/lib.js src/log.js src/mac_address.js \
	src/device_machine.js src/net_adapters/machine.js src/net_adapters/offload.js
# Sound card plugins (audio_device), likewise (the SB16 when it names none)
AUDIO_DEVICE_PLUGINS=build/v86-sb16.js build/v86-hd-audio.js
AUDIO_DEVICE_COMMON=src/cjs.js src/const.js src/lib.js src/log.js src/device_machine.js src/audio_devices/machine.js
# USB's plugin (usb: its controllers and devices), likewise
USB_PLUGINS=build/v86-usb.js
USB_COMMON=src/cjs.js src/const.js src/lib.js src/log.js src/device_machine.js
# the TPM's (tpm: docs/tpm.md), with its module (bios/libtpms.wasm, tools/libtpms/build.sh) beside it
TPM_PLUGINS=build/v86-tpm.js build/libtpms.wasm
# the ranchu machine's GLES host (ranchu_gpu "host": docs/gles-proxy-plan.md)
# the GLES host's, with its GLSL ES compiler (bios/glslang.wasm, tools/glslang/build.sh) beside it
GLES_PLUGINS=build/v86-gles.js build/glslang.wasm
DEVICE_PLUGINS=$(GRAPHICS_ADAPTER_PLUGINS) $(NET_ADAPTER_PLUGINS) $(AUDIO_DEVICE_PLUGINS) $(USB_PLUGINS) $(TPM_PLUGINS) $(GLES_PLUGINS)

RUST_FILES=$(shell find src/rust/ -name '*.rs') \
	   src/rust/gen/interpreter.rs src/rust/gen/interpreter0f.rs src/rust/gen/interpreter0f38.rs src/rust/gen/interpreter0f3a.rs \
	   build/jit-defaults

# Build-time defaults of the JIT switches (src/rust/jit_switches.rs), for A/B
# builds: JIT_DEFAULTS="x64_outline=0,x64_block_count=0" make build/v86.wasm. The
# stamp changes with the value, which rebuilds the Wasm modules.
export JIT_DEFAULTS
build/jit-defaults: FORCE
	@mkdir -p build
	@if [ ! -e $@ ] || [ "$$(cat $@)" != "$(JIT_DEFAULTS)" ]; then printf '%s' "$(JIT_DEFAULTS)" > $@; fi

.PHONY: FORCE
FORCE:

CORE_FILES:=$(addprefix src/,$(CORE_FILES))
LIB_FILES:=$(addprefix lib/,$(LIB_FILES))
BROWSER_FILES:=$(addprefix src/browser/,$(BROWSER_FILES))

build/v86-bochs-vga.js: $(CLOSURE) src/*.js src/graphics_adapters/*.js src/graphics_adapters/bochs_vga/*.js
	mkdir -p build
	java -jar $(CLOSURE) --js_output_file $@ --define=DEBUG=false $(CLOSURE_FLAGS) \
		--compilation_level SIMPLE --jscomp_off=missingProperties \
		--output_wrapper ';(function(){%output%}).call(this);' \
		--js $(GRAPHICS_ADAPTER_COMMON) --js src/graphics_adapters/bochs_vga/plugin.js

build/v86-vmware-svga.js: $(CLOSURE) src/*.js src/graphics_adapters/*.js src/graphics_adapters/vmware_svga/*.js
	mkdir -p build
	java -jar $(CLOSURE) --js_output_file $@ --define=DEBUG=false $(CLOSURE_FLAGS) \
		--compilation_level SIMPLE --jscomp_off=missingProperties \
		--output_wrapper ';(function(){%output%}).call(this);' \
		--js $(GRAPHICS_ADAPTER_COMMON) --js src/graphics_adapters/vmware_svga/svga_constants.js \
		--js src/graphics_adapters/vmware_svga/svga_gmr.js --js src/graphics_adapters/vmware_svga/svga_screens.js \
		--js src/graphics_adapters/vmware_svga/svga_cursor.js --js src/graphics_adapters/vmware_svga/svga_video.js --js src/graphics_adapters/vmware_svga/svga_gb.js \
		--js src/graphics_adapters/vmware_svga/svga_formats.js --js src/graphics_adapters/vmware_svga/svga_dx_formats.js \
		--js src/graphics_adapters/vmware_svga/svga3d_d9wg.js --js src/graphics_adapters/vmware_svga/svga3d_tables.js \
		--js src/graphics_adapters/vmware_svga/svga3d_dx.js \
		--js src/graphics_adapters/vmware_svga/svga3d.js \
		--js src/graphics_adapters/vmware_svga/svga_device.js --js src/graphics_adapters/vmware_svga/plugin.js

build/v86-virtio-gpu.js: $(CLOSURE) src/*.js src/graphics_adapters/*.js src/graphics_adapters/virtio_gpu/*.js src/graphics_adapters/vmware_svga/*.js
	mkdir -p build
	java -jar $(CLOSURE) --js_output_file $@ --define=DEBUG=false $(CLOSURE_FLAGS) \
		--compilation_level SIMPLE --jscomp_off=missingProperties \
		--output_wrapper ';(function(){%output%}).call(this);' \
		--js $(GRAPHICS_ADAPTER_COMMON) --js src/graphics_adapters/vmware_svga/svga_cursor.js \
		--js src/graphics_adapters/vmware_svga/svga_constants.js --js src/graphics_adapters/vmware_svga/svga_dx_formats.js \
		--js src/graphics_adapters/virtio_gpu/edid.js --js src/graphics_adapters/virtio_gpu/virgl_caps.js \
		--js src/graphics_adapters/virtio_gpu/tgsi.js --js src/graphics_adapters/virtio_gpu/tgsi_vgpu10.js \
		--js src/graphics_adapters/virtio_gpu/virgl_context.js --js src/graphics_adapters/virtio_gpu/virgl.js \
		--js src/graphics_adapters/virtio_gpu/venus_protocol.js --js src/graphics_adapters/virtio_gpu/venus_device_info.js \
		--js src/graphics_adapters/virtio_gpu/venus_vk_resources.js --js src/graphics_adapters/virtio_gpu/venus_vk_commands.js \
		--js src/graphics_adapters/virtio_gpu/venus_vk_pipeline.js \
		--js src/graphics_adapters/virtio_gpu/venus_vk.js --js src/graphics_adapters/virtio_gpu/venus_state.js --js src/graphics_adapters/virtio_gpu/venus.js \
		--js src/graphics_adapters/virtio_gpu/gfxstream_protocol.js --js src/graphics_adapters/virtio_gpu/gfxstream_vk.js \
		--js src/graphics_adapters/virtio_gpu/gfxstream.js \
		--js src/graphics_adapters/virtio_gpu/virtio_gpu_device.js \
		--js src/graphics_adapters/virtio_gpu/plugin.js

.PHONY: graphics-adapters device-plugins
graphics-adapters: $(GRAPHICS_ADAPTER_PLUGINS)

build/v86-ne2k.js: $(CLOSURE) src/*.js src/net_adapters/*.js src/net_adapters/ne2k/*.js
	mkdir -p build
	java -jar $(CLOSURE) --js_output_file $@ --define=DEBUG=false $(CLOSURE_FLAGS) \
		--compilation_level SIMPLE --jscomp_off=missingProperties \
		--output_wrapper ';(function(){%output%}).call(this);' \
		--js $(NET_ADAPTER_COMMON) --js src/net_adapters/ne2k/ne2k.js --js src/net_adapters/ne2k/plugin.js

build/v86-e1000.js: $(CLOSURE) src/*.js src/net_adapters/*.js src/net_adapters/e1000/*.js
	mkdir -p build
	java -jar $(CLOSURE) --js_output_file $@ --define=DEBUG=false $(CLOSURE_FLAGS) \
		--compilation_level SIMPLE --jscomp_off=missingProperties \
		--output_wrapper ';(function(){%output%}).call(this);' \
		--js $(NET_ADAPTER_COMMON) --js src/net_adapters/e1000/e1000.js --js src/net_adapters/e1000/plugin.js

build/v86-sb16.js: $(CLOSURE) src/*.js src/audio_devices/*.js src/audio_devices/sb16/*.js
	mkdir -p build
	java -jar $(CLOSURE) --js_output_file $@ --define=DEBUG=false $(CLOSURE_FLAGS) \
		--compilation_level SIMPLE --jscomp_off=missingProperties \
		--output_wrapper ';(function(){%output%}).call(this);' \
		--js $(AUDIO_DEVICE_COMMON) --js src/audio_devices/sb16/sb16.js --js src/audio_devices/sb16/plugin.js

build/v86-hd-audio.js: $(CLOSURE) src/*.js src/audio_devices/*.js src/audio_devices/hd_audio/*.js
	mkdir -p build
	java -jar $(CLOSURE) --js_output_file $@ --define=DEBUG=false $(CLOSURE_FLAGS) \
		--compilation_level SIMPLE --jscomp_off=missingProperties \
		--output_wrapper ';(function(){%output%}).call(this);' \
		--js $(AUDIO_DEVICE_COMMON) --js src/audio_devices/hd_audio/codec.js --js src/audio_devices/hd_audio/controller.js \
		--js src/audio_devices/hd_audio/plugin.js

build/v86-usb.js: $(CLOSURE) src/*.js src/usb/*.js
	mkdir -p build
	java -jar $(CLOSURE) --js_output_file $@ --define=DEBUG=false $(CLOSURE_FLAGS) \
		--compilation_level SIMPLE --jscomp_off=missingProperties \
		--output_wrapper ';(function(){%output%}).call(this);' \
		--js $(USB_COMMON) --js src/usb/usb.js --js src/usb/usb_device.js --js src/usb/hid_tablet.js --js src/usb/mass_storage.js --js src/usb/uhci.js --js src/usb/ehci.js --js src/usb/xhci.js \
		--js src/usb/machine.js --js src/usb/plugin.js

build/v86-tpm.js: $(CLOSURE) src/*.js src/tpm/*.js
	mkdir -p build
	java -jar $(CLOSURE) --js_output_file $@ --define=DEBUG=false $(CLOSURE_FLAGS) \
		--compilation_level SIMPLE --jscomp_off=missingProperties \
		--output_wrapper ';(function(){%output%}).call(this);' \
		--js $(USB_COMMON) --js src/tpm/libtpms.js --js src/tpm/crb.js --js src/tpm/store.js --js src/tpm/plugin.js

build/glslang.wasm: bios/glslang.wasm
	mkdir -p build
	cp bios/glslang.wasm $@

build/libtpms.wasm: bios/libtpms.wasm
	mkdir -p build
	cp $< $@

# (esbuild, not Closure: it bundles gl-webgpu's GLSL front end, CommonJS
# scripts, for the shadow state's compiles and links)
build/v86-gles.js: src/gles/*.js src/graphics_adapters/renderer_protocol.js src/device_machine.js \
		src/browser/glbridge/gl-webgpu/gl_shader_translator.js src/browser/glbridge/gl-webgpu/gl_state_layout.js node_modules/.bin/esbuild
	mkdir -p build
	node_modules/.bin/esbuild src/gles/plugin.js --bundle --format=iife --target=es2020 --minify --legal-comments=none --outfile=$@

device-plugins: $(DEVICE_PLUGINS)

build/libv86.js: $(DEVICE_PLUGINS) $(CLOSURE) src/*.js src/parallel/*.js src/arm/*.js src/virt/*.js src/image/*.js lib/*.js src/browser/*.js
	mkdir -p build
	-ls -lh build/libv86.js
	java -jar $(CLOSURE) \
		--js_output_file build/libv86.js\
		--define=DEBUG=false\
		$(CLOSURE_FLAGS)\
		--compilation_level SIMPLE\
		--jscomp_off=missingProperties\
		--output_wrapper ';(function(){%output%}).call(this);'\
		--js $(CORE_FILES)\
		--js $(BROWSER_FILES)\
		--js $(LIB_FILES)
	ls -lh build/libv86.js

build/libv86.mjs: $(DEVICE_PLUGINS) $(CLOSURE) src/*.js src/parallel/*.js src/arm/*.js src/virt/*.js src/image/*.js src/android/*.js lib/*.js src/browser/*.js
	mkdir -p build
	-ls -lh build/libv86.js
	java -jar $(CLOSURE) \
		--js_output_file build/libv86.mjs\
		--define=DEBUG=false\
		$(CLOSURE_FLAGS)\
		--compilation_level SIMPLE\
		--jscomp_off=missingProperties\
		--output_wrapper ';let module = {exports:{}}; var V86_BUNDLE_URL = import.meta.url; %output%; export default module.exports.V86; export let {V86, CPU} = module.exports;'\
		--js $(CORE_FILES)\
		--js $(BROWSER_FILES)\
		--js $(LIB_FILES)\
		--chunk_output_type=ES_MODULES\
		--emit_use_strict=false
	ls -lh build/libv86.mjs

build/libv86-debug.js: $(DEVICE_PLUGINS) $(CLOSURE) src/*.js src/parallel/*.js src/arm/*.js src/virt/*.js src/image/*.js lib/*.js src/browser/*.js
	mkdir -p build
	java -jar $(CLOSURE) \
		--js_output_file build/libv86-debug.js\
		--define=DEBUG=true\
		$(CLOSURE_FLAGS)\
		$(CLOSURE_READABLE)\
		--compilation_level SIMPLE\
		--jscomp_off=missingProperties\
		--output_wrapper ';(function(){%output%}).call(this);'\
		--js $(CORE_FILES)\
		--js $(BROWSER_FILES)\
		--js $(LIB_FILES)
	ls -lh build/libv86-debug.js

build/libv86-debug.mjs: $(DEVICE_PLUGINS) $(CLOSURE) src/*.js src/parallel/*.js src/arm/*.js src/virt/*.js src/image/*.js src/android/*.js lib/*.js src/browser/*.js
	mkdir -p build
	java -jar $(CLOSURE) \
		--js_output_file build/libv86-debug.mjs\
		--define=DEBUG=true\
		$(CLOSURE_FLAGS)\
		$(CLOSURE_READABLE)\
		--compilation_level SIMPLE\
		--jscomp_off=missingProperties\
		--output_wrapper ';let module = {exports:{}}; var V86_BUNDLE_URL = import.meta.url; %output%; export default module.exports.V86; export let {V86, CPU} = module.exports;'\
		--js $(CORE_FILES)\
		--js $(BROWSER_FILES)\
		--js $(LIB_FILES)\
		--chunk_output_type=ES_MODULES\
		--emit_use_strict=false
	ls -lh build/libv86-debug.mjs

src/rust/gen/interpreter.rs: $(INTERPRETER_DEPENDENCIES)
	./gen/generate_interpreter.js --output-dir build/ --table interpreter
src/rust/gen/interpreter0f.rs: $(INTERPRETER_DEPENDENCIES)
	./gen/generate_interpreter.js --output-dir build/ --table interpreter0f
src/rust/gen/interpreter0f38.rs: $(INTERPRETER_DEPENDENCIES)
	./gen/generate_interpreter.js --output-dir build/ --table interpreter0f38
src/rust/gen/interpreter0f3a.rs: $(INTERPRETER_DEPENDENCIES)
	./gen/generate_interpreter.js --output-dir build/ --table interpreter0f3a

build/v86.wasm: $(RUST_FILES) build/softfloat.o build/zstddeclib.o Cargo.toml
	mkdir -p build/
	-BLOCK_SIZE=K ls -l build/v86.wasm
	cargo rustc --release $(CARGO_FLAGS)
	cp build/wasm32-unknown-unknown/release/v86.wasm build/v86.wasm
	@if [ "$(WASM_OPT)" != "false" ]; then $(WASM_OPT) && wasm-opt -O2 --strip-debug build/v86.wasm -o build/v86.wasm; fi
	BLOCK_SIZE=K ls -l build/v86.wasm

# An A/B arm (docs/jit-unification-plan.md P3.0a, docs/profiling.md): the
# release core with build-time switch defaults, beside the others in
# build/bench/arms, for the measurements whose processes take one setting
# (tools/owner_perf.mjs --arms, XP, Windows 8.1 and Windows 98):
#   make jit-arm ARM=no-legacy32 JIT_DEFAULTS="x64_page_legacy32=0"
# Its own cargo target directory leaves build/v86.wasm as it is.
.PHONY: jit-arm
jit-arm: $(RUST_FILES) build/softfloat.o build/zstddeclib.o Cargo.toml
	@test -n "$(ARM)" || { echo "jit-arm: name the arm, ARM=name"; exit 1; }
	mkdir -p build/bench/arms
	CARGO_TARGET_DIR=build/arm-target cargo rustc --release $(CARGO_FLAGS)
	cp build/arm-target/wasm32-unknown-unknown/release/v86.wasm build/bench/arms/$(ARM).wasm
	@if [ "$(WASM_OPT)" != "false" ]; then $(WASM_OPT) && wasm-opt -O2 --strip-debug build/bench/arms/$(ARM).wasm -o build/bench/arms/$(ARM).wasm; fi
	@echo "build/bench/arms/$(ARM).wasm: JIT_DEFAULTS=\"$(JIT_DEFAULTS)\""

build/v86-debug.wasm: $(RUST_FILES) build/softfloat.o build/zstddeclib.o Cargo.toml
	mkdir -p build/
	-BLOCK_SIZE=K ls -l build/v86-debug.wasm
	cargo rustc $(CARGO_FLAGS)
	cp build/wasm32-unknown-unknown/debug/v86.wasm build/v86-debug.wasm
	BLOCK_SIZE=K ls -l build/v86-debug.wasm

build/v86-parallel.wasm: $(RUST_FILES) build/softfloat.o build/zstddeclib.o Cargo.toml tools/parallel_wasm.mjs
	mkdir -p build/
	CARGO_TARGET_DIR=build/parallel cargo rustc --release --features parallel $(CARGO_FLAGS_PARALLEL)
	./tools/parallel_wasm.mjs build/parallel/wasm32-unknown-unknown/release/v86.wasm build/v86-parallel.wasm

build/v86-parallel-debug.wasm: $(RUST_FILES) build/softfloat.o build/zstddeclib.o Cargo.toml tools/parallel_wasm.mjs
	mkdir -p build/
	CARGO_TARGET_DIR=build/parallel cargo rustc --features parallel $(CARGO_FLAGS_PARALLEL)
	./tools/parallel_wasm.mjs build/parallel/wasm32-unknown-unknown/debug/v86.wasm build/v86-parallel-debug.wasm

build/v86-fallback.wasm: $(RUST_FILES) build/softfloat.o build/zstddeclib.o Cargo.toml
	mkdir -p build/
	cargo rustc --release $(CARGO_FLAGS_SAFE)
	cp build/wasm32-unknown-unknown/release/v86.wasm build/v86-fallback.wasm || true

# The ARM core (docs/arm64-virt-android16-plan.md P1.0): the same crate with
# the feature aarch64 and its own cargo target directory, so that the cores
# do not rebuild each other; SoftFloat with the ARM specialization
# (build/softfloat_arm.o) instead of the x86 one
CARGO_FLAGS_ARM64_SAFE=\
		--target wasm32-unknown-unknown \
		--features aarch64 \
		-- \
		-C linker=tools/rust-lld-wrapper \
		-C link-args="--import-table --global-base=4096 $(STRIP_DEBUG_FLAG)" \
		-C link-args="build/softfloat_arm.o" \
		-C link-args="build/zstddeclib.o" \
		--verbose
CARGO_FLAGS_ARM64=$(CARGO_FLAGS_ARM64_SAFE) -C target-feature=+bulk-memory -C target-feature=+multivalue -C target-feature=+simd128

build/v86-arm64.wasm: $(RUST_FILES) build/softfloat_arm.o build/zstddeclib.o Cargo.toml
	mkdir -p build/
	CARGO_TARGET_DIR=build/arm64 cargo rustc --release $(CARGO_FLAGS_ARM64)
	cp build/arm64/wasm32-unknown-unknown/release/v86.wasm build/v86-arm64.wasm
	BLOCK_SIZE=K ls -l build/v86-arm64.wasm

# The ARM core with its cores in vCPU workers (P8.2): built as
# v86-parallel.wasm is (atomics, the memory imported, relocations kept)
CARGO_FLAGS_ARM64_PARALLEL=$(CARGO_FLAGS_ARM64) -C target-feature=+atomics \
		-C link-args="--import-memory --export-memory --emit-relocs --no-check-features --max-memory=4294967296 --global-base=32768 --export=__heap_base --export=__data_end"

build/v86-arm64-parallel.wasm: $(RUST_FILES) build/softfloat_arm.o build/zstddeclib.o Cargo.toml tools/parallel_wasm.mjs
	mkdir -p build/
	CARGO_TARGET_DIR=build/arm64-parallel cargo rustc --release --features parallel $(CARGO_FLAGS_ARM64_PARALLEL)
	./tools/parallel_wasm.mjs build/arm64-parallel/wasm32-unknown-unknown/release/v86.wasm build/v86-arm64-parallel.wasm

build/v86-arm64-debug.wasm: $(RUST_FILES) build/softfloat_arm.o build/zstddeclib.o Cargo.toml
	mkdir -p build/
	CARGO_TARGET_DIR=build/arm64 cargo rustc $(CARGO_FLAGS_ARM64)
	cp build/arm64/wasm32-unknown-unknown/debug/v86.wasm build/v86-arm64-debug.wasm

build/v86-arm64-fallback.wasm: $(RUST_FILES) build/softfloat_arm.o build/zstddeclib.o Cargo.toml
	mkdir -p build/
	CARGO_TARGET_DIR=build/arm64-fallback cargo rustc --release $(CARGO_FLAGS_ARM64_SAFE)
	cp build/arm64-fallback/wasm32-unknown-unknown/release/v86.wasm build/v86-arm64-fallback.wasm

debug-with-profiler: $(RUST_FILES) build/softfloat.o build/zstddeclib.o Cargo.toml
	mkdir -p build/
	cargo rustc --features profiler $(CARGO_FLAGS)
	cp build/wasm32-unknown-unknown/debug/v86.wasm build/v86-debug.wasm || true

with-profiler: $(RUST_FILES) build/softfloat.o build/zstddeclib.o Cargo.toml
	mkdir -p build/
	cargo rustc --release --features profiler $(CARGO_FLAGS)
	cp build/wasm32-unknown-unknown/release/v86.wasm build/v86.wasm || true

watch:
	cargo watch -x 'rustc $(CARGO_FLAGS)' -s 'cp build/wasm32-unknown-unknown/debug/v86.wasm build/v86-debug.wasm'

build/softfloat.o: lib/softfloat/softfloat.c
	mkdir -p build
	clang -c -Wall \
	    --target=wasm32 -O3 -flto -nostdlib -fvisibility=hidden -ffunction-sections -fdata-sections \
	    -DSOFTFLOAT_FAST_INT64 -DINLINE_LEVEL=5 -DSOFTFLOAT_FAST_DIV32TO16 -DSOFTFLOAT_FAST_DIV64TO32 \
	    -o build/softfloat.o \
	    lib/softfloat/softfloat.c

build/softfloat_arm.o: lib/softfloat/softfloat.c tools/softfloat_arm.mjs
	mkdir -p build
	node tools/softfloat_arm.mjs lib/softfloat/softfloat.c build/softfloat_arm.c
	clang -c -Wall \
	    --target=wasm32 -O3 -flto -nostdlib -fvisibility=hidden -ffunction-sections -fdata-sections \
	    -DSOFTFLOAT_FAST_INT64 -DINLINE_LEVEL=5 -DSOFTFLOAT_FAST_DIV32TO16 -DSOFTFLOAT_FAST_DIV64TO32 \
	    -DSOFTFLOAT_ROUND_ODD \
	    -o build/softfloat_arm.o \
	    build/softfloat_arm.c

build/zstddeclib.o: lib/zstd/zstddeclib.c
	mkdir -p build
	clang -c -Wall \
	    --target=wasm32 -O3 -flto -nostdlib -fvisibility=hidden -ffunction-sections -fdata-sections \
	    -DZSTDLIB_VISIBILITY="" \
	    -o build/zstddeclib.o \
	    lib/zstd/zstddeclib.c

clean:
	-rm build/libv86.js
	-rm $(DEVICE_PLUGINS)
	-rm build/libv86.mjs
	-rm build/libv86-debug.js
	-rm build/libv86-debug.mjs
	-rm build/v86_app.js build/v86_app.js.map
	-rm build/v86.wasm
	-rm build/v86-debug.wasm
	-rm $(INSTRUCTION_TABLES)
	-rm build/*.map
	-rm build/*.wast
	-rm build/*.o
	$(MAKE) -C $(NASM_TEST_DIR) clean

run: browser glbridge build/v86.wasm
	python3 tools/dev-server.py 2> /dev/null

# The VM manager as a static site in build/pages (tools/pages_dist.mjs, for
# Cloudflare Pages: .github/workflows/pages.yml, docs/vm-manager.md)
PAGES_BUILD=build/v86_app.js build/android-import-worker.js build/libv86.mjs build/cpu-worker.js build/vcpu-worker.js build/xterm.js \
	build/v86.wasm build/v86-fallback.wasm build/v86-parallel.wasm \
	build/v86-arm64.wasm build/v86-arm64-fallback.wasm build/v86-arm64-parallel.wasm $(DEVICE_PLUGINS)
.PHONY: pages
pages: $(PAGES_BUILD) glbridge
	node tools/pages_dist.mjs

update_version:
	set -e ;\
	COMMIT=`git log --format="%h" -n 1` ;\
	DATE=`git log --date="format:%b %e, %Y %H:%m" --format="%cd" -n 1` ;\
	SEARCH='<code>Version: <a id="version" href="https://github.com/speedyHKjournalist/v64/commits/[a-f0-9]\+">[a-f0-9]\+</a> ([^(]\+)</code>' ;\
	REPLACE='<code>Version: <a id="version" href="https://github.com/speedyHKjournalist/v64/commits/'$$COMMIT'">'$$COMMIT'</a> ('$$DATE')</code>' ;\
	sed -i "s@$$SEARCH@$$REPLACE@g" index.html ;\
	sed -i "s@\(build/v86_app.js\|build/libv86.mjs\|src/app/app.css\)?[a-f0-9]\+@\1?$$COMMIT@g" index.html ;\
	grep $$COMMIT index.html


$(CLOSURE):
	mkdir -p $(CLOSURE_DIR)
	# don't upgrade until https://github.com/google/closure-compiler/issues/3972 is fixed
	wget -nv -O $(CLOSURE) https://repo1.maven.org/maven2/com/google/javascript/closure-compiler/v20210601/closure-compiler-v20210601.jar

build/integration-test-fs/fs.json: images/buildroot-bzimage68.bin
	mkdir -p build/integration-test-fs/flat
	cp images/buildroot-bzimage68.bin build/integration-test-fs/bzImage
	touch build/integration-test-fs/initrd
	cd build/integration-test-fs && tar cfv fs.tar bzImage initrd
	./tools/fs2json.py build/integration-test-fs/fs.tar --out build/integration-test-fs/fs.json
	./tools/copy-to-sha256.py build/integration-test-fs/fs.tar build/integration-test-fs/flat
	rm build/integration-test-fs/fs.tar build/integration-test-fs/bzImage build/integration-test-fs/initrd

tests: build/v86-debug.wasm build/integration-test-fs/fs.json
	LOG_LEVEL=3 ./tests/full/run.js

tests-release: build/libv86.js build/v86.wasm build/integration-test-fs/fs.json
	TEST_RELEASE_BUILD=1 ./tests/full/run.js

nasmtests: build/v86-debug.wasm
	$(NASM_TEST_DIR)/create_tests.js
	$(NASM_TEST_DIR)/gen_fixtures.js
	$(NASM_TEST_DIR)/run.js

nasmtests-force-jit: build/v86-debug.wasm
	$(NASM_TEST_DIR)/create_tests.js
	$(NASM_TEST_DIR)/gen_fixtures.js
	$(NASM_TEST_DIR)/run.js --force-jit

jitpagingtests: build/v86-debug.wasm
	$(MAKE) -C tests/jit-paging test-jit test-jit-smc
	./tests/jit-paging/run.js
	./tests/jit-paging/run-smc.js

qemutests: build/v86-debug.wasm
	$(MAKE) -C tests/qemu test-i386
	LOG_LEVEL=3 ./tests/qemu/run.js build/qemu-test-result
	./tests/qemu/run-qemu.js > build/qemu-test-reference
	diff build/qemu-test-result build/qemu-test-reference

qemutests-release: build/libv86.mjs build/v86.wasm
	$(MAKE) -C tests/qemu test-i386
	TEST_RELEASE_BUILD=1 time ./tests/qemu/run.js build/qemu-test-result
	./tests/qemu/run-qemu.js > build/qemu-test-reference
	diff build/qemu-test-result build/qemu-test-reference

# kvm-unit-tests are built out of tree in build/kvm-unit-tests/<arch>/ (also on
# macOS, see tests/kvm-unit-tests/build.sh)
KVM_UNIT_TESTS=build/kvm-unit-tests/i386/x86

kvm-unit-test: build/v86-debug.wasm
	tests/kvm-unit-tests/build.sh i386 x86/realmode.flat x86/taskswitch.flat x86/taskswitch2.flat
	tests/kvm-unit-tests/run.mjs $(KVM_UNIT_TESTS)/taskswitch.flat
	tests/kvm-unit-tests/run.mjs --expect-pass 11 $(KVM_UNIT_TESTS)/taskswitch2.flat
	# (realmode.flat runs about 50 s, debug or release: near run.mjs's 60 s)
	tests/kvm-unit-tests/run.mjs --timeout 180 --expect-pass 127 $(KVM_UNIT_TESTS)/realmode.flat

# x86/xsave.flat without XSAVE, with it (XCR0 x87, SSE) and with AVX too (YMM),
# in the x86_64 build (whose exception tables ASM_TRY fills with .quad)
kvm-unit-test-xsave: build/v86-debug.wasm
	tests/kvm-unit-tests/build.sh x86_64 x86/xsave.flat
	tests/kvm-unit-tests/run.mjs --cpu-type x86_64 --expect-pass 4 build/kvm-unit-tests/x86_64/x86/xsave.flat
	tests/kvm-unit-tests/run.mjs --cpu-type x86_64 --expect-pass 15 --cpu-features XSAVE build/kvm-unit-tests/x86_64/x86/xsave.flat
	tests/kvm-unit-tests/run.mjs --cpu-type x86_64 --expect-pass 17 --cpu-features SSSE3,SSE4.1,SSE4.2,XSAVE,AVX build/kvm-unit-tests/x86_64/x86/xsave.flat

kvm-unit-test-release: build/libv86.mjs build/v86.wasm
	tests/kvm-unit-tests/build.sh i386 x86/realmode.flat x86/taskswitch.flat x86/taskswitch2.flat
	TEST_RELEASE_BUILD=1 tests/kvm-unit-tests/run.mjs $(KVM_UNIT_TESTS)/taskswitch.flat
	TEST_RELEASE_BUILD=1 tests/kvm-unit-tests/run.mjs --expect-pass 11 $(KVM_UNIT_TESTS)/taskswitch2.flat
	TEST_RELEASE_BUILD=1 tests/kvm-unit-tests/run.mjs --timeout 180 --expect-pass 127 $(KVM_UNIT_TESTS)/realmode.flat

# Interrupt controller tests (ACPI enables the APIC in v86).
kvm-unit-test-apic: build/v86-debug.wasm
	tests/kvm-unit-tests/build.sh i386 x86/ioapic.flat x86/smptest.flat x86/apic.flat
	tests/kvm-unit-tests/run.mjs --acpi --expect-pass 19 $(KVM_UNIT_TESTS)/ioapic.flat
	tests/kvm-unit-tests/run.mjs --acpi --expect-pass 1 $(KVM_UNIT_TESTS)/smptest.flat
	tests/kvm-unit-tests/run.mjs --acpi --expect-pass 11 $(KVM_UNIT_TESTS)/apic.flat

acpi-device-tests: build/v86-debug.wasm
	./tests/devices/acpi_device.js
	./tests/devices/device_io_reset.mjs

acpi-guest-tests: build/v86-debug.wasm
	./tests/devices/acpi_guest.js
	DISABLE_JIT=1 ./tests/devices/acpi_guest.js
	GUEST=linux4 ./tests/devices/acpi_guest.js

# The Q35 machine (docs/q35.md, docs/ahci.md, docs/sata.md): the AHCI controller driven
# without a guest, its commands with disk I/O in flight, and real guests
# (images/linux4.iso, msdos622.img, buildroot-bzimage68.bin)
q35-device-tests: build/v86-debug.wasm
	./tests/devices/ahci.js
	./tests/devices/ahci_lifecycle.mjs
	./tests/devices/disk_write_cache.js
	./tests/devices/pcie_root_port.js
	./tests/devices/hpet.js
	./tests/devices/smbus.js
	./tests/devices/ich9_tco.js
	./tests/devices/smm.js

q35-guest-tests: build/v86-debug.wasm
	./tests/devices/q35_guest.js

# PCI Express hot plug with Linux: Alpine's x86_64 virt kernel (pciehp), the
# pinned Alpine ISO downloaded on first use as for the x64 linux targets
q35-hotplug-tests: build/v86-debug.wasm
	./tests/devices/pcie_hotplug.mjs

# The e1000 network card (docs/modern-pc-devices-plan.md N1): the plugin's
# device through its registers (from the source tree and as build/v86-e1000.js),
# then Linux 4.16's driver on images/linux4.iso, on one core and on two
e1000-tests: build/v86-debug.wasm build/libv86.mjs
	./tests/devices/e1000.js
	TEST_RELEASE_BUILD=1 ./tests/devices/e1000.js
	./tests/devices/e1000_guest.mjs
	CPU_CORES=2 ./tests/devices/e1000_guest.mjs

# The HD Audio controller (docs/sound.md, docs/modern-pc-devices-plan.md H1):
# the plugin's device through its registers, then Alpine x86_64's drivers
# playing through it (i440FX, Q35, two cores; the pinned ISO is downloaded
# on first use, as for the x64 linux targets), and what headless Chrome plays
# of it with the CPU worker
hd-audio-tests: build/v86-debug.wasm build/libv86.mjs
	./tests/devices/hd_audio.js
	TEST_RELEASE_BUILD=1 ./tests/devices/hd_audio.js
	./tests/devices/hd_audio_guest.mjs
	MACHINE=q35 ./tests/devices/hd_audio_guest.mjs
	CPU_CORES=2 ./tests/devices/hd_audio_guest.mjs
	TIMEOUT_MS=1500000 node tests/app/browser_runner.mjs tests/devices/hd_audio_browser.html autoplay=1

# USB (docs/usb.md, docs/modern-pc-devices-plan.md U1 to U4): UHCI, EHCI,
# xHCI, the HID tablet and USB disks through the controllers' registers,
# schedules and rings, then Alpine x86_64's uhci-hcd, ehci-pci, xhci-pci,
# usbhid and usb-storage
# (i440FX, Q35, two cores). Windows: tests/devices/
# usb_windows_xp.mjs, tests/x64/windows_boot.mjs WIN_USB (their images)
# The TPM 2.0 (docs/tpm.md): the device in Node, Linux's tpm_crb (Alpine's LTS
# kernel), OVMF's measurements and their event log (macOS: hdiutil makes the ESP)
tpm-tests: build/v86-debug.wasm build/v86.wasm build/libv86.mjs build/v86-tpm.js build/libtpms.wasm
	./tests/tpm/tpm.mjs
	TEST_RELEASE_BUILD=1 ./tests/tpm/tpm.mjs
	MACHINE=q35 ./tests/tpm/tpm.mjs
	./tests/tpm/linux_tpm.mjs
	MACHINE=q35 CPU_CORES=2 ./tests/tpm/linux_tpm.mjs
	TEST_RELEASE_BUILD=1 ./tests/tpm/linux_tpm.mjs
	./tests/tpm/uefi_tpm.mjs
	MACHINE=i440fx CPU_CORES=2 ./tests/tpm/uefi_tpm.mjs
	TEST_RELEASE_BUILD=1 ./tests/tpm/uefi_tpm.mjs

# The UEFI firmware (docs/uefi.md): OVMF to its Shell, and Alpine from a GPT
# disk's ESP (macOS: hdiutil), on Q35, i440FX, two cores and the release build;
# Secure Boot with test keys (x86_64-w64-mingw32-gcc, openssl); Windows Setup
# (a local installer ISO), also under Secure Boot with Microsoft's keys
uefi-tests: build/v86-debug.wasm build/v86.wasm build/libv86.mjs
	./tests/uefi/shell.mjs
	MACHINE=i440fx ./tests/uefi/shell.mjs
	CPU_CORES=2 ./tests/uefi/shell.mjs
	MEMORY_MB=5120 ./tests/uefi/shell.mjs
	TEST_RELEASE_BUILD=1 ./tests/uefi/shell.mjs
	./tests/uefi/vars.mjs
	TEST_RELEASE_BUILD=1 ./tests/uefi/vars.mjs
	./tests/uefi/esp_boot.mjs
	MACHINE=i440fx ./tests/uefi/esp_boot.mjs
	CPU_CORES=2 ./tests/uefi/esp_boot.mjs
	TEST_RELEASE_BUILD=1 ./tests/uefi/esp_boot.mjs
	./tests/uefi/secure_boot.mjs
	CPU_CORES=2 ./tests/uefi/secure_boot.mjs
	TEST_RELEASE_BUILD=1 ./tests/uefi/secure_boot.mjs
	TEST_RELEASE_BUILD=1 ./tests/uefi/vars_resilience.mjs
	SECURE_BOOT=1 TEST_RELEASE_BUILD=1 ./tests/uefi/vars_resilience.mjs
	./tests/uefi/windows_setup.mjs
	SECURE_BOOT=1 ./tests/uefi/windows_setup.mjs
	SECURE_BOOT=1 MEMORY_MB=4096 ./tests/uefi/windows_setup.mjs

usb-tests: build/v86-debug.wasm build/libv86.mjs build/v86-usb.js
	./tests/devices/usb.js
	TEST_RELEASE_BUILD=1 ./tests/devices/usb.js
	./tests/devices/usb_storage.js
	TEST_RELEASE_BUILD=1 ./tests/devices/usb_storage.js
	./tests/devices/usb_ehci.js
	TEST_RELEASE_BUILD=1 ./tests/devices/usb_ehci.js
	./tests/devices/usb_xhci.js
	TEST_RELEASE_BUILD=1 ./tests/devices/usb_xhci.js
	./tests/devices/usb_guest.mjs
	MACHINE=q35 CPU_CORES=2 ./tests/devices/usb_guest.mjs
	USB_CONTROLLER=ehci ./tests/devices/usb_guest.mjs
	USB_CONTROLLER=xhci ./tests/devices/usb_guest.mjs
	./tests/devices/usb_storage_guest.mjs
	MACHINE=q35 CPU_CORES=2 ./tests/devices/usb_storage_guest.mjs
	USB_CONTROLLER=ehci ./tests/devices/usb_storage_guest.mjs
	USB_CONTROLLER=ehci MACHINE=q35 CPU_CORES=2 ./tests/devices/usb_storage_guest.mjs
	USB_CONTROLLER=xhci ./tests/devices/usb_storage_guest.mjs
	USB_CONTROLLER=xhci MACHINE=q35 CPU_CORES=2 ./tests/devices/usb_storage_guest.mjs

.PHONY: usb-tests hd-audio-tests e1000-tests q35-device-tests q35-guest-tests q35-hotplug-tests q35-tests
q35-tests: acpi-table-tests q35-device-tests q35-guest-tests q35-hotplug-tests

# ACPICA's iasl/acpiexec are used when found on PATH or in IASL/ACPIEXEC
acpi-table-tests:
	./tests/devices/acpi_tables.js

.PHONY: acpi-device-tests acpi-table-tests acpi-guest-tests acpi-tests
acpi-tests: acpi-table-tests acpi-device-tests acpi-guest-tests

devices-test: build/v86-debug.wasm
	./tests/devices/display.js
	./tests/devices/graphics_adapter.js
	./tests/devices/vmware_svga.js
	./tests/devices/vmware_svga_3d.js
	./tests/devices/vmware_svga_gb.js
	./tests/devices/vmware_svga_video.js
	./tests/devices/virtio_gpu.js
	./tests/devices/virtio_gpu_hostmem.js
	./tests/devices/virtio_gpu_present.js
	./tests/devices/virtio_gpu_venus.js
	./tests/devices/venus_protocol.js
	./tests/devices/virtio_gpu_gfxstream.js
	./tests/devices/virtio_gpu_gfxstream_vk.js
	./tests/devices/gfxstream_protocol.js
	./tests/devices/virgl_tgsi.js
	./tests/devices/vmware_backdoor.js
	./tests/devices/mmio_ram.js
	./tests/devices/virtio_9p.js
	./tests/devices/virtio_console.js
	./tests/devices/fetch_network.js
	USE_VIRTIO=1 ./tests/devices/fetch_network.js
	./tests/devices/fetch_network_post.js
	./tests/devices/wisp_network.js
	./tests/devices/virtio_balloon.js
	./tests/devices/virtio_devices.js
	./tests/devices/virtio_rng.js
	./tests/devices/ide_large_disk.js
	./tests/devices/ide_disk_image.js
	./tests/devices/disk_error.mjs
	./tests/devices/disk_writeback.mjs
	./tests/devices/disk_sector_size.js

rust-test: $(RUST_FILES)
	env RUSTFLAGS="-D warnings" RUST_BACKTRACE=full RUST_TEST_THREADS=1 cargo test -- --nocapture
	./tests/rust/verify-wasmgen-dummy-output.js

rust-test-intensive:
	QUICKCHECK_TESTS=100000000 make rust-test

build/softfloat-fast-test.wasm: tests/rust/softfloat_fast_path.rs src/rust/softfloat.rs src/rust/profiler.rs build/softfloat.o
	rustc --edition=2021 --target wasm32-unknown-unknown --crate-type cdylib -O \
	    -C linker=tools/rust-lld-wrapper -C link-arg=build/softfloat.o \
	    tests/rust/softfloat_fast_path.rs -o $@

softfloat-fast-tests: build/softfloat-fast-test.wasm
	node tests/rust/softfloat_fast_path.mjs

x87-fast-math-tests: build/softfloat-fast-test.wasm
	node tests/rust/x87_fast_math.mjs

x87-jit-cache-tests: build/jit-capacity.bin build/v86.wasm build/libv86.mjs
	node tests/rust/x87_jit_cache.mjs

build/x87-fast-test.bin: tests/rust/x87_fast_path.asm
	nasm -f bin $< -o $@

x87-fast-tests: build/x87-fast-test.bin build/v86.wasm build/v86-profiler.wasm build/libv86.mjs
	node tests/rust/x87_fast_path.mjs
	X87_PATHS=1 node tests/rust/x87_fast_path.mjs "" build/v86-profiler.wasm

# The release core with the profiler's statistics (src/rust/profiler.rs), in
# its own target directory: x87-fast-tests checks the x87 paths with it
build/v86-profiler.wasm: $(RUST_FILES) build/softfloat.o build/zstddeclib.o Cargo.toml
	mkdir -p build/
	CARGO_TARGET_DIR=build/profiler cargo rustc --release --features profiler $(CARGO_FLAGS)
	cp build/profiler/wasm32-unknown-unknown/release/v86.wasm build/v86-profiler.wasm

.PHONY: cpu-optimization-tests cpu-optimization-benchmark
cpu-optimization-tests: build/jit-capacity.bin build/v86.wasm build/libv86.mjs
	node tests/rust/cpu_optimizations.mjs

.PHONY: flags-provenance-tests
flags-provenance-tests: build/jit-capacity.bin build/v86.wasm build/libv86.mjs
	node tests/rust/flags_provenance.mjs

.PHONY: cpu-plan-tests
cpu-plan-tests: build/jit-capacity.bin build/v86.wasm build/libv86.mjs
	node tests/rust/cpu_plan_sequences.mjs

.PHONY: jit-tiers-tests
jit-tiers-tests: build/jit-capacity.bin build/v86.wasm build/libv86.mjs
	node tests/rust/jit_tiers.mjs

.PHONY: mmx-fast-tests
mmx-fast-tests: build/jit-capacity.bin build/v86.wasm build/libv86.mjs
	node tests/rust/mmx_fast_path.mjs

# Preserve a baseline before rebuilding, or pass paths directly to the script.
cpu-optimization-benchmark: build/jit-capacity.bin build/v86.wasm build/libv86.mjs
	node tests/rust/cpu_optimizations_benchmark.mjs

build/jit-capacity.bin: tests/rust/jit_capacity.asm
	nasm -f bin $< -o $@

api-tests: build/v86-debug.wasm
	./tests/api/clean-shutdown.js
	./tests/api/arm64-options.js
	./tests/api/jit-switches.js
	./tests/api/destroy-during-init.js
	./tests/api/state.js
	./tests/api/sb16-state.js
	./tests/api/sb16-dma.js
	./tests/api/reset.js
	./tests/api/floppy.js
	./tests/api/parallel.js
	./tests/api/cdrom-insert-eject.js
	./tests/api/disk-image.js
	./tests/api/disk-options.js
	./tests/api/iso9660.js
	./tests/api/serial.js
	./tests/api/reboot.js
	#./tests/api/reboot-buildroot.js # https://github.com/copy/v86/issues/636
	./tests/api/pic.js

# Disk images in container formats (docs/disk-image-formats-plan.md): the
# readers against images of qemu-img and qemu-io (QEMU_IMG, QEMU_IO; the
# samples are made in build/disk-image-samples), the devices and guests;
# the browser tests in headless Chrome (CHROME), on the page and in the CPU Worker
.PHONY: disk-image-tests disk-image-browser-tests
disk-image-tests: build/v86-debug.wasm
	./tests/image/inflate.mjs
	./tests/image/disk_image.mjs
	./tests/image/qcow2.mjs
	./tests/image/vhd_vdi.mjs
	./tests/image/vmdk.mjs
	./tests/image/vhdx.mjs
	./tests/image/sector_size.mjs
	./tests/image/qcow2_export.mjs
	./tests/devices/ide_disk_image.js
	./tests/devices/disk_sector_size.js
	./tests/api/disk-image.js
	./tests/image/guest.mjs
	./tests/image/sector_size_guest.mjs

disk-image-browser-tests: build/libv86.mjs build/cpu-worker.js build/v86.wasm $(DEVICE_PLUGINS)
	./tests/image/browser_runner.mjs worker=0
	./tests/image/browser_runner.mjs worker=1

# Disk persistence (docs/disk-persistence-plan.md): disk_option, disk_error,
# FLUSH, the consistent reads of a read_only disk; the browser tests in
# headless Chrome (CHROME), on the page and in the CPU Worker
# The VM manager (docs/vm-manager-plan.md G2-G4): src/app/ as ES modules
# outside Closure, bundled by esbuild into build/v86_app.js (build/libv86.mjs
# stays its own file: index.html's import map names it "v86"), checked by tsc
# against v86.d.ts. The tools are package.json's devDependencies (npm ci).
APP_FILES=$(shell find src/app -name '*.js') $(wildcard src/android/*.js) src/browser/vm_options.js src/browser/query_compat.js \
	src/machine_options.js src/disk_options.js
node_modules/.bin/esbuild node_modules/.bin/tsc: package.json package-lock.json
	npm ci
	touch node_modules/.bin/esbuild node_modules/.bin/tsc

.PHONY: app app-check
app: build/v86_app.js build/android-import-worker.js build/libv86.mjs build/cpu-worker.js build/vcpu-worker.js

build/v86_app.js: $(APP_FILES) node_modules/.bin/esbuild
	mkdir -p build
	node_modules/.bin/esbuild src/app/main.js --bundle --format=esm --target=es2022 --minify --sourcemap \
		--external:v86 --outfile=build/v86_app.js --log-level=warning

# the Android importer's worker (src/app/android_import.js starts it): the
# image library of src/android/ and a browser disk's sync access handle
build/android-import-worker.js: src/app/android_import_worker.js $(wildcard src/android/*.js) src/image/sha256.js node_modules/.bin/esbuild
	mkdir -p build
	node_modules/.bin/esbuild src/app/android_import_worker.js --bundle --format=esm --target=es2022 --minify --sourcemap \
		--outfile=build/android-import-worker.js --log-level=warning

app-check: node_modules/.bin/tsc
	node_modules/.bin/tsc -p tsconfig.json

# the VM manager plan (docs/vm-manager-plan.md), U0: the shared modules
# (src/browser/vm_options.js, query_compat.js) give the options
# the pages give (index.html's addresses, debug.html's addresses and form),
# made by Node from the modules as by the pages
# U1: the configurations (src/app/vm_config.js) and the library (vm_store.js);
# U2: the page: the type check, the addresses' options as the modules make them, the
# library and a console booting FreeDOS (the release and debug pages, the CPU
# in its Worker and in the page); U3: the presets and the dialog's rules, the
# disk service's create and list, the wizard booting FreeDOS, Linux and
# Alpine arm64 (build/a64-linux: tests/a64/linux_boot.mjs prepares it), the
# settings dialog, the wizard's disk on the disk service; U4: the console's
# every function with MS-DOS (in its Worker and in the page), a disk written
# back to the disk service with its error dialog; U5: suspend and resume, one
# tab per machine; U6: browser disks (the backend in a worker, Linux and
# MS-DOS on them, import, export, sharing, the CPU in the page refused)
.PHONY: app-shared-tests app-tests
app-tests: app-shared-tests app-check app build/v86.wasm build/v86-debug.wasm build/v86-arm64.wasm build/libv86-debug.mjs
	node tests/app/vm_config.mjs
	node tests/app/presets.mjs
	node tests/app/browser_runner.mjs tests/app/store_test.html
	node tests/app/disk_service_create.mjs
	node tests/app/browser_runner.mjs tests/app/app_test.html page=index.html
	node tests/app/browser_runner.mjs tests/app/app_test.html page=app_debug.html
	node tests/app/browser_runner.mjs tests/app/app_test.html page=index.html worker=0
	node tests/android/make_package.mjs
	for part in freedos linux arm64 dialog uefi secure_boot android android_gsi android_emulator; do node tests/app/browser_runner.mjs tests/app/wizard_test.html part=$$part || exit 1; done
	node tests/app/browser_runner.mjs tests/app/wizard_test.html part=service service=1
	node tests/app/browser_runner.mjs tests/app/wizard_test.html part=android_service service=1
	node tests/app/browser_runner.mjs tests/app/console_test.html part=main
	node tests/app/browser_runner.mjs tests/app/console_test.html part=main worker=0
	node tests/app/browser_runner.mjs tests/app/console_test.html part=disk service=1
	node tests/app/browser_runner.mjs tests/app/suspend_test.html
	node tests/app/browser_runner.mjs tests/app/opfs_disk_test.html
	node tests/app/browser_runner.mjs tests/app/missing_image_test.html
	node tests/app/browser_runner.mjs tests/app/missing_image_test.html worker=0
	for part in page import share linux; do node tests/app/browser_runner.mjs tests/app/browser_disk_test.html part=$$part || exit 1; done

app-shared-tests: build/v86_app.js build/libv86.mjs
	node tests/app/machine_rules.mjs
	mkdir -p build/app
	node tests/app/legacy_options.mjs record=build/app/legacy-options.json
	node tests/app/shared_options.mjs build/app/legacy-options.json

.PHONY: disk-persistence-tests disk-persistence-browser-tests
disk-persistence-tests: build/v86-debug.wasm build/v86-arm64.wasm
	./tests/api/disk-options.js
	./tests/persistence/response_version.mjs
	./tests/devices/disk_error.mjs
	node tests/a64/virtio_blk_disk_error.mjs
	./tests/persistence/node_file.mjs
	./tests/devices/disk_writeback.mjs
	./tests/persistence/guest.mjs
	./tests/persistence/disk_service.mjs
	./tests/persistence/disk_service_sync.mjs
	./tests/persistence/service_machine.mjs
	./tests/persistence/floppy.mjs

disk-persistence-browser-tests: build/libv86.mjs build/cpu-worker.js build/v86.wasm $(DEVICE_PLUGINS)
	for worker in 0 1; do for part in d0 d2 close pagehide page; do \
		./tests/persistence/browser_runner.mjs worker=$$worker part=$$part || exit 1; done; done

all-tests: eslint kvm-unit-test qemutests qemutests-release jitpagingtests api-tests nasmtests nasmtests-force-jit rust-test tests
	# Skipping:
	# - devices-test (hangs)

eslint:
	eslint src tests gen lib examples tools

rustfmt: $(RUST_FILES)
	cargo fmt --all -- --check --config fn_single_line=true,control_brace_style=ClosingNextLine

build/capstone-x86.min.js:
	mkdir -p build
	wget -nv -P build https://github.com/AlexAltea/capstone.js/releases/download/v3.0.5-rc1/capstone-x86.min.js

# The page always loads the serial terminal; its CSS is included in v86.css.
# Never leave an empty/partial target behind when a download fails.
build/xterm.js:
	mkdir -p build
	curl --fail --location --retry 2 https://cdn.jsdelivr.net/npm/xterm@5.2.1/lib/xterm.min.js --output $@.tmp
	mv $@.tmp $@

build/xterm.js.map:
	mkdir -p build
	curl --fail --location --retry 2 https://cdn.jsdelivr.net/npm/xterm@5.2.1/lib/xterm.js.map --output $@.tmp
	mv $@.tmp $@

update-package-json-version:
	git describe --tags --exclude latest | sed 's/-/./' | tr - + | tee build/version
	jq --arg version "$$(cat build/version)" '.version = $$version' package.json > package.json.tmp
	mv package.json.tmp package.json

doc:
	set -e ;\
	COMMIT=`git log --format="%h" -n 1` ;\
	npx typedoc --readme none --customFooterHtml "Commit: <a href='https://github.com/speedyHKjournalist/v64/commits/$$COMMIT'><code>$$COMMIT</code></a>" --out ./docs/api ./v86.d.ts

denodoc:
	deno doc --html --name="v86 API" --output=./docs/api ./v86.d.ts

.PHONY: tests

.PHONY: packed-simd-tests
packed-simd-tests: build/jit-capacity.bin build/v86.wasm build/libv86.mjs
	node tests/rust/packed_simd.mjs

.PHONY: sse3-tests
sse3-tests: build/libv86.mjs build/jit-capacity.bin build/v86.wasm build/v86-fallback.wasm build/v86-debug.wasm
	node tests/rust/sse3.mjs
	node tests/rust/sse3.mjs build/v86-fallback.wasm
	node tests/rust/sse3.mjs build/v86-debug.wasm

# Keep the worker's public option/event wire names stable across bundles.
build/cpu-worker.js: $(DEVICE_PLUGINS) $(CLOSURE) src/*.js src/parallel/*.js src/arm/*.js src/virt/*.js src/image/*.js src/android/*.js src/browser/*.js lib/*.js
	mkdir -p build
	java -jar $(CLOSURE) --js_output_file $@ --define=DEBUG=false $(CLOSURE_FLAGS) \
		--compilation_level SIMPLE --jscomp_off=missingProperties \
		--js $(CORE_FILES) --js $(LIB_FILES) --js $(BROWSER_FILES) \
		--js src/browser/cpu_worker_runtime.js --js src/browser/cpu_worker_entry.js

# The vCPU workers of the host-parallel build (src/parallel/vcpu.js), paired
# with v86-parallel.wasm: `parallel: true` loads both next to the bundles
build/vcpu-worker.js: $(CLOSURE) src/*.js src/parallel/*.js src/arm/*.js src/virt/*.js src/image/*.js src/android/*.js src/browser/*.js lib/*.js
	mkdir -p build
	java -jar $(CLOSURE) --js_output_file $@ --define=DEBUG=false $(CLOSURE_FLAGS) \
		--compilation_level SIMPLE --jscomp_off=missingProperties \
		--js $(CORE_FILES) --js $(LIB_FILES) --js $(BROWSER_FILES) \
		--js src/parallel/vcpu_arm.js --js src/parallel/vcpu.js --js src/parallel/vcpu_worker_entry.js

.PHONY: parallel
parallel: build/v86-parallel.wasm build/vcpu-worker.js

build/cpu-worker-test.bin: tests/rust/cpu_worker.asm
	nasm -f bin $< -o $@

.PHONY: cpu-worker-tests
cpu-worker-tests: build/cpu-worker.js build/cpu-worker-test.bin build/libv86.mjs build/libv86.js build/v86_app.js build/v86.wasm build/v86-vmware-svga.js glbridge
	node tests/glbridge/cpu_worker_screen_test.mjs
	node tests/glbridge/gl_multipass_browser_runner.js cpu_worker_browser_test.html
	node tests/glbridge/gl_multipass_browser_runner.js cpu_worker_gpu_browser_test.html
	node tests/glbridge/gl_multipass_browser_runner.js cpu_worker_svga_browser_test.html
	node tests/glbridge/gl_multipass_browser_runner.js cpu_worker_audio_browser_test.html
	node tests/glbridge/speaker_unlock_browser_test.mjs
	node tests/glbridge/gl_multipass_browser_runner.js cpu_worker_hotplug_browser_test.html

# One canvas for text, graphics and composited D3D/GL windows (docs/display-design.md)
.PHONY: display-browser-tests
display-browser-tests: build/cpu-worker.js build/libv86.mjs build/libv86.js build/v86.wasm build/v86-debug.wasm glbridge
	node tests/glbridge/gl_multipass_browser_runner.js display_canvas_browser_test.html
	node tests/glbridge/gl_multipass_browser_runner.js "display_canvas_browser_test.html?worker=1"
	node tests/glbridge/gl_multipass_browser_runner.js display_text_glyphs_browser_test.html
	node tests/glbridge/gl_multipass_browser_runner.js display_compositor_browser_test.html
	node tests/glbridge/gl_multipass_browser_runner.js virtio_gpu_present_browser_test.html
	node tests/glbridge/gl_multipass_browser_runner.js graphics_vga_browser_test.html
	node tests/glbridge/gl_multipass_browser_runner.js svga_renderer_browser_test.html
	node tests/glbridge/gl_multipass_browser_runner.js gles_executor_browser_test.html
	node tests/glbridge/gl_multipass_browser_runner.js gles3_executor_browser_test.html
	node tests/glbridge/gl_multipass_browser_runner.js gles_shader_browser_test.html
	node tests/gles/chrome_renderer_test.mjs
	node tests/glbridge/gl_multipass_browser_runner.js svga_dx_browser_test.html
	node tests/glbridge/gl_multipass_browser_runner.js svga_share_browser_test.html
	node tests/glbridge/gl_multipass_browser_runner.js svga_fixed_function_browser_test.html
	node tests/glbridge/gl_multipass_browser_runner.js svga_gs_browser_test.html
	node tests/glbridge/gl_multipass_browser_runner.js svga_so_browser_test.html
	node tests/glbridge/gl_multipass_browser_runner.js svga_pull_browser_test.html
	node tests/glbridge/gl_multipass_browser_runner.js svga_depth_upload_browser_test.html
	node tests/glbridge/gl_multipass_browser_runner.js svga_msaa_browser_test.html
	node tests/glbridge/gl_multipass_browser_runner.js svga_cube_array_browser_test.html
	node tests/glbridge/gl_multipass_browser_runner.js svga_compute_browser_test.html
	node tests/glbridge/gl_multipass_browser_runner.js tessellator_browser_test.html
	node tests/glbridge/gl_multipass_browser_runner.js svga_tess_browser_test.html
	node tests/glbridge/gl_multipass_browser_runner.js vx_transfer_browser_test.html

# A browser/library rebuild must ship the matching wire-protocol implementation.
build/libv86.js build/libv86.mjs build/libv86-debug.js build/libv86-debug.mjs: | build/cpu-worker.js

# Keep the terminal available even when building the page bundle directly.
build/v86_app.js: | build/xterm.js

# The decoder catalogue's tables (src/rust/decode/encodings.rs)
.PHONY: decoder-generated decoder-generated-check
decoder-generated:
	node gen/generate_decoder.js

decoder-generated-check:
	node gen/generate_decoder.js --check

# CPU state layout: generated global_pointers.rs constants, src/state_layout.js,
# and the owner of every Rust static (gen/state_layout.js)
state-layout:
	node gen/state_layout.js

state-layout-check:
	node gen/state_layout.js --check

# Multicore building blocks (docs/multicore.md): state layout and core switching
build/smp/core_swap.bin: tests/smp/core_swap.asm
	mkdir -p build/smp
	nasm -f bin -o $@ $<

smp-tests: build/smp/core_swap.bin build/v86-debug.wasm
	node gen/state_layout.js --check
	./tests/smp/core_swap.mjs
	DISABLE_JIT=1 ./tests/smp/core_swap.mjs

build/smp/ap_startup.bin: tests/smp/ap_startup.asm
	mkdir -p build/smp
	nasm -f bin -o $@ $<

build/smp/firmware_boot.bin: tests/smp/firmware_boot.asm
	mkdir -p build/smp
	nasm -f bin -o $@ $<

# AP startup and interrupt routing; clock/topology/coherence gates below.
multicore-boot-tests: build/smp/ap_startup.bin build/smp/firmware_boot.bin build/v86-debug.wasm state-layout-check
	node tests/smp/apic_routing.mjs
	node tests/smp/scheduler.mjs
	node tests/smp/ap_startup.mjs
	node tests/smp/firmware_boot.mjs

multicore-boot-tests-release: build/smp/ap_startup.bin build/smp/firmware_boot.bin build/libv86.mjs build/v86.wasm state-layout-check
	TEST_RELEASE_BUILD=1 node tests/smp/apic_routing.mjs
	TEST_RELEASE_BUILD=1 node tests/smp/scheduler.mjs
	TEST_RELEASE_BUILD=1 node tests/smp/ap_startup.mjs
	TEST_RELEASE_BUILD=1 node tests/smp/firmware_boot.mjs

# Machine clock and cross-core coherence gates. OS tests are separate because they need Linux media.
multicore-clock-tests: build/v86-debug.wasm
	node tests/smp/clock.mjs
	node tests/smp/clock_execution.mjs

multicore-coherence-tests: build/v86-debug.wasm state-layout-check
	node tests/smp/coherence.mjs
	node tests/smp/lifecycle.mjs
	node tests/smp/exception_lifecycle.mjs
	node tests/smp/state_stream.mjs

multicore-clock-tests-release: build/libv86.mjs build/v86.wasm
	node tests/smp/clock.mjs
	TEST_RELEASE_BUILD=1 node tests/smp/clock_execution.mjs

multicore-coherence-tests-release: build/libv86.mjs build/v86.wasm state-layout-check
	TEST_RELEASE_BUILD=1 node tests/smp/coherence.mjs
	TEST_RELEASE_BUILD=1 node tests/smp/lifecycle.mjs
	TEST_RELEASE_BUILD=1 node tests/smp/exception_lifecycle.mjs
	TEST_RELEASE_BUILD=1 node tests/smp/state_stream.mjs

multicore-atomic-tests: build/v86-debug.wasm state-layout-check
	node tests/smp/atomic_boundaries.mjs

multicore-atomic-tests-release: build/libv86.mjs build/v86.wasm state-layout-check
	TEST_RELEASE_BUILD=1 node tests/smp/atomic_boundaries.mjs

multicore-memory-order-tests: build/v86-debug.wasm
	node tests/smp/memory_order.mjs

multicore-memory-order-tests-release: build/libv86.mjs build/v86.wasm
	TEST_RELEASE_BUILD=1 node tests/smp/memory_order.mjs

multicore-statistics-tests: build/v86-debug.wasm
	node tests/smp/core_statistics.mjs
	SMP_CORES=1 SMP_MODES=pages node tests/smp/core_statistics.mjs

multicore-statistics-tests-release: build/libv86.mjs build/v86.wasm
	TEST_RELEASE_BUILD=1 node tests/smp/core_statistics.mjs

multicore-os-stress-tests: build/v86-debug.wasm images/linux4.iso
	node tests/smp/os_stress.mjs

multicore-os-stress-tests-release: build/libv86.mjs build/v86.wasm images/linux4.iso
	TEST_RELEASE_BUILD=1 node tests/smp/os_stress.mjs

.PHONY: multicore-atomic-tests multicore-atomic-tests-release multicore-memory-order-tests multicore-memory-order-tests-release multicore-statistics-tests multicore-statistics-tests-release multicore-os-stress-tests multicore-os-stress-tests-release

.PHONY: multicore-clock-tests multicore-clock-tests-release multicore-coherence-tests multicore-coherence-tests-release

# Cores in vCPU workers (docs/multicore.md): the relocatable build under
# the cooperative suites, relocated instances in one memory, then cores in vCPU
# workers: litmus/IPI wake-ups, lifecycle and failures, Linux boot, the OS
# stress matrix and ACPI S3/S4 cycles
PARALLEL_ABI_SUITES=tests/smp/ap_startup.mjs tests/smp/core_swap.mjs tests/smp/apic_routing.mjs tests/smp/lifecycle.mjs \
	tests/smp/scheduler.mjs tests/smp/coherence.mjs tests/smp/atomic_boundaries.mjs tests/smp/memory_order.mjs \
	tests/smp/exception_lifecycle.mjs tests/smp/topology.mjs tests/x64/multicore.mjs
multicore-parallel-tests: build/v86-parallel.wasm build/smp/core_swap.bin build/smp/ap_startup.bin images/linux4.iso
	node tests/parallel/relocation.mjs
	node tests/x64/unaligned_parallel.mjs
	for t in $(PARALLEL_ABI_SUITES); do V86_WASM=build/v86-parallel.wasm node $$t || exit 1; done
	LITMUS_MODES=cooperative,cooperative-jit,parallel,parallel-jit LITMUS_CORES=2,4,8 LITMUS_ROUNDS=20000 node tests/parallel/litmus.mjs
	node tests/parallel/lifecycle.mjs
	DISABLE_JIT=1 node tests/parallel/lifecycle.mjs
	CPU_CORES=2 node tests/parallel/linux_boot.mjs
	CPU_CORES=4 node tests/parallel/linux_boot.mjs
	PARALLEL=1 SMP_SEEDS=1,2,3 SMP_QUANTUMS=4096 CPU_CORES=4 node tests/smp/os_stress.mjs
	PARALLEL=1 GUEST=linux4 CPU_CORES=4 S3_CYCLES=4 S4_CYCLES=2 node tests/devices/acpi_guest.js

# the bundles: libv86.mjs starts build/vcpu-worker.js
multicore-parallel-tests-release: build/v86-parallel.wasm build/vcpu-worker.js build/libv86.mjs images/linux4.iso
	TEST_RELEASE_BUILD=1 LITMUS_MODES=parallel,parallel-jit LITMUS_CORES=2,4,8 node tests/parallel/litmus.mjs
	TEST_RELEASE_BUILD=1 node tests/parallel/lifecycle.mjs
	TEST_RELEASE_BUILD=1 CPU_CORES=4 node tests/parallel/linux_boot.mjs

# headless Chrome: vCPU module workers with COOP/COEP, the "auto" fallback without
multicore-parallel-browser-tests: build/v86-parallel.wasm build/vcpu-worker.js build/libv86.mjs
	node tests/parallel/browser.mjs

# Throughput: fixed guest work on 1/2/4/8 cores, cooperative and in vCPU workers
multicore-parallel-bench: build/v86.wasm build/v86-parallel.wasm
	BENCH_REPORT=build/parallel-bench.json node tests/parallel/bench.mjs

.PHONY: multicore-parallel-tests multicore-parallel-tests-release multicore-parallel-browser-tests multicore-parallel-bench

# ACPI sleep states: S3 and OS-directed S4 cycles on 32-bit Linux (1 and 2 cores, JIT and
# interpreter) and on x86_64 Linux (Alpine's lts kernel has hibernation)
acpi-sleep-tests: build/v86-debug.wasm images/linux4.iso
	GUEST=linux4 S3_CYCLES=4 S4_CYCLES=2 ./tests/devices/acpi_guest.js
	GUEST=linux4 CPU_CORES=2 S3_CYCLES=4 S4_CYCLES=2 ./tests/devices/acpi_guest.js
	GUEST=linux4 DISABLE_JIT=1 S3_CYCLES=2 S4_CYCLES=1 ./tests/devices/acpi_guest.js
	X64_LINUX_FLAVOR=lts X64_JIT=1 X64_CORES=2 X64_LINUX_SLEEP=3 X64_LINUX_TIMEOUT=3600000 node tests/x64/linux_boot.mjs

# Platform contract: generated state layout, CPU profile options, topology,
# firmware tables (the ACPICA part needs iasl/acpiexec)
platform-contract-tests: build/v86-debug.wasm build/libv86.mjs build/v86.wasm build/v86-arm64.wasm
	node gen/state_layout.js --check
	node gen/cpu_features.js --check
	node tools/cpu_contract.mjs --check
	node tests/x64/profile_options.mjs
	node tests/x64/cpu_features.mjs
	node tests/smp/topology.mjs
	node tests/devices/acpi_tables.js

# Whole-machine state of several cores (snapshots, streams, reset,
# exceptions) and sleep states with 4 cores
multicore-state-tests: build/v86-debug.wasm images/linux4.iso
	node tests/smp/lifecycle.mjs
	node tests/smp/exception_lifecycle.mjs
	node tests/smp/state_stream.mjs
	node tests/smp/x64_snapshot.mjs
	GUEST=linux4 CPU_CORES=4 S3_CYCLES=4 S4_CYCLES=2 ./tests/devices/acpi_guest.js

# Extended RAM: guest RAM beyond the wasm32 backing store
extended-memory-tests: build/v86-debug.wasm
	node tests/x64/extended_memory.mjs
	X64_CORES=2 node tests/x64/extended_memory.mjs

x64-extended-guest-tests: build/libv86.mjs build/v86.wasm
	TEST_RELEASE_BUILD=1 X64_JIT=1 X64_CORES=2 X64_EXTENDED_MEMORY=6442450944 X64_LINUX_MEMTEST=5120 X64_LINUX_TIMEOUT=10800000 node tests/x64/linux_boot.mjs

# Release gate: every level's acceptance targets, with a report in build/release-gate/
# (GATE_ARGS: --levels R-base,R-ACPI,R-SMP32,R-x64-UP,R-x64-SMP,R-parallel,R-extended-memory,R-q35 --quick --keep-going)
platform-release-gate:
	node tools/release_gate.mjs $(GATE_ARGS)

# The local gates of docs/jit-unification-plan.md (P0.9, tools/jit_gate.mjs):
# jit-gate before each commit, jit-gate-full at a milestone's exit
.PHONY: jit-gate jit-gate-full core-split-check jit-core-tests
jit-gate:
	node tools/jit_gate.mjs $(JIT_GATE_ARGS)

jit-gate-full:
	node tools/jit_gate.mjs --full $(JIT_GATE_ARGS)

# Golden digests of the x86 leaf emitters (P2.1, tests/x86tpl)
.PHONY: jit-leaf-tests
jit-leaf-tests:
	env RUSTFLAGS="-D warnings" cargo test --lib leaf_digests

# The JIT switch registry (src/rust/jit_switches.rs, src/jit_switches.js)
.PHONY: jit-switch-tests
jit-switch-tests: build/v86-debug.wasm
	./tests/api/jit-switches.js

# build/v86.wasm of a base revision (default HEAD) against the working tree's,
# function by function (docs/arm64-virt-android16-plan.md P0.7)
# The generated code of both JITs, byte for byte, against a base
# (docs/jit-unification-plan.md P2.0): REPLAY_ARGS, e.g. --base REV;
# replay-record saves recordings of the benchmarks' compilations
replay-check: build/v86-ir-test-release.wasm
	node tools/replay_check.mjs $(REPLAY_ARGS) $(foreach f,$(wildcard build/replay/*.t0r build/replay/*.x6r),--records $(f))
replay-record: build/v86-ir-test-release.wasm build/libv86.mjs bench-build
	node tools/replay_record.mjs

core-split-check:
	node tools/core_split_check.mjs $(CORE_SPLIT_ARGS)

# The ARM64 plan's local gates (docs/arm64-virt-android16-plan.md P0.11,
# tools/a64_gate.mjs): a64-gate before each commit, a64-gate-full at a
# milestone's exit; the fixed QEMU reference comes from tools/a64_qemu/build.sh
.PHONY: a64-gate a64-gate-full a64-qemu-reference a64-reference-tests a64-kvm-unit-tests-qemu
a64-gate:
	node tools/a64_gate.mjs $(A64_GATE_ARGS)

a64-gate-full:
	node tools/a64_gate.mjs --full $(A64_GATE_ARGS)

a64-qemu-reference:
	tools/a64_qemu/build.sh

# The QEMU side of P0 (A0): bare-metal float, platform and ID register
# checks, Alpine's initramfs and live stages on 1/2/4 cores
a64-reference-tests:
	node tests/a64/float_ref.mjs
	node tests/a64/platform_probe.mjs
	node tools/cpu_contract.mjs --a64-reference
	for stage in initramfs live; do for cores in 1 2 4; do \
		A64_LINUX_QEMU=1 A64_STAGE=$$stage A64_CORES=$$cores node tests/a64/linux_boot.mjs || exit 1; done; done

a64-kvm-unit-tests-qemu:
	node tests/kvm-unit-tests/arm64.mjs --qemu

# The release levels R-a64-* and R-android (tools/release_gate.mjs): the
# targets that have no tests yet print A64_PENDING and the milestone that
# brings them, which the release gate reports as pending
A64_PENDING = @echo "A64_PENDING $@: arrives with $(1) (docs/arm64-virt-android16-plan.md)"
.PHONY: a64-decode-tests a64-isa-tests a64-native-tests a64-trace-tests a64-portable-tests a64-system-tests a64-mmu-tests \
	a64-kvm-unit-tests a64-litmus-tests a64-virt-device-tests a64-api-tests a64-guest-quick-tests a64-guest-tests \
	a64-lifecycle-guest-tests a64-multicore-guest-tests a64-page-tier-tests a64-jit-guest-tests a64-gpu-guest-tests \
	a64-parallel-tests a64-parallel-guest-tests a64-browser-tests a64-extended-guest-tests a64-pagesize-guest-tests \
	a64-android-prep-tests android-materials android-reference-tests android-guest-tests android-venus
a64-decode-tests: build/v86-arm64.wasm
	node tests/a64/oracle/decode.mjs --self-test
	RUST_TEST_THREADS=1 cargo test --features aarch64 aarch64::
	node tests/a64/decode_check.mjs
a64-isa-tests: build/v86-arm64.wasm
	node tests/a64/integer_oracle.mjs
	node tests/a64/simd_oracle.mjs
	node tests/a64/fp_oracle.mjs
	node tests/a64/crypto_oracle.mjs
	A64_TARGET=v86 node tests/a64/float_ref.mjs
# (P2.12: the FP, AdvSIMD and crypto cases on the host's arm64 CPU; macOS on arm64 only)
a64-native-tests: build/v86-arm64.wasm
	node tests/a64/native_oracle.mjs
# (L, P2.10: 10 million instructions sampled at EL0 from Alpine's workload on
# QEMU and replayed on the interpreter; every word QEMU translated decodes as llvm-mc decodes it)
a64-trace-tests: build/v86-arm64.wasm
	node tests/a64/trace_replay.mjs
# (the portable core, without Wasm SIMD: the ISA oracles and Alpine's initramfs stage on it)
a64-portable-tests: build/v86-arm64-fallback.wasm
	A64_WASM=build/v86-arm64-fallback.wasm node tests/a64/integer_oracle.mjs
	A64_WASM=build/v86-arm64-fallback.wasm node tests/a64/simd_oracle.mjs
	A64_WASM=build/v86-arm64-fallback.wasm node tests/a64/fp_oracle.mjs
	A64_WASM=build/v86-arm64-fallback.wasm node tests/a64/crypto_oracle.mjs
	A64_WASM=build/v86-arm64-fallback.wasm A64_STAGE=initramfs node tests/a64/linux_boot.mjs
# (P3.1, P3.2: the ID registers on v86, and the exceptions oracle against QEMU)
a64-system-tests: build/v86-arm64.wasm
	node tools/cpu_contract.mjs --a64-v86
	node tests/a64/system_oracle.mjs
a64-mmu-tests: build/v86-arm64.wasm
	node tests/a64/mmu.mjs
	node tests/a64/mmu.mjs --seed 2
	node tests/a64/mmu_granule.mjs
	node tests/a64/pan.mjs
# (L: every case on the interpreter, the SMP ones on its cooperative cores
# (P3.9), at 4k, and at 16k and 64k with the test profile v1.1)
a64-kvm-unit-tests: build/v86-arm64.wasm
	node tests/kvm-unit-tests/arm64.mjs
# (P3.9: MP, SB, LB, IRIW, 2+2W, exclusives, TLBI shootdown, SGI and WFE rings on 2 and 4 cooperative cores)
a64-litmus-tests: build/v86-arm64.wasm
	node tests/a64/litmus.mjs
a64-virt-device-tests: build/v86-arm64.wasm build/v86.wasm
	node tests/a64/core_loader.mjs
	node tests/a64/address_space.mjs
	node tests/a64/pl011_hello.mjs
	node tests/a64/dtb.mjs
	node tests/a64/linux_loader.mjs
	node tests/a64/device_io_reset.mjs
	node tests/a64/virtio_input_touch.mjs
	node tests/a64/virtio_blk_disk_image.mjs
	node tests/a64/virtio_blk_disk_error.mjs
	node tests/a64/virtio_blk_sector_size.mjs
	node tests/a64/extended_memory.mjs
# (api-tests' arm64 part)
a64-api-tests: build/libv86.js build/v86-arm64.wasm
	node tests/api/arm64-options.js
# (Alpine on the 1-core interpreter: the initramfs stage with the probe, about 40 s)
a64-guest-quick-tests: build/v86-arm64.wasm
	A64_STAGE=initramfs A64_CORES=1 node tests/a64/linux_boot.mjs
	node tests/a64/linux_sector_size.mjs
# (L: the QEMU reference, then the interpreter's initramfs, single,
# lifecycle and live stages: the live one from the ISO on virtio-blk to a
# login, the probe from its disk, virtio-net, -rng and -console, P5; then
# setup-disk -m sys and the installed system, with the page tier: its
# packages from tools/alpine_repo.mjs --arch aarch64 --set sys)
a64-guest-tests: build/v86-arm64.wasm
	A64_LINUX_QEMU=1 A64_STAGE=initramfs A64_CORES=1 node tests/a64/linux_boot.mjs
	A64_STAGE=initramfs A64_CORES=1 node tests/a64/linux_boot.mjs
	A64_STAGE=single A64_CORES=1 node tests/a64/linux_boot.mjs
	A64_STAGE=lifecycle A64_CORES=1 node tests/a64/linux_boot.mjs
	A64_LINUX_QEMU=1 A64_STAGE=live A64_CORES=1 node tests/a64/linux_boot.mjs
	A64_STAGE=live A64_CORES=1 node tests/a64/linux_boot.mjs
	A64_JIT=1 node tests/a64/linux_install.mjs
	A64_LINUX_QEMU=1 A64_STAGE=live A64_TRANSPORT=pci A64_CORES=1 node tests/a64/linux_boot.mjs
	A64_STAGE=live A64_TRANSPORT=pci A64_CORES=1 node tests/a64/linux_boot.mjs
	A64_JIT=1 A64_TRANSPORT=pci node tests/a64/linux_install.mjs
# (L, P8.1: snapshots at the probe's three markers, V7 and V6 in turn, for
# the interpreter and the page tier on 1, 2 and 4 cores, on virtio-mmio and
# virtio-pci; s2idle woken by the PL031's alarm and hibernation onto a swap
# disk with a power-on and resume, twice each)
a64-lifecycle-guest-tests: build/v86-arm64.wasm
	for jit in 0 1; do for cores in 1 2 4; do for transport in mmio pci; do \
		A64_JIT=$$jit A64_STAGE=live A64_LINUX_SNAPSHOT=1 A64_CORES=$$cores A64_TRANSPORT=$$transport node tests/a64/linux_boot.mjs || exit 1; \
	done; done; done
	for cores in 1 4; do for transport in mmio pci; do \
		A64_JIT=1 A64_STAGE=live A64_LINUX_SLEEP=2 A64_CORES=$$cores A64_TRANSPORT=$$transport node tests/a64/linux_boot.mjs || exit 1; \
	done; done
	A64_STAGE=live A64_LINUX_SLEEP=1 A64_CORES=1 node tests/a64/linux_boot.mjs
# (L: the initramfs stage on 2 and 4 cooperative cores, its kpti=1 variant
# on 1, 2 and 4, and the live stage on 2 and 4 against QEMU's)
a64-multicore-guest-tests: build/v86-arm64.wasm
	A64_STAGE=initramfs A64_CORES=2 node tests/a64/linux_boot.mjs
	A64_STAGE=initramfs A64_CORES=4 node tests/a64/linux_boot.mjs
	A64_STAGE=initramfs A64_KPTI=1 A64_CORES=1 node tests/a64/linux_boot.mjs
	A64_STAGE=initramfs A64_KPTI=1 A64_CORES=2 node tests/a64/linux_boot.mjs
	A64_STAGE=initramfs A64_KPTI=1 A64_CORES=4 node tests/a64/linux_boot.mjs
	for cores in 2 4; do A64_LINUX_QEMU=1 A64_STAGE=live A64_CORES=$$cores node tests/a64/linux_boot.mjs || exit 1; done
	for cores in 2 4; do A64_STAGE=live A64_CORES=$$cores node tests/a64/linux_boot.mjs || exit 1; done
	for cores in 2 4; do A64_LINUX_QEMU=1 A64_STAGE=live A64_TRANSPORT=pci A64_CORES=$$cores node tests/a64/linux_boot.mjs || exit 1; done
	for cores in 2 4; do A64_STAGE=live A64_TRANSPORT=pci A64_CORES=$$cores node tests/a64/linux_boot.mjs || exit 1; done
# (A4, JIT plan P6.5: random programs on the page tier against the
# interpreter; the FP fast path's hot multiply-add loop; the ISA, exceptions
# and MMU oracles with every instruction compiled (A64_JIT=1, threshold 1;
# A64_MMU=1: the bare-metal runtime turns the MMU on), the FP oracle with
# a64_relaxed_fma off and at its default; litmus on the page tier)
# (docs/aarch32-plan.md: profile v3's AArch32 EL0) the instructions against
# QEMU's cortex-a35 one by one, the EL0 cases (exits, the debug registers),
# the cases and random programs on the page tier against the interpreter,
# v86's CONSTRAINED UNPREDICTABLE choices against their values (QEMU's differ),
# the same C as A64, A32 and T32 (Q6.4's gate: 32-bit at most twice A64's
# time), Alpine armv7's
# programs on the 64-bit kernel against QEMU's output (the packages:
# tools/alpine_repo.mjs --arch armv7 --set aarch32), interpreted and compiled
a32-tests: a32-system-tests build/v86-arm64.wasm
	node tests/a64/aarch32_oracle.mjs
	for cases in q1 q3 q4; do A64_AARCH32_CASES=$$cases node tests/a64/aarch32_el0.mjs || exit 1; done
	A64_AARCH32_DRIVER=debug A64_AARCH32_CASES=qdebug node tests/a64/aarch32_el0.mjs
	node tests/a64/aarch32_page.mjs
	for seed in 1 2 3; do node tests/a64/aarch32_page_fuzz.mjs --seed $$seed || exit 1; done
	node tests/a64/aarch32_unpredictable.mjs
	node tests/a64/aarch32_bench.mjs --scale 0.3
	A64_PROFILE=v3 A64_WORKLOAD=aarch32 A64_CORES=1 node tests/a64/linux_boot.mjs
	A64_PROFILE=v3 A64_WORKLOAD=aarch32 A64_JIT=1 A64_JIT_SWITCHES=a64_page_aarch32=1 A64_CORES=1 node tests/a64/linux_boot.mjs
	A64_PROFILE=v3 A64_WORKLOAD=aarch32 A64_JIT=1 A64_JIT_SWITCHES=a64_page_aarch32=1 A64_PARALLEL=1 A64_CORES=4 node tests/a64/linux_boot.mjs

# cpu_type "arm32" (docs/arm32.md, docs/aarch32-plan.md part 2): PL1 at
# bare metal against QEMU's cortex-a15, the ranchu machine's devices, Alpine
# armv7's initramfs stage on 1/2/4 cores with the page tier (against the
# reference) and its lifecycle, kvm-unit-tests arm
a32-system-tests: build/v86-arm64.wasm
	node tests/a32/baremetal.mjs
	node tests/a32/ranchu_devices.mjs
	for cores in 1 2 4; do A32_JIT=1 A32_CORES=$$cores node tests/a32/linux_boot.mjs || exit 1; done
	A32_STAGE=lifecycle A32_JIT=1 A32_CORES=2 node tests/a32/linux_boot.mjs
	node tests/kvm-unit-tests/arm32.mjs

# the official Android 7.1.1 emulator image (armeabi-v7a-25_r18.zip in
# build/a32-android/) on ranchu to sys.boot_completed and the home screen,
# booted directly and from the imported disk (about 15 minutes each)
a32-android-tests: build/v86-arm64.wasm
	A32_ANDROID_APP=1 node tests/a32/android_boot.mjs
	A32_ANDROID_DISK=1 node tests/a32/android_boot.mjs

.PHONY: a32-system-tests a32-android-tests

a64-page-tier-tests: build/v86-arm64.wasm
	node tests/a64/page_fuzz.mjs
	node tests/a64/fma.mjs
	A64_JIT=1 A64_MMU=1 node tests/a64/integer_oracle.mjs
	A64_JIT=1 A64_MMU=1 node tests/a64/simd_oracle.mjs
	A64_JIT=1 A64_MMU=1 node tests/a64/fp_oracle.mjs
	A64_JIT=1 A64_MMU=1 A64_JIT_SWITCHES=a64_relaxed_fma=0 node tests/a64/fp_oracle.mjs
	A64_JIT=1 A64_MMU=1 node tests/a64/crypto_oracle.mjs
	A64_JIT=1 node tests/a64/system_oracle.mjs
	A64_JIT=1 node tests/a64/mmu.mjs
	A64_JIT=1 node tests/a64/litmus.mjs
# (L, A4: A2's and A3's Alpine stages with the page tier on 1, 2 and 4
# cores, kpti=1, the workload with a snapshot in its middle against QEMU's
# output, kvm-unit-tests at 4k, 16k and 64k, the live stage on 1, 2 and 4
# cores and with snapshots at three of the probe's markers, and P6.7's guest JIT workloads
# (V8, HotSpot, LuaJIT, PCRE2; their packages: tools/alpine_repo.mjs --arch
# aarch64 --set jit) against QEMU's output, also with a snapshot in their middle)
a64-jit-guest-tests: build/v86-arm64.wasm
	for cores in 1 2 4; do A64_JIT=1 A64_STAGE=initramfs A64_CORES=$$cores node tests/a64/linux_boot.mjs || exit 1; done
	for cores in 1 2 4; do A64_JIT=1 A64_STAGE=initramfs A64_KPTI=1 A64_CORES=$$cores node tests/a64/linux_boot.mjs || exit 1; done
	A64_JIT=1 A64_STAGE=single A64_CORES=1 node tests/a64/linux_boot.mjs
	A64_JIT=1 A64_STAGE=lifecycle A64_CORES=1 node tests/a64/linux_boot.mjs
	A64_LINUX_QEMU=1 A64_STAGE=initramfs A64_WORKLOAD=3 A64_CORES=2 node tests/a64/linux_boot.mjs
	A64_JIT=1 A64_STAGE=initramfs A64_WORKLOAD=3 A64_MIDWAY_SNAPSHOT=1 A64_CORES=2 node tests/a64/linux_boot.mjs
	A64_JIT=1 node tests/kvm-unit-tests/arm64.mjs
	for cores in 1 2 4; do A64_JIT=1 A64_STAGE=live A64_CORES=$$cores node tests/a64/linux_boot.mjs || exit 1; done
	A64_JIT=1 A64_STAGE=live A64_LINUX_SNAPSHOT=1 A64_CORES=2 node tests/a64/linux_boot.mjs
	for cores in 1 2 4; do A64_JIT=1 A64_STAGE=live A64_TRANSPORT=pci A64_CORES=$$cores node tests/a64/linux_boot.mjs || exit 1; done
	A64_JIT=1 A64_STAGE=live A64_TRANSPORT=pci A64_LINUX_SNAPSHOT=1 A64_CORES=2 node tests/a64/linux_boot.mjs
	A64_LINUX_QEMU=1 A64_STAGE=initramfs A64_WORKLOAD=jit A64_CORES=1 node tests/a64/linux_boot.mjs
	A64_JIT=1 A64_STAGE=initramfs A64_WORKLOAD=jit A64_CORES=1 node tests/a64/linux_boot.mjs
	A64_JIT=1 A64_STAGE=initramfs A64_WORKLOAD=jit A64_MIDWAY_SNAPSHOT=1 A64_CORES=1 node tests/a64/linux_boot.mjs
# (L, A5: Alpine on virtio-gpu without VGA, P7; the packages from
# `node tools/alpine_repo.mjs --arch aarch64`; the 3D levels on the GPU of a
# headless Chrome)
a64-gpu-guest-tests: build/v86-arm64.wasm glbridge
	for scenario in drm gl resize input; do GPU_SCENARIO=$$scenario node tests/a64/linux_gpu.mjs || exit 1; done
	for scenario in gltest virgl kms; do GPU_SCENARIO=$$scenario GPU_LEVEL=virgl43-hostmem GPU_RENDERER=chrome node tests/a64/linux_gpu.mjs || exit 1; done
	for scenario in venus vkcube; do GPU_SCENARIO=$$scenario GPU_LEVEL=venus GPU_RENDERER=chrome node tests/a64/linux_gpu.mjs || exit 1; done
	./tests/devices/virtio_gpu_gfxstream_render.js
	GPU_SCENARIO=drm GPU_TRANSPORT=mmio node tests/a64/linux_gpu.mjs
# (P8.2-P8.4: cores in vCPU workers) the litmus tests in all four modes on
# 2, 4 and 8 cores; the parallel build's page tier against the interpreter
a64-parallel-tests: build/v86-arm64.wasm build/v86-arm64-parallel.wasm
	LITMUS_MODES=cooperative,cooperative-jit,parallel,parallel-jit node tests/a64/litmus.mjs --cores 2,4,8 --rounds 20000
	for seed in 1 2 3; do A64_WASM=build/v86-arm64-parallel.wasm node tests/a64/page_fuzz.mjs --seed $$seed || exit 1; done
# Alpine with cores in workers: the initramfs stage interpreted and with the
# page tier on 2 and 4 cores, the live stage with snapshots on mmio and pci,
# reboot and poweroff, s2idle and hibernation, four workloads at once
a64-parallel-guest-tests: build/v86-arm64.wasm build/v86-arm64-parallel.wasm
	for jit in 0 1; do for cores in 2 4; do \
		A64_PARALLEL=1 A64_JIT=$$jit A64_STAGE=initramfs A64_CORES=$$cores node tests/a64/linux_boot.mjs || exit 1; \
	done; done
	for transport in mmio pci; do \
		A64_PARALLEL=1 A64_JIT=1 A64_STAGE=live A64_LINUX_SNAPSHOT=1 A64_CORES=4 A64_TRANSPORT=$$transport node tests/a64/linux_boot.mjs || exit 1; \
	done
	A64_PARALLEL=1 A64_JIT=1 A64_STAGE=lifecycle A64_CORES=4 node tests/a64/linux_boot.mjs
	A64_PARALLEL=1 A64_JIT=1 A64_STAGE=live A64_LINUX_SLEEP=1 A64_CORES=4 node tests/a64/linux_boot.mjs
	A64_PARALLEL=1 A64_JIT=1 A64_STAGE=initramfs A64_WORKLOAD=smp4 A64_CORES=4 node tests/a64/linux_boot.mjs
# (P8.7: Alpine aarch64 from its ISO in a headless Chrome: the source tree,
# the bundle, the CPU worker, virtio-pci; the files from linux_boot.mjs)
a64-browser-tests: build/v86-arm64.wasm build/libv86.mjs build/cpu-worker.js
	A64_LINUX_PREPARE_ONLY=1 A64_STAGE=live node tests/a64/linux_boot.mjs
	node tests/a64/browser.mjs
# (P8.5: guest RAM of 3 GiB and 4 GiB, extended RAM from 4 GiB: the probe's
# memtest over most of it, code, an exclusive counter and DC ZVA there)
a64-extended-guest-tests: build/v86-arm64.wasm
	node tests/a64/extended_memory.mjs
	A64_JIT=1 A64_MEMORY_MB=1024 A64_EXTENDED_MEMORY=2147483648 A64_LINUX_MEMTEST=2304 node tests/a64/linux_boot.mjs
	A64_JIT=0 A64_MEMORY_MB=1024 A64_EXTENDED_MEMORY=2147483648 A64_LINUX_MEMTEST=2304 node tests/a64/linux_boot.mjs
	A64_JIT=1 A64_CORES=2 A64_MEMORY_MB=1024 A64_EXTENDED_MEMORY=3221225472 A64_LINUX_MEMTEST=3328 node tests/a64/linux_boot.mjs
# (P8.6, P9.1, P9.2) the 16 and 64 KiB page kernels and the androidish one, built in an Alpine aarch64 VM under
# Homebrew QEMU with HVF (tools/a64_kernel.mjs: the source in build/a64-kernel/dl/,
# the toolchain from tools/alpine_repo.mjs --arch aarch64 --set kbuild)
.PHONY: a64-kernels
a64-kernels:
	node tools/a64_kernel.mjs --variants 16k,64k,androidish
# Each on 2 cores (TLBI broadcasts): the live stage to a login, interpreted
# and with the page tier, the probe reporting the page size; the guest JIT
# workloads, their output against the reference's (P6.7)
a64-pagesize-guest-tests: build/v86-arm64.wasm
	for kernel in 16k 64k; do \
		A64_KERNEL=$$kernel A64_JIT=1 A64_STAGE=live A64_CORES=2 node tests/a64/linux_boot.mjs || exit 1; \
		A64_KERNEL=$$kernel A64_STAGE=live A64_CORES=2 node tests/a64/linux_boot.mjs || exit 1; \
		A64_KERNEL=$$kernel A64_JIT=1 A64_STAGE=initramfs A64_WORKLOAD=jit node tests/a64/linux_boot.mjs || exit 1; \
	done
# (P9.1, P9.2: Android's kernel needs on Alpine) the androidish kernel
# (tools/a64_kernel.mjs --variants androidish) and its images: f2fs with
# fscrypt across a reboot, bootconfig, the minimal SELinux policy enforcing
# (the probe after it), binderfs's selftest, binder between two cores,
# userfaultfd, erofs on dm-verity, zram and PSI's trigger; interpreted and
# with the page tier, on 2 and 4 cores, with the cores in workers, and with
# 4 GiB of RAM (3 GiB of it extended); virtio-console's ports 1-3 are in
# every live stage
a64-android-prep-tests: build/v86-arm64.wasm build/v86-arm64-parallel.wasm
	for jit in 0 1; do for cores in 2 4; do \
		A64_KERNEL=androidish A64_JIT=$$jit A64_STAGE=initramfs A64_CORES=$$cores node tests/a64/linux_boot.mjs || exit 1; \
	done; done
	for jit in 0 1; do \
		A64_KERNEL=androidish A64_PARALLEL=1 A64_JIT=$$jit A64_STAGE=initramfs A64_CORES=4 node tests/a64/linux_boot.mjs || exit 1; \
	done
	A64_KERNEL=androidish A64_JIT=1 A64_STAGE=initramfs A64_CORES=2 A64_MEMORY_MB=1024 A64_EXTENDED_MEMORY=3221225472 \
		node tests/a64/linux_boot.mjs
# Android 16 (docs/arm64-virt-android16-plan.md P10): the pinned Cuttlefish
# build's materials (tools/a64_android.mjs: its downloads, about 1 GiB, with
# --download), on the QEMU reference to sys.boot_completed=1 (P10.3) and the
# GKI bridge's expected output (P10.6); then on v86 the bridge and Android to
# system_server and adbd over vsock (P10.7)
# (and P12.1's with the 16K kernel, P12.3's CTS modules: tools/a64_cts.mjs, byte ranges of the CTS zip with --download)
android-materials:
	node tools/a64_android.mjs
	node tools/a64_android.mjs --page-size 16k
	node tools/a64_cts.mjs --subset
android-reference-tests: android-materials
	A64_ANDROID_TARGET=qemu node tests/a64/android_boot.mjs
	A64_ANDROID_TARGET=qemu A64_ANDROID_SCENARIO=a9 node tests/a64/android_boot.mjs
	A64_ANDROID_TARGET=qemu A64_ANDROID_SCENARIO=a10 node tests/a64/android_boot.mjs
	A64_ANDROID_TARGET=qemu A64_ANDROID_SCENARIO=cts node tests/a64/android_boot.mjs
	A64_ANDROID_TARGET=qemu A64_ANDROID_SCENARIO=pagesize A64_ANDROID_PAGE_SIZE=16k node tests/a64/android_boot.mjs
	for cores in 1 4; do A64_KERNEL=gki A64_LINUX_QEMU=1 A64_STAGE=initramfs A64_CORES=$$cores node tests/a64/linux_boot.mjs || exit 1; done
# Official Android images (docs/android-images-plan.md, release level
# R-android-images): the image library's tests, then (long) the layouts
# the importer makes booted on QEMU (A64_ANDROID_ACCEL, hvf on this Mac:
# Cuttlefish as built, super shrunk with blank userdata, the BP4A GSI on
# it), then (long) the official zip and the GSI through the wizard in
# headless Chrome to boot_completed. The GSI zips are not downloaded here:
# build/a64-android/dl/gsi/ (the catalog's, tools/android_catalog.mjs).
ANDROID_GSI=build/a64-android/dl/gsi/aosp_arm64-exp-BP4A.251205.006-14401865-2171cf0e.zip
A64_ANDROID_ACCEL?=hvf
.PHONY: android-image-tests android-image-reference-tests android-image-browser-tests
android-image-tests:
	node tests/android/library.mjs
	node tests/android/real_images.mjs
	node tools/android_catalog.mjs
android-image-reference-tests: android-materials
	node tools/a64_android.mjs --release --no-venus --out build/a64-android/out-official
	node tools/a64_android.mjs --release --no-venus --shrink-super --userdata-mb 4096 --out build/a64-android/out-official-small
	node tools/a64_android.mjs --release --gsi $(ANDROID_GSI) --shrink-super --userdata-mb 4096 --out build/a64-android/out-gsi-bp4a-small
	for out in out-official out-official-small; do A64_ANDROID_ACCEL=$(A64_ANDROID_ACCEL) A64_ANDROID_OUT=build/a64-android/$$out node tests/a64/android_boot.mjs || exit 1; done
	A64_ANDROID_CONSOLE=0 A64_ANDROID_ACCEL=$(A64_ANDROID_ACCEL) A64_ANDROID_OUT=build/a64-android/out-gsi-bp4a-small node tests/a64/android_boot.mjs
	node tests/android/real_images.mjs
android-image-browser-tests: app android-materials
	TIMEOUT_MS=14400000 node tests/app/browser_runner.mjs tests/app/wizard_test.html part=android_boot isolated=1 timeout=220
	TIMEOUT_MS=14400000 node tests/app/browser_runner.mjs tests/app/wizard_test.html part=android_boot isolated=1 timeout=220 gsi=$(ANDROID_GSI)
	node tests/app/browser_runner.mjs tests/app/wizard_test.html part=android_cancel
# (A9's scenario on Venus: the guest's driver in the materials, the renderer in a headless Chrome)
android-guest-tests: android-venus android-materials build/v86-arm64.wasm build/v86-arm64-parallel.wasm glbridge
	for cores in 1 4; do A64_KERNEL=gki A64_JIT=1 A64_STAGE=initramfs A64_CORES=$$cores node tests/a64/linux_boot.mjs || exit 1; done
	A64_KERNEL=gki A64_JIT=0 A64_STAGE=initramfs A64_CORES=1 node tests/a64/linux_boot.mjs
	A64_ANDROID_TARGET=v86 A64_JIT=1 A64_PARALLEL=1 A64_CORES=4 node tests/a64/android_boot.mjs
	A64_ANDROID_TARGET=v86 A64_ANDROID_SCENARIO=a9 A64_ANDROID_GPU=venus A64_JIT=1 A64_PARALLEL=1 A64_CORES=4 node tests/a64/android_boot.mjs
	# (A10: the desktop saved by one run, restored by the next)
	A64_ANDROID_TARGET=v86 A64_ANDROID_SCENARIO=a10 A64_ANDROID_A10_SAVE=build/a64-android/a10-desktop.v7 \
		A64_ANDROID_GPU=venus A64_JIT=1 A64_PARALLEL=1 A64_CORES=4 node tests/a64/android_boot.mjs
	A64_ANDROID_TARGET=v86 A64_ANDROID_SCENARIO=a10 A64_ANDROID_RESTORE_STATE=build/a64-android/a10-desktop.v7 \
		A64_ANDROID_GPU=venus A64_JIT=1 A64_PARALLEL=1 A64_CORES=4 node tests/a64/android_boot.mjs
	# (P12.3's CTS subset; P12.1: the 16K kernel to boot_completed, native APKs aligned to 4 and 16 KiB)
	A64_ANDROID_TARGET=v86 A64_ANDROID_SCENARIO=cts A64_ANDROID_GPU=venus A64_JIT=1 A64_PARALLEL=1 A64_CORES=4 node tests/a64/android_boot.mjs
	A64_ANDROID_TARGET=v86 A64_ANDROID_SCENARIO=pagesize A64_ANDROID_PAGE_SIZE=16k A64_ANDROID_GPU=venus A64_JIT=1 A64_PARALLEL=1 A64_CORES=4 \
		node tests/a64/android_boot.mjs
# Mesa's venus driver for Android (P11.4): tools/a64_venus/build.mjs with the
# NDK (the pinned Mesa and libdrm tarballs, meson and mako with --download)
android-venus:
	node tools/a64_venus/build.mjs

# The JIT's and the decoder's tests outside the x64 targets (the R-JIT level
# of the release gate): the Rust unit tests, the Wasm builder's output, the
# decoder, the interpreter's REP engine and VERR flags, the decode rules
jit-core-tests: decoder-generated-check build/v86-ir-test.wasm build/v86-ir-test-release.wasm build/libv86.mjs build/jit-capacity.bin
	env RUSTFLAGS="-D warnings" cargo test
	node tests/rust/verify-wasmgen-dummy-output.js
	$(MAKE) decode-tests rep-engine-tests verr-flags-tests decode-rules-tests

.PHONY: acpi-sleep-tests platform-contract-tests multicore-state-tests extended-memory-tests x64-extended-guest-tests platform-release-gate

.PHONY: state-layout state-layout-check smp-tests multicore-boot-tests multicore-boot-tests-release

# x86-64 (docs/x86-64.md). The oracle
# targets need nasm and qemu-system-x86_64; linux targets download the pinned
# Alpine ISO on first use and run for several minutes on the interpreter.
x64-decode-tests: state-layout-check
	cargo test x64::
	cargo test simd_corpus -- --nocapture
	CARGO_TARGET_DIR=build/x64-oracle-target cargo run --manifest-path tests/x64/oracle/Cargo.toml --release

x64-system-tests: build/v86-debug.wasm
	node tests/x64/system_oracle.mjs
	node tests/x64/irq_boundary.mjs
	node tests/x64/smm_long_mode.mjs
	node tests/x64/smm_entry_state.mjs
	node tests/x64/triple_fault.mjs
	node tests/x64/direct_loader.mjs
	node tests/x64/profile_options.mjs
	node tests/x64/protected_mode_msrs.mjs
	node tests/x64/protected_mode_rdtscp.mjs
	node tests/x64/task_faults.mjs

x64-differential-tests: build/v86-debug.wasm
	node tests/x64/integer_oracle.mjs
	node tests/x64/vector_oracle.mjs
	node tests/x64/cache_oracle.mjs
	node tests/x64/rep_strings.mjs

# The x64 page tier (x64::pagegen/pages): QEMU and interpreter references,
# and random programs compared with the interpreter.
# WOW64 (IA-32e compatibility mode) code under the JIT, docs/jit-unification-plan.md
# M4's gate set: compiled 32-bit code with remapped and patched pages (and,
# until P7.5, pages compiled from long-mode frames, x64_long_visit). On the owner's Windows
# 8.1 image the set adds PROBE32 (tests/x64/windows_boot.mjs) and CPULOAD32
# (WIN_CPULOAD32, tools/owner_perf.mjs).
x64-wow64-tests: build/v86-debug.wasm
	node tests/x64/compat_jit.mjs
	COMPAT_FUZZ_SEED=1 COMPAT_FUZZ_GUESTS=3 node tests/x64/compat_fuzz.mjs
	COMPAT_FUZZ_SEED=2 COMPAT_FUZZ_GUESTS=3 node tests/x64/compat_fuzz.mjs
	JIT_SWITCHES=x64_loops=1 COMPAT_FUZZ_SEED=3 COMPAT_FUZZ_GUESTS=3 node tests/x64/compat_fuzz.mjs

x64-page-tier-tests: build/v86-debug.wasm
	X64_JIT=1 node tests/x64/integer_oracle.mjs
	X64_JIT=pages node tests/x64/vector_oracle.mjs
	JIT_SWITCHES=x64_cvt=0 X64_JIT=1 X64_VECTOR_FILTER=cvt node tests/x64/vector_oracle.mjs
	X64_JIT=1 node tests/x64/system_oracle.mjs
	X64_JIT=1 X64_IR_TIER0=0 node tests/x64/system_oracle.mjs
	node tests/x64/page_system.mjs
	node tests/x64/frame_buffer.mjs
	node tests/x64/compat_jit.mjs
	node tests/x64/initial_ram.mjs
	node tests/x64/step_profile.mjs
	node tests/x64/step_events.mjs
	node tests/x64/accounting.mjs
	node tests/x64/xmm_state.mjs
	node tests/x64/kept_translations.mjs
	node tests/x64/mode_ledger.mjs
	PAGE_FUZZ_SEED=1 PAGE_FUZZ_GUESTS=4 node tests/x64/page_fuzz.mjs
	PAGE_FUZZ_SEED=2 PAGE_FUZZ_GUESTS=4 node tests/x64/page_fuzz.mjs
	PAGE_FUZZ_SEED=3 PAGE_FUZZ_GUESTS=4 node tests/x64/page_fuzz.mjs
	for seed in 1 2 3; do SSE_FP_SEED=$$seed node tests/x64/sse_fp_template.mjs || exit 1; done
	SSE_FP_ORDINARY=1 node tests/x64/sse_fp_template.mjs
	for seed in 1 2 3; do SSE_INT_SEED=$$seed node tests/x64/sse_int_template.mjs || exit 1; done

# The x64 page tier on legacy protected-mode code (x64_page_legacy32,
# docs/jit-unification-plan.md P7.3): the differential tests written for IR
# Tier-0 (ir-tier0-tests until P7.5 deleted it; the tier0_ names stay), run
# on it: random programs of each instruction kind against the interpreter
# (tier0_fuzz.mjs, FUZZ_KIND), faults, interrupts, the step profile and the
# mode ledger.
.PHONY: x64-legacy32-tests
x64-legacy32-tests: bench-build build/v86.wasm build/libv86.mjs build/jit-capacity.bin
	node tests/ir/differential/tier0_fuzz.mjs 60 1
	for kind in i0 i10 i13 i19 i22 i26 s3 s7 s10 x; do FUZZ_KIND=$$kind node tests/ir/differential/tier0_fuzz.mjs 6 2 || exit 1; done
	# (packed SSE arithmetic of random values: the page tier retries lanes
	# its templates refuse in the interpreter, where IR Tier-0 ran its exact
	# helper in place, so about half of it runs outside page functions)
	FUZZ_KIND=s1 FUZZ_COVERAGE=0.25 node tests/ir/differential/tier0_fuzz.mjs 6 2
	for kind in j g e d o a m v c p r b s11 s12 s13; do FUZZ_KIND=$$kind node tests/ir/differential/tier0_fuzz.mjs 20 1 || exit 1; done
	FUZZ_KIND=r node tests/ir/differential/tier0_fuzz.mjs 20 3
	FUZZ_STRADDLE=1 node tests/ir/differential/tier0_fuzz.mjs 20 2
	node tests/ir/differential/sse_fp_tracking.mjs build/v86.wasm
	node tests/ir/differential/tier0_fetch_fault.mjs
	node tests/ir/differential/tier0_rep_fault.mjs
	node tests/ir/differential/tier0_irq_slow.mjs
	node tests/ir/differential/tier0_segment_fault.mjs
	node tests/ir/differential/tier0_step_profile.mjs
	node tests/ir/differential/tier0_mode_ledger.mjs
	node tests/ir/differential/page_smc.mjs
	node tests/ir/differential/page_vector_ts.mjs
	node tests/ir/differential/page_step_budget.mjs
	node tests/ir/differential/page_x87_cw.mjs
	node tests/ir/differential/page_crossing.mjs
	# (multi-page functions, x64_page_clusters: P7.3b; spans form after one
	# crossing)
	for kind in "" m s13; do FUZZ_KIND=$$kind JIT_SWITCHES=x64_span_crossings=1,x64_span_entries=4096 node tests/ir/differential/tier0_fuzz.mjs 20 1 || exit 1; done
	FUZZ_STRADDLE=1 JIT_SWITCHES=x64_span_crossings=1,x64_span_entries=4096 node tests/ir/differential/tier0_fuzz.mjs 20 2
	node tests/ir/differential/tier0_span_remap.mjs
	# (16-bit protected-mode code, x64_page_prot16: P7.7)
	node tests/ir/differential/prot16_fuzz.mjs 40 1
	for kind in a m s j g x f l z c; do FUZZ_KIND=$$kind node tests/ir/differential/prot16_fuzz.mjs 12 2 || exit 1; done
	FUZZ_STRADDLE=1 node tests/ir/differential/prot16_fuzz.mjs 20 3
	# (real-mode and virtual-8086 code, x64_page_v86: P7.8; at most 24 cases
	# a run, below 1 MiB)
	for mode in real v86; do FUZZ_MODE=$$mode node tests/ir/differential/prot16_fuzz.mjs 24 1 || exit 1; done
	for kind in a m s j g x f l c; do for mode in real v86; do FUZZ_MODE=$$mode FUZZ_KIND=$$kind node tests/ir/differential/prot16_fuzz.mjs 10 2 || exit 1; done; done
	FUZZ_MODE=v86 FUZZ_KIND=i node tests/ir/differential/prot16_fuzz.mjs 12 2
	FUZZ_MODE=v86 FUZZ_KIND=k node tests/ir/differential/prot16_fuzz.mjs 12 3
	for mode in real v86; do FUZZ_MODE=$$mode FUZZ_STRADDLE=1 node tests/ir/differential/prot16_fuzz.mjs 20 3 || exit 1; done
	# (a stack of the other width than the code's: M11)
	FUZZ_MODE=prot16ss32 node tests/ir/differential/prot16_fuzz.mjs 30 1
	FUZZ_MODE=prot16ss32 FUZZ_STRADDLE=1 node tests/ir/differential/prot16_fuzz.mjs 20 3
	for mode in prot16 prot16ss32; do FUZZ_MODE=$$mode FUZZ_KIND=y node tests/ir/differential/prot16_fuzz.mjs 12 2 || exit 1; done
	FUZZ_MODE=prot16ss32 FUZZ_KIND=f node tests/ir/differential/prot16_fuzz.mjs 12 2
	# (far calls and returns between 16-bit code and flat 32-bit code, which
	# chain across the page tier's modes, M11; with the mode ledger on they
	# leave)
	for mode in prot16 prot16ss32; do FUZZ_FAR32=1 FUZZ_MODE=$$mode FUZZ_KIND=f node tests/ir/differential/prot16_fuzz.mjs 12 2 || exit 1; done
	FUZZ_FAR32=1 FUZZ_MODE=prot16 node tests/ir/differential/prot16_fuzz.mjs 20 4
	JIT_SWITCHES=mode_ledger=1 FUZZ_FAR32=1 FUZZ_MODE=prot16ss32 FUZZ_KIND=f node tests/ir/differential/prot16_fuzz.mjs 8 5
	FUZZ_SS16=1 node tests/ir/differential/tier0_fuzz.mjs 30 1
	for kind in p j g m; do FUZZ_SS16=1 FUZZ_KIND=$$kind node tests/ir/differential/tier0_fuzz.mjs 20 3 || exit 1; done
	FUZZ_SS16=1 FUZZ_STRADDLE=1 node tests/ir/differential/tier0_fuzz.mjs 20 4

# Every long-mode encoding of the opcode map executed at CPL3; needs the
# expectations written by x64-decode-tests.
x64-opcode-matrix-tests: build/v86-debug.wasm x64-decode-tests
	node tests/x64/opcode_matrix.mjs

highmem-tests: build/v86-debug.wasm
	node tests/smp/physical_bus.mjs
	node tests/smp/virtio_high_dma.mjs
	node tests/smp/x64_snapshot.mjs
	node tests/smp/legacy_low_hole.mjs
	node tests/x64/high_memory.mjs

x64-multicore-tests: build/v86-debug.wasm
	node tests/x64/multicore.mjs

x64-guest-tests: build/v86-debug.wasm
	X64_LINUX_QEMU=1 X64_LINUX_TIMEOUT=180000 node tests/x64/linux_boot.mjs
	X64_LINUX_TIMEOUT=3600000 node tests/x64/linux_boot.mjs
	X64_JIT=1 X64_LINUX_SNAPSHOT=1 X64_LINUX_LIFECYCLE=1 X64_LINUX_TIMEOUT=1800000 node tests/x64/linux_boot.mjs
	X64_HIGH_MEMORY=134217728 X64_LINUX_QEMU=1 X64_LINUX_TIMEOUT=180000 node tests/x64/linux_boot.mjs
	X64_HIGH_MEMORY=134217728 X64_JIT=1 X64_LINUX_TIMEOUT=1800000 node tests/x64/linux_boot.mjs

# The real-guest acceptance of docs/simd-xsave-plan.md 11.3 (P12): Alpine
# x86_64 running glibc 2.39's x86-64-v3 code (ld.so's levels, glibc-hwcaps,
# the IFUNC choices and their results as QEMU's) and the YMM registers across
# context switches, page tier: x86-64-v3 with the XSAVE family on one core,
# on two with snapshots and on two in vCPU workers, AVX alone, x86-64-v2, and
# x86-64-v3 under noxsave
X64_V3_FEATURES = SSSE3,SSE4.1,SSE4.2,XSAVE,AVX,AVX2,FMA,F16C,BMI1,BMI2,LZCNT,MOVBE,XSAVEOPT,XSAVEC,XGETBV1,XSAVES
X64_LINUX_DEFAULT_CMDLINE = console=ttyS0,115200 earlyprintk=serial,ttyS0,115200 loglevel=7 nokaslr panic=-1 modules=loop,squashfs,sd-mod,usb-storage
.PHONY: x64-glibc-tests
x64-glibc-tests: build/libv86.mjs build/v86.wasm build/v86-parallel.wasm build/vcpu-worker.js
	TEST_RELEASE_BUILD=1 X64_JIT=1 X64_LINUX_GLIBC=1 X64_CPU_FEATURES=$(X64_V3_FEATURES) X64_LINUX_TIMEOUT=1800000 node tests/x64/linux_boot.mjs
	TEST_RELEASE_BUILD=1 X64_JIT=1 X64_CORES=2 X64_LINUX_SNAPSHOT=1 X64_LINUX_GLIBC=1 X64_CPU_FEATURES=$(X64_V3_FEATURES) X64_LINUX_TIMEOUT=1800000 node tests/x64/linux_boot.mjs
	TEST_RELEASE_BUILD=1 X64_JIT=1 X64_CORES=2 X64_PARALLEL=1 X64_LINUX_GLIBC=1 X64_CPU_FEATURES=$(X64_V3_FEATURES) X64_LINUX_TIMEOUT=1800000 node tests/x64/linux_boot.mjs
	TEST_RELEASE_BUILD=1 X64_JIT=1 X64_LINUX_GLIBC=1 X64_CPU_FEATURES=SSSE3,SSE4.1,SSE4.2,XSAVE,AVX X64_LINUX_TIMEOUT=1800000 node tests/x64/linux_boot.mjs
	TEST_RELEASE_BUILD=1 X64_JIT=1 X64_LINUX_GLIBC=1 X64_CPU_FEATURES=SSSE3,SSE4.1,SSE4.2 X64_LINUX_TIMEOUT=1800000 node tests/x64/linux_boot.mjs
	TEST_RELEASE_BUILD=1 X64_JIT=1 X64_LINUX_GLIBC=1 X64_CPU_FEATURES=$(X64_V3_FEATURES) X64_LINUX_CMDLINE="$(X64_LINUX_DEFAULT_CMDLINE) noxsave" X64_LINUX_TIMEOUT=1800000 node tests/x64/linux_boot.mjs

x64-multicore-guest-tests: build/v86-debug.wasm
	X64_CORES=4 X64_LINUX_QEMU=1 X64_LINUX_TIMEOUT=180000 node tests/x64/linux_boot.mjs
	X64_CORES=2 X64_JIT=1 X64_LINUX_TIMEOUT=1800000 node tests/x64/linux_boot.mjs
	X64_CORES=4 X64_JIT=1 X64_LINUX_SNAPSHOT=1 X64_LINUX_LIFECYCLE=1 X64_LINUX_TIMEOUT=1800000 node tests/x64/linux_boot.mjs

# The same Linux configurations on the interpreter alone (hours for 2+ cores).
x64-guest-interpreter-tests: build/v86-debug.wasm
	X64_CORES=2 X64_LINUX_TIMEOUT=7200000 node tests/x64/linux_boot.mjs
	X64_CORES=4 X64_LINUX_TIMEOUT=14400000 node tests/x64/linux_boot.mjs

.PHONY: x64-decode-tests x64-system-tests x64-differential-tests x64-page-tier-tests x64-wow64-tests x64-opcode-matrix-tests highmem-tests x64-multicore-tests x64-guest-tests x64-multicore-guest-tests x64-guest-interpreter-tests

# The decoder catalogue (src/rust/decode, gen/generate_decoder.js): every
# encoding/ModRM/SIB form, instruction boundaries against NDISASM, the staged
# ModRM resolver of the interpreter and VEX by mode
.PHONY: decode-tests
decode-tests: decoder-generated-check build/v86-ir-test.wasm build/v86-ir-test-release.wasm build/libv86.mjs build/jit-capacity.bin
	cargo test decode::tests -- --nocapture
	node tests/decode/oracle.mjs
	node tests/decode/staged.mjs
	node tests/decode/staged.mjs build/v86-ir-test-release.wasm

# Test cores: build/v86.wasm's code with the differential hooks (ir-test-hooks:
# an interpreter step, the staged ModRM resolver, the REP engine's batches and
# the page tier's recording and replay)
build/v86-ir-test.wasm: $(RUST_FILES) build/softfloat.o build/zstddeclib.o Cargo.toml
	cargo rustc --features ir-test-hooks $(CARGO_FLAGS)
	cp build/wasm32-unknown-unknown/debug/v86.wasm $@

build/v86-ir-test-release.wasm: $(RUST_FILES) build/softfloat.o build/zstddeclib.o Cargo.toml
	cargo rustc --release --features ir-test-hooks $(CARGO_FLAGS)
	cp build/wasm32-unknown-unknown/release/v86.wasm $@

# The parallel build's test core (docs/jit-unification-plan.md P5.0): the
# replay identity of the generated code with atomic guest memory
build/v86-ir-test-parallel.wasm: $(RUST_FILES) build/softfloat.o build/zstddeclib.o Cargo.toml tools/parallel_wasm.mjs
	CARGO_TARGET_DIR=build/parallel-test cargo rustc --release --features ir-test-hooks,parallel $(CARGO_FLAGS_PARALLEL)
	./tools/parallel_wasm.mjs build/parallel-test/wasm32-unknown-unknown/release/v86.wasm $@

# The pinned resolver is compiled into test cores via #[path].
build/v86-ir-test.wasm build/v86-ir-test-release.wasm build/v86-ir-test-parallel.wasm build/v86-rep-reference.wasm: tests/decode/legacy_modrm.rs

# The interpreter's REP engine in bounded batches against the pinned
# pre-refactor string body (tests/ir/differential/build_rep_reference.py)
.PHONY: rep-engine-tests
build/v86-rep-reference.wasm: $(RUST_FILES) Cargo.toml build/softfloat.o build/zstddeclib.o tests/ir/differential/build_rep_reference.py
	python3 tests/ir/differential/build_rep_reference.py

rep-engine-tests: build/v86-ir-test.wasm build/v86-rep-reference.wasm build/libv86.mjs build/jit-capacity.bin
	node tests/ir/differential/rep_engine.mjs

# VERR/VERW in the interpreter: the computed ZF against the raw flag
.PHONY: verr-flags-tests
verr-flags-tests: build/v86-ir-test.wasm build/v86-ir-test-release.wasm build/libv86.mjs build/jit-capacity.bin
	node tests/ir/differential/verr_flags_baseline.mjs

.PHONY: jit-disabled-tests
jit-disabled-tests: build/v86-debug.wasm build/v86.wasm build/libv86.mjs build/cpu-worker-test.bin
	node tests/rust/jit_disabled_promotion.mjs build/v86-debug.wasm
	node tests/rust/jit_disabled_promotion.mjs build/v86.wasm

# Topology: CPUID and firmware-input agreement, followed by real 32-bit Linux SMP.
build/smp/affinity_probe: tests/smp/affinity_probe.asm
	mkdir -p build/smp
	nasm -f bin $< -o $@

multicore-topology-tests: build/v86-debug.wasm state-layout-check
	node tests/smp/topology.mjs

multicore-topology-tests-release: build/libv86.mjs build/v86.wasm state-layout-check
	TEST_RELEASE_BUILD=1 node tests/smp/topology.mjs

multicore-linux-tests: build/smp/affinity_probe build/v86-debug.wasm images/linux4.iso
	node tests/smp/linux_topology.mjs

multicore-linux-tests-release: build/smp/affinity_probe build/libv86.mjs build/v86.wasm images/linux4.iso
	TEST_RELEASE_BUILD=1 node tests/smp/linux_topology.mjs

.PHONY: multicore-topology-tests multicore-topology-tests-release multicore-linux-tests multicore-linux-tests-release

multicore-linux-jit-tests: build/smp/affinity_probe build/v86-debug.wasm images/linux4.iso
	SMP_JIT_MODE=pages node tests/smp/linux_topology.mjs

multicore-linux-jit-tests-release: build/smp/affinity_probe build/libv86.mjs build/v86.wasm images/linux4.iso
	TEST_RELEASE_BUILD=1 SMP_JIT_MODE=pages node tests/smp/linux_topology.mjs

.PHONY: multicore-linux-jit-tests multicore-linux-jit-tests-release

# SSSE3 to x86-64-v3 and XSAVE (docs/simd-xsave-plan.md). gen/isa_forms.json
# lists the target instruction forms, generated from the pinned iced-x86 like
# the x64 decode oracle; gen/cpu_features.js holds the CPUID features of the
# plan and their dependencies.
isa-forms:
	CARGO_TARGET_DIR=build/isa-forms-target cargo run --release --manifest-path tools/isa_forms/Cargo.toml -- gen/isa_forms.json

isa-forms-check:
	CARGO_TARGET_DIR=build/isa-forms-target cargo run --release --manifest-path tools/isa_forms/Cargo.toml -- --check gen/isa_forms.json
	node gen/cpu_features.js --check

# gen/isa_hot_forms.json: the forms the x86-64 glibc uses (plan 5.1), from
# the unpacked libc6 package named in that file
ISA_GLIBC ?= build/simd-xsave/p0-baseline/glibc/root/usr/lib/x86_64-linux-gnu
isa-hot-forms:
	CARGO_TARGET_DIR=build/isa-forms-target cargo run --release --manifest-path tools/isa_forms/Cargo.toml -- --hot gen/isa_hot_forms.json $(ISA_GLIBC)/libc.so.6 $(ISA_GLIBC)/libm.so.6 $(ISA_GLIBC)/ld-linux-x86-64.so.2

# The decode rules of the plan (5.2) on the 32-bit interpreter and the page
# tier: mandatory prefixes, F2/F3 order, #UD for unlisted prefixes
decode-rules-tests: build/libv86.mjs build/jit-capacity.bin build/v86.wasm build/v86-debug.wasm build/v86-ir-test.wasm build/v86-ir-test-release.wasm
	node tests/rust/decode_rules.mjs
	node tests/rust/decode_rules.mjs build/v86-debug.wasm
	node tests/decode/vex_modes.mjs
	node tests/decode/vex_modes.mjs build/v86-ir-test-release.wasm

# The XSAVE feature set (docs/simd-xsave-plan.md P2): the 32-bit engines,
# the x64 engine and compatibility mode, snapshots, INIT and reset
xsave-tests: build/libv86.mjs build/jit-capacity.bin build/v86.wasm build/v86-debug.wasm
	node tests/rust/xsave.mjs
	node tests/rust/xsave.mjs build/v86-debug.wasm
	node tests/x64/xsave.mjs
	TEST_RELEASE_BUILD=1 node tests/x64/xsave.mjs
	node tests/smp/xstate_lifecycle.mjs
	TEST_RELEASE_BUILD=1 node tests/smp/xstate_lifecycle.mjs

# SSSE3 (docs/simd-xsave-plan.md P3): the 32-bit engines against a model of
# the SDM (with Wasm SIMD, debug, and without SIMD), the x64 engine against
# QEMU and the model
ssse3-tests: build/libv86.mjs build/jit-capacity.bin build/v86.wasm build/v86-debug.wasm build/v86-fallback.wasm
	node tests/rust/ssse3.mjs
	node tests/rust/ssse3.mjs build/v86-debug.wasm
	node tests/rust/ssse3.mjs build/v86-fallback.wasm
	node tests/x64/ssse3.mjs
	TEST_RELEASE_BUILD=1 node tests/x64/ssse3.mjs

# Exact SSE floating point in the 32-bit engines against an independent model
# (docs/simd-xsave-plan.md 7.4, P4a), and what Tier-0 knows about registers.
.PHONY: sse-fp-tests
sse-fp-tests: build/libv86.mjs build/jit-capacity.bin build/v86.wasm build/v86-debug.wasm build/v86-fallback.wasm
	node tests/rust/sse_fp.mjs
	node tests/rust/sse_fp.mjs build/v86-fallback.wasm
	node tests/rust/sse_fp.mjs build/v86-debug.wasm
	node tests/ir/differential/sse_fp_tracking.mjs

# SSE4.1 and SSE4.2 (docs/simd-xsave-plan.md P4b): the 32-bit engines against a
# model of the SDM (with Wasm SIMD, debug, and without SIMD), the x64 engine
# against QEMU and the model
.PHONY: sse4-tests
sse4-tests: build/libv86.mjs build/jit-capacity.bin build/v86.wasm build/v86-debug.wasm build/v86-fallback.wasm
	node tests/rust/sse4.mjs
	node tests/rust/sse4.mjs build/v86-debug.wasm
	node tests/rust/sse4.mjs build/v86-fallback.wasm
	node tests/x64/sse4.mjs
	TEST_RELEASE_BUILD=1 node tests/x64/sse4.mjs

# AVX (docs/simd-xsave-plan.md P5-P6): the 32-bit engines against a model of
# the SDM (with Wasm SIMD, debug, and without SIMD; floating point with every
# MXCSR setting in avx_fp.mjs), the x64 engine and compatibility mode against
# QEMU and the model
.PHONY: avx-tests
avx-tests: build/libv86.mjs build/jit-capacity.bin build/v86.wasm build/v86-debug.wasm build/v86-fallback.wasm build/v86-parallel.wasm build/vcpu-worker.js
	node tests/rust/avx.mjs
	node tests/rust/avx.mjs build/v86-debug.wasm
	node tests/rust/avx.mjs build/v86-fallback.wasm
	node tests/rust/avx_fp.mjs
	node tests/rust/avx_fp.mjs build/v86-debug.wasm
	node tests/rust/avx_fp.mjs build/v86-fallback.wasm
	node tests/x64/avx.mjs
	TEST_RELEASE_BUILD=1 node tests/x64/avx.mjs

# BMI1, BMI2, TZCNT, LZCNT and MOVBE (docs/simd-xsave-plan.md P10): the
# 32-bit engines against a bit-level model of the SDM (release and debug
# builds), the x64 engine (interpreted, page tier, compatibility-mode Tier-0)
# against QEMU and the model
.PHONY: bmi-tests
bmi-tests: build/libv86.mjs build/jit-capacity.bin build/v86.wasm build/v86-debug.wasm
	node tests/rust/bmi.mjs
	node tests/rust/bmi.mjs build/v86-debug.wasm
	node tests/x64/bmi.mjs
	TEST_RELEASE_BUILD=1 node tests/x64/bmi.mjs

# FMA and F16C (docs/simd-xsave-plan.md P11): the 32-bit engines against the
# exact model of tests/rust/sse_fp_model.mjs (release and debug builds), the
# x64 engine (interpreted, page tier, compatibility-mode Tier-0) against QEMU
# and the model
.PHONY: fma-tests uefi-tests tpm-tests
fma-tests: build/libv86.mjs build/jit-capacity.bin build/v86.wasm build/v86-debug.wasm
	node tests/rust/fma.mjs
	node tests/rust/cvtpi2ps_x87.mjs
	node tests/rust/fma.mjs build/v86-debug.wasm
	node tests/x64/fma.mjs
	TEST_RELEASE_BUILD=1 node tests/x64/fma.mjs

# The legacy SSE exception conditions in the 32-bit engines (docs/simd-xsave-plan.md
# 3.3, P4a): CR4.OSFXSR for XMM forms only, 16-byte alignment, their order
.PHONY: sse-fault-tests
sse-fault-tests: build/libv86.mjs build/jit-capacity.bin build/v86.wasm build/v86-debug.wasm build/v86-fallback.wasm
	node tests/rust/sse_faults.mjs
	node tests/rust/sse_faults.mjs build/v86-fallback.wasm
	node tests/rust/sse_faults.mjs build/v86-debug.wasm

.PHONY: isa-forms isa-forms-check isa-hot-forms decode-rules-tests xsave-tests ssse3-tests

# docs/iphone4-plan.md "测试": the iOS firmware tools on samples the tests
# make themselves (made-up keys, no Apple files)
.PHONY: ios-tests
ios-tests:
	node tests/ios/tools.mjs

# docs/gles-proxy-plan.md "测试": the GLES host's protocol tables against the
# pinned specs' shapes, the connection stream, renderControl, the shadow
# state against GLES 2.0's rules, the batches (no guest, no page); the
# plugin builds
.PHONY: gles-tests
gles-tests: build/v86-gles.js build/glslang.wasm
	node tests/gles/protocol.mjs
	node tests/gles/stream.mjs
	node tests/gles/render_control.mjs
	node tests/gles/shadow.mjs
	node tests/gles/shadow3.mjs
	node tests/gles/shadow31.mjs
	node tests/gles/batch.mjs
	node tests/gles/snapshot.mjs
	node tests/gles/shader_corpus.mjs
