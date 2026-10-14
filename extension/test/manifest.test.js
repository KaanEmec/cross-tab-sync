import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Plain JS so the extension tsconfig needs no Node types. Checks the build output when present (run `pnpm build` first); skipped otherwise.
const dist = join(import.meta.dirname, "..", "dist");

describe.each(["brave", "safari"])("dist/%s/manifest.json", (target) => {
  const file = join(dist, target, "manifest.json");
  it.skipIf(!existsSync(file))("is a valid MV3 manifest with the expected fields", () => {
    const m = JSON.parse(readFileSync(file, "utf8"));
    expect(m.manifest_version).toBe(3);
    expect(m.version).toBe("3.0.0");
    expect(m.background).toEqual({ service_worker: "background.js" });
    expect(m.permissions).toEqual(["tabs", "storage", "alarms"]);
    // Safari included: the diagnostics trace no longer goes to a native host.
    expect(m.permissions).not.toContain("nativeMessaging");
    expect(m.description.length).toBeLessThanOrEqual(132); // Chrome Web Store summary
    expect(m.host_permissions).toBeUndefined();
    expect(m.optional_host_permissions).toContain("https://*/*");
    expect(JSON.stringify(m)).not.toContain("_comment");
    for (const f of ["background.js", "popup.html", "popup.js", "popup.css", ...Object.values(m.icons)]) {
      expect(existsSync(join(dist, target, f))).toBe(true);
    }
  });
});
