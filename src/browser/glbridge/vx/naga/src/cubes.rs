//! Samples of integer cube images (GLSL's `texture` of an isamplerCube or
//! usamplerCube): WGSL samples only float textures and loads from no cube,
//! so the image becomes a 2D array of its six faces (VX binds a `2d-array`
//! view of the cube for a binding of kind `texture-*-faces`) and each sample
//! a load of the texel the nearest filter takes in the face the direction
//! selects (Vulkan's cube map face selection: the largest magnitude, then
//! s = (sc / |ma| + 1) / 2, t = (tc / |ma| + 1) / 2), clamped to the face, at
//! an explicit lod's level, else 0. This runs after layers.rs (whose size
//! queries of arrays would take the faces for layers). Gathers, and images
//! a function receives as arguments, are left as they were.

use alloc::string::String;
use alloc::vec::Vec;
use naga::{BinaryOperator, Expression, Function, Handle, ImageClass, ImageDimension, ImageQuery, Literal, MathFunction, SampleLevel, Scalar, ScalarKind,
    Span, Type, TypeInner, UnaryOperator, VectorSize};

/// The name a cube made a 2D array gets (lib.rs's kind reads it)
pub const FACES: &str = "vx_faces";

type H = Handle<Expression>;

/// The integer cube image an expression is, if it is a global variable's
fn cube(module: &naga::Module, function: &Function, image: H) -> Option<Handle<naga::GlobalVariable>> {
    let Expression::GlobalVariable(g) = function.expressions[image] else { return None };
    match module.types[module.global_variables[g].ty].inner {
        TypeInner::Image { dim: ImageDimension::Cube, arrayed: false, class: ImageClass::Sampled { kind: ScalarKind::Sint | ScalarKind::Uint, multi: false } } => Some(g),
        _ => None,
    }
}

