//! The loop structure of a page function (docs/jit-unification-plan.md:
//! from IR Tier-0's page analysis, ir::tier0::analysis until P7.5 deleted
//! Tier-0): each cycle of the block graph (a strongly connected set) is a
//! Wasm loop whose first block, its header, is the member with the lowest
//! address; nested cycles (those left after removing the edges into the
//! header) nest.

/// A page function's blocks in address order, cycles as loops
pub enum Unit {
    Block(u32),
    Loop { header: u32, units: Vec<Unit> },
}
impl Unit {
    pub fn blocks(&self, out: &mut Vec<u32>) {
        match self {
            Unit::Block(k) => out.push(*k),
            Unit::Loop { units, .. } => units.iter().for_each(|u| u.blocks(out)),
        }
    }
    pub fn first(&self) -> u32 {
        match self {
            Unit::Block(k) => *k,
            Unit::Loop { header, .. } => *header,
        }
    }
}

/// Loop dispatch table bounds: per loop, and for all loops of a function
/// (frame::structured; V8 compiles functions with very large tables slowly or
/// not at all, its per-function zone limit)
pub(crate) const MAX_LOOP_TABLE: usize = 1024;
pub(crate) const MAX_LOOP_TABLES: usize = 8192;
pub(crate) fn visit_loops(units: &[Unit], f: &mut dyn FnMut(&Unit)) {
    for unit in units {
        if let Unit::Loop { units, .. } = unit {
            f(unit);
            visit_loops(units, f);
        }
    }
}
/// Replace the loops matching `wide` by their units (in address order).
pub(crate) fn flatten(units: &mut Vec<Unit>, wide: &dyn Fn(&Unit) -> bool) {
    let mut out = Vec::with_capacity(units.len());
    for unit in std::mem::take(units) {
        let flat = matches!(unit, Unit::Loop { .. }) && wide(&unit);
        match unit {
            Unit::Loop {
                header,
                units: mut inner,
            } => {
                flatten(&mut inner, wide);
                if flat {
                    out.extend(inner);
                }
                else {
                    out.push(Unit::Loop {
                        header,
                        units: inner,
                    });
                }
            },
            unit => out.push(unit),
        }
    }
    out.sort_by_key(Unit::first);
    *units = out;
}

/// Units of `members` (sorted), ignoring edges into `header`.
pub(crate) fn units(members: &[u32], successors: &[Vec<u32>], header: Option<u32>) -> Vec<Unit> {
    let n = successors.len();
    let mut member = vec![false; n];
    for &k in members {
        member[k as usize] = true;
    }
    let edges = |k: u32| -> Vec<u32> {
        successors[k as usize]
            .iter()
            .copied()
            .filter(|&t| member[t as usize] && Some(t) != header)
            .collect()
    };
    // Tarjan's strongly connected components.
    let mut index = vec![u32::MAX; n];
    let mut low = vec![0u32; n];
    let mut on_stack = vec![false; n];
    let mut stack = vec![];
    let mut next = 0;
    let mut components: Vec<Vec<u32>> = vec![];
    for &root in members {
        if index[root as usize] != u32::MAX {
            continue;
        }
        // Iterative DFS: (block, successor position).
        let mut work = vec![(root, 0usize)];
        index[root as usize] = next;
        low[root as usize] = next;
        next += 1;
        stack.push(root);
        on_stack[root as usize] = true;
        while let Some(&mut (v, ref mut position)) = work.last_mut() {
            let targets = edges(v);
            if let Some(&w) = targets.get(*position) {
                *position += 1;
                if index[w as usize] == u32::MAX {
                    index[w as usize] = next;
                    low[w as usize] = next;
                    next += 1;
                    stack.push(w);
                    on_stack[w as usize] = true;
                    work.push((w, 0));
                }
                else if on_stack[w as usize] {
                    low[v as usize] = low[v as usize].min(index[w as usize]);
                }
                continue;
            }
            work.pop();
            if let Some(&(parent, _)) = work.last() {
                low[parent as usize] = low[parent as usize].min(low[v as usize]);
            }
            if low[v as usize] == index[v as usize] {
                let mut component = vec![];
                loop {
                    let w = stack.pop().unwrap();
                    on_stack[w as usize] = false;
                    component.push(w);
                    if w == v {
                        break;
                    }
                }
                component.sort_unstable();
                components.push(component);
            }
        }
    }
    let mut result: Vec<Unit> = components
        .into_iter()
        .map(|component| {
            let k = component[0];
            if component.len() == 1 && !edges(k).contains(&k) {
                Unit::Block(k)
            }
            else {
                Unit::Loop {
                    header: k,
                    units: units(&component, successors, Some(k)),
                }
            }
        })
        .collect();
    result.sort_by_key(Unit::first);
    result
}
