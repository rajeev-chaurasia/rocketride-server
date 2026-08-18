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

// =============================================================================
// DASHBOARD VIEW — everything that needs doing, at a glance
// =============================================================================

/**
 * The DASHBOARD view — the App Builder's landing tab. The lead card SPEAKS:
 * it narrates the app's state in plain English (latest version, its review
 * state, what serves where) and recommends the next step in full sentences —
 * no label-speak. Alongside it: the review conversation with the store
 * reviewer, where the app is live, and recent activity.
 *
 * The conversation IS the app's deployment history: 'reply' rows render as
 * chat bubbles (developer right/brand, admin left/surface — the developer's
 * own side sits right, mirroring the reviewer's App Admin surface), review
 * transitions as centered system lines. Pure machine ops (deploy, publish,
 * rollback...) stay out of the chat and live in Recent activity instead.
 *
 * Liveness (v1): the host re-creates its adapter on account changes (verdict
 * pushes ride app:statusChanged into that re-mint), which re-runs the
 * [host]-keyed refresh; replies have no push event yet, so the card carries
 * a manual Refresh and reloads after the developer's own send.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Banner } from 'shell';
import { Button } from 'shell';
import { Card } from 'shell';
import { EmptyState } from 'shell';
import { InputField } from 'shell';
import { StatusBadge } from 'shell';
import type { AppBuilderStage, AppHistoryEntry, AppSummary, AppVersionInfo, BuildStatusTick, IAppBuilderHost, PreflightCheck, RungPin, WatchStatus } from './types';

// =============================================================================
// TYPES
// =============================================================================

/** Props for the {@link DashboardView} component. */
export interface IDashboardViewProps {
	/** The host adapter (data + actions). */
	host: IAppBuilderHost;
	/** The app being shown. */
	app: AppSummary;
	/** Namespace mismatch: disable the reply box (the view stays readable). */
	readOnly?: boolean;
	/** Deep-link into another tab from an attention row ("Open Deploy"). */
	onNavigate?: (stage: AppBuilderStage) => void;
}

/** One sentence of the narrated status — the card speaks plain English. */
interface StatusLine {
	/** Sentence tone: 'plain' narrates, 'warn'/'error' tint the text. */
	tone: 'plain' | 'warn' | 'error';
	/** The sentence itself — full natural language, no label-speak. */
	text: string;
	/** Tab that carries the recommended action, rendered as an "Open ..." button. */
	stage?: AppBuilderStage;
}

// =============================================================================
// STYLES
// =============================================================================

