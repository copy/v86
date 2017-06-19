
CC=gcc
CC_I386=$(CC) -m32
QEMU_INCLUDES += -I../..
CFLAGS=-Wall -O2 -g -fno-strict-aliasing -static -mmmx -mno-sse
LDFLAGS=


# i386/x86_64 emulation test (test various opcodes) */
test-i386: test-i386.c test-i386-code16.S test-i386-vm86.S \
           test-i386.h test-i386-shift.h test-i386-muldiv.h
	$(CC_I386) $(QEMU_INCLUDES) $(CFLAGS) $(LDFLAGS) -o $@ \
              $(<D)/test-i386.c $(<D)/test-i386-code16.S $(<D)/test-i386-vm86.S -lm


clean:
	rm -f test-i386
