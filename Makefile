CLOSURE=../closure-compiler/compiler.jar
BROWSER=chromium

CPP_VERSION := $(shell cpp --version 2>/dev/null)

# MacosX Hack : 
# "cpp" doesn't work as expected on MacosX
# So we define mcpp as default, and cpp IF NOT "on MacosX" AND "CPP is defined"
UNAME_S := $(shell uname -s)
CPP=mcpp/src/mcpp -a -C -P 
ifneq ($(UNAME_S),Darwin))
        ifdef CPP_VERSION
                CPP=cpp -P -undef -Wundef -std=c99 -nostdinc -Wtrigraphs -fdollars-in-identifiers -C
        endif
endif


all: build/v86_all.js
browser: build/v86_all.js

build/cpu.js: src/*.macro.js
	# build cpu.macro.js using cpp or mcpp
	$(CPP) src/cpu.macro.js build/cpu.js 

# Used for nodejs builds and in order to profile code.
# `debug` gives identifiers a readable name, make sure it doesn't have any side effects. 
#CLOSURE_READABLE=--formatting PRETTY_PRINT --debug
CLOSURE_READABLE=--formatting PRETTY_PRINT

CLOSURE_SOURCE_MAP=\
		--source_map_format V3\
		--create_source_map

CLOSURE_FLAGS=\
		--compilation_level ADVANCED_OPTIMIZATIONS\
		--externs externs.js\
		--warning_level VERBOSE\
		--jscomp_off uselessCode\
		--use_types_for_optimization\
		--summary_detail_level 3\
		--language_in ECMASCRIPT5_STRICT


CORE_FILES=const.js io.js main.js lib.js fpu.js ide.js pci.js floppy.js memory.js\
		   dma.js pit.js vga.js ps2.js pic.js rtc.js uart.js hpet.js acpi.js\
		   state.js ne2k.js virtio.js bus.js log.js
LIB_FILES=../lib/9p.js ../lib/filesystem.js ../lib/jor1k.js ../lib/marshall.js ../lib/utf8.js
BROWSER_FILES=browser/screen.js\
			  browser/keyboard.js browser/mouse.js browser/serial.js\
			  browser/network.js browser/lib.js browser/starter.js

build/v86_all.js: src/*.js src/browser/*.js build/cpu.js lib/*.js
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
		--js $(CORE_FILES)\
		--js $(LIB_FILES)\
		--js $(BROWSER_FILES)\
	 	--js ../build/cpu.js\
	 	--js browser/main.js

	echo "//# sourceMappingURL=v86_all.js.map" >> build/v86_all.js
	ls -lh build/v86_all.js


build/libv86.js: src/*.js build/cpu.js lib/*.js src/browser/*.js
	cd src &&\
	java -jar $(CLOSURE) \
		--js_output_file "../build/libv86.js"\
		--define=DEBUG=false\
		--define=IN_NODE=false\
		--define=IN_BROWSER=true\
		--define=IN_WORKER=false\
		$(CLOSURE_FLAGS)\
		--output_wrapper ';(function(){%output%})();'\
		--js $(CORE_FILES)\
		--js $(BROWSER_FILES)\
		--js $(LIB_FILES)\
	 	--js ../build/cpu.js

clean:
	rm -f build/*

run:
	python2 -m SimpleHTTPServer 2> /dev/null 
	#sleep 1
	#$(BROWSER) http://localhost:8000/index.html &
