/*
 * Copyright (C) 2014, Red Hat Inc, Andrew Jones <drjones@redhat.com>
 *
 * This work is licensed under the terms of the GNU LGPL, version 2.
 */
#include "libcflat.h"
#include "libfdt/libfdt.h"
#include "devicetree.h"

static const void *fdt;

const void *dt_fdt(void)
{
	return fdt;
}

bool dt_available(void)
{
	return fdt_check_header(fdt) == 0;
}

int dt_get_nr_cells(int fdtnode, u32 *nr_address_cells, u32 *nr_size_cells)
{
	const struct fdt_property *prop;
	u32 *nr_cells;
	int len, nac, nsc;

	prop = fdt_get_property(fdt, fdtnode, "#address-cells", &len);
	if (prop == NULL)
		return len;

	nr_cells = (u32 *)prop->data;
	nac = fdt32_to_cpu(*nr_cells);

	prop = fdt_get_property(fdt, fdtnode, "#size-cells", &len);
	if (prop == NULL)
		return len;

	nr_cells = (u32 *)prop->data;
	nsc = fdt32_to_cpu(*nr_cells);

	*nr_address_cells = nac;
	*nr_size_cells = nsc;

	return 0;
}

void dt_reg_init(struct dt_reg *reg, u32 nr_address_cells, u32 nr_size_cells)
{
	memset(reg, 0, sizeof(struct dt_reg));
	reg->nr_address_cells = nr_address_cells;
	reg->nr_size_cells = nr_size_cells;
}

int dt_get_reg(int fdtnode, int regidx, struct dt_reg *reg)
{
	const struct fdt_property *prop;
	u32 *cells, i;
	unsigned nr_tuple_cells;
	int len;

	prop = fdt_get_property(fdt, fdtnode, "reg", &len);
	if (prop == NULL)
		return len;

	cells = (u32 *)prop->data;
	nr_tuple_cells = reg->nr_address_cells + reg->nr_size_cells;
	regidx *= nr_tuple_cells;

	if (regidx + nr_tuple_cells > len/sizeof(u32))
		return -FDT_ERR_NOTFOUND;

	for (i = 0; i < reg->nr_address_cells; ++i)
		reg->address_cells[i] = fdt32_to_cpu(cells[regidx + i]);

	regidx += reg->nr_address_cells;
	for (i = 0; i < reg->nr_size_cells; ++i)
		reg->size_cells[i] = fdt32_to_cpu(cells[regidx + i]);

	return 0;
}

int dt_pbus_translate_node(int fdtnode, int regidx,
			   struct dt_pbus_reg *pbus_reg)
{
	struct dt_reg raw_reg;
	u32 nac, nsc;
	int parent, ret;

	parent = fdt_parent_offset(fdt, fdtnode);
	if (parent < 0)
		return parent;

	ret = dt_get_nr_cells(parent, &nac, &nsc);
	if (ret != 0)
		return ret;

	dt_reg_init(&raw_reg, nac, nsc);

	ret = dt_get_reg(fdtnode, regidx, &raw_reg);
	if (ret < 0)
		return ret;

	pbus_reg->addr = dt_pbus_read_cells(raw_reg.nr_address_cells,
					    raw_reg.address_cells);
	pbus_reg->size = dt_pbus_read_cells(raw_reg.nr_size_cells,
					    raw_reg.size_cells);

	return 0;
}

int dt_pbus_translate(const struct dt_device *dev, int regidx,
		      void *reg)
{
	return dt_pbus_translate_node(dev->fdtnode, regidx, reg);
}

int dt_bus_match_any(const struct dt_device *dev __unused, int fdtnode)
{
	/* matches any device with a valid node */
	return fdtnode < 0 ? fdtnode : 1;
}

static const struct dt_bus dt_default_bus = {
	.match = dt_bus_match_any,
	.translate = dt_pbus_translate,
};

void dt_bus_init_defaults(struct dt_bus *bus)
{
	memcpy(bus, &dt_default_bus, sizeof(struct dt_bus));
}

void dt_device_init(struct dt_device *dev, const struct dt_bus *bus,
		    void *info)
{
	memset(dev, 0, sizeof(struct dt_device));
	dev->bus = bus;
	dev->info = info;
}

int dt_device_find_compatible(const struct dt_device *dev,
			      const char *compatible)
{
	int node, ret;

	node = fdt_node_offset_by_compatible(fdt, -1, compatible);
	while (node >= 0) {
		ret = dev->bus->match(dev, node);
		if (ret < 0)
			return ret;
		else if (ret)
			break;
		node = fdt_node_offset_by_compatible(fdt, node, compatible);
	}
	return node;
}

