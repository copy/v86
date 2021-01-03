CC=gcc
CC_I386=$(CC) -m32
CFLAGS=-Wall -g -fno-strict-aliasing -fPIC -static
LDFLAGS=


test-jit: test-jit.c
	$(CC_I386) $(CFLAGS) $(LDFLAGS) -o $@ $(<D)/test-jit.c

clean:
	rm -f test-jit
