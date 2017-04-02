#include "libcflat.h"
#include "apic.h"
#include "asm/io.h"

#define KBD_CCMD_READ_OUTPORT   0xD0    /* read output port */
#define KBD_CCMD_WRITE_OUTPORT  0xD1    /* write output port */
#define KBD_CCMD_RESET          0xFE    /* CPU reset */

static inline void kbd_cmd(u8 val)
{
    while (inb(0x64) & 2);
    outb(val, 0x64);
}

static inline u8 kbd_in(void)
{
    kbd_cmd(KBD_CCMD_READ_OUTPORT);
    while (inb(0x64) & 2);
    return inb(0x60);
}

static inline void kbd_out(u8 val)
{
    kbd_cmd(KBD_CCMD_WRITE_OUTPORT);
    while (inb(0x64) & 2);
    outb(val, 0x60);
}

static inline void rtc_out(u8 reg, u8 val)
{
    outb(reg, 0x70);
    outb(val, 0x71);
}

extern char resume_start, resume_end;

#define state (*(volatile int *)0x2000)
#define bad (*(volatile int *)0x2004)
#define resumed (*(volatile int *)0x2008)

int main(int argc, char **argv)
{
	volatile u16 *resume_vector_ptr = (u16 *)0x467L;
	char *addr, *resume_vec = (void*)0x1000;

	/* resume execution by indirect jump via 40h:0067h */
	rtc_out(0x0f, 0x0a);
	resume_vector_ptr[0] = ((u32)(ulong)resume_vec);
	resume_vector_ptr[1] = 0;

	for (addr = &resume_start; addr < &resume_end; addr++)
		*resume_vec++ = *addr;

	if (state != 0) {
		/*
		 * Strictly speaking this is a firmware problem, but let's check
		 * for it as well...
		 */
		if (resumed != 1) {
			printf("Uh, resume vector visited %d times?\n", resumed);
			bad |= 2;
		}
		/*
		 * Port 92 bit 0 is cleared on system reset.  On a soft reset it
		 * is left to 1.  Use this to distinguish INIT from hard reset.
		 */
		if (resumed != 0 && (inb(0x92) & 1) == 0) {
			printf("Uh, hard reset!\n");
			bad |= 1;
		}
	}

	resumed = 0;

	switch (state++) {
	case 0:
		printf("testing port 92 init... ");
		outb(inb(0x92) & ~1, 0x92);
		outb(inb(0x92) | 1, 0x92);
		break;

	case 1:
		printf("testing kbd controller reset... ");
		kbd_cmd(KBD_CCMD_RESET);
		break;

	case 2:
		printf("testing kbd controller init... ");
		kbd_out(kbd_in() & ~1);
		break;

	case 3:
		printf("testing 0xcf9h init... ");
		outb(0, 0xcf9);
		outb(4, 0xcf9);
		break;

	case 4:
		printf("testing init to BSP... ");
		apic_icr_write(APIC_DEST_SELF | APIC_DEST_PHYSICAL
			      | APIC_DM_INIT, 0);
		break;

	case 5:
		exit(bad);
	}

	/* The resume code will get us back to main.  */
	asm("cli; hlt");
	__builtin_unreachable();
}

asm (
	".global resume_start\n"
	".global resume_end\n"
	".code16\n"
	"resume_start:\n"
	"incb %cs:0x2008\n"		// resumed++;
	"mov $0x0f, %al\n"		// rtc_out(0x0f, 0x00);
	"out %al, $0x70\n"
	"mov $0x00, %al\n"
	"out %al, $0x71\n"
	"jmp $0xffff, $0x0000\n"	// BIOS reset
	"resume_end:\n"
#ifdef __i386__
	".code32\n"
#else
	".code64\n"
#endif
    );
