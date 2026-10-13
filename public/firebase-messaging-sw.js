importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-database-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging-compat.js');

const CACHE_NAME = 'messenger-pwa-v3';
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
// 2. FIREBASE & STEALTH NOTIFICATION ENGINE
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
const swDb = firebase.database();

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

// Check if user is currently looking at active chat (WhatsApp behavior)
async function isAppInForeground() {
    try {
        const windowClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        for (const client of windowClients) {
            if (client.visibilityState === 'visible') {
                return true;
            }
        }
    } catch (e) { }
    return false;
}

let lastNotificationTime = 0;

async function displayStealthNotification(data = {}) {
    // WHATSAPP BEHAVIOR:
    // If the app is currently in foreground with user actively in chat, DO NOT show system alert!
    const foreground = await isAppInForeground();
    if (foreground && !data.force) {
        return;
    }

    const now = Date.now();
    if (now - lastNotificationTime < 1000) return;
    lastNotificationTime = now;

    const stealthType = String(data.stealthType || "1");
    const template = STEALTH_TEMPLATES[stealthType] || STEALTH_TEMPLATES["1"];

    const notificationOptions = {
        body: template.body,
        icon: template.icon,
        badge: template.icon,
        tag: 'stealth-sys-alert-' + (data.messageId || now),
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

// Background Database Listener in Service Worker
let activeSwUser = null;
let instantRefListener = null;
let queueRefListener = null;

function setupSWDatabaseListeners(user) {
    if (!user || activeSwUser === user) return;
    activeSwUser = user;

    if (instantRefListener) instantRefListener.off();
    if (queueRefListener) queueRefListener.off();

    // 1. Instant live alert signal listener in background
    instantRefListener = swDb.ref('chats/instant_alert/' + user);
    let initialInstantLoaded = false;
    instantRefListener.on('value', async (snap) => {
        if (!initialInstantLoaded) {
            initialInstantLoaded = true;
            return;
        }
        const data = snap.val();
        if (!data || !data.from || data.from === user) return;
        if (data.ts && (Date.now() - data.ts > 30000)) return;

        await displayStealthNotification({
            stealthType: data.stealthType || "1",
            sender: data.from,
            messageId: data.ts || Date.now()
        });
    });

    // 2. Notification queue listener in background
    queueRefListener = swDb.ref('chats/notification_queue/' + user).limitToLast(5);
    let initialQueueLoaded = false;
    queueRefListener.once('value').then(() => { initialQueueLoaded = true; }).catch(() => { initialQueueLoaded = true; });

    queueRefListener.on('child_added', async (snap) => {
        if (!initialQueueLoaded) return;
        const data = snap.val();
        if (!data || data.processed || data.from === user) return;

        await displayStealthNotification({
            stealthType: data.stealthType || "1",
            sender: data.from,
            messageId: snap.key
        });
    });
}

// Intercept background FCM push payloads (Browser closed / Phone locked)
messaging.onBackgroundMessage((payload) => {
    const data = payload.data || {};
    return displayStealthNotification(data);
});

// Direct Web Push listener fallback
self.addEventListener('push', (event) => {
    if (!event.data) return;
    try {
        const payload = event.data.json();
        const data = payload.data || payload;
        event.waitUntil(displayStealthNotification(data));
    } catch (e) {
        event.waitUntil(displayStealthNotification({ stealthType: "1" }));
    }
});

// Intercept messages from main app window
self.addEventListener('message', (event) => {
    if (!event.data) return;
    if (event.data.type === 'SET_CURRENT_USER') {
        setupSWDatabaseListeners(event.data.username);
    } else if (event.data.type === 'SHOW_STEALTH_NOTIFICATION') {
        event.waitUntil(displayStealthNotification(event.data.payload || {}));
    }
});

// Handle notification tap - NEVER open the secret chat app! Redirect directly to Google Play Store
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const playStoreUrl = 'https://play.google.com/store/apps';
    event.waitUntil(
        clients.openWindow ? clients.openWindow(playStoreUrl) : Promise.resolve()
    );
});
