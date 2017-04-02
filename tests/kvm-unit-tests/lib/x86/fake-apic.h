#ifndef SILLY_APIC_H
#define SILLY_APIC_H

#define APIC_BASE 0x1000
#define APIC_SIZE 0x100

#define APIC_REG_NCPU        0x00
#define APIC_REG_ID          0x04
#define APIC_REG_SIPI_ADDR   0x08
#define APIC_REG_SEND_SIPI   0x0c
#define APIC_REG_IPI_VECTOR  0x10
#define APIC_REG_SEND_IPI    0x14

#endif
