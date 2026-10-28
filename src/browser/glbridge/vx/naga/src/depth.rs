//! Depth for what WebGPU's pipelines and viewports cannot do:
//! - a fragment shader writing depth in a pipeline with no depth attachment
//!   (Vulkan ignores the write, WebGPU refuses the pipeline): its FragDepth
//!   output dropped (`drop_frag_depth`);
//! - a viewport whose minDepth is greater than its maxDepth (GL's
//!   glDepthRangef(1, 0): Vulkan maps depth through it reversed, WebGPU's
//!   viewports cannot): the vertex shader's position z becomes w - z
//!   (`reverse_depth`) and VX swaps the viewport's depths, the same window
//!   depth;
//! - GL's clip space (the GLES host's shaders, docs/gles3-plan.md): depth
//!   from -w to w, WebGPU's from 0 to w: z becomes (z + w) / 2 (`gl_depth`).

use alloc::vec::Vec;
use naga::{Binding, BinaryOperator, Block, BuiltIn, Expression, Handle, ShaderStage, Span, Statement, Type, TypeInner};

/// The fragment entry points' FragDepth outputs dropped
pub fn drop_frag_depth(module: &mut naga::Module) {
    let frag_depth = |m: &naga::StructMember| matches!(m.binding, Some(Binding::BuiltIn(BuiltIn::FragDepth)));
    for ep in module.entry_points.iter_mut() {
        if ep.stage != ShaderStage::Fragment {
            continue;
        }
        let Some(result) = ep.function.result.clone() else { continue };
        if matches!(result.binding, Some(Binding::BuiltIn(BuiltIn::FragDepth))) {
            // (depth its only output: none)
            ep.function.result = None;
            none_returns(&mut ep.function.body);
            continue;
        }
        let (members, span) = match &module.types[result.ty].inner {
            TypeInner::Struct { members, span } => (members.clone(), *span),
            _ => continue,
        };
        let keep: Vec<bool> = members.iter().map(|m| !frag_depth(m)).collect();
        if keep.iter().all(|k| *k) {
            continue;
        }
        let kept = members.into_iter().zip(&keep).filter(|(_, k)| **k).map(|(m, _)| m).collect();
        let new = module.types.insert(Type { name: None, inner: TypeInner::Struct { members: kept, span } }, Span::UNDEFINED);
        crate::retype(&mut ep.function, result.ty, new, Some(&keep));
    }
}

fn none_returns(block: &mut Block) {
    for s in block.iter_mut() {
        match s {
            Statement::Return { value } => *value = None,
            Statement::Block(b) => none_returns(b),
            Statement::If { accept, reject, .. } => {
                none_returns(accept);
                none_returns(reject);
            },
            Statement::Loop { body, continuing, .. } => {
                none_returns(body);
                none_returns(continuing);
            },
            Statement::Switch { cases, .. } => cases.iter_mut().for_each(|c| none_returns(&mut c.body)),
            _ => {},
        }
    }
}

/// The vertex entry points' position z made w - z on return
pub fn reverse_depth(module: &mut naga::Module) {
    position_z(module, false);
}

/// The vertex entry points' position z made (z + w) / 2 on return (GL's clip space)
pub fn gl_depth(module: &mut naga::Module) {
    position_z(module, true);
}

fn position_z(module: &mut naga::Module, gl: bool) {
    for e in 0..module.entry_points.len() {
        if module.entry_points[e].stage != ShaderStage::Vertex {
            continue;
        }
        let Some(result) = module.entry_points[e].function.result.clone() else { continue };
        // (the position alone: the result itself, index usize::MAX)
        let (index, position_ty) = match module.types[result.ty].inner {
            TypeInner::Struct { ref members, .. } => {
                let Some(index) = members.iter().position(|m| matches!(m.binding, Some(Binding::BuiltIn(BuiltIn::Position { .. })))) else { continue };
                (index, members[index].ty)
            },
            _ if matches!(result.binding, Some(Binding::BuiltIn(BuiltIn::Position { .. }))) => (usize::MAX, result.ty),
            _ => continue,
        };
        let f = &mut module.entry_points[e].function;
        // (a literal is never emitted: before the returns' new expressions)
        let half = if gl { Some(f.expressions.append(Expression::Literal(naga::Literal::F32(0.5)), Span::UNDEFINED)) } else { None };
        reverse_returns(&mut f.body, &mut f.expressions, result.ty, index, position_ty, half);
    }
}

fn reverse_returns(block: &mut Block, expressions: &mut naga::Arena<Expression>, ty: Handle<Type>, index: usize, position_ty: Handle<Type>,
    half: Option<Handle<Expression>>) {
    let mut i = 0;
    while i < block.len() {
        let mut insert = None;
        match &mut block[i] {
            Statement::Return { value: Some(value) } => {
                // (naga's wrapper returns a compose of the outputs, or the position alone)
                let members = match expressions[*value] {
                    _ if index == usize::MAX => Vec::from([*value]),
                    Expression::Compose { ref components, .. } if components.len() > index => components.clone(),
                    _ => {
                        i += 1;
                        continue;
                    },
                };
                let first = expressions.len();
                let p = members[if index == usize::MAX { 0 } else { index }];
                let xyzw: Vec<Handle<Expression>> = (0..4).map(|k| expressions.append(Expression::AccessIndex { base: p, index: k }, Span::UNDEFINED)).collect();
                let z = match half {
                    Some(half) => {
                        let sum = expressions.append(Expression::Binary { op: BinaryOperator::Add, left: xyzw[2], right: xyzw[3] }, Span::UNDEFINED);
                        expressions.append(Expression::Binary { op: BinaryOperator::Multiply, left: sum, right: half }, Span::UNDEFINED)
                    },
                    None => expressions.append(Expression::Binary { op: BinaryOperator::Subtract, left: xyzw[3], right: xyzw[2] }, Span::UNDEFINED),
                };
                let reversed = expressions.append(Expression::Compose { ty: position_ty, components: Vec::from([xyzw[0], xyzw[1], z, xyzw[3]]) },
                    Span::UNDEFINED);
                if index == usize::MAX {
                    *value = reversed;
                } else {
                    let parts: Vec<Handle<Expression>> = members.iter().enumerate().map(|(m, &c)| if m == index { reversed } else { c }).collect();
                    *value = expressions.append(Expression::Compose { ty, components: parts }, Span::UNDEFINED);
                }
                insert = Some(Statement::Emit(expressions.range_from(first)));
            },
            Statement::Block(b) => reverse_returns(b, expressions, ty, index, position_ty, half),
            Statement::If { accept, reject, .. } => {
                reverse_returns(accept, expressions, ty, index, position_ty, half);
                reverse_returns(reject, expressions, ty, index, position_ty, half);
            },
            Statement::Loop { body, continuing, .. } => {
                reverse_returns(body, expressions, ty, index, position_ty, half);
                reverse_returns(continuing, expressions, ty, index, position_ty, half);
            },
            Statement::Switch { cases, .. } => {
                for case in cases.iter_mut() {
                    reverse_returns(&mut case.body, expressions, ty, index, position_ty, half);
                }
            },
            _ => {},
        }
        if let Some(emit) = insert {
            block.splice(i..i, Block::from_vec(Vec::from([emit])));
            i += 1;
        }
        i += 1;
    }
}

