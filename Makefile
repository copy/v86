CLOSURE_DIR=closure-compiler
CLOSURE=$(CLOSURE_DIR)/compiler.jar
BROWSER=chromium

all: build/v86_all.js
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

CLOSURE_FLAGS=\
	        --js lib/closure-base.js\
		--generate_exports\
		--compilation_level ADVANCED_OPTIMIZATIONS\
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
		--jscomp_error inferredConstCheck\
		--jscomp_error internetExplorerChecks\
		--jscomp_error invalidCasts\
		--jscomp_error misplacedTypeAnnotation\
		--jscomp_error missingGetCssName\
		--jscomp_error missingProperties\
		--jscomp_error missingReturn\
		--jscomp_error msgDescriptions\
		--jscomp_error newCheckTypes\
		--jscomp_error nonStandardJsDocs\
		--jscomp_error suspiciousCode\
		--jscomp_error strictModuleDepCheck\
		--jscomp_error typeInvalidation\
		--jscomp_error undefinedNames\
		--jscomp_error undefinedVars\
		--jscomp_error unknownDefines\
		--jscomp_error unnecessaryCasts\
		--jscomp_error visibility\
		--use_types_for_optimization\
		--summary_detail_level 3\
		--language_in ECMASCRIPT5_STRICT


TRANSPILE_ES6_FLAGS=\
		--language_in ECMASCRIPT6_STRICT\
		--language_out ECMASCRIPT5_STRICT\


CORE_FILES=src/const.js src/io.js src/main.js src/lib.js src/fpu.js src/ide.js src/pci.js src/floppy.js src/memory.js\
	   src/dma.js src/pit.js src/vga.js src/ps2.js src/pic.js src/rtc.js src/uart.js src/hpet.js src/acpi.js src/apic.js\
	   src/state.js src/ne2k.js src/virtio.js src/bus.js src/log.js\
	   src/cpu.js src/translate.js src/modrm.js src/string.js src/arith.js src/misc_instr.js src/instructions.js src/debug.js
LIB_FILES=lib/9p.js lib/filesystem.js lib/jor1k.js lib/marshall.js lib/utf8.js
BROWSER_FILES=src/browser/screen.js\
	      src/browser/keyboard.js src/browser/mouse.js src/browser/serial.js\
	      src/browser/network.js src/browser/lib.js src/browser/starter.js src/browser/worker_bus.js

build/v86_all.js: $(CLOSURE) src/*.js src/browser/*.js lib/*.js
	mkdir -p build
	-ls -lh build/v86_all.js
	java -jar $(CLOSURE) \
		--js_output_file build/v86_all.js\
		--define=DEBUG=false\
		$(CLOSURE_SOURCE_MAP)\
		$(CLOSURE_FLAGS)\
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
		$(TRANSPILE_ES6_FLAGS)\
		--output_wrapper ';(function(){%output%})();'\
		--js $(CORE_FILES)\
		--js $(BROWSER_FILES)\
		--js $(LIB_FILES)

	ls -lh build/libv86.js

clean:
	-rm build/libv86.js
	-rm build/v86_all.js

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
