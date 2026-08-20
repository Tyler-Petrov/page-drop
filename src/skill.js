import { cp, lstat, mkdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = join(PACKAGE_DIR, "skills", "page-drop");

export function skillsRoot(options = {}) {
  return resolve(options.target || process.env.PAGE_DROP_SKILLS_DIR || join(homedir(), ".agents", "skills"));
}

export async function installSkill(options = {}) {
  const target = join(skillsRoot(options), "page-drop");
  let targetExists = false;
  let existing;
  try { await lstat(target); targetExists = true; }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (targetExists) {
    try { existing = await readFile(join(target, "SKILL.md"), "utf8"); }
    catch (error) { if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error; }
    const frontmatter = existing?.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1];
    const recognized = frontmatter && /^name:\s*page-drop\s*$/m.test(frontmatter);
    if (!recognized && !options.force) {
      throw new Error(`${target} is not a recognized Page Drop skill; use --force to replace it`);
    }
    await rm(target, { recursive: true });
  }
  await mkdir(dirname(target), { recursive: true });
  await cp(SOURCE, target, { recursive: true });
  return target;
}
