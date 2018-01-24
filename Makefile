CLOSURE_DIR=closure-compiler
CLOSURE=$(CLOSURE_DIR)/compiler.jar
BROWSER=chromium
NASM_TEST_DIR=./tests/nasm

all: build/v86_all.js
browser: build/v86_all.js

ACPI=false
ifeq ($(useacpi),true)
ACPI=true
endif

# Used for nodejs builds and in order to profile code.
# `debug` gives identifiers a readable name, make sure it doesn't have any side effects.
CLOSURE_READABLE=--formatting PRETTY_PRINT --debug

CLOSURE_SOURCE_MAP=\
		--source_map_format V3\
		--source_map_include_content\
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
	   state.js ne2k.js sb16.js virtio.js bus.js log.js \
	   cpu.js translate.js modrm.js string.js arith.js misc_instr.js instructions.js debug.js \
	   elf.js
LIB_FILES=9p.js filesystem.js jor1k.js marshall.js utf8.js
BROWSER_FILES=screen.js \
	      keyboard.js mouse.js speaker.js serial.js \
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
		--define=ENABLE_ACPI=$(ACPI)\
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
		--define=ENABLE_ACPI=$(ACPI)\
		$(CLOSURE_FLAGS)\
		--compilation_level SIMPLE\
		$(TRANSPILE_ES6_FLAGS)\
		--output_wrapper ';(function(){%output%}).call(this);'\
		--js $(CORE_FILES)\
		--js $(BROWSER_FILES)\
		--js $(LIB_FILES)

	ls -lh build/libv86.js

clean:
	-rm build/libv86.js
	-rm build/v86_all.js
	-rm build/libv86.js.map
	-rm build/v86_all.js.map
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

tests: build/libv86.js
	./tests/full/run.js

nasmtests: build/libv86.js
	$(MAKE) -C $(NASM_TEST_DIR) all
	$(NASM_TEST_DIR)/run.js

qemutests: build/libv86.js
	make -C tests/qemu test-i386
	./tests/qemu/run.js > result
	./tests/qemu/test-i386 > reference
	diff result reference

kvm-unit-test: build/libv86.js
	(cd tests/kvm-unit-tests && ./configure)
	make -C tests/kvm-unit-tests
	tests/kvm-unit-tests/run.js tests/kvm-unit-tests/x86/realmode.flat
