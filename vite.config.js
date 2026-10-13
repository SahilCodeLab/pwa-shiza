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

// In-memory subscription cache per user and device
const subscriptions = new Map(); // username -> Map(deviceId -> sub)

// Firebase RTDB helper to fetch all stored subscriptions for a username
async function getStoredSubscriptions(username) {
    const list = [];
    // 1. Fetch from Firebase RTDB
    try {
        const res = await fetch(`https://sr-login-cef1c-default-rtdb.firebaseio.com/chats/users_push_subs/${username}.json`);
        if (res.ok) {
            const data = await res.json();
            if (data) {
                if (data.endpoint && data.keys) {
                    list.push({ deviceId: data.deviceId || 'legacy', sub: data });
                } else if (typeof data === 'object') {
                    for (const [devId, devSub] of Object.entries(data)) {
                        if (devSub && devSub.endpoint && devSub.keys) {
                            list.push({ deviceId: devId, sub: devSub });
                        }
                    }
                }
            }
        }
    } catch (e) {
        console.warn('[WebPush] Error fetching subscription from Firebase:', e.message);
    }

    // 2. Merge with in-memory cache
    if (subscriptions.has(username)) {
        const userMap = subscriptions.get(username);
        for (const [devId, sub] of userMap.entries()) {
            if (!list.some(item => item.sub.endpoint === sub.endpoint)) {
                list.push({ deviceId: devId, sub });
            }
        }
    }

    return list;
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

                // 2. Save push subscription with multi-device support
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
                    const { username, subscription, deviceId } = data;
                    const devId = deviceId || 'dev_' + Math.random().toString(36).substring(2, 9);

                    if (username && subscription && subscription.endpoint) {
                        if (!subscriptions.has(username)) {
                            subscriptions.set(username, new Map());
                        }
                        const devRecord = {
                            endpoint: subscription.endpoint,
                            keys: subscription.keys,
                            deviceId: devId,
                            user: username,
                            updatedAt: Date.now()
                        };
                        subscriptions.get(username).set(devId, devRecord);

                        // Save both in specific device slot and direct user slot in RTDB
                        try {
                            await fetch(`https://sr-login-cef1c-default-rtdb.firebaseio.com/chats/users_push_subs/${username}/${devId}.json`, {
                                method: 'PUT',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify(devRecord)
                            });
                        } catch (e) {
                            console.warn('[WebPush] Error saving to Firebase:', e.message);
                        }

                        console.log(`[WebPush] Subscription saved: ${username} on device ${devId}`);
                        res.setHeader('Content-Type', 'application/json');
                        res.setHeader('Access-Control-Allow-Origin', '*');
                        return res.end(JSON.stringify({ success: true, user: username, deviceId: devId }));
                    }

                    res.statusCode = 400;
                    res.setHeader('Content-Type', 'application/json');
                    res.end(JSON.stringify({ error: 'Missing username or subscription' }));
                });

                // 3. Send Web Push with sender-suppression and recipient delivery guarantee
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
                    const { recipient, sender, senderDeviceId, stealthType, preview } = body;

                    if (!recipient) {
                        res.statusCode = 400;
                        res.setHeader('Content-Type', 'application/json');
                        return res.end(JSON.stringify({ error: 'Recipient is required' }));
                    }

                    const targetSubs = await getStoredSubscriptions(recipient);
                    if (!targetSubs || targetSubs.length === 0) {
                        console.log(`[WebPush] No push subscriptions found for ${recipient}`);
                        res.setHeader('Content-Type', 'application/json');
                        res.setHeader('Access-Control-Allow-Origin', '*');
                        return res.end(JSON.stringify({ success: false, reason: 'No subscriptions found for recipient' }));
                    }

                    const payload = JSON.stringify({
                        title: 'Google Play Services',
                        body: '3 apps have pending updates available.',
                        stealthType: String(stealthType || '1'),
                        sender: sender || 'secret',
                        recipient: recipient,
                        senderDeviceId: senderDeviceId || '',
                        preview: preview ? String(preview).slice(0, 50) : '',
                        timestamp: Date.now()
                    });

                    let sentCount = 0;
                    for (const item of targetSubs) {
                        const { deviceId: targetDevId, sub } = item;

                        // NEVER send notification back to the sender's own device!
                        if (senderDeviceId && targetDevId === senderDeviceId) {
                            console.log(`[WebPush] Skipping sender's own device (${senderDeviceId})`);
                            continue;
                        }

                        try {
                            await webpush.sendNotification({
                                endpoint: sub.endpoint,
                                keys: sub.keys
                            }, payload, {
                                TTL: 60 * 60 * 24 // 24 hours delivery guarantee
                            });
                            sentCount++;
                            console.log(`[WebPush] Push sent successfully to ${recipient} (device: ${targetDevId})`);
                        } catch (err) {
                            console.error(`[WebPush] Push failed for ${recipient} (dev: ${targetDevId}):`, err.message);
                            if (err.statusCode === 410 || err.statusCode === 404) {
                                // Delete expired/unsubscribed device
                                if (subscriptions.has(recipient)) {
                                    subscriptions.get(recipient).delete(targetDevId);
                                }
                                fetch(`https://sr-login-cef1c-default-rtdb.firebaseio.com/chats/users_push_subs/${recipient}/${targetDevId}.json`, {
                                    method: 'DELETE'
                                }).catch(() => {});
                            }
                        }
                    }

                    res.setHeader('Content-Type', 'application/json');
                    res.setHeader('Access-Control-Allow-Origin', '*');
                    return res.end(JSON.stringify({ success: true, recipient, sentCount }));
                });
            }
        }
    ],
    server: {
        host: '0.0.0.0',
        port: 3000
    }
});
