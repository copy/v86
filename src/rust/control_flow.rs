use std::collections::HashSet;
use std::collections::{BTreeMap, BTreeSet};
use std::iter;

use crate::jit::{BasicBlock, BasicBlockType, MAX_EXTRA_BASIC_BLOCKS};
use crate::profiler;

const ENTRY_NODE_ID: u32 = 0xffff_ffff;

// this code works fine with either BTree or Hash Maps/Sets
// - HashMap / HashSet: slightly faster
// - BTreeMap / BTreeSet: stable iteration order (graphs don't change between rust versions, required for expect tests)
type Set = BTreeSet<u32>;
type Graph = BTreeMap<u32, Set>;

/// Reverse the direction of all edges in the graph
fn rev_graph_edges(nodes: &Graph) -> Graph {
    let mut rev_nodes = Graph::new();
    for (from, tos) in nodes {
        for to in tos {
            rev_nodes
                .entry(*to)
                .or_insert_with(|| Set::new())
                .insert(*from);
        }
    }
    rev_nodes
}

pub fn make_graph(basic_blocks: &Vec<BasicBlock>) -> Graph {
    let mut nodes = Graph::new();
    let mut entry_edges = Set::new();

    for b in basic_blocks.iter() {
        let mut edges = Set::new();

        match &b.ty {
            &BasicBlockType::ConditionalJump {
                next_block_addr,
                next_block_branch_taken_addr,
                ..
            } => {
                if let Some(next_block_addr) = next_block_addr {
                    edges.insert(next_block_addr);
                }
                if let Some(next_block_branch_taken_addr) = next_block_branch_taken_addr {
                    edges.insert(next_block_branch_taken_addr);
                }
            },
            &BasicBlockType::Normal {
                next_block_addr: Some(next_block_addr),
                ..
            } => {
                edges.insert(next_block_addr);
            },
            &BasicBlockType::Normal {
                next_block_addr: None,
                ..
            } => {},
            BasicBlockType::Exit => {},
            BasicBlockType::AbsoluteEip => {
                // Not necessary: We generate a loop around the outer brtable unconditionally
                //edges.insert(ENTRY_NODE_ID);
            },
        }

        nodes.insert(b.addr, edges);

        if b.is_entry_block {
            entry_edges.insert(b.addr);
        }
    }

    // Entry node that represents the initial basic block of the generated function (must be
    // able to reach all entry nodes)
    nodes.insert(ENTRY_NODE_ID, entry_edges);
    return nodes;
}

pub enum WasmStructure {
    BasicBlock(u32),
    Dispatcher(Vec<u32>),
    Loop(Vec<WasmStructure>),
    Block(Vec<WasmStructure>),
}
impl WasmStructure {
    pub fn print(&self, depth: usize) {
        match self {
            Self::BasicBlock(addr) => {
                dbg_log!("{} 0x{:x}", " ".repeat(depth), addr);
            },
            Self::Dispatcher(entries) => {
                dbg_log!("{} Dispatcher entries:", " ".repeat(depth));
                for e in entries {
                    dbg_log!("{}  {:x}", " ".repeat(depth), e);
                }
            },
            Self::Loop(elements) => {
                dbg_log!("{} loop_void({})", " ".repeat(depth), elements.len());
                for e in elements {
                    e.print(depth + 1)
                }
                dbg_log!("{} loop_end({})", " ".repeat(depth), elements.len());
            },
            Self::Block(elements) => {
                dbg_log!("{} block_void({})", " ".repeat(depth), elements.len());
                for e in elements {
                    e.print(depth + 1)
                }
                dbg_log!("{} block_end({})", " ".repeat(depth), elements.len());
            },
        }
    }

    fn branches(&self, edges: &Graph) -> HashSet<u32> {
        fn handle(block: &WasmStructure, edges: &Graph, result: &mut HashSet<u32>) {
            match block {
                WasmStructure::BasicBlock(addr) => result.extend(edges.get(&addr).unwrap()),
                WasmStructure::Dispatcher(entries) => result.extend(entries),
                WasmStructure::Loop(children) | WasmStructure::Block(children) => {
                    for c in children.iter() {
                        handle(c, edges, result);
                    }
                },
            }
        }

        let mut result = HashSet::new();
        handle(self, edges, &mut result);
        result
    }

