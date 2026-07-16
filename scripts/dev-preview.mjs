// Isolated preview dev server for verifying working-tree changes without
// touching the launchd instance on :4183. Separate dist dir so it never
// clobbers the production .next; shares the real data dir so attachments and
// threads round-trip end-to-end. Port 4199.
import { spawn } from "node:child_process";

const env = {
  ...process.env,
  NEXT_DIST_DIR: ".next-preview",
  NODE_ENV: "development",
};

const child = spawn(
  "npx",
  ["next", "dev", "-H", "127.0.0.1", "-p", "4199"],
  { stdio: "inherit", env }
);
child.on("exit", (code) => process.exit(code ?? 0));