const styles: Record<string, React.CSSProperties> = {
	wrap: {
		overflow: 'auto',
		height: '100%',
	},
	head: {
		padding: '18px 26px 0',
	},
	h1: {
		fontSize: 20,
		fontWeight: 600,
		color: 'var(--rr-text-primary)',
	},
	sub: {
		fontSize: 12.5,
		color: 'var(--rr-text-secondary)',
		marginTop: 3,
		lineHeight: 1.5,
	},
	grid: {
		display: 'grid',
		gridTemplateColumns: '3fr 2fr',
		gap: 16,
		alignItems: 'start',
		margin: '16px 26px 30px',
		maxWidth: 1060,
	},
	col: {
		display: 'flex',
		flexDirection: 'column',
		gap: 16,
	},
	// ── Status & next steps (narrated prose) ────────────────────────────────
	statusRow: {
		display: 'flex',
		alignItems: 'flex-start',
		gap: 12,
		padding: '5px 0',
	},
	statusText: {
		flex: 1,
		fontSize: 13,
		color: 'var(--rr-text-primary)',
		lineHeight: 1.65,
	},
	// ── Conversation ────────────────────────────────────────────────────────
	chatScroll: {
		display: 'flex',
		flexDirection: 'column',
		gap: 10,
		height: 380,
		overflowY: 'auto',
		padding: '4px 2px',
	},
	sysLine: {
		alignSelf: 'center',
		fontSize: 11.5,
		color: 'var(--rr-text-secondary)',
		background: 'var(--rr-bg-surface-alt)',
		border: '1px dashed var(--rr-border)',
		borderRadius: 14,
		padding: '3px 12px',
		textAlign: 'center',
	},
	replyRow: {
		display: 'flex',
		gap: 10,
		marginTop: 10,
		paddingTop: 12,
		borderTop: '1px solid var(--rr-border)',
	},
	replyInput: {
		flex: 1,
	},
	replyHint: {
		fontSize: 11.5,
		color: 'var(--rr-text-disabled)',
		marginTop: 6,
		lineHeight: 1.5,
	},
	replyError: {
		marginTop: 10,
	},
	// ── Where it's live ─────────────────────────────────────────────────────
	pinRow: {
		display: 'flex',
		alignItems: 'center',
		gap: 10,
		padding: '7px 0',
		fontSize: 12.5,
		borderTop: '1px solid var(--rr-bg-widget-header)',
	},
	pinRowFirst: {
		borderTop: 'none',
	},
	pinHandle: {
		fontFamily: 'var(--rr-font-mono, Consolas, monospace)',
		fontSize: 12,
		color: 'var(--rr-text-primary)',
		whiteSpace: 'nowrap',
	},
	pinVersion: {
		fontFamily: 'var(--rr-font-mono, Consolas, monospace)',
		fontSize: 11.5,
		color: 'var(--rr-text-secondary)',
		whiteSpace: 'nowrap',
	},
	pinAudience: {
		flex: 1,
		fontSize: 11.5,
		color: 'var(--rr-text-disabled)',
		textAlign: 'right',
		overflow: 'hidden',
		textOverflow: 'ellipsis',
		whiteSpace: 'nowrap',
	},
	// ── Recent activity ─────────────────────────────────────────────────────
	actRow: {
		display: 'flex',
		gap: 10,
		padding: '5px 0',
		fontSize: 12,
		borderTop: '1px solid var(--rr-bg-widget-header)',
		alignItems: 'baseline',
	},
	actRowFirst: {
		borderTop: 'none',
	},
	actWhen: {
		fontFamily: 'var(--rr-font-mono, Consolas, monospace)',
		fontSize: 11,
		color: 'var(--rr-text-disabled)',
		whiteSpace: 'nowrap',
	},
	actWhat: {
		flex: 1,
		color: 'var(--rr-text-secondary)',
		lineHeight: 1.5,
	},
	loadBanner: {
		margin: '16px 26px 0',
		maxWidth: 1060,
	},
};

/**
 * Chat bubble style. The developer's own messages sit right in the brand
 * color; the reviewer's sit left on the widget surface — the same grammar
 * as the reviewer's App Admin surface with the sides swapped.
 *
 * @param isDeveloper - Whether the message side is the developer (this app's own side).
 * @returns The bubble style object.
 */
const bubble = (isDeveloper: boolean): React.CSSProperties => ({
	maxWidth: '78%',
	padding: '9px 13px',
	borderRadius: 12,
	fontSize: 12.5,
	lineHeight: 1.55,
	alignSelf: isDeveloper ? 'flex-end' : 'flex-start',
	background: isDeveloper ? 'var(--rr-brand)' : 'var(--rr-bg-widget)',
	color: isDeveloper ? '#fff' : 'var(--rr-text-primary)',
	border: isDeveloper ? 'none' : '1px solid var(--rr-border)',
	borderBottomRightRadius: isDeveloper ? 4 : 12,
	borderBottomLeftRadius: isDeveloper ? 12 : 4,
	whiteSpace: 'pre-wrap',
	wordBreak: 'break-word',
});

/**
 * Meta line under a bubble (actor and timestamp), aligned to its side.
 *
 * @param isDeveloper - Whether the message side is the developer.
 * @returns The meta-line style object.
 */
const bubbleMeta = (isDeveloper: boolean): React.CSSProperties => ({
	fontSize: 10.5,
	color: 'var(--rr-text-secondary)',
	alignSelf: isDeveloper ? 'flex-end' : 'flex-start',
	marginTop: -4,
});

// Sentence text color per tone — plain sentences narrate in the normal
// foreground; warnings and errors tint the whole sentence.
const TONE_COLOR: Record<StatusLine['tone'], string> = {
	plain: 'var(--rr-text-primary)',
	warn: 'var(--rr-color-warning)',
	error: 'var(--rr-color-error)',
};

// =============================================================================
// HISTORY VOCABULARY
// =============================================================================

// Review-lifecycle actions — rendered as system lines inside the conversation.
const LIFECYCLE_ACTIONS = new Set(['request', 'approved', 'rejected', 'withdrawn', 'failed']);

