source_files := $(wildcard *.asm)
host_executables := $(patsubst %.asm,%.bin,$(source_files))
v86_executables := $(patsubst %.asm,%.img,$(source_files))
host_fixtures := $(patsubst %.asm,%.fixture,$(source_files))

all: $(host_executables) $(v86_executables) $(host_fixtures)
.PHONY: all

# To run / debug locally
%.bin: %.asm *.inc
	nasm -felf32 -o $@.o $<; ld -g $@.o -m elf_i386 -o $@

# To generate a fixture using gdb
%.fixture: %.bin
	gdb -quiet -batch -x gdbauto $< > $@

# To use as a multiboot kernel image for v86
%.img: %.asm *.inc
	nasm -felf32 -o $@.o $<; ld -g $@.o -m elf_i386 --section-start=.text=0x8000 -o $@

clean:
	rm -f *.o *.bin *.img *.fixture
