import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export function isolatedEnv(privateRoot, agentDir, inherited = process.env) {
  const env = { ...inherited };
  for (const key of Object.keys(env)) if (/^PI_/i.test(key)) delete env[key];
  const home = path.join(privateRoot, "user");
  const temp = path.join(privateRoot, "temp");
  const appData = path.join(home, "AppData", "Roaming");
  const localAppData = path.join(home, "AppData", "Local");
  for (const dir of [home, temp, appData, localAppData]) fs.mkdirSync(dir, { recursive: true });
  const npmrc = path.join(home, ".npmrc");
  fs.writeFileSync(npmrc, `cache=${path.join(privateRoot, "npm-cache").replace(/\\/g, "/")}\nprefix=${path.join(privateRoot, "npm-prefix").replace(/\\/g, "/")}\n`);
  return { ...env,
    HOME: home, USERPROFILE: home, APPDATA: appData, LOCALAPPDATA: localAppData,
    XDG_CONFIG_HOME: path.join(home, ".config"), XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_DATA_HOME: path.join(home, ".local", "share"), TEMP: temp, TMP: temp, TMPDIR: temp,
    NPM_CONFIG_USERCONFIG: npmrc, NPM_CONFIG_GLOBALCONFIG: npmrc,
    PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1",
    FOLIO_BENCH_PRIVATE_ROOT: privateRoot,
    PATH: [inherited.FOLIO_PYTHON_DIR, inherited.PATH].filter(Boolean).join(path.delimiter),
  };
}

// Read-only fingerprints of personal pi configuration; values/credentials never leave this function.
export function snapshotPiConfig(piRoot) {
  const files = {};
  for (const dir of [piRoot, path.join(piRoot, "agent")]) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !/\.(json|jsonc|ya?ml|toml|bak)$/i.test(entry.name)) continue;
      const name = path.relative(piRoot, path.join(dir, entry.name)).replace(/\\/g, "/");
      files[name] = createHash("sha256").update(fs.readFileSync(path.join(dir, entry.name))).digest("hex");
    }
  }
  return files;
}

export function balancedJobs(arms, questions, repeat) {
  const jobs = [];
  for (let r = 1; r <= repeat; r++) for (let i = 0; i < questions.length; i++) {
    const order = (r + i) % 2 ? arms : [...arms].reverse();
    for (const arm of order) jobs.push({ arm, q: questions[i], r });
  }
  return jobs;
}
