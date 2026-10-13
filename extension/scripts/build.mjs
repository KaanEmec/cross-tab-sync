// Builds dist/brave and dist/safari: two IIFE bundles, merged manifest, popup assets, icons.
// Usage: node scripts/build.mjs [--watch]
import * as esbuild from "esbuild";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { icons } from "./icons.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const watch = process.argv.includes("--watch");
const targets = ["brave", "safari"];

const readJson = async (p) => JSON.parse(await readFile(join(root, p), "utf8"));

function merge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = v && typeof v === "object" && !Array.isArray(v) && base[k] && typeof base[k] === "object" ? merge(base[k], v) : v;
  }
  return out;
}

function stripComments(value) {
  if (Array.isArray(value)) return value.map(stripComments);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => !k.startsWith("_comment"))
        .map(([k, v]) => [k, stripComments(v)]),
    );
  }
  return value;
}

async function writeStatic(target) {
  const out = join(root, "dist", target);
  const pkg = await readJson("package.json");
  const manifest = stripComments(merge(await readJson("manifests/base.json"), await readJson(`manifests/${target}.json`)));
  manifest.version = pkg.version;
  await mkdir(join(out, "icons"), { recursive: true });
  await writeFile(join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  await copyFile(join(root, "src/popup/popup.html"), join(out, "popup.html"));
  await copyFile(join(root, "src/popup/popup.css"), join(out, "popup.css"));
  for (const [name, png] of Object.entries(icons())) await writeFile(join(out, "icons", name), png);
}

function options(target) {
  return {
    entryPoints: { background: join(root, "src/background/index.ts"), popup: join(root, "src/popup/popup.ts") },
    outdir: join(root, "dist", target),
    bundle: true,
    format: "iife",
    target: target === "safari" ? ["safari16"] : ["chrome110"],
    define: { __BROWSER__: JSON.stringify(target) },
    sourcemap: watch ? "inline" : false,
    minify: false,
    legalComments: "none",
    logLevel: "warning",
  };
}

await rm(join(root, "dist"), { recursive: true, force: true });
for (const target of targets) {
  await writeStatic(target);
  if (watch) {
    const ctx = await esbuild.context(options(target));
    await ctx.watch();
  } else {
    await esbuild.build(options(target));
  }
  console.log(`built dist/${target}`);
}
if (watch) console.log("watching for changes (static files are copied at start; restart after editing them)");
