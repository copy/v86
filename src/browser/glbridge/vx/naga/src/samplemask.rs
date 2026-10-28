//! GLSL's gl_SampleMaskIn and gl_SampleMask are arrays of int (one element
//! for up to 32 samples), WGSL's sample_mask a u32. naga's SPIR-V front end
//! keeps GLSL's type for the entry point's argument and result member, and
//! gives the output's private variable a u32 initializer (all samples):
//! the validator refuses both. Here the argument and the result member are
//! u32, bit casts of the private arrays' element 0, and the initializer an
//! array of all ones.

use alloc::vec::Vec;
use naga::{ArraySize, Binding, Block, BuiltIn, Expression, Handle, Literal, Scalar, ScalarKind, Span, Statement, Type, TypeInner};

fn is_mask(module: &naga::Module, ty: Handle<Type>) -> bool {
    match module.types[ty].inner {
        TypeInner::Array { base, size: ArraySize::Constant(n), .. } => n.get() == 1 && module.types[base].inner == TypeInner::Scalar(Scalar::I32),
        _ => false,
    }
}

pub fn lower(module: &mut naga::Module) {
    let masks: Vec<Handle<naga::GlobalVariable>> = module.global_variables.iter()
        .filter(|(_, v)| is_mask(module, v.ty) && v.init.is_some_and(|i| matches!(module.global_expressions[i], Expression::Literal(Literal::U32(_)))))
        .map(|(h, _)| h).collect();
    for h in masks {
        let ty = module.global_variables[h].ty;
        let one = module.global_expressions.append(Expression::Literal(Literal::I32(-1)), Span::UNDEFINED);
        let init = module.global_expressions.append(Expression::Compose { ty, components: Vec::from([one]) }, Span::UNDEFINED);
        module.global_variables[h].init = Some(init);
    }
    let u32_ty = module.types.insert(Type { name: None, inner: TypeInner::Scalar(Scalar::U32) }, Span::UNDEFINED);
    for e in 0..module.entry_points.len() {
        // the argument: its store into the private array a compose of its bit cast
        let arguments: Vec<(usize, Handle<Type>)> = module.entry_points[e].function.arguments.iter().enumerate()
            .filter(|(_, a)| matches!(a.binding, Some(Binding::BuiltIn(BuiltIn::SampleMask))) && is_mask(module, a.ty))
            .map(|(i, a)| (i, a.ty)).collect();
        for (index, array_ty) in arguments {
            let f = &mut module.entry_points[e].function;
            f.arguments[index].ty = u32_ty;
            let Some((argument, _)) = f.expressions.iter().find(|(_, x)| matches!(x, Expression::FunctionArgument(i) if *i as usize == index)) else { continue };
            let mut i = 0;
            while i < f.body.len() {
                if let Statement::Store { value, .. } = &mut f.body[i] {
                    if *value == argument {
                        let first = f.expressions.len();
                        let cast = f.expressions.append(Expression::As { expr: argument, kind: ScalarKind::Sint, convert: None }, Span::UNDEFINED);
                        *value = f.expressions.append(Expression::Compose { ty: array_ty, components: Vec::from([cast]) }, Span::UNDEFINED);
                        let emit = Statement::Emit(f.expressions.range_from(first));
                        f.body.splice(i..i, Block::from_vec(Vec::from([emit])));
                        i += 1;
                    }
                }
                i += 1;
            }
        }
        // the result's member: element 0 of the array the wrapper loads, bit cast
        let Some(result) = module.entry_points[e].function.result.clone() else { continue };
        let (members, span) = match &module.types[result.ty].inner {
            TypeInner::Struct { members, span } => (members.clone(), *span),
            _ => continue,
        };
        let Some(index) = members.iter().position(|m| matches!(m.binding, Some(Binding::BuiltIn(BuiltIn::SampleMask))) && is_mask(module, m.ty)) else { continue };
        // (a struct of its own: the wrapper's compose of the old one stays valid, unused)
        let mut changed = members.clone();
        changed[index].ty = u32_ty;
        let new_ty = module.types.insert(Type { name: None, inner: TypeInner::Struct { members: changed, span } }, Span::UNDEFINED);
        let f = &mut module.entry_points[e].function;
        f.result.as_mut().unwrap().ty = new_ty;
        returns(&mut f.body, &mut f.expressions, new_ty, index);
    }
}

fn returns(block: &mut Block, expressions: &mut naga::Arena<Expression>, ty: Handle<Type>, index: usize) {
    let mut i = 0;
    while i < block.len() {
        let mut insert = None;
        match &mut block[i] {
            Statement::Return { value: Some(value) } => {
                if let Expression::Compose { ref components, .. } = expressions[*value] {
                    if components.len() > index {
                        let mut parts = components.clone();
                        let first = expressions.len();
                        let element = expressions.append(Expression::AccessIndex { base: parts[index], index: 0 }, Span::UNDEFINED);
                        parts[index] = expressions.append(Expression::As { expr: element, kind: ScalarKind::Uint, convert: None }, Span::UNDEFINED);
                        *value = expressions.append(Expression::Compose { ty, components: parts }, Span::UNDEFINED);
                        insert = Some(Statement::Emit(expressions.range_from(first)));
                    }
                }
            },
            Statement::Block(b) => returns(b, expressions, ty, index),
            Statement::If { accept, reject, .. } => {
                returns(accept, expressions, ty, index);
                returns(reject, expressions, ty, index);
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
