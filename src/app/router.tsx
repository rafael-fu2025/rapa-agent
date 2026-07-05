import { createBrowserRouter } from "react-router";

import { LoginRoute, ProtectedAuthGuard, Home, Settings } from "./routes";

export const router = createBrowserRouter([
  {
    path: "/login",
    element: <LoginRoute />,
  },
  {
    element: <ProtectedAuthGuard />,
    children: [
      {
        path: "/",
        Component: Home,
      },
      {
        path: "/settings",
        Component: Settings,
      },
    ],
  },
]);
