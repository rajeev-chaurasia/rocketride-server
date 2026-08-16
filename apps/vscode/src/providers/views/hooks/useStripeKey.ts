// =============================================================================
// MIT License
// Copyright (c) 2026 Aparavi Software AG
// =============================================================================

/**
 * useStripeKey — resolves the Stripe publishable key for the embedded
 * CheckoutModal from the extension host.
 *
 * The key is not baked into the webview bundle: it is server-specific
 * (pk_test vs pk_live) and must match the Stripe account of the server the
 * host's billing client is connected to. The host learns it from the
 * unauthenticated server probe (ServerInfoResult.stripePublishableKey) and
 * caches it per URI (see providers/shared/stripe-key.ts).
 *
 * Call it from the component that renders a CheckoutModal. It requests
 * `checkout:getStripeKey` and returns the `checkout:stripeKey` reply, ''
 * until it arrives (consumers already gate checkout UI on a non-empty key).
 * A panel can mount before the server connection lands, so an empty reply is
 * retried with bounded backoff and re-requested the moment a connection
 * arrives — otherwise key==='' would strand checkout for the panel's whole
 * lifetime. Uses the auxiliary-bridge pattern (own window listener +
 * getVsCodeApi) so it composes with the webview's main useMessaging without
 * re-running the view:ready handshake.
 */

import { useEffect, useState } from 'react';
import { getVsCodeApi } from './useMessaging';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Bounded backoff for an empty reply — a transient probe failure (the server
 *  not reachable yet) must not strand checkout, but the retries must not spin
 *  forever either. A landed connection refills this budget. */
const MAX_EMPTY_RETRIES = 5;
const BASE_RETRY_MS = 1000;

// =============================================================================
// HOOK
// =============================================================================

/**
 * Fetch the connected server's Stripe publishable key from the extension host.
 *
 * @param enabled - Skip the request entirely when false (e.g. a CloudPanel
 *                  rendered without checkout callbacks never mounts a modal).
 * @returns The server's publishable key, or '' while loading / when the
 *          server has no billing configured / when disabled.
 */
export function useStripeKey(enabled = true): string {
	const [key, setKey] = useState('');

	useEffect(() => {
		if (!enabled) return;

		// Once a non-empty key resolves it never changes for a server — settle
		// and stop asking. Until then an empty reply schedules a bounded backoff
		// retry, and a landed connection re-asks immediately (the first request
		// commonly races ahead of the server connection).
		let settled = false;
		let attempt = 0;
		let retryTimer: ReturnType<typeof setTimeout> | undefined;

		const request = (): void => {
			getVsCodeApi()?.postMessage({ type: 'checkout:getStripeKey' });
		};

		// Listen before asking so a fast host reply cannot be missed.
		const onHostMessage = (event: MessageEvent): void => {
			const message = event.data as { type?: string; key?: string; reason?: string; isConnected?: boolean } | undefined;
			if (!message) return;

			if (message.type === 'checkout:stripeKey') {
				// A real key settles the hook for good.
				if (message.key) {
					settled = true;
					if (retryTimer) clearTimeout(retryTimer);
					setKey(message.key);
					return;
				}
				// Empty key (no connection / probe failed) — retry with backoff
				// until the budget runs out; a connection change refills it.
				if (!settled && attempt < MAX_EMPTY_RETRIES) {
					const delay = BASE_RETRY_MS * 2 ** attempt;
					attempt += 1;
					retryTimer = setTimeout(request, delay);
				}
				return;
			}

			// A connection landing is the strongest re-request signal. It
			// covers BOTH the pre-connect mount (key==='' for the panel's
			// whole life otherwise) AND a server SWITCH: Stripe keys are
			// server-specific, so a new connection invalidates any key we
			// already settled on. Clear the settled state and the stale key
			// and re-ask, rather than keeping the previous server's key.
			if (message.type === 'shell:connectionChange' && message.isConnected) {
				settled = false;
				attempt = 0;
				if (retryTimer) clearTimeout(retryTimer);
				setKey('');
				request();
			}
		};
		window.addEventListener('message', onHostMessage);
		request();
		return () => {
			window.removeEventListener('message', onHostMessage);
			if (retryTimer) clearTimeout(retryTimer);
		};
	}, [enabled]);

	return key;
}
