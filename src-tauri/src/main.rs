#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(target_os = "linux")]
    {
        // Fix severe stutter/lag on Linux (WebKitGTK + NVIDIA / Wayland / DMA-BUF bug)
        // WebKitGTK 2.40+ has a known issue with DMABUF renderer on NVIDIA proprietary drivers
        if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }
    }

    ql_studio_core::run();
}
