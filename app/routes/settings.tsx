// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Badge, Button, Input, Loader, useKumoToastManager } from "@cloudflare/kumo";
import { RobotIcon, ArrowCounterClockwiseIcon, BellRingingIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { useParams } from "react-router";
import { useMailbox, useUpdateMailbox } from "~/queries/mailboxes";
import api from "~/services/api";

// Placeholder shown in the textarea when no custom prompt is set.
// The authoritative default prompt lives in workers/agent/index.ts (DEFAULT_SYSTEM_PROMPT).
const PROMPT_PLACEHOLDER = `You are an email assistant that helps manage this inbox. You read emails, draft replies, and help organize conversations.\n\nWrite like a real person. Short, direct, flowing prose. Plain text only.\n\n(Leave empty to use the full built-in default prompt)`;

function base64UrlToUint8Array(value: string) {
	const padding = "=".repeat((4 - value.length % 4) % 4);
	const base64 = `${value}${padding}`.replace(/-/g, "+").replace(/_/g, "/");
	const raw = window.atob(base64);
	const output = new Uint8Array(raw.length);
	for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
	return output;
}

function getPushUnsupportedReason() {
	if (typeof window === "undefined") return "Notifications are not available during server rendering.";
	if (!window.isSecureContext) return "Notifications require HTTPS.";
	if (!("Notification" in window)) return "This browser does not support notifications.";
	if (!("serviceWorker" in navigator)) return "This browser does not support service workers.";
	if (!("PushManager" in window)) return "This browser does not support web push.";
	return null;
}

async function ensureServiceWorkerRegistration() {
	const existing = await navigator.serviceWorker.getRegistration("/");
	if (existing) return existing;
	return navigator.serviceWorker.register("/sw.js");
}

export default function SettingsRoute() {
	const { mailboxId } = useParams<{ mailboxId: string }>();
	const toastManager = useKumoToastManager();
	const { data: mailbox } = useMailbox(mailboxId);
	const updateMailboxMutation = useUpdateMailbox();

	const [displayName, setDisplayName] = useState("");
	const [agentPrompt, setAgentPrompt] = useState("");
	const [isSaving, setIsSaving] = useState(false);
	const [pushPublicKey, setPushPublicKey] = useState<string | null>(null);
	const [pushEnabled, setPushEnabled] = useState(false);
	const [pushStatus, setPushStatus] = useState("Checking notification support...");
	const [isPushBusy, setIsPushBusy] = useState(false);

	useEffect(() => {
		if (mailbox) {
			setDisplayName(mailbox.settings?.fromName || mailbox.name || "");
			setAgentPrompt(mailbox.settings?.agentSystemPrompt || "");
		}
	}, [mailbox]);

	useEffect(() => {
		if (!mailboxId) return;
		let cancelled = false;

		async function loadPushState() {
			const unsupportedReason = getPushUnsupportedReason();
			if (unsupportedReason) {
				if (!cancelled) setPushStatus(unsupportedReason);
				return;
			}

			try {
				const config = await api.getPushConfig();
				if (!config.enabled || !config.publicKey) {
					if (!cancelled) {
						setPushPublicKey(null);
						setPushEnabled(false);
						setPushStatus("Push notifications are not configured on the server.");
					}
					return;
				}

				const registration = await ensureServiceWorkerRegistration();
				const subscription = await registration.pushManager.getSubscription();
				if (!cancelled) {
					setPushPublicKey(config.publicKey);
					setPushEnabled(Boolean(subscription));
					setPushStatus(subscription ? "Enabled on this device." : "Ready to enable on this device.");
				}
			} catch {
				if (!cancelled) {
					setPushPublicKey(null);
					setPushEnabled(false);
					setPushStatus("Could not check notification support.");
				}
			}
		}

		void loadPushState();
		return () => {
			cancelled = true;
		};
	}, [mailboxId]);

	const handleSave = async () => {
		if (!mailbox || !mailboxId) return;
		setIsSaving(true);
		const settings = {
			...mailbox.settings,
			fromName: displayName,
			agentSystemPrompt: agentPrompt.trim() || undefined,
		};
		try {
			await updateMailboxMutation.mutateAsync({ mailboxId, settings });
			toastManager.add({ title: "Settings saved!" });
		} catch {
			toastManager.add({
				title: "Failed to save settings",
				variant: "error",
			});
		} finally {
			setIsSaving(false);
		}
	};

	const handleResetPrompt = () => {
		setAgentPrompt("");
	};

	const handleEnablePush = async () => {
		if (!mailboxId || !pushPublicKey) return;
		setIsPushBusy(true);
		try {
			const permission = await Notification.requestPermission();
			if (permission !== "granted") {
				setPushStatus(permission === "denied"
					? "Notifications are blocked in this browser."
					: "Notifications were not enabled.");
				return;
			}

			const registration = await ensureServiceWorkerRegistration();
			let subscription = await registration.pushManager.getSubscription();
			if (!subscription) {
				subscription = await registration.pushManager.subscribe({
					userVisibleOnly: true,
					applicationServerKey: base64UrlToUint8Array(pushPublicKey),
				});
			}

			await api.subscribePush(mailboxId, subscription.toJSON());
			setPushEnabled(true);
			setPushStatus("Enabled on this device.");
			toastManager.add({ title: "Notifications enabled" });
		} catch (error) {
			setPushStatus("Could not enable notifications.");
			toastManager.add({
				title: error instanceof Error ? error.message : "Failed to enable notifications",
				variant: "error",
			});
		} finally {
			setIsPushBusy(false);
		}
	};

	const handleDisablePush = async () => {
		if (!mailboxId) return;
		setIsPushBusy(true);
		try {
			const registration = await navigator.serviceWorker.getRegistration("/");
			const subscription = await registration?.pushManager.getSubscription();
			if (subscription) {
				await api.unsubscribePush(mailboxId, subscription.endpoint).catch(() => {});
				await subscription.unsubscribe();
			}
			setPushEnabled(false);
			setPushStatus("Ready to enable on this device.");
			toastManager.add({ title: "Notifications disabled" });
		} catch {
			toastManager.add({ title: "Failed to disable notifications", variant: "error" });
		} finally {
			setIsPushBusy(false);
		}
	};

	const handleTestPush = async () => {
		if (!mailboxId) return;
		setIsPushBusy(true);
		try {
			await api.sendTestPush(mailboxId);
			toastManager.add({ title: "Test notification sent" });
		} catch (error) {
			toastManager.add({
				title: error instanceof Error ? error.message : "Failed to send test notification",
				variant: "error",
			});
		} finally {
			setIsPushBusy(false);
		}
	};

	if (!mailbox) {
		return (
			<div className="flex justify-center py-20">
				<Loader size="lg" />
			</div>
		);
	}

	const isCustomPrompt = agentPrompt.trim().length > 0;

	return (
		<div className="max-w-2xl px-4 py-4 md:px-8 md:py-6 h-full overflow-y-auto">
			<h1 className="text-lg font-semibold text-kumo-default mb-6">Settings</h1>

			<div className="space-y-6">
				{/* Account */}
				<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
					<div className="text-sm font-medium text-kumo-default mb-4">
						Account
					</div>
					<div className="space-y-3">
						<Input
							label="Display Name"
							value={displayName}
							onChange={(e) => setDisplayName(e.target.value)}
						/>
						<Input label="Email" type="email" value={mailbox.email} disabled />
					</div>
				</div>

				{/* Push Notifications */}
				<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
					<div className="flex items-center justify-between mb-4">
						<div className="flex items-center gap-2">
							<BellRingingIcon size={16} weight="duotone" className="text-kumo-subtle" />
							<span className="text-sm font-medium text-kumo-default">
								Email Notifications
							</span>
							<Badge variant={pushEnabled ? "primary" : "secondary"}>
								{pushEnabled ? "Enabled" : "Off"}
							</Badge>
						</div>
					</div>
					<p className="text-xs text-kumo-subtle mb-3">
						Get an alert when this mailbox receives a new email.
						On iPhone, enable this from the installed Home Screen app.
					</p>
					<div className="flex flex-col gap-2 sm:flex-row">
						<Button
							variant={pushEnabled ? "secondary" : "primary"}
							size="sm"
							onClick={pushEnabled ? handleDisablePush : handleEnablePush}
							disabled={!pushPublicKey || isPushBusy}
							loading={isPushBusy}
						>
							{pushEnabled ? "Disable on this device" : "Enable on this device"}
						</Button>
						{pushEnabled && (
							<Button
								variant="secondary"
								size="sm"
								onClick={handleTestPush}
								disabled={isPushBusy}
							>
								Send test
							</Button>
						)}
					</div>
					<p className="text-xs text-kumo-subtle mt-3">{pushStatus}</p>
				</div>

				{/* Agent System Prompt */}
				<div className="rounded-lg border border-kumo-line bg-kumo-base p-5">
					<div className="flex items-center justify-between mb-4">
						<div className="flex items-center gap-2">
							<RobotIcon size={16} weight="duotone" className="text-kumo-subtle" />
							<span className="text-sm font-medium text-kumo-default">
								AI Agent Prompt
							</span>
							{isCustomPrompt ? (
								<Badge variant="primary">Custom</Badge>
							) : (
								<Badge variant="secondary">Default</Badge>
							)}
						</div>
						{isCustomPrompt && (
							<Button
								variant="ghost"
								size="xs"
								icon={<ArrowCounterClockwiseIcon size={14} />}
								onClick={handleResetPrompt}
							>
								Reset to default
							</Button>
						)}
					</div>
					<p className="text-xs text-kumo-subtle mb-3">
						Customize how the AI agent behaves for this mailbox.
						Leave empty to use the built-in default prompt.
					</p>
					<textarea
						value={agentPrompt}
						onChange={(e) => setAgentPrompt(e.target.value)}
						placeholder={PROMPT_PLACEHOLDER}
						rows={12}
						className="w-full resize-y rounded-lg border border-kumo-line bg-kumo-recessed px-3 py-2 text-xs text-kumo-default placeholder:text-kumo-subtle focus:outline-none focus:ring-1 focus:ring-kumo-ring font-mono leading-relaxed"
					/>
					<p className="text-xs text-kumo-subtle mt-2">
						The prompt is sent as the system message to the AI model.
						It controls the agent's personality, writing style, and behavior rules.
					</p>
				</div>

				{/* Save */}
				<div className="flex justify-end">
					<Button variant="primary" onClick={handleSave} loading={isSaving}>
						Save Changes
					</Button>
				</div>
			</div>
		</div>
	);
}
