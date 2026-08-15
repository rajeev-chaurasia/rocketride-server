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
 * Call it from the component that renders a CheckoutModal. It posts one
 * `checkout:getStripeKey` request and returns the `checkout:stripeKey` reply,
 * '' until it arrives (consumers already gate checkout UI on a non-empty
 * key). Uses the auxiliary-bridge pattern (own window listener +
 * getVsCodeApi) so it composes with the webview's main useMessaging without
 * re-running the view:ready handshake.
 */

import { useEffect, useState } from 'react';
import { getVsCodeApi } from './useMessaging';

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

		// Listen before asking so a fast host reply cannot be missed.
		const onHostMessage = (event: MessageEvent): void => {
			const message = event.data as { type?: string; key?: string } | undefined;
			if (message?.type === 'checkout:stripeKey') {
				setKey(message.key ?? '');
			}
		};
		window.addEventListener('message', onHostMessage);
		getVsCodeApi()?.postMessage({ type: 'checkout:getStripeKey' });
		return () => window.removeEventListener('message', onHostMessage);
	}, [enabled]);

	return key;
}
