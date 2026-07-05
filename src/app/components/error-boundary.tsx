import React, { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertCircle } from "lucide-react";

interface Props {
  children?: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
    errorInfo: null,
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error, errorInfo: null };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("Uncaught error:", error, errorInfo);
    this.setState({ errorInfo });
  }

  public render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div className="flex h-screen w-full items-center justify-center bg-app p-4 text-primary">
          <div className="flex w-full max-w-lg flex-col gap-4 rounded-xl border border-card bg-card-3 p-6 shadow-xl">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-card-hover/20 text-accent-red">
                <AlertCircle size={24} />
              </div>
              <h1 className="text-xl font-semibold">Something went wrong</h1>
            </div>
            
            <div className="mt-2 space-y-2">
              <p className="text-sm text-muted">
                An unexpected error occurred in the application interface.
              </p>
              
              {this.state.error && (
                <div className="mt-4 rounded-lg border border-[#3A2026] bg-app p-4">
                  <p className="font-mono text-sm font-medium text-[#F4C7CF] break-words">
                    {this.state.error.toString()}
                  </p>
                </div>
              )}
            </div>

            <div className="mt-6 flex justify-end">
              <button
                onClick={() => window.location.reload()}
                className="rounded-lg bg-[#24272D] px-4 py-2 text-sm font-medium transition-colors hover:bg-card-hover"
              >
                Reload Page
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
