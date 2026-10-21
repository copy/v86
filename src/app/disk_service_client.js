// @ts-check
// The VM manager's side of a disk service (docs/vm-manager-plan.md "磁盘服务
// 的创建与列出", tools/disk-service.mjs): its images (list), a new image
// (create), and whether a URL is a disk service at all (probe). Its images
// are a configuration's images of kind "url" with disk_option "read_write".

/** The local disk service of make run (tools/dev-server.py) */
export const LOCAL_SERVICE = "http://127.0.0.1:8471/";

/**
 * @typedef {{url: string, token?: string}} Service a disk service's URL and its token (if it needs one)
 * @typedef {{name: string, size: number, modified: string, writer: boolean}} ServiceImage
 * @typedef {{images: ServiceImage[], create: boolean, max_size: number}} ServiceList
 */

/** A disk service's refusal: its code (create, name, size, exists, no_space, token, origin, ...) and status */
export class ServiceError extends Error
{
    /**
     * @param {string} message
     * @param {string} code
     * @param {number} status
     */
    constructor(message, code, status)
    {
        super(message);
        this.code = code;
        this.status = status;
    }
}

/**
 * The service's URL, ending in /
 * @param {string} url
 * @return {string}
 */
export function service_base(url)
{
    return url.endsWith("/") ? url : url + "/";
}

/**
 * The URL of an image of the service
 * @param {Service} service
 * @param {string} name
 * @return {string}
 */
export function image_url(service, name)
{
    return service_base(service.url) + encodeURIComponent(name);
}

/**
 * @param {Service} service
 * @param {string} name "" for the service itself
 * @param {Object<string, string>} headers
 * @return {Promise<any>}
 */
async function operate(service, name, headers)
{
    const all = Object.assign({}, headers);
    if(service.token) all["Authorization"] = "Bearer " + service.token;
    let response;
    try
    {
        response = await fetch(service_base(service.url) + (name ? encodeURIComponent(name) : ""), { method: "POST", headers: all, cache: "no-store" });
    }
    catch(e)
    {
        throw new ServiceError("The disk service at " + service.url + " cannot be reached, or does not accept this page " +
            "(start it with --origin " + globalThis.location?.origin + ")", "unreachable", 0);
    }
    if(!response.headers.get("X-V86-Disk-Protocol"))
    {
        throw new ServiceError(service.url + " is not a disk service that lists and creates images (an older version answers " +
            response.status + ")", "not_a_service", response.status);
    }
    const body = await response.json().catch(() => ({}));
    if(!response.ok) throw new ServiceError(body.error || "The disk service refused (" + response.status + ")", body.code || "refused", response.status);
    return body;
}

/**
 * The service's images, and whether it creates new ones
 * @param {Service} service
 * @return {Promise<ServiceList>}
 */
export async function list_images(service)
{
    return operate(service, "", { "X-V86-Disk-Op": "list" });
}

/**
 * A new image of zeros in the service's directory
 * @param {Service} service
 * @param {string} name a name ending in .img
 * @param {number} size bytes, a multiple of 512
 * @return {Promise<{name: string, size: number, url: string}>}
 */
export async function create_image(service, name, size)
{
    return operate(service, name, { "X-V86-Disk-Op": "create", "X-V86-Disk-Size": String(size) });
}

/**
 * Whether a disk service answers at the URL, and what it has
 * @param {Service} service
 * @return {Promise<{ok: true, list: ServiceList} | {ok: false, reason: string, code: string}>}
 */
export async function probe(service)
{
    try
    {
        return { ok: true, list: await list_images(service) };
    }
    catch(e)
    {
        return { ok: false, reason: e.message, code: e.code || "error" };
    }
}

/**
 * A name for a new image of the service: the machine's name in letters,
 * digits and dashes, not taken yet
 * @param {string} machine
 * @param {ServiceImage[]} images
 * @return {string}
 */
export function new_image_name(machine, images)
{
    const base = machine.normalize("NFKD").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase().slice(0, 100) || "disk";
    const taken = new Set(images.map(image => image.name));
    for(let i = 1; ; i++)
    {
        const name = base + (i === 1 ? "" : "-" + i) + ".img";
        if(!taken.has(name)) return name;
    }
}
