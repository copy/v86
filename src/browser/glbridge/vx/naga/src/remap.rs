//! New expressions of a function put before the ones that use them: naga
//! wants an expression's operands before it, so a pass that replaces an
//! expression with a new one made of others (appended at the arena's end)
//! has the arena made again, each appended expression moved before the
//! expression it names, every handle (in the expressions, the statements,
//! the emit ranges, the named expressions and local variables' initializers)
//! remapped. An appended expression is emitted with the one it goes before.
//! Kinds of expressions and statements graphics shaders do not have (ray
//! queries, subgroups, cooperative matrices) leave the function as it was.

use alloc::collections::BTreeMap;
use alloc::vec::Vec;
use naga::{Arena, Block, Expression, Function, Handle, SampleLevel, Statement};

type H = Handle<Expression>;

/// The handles an expression uses, remapped by `f`; None for a kind not done here
pub(crate) fn remap_expression(e: &Expression, f: &dyn Fn(H) -> H) -> Option<Expression> {
    use Expression as E;
    let o = |h: &Option<H>| h.map(|h| f(h));
    Some(match e {
        E::Literal(_) | E::Constant(_) | E::Override(_) | E::ZeroValue(_) | E::FunctionArgument(_) | E::GlobalVariable(_) | E::LocalVariable(_)
        | E::CallResult(_) | E::AtomicResult { .. } | E::WorkGroupUniformLoadResult { .. } => e.clone(),
        E::Compose { ty, components } => E::Compose { ty: *ty, components: components.iter().map(|&h| f(h)).collect() },
        E::Access { base, index } => E::Access { base: f(*base), index: f(*index) },
        E::AccessIndex { base, index } => E::AccessIndex { base: f(*base), index: *index },
        E::Splat { size, value } => E::Splat { size: *size, value: f(*value) },
        E::Swizzle { size, vector, pattern } => E::Swizzle { size: *size, vector: f(*vector), pattern: *pattern },
        E::Load { pointer } => E::Load { pointer: f(*pointer) },
        E::ImageSample { image, sampler, gather, coordinate, array_index, offset, level, depth_ref, clamp_to_edge } => E::ImageSample {
            image: f(*image),
            sampler: f(*sampler),
            gather: *gather,
            coordinate: f(*coordinate),
            array_index: o(array_index),
            offset: o(offset),
            level: match *level {
                SampleLevel::Auto => SampleLevel::Auto,
                SampleLevel::Zero => SampleLevel::Zero,
                SampleLevel::Exact(h) => SampleLevel::Exact(f(h)),
                SampleLevel::Bias(h) => SampleLevel::Bias(f(h)),
                SampleLevel::Gradient { x, y } => SampleLevel::Gradient { x: f(x), y: f(y) },
            },
            depth_ref: o(depth_ref),
            clamp_to_edge: *clamp_to_edge,
        },
        E::ImageLoad { image, coordinate, array_index, sample, level } => E::ImageLoad {
            image: f(*image),
            coordinate: f(*coordinate),
            array_index: o(array_index),
            sample: o(sample),
            level: o(level),
        },
        E::ImageQuery { image, query } => E::ImageQuery {
            image: f(*image),
            query: match *query {
                naga::ImageQuery::Size { level } => naga::ImageQuery::Size { level: level.map(|h| f(h)) },
                q => q,
            },
        },
        E::Unary { op, expr } => E::Unary { op: *op, expr: f(*expr) },
        E::Binary { op, left, right } => E::Binary { op: *op, left: f(*left), right: f(*right) },
        E::Select { condition, accept, reject } => E::Select { condition: f(*condition), accept: f(*accept), reject: f(*reject) },
        E::Derivative { axis, ctrl, expr } => E::Derivative { axis: *axis, ctrl: *ctrl, expr: f(*expr) },
        E::Relational { fun, argument } => E::Relational { fun: *fun, argument: f(*argument) },
        E::Math { fun, arg, arg1, arg2, arg3 } => E::Math { fun: *fun, arg: f(*arg), arg1: o(arg1), arg2: o(arg2), arg3: o(arg3) },
        E::As { expr, kind, convert } => E::As { expr: f(*expr), kind: *kind, convert: *convert },
        E::ArrayLength(h) => E::ArrayLength(f(*h)),
        _ => return None,
    })
}

