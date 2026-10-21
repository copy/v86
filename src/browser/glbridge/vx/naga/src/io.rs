//! Entry point inputs and outputs that WGSL cannot have at a location:
//! matrices, arrays and structs (a matrix vertex attribute, a matrix or
//! array varying, an array of fragment outputs). Each becomes its vectors
//! and scalars at consecutive locations in Vulkan's order (a matrix's
//! columns, an array's elements, a struct's members, one location each), so
//! a vertex shader's outputs still meet the fragment shader's inputs, and a
//! matrix attribute's columns are the pipeline's attributes at those
//! locations. The entry point (naga's wrapper of the SPIR-V's main) makes
//! the value of its inputs again, and takes its outputs apart on return. A
//! fragment shader's outputs of fewer than 4 components get the rest (0, and
//! 1 for alpha): WebGPU wants as many as the target has.

use alloc::string::String;
use alloc::vec::Vec;
use naga::{ArraySize, Binding, Block, Expression, Handle, Span, Statement, Type, TypeInner, VectorSize};

/// A type a location can have (a scalar or vector of 32 bits)
fn shareable(module: &naga::Module, ty: Handle<Type>) -> bool {
    match module.types[ty].inner {
        TypeInner::Scalar(s) | TypeInner::Vector { scalar: s, .. } => s.width == 4,
        _ => false,
    }
}

/// The vectors and scalars of a type, each with the indices that reach it
fn leaves(module: &mut naga::Module, ty: Handle<Type>, path: &mut Vec<u32>, out: &mut Vec<(Handle<Type>, Vec<u32>)>) -> bool {
    match module.types[ty].inner.clone() {
        TypeInner::Scalar(_) | TypeInner::Vector { .. } => {
            out.push((ty, path.clone()));
            true
        },
        TypeInner::Matrix { columns, rows, scalar } => {
            let column = module.types.insert(Type { name: None, inner: TypeInner::Vector { size: rows, scalar } }, Span::UNDEFINED);
            for c in 0..columns as u32 {
                path.push(c);
                out.push((column, path.clone()));
                path.pop();
            }
            true
        },
        TypeInner::Array { base, size: ArraySize::Constant(n), .. } => {
            for i in 0..n.get() {
                path.push(i);
                let ok = leaves(module, base, path, out);
                path.pop();
                if !ok {
                    return false;
                }
            }
            true
        },
        TypeInner::Struct { members, .. } => {
            for (i, m) in members.iter().enumerate() {
                path.push(i as u32);
                let ok = leaves(module, m.ty, path, out);
                path.pop();
                if !ok {
                    return false;
                }
            }
            true
        },
        _ => false,
    }
}

/// The binding of a leaf `k` locations after `binding`; for a varying
/// (`varying`: a vertex output, a fragment input), an integer leaf's is flat
/// (a struct's or array's of mixed kinds had the first member's), and a
/// leaf without one gets naga's default (naga gives none to the types it
/// cannot pass)
fn shifted(module: &naga::Module, binding: &Binding, k: u32, ty: Handle<Type>, varying: bool) -> Binding {
    match binding.clone() {
        Binding::Location { location, interpolation, sampling, blend_src, per_primitive } => {
            let integer = matches!(module.types[ty].inner.scalar_kind(), Some(naga::ScalarKind::Sint | naga::ScalarKind::Uint));
            let (interpolation, sampling) = if !varying {
                (interpolation, sampling)
            }
            else if integer {
                (Some(naga::Interpolation::Flat), None)
            }
            else if interpolation.is_none() {
                (Some(naga::Interpolation::Perspective), Some(naga::Sampling::Center))
            }
            else {
                (interpolation, sampling)
            };
            Binding::Location { location: location + k, interpolation, sampling, blend_src, per_primitive }
        },
        b => b,
    }
}

/// The value of type `ty` made of leaf expressions (by path), the composes appended
fn compose(module: &naga::Module, f: &mut naga::Function, ty: Handle<Type>, path: &mut Vec<u32>, leaf: &dyn Fn(&[u32]) -> Option<Handle<Expression>>)
    -> Option<Handle<Expression>> {
    if let Some(h) = leaf(path) {
        return Some(h);
    }
    let count = match module.types[ty].inner {
        TypeInner::Matrix { columns, .. } => columns as u32,
        TypeInner::Array { size: ArraySize::Constant(n), .. } => n.get(),
        TypeInner::Struct { ref members, .. } => members.len() as u32,
        _ => return None,
    };
    let mut components = Vec::new();
    for i in 0..count {
        let inner = match module.types[ty].inner {
            TypeInner::Matrix { rows, scalar, .. } => module.types.get(&Type { name: None, inner: TypeInner::Vector { size: rows, scalar } })?,
            TypeInner::Array { base, .. } => base,
            TypeInner::Struct { ref members, .. } => members[i as usize].ty,
            _ => return None,
        };
        path.push(i);
        let c = compose(module, f, inner, path, leaf);
        path.pop();
        components.push(c?);
    }
    Some(f.expressions.append(Expression::Compose { ty, components }, Span::UNDEFINED))
}

