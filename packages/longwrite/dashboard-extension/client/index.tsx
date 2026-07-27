import { LongWrite } from "./LongWrite";
import { Evidence, Manuscript, Release, ResearchOverview } from "./Research";

export const longWriteDashboardClientExtension = {
  id: "longwrite",
  // Trusted build-time contributions only. Keep the stable route/API namespace
  // while presenting the public product, not its internal writing component.
  routes: [
    { path: "/maliang", element: <LongWrite /> },
    { path: "/maliang/research", element: <ResearchOverview /> },
    { path: "/maliang/evidence", element: <Evidence /> },
    { path: "/maliang/manuscript", element: <Manuscript /> },
    { path: "/maliang/release", element: <Release /> },
  ],
  navigation: [
    { to: "/maliang", label: "MrMaLiang" },
    { to: "/maliang/research", label: "Research" },
    { to: "/maliang/evidence", label: "Evidence" },
    { to: "/maliang/manuscript", label: "Manuscript" },
    { to: "/maliang/release", label: "Release" },
  ],
  projectKinds: ["maliang_program", "longwrite_workspace"],
};
