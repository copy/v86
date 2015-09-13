CLOSURE=../closure-compiler/compiler.jar
BROWSER=chromium

all: build/v86_all.js
browser: build/v86_all.js

# Used for nodejs builds and in order to profile code.
# `debug` gives identifiers a readable name, make sure it doesn't have any side effects.
CLOSURE_READABLE=--formatting PRETTY_PRINT --debug

CLOSURE_SOURCE_MAP=\
		--source_map_format V3\
		--create_source_map

		#--jscomp_error reportUnknownTypes\

CLOSURE_FLAGS=\
		--compilation_level ADVANCED_OPTIMIZATIONS\
		--externs externs.js\
		--warning_level VERBOSE\
		--jscomp_off uselessCode\
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


CORE_FILES=const.js io.js main.js lib.js fpu.js ide.js pci.js floppy.js memory.js\
		   dma.js pit.js vga.js ps2.js pic.js rtc.js uart.js hpet.js acpi.js apic.js\
		   state.js ne2k.js virtio.js bus.js log.js\
		   cpu.js translate.js modrm.js string.js arith.js misc_instr.js instructions.js debug.js
LIB_FILES=../lib/9p.js ../lib/filesystem.js ../lib/jor1k.js ../lib/marshall.js ../lib/utf8.js
BROWSER_FILES=browser/screen.js\
		  browser/keyboard.js browser/mouse.js browser/serial.js\
		  browser/network.js browser/lib.js browser/starter.js browser/worker_bus.js

build/v86_all.js: src/*.js src/browser/*.js lib/*.js
	-ls -lh build/v86_all.js
	cd src &&\
	java -jar $(CLOSURE) \
		--js_output_file "../build/v86_all.js"\
		--define=DEBUG=false\
		--define=IN_NODE=false\
		--define=IN_BROWSER=true\
		--define=IN_WORKER=false\
		$(CLOSURE_SOURCE_MAP) ../build/v86_all.js.map\
		$(CLOSURE_FLAGS)\
		$(TRANSPILE_ES6_FLAGS)\
		--js $(CORE_FILES)\
		--js $(LIB_FILES)\
		--js $(BROWSER_FILES)\
		--js browser/main.js

	echo "//# sourceMappingURL=v86_all.js.map" >> build/v86_all.js
	ls -lh build/v86_all.js


build/libv86.js: src/*.js lib/*.js src/browser/*.js
	-ls -lh build/libv86.js
	cd src &&\
	java -jar $(CLOSURE) \
		--js_output_file "../build/libv86.js"\
		--define=DEBUG=false\
		--define=IN_NODE=false\
		--define=IN_BROWSER=true\
		--define=IN_WORKER=false\
		$(CLOSURE_FLAGS)\
		$(TRANSPILE_ES6_FLAGS)\
		--output_wrapper ';(function(){%output%})();'\
		--js $(CORE_FILES)\
		--js $(BROWSER_FILES)\
		--js $(LIB_FILES)

	ls -lh build/libv86.js

clean:
	rm -f build/*

run:
	python2 -m SimpleHTTPServer 2> /dev/null
	#sleep 1
	#$(BROWSER) http://localhost:8000/index.html &