int dt_pbus_get_base_compatible(const char *compatible,
				struct dt_pbus_reg *base)
{
	struct dt_device dev;
	int node;

	dt_device_init(&dev, &dt_default_bus, NULL);

	node = dt_device_find_compatible(&dev, compatible);
	if (node < 0)
		return node;

	dt_device_bind_node(&dev, node);

	return dt_pbus_get_base(&dev, base);
}

int dt_get_memory_params(struct dt_pbus_reg *regs, int nr_regs)
{
	const char *pn = "device_type", *pv = "memory";
	int node, ret, reg_idx, pl = strlen(pv) + 1, nr = 0;
	struct dt_pbus_reg reg;

	node = fdt_node_offset_by_prop_value(fdt, -1, pn, pv, pl);

	while (node >= 0) {

		reg_idx = 0;

		while (nr < nr_regs) {
			ret = dt_pbus_translate_node(node, reg_idx, &reg);
			if (ret == -FDT_ERR_NOTFOUND)
				break;
			if (ret < 0)
				return ret;
			regs[nr].addr = reg.addr;
			regs[nr].size = reg.size;
			++nr, ++reg_idx;
		}

		node = fdt_node_offset_by_prop_value(fdt, node, pn, pv, pl);
	}

	return node != -FDT_ERR_NOTFOUND ? node : nr;
}

int dt_for_each_cpu_node(void (*func)(int fdtnode, u64 regval, void *info),
			 void *info)
{
	const struct fdt_property *prop;
	int cpus, cpu, ret, len;
	struct dt_reg raw_reg;
	u32 nac, nsc;
	u64 regval;

	cpus = fdt_path_offset(fdt, "/cpus");
	if (cpus < 0)
		return cpus;

	ret = dt_get_nr_cells(cpus, &nac, &nsc);
	if (ret < 0)
		return ret;

	dt_reg_init(&raw_reg, nac, nsc);

	dt_for_each_subnode(cpus, cpu) {

		prop = fdt_get_property(fdt, cpu, "device_type", &len);
		if (prop == NULL)
			return len;

		if (len != 4 || strcmp((char *)prop->data, "cpu"))
			continue;

		ret = dt_get_reg(cpu, 0, &raw_reg);
		if (ret < 0)
			return ret;

		regval = raw_reg.address_cells[0];
		if (nac == 2)
			regval = (regval << 32) | raw_reg.address_cells[1];

		func(cpu, regval, info);
	}

	return 0;
}

int dt_get_bootargs(const char **bootargs)
{
	const struct fdt_property *prop;
	int node, len;

	*bootargs = NULL;

	node = fdt_path_offset(fdt, "/chosen");
	if (node < 0)
		return node;

	prop = fdt_get_property(fdt, node, "bootargs", &len);
	if (!prop)
		return len;

	*bootargs = prop->data;
	return 0;
}

int dt_get_default_console_node(void)
{
	const struct fdt_property *prop;
	int node, len;

	node = fdt_path_offset(fdt, "/chosen");
	if (node < 0)
		return node;

	prop = fdt_get_property(fdt, node, "stdout-path", &len);
	if (!prop) {
		prop = fdt_get_property(fdt, node, "linux,stdout-path", &len);
		if (!prop)
			return len;
	}

	return fdt_path_offset(fdt, prop->data);
}

int dt_get_initrd(const char **initrd, u32 *size)
{
	const struct fdt_property *prop;
	const char *start, *end;
	int node, len;
	u32 *data;

	*initrd = NULL;
	*size = 0;

	node = fdt_path_offset(fdt, "/chosen");
	if (node < 0)
		return node;

	prop = fdt_get_property(fdt, node, "linux,initrd-start", &len);
	if (!prop)
		return len;
	data = (u32 *)prop->data;
	start = (const char *)(unsigned long)fdt32_to_cpu(*data);

	prop = fdt_get_property(fdt, node, "linux,initrd-end", &len);
	if (!prop) {
		assert(len != -FDT_ERR_NOTFOUND);
		return len;
	}
	data = (u32 *)prop->data;
	end = (const char *)(unsigned long)fdt32_to_cpu(*data);

	*initrd = start;
	*size = (unsigned long)end - (unsigned long)start;

	return 0;
}

int dt_init(const void *fdt_ptr)
{
	int ret;

	ret = fdt_check_header(fdt_ptr);
	if (ret < 0)
		return ret;

	/* Sanity check the path.  */
	ret = fdt_path_offset(fdt_ptr, "/");
	if (ret < 0)
		return ret;

	fdt = fdt_ptr;
	return 0;
}
