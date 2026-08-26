import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	formatConflictOutput,
	formatRollbackFailure,
	parseUpdateTarget,
	rebasePrivateRuntime,
	RollbackFailedError,
	type RunCommand,
	updatePrivateFork,
} from "./update-private-fork.ts";

function runInRepository(root: string): RunCommand {
	return (command, args, options = {}) => {
		const result = spawnSync(command, args, {
			cwd: options.cwd ?? root,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		if (result.error) throw result.error;
		if (result.status !== 0) {
			throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr.trim()}`);
		}
		return options.capture ? result.stdout.trim() : "";
	};
}

function runJj(run: RunCommand, args: readonly string[]): string {
	return run("jj", args, { capture: true });
}

test("parses stable and prerelease Pi package targets", () => {
	assert.deepEqual(parseUpdateTarget("@earendil-works/pi-coding-agent@1.2.3"), {
		version: "1.2.3",
		tag: "v1.2.3",
	});
	assert.deepEqual(parseUpdateTarget("@earendil-works/pi-coding-agent@1.2.3-rc.1+build.4"), {
		version: "1.2.3-rc.1+build.4",
		tag: "v1.2.3-rc.1+build.4",
	});
});

test("rejects unversioned update targets", () => {
	assert.throws(
		() => parseUpdateTarget("@earendil-works/pi-coding-agent"),
		/Expected a versioned Pi package spec/,
	);
});

test("rejects an already-conflicted live checkout", () => {
	const commands: string[][] = [];
	const run: RunCommand = (_command, args) => {
		commands.push([...args]);
		if (args[0] === "log" && args[5] === "empty") return "true";
		if (args[0] === "log" && args[5] === "conflict") return "true";
		throw new Error(`Unexpected command arguments: ${args.join(" ")}`);
	};

	assert.throws(
		() =>
			updatePrivateFork("@earendil-works/pi-coding-agent@1.2.3", {
				runCommand: run,
				tryCommand: () => true,
				readCodingAgentVersion: () => "1.2.3",
			}),
		/already contains unresolved conflicts/,
	);
	assert.equal(commands.some((args) => args[0] === "rebase"), false);
});
test("preserves a conflicted rebase and restores the live checkout", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-private-update-"));
	try {
		const run = runInRepository(root);
		runJj(run, ["git", "init", "."]);
		runJj(run, ["config", "set", "--repo", "user.name", "Pi updater test"]);
		runJj(run, ["config", "set", "--repo", "user.email", "pi-updater@example.invalid"]);

		const fixturePath = join(root, "fixture.txt");
		await writeFile(fixturePath, "base\n");
		runJj(run, ["commit", "-m", "base"]);
		runJj(run, ["bookmark", "create", "base", "-r", "@-"]);

		await writeFile(fixturePath, "upstream\n");
		runJj(run, ["commit", "-m", "upstream"]);
		runJj(run, ["bookmark", "create", "v1.2.3", "-r", "@-"]);

		runJj(run, ["new", "base"]);
		await writeFile(fixturePath, "private\n");
		runJj(run, ["commit", "-m", "private"]);
		runJj(run, ["bookmark", "create", "private-runtime", "-r", "@-"]);
		runJj(run, ["new", "private-runtime"]);

		const liveRuntimeBefore = runJj(run, ["log", "-r", "private-runtime", "--no-graph", "-T", "commit_id"]);
		const commands: Array<{ command: string; args: readonly string[] }> = [];
		const recordingRun: RunCommand = (command, args, options) => {
			commands.push({ command, args });
			if (command === "jj" && args[0] === "git" && args[1] === "fetch") return "";
			return run(command, args, options);
		};
		let readVersionCalled = false;
		let pushCalled = false;

		const result = updatePrivateFork("@earendil-works/pi-coding-agent@1.2.3", {
			runCommand: recordingRun,
			tryCommand: () => {
				pushCalled = true;
				return true;
			},
			readCodingAgentVersion: () => {
				readVersionCalled = true;
				return "1.2.3";
			},
		});

		assert.equal(result.kind, "conflict-preserved");
		if (result.kind !== "conflict-preserved") throw new Error("Expected a preserved conflict result.");
		assert.equal(await readFile(fixturePath, "utf8"), "private\n");
		assert.equal(
			runJj(run, ["log", "-r", "private-runtime", "--no-graph", "-T", "commit_id"]),
			liveRuntimeBefore,
		);
		assert.equal(runJj(run, ["log", "-r", result.candidateBookmark, "--no-graph", "-T", "conflict"]), "true");
		assert.equal(readVersionCalled, false);
		assert.equal(pushCalled, false);
		assert.equal(commands.some(({ command }) => command === "npm"), false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("reports the exact manual restore command when rollback fails", () => {
	const candidateCommit = "435171ac27a1384d5ada471ce49efb226c6a3cbc";
	const run: RunCommand = (_command, args) => {
		if (args[0] === "op" && args[1] === "log") return "064513794a9a";
		if (args[0] === "rebase") return "";
		if (args[0] === "log" && args[2]?.startsWith("conflicts()")) return candidateCommit;
		if (args[0] === "log" && args[2] === "private-runtime") return candidateCommit;
		if (args[0] === "op" && args[1] === "restore") throw new Error("restore failed");
		throw new Error(`Unexpected command arguments: ${args.join(" ")}`);
	};

	let failure: unknown;
	try {
		rebasePrivateRuntime("1.2.3", "v1.2.3", run);
	} catch (error) {
		failure = error;
	}
	assert.ok(failure instanceof RollbackFailedError);

	const output = formatRollbackFailure(failure, "/tmp/pi-mono");
	assert.match(output, /Live checkout: UNKNOWN/);
	assert.match(output, /jj op restore 064513794a9a/);
	assert.match(output, new RegExp(candidateCommit));
});

test("conflict output names the candidate and repair workspace command", () => {
	const output = formatConflictOutput(
		{
			kind: "conflict-preserved",
			version: "1.2.3",
			tag: "v1.2.3",
			candidateBookmark: "private-runtime-update-v1.2.3-435171ac",
			candidateCommit: "435171ac27a1384d5ada471ce49efb226c6a3cbc",
			preRebaseOperation: "064513794a9a",
		},
		"/tmp/pi-mono",
	);

	assert.match(output, /Live checkout: restored/);
	assert.match(output, /private-runtime-update-v1\.2\.3-435171ac/);
	assert.match(
		output,
		/jj workspace add \/tmp\/pi-update-1\.2\.3 --name pi-update-1\.2\.3 -r private-runtime-update-v1\.2\.3-435171ac/,
	);
});
