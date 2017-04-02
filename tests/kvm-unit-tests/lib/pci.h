#ifndef PCI_H
#define PCI_H
/*
 * API for scanning a PCI bus for a given device, as well to access
 * BAR registers.
 *
 * Copyright (C) 2013, Red Hat Inc, Michael S. Tsirkin <mst@redhat.com>
 *
 * This work is licensed under the terms of the GNU LGPL, version 2.
 */
#include "libcflat.h"

typedef uint16_t pcidevaddr_t;
enum {
	PCIDEVADDR_INVALID = 0xffff,
};

#define PCI_BAR_NUM                     6
#define PCI_DEVFN_MAX                   256

#define PCI_BDF_GET_DEVFN(x)            ((x) & 0xff)
#define PCI_BDF_GET_BUS(x)              (((x) >> 8) & 0xff)

struct pci_dev {
	uint16_t bdf;
	uint16_t msi_offset;
	phys_addr_t resource[PCI_BAR_NUM];
};

extern void pci_dev_init(struct pci_dev *dev, pcidevaddr_t bdf);
extern void pci_cmd_set_clr(struct pci_dev *dev, uint16_t set, uint16_t clr);
typedef void (*pci_cap_handler_t)(struct pci_dev *dev, int cap_offset, int cap_id);
extern void pci_cap_walk(struct pci_dev *dev, pci_cap_handler_t handler);
extern void pci_enable_defaults(struct pci_dev *dev);
extern bool pci_setup_msi(struct pci_dev *dev, uint64_t msi_addr,
			  uint32_t msi_data);

typedef phys_addr_t iova_t;

extern bool pci_probe(void);
extern void pci_print(void);
extern bool pci_dev_exists(pcidevaddr_t dev);
extern pcidevaddr_t pci_find_dev(uint16_t vendor_id, uint16_t device_id);

/*
 * @bar_num in all BAR access functions below is the index of the 32-bit
 * register starting from the PCI_BASE_ADDRESS_0 offset.
 *
 * In cases where the BAR size is 64-bit, a caller should still provide
 * @bar_num in terms of 32-bit words. For example, if a device has a 64-bit
 * BAR#0 and a 32-bit BAR#1, then caller should provide 2 to address BAR#1,
 * not 1.
 *
 * It is expected the caller is aware of the device BAR layout and never
 * tries to address the middle of a 64-bit register.
 */
extern phys_addr_t pci_bar_get_addr(struct pci_dev *dev, int bar_num);
extern void pci_bar_set_addr(struct pci_dev *dev, int bar_num, phys_addr_t addr);
extern phys_addr_t pci_bar_size(struct pci_dev *dev, int bar_num);
extern uint32_t pci_bar_get(struct pci_dev *dev, int bar_num);
extern uint32_t pci_bar_mask(uint32_t bar);
extern bool pci_bar_is64(struct pci_dev *dev, int bar_num);
extern bool pci_bar_is_memory(struct pci_dev *dev, int bar_num);
extern bool pci_bar_is_valid(struct pci_dev *dev, int bar_num);
extern void pci_bar_print(struct pci_dev *dev, int bar_num);
extern void pci_dev_print_id(struct pci_dev *dev);
extern void pci_dev_print(struct pci_dev *dev);
extern uint8_t pci_intx_line(struct pci_dev *dev);
void pci_msi_set_enable(struct pci_dev *dev, bool enabled);

extern int pci_testdev(void);

/*
 * pci-testdev is a driver for the pci-testdev qemu pci device. The
 * device enables testing mmio and portio exits, and measuring their
 * speed.
 */
#define PCI_VENDOR_ID_REDHAT		0x1b36
#define PCI_DEVICE_ID_REDHAT_TEST	0x0005

/*
 * pci-testdev supports at least three types of tests (via mmio and
 * portio BARs): no-eventfd, wildcard-eventfd and datamatch-eventfd
 */
#define PCI_TESTDEV_BAR_MEM		0
#define PCI_TESTDEV_BAR_IO		1
#define PCI_TESTDEV_NUM_BARS		2
#define PCI_TESTDEV_NUM_TESTS		3

struct pci_test_dev_hdr {
	uint8_t  test;
	uint8_t  width;
	uint8_t  pad0[2];
	uint32_t offset;
	uint32_t data;
	uint32_t count;
	uint8_t  name[];
};

#define  PCI_HEADER_TYPE_MASK		0x7f

#endif /* PCI_H */
