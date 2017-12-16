CLOSURE_DIR=closure-compiler
CLOSURE=$(CLOSURE_DIR)/compiler.jar
BROWSER=chromium
NASM_TEST_DIR=./tests/nasm

all: build/v86_all.js
browser: build/v86_all.js
wasm: build/v86.wasm

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
	        --js lib/closure-base.js\
		--generate_exports\
		--externs src/externs.js\
		--warning_level VERBOSE\
		--jscomp_error accessControls\
		--jscomp_error ambiguousFunctionDecl\
		--jscomp_error checkEventfulObjectDisposal\
		--jscomp_error checkRegExp\
		--jscomp_error checkTypes\
		--jscomp_error checkVars\
		--jscomp_error conformanceViolations\
		--jscomp_error const\
		--jscomp_error constantProperty\
		--jscomp_error deprecated\
		--jscomp_error deprecatedAnnotations\
		--jscomp_error duplicateMessage\
		--jscomp_error es3\
		--jscomp_error es5Strict\
		--jscomp_error externsValidation\
		--jscomp_error fileoverviewTags\
		--jscomp_error globalThis\
		--jscomp_error internetExplorerChecks\
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
		--language_in ECMASCRIPT5_STRICT

TRANSPILE_ES6_FLAGS=\
		--language_in ECMASCRIPT6_STRICT\
		--language_out ECMASCRIPT5_STRICT\


CORE_FILES=const.js config.js io.js main.js lib.js fpu.js ide.js pci.js floppy.js memory.js \
	   dma.js pit.js vga.js ps2.js pic.js rtc.js uart.js hpet.js acpi.js apic.js ioapic.js \
	   state.js ne2k.js virtio.js bus.js log.js \
	   cpu.js translate.js modrm.js string.js arith.js misc_instr.js instructions.js debug.js \
	   elf.js codegen.js
LIB_FILES=9p.js filesystem.js jor1k.js marshall.js utf8.js
BROWSER_FILES=screen.js \
	      keyboard.js mouse.js serial.js \
	      network.js lib.js starter.js worker_bus.js dummy_screen.js

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
		$(TRANSPILE_ES6_FLAGS)\
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
		$(TRANSPILE_ES6_FLAGS)\
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
		$(TRANSPILE_ES6_FLAGS)\
		--output_wrapper ';(function(){%output%}).call(this);'\
		--js $(CORE_FILES)\
		--js $(BROWSER_FILES)\
		--js $(LIB_FILES)

build/v86.wasm: src/native/*.c src/native/*.h src/native/codegen/*.c src/native/codegen/*.h
	mkdir -p build
	-ls -lh build/v86.wasm
	# --llvm-opts 3
	# -Wno-extra-semi
	# EMCC_DEBUG=1  EMCC_WASM_BACKEND=1
	# -fno-inline
	emcc src/native/all.c src/native/codegen/api.c \
	    -Isrc/native/ -Isrc/native/profiler/ \
	    -Wall -Wpedantic -Wextra \
	    -DDEBUG=false \
	    -DNDEBUG \
	    -Wno-bitwise-op-parentheses -Wno-gnu-binary-literal \
	    -fcolor-diagnostics \
	    -fwrapv \
	    --llvm-opts 3 \
	    --llvm-lto 3 \
	    -O3 \
	    -g4 \
	    -s LEGALIZE_JS_FFI=0 \
	    -s "BINARYEN_TRAP_MODE='allow'" \
	    -s WASM=1 -s SIDE_MODULE=1 -o build/v86.wasm
	ls -lh build/v86.wasm

build/v86-debug.wasm: src/native/*.c src/native/*.h src/native/codegen/*.c src/native/codegen/*.h
	emcc src/native/all.c src/native/codegen/api.c \
	    -Isrc/native/ -Isrc/native/profiler/ \
	    -Wall -Wpedantic -Wextra \
	    -Wno-bitwise-op-parentheses -Wno-gnu-binary-literal \
	    -fcolor-diagnostics \
	    -fwrapv \
	    -Os \
	    -g4 \
	    -s LEGALIZE_JS_FFI=0 \
	    -s "BINARYEN_TRAP_MODE='allow'" \
	    -s WASM=1 -s SIDE_MODULE=1 -o build/v86-debug.wasm
	ls -lh build/v86-debug.wasm

build/codegen-test.wasm: src/native/*.c src/native/*.h src/native/codegen/*.c src/native/codegen/*.h
	emcc src/native/codegen/api.c \
	    -Isrc/native/ -Isrc/native/profiler/ \
	    -Wall -Wpedantic -Wextra \
	    -Wno-bitwise-op-parentheses -Wno-gnu-binary-literal \
	    -fcolor-diagnostics \
	    -fwrapv \
	    -Os \
	    -g4 \
	    -s LEGALIZE_JS_FFI=0 \
	    -s "BINARYEN_TRAP_MODE='allow'" \
	    -s WASM=1 -s SIDE_MODULE=1 -o build/codegen-test.wasm
	ls -lh build/codegen-test.wasm

clean:
	-rm build/libv86.js
	-rm build/libv86-debug.js
	-rm build/v86_all.js
	-rm build/v86.wasm
	-rm build/v86-debug.wasm
	-rm build/*.map
	-rm build/*.wast
	$(MAKE) -C $(NASM_TEST_DIR) clean

run:
	python2 -m SimpleHTTPServer 2> /dev/null
	#sleep 1
	#$(BROWSER) http://localhost:8000/index.html &

update_version:
	set -e ;\
	COMMIT=`git log --format="%h" -n 1` ;\
	DATE=`git log --date="format:%b %e, %Y %H:%m" --format="%cd" -n 1` ;\
	SEARCH='<code>Version: <a href="https://github.com/copy/v86/commits/[a-f0-9]\+">[a-f0-9]\+</a> ([^(]\+)</a></code>' ;\
	REPLACE='<code>Version: <a href="https://github.com/copy/v86/commits/'$$COMMIT'">'$$COMMIT'</a> ('$$DATE')</a></code>' ;\
	sed -i "s@$$SEARCH@$$REPLACE@g" index.html ;\
	grep $$COMMIT index.html


$(CLOSURE):
	wget -P $(CLOSURE_DIR) http://dl.google.com/closure-compiler/compiler-latest.zip
	unzip -d closure-compiler $(CLOSURE_DIR)/compiler-latest.zip \*.jar
	mv $(CLOSURE_DIR)/*.jar $(CLOSURE)
	rm $(CLOSURE_DIR)/compiler-latest.zip

tests: build/libv86.js build/v86.wasm
	./tests/full/run.js

nasmtests: build/libv86-debug.js build/v86-debug.wasm
	$(MAKE) -C $(NASM_TEST_DIR) all
	$(NASM_TEST_DIR)/run.js

jitpagingtests: build/libv86.js build/v86.wasm
	$(MAKE) -C tests/jit-paging test-jit
	./tests/jit-paging/run.js

qemutests: build/libv86.js build/v86.wasm
	$(MAKE) -C tests/qemu test-i386
	./tests/qemu/run.js > /tmp/v86-test-result
	./tests/qemu/test-i386 > /tmp/v86-test-reference
	diff /tmp/v86-test-result /tmp/v86-test-reference

kvm-unit-test: build/libv86.js build/v86.wasm
	(cd tests/kvm-unit-tests && ./configure)
	$(MAKE) -C tests/kvm-unit-tests
	tests/kvm-unit-tests/run.js tests/kvm-unit-tests/x86/realmode.flat
