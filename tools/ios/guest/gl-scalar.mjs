// GLI adds an opaque driver pointer before the public iOS arguments.
// The emugl request has an 8-byte header and byte-packed little-endian
// scalars. Both Darwin ARM and the host protocol use IEEE binary32.
import { GLES_APIS } from "../../../src/gles/gles_protocol.js";
import { dispatch_slot } from "../gl-dispatch.mjs";

export const c_type = { u8: "unsigned char", i32: "int", u32: "unsigned", f32: "float", void: "void" };

export function scalar_commands(wrappers)
{
    const special = new Set(["glClear", "glClearColor", "glEnable", "glScissor", "glGetError"]);
    // 10B329 gives both calls exactly the same entry point. A provider
    // needs the object's type before it can choose an emugl opcode.
    special.add("glDeleteProgram");
    special.add("glDeleteShader");
    const taken = new Set();
    return GLES_APIS.gles2.commands.filter(([name, ret, params, flags]) => {
        if(!wrappers.has(name) || special.has(name) || flags?.includes("unsupported") ||
            !Object.hasOwn(c_type, ret) || !params.every(p => Object.hasOwn(c_type, p[1]))) return false;
        const slot = dispatch_slot(wrappers.get(name));
        if(taken.has(slot)) throw new Error("ambiguous scalar callback: " + name);
        taken.add(slot);
        return true;
    });
}

export function scalar_driver(commands)
{
    const lines = ["// Generated from the local OpenGLES ABI and the emugl command descriptions."];
    for(const [name, ret, params] of commands)
    {
        const args = params.map(([n,t]) => c_type[t] + " " + n);
        lines.push("static __attribute__((pcs(\"aapcs\"))) " + c_type[ret] + " driver_" + name + "(" + ["struct n90_driver *d", ...args].join(", ") + ")", "{",
            "    struct __attribute__((packed)) { unsigned op, size; " + args.map(a => a + ";").join(" ") + " }",
            "        packet = { " + ["gles2_" + name, "sizeof(packet)", ...params.map(p => p[0])].join(", ") + " };");
        const sent = "gles_call(2, &packet, sizeof(packet), d->connection) == (int)sizeof(packet)";
        if(ret === "void") lines.push("    d->ok &= " + sent + ";");
        else lines.push("    " + c_type[ret] + " result = 0;",
            "    d->ok &= " + sent + " && gles_read(d->connection, &result, sizeof(result));", "    return result;");
        lines.push("}", "");
    }
    lines.push("static void install_scalar_functions(driver_word *functions)", "{");
    for(const [name] of commands) lines.push("    functions[N90_" + name + " - 5] = (driver_word)driver_" + name + ";");
    return lines.concat("}", "").join("\n");
}
