// MIT License
//
// Copyright (c) 2026 Aparavi Software AG
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

/**
 * devServerGuard — the dev server's liveness tether to its editor.
 *
 * The extension host spawns this wrapper instead of rsbuild directly; the
 * wrapper spawns rsbuild as its child and guarantees the server can never
 * outlive the editor that owns it. A window reload, crash, EDH stop, or a
 * hard kill of the extension host all close the guard's STDIN pipe (the
 * OS releases the write end with the dying process); the guard reacts by
 * felling its own process tree — dev-server orphans are structurally
 * impossible, which is what replaced boot-time orphan hunting.
 *
 * Duties:
 *   1. Die with the owner — stdin EOF (event-driven, catches every death
 *      mode) plus a slow owner-pid liveness poll as a backstop.
 *   2. Pass output through untouched — the child inherits the guard's
 *      stdout/stderr, so the extension's banner/build parsing sees
 *      rsbuild verbatim.
 *   3. Mirror the exit — the guard exits with the child's code, so the
 *      extension's crash detection treats the guard as the server.
 *
 * argv: [ownerPid, useShell(0|1), cmd, ...args]
 * cwd:  the app folder (set by the spawner).
 */

'use strict';

const { spawn } = require('child_process');

// =============================================================================
// ARGUMENTS
// =============================================================================

const [ownerPidArg, shellArg, cmd, ...args] = process.argv.slice(2);
const ownerPid = Number(ownerPidArg);

// =============================================================================
// CHILD — the actual dev server
// =============================================================================

// NOT detached: the child shares the guard's process group (the extension
// spawns the guard detached on POSIX, making the guard the group leader),
// so one group signal — from the extension's stop() or from die() below —
// fells guard and server together. Windows uses taskkill /T for the same
// whole-tree guarantee.
const child = spawn(cmd, args, {
	shell: shellArg === '1',
	stdio: ['ignore', 'inherit', 'inherit'],
	// The shell fallback runs through cmd.exe (console subsystem) — without
	// this, Windows allocates a visible console window that sits on the
	// user's desktop for the dev server's whole lifetime.
	windowsHide: true,
});

let dying = false;

/**
 * Fells the guard's own process tree, guard included — total by design:
 * the tether dropped, so nothing here may survive.
 */
function die() {
	if (dying) return;
	dying = true;
	if (process.platform === 'win32') {
		// taskkill /T on our own pid takes the child down with us.
		const killer = spawn('taskkill', ['/PID', String(process.pid), '/T', '/F'], { windowsHide: true });
		killer.on('exit', () => process.exit(1));
		killer.on('error', () => process.exit(1));
		// Never linger if taskkill wedges — exit; the poll backstop of a
		// sibling guard cannot help us, but an exited guard at least
		// releases the pipes.
		setTimeout(() => process.exit(1), 3000);
	} else {
		// Group signal: the guard is the group leader, the child is in the
		// group — one SIGKILL fells both.
		try { process.kill(-process.pid, 'SIGKILL'); } catch { /* raced our own death */ }
		process.exit(1);
	}
}

// =============================================================================
// TETHER 1 — stdin EOF (event-driven owner-death signal)
// =============================================================================

// The extension host holds the write end of this pipe for as long as it
// lives; ANY death mode releases it and EOF arrives here. resume() starts
// the read so 'end' can fire.
process.stdin.resume();
process.stdin.on('end', die);
process.stdin.on('close', die);
process.stdin.on('error', die);

// =============================================================================
// TETHER 2 — owner-pid poll (backstop for exotic stdin situations)
// =============================================================================

if (Number.isFinite(ownerPid) && ownerPid > 0) {
	const poll = setInterval(() => {
		try {
			process.kill(ownerPid, 0);
		} catch {
			die();
		}
	}, 5000);
	// The poll must not keep the guard alive once the child exits.
	poll.unref();
}

// =============================================================================
// EXIT PASSTHROUGH — the guard IS the server to its spawner
// =============================================================================

child.on('exit', (code) => {
	if (!dying) process.exit(code == null ? 1 : code);
});
child.on('error', () => {
	if (!dying) process.exit(1);
});