// Human labels for machine actions (system lines + the activity feed).
const ACTION_LABEL: Record<string, string> = {
	request: 'submitted for review',
	approved: 'approved',
	rejected: 'rejected',
	withdrawn: 'withdrawn from review',
	failed: 'build failed',
	publish: 'published to the rail',
	deploy: 'deployed',
	rollback: 'rolled back',
	enable: 'enabled',
	disable: 'disabled',
	enabled: 'enabled',
	disabled: 'disabled',
	remove: 'removed',
	removed: 'removed',
	errored: 'errored',
};

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Classify a version's server build word. The build status is a SEPARATE
 * axis from the review state — a 'private' draft whose build failed can
 * never serve, and recommending it for publish/review would be wrong.
 *
 * @param version - The rail entry (undefined-safe).
 * @returns 'ok' (servable — '' and 'ok' both count, legacy rows carry no
 *          word), 'failed', or 'running' (any in-flight ticker word).
 */
function buildStateOf(version: AppVersionInfo | undefined): 'ok' | 'failed' | 'running' {
	const word = version?.buildStatus ?? '';
	if (word === '' || word === 'ok') return 'ok';
	if (word === 'failed') return 'failed';
	return 'running';
}

/**
 * Format an epoch-seconds timestamp as a short locale date + time line.
 *
 * @param epochSeconds - Seconds since the epoch.
 * @returns Locale-formatted date/time, or '' when unparseable.
 */
function formatAt(epochSeconds: number): string {
	try {
		return new Date(epochSeconds * 1000).toLocaleString(undefined, {
			month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
		});
	} catch {
		return '';
	}
}

/**
 * Human label for a machine history row ("v4 submitted for review by dana").
 *
 * @param entry - The history row.
 * @returns The one-line "what happened" text.
 */
function systemLabel(entry: AppHistoryEntry): string {
	const version = entry.version != null ? `v${entry.version} ` : '';
	const label = ACTION_LABEL[entry.action] ?? entry.action;
	const actor = entry.actor?.display || entry.actor?.email || '';
	return `${version}${label}${actor ? ` by ${actor}` : ''}`;
}

/**
 * Narrate the app's state as plain English: where things stand (latest
 * version, its review state, what is serving where) followed by what the
 * developer might do next — recommendations, not label-speak. Pure — every
 * sentence derives only from its inputs, so the story re-derives on any
 * refresh.
 *
 * @param versions - The version rail, newest first.
 * @param pins - The where-live reverse index.
 * @param checks - Pre-flight results ([] until run).
 * @param watch - Latest local watch/build status (null before the first tick).
 * @param history - The history stream, oldest first.
 * @returns The status sentences, story first, problems and next steps after.
 */
