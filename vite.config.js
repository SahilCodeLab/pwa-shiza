import { defineConfig } from 'vite';
import webpush from 'web-push';

const VAPID_PUBLIC_KEY = 'BMbt23eOSeAzwTYy-b8q6xfVVxE587ohJMXtVOAyA6zGslwVLT5TKct9Bhz8tBYP_qs65EFtsPw1_52oqM1EsU0';
const VAPID_PRIVATE_KEY = 'uIwUCN0vR3k9XdgkRgdgiOW5rzG6KqFQ-KmcB2PQv_o';
const VAPID_SUBJECT = 'mailto:stealth-messenger@app.internal';

webpush.setVapidDetails(
    VAPID_SUBJECT,
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY
);

// In-memory subscription cache as immediate fallback
const subscriptions = new Map();

// Firebase RTDB helper to fetch stored subscription if not in memory
async function getStoredSubscription(username) {
    if (subscriptions.has(username)) {
        return subscriptions.get(username);
    }
    try {
        const res = await fetch(`https://sr-login-cef1c-default-rtdb.firebaseio.com/chats/users_push_subs/${username}.json`);
        if (res.ok) {
            const data = await res.json();
            if (data && data.endpoint && data.keys) {
                subscriptions.set(username, data);
                return data;
            }
        }
    } catch (e) {
        console.warn('[WebPush] Error fetching subscription from Firebase:', e);
    }
    return null;
}

export default defineConfig({
    plugins: [
        {
            name: 'web-push-api-middleware',
            configureServer(server) {
                // Parse JSON body helper
                function parseJsonBody(req) {
                    return new Promise((resolve) => {
                        let body = '';
                        req.on('data', chunk => { body += chunk; });
                        req.on('end', () => {
                            try {
                                resolve(JSON.parse(body || '{}'));
                            } catch (e) {
                                resolve({});
                            }
                        });
                        req.on('error', () => resolve({}));
                    });
                }

                // 1. Get VAPID public key
                server.middlewares.use('/api/vapid-key', (req, res) => {
                    res.setHeader('Content-Type', 'application/json');
                    res.setHeader('Access-Control-Allow-Origin', '*');
                    res.end(JSON.stringify({ publicKey: VAPID_PUBLIC_KEY }));
                });

                // 2. Save push subscription
                server.middlewares.use('/api/save-subscription', async (req, res) => {
                    if (req.method === 'OPTIONS') {
                        res.setHeader('Access-Control-Allow-Origin', '*');
                        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
                        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
                        res.statusCode = 200;
                        return res.end();
                    }

                    if (req.method !== 'POST') {
                        res.statusCode = 405;
                        return res.end('Method Not Allowed');
                    }

                    const data = await parseJsonBody(req);
                    const { username, subscription } = data;

                    if (username && subscription && subscription.endpoint) {
                        subscriptions.set(username, subscription);
                        console.log(`[WebPush] Subscription registered for user: ${username}`);
                        res.setHeader('Content-Type', 'application/json');
                        res.setHeader('Access-Control-Allow-Origin', '*');
                        return res.end(JSON.stringify({ success: true, user: username }));
                    }

                    res.statusCode = 400;
                    res.setHeader('Content-Type', 'application/json');
                    res.end(JSON.stringify({ error: 'Missing username or subscription' }));
                });

                // 3. Send Web Push to recipient's device (wakes up phone when app is completely closed)
                server.middlewares.use('/api/send-push', async (req, res) => {
                    if (req.method === 'OPTIONS') {
                        res.setHeader('Access-Control-Allow-Origin', '*');
                        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
                        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
                        res.statusCode = 200;
                        return res.end();
                    }

                    if (req.method !== 'POST') {
                        res.statusCode = 405;
                        return res.end('Method Not Allowed');
                    }

                    const body = await parseJsonBody(req);
                    const { recipient, sender, stealthType, preview } = body;

                    if (!recipient) {
                        res.statusCode = 400;
                        res.setHeader('Content-Type', 'application/json');
                        return res.end(JSON.stringify({ error: 'Recipient is required' }));
                    }

                    const sub = await getStoredSubscription(recipient);
                    if (!sub) {
                        console.log(`[WebPush] No push subscription found for ${recipient}`);
                        res.setHeader('Content-Type', 'application/json');
                        res.setHeader('Access-Control-Allow-Origin', '*');
                        return res.end(JSON.stringify({ success: false, reason: 'No subscription yet for recipient' }));
                    }

                    const payload = JSON.stringify({
                        title: 'Notification',
                        body: 'Pending notification',
                        stealthType: String(stealthType || '1'),
                        sender: sender || 'secret',
                        preview: preview || '',
                        timestamp: Date.now()
                    });

                    try {
                        await webpush.sendNotification(sub, payload, {
                            TTL: 60 * 60 * 24 // 24 hours delivery guarantee
                        });
                        console.log(`[WebPush] Push sent successfully to ${recipient}`);
                        res.setHeader('Content-Type', 'application/json');
                        res.setHeader('Access-Control-Allow-Origin', '*');
                        return res.end(JSON.stringify({ success: true, recipient }));
                    } catch (err) {
                        console.error(`[WebPush] Failed to send push to ${recipient}:`, err.message);
                        if (err.statusCode === 410 || err.statusCode === 404) {
                            subscriptions.delete(recipient);
                        }
                        res.setHeader('Content-Type', 'application/json');
                        res.setHeader('Access-Control-Allow-Origin', '*');
                        return res.end(JSON.stringify({ success: false, error: err.message }));
                    }
                });
            }
        }
    ],
    server: {
        host: '0.0.0.0',
        port: 3000
    }
});
