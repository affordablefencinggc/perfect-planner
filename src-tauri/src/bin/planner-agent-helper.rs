#[cfg(windows)]
fn main(){std::process::exit(perfect_planner_desktop_lib::run_agent_stdio());}
#[cfg(not(windows))]
fn main(){eprintln!("AGENT_HELPER_PLATFORM_UNSUPPORTED");std::process::exit(2);}
