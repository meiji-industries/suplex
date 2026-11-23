//! Google Antigravity through its official ACP agent, `agy acp`. Each turn is
//! a headless `suplex antigravity-turn` process: an ACP client that resumes
//! the native session, selects the model and thinking level, sends the
//! prompt, and logs the agent's updates. `cli` holds the CLI contract.

pub mod acp;
pub mod cli;
pub mod display;
pub mod harness;
pub mod probe;
pub mod runtime;
pub mod session_reader;
pub mod task_runtime;
pub mod transcript;
pub mod turn;

#[cfg(test)]
mod tests;
