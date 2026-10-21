//! The compute shader of a capturing draw for a vertex shader's SPIR-V
//! (xfb.rs): cargo run --example xfb -- shader.spv [group]; its vertex
//! input: attributes (location, slot, VkFormat, offset) 0/0/R32G32_SFLOAT/0,
//! 1/1/R8G8B8A8_UNORM/0, 2/1/R32_UINT/4; slots 0 stride 8, 1 stride 8
fn main() {
    let args: Vec<String> = std::env::args().collect();
    let bytes = std::fs::read(&args[1]).expect("the SPIR-V");
    let group = args.get(2).map_or(1, |g| g.parse().unwrap());
    let input = vx_naga::XfbInput {
        attributes: vec![
            vx_naga::xfb::Attribute { location: 0, slot: 0, format: 103, offset: 0 },
            vx_naga::xfb::Attribute { location: 1, slot: 1, format: 37, offset: 0 },
            vx_naga::xfb::Attribute { location: 2, slot: 1, format: 98, offset: 4 },
        ],
        slots: vec![vx_naga::xfb::Slot { slot: 0, stride: 8, instance: false }, vx_naga::xfb::Slot { slot: 1, stride: 8, instance: false }],
        group,
    };
    let options = vx_naga::Options { immediates_group: 3, immediates_binding: 998, keep_coordinate_space: true, storage_uniforms: Vec::new(), drop_frag_depth: false, reverse_depth: false, int_wraps: Vec::new() };
    match vx_naga::translate_xfb(&bytes, &options, &input) {
        Ok(json) => println!("{}", json),
        Err(e) => { eprintln!("error: {}", e); std::process::exit(1); }
    }
}
