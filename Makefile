CLOSURE_DIR=closure-compiler
CLOSURE=$(CLOSURE_DIR)/compiler.jar
NASM_TEST_DIR=./tests/nasm

INSTRUCTION_TABLES=src/rust/gen/jit.rs src/rust/gen/jit0f.rs \
		   src/rust/gen/interpreter.rs src/rust/gen/interpreter0f.rs \
		   src/rust/gen/analyzer.rs src/rust/gen/analyzer0f.rs \

# Only the dependencies common to both generate_{jit,interpreter}.js
GEN_DEPENDENCIES=$(filter-out gen/generate_interpreter.js gen/generate_jit.js gen/generate_analyzer.js, $(wildcard gen/*.js))
JIT_DEPENDENCIES=$(GEN_DEPENDENCIES) gen/generate_jit.js
INTERPRETER_DEPENDENCIES=$(GEN_DEPENDENCIES) gen/generate_interpreter.js
ANALYZER_DEPENDENCIES=$(GEN_DEPENDENCIES) gen/generate_analyzer.js

STRIP_DEBUG_FLAG=
ifeq ($(STRIP_DEBUG),true)
STRIP_DEBUG_FLAG=--v86-strip-debug
endif

WASM_OPT ?= false

default: build/v86-debug.wasm
all: build/v86_all.js build/libv86.js build/libv86.mjs build/v86.wasm
all-debug: build/libv86-debug.js build/libv86-debug.mjs build/v86-debug.wasm
browser: build/v86_all.js

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

CORE_FILES=cjs.js const.js io.js main.js lib.js buffer.js ide.js pci.js floppy.js \
	   dma.js pit.js vga.js ps2.js rtc.js uart.js \
	   acpi.js apic.js ioapic.js iso9660.js \
	   state.js ne2k.js sb16.js virtio.js virtio_console.js virtio_net.js virtio_balloon.js \
	   bus.js log.js cpu.js \
	   elf.js kernel.js
LIB_FILES=9p.js filesystem.js marshall.js
BROWSER_FILES=screen.js keyboard.js mouse.js speaker.js serial.js \
	      network.js starter.js worker_bus.js dummy_screen.js \
	      inbrowser_network.js fake_network.js wisp_network.js fetch_network.js \
          print_stats.js filestorage.js

RUST_FILES=$(shell find src/rust/ -name '*.rs') \
	   src/rust/gen/interpreter.rs src/rust/gen/interpreter0f.rs \
	   src/rust/gen/jit.rs src/rust/gen/jit0f.rs \
	   src/rust/gen/analyzer.rs src/rust/gen/analyzer0f.rs

CORE_FILES:=$(addprefix src/,$(CORE_FILES))
LIB_FILES:=$(addprefix lib/,$(LIB_FILES))
BROWSER_FILES:=$(addprefix src/browser/,$(BROWSER_FILES))

build/v86_all.js: $(CLOSURE) src/*.js src/browser/*.js lib/*.js
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

build/v86_all_debug.js: $(CLOSURE) src/*.js src/browser/*.js lib/*.js
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

build/libv86.js: $(CLOSURE) src/*.js lib/*.js src/browser/*.js
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

build/libv86.mjs: $(CLOSURE) src/*.js lib/*.js src/browser/*.js
	mkdir -p build
	-ls -lh build/libv86.js
	java -jar $(CLOSURE) \
		--js_output_file build/libv86.mjs\
		--define=DEBUG=false\
		$(CLOSURE_FLAGS)\
		--compilation_level SIMPLE\
		--jscomp_off=missingProperties\
		--output_wrapper ';let module = {exports:{}}; %output%; export default module.exports.V86; export let {V86, CPU} = module.exports;'\
		--js $(CORE_FILES)\
		--js $(BROWSER_FILES)\
		--js $(LIB_FILES)\
		--chunk_output_type=ES_MODULES\
		--emit_use_strict=false
	ls -lh build/libv86.mjs

build/libv86-debug.js: $(CLOSURE) src/*.js lib/*.js src/browser/*.js
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

build/libv86-debug.mjs: $(CLOSURE) src/*.js lib/*.js src/browser/*.js
	mkdir -p build
	java -jar $(CLOSURE) \
		--js_output_file build/libv86-debug.mjs\
		--define=DEBUG=true\
		$(CLOSURE_FLAGS)\
		--compilation_level SIMPLE\
		--jscomp_off=missingProperties\
		--output_wrapper ';let module = {exports:{}}; %output%; export default module.exports.V86; export let {V86, CPU} = module.exports;'\
		--js $(CORE_FILES)\
		--js $(BROWSER_FILES)\
		--js $(LIB_FILES)\
		--chunk_output_type=ES_MODULES\
		--emit_use_strict=false
	ls -lh build/libv86-debug.mjs

src/rust/gen/jit.rs: $(JIT_DEPENDENCIES)
	./gen/generate_jit.js --output-dir build/ --table jit
src/rust/gen/jit0f.rs: $(JIT_DEPENDENCIES)
	./gen/generate_jit.js --output-dir build/ --table jit0f

src/rust/gen/interpreter.rs: $(INTERPRETER_DEPENDENCIES)
	./gen/generate_interpreter.js --output-dir build/ --table interpreter
src/rust/gen/interpreter0f.rs: $(INTERPRETER_DEPENDENCIES)
	./gen/generate_interpreter.js --output-dir build/ --table interpreter0f

src/rust/gen/analyzer.rs: $(ANALYZER_DEPENDENCIES)
	./gen/generate_analyzer.js --output-dir build/ --table analyzer
src/rust/gen/analyzer0f.rs: $(ANALYZER_DEPENDENCIES)
	./gen/generate_analyzer.js --output-dir build/ --table analyzer0f

build/v86.wasm: $(RUST_FILES) build/softfloat.o build/zstddeclib.o Cargo.toml
	mkdir -p build/
	-BLOCK_SIZE=K ls -l build/v86.wasm
	cargo rustc --release $(CARGO_FLAGS)
	cp build/wasm32-unknown-unknown/release/v86.wasm build/v86.wasm
	-$(WASM_OPT) && wasm-opt -O2 --strip-debug build/v86.wasm -o build/v86.wasm
	BLOCK_SIZE=K ls -l build/v86.wasm

build/v86-debug.wasm: $(RUST_FILES) build/softfloat.o build/zstddeclib.o Cargo.toml
	mkdir -p build/
	-BLOCK_SIZE=K ls -l build/v86-debug.wasm
	cargo rustc $(CARGO_FLAGS)
	cp build/wasm32-unknown-unknown/debug/v86.wasm build/v86-debug.wasm
	BLOCK_SIZE=K ls -l build/v86-debug.wasm

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

run:
	python3 -m http.server 2> /dev/null

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
	$(MAKE) -C tests/jit-paging test-jit
	./tests/jit-paging/run.js

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

kvm-unit-test: build/v86-debug.wasm
	(cd tests/kvm-unit-tests && ./configure && make x86/realmode.flat)
	tests/kvm-unit-tests/run.mjs tests/kvm-unit-tests/x86/realmode.flat

kvm-unit-test-release: build/libv86.mjs build/v86.wasm
	(cd tests/kvm-unit-tests && ./configure && make x86/realmode.flat)
	TEST_RELEASE_BUILD=1 tests/kvm-unit-tests/run.mjs tests/kvm-unit-tests/x86/realmode.flat

expect-tests: build/v86-debug.wasm build/libwabt.cjs
	make -C tests/expect/tests
	./tests/expect/run.js

devices-test: build/v86-debug.wasm
	./tests/devices/virtio_9p.js
	./tests/devices/virtio_console.js
	./tests/devices/fetch_network.js
	USE_VIRTIO=1 ./tests/devices/fetch_network.js
	./tests/devices/wisp_network.js
	./tests/devices/virtio_balloon.js

rust-test: $(RUST_FILES)
	env RUSTFLAGS="-D warnings" RUST_BACKTRACE=full RUST_TEST_THREADS=1 cargo test -- --nocapture
	./tests/rust/verify-wasmgen-dummy-output.js

rust-test-intensive:
	QUICKCHECK_TESTS=100000000 make rust-test

api-tests: build/v86-debug.wasm
	./tests/api/clean-shutdown.js
	./tests/api/state.js
	./tests/api/reset.js
	./tests/api/floppy.js
	./tests/api/cdrom-insert-eject.js
	./tests/api/serial.js
	./tests/api/reboot.js
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

build/libwabt.cjs:
	mkdir -p build
	wget -nv -P build https://github.com/WebAssembly/wabt/archive/1.0.6.zip
	unzip -j -d build/ build/1.0.6.zip wabt-1.0.6/demo/libwabt.js
	mv build/libwabt.js build/libwabt.cjs
	rm build/1.0.6.zip

build/xterm.js:
	curl https://cdn.jsdelivr.net/npm/xterm@5.2.1/lib/xterm.min.js > build/xterm.js
	curl https://cdn.jsdelivr.net/npm/xterm@5.2.1/lib/xterm.js.map > build/xterm.js.map
	curl https://cdn.jsdelivr.net/npm/xterm@5.2.1/css/xterm.css > build/xterm.css

update-package-json-version:
	git describe --tags --exclude latest | sed 's/-/./' | tr - + | tee build/version
	jq --arg version "$$(cat build/version)" '.version = $$version' package.json > package.json.tmp
	mv package.json.tmp package.json
