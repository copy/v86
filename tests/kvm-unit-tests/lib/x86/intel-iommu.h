/*
 * Intel IOMMU header
 *
 * Copyright (C) 2016 Red Hat, Inc.
 *
 * Authors:
 *   Peter Xu <peterx@redhat.com>,
 *
 * This work is licensed under the terms of the GNU LGPL, version 2 or
 * later.
 *
 * (From include/linux/intel-iommu.h)
 */

#ifndef __INTEL_IOMMU_H__
#define __INTEL_IOMMU_H__

#include "libcflat.h"
#include "vm.h"
#include "isr.h"
#include "smp.h"
#include "desc.h"
#include "pci.h"
#include "asm/io.h"
#include "apic.h"

#define Q35_HOST_BRIDGE_IOMMU_ADDR  0xfed90000ULL
#define VTD_PAGE_SHIFT              PAGE_SHIFT
#define VTD_PAGE_SIZE               PAGE_SIZE

/*
 * Intel IOMMU register specification
 */
#define DMAR_VER_REG            0x0  /* Arch version supported by this IOMMU */
#define DMAR_CAP_REG            0x8  /* Hardware supported capabilities */
#define DMAR_CAP_REG_HI         0xc  /* High 32-bit of DMAR_CAP_REG */
#define DMAR_ECAP_REG           0x10 /* Extended capabilities supported */
#define DMAR_ECAP_REG_HI        0X14
#define DMAR_GCMD_REG           0x18 /* Global command */
#define DMAR_GSTS_REG           0x1c /* Global status */
#define DMAR_RTADDR_REG         0x20 /* Root entry table */
#define DMAR_RTADDR_REG_HI      0X24
#define DMAR_CCMD_REG           0x28 /* Context command */
#define DMAR_CCMD_REG_HI        0x2c
#define DMAR_FSTS_REG           0x34 /* Fault status */
#define DMAR_FECTL_REG          0x38 /* Fault control */
#define DMAR_FEDATA_REG         0x3c /* Fault event interrupt data */
#define DMAR_FEADDR_REG         0x40 /* Fault event interrupt addr */
#define DMAR_FEUADDR_REG        0x44 /* Upper address */
#define DMAR_AFLOG_REG          0x58 /* Advanced fault control */
#define DMAR_AFLOG_REG_HI       0X5c
#define DMAR_PMEN_REG           0x64 /* Enable protected memory region */
#define DMAR_PLMBASE_REG        0x68 /* PMRR low addr */
#define DMAR_PLMLIMIT_REG       0x6c /* PMRR low limit */
#define DMAR_PHMBASE_REG        0x70 /* PMRR high base addr */
#define DMAR_PHMBASE_REG_HI     0X74
#define DMAR_PHMLIMIT_REG       0x78 /* PMRR high limit */
#define DMAR_PHMLIMIT_REG_HI    0x7c
#define DMAR_IQH_REG            0x80 /* Invalidation queue head */
#define DMAR_IQH_REG_HI         0X84
#define DMAR_IQT_REG            0x88 /* Invalidation queue tail */
#define DMAR_IQT_REG_HI         0X8c
#define DMAR_IQA_REG            0x90 /* Invalidation queue addr */
#define DMAR_IQA_REG_HI         0x94
#define DMAR_ICS_REG            0x9c /* Invalidation complete status */
#define DMAR_IRTA_REG           0xb8 /* Interrupt remapping table addr */
#define DMAR_IRTA_REG_HI        0xbc
#define DMAR_IECTL_REG          0xa0 /* Invalidation event control */
#define DMAR_IEDATA_REG         0xa4 /* Invalidation event data */
#define DMAR_IEADDR_REG         0xa8 /* Invalidation event address */
#define DMAR_IEUADDR_REG        0xac /* Invalidation event address */
#define DMAR_PQH_REG            0xc0 /* Page request queue head */
#define DMAR_PQH_REG_HI         0xc4
#define DMAR_PQT_REG            0xc8 /* Page request queue tail*/
#define DMAR_PQT_REG_HI         0xcc
#define DMAR_PQA_REG            0xd0 /* Page request queue address */
#define DMAR_PQA_REG_HI         0xd4
#define DMAR_PRS_REG            0xdc /* Page request status */
#define DMAR_PECTL_REG          0xe0 /* Page request event control */
#define DMAR_PEDATA_REG         0xe4 /* Page request event data */
#define DMAR_PEADDR_REG         0xe8 /* Page request event address */
#define DMAR_PEUADDR_REG        0xec /* Page event upper address */
#define DMAR_MTRRCAP_REG        0x100 /* MTRR capability */
#define DMAR_MTRRCAP_REG_HI     0x104
#define DMAR_MTRRDEF_REG        0x108 /* MTRR default type */
#define DMAR_MTRRDEF_REG_HI     0x10c

