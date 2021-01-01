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

default: build/v86-debug.wasm
all: build/v86_all.js build/libv86.js build/v86.wasm
all-debug: build/libv86-debug.js build/v86-debug.wasm
browser: build/v86_all.js

# Used for nodejs builds and in order to profile code.
# `debug` gives identifiers a readable name, make sure it doesn't have any side effects.
CLOSURE_READABLE=--formatting PRETTY_PRINT --debug

CLOSURE_SOURCE_MAP=\
		--source_map_format V3\
		--create_source_map '%outname%.map'

		#--jscomp_error reportUnknownTypes\
		#--jscomp_error unusedLocalVariables\
		#--jscomp_error unusedPrivateMembers\
		#--new_type_inf\

		# Easily breaks code:
		#--assume_function_wrapper\

		# implies new type inferrence
		#--jscomp_error newCheckTypes\

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
		--jscomp_error missingGetCssName\
		--jscomp_error missingProperties\
		--jscomp_error missingReturn\
		--jscomp_error msgDescriptions\
		--jscomp_error nonStandardJsDocs\
		--jscomp_error suspiciousCode\
		--jscomp_error strictModuleDepCheck\
		--jscomp_error typeInvalidation\
		--jscomp_error undefinedNames\
		--jscomp_error undefinedVars\
		--jscomp_error unknownDefines\
		--jscomp_error visibility\
		--use_types_for_optimization\
		--summary_detail_level 3\
		--language_in ECMASCRIPT_2017\
		--language_out ECMASCRIPT_2017

CARGO_FLAGS=\
		--target wasm32-unknown-unknown \
		-- \
		-C linker=tools/rust-lld-wrapper \
		-C link-args="--import-table --global-base=18874368 $(STRIP_DEBUG_FLAG)" \
		--verbose

CORE_FILES=const.js config.js io.js main.js lib.js ide.js pci.js floppy.js \
	   memory.js dma.js pit.js vga.js ps2.js pic.js rtc.js uart.js hpet.js acpi.js apic.js ioapic.js \
	   state.js ne2k.js virtio.js bus.js log.js \
	   cpu.js debug.js \
	   elf.js kernel.js
LIB_FILES=9p.js filesystem.js jor1k.js marshall.js utf8.js
BROWSER_FILES=screen.js \
		  keyboard.js mouse.js serial.js \
		  network.js lib.js starter.js worker_bus.js dummy_screen.js print_stats.js filestorage.js

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

	echo '//# sourceMappingURL=v86_all.js.map' >> build/v86_all.js

	ls -lh build/v86_all.js


