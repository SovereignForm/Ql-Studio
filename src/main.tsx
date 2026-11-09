import React, { Component, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./styles.css";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

class RootErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  public override state: ErrorBoundaryState = {
    hasError: false,
    error: null,
  };

  public static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  public override componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("Uncaught Studio Workspace Error:", error, errorInfo);
  }

  private handleReset = () => {
    localStorage.removeItem("ql_visual_sync_offset_ms");
    window.location.reload();
  };

  public override render() {
    if (this.state.hasError) {
      return (
        <div className="h-screen w-screen bg-[#16191e] text-zinc-100 flex flex-col items-center justify-center p-6 text-center select-none font-sans">
          <div className="max-w-md p-6 bg-[#21262d] border border-red-500/40 rounded-lg shadow-2xl flex flex-col items-center gap-4">
            <div className="w-10 h-10 rounded-full bg-red-500/20 text-red-400 grid place-items-center font-bold text-lg">
              !
            </div>
            <h2 className="text-lg font-bold text-white tracking-wide">
              Workspace Recovery Notice
            </h2>
            <p className="text-xs text-zinc-400 leading-relaxed">
              A temporary layout or state exception was intercepted. Your project audio buffer remains protected.
            </p>
            <pre className="text-[10px] text-zinc-500 bg-black/50 p-2.5 rounded w-full text-left font-mono overflow-auto max-h-24">
              {this.state.error?.message || "Unknown error"}
            </pre>
            <div className="flex gap-3 mt-1">
              <button
                type="button"
                onClick={() => this.setState({ hasError: false, error: null })}
                className="px-4 py-1.5 rounded bg-zinc-700 hover:bg-zinc-600 text-xs font-semibold cursor-pointer"
              >
                Resume Session
              </button>
              <button
                type="button"
                onClick={this.handleReset}
                className="px-4 py-1.5 rounded bg-amber-600 hover:bg-amber-500 text-black text-xs font-bold cursor-pointer"
              >
                Reload Workstation
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

try {
  const container = document.getElementById("root");
  if (container) {
    createRoot(container).render(
      <React.StrictMode>
        <RootErrorBoundary>
          <App />
        </RootErrorBoundary>
      </React.StrictMode>,
    );
  }
} catch (err: unknown) {
  console.error("Fatal React Root Mounting Error:", err);
}
