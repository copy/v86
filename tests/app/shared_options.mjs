#!/usr/bin/env node
// The old page's shared modules as ES modules (docs/vm-manager-plan.md U0):
// Node imports src/browser/profiles.js, vm_options.js and query_compat.js,
// as the VM manager will, and makes each start that tests/app/legacy_options.mjs
// recorded in the old pages (legacy.html's Closure build, debug.html's
// modules): the same options, alerts, addresses and form fields.
//   node tests/app/legacy_options.mjs record=build/app/legacy-options.json
//   node tests/app/shared_options.mjs build/app/legacy-options.json

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { get_profiles } from "../../src/browser/profiles.js";
import { DEFAULT_FORM, settings_to_options } from "../../src/browser/vm_options.js";
import { image_host, start_settings, format_query_args } from "../../src/browser/query_compat.js";
import { FORM_CASES, compare_records } from "./legacy_cases.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const record_file = process.argv[2];
if(!record_file)
{
    console.error("usage: node tests/app/shared_options.mjs <file recorded by tests/app/legacy_options.mjs>");
    process.exit(2);
}
const recorded = JSON.parse(fs.readFileSync(record_file, "utf8"));

const SCREEN = { id: "screen_container" };
/** A copy of the form (plain values) */
const clone = v => JSON.parse(JSON.stringify(v));
const ser = v =>
    v === undefined ? { $: "undefined" } :
    typeof v === "number" && !Number.isFinite(v) ? { $: String(v) } :
    v === null || typeof v !== "object" && typeof v !== "function" ? v :
    typeof v === "function" ? { $: "function" } :
    v === SCREEN ? { $: "element", id: v.id } :
    v instanceof ArrayBuffer ? { $: "ArrayBuffer", byteLength: v.byteLength } :
    Array.isArray(v) ? v.map(ser) :
    Object.fromEntries(Object.keys(v).sort().map(k => [k, ser(v[k])]));

/** The pages: their builds, form, version, title and elements */
const PAGES = {};
for(const [name, debug] of [["legacy.html", false], ["debug.html", true]])
{
    const html = fs.readFileSync(path.join(root, name), "utf8");
    const version = /id="version"[^>]*>([^<]*)</.exec(html);
    PAGES[name] = {
        debug,
        query_append: version ? "?" + version[1] : "",
        title: /<title>([^<]*)<\/title>/.exec(html)[1],
        ids: new Set(Array.from(html.matchAll(/id="([^"]+)"/g), m => m[1])),
        // (a select's options: a value it lacks makes its value "")
        selects: new Map(Array.from(html.matchAll(/<select id="([^"]+)">([\s\S]*?)<\/select>/g),
            m => [m[1], new Set(Array.from(m[2].matchAll(/<option value="([^"]*)"/g), o => o[1]))])),
        // (debug.html on localhost: the local relay, main.js's onload)
        form: Object.assign(clone(DEFAULT_FORM), debug ? { relay_url: "ws://localhost:8080/" } : {}),
    };
}

/** The form's fields that the recorder reads */
const FIELDS = ["memory_size", "vga_memory_size", "cpu_type", "machine_type", "acpi"];

/** A form case's steps on DEFAULT_FORM, as the page's fields hold them; undefined when the page lacks a field */
function fill_form(page, steps)
{
    const form = clone(page.form);
    for(const [what, id, value] of steps)
    {
        // (the empty disks' fields appear when their links are clicked)
        const toggled = id.endsWith("_empty_size") && steps.some(([w, i]) => w === "click" && i === id.replace("_empty_size", "_toggle_empty_disk"));
        if(!page.ids.has(id) && !toggled) return { missing: id };
        const disk = /^(hda|hdb|fda|fdb)_(url|disk_option|toggle_empty_disk|empty_size)$/.exec(id);
        if(what === "click")
        {
            // (an empty disk's default size: 100 MB, a 1.44 MB floppy)
            form.empty_sizes[disk[1]] = disk[1].startsWith("hd") ? 100 : 2880 * 512;
        }
        else if(disk && disk[2] === "url") form.urls[disk[1]] = value;
        else if(disk && disk[2] === "disk_option") form.disk_options[disk[1]] = value;
        else if(disk && disk[2] === "empty_size") form.empty_sizes[disk[1]] = +value;
        else form[id] = page.selects.has(id) && !page.selects.get(id).has(value) ? "" : value;
    }
    return { form };
}

/** A start as main.js makes it: the record the page would have */
function start(page, profile, query_args, form, location_search)
{
    const location_args = new URLSearchParams(location_search);
    const result = start_settings(profile, query_args, form, { location_args, origin: "http://ORIGIN", debug: page.debug, graphics_proxy: false });
    const fields = Object.fromEntries(FIELDS.filter(id => page.ids.has(id)).map(id => [id, form[id]]));
    if(result.error)
    {
        return { fields, kind: "alert", text: result.error };
    }
    for(const id of FIELDS)
    {
        const value = result.updates[id];
        if(value === undefined || !(id in fields)) continue;
        fields[id] = page.selects.has(id) && !page.selects.get(id).has(value) ? "" : value;
    }
    const options = settings_to_options(result.settings, {
        cpu_worker: result.cpu_worker, debug: page.debug, query_append: page.query_append, graphics_proxy: false, screen_container: SCREEN,
    });
    const title = result.title || profile?.name;
    return {
        fields,
        kind: "options",
        options: ser(options),
        reset: profile?.state ? "none" : "",
        search: query_args ? location_search : format_query_args(result.new_query_args),
        title: title ? title + " - v86" + (page.debug ? " - debug" : "") : page.title,
    };
}

const made = {};
// (the modules' notes, as "More than 2048 MB of memory: selecting the x86_64 CPU")
const log = console.log;
console.log = () => {};
for(const key of Object.keys(recorded))
{
    const [page_name, kind, ...rest] = key.split(" ");
    const page = PAGES[page_name];
    if(kind === "form")
    {
        const name = rest.join(" ");
        const steps = FORM_CASES.find(([n]) => n === name)[1];
        const filled = fill_form(page, steps);
        made[key] = filled.missing ? { id: filled.missing, kind: "missing" } : start(page, null, null, filled.form, "");
        continue;
    }
    // (main.js's onload: a profile's id, or custom with an image)
    const search = kind;
    const query_args = new URLSearchParams(search);
    const id = query_args.get("profile");
    const profile = get_profiles(image_host(query_args, true), true).find(p => p.id === id);
    if(profile || id === "custom" && ["hda.url", "cdrom.url", "fda.url"].some(name => query_args.has(name)))
    {
        made[key] = start(page, profile || null, query_args, clone(page.form), search);
    }
    else
    {
        made[key] = { kind: "no start" };
    }
}

console.log = log;

const differences = compare_records(recorded, made);
for(const line of differences.slice(0, 50)) console.log(line);
console.log(Object.keys(made).length + " starts made by the modules: " +
    (differences.length ? "FAIL, " + differences.length + " differences from " + record_file : "PASS, the same as the pages recorded"));
process.exitCode = differences.length ? 1 : 0;