#define VTD_GCMD_IR_TABLE       0x1000000
#define VTD_GCMD_IR             0x2000000
#define VTD_GCMD_QI             0x4000000
#define VTD_GCMD_WBF            0x8000000  /* Write Buffer Flush */
#define VTD_GCMD_SFL            0x20000000 /* Set Fault Log */
#define VTD_GCMD_ROOT           0x40000000
#define VTD_GCMD_DMAR           0x80000000
#define VTD_GCMD_ONE_SHOT_BITS  (VTD_GCMD_IR_TABLE | VTD_GCMD_WBF | \
				 VTD_GCMD_SFL | VTD_GCMD_ROOT)

/* Supported Adjusted Guest Address Widths */
#define VTD_CAP_SAGAW_SHIFT         8
/* 39-bit AGAW, 3-level page-table */
#define VTD_CAP_SAGAW_39bit         (0x2ULL << VTD_CAP_SAGAW_SHIFT)
/* 48-bit AGAW, 4-level page-table */
#define VTD_CAP_SAGAW_48bit         (0x4ULL << VTD_CAP_SAGAW_SHIFT)
#define VTD_CAP_SAGAW               VTD_CAP_SAGAW_39bit

/* Both 1G/2M huge pages */
#define VTD_CAP_SLLPS               ((1ULL << 34) | (1ULL << 35))

#define VTD_CONTEXT_TT_MULTI_LEVEL  0
#define VTD_CONTEXT_TT_DEV_IOTLB    1
#define VTD_CONTEXT_TT_PASS_THROUGH 2

#define VTD_PTE_R                   (1 << 0)
#define VTD_PTE_W                   (1 << 1)
#define VTD_PTE_RW                  (VTD_PTE_R | VTD_PTE_W)
#define VTD_PTE_ADDR                GENMASK_ULL(63, 12)
#define VTD_PTE_HUGE                (1 << 7)

extern void *vtd_reg_base;
#define vtd_reg(reg) ({ assert(vtd_reg_base); \
			(volatile void *)(vtd_reg_base + reg); })

static inline void vtd_writel(unsigned int reg, uint32_t value)
{
	__raw_writel(value, vtd_reg(reg));
}

static inline void vtd_writeq(unsigned int reg, uint64_t value)
{
	__raw_writeq(value, vtd_reg(reg));
}

static inline uint32_t vtd_readl(unsigned int reg)
{
	return __raw_readl(vtd_reg(reg));
}

static inline uint64_t vtd_readq(unsigned int reg)
{
	return __raw_readq(vtd_reg(reg));
}

void vtd_init(void);
void vtd_map_range(uint16_t sid, phys_addr_t iova, phys_addr_t pa, size_t size);
bool vtd_setup_msi(struct pci_dev *dev, int vector, int dest_id);
void vtd_setup_ioapic_irq(struct pci_dev *dev, int vector,
			  int dest_id, trigger_mode_t trigger);

#endif