/// Uses of expression `from` in a block's statements made uses of `to`; false where another kind of use is met
fn replace_uses(block: &mut Block, from: Handle<Expression>, to: Handle<Expression>) -> bool {
    let swap = |h: &mut Handle<Expression>| {
        if *h == from {
            *h = to;
        }
    };
    for statement in block.iter_mut() {
        match statement {
            Statement::Store { pointer, value } => {
                if *pointer == from {
                    return false;
                }
                swap(value);
            },
            Statement::Return { value: Some(v) } => swap(v),
            Statement::Call { arguments, .. } => arguments.iter_mut().for_each(swap),
            Statement::Block(b) => {
                if !replace_uses(b, from, to) {
                    return false;
                }
            },
            Statement::If { condition, accept, reject } => {
                if *condition == from || !replace_uses(accept, from, to) || !replace_uses(reject, from, to) {
                    return false;
                }
            },
            Statement::Loop { body, continuing, .. } => {
                if !replace_uses(body, from, to) || !replace_uses(continuing, from, to) {
                    return false;
                }
            },
            Statement::Emit(_) | Statement::Return { value: None } | Statement::Kill | Statement::Break | Statement::Continue => {},
            _ => {},
        }
    }
    true
}

/// The entry points' inputs and outputs of those types, flattened
pub fn flatten(module: &mut naga::Module) -> Result<(), String> {
    for e in 0..module.entry_points.len() {
        flatten_inputs(module, e)?;
        flatten_outputs(module, e)?;
    }
    // the structs the entry points had (naga's WGSL writer writes every
    // struct, and WGSL refuses a location on a matrix or an array): their
    // members of such types unbound
    let unbind: Vec<Handle<Type>> = module.types.iter().filter(|(_, ty)| match &ty.inner {
        TypeInner::Struct { members, .. } => members.iter().any(|m| matches!(m.binding, Some(Binding::Location { .. })) && !shareable(module, m.ty)),
        _ => false,
    }).map(|(handle, _)| handle).collect();
    for handle in unbind {
        let mut ty = module.types[handle].clone();
        if let TypeInner::Struct { members, .. } = &mut ty.inner {
            for m in members.iter_mut() {
                if matches!(m.binding, Some(Binding::Location { .. })) && !shareable(module, m.ty) {
                    m.binding = None;
                }
            }
        }
        module.types.replace(handle, ty);
    }
    Ok(())
}

fn flatten_inputs(module: &mut naga::Module, e: usize) -> Result<(), String> {
    let count = module.entry_points[e].function.arguments.len();
    let fragment = module.entry_points[e].stage == naga::ShaderStage::Fragment;
    for a in 0..count {
        let argument = module.entry_points[e].function.arguments[a].clone();
        let Some(binding @ Binding::Location { .. }) = argument.binding.clone() else { continue };
        if shareable(module, argument.ty) {
            continue;
        }
        let mut list = Vec::new();
        if !leaves(module, argument.ty, &mut Vec::new(), &mut list) || list.is_empty() {
            return Err(String::from("an input of a type not done"));
        }
        // (the function out of the module while it changes)
        let mut function = core::mem::take(&mut module.entry_points[e].function);
        let f = &mut function;
        // the argument becomes the first leaf, the others are appended
        let mut leaf_arguments = Vec::new();
        for (k, (ty, _)) in list.iter().enumerate() {
            let index = if k == 0 {
                f.arguments[a].ty = *ty;
                f.arguments[a].binding = Some(shifted(module, &binding, 0, *ty, fragment));
                a
            }
            else {
                f.arguments.push(naga::FunctionArgument { name: None, ty: *ty, binding: Some(shifted(module, &binding, k as u32, *ty, fragment)) });
                f.arguments.len() - 1
            };
            leaf_arguments.push(f.expressions.append(Expression::FunctionArgument(index as u32), Span::UNDEFINED));
        }
        let olds: Vec<Handle<Expression>> = f.expressions.iter()
            .filter(|(h, x)| matches!(x, Expression::FunctionArgument(i) if *i as usize == a) && !leaf_arguments.contains(h))
            .map(|(h, _)| h).collect();
        let first = f.expressions.len();
        let by_path = |path: &[u32]| list.iter().position(|(_, p)| p.as_slice() == path).map(|k| leaf_arguments[k]);
        let value = compose(module, f, argument.ty, &mut Vec::new(), &by_path);
        let value = match value {
            Some(v) => v,
            None => {
                module.entry_points[e].function = function;
                return Err(String::from("an input's value"));
            },
        };
        // (no expression may use the old argument: the wrapper only stores it)
        let used = f.expressions.iter().any(|(h, x)| h.index() < first && matches!(x,
            Expression::AccessIndex { base, .. } | Expression::Access { base, .. } if olds.contains(base)));
        if used {
            module.entry_points[e].function = function;
            return Err(String::from("an input used other than stored"));
        }
        for &old in &olds {
            if !replace_uses(&mut f.body, old, value) {
                module.entry_points[e].function = function;
                return Err(String::from("an input used other than stored"));
            }
        }
        if f.expressions.len() > first {
            let range = f.expressions.range_from(first);
            f.body.splice(0..0, Block::from_vec(Vec::from([Statement::Emit(range)])));
        }
        module.entry_points[e].function = function;
    }
    Ok(())
}