/// The function's samples of integer cubes made loads; the images it made faces
fn fix(module: &mut naga::Module, function: &mut Function, faces: &mut Vec<Handle<naga::GlobalVariable>>) {
    let samples: Vec<(H, H, H, SampleLevel, Handle<naga::GlobalVariable>)> = function.expressions.iter().filter_map(|(h, e)| match *e {
        Expression::ImageSample { image, coordinate, gather: None, array_index: None, depth_ref: None, level, .. } =>
            cube(module, function, image).map(|g| (h, image, coordinate, level, g)),
        _ => None,
    }).collect();
    if samples.is_empty() {
        return;
    }
    let vec2 = |module: &mut naga::Module, scalar: Scalar| module.types.insert(Type { name: None, inner: TypeInner::Vector { size: VectorSize::Bi, scalar } },
        Span::UNDEFINED);
    let vec2f = vec2(module, Scalar::F32);
    let mut f = function.clone();
    let mut moves = Vec::new();
    for &(h, image, c, level, g) in &samples {
        // (literals before the image's expression, outside of every emit range)
        let mut literal = |f: &mut Function, l: Literal| {
            let e = f.expressions.append(Expression::Literal(l), Span::UNDEFINED);
            moves.push((e, image));
            e
        };
        let zero = literal(&mut f, Literal::F32(0.0));
        let half = literal(&mut f, Literal::F32(0.5));
        let one = literal(&mut f, Literal::F32(1.0));
        let face_literals: Vec<H> = (0..6).map(|i| literal(&mut f, Literal::I32(i))).collect();
        let izero = face_literals[0];
        let ione = face_literals[1];
        let mut list = Vec::new();
        let mut add = |f: &mut Function, e: Expression| {
            let x = f.expressions.append(e, Span::UNDEFINED);
            list.push(x);
            x
        };
        let cx = add(&mut f, Expression::AccessIndex { base: c, index: 0 });
        let cy = add(&mut f, Expression::AccessIndex { base: c, index: 1 });
        let cz = add(&mut f, Expression::AccessIndex { base: c, index: 2 });
        let abs = |f: &mut Function, add: &mut dyn FnMut(&mut Function, Expression) -> H, x: H| add(f, Expression::Math { fun: MathFunction::Abs, arg: x, arg1: None, arg2: None, arg3: None });
        let ax = abs(&mut f, &mut add, cx);
        let ay = abs(&mut f, &mut add, cy);
        let az = abs(&mut f, &mut add, cz);
        let ge = |f: &mut Function, add: &mut dyn FnMut(&mut Function, Expression) -> H, l: H, r: H| add(f, Expression::Binary { op: BinaryOperator::GreaterEqual, left: l, right: r });
        let x_ge_y = ge(&mut f, &mut add, ax, ay);
        let x_ge_z = ge(&mut f, &mut add, ax, az);
        let y_ge_z = ge(&mut f, &mut add, ay, az);
        let x_major = add(&mut f, Expression::Binary { op: BinaryOperator::LogicalAnd, left: x_ge_y, right: x_ge_z });
        let not_x = add(&mut f, Expression::Unary { op: UnaryOperator::LogicalNot, expr: x_major });
        let y_major = add(&mut f, Expression::Binary { op: BinaryOperator::LogicalAnd, left: not_x, right: y_ge_z });
        let px = ge(&mut f, &mut add, cx, zero);
        let py = ge(&mut f, &mut add, cy, zero);
        let pz = ge(&mut f, &mut add, cz, zero);
        let select = |f: &mut Function, add: &mut dyn FnMut(&mut Function, Expression) -> H, condition: H, accept: H, reject: H|
            add(f, Expression::Select { condition, accept, reject });
        let negate = |f: &mut Function, add: &mut dyn FnMut(&mut Function, Expression) -> H, x: H| add(f, Expression::Unary { op: UnaryOperator::Negate, expr: x });
        // the face: +x 0, -x 1, +y 2, -y 3, +z 4, -z 5
        let fx = select(&mut f, &mut add, px, face_literals[0], face_literals[1]);
        let fy = select(&mut f, &mut add, py, face_literals[2], face_literals[3]);
        let fz = select(&mut f, &mut add, pz, face_literals[4], face_literals[5]);
        let fyz = select(&mut f, &mut add, y_major, fy, fz);
        let face = select(&mut f, &mut add, x_major, fx, fyz);
        // sc, tc and ma of each axis
        let ncx = negate(&mut f, &mut add, cx);
        let ncy = negate(&mut f, &mut add, cy);
        let ncz = negate(&mut f, &mut add, cz);
        let scx = select(&mut f, &mut add, px, ncz, cz);
        let scz = select(&mut f, &mut add, pz, cx, ncx);
        let tcy = select(&mut f, &mut add, py, cz, ncz);
        let syz = select(&mut f, &mut add, y_major, cx, scz);
        let sc = select(&mut f, &mut add, x_major, scx, syz);
        let tyz = select(&mut f, &mut add, y_major, tcy, ncy);
        let tc = select(&mut f, &mut add, x_major, ncy, tyz);
        let myz = select(&mut f, &mut add, y_major, ay, az);
        let ma = select(&mut f, &mut add, x_major, ax, myz);
        // the face's coordinates
        let st = add(&mut f, Expression::Compose { ty: vec2f, components: Vec::from([sc, tc]) });
        let ma2 = add(&mut f, Expression::Splat { size: VectorSize::Bi, value: ma });
        let ratio = add(&mut f, Expression::Binary { op: BinaryOperator::Divide, left: st, right: ma2 });
        let one2 = add(&mut f, Expression::Splat { size: VectorSize::Bi, value: one });
        let shifted = add(&mut f, Expression::Binary { op: BinaryOperator::Add, left: ratio, right: one2 });
        let half2 = add(&mut f, Expression::Splat { size: VectorSize::Bi, value: half });
        let uv = add(&mut f, Expression::Binary { op: BinaryOperator::Multiply, left: shifted, right: half2 });
        // the level, the texel
        let lod = match level {
            SampleLevel::Exact(l) => add(&mut f, Expression::As { expr: l, kind: ScalarKind::Sint, convert: Some(4) }),
            _ => izero,
        };
        let size = add(&mut f, Expression::ImageQuery { image, query: ImageQuery::Size { level: Some(lod) } });
        let sizef = add(&mut f, Expression::As { expr: size, kind: ScalarKind::Float, convert: Some(4) });
        let scaled = add(&mut f, Expression::Binary { op: BinaryOperator::Multiply, left: uv, right: sizef });
        let floor = add(&mut f, Expression::Math { fun: MathFunction::Floor, arg: scaled, arg1: None, arg2: None, arg3: None });
        let texel = add(&mut f, Expression::As { expr: floor, kind: ScalarKind::Sint, convert: Some(4) });
        let sizei = add(&mut f, Expression::As { expr: size, kind: ScalarKind::Sint, convert: Some(4) });
        let one_i = add(&mut f, Expression::Splat { size: VectorSize::Bi, value: ione });
        let last = add(&mut f, Expression::Binary { op: BinaryOperator::Subtract, left: sizei, right: one_i });
        let zero_i = add(&mut f, Expression::Splat { size: VectorSize::Bi, value: izero });
        let clamped = add(&mut f, Expression::Math { fun: MathFunction::Clamp, arg: texel, arg1: Some(zero_i), arg2: Some(last), arg3: None });
        for &x in &list {
            moves.push((x, h));
        }
        f.expressions[h] = Expression::ImageLoad { image, coordinate: clamped, array_index: Some(face), sample: None, level: Some(lod) };
        if !faces.contains(&g) {
            faces.push(g);
        }
    }
    if crate::remap::place(&mut f, &moves) {
        *function = f;
    }
    else {
        faces.retain(|g| !samples.iter().any(|s| s.4 == *g));
    }
}

/// The module's samples of integer cube images made loads from their faces
pub fn lower(module: &mut naga::Module) {
    let mut faces = Vec::new();
    let handles: Vec<Handle<Function>> = module.functions.iter().map(|(h, _)| h).collect();
    for h in handles {
        let mut f = core::mem::take(&mut module.functions[h]);
        fix(module, &mut f, &mut faces);
        module.functions[h] = f;
    }
    for e in 0..module.entry_points.len() {
        let mut f = core::mem::take(&mut module.entry_points[e].function);
        fix(module, &mut f, &mut faces);
        module.entry_points[e].function = f;
    }
    // the images: 2D arrays of the faces
    for g in faces {
        let TypeInner::Image { class, .. } = module.types[module.global_variables[g].ty].inner else { continue };
        let ty = module.types.insert(Type { name: None, inner: TypeInner::Image { dim: ImageDimension::D2, arrayed: true, class } }, Span::UNDEFINED);
        let var = &mut module.global_variables[g];
        var.ty = ty;
        var.name = Some(String::from(FACES));
    }
}
