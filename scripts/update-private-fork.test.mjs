import assert from "node:assert/strict";
import test from "node:test";
import { parseUpdateTarget } from "./update-private-fork.mjs";

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
