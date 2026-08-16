// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * CheckoutUnavailableNotice — the "why is there no checkout" dialog.
 *
 * Rendered by the Subscribe surfaces (Account, Project, CloudPanel) when the
 * user asked for checkout but no Stripe publishable key is available, so the
 * click explains itself instead of doing nothing. The message is derived from
 * the host-reported StripeKeyUnavailableReason carried by useStripeKey.
 */

import React, { CSSProperties } from 'react';
import type { StripeKeyUnavailableReason } from '../../types/checkoutTypes';

// =============================================================================
// STYLES
// =============================================================================

const styles = {
	backdrop: {
		position: 'fixed',
		inset: 0,
		zIndex: 1000,
		backgroundColor: 'rgba(0, 0, 0, 0.45)',
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
	} as CSSProperties,
	dialog: {
		maxWidth: 420,
		margin: 16,
		padding: '20px 24px',
		backgroundColor: 'var(--vscode-editorWidget-background)',
		border: '1px solid var(--vscode-editorWidget-border)',
		borderRadius: 6,
		color: 'var(--vscode-foreground)',
	} as CSSProperties,
	title: {
		margin: '0 0 8px 0',
		fontSize: 14,
		fontWeight: 600,
	} as CSSProperties,
	message: {
		margin: '0 0 16px 0',
		fontSize: 13,
		lineHeight: 1.5,
		color: 'var(--vscode-descriptionForeground)',
	} as CSSProperties,
	closeRow: {
		display: 'flex',
		justifyContent: 'flex-end',
	} as CSSProperties,
	closeButton: {
		padding: '6px 16px',
		background: 'var(--vscode-button-secondaryBackground)',
		color: 'var(--vscode-button-secondaryForeground)',
		border: 'none',
		borderRadius: 3,
		cursor: 'pointer',
	} as CSSProperties,
};

// =============================================================================
// MESSAGES
// =============================================================================

/** User-facing explanation per host-reported reason; the undefined key covers
 *  "no reply yet" (the key request is still in flight when the user clicks). */
const MESSAGES: Record<string, string> = {
	'no-billing': 'This server has no billing configured, so subscriptions are not available here.',
	'no-connection': 'Not connected to a server. Connect first, then subscribe.',
	'probe-failed': 'The server could not be reached to set up checkout. Check the connection and try again.',
	pending: 'Contacting the server to set up checkout. Try again in a moment.',
};

// =============================================================================
// COMPONENT
// =============================================================================

/** Props for the CheckoutUnavailableNotice dialog. */
export interface CheckoutUnavailableNoticeProps {
	/** Why the Stripe key is unavailable; undefined while the reply is pending. */
	reason?: StripeKeyUnavailableReason;
	/** Dismiss callback — the owner clears its showCheckout state. */
	onClose: () => void;
}

/**
 * Modal notice explaining why checkout cannot open.
 *
 * @param props - Reason and dismiss callback.
 * @returns The dialog element.
 */
export const CheckoutUnavailableNotice: React.FC<CheckoutUnavailableNoticeProps> = ({ reason, onClose }) => (
	<div style={styles.backdrop} onClick={onClose}>
		<div style={styles.dialog} role="alertdialog" aria-label="Checkout unavailable" onClick={(e) => e.stopPropagation()}>
			<h3 style={styles.title}>Checkout unavailable</h3>
			<p style={styles.message}>{MESSAGES[reason ?? 'pending']}</p>
			<div style={styles.closeRow}>
				<button type="button" style={styles.closeButton} onClick={onClose}>
					Close
				</button>
			</div>
		</div>
	</div>
);
