#ifndef CFLAT_APIC_H
#define CFLAT_APIC_H

#include <stdint.h>
#include "apic-defs.h"

typedef struct {
    uint8_t vector;
    uint8_t delivery_mode:3;
    uint8_t dest_mode:1;
    uint8_t delivery_status:1;
    uint8_t polarity:1;
    uint8_t remote_irr:1;
    uint8_t trig_mode:1;
    uint8_t mask:1;
    uint8_t reserve:7;
    uint8_t reserved[4];
    uint8_t dest_id;
} ioapic_redir_entry_t;

typedef enum trigger_mode {
	TRIGGER_EDGE = 0,
	TRIGGER_LEVEL,
	TRIGGER_MAX,
} trigger_mode_t;

void mask_pic_interrupts(void);

void eoi(void);
uint8_t apic_get_tpr(void);
void apic_set_tpr(uint8_t tpr);

void ioapic_write_redir(unsigned line, ioapic_redir_entry_t e);
void ioapic_write_reg(unsigned reg, uint32_t value);
ioapic_redir_entry_t ioapic_read_redir(unsigned line);
uint32_t ioapic_read_reg(unsigned reg);

void set_mask(unsigned line, int mask);

void enable_apic(void);
uint32_t apic_read(unsigned reg);
bool apic_read_bit(unsigned reg, int n);
void apic_write(unsigned reg, uint32_t val);
void apic_icr_write(uint32_t val, uint32_t dest);
uint32_t apic_id(void);

int enable_x2apic(void);
void reset_apic(void);

#endif
