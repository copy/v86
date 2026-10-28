//! Math naga reads from SPIR-V but cannot write as WGSL, or types wrongly:
//! - `outerProduct` (OpOuterProduct, naga's Math Outer, which WGSL has not):
//!   in its place the matrix of `a * b[i]` columns, the new expressions
//!   before it (remap.rs);
//! - modf's and frexp's results (GLSL.std.450's ModfStruct, FrexpStruct):
//!   their result structs registered as naga's special types, which its
//!   front end leaves out;
//! - normalize, reflect, refract and faceforward of scalars (GLSL has
//!   them, WGSL only of vectors): of `vec2(x, 0)` each, their `.x`;
//! - atan2 and tanh where Chrome's Metal compiler gets them wrong
//!   (dEQP-GLES3 builtin_functions.precision): `atan(y, x)` of x == 0 is
//!   the opposite of its sign there, so it is `sign(y) * π/2`; `tanh(x)`
//!   of |x| past 10 is NaN there, so it is `sign(x)` (1 to within a float
//!   from 9 on).

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

/// Normalize, Reflect, Refract and FaceForward of scalars as of 2-vectors with a 0 second component
fn scalars(module: &mut naga::Module, function: &mut Function) {
    const VECTOR_ONLY: [MathFunction; 4] = [MathFunction::Normalize, MathFunction::Reflect, MathFunction::Refract, MathFunction::FaceForward];
    let found: Vec<(Handle<Expression>, MathFunction, Handle<Expression>, Option<Handle<Expression>>, Option<Handle<Expression>>)> =
        function.expressions.iter().filter_map(|(h, e)| match *e {
            Expression::Math { fun, arg, arg1, arg2, .. } if VECTOR_ONLY.contains(&fun) => Some((h, fun, arg, arg1, arg2)),
            _ => None,
        }).collect();
    if found.is_empty() {
        return;
    }
    // (each expression's type on its own: naga's typifier stops at the first it
    // cannot resolve, which is the very scalar normalize this is for)
    let mut resolutions: Vec<Option<naga::proc::TypeResolution>> = Vec::new();
    {
        let ctx = naga::proc::ResolveContext::with_locals(module, &function.local_variables, &function.arguments);
        for (_, e) in function.expressions.iter() {
            let r = ctx.resolve(e, |p| resolutions[p.index()].as_ref().ok_or(naga::proc::ResolveError::InvalidAccess { expr: p, indexed: false }));
            resolutions.push(r.ok());
        }
    }
    let scalar_of: Vec<Option<naga::Scalar>> = found.iter().map(|&(_, _, arg, _, _)| match resolutions[arg.index()] {
        Some(ref r) => match *r.inner_with(&module.types) { TypeInner::Scalar(s) => Some(s), _ => None },
        None => None,
    }).collect();
    if scalar_of.iter().all(|s| s.is_none()) {
        return;
    }
    // (the literals before an expression that no emit range holds)
    let Some((first, _)) = function.expressions.iter().find(|(_, e)| matches!(e, Expression::Literal(_) | Expression::Constant(_)
        | Expression::GlobalVariable(_) | Expression::FunctionArgument(_) | Expression::LocalVariable(_) | Expression::ZeroValue(_))) else { return };
    let mut f = function.clone();
    let mut moves = Vec::new();
    for (&(h, fun, arg, arg1, arg2), scalar) in found.iter().zip(&scalar_of) {
        let Some(scalar) = *scalar else { continue };
        let ty = module.types.insert(Type { name: None, inner: TypeInner::Vector { size: VectorSize::Bi, scalar } }, Span::UNDEFINED);
        let zero = f.expressions.append(Expression::Literal(naga::Literal::F32(0.0)), Span::UNDEFINED);
        moves.push((zero, first));
        let mut wrap = |x: Handle<Expression>| {
            let c = f.expressions.append(Expression::Compose { ty, components: alloc::vec![x, zero] }, Span::UNDEFINED);
            moves.push((c, h));
            c
        };
        let (a, a1, a2) = match fun {
            MathFunction::Normalize => (wrap(arg), None, None),
            MathFunction::Reflect => (wrap(arg), arg1.map(&mut wrap), None),
            MathFunction::Refract => (wrap(arg), arg1.map(&mut wrap), arg2),
            _ => (wrap(arg), arg1.map(&mut wrap), arg2.map(&mut wrap)),
        };
        let math = f.expressions.append(Expression::Math { fun, arg: a, arg1: a1, arg2: a2, arg3: None }, Span::UNDEFINED);
        moves.push((math, h));
        f.expressions[h] = Expression::AccessIndex { base: math, index: 0 };
    }
    if crate::remap::place(&mut f, &moves) {
        *function = f;
    }
}