function deriveStatus(
	versions: AppVersionInfo[],
	pins: RungPin[],
	checks: PreflightCheck[],
	watch: WatchStatus | null,
	history: AppHistoryEntry[],
): StatusLine[] {
	const lines: StatusLine[] = [];
	const newest = versions[0];
	const publicPin = pins.find((p) => p.rung === 'public');

	// ── The story: what the latest version is and how it got here ────────
	if (!newest) {
		lines.push({
			tone: 'plain',
			text: 'This app has not been deployed yet, so nothing is on the server. When you are ready, deploy your first version and it will show up here.',
			stage: 'deploy',
		});
	} else {
		const when = newest.publishedAt ? ` on ${formatAt(newest.publishedAt)}` : '';
		const who = newest.author ? ` by ${newest.author}` : '';
		const semver = newest.version ? ` (${newest.version})` : '';
		const stateStory: Record<string, string> = {
			private: 'it is a private draft, ready for internal use',
			submit: 'it is in review right now — the verdict will land here and in the conversation below',
			ready: 'it passed review and is approved',
			rejected: 'it was rejected in review',
			failed: 'its server build failed, so it never became servable',
		};
		// The build axis outranks the review state in the story: a draft
		// whose server build broke is NOT "ready for internal use", and a
		// still-running build is not anything yet.
		const build = buildStateOf(newest);
		const story =
			build === 'failed'
				? 'its server build FAILED, so this version cannot serve'
				: build === 'running'
					? `the server is still building it (${newest.buildStatus})`
					: (stateStory[newest.state ?? ''] ?? 'its state is unknown');
		lines.push({
			tone: 'plain',
			text: `Your latest version is v${newest.registryVersion}${semver}, deployed${when}${who} — ${story}.`,
		});
	}

	// ── What is serving where, in one sentence ───────────────────────────
	if (pins.length > 0) {
		const serving = pins.map((p) => `${p.handle} serves v${p.registryVersion}${p.version ? ` (${p.version})` : ''}`).join(', ');
		lines.push({ tone: 'plain', text: `Right now ${serving}.` });
	} else if (newest) {
		lines.push({ tone: 'plain', text: 'It is not being served to anyone yet.' });
	}

	// ── Problems first — anything broken outranks any suggestion ─────────
	if (watch?.state === 'error') {
		lines.push({
			tone: 'error',
			text: `Heads up: your local build is failing — ${watch.reason || 'see the Console for details'}. The preview and your next deploy both depend on it.`,
			stage: 'design',
		});
	}
	if (newest && buildStateOf(newest) === 'failed') {
		lines.push({
			tone: 'error',
			text: `v${newest.registryVersion} failed its server build — click the failed badge on its card in Deploy to read the build log, then fix the source and deploy a new version. A version whose build failed can never be published or reviewed.`,
			stage: 'deploy',
		});
	}
	if (newest?.state === 'failed') {
		lines.push({
			tone: 'error',
			text: 'Check the build output in the Console, fix the error, and deploy again — a failed version cannot be published or reviewed.',
			stage: 'design',
		});
	}
	if (newest?.state === 'rejected') {
		lines.push({
			tone: 'error',
			text: 'Read the notes from the reviewer in the conversation below, fix what they flagged, and deploy a new version — a rejection is final for that version.',
		});
	}
	const failing = checks.filter((c) => c.state === 'fail').length;
	if (failing > 0) {
		lines.push({
			tone: 'warn',
			text: `Before your next store submission, ${failing === 1 ? 'one pre-flight check needs' : `${failing} pre-flight checks need`} fixing.`,
			stage: 'store',
		});
	}
	const lastReply = [...history].reverse().find((e) => e.action === 'reply');
	if (lastReply?.data?.side === 'admin') {
		lines.push({ tone: 'warn', text: 'The reviewer sent you a message — it is waiting in the conversation below.' });
	}

	// ── Next steps: what you might do from here. Only a version whose
	// build is green gets recommended anywhere — suggesting publish or
	// review for an unservable version would be advice the server refuses.
	const newestBuild = buildStateOf(newest);
	if (newest && newestBuild === 'running') {
		lines.push({
			tone: 'plain',
			text: 'Hang tight — once the build finishes, you can publish it or submit it for review.',
		});
	} else if (newest && newestBuild === 'failed') {
		// The error sentence above already says what to do; no cheerful
		// recommendation on top of it.
	} else if (newest?.state === 'ready' && publicPin?.registryVersion !== newest.registryVersion) {
		lines.push({
			tone: 'plain',
			text: `All is well — v${newest.registryVersion} is approved. If you want, publish it to @public and the store starts serving it.`,
			stage: 'deploy',
		});
	} else if (newest?.state === 'ready') {
		lines.push({ tone: 'plain', text: 'All is well — the store is serving your approved version. Nothing needs doing.' });
	} else if (newest?.state === 'private') {
		const behindPublic = publicPin && publicPin.registryVersion < newest.registryVersion;
		lines.push({
			tone: 'plain',
			text: behindPublic
				? `The store is still on v${publicPin.registryVersion}. If you want, you can try v${newest.registryVersion} on your desktop or share it with a team right away, or submit it for review to bring the store up to date.`
				: 'If you want, you can publish it to your desktop or one of your teams right away, or submit it for review to make it public.',
			stage: 'deploy',
		});
	} else if (newest?.state === 'submit') {
		lines.push({
			tone: 'plain',
			text: 'Nothing needs doing while the review runs — you can keep working; deploying a new version simply withdraws this submission.',
		});
	}

	return lines;
}

// =============================================================================
// COMPONENT
// =============================================================================

/**
 * Renders the DASHBOARD view: the narrated status, the review conversation,
 * where the app is live, and recent activity.
 *
 * @param props - See {@link IDashboardViewProps}.
 */