fn flatten_outputs(module: &mut naga::Module, e: usize) -> Result<(), String> {
    let Some(result) = module.entry_points[e].function.result.clone() else { return Ok(()) };
    // the members (or the one value) at a location of a type not shareable
    let members: Vec<naga::StructMember> = match module.types[result.ty].inner {
        TypeInner::Struct { ref members, .. } => members.clone(),
        _ => match result.binding {
            Some(ref b @ Binding::Location { .. }) => Vec::from([naga::StructMember { name: None, ty: result.ty, binding: Some(b.clone()), offset: 0 }]),
            _ => return Ok(()),
        },
    };
    let single = !matches!(module.types[result.ty].inner, TypeInner::Struct { .. });
    let fragment = module.entry_points[e].stage == naga::ShaderStage::Fragment;
    let flatten_member = |module: &naga::Module, m: &naga::StructMember| matches!(m.binding, Some(Binding::Location { .. })) && !shareable(module, m.ty);
    // (a fragment output of fewer than 4 components: WebGPU wants as many as the target has, Vulkan leaves the rest undefined)
    let narrow = |module: &naga::Module, ty: Handle<Type>| -> Option<(naga::Scalar, u32)> {
        match module.types[ty].inner {
            TypeInner::Scalar(s) if fragment => Some((s, 1)),
            TypeInner::Vector { size, scalar } if fragment && (size as u32) < 4 => Some((scalar, size as u32)),
            _ => None,
        }
    };
    if !members.iter().any(|m| flatten_member(module, m) || matches!(m.binding, Some(Binding::Location { .. })) && narrow(module, m.ty).is_some()) {
        return Ok(());
    }
    // the new members: (member, leaf path, widened from) each
    let mut new_members = Vec::new();
    let mut sources: Vec<Source> = Vec::new();
    for (i, m) in members.iter().enumerate() {
        let binding = m.binding.clone();
        let mut list = Vec::new();
        if flatten_member(module, m) {
            if !leaves(module, m.ty, &mut Vec::new(), &mut list) {
                return Err(String::from("an output of a type not done"));
            }
        }
        else {
            list.push((m.ty, Vec::new()));
        }
        for (k, (ty, path)) in list.into_iter().enumerate() {
            let at = |module: &naga::Module, b: &Option<Binding>, ty: Handle<Type>| b.as_ref().map(|b| shifted(module, b, k as u32, ty, !fragment));
            let located = matches!(binding, Some(Binding::Location { .. }));
            match narrow(module, ty).filter(|_| located) {
                Some((scalar, count)) => {
                    let wide = module.types.insert(Type { name: None, inner: TypeInner::Vector { size: VectorSize::Quad, scalar } }, Span::UNDEFINED);
                    new_members.push(naga::StructMember { name: m.name.clone(), ty: wide, binding: at(module, &binding, wide), offset: 0 });
                    sources.push(Source { member: i, path, widen: Some((scalar, count, wide)) });
                },
                None => {
                    new_members.push(naga::StructMember { name: m.name.clone(), ty, binding: at(module, &binding, ty), offset: 0 });
                    sources.push(Source { member: i, path, widen: None });
                },
            }
        }
    }
    // their offsets (an output struct's layout is its own)
    let mut layouter = naga::proc::Layouter::default();
    layouter.update(module.to_ctx()).map_err(|_| String::from("layout"))?;
    let mut offset = 0;
    let mut alignment = naga::proc::Alignment::ONE;
    for m in new_members.iter_mut() {
        let layout = layouter[m.ty];
        offset = layout.alignment.round_up(offset);
        m.offset = offset;
        offset += layout.size;
        alignment = alignment.max(layout.alignment);
    }
    let span = alignment.round_up(offset);
    let new_ty = module.types.insert(Type { name: None, inner: TypeInner::Struct { members: new_members, span } }, Span::UNDEFINED);
    let f = &mut module.entry_points[e].function;
    f.result = Some(naga::FunctionResult { ty: new_ty, binding: None });
    rewrite_returns(&mut f.body, &mut f.expressions, &sources, single, new_ty);
    Ok(())
}

