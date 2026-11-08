#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(target_os = "linux")]
    {
        // Fix severe stutter/lag and blank screen on Linux (WebKitGTK + NVIDIA / Wayland / DMA-BUF bug)
        // 1. Force GDK to prefer X11 (via XWayland) if available, falling back to Wayland.
        //    This completely avoids KWin Wayland EGL swapchain buffer allocation failures on NVIDIA proprietary drivers.
        if std::env::var_os("GDK_BACKEND").is_none() {
            std::env::set_var("GDK_BACKEND", "x11,wayland");
        }
        // 2. Disable DMA-BUF renderer to prevent black screen / buffer negotiation failures on NVIDIA.
        if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }
        // 3. Disable GPU compositing mode to prevent blank/black canvas crashes.
        if std::env::var_os("WEBKIT_DISABLE_COMPOSITING_MODE").is_none() {
            std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
        }
    }

    ql_studio_core::run();
}
