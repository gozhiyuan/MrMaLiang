import { LongWrite } from "./LongWrite";

export const longWriteDashboardClientExtension = {
  id: "longwrite",
  // Keep the stable extension id/API namespace for existing registrations,
  // but present the public product—not its internal writing component.
  label: "MrMaLiang",
  path: "/maliang",
  element: <LongWrite />,
};
