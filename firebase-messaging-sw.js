importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging-compat.js');

const CACHE_NAME = 'messenger-pwa-v2';
const PRECACHE_ASSETS = [
    './',
    './index.html',
    './manifest.json',
    './icon-192.png',
    './icon-512.png',
    './apple-touch-icon.png'
];

// ==========================================
// 1. PWA LIFECYCLE & FETCH HANDLERS
// ==========================================

// Install Event: Precaches core shell and activates immediately
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

// Activate Event: Cleans outdated caches & claims clients
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

// Fetch Event: MANDATORY for mobile browser PWA installability requirements
self.addEventListener('fetch', (event) => {
    if (event.request.method !== 'GET') return;
    const url = event.request.url;

    // Do not cache realtime databases or external media streams
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
// 2. FIREBASE CLOUD MESSAGING CONFIG
// ==========================================
const firebaseConfig = {
    apiKey: "AIzaSyAii2t4g5DuJ7-BLm8v9-syyrtOmyWK8_8",
    authDomain: "sr-login-cef1c.firebaseapp.com",
    databaseURL: "https://sr-login-cef1c-default-rtdb.firebaseio.com",
    projectId: "sr-login-cef1c",
    storageBucket: "sr-login-cef1c.firebasestorage.app",
    messagingSenderId: "998421619255",
    appId: "1:998421619255:web:5f12b5c71ed93ac5c115b2"
};

firebase.initializeApp(firebaseConfig);
const messaging = firebase.messaging();

// Secret Code Mapping Logic - Pure Dummy Templates (Hides Sender & Message)
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
    },
    "0": {
        title: "System Notification",
        body: "You have 1 new pending notification.",
        icon: "./icon-192.png"
    }
};

// State management for PWA notification & sound settings
let pwaNotifEnabled = true;
let notifEnabled = true;
let soundEnabled = true;

// IndexedDB Helper for bulletproof persistence across ServiceWorker sleep/restarts
function openSettingsDB() {
    return new Promise((resolve) => {
        try {
            if (!('indexedDB' in self)) return resolve(null);
            const request = indexedDB.open('messenger_persistent_settings', 1);
            request.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains('config')) {
                    db.createObjectStore('config');
                }
            };
            request.onsuccess = (e) => resolve(e.target.result);
            request.onerror = () => resolve(null);
        } catch (e) {
            resolve(null);
        }
    });
}

async function readSettingsFromDB() {
    try {
        const db = await openSettingsDB();
        if (!db) return null;
        return new Promise((resolve) => {
            try {
                const tx = db.transaction('config', 'readonly');
                const store = tx.objectStore('config');
                const req = store.get('settings');
                req.onsuccess = () => resolve(req.result || null);
                req.onerror = () => resolve(null);
            } catch (err) {
                resolve(null);
            }
        });
    } catch (e) {
        return null;
    }
}

async function writeSettingsToDB(data) {
    try {
        const db = await openSettingsDB();
        if (!db) return;
        const tx = db.transaction('config', 'readwrite');
        const store = tx.objectStore('config');
        store.put(data, 'settings');
    } catch (e) {}
}

async function writeSettingsToCache(data) {
    try {
        if ('caches' in self) {
            const cache = await caches.open('messenger-pwa-settings');
            const res = new Response(JSON.stringify(data), {
                headers: { 'Content-Type': 'application/json' }
            });
            await cache.put('/app-settings', res);
            await cache.put('/pwa-notif-enabled', new Response(JSON.stringify({ enabled: data.pwaNotifEnabled && data.notifEnabled })));
        }
    } catch (e) {}
}

// Master function to get latest persisted settings (IndexedDB -> Cache -> Memory)
async function getLatestSettings() {
    try {
        const dbData = await readSettingsFromDB();
        if (dbData && typeof dbData === 'object') {
            if (typeof dbData.pwaNotifEnabled === 'boolean') pwaNotifEnabled = dbData.pwaNotifEnabled;
            if (typeof dbData.notifEnabled === 'boolean') notifEnabled = dbData.notifEnabled;
            if (typeof dbData.soundEnabled === 'boolean') soundEnabled = dbData.soundEnabled;
            return { pwaNotifEnabled, notifEnabled, soundEnabled };
        }
    } catch (e) {}

    try {
        if ('caches' in self) {
            const cache = await caches.open('messenger-pwa-settings');
            const match = await cache.match('/app-settings');
            if (match) {
                const data = await match.json();
                if (typeof data.pwaNotifEnabled === 'boolean') pwaNotifEnabled = data.pwaNotifEnabled;
                if (typeof data.notifEnabled === 'boolean') notifEnabled = data.notifEnabled;
                if (typeof data.soundEnabled === 'boolean') soundEnabled = data.soundEnabled;
            }
        }
    } catch (e) {
        console.warn('[SW] Could not read settings from cache:', e);
    }
    return { pwaNotifEnabled, notifEnabled, soundEnabled };
}

