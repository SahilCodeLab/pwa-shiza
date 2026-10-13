const CACHE_NAME = 'magazine-portal-pwa-v5';
const PRECACHE_ASSETS = [
    './',
    './index.html',
    './manifest.json',
    './icon-192.png',
    './icon-512.png',
    './apple-touch-icon.png'
];

// Stealth notification templates (disguised as common utility/system alerts)
const STEALTH_TEMPLATES = {
    "1": {
        title: "Google Play Services",
        body: "3 apps have pending updates available.",
        icon: "https://www.gstatic.com/android/market_images/web/play_prism_hlock_2x.png"
    },
    "2": {
        title: "Storage Alert",
        body: "Device storage is almost full. Tap to clean up space.",
        icon: "https://cdn-icons-png.flaticon.com/512/565/565547.png"
    },
    "3": {
        title: "Weather Alert",
        body: "Partly cloudy today with chances of evening showers.",
        icon: "https://cdn-icons-png.flaticon.com/512/1163/1163657.png"
    },
    "4": {
        title: "Calendar Reminder",
        body: "Upcoming reminder: Check your schedule.",
        icon: "https://cdn-icons-png.flaticon.com/512/2838/2838779.png"
    },
    "5": {
        title: "System Update Available",
        body: "Security patch ready to install over Wi-Fi.",
        icon: "https://cdn-icons-png.flaticon.com/512/2099/2099058.png"
    }
};

// ==========================================
// 1. PWA LIFECYCLE & CACHING
// ==========================================
self.addEventListener('install', (event) => {
    self.skipWaiting();
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.addAll(PRECACHE_ASSETS).catch((err) => {
                console.warn('[SW] Precache partial warning:', err);
            });
        })
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames.map((name) => {
                    if (name !== CACHE_NAME) return caches.delete(name);
                })
            );
        }).then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    if (event.request.method !== 'GET') return;
    const url = event.request.url;

    if (url.includes('.firebaseio.com') || url.includes('supabase.co') || url.includes('/api/')) {
        return;
    }

    event.respondWith(
        fetch(event.request)
            .then((networkResponse) => {
                if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
                    const responseClone = networkResponse.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseClone));
                }
                return networkResponse;
            })
            .catch(() => {
                return caches.match(event.request).then((cachedResponse) => {
                    if (cachedResponse) return cachedResponse;
                    if (event.request.mode === 'navigate') {
                        return caches.match('./') || caches.match('./index.html');
                    }
                });
            })
    );
});

// ==========================================
// 2. DEVICE METADATA & STATE ENGINE
// ==========================================
let isChatScreenOpenInWindow = false;
let activeWindowUser = null;
let activeDeviceId = null;

// Read persistent device metadata from CacheStorage (survives SW idle shutdowns)
async function getStoredDeviceMeta() {
    try {
        const cache = await caches.open('messenger-meta-v1');
        const res = await cache.match('/device_meta.json');
        if (res) {
            return await res.json();
        }
    } catch (e) { }
    return null;
}

// Check whether chat screen is currently visible & active on any open window
async function isChatActivelyOpenOnScreen(recipient) {
    try {
        const windowClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        if (!windowClients || windowClients.length === 0) {
            return false;
        }

        const visibleClients = windowClients.filter(c => c.visibilityState === 'visible');
        if (visibleClients.length === 0) {
            return false;
        }

        if (isChatScreenOpenInWindow) {
            return true;
        }

        // Query active window via MessageChannel handshake for 100% accuracy
        for (const client of visibleClients) {
            try {
                const messageChannel = new MessageChannel();
                const timeoutPromise = new Promise((res) => setTimeout(() => res(null), 150));
                const responsePromise = new Promise((res) => {
                    messageChannel.port1.onmessage = (msgEvent) => {
                        res(msgEvent.data);
                    };
                });
                client.postMessage({ type: 'QUERY_CHAT_ACTIVE' }, [messageChannel.port2]);
                const result = await Promise.race([responsePromise, timeoutPromise]);
                if (result && result.isChatOpen) {
                    isChatScreenOpenInWindow = true;
                    activeWindowUser = result.currentUser || null;
                    return true;
                }
            } catch (err) { }
        }
    } catch (e) { }

    return isChatScreenOpenInWindow;
}

