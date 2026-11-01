// Packages dist/brave and dist/safari into dist/zips/*.zip (run after `pnpm build`).
// Usage: node scripts/zip.mjs [version]   (default: package.json version; a leading "v" is stripped)
// Dependency-free: writes the zip format directly so it works the same on macOS, Linux and CI.
import { crc32, deflateRawSync } from "node:zlib";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const version = (process.argv[2] ?? pkg.version).replace(/^v/, "");

async function listFiles(dir, prefix = "") {
  const out = [];
  for (const e of (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (e.isDirectory()) out.push(...(await listFiles(join(dir, e.name), `${prefix}${e.name}/`)));
    else if (e.isFile()) out.push(`${prefix}${e.name}`);
  }
  return out;
}

async function zipDir(dir) {
  const names = await listFiles(dir);
  if (!names.includes("manifest.json")) throw new Error(`${dir} has no manifest.json; run pnpm build first`);
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const name of names) {
    const data = await readFile(join(dir, name));
    const packed = deflateRawSync(data, { level: 9 });
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(data);
    // Fixed timestamp (1980-01-01) keeps the archive reproducible.
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    chunks.push(local, nameBuf, packed);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(0x031e, 4); // made by: Unix
    local.copy(cd, 6, 4, 30); // version needed .. name length
    cd.writeUInt32LE(((0o100644 << 16) | 0) >>> 0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += local.length + nameBuf.length + packed.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(names.length, 8);
  end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cdBuf, end]);
}

const outDir = join(root, "dist", "zips");
await mkdir(outDir, { recursive: true });
for (const [target, name] of [
  ["brave", `cross-tab-sync-brave-${version}.zip`],
  ["safari", `cross-tab-sync-safari-resources-${version}.zip`],
]) {
  await writeFile(join(outDir, name), await zipDir(join(root, "dist", target)));
  console.log(`dist/zips/${name}`);
}