    pub fn head(&self) -> Box<dyn iter::Iterator<Item = u32> + '_> {
        match self {
            Self::BasicBlock(addr) => Box::new(iter::once(*addr)),
            Self::Dispatcher(entries) => Box::new(entries.iter().copied()),
            Self::Loop(children) => children.first().unwrap().head(),
            Self::Block(elements) => elements.first().unwrap().head(),
        }
    }
}

/// Check:
/// - Dispatcher appears at the beginning of a loop
/// - No two nested blocks at the end
/// - No two nested loops at the beginning
/// - No empty blocks or loops
/// - The entry node block is not present
pub fn assert_invariants(blocks: &Vec<WasmStructure>) {
    fn check(node: &WasmStructure, in_tail_block: bool, in_head_loop: bool, is_first: bool) {
        match node {
            WasmStructure::Block(children) => {
                dbg_assert!(!in_tail_block);
                dbg_assert!(!children.is_empty());
                for (i, c) in children.iter().enumerate() {
                    let is_first = i == 0;
                    let is_last = i == children.len() - 1;
                    check(c, is_last, in_head_loop && is_first, is_first);
                }
            },
            WasmStructure::Loop(children) => {
                dbg_assert!(!in_head_loop);
                dbg_assert!(!children.is_empty());
                for (i, c) in children.iter().enumerate() {
                    let is_first = i == 0;
                    let is_last = i == children.len() - 1;
                    check(c, in_tail_block && is_last, is_first, is_first);
                }
            },
            &WasmStructure::BasicBlock(addr) => {
                dbg_assert!(addr != ENTRY_NODE_ID);
            },
            WasmStructure::Dispatcher(_) => {
                dbg_assert!(is_first);
                //dbg_assert!(in_head_loop); // fails for module dispatcher
            },
        }
    }

    for (i, b) in blocks.iter().enumerate() {
        check(b, false, false, i == 0);
    }
}

/// Strongly connected components via Kosaraju's algorithm
fn scc(edges: &Graph, rev_edges: &Graph) -> Vec<Vec<u32>> {
    fn visit(
        node: u32,
        edges: &Graph,
        rev_edges: &Graph,
        visited: &mut HashSet<u32>,
        l: &mut Vec<u32>,
    ) {
        if visited.contains(&node) {
            return;
        }
        visited.insert(node);
        for &next in edges.get(&node).unwrap() {
            visit(next, edges, rev_edges, visited, l);
        }
        l.push(node);
    }

    let mut l = Vec::new();
    let mut visited = HashSet::new();
    for &node in edges.keys() {
        visit(node, edges, rev_edges, &mut visited, &mut l);
    }

    fn assign(
        node: u32,
        edges: &Graph,
        rev_edges: &Graph,
        assigned: &mut HashSet<u32>,
        group: &mut Vec<u32>,
    ) {
        if assigned.contains(&node) {
            return;
        }
        assigned.insert(node);
        group.push(node);
        if let Some(nexts) = rev_edges.get(&node) {
            for &next in nexts {
                assign(next, edges, rev_edges, assigned, group);
            }
        }
    }
    let mut assigned = HashSet::new();
    let mut assignment = Vec::new();
    for &node in l.iter().rev() {
        let mut group = Vec::new();
        assign(node, edges, rev_edges, &mut assigned, &mut group);
        if !group.is_empty() {
            assignment.push(group);
        }
    }

    assignment
}

