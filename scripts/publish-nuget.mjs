import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dirname, "..");
const csharp = join(repo, "csharp");
const artifacts = join(csharp, "artifacts");
const project = "Deterministic.Generators.Common/Deterministic.Generators.Common.csproj";
const id = "Deterministic.Generators.Common";
const ours = "https://github.com/deterministic-code/deterministic-generators-common";
const argv = process.argv.slice(2);
const doPublish = argv.includes("--publish");
const versionAt = argv.indexOf("--version");
const stamp = versionAt >= 0 ? argv[versionAt + 1] : undefined;
if (versionAt >= 0 && !stamp) {
  console.error("usage: npm run publish:nuget -- [--publish] [--version x.y.z]");
  process.exit(1);
}

const run = (command, args, cwd, opts = {}) =>
  new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: opts.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let stdout = "";
    let stderr = "";
    if (opts.capture) {
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
    }
    child.on("error", reject);
    child.on("close", (status) => {
      if (status !== 0 && !opts.allowFail) process.exit(status ?? 1);
      resolvePromise({ status: status ?? 1, stdout, stderr });
    });
  });

const version = async () => {
  if (stamp) return stamp;
  const props = await run(
    "dotnet",
    ["msbuild", project, "-getProperty:Version", "-nologo"],
    csharp,
    { capture: true },
  );
  return props.stdout.trim();
};

const nugetJson = async (url) => {
  const response = await fetch(url);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return response.json();
};

const published = async (ver) => {
  const index = await nugetJson(
    `https://api.nuget.org/v3-flatcontainer/${id.toLowerCase()}/index.json`,
  );
  return Boolean(index?.versions?.includes(ver));
};

const foreignOwner = async () => {
  const catalog = await nugetJson(
    `https://api.nuget.org/v3/registration5-semver1/${id.toLowerCase()}/index.json`,
  );
  if (!catalog) return false;
  const items = catalog.items ?? [];
  const pages = items.flatMap((page) => page.items ?? [page]);
  const urls = pages.flatMap((item) => {
    const catalogEntry = item.catalogEntry ?? item;
    const repoUrl = catalogEntry.repository ?? catalogEntry.projectUrl ?? "";
    return [String(repoUrl)];
  });
  if (urls.length === 0) return true;
  return !urls.some((url) => url.toLowerCase().includes(ours.toLowerCase()));
};

const pack = async (ver) => {
  const args = ["pack", project, "-c", "Release", "--no-restore"];
  if (stamp) args.push(`-p:Version=${stamp}`);
  console.log(`pack ${id} ${ver}`);
  await run("dotnet", ["restore", project], csharp);
  await run("dotnet", args, csharp);
};

const smoke = async (ver) => {
  const dir = await mkdtemp(join(tmpdir(), "deterministic-generators-common-nuget-"));
  try {
    await run(
      "dotnet",
      ["new", "classlib", "-n", "Smoke", "-o", ".", "--framework", "net10.0", "--force"],
      dir,
    );
    await writeFile(
      join(dir, "nuget.config"),
      `<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <packageSources>
    <clear />
    <add key="local" value="${artifacts}" />
    <add key="nuget.org" value="https://api.nuget.org/v3/index.json" />
  </packageSources>
</configuration>
`,
    );
    await run("dotnet", ["add", "package", id, "--version", ver, "--source", artifacts], dir);
    await run("dotnet", ["build"], dir);
    console.log("smoke ok");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const push = async (ver) => {
  const key = process.env.NUGET_API_KEY;
  if (!key) {
    console.error("NUGET_API_KEY is not set; stop before push");
    process.exit(1);
  }
  if (await published(ver)) {
    console.log(`skip ${id}@${ver} (already on nuget.org)`);
    return;
  }
  const file = join(artifacts, `${id}.${ver}.nupkg`);
  console.log(`push ${id}@${ver}`);
  const result = await run(
    "dotnet",
    [
      "nuget",
      "push",
      file,
      "--source",
      "https://api.nuget.org/v3/index.json",
      "--api-key",
      key,
      "--skip-duplicate",
    ],
    repo,
    { capture: true, allowFail: true },
  );
  if (result.status !== 0) {
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exit(result.status);
  }
  process.stdout.write(result.stdout);
};

if (await foreignOwner()) {
  console.error(
    `nuget.org already has ${id} from another owner. Do not rename. Stop and decide.`,
  );
  process.exit(1);
}

const ver = await version();
await pack(ver);
const files = (await readdir(artifacts)).filter((name) => name.endsWith(`${ver}.nupkg`));
if (!files.includes(`${id}.${ver}.nupkg`)) {
  console.error(`expected ${id}.${ver}.nupkg, found ${files.join(", ")}`);
  process.exit(1);
}
await smoke(ver);
if (doPublish) await push(ver);
else console.log(`dry-run packed ${ver}; pass --publish to push to nuget.org`);
