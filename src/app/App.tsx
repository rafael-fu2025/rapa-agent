import { RouterProvider } from "react-router";
import { Toaster } from "sonner";
import { router } from "./router";
import { ThemeProvider } from "./hooks/use-theme";

function App() {
  return (
    <ThemeProvider>
      <div className="h-full w-full bg-background text-foreground">
        <RouterProvider router={router} />
        <Toaster
          position="bottom-right"
          toastOptions={{
            className: "border border-border bg-card text-card-foreground shadow-lg"
          }}
        />
      </div>
    </ThemeProvider>
  );
}

export default App;
