import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "..");
const codingAgentDir = join(repoRoot, "packages", "coding-agent");
const runtimeBookmark = "private-runtime";
const retryBookmark = "retry-cancel";

interface RunCommandOptions {
	readonly cwd?: string;
	readonly capture?: boolean;
}

export type RunCommand = (command: string, args: readonly string[], options?: RunCommandOptions) => string;

type TryCommand = (command: string, args: readonly string[]) => boolean;

export interface UpdateDependencies {
	readonly runCommand: RunCommand;
	readonly tryCommand: TryCommand;
	readonly readCodingAgentVersion: () => string;
}

export interface ConflictPreservedResult {
	readonly kind: "conflict-preserved";
	readonly version: string;
	readonly tag: string;
	readonly candidateBookmark: string;
	readonly candidateCommit: string;
	readonly preRebaseOperation: string;
}

interface UpdatedResult {
	readonly kind: "updated";
	readonly tag: string;
}

export type UpdateResult = ConflictPreservedResult | UpdatedResult;

export class RollbackFailedError extends Error {
	readonly preRebaseOperation: string;
	readonly conflictedCommit: string;

	constructor(preRebaseOperation: string, conflictedCommit: string, cause: unknown) {
		super("The pre-rebase operation could not be restored.", { cause });
		this.name = "RollbackFailedError";
		this.preRebaseOperation = preRebaseOperation;
		this.conflictedCommit = conflictedCommit;
	}
}

function formatCommand(command: string, args: readonly string[]): string {
	return [command, ...args].map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg)).join(" ");
}

const runCommand: RunCommand = (command, args, options = {}) => {
	console.log(`> ${formatCommand(command, args)}`);
	const result = spawnSync(command, args, {
		cwd: options.cwd ?? repoRoot,
		encoding: "utf8",
		stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
	});
	if (result.error) throw result.error;
	if (result.status !== 0) {
		const details = options.capture ? result.stderr.trim() : "";
		throw new Error(
			`${formatCommand(command, args)} exited with code ${result.status ?? "unknown"}${details ? `: ${details}` : ""}`,
		);
	}
	return options.capture ? result.stdout.trim() : "";
};

const tryCommand: TryCommand = (command, args) => {
	console.log(`> ${formatCommand(command, args)}`);
	const result = spawnSync(command, args, { cwd: repoRoot, stdio: "inherit" });
	return !result.error && result.status === 0;
};

function revisionId(run: RunCommand, revision: string): string {
	return run("jj", ["log", "-r", revision, "--no-graph", "-T", "commit_id"], { capture: true });
}

function assertReadyWorkingCopy(run: RunCommand): void {
	const empty = run("jj", ["log", "-r", "@", "--no-graph", "-T", "empty"], { capture: true });
	if (empty !== "true") {
		throw new Error("The Pi checkout has uncommitted working-copy changes. Commit or abandon them before updating.");
	}
	const conflicted = run("jj", ["log", "-r", "@", "--no-graph", "-T", "conflict"], { capture: true });
	if (conflicted !== "false") {
		throw new Error("The Pi checkout already contains unresolved conflicts. Resolve or restore it before updating.");
	}
	if (revisionId(run, "@-") !== revisionId(run, runtimeBookmark)) {
		throw new Error(`The working-copy parent must be the ${runtimeBookmark} bookmark.`);
	}
}