/// atan2 at x == 0 and tanh past |x| = 10 given their values there (atan2's
/// comparison of the operand's own shape, `x == x - x`; tanh's with 10 splat
/// to the operand's size)
fn guards(module: &naga::Module, function: &mut Function) {
    let found: Vec<(Handle<Expression>, MathFunction, Handle<Expression>, Option<Handle<Expression>>)> = function.expressions.iter().filter_map(|(h, e)| match *e {
        Expression::Math { fun: fun @ (MathFunction::Atan2 | MathFunction::Tanh), arg, arg1, .. } => Some((h, fun, arg, arg1)),
        _ => None,
    }).collect();
    if found.is_empty() {
        return;
    }
    let Some((first, _)) = function.expressions.iter().find(|(_, e)| matches!(e, Expression::Literal(_) | Expression::Constant(_)
        | Expression::GlobalVariable(_) | Expression::FunctionArgument(_) | Expression::LocalVariable(_) | Expression::ZeroValue(_))) else { return };
    // (each tanh operand's vector size, None for a scalar's)
    let mut resolutions: Vec<Option<naga::proc::TypeResolution>> = Vec::new();
    {
        let ctx = naga::proc::ResolveContext::with_locals(module, &function.local_variables, &function.arguments);
        for (_, e) in function.expressions.iter() {
            let r = ctx.resolve(e, |p| resolutions[p.index()].as_ref().ok_or(naga::proc::ResolveError::InvalidAccess { expr: p, indexed: false }));
            resolutions.push(r.ok());
        }
    }
    let size_of = |h: Handle<Expression>| -> Option<Option<VectorSize>> {
        match *resolutions[h.index()].as_ref()?.inner_with(&module.types) {
            TypeInner::Scalar(_) => Some(None),
            TypeInner::Vector { size, .. } => Some(Some(size)),
            _ => None,
        }
    };
    let mut f = function.clone();
    let mut moves: Vec<(Handle<Expression>, Handle<Expression>)> = Vec::new();
    // (literals with the others, before any emit range; the rest just before the expression they replace)
    let add = |f: &mut Function, moves: &mut Vec<(Handle<Expression>, Handle<Expression>)>, e: Expression, before: Handle<Expression>| {
        let id = f.expressions.append(e, Span::UNDEFINED);
        moves.push((id, before));
        id
    };
    let math = |fun, arg, arg1| Expression::Math { fun, arg, arg1, arg2: None, arg3: None };
    let literal = |v: f32| Expression::Literal(naga::Literal::F32(v));
    for &(h, fun, arg, arg1) in &found {
        let (condition, accept, reject) = if fun == MathFunction::Atan2 {
            let Some(x) = arg1 else { continue };
            let half_pi = add(&mut f, &mut moves, literal(core::f32::consts::FRAC_PI_2), first);
            let original = add(&mut f, &mut moves, math(MathFunction::Atan2, arg, Some(x)), h);
            let zero = add(&mut f, &mut moves, Expression::Binary { op: BinaryOperator::Subtract, left: x, right: x }, h);
            let at_zero = add(&mut f, &mut moves, Expression::Binary { op: BinaryOperator::Equal, left: x, right: zero }, h);
            let sign = add(&mut f, &mut moves, math(MathFunction::Sign, arg, None), h);
            let axis = add(&mut f, &mut moves, Expression::Binary { op: BinaryOperator::Multiply, left: sign, right: half_pi }, h);
            (at_zero, axis, original)
        } else {
            let Some(size) = size_of(arg) else { continue };
            let ten = add(&mut f, &mut moves, literal(10.0), first);
            let original = add(&mut f, &mut moves, math(MathFunction::Tanh, arg, None), h);
            let magnitude = add(&mut f, &mut moves, math(MathFunction::Abs, arg, None), h);
            let tens = match size {
                Some(size) => add(&mut f, &mut moves, Expression::Splat { size, value: ten }, h),
                None => ten,
            };
            let past = add(&mut f, &mut moves, Expression::Binary { op: BinaryOperator::Greater, left: magnitude, right: tens }, h);
            let sign = add(&mut f, &mut moves, math(MathFunction::Sign, arg, None), h);
            (past, sign, original)
        };
        f.expressions[h] = Expression::Select { condition, accept, reject };
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
        scalars(module, &mut f);
        guards(module, &mut f);
        module.functions[h] = f;
    }
    for e in 0..module.entry_points.len() {
        let mut f = core::mem::take(&mut module.entry_points[e].function);
        fix(module, &mut f);
        scalars(module, &mut f);
        guards(module, &mut f);
        module.entry_points[e].function = f;
    }
}

