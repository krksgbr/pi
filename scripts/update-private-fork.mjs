#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "..");
const codingAgentDir = join(repoRoot, "packages", "coding-agent");
const runtimeBookmark = "private-runtime";
const retryBookmark = "retry-cancel";

function formatCommand(command, args) {
	return [command, ...args].map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg)).join(" ");
}

function runCommand(command, args, options = {}) {
	console.log(`> ${formatCommand(command, args)}`);
	const result = spawnSync(command, args, {
		cwd: options.cwd ?? repoRoot,
		encoding: "utf8",
		stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
	});
	if (result.error) throw result.error;
	if (result.status !== 0) {
		const details = options.capture ? result.stderr.trim() : "";
		throw new Error(`${formatCommand(command, args)} exited with code ${result.status ?? "unknown"}${details ? `: ${details}` : ""}`);
	}
	return options.capture ? result.stdout.trim() : "";
}

function tryCommand(command, args) {
	console.log(`> ${formatCommand(command, args)}`);
	const result = spawnSync(command, args, { cwd: repoRoot, stdio: "inherit" });
	return !result.error && result.status === 0;
}

function revisionId(revision) {
	return runCommand("jj", ["log", "-r", revision, "--no-graph", "-T", "commit_id"], { capture: true });
}

function assertReadyWorkingCopy() {
	const empty = runCommand("jj", ["log", "-r", "@", "--no-graph", "-T", "empty"], { capture: true });
	if (empty !== "true") {
		throw new Error("The Pi checkout has uncommitted working-copy changes. Commit or abandon them before updating.");
	}
	if (revisionId("@-") !== revisionId(runtimeBookmark)) {
		throw new Error(`The working-copy parent must be the ${runtimeBookmark} bookmark.`);
	}
}

export function parseUpdateTarget(installSpec) {
	const match = /@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/.exec(installSpec);
	if (!match) throw new Error(`Expected a versioned Pi package spec, received: ${installSpec}`);
	return { version: match[1], tag: `v${match[1]}` };
}

export function main(args = process.argv.slice(2)) {
	const installSpec = args[0];
	if (!installSpec || args.length !== 1) {
		throw new Error("Usage: update-private-fork.mjs <package@version>");
	}
	const { version, tag } = parseUpdateTarget(installSpec);

	assertReadyWorkingCopy();
	runCommand("jj", ["git", "fetch", "--remote", "upstream"]);
	revisionId(tag);
	runCommand("jj", ["rebase", "--ignore-immutable", "-b", runtimeBookmark, "-o", tag]);

	const conflicts = runCommand("jj", ["log", "-r", `conflicts() & (${tag}..@)`, "--no-graph", "-T", "commit_id"], {
		capture: true,
	});
	if (conflicts) throw new Error(`Rebase onto ${tag} produced conflicts. Resolve them before rebuilding Pi.`);
	assertReadyWorkingCopy();

	const packageVersion = JSON.parse(readFileSync(join(codingAgentDir, "package.json"), "utf8")).version;
	if (packageVersion !== version) {
		throw new Error(`Tag ${tag} contains coding-agent version ${packageVersion}, expected ${version}.`);
	}

	runCommand("npm", ["install", "--ignore-scripts"]);
	runCommand("npm", ["run", "hydrate:model-data"]);
	runCommand(
		process.execPath,
		[
			"../../node_modules/vitest/dist/cli.js",
			"--run",
			"test/interactive-mode-ctrl-c.test.ts",
			"test/status-indicator.test.ts",
			"test/config.test.ts",
		],
		{ cwd: codingAgentDir },
	);
	runCommand("npm", ["run", "check"]);
	assertReadyWorkingCopy();
	runCommand("npm", ["run", "build:offline"]);

	const builtVersion = runCommand(process.execPath, [join(codingAgentDir, "dist", "cli.js"), "--version"], {
		capture: true,
	});
	if (builtVersion !== version) throw new Error(`Built Pi reports ${builtVersion}, expected ${version}.`);

	if (!tryCommand("jj", ["git", "push", "--remote", "origin", "--bookmark", retryBookmark, "--bookmark", runtimeBookmark])) {
		console.warn("Pi updated locally, but pushing the private runtime bookmarks failed.");
	}
	console.log(`Private Pi updated to ${tag}.`);
	console.log(
		"Restart any already-running Pi sessions before further prompting: the update rebuilt runtime modules in place, and a running process can mix cached modules with newly built files.",
	);
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
	try {
		main();
	} catch (error) {
		console.error(`Private Pi update failed: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	}
}
