/*
 * Intel IOMMU unit test.
 *
 * Copyright (C) 2016 Red Hat, Inc.
 *
 * Authors:
 *   Peter Xu <peterx@redhat.com>,
 *
 * This work is licensed under the terms of the GNU LGPL, version 2 or
 * later.
 */

#include "intel-iommu.h"
#include "pci-edu.h"
#include "x86/apic.h"

#define VTD_TEST_DMAR_4B ("DMAR 4B memcpy test")
#define VTD_TEST_IR_MSI ("IR MSI")
#define VTD_TEST_IR_IOAPIC ("IR IOAPIC")

static struct pci_edu_dev edu_dev;

static void vtd_test_dmar(void)
{
	struct pci_edu_dev *dev = &edu_dev;
	void *page = alloc_page();

	report_prefix_push("vtd_dmar");

#define DMA_TEST_WORD (0x12345678)
	/* Modify the first 4 bytes of the page */
	*(uint32_t *)page = DMA_TEST_WORD;

	/*
	 * Map the newly allocated page into IOVA address 0 (size 4K)
	 * of the device address space. Root entry and context entry
	 * will be automatically created when needed.
	 */
	vtd_map_range(dev->pci_dev.bdf, 0, virt_to_phys(page), PAGE_SIZE);

	/*
	 * DMA the first 4 bytes of the page to EDU device buffer
	 * offset 0.
	 */
	edu_dma(dev, 0, 4, 0, false);

	/*
	 * DMA the first 4 bytes of EDU device buffer into the page
	 * with offset 4 (so it'll be using 4-7 bytes).
	 */
	edu_dma(dev, 4, 4, 0, true);

	/*
	 * Check data match between 0-3 bytes and 4-7 bytes of the
	 * page.
	 */
	report(VTD_TEST_DMAR_4B, *((uint32_t *)page + 1) == DMA_TEST_WORD);

	free_page(page);

	report_prefix_pop();
}

static volatile bool edu_intr_recved;

static void edu_isr(isr_regs_t *regs)
{
	edu_intr_recved = true;
	eoi();
	edu_reg_writel(&edu_dev, EDU_REG_INTR_ACK,
			edu_reg_readl(&edu_dev, EDU_REG_INTR_STATUS));
}

static void vtd_test_ir(void)
{
#define VTD_TEST_VECTOR_IOAPIC (0xed)
#define VTD_TEST_VECTOR_MSI (0xee)
	struct pci_edu_dev *dev = &edu_dev;
	struct pci_dev *pci_dev = &dev->pci_dev;

	report_prefix_push("vtd_ir");

	irq_enable();

	/* This will enable INTx */
	pci_msi_set_enable(pci_dev, false);
	vtd_setup_ioapic_irq(pci_dev, VTD_TEST_VECTOR_IOAPIC,
			     0, TRIGGER_EDGE);
	handle_irq(VTD_TEST_VECTOR_IOAPIC, edu_isr);

	edu_intr_recved = false;
	wmb();
	/* Manually trigger INTR */
	edu_reg_writel(dev, EDU_REG_INTR_RAISE, 1);

	while (!edu_intr_recved)
		cpu_relax();

	/* Clear INTR bits */
	edu_reg_writel(dev, EDU_REG_INTR_RAISE, 0);

	/* We are good as long as we reach here */
	report(VTD_TEST_IR_IOAPIC, edu_intr_recved == true);

	/*
	 * Setup EDU PCI device MSI, using interrupt remapping. By
	 * default, EDU device is using INTx.
	 */
	if (!vtd_setup_msi(pci_dev, VTD_TEST_VECTOR_MSI, 0)) {
		printf("edu device does not support MSI, skip test\n");
		report_skip(VTD_TEST_IR_MSI);
		return;
	}

	handle_irq(VTD_TEST_VECTOR_MSI, edu_isr);

	edu_intr_recved = false;
	wmb();
	/* Manually trigger INTR */
	edu_reg_writel(dev, EDU_REG_INTR_RAISE, 1);

	while (!edu_intr_recved)
		cpu_relax();

	/* We are good as long as we reach here */
	report(VTD_TEST_IR_MSI, edu_intr_recved == true);

	report_prefix_pop();
}

int main(int argc, char *argv[])
{
	vtd_init();

	report_prefix_push("vtd_init");

	report("fault status check", vtd_readl(DMAR_FSTS_REG) == 0);
	report("QI enablement", vtd_readl(DMAR_GSTS_REG) & VTD_GCMD_QI);
	report("DMAR table setup", vtd_readl(DMAR_GSTS_REG) & VTD_GCMD_ROOT);
	report("IR table setup", vtd_readl(DMAR_GSTS_REG) & VTD_GCMD_IR_TABLE);
	report("DMAR enablement", vtd_readl(DMAR_GSTS_REG) & VTD_GCMD_DMAR);
	report("IR enablement", vtd_readl(DMAR_GSTS_REG) & VTD_GCMD_IR);
	report("DMAR support 39 bits address width",
	       vtd_readq(DMAR_CAP_REG) & VTD_CAP_SAGAW);
	report("DMAR support huge pages", vtd_readq(DMAR_CAP_REG) & VTD_CAP_SLLPS);

	report_prefix_pop();

	if (!edu_init(&edu_dev)) {
		printf("Please specify \"-device edu\" to do "
		       "further IOMMU tests.\n");
		report_skip(VTD_TEST_DMAR_4B);
		report_skip(VTD_TEST_IR_IOAPIC);
		report_skip(VTD_TEST_IR_MSI);
	} else {
		printf("Found EDU device:\n");
		pci_dev_print(&edu_dev.pci_dev);
		vtd_test_dmar();
		vtd_test_ir();
	}

	return report_summary();
}