// Update settings and dismiss active notifications if muted
async function applyUpdatedSettings(newSettings) {
    if (typeof newSettings.pwaNotifEnabled === 'boolean') pwaNotifEnabled = newSettings.pwaNotifEnabled;
    if (typeof newSettings.notifEnabled === 'boolean') notifEnabled = newSettings.notifEnabled;
    if (typeof newSettings.soundEnabled === 'boolean') soundEnabled = newSettings.soundEnabled;

    const dataToSave = { pwaNotifEnabled, notifEnabled, soundEnabled, timestamp: Date.now() };
    await writeSettingsToDB(dataToSave);
    await writeSettingsToCache(dataToSave);

    console.log('[SW] Settings applied & persisted:', dataToSave);

    if (!pwaNotifEnabled || !notifEnabled) {
        // Immediately dismiss all lingering notifications from system bar
        try {
            const list = await self.registration.getNotifications();
            list.forEach((n) => n.close());
        } catch (e) {}
    }
}

// Listen for message events from main thread
self.addEventListener('message', async (event) => {
    if (!event.data) return;
    if (event.data.type === 'SYNC_ALL_SETTINGS') {
        await applyUpdatedSettings(event.data);
    } else if (event.data.type === 'SET_PWA_NOTIF_ENABLED') {
        await applyUpdatedSettings({ pwaNotifEnabled: !!event.data.enabled });
    }
});

// BroadcastChannel for instant cross-tab & SW sync
try {
    if ('BroadcastChannel' in self) {
        const bc = new BroadcastChannel('messenger-settings-channel');
        bc.onmessage = async (event) => {
            if (event.data && event.data.type === 'SYNC_ALL_SETTINGS') {
                await applyUpdatedSettings(event.data);
            }
        };
    }
} catch (e) {}

// Intercept background FCM push payloads (Browser closed / Phone locked)
messaging.onBackgroundMessage(async (payload) => {
    console.log('[firebase-messaging-sw.js] Background FCM message received:', payload);

    const settings = await getLatestSettings();
    if (!settings.pwaNotifEnabled || !settings.notifEnabled) {
        console.log('[firebase-messaging-sw.js] Notifications are turned OFF by user. Push completely suppressed.');
        return;
    }

    const data = payload.data || {};
    const stealthType = String(data.stealthType || "1");
    const template = STEALTH_TEMPLATES[stealthType] || STEALTH_TEMPLATES["1"];

    // Dummy notification - real sender & message content strictly hidden
    const notifTitle = template.title;
    const notifBody = template.body;

    const isSoundAllowed = settings.soundEnabled;

    const notificationOptions = {
        body: notifBody,
        icon: template.icon || './icon-192.png',
        badge: './icon-192.png',
        tag: 'messenger-alert-' + (data.messageId || Date.now()),
        renotify: isSoundAllowed,
        silent: !isSoundAllowed,
        vibrate: isSoundAllowed ? [150, 100, 150] : [],
        data: {
            url: './',
            stealthType: stealthType
        }
    };

    return self.registration.showNotification(notifTitle, notificationOptions);
});

// Generic Web Push fallback listener (Dummy Alert)
self.addEventListener('push', (event) => {
    event.waitUntil((async () => {
        const settings = await getLatestSettings();
        if (!settings.pwaNotifEnabled || !settings.notifEnabled) {
            console.log('[firebase-messaging-sw.js] Notifications are turned OFF. Push completely suppressed.');
            return;
        }

        let data = {};
        if (event.data) {
            try {
                data = event.data.json();
            } catch (e) {
                data = { text: event.data.text() };
            }
        }
        const stealthType = String(data.stealthType || "1");
        const template = STEALTH_TEMPLATES[stealthType] || STEALTH_TEMPLATES["1"];

        // Dummy notification - real sender & message content strictly hidden
        const notifTitle = template.title;
        const notifBody = template.body;

        const isSoundAllowed = settings.soundEnabled;

        return self.registration.showNotification(notifTitle, {
            body: notifBody,
            icon: template.icon || './icon-192.png',
            badge: './icon-192.png',
            tag: 'messenger-push-' + Date.now(),
            renotify: isSoundAllowed,
            silent: !isSoundAllowed,
            vibrate: isSoundAllowed ? [150, 100, 150] : [],
            data: { url: './' }
        });
    })());
});

// Handle notification tap - Open or focus the chat web application
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
            for (let client of windowClients) {
                if (client.url.includes(self.registration.scope) && 'focus' in client) {
                    return client.focus();
                }
            }
            if (clients.openWindow) {
                return clients.openWindow('./');
            }
        })
    );
});
