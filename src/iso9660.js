// Source:
// - ISO9660: https://wiki.osdev.org/ISO_9660
// - Joliet: https://pismotec.com/cfs/jolspec.html

// Limitations:
// - can only generate iso files
// - only supports a single directory, no file system hierarchy
// - root directory entry is limited to 2 KiB (~42 files)

import { dbg_assert } from "./log.js";

const BLOCK_SIZE = 2 * 1024; // 0x800

const FILE_FLAGS_HIDDEN = 1 << 0;
const FILE_FLAGS_DIRECTORY = 1 << 1;
const FILE_FLAGS_ASSOCIATED_FILE = 1 << 2;
const FILE_FLAGS_HAS_EXTENDED_ATTRIBUTE_RECORD = 1 << 3;
const FILE_FLAGS_HAS_PERMISSIONS = 1 << 4;
const FILE_FLAGS_NOT_FINAL = 1 << 7;

const SYSTEM_ID = "V86";
const VOLUME_ID = "CDROM";

/**
 * @param {Array.<{ name: string, contents: Uint8Array}>} files
 */
export function generate(files)
{
    const te = new TextEncoder();
    const date = new Date;

    const write8 = (b, v) => { b.buffer[b.offset++] = v; };
    const write_le16 = (b, v) => { b.buffer[b.offset++] = v; b.buffer[b.offset++] = v >> 8; };
    const write_le32 = (b, v) => { b.buffer[b.offset++] = v; b.buffer[b.offset++] = v >> 8; b.buffer[b.offset++] = v >> 16; b.buffer[b.offset++] = v >> 24; };
    const write_be16 = (b, v) => { b.buffer[b.offset++] = v >> 8; b.buffer[b.offset++] = v; };
    const write_be32 = (b, v) => { b.buffer[b.offset++] = v >> 24; b.buffer[b.offset++] = v >> 16; b.buffer[b.offset++] = v >> 8; b.buffer[b.offset++] = v; };
    const write_lebe16 = (b, v) => { write_le16(b, v); write_be16(b, v); };
    const write_lebe32 = (b, v) => { write_le32(b, v); write_be32(b, v); };
    const fill = (b, len, v) => { b.buffer.fill(v, b.offset, b.offset += len); };
    const write_ascii = (b, v) => { b.offset += te.encodeInto(v, b.buffer.subarray(b.offset)).written; };
    const write_padded_ascii = (b, len, v) => { b.offset += te.encodeInto(v.padEnd(len), b.buffer.subarray(b.offset)).written; };
    const write_dummy_date_ascii = b => { fill(b, 16, 0x20); write8(b, 0); };
    const write_date_compact = b => {
        write8(b, date.getUTCFullYear() - 1900);
        write8(b, 1 + date.getUTCMonth());
        write8(b, date.getUTCDate());
        write8(b, date.getUTCHours());
        write8(b, date.getUTCMinutes());
        write8(b, date.getUTCSeconds());
        write8(b, 0);
    };
    const skip = (b, len) => { b.offset += len; };
    const write_utf16be = (b, v) => {
        for(let i = 0; i < v.length; i++) write_be16(b, v.charCodeAt(i));
        return v.length * 2;
    };
    const write_padded_utf16be = (b, len, v) => write_utf16be(b, v.padEnd(len / 2));

    const write_record = (b, name, flags, is_special, lba, len, joliet) => {
        // write name first and get its length
        const START = b.offset;
        const NAME_OFFSET = 33;
        let name_len = 0;
        if(joliet)
        {
            // encode into utf16be
            name = sanitise_filename_joliet(name);
            let name_buffer = {
                buffer: b.buffer,
                offset: START + NAME_OFFSET,
            };
            name_len = write_utf16be(name_buffer, name);
        }
        else
        {
            if(!is_special) name = sanitise_filename(name) + ";1";
            name_len = te.encodeInto(name, b.buffer.subarray(b.offset + NAME_OFFSET)).written;
        }
        const pad = (name_len & 1) ? 0 : 1;
        const len_field = 33 + name_len + pad;
        dbg_assert(len_field < 256);

        write8(b, len_field);      // Length of directory record
        write8(b, 0);              // Extended Attribute Record length
        write_lebe32(b, lba);      // Location of extent (LBA)
        write_lebe32(b, len);      // Data length (size of extent)
        write_date_compact(b);
        write8(b, flags);
        write8(b, 0);              // File unit size for files recorded in interleaved mode, zero otherwise
        write8(b, 0);              // Interleave gap size for files recorded in interleaved mode, zero otherwise
        write_lebe16(b, 1);        // Volume sequence number - the volume that this extent is recorded on
        write8(b, name_len);       // length of file name
        dbg_assert(b.offset === START + NAME_OFFSET);
        skip(b, name_len + pad);   // File name: was already written
        dbg_assert(b.offset === START + len_field);
    };
    const write_special_directory_record = (b, name, lba, len) => write_record(b, name, FILE_FLAGS_DIRECTORY, true, lba, len, false);
    const write_file_record = (b, name, lba, len, joliet) => write_record(b, name, 0, false, lba, len, joliet);

    function round_byte_size_to_block_size(n)
    {
        return 1 + Math.floor((n - 1) / BLOCK_SIZE);
    }
    dbg_assert(round_byte_size_to_block_size(0) === 0);
    dbg_assert(round_byte_size_to_block_size(1) === 1);
    dbg_assert(round_byte_size_to_block_size(BLOCK_SIZE - 1) === 1);
    dbg_assert(round_byte_size_to_block_size(BLOCK_SIZE) === 1);
    dbg_assert(round_byte_size_to_block_size(BLOCK_SIZE + 1) === 2);
    dbg_assert(round_byte_size_to_block_size(2 * BLOCK_SIZE) === 2);
    dbg_assert(round_byte_size_to_block_size(2 * BLOCK_SIZE + 1) === 3);
    dbg_assert(round_byte_size_to_block_size(10 * BLOCK_SIZE + 1) === 11);

    function to_msdos_filename(name)
    {
        const dot = name.lastIndexOf(".");
        if(dot === -1) return name.substr(0, 8);
        return name.substr(0, Math.min(8, dot)) + "." + name.substr(dot + 1, 3);
    }

    dbg_assert(to_msdos_filename("abcdefghijkl.qwerty") === "abcdefgh.qwe");
    dbg_assert(to_msdos_filename("abcdefghijkl") === "abcdefgh");

    function sanitise_filename(name)
    {
        return to_msdos_filename(name.toUpperCase().replace(/[^A-Z0-9_.]/g, ""));
    }

    function sanitise_filename_joliet(name)
    {
        return name.replace(/[*\/:;?\\]/g, "");
    }

    // layout:
    // (lba = one block of BLOCK_SIZE bytes)
    // LBA   | contents
    // ------+--------
    // 0..15 | System Area (could be used for mbr, but not used by us)
    //    16 | Primary Volume Descriptor
    //    17 | Supplementary Volume Descriptor (Joliet)
    //    18 | Volume Descriptor Set Terminator
    //    19 | Little Endian Path Table
    //    20 | Little Endian Path Table (Joliet)
    //    21 | Big Endian Path Table
    //    22 | Big Endian Path Table (Joliet)
    //    23 | Root directory
    //    24 | Root directory (Joliet)
    // 25..n | File contents
    const SYSTEM_AREA_SIZE = 16 * BLOCK_SIZE;
    const PRIMARY_VOLUME_LBA = 16;
    const SUPPLEMENTARY_VOLUME_LBA = 17;
    const VOLUME_SET_TERMINATOR_LBA = 18;
    const LE_PATH_TABLE_LBA = 19;
    const LE_PATH_TABLE_JOLIET_LBA = 20;
    const BE_PATH_TABLE_LBA = 21;
    const BE_PATH_TABLE_JOLIET_LBA = 22;
    const ROOT_DIRECTORY_LBA = 23;
    const ROOT_DIRECTORY_JOLIET_LBA = 24;
    const LE_PATH_TABLE_SIZE = BLOCK_SIZE;
    const BE_PATH_TABLE_SIZE = BLOCK_SIZE;
    const ROOT_DIRECTORY_SIZE = BLOCK_SIZE;

    const write_volume_descriptor = (is_supplementary) => {
        const VD_OFFSET = (is_supplementary ? SUPPLEMENTARY_VOLUME_LBA : PRIMARY_VOLUME_LBA) * BLOCK_SIZE;

        write8(buffer, is_supplementary ? 0x02 : 0x01); // Volume Descriptor type: Primary/Supplementary Volume Descriptor
        write_ascii(buffer, "CD001");               // Always CD001
        write8(buffer, 0x01);                       // Version
        write8(buffer, 0x00);                       // unused
        if(is_supplementary)
        {
            write_padded_utf16be(buffer, 32, SYSTEM_ID);    // System Identifier
            write_padded_utf16be(buffer, 32, VOLUME_ID);    // Identification of this volume
        }
        else
        {
            write_padded_ascii(buffer, 32, SYSTEM_ID);
            write_padded_ascii(buffer, 32, VOLUME_ID);
        }

        skip(buffer, 8);                            // unused
        write_lebe32(buffer, N_LBAS);

        // Escape Sequence
        if(is_supplementary)
        {
            write_ascii(buffer, "%/C"); // UTF-16BE
            skip(buffer, 29);
        }
        else
        {
            skip(buffer, 32); // unused
        }
        dbg_assert(buffer.offset === VD_OFFSET + 120);

        write_lebe16(buffer, 1); // Volume Set Size
        write_lebe16(buffer, 1); // Volume Sequence Number
        dbg_assert(buffer.offset === VD_OFFSET + 128);

        write_lebe16(buffer, BLOCK_SIZE);

        write_lebe32(buffer, 10);               // Path Table Size
        write_le32(buffer, is_supplementary ? LE_PATH_TABLE_JOLIET_LBA : LE_PATH_TABLE_LBA);  // Location of Type-L Path Table
        write_le32(buffer, 0);                  // Location of the Optional Type-L Path Table
        write_be32(buffer, is_supplementary ? BE_PATH_TABLE_JOLIET_LBA : BE_PATH_TABLE_LBA);  // Location of Type-M Path Table
        write_be32(buffer, 0);                  // Location of the Optional Type-M Path Table
        dbg_assert(buffer.offset === VD_OFFSET + 156);

        // Directory entry for the root directory
        write_special_directory_record(buffer, "\x00", is_supplementary ? ROOT_DIRECTORY_JOLIET_LBA : ROOT_DIRECTORY_LBA, 0x800);
        dbg_assert(buffer.offset === VD_OFFSET + 190);

        fill(buffer, 128, 0x20); // Volume Set Identifier
        fill(buffer, 128, 0x20); // Publisher Identifier
        fill(buffer, 128, 0x20); // Data Preparer Identifier
        fill(buffer, 128, 0x20); // Application Identifier
        fill(buffer,  37, 0x20); // Copyright File Identifier
        fill(buffer,  37, 0x20); // Abstract File Identifier
        fill(buffer,  37, 0x20); // Bibliographic File Identifier

        dbg_assert(buffer.offset === VD_OFFSET + 813);

        write_dummy_date_ascii(buffer); // Volume Creation Date and Time
        write_dummy_date_ascii(buffer); // Volume Modification Date and Time
        write_dummy_date_ascii(buffer); // Volume Expiration Date and Time
        write_dummy_date_ascii(buffer); // Volume Effective Date and Time

        write8(buffer, 0x01); // File Structure Version
        dbg_assert(buffer.offset === VD_OFFSET + 882);

        write8(buffer, 0x00); // Unused
        skip(buffer, 512);    // Application Used
        skip(buffer, 653);    // Reserved
    };

    const write_path_table = (start_lba, root_lba, is_le) => {
        buffer.offset = start_lba * BLOCK_SIZE;
        write8(buffer, 0x01);                   // Length of Directory Identifier
        write8(buffer, 0x00);                   // Extended Attribute Record Length
        if(is_le)
        {
            write_le32(buffer, root_lba);       // Location of Extent (LBA) ROOT_DIRECTORY_LBA
            write_le16(buffer, 1);              // Directory number of parent directory
        }
        else
        {
            write_be32(buffer, root_lba);
            write_be16(buffer, 1);
        }
        write_ascii(buffer, "\x00");            // file name
    };

    let next_file_lba = 25;
    const iso_files = files.map(({ name, contents }) => {
        const lba = next_file_lba;
        next_file_lba += round_byte_size_to_block_size(contents.length);
        return { name, contents, lba };
    });

    const write_root_directory = (start_lba, joliet) => {
        write_special_directory_record(buffer, "\x00", start_lba, 0x800);  // "."
        write_special_directory_record(buffer, "\x01", start_lba, 0x800);  // ".."
        for(const { name, contents, lba } of iso_files)
        {
            write_file_record(buffer, joliet ? name : to_msdos_filename(name), lba, contents.length, joliet);
        }
    };

    const N_LBAS = next_file_lba;
    const total_size = N_LBAS * BLOCK_SIZE;

    const buffer = {
        buffer: new Uint8Array(total_size),
        offset: SYSTEM_AREA_SIZE,
    };

    // LBA 16: Primary Volume Descriptor
    dbg_assert(buffer.offset === PRIMARY_VOLUME_LBA * BLOCK_SIZE);
    write_volume_descriptor(false);

    // LBA 17: Supplementary Volume Descriptor
    dbg_assert(buffer.offset === SUPPLEMENTARY_VOLUME_LBA * BLOCK_SIZE);
    write_volume_descriptor(true);

    // LBA 18: Volume Descriptor Set Terminator
    dbg_assert(buffer.offset === VOLUME_SET_TERMINATOR_LBA * BLOCK_SIZE);
    write8(buffer, 0xFF);           // 0xFF: Volume Descriptor Set Terminator
    write_ascii(buffer, "CD001");   // Always CD001
    write8(buffer, 0x01);           // Version

    // LBA 19: Little Endian Path Table
    write_path_table(LE_PATH_TABLE_LBA, ROOT_DIRECTORY_LBA, true);
    dbg_assert(buffer.offset < LE_PATH_TABLE_LBA * BLOCK_SIZE + LE_PATH_TABLE_SIZE);

    // LBA 20: Little Endian Path Table (Joliet)
    write_path_table(LE_PATH_TABLE_JOLIET_LBA, ROOT_DIRECTORY_JOLIET_LBA, true);
    dbg_assert(buffer.offset < LE_PATH_TABLE_JOLIET_LBA * BLOCK_SIZE + LE_PATH_TABLE_SIZE);

    // LBA 21: Big Endian Path Table
    write_path_table(BE_PATH_TABLE_LBA, ROOT_DIRECTORY_LBA, false);
    dbg_assert(buffer.offset < BE_PATH_TABLE_LBA * BLOCK_SIZE + BE_PATH_TABLE_SIZE);

    // LBA 22: Big Endian Path Table (Joliet)
    write_path_table(BE_PATH_TABLE_JOLIET_LBA, ROOT_DIRECTORY_JOLIET_LBA, false);
    dbg_assert(buffer.offset < BE_PATH_TABLE_JOLIET_LBA * BLOCK_SIZE + BE_PATH_TABLE_SIZE);

    // LBA 23: root directory
    buffer.offset = ROOT_DIRECTORY_LBA * BLOCK_SIZE;
    write_root_directory(ROOT_DIRECTORY_LBA, false);
    // TODO: this assertion can fail if too many files are used as input
    // ROOT_DIRECTORY_SIZE should be choosen dynamically
    dbg_assert(buffer.offset < ROOT_DIRECTORY_LBA * BLOCK_SIZE + ROOT_DIRECTORY_SIZE);

    // LBA 24: root directory (Joliet)
    buffer.offset = ROOT_DIRECTORY_JOLIET_LBA * BLOCK_SIZE;
    write_root_directory(ROOT_DIRECTORY_JOLIET_LBA, true);
    dbg_assert(buffer.offset < ROOT_DIRECTORY_JOLIET_LBA * BLOCK_SIZE + ROOT_DIRECTORY_SIZE);

    // file contents
    for(let { contents, lba } of iso_files)
    {
        buffer.buffer.set(contents, lba * BLOCK_SIZE);
    }

    return buffer.buffer;
}

/**
 * @param {Uint8Array} buffer
 */
export function is_probably_iso9660_file(buffer)
{
    return (
        buffer.length >= 17 * BLOCK_SIZE &&
        buffer[BLOCK_SIZE + 0] ===  1 && // Primary Volume Descriptor
        buffer[BLOCK_SIZE + 1] === 67 && // "C"
        buffer[BLOCK_SIZE + 2] === 68 && // "D"
        buffer[BLOCK_SIZE + 3] === 48 && // "0"
        buffer[BLOCK_SIZE + 4] === 48 && // "0"
        buffer[BLOCK_SIZE + 5] === 49    // "1"
    );
}
