const DEFAULT_URL = "/";

self.addEventListener("install", () => {
	self.skipWaiting();
});

self.addEventListener("activate", (event) => {
	event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
	let data = {};
	if (event.data) {
		try {
			data = event.data.json();
		} catch {
			data = { body: event.data.text() };
		}
	}

	const title = data.title || "New email";
	const options = {
		body: data.body || "Open Agentic Inbox to read it.",
		icon: "/icons/icon-192.png",
		badge: "/icons/icon-192.png",
		tag: data.tag || "agentic-inbox-email",
		data: {
			url: data.url || DEFAULT_URL,
			mailboxId: data.mailboxId,
			emailId: data.emailId,
		},
	};

	event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
	event.notification.close();
	const rawUrl = event.notification.data?.url || DEFAULT_URL;
	const targetUrl = new URL(rawUrl, self.location.origin).href;

	event.waitUntil((async () => {
		const clientsList = await self.clients.matchAll({
			type: "window",
			includeUncontrolled: true,
		});
		for (const client of clientsList) {
			if ("focus" in client) {
				await client.focus();
				if ("navigate" in client) await client.navigate(targetUrl);
				return;
			}
		}
		if (self.clients.openWindow) await self.clients.openWindow(targetUrl);
	})());
});
