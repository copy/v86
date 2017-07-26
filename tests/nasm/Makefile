source_files := $(wildcard build/*.asm)
source_files += $(addprefix build/,$(wildcard *.asm))

host_executables := $(patsubst %.asm,%.bin,$(source_files))
v86_executables := $(patsubst %.asm,%.img,$(source_files))
host_fixtures := $(patsubst %.asm,%.fixture,$(source_files))

inc_files := $(addprefix build/,$(wildcard *.inc))

all: $(source_files) $(host_executables) $(v86_executables) $(host_fixtures)
.PHONY: all

# To run / debug locally
build/%.bin: build/%.asm $(inc_files)
	nasm -felf32 -o $@.o $<; ld -g $@.o -m elf_i386 --section-start=.bss=0x100000 -o $@

# To generate a fixture using gdb
build/%.fixture: build/%.bin
	gdb -quiet -batch -x gdbauto $< > $@

# To use as a multiboot kernel image for v86
build/%.img: build/%.asm $(inc_files)
	nasm -felf32 -o $@.o $<; ld -g $@.o -m elf_i386 --section-start=.bss=0x100000 --section-start=.text=0x8000 -o $@

build/%.asm: %.asm
	mkdir -p build; cp $< $@

build/%.inc: %.inc
	mkdir -p build; cp $< $@

clean:
	rm -f *.o *.bin *.img *.fixture gen_*.asm # old location
	rm -f build/*.o build/*.bin build/*.img build/*.fixture build/*.asm
