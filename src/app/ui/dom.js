// @ts-check
// The VM manager's DOM helpers (docs/vm-manager-plan.md G6: no UI framework):
// h() for elements, modal dialogs, and downloads.

/**
 * An element: h("div.summary#vm", { onclick, title, dataset: {...}, style: {...} }, child, ...)
 * Children are nodes, strings, or arrays of them; null, undefined and false are left out.
 * @param {string} spec a tag, then .class and #id parts
 * @param {Object<string, any> | null} [props]
 * @param {...any} children
 * @return {HTMLElement}
 */
export function h(spec, props, ...children)
{
    const [, tag, rest] = /^([a-z0-9-]+)(.*)$/i.exec(spec) || [];
    const element = document.createElement(tag || "div");
    for(const part of (rest || "").match(/[.#][^.#]+/g) || [])
    {
        if(part[0] === ".") element.classList.add(part.slice(1));
        else element.id = part.slice(1);
    }
    for(const [name, value] of Object.entries(props || {}))
    {
        if(value === undefined || value === null || value === false) continue;
        if(name.startsWith("on") && typeof value === "function") element.addEventListener(name.slice(2), value);
        // (added to the spec's classes, not in their place)
        else if(name === "class") element.classList.add(...String(value).split(/\s+/).filter(Boolean));
        else if(name === "style" && typeof value === "object") Object.assign(element.style, value);
        else if(name === "dataset") Object.assign(element.dataset, value);
        else if(name in element && typeof value !== "string") /** @type {any} */ (element)[name] = value;
        else element.setAttribute(name, value === true ? "" : String(value));
    }
    append(element, children);
    return element;
}

/**
 * @param {Element} parent
 * @param {any[]} children
 */
function append(parent, children)
{
    for(const child of children)
    {
        if(child === null || child === undefined || child === false) continue;
        if(Array.isArray(child)) append(parent, child);
        else parent.append(child instanceof globalThis.Node ? child : String(child));
    }
}

/**
 * Replace an element's children
 * @param {Element} element
 * @param {...any} children
 */
export function replace(element, ...children)
{
    element.replaceChildren();
    append(element, children);
}

/**
 * A modal dialog; resolves with the value of the button pressed (Escape: undefined)
 * @param {{title: string, body?: any, buttons: Array<{label: string, value: any, primary?: boolean, danger?: boolean}>,
 *     focus?: HTMLElement, on_submit?: () => any}} options on_submit: the value of pressing Enter in a field
 * @return {Promise<any>}
 */
export function dialog(options)
{
    return new Promise(resolve =>
    {
        /** @type {HTMLDialogElement} */
        const element = /** @type {HTMLDialogElement} */ (h("dialog.dialog"));
        const close = value =>
        {
            element.close();
            element.remove();
            resolve(value);
        };
        const form = h("form", { method: "dialog", onsubmit: e => { e.preventDefault(); if(options.on_submit) close(options.on_submit()); } },
            h("h2", null, options.title),
            options.body ? h("div.dialog-body", null, options.body) : null,
            h("div.dialog-buttons", null, options.buttons.map(b => h("button" + (b.primary ? ".primary" : "") + (b.danger ? ".danger" : ""), {
                type: "button",
                onclick: () => close(b.value),
            }, b.label))));
        element.append(form);
        element.addEventListener("cancel", e => { e.preventDefault(); close(undefined); });
        document.body.append(element);
        element.showModal();
        (options.focus || element.querySelector("button.primary") || element.querySelector("button"))?.focus();
    });
}

/**
 * Ask for a line of text; undefined when cancelled
 * @param {string} title
 * @param {string} label
 * @param {string} value
 * @return {Promise<string | undefined>}
 */
export async function ask_text(title, label, value)
{
    const input = /** @type {HTMLInputElement} */ (h("input", { type: "text", value, "aria-label": label, size: 40 }));
    const answer = await dialog({
        title,
        body: h("label.field", null, h("span", null, label), input),
        focus: input,
        on_submit: () => input.value,
        buttons: [{ label: "Cancel", value: undefined }, { label: "OK", value: "ok", primary: true }],
    });
    return answer === undefined ? undefined : input.value;
}

/**
 * Ask a yes or no question
 * @param {string} title
 * @param {any} body
 * @param {string} yes the label of the button that says yes
 * @param {boolean} [danger]
 * @return {Promise<boolean>}
 */
export async function confirm(title, body, yes, danger = false)
{
    return await dialog({ title, body, buttons: [{ label: "Cancel", value: false }, { label: yes, value: true, primary: !danger, danger }] }) === true;
}

/**
 * Tell something; resolves when it is closed
 * @param {string} title
 * @param {any} body
 * @return {Promise<void>}
 */
export async function inform(title, body)
{
    await dialog({ title, body, buttons: [{ label: "OK", value: true, primary: true }] });
}

/**
 * Save data as a file of the user's
 * @param {BlobPart[]} parts
 * @param {string} name
 * @param {string} [type]
 */
export function download(parts, name, type = "application/octet-stream")
{
    const url = URL.createObjectURL(new Blob(parts, { type }));
    const link = h("a", { href: url, download: name, style: { display: "none" } });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/**
 * A file the user picks (undefined: none picked)
 * @param {string} accept
 * @return {Promise<File | undefined>}
 */
export function pick_file(accept)
{
    return new Promise(resolve =>
    {
        const input = /** @type {HTMLInputElement} */ (h("input", { type: "file", accept, style: { display: "none" } }));
        input.addEventListener("change", () => { resolve(input.files?.[0]); input.remove(); });
        input.addEventListener("cancel", () => { resolve(undefined); input.remove(); });
        document.body.append(input);
        input.click();
    });
}

/**
 * A size for people: 1.4 MB, 512 MB, 2 GB
 * @param {number} bytes
 * @return {string}
 */
export function format_size(bytes)
{
    const units = ["bytes", "KB", "MB", "GB", "TB"];
    let unit = 0;
    let value = bytes;
    while(value >= 1024 && unit < units.length - 1)
    {
        value /= 1024;
        unit++;
    }
    return (unit === 0 || value >= 100 || Number.isInteger(value) ? Math.round(value) : value.toFixed(1)) + " " + units[unit];
}

/**
 * @typedef {{label: string, action?: () => any, disabled?: boolean, checked?: boolean, title?: string, id?: string}} MenuItem
 */

/**
 * A menu button; its items are made each time it opens (their labels and
 * states follow the machine). Arrow keys move, Escape and a click elsewhere close it.
 * @param {string} label
 * @param {() => Array<MenuItem | "-">} items "-" separates
 * @param {string} [id] the button's id
 * @return {HTMLElement}
 */
export function menu_button(label, items, id)
{
    const list = h("div.menu-list", { role: "menu", hidden: true });
    const button = h("button.menu-button", { type: "button", "aria-haspopup": "menu", "aria-expanded": "false", id });
    button.textContent = label;
    const wrapper = h("div.menu", null, button, list);
    const outside = e => { if(!wrapper.contains(/** @type {Node} */ (e.target))) close(); };
    const close = () =>
    {
        list.hidden = true;
        button.setAttribute("aria-expanded", "false");
        document.removeEventListener("pointerdown", outside, true);
    };
    const open = () =>
    {
        replace(list, items().map(item => item === "-" ? h("div.menu-separator", { role: "separator" }) :
            h("button.menu-item", {
                type: "button",
                role: item.checked === undefined ? "menuitem" : "menuitemcheckbox",
                "aria-checked": item.checked === undefined ? undefined : String(item.checked),
                disabled: !!item.disabled,
                title: item.title || "",
                id: item.id,
                onclick: () => { close(); if(item.action) item.action(); },
            }, (item.checked === undefined ? "" : item.checked ? "✓ " : "   ") + item.label)));
        list.hidden = false;
        button.setAttribute("aria-expanded", "true");
        document.addEventListener("pointerdown", outside, true);
        /** @type {HTMLElement | null} */ (list.querySelector("button:not(:disabled)"))?.focus();
    };
    button.addEventListener("click", () => { if(list.hidden) open(); else close(); });
    wrapper.addEventListener("keydown", e =>
    {
        if(e.key === "Escape" && !list.hidden) { e.preventDefault(); close(); button.focus(); return; }
        if(e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
        if(list.hidden) { e.preventDefault(); open(); return; }
        const buttons = /** @type {HTMLElement[]} */ (Array.from(list.querySelectorAll("button:not(:disabled)")));
        const at = buttons.indexOf(/** @type {HTMLElement} */ (document.activeElement));
        e.preventDefault();
        buttons[(at + (e.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length]?.focus();
    });
    return wrapper;
}
