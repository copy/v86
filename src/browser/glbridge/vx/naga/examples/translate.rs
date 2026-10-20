//! cargo run --example translate -- <file.spv>...: the JSON answer of each
fn main() {
    for path in std::env::args().skip(1) {
        let bytes = std::fs::read(&path).expect("read");
        match vx_naga::translate(&bytes, &vx_naga::Options { immediates_group: 3, immediates_binding: 998, keep_coordinate_space: false, storage_uniforms: Vec::new(), drop_frag_depth: std::env::var("VX_NO_DEPTH").is_ok(), reverse_depth: std::env::var("VX_REVERSE_DEPTH").is_ok() }) {
            Ok(json) => println!("{}: {}", path, json),
            Err(e) => println!("{}: ERROR {}", path, e),
        }
    }
}
