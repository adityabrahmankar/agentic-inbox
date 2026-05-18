// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

export interface Env extends Cloudflare.Env {
	POLICY_AUD: string;
	TEAM_DOMAIN: string;
	VAPID_PUBLIC_KEY: Cloudflare.Env["VAPID_PUBLIC_KEY"];
	VAPID_PRIVATE_KEY?: string;
	VAPID_SUBJECT: Cloudflare.Env["VAPID_SUBJECT"];
}
