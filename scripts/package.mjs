import fs from "node:fs";
import path from "node:path";
import archiver from "archiver";

const root = path.resolve(import.meta.dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "extension", "manifest.json"), "utf8"));
const dist = path.join(root, "dist");
fs.mkdirSync(dist, { recursive: true });
const output = fs.createWriteStream(path.join(dist, `dsa-templates-${manifest.version}.zip`));
const archive = archiver("zip", { zlib: { level: 9 } });
archive.pipe(output);
archive.directory(path.join(root, "extension"), false);
await archive.finalize();
await new Promise((resolve, reject) => { output.on("close", resolve); output.on("error", reject); });
console.log(`Wrote ${output.path}`);
