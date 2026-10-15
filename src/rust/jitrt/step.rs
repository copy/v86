//! Single steps of compiled code (docs/jit-unification-plan.md P5.6): a page
//! function hands an instruction it has no template for, or whose template
//! refused at run time, to its ISA's interpreter (the step frontend) and goes
//! on as the outcome says. Neutral here: the outcome ABI page functions read,
//! their exit codes, the globals of the ABI as offsets (StepAbi, resolved by
//! the core's composition root into the constants generated code embeds) and
//! the driver; the context a step may change and the reasons it ends an
//! activation are the ISA's (StepFrontend). The x86 page tier's frontend is
//! crate::x64::pages::X86Step; the A64 one is the interpreter's
//! `interpret_one` (docs/arm64-virt-android16-plan.md P2.9, J2).

/// A step's outcome, as a page function reads it (an i32)
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(i32)]
pub enum StepOutcome {
    /// Go on in the function at the new PC (its dispatch)
    Continue = 0,
    /// The step changed only what a function checks at its entry (the code
    /// mode among the chained ones, x86's CS of code compiled for segment
    /// bases): leave through the chaining table to the new PC's function
    Chain = 1,
    /// Leave the activation: something the dispatcher must see happened
    Exit = 2,
}
/// (the outcome generated code compares with)
pub const STEP_CHAIN: i32 = StepOutcome::Chain as i32;

/// Why a page function returned (StepAbi::exit_code): it left normally
pub const EXIT_NORMAL: u32 = 0;
/// Interpret the instruction at the PC: a template's precondition failed
/// before any of its effects
pub const EXIT_RETRY: u32 = 1;
/// The PC is in the function's pages but at no compiled block start
pub const EXIT_UNKNOWN: u32 = 2;

/// The globals of the step ABI, as their offsets in the core's memory: the
/// composition root resolves them (crate::x64::pagegen::CompileEnv holds
/// x86's), and generated code embeds them as constants
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct StepAbi {
    /// The word a returning page function leaves its exit code in (EXIT_*)
    pub exit_code: u32,
}

/// An ISA's side of a step
pub trait StepFrontend {
    /// What the step may change that compiled code depends on, as it was
    /// before the step
    type Context: Copy;
    fn context() -> Self::Context;
    /// Interpret the instruction at the PC, with the state in memory
    fn interpret_one();
    /// The outcome, from the context before the step and the state now (a
    /// Chain or Exit notes its reason in the ISA's statistics)
    fn outcome(before: &Self::Context) -> StepOutcome;
}

/// One step through the frontend `F`
#[inline(always)]
pub fn step<F: StepFrontend>() -> StepOutcome {
    let before = F::context();
    F::interpret_one();
    F::outcome(&before)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Counter;
    static mut STATE: (u32, u32) = (0, 0);
    impl StepFrontend for Counter {
        type Context = u32;
        fn context() -> u32 { unsafe { STATE.0 } }
        fn interpret_one() {
            unsafe {
                STATE.0 += 1;
                STATE.1 += 1
            }
        }
        fn outcome(before: &u32) -> StepOutcome {
            if unsafe { STATE.0 } == before + 1 {
                StepOutcome::Continue
            }
            else {
                StepOutcome::Exit
            }
        }
    }

    #[test]
    fn outcome_abi() {
        assert_eq!(
            (
                StepOutcome::Continue as i32,
                STEP_CHAIN,
                StepOutcome::Exit as i32
            ),
            (0, 1, 2)
        );
        assert_eq!(step::<Counter>(), StepOutcome::Continue);
        assert_eq!(unsafe { STATE.1 }, 1);
    }
}
