//! The size of an array image with its layers: SPIR-V's OpImageQuerySize(Lod)
//! of one has the layer count as its last component, which naga's SPIR-V
//! front end leaves out (a 2D array's size comes out as 2 components where
//! the shader takes 3). Each such query becomes the vector of the size's
//! components and the image's `NumLayers`, in the query's own place (its
//! users unchanged), the new expressions put before it (remap.rs).
//!
//! And the layer of a sample of an array image: SPIR-V's is the coordinate's
//! last component rounded, floor(z + 0.5), naga's front end converts it to
//! an integer (truncating); the conversion gets floor(z + 0.5).

use alloc::vec::Vec;
use naga::{Expression, Function, Handle, ImageQuery, Scalar, Span, Type, TypeInner, VectorSize};

/// The array image type an image expression has, if it has one: (dimension's components)
fn arrayed(module: &naga::Module, function: &Function, image: Handle<Expression>) -> Option<u32> {
    let ty = match function.expressions[image] {
        Expression::GlobalVariable(g) => module.global_variables[g].ty,
        Expression::FunctionArgument(i) => function.arguments.get(i as usize)?.ty,
        _ => return None,
    };
    match module.types[ty].inner {
        TypeInner::Image { dim, arrayed: true, .. } => Some(match dim {
            naga::ImageDimension::D1 => 1,
            _ => 2,
        }),
        _ => None,
    }
}

fn fix(module: &mut naga::Module, function: &mut Function) {
    let queries: Vec<(Handle<Expression>, Handle<Expression>, Option<Handle<Expression>>, u32)> = function.expressions.iter()
        .filter_map(|(h, e)| match *e {
            Expression::ImageQuery { image, query: ImageQuery::Size { level } } => arrayed(module, function, image).map(|n| (h, image, level, n)),
            _ => None,
        })
        .collect();
    if queries.is_empty() {
        return;
    }
    let mut f = function.clone();
    let mut moves = Vec::new();
    for (q, image, level, n) in queries {
        let size = f.expressions.append(Expression::ImageQuery { image, query: ImageQuery::Size { level } }, Span::UNDEFINED);
        let mut components = Vec::new();
        moves.push((size, q));
        if n == 1 {
            components.push(size);
        }
        else {
            for i in 0..n {
                let c = f.expressions.append(Expression::AccessIndex { base: size, index: i }, Span::UNDEFINED);
                moves.push((c, q));
                components.push(c);
            }
        }
        let layers = f.expressions.append(Expression::ImageQuery { image, query: ImageQuery::NumLayers }, Span::UNDEFINED);
        moves.push((layers, q));
        components.push(layers);
        let size_n = if n == 1 { VectorSize::Bi } else { VectorSize::Tri };
        let ty = module.types.insert(Type { name: None, inner: TypeInner::Vector { size: size_n, scalar: Scalar::U32 } }, Span::UNDEFINED);
        f.expressions[q] = Expression::Compose { ty, components };
    }
    if crate::remap::place(&mut f, &moves) {
        *function = f;
    }
}

/// The function's samples' layers rounded (the layer naga converts with `As`)
fn round_layers(function: &mut Function) {
    let layers: Vec<(Handle<Expression>, Handle<Expression>, Handle<Expression>)> = function.expressions.iter().filter_map(|(_, e)| match *e {
        Expression::ImageSample { image, array_index: Some(index), .. } => match function.expressions[index] {
            Expression::As { expr, kind: naga::ScalarKind::Sint, convert: Some(4) } => Some((index, expr, image)),
            _ => None,
        },
        _ => None,
    }).collect();
    if layers.is_empty() {
        return;
    }
    let mut f = function.clone();
    let mut moves = Vec::new();
    let mut done = alloc::collections::BTreeSet::new();
    for (index, z, image) in layers {
        if !done.insert(index) {
            continue;
        }
        // (the literal before the image's expression: outside of every emit range)
        let half = f.expressions.append(Expression::Literal(naga::Literal::F32(0.5)), Span::UNDEFINED);
        moves.push((half, image));
        let sum = f.expressions.append(Expression::Binary { op: naga::BinaryOperator::Add, left: z, right: half }, Span::UNDEFINED);
        let floor = f.expressions.append(Expression::Math { fun: naga::MathFunction::Floor, arg: sum, arg1: None, arg2: None, arg3: None }, Span::UNDEFINED);
        moves.push((sum, index));
        moves.push((floor, index));
        f.expressions[index] = Expression::As { expr: floor, kind: naga::ScalarKind::Sint, convert: Some(4) };
    }
    if crate::remap::place(&mut f, &moves) {
        *function = f;
    }
}

/// Every function's queries of array images' sizes made whole, and its samples' layers rounded
pub fn lower(module: &mut naga::Module) {
    let handles: Vec<Handle<naga::Function>> = module.functions.iter().map(|(h, _)| h).collect();
    for h in handles {
        let mut f = core::mem::take(&mut module.functions[h]);
        fix(module, &mut f);
        round_layers(&mut f);
        module.functions[h] = f;
    }
    for e in 0..module.entry_points.len() {
        let mut f = core::mem::take(&mut module.entry_points[e].function);
        fix(module, &mut f);
        round_layers(&mut f);
        module.entry_points[e].function = f;
    }
}
