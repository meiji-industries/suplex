// The phone app starts from `run` through the mobile entry point. This binary lets `cargo check` build the crate on a computer.
fn main() {
    suplex_mobile_lib::run();
}
