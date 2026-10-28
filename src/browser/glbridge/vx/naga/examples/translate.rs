//! cargo run --example translate -- <file.spv>...: the JSON answer of each
//! (VX_INT_WRAPS=<key>:<modes>,...: integer images' address modes, Options::int_wraps)
fn main() {
    let int_wraps: Vec<(u32, u32)> = std::env::var("VX_INT_WRAPS").unwrap_or_default().split(',').filter(|s| !s.is_empty())
        .map(|s| { let (k, m) = s.split_once(':').expect("key:modes"); (k.parse().unwrap(), u32::from_str_radix(m.trim_start_matches("0x"), 16).unwrap()) }).collect();
    for path in std::env::args().skip(1) {
        let bytes = std::fs::read(&path).expect("read");
        match vx_naga::translate(&bytes, &vx_naga::Options { immediates_group: 3, immediates_binding: 998, keep_coordinate_space: false, storage_uniforms: Vec::new(), drop_frag_depth: std::env::var("VX_NO_DEPTH").is_ok(), reverse_depth: std::env::var("VX_REVERSE_DEPTH").is_ok(), gl_depth: std::env::var("VX_GL_DEPTH").is_ok(), int_wraps: int_wraps.clone() }) {
            Ok(json) => println!("{}: {}", path, json),
            Err(e) => println!("{}: ERROR {}", path, e),
        }
    }
}
