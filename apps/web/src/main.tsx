import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router";
import { z } from "zod";
import { createQueryClient } from "./app/query-client";
import { router } from "./app/router";
import { ToastProvider } from "./components/ui/toast";
import { UploadProvider } from "./pages/media/upload-store";
import "./styles.css";

// Field messages from the protocol schemas (e.g. "6 haneli kod") stay Turkish; zod's own defaults too.
z.config(z.locales.tr());

const queryClient = createQueryClient();

const root = document.getElementById("root");
if (root === null) throw new Error("#root element missing in index.html");

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <UploadProvider>
          <RouterProvider router={router} />
        </UploadProvider>
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);