/// A member of the new outputs: the original member, the path to its leaf,
/// and, for one widened to 4 components, its scalar, its components and
/// the vector type
struct Source {
    member: usize,
    path: Vec<u32>,
    widen: Option<(naga::Scalar, u32, Handle<Type>)>,
}

/// A literal of a scalar kind: 0, or 1 for the alpha
fn literal(scalar: naga::Scalar, one: bool) -> naga::Literal {
    match scalar.kind {
        naga::ScalarKind::Sint => naga::Literal::I32(one as i32),
        naga::ScalarKind::Uint => naga::Literal::U32(one as u32),
        naga::ScalarKind::Bool => naga::Literal::Bool(one),
        _ => naga::Literal::F32(if one { 1.0 } else { 0.0 }),
    }
}

/// Each return's value taken apart into the new struct's members
fn rewrite_returns(block: &mut Block, expressions: &mut naga::Arena<Expression>, sources: &[Source], single: bool, ty: Handle<Type>) {
    let mut i = 0;
    while i < block.len() {
        let mut insert = None;
        match &mut block[i] {
            Statement::Return { value: Some(value) } => {
                // (the literals of widened members first: they are not emitted)
                let mut pads = Vec::new();
                for source in sources {
                    if let Some((scalar, count, _)) = source.widen {
                        let pad: Vec<Handle<Expression>> = (count..4).map(|c| expressions.append(Expression::Literal(literal(scalar, c == 3)), Span::UNDEFINED)).collect();
                        pads.push(pad);
                    }
                    else {
                        pads.push(Vec::new());
                    }
                }
                let first = expressions.len();
                let v = *value;
                // the original members' values: the compose's components, or indexed
                let components: Option<Vec<Handle<Expression>>> = match expressions[v] {
                    Expression::Compose { ref components, .. } if !single => Some(components.clone()),
                    _ => None,
                };
                let member = |expressions: &mut naga::Arena<Expression>, m: usize| -> Handle<Expression> {
                    if single {
                        return v;
                    }
                    match &components {
                        Some(c) => c[m],
                        None => expressions.append(Expression::AccessIndex { base: v, index: m as u32 }, Span::UNDEFINED),
                    }
                };
                let mut parts = Vec::new();
                for (source, pad) in sources.iter().zip(&pads) {
                    let mut h = member(expressions, source.member);
                    for &index in &source.path {
                        h = expressions.append(Expression::AccessIndex { base: h, index }, Span::UNDEFINED);
                    }
                    if let Some((_, _, wide)) = source.widen {
                        let mut components = Vec::from([h]);
                        components.extend(pad.iter().copied());
                        h = expressions.append(Expression::Compose { ty: wide, components }, Span::UNDEFINED);
                    }
                    parts.push(h);
                }
                let new_value = expressions.append(Expression::Compose { ty, components: parts }, Span::UNDEFINED);
                *value = new_value;
                insert = Some(Statement::Emit(expressions.range_from(first)));
            },
            Statement::Block(b) => rewrite_returns(b, expressions, sources, single, ty),
            Statement::If { accept, reject, .. } => {
                rewrite_returns(accept, expressions, sources, single, ty);
                rewrite_returns(reject, expressions, sources, single, ty);
            },
            Statement::Loop { body, continuing, .. } => {
                rewrite_returns(body, expressions, sources, single, ty);
                rewrite_returns(continuing, expressions, sources, single, ty);
            },
            Statement::Switch { cases, .. } => {
                for case in cases.iter_mut() {
                    rewrite_returns(&mut case.body, expressions, sources, single, ty);
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
