// Raw N90 NAND medium. Four Samsung EC D7 94 72 chips, two per FMI.
// Each sector-aligned slot holds the complemented data and OOB. Host
// filesystem holes thus read as erased flash without allocating 17 GiB.
import { restore_disk_state } from "../disk_writeback.js";
import { BlockBackend } from "../block_backend.js";
import { dt_find, dt_property, dt_set } from "./devicetree.js";

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

export function configure_nand_tree(tree)
{
    const flash = dt_find(tree, "/arm-io/flash-controller0/disk"), io = dt_find(tree, "/arm-io");
    if(!flash || !io) throw new Error("missing N90 flash device-tree nodes");
    const ids = new Uint8Array(256);
    for(let bus = 0; bus < 2; bus++)
        for(let ce = 0; ce < 2; ce++) ids.set([0xEC, 0xD7, 0x94, 0x72], 8 * (16 * bus + ce));
    dt_set(flash, "dbg-chipids", ids);
    const properties = { "#ce": 4, "#databus": 2, "ce-bitmap": 0x30003, "#ce-blocks": NAND_BLOCKS,
        "#block-pages": NAND_BLOCK_PAGES, "#page-bytes": NAND_DATA, "#spare-bytes": NAND_SPARE, "#die-ce": 1,
        "logical-page-size": 4096, "meta-per-logical-page": 12, "valid-meta-per-logical-page": 12,
        "ecc-correctable": 8, "ecc-threshold": 8, "block-bits": 13, "page-bits": 7,
        "bbt-format": 8, "vendor-type": 0x10001, "max-transaction-size": 65536 };
    for(const [name, value] of Object.entries(properties))
    {
        const cell = new Uint8Array(4);
        new DataView(cell.buffer).setUint32(0, value, true);
        dt_set(flash, name, cell);
    }
    const source = dt_property(io, "clock-frequencies");
    if(!source || source.value.length < 0x22 * 4) throw new Error("missing NAND clock slot");
    const clocks = source.value.slice();
    new DataView(clocks.buffer, clocks.byteOffset).setUint32(0x21 * 4, 100000000, true);
    dt_set(io, "clock-frequencies", clocks);
}

export class AppleNAND
{
    constructor(cpu, buffer)
    {
        if(buffer.byteLength !== NAND_BYTES) throw new Error("N90 NAND image size must be " + NAND_BYTES);
        this.buffer = buffer;
        this.backend = new BlockBackend(cpu, buffer);
    }

    read(bus, ce, row, done, fail)
    {
        const offset = nand_offset(bus, ce, row);
        if(offset < 0) { fail(new Error("NAND page outside medium")); return; }
        this.backend.read(offset, NAND_SLOT, bytes => {
            if(bytes.length !== NAND_SLOT) { fail(new Error("short NAND page")); return; }
            const page = new Uint8Array(NAND_PAGE);
            for(let i = 0; i < page.length; i++) page[i] = ~bytes[i];
            done(page);
        }, fail);
    }

    reset() { this.backend.reset(); }
    get_state() { return [this.buffer]; }
    set_state(state) { this.reset(); restore_disk_state(this.buffer, state[0]); }
}