export const DashboardView: React.FC<IDashboardViewProps> = ({ host, app, readOnly, onNavigate }) => {
	// ── Data — loaded through the host adapter ───────────────────────────
	// null = first load in flight; [] = loaded and empty.
	const [history, setHistory] = useState<AppHistoryEntry[] | null>(null);
	const [versions, setVersions] = useState<AppVersionInfo[]>([]);
	const [pins, setPins] = useState<RungPin[]>([]);
	const [checks, setChecks] = useState<PreflightCheck[]>([]);
	const [watch, setWatch] = useState<WatchStatus | null>(null);
	const [loadError, setLoadError] = useState('');

	// ── Reply state ──────────────────────────────────────────────────────
	const [reply, setReply] = useState('');
	const [sending, setSending] = useState(false);
	const [replyError, setReplyError] = useState('');

	/** Batched refresh: history, rail, pins, and pre-flight in one round. */
	const refresh = useCallback(async (): Promise<void> => {
		setLoadError('');
		try {
			const [h, v, p, c] = await Promise.all([
				host.loadHistory?.() ?? Promise.resolve([]),
				host.listVersions?.() ?? Promise.resolve([]),
				host.getWhereLive?.() ?? Promise.resolve([]),
				host.runPreflight?.() ?? Promise.resolve([]),
			]);
			setHistory(h);
			setVersions(v);
			setPins(p);
			setChecks(c);
		} catch (e) {
			// Not connected / server unreachable: keep the cards rendered on
			// their empty states and say why the server-side facts are missing.
			setHistory((prev) => prev ?? []);
			setLoadError(e instanceof Error ? e.message : String(e));
		}
	}, [host]);

	// [host]-keyed: the VSCode adapter re-mints on account changes (verdict
	// pushes included), so this ALSO serves as the live-refresh trigger.
	useEffect(() => {
		void refresh();
	}, [refresh]);

	// Latest local watch/build status for the attention rules.
	useEffect(() => host.subscribeWatch?.((s) => setWatch(s)), [host.subscribeWatch]);

	// Live SERVER-build ticker: a deploy's failure or success lands as build
	// ticks, NOT as an account change — without this the card would narrate
	// a stale rail until the next full refresh. A terminal tick ('' =
	// success, 'failed') also re-pulls the rail so the persisted buildStatus
	// takes over from the overlay.
	const [buildTicks, setBuildTicks] = useState<Record<number, string>>({});
	useEffect(() => host.subscribeBuildStatus?.((tick: BuildStatusTick) => {
		if (tick.version == null) return;
		setBuildTicks((prev) => ({ ...prev, [tick.version as number]: tick.status }));
		if (tick.status === '' || tick.status === 'failed') void refresh();
	}), [host.subscribeBuildStatus, refresh]);

	// The rail with the live ticker overlaid — the freshest build word wins
	// ('' is the success terminal and reads as servable).
	const liveVersions = useMemo(
		() => versions.map((v) => {
			const word = buildTicks[v.registryVersion];
			return word === undefined ? v : { ...v, buildStatus: word === '' ? 'ok' : word };
		}),
		[versions, buildTicks],
	);

	// ── Conversation projection ──────────────────────────────────────────
	// The chat shows replies and review transitions; pure machine ops stay
	// in Recent activity.
	const thread = useMemo(
		() => (history ?? []).filter((e) => e.action === 'reply' || LIFECYCLE_ACTIONS.has(e.action)),
		[history],
	);
	const activity = useMemo(
		() => (history ?? []).filter((e) => e.action !== 'reply').slice(-10).reverse(),
		[history],
	);
	const status = useMemo(
		() => deriveStatus(liveVersions, pins, checks, watch, history ?? []),
		[liveVersions, pins, checks, watch, history],
	);

	// Keep the chat pinned to its newest message on every (re)load.
	const chatRef = useRef<HTMLDivElement | null>(null);
	useEffect(() => {
		const el = chatRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [thread]);

	/** Send the reply, then reload so the row renders from the server's
	 * serialization (no optimistic insert). */
	const sendReply = useCallback(async (): Promise<void> => {
		const message = reply.trim();
		if (!host.sendReply || message.length === 0 || readOnly) return;
		setSending(true);
		setReplyError('');
		try {
			await host.sendReply(message);
			setReply('');
			await refresh();
		} catch (e) {
			setReplyError(e instanceof Error ? e.message : String(e));
		} finally {
			setSending(false);
		}
	}, [host, reply, readOnly, refresh]);

	// =====================================================================
	// RENDER
	// =====================================================================

	return (
		<div style={styles.wrap}>
			{/* View header — title + one-line purpose */}
			<div style={styles.head}>
				<div style={styles.h1}>{app.name}</div>
				<div style={styles.sub}>Dashboard — where things stand with this app, the conversation with the reviewer, and what you might do next.</div>
			</div>

			{/* Server-side facts unavailable — the cards below stay on their empty states */}
			{loadError ? (
				<div style={styles.loadBanner}>
					<Banner variant="info">Not connected to a RocketRide server — {loadError}. Server-side status appears here once connected.</Banner>
				</div>
			) : null}

			<div style={styles.grid}>
				{/* ── Left: attention + the conversation ─────────────────── */}
				<div style={styles.col}>
					<Card header="Status & next steps">
						{history === null ? (
							<div style={styles.statusRow}>
								<div style={styles.statusText}>Looking at the current state...</div>
							</div>
						) : (
							status.map((line) => (
								<div key={line.text} style={styles.statusRow}>
									<div style={{ ...styles.statusText, color: TONE_COLOR[line.tone] }}>{line.text}</div>
									{line.stage && onNavigate ? (
										<Button variant="secondary" small onClick={() => onNavigate(line.stage as AppBuilderStage)}>
											Open {line.stage.charAt(0).toUpperCase() + line.stage.slice(1)}
										</Button>
									) : null}
								</div>
							))
						)}
					</Card>

					<Card
						header="Review conversation"
						headerActions={
							<Button variant="secondary" small onClick={() => void refresh()}>Refresh</Button>
						}
					>
						<div ref={chatRef} style={styles.chatScroll}>
							{history === null ? (
								<div style={styles.sysLine}>Loading thread...</div>
							) : thread.length === 0 ? (
								<EmptyState title="No conversation yet" description="Submissions, verdicts, and reviewer messages appear here once the app is on the server." />
							) : (
								thread.map((entry) => {
									if (entry.action === 'reply' && entry.data?.message) {
										const isDeveloper = entry.data.side === 'developer';
										return (
											<React.Fragment key={entry.seq}>
												<div style={bubble(isDeveloper)}>{entry.data.message}</div>
												<div style={bubbleMeta(isDeveloper)}>
													{(entry.actor?.display || entry.actor?.email || entry.data.side || '')} · {formatAt(entry.at)}
												</div>
											</React.Fragment>
										);
									}
									return (
										<div key={entry.seq} style={styles.sysLine}>
											{formatAt(entry.at)} — {systemLabel(entry)}
										</div>
									);
								})
							)}
						</div>

						{host.sendReply ? (
							<>
								<div style={styles.replyRow}>
									<div style={styles.replyInput}>
										<InputField
											placeholder={readOnly ? 'Replies disabled' : 'Reply to the reviewer...'}
											value={reply}
											disabled={readOnly}
											maxLength={4000}
											onChange={(e) => setReply(e.target.value)}
											onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void sendReply(); } }}
										/>
									</div>
									<Button disabled={sending || reply.trim().length === 0 || !!readOnly} onClick={() => void sendReply()}>
										{sending ? 'Sending...' : 'Send'}
									</Button>
								</div>
								{readOnly ? (
									<div style={styles.replyHint}>Replies are disabled: this app&rsquo;s id is outside your organization&rsquo;s developer namespace.</div>
								) : null}
								{replyError ? (
									<div style={styles.replyError}>
										<Banner variant="error">{replyError}</Banner>
									</div>
								) : null}
							</>
						) : (
							<div style={styles.replyHint}>Replying is not wired up on this host yet — the thread is read-only here.</div>
						)}
					</Card>
				</div>

				{/* ── Right: where it's live + recent activity ───────────── */}
				<div style={styles.col}>
					<Card header="Where it's live">
						{pins.length === 0 ? (
							<EmptyState title="Not serving anywhere" description="Publish a version to @me, @team, or @public and its pin appears here." />
						) : (
							pins.map((pin, i) => (
								<div key={pin.handle} style={i === 0 ? { ...styles.pinRow, ...styles.pinRowFirst } : styles.pinRow}>
									<span style={styles.pinHandle}>{pin.handle}</span>
									<span style={styles.pinVersion}>v{pin.registryVersion}{pin.version ? ` · ${pin.version}` : ''}</span>
									<StatusBadge variant={pin.state === 'pending' ? 'muted' : 'info'}>
										{pin.state === 'enabled' ? 'live' : pin.state === 'approved' ? 'live' : 'in review'}
									</StatusBadge>
									<span style={styles.pinAudience}>{pin.audience}</span>
								</div>
							))
						)}
					</Card>

					<Card header="Recent activity">
						{activity.length === 0 ? (
							<EmptyState title="No activity yet" description="Deploys, publishes, and review events appear here." />
						) : (
							activity.map((entry, i) => (
								<div key={entry.seq} style={i === 0 ? { ...styles.actRow, ...styles.actRowFirst } : styles.actRow}>
									<span style={styles.actWhen}>{formatAt(entry.at)}</span>
									<span style={styles.actWhat}>{systemLabel(entry)}</span>
								</div>
							))
						)}
					</Card>
				</div>
			</div>
		</div>
	);
};
