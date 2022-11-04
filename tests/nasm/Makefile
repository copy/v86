source_files := $(wildcard build/*.asm)
source_files += $(addprefix build/,$(wildcard *.asm))

obj_files := $(patsubst %.asm,%.o,$(source_files))
v86_executables := $(patsubst %.asm,%.img,$(source_files))

inc_files := $(addprefix build/,$(wildcard *.inc))

all: $(source_files) $(obj_files) $(inc_files) $(v86_executables)
.PHONY: all

build/%.o: build/%.asm $(inc_files)
	nasm -w+error -felf32 -o $@ $<

# used both as a multiboot image for v86 and as a regular elf executable for gdb
build/%.img: build/%.o
	ld -g $< -m elf_i386 --section-start=.bss=0x100000 --section-start=.text=0x80000 --section-start=.multiboot=0x20000 -o $@

build/%.asm: %.asm
	mkdir -p build; cp $< $@

build/%.inc: %.inc
	mkdir -p build; cp $< $@

.PHONY: clean
clean:
	rm -f *.o *.bin *.img *.fixture gen_*.asm # old location
	rm -f build/*.o build/*.bin build/*.img build/*.fixture build/*.asm
