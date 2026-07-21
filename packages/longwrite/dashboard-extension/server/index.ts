import { longWriteDashboardServerExtensionManifest } from "./manifest.js";
import { createLongWriteDashboardRoutes } from "./routes.js";

export function createDashboardServerExtension(host: Parameters<typeof createLongWriteDashboardRoutes>[0]) {
  return {
    id: longWriteDashboardServerExtensionManifest.id,
    routes: createLongWriteDashboardRoutes(host),
  };
}

export default createDashboardServerExtension;
