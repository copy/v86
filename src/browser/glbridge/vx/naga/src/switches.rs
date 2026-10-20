//! Switch cases that fall through (GLSL allows them, WGSL has no fallthrough
//! and naga's WGSL writer does not do them): a case that falls through into
//! the next gets a copy of the next one's statements (and so on, while they
//! fall through too), its expressions copied as new ones, so that it ends as
//! the next one does. Cases with nothing in them that fall through stay
//! (naga writes them as one case of several values).

use alloc::collections::BTreeMap;
use alloc::vec::Vec;
use naga::{Arena, Block, Expression, Handle, Span, Statement};

type H = Handle<Expression>;

/// A copy of a block: its emitted expressions copied (`map`, old to new),
/// the call and atomic results new ones; None for a kind of statement not done
fn copy(block: &Block, expressions: &mut Arena<Expression>, map: &mut BTreeMap<usize, H>) -> Option<Block> {
    let mut out = Vec::new();
    for statement in block.iter() {
        let s = match statement {
            Statement::Emit(range) => {
                let first = expressions.len();
                for h in range.clone() {
                    let e = {
                        let m = &*map;
                        crate::remap::remap_expression(&expressions[h], &|x: H| m.get(&x.index()).copied().unwrap_or(x))?
                    };
                    let new = expressions.append(e, Span::UNDEFINED);
                    map.insert(h.index(), new);
                }
                Statement::Emit(expressions.range_from(first))
            },
            Statement::Block(b) => Statement::Block(copy(b, expressions, map)?),
            Statement::If { condition, accept, reject } => {
                let condition = map.get(&condition.index()).copied().unwrap_or(*condition);
                Statement::If { condition, accept: copy(accept, expressions, map)?, reject: copy(reject, expressions, map)? }
            },
            Statement::Loop { body, continuing, break_if } => {
                let body = copy(body, expressions, map)?;
                let continuing = copy(continuing, expressions, map)?;
                let break_if = break_if.map(|h| map.get(&h.index()).copied().unwrap_or(h));
                Statement::Loop { body, continuing, break_if }
            },
            Statement::Switch { selector, cases } => {
                let selector = map.get(&selector.index()).copied().unwrap_or(*selector);
                let mut new_cases = Vec::new();
                for case in cases {
                    new_cases.push(naga::SwitchCase { value: case.value, body: copy(&case.body, expressions, map)?, fall_through: case.fall_through });
                }
                Statement::Switch { selector, cases: new_cases }
            },
            Statement::Call { function, arguments, result } => {
                let result = match result {
                    Some(r) => {
                        let new = expressions.append(Expression::CallResult(*function), Span::UNDEFINED);
                        map.insert(r.index(), new);
                        Some(new)
                    },
                    None => None,
                };
                let arguments = arguments.iter().map(|h| map.get(&h.index()).copied().unwrap_or(*h)).collect();
                Statement::Call { function: *function, arguments, result }
            },
            Statement::Atomic { result: Some(r), .. } => {
                let ty = match expressions[*r] {
                    Expression::AtomicResult { ty, comparison } => Expression::AtomicResult { ty, comparison },
                    _ => return None,
                };
                let new = expressions.append(ty, Span::UNDEFINED);
                map.insert(r.index(), new);
                let mut b = Block::from_vec(Vec::from([statement.clone()]));
                let m = &*map;
                if !crate::remap::remap_block(&mut b, &|x: H| m.get(&x.index()).copied().unwrap_or(x), &|r| r.clone()) {
                    return None;
                }
                b.span_into_iter().next().map(|(s, _)| s)?
            },
            other => {
                let mut b = Block::from_vec(Vec::from([other.clone()]));
                let m = &*map;
                if !crate::remap::remap_block(&mut b, &|x: H| m.get(&x.index()).copied().unwrap_or(x), &|r| r.clone()) {
                    return None;
                }
                b.span_into_iter().next().map(|(s, _)| s)?
            },
        };
        out.push(s);
    }
    Some(Block::from_vec(out))
}

/// The switches of a block (and those within), their falling cases closed
fn fix(block: &mut Block, expressions: &mut Arena<Expression>) -> bool {
    for statement in block.iter_mut() {
        let ok = match statement {
            Statement::Block(b) => fix(b, expressions),
            Statement::If { accept, reject, .. } => fix(accept, expressions) && fix(reject, expressions),
            Statement::Loop { body, continuing, .. } => fix(body, expressions) && fix(continuing, expressions),
            Statement::Switch { cases, .. } => {
                let mut ok = cases.iter_mut().all(|c| fix(&mut c.body, expressions));
                // from the last: a case falling into the next takes a copy of the next's statements
                for i in (0..cases.len()).rev() {
                    if !ok || !cases[i].fall_through || cases[i].body.is_empty() || i + 1 >= cases.len() {
                        continue;
                    }
                    let next = cases[i + 1].body.clone();
                    match copy(&next, expressions, &mut BTreeMap::new()) {
                        Some(copied) => {
                            let mut copied = copied;
                            cases[i].body.append(&mut copied);
                            cases[i].fall_through = cases[i + 1].fall_through;
                        },
                        None => ok = false,
                    }
                }
                ok
            },
            _ => true,
        };
        if !ok {
            return false;
        }
    }
    true
}

/// The module's falling switch cases closed (each function as it was where that cannot be done)
pub fn lower(module: &mut naga::Module) {
    let any = |b: &Block| format_has_fall_through(b);
    let handles: Vec<Handle<naga::Function>> = module.functions.iter().map(|(h, _)| h).collect();
    for h in handles {
        let f = &mut module.functions[h];
        if any(&f.body) {
            let mut copy = f.clone();
            if fix(&mut copy.body, &mut copy.expressions) {
                *f = copy;
            }
        }
    }
    for e in module.entry_points.iter_mut() {
        if any(&e.function.body) {
            let mut copy = e.function.clone();
            if fix(&mut copy.body, &mut copy.expressions) {
                e.function = copy;
            }
        }
    }
}

/// Whether a block has a case with statements that falls through
fn format_has_fall_through(block: &Block) -> bool {
    block.iter().any(|s| match s {
        Statement::Block(b) => format_has_fall_through(b),
        Statement::If { accept, reject, .. } => format_has_fall_through(accept) || format_has_fall_through(reject),
        Statement::Loop { body, continuing, .. } => format_has_fall_through(body) || format_has_fall_through(continuing),
        Statement::Switch { cases, .. } => cases.iter().any(|c| c.fall_through && !c.body.is_empty() || format_has_fall_through(&c.body)),
        _ => false,
    })
}
