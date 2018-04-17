
source_files := $(wildcard *.asm)
executable_files := $(patsubst %.asm,build/%.bin,$(source_files))

all: $(executable_files)
	mkdir -p build

build/%.bin: %.asm
	nasm $< -o $@
