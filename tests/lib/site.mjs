// The owner's retro-gaming-site checkout (the Windows images and the
// Windows 98 states): next to the main v86 checkout, found from a worktree
// (build/wt-*) too through git's common directory
import { spawnSync } from "node:child_process";
import path from "node:path";

/** @param {string} root a v86 tree (the main checkout or a worktree) */
export function site_directory(root)
{
    const r = spawnSync("git", ["-C", root, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" });
    const main = r.status === 0 ? path.dirname(r.stdout.trim()) : root;
    return path.resolve(main, "../retro-gaming-site");
}