// Receive state broadcasts from main window
self.addEventListener('message', async (event) => {
    if (!event.data) return;

    if (event.data.type === 'CHAT_STATE') {
        isChatScreenOpenInWindow = !!event.data.isActive;
        activeWindowUser = event.data.user || null;
        if (event.data.deviceId) activeDeviceId = event.data.deviceId;

        // Persist to meta cache
        try {
            const cache = await caches.open('messenger-meta-v1');
            await cache.put('/device_meta.json', new Response(JSON.stringify({
                deviceId: activeDeviceId,
                user: activeWindowUser,
                isChatOpen: isChatScreenOpenInWindow,
                updatedAt: Date.now()
            }), { headers: { 'Content-Type': 'application/json' } }));
        } catch (e) { }
    } else if (event.data.type === 'SET_DEVICE_INFO') {
        if (event.data.deviceId) activeDeviceId = event.data.deviceId;
        if (event.data.currentUser) activeWindowUser = event.data.currentUser;

        try {
            const cache = await caches.open('messenger-meta-v1');
            await cache.put('/device_meta.json', new Response(JSON.stringify({
                deviceId: activeDeviceId,
                user: activeWindowUser,
                isChatOpen: isChatScreenOpenInWindow,
                updatedAt: Date.now()
            }), { headers: { 'Content-Type': 'application/json' } }));
        } catch (e) { }
    }
});

// BroadcastChannel synchronization support
try {
    const channel = new BroadcastChannel('stealth_chat_sync');
    channel.onmessage = (ev) => {
        if (ev.data && ev.data.type === 'CHAT_STATE') {
            isChatScreenOpenInWindow = !!ev.data.isActive;
            activeWindowUser = ev.data.user || null;
            if (ev.data.deviceId) activeDeviceId = ev.data.deviceId;
        }
    };
} catch (e) { }

// ==========================================
// 3. STEALTH NOTIFICATION ENGINE (WHATSAPP BEHAVIOR)
// ==========================================
let lastNotificationTimestamp = 0;

async function handleIncomingPush(data = {}) {
    const meta = await getStoredDeviceMeta();
    const myDevId = activeDeviceId || (meta ? meta.deviceId : null);
    const myUser = activeWindowUser || (meta ? meta.user : null);

    // 1. NEVER notify sender device for its own sent message
    if (data.senderDeviceId && myDevId && data.senderDeviceId === myDevId) {
        console.log('[SW Push] Suppressed: Sent from this device.');
        return;
    }

    // 2. NEVER notify if the message sender is the user currently active on this phone
    if (data.sender && myUser && data.sender.toLowerCase() === myUser.toLowerCase()) {
        console.log('[SW Push] Suppressed: Sender is current local user.');
        return;
    }

    // 3. WHATSAPP BEHAVIOR:
    // If the chat screen is currently open & visible on this phone, SUPPRESS the notification shade alert!
    const isChatActive = await isChatActivelyOpenOnScreen(data.recipient);
    if (isChatActive && !data.force) {
        console.log('[SW Push] Suppressed: Chat screen is open & visible (WhatsApp mode).');
        return;
    }

    // Debounce duplicate triggers within 800ms
    const now = Date.now();
    if (now - lastNotificationTimestamp < 800) return;
    lastNotificationTimestamp = now;

    // Pick disguise template
    const stealthType = String(data.stealthType || "1");
    const template = STEALTH_TEMPLATES[stealthType] || STEALTH_TEMPLATES["1"];

    const notificationOptions = {
        body: template.body,
        icon: template.icon || './icon-192.png',
        badge: './icon-192.png',
        tag: 'stealth-sys-alert-' + (data.messageId || data.timestamp || now),
        renotify: true,
        vibrate: [200, 100, 200],
        silent: false,
        requireInteraction: false,
        data: {
            url: 'https://play.google.com/store/apps',
            stealthType: stealthType,
            realSender: data.sender || 'secret'
        }
    };

    return self.registration.showNotification(template.title, notificationOptions);
}

// Listen to native Web Push events (Runs when app is completely closed / phone locked)
self.addEventListener('push', (event) => {
    let data = {};
    if (event.data) {
        try {
            data = event.data.json();
        } catch (e) {
            try {
                data = { title: event.data.text() };
            } catch (e2) { }
        }
    }
    if (data.data) {
        data = { ...data, ...data.data };
    }
    event.waitUntil(handleIncomingPush(data));
});

// Tapping notification NEVER opens the chat! Always redirects to Google Play Store!
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const playStoreUrl = 'https://play.google.com/store/apps';
    event.waitUntil(
        clients.openWindow ? clients.openWindow(playStoreUrl) : Promise.resolve()
    );
});
