# To run / debug locally
%.bin: %.asm
	nasm -felf32 -o $@.o $<; ld -g $@.o -m elf_i386 -o $@

# To use as a multiboot kernel image for v86
%.img: %.asm
	nasm -felf32 -o $@.o $<; ld -g $@.o -m elf_i386 --section-start=.text=0x8000 -o $@

clean:
	rm -f *.o *.bin *.img
