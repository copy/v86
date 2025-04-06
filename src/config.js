"use strict";
/*
 * Compile time configuration, some only relevant for debug mode
 */

import {
    LOG_ALL, LOG_PS2, LOG_PIT, LOG_9P, LOG_PIC, LOG_DMA, LOG_NET, LOG_FLOPPY, LOG_DISK,
    LOG_SERIAL, LOG_VGA, LOG_SB16, LOG_VIRTIO
} from "./const.js";

/** @const */
export var LOG_TO_FILE = false;

/**
 * @const
 * Enables logging all IO port reads and writes. Very verbose
 */
export var LOG_ALL_IO = false;

/**
 * @const
 */
export var DUMP_GENERATED_WASM = false;

/**
 * @const
 */
export var DUMP_UNCOMPILED_ASSEMBLY = false;

export var LOG_LEVEL = LOG_ALL & ~LOG_PS2 & ~LOG_PIT & ~LOG_VIRTIO & ~LOG_9P & ~LOG_PIC &
                          ~LOG_DMA & ~LOG_SERIAL & ~LOG_NET & ~LOG_FLOPPY & ~LOG_DISK & ~LOG_VGA & ~LOG_SB16;

export function set_log_level(level) {
    LOG_LEVEL = level;
}

/**
 * @const
 * Draws entire buffer and visualizes the layers that would be drawn
 */
export var DEBUG_SCREEN_LAYERS = DEBUG && false;

/**
 * @const
 * How many ticks the TSC does per millisecond
 */
export var TSC_RATE = 1 * 1000 * 1000;

/** @const */
export var APIC_TIMER_FREQ = TSC_RATE;
