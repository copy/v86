#ifndef _DEVICETREE_H_
#define _DEVICETREE_H_
/*
 * devicetree builds on libfdt to implement abstractions and accessors
 * for Linux required device tree content. The accessors provided are
 * common across architectures. See section III of the kernel doc
 * Documentation/devicetree/booting-without-of.txt
 *
 * Copyright (C) 2014, Red Hat Inc, Andrew Jones <drjones@redhat.com>
 *
 * This work is licensed under the terms of the GNU LGPL, version 2.
 */
#include "libcflat.h"
#include "libfdt/libfdt.h"

/**********************************************************************
 * devicetree init and libfdt helpers
 **********************************************************************/

/* dt_init initializes devicetree with a pointer to an fdt, @fdt_ptr */
extern int dt_init(const void *fdt_ptr);

/* get the fdt pointer that devicetree is using */
extern const void *dt_fdt(void);

/* check for an initialized, valid devicetree */
extern bool dt_available(void);

/* traverse child nodes */
#define dt_for_each_subnode(n, s)					\
	for (s = fdt_first_subnode(dt_fdt(), n);			\
	     s != -FDT_ERR_NOTFOUND;					\
	     s = fdt_next_subnode(dt_fdt(), s))

/**********************************************************************
 * Abstractions for required node types and properties
 **********************************************************************/

struct dt_device {
	int fdtnode;
	const struct dt_bus *bus;

	/*
	 * info is a pointer to device specific data, which may be
	 * used by the bus match() and translate() functions
	 */
	void *info;
};

struct dt_bus {
	/*
	 * match a device @dev to an fdt node @fdtnode
	 * returns
	 *  - a positive value on match
	 *  - zero on no match
	 *  - a negative FDT_ERR_* value on failure
	 */
	int (*match)(const struct dt_device *dev, int fdtnode);

	/*
	 * translate the @regidx'th "address size" tuple of
	 * @dev's fdt node's "reg" property, and store the result
	 * in @reg, a bus specific structure
	 * returns
	 *  - zero on success
	 *  - a negative FDT_ERR_* value on failure
	 */
	int (*translate)(const struct dt_device *dev, int regidx, void *reg);
};

/* dt_bus_match_any matches any fdt node, i.e. it always returns true */
extern int dt_bus_match_any(const struct dt_device *dev, int fdtnode);

/* the processor bus (pbus) address type and register tuple */
typedef u64 dt_pbus_addr_t;
struct dt_pbus_reg {
	dt_pbus_addr_t addr;
	dt_pbus_addr_t size;
};

static inline dt_pbus_addr_t dt_pbus_read_cells(u32 nr_cells, u32 *cells)
{
	switch (nr_cells) {
	case 1: return cells[0];
	case 2: return ((u64)cells[0] << 32) | cells[1];
	}
	return (~0ULL);
}

/*
 * dt_pbus_translate translates device node regs for the
 * processor bus using the parent node's #address-cells
 * and #size-cells and dt_pbus_read_cells()
 * returns
 *  - zero on success
 *  - a negative FDT_ERR_* value on failure
 */
extern int dt_pbus_translate(const struct dt_device *dev, int regidx,
			     void *reg);

/*
 * dt_pbus_translate_node is the same as dt_pbus_translate but
 * operates on an fdt node instead of a dt_device
 */
extern int dt_pbus_translate_node(int fdtnode, int regidx,
				  struct dt_pbus_reg *reg);

/*
 * dt_pbus_get_base is an alias for
 *     dt_pbus_translate(dev, 0, base)
 * returns
 *  - zero on success
 *  - a negative FDT_ERR_* value on failure
 */
static inline int dt_pbus_get_base(const struct dt_device *dev,
				   struct dt_pbus_reg *base)
{
	return dt_pbus_translate(dev, 0, base);
}

/*
 * dt_bus_init_defaults initializes @bus with
 *  match		<- dt_bus_match_any
 *  translate		<- dt_pbus_translate
 */
extern void dt_bus_init_defaults(struct dt_bus *bus);

/*
 * dt_device_init initializes a dt_device with the given parameters
 */
