// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * WatchManager — the App Builder inner loop's engine room.
 *
 * Per app: runs `rsbuild dev` in the app's folder (serves the MF remote on
 * its dev port and rebuilds on save), parses the process output for the dev
 * URL and build results, keeps the developer's PERSONAL dev overlay pointed
 * at the served bundle via `rrext_deploy_app.register_dev` (re-registered
 * on every rebuild — that also keeps the overlay's idle TTL alive), and
 * notifies the App Builder panel: watch status for the DEV badge, and a
 * debounced preview reload on each successful rebuild.
 *
 * Lifecycle: started when an App Builder panel opens (setting-gated by
 * `rocketride.appdev.autoWatch`), stopped when the panel closes or the
 * extension deactivates. Stopping unregisters the overlay entry so the
 * shell drops the dev bundle.
 */

import * as vscode from 'vscode';
import { spawn, ChildProcess } from 'child_process';
import { ConnectionManager } from '../connection/connection';
import { extractInstallCause, isTransientLockError } from './appTypes';
import { getLogger } from '../shared/util/output';
import type { ScannedApp } from './appScan';
import type { AppScreenProvider, AppWatchStatus } from '../providers/AppScreenProvider';

// =============================================================================
// TYPES
// =============================================================================

/** One running watch session. */
interface WatchSession {
	app: ScannedApp;
	/** The spawned dev-server tree; absent for an ADOPTED orphan (see
	    adoptOrClearPort) — adopted sessions are stopped by adoptedPids. */
	proc?: ChildProcess;
	/** The discovered process ids of an ADOPTED orphan's tree — stop()
	    tree-kills exactly these, never "whatever holds the port now". */
	adoptedPids?: number[];
	/** Dev server origin once parsed from output (http://localhost:<port>). */
	devOrigin?: string;
	/** Rebuild-reload debounce timer. */
	reloadTimer?: NodeJS.Timeout;
	/** Millisecond stamp when the current build started (for the badge). */
	buildStart?: number;
	/** Watches the app's package.json — a dep edit reinstalls and restarts. */
	pkgWatcher?: vscode.FileSystemWatcher;
	/** Debounce timer for package.json change bursts. */
	pkgTimer?: NodeJS.Timeout;
	/** Incomplete trailing line carried over between output chunks. */
	pending?: string;
	/** Deferred-teardown timer while the session LINGERS after its panel
	    closed; a reopen inside the window cancels it and revives. */
	lingerTimer?: NodeJS.Timeout;
	/** Identifies the CURRENT linger. The deferred teardown carries the token
	    it was scheduled with and only fires when the app's live session still
	    bears it — a revive clears it, and a replacement session (an exit +
	    fresh start) never inherits it, so an already-expired linger can never
	    tear down a session the user just reopened. */
	lingerToken?: number;
}

// =============================================================================
// MANAGER
// =============================================================================

export class WatchManager {
	private sessions = new Map<string, WatchSession>();
	/**
	 * THE CATALOG DISCIPLINE: every lifecycle operation for an app —
	 * start, stop, restart — is appended to that app's serialized chain
	 * and runs alone. Interleaving is impossible by construction (no
	 * "stop raced a half-started spawn", no double-spawn windows), and a
	 * stop issued during a start simply runs right after it — exactly the
	 * user's intent when closing a still-spinning panel.
	 */
	private chains = new Map<string, Promise<unknown>>();
	/** Per-app readiness: resolves with the dev origin once the server is
	    actually serving (spawned+parsed or adopted); replaced per start. */
	private readiness = new Map<string, { promise: Promise<string>; resolve: (origin: string) => void; reject: (err: Error) => void }>();
	/** Burst-shared discovery snapshot: rapid open-all fires many starts;
	    one OS enumeration serves them all instead of N concurrent probes. */
	private discoveryMemo: { at: number; promise: Promise<Map<string, Array<{ port: number; pids: number[] }>>> } | null = null;
	/** First lookup accepts the lazy boot prewarm's older snapshot — before
	    our first spawn, orphans cannot have changed underneath it. */
	private firstDiscovery = true;
	/**
	 * Serialized single-flight memo for the WORKSPACE-GLOBAL install. Concurrent
	 * watch starts for several apps await the SAME `pnpm install` at the
	 * workspace root (the apps are workspace members sharing one node_modules),
	 * and two installs must NEVER overlap — concurrent pnpm runs on one root
	 * corrupt the store and trip EPERM on Windows during pnpm's atomic renames.
	 *
	 * `installGen` is the generation the workspace currently WANTS installed;
	 * invalidateInstall() bumps it (a package.json change or a rewired shell
	 * spec). `install` memoizes the run for one generation: when its gen matches
	 * installGen the memo is reused (concurrent starts collapse into one); when
	 * a newer generation is requested the fresh run is CHAINED onto the tail of
	 * any in-flight one rather than started concurrently.
	 */
	private install: { gen: number; promise: Promise<boolean> } | null = null;
	private installGen = 0;
	/** Monotonic source of linger tokens (see WatchSession.lingerToken). */
	private lingerSeq = 0;
	private connectionManager = ConnectionManager.getInstance();
	private logger = getLogger();

	constructor(private readonly appScreen: AppScreenProvider) {}

	// =========================================================================
	// PUBLIC
	// =========================================================================

	/** Whether a watch session is running for an app. */
	public isRunning(appId: string): boolean {
		return this.sessions.has(appId);
	}

	/**
	 * Marks the shared workspace install stale so the next start (or an explicit
	 * ensureInstalled) runs `pnpm install` again — called when a package.json
	 * changes or a fresh app is scaffolded into the workspace.
	 *
	 * Bumps the generation rather than dropping an in-flight install: the
	 * running pnpm keeps going and the fresh install CHAINS after it (see
	 * ensureInstalled), so two installs never race on the shared node_modules.
	 */
	public invalidateInstall(): void {
		this.installGen++;
	}

	/**
	 * Ensures the workspace-global install has run (single-flight). Safe to
	 * call from anywhere — scaffolding uses it to link a brand-new app
	 * without waiting for a watch session.
	 *
	 * @param triggerAppId - The app whose console carries the install output.
	 * @returns True when the install succeeded (or was already done).
	 */
	public ensureInstalled(triggerAppId?: string): Promise<boolean> {
		// Reuse the memo when it already targets the generation the workspace
		// wants — this collapses concurrent starts at the same generation into
		// a single install.
		if (this.install && this.install.gen === this.installGen) return this.install.promise;

		// A newer generation is wanted (or nothing has installed yet): run a
		// FRESH install, but CHAIN it after any in-flight one so two pnpm
		// processes never touch the shared node_modules at once. A superseded
		// in-flight install still runs to completion (cancelling mid-rename is
		// what corrupts the store); its result is simply discarded — only this
		// run, targeting `gen`, decides the outcome.
		const gen = this.installGen;
		const prior = this.install?.promise ?? Promise.resolve(true);
		const promise = prior
			.catch(() => false)
			.then(() => this.runWorkspaceInstall(triggerAppId))
			.then((ok) => {
				// A failed install at the still-current generation must not be
				// memoized as done — drop it so the next start retries. If a
				// newer generation has already superseded this run, leave the
				// memo (now pointing at that newer run) untouched.
				if (!ok && this.install?.gen === gen) this.install = null;
				return ok;
			});
		this.install = { gen, promise };
		return promise;
	}

	/**
	 * Starts (or reuses) the watch session for an app.
	 *
	 * Awaits the shared workspace install first: package.json may have
	 * changed since the last session (or the app may be freshly scaffolded
	 * with no node_modules at all); the single-flight memo makes concurrent
	 * starts share one `pnpm install`. Only then does `rsbuild dev` spawn.
	 *
	 * @param app - The scanned workspace app to watch.
	 */
	public start(app: ScannedApp): Promise<void> {
		return this.enqueue(app.id, () => this.doStart(app));
	}

	/**
	 * Awaitable readiness for an app's dev server: resolves with the served
	 * origin (http://localhost:<port>) once it is actually serving —
	 * spawned-and-parsed or adopted. Rejects when the start fails or the
	 * session is stopped first. Undefined when the app was never started.
	 *
	 * @param appId - The app to await.
	 */
	public whenReady(appId: string): Promise<string> | undefined {
		return this.readiness.get(appId)?.promise;
	}

	/**
	 * Appends an operation to the app's serialized chain (see `chains`).
	 * Failures propagate to THIS caller but never break the chain for the
	 * next operation.
	 */
	private enqueue<T>(appId: string, op: () => Promise<T>): Promise<T> {
		const prev = this.chains.get(appId) ?? Promise.resolve();
		const next = prev.then(op, op);
		this.chains.set(appId, next.catch(() => undefined));
		return next;
	}

	/** Installs a fresh (pending) readiness record for a start attempt. */
	private createReadiness(appId: string): void {
		let resolve!: (origin: string) => void;
		let reject!: (err: Error) => void;
		const promise = new Promise<string>((res, rej) => { resolve = res; reject = rej; });
		// Nobody is obliged to await readiness — swallow the rejection so an
		// unawaited failed start never surfaces as an unhandled rejection.
		promise.catch(() => undefined);
		this.readiness.set(appId, { promise, resolve, reject });
	}

	/** Settles the app's readiness with its served origin (no-op if settled). */
	private resolveReadiness(appId: string, origin: string): void {
		this.readiness.get(appId)?.resolve(origin);
	}

	/** Fails the app's readiness (no-op when already settled). */
	private rejectReadiness(appId: string, reason: string): void {
		this.readiness.get(appId)?.reject(new Error(reason));
	}

	/** The start transition — runs alone on the app's chain. */
	private async doStart(app: ScannedApp): Promise<void> {
		const existing = this.sessions.get(app.id);
		if (existing) {
			// LINGER REVIVE: the panel closed and reopened inside the grace
			// window — the server never stopped, so reopening is instant:
			// cancel the deferred teardown and re-announce the live server.
			if (existing.lingerTimer) {
				clearTimeout(existing.lingerTimer);
				existing.lingerTimer = undefined;
				// Drop the token so an already-fired linger's queued teardown
				// (which captured the old token) no longer matches this session.
				existing.lingerToken = undefined;
				this.logger.output(`[appdev] revived lingering dev server for ${app.id}`);
				this.console(app.id, 'log', 'reopened within the linger window — reusing the running dev server');
				this.notify(app.id, { state: 'ok', target: existing.devOrigin?.replace(/^https?:\/\//, '') });
				this.notifyDevEntry(existing);
				void this.registerOverlay(existing);
				this.scheduleReload(existing);
			}
			return;
		}

		// Fresh readiness for this start attempt; consumers awaiting the
		// previous (stopped) session's promise were already settled.
		this.createReadiness(app.id);

		// Dependencies first (single-flight across concurrent app starts).
		const installed = await this.ensureInstalled(app.id);
		if (!installed) {
			this.rejectReadiness(app.id, 'workspace install failed');
			return;
		}

		// Port reconciliation BEFORE spawning: the extension host can die
		// without cleanup (window reload, crash), orphaning the previous
		// dev-server tree — Windows never cascades to grandchildren. A blind
		// spawn then loses the port race, rsbuild silently bumps to the next
		// free port, and the preview stays registered against the orphan's
		// stale bundle (the unkillable reload loop). Reconcile by DISCOVERY
		// (ports are dynamic — bumped servers drift, so a configured-port
		// probe would shoot the wrong app): enumerate live rsbuild processes,
		// identify each by its mf-manifest name, and adopt THIS app's orphan
		// at whatever port it actually holds; duplicates of this app are
		// tree-killed; other apps' servers are never touched.
		if (await this.adoptOrClearPort(app)) return;

		// Resolve the app-local rsbuild binary; the scaffolder pins it as a
		// devDependency. Falling back to `pnpm exec` covers hoisted setups.
		const spawnArgs = this.resolveRsbuild(app.folder);
		this.logger.output(`[appdev] watch start: ${app.id} (${spawnArgs.cmd} ${spawnArgs.args.join(' ')})`);
		this.console(app.id, 'log', '$ rsbuild dev');

		const proc = spawn(spawnArgs.cmd, [...spawnArgs.args, 'dev'], {
			cwd: app.folder,
			shell: spawnArgs.shell,
			env: { ...process.env, NO_COLOR: '1' },
			// POSIX: make the dev server its own process GROUP so stop() can
			// signal the whole tree (kill(-pid)) — signalling a single pid
			// only fells the pnpm wrapper and orphans the rsbuild grandchild,
			// the same zombie Windows gets without taskkill /T.
			detached: process.platform !== 'win32',
		});

		const session: WatchSession = { app, proc, buildStart: Date.now() };
		this.sessions.set(app.id, session);
		this.notify(app.id, { state: 'building' });

		// package.json watcher: a dependency edit invalidates the shared
		// install and restarts THIS session (other apps' dev servers survive
		// a root install — pnpm only rewrites the changed project's links).
		// The install/restart loop DOES write package.json (the App Builder
		// open path rewires the shell spec via ensureShellDependency), but it
		// terminates: the rewrite early-returns once the spec is correct, so
		// the watcher fires at most one extra cycle. Disposed in stop() so
		// watcher lifetime tracks the session. Known edge: an edit landing
		// while the install is mid-flight is swallowed by the starting guard —
		// accepted (the debounce makes it rare, and the preview Reload button
		// recovers).
		session.pkgWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(app.folder), 'package.json'));
		const onPkgChange = (): void => {
			if (session.pkgTimer) clearTimeout(session.pkgTimer);
			session.pkgTimer = setTimeout(() => {
				this.logger.output(`[appdev] package.json changed: ${app.id} — reinstalling and restarting`);
				this.invalidateInstall();
				void this.restart(app);
			}, 800);
		};
		session.pkgWatcher.onDidChange(onPkgChange);
		session.pkgWatcher.onDidCreate(onPkgChange);

		// Parse stdout for the dev origin and build results
		proc.stdout?.on('data', (chunk: Buffer) => this.handleOutput(session, chunk.toString('utf8')));
		proc.stderr?.on('data', (chunk: Buffer) => this.handleOutput(session, chunk.toString('utf8')));

		proc.on('exit', (code) => {
			this.logger.output(`[appdev] watch exited (${code}): ${app.id}`);
			if (this.sessions.get(app.id) === session) {
				this.sessions.delete(app.id);
				this.rejectReadiness(app.id, `dev server exited (${code})`);
				this.notify(app.id, { state: 'idle' });
			}
		});
		proc.on('error', (err) => {
			this.logger.output(`[appdev] watch failed to start: ${app.id}: ${err.message}`);
			// Only tear down the entry this handler still owns — a restart may
			// have replaced the session under the same app id (same guard as exit).
			if (this.sessions.get(app.id) === session) {
				this.sessions.delete(app.id);
				this.rejectReadiness(app.id, err.message);
				this.notify(app.id, { state: 'error' });
			}
		});
	}

	/**
	 * Stops an app's watch session and drops its dev-overlay entry.
	 *
	 * Default (panel close) is a LINGERING stop: the server keeps running
	 * for a grace window so reopening the .rrapp is instant — a very common
	 * flow while iterating. The teardown only executes when the window
	 * expires unrevived. `immediate` (restart, deactivation) skips the
	 * grace and tears down now.
	 *
	 * @param appId - The app to stop watching.
	 * @param opts - immediate: tear down now, no linger.
	 */
	public stop(appId: string, opts?: { immediate?: boolean }): Promise<void> {
		// Chained after any in-flight start: closing a still-spinning panel
		// stops the session the moment it exists — never a missed kill.
		return this.enqueue(appId, () => this.doStop(appId, opts?.immediate === true));
	}

	/** Grace window a closed panel's dev server keeps running (revive-on-reopen). */
	private static readonly LINGER_MS = 60_000;

	/** The stop transition — runs alone on the app's chain. */
	private async doStop(appId: string, immediate: boolean): Promise<void> {
		const session = this.sessions.get(appId);
		if (!session) return;

		if (!immediate) {
			// LINGER: leave the server (and its overlay registration) running;
			// schedule the real teardown. A reopen inside the window cancels
			// it (doStart's revive path) and reuses the live server.
			if (session.lingerTimer) return; // already lingering
			// Stamp this linger with a token; the deferred teardown captures it
			// and only tears down while the live session still bears the same
			// token (guards a session the user reopened after the timer fired).
			const token = ++this.lingerSeq;
			session.lingerToken = token;
			this.logger.output(`[appdev] ${appId}: panel closed — dev server lingers ${WatchManager.LINGER_MS / 1000}s for a fast reopen`);
			session.lingerTimer = setTimeout(() => {
				session.lingerTimer = undefined;
				void this.enqueue(appId, () => this.doLingerExpiry(appId, token));
			}, WatchManager.LINGER_MS);
			return;
		}

		if (session.lingerTimer) {
			clearTimeout(session.lingerTimer);
			session.lingerTimer = undefined;
		}
		session.lingerToken = undefined;
		this.rejectReadiness(appId, 'watch stopped');
		this.sessions.delete(appId);
		if (session.reloadTimer) clearTimeout(session.reloadTimer);
		if (session.pkgTimer) clearTimeout(session.pkgTimer);
		session.pkgWatcher?.dispose();
		try {
			// Windows: kill() only reaches the immediate process — rsbuild's
			// children (the dev server) survive and squat the port across
			// reloads. taskkill /T fells the whole tree — and it must be
			// AWAITED: restart() runs stop()→start() back-to-back, and a
			// fire-and-forget kill races the new spawn. The old server still
			// holds the configured port, rsbuild silently bumps the new one
			// to the next free port, and the preview's registration keeps
			// pointing at the ZOMBIE's stale bundle — an unkillable reload
			// loop that survives every watch restart.
			if (!session.proc) {
				// Adopted orphan — no process handle; tree-kill the discovered
				// pids (never by port: the port may have been re-assigned to a
				// different app's server since adoption).
				await this.killPids(session.adoptedPids ?? []);
			} else if (process.platform === 'win32' && session.proc.pid) {
				const pid = session.proc.pid;
				await new Promise<void>((resolve) => {
					const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F']);
					killer.on('exit', () => resolve());
					killer.on('error', () => resolve());
					// Never hang stop() on a wedged taskkill.
					setTimeout(resolve, 3000);
				});
			} else if (session.proc.pid) {
				// POSIX: signal the process GROUP (negative pid — the spawn is
				// detached, so the tree is its own group), then escalate. A
				// bare proc.kill() would orphan the rsbuild grandchild.
				const pid = session.proc.pid;
				try {
					process.kill(-pid, 'SIGTERM');
				} catch {
					session.proc.kill();
				}
				await new Promise<void>((resolve) => setTimeout(resolve, 1500));
				try {
					process.kill(-pid, 'SIGKILL');
				} catch { /* group already gone — the normal case */ }
			} else {
				session.proc.kill();
			}
		} catch { /* already gone */ }

		// Drop the overlay entry so the shell returns to the published bundle
		try {
			const client = this.connectionManager.getClient();
			if (client && this.connectionManager.isConnected()) {
				await client.call('rrext_deploy_app', { subcommand: 'register_dev', moduleId: session.app.moduleId, unregister: true });
			}
		} catch { /* engine gone — the overlay's disconnect expiry covers it */ }
		this.notify(appId, { state: 'idle' });
	}

	/**
	 * The deferred teardown a lingering stop schedules, gated on its token.
	 *
	 * It only proceeds when the app's CURRENT session is still the one that
	 * scheduled this linger (same token). A revive clears the token, and a
	 * replacement session — the previous server exiting on its own, then a
	 * fresh start racing behind this already-fired timer — never inherits it,
	 * so a stale linger cannot tear down a session the user just reopened.
	 *
	 * @param appId - The app whose linger is expiring.
	 * @param token - The token stamped when this linger was scheduled.
	 */
	private async doLingerExpiry(appId: string, token: number): Promise<void> {
		const session = this.sessions.get(appId);
		if (!session || session.lingerToken !== token) return;
		await this.doStop(appId, true);
	}

	/**
	 * Full session restart: kill the running dev server, reinstall deps, and
	 * spawn a fresh `rsbuild dev`. The preview Reload button routes here so a
	 * package.json edit (or a wedged dev server) is one click away from a
	 * clean state; the rebuilt bundle triggers the normal debounced preview
	 * reload when the new server reports its first successful build.
	 *
	 * @param app - The app whose session should restart.
	 */
	public async restart(app: ScannedApp): Promise<void> {
		// A restart's whole point is a FRESH server — never linger the old one.
		await this.stop(app.id, { immediate: true });
		await this.start(app);
	}

	/** Stops every session (extension deactivation) — no linger on exit. */
	public dispose(): void {
		for (const appId of [...this.sessions.keys()]) void this.stop(appId, { immediate: true });
	}

	// =========================================================================
	// PORT RECONCILIATION — adopt-or-kill before every spawn
	// =========================================================================

	/**
	 * Reconciles orphaned dev servers for THIS app before spawning one.
	 *
	 * Ports are DYNAMIC (a taken port makes rsbuild bump to the next free
	 * one, so servers drift from their configured ports across restarts) —
	 * a configured-port probe would misidentify a drifted neighbor and
	 * shoot the wrong app. Discovery goes the other way around:
	 *
	 *   1. Enumerate live rsbuild processes and the ports each one is
	 *      ACTUALLY listening on (OS truth, no assumptions).
	 *   2. Identify every candidate by its ``mf-manifest.json`` name (the
	 *      MF container name — a real identity check).
	 *   3. Exactly one server identifying as THIS app → ADOPT it at its
	 *      actual port: the orphan still watches the same source tree, so
	 *      it is not stale, and adoption is instant where a respawn waits
	 *      out a full build. Duplicates of this app → tree-kill them all
	 *      and spawn fresh. Other apps' servers are NEVER touched — they
	 *      are adopted (or cleaned) when their own watch starts.
	 *
	 * Adopted sessions carry no process handle: build telemetry (the DEV
	 * badge's building/ok ticks) resumes on the next owned spawn — the
	 * panel's Reload button routes through restart(), which tree-kills the
	 * adopted pids and respawns an owned server.
	 *
	 * @param app - The app about to be watched.
	 * @returns True when a running server was adopted (caller skips spawn).
	 */
	private async adoptOrClearPort(app: ScannedApp): Promise<boolean> {
		const inventory = await this.discoverDevServers();
		const mine = inventory.get(app.moduleId);
		if (!mine || mine.length === 0) return false;

		if (mine.length > 1) {
			// Two servers claiming one container = the zombie-duplicate state
			// (each preview registration can only point at one) — clear them
			// all and start owned.
			const pids = mine.flatMap((c) => c.pids);
			this.logger.output(`[appdev] ${app.id}: ${mine.length} duplicate dev servers found — clearing pids ${pids.join(', ')}`);
			this.console(app.id, 'warn', `found ${mine.length} duplicate dev servers — killing and respawning`);
			await this.killPids(pids);
			return false;
		}

		// Identity confirmed and unique — adopt at its ACTUAL port.
		const found = mine[0];
		this.logger.output(`[appdev] adopted running dev server for ${app.id} at port ${found.port} (pids ${found.pids.join(', ')})`);
		this.console(app.id, 'log', `adopted running dev server on port ${found.port} (no rebuild needed)`);
		const session: WatchSession = { app, devOrigin: `http://localhost:${found.port}`, adoptedPids: found.pids };
		this.sessions.set(app.id, session);
		this.resolveReadiness(app.id, session.devOrigin!);
		this.notify(app.id, { state: 'ok', target: `localhost:${found.port}` });
		this.notifyDevEntry(session);
		void this.registerOverlay(session);
		this.scheduleReload(session);
		return true;
	}

	/**
	 * Discovers live MF dev servers: every rsbuild-ish node process, the
	 * ports it actually LISTENS on, identified per port by mf-manifest.
	 *
	 * Orphans exist on every OS — an abruptly killed extension host never
	 * cascades to grandchildren on Windows OR POSIX. Only the enumeration
	 * mechanism differs per platform; a failed enumeration degrades to an
	 * empty inventory (start() then spawns exactly as before).
	 *
	 * @returns moduleId -> [{port, pids}] for every identified server.
	 */
	private async discoverDevServers(): Promise<Map<string, Array<{ port: number; pids: number[] }>>> {
		// Burst sharing: an open-all fires many starts within seconds; each
		// would otherwise run its own OS enumeration (concurrent PowerShell
		// probes are what made rapid multi-open hang). One snapshot serves
		// the whole burst — taken before any of the burst's spawns, so every
		// adoption decision still sees only true orphans. Each app looks up
		// ONLY its own moduleId, so burst siblings absent from the snapshot
		// are irrelevant (their spawns are guarded per-app anyway).
		const now = Date.now();
		// The FIRST lookup accepts the lazy boot prewarm's older snapshot:
		// before our first spawn nothing can have changed underneath it, so
		// the first panel open skips the enumeration wait entirely.
		const maxAge = this.firstDiscovery ? 30_000 : 3_000;
		this.firstDiscovery = false;
		if (this.discoveryMemo && now - this.discoveryMemo.at < maxAge) return this.discoveryMemo.promise;
		const promise = this.discoverDevServersUncached();
		this.discoveryMemo = { at: now, promise };
		return promise;
	}

	/**
	 * Lazy boot prewarm (fire-and-forget from activation): take the orphan
	 * inventory once in the background so the first App Builder open adopts
	 * instantly instead of paying the enumeration round trip.
	 */
	public prewarmDiscovery(): void {
		const promise = this.discoverDevServersUncached();
		this.discoveryMemo = { at: Date.now(), promise };
		void promise.then((inv) => {
			const count = [...inv.values()].reduce((n, list) => n + list.length, 0);
			if (count > 0) this.logger.output(`[appdev] boot discovery: ${count} running dev server(s) found — will adopt on open`);
		});
	}

	/** The uncached discovery body (see discoverDevServers for semantics). */
	private async discoverDevServersUncached(): Promise<Map<string, Array<{ port: number; pids: number[] }>>> {
		const inventory = new Map<string, Array<{ port: number; pids: number[] }>>();

		// Enumerate "pid port" lines of rsbuild LISTEN sockets — OS truth,
		// however a server got its port.
		const lines = await this.listRsbuildListeners();

		// port -> pids (a server may listen on v4+v6; dedupe by port).
		const byPort = new Map<number, Set<number>>();
		for (const line of lines.split(/\r?\n/)) {
			const m = /^(\d+)\s+(\d+)$/.exec(line.trim());
			if (!m) continue;
			const pid = Number(m[1]);
			const port = Number(m[2]);
			if (!byPort.has(port)) byPort.set(port, new Set());
			byPort.get(port)!.add(pid);
		}

		// Identify each port by its manifest; unidentifiable ports (HMR-only
		// sockets, wedged servers) are simply not adoptable and are left to
		// the duplicate/foreign rules of whoever owns them.
		await Promise.all(
			[...byPort.entries()].map(async ([port, pids]) => {
				const name = await this.identifyDevServer(port);
				if (!name) return;
				if (!inventory.has(name)) inventory.set(name, []);
				inventory.get(name)!.push({ port, pids: [...pids] });
			}),
		);
		return inventory;
	}

	/**
	 * Platform enumeration: "pid port" lines for every LISTEN socket owned
	 * by an rsbuild-ish node process.
	 *
	 * Windows: one PowerShell round trip (CIM + Get-NetTCPConnection).
	 * POSIX: `ps` finds the rsbuild pids, `lsof` lists their LISTEN
	 * sockets (present by default on macOS; near-universal on Linux). Any
	 * failure resolves to '' — discovery degrades, never breaks a start.
	 */
	private listRsbuildListeners(): Promise<string> {
		if (process.platform === 'win32') {
			return new Promise<string>((resolve) => {
				const script =
					"$procs = Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'rsbuild' }; " +
					'$procIds = @($procs | Select-Object -ExpandProperty ProcessId); ' +
					'if ($procIds.Count -gt 0) { Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $procIds -contains $_.OwningProcess } | ForEach-Object { "$($_.OwningProcess) $($_.LocalPort)" } }';
				const probe = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
				let out = '';
				let done = false;
				const settle = (value: string): void => {
					if (done) return;
					done = true;
					clearTimeout(timer);
					resolve(value);
				};
				probe.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
				probe.on('exit', () => settle(out));
				probe.on('error', () => settle(''));
				// A wedged probe keeps powershell.exe alive with its pipes open
				// and its data handler appending to `out` after we settle;
				// discovery runs every burst, so leaked probes accumulate. Kill
				// the child and detach its handlers before settling.
				const timer = setTimeout(() => {
					probe.stdout?.removeAllListeners('data');
					try { probe.kill('SIGKILL'); } catch { /* already gone */ }
					settle(out);
				}, 5000);
			});
		}
		return new Promise<string>((resolve) => {
			// ps: pids of rsbuild processes; lsof: their LISTEN sockets as
			// "p<pid>" / "n<host>:<port>" field lines, normalized to
			// "pid port" to share the Windows parser.
			const script =
				"pids=$(ps -Ao pid=,command= | grep rsbuild | grep -v grep | awk '{print $1}' | paste -s -d, -); " +
				'if [ -n "$pids" ]; then lsof -nP -iTCP -sTCP:LISTEN -a -p "$pids" -Fpn 2>/dev/null | ' +
				"awk '/^p/{pid=substr($0,2)} /^n/{n=$0; sub(/^n.*:/, \"\", n); print pid, n}'; fi";
			const probe = spawn('/bin/sh', ['-c', script]);
			let out = '';
			let done = false;
			const settle = (value: string): void => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				resolve(value);
			};
			probe.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
			probe.on('exit', () => settle(out));
			probe.on('error', () => settle(''));
			// A wedged ps/lsof pipeline keeps /bin/sh alive with its pipes open
			// and its data handler appending to `out` after we settle;
			// discovery runs every burst, so leaked probes accumulate. Kill the
			// child and detach its handlers before settling.
			const timer = setTimeout(() => {
				probe.stdout?.removeAllListeners('data');
				try { probe.kill('SIGKILL'); } catch { /* already gone */ }
				settle(out);
			}, 5000);
		});
	}

	/**
	 * Fetches a candidate port's mf-manifest and returns its container name,
	 * or null when it does not answer like an MF dev server.
	 *
	 * @param port - The listening port to identify.
	 */
	private async identifyDevServer(port: number): Promise<string | null> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 1000);
		try {
			const res = await fetch(`http://localhost:${port}/mf-manifest.json`, { signal: controller.signal });
			if (!res.ok) return null;
			const manifest = (await res.json()) as { name?: string };
			return typeof manifest?.name === 'string' && manifest.name ? manifest.name : null;
		} catch {
			return null;
		} finally {
			clearTimeout(timer);
		}
	}

	/**
	 * Tree-kills the given process ids, awaited so a subsequent spawn can
	 * never race the dying tree.
	 *
	 * Windows: taskkill /T fells each tree. POSIX: the discovered pids ARE
	 * the listening servers themselves (not wrappers), so SIGTERM with a
	 * SIGKILL escalation suffices.
	 *
	 * @param pids - Process ids to fell.
	 */
	private async killPids(pids: number[]): Promise<void> {
		if (pids.length === 0) return;
		if (process.platform === 'win32') {
			await Promise.all(
				pids.map(
					(pid) =>
						new Promise<void>((resolve) => {
							const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F']);
							killer.on('exit', () => resolve());
							killer.on('error', () => resolve());
							// Never hang a start on a wedged kill.
							setTimeout(resolve, 3000);
						}),
				),
			);
			return;
		}
		for (const pid of pids) {
			try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
		}
		await new Promise<void>((resolve) => setTimeout(resolve, 1500));
		for (const pid of pids) {
			try { process.kill(pid, 'SIGKILL'); } catch { /* already gone — the normal case */ }
		}
	}

	// =========================================================================
	// INSTALL
	// =========================================================================

	/**
	 * Runs `pnpm install` at the WORKSPACE root — one install shared by all
	 * apps (they are workspace members; pnpm materializes each member's
	 * node_modules links from the root). Badge state and installer output
	 * broadcast to every open panel: a global install belongs to all of
	 * them. A failure names the offending project through pnpm's own output.
	 *
	 * Assumes workspaceFolders[0] (same known limitation as ensureShell —
	 * apps in a second workspace root are not covered).
	 *
	 * @param triggerAppId - The app that initiated the install (error focus).
	 * @returns True when the install succeeded (or was a no-op).
	 */
	private async runWorkspaceInstall(triggerAppId?: string): Promise<boolean> {
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!workspaceRoot) return false;
		this.appScreen.notifyWatchAll({ state: 'installing' });
		this.logger.output(`[appdev] pnpm install (workspace) at ${workspaceRoot}${triggerAppId ? ` — triggered by ${triggerAppId}` : ''}`);
		this.appScreen.notifyConsoleAll('log', `$ pnpm install --prefer-offline  (${workspaceRoot})`);

		// Windows holds transient handles on files under node_modules/.pnpm
		// (antivirus scan, Search indexer, an editor watching the tree), so
		// pnpm's atomic rename step intermittently fails with EPERM/EBUSY/
		// ENOTEMPTY even though the dependency graph is fine. The handle clears
		// on its own, so retry the WHOLE install a few times on that specific
		// signature — never on a genuine resolution or build failure. A
		// backoff between attempts gives the OS time to release the handle.
		const MAX_ATTEMPTS = 3;
		let result = await this.spawnInstallOnce(workspaceRoot);
		// A terminal failure (a timeout or a spawn error carries failureReason)
		// is NEVER retried — retrying a timed-out install could start a second
		// pnpm on the shared root while the first tree is still dying, even if
		// its accumulated output happens to carry a transient-lock signature.
		for (let attempt = 1; !result.ok && !result.failureReason && attempt < MAX_ATTEMPTS && isTransientLockError(result.output); attempt++) {
			const note = `pnpm install hit a transient Windows file lock — retrying (attempt ${attempt + 1}/${MAX_ATTEMPTS})`;
			this.logger.output(`[appdev] ${note}`);
			this.appScreen.notifyConsoleAll('warn', note);
			await new Promise((r) => setTimeout(r, 1500 * attempt));
			result = await this.spawnInstallOnce(workspaceRoot);
		}

		if (result.ok) {
			this.appScreen.notifyConsoleAll('log', 'pnpm install: done');
			// Clear the broadcast 'installing' badge; running sessions
			// immediately re-assert their real state below.
			this.appScreen.notifyWatchAll({ state: 'idle' });
			for (const s of this.sessions.values()) {
				this.notify(s.app.id, { state: s.buildStart ? 'building' : 'ok', target: s.devOrigin?.replace(/^https?:\/\//, '') });
			}
			return true;
		}
		// A timeout/spawn failure carries its own reason; everything else names
		// its cause from the accumulated output.
		const reason = result.failureReason ?? `pnpm install failed: ${extractInstallCause(result.output, result.code)}`;
		this.logger.output(`[appdev] workspace ${reason}`);
		if (triggerAppId) this.appScreen.notifyError(triggerAppId, reason, 'pnpm install');
		this.appScreen.notifyWatchAll({ state: 'error', target: 'pnpm install', reason });
		return false;
	}

	/**
	 * Runs ONE `pnpm install --prefer-offline` at the workspace root and
	 * resolves to its outcome — never reports to the UI itself, so the caller
	 * (runWorkspaceInstall) owns retry decisions and the final badge/error.
	 *
	 * Installer output still streams live into every panel's Console as it
	 * arrives, and is accumulated so a failure can name its cause.
	 *
	 * @param workspaceRoot - The workspace folder pnpm installs into.
	 * @returns ok + the combined output + exit code; failureReason is set only
	 *          for terminal, non-retriable failures (timeout, spawn error).
	 */
	private spawnInstallOnce(workspaceRoot: string): Promise<{ ok: boolean; output: string; code: number | null; failureReason?: string }> {
		return new Promise((resolve) => {
			// Workspace model: no --ignore-workspace (the root workspace file
			// claims apps/*), no --no-lockfile (the root lockfile is the
			// honest record of what the workspace resolves).
			// --prefer-offline: resolve from the store when a range is already
			// satisfied, so one slow registry response cannot stall installs.
			const proc = spawn('pnpm', ['install', '--prefer-offline'], {
				cwd: workspaceRoot,
				shell: process.platform === 'win32',
				env: { ...process.env, NO_COLOR: '1' },
				// POSIX: own process group so a timeout can fell the WHOLE tree.
				// pnpm forks its real work into children; a bare kill of this
				// shim leaves them alive on the shared store, and the chained
				// next-generation install then starts a SECOND pnpm on the same
				// root — the store-corrupting overlap this module forbids.
				// Matches doStart/doStop; Windows uses taskkill /T instead.
				detached: process.platform !== 'win32',
			});
			// Mirror installer output into every open panel's Console, and
			// accumulate it so a failure can NAME its cause.
			let output = '';
			proc.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); this.consoleAllLines('log', chunk.toString('utf8')); });
			proc.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); this.consoleAllLines('warn', chunk.toString('utf8')); });
			// Settle exactly once — exit, spawn-error, and the timeout race here.
			let settled = false;
			const finish = (r: { ok: boolean; output: string; code: number | null; failureReason?: string }): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve(r);
			};
			// A stalled install must not wedge the single-flight memo forever —
			// bound it and surface the failure like any other install error.
			// shell:true wraps pnpm in cmd.exe on Windows, so SIGKILL fells only
			// the wrapper while pnpm keeps running — taskkill /T fells the whole
			// tree, same approach as stop(). A timeout is terminal, not a
			// transient lock, so it carries its own non-retriable reason.
			const timer = setTimeout(() => {
				// Claim the settle synchronously so the tree-kill's own 'close'
				// (a non-zero exit, no failureReason) cannot win the race and
				// leave the outcome retriable.
				if (settled) return;
				settled = true;
				// AWAIT the tree-kill before resolving: returning while the old
				// pnpm tree is still dying would let a chained install (a newer
				// generation) start a SECOND pnpm on the shared root — exactly
				// the store-corrupting overlap this module forbids.
				void (async () => {
					if (process.platform === 'win32' && proc.pid) {
						await new Promise<void>((res) => {
							const killer = spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F']);
							killer.on('exit', () => res());
							killer.on('error', () => res());
							// Never hang the install on a wedged taskkill.
							setTimeout(res, 3000);
						});
					} else {
						// POSIX: the spawn is detached, so signal the whole GROUP
						// (negative pid). A bare proc.kill() would fell only the
						// pnpm shim and orphan its store-writing children.
						try {
							if (proc.pid) process.kill(-proc.pid, 'SIGKILL');
							else proc.kill('SIGKILL');
						} catch { /* group already gone */ }
					}
					resolve({ ok: false, output, code: null, failureReason: 'pnpm install timed out after 10 minutes' });
				})();
			}, 10 * 60 * 1000);
			// 'close' (not 'exit'): stdio is flushed first, so extractInstallCause
			// reads the COMPLETE output — aligns with publish.ts and runRootInstall.
			proc.on('close', (code) => finish({ ok: code === 0, output, code }));
			proc.on('error', (err) => finish({ ok: false, output, code: null, failureReason: `pnpm could not be started: ${err.message}` }));
		});
	}

	/**
	 * Splits raw workspace-install output into rows broadcast to every open
	 * panel's Console (blank lines dropped), mirroring the extension log.
	 *
	 * @param level - Row severity.
	 * @param text - Raw chunk (possibly multi-line).
	 */
	private consoleAllLines(level: 'log' | 'warn' | 'error', text: string): void {
		for (const line of text.split(/\r?\n/)) {
			const trimmed = line.trim();
			if (trimmed) {
				this.logger.output(`[appdev] ${trimmed}`);
				this.appScreen.notifyConsoleAll(level, trimmed);
			}
		}
	}

	/**
	 * Splits raw process output into rows for the panel Console (blank lines
	 * dropped), mirroring each line to the extension log.
	 *
	 * @param appId - The app the output belongs to.
	 * @param level - Row severity for the Console pane.
	 * @param text - Raw chunk (possibly multi-line).
	 */
	private consoleLines(appId: string, level: 'log' | 'warn' | 'error', text: string): void {
		for (const line of text.split(/\r?\n/)) {
			const trimmed = line.trim();
			if (trimmed) this.console(appId, level, trimmed);
		}
	}

	/** One console row → panel Console pane + extension log. */
	private console(appId: string, level: 'log' | 'warn' | 'error', text: string): void {
		this.logger.output(`[appdev] ${text}`);
		this.appScreen.notifyConsole(appId, level, text);
	}

	// =========================================================================
	// OUTPUT PARSING
	// =========================================================================

	/**
	 * Parses rsbuild output: captures the dev origin the first time it
	 * appears, then classifies build completions and failures.
	 *
	 * @param session - The owning watch session.
	 * @param chunk - Raw process output chunk.
	 */
	private handleOutput(session: WatchSession, chunk: string): void {
		// Chunks split mid-line at the pipe's whim — a marker torn across two
		// chunks would never match its regex. Carry the incomplete trailing
		// line over and only parse COMPLETE lines.
		const buffered = (session.pending ?? '') + chunk;
		const lines = buffered.split(/\r?\n/);
		session.pending = lines.pop() ?? '';
		if (lines.length === 0) return;
		const text = lines.join('\n');

		// Mirror the raw rsbuild output into the panel Console pane
		this.consoleLines(session.app.id, 'log', text);

		// Dev origin: "  ➜ Local:    http://localhost:3013/" (rsbuild banner)
		if (!session.devOrigin) {
			const m = /Local:\s+(http:\/\/[\w.-]+:\d+)/.exec(text);
			if (m) {
				session.devOrigin = m[1];
				this.logger.output(`[appdev] ${session.app.id} dev server at ${session.devOrigin}`);
				this.resolveReadiness(session.app.id, session.devOrigin);
				// The panel injects this entry straight into the preview shell
				// (postMessage — no server dependency); the overlay below only
				// serves embedder-less shells (F5's external browser).
				this.notifyDevEntry(session);
				void this.registerOverlay(session);
			}
		}

		// Build results: rsbuild prints "built in 1.24 s" / "build failed"
		if (/built in\s+[\d.]+/i.test(text)) {
			const durationMs = session.buildStart ? Date.now() - session.buildStart : undefined;
			session.buildStart = undefined;
			this.notify(session.app.id, { state: 'ok', durationMs, target: session.devOrigin?.replace(/^https?:\/\//, '') });
			// Fresh cache-busted entry FIRST (same-URL re-registration would
			// resolve to the browser-cached container — the stale-bundle bug),
			// then the overlay refresh and the debounced re-inject.
			this.notifyDevEntry(session);
			void this.registerOverlay(session);
			this.scheduleReload(session);
		} else if (/build failed|error {3}/i.test(text)) {
			session.buildStart = undefined;
			this.appScreen.notifyError(session.app.id, 'rsbuild build failed — see the Console pane for compiler output', 'rsbuild');
			this.notify(session.app.id, { state: 'error', target: session.devOrigin?.replace(/^https?:\/\//, ''), reason: 'The app failed to compile — the Console pane carries the compiler output.' });
		} else if (/building|compiling/i.test(text) && session.buildStart === undefined) {
			session.buildStart = Date.now();
			this.notify(session.app.id, { state: 'building', target: session.devOrigin?.replace(/^https?:\/\//, '') });
		}
	}

	// =========================================================================
	// OVERLAY + RELOAD
	// =========================================================================

	/**
	 * Announces the dev server entry to the panel with a per-build cache
	 * buster: a CHANGED entry URL is what makes the shell's force
	 * re-registration actually refetch the container instead of resolving
	 * the browser-cached script (chunks still resolve relative to the URL's
	 * directory, so the query hurts nothing).
	 *
	 * @param session - The session whose dev server has a fresh build.
	 */
	private notifyDevEntry(session: WatchSession): void {
		if (!session.devOrigin) return;
		this.appScreen.notifyDevServer(session.app.id, `${session.devOrigin}/remoteEntry.js?t=${Date.now()}`);
	}

	/** Points the caller's dev overlay at the served remoteEntry.js. */
	private async registerOverlay(session: WatchSession): Promise<void> {
		if (!session.devOrigin) return;
		try {
			const client = this.connectionManager.getClient();
			if (!client || !this.connectionManager.isConnected()) return;
			await client.call('rrext_deploy_app', {
				subcommand: 'register_dev',
				moduleId: session.app.moduleId,
				url: `${session.devOrigin}/remoteEntry.js`,
				appId: session.app.id,
			});
		} catch (err) {
			this.logger.output(`[appdev] register_dev failed for ${session.app.id}: ${err}`);
		}
	}

	/** Debounced (300ms) preview reload after a successful rebuild. */
	private scheduleReload(session: WatchSession): void {
		if (session.reloadTimer) clearTimeout(session.reloadTimer);
		session.reloadTimer = setTimeout(() => {
			this.appScreen.notifyReload(session.app.id);
		}, 300);
	}

	/** Forwards a watch status to the app's panel DEV badge. */
	private notify(appId: string, status: AppWatchStatus): void {
		this.appScreen.notifyWatch(appId, status);
	}

	// =========================================================================
	// BINARY RESOLUTION
	// =========================================================================

	/** See {@link resolveRsbuildInvocation}. */
	private resolveRsbuild(appRoot: string): { cmd: string; args: string[]; shell: boolean } {
		return resolveRsbuildInvocation(appRoot);
	}
}

/**
 * Resolves how to invoke rsbuild for an app folder: the app-local bin
 * first (deterministic), `pnpm exec` as the fallback for hoisted trees.
 * Shared by the watch loop (`rsbuild dev`) and the publish flow's one-shot
 * `rsbuild build`.
 *
 * @param appRoot - The app's absolute folder path.
 */
export function resolveRsbuildInvocation(appRoot: string): { cmd: string; args: string[]; shell: boolean } {
	try {
		const binPath = require.resolve('@rsbuild/core/bin/rsbuild.js', { paths: [appRoot] });
		return { cmd: process.execPath, args: [binPath], shell: false };
	} catch {
		// --ignore-workspace keeps the exec scoped to the app folder — inside
		// an enclosing pnpm workspace a bare exec goes recursive across ITS
		// projects (ERR_PNPM_RECURSIVE_EXEC) instead of running the app's bin.
		return { cmd: 'pnpm', args: ['--ignore-workspace', 'exec', 'rsbuild'], shell: process.platform === 'win32' };
	}
}

/** Module-level accessor wiring (set once in extension activation). */
let instance: WatchManager | null = null;

/** Installs the singleton WatchManager (called from extension activation). */
export function initWatchManager(appScreen: AppScreenProvider): WatchManager {
	instance = new WatchManager(appScreen);
	// Lazy boot pass: discover already-running dev servers in the background
	// so the first panel open adopts instantly. Deferred off the activation
	// path — activation must never wait on process enumeration.
	const created = instance;
	setTimeout(() => { try { created.prewarmDiscovery(); } catch { /* best-effort */ } }, 1500);
	return instance;
}

/** Returns the active WatchManager, or null before activation wiring. */
export function getWatchManager(): WatchManager | null {
	return instance;
}

/**
 * Ensures the watch session for an app is running (used by the App Screen
 * open path and F5). Honors the `rocketride.appdev.autoWatch` setting when
 * `force` is false.
 *
 * @param app - The app to watch.
 * @param force - True to start regardless of the autoWatch setting (F5).
 */
export async function ensureWatch(app: ScannedApp, force = false): Promise<void> {
	const manager = instance;
	if (!manager) return;
	const autoWatch = vscode.workspace.getConfiguration('rocketride.appdev').get<boolean>('autoWatch', true);
	if (!force && !autoWatch) return;
	await manager.start(app);
}