build/libv86.js: $(CLOSURE) src/*.js lib/*.js src/browser/*.js
	mkdir -p build
	-ls -lh build/libv86.js
	java -jar $(CLOSURE) \
		--js_output_file build/libv86.js\
		--define=DEBUG=false\
		$(CLOSURE_FLAGS)\
		--compilation_level SIMPLE\
		--output_wrapper ';(function(){%output%}).call(this);'\
		--js $(CORE_FILES)\
		--js $(BROWSER_FILES)\
		--js $(LIB_FILES)
	ls -lh build/libv86.js

build/libv86-debug.js: $(CLOSURE) src/*.js lib/*.js src/browser/*.js
	mkdir -p build
	java -jar $(CLOSURE) \
		--js_output_file build/libv86-debug.js\
		--define=DEBUG=true\
		$(CLOSURE_FLAGS)\
		$(CLOSURE_READABLE)\
		--compilation_level SIMPLE\
		--output_wrapper ';(function(){%output%}).call(this);'\
		--js $(CORE_FILES)\
		--js $(BROWSER_FILES)\
		--js $(LIB_FILES)


.PHONY: instruction_tables
instruction_tables: $(INSTRUCTION_TABLES)

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

build/v86.wasm: $(RUST_FILES) Cargo.toml
	mkdir -p build/
	-ls -lh build/v86.wasm
	cargo +nightly rustc --release $(CARGO_FLAGS)
	mv build/wasm32-unknown-unknown/release/v86.wasm build/v86.wasm
	ls -lh build/v86.wasm

build/v86-debug.wasm: $(RUST_FILES) Cargo.toml
	mkdir -p build/
	-ls -lh build/v86-debug.wasm
	cargo +nightly rustc $(CARGO_FLAGS)
	mv build/wasm32-unknown-unknown/debug/v86.wasm build/v86-debug.wasm
	ls -lh build/v86-debug.wasm

clean:
	-rm build/libv86.js
	-rm build/libv86-debug.js
	-rm build/v86_all.js
	-rm build/v86.wasm
	-rm build/v86-debug.wasm
	-rm $(INSTRUCTION_TABLES)
	-rm build/*.map
	-rm build/*.wast
	$(MAKE) -C $(NASM_TEST_DIR) clean

run:
	python3 -m http.server 2> /dev/null

update_version:
	set -e ;\
	COMMIT=`git log --format="%h" -n 1` ;\
	DATE=`git log --date="format:%b %e, %Y %H:%m" --format="%cd" -n 1` ;\
	SEARCH='<code>Version: <a href="https://github.com/copy/v86/commits/[a-f0-9]\+">[a-f0-9]\+</a> ([^(]\+)</code>' ;\
	REPLACE='<code>Version: <a href="https://github.com/copy/v86/commits/'$$COMMIT'">'$$COMMIT'</a> ('$$DATE')</code>' ;\
	sed -i "s@$$SEARCH@$$REPLACE@g" index.html ;\
	grep $$COMMIT index.html


$(CLOSURE):
	wget -nv -P $(CLOSURE_DIR) http://dl.google.com/closure-compiler/compiler-latest.zip
	unzip -d closure-compiler $(CLOSURE_DIR)/compiler-latest.zip \*.jar
	mv $(CLOSURE_DIR)/*.jar $(CLOSURE)
	rm $(CLOSURE_DIR)/compiler-latest.zip

tests: all-debug
	mkdir -p images/integration-test-fs/flat # XXX
	cp images/bzImage images/integration-test-fs/
	touch images/integration-test-fs/initrd
	cd images/integration-test-fs && tar cfv fs.tar bzImage initrd
	./tools/fs2json.py images/integration-test-fs/fs.tar --out images/integration-test-fs/fs.json
	./tools/copy-to-sha256.py images/integration-test-fs/fs.tar images/integration-test-fs/flat
	./tests/full/run.js

tests-release: all
	mkdir -p images/integration-test-fs/flat # XXX
	cp images/bzImage images/integration-test-fs/
	touch images/integration-test-fs/initrd
	cd images/integration-test-fs && tar cfv fs.tar bzImage initrd
	./tools/fs2json.py images/integration-test-fs/fs.tar --out images/integration-test-fs/fs.json
	./tools/copy-to-sha256.py images/integration-test-fs/fs.tar images/integration-test-fs/flat
	TEST_RELEASE_BUILD=1 ./tests/full/run.js

nasmtests: all-debug
	$(MAKE) -C $(NASM_TEST_DIR) all
	$(NASM_TEST_DIR)/gen_fixtures.js
	$(NASM_TEST_DIR)/run.js

nasmtests-force-jit: all-debug
	$(MAKE) -C $(NASM_TEST_DIR) all
	$(NASM_TEST_DIR)/gen_fixtures.js
	$(NASM_TEST_DIR)/run.js --force-jit

jitpagingtests: all-debug
	$(MAKE) -C tests/jit-paging test-jit
	./tests/jit-paging/run.js

qemutests: all-debug
	$(MAKE) -C tests/qemu test-i386
	./tests/qemu/run.js > /tmp/v86-test-result
	#./tests/qemu/test-i386 > /tmp/v86-test-reference
	./tests/qemu/run-qemu.js > /tmp/v86-test-reference
	diff /tmp/v86-test-result /tmp/v86-test-reference

qemutests-release: all
	$(MAKE) -C tests/qemu test-i386
	time ./tests/qemu/run.js > /tmp/v86-test-result
	#./tests/qemu/test-i386 > /tmp/v86-test-reference
	./tests/qemu/run-qemu.js > /tmp/v86-test-reference
	diff /tmp/v86-test-result /tmp/v86-test-reference

kvm-unit-test: all-debug
	(cd tests/kvm-unit-tests && ./configure && make)
	tests/kvm-unit-tests/run.js tests/kvm-unit-tests/x86/realmode.flat

kvm-unit-test-release: all
	(cd tests/kvm-unit-tests && ./configure && make)
	TEST_RELEASE_BUILD=1 tests/kvm-unit-tests/run.js tests/kvm-unit-tests/x86/realmode.flat

expect-tests: all-debug build/libwabt.js
	make -C tests/expect/tests
	./tests/expect/run.js

devices-test: all-debug
	./tests/devices/virtio_9p.js

rust-test: $(RUST_FILES)
	# RUSTFLAGS="-D warnings"
	env RUST_BACKTRACE=full RUST_TEST_THREADS=1 cargo +nightly test -- --nocapture
	./tests/rust/verify-wasmgen-dummy-output.js

rust-no-warnings:
	RUSTFLAGS="-D warnings" make all all-debug

rust-test-intensive:
	QUICKCHECK_TESTS=100000000 make rust-test

api-tests: all-debug
	./tests/api/clean-shutdown.js
	./tests/api/state.js
	./tests/api/reset.js

all-tests: jshint kvm-unit-test qemutests jitpagingtests api-tests rust-test nasmtests nasmtests-force-jit tests expect-tests
	# Skipping:
	# - debiantests (requires network)
	# - devices-test (hangs)

jshint:
	jshint --config=./.jshint.json src tests gen lib --exclude lib/closure-base.js

rustfmt: $(RUST_FILES)
	cargo +nightly fmt --all -- --check

build/capstone-x86.min.js:
	mkdir -p build
	wget -P build https://github.com/AlexAltea/capstone.js/releases/download/v3.0.5-rc1/capstone-x86.min.js

build/libwabt.js:
	mkdir -p build
	wget -P build https://github.com/WebAssembly/wabt/archive/1.0.6.zip
	unzip -j -d build/ build/1.0.6.zip wabt-1.0.6/demo/libwabt.js
	rm build/1.0.6.zip

build/xterm.js:
	curl https://cdn.jsdelivr.net/npm/xterm@4.2.0-vscode1/lib/xterm.js > build/xterm.js
	curl https://cdn.jsdelivr.net/npm/xterm@4.2.0-vscode1/lib/xterm.js.map > build/xterm.js.map
	curl https://cdn.jsdelivr.net/npm/xterm@4.2.0-vscode1/css/xterm.css > build/xterm.css
