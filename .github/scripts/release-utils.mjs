#!/usr/bin/env node
// Release metadata validation (ci.yml) and npm/GitHub drift comparison (sync-check.yml).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const run = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8" }).trim();

// Versions are always X.Y.Z-external.N: [major, minor, patch, externalCounter].
const parse = (v) => {
	const m = /^(\d+)\.(\d+)\.(\d+)-external\.(\d+)$/.exec(v ?? "");
	return m ? [...m.slice(1, 4).map(Number), Number(m[4])] : null;
};

const cmp = (a, b) => {
	const [x, y] = [parse(a), parse(b)];
	if (!x || !y) return null;
	for (let i = 0; i < 4; i += 1) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
	return 0;
};

// Core bumps (patch/minor/major) must reset to external.0; same-core publishes
// increment the external counter.
const bump = (from, to) => {
	const [a, b] = [parse(from), parse(to)];
	if (!a || !b) return null;
	if (b[0] === a[0] && b[1] === a[1] && b[2] === a[2]) {
		return b[3] === a[3] + 1 ? "prerelease" : null;
	}
	if (b[3] !== 0) return null;
	if (b[0] === a[0] + 1 && b[1] === 0 && b[2] === 0) return "major";
	if (b[0] === a[0] && b[1] === a[1] + 1 && b[2] === 0) return "minor";
	if (b[0] === a[0] && b[1] === a[1] && b[2] === a[2] + 1) return "patch";
	return null;
};

const fail = (msg) => {
	console.error(`release check failed: ${msg}`);
	process.exit(1);
};

const readVersion = (rev) => JSON.parse(run("git", ["show", `${rev}:package.json`])).version;

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
// Entries whose change means the published tarball changed.
const shippedEntries = [...(pkg.files ?? []), "package.json", "package-lock.json"].map((f) =>
	f.replace(/\/+$/, ""),
);

const matchShipped = (changed, entries) =>
	changed.filter((f) => entries.some((e) => f === e || f.startsWith(`${e}/`)));

const publishedVersion = () => {
	try {
		return run("npm", ["view", pkg.name, "version"]);
	} catch {
		fail(`could not read ${pkg.name}'s published version from npm; check registry access`);
	}
};

const mode = process.argv[2];

if (mode === "selftest") {
	const cases = [
		[cmp("1.9.0-external.0", "1.9.0-external.1"), -1],
		[cmp("1.9.0-external.1", "1.9.0-external.0"), 1],
		[cmp("1.9.0-external.5", "1.10.0-external.0"), -1],
		[cmp("1.9.0-external.0", "1.9.0-external.0"), 0],
		[cmp("1.9.0-external.0", "1.9.0"), null],
		[bump("1.9.0-external.0", "1.9.0-external.1"), "prerelease"],
		[bump("1.9.0-external.1", "1.10.0-external.0"), "minor"],
		[bump("1.9.0-external.0", "1.9.1-external.0"), "patch"],
		[bump("1.9.0-external.0", "2.0.0-external.0"), "major"],
		[bump("1.9.0-external.0", "1.9.0-external.0"), null],
		[bump("1.9.0-external.0", "1.9.0-external.2"), null],
		[bump("1.9.0-external.0", "1.11.0-external.0"), null],
		[bump("1.9.0-external.0", "1.10.0"), null],
		[bump("1.9.0-external.0", "1.10.0-external.1"), null],
		[
			matchShipped(
				["src/a.ts", "docs/field-testing.md", "test/a.test.ts", "docs/design.md", "README.md"],
				["src", "docs/field-testing.md", "README.md"],
			).join(","),
			"src/a.ts,docs/field-testing.md,README.md",
		],
	];
	for (const [got, want] of cases) {
		if (got !== want) fail(`selftest: got ${got}, want ${want}`);
	}
	console.log("selftest ok");
} else if (mode === "gt") {
	const [a, b] = process.argv.slice(3);
	const result = cmp(a, b);
	if (result === null) {
		console.error(`cannot compare versions: ${a} / ${b}`);
		process.exit(2);
	}
	process.exit(result === 1 ? 0 : 1);
} else if (mode === "validate") {
	if (!process.env.BASE_SHA || !process.env.HEAD_SHA) fail("BASE_SHA and HEAD_SHA are required");
	const published = publishedVersion();
	const next = readVersion("HEAD");
	const labels = JSON.parse(process.env.LABELS || "[]");
	const releaseLabels = labels.filter((l) => l.startsWith("release:") && l !== "release:none");
	if (labels.includes("release:none") && releaseLabels.length > 0) {
		fail(`release:none cannot be combined with ${releaseLabels.join(", ")}`);
	}
	if (labels.includes("release:none") && cmp(next, published) !== 0) {
		fail(`release:none but package.json is ${next} (published ${published}); remove the label or the bump`);
	}
	if (releaseLabels.length > 1) fail(`multiple release labels: ${releaseLabels.join(", ")}`);

	if (cmp(next, published) === 0) {
		if (labels.includes("release:none")) {
			console.log("release:none; no release");
			process.exit(0);
		}
		const changed = run("git", [
			"diff",
			"--name-only",
			`${process.env.BASE_SHA}...${process.env.HEAD_SHA}`,
		]).split("\n");
		const shipped = matchShipped(changed, shippedEntries);
		if (shipped.length > 0) {
			fail(
				`shipped files changed (${shipped.join(", ")}) but package.json is still ${next}. ` +
					`Run "npm version <type> --no-git-tag-version" (versions are X.Y.Z-external.N), add a "## [X.Y.Z-external.N]" CHANGELOG section, ` +
					`or label the PR release:none.`,
			);
		}
		console.log("docs/CI-only change; no release");
		process.exit(0);
	}

	const level = bump(published, next);
	if (!level) {
		fail(
			`${next} is not a clean patch/minor/major/prerelease bump from published ${published}; ` +
				`versions must be X.Y.Z-external.N (core bumps reset to external.0, same-core publishes increment it)`,
		);
	}
	if (releaseLabels.length === 1 && releaseLabels[0] !== `release:${level}`) {
		fail(`label ${releaseLabels[0]} does not match the ${level} bump ${published} -> ${next}`);
	}

	const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
	if (lock.version !== next || lock.packages?.[""]?.version !== next) {
		fail("package-lock.json version is out of sync; run npm install");
	}
	if (!new RegExp(`^## \\[${next.replace(/\./g, "\\.")}\\]`, "m").test(readFileSync("CHANGELOG.md", "utf8"))) {
		fail(`CHANGELOG.md has no "## [${next}]" section`);
	}
	console.log(`release ${published} -> ${next} (${level})`);
} else {
	fail("usage: release-utils.mjs selftest|validate|gt <a> <b>");
}
