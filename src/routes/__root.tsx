import { HeadContent, Outlet, Scripts, createRootRoute } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { AuthProvider } from "@/lib/auth/provider";
import { PreviewHostBridge } from "@/components/preview-host-bridge";
import { AppErrorComponent } from "@/lib/error-component";
import { Toaster } from "sonner";
import appCss from "../styles.css?url";

const APP_NAME = "Fleet";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: APP_NAME },
      { name: "theme-color", content: "#f7f7f8" },
      {
        name: "description",
        content: "One MCP tool. Windows, Linux, macOS. Try https://fleet.ginfo.cc.",
      },
    ],
    links: [
      { rel: "icon", href: "/favicon.ico", sizes: "any" },
      { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
      { rel: "icon", type: "image/png", href: "/favicon-32.png", sizes: "32x32" },
      { rel: "stylesheet", href: appCss },
      { rel: "manifest", href: "/__grok/manifest.webmanifest" },
      { rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      { rel: "preconnect", href: "https://cdn.jsdelivr.net", crossOrigin: "anonymous" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap",
      },
      {
        rel: "stylesheet",
        href: "https://cdn.jsdelivr.net/npm/@chinese-fonts/xiaolai@3.0.0/dist/Xiaolai/result.css",
      },
    ],
    scripts: [
      {
        children: `(function(){try{var p=localStorage.getItem("fleet-theme")||"system";var d=window.matchMedia("(prefers-color-scheme: dark)").matches;var r=p==="system"?(d?"dark":"light"):p;document.documentElement.setAttribute("data-theme",r);document.documentElement.setAttribute("data-theme-pref",p);document.documentElement.style.colorScheme=r;}catch(e){}})();`,
      },
    ],
  }),
  errorComponent: AppErrorComponent,
  component: RootDocument,
});

function RootDocument() {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: 1, refetchOnWindowFocus: false },
        },
      }),
  );

  return (
    <html lang="en" className="antialiased" suppressHydrationWarning>
      <head>
        <HeadContent />
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var p=localStorage.getItem("fleet-theme")||"system";var d=window.matchMedia("(prefers-color-scheme: dark)").matches;var r=p==="system"?(d?"dark":"light"):p;document.documentElement.setAttribute("data-theme",r);document.documentElement.setAttribute("data-theme-pref",p);document.documentElement.style.colorScheme=r;}catch(e){}})();`,
          }}
        />
      </head>
      <body className="bg-bg text-fg min-h-svh">
        <PreviewHostBridge />
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <Outlet />
            <Toaster theme="system" position="bottom-right" className="font-sans" />
          </AuthProvider>
        </QueryClientProvider>
        <Scripts />
      </body>
    </html>
  );
}
