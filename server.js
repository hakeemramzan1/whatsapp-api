const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.json());
// Serve frontend from ./public (put index.html there)
app.use(express.static('public'));

// In-memory stores (reset when server restarts)
let messageStore = {};   // { phoneNumber: [ { type, text, timestamp, messageId, status } ] }
let contactStore = {};   // { phoneNumber: { number, name, lastMessage, lastMessageTime, unreadCount } }
let messageStatus = {};  // { messageId: status }

let config = {
    phoneNumberId: '',
    accessToken: '',
    webhookVerifyToken: 'your_verify_token_123' // change this to your own token
};

// Save API config from frontend
app.post('/api/config', (req, res) => {
    const { phoneNumberId, accessToken } = req.body;

    if (!phoneNumberId || !accessToken) {
        return res.status(400).json({ error: 'Missing phoneNumberId or accessToken' });
    }

    config.phoneNumberId = phoneNumberId;
    config.accessToken = accessToken;

    console.log('✅ Configuration saved');
    res.json({ success: true, message: 'Configuration saved' });
});

// Tell frontend whether API is configured
app.get('/api/config', (req, res) => {
    res.json({
        configured: !!(config.phoneNumberId && config.accessToken),
        phoneNumberId: config.phoneNumberId ? '***' + config.phoneNumberId.slice(-4) : null
    });
});

// Send a WhatsApp message
app.post('/api/send-message', async (req, res) => {
    const { to, message } = req.body;

    if (!config.phoneNumberId || !config.accessToken) {
        return res.status(400).json({ error: 'WhatsApp API not configured' });
    }

    if (!to || !message) {
        return res.status(400).json({ error: 'Missing to or message' });
    }

    try {
        console.log(`📤 Sending message to ${to}: ${message}`);

        const response = await axios.post(
            `https://graph.facebook.com/v18.0/${config.phoneNumberId}/messages`,
            {
                messaging_product: 'whatsapp',
                to: to,
                type: 'text',
                text: { body: message }
            },
            {
                headers: {
                    Authorization: `Bearer ${config.accessToken}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        console.log('✅ Message sent successfully');

        const messageId = response.data.messages[0].id;

        if (!messageStore[to]) {
            messageStore[to] = [];
        }

        const msgData = {
            type: 'sent',
            text: message,
            timestamp: Date.now(),
            messageId: messageId,
            status: 'sent'
        };

        messageStore[to].push(msgData);
        messageStatus[messageId] = 'sent';

        if (!contactStore[to]) {
            contactStore[to] = {
                number: to,
                name: to,
                lastMessage: message,
                lastMessageTime: Date.now(),
                unreadCount: 0
            };
        } else {
            contactStore[to].lastMessage = message;
            contactStore[to].lastMessageTime = Date.now();
        }

        res.json({
            success: true,
            messageId: messageId,
            data: response.data
        });
    } catch (error) {
        console.error('❌ Error sending message:', error.response?.data || error.message);
        res.status(500).json({
            error: 'Failed to send message',
            details: error.response?.data || error.message
        });
    }
});

// Get messages for a contact
app.get('/api/messages/:phoneNumber', (req, res) => {
    const phoneNumber = req.params.phoneNumber;
    const messages = messageStore[phoneNumber] || [];
    res.json({ messages });
});

// Get contact list
app.get('/api/contacts', (req, res) => {
    const contacts = Object.keys(contactStore).map(number => ({
        number,
        name: contactStore[number].name || number,
        lastMessage: contactStore[number].lastMessage,
        lastMessageTime: contactStore[number].lastMessageTime,
        unreadCount: contactStore[number].unreadCount || 0,
        messageCount: messageStore[number]?.length || 0
    }));

    contacts.sort((a, b) => (b.lastMessageTime || 0) - (a.lastMessageTime || 0));

    res.json({ contacts });
});

// Mark a chat as read (reset unread count)
app.post('/api/mark-read/:phoneNumber', (req, res) => {
    const phoneNumber = req.params.phoneNumber;

    if (contactStore[phoneNumber]) {
        contactStore[phoneNumber].unreadCount = 0;
    }

    res.json({ success: true });
});

// Update contact name / create contact
app.post('/api/contacts/:phoneNumber/update', (req, res) => {
    const phoneNumber = req.params.phoneNumber;
    const { name } = req.body;

    if (!contactStore[phoneNumber]) {
        contactStore[phoneNumber] = {
            number: phoneNumber,
            name: name || phoneNumber,
            lastMessage: '',
            lastMessageTime: Date.now(),
            unreadCount: 0
        };
    } else {
        contactStore[phoneNumber].name = name || phoneNumber;
    }

    res.json({ success: true });
});

// Webhook verification (GET)
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === config.webhookVerifyToken) {
        console.log('✅ Webhook verified');
        res.status(200).send(challenge);
    } else {
        console.log('❌ Webhook verification failed');
        res.sendStatus(403);
    }
});

// Webhook receiver (POST)
app.post('/webhook', (req, res) => {
    try {
        const body = req.body;

        if (body.object === 'whatsapp_business_account') {
            body.entry.forEach(entry => {
                entry.changes.forEach(change => {
                    // Status updates (sent, delivered, read, etc.)
                    if (change.value.statuses) {
                        change.value.statuses.forEach(status => {
                            const messageId = status.id;
                            const newStatus = status.status;

                            messageStatus[messageId] = newStatus;

                            Object.keys(messageStore).forEach(number => {
                                messageStore[number].forEach(msg => {
                                    if (msg.messageId === messageId) {
                                        msg.status = newStatus;
                                    }
                                });
                            });

                            console.log(`📊 Message ${messageId} status: ${newStatus}`);
                        });
                    }

                    // Incoming messages
                    if (change.field === 'messages' && change.value.messages) {
                        const messages = change.value.messages;

                        messages.forEach(message => {
                            const from = message.from;
                            const text = message.text?.body || '[Media message]';
                            const timestamp = parseInt(message.timestamp, 10) * 1000;

                            console.log(`📩 Received message from ${from}: ${text}`);

                            if (!messageStore[from]) {
                                messageStore[from] = [];
                            }

                            const newMessage = {
                                type: 'received',
                                text: text,
                                timestamp: timestamp,
                                messageId: message.id,
                                status: 'received',
                                isNew: true
                            };

                            messageStore[from].push(newMessage);

                            const contactName =
                                change.value.contacts?.[0]?.profile?.name || from;

                            if (!contactStore[from]) {
                                contactStore[from] = {
                                    number: from,
                                    name: contactName,
                                    lastMessage: text,
                                    lastMessageTime: timestamp,
                                    unreadCount: 1
                                };
                            } else {
                                contactStore[from].lastMessage = text;
                                contactStore[from].lastMessageTime = timestamp;
                                contactStore[from].unreadCount =
                                    (contactStore[from].unreadCount || 0) + 1;
                            }
                        });
                    }
                });
            });
        }

        // Always 200 quickly so WhatsApp doesn't retry
        res.sendStatus(200);
    } catch (error) {
        console.error('❌ Webhook error:', error);
        res.sendStatus(500);
    }
});

app.listen(PORT, () => {
    console.log('🚀 WhatsApp Cloud API Server Started');
    console.log('====================================');
    console.log(`📱 Open in browser: http://localhost:${PORT}`);
    console.log(`🔗 Webhook URL: http://localhost:${PORT}/webhook`);
    console.log(`🔐 Webhook Verify Token: ${config.webhookVerifyToken}`);
    console.log('====================================');
    console.log('Server is running and ready!');
});