function sanitizeName(value: string): string {
	return value.replace(/[^0-9A-Za-z._-]/g, "-");
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function readCodingAgentVersion(): string {
	const packageJson: unknown = JSON.parse(readFileSync(join(codingAgentDir, "package.json"), "utf8"));
	if (
		packageJson === null ||
		typeof packageJson !== "object" ||
		!("version" in packageJson) ||
		typeof packageJson.version !== "string"
	) {
		throw new Error("The coding-agent package.json does not contain a string version.");
	}
	return packageJson.version;
}

const defaultDependencies: UpdateDependencies = {
	runCommand,
	tryCommand,
	readCodingAgentVersion,
};

export function parseUpdateTarget(installSpec: string): { version: string; tag: string } {
	const match = /@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/.exec(installSpec);
	if (!match) throw new Error(`Expected a versioned Pi package spec, received: ${installSpec}`);
	return { version: match[1], tag: `v${match[1]}` };
}

export function rebasePrivateRuntime(
	version: string,
	tag: string,
	run: RunCommand,
): ConflictPreservedResult | undefined {
	const preRebaseOperation = run("jj", ["op", "log", "--limit", "1", "--no-graph", "-T", "id"], {
		capture: true,
	});
	run("jj", ["rebase", "--ignore-immutable", "-b", runtimeBookmark, "-o", tag]);

	const conflicts = run("jj", ["log", "-r", `conflicts() & (${tag}..@)`, "--no-graph", "-T", "commit_id"], {
		capture: true,
	});
	if (!conflicts) return undefined;

	const candidateCommit = revisionId(run, runtimeBookmark);
	const candidateBookmark = `${runtimeBookmark}-update-${sanitizeName(tag)}-${candidateCommit.slice(0, 8)}`;

	try {
		run("jj", ["op", "restore", preRebaseOperation]);
	} catch (error) {
		throw new RollbackFailedError(preRebaseOperation, candidateCommit, error);
	}

	try {
		run("jj", ["bookmark", "create", candidateBookmark, "-r", candidateCommit]);
	} catch (error) {
		throw new Error(
			`The live checkout was restored, but the conflicted candidate could not be bookmarked. Preserve it with: ${formatCommand("jj", ["bookmark", "create", candidateBookmark, "-r", candidateCommit])}. ${errorMessage(error)}`,
			{ cause: error },
		);
	}

	assertReadyWorkingCopy(run);
	return {
		kind: "conflict-preserved",
		version,
		tag,
		candidateBookmark,
		candidateCommit,
		preRebaseOperation,
	};
}

export function updatePrivateFork(installSpec: string, dependencies: UpdateDependencies = defaultDependencies): UpdateResult {
	const { version, tag } = parseUpdateTarget(installSpec);
	const run = dependencies.runCommand;

	assertReadyWorkingCopy(run);
	run("jj", ["git", "fetch", "--remote", "upstream"]);
	revisionId(run, tag);
	const conflict = rebasePrivateRuntime(version, tag, run);
	if (conflict) return conflict;
	assertReadyWorkingCopy(run);

	const packageVersion = dependencies.readCodingAgentVersion();
	if (packageVersion !== version) {
		throw new Error(`Tag ${tag} contains coding-agent version ${packageVersion}, expected ${version}.`);
	}

	run("npm", ["install", "--ignore-scripts"]);
	run("npm", ["run", "hydrate:model-data"]);
	run(
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
	run("npm", ["run", "check"]);
	assertReadyWorkingCopy(run);
	run("npm", ["run", "build:offline"]);

	const builtVersion = run(process.execPath, [join(codingAgentDir, "dist", "cli.js"), "--version"], { capture: true });
	if (builtVersion !== version) throw new Error(`Built Pi reports ${builtVersion}, expected ${version}.`);

	if (!dependencies.tryCommand("jj", ["git", "push", "--remote", "origin", "--bookmark", retryBookmark, "--bookmark", runtimeBookmark])) {
		console.warn("Pi updated locally, but pushing the private runtime bookmarks failed.");
	}
	console.log(`Private Pi updated to ${tag}.`);
	console.log(
		"Restart any already-running Pi sessions before further prompting: the update rebuilt runtime modules in place, and a running process can mix cached modules with newly built files.",
	);
	return { kind: "updated", tag };
}

export function formatConflictOutput(result: ConflictPreservedResult, root: string): string {
	const workspaceName = `pi-update-${sanitizeName(result.version)}`;
	const workspacePath = resolve(dirname(root), workspaceName);
	return [
		"Private Pi update stopped: rebase conflicts",
		"",
		`Target: ${result.tag}`,
		"Live checkout: restored; the existing Pi installation remains usable.",
		`Conflicted candidate: ${result.candidateBookmark}`,
		`Repository: ${root}`,
		"",
		"To repair it in a separate workspace:",
		`  ${formatCommand("cd", [root])}`,
		`  ${formatCommand("jj", ["workspace", "add", workspacePath, "--name", workspaceName, "-r", result.candidateBookmark])}`,
		"",
		`Resolve conflicts in that workspace. Leave the live ${runtimeBookmark} bookmark unchanged.`,
	].join("\n");
}

export function formatRollbackFailure(error: RollbackFailedError, root: string): string {
	return [
		"Private Pi update failed while restoring the live checkout.",
		"",
		"Live checkout: UNKNOWN; it may still contain conflicts.",
		"",
		"Restore it manually:",
		`  ${formatCommand("cd", [root])}`,
		`  ${formatCommand("jj", ["op", "restore", error.preRebaseOperation])}`,
		"",
		"Conflicted candidate commit:",
		`  ${error.conflictedCommit}`,
		"",
		`Cause: ${errorMessage(error.cause)}`,
	].join("\n");
}

export function runCli(args: readonly string[] = process.argv.slice(2)): number {
	try {
		const installSpec = args[0];
		if (!installSpec || args.length !== 1) {
			throw new Error("Usage: update-private-fork.mjs <package@version>");
		}
		const result = updatePrivateFork(installSpec);
		if (result.kind === "conflict-preserved") {
			console.error(formatConflictOutput(result, repoRoot));
			return 1;
		}
		return 0;
	} catch (error) {
		if (error instanceof RollbackFailedError) {
			console.error(formatRollbackFailure(error, repoRoot));
		} else {
			console.error(`Private Pi update failed: ${errorMessage(error)}`);
		}
		return 1;
	}
}