pub fn loopify(nodes: &Graph) -> Vec<WasmStructure> {
    let rev_nodes = rev_graph_edges(nodes);
    let groups = scc(nodes, &rev_nodes);

    return groups
        .iter()
        .flat_map(|group| {
            dbg_assert!(!group.is_empty());
            if group.len() == 1 {
                let addr = group[0];
                if addr == ENTRY_NODE_ID {
                    let entries = nodes.get(&ENTRY_NODE_ID).unwrap().iter().copied().collect();
                    return vec![WasmStructure::Dispatcher(entries)].into_iter();
                }
                let block = WasmStructure::BasicBlock(addr);
                // self-loops
                if nodes.get(&group[0]).unwrap().contains(&group[0]) {
                    return vec![WasmStructure::Loop(vec![block])].into_iter();
                }
                else {
                    return vec![block].into_iter();
                }
            }

            let entries_to_group: Vec<u32> = group
                .iter()
                .filter(|addr| {
                    // reachable from outside of the group
                    rev_nodes.get(addr).map_or(false, |x| {
                        x.iter().any(|incoming| !group.contains(incoming))
                    })
                })
                .copied()
                .collect();

            if entries_to_group.len() != 1 {
                //dbg_log!(
                //    "Compiling multi-entry loop with {} entries and {} basic blocks",
                //    entries_to_group.len(),
                //    group.len()
                //);
            }

            let max_extra_basic_blocks = unsafe { MAX_EXTRA_BASIC_BLOCKS } as usize;

            if entries_to_group.len() * group.len() > max_extra_basic_blocks {
                let mut subgroup_edges: Graph = Graph::new();
                for elem in group {
                    subgroup_edges.insert(
                        *elem,
                        nodes
                            .get(&elem)
                            .unwrap()
                            .iter()
                            .filter(|dest| {
                                // XXX: This might remove forward edges to other loop entries
                                //      Probably not an issue since it can go through the
                                //      dispatcher
                                group.contains(dest) && !entries_to_group.contains(dest)
                            })
                            .copied()
                            .collect(),
                    );
                }

                let mut loop_nodes = loopify(&subgroup_edges);

                if entries_to_group.len() > 1 {
                    loop_nodes.insert(0, WasmStructure::Dispatcher(entries_to_group));
                }

                return vec![WasmStructure::Loop(loop_nodes)].into_iter();
            }
            else {
                profiler::stat_increment_by(
                    profiler::stat::COMPILE_DUPLICATED_BASIC_BLOCK,
                    ((entries_to_group.len() - 1) * group.len()) as u64,
                );

                let nodes: Vec<WasmStructure> = entries_to_group
                    .iter()
                    .map(|&entry| {
                        let mut subgroup_edges: Graph = Graph::new();
                        for &elem in group {
                            subgroup_edges.insert(
                                elem,
                                nodes
                                    .get(&elem)
                                    .unwrap()
                                    .iter()
                                    .copied()
                                    .filter(|dest| group.contains(dest) && *dest != entry)
                                    .collect(),
                            );
                        }
                        let loop_nodes = loopify(&subgroup_edges);
                        WasmStructure::Loop(loop_nodes)
                    })
                    .collect();

                nodes.into_iter()
            }
        })
        .collect();
}

pub fn blockify(blocks: &mut Vec<WasmStructure>, edges: &Graph) {
    let mut cached_branches: Vec<HashSet<u32>> = Vec::new();
    for i in 0..blocks.len() {
        cached_branches.push(blocks[i].branches(edges));
    }

    let mut i = 0;
    while i < blocks.len() {
        match &mut blocks[i] {
            WasmStructure::BasicBlock(_) | WasmStructure::Dispatcher(_) => {},
            WasmStructure::Loop (
                blocks
            )
            // TODO: Might be faster to do this *after* inserting blocks in this block
            | WasmStructure::Block(blocks) => blockify(blocks, edges),
        }

        let source = {
            let mut source = None;
            for j in 0..i {
                if blocks[i].head().any(|bb| cached_branches[j].contains(&bb)) {
                    source = Some(j);
                    break;
                }
            }
            match source {
                Some(s) => s,
                None => {
                    i += 1;
                    continue;
                },
            }
        };

        // This is optional: Avoid putting a single basic block into a block
        if source == i - 1 {
            match &blocks[source] {
                &WasmStructure::BasicBlock(_) => {
                    i += 1;
                    continue;
                },
                _ => {},
            }
        }

        let replacement = WasmStructure::Block(Vec::new());
        let children: Vec<WasmStructure> =
            blocks.splice(source..i, iter::once(replacement)).collect();
        match &mut blocks[source] {
            WasmStructure::Block(c) => c.extend(children),
            _ => {
                dbg_assert!(false);
            },
        }
        match &blocks[source + 1] {
            WasmStructure::BasicBlock(_) =>
                //dbg_assert!(*b == bbs.next().unwrap())
                {},
            WasmStructure::Dispatcher(_) => {},
            WasmStructure::Loop(_blocks) | WasmStructure::Block(_blocks) => {}, //dbg_assert!(blocks[0].head() == bb),
        }

        {
            let replacement = HashSet::new();
            let children: Vec<HashSet<u32>> = cached_branches
                .splice(source..i, iter::once(replacement))
                .collect();
            dbg_assert!(cached_branches[source].len() == 0);
            let mut iter = children.into_iter();
            cached_branches[source] = iter.next().unwrap();
            for c in iter {
                cached_branches[source].extend(c);
            }
        }

        // skip the inserted block and this block
        i = source + 2;
    }
}
