//! Pi and its fork omp (oh-my-pi). One runtime serves both; `cli` holds
//! what differs between them.

pub mod cli;
pub mod display;
pub mod executable;
pub mod harness;
pub mod invocation;
pub mod models;
pub mod runtime;
pub mod session_reader;
pub mod task_runtime;
pub mod tool_evidence;
pub mod transcript;
pub mod usage;
