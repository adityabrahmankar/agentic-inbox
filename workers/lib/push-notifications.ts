// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { Env } from "../types";

const SUBSCRIPTION_PREFIX = "push-subscriptions";
const DEFAULT_VAPID_SUBJECT = "https://supportfa.st";
const AES_128_GCM_RECORD_SIZE = 4096;

export interface IncomingPushNotification {
	emailId: string;
	mailboxId: string;
	sender: string;
	subject: string;
	url: string;
}

interface StoredPushSubscription {
	id: string;
	mailboxId: string;
	subscription: PushSubscription;
	createdAt: string;
	updatedAt: string;
	userAgent?: string;
	origin?: string;
}

interface PushSubscription {
	endpoint: string;
	expirationTime?: number | null;
	keys: {
		p256dh: string;
		auth: string;
	};
}

export interface PushDeliveryResult {
	total: number;
	sent: number;
	removed: number;
	skipped?: "not_configured" | "no_subscriptions";
}

function getMailboxSubscriptionPrefix(mailboxId: string) {
	return `${SUBSCRIPTION_PREFIX}/${encodeURIComponent(mailboxId)}/`;
}

function toHex(bytes: ArrayBuffer) {
	return Array.from(new Uint8Array(bytes))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

function toBase64Url(bytes: Uint8Array) {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string) {
	const padding = "=".repeat((4 - value.length % 4) % 4);
	const base64 = `${value}${padding}`.replace(/-/g, "+").replace(/_/g, "/");
	const raw = atob(base64);
	const bytes = new Uint8Array(raw.length);
	for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
	return bytes;
}

function concatBytes(...arrays: Uint8Array[]) {
	const length = arrays.reduce((sum, array) => sum + array.byteLength, 0);
	const result = new Uint8Array(length);
	let offset = 0;
	for (const array of arrays) {
		result.set(array, offset);
		offset += array.byteLength;
	}
	return result;
}

function toArrayBuffer(bytes: Uint8Array) {
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function subscriptionId(endpoint: string) {
	const encoded = new TextEncoder().encode(endpoint);
	const digest = await crypto.subtle.digest("SHA-256", encoded);
	return toHex(digest);
}

async function hmacSha256(keyBytes: Uint8Array, data: Uint8Array) {
	const key = await crypto.subtle.importKey(
		"raw",
		toArrayBuffer(keyBytes),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	return new Uint8Array(await crypto.subtle.sign("HMAC", key, toArrayBuffer(data)));
}

async function hkdfExpand(prk: Uint8Array, info: Uint8Array, length: number) {
	const result = await hmacSha256(prk, concatBytes(info, new Uint8Array([1])));
	return result.slice(0, length);
}

function validateSubscription(subscription: PushSubscription) {
	const endpoint = new URL(subscription.endpoint);
	if (endpoint.protocol !== "https:") {
		throw new Error("Push subscription endpoint must use HTTPS");
	}
	if (!subscription.keys?.p256dh || !subscription.keys?.auth) {
		throw new Error("Push subscription is missing encryption keys");
	}
}

export function getPushConfig(env: Env) {
	const publicKey = env.VAPID_PUBLIC_KEY?.trim() || null;
	const privateKey = env.VAPID_PRIVATE_KEY?.trim() || null;
	return {
		enabled: Boolean(publicKey && privateKey),
		publicKey,
	};
}

function getVapidDetails(env: Env, origin?: string) {
	const publicKey = env.VAPID_PUBLIC_KEY?.trim();
	const privateKey = env.VAPID_PRIVATE_KEY?.trim();
	if (!publicKey || !privateKey) return null;
	return {
		subject: env.VAPID_SUBJECT?.trim() || origin || DEFAULT_VAPID_SUBJECT,
		publicKey,
		privateKey,
	};
}

async function createVapidAuthorization(
	subscription: PushSubscription,
	vapidDetails: { subject: string; publicKey: string; privateKey: string },
) {
	const publicKeyBytes = fromBase64Url(vapidDetails.publicKey);
	if (publicKeyBytes.byteLength !== 65 || publicKeyBytes[0] !== 4) {
		throw new Error("Invalid VAPID public key");
	}

	const jwk = {
		kty: "EC",
		crv: "P-256",
		x: toBase64Url(publicKeyBytes.slice(1, 33)),
		y: toBase64Url(publicKeyBytes.slice(33, 65)),
		d: vapidDetails.privateKey,
	};
	const key = await crypto.subtle.importKey(
		"jwk",
		jwk,
		{ name: "ECDSA", namedCurve: "P-256" },
		false,
		["sign"],
	);
	const endpointOrigin = new URL(subscription.endpoint).origin;
	const header = toBase64Url(
		new TextEncoder().encode(JSON.stringify({ alg: "ES256", typ: "JWT" })),
	);
	const claims = toBase64Url(
		new TextEncoder().encode(JSON.stringify({
			aud: endpointOrigin,
			exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
			sub: vapidDetails.subject,
		})),
	);
	const signingInput = `${header}.${claims}`;
	const signature = new Uint8Array(await crypto.subtle.sign(
		{ name: "ECDSA", hash: "SHA-256" },
		key,
		new TextEncoder().encode(signingInput),
	));
	const jwt = `${signingInput}.${toBase64Url(signature)}`;

	return `vapid t=${jwt}, k=${vapidDetails.publicKey}`;
}

async function encryptPushPayload(subscription: PushSubscription, payload: string) {
	const encoder = new TextEncoder();
	const userPublicKey = fromBase64Url(subscription.keys.p256dh);
	const authSecret = fromBase64Url(subscription.keys.auth);
	const salt = crypto.getRandomValues(new Uint8Array(16));

	const userKey = await crypto.subtle.importKey(
		"raw",
		userPublicKey,
		{ name: "ECDH", namedCurve: "P-256" },
		false,
		[],
	);
	const localKeyPair = await crypto.subtle.generateKey(
		{ name: "ECDH", namedCurve: "P-256" },
		true,
		["deriveBits"],
	);
	const localPublicKey = new Uint8Array(
		await crypto.subtle.exportKey("raw", localKeyPair.publicKey),
	);
	const sharedSecret = new Uint8Array(
		await crypto.subtle.deriveBits(
			{ name: "ECDH", public: userKey },
			localKeyPair.privateKey,
			256,
		),
	);

	const prkKey = await hmacSha256(authSecret, sharedSecret);
	const keyInfo = concatBytes(
		encoder.encode("WebPush: info"),
		new Uint8Array([0]),
		userPublicKey,
		localPublicKey,
	);
	const ikm = await hkdfExpand(prkKey, keyInfo, 32);
	const prk = await hmacSha256(salt, ikm);
	const cek = await hkdfExpand(
		prk,
		concatBytes(encoder.encode("Content-Encoding: aes128gcm"), new Uint8Array([0])),
		16,
	);
	const nonce = await hkdfExpand(
		prk,
		concatBytes(encoder.encode("Content-Encoding: nonce"), new Uint8Array([0])),
		12,
	);
	const aesKey = await crypto.subtle.importKey(
		"raw",
		cek,
		{ name: "AES-GCM", length: 128 },
		false,
		["encrypt"],
	);
	const record = concatBytes(encoder.encode(payload), new Uint8Array([2]));
	const ciphertext = new Uint8Array(
		await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, record),
	);

	const header = new Uint8Array(21 + localPublicKey.byteLength);
	header.set(salt, 0);
	new DataView(header.buffer).setUint32(16, AES_128_GCM_RECORD_SIZE, false);
	header[20] = localPublicKey.byteLength;
	header.set(localPublicKey, 21);

	return concatBytes(header, ciphertext);
}

export async function savePushSubscription(
	env: Env,
	mailboxId: string,
	subscription: PushSubscription,
	metadata: { userAgent?: string; origin?: string } = {},
) {
	validateSubscription(subscription);
	const id = await subscriptionId(subscription.endpoint);
	const key = `${getMailboxSubscriptionPrefix(mailboxId)}${id}.json`;
	const existing = await env.BUCKET.get(key);
	const now = new Date().toISOString();
	const previous = existing
		? ((await existing.json()) as StoredPushSubscription)
		: null;
	const record: StoredPushSubscription = {
		id,
		mailboxId,
		subscription,
		createdAt: previous?.createdAt ?? now,
		updatedAt: now,
		...metadata,
	};

	await env.BUCKET.put(key, JSON.stringify(record), {
		httpMetadata: { contentType: "application/json" },
	});
	return { id };
}

export async function deletePushSubscription(
	env: Env,
	mailboxId: string,
	endpoint: string,
) {
	const id = await subscriptionId(endpoint);
	await env.BUCKET.delete(`${getMailboxSubscriptionPrefix(mailboxId)}${id}.json`);
	return { id };
}

async function listPushSubscriptions(env: Env, mailboxId: string) {
	const records: StoredPushSubscription[] = [];
	const prefix = getMailboxSubscriptionPrefix(mailboxId);
	let cursor: string | undefined;

	do {
		const page = await env.BUCKET.list({ prefix, cursor });
		for (const object of page.objects) {
			const stored = await env.BUCKET.get(object.key);
			if (!stored) continue;
			records.push((await stored.json()) as StoredPushSubscription);
		}
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);

	return records;
}

function notificationBody(sender: string, subject: string) {
	const senderLabel = sender || "Unknown sender";
	const subjectLabel = subject || "(no subject)";
	const body = `${senderLabel}: ${subjectLabel}`;
	return body.length > 160 ? `${body.slice(0, 157)}...` : body;
}

async function deliverPush(
	env: Env,
	record: StoredPushSubscription,
	payload: IncomingPushNotification,
) {
	const vapidDetails = getVapidDetails(env, record.origin);
	if (!vapidDetails) return "not_configured" as const;

	const body = await encryptPushPayload(
		record.subscription,
		JSON.stringify({
			title: "New email",
			body: notificationBody(payload.sender, payload.subject),
			tag: `email-${payload.emailId}`,
			url: payload.url,
			mailboxId: payload.mailboxId,
			emailId: payload.emailId,
		}),
	);
	const authorization = await createVapidAuthorization(record.subscription, vapidDetails);

	const response = await fetch(record.subscription.endpoint, {
		method: "POST",
		headers: {
			Authorization: authorization,
			"Content-Encoding": "aes128gcm",
			"Content-Type": "application/octet-stream",
			TTL: "60",
			Urgency: "high",
		},
		body,
	});

	if (response.ok) return "sent" as const;
	if (response.status === 404 || response.status === 410) {
		await deletePushSubscription(
			env,
			record.mailboxId,
			record.subscription.endpoint,
		);
		return "removed" as const;
	}

	const text = await response.text().catch(() => "");
	console.warn(
		JSON.stringify({
			message: "push notification delivery failed",
			status: response.status,
			mailboxId: record.mailboxId,
			endpointHost: new URL(record.subscription.endpoint).host,
			error: text.slice(0, 300),
		}),
	);
	return "failed" as const;
}

export async function sendMailboxPushNotification(
	env: Env,
	payload: IncomingPushNotification,
): Promise<PushDeliveryResult> {
	if (!getVapidDetails(env)) {
		return { total: 0, sent: 0, removed: 0, skipped: "not_configured" };
	}

	const subscriptions = await listPushSubscriptions(env, payload.mailboxId);
	if (subscriptions.length === 0) {
		return { total: 0, sent: 0, removed: 0, skipped: "no_subscriptions" };
	}

	let sent = 0;
	let removed = 0;
	await Promise.all(
		subscriptions.map(async (subscription) => {
			try {
				const result = await deliverPush(env, subscription, payload);
				if (result === "sent") sent += 1;
				if (result === "removed") removed += 1;
			} catch (error) {
				console.warn(
					JSON.stringify({
						message: "push notification delivery threw",
						mailboxId: payload.mailboxId,
						error: error instanceof Error ? error.message : String(error),
					}),
				);
			}
		}),
	);

	return { total: subscriptions.length, sent, removed };
}
