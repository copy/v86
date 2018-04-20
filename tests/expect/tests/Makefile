build_dir := build
source_files := $(wildcard *.asm)
executable_files := $(patsubst %.asm,$(build_dir)/%.bin,$(source_files))

.PHONY: all
all: $(build_dir) $(executable_files)

$(build_dir):
	mkdir -p $@

$(build_dir)/%.bin: %.asm
	nasm $< -o $@

.PHONY: clean
clean:
	rm $(build_dir)/*
