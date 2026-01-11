const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(bodyParser.json());
app.use(express.static('public'));

// Store messages in memory (you can use a database later)
let messageStore = {};

// Configuration (will be set via API)
let config = {
    phoneNumberId: '',
    accessToken: '',
    webhookVerifyToken: 'your_verify_token_123' // Change this to something secure
};

// ==================== API ENDPOINTS ====================

// Save configuration
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

// Get configuration status
app.get('/api/config', (req, res) => {
    res.json({ 
        configured: !!(config.phoneNumberId && config.accessToken),
        phoneNumberId: config.phoneNumberId ? '***' + config.phoneNumberId.slice(-4) : null
    });
});

// Send message
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
                    'Authorization': `Bearer ${config.accessToken}`,
                    'Content-Type': 'application/json'
                }
            }
        );
        
        console.log('✅ Message sent successfully');
        
        // Store sent message
        if (!messageStore[to]) {
            messageStore[to] = [];
        }
        messageStore[to].push({
            type: 'sent',
            text: message,
            timestamp: Date.now()
        });
        
        res.json({ 
            success: true, 
            messageId: response.data.messages[0].id,
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

// Get all contacts
app.get('/api/contacts', (req, res) => {
    const contacts = Object.keys(messageStore).map(number => ({
        number,
        messageCount: messageStore[number].length,
        lastMessage: messageStore[number][messageStore[number].length - 1]
    }));
    res.json({ contacts });
});

// ==================== WEBHOOK ENDPOINTS ====================

// Webhook verification (required by Meta)
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

// Webhook for receiving messages
app.post('/webhook', (req, res) => {
    try {
        const body = req.body;
        
        console.log('📨 Webhook received:', JSON.stringify(body, null, 2));
        
        if (body.object === 'whatsapp_business_account') {
            body.entry.forEach(entry => {
                entry.changes.forEach(change => {
                    if (change.field === 'messages') {
                        const messages = change.value.messages;
                        
                        if (messages) {
                            messages.forEach(message => {
                                const from = message.from;
                                const text = message.text?.body || '[Media message]';
                                
                                console.log(`📩 Received message from ${from}: ${text}`);
                                
                                // Store received message
                                if (!messageStore[from]) {
                                    messageStore[from] = [];
                                }
                                messageStore[from].push({
                                    type: 'received',
                                    text: text,
                                    timestamp: Date.now(),
                                    messageId: message.id
                                });
                            });
                        }
                    }
                });
            });
        }
        
        res.sendStatus(200);
    } catch (error) {
        console.error('❌ Webhook error:', error);
        res.sendStatus(500);
    }
});

// ==================== START SERVER ====================

app.listen(PORT, () => {
    console.log('🚀 WhatsApp Cloud API Server Started');
    console.log('====================================');
    console.log(`📱 Open in browser: http://localhost:${PORT}`);
    console.log(`🔗 Webhook URL: http://localhost:${PORT}/webhook`);
    console.log(`🔐 Webhook Verify Token: ${config.webhookVerifyToken}`);
    console.log('====================================');
    console.log('Server is running and ready to send/receive messages!');
});