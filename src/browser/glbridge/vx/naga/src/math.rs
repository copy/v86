//! Math naga reads from SPIR-V but cannot write as WGSL, or types wrongly:
//! - `outerProduct` (OpOuterProduct, naga's Math Outer, which WGSL has not):
//!   in its place the matrix of `a * b[i]` columns, the new expressions
//!   before it (remap.rs);
//! - modf's and frexp's results (GLSL.std.450's ModfStruct, FrexpStruct):
//!   their result structs registered as naga's special types, which its
//!   front end leaves out.

use alloc::vec::Vec;
use naga::{BinaryOperator, Expression, Function, Handle, MathFunction, Span, Type, TypeInner, VectorSize};

fn fix(module: &mut naga::Module, function: &mut Function) {
    let outers: Vec<(Handle<Expression>, Handle<Expression>, Handle<Expression>)> = function.expressions.iter().filter_map(|(h, e)| match *e {
        Expression::Math { fun: MathFunction::Outer, arg, arg1: Some(arg1), .. } => Some((h, arg, arg1)),
        _ => None,
    }).collect();
    if outers.is_empty() {
        return;
    }
    // the operands' sizes
    let mut typifier = naga::front::Typifier::new();
    let mut sizes = Vec::new();
    {
        let ctx = naga::proc::ResolveContext::with_locals(module, &function.local_variables, &function.arguments);
        for &(_, a, b) in &outers {
            if typifier.grow(a, &function.expressions, &ctx).is_err() || typifier.grow(b, &function.expressions, &ctx).is_err() {
                return;
            }
            let size = |inner: &TypeInner| match *inner {
                TypeInner::Vector { size, scalar } => Some((size, scalar)),
                _ => None,
            };
            let (Some((rows, scalar)), Some((columns, _))) = (size(typifier.get(a, &module.types)), size(typifier.get(b, &module.types))) else { return };
            sizes.push((rows, columns, scalar));
        }
    }
    let mut f = function.clone();
    let mut moves = Vec::new();
    for (&(h, a, b), &(rows, columns, scalar)) in outers.iter().zip(&sizes) {
        let ty = module.types.insert(Type { name: None, inner: TypeInner::Matrix { columns, rows, scalar } }, Span::UNDEFINED);
        let mut components = Vec::new();
        for i in 0..columns as u32 {
            let bi = f.expressions.append(Expression::AccessIndex { base: b, index: i }, Span::UNDEFINED);
            let column = f.expressions.append(Expression::Binary { op: BinaryOperator::Multiply, left: a, right: bi }, Span::UNDEFINED);
            moves.push((bi, h));
            moves.push((column, h));
            components.push(column);
        }
        f.expressions[h] = Expression::Compose { ty, components };
    }
    if crate::remap::place(&mut f, &moves) {
        *function = f;
    }
}

/// The module's outer products made matrices of columns, and modf's and frexp's result types registered
pub fn lower(module: &mut naga::Module) {
    let any = |f: &Function, which: &[MathFunction]| f.expressions.iter().any(|(_, e)| matches!(e, Expression::Math { fun, .. } if which.contains(fun)));
    let special = module.functions.iter().any(|(_, f)| any(f, &[MathFunction::Modf, MathFunction::Frexp]))
        || module.entry_points.iter().any(|e| any(&e.function, &[MathFunction::Modf, MathFunction::Frexp]));
    if special {
        for size in [None, Some(VectorSize::Bi), Some(VectorSize::Tri), Some(VectorSize::Quad)] {
            module.generate_predeclared_type(naga::PredeclaredType::ModfResult { size, scalar: naga::Scalar::F32 });
            module.generate_predeclared_type(naga::PredeclaredType::FrexpResult { size, scalar: naga::Scalar::F32 });
        }
    }
    let handles: Vec<Handle<Function>> = module.functions.iter().map(|(h, _)| h).collect();
    for h in handles {
        let mut f = core::mem::take(&mut module.functions[h]);
        fix(module, &mut f);
        module.functions[h] = f;
    }
    for e in 0..module.entry_points.len() {
        let mut f = core::mem::take(&mut module.entry_points[e].function);
        fix(module, &mut f);
        module.entry_points[e].function = f;
    }
}
