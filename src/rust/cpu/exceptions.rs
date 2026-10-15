//! Exception delivery escalation (Intel SDM Vol. 3A, table 7-5).
//! Delivery is synchronous and never spans a scheduler boundary. Shutdown is
//! architectural per-core state; the board resets on BSP shutdown only.
use crate::cpu::{apic, cpu, global_pointers::*};

#[derive(Clone, Copy, PartialEq, Debug)]
enum Class {
    Benign,
    Contributory,
    Page,
    Double,
}
fn class(vector: i32) -> Class {
    match vector {
        0 | 10..=13 => Class::Contributory,
        14 => Class::Page,
        8 => Class::Double,
        _ => Class::Benign,
    }
}
#[derive(PartialEq, Debug)]
enum Action {
    Deliver,
    Double,
    Shutdown,
}
fn escalation(first: Class, second: Class) -> Action {
    match (first, second) {
        (Class::Double, Class::Contributory | Class::Page) => Action::Shutdown,
        (Class::Contributory, Class::Contributory)
        | (Class::Page, Class::Contributory | Class::Page) => Action::Double,
        _ => Action::Deliver,
    }
}
static mut DELIVERING: Option<Class> = None;
static mut EXTERNAL: bool = false;
// 0: running, 1: shutdown (NMI/INIT can wake), 2: shutdown during NMI (reset only).
static mut SHUTDOWN: [u8; 8] = [0; 8];
static mut BSP_RESET: bool = false;

pub unsafe fn delivering() -> bool { matches!(DELIVERING, Some(_)) }
pub unsafe fn interrupt(vector: i32, software: bool, code: Option<i32>) -> bool {
    let old = DELIVERING;
    let old_external = EXTERNAL;
    EXTERNAL = !software;
    DELIVERING = Some(Class::Benign);
    let completed = cpu::deliver_interrupt(vector, software, code);
    DELIVERING = old;
    EXTERNAL = old_external;
    completed
}
/// A CPU trap ignores gate DPL without marking a later selector fault as
/// externally caused. Its return IP already points past the retired opcode.
pub unsafe fn trap(vector: i32) {
    let old = DELIVERING;
    let old_external = EXTERNAL;
    EXTERNAL = false;
    DELIVERING = Some(Class::Benign);
    cpu::deliver_interrupt(vector, false, None);
    DELIVERING = old;
    EXTERNAL = old_external;
}
pub unsafe fn fault(vector: i32, code: Option<i32>) {
    if vector == 7 {
        // (the step profile's #NM count, docs/jit-unification-plan.md P4.0)
        crate::step_profile::note_event(crate::step_profile::event::NM, 0);
    }
    let old = DELIVERING;
    let action = escalation(old.unwrap_or(Class::Benign), class(vector));
    if action == Action::Shutdown {
        shutdown();
        return;
    }
    let code = if EXTERNAL && matches!(vector, 10..=13) { code.map(|code| code | 1) } else { code };
    let (vector, code) = if action == Action::Double { (8, Some(0)) } else { (vector, code) };
    DELIVERING = Some(class(vector));
    cpu::deliver_interrupt(vector, false, code);
    DELIVERING = old;
}
/// The shutdown state: a triple fault, or RSM to invalid state; the
/// chipset resets the machine for the BSP
pub unsafe fn shutdown() {
    let core = apic::current_core();
    (*crate::parallel::machine(&raw mut SHUTDOWN))[core] = if *nmi_blocked { 2 } else { 1 };
    if core == 0 {
        BSP_RESET = true;
    }
    *in_hlt = true;
    cpu::request_core_yield();
}
#[no_mangle]
pub unsafe fn exception_shutdown(core: u32) -> u32 {
    assert!(core < 8);
    (*crate::parallel::machine(&raw mut SHUTDOWN))[core as usize] as u32
}
#[no_mangle]
pub unsafe fn exception_restore(core: u32, state: u32) {
    assert!(core < 8 && state <= 2);
    (*crate::parallel::machine(&raw mut SHUTDOWN))[core as usize] = state as u8;
}
pub unsafe fn init(core: u32) -> bool {
    if exception_shutdown(core) == 2 {
        return false;
    }
    exception_restore(core, 0);
    true
}
pub unsafe fn reset() {
    *crate::parallel::machine(&raw mut SHUTDOWN) = [0; 8];
    DELIVERING = None;
    EXTERNAL = false;
    BSP_RESET = false;
}
#[no_mangle]
pub unsafe fn exception_take_bsp_reset() -> bool {
    let pending = BSP_RESET;
    BSP_RESET = false;
    pending
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn intel_delivery_escalation_matrix() {
        use Action::{Deliver, Shutdown};
        use Class::*;
        for (first, expected) in [
            (Benign, [Deliver, Deliver, Deliver]),
            (Contributory, [Deliver, Action::Double, Deliver]),
            (Page, [Deliver, Action::Double, Action::Double]),
            (Class::Double, [Deliver, Shutdown, Shutdown]),
        ] {
            for (second, expected) in [Benign, Contributory, Page].into_iter().zip(expected) {
                assert_eq!(escalation(first, second), expected);
            }
        }
    }
}
