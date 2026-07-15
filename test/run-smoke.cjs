const { execFileSync } = require("child_process");
const esbuild = require("esbuild");

esbuild.buildSync({
  entryPoints: ["test/smoke.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  alias: { vscode: "./test/vscode-stub.js" },
  outfile: "out/smoke.cjs",
  logLevel: "info",
});

execFileSync(process.execPath, ["out/smoke.cjs"], { stdio: "inherit" });