/// A block's statements with their handles remapped (emit ranges by `range`); false for a kind not done here
pub(crate) fn remap_block(block: &mut Block, f: &dyn Fn(H) -> H, range: &dyn Fn(&naga::Range<Expression>) -> naga::Range<Expression>) -> bool {
    use Statement as S;
    for s in block.iter_mut() {
        let ok = match s {
            S::Emit(r) => {
                *r = range(r);
                true
            },
            S::Block(b) => remap_block(b, f, range),
            S::If { condition, accept, reject } => {
                *condition = f(*condition);
                remap_block(accept, f, range) && remap_block(reject, f, range)
            },
            S::Switch { selector, cases } => {
                *selector = f(*selector);
                cases.iter_mut().all(|c| remap_block(&mut c.body, f, range))
            },
            S::Loop { body, continuing, break_if } => {
                *break_if = break_if.map(|h| f(h));
                remap_block(body, f, range) && remap_block(continuing, f, range)
            },
            S::Break | S::Continue | S::Kill | S::ControlBarrier(_) | S::MemoryBarrier(_) => true,
            S::Return { value } => {
                *value = value.map(|h| f(h));
                true
            },
            S::Store { pointer, value } => {
                *pointer = f(*pointer);
                *value = f(*value);
                true
            },
            S::ImageStore { image, coordinate, array_index, value } => {
                *image = f(*image);
                *coordinate = f(*coordinate);
                *array_index = array_index.map(|h| f(h));
                *value = f(*value);
                true
            },
            S::Atomic { pointer, fun, value, result } => {
                *pointer = f(*pointer);
                if let naga::AtomicFunction::Exchange { compare } = fun {
                    *compare = compare.map(|h| f(h));
                }
                *value = f(*value);
                *result = result.map(|h| f(h));
                true
            },
            S::ImageAtomic { image, coordinate, array_index, fun, value } => {
                *image = f(*image);
                *coordinate = f(*coordinate);
                *array_index = array_index.map(|h| f(h));
                if let naga::AtomicFunction::Exchange { compare } = fun {
                    *compare = compare.map(|h| f(h));
                }
                *value = f(*value);
                true
            },
            S::WorkGroupUniformLoad { pointer, result } => {
                *pointer = f(*pointer);
                *result = f(*result);
                true
            },
            S::Call { arguments, result, .. } => {
                arguments.iter_mut().for_each(|h| *h = f(*h));
                *result = result.map(|h| f(h));
                true
            },
            _ => false,
        };
        if !ok {
            return false;
        }
    }
    true
}

/// The function's expressions again with each of `moves` (an appended
/// expression, the one it goes before) in its place; false (the function
/// as it was) when that cannot be done
pub fn place(function: &mut Function, moves: &[(H, H)]) -> bool {
    let count = function.expressions.len();
    let moved: BTreeMap<usize, usize> = moves.iter().map(|&(m, before)| (m.index(), before.index())).collect();
    // the order: each original expression after those moved before it
    let mut before: BTreeMap<usize, Vec<usize>> = BTreeMap::new();
    for (&m, &b) in &moved {
        before.entry(b).or_default().push(m);
    }
    let mut order = Vec::with_capacity(count);
    let mut group_start = Vec::from_iter(core::iter::repeat(0usize).take(count));
    for i in 0..count {
        if moved.contains_key(&i) {
            continue;
        }
        group_start[i] = order.len();
        if let Some(list) = before.get(&i) {
            order.extend(list.iter().copied());
        }
        order.push(i);
    }
    for (&m, _) in &moved {
        if !order.contains(&m) {
            return false;
        }
    }
    let mut position = Vec::from_iter(core::iter::repeat(0usize).take(count));
    for (p, &i) in order.iter().enumerate() {
        position[i] = p;
        if moved.contains_key(&i) {
            group_start[i] = p;
        }
    }
    let handles: Vec<H> = function.expressions.iter().map(|(h, _)| h).collect();
    let at = |h: H| handles[position[h.index()]];
    // (the new handles are the old arena's, in order: handles[p] is the p-th)
    let mut arena: Arena<Expression> = Arena::new();
    for &i in &order {
        let h = handles[i];
        let Some(e) = remap_expression(&function.expressions[h], &at) else { return false };
        arena.append(e, function.expressions.get_span(h));
    }
    let range = |r: &naga::Range<Expression>| -> naga::Range<Expression> {
        match r.first_and_last() {
            Some((first, last)) => naga::Range::new_from_bounds(handles[group_start[first.index()]], handles[position[last.index()]]),
            None => r.clone(),
        }
    };
    let mut body = function.body.clone();
    if !remap_block(&mut body, &at, &range) {
        return false;
    }
    function.expressions = arena;
    function.body = body;
    let named: Vec<(H, alloc::string::String)> = function.named_expressions.iter().map(|(&h, n)| (at(h), n.clone())).collect();
    function.named_expressions.clear();
    for (h, n) in named {
        function.named_expressions.insert(h, n);
    }
    for (_, v) in function.local_variables.iter_mut() {
        v.init = v.init.map(|h| at(h));
    }
    true
}
