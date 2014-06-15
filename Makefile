CLOSURE=../closure-compiler/compiler.jar
BROWSER=chromium

CPP_VERSION := $(shell cpp --version 2>/dev/null)

ifdef CPP_VERSION
	CPP=cpp -P -undef -Wundef -std=c99 -nostdinc -Wtrigraphs -fdollars-in-identifiers -C
else
	CPP=mcpp/src/mcpp -a -C -P 
endif


all: v86_all.js
browser: v86_all.js
node: v86_node.js

src/cpu.js: src/*.macro.js
	# build cpu.macro.js using cpp or mcpp
	$(CPP) src/cpu.macro.js src/cpu.js 

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


CORE_FILES=const.js io.js cpu.js main.js fpu.js ide.js pci.js floppy.js memory.js\
		   dma.js pit.js vga.js ps2.js pic.js rtc.js uart.js hpet.js acpi.js
BROWSER_FILES=browser/main.js browser/screen.js\
			  browser/keyboard.js browser/mouse.js browser/serial.js
NODE_FILES=node/main.js node/keyboard_sdl.js\
		   node/screen_sdl.js node/keyboard_tty.js node/screen_tty.js

v86_all.js: src/*.js src/browser/*.js src/cpu.js
	-ls -lh v86_all.js
	cd src &&\
	java -jar $(CLOSURE) \
		--js_output_file "../v86_all.js"\
		--define=DEBUG=false\
		--define=IN_NODE=false\
		--define=IN_BROWSER=true\
		--define=IN_WORKER=false\
		$(CLOSURE_SOURCE_MAP) v86_all.js.map\
		$(CLOSURE_FLAGS)\
		--js $(CORE_FILES)\
		--js $(BROWSER_FILES)

	echo "//# sourceMappingURL=src/v86_all.js.map" >> v86_all.js
	ls -lh v86_all.js


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
		--js $(CORE_FILES) \
		--js $(NODE_FILES)


pack:
	rm -f ../v86-latest.tar.gz 
		# Not sure if legally necessary
		#--exclude "qemu"
	tar -zcvf ../v86-latest.tar.gz ../v86/ \
		--exclude "images" \
		--exclude "mcpp" \
		--exclude "closure-compiler" \
		--exclude "screenshots" \
		--exclude ".git"



clean:
	rm -f v86-latest.tar.gz v86_all.js src/v86_all.js.map src/cpu.js

run:
	python2 -m SimpleHTTPServer 2> /dev/null &
	sleep 1
	$(BROWSER) http://localhost:8000/ &
