import type { App } from "obsidian";

export type EpubRegistrationStatus = "registered" | "ready" | "other-reader" | "unavailable";

/** Obsidian has no public extension-query API. Keep the optional internal lookup isolated. */
export function ensureEpubRegistration(app: App, viewType: string, register: () => void): EpubRegistrationStatus {
  const registry = (app as App & {
    viewRegistry?: { getTypeByExtension?: (extension: string) => string | undefined };
  }).viewRegistry;
  if (!registry?.getTypeByExtension) return "unavailable";
  const current = registry.getTypeByExtension("epub");
  if (current === viewType) return "ready";
  if (current) return "other-reader";
  register();
  return "registered";
}
