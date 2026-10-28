//! The compute shader of a tessellation shader's SPIR-V (tessellation.rs):
//! cargo run --example tessellation -- shader.spv control|evaluation [group]
fn main() {
    let args: Vec<String> = std::env::args().collect();
    let bytes = std::fs::read(&args[1]).expect("the SPIR-V");
    let group = args.get(3).map_or(1, |g| g.parse().unwrap());
    let options = vx_naga::Options { immediates_group: 0, immediates_binding: 0, keep_coordinate_space: true, storage_uniforms: Vec::new(), drop_frag_depth: false,
        reverse_depth: false, gl_depth: false, int_wraps: Vec::new() };
    match vx_naga::translate_tessellation(&bytes, &options, args[2] == "control", group) {
        Ok(json) => println!("{}", json),
        Err(e) => { eprintln!("error: {}", e); std::process::exit(1); }
    }
}
