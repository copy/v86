#include "libcflat.h"
#include "x86/acpi.h"
#include "asm/io.h"

u32* find_resume_vector_addr(void)
{
    struct facs_descriptor_rev1 *facs = find_acpi_table_addr(FACS_SIGNATURE);
    if (!facs)
        return 0;
    printf("FACS is at %p\n", facs);
    return &facs->firmware_waking_vector;
}

#define RTC_SECONDS_ALARM       1
#define RTC_MINUTES_ALARM       3
#define RTC_HOURS_ALARM         5
#define RTC_ALARM_DONT_CARE     0xC0

#define RTC_REG_A               10
#define RTC_REG_B               11
#define RTC_REG_C               12

#define REG_A_UIP               0x80
#define REG_B_AIE               0x20

static inline int rtc_in(u8 reg)
{
    outb(reg, 0x70);
    return inb(0x71);
}

static inline void rtc_out(u8 reg, u8 val)
{
    outb(reg, 0x70);
    outb(val, 0x71);
}

extern char resume_start, resume_end;

int main(int argc, char **argv)
{
	struct fadt_descriptor_rev1 *fadt = find_acpi_table_addr(FACP_SIGNATURE);
	volatile u32 *resume_vector_ptr = find_resume_vector_addr();
	char *addr, *resume_vec = (void*)0x1000;

	*resume_vector_ptr = (u32)(ulong)resume_vec;

	printf("resume vector addr is %p\n", resume_vector_ptr);
	for (addr = &resume_start; addr < &resume_end; addr++)
		*resume_vec++ = *addr;
	printf("copy resume code from %p\n", &resume_start);

	printf("PM1a event registers at %x\n", fadt->pm1a_evt_blk);
	outw(0x400, fadt->pm1a_evt_blk + 2);

	/* Setup RTC alarm to wake up on the next second.  */
	while ((rtc_in(RTC_REG_A) & REG_A_UIP) == 0);
	while ((rtc_in(RTC_REG_A) & REG_A_UIP) != 0);
	rtc_in(RTC_REG_C);
	rtc_out(RTC_SECONDS_ALARM, RTC_ALARM_DONT_CARE);
	rtc_out(RTC_MINUTES_ALARM, RTC_ALARM_DONT_CARE);
	rtc_out(RTC_HOURS_ALARM, RTC_ALARM_DONT_CARE);
	rtc_out(RTC_REG_B, rtc_in(RTC_REG_B) | REG_B_AIE);

	*(volatile int*)0 = 0;
	asm volatile("outw %0, %1" :: "a"((short)0x2400), "d"((short)fadt->pm1a_cnt_blk):"memory");
	while(1)
		*(volatile int*)0 = 1;

	return 0;
}

asm (
        ".global resume_start\n"
	".global resume_end\n"
	".code16\n"
	"resume_start:\n"
	"mov 0x0, %eax\n"
	"mov $0xf4, %dx\n"
	"out %eax, %dx\n"
	"1: hlt\n"
	"jmp 1b\n"
	"resume_end:\n"
#ifdef __i386__
	".code32\n"
#else
	".code64\n"
#endif
    );
