// @ts-check
// Key combinations for the console's "Send keys" menu (docs/vm-manager-plan.md
// "控制台"): "Ctrl+Alt+Del", "Alt+Tab", "Ctrl+Alt+F2", "Win+R" as PC
// scancodes (set 1, what keyboard_send_scancodes takes): the keys pressed
// in order, released in the reverse order.

/** Make codes; 0xE0xx: an extended key (its E0 prefix) */
const KEYS = {
    esc: 0x01, "1": 0x02, "2": 0x03, "3": 0x04, "4": 0x05, "5": 0x06, "6": 0x07, "7": 0x08, "8": 0x09, "9": 0x0A, "0": 0x0B,
    "-": 0x0C, "=": 0x0D, backspace: 0x0E, tab: 0x0F,
    q: 0x10, w: 0x11, e: 0x12, r: 0x13, t: 0x14, y: 0x15, u: 0x16, i: 0x17, o: 0x18, p: 0x19, "[": 0x1A, "]": 0x1B, enter: 0x1C,
    ctrl: 0x1D, a: 0x1E, s: 0x1F, d: 0x20, f: 0x21, g: 0x22, h: 0x23, j: 0x24, k: 0x25, l: 0x26, ";": 0x27, "'": 0x28, "`": 0x29,
    shift: 0x2A, "\\": 0x2B, z: 0x2C, x: 0x2D, c: 0x2E, v: 0x2F, b: 0x30, n: 0x31, m: 0x32, ",": 0x33, ".": 0x34, "/": 0x35,
    alt: 0x38, space: 0x39, capslock: 0x3A,
    f1: 0x3B, f2: 0x3C, f3: 0x3D, f4: 0x3E, f5: 0x3F, f6: 0x40, f7: 0x41, f8: 0x42, f9: 0x43, f10: 0x44, f11: 0x57, f12: 0x58,
    numlock: 0x45, scrolllock: 0x46,
    home: 0xE047, up: 0xE048, pageup: 0xE049, left: 0xE04B, right: 0xE04D, end: 0xE04F, down: 0xE050, pagedown: 0xE051,
    // (Del: the keypad's code, as the old page sends Ctrl+Alt+Del, which every BIOS takes)
    insert: 0xE052, del: 0x53, win: 0xE05B, menu: 0xE05D, printscreen: 0xE037,
};
/** Other names of the keys */
const ALIASES = { control: "ctrl", delete: "del", escape: "esc", return: "enter", meta: "win", super: "win", cmd: "win", ins: "insert",
    pgup: "pageup", pgdn: "pagedown", " ": "space" };

/** The combinations of the menu */
export const COMBINATIONS = ["Ctrl+Alt+Del", "Alt+Tab", "Alt+F4", "Ctrl+Esc", "Win", "Win+R", "Ctrl+Alt+F1", "Ctrl+Alt+F2", "Ctrl+Alt+Backspace", "PrintScreen"];

/**
 * The scancodes of a combination, its presses and its releases (sent 100 ms
 * later, as the old page sends Alt+Tab); throws for a key it does not know
 * @param {string} text "Ctrl+Alt+Del"
 * @return {{press: number[], release: number[]}}
 */
export function combination_scancodes(text)
{
    const keys = text.split("+").map(k => k.trim().toLowerCase()).filter(Boolean).map(k => ALIASES[k] || k);
    if(!keys.length) throw new Error("No keys");
    const codes = keys.map(k =>
    {
        if(!(k in KEYS)) throw new Error("Unknown key: " + k);
        return KEYS[k];
    });
    const scancodes = (list, release) => list.flatMap(code => (code > 0xFF ? [0xE0] : []).concat([(code & 0xFF) | (release ? 0x80 : 0)]));
    return { press: scancodes(codes, false), release: scancodes(codes.slice().reverse(), true) };
}
