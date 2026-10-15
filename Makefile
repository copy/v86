CLOSURE_DIR=closure-compiler
CLOSURE=$(CLOSURE_DIR)/compiler.jar
NASM_TEST_DIR=./tests/nasm

INSTRUCTION_TABLES=src/rust/gen/interpreter.rs src/rust/gen/interpreter0f.rs src/rust/gen/interpreter0f38.rs src/rust/gen/interpreter0f3a.rs

# Only the dependencies common to the generators
GEN_DEPENDENCIES=$(filter-out gen/generate_interpreter.js gen/generate_ir_decoder.js gen/ir_semantics.js gen/state_layout.js, $(wildcard gen/*.js))
INTERPRETER_DEPENDENCIES=$(GEN_DEPENDENCIES) gen/generate_interpreter.js

STRIP_DEBUG_FLAG=
ifeq ($(STRIP_DEBUG),true)
STRIP_DEBUG_FLAG=--v86-strip-debug
endif

WASM_OPT ?= false

default: build/v86-debug.wasm
# (v86-parallel.wasm and vcpu-worker.js: index.html runs more than one core in
# host threads with them where the page allows it; see `make parallel`)
all: build/cpu-worker.js build/v86_all.js build/libv86.js build/libv86.mjs build/v86.wasm build/v86-parallel.wasm build/vcpu-worker.js glbridge
all-debug: build/cpu-worker.js build/libv86-debug.js build/libv86-debug.mjs build/v86-debug.wasm glbridge
browser: build/cpu-worker.js build/v86_all.js

# CPU benchmark suite (tests/bench): one IR core against another, see docs/cpu-benchmarks.md.
.PHONY: bench-build bench bench-quick bench-same-source replay-check replay-record
bench-build:
	node tools/bench/build.mjs

bench: bench-build build/v86-ir-runtime.wasm build/libv86.mjs
	node tests/bench/run.mjs $(BENCH_ARGS)

bench-quick: bench-build build/v86-ir-runtime.wasm build/libv86.mjs
	node tests/bench/run.mjs --quick $(BENCH_ARGS)

# The same C sources as i686 code on Tier-0 and as x86-64 code on the x64
# page tier, alternating in one session, then the S gate
# (docs/jit-unification-plan.md P0.4, cross-phase rule 2)
bench-same-source: bench-build build/v86-ir-runtime.wasm build/libv86.mjs
	node tests/bench/run.mjs --same-source --quick --out build/bench/same-source.json $(BENCH_ARGS)
	node tests/bench/gate.mjs --level S build/bench/same-source.json

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

CORE_FILES=cjs.js const.js io.js machine_clock.js main.js lib.js buffer.js ide.js pci.js floppy.js \
	   dma.js pit.js display.js graphics_adapter.js ps2.js rtc.js uart.js parallel.js vmware.js \
	   acpi.js acpi_tables.js platform.js q35.js ahci.js pcie_root_port.js hpet.js smbus.js ich9_tco.js state_layout.js cpu_features.js jit_switches.js iso9660.js \
	   state.js state_io.js ne2k.js sb16.js virtio.js virtio_console.js virtio_net.js virtio_balloon.js \
	   virtio_devices.js \
	   bus.js log.js cpu.js \
	   elf.js kernel.js extended_memory.js \
	   parallel/relocate.js parallel/control.js parallel/machine.js
LIB_FILES=9p.js filesystem.js marshall.js
BROWSER_FILES=screen.js keyboard.js mouse.js speaker.js serial.js \
	      network.js starter.js wasm_paths.js worker_bus.js state_stream_transport.js cpu_worker.js dummy_screen.js ansi_screen.js \
	      inbrowser_network.js fake_network.js wisp_network.js fetch_network.js \
          print_stats.js filestorage.js modem.js graphics_performance.js performance_recorder.js

# Display adapter plugins (src/graphics_adapter.js): each its own file, loaded
# when graphics_adapter names it. Built with every bundle, which looks for
# them beside itself. The boundary to v86 uses quoted names only, so a plugin
# works with any bundle, including the ADVANCED-compiled v86_all.js.
GRAPHICS_ADAPTER_PLUGINS=build/v86-bochs-vga.js build/v86-vmware-svga.js build/v86-virtio-gpu.js
GRAPHICS_ADAPTER_COMMON=src/cjs.js src/const.js src/lib.js src/log.js src/bus.js src/display.js \
	src/graphics_adapters/machine.js src/graphics_adapters/vga_core.js src/graphics_adapters/renderer_protocol.js

RUST_FILES=$(shell find src/rust/ -name '*.rs') \
	   src/rust/gen/interpreter.rs src/rust/gen/interpreter0f.rs src/rust/gen/interpreter0f38.rs src/rust/gen/interpreter0f3a.rs \
	   build/jit-defaults

# Build-time defaults of the JIT switches (src/rust/jit_switches.rs), for A/B
# builds: JIT_DEFAULTS="x64_outline=0,ir_fusion=1" make build/v86.wasm. The
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
		--js src/graphics_adapters/virtio_gpu/virtio_gpu_device.js \
		--js src/graphics_adapters/virtio_gpu/plugin.js

.PHONY: graphics-adapters
graphics-adapters: $(GRAPHICS_ADAPTER_PLUGINS)

build/v86_all.js: $(GRAPHICS_ADAPTER_PLUGINS) $(CLOSURE) src/*.js src/parallel/*.js src/browser/*.js lib/*.js
	mkdir -p build
	-ls -lh build/v86_all.js
	java -jar $(CLOSURE) \
		--js_output_file build/v86_all.js\
		--define=DEBUG=false\
		$(CLOSURE_SOURCE_MAP)\
		$(CLOSURE_FLAGS)\
		--compilation_level ADVANCED\
		--js $(CORE_FILES)\
		--js $(LIB_FILES)\
		--js $(BROWSER_FILES)\
		--js src/browser/main.js
	ls -lh build/v86_all.js

build/v86_all_debug.js: $(GRAPHICS_ADAPTER_PLUGINS) $(CLOSURE) src/*.js src/parallel/*.js src/browser/*.js lib/*.js
	mkdir -p build
	java -jar $(CLOSURE) \
		--js_output_file build/v86_all_debug.js\
		--define=DEBUG=true\
		$(CLOSURE_SOURCE_MAP)\
		$(CLOSURE_FLAGS)\
		--compilation_level ADVANCED\
		--js $(CORE_FILES)\
		--js $(LIB_FILES)\
		--js $(BROWSER_FILES)\
		--js src/browser/main.js

build/libv86.js: $(GRAPHICS_ADAPTER_PLUGINS) $(CLOSURE) src/*.js src/parallel/*.js lib/*.js src/browser/*.js
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

build/libv86.mjs: $(GRAPHICS_ADAPTER_PLUGINS) $(CLOSURE) src/*.js src/parallel/*.js lib/*.js src/browser/*.js
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

build/libv86-debug.js: $(GRAPHICS_ADAPTER_PLUGINS) $(CLOSURE) src/*.js src/parallel/*.js lib/*.js src/browser/*.js
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

build/libv86-debug.mjs: $(GRAPHICS_ADAPTER_PLUGINS) $(CLOSURE) src/*.js src/parallel/*.js lib/*.js src/browser/*.js
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

# The D gate's A/B builds of a mode migration (docs/jit-unification-plan.md
# P7.0): A with 32-bit code in the region tiers (x64_page_compat32 and
# x64_page_legacy32 off: IR Tier-0, M6-M8's A, was deleted in P7.5), B the
# release core as it is (a build-time default, JIT_DEFAULTS, where the plan
# named a cargo feature), for tools/owner_perf.mjs --arms and
# tests/bench/run.mjs --wasm/--baseline
.PHONY: ab-ptier
ab-ptier:
	mkdir -p build/ab
	$(MAKE) jit-arm ARM=ab-A JIT_DEFAULTS="x64_page_compat32=0,x64_page_legacy32=0"
	cp build/bench/arms/ab-A.wasm build/ab/A.wasm
	$(MAKE) jit-arm ARM=ab-B JIT_DEFAULTS=""
	cp build/bench/arms/ab-B.wasm build/ab/B.wasm

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

build/zstddeclib.o: lib/zstd/zstddeclib.c
	mkdir -p build
	clang -c -Wall \
	    --target=wasm32 -O3 -flto -nostdlib -fvisibility=hidden -ffunction-sections -fdata-sections \
	    -DZSTDLIB_VISIBILITY="" \
	    -o build/zstddeclib.o \
	    lib/zstd/zstddeclib.c

clean:
	-rm build/libv86.js
	-rm $(GRAPHICS_ADAPTER_PLUGINS)
	-rm build/libv86.mjs
	-rm build/libv86-debug.js
	-rm build/libv86-debug.mjs
	-rm build/v86_all.js
	-rm build/v86.wasm
	-rm build/v86-debug.wasm
	-rm $(INSTRUCTION_TABLES)
	-rm build/*.map
	-rm build/*.wast
	-rm build/*.o
	$(MAKE) -C $(NASM_TEST_DIR) clean

run: browser glbridge build/v86.wasm
	python3 tools/dev-server.py 2> /dev/null

update_version:
	set -e ;\
	COMMIT=`git log --format="%h" -n 1` ;\
	DATE=`git log --date="format:%b %e, %Y %H:%m" --format="%cd" -n 1` ;\
	SEARCH='<code>Version: <a id="version" href="https://github.com/copy/v86/commits/[a-f0-9]\+">[a-f0-9]\+</a> ([^(]\+)</code>' ;\
	REPLACE='<code>Version: <a id="version" href="https://github.com/copy/v86/commits/'$$COMMIT'">'$$COMMIT'</a> ('$$DATE')</code>' ;\
	sed -i "s@$$SEARCH@$$REPLACE@g" index.html ;\
	SEARCH='<script src="build/v86_all.js?[a-f0-9]\+"></script>' ;\
	REPLACE='<script src="build/v86_all.js?'$$COMMIT'"></script>' ;\
	sed -i "s@$$SEARCH@$$REPLACE@g" index.html ;\
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

expect-tests: build/v86-debug.wasm build/libwabt.cjs
	make -C tests/expect/tests
	./tests/expect/run.js

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

.PHONY: q35-device-tests q35-guest-tests q35-hotplug-tests q35-tests
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
	./tests/devices/virtio_gpu_venus.js
	./tests/devices/venus_protocol.js
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

rust-test: $(RUST_FILES)
	env RUSTFLAGS="-D warnings" RUST_BACKTRACE=full RUST_TEST_THREADS=1 cargo test -- --nocapture
	./tests/rust/verify-wasmgen-dummy-output.js

rust-test-intensive:
	QUICKCHECK_TESTS=100000000 make rust-test

build/softfloat-fast-test.wasm: tests/rust/softfloat_fast_path.rs src/rust/softfloat.rs src/rust/x87_profiler.rs build/softfloat.o
	rustc --edition=2021 --target wasm32-unknown-unknown --crate-type cdylib -O \
	    -C linker=tools/rust-lld-wrapper -C link-arg=build/softfloat.o \
	    tests/rust/softfloat_fast_path.rs -o $@

softfloat-fast-tests: build/softfloat-fast-test.wasm
	node tests/rust/softfloat_fast_path.mjs

x87-recording-tests: build/softfloat-fast-test.wasm
	node tests/rust/x87_recording.mjs

x87-fast-math-tests: build/softfloat-fast-test.wasm
	node tests/rust/x87_fast_math.mjs

x87-jit-cache-tests: build/jit-capacity.bin build/v86.wasm build/libv86.mjs
	node tests/rust/x87_jit_cache.mjs

build/x87-fast-test.bin: tests/rust/x87_fast_path.asm
	nasm -f bin $< -o $@

x87-fast-tests: build/x87-fast-test.bin build/v86.wasm build/libv86.mjs
	node tests/rust/x87_fast_path.mjs

.PHONY: cpu-optimization-tests cpu-optimization-benchmark
cpu-optimization-tests: build/jit-capacity.bin build/v86.wasm build/libv86.mjs
	node tests/rust/cpu_optimizations.mjs

.PHONY: flags-provenance-tests
flags-provenance-tests: build/jit-capacity.bin build/v86.wasm build/libv86.mjs
	node tests/rust/flags_provenance.mjs

.PHONY: cpu-plan-tests jit-policy-benchmark
cpu-plan-tests: build/jit-capacity.bin build/v86.wasm build/libv86.mjs
	node tests/rust/cpu_plan_sequences.mjs

jit-policy-benchmark: build/jit-capacity.bin build/v86.wasm build/libv86.mjs
	node tests/rust/jit_policy_benchmark.mjs

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

build/performance-recording-test: tests/rust/performance_recording.rs src/rust/profiler.rs
	rustc --edition=2021 --test -O $< -o $@

performance-recording-tests: build/performance-recording-test
	./build/performance-recording-test

api-tests: build/v86-debug.wasm
	./tests/api/clean-shutdown.js
	./tests/api/jit-switches.js
	./tests/api/destroy-during-init.js
	./tests/api/state.js
	./tests/api/sb16-state.js
	./tests/api/reset.js
	./tests/api/floppy.js
	./tests/api/parallel.js
	./tests/api/cdrom-insert-eject.js
	./tests/api/iso9660.js
	./tests/api/serial.js
	./tests/api/reboot.js
	#./tests/api/reboot-buildroot.js # https://github.com/copy/v86/issues/636
	./tests/api/pic.js

all-tests: eslint kvm-unit-test qemutests qemutests-release jitpagingtests api-tests nasmtests nasmtests-force-jit rust-test tests expect-tests
	# Skipping:
	# - devices-test (hangs)

eslint:
	eslint src tests gen lib examples tools

rustfmt: $(RUST_FILES)
	cargo fmt --all -- --check --config fn_single_line=true,control_brace_style=ClosingNextLine

build/capstone-x86.min.js:
	mkdir -p build
	wget -nv -P build https://github.com/AlexAltea/capstone.js/releases/download/v3.0.5-rc1/capstone-x86.min.js

# Recent enough for the SIMD and multi-value code the IR compiler emits.
build/libwabt.cjs:
	mkdir -p build
	wget -nv -O build/wabt-1.0.39.tgz https://registry.npmjs.org/wabt/-/wabt-1.0.39.tgz
	tar -xzf build/wabt-1.0.39.tgz -C build package/index.js
	mv build/package/index.js build/libwabt.cjs
	rm -r build/wabt-1.0.39.tgz build/package

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
	npx typedoc --readme none --customFooterHtml "Commit: <a href='https://github.com/copy/v86/commits/$$COMMIT'><code>$$COMMIT</code></a>" --out ./docs/api ./v86.d.ts

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
build/cpu-worker.js: $(GRAPHICS_ADAPTER_PLUGINS) $(CLOSURE) src/*.js src/parallel/*.js src/browser/*.js lib/*.js
	mkdir -p build
	java -jar $(CLOSURE) --js_output_file $@ --define=DEBUG=false $(CLOSURE_FLAGS) \
		--compilation_level SIMPLE --jscomp_off=missingProperties \
		--js $(CORE_FILES) --js $(LIB_FILES) --js $(BROWSER_FILES) \
		--js src/browser/cpu_worker_runtime.js --js src/browser/cpu_worker_entry.js

# The vCPU workers of the host-parallel build (src/parallel/vcpu.js), paired
# with v86-parallel.wasm: `parallel: true` loads both next to the bundles
build/vcpu-worker.js: $(CLOSURE) src/*.js src/parallel/*.js src/browser/*.js lib/*.js
	mkdir -p build
	java -jar $(CLOSURE) --js_output_file $@ --define=DEBUG=false $(CLOSURE_FLAGS) \
		--compilation_level SIMPLE --jscomp_off=missingProperties \
		--js $(CORE_FILES) --js $(LIB_FILES) --js $(BROWSER_FILES) \
		--js src/parallel/vcpu.js --js src/parallel/vcpu_worker_entry.js

.PHONY: parallel
parallel: build/v86-parallel.wasm build/vcpu-worker.js

build/cpu-worker-test.bin: tests/rust/cpu_worker.asm
	nasm -f bin $< -o $@

.PHONY: cpu-worker-tests
cpu-worker-tests: build/cpu-worker.js build/cpu-worker-test.bin build/libv86.mjs build/libv86.js build/v86_all.js build/v86.wasm build/v86-vmware-svga.js glbridge
	node tests/glbridge/cpu_worker_screen_test.mjs
	node tests/glbridge/gl_multipass_browser_runner.js cpu_worker_browser_test.html
	node tests/glbridge/gl_multipass_browser_runner.js cpu_worker_gpu_browser_test.html
	node tests/glbridge/gl_multipass_browser_runner.js cpu_worker_svga_browser_test.html
	node tests/glbridge/gl_multipass_browser_runner.js cpu_worker_audio_browser_test.html
	node tests/glbridge/gl_multipass_browser_runner.js cpu_worker_ui_browser_test.html
	node tests/glbridge/gl_multipass_browser_runner.js cpu_worker_hotplug_browser_test.html

# One canvas for text, graphics and composited D3D/GL windows (docs/display-design.md)
.PHONY: display-browser-tests
display-browser-tests: build/cpu-worker.js build/libv86.mjs build/libv86.js build/v86.wasm build/v86-debug.wasm glbridge
	node tests/glbridge/gl_multipass_browser_runner.js display_canvas_browser_test.html
	node tests/glbridge/gl_multipass_browser_runner.js "display_canvas_browser_test.html?worker=1"
	node tests/glbridge/gl_multipass_browser_runner.js display_text_glyphs_browser_test.html
	node tests/glbridge/gl_multipass_browser_runner.js display_compositor_browser_test.html
	node tests/glbridge/gl_multipass_browser_runner.js graphics_vga_browser_test.html
	node tests/glbridge/gl_multipass_browser_runner.js svga_renderer_browser_test.html
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

# A browser/library rebuild must ship the matching wire-protocol implementation.
build/v86_all.js build/v86_all_debug.js build/libv86.js build/libv86.mjs build/libv86-debug.js build/libv86-debug.mjs: | build/cpu-worker.js

# Keep the terminal available even when building the page bundle directly.
build/v86_all.js build/v86_all_debug.js: | build/xterm.js

# IR tests exercise the experimental compiler without changing the production backend.
.PHONY: ir-generated ir-generated-check ir-decoder-tests ir-verifier-tests ir-backend-tests ir-semantics-tests ir-differential-tests ir-tests
ir-generated:
	node gen/generate_ir_decoder.js

ir-generated-check:
	node gen/generate_ir_decoder.js --check

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
	node tests/smp/publication.mjs
	node tests/smp/state_stream.mjs

multicore-clock-tests-release: build/libv86.mjs build/v86.wasm
	node tests/smp/clock.mjs
	TEST_RELEASE_BUILD=1 node tests/smp/clock_execution.mjs

multicore-coherence-tests-release: build/libv86.mjs build/v86.wasm state-layout-check
	TEST_RELEASE_BUILD=1 node tests/smp/coherence.mjs
	TEST_RELEASE_BUILD=1 node tests/smp/lifecycle.mjs
	TEST_RELEASE_BUILD=1 node tests/smp/exception_lifecycle.mjs
	TEST_RELEASE_BUILD=1 node tests/smp/publication.mjs
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
platform-contract-tests: build/v86-debug.wasm build/libv86.mjs build/v86.wasm
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
.PHONY: jit-gate jit-gate-full core-split-check ir-core-tests
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

# The steps of .github/workflows/ir-core.yml, run here (the release gate's
# R-IR level; the workflow itself stays as it is)
ir-core-tests: ir-generated-check build/v86-ir-test.wasm build/v86-ir-test-release.wasm build/libv86.mjs build/jit-capacity.bin
	$(MAKE) ir-x87-tests ir-control-reference-tests ir-sse-fp-tests ir-mmx-tests ir-coverage-tests
	$(MAKE) ir-sti-tests ir-helper-reload-tests ir-mir-owned-tests ir09-completion-tests
	env RUSTFLAGS="-D warnings" cargo test ir::mir::forwarding -- --nocapture
	env RUSTFLAGS="-D warnings" cargo test
	node tests/ir/wasm/run.mjs
	node tests/rust/verify-wasmgen-dummy-output.js
	node tests/ir/decode/oracle.mjs
	tools/ir-licm-tests.sh
	node tests/ir/differential/cfg.mjs
	node tests/ir/differential/shifts.mjs
	node tests/ir/differential/bits.mjs
	node tests/ir/differential/multiply.mjs
	node tests/ir/differential/ir10.mjs
	tools/ir-forwarding-tests.sh
	node tests/ir/differential/simd_integer.mjs
	sh tools/ir-store-continuation-tests.sh
	$(MAKE) ir-budget-batch-tests ir-entry-tests ir-live-tests ir-cache-tests ir-auto-tests ir-fusion-tests ir-diagnostic-tests
	sh tools/ir13-smoke-tests.sh
	$(MAKE) ir-decode-contract-tests ir-system-mode-tests ir-portable-tests
	node tests/ir/differential/helper_audit.mjs

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
x64-legacy32-tests: bench-build build/v86-ir-runtime.wasm build/libv86.mjs build/jit-capacity.bin
	node tests/ir/differential/tier0_fuzz.mjs 60 1
	for kind in i0 i10 i13 i19 i22 i26 s3 s7 s10 x; do FUZZ_KIND=$$kind node tests/ir/differential/tier0_fuzz.mjs 6 2 || exit 1; done
	# (packed SSE arithmetic of random values: the page tier retries lanes
	# its templates refuse in the interpreter, where IR Tier-0 ran its exact
	# helper in place, so about half of it runs outside page functions)
	FUZZ_KIND=s1 FUZZ_COVERAGE=0.25 node tests/ir/differential/tier0_fuzz.mjs 6 2
	for kind in j g e d o a m v c p r b s11 s12 s13; do FUZZ_KIND=$$kind node tests/ir/differential/tier0_fuzz.mjs 20 1 || exit 1; done
	FUZZ_KIND=r node tests/ir/differential/tier0_fuzz.mjs 20 3
	FUZZ_STRADDLE=1 node tests/ir/differential/tier0_fuzz.mjs 20 2
	node tests/ir/differential/sse_fp_tracking.mjs build/v86-ir-runtime.wasm
	node tests/ir/differential/tier0_fetch_fault.mjs
	node tests/ir/differential/tier0_rep_fault.mjs
	node tests/ir/differential/tier0_irq_slow.mjs
	node tests/ir/differential/tier0_segment_fault.mjs
	node tests/ir/differential/tier0_step_profile.mjs
	node tests/ir/differential/tier0_mode_ledger.mjs
	node tests/ir/differential/page_smc.mjs
	node tests/ir/differential/page_vector_ts.mjs
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

ir-decoder-tests: ir-generated-check
	cargo test decode::tests -- --nocapture
	node tests/ir/decode/oracle.mjs

ir-verifier-tests: ir-generated-check
	cargo test ir::core_tests

ir-backend-tests: ir-generated-check
	cargo test
	node tests/ir/wasm/run.mjs
	node tests/rust/verify-wasmgen-dummy-output.js

ir-semantics-tests: ir-generated-check
	cargo test ir::core_tests::register_lowering_corpus

ir-differential-tests: ir-semantics-tests build/v86.wasm build/libv86.mjs build/jit-capacity.bin
	node tests/ir/differential/registers.mjs

ir-tests: ir-generated-check build/v86.wasm build/libv86.mjs build/jit-capacity.bin
	env RUSTFLAGS="-D warnings" cargo test
	node tests/ir/decode/oracle.mjs
	node tests/ir/wasm/run.mjs
	node tests/rust/verify-wasmgen-dummy-output.js
	node tests/ir/differential/registers.mjs

.PHONY: ir-coverage ir-default-gate
ir-coverage: ir-generated-check
	node tests/ir/coverage.mjs

# Every valid decoder form must have an attributed IR lowering path.
ir-default-gate: ir-generated-check
	node tests/ir/coverage.mjs --require-complete

build/v86-ir-test.wasm: $(RUST_FILES) build/softfloat.o build/zstddeclib.o Cargo.toml
	cargo rustc --features ir-test-hooks $(CARGO_FLAGS)
	cp build/wasm32-unknown-unknown/debug/v86.wasm $@

.PHONY: ir-decode-snapshot-tests
ir-decode-snapshot-tests: ir-generated-check build/v86-ir-test.wasm build/libv86.mjs
	cargo test decode::tests::catalogue_lengths_and_all_modrm_sib_forms
	node tests/ir/decode/snapshot.mjs

.PHONY: ir-memory-tests
ir-memory-tests: ir-generated-check build/v86-ir-test.wasm build/libv86.mjs build/jit-capacity.bin
	cargo test ir::memory_tests
	node tests/ir/differential/memory.mjs

.PHONY: ir-stack-tests
ir-stack-tests: ir-generated-check build/v86-ir-test.wasm build/libv86.mjs build/jit-capacity.bin
	cargo test ir::stack_tests
	node tests/ir/differential/stack.mjs

.PHONY: ir-control-tests
ir-control-tests: ir-generated-check build/v86-ir-test.wasm build/libv86.mjs build/jit-capacity.bin
	cargo test ir::control_tests
	node tests/ir/differential/control.mjs

.PHONY: ir-shift-tests
ir-shift-tests: ir-generated-check build/v86-ir-test.wasm build/libv86.mjs build/jit-capacity.bin
	cargo test ir::shift_tests
	node tests/ir/differential/shifts.mjs

.PHONY: ir-multiply-tests
ir-multiply-tests: ir-generated-check build/v86-ir-test.wasm build/libv86.mjs build/jit-capacity.bin
	cargo test ir::multiply_tests
	node tests/ir/differential/multiply.mjs

.PHONY: ir-bit-tests
ir-bit-tests: ir-generated-check build/v86-ir-test.wasm build/libv86.mjs build/jit-capacity.bin
	cargo test ir::bit_tests
	node tests/ir/differential/bits.mjs

.PHONY: ir-exchange-tests
ir-exchange-tests: ir-generated-check build/v86-ir-test.wasm build/libv86.mjs build/jit-capacity.bin
	cargo test ir::exchange_tests
	node tests/ir/differential/exchange.mjs

.PHONY: ir-enter-tests
ir-enter-tests: ir-generated-check build/v86-ir-test-release.wasm build/libv86.mjs build/jit-capacity.bin
	cargo test ir::enter_tests
	node tests/ir/differential/enter.mjs

# ENTER16's pinned debug-only value assertion rejects high ESP before truncation.
# The release oracle matches production, including nested unwrap fault behavior.
build/v86-ir-test-release.wasm: $(RUST_FILES) build/softfloat.o build/zstddeclib.o Cargo.toml
	cargo rustc --release --features ir-test-hooks $(CARGO_FLAGS)
	cp build/wasm32-unknown-unknown/release/v86.wasm $@

.PHONY: ir-misc-tests
ir-misc-tests: ir-generated-check build/v86-ir-test.wasm build/libv86.mjs build/jit-capacity.bin
	cargo test ir::misc_tests
	node tests/ir/differential/misc.mjs

.PHONY: ir-loop-tests
ir-loop-tests: ir-generated-check build/v86-ir-test.wasm build/libv86.mjs build/jit-capacity.bin
	cargo test ir::loop_tests
	node tests/ir/differential/loops.mjs

.PHONY: ir-cfg-tests
ir-cfg-tests: ir-generated-check build/v86-ir-test.wasm build/libv86.mjs build/jit-capacity.bin
	cargo test ir::cfg_frontend_tests
	node tests/ir/differential/cfg.mjs

.PHONY: ir-fusion-tests
ir-fusion-tests: ir-generated-check build/v86-ir-test.wasm build/v86-ir-test-release.wasm build/libv86.mjs build/jit-capacity.bin
	env RUSTFLAGS="-D warnings" cargo test ir::fusion_tests
	node tests/ir/differential/fusion.mjs
	node tests/ir/differential/fusion.mjs build/v86-ir-test-release.wasm

.PHONY: ir-diagnostic-tests
ir-diagnostic-tests: build/v86-ir-runtime.wasm build/v86-ir-cache-test.wasm build/v86-ir-cache-test-release.wasm build/libv86.mjs build/jit-capacity.bin
	node tests/ir/differential/diagnostics.mjs build/v86-ir-cache-test.wasm
	node tests/ir/differential/diagnostics.mjs build/v86-ir-cache-test-release.wasm
	node tests/ir/differential/diagnostics.mjs build/v86-ir-runtime.wasm
	IR_DIAGNOSTICS=16 node tests/ir/differential/auto.mjs build/v86-ir-runtime.wasm

.PHONY: ir09-completion-tests
ir09-completion-tests: ir-generated-check build/v86-ir-test.wasm build/libv86.mjs build/jit-capacity.bin
	env RUSTFLAGS="-D warnings" cargo test ir::backend::structure::tests -- --nocapture
	env RUSTFLAGS="-D warnings" cargo test ir::runtime::region::tests -- --nocapture
	env RUSTFLAGS="-D warnings" cargo test ir::cfg_frontend_tests -- --nocapture
	node tests/ir/differential/cfg.mjs

.PHONY: ir-system-stack-tests
ir-system-stack-tests: ir-generated-check build/v86-ir-test.wasm build/libv86.mjs build/jit-capacity.bin
	cargo test ir::system_stack_tests
	node tests/ir/differential/system_stack.mjs

.PHONY: ir-segment-tests
ir-segment-tests: ir-generated-check build/v86-ir-test.wasm build/libv86.mjs build/jit-capacity.bin
	cargo test ir::segment_tests
	node tests/ir/differential/segments.mjs

.PHONY: ir-string-tests
ir-string-tests: ir-generated-check build/v86-ir-test.wasm build/libv86.mjs build/jit-capacity.bin
	cargo test ir::string_tests
	node tests/ir/differential/strings.mjs

.PHONY: ir-io-tests
ir-io-tests: ir-generated-check build/v86-ir-test.wasm build/libv86.mjs build/jit-capacity.bin
	cargo test ir::io_tests
	node tests/ir/differential/io.mjs

.PHONY: ir-rep-engine-tests
build/v86-rep-reference.wasm: $(RUST_FILES) Cargo.toml build/softfloat.o build/zstddeclib.o tests/ir/differential/build_rep_reference.py
	python3 tests/ir/differential/build_rep_reference.py

ir-rep-engine-tests: ir-generated-check build/v86-ir-test.wasm build/v86-rep-reference.wasm build/libv86.mjs build/jit-capacity.bin
	node tests/ir/differential/rep_engine.mjs

.PHONY: ir-rep-tests
ir-rep-tests: ir-generated-check build/v86-ir-test.wasm build/v86-rep-reference.wasm build/libv86.mjs build/jit-capacity.bin
	cargo test ir::rep_tests
	node tests/ir/differential/rep.mjs

.PHONY: ir-cpu-info-tests
ir-cpu-info-tests: ir-generated-check build/v86-ir-test.wasm build/v86-ir-test-release.wasm build/libv86.mjs build/jit-capacity.bin
	cargo test ir::cpu_info_tests
	node tests/ir/differential/cpu_info.mjs

.PHONY: ir-cpu-system-tests
ir-cpu-system-tests: ir-generated-check build/v86-ir-test.wasm build/libv86.mjs build/jit-capacity.bin
	cargo test ir::cpu_system_tests
	node tests/ir/differential/cpu_system.mjs

.PHONY: ir-control-regs-tests
ir-control-regs-tests: ir-generated-check build/v86-ir-test.wasm build/v86-ir-test-release.wasm build/libv86.mjs build/jit-capacity.bin
	cargo test ir::control_regs_tests
	node tests/ir/differential/control_regs.mjs
	node tests/ir/differential/system_read_continuation.mjs

.PHONY: ir-descriptor-tests
ir-descriptor-tests: ir-generated-check build/v86-ir-test.wasm build/v86-ir-test-release.wasm build/libv86.mjs build/jit-capacity.bin
	cargo test ir::descriptor_tests
	node tests/ir/differential/descriptor.mjs

build/v86-task-reference.wasm: $(RUST_FILES) Cargo.toml build/softfloat.o build/zstddeclib.o tests/ir/differential/build_task_reference.py
	python3 tests/ir/differential/build_task_reference.py

build/v86-task-reference-release.wasm: build/v86-task-reference.wasm
	test -f $@ || python3 tests/ir/differential/build_task_reference.py

.PHONY: ir-task-regs-tests
ir-task-regs-tests: ir-generated-check build/v86-task-reference.wasm build/v86-task-reference-release.wasm build/libv86.mjs build/jit-capacity.bin
	cargo test ir::task_regs_tests
	node tests/ir/differential/task_regs.mjs

.PHONY: ir-selector-query-tests
ir-selector-query-tests: ir-generated-check build/v86-ir-test.wasm build/v86-ir-test-release.wasm build/libv86.mjs build/jit-capacity.bin
	cargo test ir::selector_query_tests
	node tests/ir/differential/selector_query.mjs

.PHONY: ir-flags-observer-tests
ir-flags-observer-tests: build/v86-ir-test.wasm build/v86-ir-test-release.wasm build/libv86.mjs build/jit-capacity.bin
	node tests/ir/differential/verr_flags_baseline.mjs

.PHONY: ir-verr-tests
ir-verr-tests: ir-generated-check build/v86-ir-test.wasm build/v86-ir-test-release.wasm build/libv86.mjs build/jit-capacity.bin
	cargo test ir::verr_tests
	node tests/ir/differential/verr.mjs
	node tests/ir/differential/raw_zero.mjs

.PHONY: ir-cmpxchg8b-tests
ir-cmpxchg8b-tests: ir-generated-check build/v86-ir-test.wasm build/v86-ir-test-release.wasm build/libv86.mjs build/jit-capacity.bin
	cargo test ir::cmpxchg8b_tests
	node tests/ir/differential/cmpxchg8b.mjs

.PHONY: ir-x87-tests
ir-x87-tests: ir-generated-check build/v86-ir-test.wasm build/v86-ir-test-release.wasm build/libv86.mjs build/jit-capacity.bin
	cargo test ir::x87_tests
	node tests/ir/differential/x87.mjs

.PHONY: ir-far-control-tests ir-x87-memory-tests ir-fp-state-tests ir-control-reference-tests
ir-far-control-tests: ir-generated-check build/v86-ir-test.wasm build/v86-ir-test-release.wasm build/libv86.mjs build/jit-capacity.bin
	cargo test ir::far_control_tests
	node tests/ir/differential/far_control.mjs
	node tests/ir/differential/far_control.mjs build/v86-ir-test-release.wasm

ir-x87-memory-tests: ir-generated-check build/v86-ir-test.wasm build/v86-ir-test-release.wasm build/libv86.mjs build/jit-capacity.bin
	cargo test ir::x87_memory_tests
	node tests/ir/differential/x87_memory.mjs

ir-fp-state-tests: ir-generated-check build/v86-ir-test.wasm build/v86-ir-test-release.wasm build/libv86.mjs build/jit-capacity.bin
	cargo test ir::fp_state_tests
	node tests/ir/differential/fp_state.mjs

build/v86-control-reference.wasm: $(RUST_FILES) Cargo.toml build/softfloat.o build/zstddeclib.o tests/ir/differential/build_control_reference.py
	python3 tests/ir/differential/build_control_reference.py

build/v86-control-reference-release.wasm: build/v86-control-reference.wasm
	@test -f $@ || python3 tests/ir/differential/build_control_reference.py

ir-control-reference-tests: ir-far-control-tests ir-x87-memory-tests ir-fp-state-tests ir-coverage-tests build/v86-control-reference.wasm build/v86-control-reference-release.wasm
	node tests/ir/differential/far_control.mjs build/v86-control-reference.wasm
	node tests/ir/differential/far_control.mjs build/v86-control-reference-release.wasm
	node tests/ir/differential/x87_memory.mjs build/v86-control-reference
	node tests/ir/differential/fp_state.mjs build/v86-control-reference
	node tests/ir/differential/coverage.mjs build/v86-control-reference

.PHONY: ir-simd-move-tests
ir-simd-move-tests: ir-generated-check build/v86-ir-test.wasm build/v86-ir-test-release.wasm build/libv86.mjs build/jit-capacity.bin
	cargo test ir::simd_move_tests
	node tests/ir/differential/simd_moves.mjs

.PHONY: ir-simd-integer-tests
ir-simd-integer-tests: ir-generated-check build/v86-ir-test.wasm build/v86-ir-test-release.wasm build/libv86.mjs build/jit-capacity.bin
	cargo test ir::simd_integer_tests
	node tests/ir/differential/simd_integer.mjs

.PHONY: ir-simd-immediate-tests
ir-simd-immediate-tests: ir-generated-check build/v86-ir-test.wasm build/v86-ir-test-release.wasm build/libv86.mjs build/jit-capacity.bin
	cargo test ir::simd_immediate_tests
	node tests/ir/differential/simd_immediate.mjs

.PHONY: ir-simd-shuffle-tests
ir-simd-shuffle-tests: ir-generated-check build/v86-ir-test.wasm build/v86-ir-test-release.wasm build/libv86.mjs build/jit-capacity.bin
	cargo test ir::simd_shuffle_tests
	node tests/ir/differential/simd_shuffle.mjs

.PHONY: ir-simd-transfer-tests
ir-simd-transfer-tests: ir-generated-check build/v86-ir-test.wasm build/v86-ir-test-release.wasm build/libv86.mjs build/jit-capacity.bin
	cargo test ir::simd_transfer_tests
	node tests/ir/differential/simd_transfer.mjs

.PHONY: ir-simd-lane-tests
ir-simd-lane-tests: ir-generated-check build/v86-ir-test.wasm build/v86-ir-test-release.wasm build/libv86.mjs build/jit-capacity.bin
	cargo test ir::simd_lane_tests
	node tests/ir/differential/simd_lane.mjs

.PHONY: ir-simd-masked-tests
ir-simd-masked-tests: ir-generated-check build/v86-ir-test.wasm build/v86-ir-test-release.wasm build/libv86.mjs build/jit-capacity.bin
	cargo test ir::simd_masked_tests
	node tests/ir/differential/simd_masked.mjs

.PHONY: ir-entry-tests
ir-entry-tests: ir-generated-check build/v86-ir-test.wasm build/v86-ir-test-release.wasm build/libv86.mjs build/jit-capacity.bin
	cargo test ir::entry_tests
	node tests/ir/differential/entry.mjs
	node tests/ir/differential/entry.mjs build/v86-ir-test-release.wasm
	node tests/ir/differential/shared_entry.mjs
	node tests/ir/differential/shared_entry.mjs build/v86-ir-test-release.wasm

.PHONY: ir-live-tests
ir-live-tests: ir-generated-check build/v86-ir-test.wasm build/v86-ir-test-release.wasm build/v86-ir-runtime.wasm build/libv86.mjs build/jit-capacity.bin
	cargo test ir::entry_tests
	node tests/ir/differential/live.mjs
	node tests/ir/differential/live.mjs build/v86-ir-test-release.wasm
	node tests/ir/differential/live_runtime.mjs

# The release core without differential test hooks: the same as build/v86.wasm,
# under the path the IR tests use.
build/v86-ir-runtime.wasm: build/v86.wasm
	cp build/v86.wasm $@

.PHONY: ir-cache-tests
ir-cache-tests: ir-generated-check build/v86-ir-cache-test.wasm build/v86-ir-cache-test-release.wasm build/v86-ir-runtime.wasm build/libv86.mjs build/jit-capacity.bin
	node tests/ir/differential/sse_task_faults.mjs build/v86-ir-cache-test.wasm
	node tests/ir/differential/sse_task_faults.mjs build/v86-ir-cache-test-release.wasm --release
	node tests/ir/differential/cache.mjs build/v86-ir-cache-test.wasm
	node tests/ir/differential/cache.mjs build/v86-ir-cache-test-release.wasm
	node tests/ir/differential/cache.mjs build/v86-ir-runtime.wasm
	node tests/ir/differential/io_permission_observer.mjs build/v86-ir-cache-test.wasm
	node tests/ir/differential/io_permission_observer.mjs build/v86-ir-cache-test-release.wasm
	node tests/ir/differential/io_permission_observer.mjs build/v86-ir-runtime.wasm
	node tests/ir/differential/warm_chain.mjs build/v86-ir-cache-test.wasm
	node tests/ir/differential/warm_chain.mjs build/v86-ir-cache-test-release.wasm
	node tests/ir/differential/warm_chain.mjs build/v86-ir-runtime.wasm
	node tests/ir/differential/polymorphic_chain.mjs build/v86-ir-cache-test.wasm
	node tests/ir/differential/polymorphic_chain.mjs build/v86-ir-cache-test-release.wasm
	node tests/ir/differential/polymorphic_chain.mjs build/v86-ir-runtime.wasm
	node tests/ir/differential/overlap_validation.mjs build/v86-ir-cache-test.wasm
	node tests/ir/differential/overlap_validation.mjs build/v86-ir-cache-test-release.wasm
	node tests/ir/differential/overlap_validation.mjs build/v86-ir-runtime.wasm
	node tests/ir/differential/missing_hint.mjs build/v86-ir-cache-test.wasm
	node tests/ir/differential/missing_hint.mjs build/v86-ir-cache-test-release.wasm
	node tests/ir/differential/missing_hint.mjs build/v86-ir-runtime.wasm
	node tests/ir/differential/poll_reuse.mjs build/v86-ir-cache-test.wasm
	node tests/ir/differential/poll_reuse.mjs build/v86-ir-cache-test-release.wasm
	node tests/ir/differential/poll_reuse.mjs build/v86-ir-runtime.wasm
	node tests/ir/differential/notified_validation.mjs build/v86-ir-cache-test.wasm
	node tests/ir/differential/notified_validation.mjs build/v86-ir-cache-test-release.wasm
	node tests/ir/differential/notified_validation.mjs build/v86-ir-runtime.wasm
	node tests/ir/performance/timing_test.mjs

.PHONY: ir-auto-tests
ir-auto-tests: ir-generated-check build/v86-ir-cache-test.wasm build/v86-ir-cache-test-release.wasm build/v86-ir-runtime.wasm build/libv86.mjs build/jit-capacity.bin
	node tests/ir/differential/auto.mjs build/v86-ir-cache-test.wasm
	node tests/ir/differential/auto.mjs build/v86-ir-cache-test-release.wasm
	node tests/ir/differential/auto.mjs build/v86-ir-runtime.wasm
	node tests/ir/differential/hot_working_set.mjs build/v86-ir-cache-test.wasm
	node tests/ir/differential/hot_working_set.mjs build/v86-ir-cache-test-release.wasm
	node tests/ir/differential/hot_working_set.mjs build/v86-ir-runtime.wasm
	node tests/ir/differential/publication_yield.mjs build/v86-ir-cache-test.wasm
	node tests/ir/differential/publication_yield.mjs build/v86-ir-cache-test-release.wasm
	node tests/ir/differential/publication_yield.mjs build/v86-ir-runtime.wasm
	node tests/ir/differential/scheduler_ready.mjs build/v86-ir-cache-test.wasm
	node tests/ir/differential/scheduler_ready.mjs build/v86-ir-cache-test-release.wasm
	node tests/ir/differential/scheduler_ready.mjs build/v86-ir-runtime.wasm
	node tests/ir/differential/observed_entries.mjs build/v86-ir-cache-test.wasm
	node tests/ir/differential/observed_entries.mjs build/v86-ir-cache-test-release.wasm
	node tests/ir/differential/observed_entries.mjs build/v86-ir-runtime.wasm
	node tests/ir/differential/resident_promotion.mjs build/v86-ir-cache-test.wasm
	node tests/ir/differential/resident_promotion.mjs build/v86-ir-cache-test-release.wasm
	node tests/ir/differential/resident_promotion.mjs build/v86-ir-runtime.wasm

.PHONY: ir-backend-integration-tests ir-backend-browser-tests
ir-backend-integration-tests: build/v86-ir-cache-test.wasm build/v86-ir-runtime.wasm build/v86.wasm build/libv86.mjs build/cpu-worker-test.bin
	node tests/ir/differential/backend.mjs build/v86-ir-cache-test.wasm
	node tests/ir/differential/backend.mjs build/v86-ir-runtime.wasm

ir-backend-browser-tests: build/v86-ir-runtime.wasm build/v86.wasm build/libv86.mjs build/cpu-worker.js build/cpu-worker-test.bin
	node tests/glbridge/gl_multipass_browser_runner.js ir_backend_browser_test.html

# IR-13 host/device acceptance deliberately reuses the production Worker/browser
# integration scenarios instead of a reduced IR-only fixture. The query string
# selects the experimental core while preserving the exact graphics/audio/state
# workload used by the legacy regression.
.PHONY: ir13-host-tests ir13-browser-tests
ir13-host-tests: ir-backend-integration-tests
	@echo "PASS: IR-13 Node host/backend integration"

ir13-browser-tests: build/v86-ir-runtime.wasm build/v86.wasm build/libv86.mjs build/cpu-worker.js build/cpu-worker-test.bin
	node tests/glbridge/gl_multipass_browser_runner.js ir_backend_browser_test.html
	node tests/glbridge/gl_multipass_browser_runner.js 'cpu_worker_browser_test.html?jit_backend=ir'
	node tests/glbridge/gl_multipass_browser_runner.js 'cpu_worker_audio_browser_test.html?jit_backend=ir'

.PHONY: ir13-budget-matrix
ir13-budget-matrix: build/v86-ir-runtime.wasm build/libv86.mjs build/cpu-worker-test.bin
	node tests/ir/performance/smoke.mjs > build/ir13-performance-smoke.json
	cat build/ir13-performance-smoke.json

.PHONY: jit-disabled-tests
jit-disabled-tests: build/v86-debug.wasm build/v86.wasm build/libv86.mjs build/cpu-worker-test.bin
	node tests/rust/jit_disabled_promotion.mjs build/v86-debug.wasm
	node tests/rust/jit_disabled_promotion.mjs build/v86.wasm

.PHONY: ir-mir-owned-tests
ir-mir-owned-tests:
	cargo test mir::optimize::tests
	node tests/ir/wasm/owned.mjs

build/v86-ir-cache-test.wasm: $(RUST_FILES) build/softfloat.o build/zstddeclib.o Cargo.toml
	cargo rustc --features ir-test-hooks $(CARGO_FLAGS)
	cp build/wasm32-unknown-unknown/debug/v86.wasm $@

build/v86-ir-cache-test-release.wasm: $(RUST_FILES) build/softfloat.o build/zstddeclib.o Cargo.toml
	cargo rustc --release --features ir-test-hooks $(CARGO_FLAGS)
	cp build/wasm32-unknown-unknown/release/v86.wasm $@

.PHONY: ir-forwarding-tests
ir-forwarding-tests:
	tools/ir-forwarding-tests.sh

.PHONY: ir-sse-fp-tests
ir-sse-fp-tests: ir-generated-check build/v86-ir-test.wasm build/v86-ir-test-release.wasm build/libv86.mjs build/jit-capacity.bin
	cargo test ir::sse_fp_tests
	node tests/ir/differential/sse_fp.mjs

.PHONY: ir-crc32-tests
ir-crc32-tests: ir-generated-check build/v86-ir-test.wasm build/v86-ir-test-release.wasm build/libv86.mjs build/jit-capacity.bin
	cargo test ir::crc32_tests
	node tests/ir/differential/crc32.mjs

.PHONY: ir-avx-tests
ir-avx-tests: ir-generated-check build/v86-ir-test.wasm build/v86-ir-test-release.wasm build/libv86.mjs build/jit-capacity.bin
	cargo test ir::avx_tests
	node tests/ir/differential/avx.mjs

.PHONY: ir-bmi-tests
ir-bmi-tests: ir-generated-check build/v86-ir-test.wasm build/v86-ir-test-release.wasm build/libv86.mjs build/jit-capacity.bin
	cargo test ir::bmi_tests
	node tests/ir/differential/bmi.mjs

.PHONY: ir-mmx-tests
ir-mmx-tests: ir-generated-check build/v86-ir-test.wasm build/v86-ir-test-release.wasm build/libv86.mjs build/jit-capacity.bin
	cargo test ir::mmx_tests
	node tests/ir/differential/mmx.mjs

.PHONY: ir-coverage-tests
ir-coverage-tests: ir-generated-check build/v86-ir-test.wasm build/v86-ir-test-release.wasm build/libv86.mjs build/jit-capacity.bin
	node tests/ir/coverage.mjs --require-complete
	cargo test ir::coverage_tests
	node tests/ir/differential/coverage.mjs

.PHONY: ir-sti-tests
ir-sti-tests: ir-generated-check build/v86-ir-test.wasm build/v86-ir-test-release.wasm build/libv86.mjs build/jit-capacity.bin
	cargo test ir::sti_tests
	node tests/ir/differential/sti.mjs

.PHONY: ir-helper-reload-tests
ir-helper-reload-tests: ir-generated-check build/v86-ir-test.wasm build/v86-ir-test-release.wasm build/libv86.mjs build/jit-capacity.bin
	cargo test ir::helper_tests::cpu_reload_contract_and_continuation_fixtures
	node tests/ir/differential/reload.mjs

# Portable IR core: scalar regions compile, vector regions explicitly fall back
# to the interpreter and participate in normal failed-compilation suppression.
build/v86-ir-runtime-fallback.wasm: $(RUST_FILES) build/softfloat.o build/zstddeclib.o Cargo.toml
	cargo rustc --release $(CARGO_FLAGS_SAFE) -C target-feature=-simd128
	cp build/wasm32-unknown-unknown/release/v86.wasm $@

build/v86-ir-test-fallback.wasm: $(RUST_FILES) build/softfloat.o build/zstddeclib.o Cargo.toml
	cargo rustc --features ir-test-hooks $(CARGO_FLAGS_SAFE) -C target-feature=-simd128
	cp build/wasm32-unknown-unknown/debug/v86.wasm $@

.PHONY: ir-decode-contract-tests ir-system-mode-tests ir-portable-tests ir-helper-audit
ir-decode-contract-tests: ir-decode-snapshot-tests build/v86-ir-test-release.wasm build/jit-capacity.bin
	cargo test invalid_form_fixtures
	node tests/ir/decode/staged.mjs
	node tests/ir/decode/staged.mjs build/v86-ir-test-release.wasm
	node tests/ir/differential/invalid.mjs
	node tests/ir/differential/invalid.mjs build/v86-ir-test-release.wasm
	cargo test multiple_cpu_entries
	node tests/ir/differential/multientry.mjs
	node tests/ir/differential/multientry.mjs build/v86-ir-test-release.wasm

ir-system-mode-tests: ir-far-control-tests build/v86-control-reference.wasm build/v86-control-reference-release.wasm
	node tests/ir/differential/system_modes.mjs
	node tests/ir/differential/system_modes.mjs build/v86-ir-test-release.wasm
	node tests/ir/differential/system_modes.mjs build/v86-control-reference.wasm
	node tests/ir/differential/system_modes.mjs build/v86-control-reference-release.wasm

ir-portable-tests: build/v86-ir-test.wasm build/v86-ir-test-fallback.wasm build/v86-ir-runtime-fallback.wasm build/libv86.mjs build/jit-capacity.bin
	cargo test portable_core
	node tests/ir/differential/fallback.mjs
	node tests/ir/differential/auto.mjs build/v86-ir-runtime-fallback.wasm

# Full fixture set is also produced by cargo test --lib in CI.
ir-helper-audit: ir-generated-check
	cargo test ir::simd_
	cargo test sse_fp_fixtures
	cargo test mmx_fixtures
	node tests/ir/differential/helper_audit.mjs

# The pinned resolver is compiled into test cores via #[path].
build/v86-ir-test.wasm build/v86-ir-test-release.wasm build/v86-ir-test-fallback.wasm build/v86-control-reference.wasm build/v86-control-reference-release.wasm: tests/ir/decode/legacy_modrm.rs

.PHONY: ir-budget-batch-tests
ir-budget-batch-tests:
	sh tools/ir-budget-batch-tests.sh

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
	SMP_JIT_MODE=region node tests/smp/linux_topology.mjs
	SMP_JIT_MODE=pages node tests/smp/linux_topology.mjs

multicore-linux-jit-tests-release: build/smp/affinity_probe build/libv86.mjs build/v86.wasm images/linux4.iso
	TEST_RELEASE_BUILD=1 SMP_JIT_MODE=region node tests/smp/linux_topology.mjs
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

# The decode rules of the plan (5.2) on the 32-bit interpreter and both IR
# code generators: mandatory prefixes, F2/F3 order, #UD for unlisted prefixes
decode-rules-tests: build/libv86.mjs build/jit-capacity.bin build/v86.wasm build/v86-debug.wasm build/v86-ir-test.wasm build/v86-ir-test-release.wasm
	node tests/rust/decode_rules.mjs
	node tests/rust/decode_rules.mjs build/v86-debug.wasm
	node tests/ir/decode/vex_modes.mjs
	node tests/ir/decode/vex_modes.mjs build/v86-ir-test-release.wasm

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
.PHONY: fma-tests
fma-tests: build/libv86.mjs build/jit-capacity.bin build/v86.wasm build/v86-debug.wasm
	node tests/rust/fma.mjs
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
