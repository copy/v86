//! The sampling of inputs and outputs decorated Centroid or Sample: naga's
//! SPIR-V front end gives a binding without an interpolation decoration
//! (GLSL's smooth, the default) perspective interpolation at the center,
//! over what the decorations said. `read` takes them from the SPIR-V,
//! `restore` puts them back on the entry points' bindings.

use alloc::vec::Vec;
use naga::{Binding, Interpolation, Sampling, TypeInner};

const OP_VARIABLE: u32 = 59;
const OP_DECORATE: u32 = 71;
const DECORATION_CENTROID: u32 = 16;
const DECORATION_SAMPLE: u32 = 17;
const DECORATION_LOCATION: u32 = 30;
const STORAGE_INPUT: u32 = 1;
const STORAGE_OUTPUT: u32 = 3;

/// The inputs' and outputs' sampling other than the center: (output, location, sampling)
pub fn read(words: &[u32]) -> Vec<(bool, u32, Sampling)> {
    use alloc::collections::BTreeMap;
    let mut storage: BTreeMap<u32, bool> = BTreeMap::new();
    let mut locations: BTreeMap<u32, u32> = BTreeMap::new();
    let mut sampling: BTreeMap<u32, Sampling> = BTreeMap::new();
    let mut at = 5;
    while at < words.len() {
        let count = (words[at] >> 16) as usize;
        if count == 0 || at + count > words.len() {
            break;
        }
        let w = &words[at..at + count];
        match w[0] & 0xFFFF {
            OP_VARIABLE if count >= 4 && (w[3] == STORAGE_INPUT || w[3] == STORAGE_OUTPUT) => {
                storage.insert(w[2], w[3] == STORAGE_OUTPUT);
            },
            OP_DECORATE if count >= 4 && w[2] == DECORATION_LOCATION => {
                locations.insert(w[1], w[3]);
            },
            OP_DECORATE if count >= 3 && w[2] == DECORATION_CENTROID => {
                sampling.insert(w[1], Sampling::Centroid);
            },
            OP_DECORATE if count >= 3 && w[2] == DECORATION_SAMPLE => {
                sampling.insert(w[1], Sampling::Sample);
            },
            _ => {},
        }
        at += count;
    }
    sampling.iter().filter_map(|(id, s)| Some((*storage.get(id)?, *locations.get(id)?, *s))).collect()
}

/// The entry points' bindings at those locations given their sampling back
/// (before io.rs splits a matrix or array into locations after its first)
pub fn restore(module: &mut naga::Module, list: &[(bool, u32, Sampling)]) {
    if list.is_empty() {
        return;
    }
    let fix = |binding: &mut Option<Binding>, output: bool| {
        if let Some(Binding::Location { location, interpolation, sampling, .. }) = binding {
            if matches!(interpolation, Some(Interpolation::Perspective) | Some(Interpolation::Linear)) {
                if let Some((_, _, s)) = list.iter().find(|(o, l, _)| *o == output && *l == *location) {
                    *sampling = Some(*s);
                }
            }
        }
    };
    for ep in module.entry_points.iter_mut() {
        for a in ep.function.arguments.iter_mut() {
            fix(&mut a.binding, false);
        }
        let Some(result) = ep.function.result.as_mut() else { continue };
        fix(&mut result.binding, true);
        if let TypeInner::Struct { members, span } = module.types[result.ty].inner.clone() {
            let mut changed = members.clone();
            for m in changed.iter_mut() {
                fix(&mut m.binding, true);
            }
            // (UniqueArena's replace refuses a type it has)
            if changed != members {
                let name = module.types[result.ty].name.clone();
                module.types.replace(result.ty, naga::Type { name, inner: TypeInner::Struct { members: changed, span } });
            }
        }
    }
}
