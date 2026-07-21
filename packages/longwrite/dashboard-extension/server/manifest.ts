export const longWriteDashboardServerExtensionManifest = {
  id: "longwrite",
  apiBasePath: "/api/longwrite",
  workspaceConfigFile: "longwrite.yaml",
  cliEnv: ["MALACLAW_LONGWRITE_BIN", "LONGWRITE_BIN"],
  cliBin: "longwrite",
  description: "LongWrite writing-workspace dashboard extension.",
};

export type LongWriteDashboardServerExtensionManifest = typeof longWriteDashboardServerExtensionManifest;
