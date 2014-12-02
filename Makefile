CLOSURE=../closure-compiler/compiler.jar
BROWSER=chromium

CPP_VERSION := $(shell cpp --version 2>/dev/null)

ifdef CPP_VERSION
	CPP=cpp -P -undef -Wundef -std=c99 -nostdinc -Wtrigraphs -fdollars-in-identifiers -C
else
	CPP=mcpp/src/mcpp -a -C -P 
endif


all: build/v86_all.js
browser: build/v86_all.js
node: src/node/v86_node.js

build/cpu.js: src/*.macro.js
	# build cpu.macro.js using cpp or mcpp
	$(CPP) src/cpu.macro.js build/cpu.js 

# Used for nodejs builds and in order to profile code.
# `debug` gives identifiers a readable name, make sure it doesn't have any side effects. 
CLOSURE_READABLE=--formatting PRETTY_PRINT --debug

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


CORE_FILES=const.js io.js main.js fpu.js ide.js pci.js floppy.js memory.js\
		   dma.js pit.js vga.js ps2.js pic.js rtc.js uart.js hpet.js acpi.js\
		   state.js ne2k.js virtio.js
LIB_FILES=../lib/9p.js ../lib/filesystem.js ../lib/jor1k.js ../lib/marshall.js ../lib/utf8.js
BROWSER_FILES=browser/main.js browser/screen.js\
			  browser/keyboard.js browser/mouse.js browser/serial.js\
			  browser/network.js browser/lib.js
NODE_FILES=node/main.js node/keyboard_sdl.js\
		   node/screen_sdl.js node/keyboard_tty.js node/screen_tty.js

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
	 	--js ../build/cpu.js

	echo "//# sourceMappingURL=v86_all.js.map" >> build/v86_all.js
	ls -lh build/v86_all.js


src/node/v86_node.js: src/*.js src/node/*.js
	cd src &&\
	java -jar $(CLOSURE) \
		--js_output_file "node/v86_node.js"\
		--define=DEBUG=false\
		--define=IN_NODE=true\
		--define=IN_BROWSER=false\
		--define=IN_WORKER=false\
		$(CLOSURE_FLAGS)\
		$(CLOSURE_READABLE)\
		--js $(CORE_FILES)\
		--js $(LIB_FILES)\
		--js $(NODE_FILES)

build/libv86.js: src/*.js build/cpu.js
	cd src &&\
	java -jar $(CLOSURE) \
		--js_output_file "../build/libv86.js"\
		--define=DEBUG=false\
		--define=IN_CLOSURE=false\
		--externs adapter-externs.js\
		$(CLOSURE_FLAGS)\
		$(CLOSURE_READABLE)\
		--js $(CORE_FILES)\
		--js $(LIB_FILES)\
	 	--js ../build/cpu.js

clean:
	rm -f build/*

run:
	python2 -m SimpleHTTPServer 2> /dev/null 
	#sleep 1
	#$(BROWSER) http://localhost:8000/index.html &
