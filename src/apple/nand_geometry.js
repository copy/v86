// Four Samsung NAND chips, two per flash controller on the N90.
export const NAND_DATA = 8192, NAND_SPARE = 436, NAND_PAGE = NAND_DATA + NAND_SPARE;
export const NAND_SLOT = Math.ceil(NAND_PAGE / 512) * 512;
export const NAND_BLOCK_PAGES = 128, NAND_BLOCKS = 0x1038, NAND_ROWS = NAND_BLOCK_PAGES * NAND_BLOCKS;
export const NAND_BYTES = 4 * NAND_ROWS * NAND_SLOT;

export function nand_offset(bus, ce, row)
{
    if(!Number.isInteger(bus) || bus < 0 || bus >= 2 || !Number.isInteger(ce) || ce < 0 || ce >= 2 ||
        !Number.isInteger(row) || row < 0 || row >= NAND_ROWS) return -1;
    return ((bus * 2 + ce) * NAND_ROWS + row) * NAND_SLOT;
}
