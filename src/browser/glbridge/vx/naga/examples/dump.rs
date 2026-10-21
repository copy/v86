//! cargo run --example dump -- <file.spv>: the module naga reads (after VX's
//! SPIR-V passes): its global variables and entry points, for debugging
fn main() {
    let path = std::env::args().nth(1).expect("a SPIR-V file");
    let bytes = std::fs::read(&path).expect("read");
    // (DUMP_SPV=<file>: the SPIR-V after VX's passes written there)
    if let Ok(out) = std::env::var("DUMP_SPV") {
        std::fs::write(out, vx_naga::passes_for_debugging(&bytes)).expect("write");
    }
    let module = vx_naga::parse_for_debugging(&bytes).expect("parse");
    for (handle, var) in module.global_variables.iter() {
        println!("{:?} {:?} {:?} {:?} {:?}", handle, var.name, var.space, var.binding, module.types[var.ty].inner);
    }
    // (DUMP_FUNCTION=<index>: that function's expressions and stores)
    if let Ok(index) = std::env::var("DUMP_FUNCTION") {
        let f = &module.functions[module.functions.iter().nth(index.parse().unwrap()).unwrap().0];
        for (h, e) in f.expressions.iter() {
            println!("  {:?} {:?}", h, e);
        }
        println!("  body {:?}", f.body);
        for (h, v) in f.local_variables.iter() {
            println!("  local {:?} {:?}", h, module.types[v.ty].inner);
        }
    }
    for ep in &module.entry_points {
        println!("entry {} {:?}", ep.name, ep.stage);
        for a in &ep.function.arguments {
            println!("  in {:?} {:?} {:?}", a.name, a.binding, module.types[a.ty].inner);
        }
        if let Some(r) = &ep.function.result {
            println!("  out {:?}", module.types[r.ty].inner);
        }
    }
}
