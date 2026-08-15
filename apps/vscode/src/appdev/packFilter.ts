// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Pack filter — selects the files a deploy zip carries.
 *
 * Walks a set of WORKSPACE-RELATIVE pack roots (the app folder plus any
 * `appManifest.include` entries) and yields every file that survives the
 * ignore rules, each addressed by the workspace-relative path it keeps
 * inside the zip. The zip mirrors the workspace tree, so relative
 * references between packed roots (an app's `../shared/src/*` tsconfig
 * mapping, a `file:` dependency) resolve after the server unpacks —
 * nothing is ever rewritten.
 *
 * Filtering follows git: a hardcoded baseline (node_modules/, dist/,
 * .git/ — enforced even when no .gitignore exists) plus the workspace's
 * `.gitignore` files applied hierarchically — every ancestor of a pack
 * root contributes its rules, and each directory entered during the walk
 * contributes its own. Ignored directories are never descended into,
 * which is also what keeps cross-file semantics aligned with git's.
 *
 * Deliberate exceptions:
 * - `*.rrapp` markers always pack — deploy provenance the receipt reads,
 *   not user content.
 * - A pack root the user NAMED wins over rules that would exclude it:
 *   any rule set that ignores the root itself is dropped for that root's
 *   walk (an explicit include is intent), while every other rule keeps
 *   filtering its contents.
 *
 * No vscode imports — pure fs/path so the walker is unit-testable and
 * portable to the browser packer's fs abstraction later.
 */

import * as fs from 'fs';
import * as path from 'path';
import ignore from 'ignore';
import type { Ignore } from 'ignore';

// =============================================================================
// TYPES
// =============================================================================

/** One file selected for the zip. */
export interface PackedFile {
	/** Workspace-relative POSIX path — the entry name inside the zip. */
	zipPath: string;
	/** Absolute path on disk to read the bytes from. */
	absPath: string;
}

/** An ignore matcher scoped to the directory whose rules it carries. */
interface ScopedMatcher {
	/** Workspace-relative POSIX dir the rules are anchored at ('' = root). */
	baseRel: string;
	/** The compiled matcher for that directory's patterns. */
	matcher: Ignore;
}

// =============================================================================
// BASELINE
// =============================================================================

/**
 * Always-on excludes, in gitignore syntax, anchored at the workspace root.
 * Slash-less dir patterns match at every depth (git semantics), so one
 * baseline matcher covers the whole tree even when no .gitignore exists.
 * `.git/` is here because a real .gitignore never lists it.
 */
const BASELINE_PATTERNS = ['node_modules/', 'dist/', '.git/'];

// =============================================================================
// MATCHING
// =============================================================================

/**
 * Loads a directory's .gitignore into a scoped matcher, or null when the
 * directory has none (or it is unreadable — treated as absent, like git).
 *
 * @param absDir - Absolute directory to probe.
 * @param baseRel - The directory's workspace-relative POSIX path.
 * @returns The scoped matcher, or null.
 */
function gitignoreMatcherOf(absDir: string, baseRel: string): ScopedMatcher | null {
	try {
		const raw = fs.readFileSync(path.join(absDir, '.gitignore'), 'utf8');
		return { baseRel, matcher: ignore().add(raw) };
	} catch {
		return null;
	}
}

/**
 * Tests a path against every matcher whose base contains it. Directories
 * are tested with a trailing slash so dir-only patterns (`dist/`) match.
 *
 * @param rel - Workspace-relative POSIX path of the entry.
 * @param isDir - Whether the entry is a directory.
 * @param matchers - Active scoped matchers, outermost first.
 * @returns true when any applicable matcher ignores the path.
 */
function isIgnored(rel: string, isDir: boolean, matchers: ScopedMatcher[]): boolean {
	for (const { baseRel, matcher } of matchers) {
		// step: scope check — a matcher only sees paths under its base dir
		let scoped: string;
		if (baseRel === '') scoped = rel;
		else if (rel.startsWith(`${baseRel}/`)) scoped = rel.slice(baseRel.length + 1);
		else continue;
		if (matcher.ignores(isDir ? `${scoped}/` : scoped)) return true;
	}
	return false;
}

// =============================================================================
// WALK
// =============================================================================

/**
 * Matchers for every .gitignore on the ancestor chain of a pack root:
 * the workspace root's, then each intermediate directory's down to (and
 * including) the root's parent. The pack root's own .gitignore is picked
 * up by the walk itself when it enters the directory.
 *
 * @param workspaceRoot - Absolute workspace root.
 * @param rootRel - Workspace-relative POSIX path of the pack root.
 * @returns Scoped matchers, outermost first.
 */