extern void dt_device_init(struct dt_device *dev, const struct dt_bus *bus,
			   void *info);

static inline void dt_device_bind_node(struct dt_device *dev, int fdtnode)
{
	dev->fdtnode = fdtnode;
}

/*
 * dt_device_find_compatible finds a @compatible node
 * returns
 *  - node (>= 0) on success
 *  - a negative FDT_ERR_* value on failure
 */
extern int dt_device_find_compatible(const struct dt_device *dev,
				     const char *compatible);

/*
 * dt_pbus_get_base_compatible simply bundles many functions into one.
 * It finds the first @compatible fdt node, then translates the 0th reg
 * tuple (the base) using the processor bus translation, and finally it
 * stores that result in @base.
 * returns
 *  - zero on success
 *  - a negative FDT_ERR_* value on failure
 */
extern int dt_pbus_get_base_compatible(const char *compatible,
				       struct dt_pbus_reg *base);

/**********************************************************************
 * Low-level accessors for required node types and properties
 **********************************************************************/

/*
 * dt_get_nr_cells sets @nr_address_cells and @nr_size_cells to the
 * #address-cells and #size-cells properties of @fdtnode
 * returns
 *  - zero on success
 *  - a negative FDT_ERR_* value on failure
 */
extern int dt_get_nr_cells(int fdtnode, u32 *nr_address_cells,
					u32 *nr_size_cells);

/* dt_reg is a structure for "raw" reg tuples */
#define MAX_ADDRESS_CELLS	4
#define MAX_SIZE_CELLS		4
struct dt_reg {
	u32 nr_address_cells, nr_size_cells;
	u32 address_cells[MAX_ADDRESS_CELLS];
	u32 size_cells[MAX_SIZE_CELLS];
};

/*
 * dt_reg_init initialize a dt_reg struct to zero and sets
 * nr_address_cells and nr_size_cells to @nr_address_cells and
 * @nr_size_cells respectively.
 */
extern void dt_reg_init(struct dt_reg *reg, u32 nr_address_cells,
					    u32 nr_size_cells);

/*
 * dt_get_reg gets the @regidx'th reg tuple of @fdtnode's reg property
 * and stores it in @reg. @reg must be initialized.
 * returns
 *  - zero on success
 *  - a negative FDT_ERR_* value on failure
 */
extern int dt_get_reg(int fdtnode, int regidx, struct dt_reg *reg);

/**********************************************************************
 * High-level accessors for required node types and properties
 **********************************************************************/

/*
 * dt_get_bootargs gets the string pointer from /chosen/bootargs
 * returns
 *  - zero on success
 *  - a negative FDT_ERR_* value on failure, and @bootargs
 *    will be set to NULL
 */
extern int dt_get_bootargs(const char **bootargs);

/*
 * dt_get_default_console_node gets the node of the path stored in
 * /chosen/stdout-path (or the deprecated /chosen/linux,stdout-path)
 * returns
 *  - the node (>= 0) on success
 *  - a negative FDT_ERR_* value on failure
 */
extern int dt_get_default_console_node(void);

/*
 * dt_get_initrd gets the physical address of the initrd and its
 * size from /chosen
 * returns
 *  - zero on success
 *  - a negative FDT_ERR_* value on failure, and @initrd will be
 *    set to NULL and @size set to zero
 */
extern int dt_get_initrd(const char **initrd, u32 *size);

/*
 * dt_get_memory_params gets the memory parameters from the /memory node(s)
 * storing each memory region ("address size" tuple) in consecutive entries
 * of @regs, up to @nr_regs
 * returns
 *  - number of memory regions found on success
 *  - a negative FDT_ERR_* value on failure
 */
extern int dt_get_memory_params(struct dt_pbus_reg *regs, int nr_regs);

/*
 * dt_for_each_cpu_node runs @func on each cpu node in the /cpus node
 * passing it its fdt node, its reg property value, and @info
 *  - zero on success
 *  - a negative FDT_ERR_* value on failure
 */
extern int dt_for_each_cpu_node(void (*func)(int fdtnode, u64 regval,
				void *info), void *info);

#endif /* _DEVICETREE_H_ */
