// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * Deploy flow — copy an immutable app version to the server from VSCode.
 *
 * The zip carries the app's SOURCE (src/, package.json with the full
 * appManifest, rsbuild config, icon/README/assets, the .rrapp marker —
 * never node_modules, dist, or .git): the SERVER owns the build, so the
 * store never has to trust client-produced binaries, and deploy runs NO
 * local build of any kind. The zip rides the generic `rrext_deploy add`
 * rail door; the server retains it and unpacks at receipt; deploying
 * never activates anything — the Deploy view publishes rungs.
 */

import * as vscode from 'vscode';
import AdmZip from 'adm-zip';
import { ConnectionManager } from '../connection/connection';
import { scanWorkspaceApps } from './appScan';
import { ensureAppMarker } from './appMarker';
import { getLogger } from '../shared/util/output';

// =============================================================================
// PUBLISH
// =============================================================================

/**
 * Packs the app's source folder and deploys it as an immutable version.
 *
 * @param appId - The app to publish (appManifest.id).
 * @param message - Commit-style "what changed" note for the version card.
 * @returns The new version-rail entry.
 */
export async function deployApp(appId: string, message: string): Promise<Record<string, unknown>> {
	const logger = getLogger();
	const apps = await scanWorkspaceApps();
	const app = apps.find((a) => a.id === appId);
	if (!app) throw new Error(`App "${appId}" has no bound folder in this workspace.`);

	const client = ConnectionManager.getInstance().getClient();
	if (!client || !ConnectionManager.getInstance().isConnected()) {
		throw new Error('Not connected — publishing needs a live server connection.');
	}

	// ── Working-copy provenance: the client-side .rrapp projectId ────────
	// Ensured BEFORE packing so a first-time deploy's freshly created
	// marker is inside the zip, not just on disk.
	const marker = await ensureAppMarker(app.folder, appId);

	// ── Pack the SOURCE folder at the zip root ───────────────────────────
	// package.json (carrying the FULL appManifest — the server reads it as
	// metadata.manifest, the listing truth), src/, rsbuild config, icon,
	// README, assets, and the .rrapp marker. Excluded: node_modules (the
	// server injects the platform deps for its own build), dist (client
	// output is never uploaded), .git.
	logger.output(`[appdev] packing source: ${appId}`);
	const zip = new AdmZip();
	zip.addLocalFolder(app.folder, undefined, (entryPath) => {
		const rel = entryPath.replace(/\\/g, '/');
		return !/(^|\/)(node_modules|dist|\.git)(\/|$)/.test(rel);
	});
	const data = new Uint8Array(zip.toBuffer());

	// ── The ONE rail door (deploy = copy code to the server) ─────────────
	const body = await client.deploy.add({
		kind: 'app',
		data,
		metadata: { projectId: marker.projectId },
		comment: message,
	});
	const entry = (body as Record<string, unknown>)?.artifact as Record<string, unknown> | undefined;
	if (!entry) throw new Error(`Deploy returned no artifact entry for ${appId}.`);
	// The registry's answer is the truth about what was deployed — report
	// the SAME version in the log and the toast (the manifest's app.version
	// is only the fallback).
	const deployedVersion = (entry.appVersion as string) ?? app.version;
	logger.output(`[appdev] deployed ${appId} v${deployedVersion} (registry v${entry.registryVersion})`);
	vscode.window.showInformationMessage(`Deployed ${app.name} v${deployedVersion} — publish it from the Deploy view to make it live.`);
	return entry;
}