function ancestorMatchersOf(workspaceRoot: string, rootRel: string): ScopedMatcher[] {
	const matchers: ScopedMatcher[] = [];
	const root = gitignoreMatcherOf(workspaceRoot, '');
	if (root) matchers.push(root);
	// step: walk down the ancestor chain, one segment at a time
	const segments = rootRel === '' ? [] : rootRel.split('/');
	let baseRel = '';
	for (const segment of segments.slice(0, -1)) {
		baseRel = baseRel === '' ? segment : `${baseRel}/${segment}`;
		const found = gitignoreMatcherOf(path.join(workspaceRoot, baseRel), baseRel);
		if (found) matchers.push(found);
	}
	return matchers;
}

/**
 * Recursively collects the surviving files under one directory.
 *
 * @param absDir - Absolute directory being walked.
 * @param relDir - Its workspace-relative POSIX path ('' = workspace root).
 * @param workspaceRoot - Absolute workspace root (for symlink containment).
 * @param matchers - Active scoped matchers (grows as the walk descends).
 * @param visited - Real paths of directories already walked (cycle guard).
 * @param out - Collected files, keyed by zipPath for cross-root dedup.
 */
function walkDir(absDir: string, relDir: string, workspaceRoot: string, matchers: ScopedMatcher[], visited: Set<string>, out: Map<string, PackedFile>): void {
	// step: cycle guard — a symlink loop must not walk forever
	let real: string;
	try {
		real = fs.realpathSync(absDir);
	} catch {
		return;
	}
	if (visited.has(real)) return;
	visited.add(real);

	// step: this directory's own .gitignore joins the active rule set
	const own = gitignoreMatcherOf(absDir, relDir);
	const active = own ? [...matchers, own] : matchers;

	for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
		const rel = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
		const abs = path.join(absDir, entry.name);

		// step: classify, following symlinks (a junctioned shared dir is
		// legitimate); a broken link is silently skipped
		let isDir = entry.isDirectory();
		let isFile = entry.isFile();
		if (entry.isSymbolicLink()) {
			try {
				const stat = fs.statSync(abs);
				isDir = stat.isDirectory();
				isFile = stat.isFile();
			} catch {
				continue;
			}
		}

		if (isDir) {
			if (isIgnored(rel, true, active)) continue;
			walkDir(abs, rel, workspaceRoot, active, visited, out);
		} else if (isFile) {
			// step: .rrapp markers are deploy provenance — always packed
			if (!entry.name.endsWith('.rrapp') && isIgnored(rel, false, active)) continue;
			if (!out.has(rel)) out.set(rel, { zipPath: rel, absPath: abs });
		}
	}
}

// =============================================================================
// ENTRY POINT
// =============================================================================

/**
 * Collects every file the deploy zip should carry.
 *
 * @param workspaceRoot - Absolute path of the workspace folder the zip is
 *   rooted at.
 * @param packRoots - Workspace-relative POSIX paths to pack (the app
 *   folder first, then any include entries). '' packs the workspace root
 *   itself (the degenerate app-is-the-workspace case). A root may be a
 *   file or a directory; overlapping roots dedupe by zip path.
 * @returns The selected files, sorted by zipPath for deterministic zips.
 * @throws Error when a pack root does not exist.
 */
export function collectPackedFiles(workspaceRoot: string, packRoots: string[]): PackedFile[] {
	const out = new Map<string, PackedFile>();
	const visited = new Set<string>();
	const baseline: ScopedMatcher = { baseRel: '', matcher: ignore().add(BASELINE_PATTERNS) };

	for (const rootRel of packRoots) {
		const abs = rootRel === '' ? workspaceRoot : path.join(workspaceRoot, rootRel);

		// step: a named root must exist — a typo fails the pack loudly
		let stat: fs.Stats;
		try {
			stat = fs.statSync(abs);
		} catch {
			throw new Error(`Pack path "${rootRel}" does not exist in the workspace.`);
		}

		if (stat.isDirectory()) {
			// step: the named root wins over rules that would exclude it —
			// drop any rule set that ignores the root itself; every other
			// set keeps filtering the root's contents
			const candidates = [baseline, ...ancestorMatchersOf(workspaceRoot, rootRel)];
			const active = rootRel === '' ? candidates : candidates.filter((m) => !isIgnored(rootRel, true, [m]));
			walkDir(abs, rootRel, workspaceRoot, active, visited, out);
		} else if (stat.isFile()) {
			if (!out.has(rootRel)) out.set(rootRel, { zipPath: rootRel, absPath: abs });
		}
	}

	return [...out.values()].sort((a, b) => a.zipPath.localeCompare(b.zipPath));
}
