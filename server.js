/* =========================================================
   Way At Sea — сервер (Node.js, без фреймворков)
   • раздаёт страницы сайта (/vacancies → vacancies.html и т.д.)
   • API: регистрация, вход, подтверждение e-mail, сброс пароля,
     анкеты моряков, CV, список моряков, админ-панель
   • база: PostgreSQL на Railway (переменная DATABASE_URL);
     без неё — локальный файл SQLite (для разработки)

   Переменные окружения (Railway → Variables):
     DATABASE_URL      — ${{Postgres.DATABASE_URL}}
     ADMIN_EMAILS      — e-mail администраторов через запятую
     SITE_URL          — https://www.wayatsea.com
     MAILER_URL        — https://notify.wayatsea.com/mailer.php (скрипт на хостинге)
     MAILER_TOKEN      — секретный ключ, тот же, что в mailer.php
     IMPORT_TOKEN      — секретный ключ для приёма вакансий от парсеров
     SENDPULSE_ID, SENDPULSE_SECRET — (необязательно) ключи API SendPulse
     MAIL_FROM         — info@wayatsea.com
     PORT              — 8080
========================================================= */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const {parseCv, RANKS: CV_RANKS} = require("./cvparse.js");
const {seafarerPdf} = require("./pdfgen.js");         // анкета моряка в PDF   // разбор резюме: документы и опыт

const PORT = Number(process.env.PORT) || 8080;
const ROOT = __dirname;
const SITE_URL = (process.env.SITE_URL || "https://www.wayatsea.com").replace(/\/$/, "");
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
const SESSION_DAYS = 30;
const MAX_BODY = 4 * 1024 * 1024;            // 4 МБ (CV до 2 МБ в base64)
const CV_MAX = 2 * 1024 * 1024;

/* =========================================================
   БАЗА ДАННЫХ: один интерфейс query(sql, params) для PostgreSQL и SQLite.
   SQL пишется в стиле PostgreSQL ($1, $2 …).
========================================================= */
let db;
async function initDb(){
    if(process.env.DATABASE_URL){
        const { Pool } = require("pg");
        const pool = new Pool({
            connectionString: process.env.DATABASE_URL,
            ssl: /localhost|127\.0\.0\.1|\.internal/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false }
        });
        db = { kind: "pg", query: async (sql, params = []) => (await pool.query(sql, params)).rows };
    }else{
        const { DatabaseSync } = require("node:sqlite");
        const file = process.env.SQLITE_FILE || path.join(ROOT, "local.db");
        const sqlite = new DatabaseSync(file);
        db = {
            kind: "sqlite",
            query: async (sql, params = []) => {
                const st = sqlite.prepare(sql.replace(/\$(\d+)/g, "?$1"));
                const args = params.map(p => typeof p === "boolean" ? (p ? 1 : 0) : p);
                return /^\s*(select|with)|returning/i.test(sql) ? st.all(...args) : (st.run(...args), []);
            }
        };
        console.log("⚠️  DATABASE_URL не задан — используется локальная SQLite:", file);
    }
    const BLOB = db.kind === "pg" ? "BYTEA" : "BLOB";
    const statements = [
        `CREATE TABLE IF NOT EXISTS users(
            id TEXT PRIMARY KEY, role TEXT NOT NULL, email TEXT NOT NULL UNIQUE, pass_hash TEXT NOT NULL,
            email_verified INTEGER NOT NULL DEFAULT 0, approved INTEGER NOT NULL DEFAULT 0, blocked INTEGER NOT NULL DEFAULT 0,
            name TEXT, company_name TEXT, phone_code TEXT, phone TEXT,
            verify_token TEXT, reset_token TEXT, reset_expires BIGINT,
            consent_at TEXT, created_at TEXT NOT NULL, last_login TEXT)`,
        `CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires BIGINT NOT NULL)`,
        `CREATE TABLE IF NOT EXISTS profiles(user_id TEXT PRIMARY KEY, data TEXT NOT NULL, complete INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL)`,
        `CREATE TABLE IF NOT EXISTS files(
            id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL, name TEXT, mime TEXT, size INTEGER,
            content ${BLOB} NOT NULL, created_at TEXT NOT NULL)`,
        `CREATE TABLE IF NOT EXISTS vacancies(
            id TEXT PRIMARY KEY, source TEXT NOT NULL, external_id TEXT NOT NULL, url TEXT,
            title TEXT, position TEXT, fleet TEXT, vessel_type TEXT, vessel_name TEXT, region TEXT,
            join_date TEXT, join_text TEXT, duration TEXT, salary_text TEXT, salary_num INTEGER,
            email TEXT, phone TEXT, company TEXT, info TEXT, hashtags TEXT,
            published TEXT NOT NULL, hidden INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_vacancies_src ON vacancies(source, external_id)`,
        `CREATE INDEX IF NOT EXISTS idx_vacancies_pub ON vacancies(published)`,
        `CREATE TABLE IF NOT EXISTS crewings(
            id TEXT PRIMARY KEY, source TEXT NOT NULL, external_id TEXT NOT NULL, url TEXT, name TEXT,
            country TEXT, city TEXT, address TEXT, phone TEXT, email TEXT, website TEXT, license TEXT,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_crewings_src ON crewings(source, external_id)`,
        `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id)`,
        `CREATE INDEX IF NOT EXISTS idx_files_user ON files(user_id, kind)`,
        `CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT)`,
        `CREATE TABLE IF NOT EXISTS bot_outbox(id TEXT PRIMARY KEY, text TEXT NOT NULL, source TEXT, created_at TEXT NOT NULL, taken_at TEXT)`
    ];
    for(const s of statements) await db.query(s);
    // язык писем пользователя (ru, uk, en, hi, fil)
    try { await db.query(`ALTER TABLE users ADD COLUMN lang TEXT`); } catch(e){ /* колонка уже есть */ }
    // вакансии от компаний: статус модерации и владелец
    try { await db.query(`ALTER TABLE vacancies ADD COLUMN status TEXT`); } catch(e){}
    try { await db.query(`ALTER TABLE vacancies ADD COLUMN company_id TEXT`); } catch(e){}
    try { await db.query(`ALTER TABLE crewings ADD COLUMN logo TEXT`); } catch(e){}      // логотип компании (data URL)
}

/* =========================================================
   УТИЛИТЫ
========================================================= */
const now = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();
const sha256 = s => crypto.createHash("sha256").update(String(s)).digest("hex");
const token = () => crypto.randomBytes(32).toString("hex");
const isEmail = v => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(v || "").trim());
const clean = (v, max = 200) => String(v ?? "").trim().slice(0, max);
const escHtml = v => String(v ?? "").replace(/[&<>'"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[c]));

function hashPassword(password){
    const salt = crypto.randomBytes(16).toString("hex");
    const hash = crypto.scryptSync(password, salt, 64).toString("hex");
    return `scrypt$${salt}$${hash}`;
}
function checkPassword(password, stored){
    const [kind, salt, hash] = String(stored || "").split("$");
    if(kind !== "scrypt" || !salt || !hash) return false;
    const a = Buffer.from(hash, "hex");
    const b = crypto.scryptSync(password, salt, 64);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const FREE_EMAIL_DOMAINS = new Set(("gmail.com googlemail.com yahoo.com ymail.com rocketmail.com outlook.com hotmail.com live.com msn.com " +
    "icloud.com me.com mac.com aol.com proton.me protonmail.com pm.me gmx.com gmx.net mail.com email.com zoho.com zohomail.com " +
    "yandex.com yandex.ru yandex.ua ya.ru mail.ru bk.ru inbox.ru list.ru rambler.ru ukr.net i.ua meta.ua bigmir.net email.ua online.ua " +
    "tutanota.com tuta.io qq.com 163.com 126.com sina.com rediffmail.com wp.pl o2.pl interia.pl onet.pl seznam.cz web.de t-online.de " +
    "libero.it laposte.net orange.fr free.fr yopmail.com mailinator.com fastmail.com hey.com").split(" "));
function isCorporateEmail(email){
    const domain = String(email).split("@")[1]?.toLowerCase() || "";
    return !!domain && !FREE_EMAIL_DOMAINS.has(domain) && !/^(yahoo|hotmail|outlook|live|gmx|yandex)\./.test(domain);
}

/* Обязательные поля анкеты — без них профиль не показывается в разделе «Моряки» */
const REQUIRED = ["firstName", "lastName", "position", "fleetType", "salary", "nationality", "availability", "phoneCode", "phone"];
const isComplete = p => REQUIRED.every(k => String(p?.[k] ?? "").trim());

/* Простое ограничение частоты запросов (защита от подбора паролей) */
const hits = new Map();
/* отменить последнюю попытку (если действие не удалось — не засчитываем её в лимит) */
function rateUndo(key){ const arr = hits.get(key); if(arr && arr.length) arr.pop(); }
function rateLimited(key, limit = 10, windowMs = 60_000){
    const t = Date.now();
    const arr = (hits.get(key) || []).filter(x => t - x < windowMs);
    arr.push(t);
    hits.set(key, arr);
    return arr.length > limit;
}
setInterval(() => { const t = Date.now(); for(const [k, v] of hits) if(!v.some(x => t - x < 60_000)) hits.delete(k); }, 300_000).unref();

/* =========================================================
   ПОЧТА: SendPulse API. Пока ключей нет — ссылка пишется в лог Railway,
   а администратор может подтвердить e-mail вручную в админке.
========================================================= */
let spToken = null, spTokenExp = 0;
/* Подсказка в логах, если токены mailer.php и Railway разные: какие символы (по 8) отличаются */
function logTokenMismatch(j){
    const mine = String(process.env.MAILER_TOKEN || "").trim();
    const why = j.reason === "not_set_in_mailer" ? "в mailer.php не вписан токен" : j.reason === "no_header" ? "токен не дошёл до mailer.php" : "токены не совпадают";
    let where = "";
    if(Array.isArray(j.parts)){
        const ours = (mine.match(/.{1,8}/g) || []).map(c => crypto.createHash("sha256").update("was:" + c).digest("hex").slice(0, 4));
        const diff = ours.map((h, i) => h === j.parts[i] ? null : `${i * 8 + 1}–${Math.min(i * 8 + 8, Math.max(mine.length, (j.len_in_mailer || 0)))}`).filter(Boolean);
        where = diff.length ? `; отличаются символы №${diff.join(", ")} (проверьте похожие: l/I/1, O/0, лишний или пропущенный символ)` : "; части совпадают";
    }
    console.error(`❌ mailer.php ответил 403: ${why} (длина в mailer.php: ${j.len_in_mailer ?? "?"}, в Railway: ${mine.length}${where})`);
}
async function sendMail(to, subject, html, extra = {}){
    // extra: {replyTo, attachments: [{filename, content (base64), type}]}
    // 1) Через ваш хостинг: mailer.php отправляет письмо с info@wayatsea.com
    if(process.env.MAILER_URL && process.env.MAILER_TOKEN){
        try{
            const r = await fetch(process.env.MAILER_URL, {
                method: "POST", redirect: "error",
                headers: {"Content-Type": "application/json", "X-Mailer-Token": String(process.env.MAILER_TOKEN).trim()},
                body: JSON.stringify({to, subject, html, replyTo: extra.replyTo || "", attachments: extra.attachments || []}),
                signal: AbortSignal.timeout(15000)
            });
            if(r.ok) return true;
            const txt = await r.text();
            if(r.status === 403){ try { logTokenMismatch(JSON.parse(txt)); } catch(e){} }
            console.error("Mailer error", r.status, txt.slice(0, 300) || "(пустой ответ — ошибка PHP на хостинге)");
        }catch(e){ console.error("Mailer error", e.message); }
        // не получилось с вложением (старый mailer.php или ограничения хостинга) — шлём без него, ссылка на PDF есть в тексте письма
        if(extra.attachments?.length){
            console.log("↻ Повторная отправка без вложения");
            return sendMail(to, subject, html, {replyTo: extra.replyTo});
        }
        console.log(`📧 [письмо не отправлено] для ${to}: ${subject}\n${html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")}`);
        return false;
    }
    // 2) Через SendPulse (если когда-нибудь понадобится)
    const id = process.env.SENDPULSE_ID, secret = process.env.SENDPULSE_SECRET;
    if(!id || !secret){
        console.log(`📧 [без SendPulse] письмо для ${to}: ${subject}\n${html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")}`);
        return false;
    }
    try{
        if(!spToken || Date.now() > spTokenExp){
            const r = await fetch("https://api.sendpulse.com/oauth/access_token", {
                method: "POST", headers: {"Content-Type": "application/json"},
                body: JSON.stringify({grant_type: "client_credentials", client_id: id, client_secret: secret})
            });
            const j = await r.json();
            spToken = j.access_token; spTokenExp = Date.now() + ((j.expires_in || 3600) - 60) * 1000;
        }
        const r = await fetch("https://api.sendpulse.com/smtp/emails", {
            method: "POST",
            headers: {"Content-Type": "application/json", Authorization: `Bearer ${spToken}`},
            body: JSON.stringify({email: {
                subject, html: Buffer.from(html).toString("base64"), text: html.replace(/<[^>]+>/g, " "),
                from: {name: "Way At Sea", email: process.env.MAIL_FROM || "info@wayatsea.com"},
                to: [{email: to}],
                ...(extra.replyTo ? {reply_to: extra.replyTo} : {}),
                ...(extra.attachments?.length ? {attachments_binary: Object.fromEntries(extra.attachments.map(a => [a.filename, a.content]))} : {})
            }})
        });
        if(!r.ok) console.error("SendPulse error", r.status, await r.text());
        return r.ok;
    }catch(e){ console.error("SendPulse error", e.message); return false; }
}
/* =========================================================
   ТЕКСТЫ ПИСЕМ НА 5 ЯЗЫКАХ. Письма приходят на языке пользователя (users.lang);
   письмо подтверждения e-mail после регистрации — всегда на английском.
========================================================= */
const MAIL_LANGS = ["ru", "uk", "en", "hi", "fil"];
// все письма с сайта — только на английском (тексты на других языках оставлены на будущее:
// чтобы включить язык пользователя, замените строку ниже на  l => MAIL_LANGS.includes(l) ? l : "en")
const mailLang = () => "en";
const MT = {
    ru: {hello: n => `Доброго времени суток${n ? `, уважаемый ${n}` : ""}!`, linkHint: "Если кнопка не работает, откройте ссылку:",
        resetSubj: "Сброс пароля — Way At Sea", resetTitle: "Сброс пароля", resetText: "Мы получили запрос на смену пароля. Ссылка действует 1 час. Если это были не вы — просто проигнорируйте письмо.", resetBtn: "Сменить пароль",
        apprSubj: "Компания одобрена — Way At Sea", apprTitle: "Доступ открыт", apprText: c => `Компания «${c}» одобрена. Теперь вам доступны профили и CV моряков.`, apprBtn: "Открыть раздел «Моряки»",
        delSubj: "Аккаунт удалён — Way At Sea", delTitle: "Аккаунт удалён", delText: "Ваш аккаунт на Way At Sea и все связанные данные (профиль, документы, CV) удалены. Если это сделали не вы — напишите нам на support@wayatsea.com.",
        alOnSubj: "Уведомления о вакансиях подключены — Way At Sea", alOnTitle: "Уведомления подключены", alOnText: "Вы подписались на уведомления о новых вакансиях на Way At Sea. Выбраны следующие критерии:",
        alWhen: "Письма приходят два раза в день — в 10:00 и 15:00 (по Лондону), когда на сайте появляются подходящие вакансии.", alBtn: "Изменить критерии",
        lPos: "Должность", lFleet: "Тип флота", lType: "Тип судна", lSal: "Минимальная зарплата", lAny: "любой", lJoin: "Посадка", lSalary: "Зарплата",
        digSubj: "Уведомление о новых вакансиях — Way At Sea", digTitle: "Уведомление о новых вакансиях", digText: n => `На сайте Way At Sea появились интересующие вас вакансии (${n}):`,
        digFoot: "Подробности и контакты — на сайте после входа. Изменить или отключить уведомления:", digBtn: "Податься"},
    uk: {hello: n => `Доброго дня${n ? `, шановний ${n}` : ""}!`, linkHint: "Якщо кнопка не працює, відкрийте посилання:",
        resetSubj: "Скидання пароля — Way At Sea", resetTitle: "Скидання пароля", resetText: "Ми отримали запит на зміну пароля. Посилання діє 1 годину. Якщо це були не ви — просто проігноруйте лист.", resetBtn: "Змінити пароль",
        apprSubj: "Компанію схвалено — Way At Sea", apprTitle: "Доступ відкрито", apprText: c => `Компанію «${c}» схвалено. Тепер вам доступні профілі та CV моряків.`, apprBtn: "Відкрити розділ «Моряки»",
        delSubj: "Акаунт видалено — Way At Sea", delTitle: "Акаунт видалено", delText: "Ваш акаунт на Way At Sea і всі пов'язані дані (профіль, документи, CV) видалено. Якщо це зробили не ви — напишіть нам на support@wayatsea.com.",
        alOnSubj: "Сповіщення про вакансії підключено — Way At Sea", alOnTitle: "Сповіщення підключено", alOnText: "Ви підписалися на сповіщення про нові вакансії на Way At Sea. Обрано такі критерії:",
        alWhen: "Листи надходять двічі на день — о 10:00 та 15:00 (за Лондоном), коли на сайті з'являються відповідні вакансії.", alBtn: "Змінити критерії",
        lPos: "Посада", lFleet: "Тип флоту", lType: "Тип судна", lSal: "Мінімальна зарплата", lAny: "будь-який", lJoin: "Посадка", lSalary: "Зарплата",
        digSubj: "Сповіщення про нові вакансії — Way At Sea", digTitle: "Сповіщення про нові вакансії", digText: n => `На сайті Way At Sea з'явилися вакансії, що вас цікавлять (${n}):`,
        digFoot: "Деталі та контакти — на сайті після входу. Змінити або вимкнути сповіщення:", digBtn: "Податися"},
    en: {hello: n => `Dear ${n || "seafarer"},`, linkHint: "If the button doesn't work, open this link:",
        resetSubj: "Password reset — Way At Sea", resetTitle: "Password reset", resetText: "We received a request to change your password. The link is valid for 1 hour. If it wasn't you, just ignore this email.", resetBtn: "Change password",
        apprSubj: "Company approved — Way At Sea", apprTitle: "Access granted", apprText: c => `Company «${c}» has been approved. Seafarer profiles and CVs are now available to you.`, apprBtn: "Open Seafarers",
        delSubj: "Account deleted — Way At Sea", delTitle: "Account deleted", delText: "Your Way At Sea account and all related data (profile, documents, CV) have been deleted. If it wasn't you, write to us at support@wayatsea.com.",
        alOnSubj: "Vacancy alerts activated — Way At Sea", alOnTitle: "Alerts activated", alOnText: "You have subscribed to new vacancy alerts on Way At Sea. Your criteria:",
        alWhen: "Emails are sent twice a day — at 10:00 and 15:00 (London time) — when matching vacancies appear on the site.", alBtn: "Change criteria",
        lPos: "Rank", lFleet: "Fleet type", lType: "Vessel type", lSal: "Minimum salary", lAny: "any", lJoin: "Joining", lSalary: "Salary",
        digSubj: "New vacancy alert — Way At Sea", digTitle: "New vacancies for you", digText: n => `New vacancies matching your criteria have appeared on Way At Sea (${n}):`,
        digFoot: "Details and contacts are on the site after you log in. Change or turn off alerts:", digBtn: "Apply"},
    hi: {hello: n => `नमस्ते${n ? `, ${n}` : ""}!`, linkHint: "यदि बटन काम न करे, तो यह लिंक खोलें:",
        resetSubj: "पासवर्ड रीसेट — Way At Sea", resetTitle: "पासवर्ड रीसेट", resetText: "हमें पासवर्ड बदलने का अनुरोध मिला। लिंक 1 घंटे तक मान्य है। यदि यह आप नहीं थे, तो इस ईमेल को अनदेखा करें।", resetBtn: "पासवर्ड बदलें",
        apprSubj: "कंपनी स्वीकृत — Way At Sea", apprTitle: "पहुँच खुल गई", apprText: c => `कंपनी «${c}» स्वीकृत हो गई है। अब आप नाविकों की प्रोफ़ाइल और CV देख सकते हैं।`, apprBtn: "«नाविक» खोलें",
        delSubj: "खाता हटाया गया — Way At Sea", delTitle: "खाता हटाया गया", delText: "Way At Sea पर आपका खाता और सभी संबंधित डेटा (प्रोफ़ाइल, दस्तावेज़, CV) हटा दिए गए हैं। यदि यह आपने नहीं किया, तो support@wayatsea.com पर लिखें।",
        alOnSubj: "वैकेंसी सूचनाएँ चालू — Way At Sea", alOnTitle: "सूचनाएँ चालू", alOnText: "आपने Way At Sea पर नई वैकेंसी की सूचनाओं की सदस्यता ली है। चुने गए मानदंड:",
        alWhen: "उपयुक्त वैकेंसी आने पर ईमेल दिन में दो बार — 10:00 और 15:00 (लंदन समय) — आते हैं।", alBtn: "मानदंड बदलें",
        lPos: "पद", lFleet: "बेड़े का प्रकार", lType: "जहाज़ का प्रकार", lSal: "न्यूनतम वेतन", lAny: "कोई भी", lJoin: "जॉइनिंग", lSalary: "वेतन",
        digSubj: "नई वैकेंसी की सूचना — Way At Sea", digTitle: "आपके लिए नई वैकेंसी", digText: n => `Way At Sea पर आपकी रुचि की नई वैकेंसी आई हैं (${n}):`,
        digFoot: "विवरण और संपर्क — लॉग इन के बाद साइट पर। सूचनाएँ बदलें या बंद करें:", digBtn: "आवेदन करें"},
    fil: {hello: n => `Magandang araw${n ? `, ${n}` : ""}!`, linkHint: "Kung hindi gumagana ang button, buksan ang link:",
        resetSubj: "Pag-reset ng password — Way At Sea", resetTitle: "Pag-reset ng password", resetText: "Nakatanggap kami ng kahilingang palitan ang password. Valid ang link nang 1 oras. Kung hindi ikaw ito, balewalain ang email na ito.", resetBtn: "Palitan ang password",
        apprSubj: "Aprubado ang kumpanya — Way At Sea", apprTitle: "Bukas na ang access", apprText: c => `Naaprubahan ang kumpanyang «${c}». Makikita mo na ang mga profile at CV ng mga seafarer.`, apprBtn: "Buksan ang Seafarers",
        delSubj: "Na-delete ang account — Way At Sea", delTitle: "Na-delete ang account", delText: "Na-delete ang iyong account sa Way At Sea at lahat ng kaugnay na data (profile, dokumento, CV). Kung hindi ikaw ito, sumulat sa support@wayatsea.com.",
        alOnSubj: "Naka-on ang abiso sa bakante — Way At Sea", alOnTitle: "Naka-on ang abiso", alOnText: "Nag-subscribe ka sa abiso ng mga bagong bakante sa Way At Sea. Napiling pamantayan:",
        alWhen: "Dumarating ang email dalawang beses sa isang araw — alas-10:00 at alas-15:00 (oras sa London) — kapag may angkop na bakante.", alBtn: "Baguhin ang pamantayan",
        lPos: "Ranggo", lFleet: "Uri ng fleet", lType: "Uri ng barko", lSal: "Minimum na sahod", lAny: "kahit ano", lJoin: "Pagsakay", lSalary: "Sahod",
        digSubj: "Abiso ng bagong bakante — Way At Sea", digTitle: "Mga bagong bakante para sa iyo", digText: n => `May mga bagong bakante sa Way At Sea na tugma sa iyo (${n}):`,
        digFoot: "Detalye at contact — sa site pagkatapos mag-log in. Baguhin o i-off ang abiso:", digBtn: "Mag-apply"},
};
/* Письмо «подтвердите e-mail» — на английском, с обращением по имени; после нажатия — сразу в личный кабинет */
const verifyMailText = name => `Dear ${name ? escHtml(name) : "user"},<br><br>
Thank you for registering on Way At Sea. To complete your registration, click «Confirm» — you will be automatically redirected to your personal account.`;
const mailLayout = (title, text, link, button, lang = "en") => `
<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#17394d">
  <h2 style="color:#082b42">${title}</h2><p>${text}</p>
  <p><a href="${link}" style="display:inline-block;padding:12px 20px;border-radius:8px;background:#087faa;color:#fff;text-decoration:none;font-weight:bold">${button}</a></p>
  <p style="font-size:12px;color:#6b8190">${MT[mailLang(lang)].linkHint} ${link}</p>
  <p style="font-size:12px;color:#6b8190">Way At Sea — www.wayatsea.com</p>
</div>`;

/* =========================================================
   HTTP: ответы, cookie, сессии
========================================================= */
const SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Content-Security-Policy": "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
};
/* HSTS: браузер всегда открывает сайт только по HTTPS */
const HSTS = {"Strict-Transport-Security": "max-age=31536000; includeSubDomains"};
function send(res, status, body, headers = {}){
    const isBuf = Buffer.isBuffer(body);
    const data = isBuf || typeof body === "string" ? body : JSON.stringify(body);
    res.writeHead(status, {
        ...SECURITY_HEADERS,
        "Content-Type": isBuf || typeof body === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
        ...headers
    });
    res.end(data);
}
const json = (res, status, obj) => send(res, status, obj, {"Cache-Control": "no-store"});
const fail = (res, status, error) => json(res, status, {error});

function parseCookies(req){
    const out = {};
    (req.headers.cookie || "").split(";").forEach(p => {
        const i = p.indexOf("=");
        if(i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
    });
    return out;
}
const isHttps = req => (req.headers["x-forwarded-proto"] || "").split(",")[0] === "https";
function sessionCookie(req, value, maxAge){
    return `was_session=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isHttps(req) ? "; Secure" : ""}`;
}
async function readBody(req, max = MAX_BODY){
    return new Promise((resolve, reject) => {
        let size = 0; const chunks = [];
        req.on("data", c => {
            size += c.length;
            if(size > max){ reject(Object.assign(new Error("too large"), {status: 413})); req.destroy(); return; }
            chunks.push(c);
        });
        req.on("end", () => {
            if(!chunks.length) return resolve({});
            try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
            catch(e){ reject(Object.assign(new Error("bad json"), {status: 400})); }
        });
        req.on("error", reject);
    });
}
async function currentUser(req){
    const t = parseCookies(req).was_session;
    if(!t) return null;
    const rows = await db.query(
        `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = $1 AND s.expires > $2`,
        [sha256(t), Date.now()]);
    const u = rows[0];
    return u && !u.blocked ? u : null;
}
async function createSession(req, res, user){
    const t = token();
    await db.query(`INSERT INTO sessions(token, user_id, expires) VALUES($1, $2, $3)`,
        [sha256(t), user.id, Date.now() + SESSION_DAYS * 864e5]);
    await db.query(`UPDATE users SET last_login = $1 WHERE id = $2`, [now(), user.id]);
    res.setHeader("Set-Cookie", sessionCookie(req, t, SESSION_DAYS * 86400));
}
/* Администратор — только с подтверждённым e-mail из списка ADMIN_EMAILS */
const isAdmin = u => !!u && !!u.email_verified && !u.blocked && ADMIN_EMAILS.includes(u.email);

async function getProfile(userId){
    const r = await db.query(`SELECT data FROM profiles WHERE user_id = $1`, [userId]);
    try { return r[0] ? JSON.parse(r[0].data) : {}; } catch(e){ return {}; }
}
async function saveProfile(userId, p){
    const data = JSON.stringify(p);
    const complete = isComplete(p) ? 1 : 0;
    const exists = await db.query(`SELECT user_id FROM profiles WHERE user_id = $1`, [userId]);
    if(exists.length) await db.query(`UPDATE profiles SET data = $1, complete = $2, updated_at = $3 WHERE user_id = $4`, [data, complete, now(), userId]);
    else await db.query(`INSERT INTO profiles(user_id, data, complete, updated_at) VALUES($1, $2, $3, $4)`, [userId, data, complete, now()]);
}
/* Что видит сам пользователь о себе */
async function publicMe(u){
    if(!u) return null;
    const me = {id: u.id, role: u.role, email: u.email, name: u.name, emailVerified: !!u.email_verified,
                approved: !!u.approved, isAdmin: isAdmin(u), companyName: u.company_name,
                phoneCode: u.phone_code, phone: u.phone, lang: u.lang || null};
    if(u.role === "seafarer") me.profile = await getProfile(u.id);
    return me;
}

/* =========================================================
   API
========================================================= */
const routes = [];
const route = (method, pattern, handler, opts = {}) => routes.push({method, pattern, handler, maxBody: opts.maxBody});

/* --- текущий пользователь --- */
route("GET", "/api/me", async (req, res, {user}) => json(res, 200, {user: await publicMe(user)}));

/* --- регистрация --- */
route("POST", "/api/auth/register", async (req, res, {body, ip}) => {
    if(rateLimited("reg:" + ip, 5)) return fail(res, 429, "tooMany");
    const role = body.role === "crewing" ? "crewing" : "seafarer";
    const email = clean(body.email, 160).toLowerCase();
    const password = String(body.password || "");
    if(!isEmail(email)) return fail(res, 400, "errEmail");
    if(password.length < 8 || password.length > 200) return fail(res, 400, "errPasswordShort");
    if(!body.phoneCode || String(body.phone || "").replace(/\D/g, "").length < 5) return fail(res, 400, "errPhone");
    if(!body.consent) return fail(res, 400, "errConsent");
    let name, company = null;
    if(role === "crewing"){
        company = clean(body.companyName, 160);
        if(!company || !clean(body.country) || !clean(body.city) || !clean(body.license)) return fail(res, 400, "errFillAll");
        if(!isCorporateEmail(email)) return fail(res, 400, "errCorpEmail");
        if(body.employerTerms !== true) return fail(res, 400, "errEmployerTerms");
        name = company;
    }else{
        if(!clean(body.firstName) || !clean(body.lastName) || !clean(body.position)) return fail(res, 400, "errFillAll");
        name = clean(body.firstName, 80);
    }
    if((await db.query(`SELECT id FROM users WHERE email = $1`, [email])).length) return fail(res, 409, "errEmailTaken");
    const id = uuid(), verify = token();
    await db.query(`INSERT INTO users(id, role, email, pass_hash, name, company_name, phone_code, phone, verify_token, consent_at, created_at)
                    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [id, role, email, hashPassword(password), name, company, clean(body.phoneCode, 4), clean(body.phone, 30), sha256(verify), now(), now()]);
    await db.query(`UPDATE users SET lang = $1 WHERE id = $2`, [mailLang(body.lang), id]);
    if(role === "crewing"){
        await saveProfile(id, {companyName: company, country: clean(body.country, 80), city: clean(body.city, 80), license: clean(body.license, 120), contactEmail: email,
                               employerTermsAt: now()});
    }
    if(role === "seafarer"){
        await saveProfile(id, {firstName: clean(body.firstName, 80), lastName: clean(body.lastName, 80), position: clean(body.position, 80),
                               phoneCode: clean(body.phoneCode, 4), phone: clean(body.phone, 30), documents: [], experience: []});
    }
    const link = `${SITE_URL}/?verify=${verify}`;
    const greetName = role === "seafarer" ? [clean(body.firstName, 80), clean(body.lastName, 80)].filter(Boolean).join(" ") : company;
    await sendMail(email, "Confirm your registration — Way At Sea",
        mailLayout("Confirm your registration", verifyMailText(greetName), link, "Confirm", "en"));
    const user = (await db.query(`SELECT * FROM users WHERE id = $1`, [id]))[0];
    await createSession(req, res, user);
    json(res, 201, {user: await publicMe(user)});
});

/* --- вход / выход --- */
route("POST", "/api/auth/login", async (req, res, {body, ip}) => {
    const email = clean(body.email, 160).toLowerCase();
    if(rateLimited("login:" + ip, 10) || rateLimited("login-acc:" + email, 8, 15 * 60_000)) return fail(res, 429, "tooMany");
    const u = (await db.query(`SELECT * FROM users WHERE email = $1`, [email]))[0];
    if(!u || !checkPassword(String(body.password || ""), u.pass_hash)) return fail(res, 401, "errBadLogin");
    if(u.blocked) return fail(res, 403, "errBlocked");
    await createSession(req, res, u);
    json(res, 200, {user: await publicMe(u)});
});
route("POST", "/api/auth/logout", async (req, res) => {
    const t = parseCookies(req).was_session;
    if(t) await db.query(`DELETE FROM sessions WHERE token = $1`, [sha256(t)]);
    res.setHeader("Set-Cookie", sessionCookie(req, "", 0));
    json(res, 200, {ok: true});
});

/* --- подтверждение e-mail --- */
route("POST", "/api/auth/verify", async (req, res, {body}) => {
    const t = String(body.token || "");
    const u = t && (await db.query(`SELECT * FROM users WHERE verify_token = $1`, [sha256(t)]))[0];
    if(!u) return fail(res, 400, "errLinkInvalid");
    await db.query(`UPDATE users SET email_verified = 1, verify_token = NULL WHERE id = $1`, [u.id]);
    await createSession(req, res, u);
    json(res, 200, {user: await publicMe({...u, email_verified: 1}), role: u.role});
});
route("POST", "/api/auth/resend", async (req, res, {user, ip}) => {
    if(!user) return fail(res, 401, "auth");
    if(user.email_verified) return json(res, 200, {ok: true});
    if(rateLimited("resend:" + ip, 3) || rateLimited("resend-acc:" + user.id, 3, 10 * 60_000)) return fail(res, 429, "tooMany");
    const verify = token();
    await db.query(`UPDATE users SET verify_token = $1 WHERE id = $2`, [sha256(verify), user.id]);
    const link = `${SITE_URL}/?verify=${verify}`;
    const prof = user.role === "seafarer" ? await getProfile(user.id) : {};
    const greetName = user.role === "seafarer" ? [prof.firstName || user.name, prof.lastName].filter(Boolean).join(" ") : (user.company_name || user.name);
    await sendMail(user.email, "Confirm your registration — Way At Sea",
        mailLayout("Confirm your registration", verifyMailText(greetName), link, "Confirm", "en"));
    json(res, 200, {ok: true});
});

/* --- забыли пароль --- */
/* Персональное письмо для смены пароля: обращение по имени, e-mail аккаунта, время запроса */
const RESET_EXTRA = {
    ru: (email, when) => `Запрос на смену пароля для аккаунта <b>${escHtml(email)}</b> на Way At Sea получен ${when} (по Лондону).`,
    uk: (email, when) => `Запит на зміну пароля для акаунта <b>${escHtml(email)}</b> на Way At Sea отримано ${when} (за Лондоном).`,
    en: (email, when) => `A password change was requested for the Way At Sea account <b>${escHtml(email)}</b> on ${when} (London time).`,
};
async function sendResetMail(u){
    const t = token();
    await db.query(`UPDATE users SET reset_token = $1, reset_expires = $2 WHERE id = $3`, [sha256(t), Date.now() + 3600_000, u.id]);
    const lang = mailLang(u.lang), m = MT[lang];
    let name = u.role === "crewing" ? (u.company_name || u.name) : u.name;
    try{
        const p = await getProfile(u.id);
        if(u.role === "seafarer" && p) name = [p.firstName || u.name, p.lastName].filter(Boolean).join(" ") || name;
    }catch(e){}
    const when = new Date().toLocaleString("en-GB", {timeZone: "Europe/London", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit"});
    const extra = (RESET_EXTRA[lang] || RESET_EXTRA.en)(u.email, when);
    const text = `${m.hello(escHtml(name || ""))}<br><br>${extra}<br><br>${m.resetText}`;
    await sendMail(u.email, m.resetSubj, mailLayout(m.resetTitle, text, `${SITE_URL}/?reset=${t}`, m.resetBtn, u.lang));
}

route("POST", "/api/auth/forgot", async (req, res, {body, ip}) => {
    const email = clean(body.email, 160).toLowerCase();
    if(rateLimited("forgot:" + ip, 5) || rateLimited("forgot-acc:" + email, 3, 60 * 60_000)) return fail(res, 429, "tooMany");
    const u = (await db.query(`SELECT * FROM users WHERE email = $1`, [email]))[0];
    if(u && !u.blocked) await sendResetMail(u);
    json(res, 200, {ok: true});   // одинаковый ответ — нельзя узнать, есть ли такой e-mail
});
route("POST", "/api/auth/reset", async (req, res, {body}) => {
    const t = String(body.token || ""), password = String(body.password || "");
    if(password.length < 8 || password.length > 200) return fail(res, 400, "errPasswordShort");
    const u = t && (await db.query(`SELECT * FROM users WHERE reset_token = $1`, [sha256(t)]))[0];
    if(!u || Date.now() > Number(u.reset_expires || 0)) return fail(res, 400, "errLinkInvalid");
    await db.query(`UPDATE users SET pass_hash = $1, reset_token = NULL, reset_expires = NULL WHERE id = $2`, [hashPassword(password), u.id]);
    await db.query(`DELETE FROM sessions WHERE user_id = $1`, [u.id]);   // выход на всех устройствах
    json(res, 200, {ok: true, email: u.email});
});

/* --- Безопасность в кабинете: письмо для смены пароля и смена пароля (текущий пароль показать нельзя — он хранится только как хэш) --- */
route("POST", "/api/account/reset-email", async (req, res, {user}) => {
    if(!user) return fail(res, 401, "auth");
    if(rateLimited("reset-cab:" + user.id, 3, 60 * 60_000)) return fail(res, 429, "tooMany");
    await sendResetMail(user);
    json(res, 200, {ok: true, email: user.email});
});
route("POST", "/api/account/change-password", async (req, res, {user, body}) => {
    if(!user) return fail(res, 401, "auth");
    if(rateLimited("chpass:" + user.id, 8, 15 * 60_000)) return fail(res, 429, "tooMany");
    if(!checkPassword(String(body.current || ""), user.pass_hash)) return fail(res, 403, "errWrongPassword");
    const password = String(body.password || "");
    if(password.length < 8 || password.length > 200) return fail(res, 400, "errPasswordShort");
    await db.query(`UPDATE users SET pass_hash = $1, reset_token = NULL, reset_expires = NULL WHERE id = $2`, [hashPassword(password), user.id]);
    // выходим на всех остальных устройствах, текущий вход оставляем
    const cur = parseCookies(req).was_session;
    await db.query(`DELETE FROM sessions WHERE user_id = $1 AND token <> $2`, [user.id, cur ? sha256(cur) : ""]);
    const lang = mailLang(user.lang);
    const note = {ru: ["Пароль изменён — Way At Sea", "Пароль изменён", `Пароль от аккаунта <b>${escHtml(user.email)}</b> только что изменён. Если это были не вы — сразу сбросьте пароль на сайте и напишите нам на support@wayatsea.com.`, "Открыть сайт"],
                  uk: ["Пароль змінено — Way At Sea", "Пароль змінено", `Пароль від акаунта <b>${escHtml(user.email)}</b> щойно змінено. Якщо це були не ви — одразу скиньте пароль на сайті та напишіть нам на support@wayatsea.com.`, "Відкрити сайт"],
                  en: ["Password changed — Way At Sea", "Password changed", `The password for the account <b>${escHtml(user.email)}</b> was just changed. If it wasn't you, reset your password on the site right away and e-mail support@wayatsea.com.`, "Open site"]}[lang] || null;
    const n = note || ["Password changed — Way At Sea", "Password changed", `The password for the account <b>${escHtml(user.email)}</b> was just changed. If it wasn't you, reset your password on the site right away and e-mail support@wayatsea.com.`, "Open site"];
    sendMail(user.email, n[0], mailLayout(n[1], n[2], `${SITE_URL}/account`, n[3], user.lang)).catch(e => console.error("❌ Письмо о смене пароля:", e.message));
    json(res, 200, {ok: true});
});

/* --- удаление аккаунта самим пользователем (право на удаление данных, GDPR) --- */
route("POST", "/api/account/delete", async (req, res, {user, body, ip}) => {
    if(!user) return fail(res, 401, "auth");
    if(rateLimited("delete:" + user.id, 5, 15 * 60_000)) return fail(res, 429, "tooMany");
    if(!checkPassword(String(body.password || ""), user.pass_hash)) return fail(res, 403, "errWrongPassword");
    await db.query(`DELETE FROM files WHERE user_id = $1`, [user.id]);
    await db.query(`DELETE FROM profiles WHERE user_id = $1`, [user.id]);
    await db.query(`DELETE FROM sessions WHERE user_id = $1`, [user.id]);
    await db.query(`DELETE FROM users WHERE id = $1`, [user.id]);
    res.setHeader("Set-Cookie", sessionCookie(req, "", 0));
    console.log(`🗑️  Аккаунт удалён пользователем: ${user.role} ${user.email}`);
    const md = MT[mailLang(user.lang)];
    sendMail(user.email, md.delSubj,
        `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;color:#17394d"><h2 style="color:#082b42">${md.delTitle}</h2>
         <p>${md.delText}</p></div>`).catch(() => {});
    json(res, 200, {ok: true});
});

/* --- анкета моряка --- */
/* Общий стаж в море по всем контрактам (пересекающиеся периоды не считаются дважды), в днях */
function seaDays(experience){
    const spans = (experience || []).map(x => [Date.parse(x.from), Date.parse(x.to)])
        .filter(([a, b]) => a && b && b >= a).sort((m, n) => m[0] - n[0]);
    let total = 0, curA = null, curB = null;
    for(const [a, b] of spans){
        if(curB !== null && a <= curB){ curB = Math.max(curB, b); continue; }
        if(curB !== null) total += curB - curA + 864e5;
        curA = a; curB = b;
    }
    if(curB !== null) total += curB - curA + 864e5;
    return Math.round(total / 864e5);
}
const PROFILE_FIELDS = ["firstName","lastName","position","fleetType","fleetType2","vesselType","dob","nationality","salary","experienceYears",
                        "availability","english","about","phoneCode","phone"];
route("PUT", "/api/profile", async (req, res, {user, body}) => {
    if(!user || user.role !== "seafarer") return fail(res, 401, "auth");
    const old = await getProfile(user.id);
    const p = {...old};
    const src = body.profile || {};
    PROFILE_FIELDS.forEach(k => { if(k in src) p[k] = clean(src[k], k === "about" ? 5000 : 200); });
    const mine = new Set((await db.query(`SELECT id FROM files WHERE user_id = $1 AND kind = 'scan'`, [user.id])).map(r => r.id));
    const keepScan = (x, out) => { if(x.scan && mine.has(x.scan.id)) out.scan = {id: x.scan.id, name: clean(x.scan.name, 160)}; return out; };
    if(Array.isArray(src.documents)){
        p.documents = src.documents.slice(0, 100).map(d => {
            const doc = {name: clean(d.name, 200), expiry: clean(d.expiry, 10), category: clean(d.category, 40), number: clean(d.number, 60)};
            return keepScan(d, doc);
        });
    }
    if(Array.isArray(src.experience)) p.experience = src.experience.slice(0, 100).map(x => keepScan(x, {
        vessel: clean(x.vessel, 120), vesselType: clean(x.vesselType, 120), position: clean(x.position, 120),
        from: clean(x.from, 10), to: clean(x.to, 10), description: clean(x.description, 2000)}));
    // файлы удалённых документов и записей опыта — удаляем и с сервера
    if(Array.isArray(src.documents) || Array.isArray(src.experience)){
        const used = new Set([...(p.documents || []), ...(p.experience || [])].map(d => d.scan?.id).filter(Boolean));
        for(const id of mine) if(!used.has(id)) await db.query(`DELETE FROM files WHERE id = $1 AND user_id = $2`, [id, user.id]);
    }
    if(MAIL_LANGS.includes(body.lang)) await db.query(`UPDATE users SET lang = $1 WHERE id = $2`, [body.lang, user.id]);
    // стаж в море считается автоматически по вкладке «Опыт»
    p.experienceYears = (p.experience || []).length ? String(Math.round(seaDays(p.experience) / 365.25 * 10) / 10) : "";
    if("photo" in src){
        const ph = String(src.photo || "");
        if(ph && (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+\/]+=*$/.test(ph) || ph.length > 400_000)) return fail(res, 400, "errPhoto");
        p.photo = ph;
    }
    // маленькая копия фото (около 24 px) — её видят моряки и гости в размытом виде; оригинал — только компаниям
    if("photoThumb" in src){
        const th = String(src.photoThumb || "");
        p.photoThumb = /^data:image\/jpeg;base64,[A-Za-z0-9+\/]+=*$/.test(th) && th.length < 6000 ? th : "";
    }
    if(!p.photo) p.photoThumb = "";
    await saveProfile(user.id, p);
    if(p.firstName) await db.query(`UPDATE users SET name = $1, phone_code = $2, phone = $3 WHERE id = $4`, [p.firstName, p.phoneCode || null, p.phone || null, user.id]);
    json(res, 200, {profile: p, complete: isComplete(p)});
});

/* --- CV: загрузка, удаление, скачивание --- */
route("POST", "/api/profile/cv", async (req, res, {user, body}) => {
    if(!user || user.role !== "seafarer") return fail(res, 401, "auth");
    const name = clean(body.name, 160);
    const m = String(body.data || "").match(/^data:([\w.+\/-]*);base64,(.+)$/);
    if(!m || !/\.(pdf|docx?)$/i.test(name)) return fail(res, 400, "cvBadType");
    const buf = Buffer.from(m[2], "base64");
    if(buf.length > CV_MAX) return fail(res, 400, "cvTooBig");
    // проверка, что это действительно PDF/DOC/DOCX (по сигнатуре файла)
    const sig = buf.subarray(0, 4).toString("hex");
    if(!["25504446", "d0cf11e0", "504b0304"].includes(sig)) return fail(res, 400, "cvBadType");
    const mime = sig === "25504446" ? "application/pdf" : sig === "d0cf11e0" ? "application/msword"
               : "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    await db.query(`DELETE FROM files WHERE user_id = $1 AND kind = 'cv'`, [user.id]);
    const id = uuid();
    await db.query(`INSERT INTO files(id, user_id, kind, name, mime, size, content, created_at) VALUES($1,$2,'cv',$3,$4,$5,$6,$7)`,
        [id, user.id, name, mime, buf.length, buf, now()]);
    const p = await getProfile(user.id);
    p.cv = {name, size: buf.length, uploaded: now().slice(0, 10)};
    await saveProfile(user.id, p);
    json(res, 200, {profile: p});
});
/* Распознать загруженное CV: документы с датами и опыт по судам (без ИИ, по шаблонам).
   Ничего не сохраняет — моряк сначала проверяет найденное и сам нажимает «Добавить». */
route("POST", "/api/profile/cv/parse", async (req, res, {user}) => {
    if(!user || user.role !== "seafarer") return fail(res, 401, "auth");
    if(rateLimited("cvparse:" + user.id, 20, 60 * 60_000)) return fail(res, 429, "tooMany");
    const f = (await db.query(`SELECT name, content FROM files WHERE user_id = $1 AND kind = 'cv'`, [user.id]))[0];
    if(!f) return fail(res, 404, "cvNotFound");
    let result;
    try { result = parseCv(Buffer.from(f.content), f.name); }
    catch(e){ console.error("❌ Разбор CV:", e.message); result = {readable: false, personal: {}, documents: [], experience: []}; }
    // тип флота — по типу судна из CV (MPSV → Offshore Fleet, Bulk Carrier → Merchant Fleet …)
    if(result.personal && result.personal.vesselType) result.personal.fleetType = detectFleet(result.personal.vesselType, "", null);
    console.log(`📄 CV разобрано: документов ${result.documents.length}, опыт ${result.experience.length}${result.readable ? "" : " (текст не читается)"}`);
    json(res, 200, result);
});
route("DELETE", "/api/profile/cv", async (req, res, {user}) => {
    if(!user || user.role !== "seafarer") return fail(res, 401, "auth");
    await db.query(`DELETE FROM files WHERE user_id = $1 AND kind = 'cv'`, [user.id]);
    const p = await getProfile(user.id);
    delete p.cv;
    await saveProfile(user.id, p);
    json(res, 200, {profile: p});
});
/* Скачать CV: сам моряк, одобренная компания или администратор */
route("GET", /^\/api\/cv\/([\w-]+)$/, async (req, res, {user, params}) => {
    const ownerId = params[0];
    const allowed = user && (user.id === ownerId || isAdmin(user) ||
        (user.role === "crewing" && user.email_verified && user.approved));
    if(!allowed) return fail(res, 403, "forbidden");
    const f = (await db.query(`SELECT * FROM files WHERE user_id = $1 AND kind = 'cv'`, [ownerId]))[0];
    if(!f) return fail(res, 404, "notFound");
    const content = Buffer.isBuffer(f.content) ? f.content : Buffer.from(f.content);
    res.writeHead(200, {...SECURITY_HEADERS, "Content-Type": f.mime || "application/octet-stream", "Content-Length": content.length,
        "Cache-Control": "private, no-store",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(f.name || "CV")}`});
    res.end(content);
});

/* --- Файлы к документам и к записям опыта: загружает только сам моряк; смотреть (без скачивания) — сам моряк,
       одобренные администратором компании и админ. Фото (JPG/PNG/WEBP/GIF) или PDF, до 1 МБ
       (небольшой запас — на случай, если браузер перевёл фото в JPG и оно чуть подросло) --- */
const SCAN_MAX = 1.5 * 1024 * 1024;
const SCAN_SIGS = {"image/jpeg": h => h.startsWith("ffd8"), "image/png": h => h === "89504e47", "image/webp": h => h === "52494646",
                   "image/gif": h => h === "47494638", "application/pdf": h => h === "25504446"};
route("POST", /^\/api\/profile\/(documents|experience)\/(\d+)\/scan$/, async (req, res, {user, body, params}) => {
    if(!user || user.role !== "seafarer") return fail(res, 401, "auth");
    if(rateLimited("scan:" + user.id, 60, 3600_000)) return fail(res, 429, "tooMany");
    const p = await getProfile(user.id);
    const doc = (p[params[0]] || [])[Number(params[1])];
    if(!doc) return fail(res, 404, "notFound");
    if(body.consent !== true) return fail(res, 400, "errScanConsent");
    p.scanConsentAt = now();
    const m = String(body.data || "").match(/^data:(image\/(?:jpeg|png|webp|gif)|application\/pdf);base64,(.+)$/);
    if(!m) return fail(res, 400, "scanBadType");
    const buf = Buffer.from(m[2], "base64");
    if(buf.length > SCAN_MAX) return fail(res, 400, "scanTooBig");
    if(!SCAN_SIGS[m[1]](buf.subarray(0, 4).toString("hex"))) return fail(res, 400, "scanBadType");
    if(doc.scan) await db.query(`DELETE FROM files WHERE id = $1 AND user_id = $2`, [doc.scan.id, user.id]);
    const id = uuid(), name = clean(body.name, 160) || "scan";
    await db.query(`INSERT INTO files(id, user_id, kind, name, mime, size, content, created_at) VALUES($1,$2,'scan',$3,$4,$5,$6,$7)`,
        [id, user.id, name, m[1], buf.length, buf, now()]);
    doc.scan = {id, name};
    await saveProfile(user.id, p);
    json(res, 200, {profile: p});
});
route("DELETE", /^\/api\/profile\/(documents|experience)\/(\d+)\/scan$/, async (req, res, {user, params}) => {
    if(!user || user.role !== "seafarer") return fail(res, 401, "auth");
    const p = await getProfile(user.id);
    const doc = (p[params[0]] || [])[Number(params[1])];
    if(doc?.scan){ await db.query(`DELETE FROM files WHERE id = $1 AND user_id = $2`, [doc.scan.id, user.id]); delete doc.scan; await saveProfile(user.id, p); }
    json(res, 200, {profile: p});
});
/* Просмотр скана: отдаём как данные для показа на холсте (не файлом для скачивания) */
route("GET", /^\/api\/scan\/([\w-]+)$/, async (req, res, {user, params}) => {
    if(!user) return fail(res, 401, "auth");
    const f = (await db.query(`SELECT user_id, mime, content FROM files WHERE id = $1 AND kind = 'scan'`, [params[0]]))[0];
    if(!f) return fail(res, 404, "notFound");
    const allowed = user.id === f.user_id || isAdmin(user) || (user.role === "crewing" && user.email_verified && user.approved);
    if(!allowed) return fail(res, 403, "forbidden");
    if(user.id !== f.user_id && rateLimited("scanview:" + user.id, 300, 3600_000)) return fail(res, 429, "tooMany");
    const content = Buffer.isBuffer(f.content) ? f.content : Buffer.from(f.content);
    json(res, 200, {scan: `data:${f.mime};base64,${content.toString("base64")}`,
        mark: user.id === f.user_id ? "Way At Sea · view only" : `Way At Sea · ${user.company_name || user.email} · view only`});
});

/* --- Пакет документов для работодателей: моряк загружает сканы (фото/PDF), всего до 20 МБ,
       с согласием GDPR на СКАЧИВАНИЕ компаниями. Скачать ZIP могут только одобренные компании и админ --- */
const PACK_TOTAL = 20 * 1024 * 1024, PACK_FILE = 10 * 1024 * 1024, PACK_COUNT = 40;
const PACK_TYPES = {
    "application/pdf": h => h.startsWith("25504446"), "image/jpeg": h => h.startsWith("ffd8"), "image/png": h => h.startsWith("89504e47"),
    "image/webp": h => h.startsWith("52494646"), "image/gif": h => h.startsWith("47494638"), "image/bmp": h => h.startsWith("424d"),
    "image/tiff": h => h.startsWith("49492a00") || h.startsWith("4d4d002a"),
    "image/heic": h => h.slice(8, 16) === "66747970", "image/heif": h => h.slice(8, 16) === "66747970"};
route("POST", "/api/profile/pack", async (req, res, {user, body}) => {
    if(!user || user.role !== "seafarer") return fail(res, 401, "auth");
    if(body.consent !== true) return fail(res, 400, "errPackConsent");
    if(rateLimited("pack:" + user.id, 120, 3600_000)) return fail(res, 429, "tooMany");
    const m = String(body.data || "").match(/^data:([\w.+\/-]+);base64,(.+)$/);
    if(!m || !PACK_TYPES[m[1]]) return fail(res, 400, "errPackType");
    const buf = Buffer.from(m[2], "base64");
    if(!buf.length || buf.length > PACK_FILE) return fail(res, 400, "errPackFileBig");
    if(!PACK_TYPES[m[1]](buf.subarray(0, 12).toString("hex"))) return fail(res, 400, "errPackType");
    const p = await getProfile(user.id);
    const pack = p.pack || [];
    if(pack.length >= PACK_COUNT) return fail(res, 400, "errPackCount");
    if(pack.reduce((a, f) => a + (f.size || 0), 0) + buf.length > PACK_TOTAL) return fail(res, 400, "errPackTotal");
    const id = uuid(), name = clean(body.name, 160).replace(/[\\/:*?"<>|]+/g, "_") || "document";
    await db.query(`INSERT INTO files(id, user_id, kind, name, mime, size, content, created_at) VALUES($1,$2,'pack',$3,$4,$5,$6,$7)`,
        [id, user.id, name, m[1], buf.length, buf, now()]);
    p.pack = [...pack, {id, name, size: buf.length, mime: m[1], at: now()}];
    p.packConsentAt = now();
    await saveProfile(user.id, p);
    json(res, 200, {profile: p});
}, {maxBody: 15 * 1024 * 1024});
route("DELETE", /^\/api\/profile\/pack\/([\w-]+)$/, async (req, res, {user, params}) => {
    if(!user || user.role !== "seafarer") return fail(res, 401, "auth");
    const p = await getProfile(user.id);
    await db.query(`DELETE FROM files WHERE id = $1 AND user_id = $2 AND kind = 'pack'`, [params[0], user.id]);
    p.pack = (p.pack || []).filter(f => f.id !== params[0]);
    if(!p.pack.length) delete p.packConsentAt;
    await saveProfile(user.id, p);
    json(res, 200, {profile: p});
});
/* ZIP без сжатия (сканы и PDF и так сжаты) */
const CRC_TABLE = (() => { const t = new Uint32Array(256); for(let n = 0; n < 256; n++){ let c = n; for(let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf){ let c = 0xffffffff; for(let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function buildZip(files){
    const parts = [], central = []; let offset = 0;
    for(const f of files){
        const name = Buffer.from(f.name, "utf8"), crc = crc32(f.data);
        const lh = Buffer.alloc(30);
        lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(0, 8);
        lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0x21, 12); lh.writeUInt32LE(crc, 14);
        lh.writeUInt32LE(f.data.length, 18); lh.writeUInt32LE(f.data.length, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
        parts.push(lh, name, f.data);
        const ch = Buffer.alloc(46);
        ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(0, 10);
        ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0x21, 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(f.data.length, 20); ch.writeUInt32LE(f.data.length, 24);
        ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
        central.push(ch, name);
        offset += 30 + name.length + f.data.length;
    }
    const cd = Buffer.concat(central), end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
    end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
    return Buffer.concat([...parts, cd, end]);
}
route("GET", /^\/api\/seafarer\/([\w-]+)\/documents\.zip$/, async (req, res, {user, params}) => {
    const id = params[0];
    const allowed = user && (isAdmin(user) || (user.role === "crewing" && user.email_verified && user.approved));
    if(!allowed) return fail(res, 403, "forbidden");
    if(rateLimited("packdl:" + user.id, 100, 3600_000)) return fail(res, 429, "tooMany");
    const r = (await db.query(`SELECT u.blocked, p.data FROM users u JOIN profiles p ON p.user_id = u.id WHERE u.id = $1 AND u.role = 'seafarer'`, [id]))[0];
    if(!r || r.blocked) return fail(res, 404, "notFound");
    let p = {}; try { p = JSON.parse(r.data); } catch(e){}
    const ids = (p.pack || []).map(f => f.id);
    if(!ids.length || !p.packConsentAt) return fail(res, 404, "notFound");
    const rows = await db.query(`SELECT id, name, content FROM files WHERE user_id = $1 AND kind = 'pack'`, [id]);
    const used = new Set();
    const files = ids.map(fid => rows.find(x => x.id === fid)).filter(Boolean).map(x => {
        let name = x.name || "document", n = 1;
        while(used.has(name.toLowerCase())) name = (x.name || "document").replace(/(\.[^.]*)?$/, m => `_${++n}${m}`);
        used.add(name.toLowerCase());
        return {name, data: Buffer.isBuffer(x.content) ? x.content : Buffer.from(x.content)};
    });
    const zip = buildZip(files);
    const base = [p.firstName, p.lastName].filter(Boolean).join("_").replace(/[^A-Za-z0-9_-]+/g, "") || "seafarer";
    console.log(`📦 Документы моряка ${id} скачаны: ${user.company_name || user.email}`);
    res.writeHead(200, {...SECURITY_HEADERS, "Content-Type": "application/zip", "Content-Length": zip.length, "Cache-Control": "private, no-store",
        "Content-Disposition": `attachment; filename="Way-At-Sea_${base}_documents.zip"`});
    res.end(zip);
});

/* =========================================================
   GDPR: отписка одним кликом, выгрузка своих данных, данные оператора для правовых страниц
========================================================= */
const UNSUB_TEXT = {ru: "Отписаться от рассылки вакансий одним нажатием", uk: "Відписатися від розсилки вакансій одним натисканням",
    en: "Unsubscribe from vacancy alerts in one click", hi: "Unsubscribe from vacancy alerts in one click", fil: "Unsubscribe from vacancy alerts in one click"};
const unsubSig = id => crypto.createHmac("sha256", PDF_SECRET).update(`unsub.${id}`).digest("hex").slice(0, 32);
const unsubLink = id => `${SITE_URL}/api/alerts/unsubscribe?u=${encodeURIComponent(id)}&s=${unsubSig(id)}`;
function simplePage(res, status, title, text){
    res.writeHead(status, {...SECURITY_HEADERS, "Content-Type": "text/html; charset=utf-8"});
    res.end(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escHtml(title)}</title>
        <style>body{margin:0;font-family:Arial,sans-serif;background:#f3f7f9;color:#13293a;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:16px}
        .b{max-width:460px;background:#fff;border-radius:16px;padding:28px;box-shadow:0 8px 30px rgba(8,43,66,.12);text-align:center}
        h1{margin:0 0 10px;font-size:22px;color:#082b42}p{color:#4d6473;line-height:1.5}a{display:inline-block;margin-top:12px;padding:10px 18px;border-radius:10px;background:#0b5c8c;color:#fff;text-decoration:none;font-weight:bold}</style>
        </head><body><div class="b"><h1>${escHtml(title)}</h1><p>${text}</p><a href="${SITE_URL}/">Way At Sea</a></div></body></html>`);
}
route("GET", "/api/alerts/unsubscribe", async (req, res, {query}) => {
    const id = String(query.get("u") || ""), sig = String(query.get("s") || "");
    const ok = id && sig.length === 32 && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(unsubSig(id)));
    if(!ok) return simplePage(res, 400, "Link is not valid", "This unsubscribe link is invalid. You can turn off alerts in your account.");
    const p = await getProfile(id);
    if(p && p.alerts){ p.alerts.enabled = false; await saveProfile(id, p); }
    console.log(`🔕 Отписка от рассылки: ${id}`);
    simplePage(res, 200, "Вы отписались / Unsubscribed",
        "Письма с вакансиями больше приходить не будут. Включить их снова можно в личном кабинете.<br><br>You will no longer receive vacancy alerts. You can turn them back on in your account.");
});
/* Выгрузка всех своих данных (право на доступ / перенос данных по GDPR) */
route("GET", "/api/profile/export", async (req, res, {user}) => {
    if(!user) return fail(res, 401, "auth");
    if(rateLimited("export:" + user.id, 10, 3600_000)) return fail(res, 429, "tooMany");
    const p = await getProfile(user.id) || {};
    const {cv, ...profile} = p;
    const files = await db.query(`SELECT id, kind, name, mime, size, created_at FROM files WHERE user_id = $1`, [user.id]);
    const data = {
        exported_at: now(), site: SITE_URL,
        account: {id: user.id, role: user.role, email: user.email, name: user.name, company_name: user.company_name, phone_code: user.phone_code,
                  phone: user.phone, email_verified: !!user.email_verified, consent_at: user.consent_at, created_at: user.created_at, last_login: user.last_login, lang: user.lang},
        profile, files_stored: files,
        note: "Uploaded files (CV, scans, documents) are listed in files_stored; you can download your CV and PDF profile in your account."
    };
    const body = Buffer.from(JSON.stringify(data, null, 2));
    res.writeHead(200, {...SECURITY_HEADERS, "Content-Type": "application/json; charset=utf-8", "Content-Length": body.length, "Cache-Control": "private, no-store",
        "Content-Disposition": `attachment; filename="way-at-sea-my-data.json"`});
    res.end(body);
});
/* Данные оператора для правовых страниц — задаются переменными Railway (LEGAL_*) */
route("GET", "/api/legal", async (req, res) => {
    json(res, 200, {
        name: process.env.LEGAL_NAME || "", address: process.env.LEGAL_ADDRESS || "", country: process.env.LEGAL_COUNTRY || "Ukraine",
        companyNo: process.env.LEGAL_COMPANY_NO || "", email: process.env.LEGAL_EMAIL || "support@wayatsea.com",
        updated: process.env.LEGAL_UPDATED || "07.10.2026"});
});

/* --- полный профиль моряка (отдельная страница /seaman/<id>): одобренные компании, админ и сам моряк --- */
route("GET", /^\/api\/seafarer\/([\w-]+)$/, async (req, res, {user, params}) => {
    const id = params[0];
    const allowed = user && (user.id === id || isAdmin(user) || (user.role === "crewing" && user.email_verified && user.approved));
    if(!allowed) return fail(res, 403, "forbidden");
    const r = (await db.query(`SELECT u.id, u.email, u.blocked, p.data FROM users u JOIN profiles p ON p.user_id = u.id WHERE u.id = $1 AND u.role = 'seafarer'`, [id]))[0];
    if(!r || (r.blocked && user.id !== id && !isAdmin(user))) return fail(res, 404, "notFound");
    let p = {}; try { p = JSON.parse(r.data); } catch(e){}
    const {cv, photoThumb, ...rest} = p;
    json(res, 200, {seafarer: {...rest, id: r.id, email: r.email, hasCv: !!cv, seaDays: (p.experience || []).length ? seaDays(p.experience) : null,
        own: user.id === id}});
});

/* Анкета моряка в PDF (буфер + имя файла) — для скачивания и для вложения в письмо */
async function buildSeafarerPdf(id){
    const r = (await db.query(`SELECT u.id, u.email, p.data FROM users u JOIN profiles p ON p.user_id = u.id WHERE u.id = $1 AND u.role = 'seafarer'`, [id]))[0];
    if(!r) return null;
    let p = {}; try { p = JSON.parse(r.data); } catch(e){}
    const days = (p.experience || []).length ? seaDays(p.experience) : 0;
    const months = Math.floor(days / 30.44), y = Math.floor(months / 12), m = months % 12;
    const seaTime = days ? [y && `${y} year${y > 1 ? "s" : ""}`, m && `${m} mo`].filter(Boolean).join(" ") || `${days} days` : "";
    const pdf = seafarerPdf({...p, email: r.email}, {root: ROOT, profileUrl: `${SITE_URL}/seaman/${r.id}`, seaTime});
    const asciiName = [p.firstName, p.lastName].filter(Boolean).join("_").replace(/[^A-Za-z0-9_-]+/g, "");
    return {pdf, profile: p, email: r.email, fname: `Way-At-Sea_${asciiName.replace(/_/g, "").length >= 2 ? asciiName : "profile"}.pdf`,
            utfName: `Way-At-Sea_${[p.firstName, p.lastName].filter(Boolean).join("_") || "Seafarer"}.pdf`};
}
/* Подписанная ссылка на анкету (для писем компаниям): действует 30 дней, без входа на сайт */
const PDF_SECRET = process.env.PDF_SECRET || process.env.IMPORT_TOKEN || process.env.MAILER_TOKEN || crypto.randomBytes(32).toString("hex");
const pdfSig = (id, exp) => crypto.createHmac("sha256", PDF_SECRET).update(`${id}.${exp}`).digest("hex").slice(0, 32);
const pdfLink = id => { const exp = Date.now() + 30 * 864e5; return `${SITE_URL}/api/pdf/${id}/${exp}/${pdfSig(id, exp)}`; };
function sendPdf(res, b){
    res.writeHead(200, {...SECURITY_HEADERS, "Content-Type": "application/pdf", "Content-Length": b.pdf.length, "Cache-Control": "private, no-store",
        "Content-Disposition": `attachment; filename="${b.fname}"; filename*=UTF-8''${encodeURIComponent(b.utfName)}`});
    res.end(b.pdf);
}
route("GET", /^\/api\/pdf\/([\w-]+)\/(\d+)\/([a-f0-9]{32})$/, async (req, res, {params}) => {
    const [id, exp, sig] = params;
    if(Date.now() > Number(exp) || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(pdfSig(id, exp)))) return fail(res, 403, "errLinkInvalid");
    const b = await buildSeafarerPdf(id);
    if(!b) return fail(res, 404, "notFound");
    sendPdf(res, b);
});

/* --- моряк отправляет резюме компании из каталога «Работодатели»:
       письмо уходит на почту компании, анкета PDF — во вложении, ответ — на почту моряка --- */
route("POST", /^\/api\/companies\/([\w-]+)\/apply$/, async (req, res, {user, body, params}) => {
    if(!user || user.role !== "seafarer") return fail(res, 401, "auth");
    if(!user.email_verified) return fail(res, 403, "notVerified");
    const cid = params[0];
    const kCo = `coapply:${user.id}:${cid}`, kDay = "coapply:" + user.id;
    if(rateLimited(kCo, 1, 24 * 3600_000)){ rateUndo(kCo); return fail(res, 429, "coApplyAlready"); }
    if(rateLimited(kDay, 20, 24 * 3600_000)){ rateUndo(kDay); rateUndo(kCo); return fail(res, 429, "coApplyDayLimit"); }
    const undo = () => { rateUndo(kCo); rateUndo(kDay); };
    // кому: зарегистрированная компания или компания из каталога
    let company = null;
    if(cid.startsWith("u-")){
        const u = (await db.query(`SELECT u.id, u.email, u.name, u.company_name, p.data FROM users u LEFT JOIN profiles p ON p.user_id = u.id
                                   WHERE u.id = $1 AND u.role = 'crewing' AND u.approved = 1 AND u.blocked = 0`, [cid.slice(2)]))[0];
        if(u){ let p = {}; try { p = JSON.parse(u.data || "{}"); } catch(e){} company = {name: p.companyName || u.company_name || u.name, email: p.contactEmail || u.email}; }
    }else{
        const c = (await db.query(`SELECT name, email FROM crewings WHERE id = $1`, [cid]))[0];
        const email = c && (String(c.email || "").match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || []).find(isCorporateEmail);
        if(c && email) company = {name: c.name, email};
    }
    if(!company){ undo(); return fail(res, 404, "notFound"); }
    const b = await buildSeafarerPdf(user.id);
    if(!b){ undo(); return fail(res, 404, "notFound"); }
    const first = clean(body.firstName, 80) || b.profile.firstName || "", last = clean(body.lastName, 80) || b.profile.lastName || "";
    const rank = clean(body.position, 80) || b.profile.position || "", vt = clean(body.vesselType, 100) || b.profile.vesselType || "";
    const message = clean(body.message, 3000);
    if(!message){ undo(); return fail(res, 400, "errFillAll"); }
    const name = [first, last].filter(Boolean).join(" ");
    const line = (l, v) => v ? `<tr><td style="padding:5px 14px 5px 0;color:#6b8190">${l}</td><td style="padding:5px 0;font-weight:bold">${escHtml(v)}</td></tr>` : "";
    const html = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;color:#17394d">
        <p style="white-space:pre-line;font-size:15px;line-height:1.55">${escHtml(message)}</p>
        <table style="margin:14px 0;border-collapse:collapse">${line("Name", name)}${line("Rank", rank)}${line("Vessel type", vt)}${line("Nationality", b.profile.nationality)}
            ${line("Phone", [b.profile.phoneCode, b.profile.phone].filter(Boolean).join(" "))}${line("E-mail", user.email)}</table>
        <p>📎 The seafarer's profile form (PDF) is attached. If you can't see the attachment, <a href="${pdfLink(user.id)}">download it here</a> (link valid for 30 days).</p>
        <p style="font-size:12px;color:#6b8190">Sent via Way At Sea — www.wayatsea.com. Reply to this e-mail to contact the seafarer directly.</p></div>`;
    const ok = await sendMail(company.email, `Application: ${rank || "Seafarer"}${vt ? " — " + vt : ""} — ${name} (Way At Sea)`, html,
        {replyTo: user.email, attachments: [{filename: b.fname, content: b.pdf.toString("base64"), type: "application/pdf"}]});
    console.log(`📨 Резюме моряка ${user.email} → компания ${company.name} <${company.email}> ${ok ? "отправлено" : "НЕ отправлено"}`);
    if(!ok){ undo(); if(process.env.MAILER_URL || process.env.SENDPULSE_ID) return fail(res, 502, "errMailSend"); }
    json(res, 200, {ok: true, company: company.name});
});

/* --- анкета моряка в PDF: сам моряк, одобренные компании и админ --- */
route("GET", /^\/api\/seafarer\/([\w-]+)\/pdf$/, async (req, res, {user, params}) => {
    const id = params[0];
    const allowed = user && (user.id === id || isAdmin(user) || (user.role === "crewing" && user.email_verified && user.approved));
    if(!allowed) return fail(res, 403, "forbidden");
    let b;
    try { b = await buildSeafarerPdf(id); } catch(e){ console.error("❌ PDF анкеты:", e.message); return fail(res, 500, "server"); }
    if(!b) return fail(res, 404, "notFound");
    sendPdf(res, b);
});

/* --- список моряков: общая карточка для всех, подробности — одобренным компаниям --- */
route("GET", "/api/seafarers", async (req, res, {user}) => {
    const rows = await db.query(
        `SELECT u.id, u.email, p.data, p.updated_at FROM users u JOIN profiles p ON p.user_id = u.id
         WHERE u.role = 'seafarer' AND u.blocked = 0 AND u.email_verified = 1 AND p.complete = 1
         ORDER BY p.updated_at DESC LIMIT 1000`);
    const full = !!user && (isAdmin(user) || (user.role === "crewing" && user.email_verified && user.approved));
    const list = rows.map(r => {
        let p = {}; try { p = JSON.parse(r.data); } catch(e){}
        const card = {id: r.id, name: p.firstName, position: p.position, fleet: p.fleetType, fleet2: p.fleetType2 || "", salary: p.salary,
            years: p.experienceYears === "" || p.experienceYears == null ? null : Number(p.experienceYears),
            seaDays: (p.experience || []).length ? seaDays(p.experience) : null,
            vessels: p.vesselType || "—", cv: !!p.cv, own: !!user && user.id === r.id,
            // фото: компаниям и самому моряку — настоящее, остальным — только крошечная копия (на сайте размыта)
            photo: (full || (!!user && user.id === r.id)) ? (p.photo || "") : "", thumb: p.photoThumb || ""};
        if(full) card.details = {lastName: p.lastName, email: r.email, phone: [p.phoneCode, p.phone], nationality: p.nationality,
            availability: p.availability, english: p.english, dob: p.dob, about: p.about, documents: p.documents || [], experience: p.experience || []};
        return card;
    });
    json(res, 200, {seafarers: list, full});
});

/* =========================================================
   ВАКАНСИИ: приём от парсеров, нормализация, выдача на сайт
========================================================= */
const SOURCE_NAMES = {ukrcrewing: "UkrCrewing", crewlink: "Crewlink", ainostri: "Ai Nostri", crewell: "Crewell", atlas: "Atlas NextWave", tospeople: "TOS", seaman: "Sea-Man", company: "Way At Sea"};
const RANK_MAP = {
    "chief mate": "Chief Officer", "1st officer": "Chief Officer", "first officer": "Chief Officer", "c/o": "Chief Officer",
    "ch.officer": "Chief Officer", "ch officer": "Chief Officer", "ch. officer": "Chief Officer", "ch.off": "Chief Officer",
    "ch.eng": "Chief Engineer", "ch.engineer": "Chief Engineer", "ch. engineer": "Chief Engineer", "c/e": "Chief Engineer",
    "2nd off": "Second Officer", "3rd off": "Third Officer", "capt": "Master", "capt.": "Master",
    "2nd officer": "Second Officer", "2nd mate": "Second Officer", "second mate": "Second Officer", "2/o": "Second Officer",
    "3rd officer": "Third Officer", "3rd mate": "Third Officer", "third mate": "Third Officer", "3/o": "Third Officer",
    "captain": "Master", "2nd engineer": "Second Engineer", "second engineer": "Second Engineer",
    "3rd engineer": "3rd Engineer", "third engineer": "3rd Engineer", "4th engineer": "4th Engineer", "fourth engineer": "4th Engineer",
    "electro-technical officer": "ETO", "electrical officer": "ETO", "boatswain": "Bosun", "able seaman": "AB", "able seafarer": "AB",
    "ordinary seaman": "OS", "chief cook": "Cook", "cook": "Cook", "motorman": "Motorman", "oiler": "Oiler", "fitter": "Fitter",
    "welder": "Welder", "electrician": "Electrician", "messman": "Messman", "steward": "Steward", "deck cadet": "Deck Cadet",
    "engine cadet": "Engine Cadet", "crane operator": "Crane Operator", "wiper": "Wiper", "baker": "Baker", "rigger": "Rigger"
};
function normPosition(rank, title){
    const r = clean(rank, 80);
    if(r && r !== "Multiple positions"){
        const k = r.toLowerCase();
        return RANK_MAP[k] || r;
    }
    const t = String(title || "").toLowerCase();
    for(const [k, v] of Object.entries(RANK_MAP)) if(new RegExp("\\b" + k.replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&") + "\\b").test(t)) return v;
    return clean(title, 80) || r || "Vacancy";
}
/* Флот по типу судна. Сначала смотрим тип судна; текст вакансии — только если тип не указан или не распознан
   (иначе «experience on tankers» в требованиях делал балкер танкерным). */
const FLEETS = ["Merchant Fleet", "Tanker Fleet", "Gas Fleet", "Offshore Fleet", "Passenger Fleet"];
/* Газовозы: LNG/LPG/этан/аммиак, FSRU, газовые бункеровщики. Проверяются раньше танкеров («LPG Tanker» — газовоз) */
const GAS_RE = /\blng|\blpg|\blngc?\b|\blpgc?\b|\bvlgc\b|\bvlec\b|\b[mlv]gc\b|gas\s*(?:carrier|tanker|ship|vessel)|\bfsru\b|\bflng\b|\bfsu\s+lng|ethane|ethylene|\bleg\s+carrier|ammonia\s+(?:carrier|tanker)|co2\s+(?:carrier|tanker)|газовоз|газов\w*\s+танкер|metanier|gazier/i;
/* Старое значение «Tanker/Gas Fleet» (до разделения): по типу судна/тексту — газовоз или танкер */
const splitTankerGas = (f, hint) => f === "Tanker/Gas Fleet" || f === "Tanker" ? (GAS_RE.test(String(hint || "")) ? "Gas Fleet" : "Tanker Fleet") : f;
const FLEET_RULES = [
    ["Passenger Fleet", /passenger|cruise|ferry|ro-?ro\s*pax|ropax|ro-?pax|yacht|superyacht|mega\s?yacht|river\s+cruise|паром|пассажир|круиз|яхт/i],
    ["Offshore Fleet", /offshore|ahts|anchor\s+handl|psv|osv|errv|fpso|fso\b|fpu|drill|rig\b|jack-?up|diving|dsv|supply\s+vessel|crew\s+(?:boat|transfer)|\bctv\b|\bsov\b|walk[\s-]?to[\s-]?work|w2w|(?<!bunker\s)barge|c?sov\b|platform|hvdc|buoy\s+lay|trench|construction\s+vessel|installation\s+vessel|rock\s+(?:installation|dump)|wind\s*farm|windfarm|cable\s+lay|pipe\s*lay|heavy\s+lift\s+crane|\brov\b|survey|seismic|research\s+vessel|tug|tugboat|towing|dredg|accommodation\s+(?:vessel|barge)|well\s+(?:stimulation|intervention)|офшор|буксир|земснаряд/i],
    ["Gas Fleet", GAS_RE],
    ["Tanker Fleet", /tanker|\blng\b|\blpg\b|gas\s+carrier|chemical|product\s+carrier|crude|bunker\s+(?:tanker|barge)|vlcc|ulcc|aframax|suezmax|panamax\s+tanker|\blr[12]\b|\bmr\s+tanker|asphalt|bitumen|oil\s+products|shuttle\s+tanker|fso\b|танкер|нефтеналив|химовоз/i],
];
function fleetFromText(text){
    for(const [fleet, re] of FLEET_RULES) if(re.test(String(text || ""))) return fleet;
    return null;
}
function detectFleet(vesselType, text, given){
    given = splitTankerGas(given, `${vesselType || ""} ${text || ""}`);
    const byType = fleetFromText(vesselType);
    if(byType) return byType;
    // слишком общий тип («Barge», «Vessel») — верим источнику / тексту вакансии
    if(/^\s*(vessel|ship|boat)\s*$/i.test(String(vesselType || ""))) return FLEETS.includes(given) ? given : (fleetFromText(text) || "Merchant Fleet");
    // тип судна указан, но ни под что не подошёл (Bulk Carrier, Container, General Cargo…) — это торговый флот
    if(clean(vesselType)) return "Merchant Fleet";
    if(FLEETS.includes(given)) return given;
    return fleetFromText(text) || "Merchant Fleet";
}
const MONTHS = {jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12};
/* Дата из текста ("15.10.2026", "2026-10-15", "15 Oct 2026", "October 15, 2026") → "2026-10-15" или null */
function parseDate(text){
    const s = String(text || "").trim().toLowerCase();
    const iso = (y, m, d) => {
        y = Number(y); m = Number(m); d = Number(d);
        if(y < 100) y += 2000;
        if(!(y > 2000 && y < 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
        return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    };
    let m;
    if((m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/))) return iso(m[1], m[2], m[3]);
    if((m = s.match(/(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})/))) return iso(m[3], m[2], m[1]);
    if((m = s.match(/(\d{1,2})\s+([a-z]{3})[a-z]*\.?,?\s+(\d{4})/)) && MONTHS[m[2]]) return iso(m[3], MONTHS[m[2]], m[1]);
    if((m = s.match(/([a-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/)) && MONTHS[m[1]]) return iso(m[3], MONTHS[m[1]], m[2]);
    return null;
}
function salaryNumber(text){
    const nums = (String(text || "").replace(/(\d)[\s,.](?=\d{3}\b)/g, "$1").match(/\d{3,6}/g) || [])
        .map(Number).filter(n => Number.isInteger(n) && n >= 100 && n < 200000);
    return nums.length ? Math.max(...nums) : null;     // всегда целое число или null (важно для PostgreSQL)
}
/* Хештег: из списка типов судов берём первый ("Crude Oil Tanker, Chemical Tanker" → #CrudeOilTanker), не длиннее 28 символов */
const tagOf = v => { const t = String(v || "").split(/[,;|]|\s\/\s/)[0].replace(/[^A-Za-z0-9]/g, "").slice(0, 28); return t ? "#" + t : null; };
function makeHashtags(position, vesselType, fleet){
    return [...new Set([position !== "Vacancy" ? tagOf(position) : null, tagOf(vesselType), tagOf(fleet)].filter(Boolean))];
}
/* Вакансии старше 45 дней (по дате публикации) на сайте не показываем */
const VACANCY_DAYS = 45;
/* Срок жизни вакансии:
   — дата посадки указана и прошла → вакансия удаляется через 5 дней после этой даты;
   — даты нет (ASAP / не указана) → удаляется через 30 дней после публикации. */
const EXPIRED_KEEP_DAYS = 5, NO_DATE_KEEP_DAYS = 30;
const ALIVE_SQL = `((join_date IS NOT NULL AND join_date >= $1) OR (join_date IS NULL AND published >= $2))`;
const aliveParams = () => [isoDaysAgo(EXPIRED_KEEP_DAYS), isoDaysAgo(NO_DATE_KEEP_DAYS)];
async function cleanupVacancies(){
    const [d1, d2] = aliveParams();
    const cnt = async (sql, p) => Number(((await db.query(sql, p))[0] || {}).c || 0);
    const a = await cnt(`SELECT COUNT(*) AS c FROM vacancies WHERE join_date IS NOT NULL AND join_date < $1`, [d1]);
    const b = await cnt(`SELECT COUNT(*) AS c FROM vacancies WHERE join_date IS NULL AND published < $1`, [d2]);
    if(a) await db.query(`DELETE FROM vacancies WHERE join_date IS NOT NULL AND join_date < $1`, [d1]);
    if(b) await db.query(`DELETE FROM vacancies WHERE join_date IS NULL AND published < $1`, [d2]);
    if(a || b) console.log(`🧹 Удалено вакансий: с истёкшей датой посадки (5+ дней) — ${a}, без даты старше 30 дней — ${b}`);
}
const isoDaysAgo = d => new Date(Date.now() - d * 864e5).toISOString().slice(0, 10);

/* Убираем мусорные строки из описания (пункты меню UkrCrewing, например "IT-manager") */
const INFO_NOISE = /^(?:ℹ️\s*)?(it-manager|asst it manager|all positions)\s*$/i;
const cleanInfo = t => t ? String(t).split("\n").filter(l => !INFO_NOISE.test(l.trim())).join("\n").trim() || null : t;

/* =========================================================
   ЕДИНАЯ ПРОВЕРКА ВАКАНСИЙ ДЛЯ ВСЕХ ПАРСЕРОВ (Telegram-каналы, Crewlink, UkrCrewing, Ai Nostri)
   Парсер отправляет вакансию сюда → сайт решает: новая (created) / дубль (duplicate) / мусор (skipped).
   В бот парсер шлёт ТОЛЬКО новые.
   Дубль (за DUP_DAYS дней): та же почта + должность + тип судна + зарплата (после приведения к одному виду),
   КРОМЕ случая, когда в обеих вакансиях указаны разные название судна или дата посадки (это разные суда).
   Плюс: тот же источник + номер поста/вакансии — тоже дубль.
========================================================= */
const DUP_DAYS = 30;
const VT_SYNONYMS = [
    [/\bchem\b/g, "chemical"], [/\bbulkers?\b|\bbulkcarriers?\b/g, "bulk carrier"], [/\blngc\b/g, "lng carrier"],
    [/\blpgc\b/g, "lpg carrier"], [/\bro\s*-?\s*ro\b/g, "roro"], [/\bro\s*-?\s*pax\b/g, "ropax"], [/\bcontainerships?\b/g, "container"],
    [/\bpctc\b|\bpcc\b|\bcar\s+carriers?\b/g, "car carrier"], [/\bgen(?:eral)?\.?\s*cargo\b/g, "general cargo"], [/\btankers\b/g, "tanker"],
    [/\bproducts?\b/g, "product"], [/\bsupply\s+vessels?\b/g, "osv"], [/\bdrill\s*ships?\b/g, "drillship"],
];
const VT_STOP = new Set(["vessel", "vessels", "ship", "ships", "type", "the", "and", "of", "a", "m", "v", "mv", "mt", "for", "on"]);
function canonVessel(v){
    let t = String(v || "").toLowerCase();
    for(const [re, to] of VT_SYNONYMS) t = t.replace(re, to);
    const words = t.replace(/[^a-z0-9а-яё]+/g, " ").split(" ").filter(w => w && !VT_STOP.has(w));
    return [...new Set(words)].sort().join(" ");
}
function canonSalary(text){
    const s = String(text || "").toLowerCase();
    if(!/\d/.test(s)) return "";
    const nums = (s.replace(/(\d)[\s,.](?=\d{3}\b)/g, "$1").replace(/(\d+(?:\.\d+)?)\s*k\b/g, (m, n) => String(Math.round(parseFloat(n) * 1000)))
        .match(/\d+/g) || []).map(Number).filter(n => n >= 50 && n < 1000000);
    if(!nums.length) return "";
    const cur = /€|eur/.test(s) ? "eur" : /£|gbp/.test(s) ? "gbp" : /\$|usd|dollar/.test(s) ? "usd" : "";
    const per = /\b(day|daily|per\s*day|\/\s*day|в\s*день|день)\b/.test(s) ? "/day" : "";
    return [...new Set(nums)].sort((a, b) => a - b).join("-") + cur + per;
}
/* Должность в одном виде: «C/O», «Ch.Officer», «Старпом» → chief officer */
function canonRank(position, title){
    const p = String(position || "");
    const src = /multiple/i.test(p) || !p || p === "Vacancy" ? String(title || "") : p;
    let best = null, at = Infinity;
    for(const [name, re] of CV_RANKS){ const m = src.match(re); if(m && m.index < at){ best = name; at = m.index; } }
    if(best) return best.toLowerCase();
    return src.toLowerCase().replace(/[^a-z0-9а-яё]+/g, " ").trim().slice(0, 80);
}
const canonName = v => String(v || "").toLowerCase().replace(/^(m\/?[vt]|mv|mt)\.?\s+/i, "").replace(/[^a-z0-9а-яё]+/g, "").slice(0, 60);
/* Мусор: не вакансия (резюме моряка, реклама, курсы) или нет корпоративной почты / должности */
const CV_POST_RE = /\b(looking\s+for\s+(a\s+)?(job|position|vacanc\w+|contract)|seeking\s+(a\s+)?(job|position|employment)|my\s+cv\b|cv\s+of\s+|i\s+am\s+available|available\s+from\s+\d|ищу\s+работу|резюме\s+моряка|шукаю\s+роботу|готов\s+к\s+посадке)/i;
const AD_POST_RE = /(подписывайтесь|подпишитесь\s+на\s+канал|subscribe\s+to\s+(our|the|my)\s+channel|промокод|promo\s*code|реклама\b|training\s+cent(er|re)\b|учебн\w+\s+центр|курсы\s+для\s+моряков|вебинар|webinar|розыгрыш|giveaway)/i;
function junkReason(v, row){
    const text = `${v.title || ""}\n${v.info || ""}`;
    if(!row.email || !isCorporateEmail(row.email)) return "нет корпоративной почты";
    if(CV_POST_RE.test(text)) return "это резюме моряка, а не вакансия";
    if(AD_POST_RE.test(text)) return "реклама / курсы, а не вакансия";
    const rankText = `${v.rank || ""} ${v.title || ""} ${String(v.info || "").slice(0, 600)}`;
    if(!/multiple/i.test(String(v.rank || "")) && !CV_RANKS.some(([, re]) => re.test(rankText)) && !Object.keys(RANK_MAP).some(k => rankText.toLowerCase().includes(k)))
        return "должность не распознана";
    return null;
}
async function findDuplicate(row, v){
    if(!row.email) return null;
    const rank = canonRank(row.position, row.title), vessel = canonVessel(row.vessel_type), salary = canonSalary(row.salary_text);
    const name = canonName(row.vessel_name), join = row.join_date || "";
    const cands = await db.query(
        `SELECT id, position, title, vessel_type, vessel_name, salary_text, join_date FROM vacancies
          WHERE email = $1 AND published >= $2 ORDER BY published DESC LIMIT 500`, [row.email, isoDaysAgo(DUP_DAYS)]);
    for(const c of cands){
        if(canonRank(c.position, c.title) !== rank) continue;
        if(canonVessel(c.vessel_type) !== vessel) continue;
        if(canonSalary(c.salary_text) !== salary) continue;
        // разные суда одной компании: если у обеих указано и отличается — это другая вакансия
        const cName = canonName(c.vessel_name);
        if(name && cName && name !== cName) continue;
        if(join && c.join_date && join !== c.join_date) continue;
        return {id: c.id, reason: `та же почта + должность + судно + зарплата (${row.position} / ${row.vessel_type || "—"} / ${row.salary_text || "—"})`};
    }
    return null;
}

/* =========================================================
   НАЗВАНИЕ КОМПАНИИ ДЛЯ КАРТОЧКИ ВАКАНСИИ
   1) поле «компания» из источника; 2) строка «Company: …» в описании;
   3) домен почты → каталог «Работодатели» / зарегистрированные компании; 4) из самого домена (vantage-drilling.com → Vantage Drilling)
========================================================= */
const COMPANY_LINE_RE = /(?:^|\n)\s*(?:company(?:\s+name)?|employer|agency|crewing(?:\s+agency)?|manning\s+agency|компания|компанія|работодатель|роботодавець)\s*[:\-–]\s*([^\n]{2,80})/i;
const COMPANY_BAD = /^(confidential|undisclosed|n\/?a|-+|—|private|не указан\w*|конфиденциально)$/i;
const TWO_LEVEL_TLD = /\.(co|com|net|org|gov|ac)\.[a-z]{2}$/i;
const DOMAIN_PREFIX = /^(mail|email|crew|crewing|hr|jobs|job|careers|career|recruitment|recruit|manning|www|cv)\./i;
let companyDomainMap = null, companyDomainAt = 0;
async function companyDomains(){
    if(companyDomainMap && Date.now() - companyDomainAt < 10 * 60_000) return companyDomainMap;
    const map = new Map();
    const add = (domain, name) => { domain = String(domain || "").toLowerCase().trim(); if(domain && name && isCorporateEmail("x@" + domain) && !map.has(domain)) map.set(domain, String(name).trim()); };
    try{
        for(const r of await db.query(`SELECT name, email, website FROM crewings WHERE name IS NOT NULL`)){
            String(r.email || "").split(/[,;\s]+/).forEach(e => { if(e.includes("@")) add(e.split("@")[1], r.name); });
            const w = String(r.website || "").toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[\/?#]/)[0];
            if(w.includes(".")) add(w, r.name);
        }
        for(const u of await db.query(`SELECT email, company_name FROM users WHERE role = 'crewing' AND company_name IS NOT NULL`))
            add(String(u.email).split("@")[1], u.company_name);
    }catch(e){ console.error("❌ Справочник компаний:", e.message); }
    companyDomainMap = map; companyDomainAt = Date.now();
    return map;
}
function companyFromDomain(domain){
    let d = String(domain || "").toLowerCase().replace(DOMAIN_PREFIX, "");
    const parts = d.split(".");
    if(parts.length < 2) return "";
    const label = TWO_LEVEL_TLD.test(d) ? parts[parts.length - 3] : parts[parts.length - 2];
    if(!label || label.length < 2) return "";
    return label.split(/[-_]+/).filter(Boolean).map(w => w.length <= 3 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)).join(" ");
}
async function companyFor(v){
    const given = clean(v.company, 160);
    if(given && !COMPANY_BAD.test(given)) return given;
    const m = String(v.info || "").match(COMPANY_LINE_RE);
    if(m){ const name = clean(m[1].replace(/[*_`]+/g, ""), 80).replace(/[.,;]+$/, ""); if(name && !COMPANY_BAD.test(name) && !name.includes("@")) return name; }
    const email = String(v.email || "").toLowerCase();
    if(!email.includes("@") || !isCorporateEmail(email)) return "";
    const domain = email.split("@")[1];
    const map = await companyDomains();
    let probe = domain;
    while(probe.includes(".")){ if(map.has(probe)) return map.get(probe); probe = probe.slice(probe.indexOf(".") + 1); }
    return companyFromDomain(domain);
}

async function importVacancy(v, dryRun = false){
    const source = clean(v.source, 40).toLowerCase();
    const externalId = clean(v.external_id || v.id || v.url, 300);
    if(!source || !externalId) return {ok: false, error: "source/external_id"};
    const position = normPosition(v.rank, v.title);
    const vesselType = clean(v.vessel_type, 100) || null;
    const fleet = detectFleet(vesselType, `${v.title || ""} ${v.info || ""}`, v.fleet);
    const joinText = clean(v.joining_date || v.join_date, 100) || null;
    const salaryText = clean(v.salary, 100) || null;
    const email = clean(v.email, 160).toLowerCase();
    const row = {
        url: /^https?:\/\//.test(String(v.url || "")) ? clean(v.url, 500) : null,
        title: clean(v.title, 200) || null, position, fleet, vessel_type: vesselType, vessel_name: clean(v.vessel_name, 120) || null,
        region: clean(v.region, 120) || null, join_date: parseDate(joinText), join_text: joinText, duration: clean(v.duration, 100) || null,
        salary_text: salaryText, salary_num: salaryNumber(salaryText), email: isEmail(email) ? email : null, phone: clean(v.phone, 60) || null,
        company: (await companyFor({company: v.company, info: v.info, email: v.email})) || null, info: cleanInfo(clean(v.info, 4000)) || null,
        hashtags: JSON.stringify(makeHashtags(position, vesselType, fleet)),
        published: parseDate(v.published || v.publication_date) || now().slice(0, 10)
    };
    const existing = (await db.query(`SELECT * FROM vacancies WHERE source = $1 AND external_id = $2`, [source, externalId]))[0];
    if(!existing){
        // мусор (резюме, реклама, без корпоративной почты / должности) — не сохраняем и в бот не шлём
        const junk = v.skip_junk_check ? null : junkReason(v, row);
        if(junk) return {ok: true, skipped: true, reason: junk};
        // дубль по содержимому — та же вакансия из другого источника или перезалитая (за DUP_DAYS дней)
        const dup = await findDuplicate(row, v);
        if(dup) return {ok: true, duplicate: true, id: dup.id, reason: dup.reason};
    }
    // Проверка без сохранения: парсер спрашивает «это дубль?» перед отправкой в Telegram
    if(dryRun) return existing ? {ok: true, duplicate: true, id: existing.id, reason: "already published"} : {ok: true, duplicate: false};
    if(existing){
        // при обновлении пустые поля не затирают уже сохранённые данные
        for(const c of Object.keys(row)) if(row[c] == null && existing[c] != null) row[c] = existing[c];
        if(!clean(v.rank) && !clean(v.title)) row.position = existing.position;
        if(!vesselType && !v.fleet) row.fleet = existing.fleet;
        if(!parseDate(v.published || v.publication_date)) row.published = existing.published;
        row.salary_num = salaryNumber(row.salary_text);
        row.join_date = parseDate(row.join_text) || existing.join_date;
        row.hashtags = JSON.stringify(makeHashtags(row.position, row.vessel_type, row.fleet));
    }
    const cols = Object.keys(row);
    if(existing){
        await db.query(`UPDATE vacancies SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(", ")}, updated_at = $${cols.length + 1} WHERE id = $${cols.length + 2}`,
            [...cols.map(c => row[c]), now(), existing.id]);
        return {ok: true, id: existing.id, updated: true, duplicate: true, reason: "already published"};
    }
    const id = uuid();
    await db.query(`INSERT INTO vacancies(id, source, external_id, ${cols.join(", ")}, created_at, updated_at)
                    VALUES(${[...Array(cols.length + 5)].map((_, i) => "$" + (i + 1)).join(", ")})`,
        [id, source, externalId, ...cols.map(c => row[c]), now(), now()]);
    return {ok: true, id, created: true};
}

/* =========================================================
   ПОДПИСКА НА ВАКАНСИИ: моряк выбирает должность, флот, тип судна, мин. зарплату —
   при появлении подходящей вакансии ему приходит письмо с кнопкой «Податься»
========================================================= */
/* Типы судов подписки: новый формат — список vesselTypes, старый — vesselType / vesselType2 */
const alertVesselTypes = a => Array.isArray(a.vesselTypes) && a.vesselTypes.length ? a.vesselTypes : [a.vesselType, a.vesselType2].filter(Boolean);
/* «LNG Carrier» → нужно слово lng; «Crew Boat / CTV» → любой из вариантов; общие слова (carrier, vessel, ship…) не учитываются */
const VT_GENERIC = new Set(["carrier", "vessel", "ship", "boat", "tanker", "the", "and", "of", "support", "type"]);
function vesselTypeMatches(type, vt){
    return String(type).split("/").some(alt => {
        const caps = new Set((alt.match(/\b[A-Z0-9]{3,}\b/g) || []).map(x => x.toLowerCase()));
        const words = alt.toLowerCase().replace(/[^a-z0-9а-яё]+/g, " ").trim().split(" ").filter(Boolean);
        if(!words.length) return false;
        const key = words.filter(w => !VT_GENERIC.has(w));
        const need = key.length ? key : words;
        return need.every(w => vt.includes(` ${w} `) || ((w.length >= 4 || caps.has(w)) && vt.includes(` ${w}`)));
    });
}
function alertMatches(a, v){
    if(!a || !a.enabled) return false;
    // должность (с синонимами: Ch.Officer = Chief Officer, Captain = Master …)
    const text = `${v.position || ""} ${v.title || ""}`;
    const posMatch = pos => {
        const rank = CV_RANKS.find(([name]) => name.toLowerCase() === String(pos).toLowerCase());
        return (rank ? rank[1].test(text) : text.toLowerCase().includes(String(pos).toLowerCase()))
            || String(v.position || "").toLowerCase() === String(pos).toLowerCase();
    };
    const positions = [a.position, a.position2].filter(Boolean);   // до 2 должностей — подходит любая
    if(positions.length && !positions.some(posMatch)) return false;
    // флот — один выбранный
    const fleet = v.vessel_type ? detectFleet(v.vessel_type, "", v.fleet) : splitTankerGas(v.fleet, `${v.title || ""} ${v.info || ""}`);
    if(a.fleet === "Tanker/Gas Fleet"){ if(fleet !== "Tanker Fleet" && fleet !== "Gas Fleet") return false; }
    else if(a.fleet && fleet !== a.fleet) return false;
    // типы судов (список из подписки; пусто = все типы выбранного флота) — подходит любой
    const types = alertVesselTypes(a);
    if(types.length){
        const vt = ` ${String(`${v.vessel_type || ""} ${v.title || ""}`).toLowerCase().replace(/[^a-z0-9а-яё]+/g, " ")} `;
        if(!types.some(type => vesselTypeMatches(type, vt))) return false;
    }
    // минимальная зарплата: если в вакансии зарплата указана и она ниже — не отправляем
    if(a.minSalary && v.salary_num && v.salary_num < Number(a.minSalary)) return false;
    return true;
}
/* Рассылка 2 раза в день — в 10:00 и 15:00 (Лондон): «на сайте появились интересующие вас вакансии» —
   список новых вакансий с прошлой рассылки по критериям моряка (без данных компании),
   кнопка «Податься» ведёт на самую свежую из них */
const DIGEST_HOURS = String(process.env.DIGEST_HOURS || "10,15").split(",").map(Number).sort((a, b) => a - b);
const londonNow = () => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false})
        .formatToParts(new Date()).map(x => [x.type, x.value]));
    return {day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour)};
};
async function metaGet(key){ return ((await db.query(`SELECT value FROM meta WHERE key = $1`, [key]))[0] || {}).value || ""; }
async function metaSet(key, value){
    await db.query(`DELETE FROM meta WHERE key = $1`, [key]);
    await db.query(`INSERT INTO meta(key, value) VALUES($1, $2)`, [key, value]);
}
async function sendVacancyDigest(){
    const {day, hour} = londonNow();
    const slot = DIGEST_HOURS.filter(h => h <= hour).pop();
    if(slot === undefined) return;                          // до 10:00 — рано
    const key = `${day} ${slot}`;
    if(await metaGet("digest_slot") === key) return;        // в этот час уже отправляли
    await metaSet("digest_slot", key);                      // сразу отмечаем — чтобы не отправить дважды
    const since = (await metaGet("digest_since")) || new Date(Date.now() - 864e5).toISOString();
    const startedAt = now();
    const vacancies = await db.query(`SELECT * FROM vacancies WHERE hidden = 0 AND created_at > $1 ORDER BY created_at DESC LIMIT 500`, [since]);
    await metaSet("digest_since", startedAt);
    const today = now().slice(0, 10);
    const fresh = vacancies.filter(v => !v.join_date || v.join_date >= today);
    if(!fresh.length) return console.log("🔔 Рассылка: новых вакансий за сутки нет");
    const rows = await db.query(`SELECT u.id, u.email, u.name, u.lang, p.data FROM users u JOIN profiles p ON p.user_id = u.id
                                 WHERE u.role = 'seafarer' AND u.blocked = 0 AND u.email_verified = 1`);
    let sent = 0;
    for(const r of rows){
        let p = {}; try { p = JSON.parse(r.data); } catch(e){ continue; }
        const list = fresh.filter(v => alertMatches(p.alerts, v)).slice(0, 20);
        if(!list.length) continue;
        const name = [p.firstName || r.name, p.lastName].filter(Boolean).join(" ");
        const m = MT[mailLang(r.lang)];
        const td = () => `style="padding:8px 10px;border-bottom:1px solid #e3edf1"`;
        const items = list.map(v => `<tr>
            <td ${td()}><a href="${SITE_URL}/vacancies#vacancy-${v.id}" style="color:#087faa;font-weight:bold;text-decoration:none">${escHtml(v.position || "—")}</a></td>
            <td ${td()}>${escHtml(v.vessel_type || "—")}</td><td ${td()}>${escHtml(v.salary_text || "Negotiable")}</td><td ${td()}>${escHtml(v.join_text || "—")}</td></tr>`).join("");
        const th = x => `<th align="left" style="padding:8px 10px">${x}</th>`;
        const text = `${m.hello(escHtml(name))}<br><br>${m.digText(list.length)}
            <table style="width:100%;margin:12px 0;border-collapse:collapse;font-size:14px">
                <tr style="background:#082b42;color:#fff">${th(m.lPos)}${th(m.lType)}${th(m.lSalary)}${th(m.lJoin)}</tr>
                ${items}
            </table>
            <span style="font-size:12px;color:#6b8190">${m.digFoot} ${SITE_URL}/account#alerts</span><br>
            <a href="${unsubLink(r.id)}" style="font-size:12px;color:#6b8190">${UNSUB_TEXT[mailLang(r.lang)] || UNSUB_TEXT.en}</a>`;
        try{
            await sendMail(r.email, m.digSubj, mailLayout(m.digTitle, text, `${SITE_URL}/vacancies#vacancy-${list[0].id}`, m.digBtn, r.lang));
            sent++;
        }catch(e){ console.error("❌ Рассылка:", r.email, e.message); }
    }
    console.log(`🔔 Рассылка вакансий: новых вакансий ${fresh.length}, писем отправлено ${sent}`);
}
/* Заявка компании на удаление из каталога «Работодатели» → письмо администратору */
route("POST", "/api/contact/remove-company", async (req, res, {body, ip, user}) => {
    if(rateLimited("rmco:" + ip, 3, 60 * 60_000)) return fail(res, 429, "tooMany");
    const company = clean(body.company, 200), email = clean(body.email, 160).toLowerCase(), message = clean(body.message, 2000);
    if(!company || !message) return fail(res, 400, "errFillAll");
    if(email && !isEmail(email)) return fail(res, 400, "errEmail");
    const to = ADMIN_EMAILS[0] || "info@wayatsea.com";
    const row = (l, v) => `<tr><td style="padding:6px 14px 6px 0;color:#6b8190">${l}</td><td style="padding:6px 0;font-weight:bold">${escHtml(v || "—")}</td></tr>`;
    await sendMail(to, `Request to remove company: ${company} — Way At Sea`,
        `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#17394d">
         <h2 style="color:#082b42">Request to remove a company</h2>
         <table style="border-collapse:collapse">${row("Company", company)}${row("Contact e-mail", email)}${row("Account", user ? user.email : "")}${row("IP", ip)}</table>
         <p style="white-space:pre-line;padding:12px;border-radius:8px;background:#f3f8fa">${escHtml(message)}</p>
         <p style="font-size:12px;color:#6b8190">Find the company in the admin panel or on ${SITE_URL}/companies?q=${encodeURIComponent(company)}</p></div>`);
    console.log(`🏢 Заявка на удаление компании: ${company} (${email || "без e-mail"})`);
    json(res, 200, {ok: true});
});
/* =========================================================
   ЛИЧНЫЙ КАБИНЕТ КОМПАНИИ: профиль компании и свои вакансии.
   Вакансия от компании → модерация администратором → публикация на сайте.
========================================================= */
const companyOnly = user => user && user.role === "crewing" && !user.blocked;
const companyVacancyView = r => ({id: r.id, position: r.position, vesselType: r.vessel_type, joinDate: r.join_date, joinText: r.join_text,
    salary: r.salary_text || "Negotiable", duration: r.duration, info: r.info, status: r.status || (r.hidden ? "hidden" : "approved"), published: r.published, createdAt: r.created_at});
route("GET", "/api/company/cabinet", async (req, res, {user}) => {
    if(!companyOnly(user)) return fail(res, 401, "auth");
    const p = await getProfile(user.id);
    const vacancies = await db.query(`SELECT * FROM vacancies WHERE company_id = $1 ORDER BY created_at DESC LIMIT 200`, [user.id]);
    json(res, 200, {company: {name: p.companyName || user.company_name || user.name, country: p.country || "", city: p.city || "",
        phone: p.companyPhone || [user.phone_code, user.phone].filter(Boolean).join(" "), email: p.contactEmail || user.email,
        website: p.website || "", description: p.description || "", license: p.license || "",
        logo: p.logo ? `/api/company-logo/${user.id}?v=${p.logoV || 1}` : ""},
        accountEmail: user.email, verified: !!user.email_verified, approved: !!user.approved, vacancies: vacancies.map(companyVacancyView)});
});
/* --- Логотип компании: показывается в каталоге «Работодатели» вместо инициалов --- */
route("POST", "/api/company/logo", async (req, res, {user, body}) => {
    if(!companyOnly(user)) return fail(res, 401, "auth");
    if(rateLimited("logo:" + user.id, 20, 3600_000)) return fail(res, 429, "tooMany");
    const m = String(body.data || "").match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+\/]+=*)$/);
    if(!m) return fail(res, 400, "errLogoType");
    const buf = Buffer.from(m[2], "base64");
    const sig = buf.subarray(0, 4).toString("hex");
    if(buf.length > 300 * 1024 || !(sig.startsWith("ffd8") || sig === "89504e47" || sig === "52494646")) return fail(res, 400, "errLogoType");
    const p = await getProfile(user.id);
    p.logo = String(body.data); p.logoV = Date.now();
    await saveProfile(user.id, p);
    json(res, 200, {logo: `/api/company-logo/${user.id}?v=${p.logoV}`});
});
route("DELETE", "/api/company/logo", async (req, res, {user}) => {
    if(!companyOnly(user)) return fail(res, 401, "auth");
    const p = await getProfile(user.id);
    delete p.logo; delete p.logoV;
    await saveProfile(user.id, p);
    json(res, 200, {logo: ""});
});
route("GET", /^\/api\/company-logo\/([\w-]+)$/, async (req, res, {params}) => {
    const p = await getProfile(params[0]);
    const m = String(p?.logo || "").match(/^data:(image\/(?:png|jpeg|webp));base64,(.+)$/);
    if(!m) return notFound(res);
    const buf = Buffer.from(m[2], "base64");
    res.writeHead(200, {...SECURITY_HEADERS, "Content-Type": m[1], "Content-Length": buf.length, "Cache-Control": "public, max-age=86400"});
    res.end(buf);
});

route("PUT", "/api/company/profile", async (req, res, {user, body}) => {
    if(!companyOnly(user)) return fail(res, 401, "auth");
    const c = body.company || {};
    const email = clean(c.email, 160).toLowerCase();
    if(!clean(c.name)) return fail(res, 400, "errFillAll");
    if(email && (!isEmail(email) || !isCorporateEmail(email))) return fail(res, 400, "errCorpEmail");
    const p = await getProfile(user.id);
    Object.assign(p, {companyName: clean(c.name, 160), country: clean(c.country, 80), city: clean(c.city, 80), companyPhone: clean(c.phone, 40),
        contactEmail: email || user.email, website: clean(c.website, 200), description: clean(c.description, 3000),
        ...("license" in c ? {license: clean(c.license, 120)} : {})});
    await saveProfile(user.id, p);
    await db.query(`UPDATE users SET company_name = $1 WHERE id = $2`, [p.companyName, user.id]);
    json(res, 200, {ok: true});
});
route("POST", "/api/company/vacancies", async (req, res, {user, body}) => {
    if(!companyOnly(user)) return fail(res, 401, "auth");
    if(!user.email_verified) return fail(res, 403, "notVerified");
    if(rateLimited("covac:" + user.id, 20, 24 * 3600_000)) return fail(res, 429, "tooMany");
    const v = body.vacancy || {};
    const position = clean(v.position, 80), vesselType = clean(v.vesselType, 100);
    if(!position || !vesselType) return fail(res, 400, "errFillAll");
    const p = await getProfile(user.id);
    const joinText = clean(v.joinDate, 40) || "ASAP";
    const salaryText = clean(v.salary, 100) || null;
    const id = uuid();
    const row = {url: null, title: position, position: normPosition(position, position), fleet: detectFleet(vesselType, "", null), vessel_type: vesselType,
        vessel_name: null, region: [p.country, p.city].filter(Boolean).join(", ") || null, join_date: parseDate(joinText), join_text: joinText,
        duration: clean(v.duration, 100) || null, salary_text: salaryText, salary_num: salaryNumber(salaryText),
        email: (p.contactEmail || user.email).toLowerCase(), phone: p.companyPhone || [user.phone_code, user.phone].filter(Boolean).join(" ") || null,
        company: p.companyName || user.company_name || user.name, info: clean(v.info, 4000) || null,
        hashtags: "[]", published: now().slice(0, 10), hidden: 1, status: "pending", company_id: user.id};
    const cols = Object.keys(row);
    await db.query(`INSERT INTO vacancies(id, source, external_id, ${cols.join(", ")}, created_at, updated_at)
                    VALUES(${[...Array(cols.length + 5)].map((_, i) => "$" + (i + 1)).join(", ")})`,
        [id, "company", id, ...cols.map(c => row[c]), now(), now()]);
    console.log(`📝 Вакансия от компании на модерации: ${row.company} — ${row.position}`);
    // письмо администратору
    const to = ADMIN_EMAILS[0] || "info@wayatsea.com";
    const line = (l, x) => `<tr><td style="padding:5px 14px 5px 0;color:#6b8190">${l}</td><td style="padding:5px 0;font-weight:bold">${escHtml(x || "—")}</td></tr>`;
    sendMail(to, `New vacancy for moderation: ${row.position} — ${row.company}`,
        mailLayout("New vacancy for moderation", `<table style="border-collapse:collapse">${line("Company", row.company)}${line("Rank", row.position)}${line("Vessel type", vesselType)}${line("Joining", joinText)}${line("Salary", salaryText || "Negotiable")}${line("Contract", row.duration)}</table>
        <p style="white-space:pre-line">${escHtml(row.info || "")}</p>`, `${SITE_URL}/admin`, "Open admin panel")).catch(() => {});
    json(res, 200, {ok: true, vacancy: companyVacancyView({...row, id, created_at: now()})});
});
route("DELETE", /^\/api\/company\/vacancies\/([\w-]+)$/, async (req, res, {user, params}) => {
    if(!companyOnly(user)) return fail(res, 401, "auth");
    const r = (await db.query(`SELECT id FROM vacancies WHERE id = $1 AND company_id = $2`, [params[0], user.id]))[0];
    if(!r) return fail(res, 404, "notFound");
    await db.query(`DELETE FROM vacancies WHERE id = $1`, [r.id]);
    json(res, 200, {ok: true});
});

/* =========================================================
   «МОИ ВАКАНСИИ» МОРЯКА: вакансии, на которые он нажал «Податься».
   Сохраняется снимок вакансии (даже если её потом удалят с сайта).
========================================================= */
route("POST", "/api/profile/applications", async (req, res, {user, body}) => {
    if(!user || user.role !== "seafarer") return fail(res, 401, "auth");
    if(!user.email_verified) return fail(res, 403, "notVerified");
    const v = (await db.query(`SELECT * FROM vacancies WHERE id = $1 AND hidden = 0`, [clean(body.vacancyId, 60)]))[0];
    if(!v) return fail(res, 404, "notFound");
    const p = await getProfile(user.id);
    const apps = Array.isArray(p.applications) ? p.applications : [];
    if(!apps.some(a => a.vacancyId === v.id)){
        apps.unshift({vacancyId: v.id, position: v.position, vesselType: v.vessel_type, salary: v.salary_text || "Negotiable", joinText: v.join_text,
            joinDate: v.join_date, duration: v.duration, company: v.company, email: v.email, phone: v.phone, info: (v.info || "").slice(0, 1500),
            savedAt: now(), sentAt: null});
        p.applications = apps.slice(0, 100);
        await saveProfile(user.id, p);
    }
    json(res, 200, {applications: p.applications || apps});
});

/* «Отправить резюме» по сохранённой вакансии: письмо с сервера на e-mail вакансии, анкета PDF во вложении, ответ — моряку */
route("POST", /^\/api\/profile\/applications\/([\w-]+)\/send$/, async (req, res, {user, body, params}) => {
    if(!user || user.role !== "seafarer") return fail(res, 401, "auth");
    if(!user.email_verified) return fail(res, 403, "notVerified");
    const p = await getProfile(user.id);
    const app = (p.applications || []).find(a => a.vacancyId === params[0]);
    if(!app) return fail(res, 404, "notFound");
    const to = (String(app.email || "").match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || [])[0];
    if(!to) return fail(res, 400, "appsNoEmail");
    const kOne = `vapply:${user.id}:${app.vacancyId}`, kDay = "vapply:" + user.id;
    if(rateLimited(kOne, 1, 24 * 3600_000)){ rateUndo(kOne); return fail(res, 429, "coApplyAlready"); }
    if(rateLimited(kDay, 30, 24 * 3600_000)){ rateUndo(kDay); rateUndo(kOne); return fail(res, 429, "coApplyDayLimit"); }
    const undo = () => { rateUndo(kOne); rateUndo(kDay); };
    const b = await buildSeafarerPdf(user.id).catch(e => { console.error("❌ PDF анкеты:", e.message); return null; });
    if(!b){ undo(); return fail(res, 500, "server"); }
    const name = [p.firstName, p.lastName].filter(Boolean).join(" ");
    const message = clean(body.message, 3000) || `Good day!\n\nI would like to apply for the position of ${app.position || ""}${app.vesselType ? " on " + app.vesselType : ""}.\nMy profile form (PDF) is attached.\n\nBest regards,\n${name}`;
    const line = (l, v) => v ? `<tr><td style="padding:5px 14px 5px 0;color:#6b8190">${l}</td><td style="padding:5px 0;font-weight:bold">${escHtml(v)}</td></tr>` : "";
    const html = `<div style="font-family:Arial,sans-serif;max-width:600px;margin:auto;color:#17394d">
        <p style="white-space:pre-line;font-size:15px;line-height:1.55">${escHtml(message)}</p>
        <table style="margin:14px 0;border-collapse:collapse">${line("Name", name)}${line("Rank", p.position)}${line("Nationality", p.nationality)}
            ${line("Phone", [p.phoneCode, p.phone].filter(Boolean).join(" "))}${line("E-mail", user.email)}</table>
        <p>📎 The seafarer's profile form (PDF) is attached. If you can't see the attachment, <a href="${pdfLink(user.id)}">download it here</a>.</p>
        <p style="font-size:12px;color:#6b8190">Sent via Way At Sea — www.wayatsea.com. Reply to this e-mail to contact the seafarer directly.</p></div>`;
    const subject = `Application: ${app.position || p.position || "Seafarer"}${app.vesselType ? " — " + app.vesselType : ""} — ${name}`;
    const attachments = [{filename: b.fname, content: b.pdf.toString("base64"), type: "application/pdf"}];
    const ok = await sendMail(to, subject + " (Way At Sea)", html, {replyTo: user.email, attachments});
    console.log(`📨 Отклик моряка ${user.email} на вакансию ${app.vacancyId} → ${to} ${ok ? "отправлен" : "НЕ отправлен"}`);
    if(!ok){ undo(); return fail(res, 502, "errMailSend"); }
    app.sentAt = now();
    await saveProfile(user.id, p);
    json(res, 200, {applications: p.applications});
});
route("POST", /^\/api\/profile\/applications\/([\w-]+)\/(sent|delete)$/, async (req, res, {user, params}) => {
    if(!user || user.role !== "seafarer") return fail(res, 401, "auth");
    const p = await getProfile(user.id);
    const apps = Array.isArray(p.applications) ? p.applications : [];
    const [id, action] = params;
    if(action === "delete") p.applications = apps.filter(a => a.vacancyId !== id);
    else { const a = apps.find(x => x.vacancyId === id); if(a) a.sentAt = now(); p.applications = apps; }
    await saveProfile(user.id, p);
    json(res, 200, {applications: p.applications});
});

/* Язык писем пользователя — меняется вместе с языком сайта */
route("PUT", "/api/account/lang", async (req, res, {user, body}) => {
    if(!user) return fail(res, 401, "auth");
    if(MAIL_LANGS.includes(body.lang)) await db.query(`UPDATE users SET lang = $1 WHERE id = $2`, [body.lang, user.id]);
    json(res, 200, {ok: true});
});
/* Сохранить подписку моряка */
route("PUT", "/api/profile/alerts", async (req, res, {user, body}) => {
    if(!user || user.role !== "seafarer") return fail(res, 401, "auth");
    const p = await getProfile(user.id);
    const a = body.alerts || {};
    p.alerts = {enabled: !!a.enabled, position: clean(a.position, 80), position2: clean(a.position2, 80), fleet: clean(a.fleet, 40),
                vesselTypes: (Array.isArray(a.vesselTypes) ? a.vesselTypes : []).slice(0, 60).map(x => clean(x, 80)).filter(Boolean),
                minSalary: String(a.minSalary || "").replace(/\D/g, "").slice(0, 7)};
    if(p.alerts.position2 === p.alerts.position) p.alerts.position2 = "";
    if(p.alerts.enabled && !p.alerts.position) return fail(res, 400, "alertsNeedPosition");
    await saveProfile(user.id, p);
    const lang = mailLang(body.lang || user.lang);
    if(body.lang) await db.query(`UPDATE users SET lang = $1 WHERE id = $2`, [lang, user.id]);
    // письмо «уведомления подключены» с выбранными критериями (при включении и при изменении)
    if(p.alerts.enabled && user.email_verified){
        const m = MT[lang], a2 = p.alerts;
        const row = (l, v) => `<tr><td style="padding:6px 14px 6px 0;color:#6b8190">${l}</td><td style="padding:6px 0;font-weight:bold">${escHtml(v || m.lAny)}</td></tr>`;
        const name = [p.firstName || user.name, p.lastName].filter(Boolean).join(" ");
        const text = `${m.hello(escHtml(name))}<br><br>${m.alOnText}
            <table style="margin:12px 0;border-collapse:collapse">${row(m.lPos, [a2.position, a2.position2].filter(Boolean).join(", "))}${row(m.lFleet, a2.fleet)}${row(m.lType, alertVesselTypes(a2).join(", "))}${row(m.lSal, a2.minSalary && a2.minSalary + " USD")}</table>
            ${m.alWhen}`;
        sendMail(user.email, m.alOnSubj, mailLayout(m.alOnTitle, text, `${SITE_URL}/account#alerts`, m.alBtn, lang)).catch(e => console.error("❌ Письмо о подписке:", e.message));
    }
    json(res, 200, {profile: p, verified: !!user.email_verified});
});

/* Приём вакансий от парсеров: заголовок X-Import-Token = переменная IMPORT_TOKEN */
route("POST", "/api/import/vacancies", async (req, res, {body}) => {
    const expected = process.env.IMPORT_TOKEN || "";
    const got = String(req.headers["x-import-token"] || "");
    if(expected.length < 24 || got.length !== expected.length ||
       !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected))) return fail(res, 403, "forbidden");
    const list = Array.isArray(body.vacancies) ? body.vacancies.slice(0, 200) : [body];
    const results = [];
    for(const v of list){
        try { results.push(await importVacancy(v, body.dry_run === true)); }
        catch(e){ console.error("❌ Ошибка сохранения вакансии", v && v.source, v && v.external_id, "—", e.message); results.push({ok: false, error: "server", detail: String(e.message).slice(0, 200)}); }
    }
    const created = results.filter(r => r.created).length, updated = results.filter(r => r.updated).length;
    const dups = results.filter(r => r.duplicate && !r.updated).length, junk = results.filter(r => r.skipped).length;
    if(created || updated || dups || junk) console.log(`📥 Вакансии${body.dry_run === true ? " (проверка)" : ""}: новых ${created}, обновлено ${updated}, дублей ${dups}, мусор ${junk}`);
    json(res, 200, {results});
});

/* Список вакансий для сайта. Контакты и подробности — только вошедшим с подтверждённым e-mail */
route("GET", "/api/vacancies", async (req, res, {user}) => {
    const full = !!user && !!user.email_verified;
    const rows = await db.query(
        `SELECT * FROM vacancies WHERE hidden = 0 AND ${ALIVE_SQL} ORDER BY published DESC, created_at DESC LIMIT 1000`,
        aliveParams());
    // компания для карточки (у старых вакансий без поля «компания» — из описания или домена почты)
    const companies = await Promise.all(rows.map(r => r.company ? r.company : companyFor({info: r.info, email: r.email}).catch(() => "")));
    json(res, 200, {full, vacancies: rows.map((r, idx) => {
        const fleet = r.vessel_type ? detectFleet(r.vessel_type, "", r.fleet) : splitTankerGas(r.fleet, `${r.title || ""} ${r.info || ""}`);
        const tags = makeHashtags(r.position, r.vessel_type, fleet);
        const v = {id: r.id, position: r.position, title: r.title, fleet, vesselType: r.vessel_type, salaryText: r.salary_text || "Negotiable",
                   salary: r.salary_num, joinDate: r.join_date, joinText: r.join_text, published: r.published, hashtags: tags,
                   source: SOURCE_NAMES[r.source] || r.source, region: r.region, company: companies[idx] || ""};
        if(full) Object.assign(v, {vesselName: r.vessel_name, duration: r.duration, email: r.email, phone: r.phone,
                                   info: cleanInfo(r.info), url: r.url});
        return v;
    })});
});

/* --- АДМИН-ПАНЕЛЬ --- */
const adminOnly = user => isAdmin(user);
route("GET", "/api/admin/users", async (req, res, {user, query}) => {
    if(!adminOnly(user)) return fail(res, 403, "forbidden");
    const role = query.get("role") === "crewing" ? "crewing" : "seafarer";
    const rows = await db.query(
        `SELECT u.id, u.role, u.email, u.name, u.company_name, u.phone_code, u.phone, u.email_verified, u.approved, u.blocked,
                u.created_at, u.last_login, p.complete, p.data
         FROM users u LEFT JOIN profiles p ON p.user_id = u.id WHERE u.role = $1 ORDER BY u.created_at DESC LIMIT 2000`, [role]);
    json(res, 200, {users: rows.map(r => {
        let p = {}; try { p = r.data ? JSON.parse(r.data) : {}; } catch(e){}
        return {id: r.id, role: r.role, email: r.email, name: r.name, companyName: r.company_name, phoneCode: r.phone_code, phone: r.phone,
                emailVerified: !!r.email_verified, approved: !!r.approved, blocked: !!r.blocked, createdAt: r.created_at, lastLogin: r.last_login,
                complete: !!r.complete, position: p.position, fleet: p.fleetType, lastName: p.lastName, hasCv: !!p.cv};
    })});
});
route("POST", /^\/api\/admin\/users\/([\w-]+)\/(approve|reject|verify|block|unblock)$/, async (req, res, {user, params}) => {
    if(!adminOnly(user)) return fail(res, 403, "forbidden");
    const [id, action] = params;
    const u = (await db.query(`SELECT * FROM users WHERE id = $1`, [id]))[0];
    if(!u) return fail(res, 404, "notFound");
    if(action === "approve"){
        await db.query(`UPDATE users SET approved = 1 WHERE id = $1`, [id]);
        const ma = MT[mailLang(u.lang)];
        await sendMail(u.email, ma.apprSubj,
            mailLayout(ma.apprTitle, ma.apprText(escHtml(u.company_name || u.name)), `${SITE_URL}/seamans`, ma.apprBtn, u.lang));
    }
    if(action === "reject") await db.query(`UPDATE users SET approved = 0 WHERE id = $1`, [id]);
    if(action === "verify") await db.query(`UPDATE users SET email_verified = 1, verify_token = NULL WHERE id = $1`, [id]);
    if(action === "block"){ await db.query(`UPDATE users SET blocked = 1 WHERE id = $1`, [id]); await db.query(`DELETE FROM sessions WHERE user_id = $1`, [id]); }
    if(action === "unblock") await db.query(`UPDATE users SET blocked = 0 WHERE id = $1`, [id]);
    json(res, 200, {ok: true});
});
route("GET", "/api/admin/vacancies", async (req, res, {user}) => {
    if(!adminOnly(user)) return fail(res, 403, "forbidden");
    const rows = await db.query(`SELECT * FROM vacancies ORDER BY published DESC, created_at DESC LIMIT 2000`);
    json(res, 200, {vacancies: rows.map(r => ({id: r.id, source: SOURCE_NAMES[r.source] || r.source, position: r.position, title: r.title,
        fleet: r.fleet, vesselType: r.vessel_type, salaryText: r.salary_text || "Negotiable", joinDate: r.join_date, joinText: r.join_text,
        published: r.published, email: r.email, url: r.url, hidden: !!r.hidden, status: r.status || "", company: r.company, info: r.info,
        duration: r.duration, fromCompany: !!r.company_id,
        expired: r.join_date ? r.join_date < now().slice(0, 10) : r.published < isoDaysAgo(NO_DATE_KEEP_DAYS)}))});
});
route("POST", /^\/api\/admin\/vacancies\/([\w-]+)\/(hide|show|delete|approve|reject)$/, async (req, res, {user, params}) => {
    if(!adminOnly(user)) return fail(res, 403, "forbidden");
    const [id, action] = params;
    if(action === "approve" || action === "reject"){
        const v = (await db.query(`SELECT * FROM vacancies WHERE id = $1`, [id]))[0];
        if(!v) return fail(res, 404, "notFound");
        if(action === "approve"){
            // публикуем «сегодня» — чтобы вакансия попала в рассылку подписчикам
            await db.query(`UPDATE vacancies SET hidden = 0, status = 'approved', published = $1, created_at = $2, updated_at = $2 WHERE id = $3`, [now().slice(0, 10), now(), id]);
        }else await db.query(`UPDATE vacancies SET hidden = 1, status = 'rejected', updated_at = $1 WHERE id = $2`, [now(), id]);
        const co = v.company_id && (await db.query(`SELECT email FROM users WHERE id = $1`, [v.company_id]))[0];
        if(co) sendMail(co.email, action === "approve" ? `Your vacancy is published: ${v.position} — Way At Sea` : `Your vacancy was not approved: ${v.position} — Way At Sea`,
            mailLayout(action === "approve" ? "Vacancy published" : "Vacancy not approved",
                action === "approve" ? `Your vacancy <b>${escHtml(v.position)}</b> (${escHtml(v.vessel_type || "")}) has been approved and is now published on Way At Sea.`
                                     : `Your vacancy <b>${escHtml(v.position)}</b> (${escHtml(v.vessel_type || "")}) was not approved by the moderator. You can check it in your account and submit a new one.`,
                action === "approve" ? `${SITE_URL}/vacancies#vacancy-${id}` : `${SITE_URL}/account`, action === "approve" ? "View vacancy" : "Open my account")).catch(() => {});
        return json(res, 200, {ok: true});
    }
    if(action === "delete") await db.query(`DELETE FROM vacancies WHERE id = $1`, [id]);
    else await db.query(`UPDATE vacancies SET hidden = $1 WHERE id = $2`, [action === "hide" ? 1 : 0, id]);
    json(res, 200, {ok: true});
});
/* =========================================================
   КРЮИНГОВЫЕ КОМПАНИИ: приём от парсера и выгрузка в CSV (Excel)
========================================================= */
function checkImportToken(req){
    const expected = process.env.IMPORT_TOKEN || "";
    const got = String(req.headers["x-import-token"] || "");
    return expected.length >= 24 && got.length === expected.length &&
        crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}
route("POST", "/api/import/crewings", async (req, res, {body}) => {
    if(!checkImportToken(req)) return fail(res, 403, "forbidden");
    const list = Array.isArray(body.crewings) ? body.crewings.slice(0, 500) : [];
    let created = 0, updated = 0;
    for(const c of list){
        const source = clean(c.source || "ukrcrewing", 40).toLowerCase();
        const ext = clean(c.external_id || c.url, 300);
        if(!ext) continue;
        const email = clean(c.email, 300);
        const logo = validLogo(c.logo);
        // режим «только логотип»: парсер дособирает логотипы уже известных компаний
        if(c.logo_only){
            if(logo){ await db.query(`UPDATE crewings SET logo = $1, updated_at = $2 WHERE source = $3 AND external_id = $4`, [logo, now(), source, ext]); updated++; }
            continue;
        }
        const row = {url: /^https?:\/\//.test(String(c.url || "")) ? clean(c.url, 500) : null, name: clean(c.name, 200) || null,
            country: clean(c.country, 100) || null, city: clean(c.city, 100) || null, address: clean(c.address, 300) || null,
            phone: clean(c.phone, 200) || null, email: email || null, website: clean(c.website, 300) || null, license: clean(c.license, 200) || null};
        if(logo) row.logo = logo;     // пустой логотип не затирает уже сохранённый
        const cols = Object.keys(row);
        const ex = (await db.query(`SELECT id FROM crewings WHERE source = $1 AND external_id = $2`, [source, ext]))[0];
        if(ex){
            await db.query(`UPDATE crewings SET ${cols.map((k, i) => `${k} = $${i + 1}`).join(", ")}, updated_at = $${cols.length + 1} WHERE id = $${cols.length + 2}`,
                [...cols.map(k => row[k]), now(), ex.id]);
            updated++;
        }else{
            await db.query(`INSERT INTO crewings(id, source, external_id, ${cols.join(", ")}, created_at, updated_at)
                VALUES(${[...Array(cols.length + 5)].map((_, i) => "$" + (i + 1)).join(", ")})`,
                [uuid(), source, ext, ...cols.map(k => row[k]), now(), now()]);
            created++;
        }
    }
    console.log(`🏢 Крюинги: новых ${created}, обновлено ${updated}`);
    json(res, 200, {ok: true, created, updated});
});
/* E-mail компаний каталога по их номеру в источнике (парсер вакансий crewell берёт контакт отсюда) */
route("GET", "/api/import/crewings/contacts", async (req, res) => {
    if(!checkImportToken(req)) return fail(res, 403, "forbidden");
    const source = String(new URL(req.url, "http://x").searchParams.get("source") || "crewell").toLowerCase();
    const rows = await db.query(`SELECT external_id, name, email FROM crewings WHERE source = $1 AND email IS NOT NULL AND email <> ''`, [source]);
    const contacts = {};
    for(const r of rows){
        const emails = String(r.email).split(/[,;\s]+/).filter(e => isEmail(e.toLowerCase()));
        // для вакансий — корпоративная почта, если есть
        const best = emails.find(e => isCorporateEmail(e)) || emails[0];
        if(best) contacts[r.external_id] = {email: best.toLowerCase(), name: r.name || ""};
    }
    json(res, 200, {contacts});
});
/* Очередь сообщений для бота @Cvsendler_bot: парсер без своего Telegram кладёт сюда,
   Telegram-парсер (у него есть аккаунт) забирает и отправляет в бот */
route("POST", "/api/import/bot-outbox", async (req, res, {body}) => {
    if(!checkImportToken(req)) return fail(res, 403, "forbidden");
    const text = String(body.text || "").slice(0, 4000).trim();
    if(!text) return fail(res, 400, "text");
    await db.query(`INSERT INTO bot_outbox(id, text, source, created_at) VALUES($1, $2, $3, $4)`, [uuid(), text, clean(body.source, 40) || null, now()]);
    json(res, 200, {ok: true});
});
route("POST", "/api/import/bot-outbox/take", async (req, res, {body}) => {
    if(!checkImportToken(req)) return fail(res, 403, "forbidden");
    const limit = Math.min(Math.max(parseInt(body.limit, 10) || 20, 1), 50);
    const rows = await db.query(`SELECT id, text FROM bot_outbox WHERE taken_at IS NULL ORDER BY created_at LIMIT ${limit}`);
    for(const r of rows) await db.query(`UPDATE bot_outbox SET taken_at = $1 WHERE id = $2`, [now(), r.id]);
    // старое (отправленное больше 30 дней назад) чистим
    await db.query(`DELETE FROM bot_outbox WHERE taken_at IS NOT NULL AND taken_at < $1`, [isoDaysAgo(30)]);
    json(res, 200, {items: rows.map(r => r.text)});
});
/* Какие компании уже собраны за последние 7 дней — чтобы после перезапуска парсер продолжил, а не начал с нуля */
route("GET", "/api/import/crewings/known", async (req, res) => {
    if(!checkImportToken(req)) return fail(res, 403, "forbidden");
    const source = String(new URL(req.url, "http://x").searchParams.get("source") || "ukrcrewing").toLowerCase();
    const rows = await db.query(`SELECT external_id FROM crewings WHERE updated_at >= $1 AND source = $2`, [isoDaysAgo(7), source]);
    json(res, 200, {known: rows.map(r => r.external_id)});
});
/* =========================================================
   ЛОГОТИПЫ КОМПАНИЙ И СБОР КОМПАНИЙ ИЗ ВАКАНСИЙ
========================================================= */
function validLogo(v){
    const m = String(v || "").match(/^data:image\/(png|jpeg|webp|gif|x-icon|vnd\.microsoft\.icon);base64,([A-Za-z0-9+\/]+=*)$/);
    if(!m) return null;
    const len = Math.floor(m[2].length * 3 / 4);
    return len > 200 && len <= 300 * 1024 ? String(v) : null;
}
route("GET", /^\/api\/crewing-logo\/([\w-]+)$/, async (req, res, {params}) => {
    const r = (await db.query(`SELECT logo FROM crewings WHERE id = $1`, [params[0]]))[0];
    const m = String(r?.logo || "").match(/^data:([\w\/.+-]+);base64,(.+)$/);
    if(!m) return notFound(res);
    const buf = Buffer.from(m[2], "base64");
    res.writeHead(200, {...SECURITY_HEADERS, "Content-Type": m[1], "Content-Length": buf.length, "Cache-Control": "public, max-age=604800"});
    res.end(buf);
});
/* Логотип по домену сайта компании: сервис иконок Google (128 px). Стандартный «глобус» (иконки нет) — не берём */
let DEFAULT_ICON_HASH = null;
async function fetchBuf(url, ms = 8000){
    const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), ms);
    try{
        const r = await fetch(url, {signal: ctl.signal, redirect: "follow", headers: {"User-Agent": "Mozilla/5.0 WayAtSea-LogoBot"}});
        if(!r.ok) return null;
        const type = (r.headers.get("content-type") || "").split(";")[0].trim();
        const buf = Buffer.from(await r.arrayBuffer());
        return {type, buf};
    }catch(e){ return null; } finally { clearTimeout(tm); }
}
async function logoForDomain(domain){
    domain = String(domain || "").toLowerCase().replace(/^www\./, "");
    if(!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) return null;
    const g = d => `https://www.google.com/s2/favicons?domain=${encodeURIComponent(d)}&sz=128`;
    if(DEFAULT_ICON_HASH === null){
        const d = await fetchBuf(g("no-such-domain-wayatsea-check.invalid"));
        DEFAULT_ICON_HASH = d ? sha256(d.buf.toString("base64")) : "";
    }
    const r = await fetchBuf(g(domain));
    if(!r || !r.buf.length || r.buf.length > 300 * 1024 || !/^image\//.test(r.type)) return null;
    if(sha256(r.buf.toString("base64")) === DEFAULT_ICON_HASH) return null;
    // слишком маленькая картинка — скорее всего пустая иконка 16 px
    if(r.buf.length < 400) return null;
    return `data:${r.type === "image/x-icon" ? "image/png" : r.type};base64,${r.buf.toString("base64")}`;
}
const siteDomain = w => String(w || "").toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[\/?#:]/)[0];

/* Страна по коду телефона и по домену почты; город — по названиям морских городов в тексте вакансий */
const PHONE_COUNTRY = [["+380","Ukraine"],["+40","Romania"],["+359","Bulgaria"],["+30","Greece"],["+357","Cyprus"],["+356","Malta"],["+31","Netherlands"],
    ["+49","Germany"],["+44","United Kingdom"],["+48","Poland"],["+90","Turkey"],["+971","United Arab Emirates"],["+65","Singapore"],["+63","Philippines"],
    ["+91","India"],["+45","Denmark"],["+47","Norway"],["+46","Sweden"],["+33","France"],["+39","Italy"],["+34","Spain"],["+385","Croatia"],["+371","Latvia"],
    ["+370","Lithuania"],["+372","Estonia"],["+995","Georgia"],["+373","Moldova"],["+7","Russia"],["+1","United States"],["+86","China"],["+852","Hong Kong"],
    ["+60","Malaysia"],["+62","Indonesia"],["+66","Thailand"],["+84","Vietnam"],["+82","South Korea"],["+81","Japan"],["+20","Egypt"],["+966","Saudi Arabia"],
    ["+974","Qatar"],["+973","Bahrain"],["+968","Oman"],["+965","Kuwait"],["+351","Portugal"],["+32","Belgium"],["+41","Switzerland"],["+358","Finland"],["+353","Ireland"]];
const TLD_COUNTRY = {ua:"Ukraine",ro:"Romania",bg:"Bulgaria",gr:"Greece",cy:"Cyprus",mt:"Malta",nl:"Netherlands",de:"Germany",uk:"United Kingdom",pl:"Poland",
    tr:"Turkey",ae:"United Arab Emirates",sg:"Singapore",ph:"Philippines",in:"India",dk:"Denmark",no:"Norway",se:"Sweden",fr:"France",it:"Italy",es:"Spain",
    hr:"Croatia",lv:"Latvia",lt:"Lithuania",ee:"Estonia",ge:"Georgia",md:"Moldova",cn:"China",hk:"Hong Kong",my:"Malaysia",id:"Indonesia",th:"Thailand",
    vn:"Vietnam",kr:"South Korea",jp:"Japan",eg:"Egypt",sa:"Saudi Arabia",qa:"Qatar",pt:"Portugal",be:"Belgium",ch:"Switzerland",fi:"Finland",ie:"Ireland"};
const CITY_RE = /\b(Odesa|Odessa|Kherson|Mykolaiv|Nikolaev|Izmail|Chornomorsk|Constan[tț]a|Galati|Varna|Burgas|Limassol|Larnaca|Piraeus|Athens|Glyfada|Valletta|Rotterdam|Amsterdam|Hamburg|Bremen|Gdynia|Gdansk|Szczecin|Riga|Klaipeda|Tallinn|Istanbul|Tuzla|Dubai|Abu Dhabi|Singapore|Manila|Cebu|Mumbai|Chennai|Kolkata|Copenhagen|Esbjerg|Oslo|Bergen|Stavanger|Aberdeen|London|Glasgow|Southampton|Genoa|Naples|Trieste|Batumi|Novorossiysk|St\.? Petersburg|Antwerp|Le Havre|Marseille|Lisbon|Hong Kong|Shanghai|Busan|Tokyo|Jakarta|Kuala Lumpur|Houston|Monaco)\b/i;
function guessCountry(phone, email){
    const p = String(phone || "").replace(/[^\d+]/g, "");
    for(const [pre, c] of [...PHONE_COUNTRY].sort((a, b) => b[0].length - a[0].length)) if(p.startsWith(pre)) return c;
    const tld = String(email || "").toLowerCase().split(".").pop();
    return TLD_COUNTRY[tld] || "";
}
/* Компании из вакансий: группируем по домену корпоративной почты */
async function companiesFromVacancies(){
    const rows = await db.query(`SELECT email, company, phone, info, published FROM vacancies WHERE email IS NOT NULL AND published >= $1`, [isoDaysAgo(365)]);
    const known = new Set();
    for(const r of await db.query(`SELECT email, website FROM crewings`)){
        String(r.email || "").split(/[,;\s]+/).forEach(e => { if(e.includes("@")) known.add(e.split("@")[1].toLowerCase()); });
        if(r.website) known.add(siteDomain(r.website));
    }
    for(const u of await db.query(`SELECT email FROM users WHERE role = 'crewing'`)) known.add(String(u.email).split("@")[1].toLowerCase());
    const groups = new Map();
    for(const r of rows){
        const email = String(r.email || "").toLowerCase();
        if(!email.includes("@") || !isCorporateEmail(email)) continue;
        const domain = email.split("@")[1];
        const g = groups.get(domain) || {domain, emails: new Map(), names: new Map(), phones: new Map(), cities: new Map(), count: 0, last: ""};
        g.count++; if(String(r.published) > g.last) g.last = String(r.published);
        g.emails.set(email, (g.emails.get(email) || 0) + 1);
        const name = await companyFor({company: r.company, info: r.info, email});
        if(name) g.names.set(name, (g.names.get(name) || 0) + (r.company ? 3 : 1));
        const ph = String(r.phone || "").trim() || ((String(r.info || "").match(/\+\d[\d\s().-]{7,}\d/) || [])[0] || "");
        if(ph) g.phones.set(ph.replace(/\s+/g, " "), (g.phones.get(ph) || 0) + 1);
        const city = (String(r.info || "").match(CITY_RE) || [])[0];
        if(city) g.cities.set(city, (g.cities.get(city) || 0) + 1);
        groups.set(domain, g);
    }
    const top = m => [...m.entries()].sort((a, b) => b[1] - a[1]).map(x => x[0]);
    const site = d => d.replace(/^(mail|email|crew|crewing|hr|jobs|careers|recruitment|manning)\./, "");
    return [...groups.values()].map(g => {
        const phone = top(g.phones)[0] || "";
        return {domain: g.domain, name: top(g.names)[0] || companyFromDomain(g.domain), email: top(g.emails).slice(0, 3).join(", "), phone,
            website: site(g.domain), country: guessCountry(phone, g.domain), city: top(g.cities)[0] || "", vacancies: g.count, last: g.last,
            inCatalog: known.has(g.domain) || known.has(site(g.domain))};
    }).sort((a, b) => Number(a.inCatalog) - Number(b.inCatalog) || b.vacancies - a.vacancies);
}
const csvCell = v => { let t = String(v ?? ""); if(/^[=@\t\r]|^[+\-](?![\d\s(])/.test(t)) t = "'" + t; return '"' + t.replace(/"/g, '""') + '"'; };
route("GET", "/api/admin/companies-from-vacancies.csv", async (req, res, {user}) => {
    if(!adminOnly(user)) return fail(res, 403, "forbidden");
    // только НОВЫЕ компании (которых ещё нет в каталоге «Работодатели»), 5 колонок
    const list = (await companiesFromVacancies()).filter(c => !c.inCatalog && c.name);
    const head = ["Название", "Страна", "Город", "Телефон", "Имейл"];
    const csv = "﻿" + [head, ...list.map(c => [c.name, c.country, c.city, c.phone, c.email])]
        .map(r => r.map(csvCell).join(";")).join("\r\n");
    res.writeHead(200, {...SECURITY_HEADERS, "Content-Type": "text/csv; charset=utf-8", "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="new-companies-${now().slice(0, 10)}.csv"`});
    res.end(csv);
});
/* Добавить новые компании из вакансий в каталог (источник «vacancies»), затем в фоне подтянуть логотипы */
let LOGO_JOB = null;
async function runLogoJob(onlyIds){
    if(LOGO_JOB) return LOGO_JOB;
    LOGO_JOB = (async () => {
        const rows = await db.query(`SELECT id, email, website FROM crewings WHERE (logo IS NULL OR logo = '')`);
        let found = 0, checked = 0;
        for(const r of rows){
            if(onlyIds && !onlyIds.has(r.id)) continue;
            const domain = siteDomain(r.website) || String(r.email || "").split(/[,;\s]+/).find(e => e.includes("@"))?.split("@")[1];
            if(!domain || !isCorporateEmail("x@" + domain)) continue;
            checked++;
            const logo = await logoForDomain(domain.replace(/^(mail|email|crew|crewing|hr|jobs|careers|recruitment|manning)\./, ""));
            if(logo){ await db.query(`UPDATE crewings SET logo = $1, updated_at = $2 WHERE id = $3`, [logo, now(), r.id]); found++; }
            await new Promise(ok => setTimeout(ok, 300));
        }
        console.log(`🖼 Логотипы: проверено ${checked}, найдено ${found}`);
        return {checked, found};
    })().finally(() => { setTimeout(() => { LOGO_JOB = null; }, 1000); });
    return LOGO_JOB;
}
route("POST", "/api/admin/companies-from-vacancies/import", async (req, res, {user}) => {
    if(!adminOnly(user)) return fail(res, 403, "forbidden");
    const list = (await companiesFromVacancies()).filter(c => !c.inCatalog && c.name);
    const ids = new Set();
    for(const c of list){
        const ex = (await db.query(`SELECT id FROM crewings WHERE source = 'vacancies' AND external_id = $1`, [c.domain]))[0];
        if(ex) continue;
        const id = uuid(); ids.add(id);
        await db.query(`INSERT INTO crewings(id, source, external_id, url, name, country, city, address, phone, email, website, license, created_at, updated_at)
            VALUES($1,'vacancies',$2,NULL,$3,$4,$5,NULL,$6,$7,$8,NULL,$9,$10)`,
            [id, c.domain, c.name, c.country || null, c.city || null, c.phone || null, c.email, c.website, now(), now()]);
    }
    companyDomainMap = null;
    console.log(`🏢 Компании из вакансий добавлены в каталог: ${ids.size}`);
    if(ids.size) runLogoJob(ids).catch(e => console.error("❌ Логотипы:", e.message));
    json(res, 200, {ok: true, added: ids.size});
});
/* Загрузка списка компаний (CSV из админки, после проверки/дополнения) в каталог «Работодатели» */
route("POST", "/api/admin/crewings/upload", async (req, res, {user, body}) => {
    if(!adminOnly(user)) return fail(res, 403, "forbidden");
    const rows = Array.isArray(body.rows) ? body.rows.slice(0, 2000) : [];
    let created = 0, updated = 0, skipped = 0;
    const ids = new Set();
    for(const r of rows){
        const name = clean(r.name, 200);
        const emails = (String(r.email || "").match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || []).map(e => e.toLowerCase());
        if(!name || !emails.length){ skipped++; continue; }
        const domain = emails[0].split("@")[1];
        const fields = {name, country: clean(r.country, 100) || null, city: clean(r.city, 100) || null, phone: clean(r.phone, 200) || null,
                        email: emails.slice(0, 3).join(", "), website: clean(r.website, 300) || siteDomain(domain)};
        const cols = Object.keys(fields);
        const ex = (await db.query(`SELECT id FROM crewings WHERE source = 'vacancies' AND external_id = $1`, [domain]))[0];
        if(ex){
            await db.query(`UPDATE crewings SET ${cols.map((k, i) => `${k} = $${i + 1}`).join(", ")}, updated_at = $${cols.length + 1} WHERE id = $${cols.length + 2}`,
                [...cols.map(k => fields[k]), now(), ex.id]);
            updated++; ids.add(ex.id);
        }else{
            const id = uuid();
            await db.query(`INSERT INTO crewings(id, source, external_id, ${cols.join(", ")}, created_at, updated_at)
                VALUES($1, 'vacancies', $2, ${cols.map((_, i) => "$" + (i + 3)).join(", ")}, $${cols.length + 3}, $${cols.length + 4})`,
                [id, domain, ...cols.map(k => fields[k]), now(), now()]);
            created++; ids.add(id);
        }
    }
    companyDomainMap = null;
    console.log(`🏢 Список компаний загружен: новых ${created}, обновлено ${updated}, пропущено ${skipped}`);
    if(ids.size) runLogoJob(ids).catch(e => console.error("❌ Логотипы:", e.message));
    json(res, 200, {ok: true, created, updated, skipped});
});
/* Контакты с сайтов компаний: у кого есть сайт, но нет e-mail/телефона (например, компании с crewell без входа).
   Смотрим главную и страницы «Контакты», берём e-mail (лучше с домена компании) и телефоны. */
let CONTACT_JOB = null;
const CONTACT_PATHS = ["", "/contact", "/contacts", "/contact-us", "/contactus", "/kontakty", "/kontakti", "/ru/contacts", "/en/contact", "/uk/contacts", "/about"];
async function fetchHtml(url){
    const r = await fetchBuf(url, 10000);
    if(!r || !/html|text/.test(r.type) || r.buf.length > 3 * 1024 * 1024) return "";
    return r.buf.toString("utf8");
}
function contactsFromHtml(html, domain){
    const text = String(html || "").replace(/&#64;|&commat;|\s*\[at\]\s*|\s*\(at\)\s*/gi, "@").replace(/&#46;|\s*\[dot\]\s*|\s*\(dot\)\s*/gi, ".");
    const emails = [...new Set((text.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) || []).map(e => e.toLowerCase().replace(/\.$/, "")))]
        .filter(e => !/\.(png|jpe?g|gif|webp|svg|css|js)$/.test(e) && !/^(noreply|no-reply|example|test|user|name|email|your|wordpress|admin@example)/.test(e)
            && !/(sentry|wixpress|example\.com|domain\.com|crewell|godaddy|cloudflare)/.test(e));
    const own = emails.filter(e => e.split("@")[1].replace(/^(mail|crew|hr)\./, "").endsWith(domain));
    const tel = [...String(html).matchAll(/href=["']tel:([^"']+)["']/gi)].map(m => decodeURIComponent(m[1]).replace(/[^\d+()\s-]/g, "").trim());
    const plain = (text.replace(/<[^>]+>/g, " ").match(/\+\d[\d\s().-]{8,}\d/g) || []).map(p => p.replace(/\s+/g, " ").trim());
    const phones = [...new Set([...tel, ...plain].filter(p => p.replace(/\D/g, "").length >= 9 && p.replace(/\D/g, "").length <= 15))];
    return {emails: own.length ? own : emails, phones};
}
async function runContactJob(){
    if(CONTACT_JOB) return CONTACT_JOB;
    CONTACT_JOB = (async () => {
        const rows = await db.query(`SELECT id, website, email, phone FROM crewings WHERE website IS NOT NULL AND website <> '' AND (email IS NULL OR email = '' OR phone IS NULL OR phone = '')`);
        let checked = 0, found = 0;
        for(const r of rows){
            const domain = siteDomain(r.website);
            // только обычные домены: без IP-адресов и внутренних имён
            if(!domain || !/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(domain) || /(^|\.)(localhost|internal|local|railway)$/.test(domain)) continue;
            checked++;
            const base = (/^http:\/\//i.test(r.website) ? "http://" : "https://") + (/^www\./i.test(String(r.website).replace(/^https?:\/\//i, "")) ? "www." : "") + domain;
            let emails = [], phones = [];
            for(const p of CONTACT_PATHS){
                const html = await fetchHtml(base + p);
                if(!html) { if(p === "") break; else continue; }
                const c = contactsFromHtml(html, domain);
                emails = [...new Set([...emails, ...c.emails])]; phones = [...new Set([...phones, ...c.phones])];
                if(emails.some(e => e.endsWith(domain)) && phones.length) break;
                await new Promise(ok => setTimeout(ok, 300));
            }
            const set = {};
            if(!r.email && emails.length) set.email = emails.slice(0, 3).join(", ");
            if(!r.phone && phones.length) set.phone = phones.slice(0, 3).join(", ");
            const cols = Object.keys(set);
            if(cols.length){
                await db.query(`UPDATE crewings SET ${cols.map((k, i) => `${k} = $${i + 1}`).join(", ")}, updated_at = $${cols.length + 1} WHERE id = $${cols.length + 2}`,
                    [...cols.map(k => set[k]), now(), r.id]);
                found++;
            }
            if(checked % 25 === 0) console.log(`📇 Контакты: проверено ${checked}/${rows.length}, найдено ${found}`);
        }
        console.log(`📇 Контакты с сайтов: проверено ${checked}, дополнено ${found}`);
        return {checked, found};
    })().finally(() => { setTimeout(() => { CONTACT_JOB = null; }, 1000); });
    return CONTACT_JOB;
}
route("POST", "/api/admin/crewings/contacts", async (req, res, {user}) => {
    if(!adminOnly(user)) return fail(res, 403, "forbidden");
    const busy = !!CONTACT_JOB;
    runContactJob().catch(e => console.error("❌ Контакты:", e.message));
    json(res, 200, {ok: true, started: !busy});
});
route("POST", "/api/admin/crewings/logos", async (req, res, {user}) => {
    if(!adminOnly(user)) return fail(res, 403, "forbidden");
    const busy = !!LOGO_JOB;
    runLogoJob().catch(e => console.error("❌ Логотипы:", e.message));
    json(res, 200, {ok: true, started: !busy});
});

/* Список компаний для страницы «Работодатели». Контакты — только вошедшим с подтверждённым e-mail */
const validSite = w => { const t = String(w || "").trim(); return /^(https?:\/\/)?(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(t) ? t : null; };
route("GET", "/api/companies", async (req, res, {user}) => {
    const full = !!user && !!user.email_verified;
    const rows = await db.query(`SELECT id, name, country, city, address, phone, email, website, license, updated_at,
        CASE WHEN logo IS NULL OR logo = '' THEN 0 ELSE 1 END AS has_logo FROM crewings WHERE name IS NOT NULL ORDER BY name LIMIT 5000`);
    const companies = [], seen = new Set();
    const nameKey = n => String(n || "").toLowerCase().replace(/[^a-z0-9а-яё]/gi, "").replace(/(llc|ltd|srl|sa|inc|co|limited|gmbh|ооо|тов)$/g, "");
    // компании, зарегистрированные на сайте и одобренные администратором, — появляются в каталоге автоматически
    const registered = await db.query(`SELECT u.id, u.email, u.name, u.company_name, u.phone_code, u.phone, p.data FROM users u
        LEFT JOIN profiles p ON p.user_id = u.id WHERE u.role = 'crewing' AND u.approved = 1 AND u.blocked = 0 AND u.email_verified = 1`);
    for(const u of registered){
        let p = {}; try { p = JSON.parse(u.data || "{}"); } catch(e){}
        const name = p.companyName || u.company_name || u.name;
        const key = nameKey(name);
        if(!name || seen.has(key)) continue;
        seen.add(key);
        const c = {id: "u-" + u.id, name, country: p.country || "", city: p.city || "", license: p.license || "", registered: true,
                   logo: p.logo ? `/api/company-logo/${u.id}?v=${p.logoV || 1}` : ""};
        if(full) Object.assign(c, {address: "", phone: p.companyPhone || [u.phone_code, u.phone].filter(Boolean).join(" "),
            email: p.contactEmail || u.email, website: validSite(p.website), description: p.description || ""});
        companies.push(c);
    }
    for(const r of rows){
        // одна и та же компания с разных сайтов (UkrCrewing, Crewlink) — показываем один раз
        const key = nameKey(r.name);
        if(seen.has(key)) continue;
        // Показываем только компании с корпоративной почтой (без e-mail или только Gmail/Ukr.net и т.п. — скрываем)
        const emails = (String(r.email || "").match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || []).filter(isCorporateEmail);
        if(!emails.length) continue;
        seen.add(key);
        const c = {id: r.id, name: r.name, country: r.country, city: r.city, license: r.license,
                   logo: Number(r.has_logo) ? `/api/crewing-logo/${r.id}?v=${encodeURIComponent(String(r.updated_at || "").slice(0, 19))}` : ""};
        if(full) Object.assign(c, {address: r.address, phone: r.phone, email: emails.join(", "), website: validSite(r.website)});
        companies.push(c);
    }
    // случайный порядок карточек при каждом открытии
    for(let i = companies.length - 1; i > 0; i--){
        const j = Math.floor(Math.random() * (i + 1));
        [companies[i], companies[j]] = [companies[j], companies[i]];
    }
    json(res, 200, {full, companies});
});
/* Скачать все крюинги одним файлом (открывается в Excel / Google Таблицах) */
route("GET", "/api/admin/crewings.csv", async (req, res, {user}) => {
    if(!adminOnly(user)) return fail(res, 403, "forbidden");
    const rows = await db.query(`SELECT name, country, city, address, phone, email, website, license, url FROM crewings ORDER BY name`);
    const head = ["Название", "Страна", "Город", "Адрес", "Телефон", "E-mail", "Сайт", "Лицензия", "Ссылка"];
    const cell = v => {
        let t = String(v ?? "");
        if(/^[=@\t\r]|^[+\-](?![\d\s(])/.test(t)) t = "'" + t;   // защита от формул в Excel (телефоны +38… не трогаем)
        return '"' + t.replace(/"/g, '""') + '"';
    };
    const csv = "\ufeff" + [head, ...rows.map(r => [r.name, r.country, r.city, r.address, r.phone, r.email, r.website, r.license, r.url])]
        .map(r => r.map(cell).join(";")).join("\r\n");
    res.writeHead(200, {...SECURITY_HEADERS, "Content-Type": "text/csv; charset=utf-8", "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="crewings-${now().slice(0, 10)}.csv"`});
    res.end(csv);
});
route("GET", "/api/admin/stats", async (req, res, {user}) => {
    if(!adminOnly(user)) return fail(res, 403, "forbidden");
    const one = async sql => Number((await db.query(sql))[0]?.c || 0);
    json(res, 200, {
        seafarers: await one(`SELECT COUNT(*) AS c FROM users WHERE role = 'seafarer'`),
        complete: await one(`SELECT COUNT(*) AS c FROM profiles WHERE complete = 1`),
        companies: await one(`SELECT COUNT(*) AS c FROM users WHERE role = 'crewing'`),
        pending: await one(`SELECT COUNT(*) AS c FROM users WHERE role = 'crewing' AND approved = 0 AND blocked = 0`),
        crewings: await one(`SELECT COUNT(*) AS c FROM crewings`),
        moderation: await one(`SELECT COUNT(*) AS c FROM vacancies WHERE status = 'pending'`),
        vacancies: await one(`SELECT COUNT(*) AS c FROM vacancies WHERE hidden = 0 AND ((join_date IS NOT NULL AND join_date >= '${isoDaysAgo(EXPIRED_KEEP_DAYS)}') OR (join_date IS NULL AND published >= '${isoDaysAgo(NO_DATE_KEEP_DAYS)}'))`)
    });
});

/* =========================================================
   СТАТИЧЕСКИЕ ФАЙЛЫ САЙТА
========================================================= */
const MIME = {".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".svg": "image/svg+xml", ".webp": "image/webp",
    ".ico": "image/x-icon", ".xml": "application/xml; charset=utf-8", ".txt": "text/plain; charset=utf-8"};
const PRIVATE = new Set(["server.js", "cvparse.js", "pdfgen.js", "package.json", "package-lock.json", "local.db", ".env", "railway.json", "Caddyfile", "README.md"]);
function serveStatic(req, res, urlPath){
    let p = decodeURIComponent(urlPath);
    if(p.includes("\0") || p.split("/").some(s => s.startsWith("."))) return notFound(res);
    if(p === "/") p = "/index.html";
    const candidates = [p, p + ".html", p.replace(/\/$/, "") + "/index.html"];
    for(const c of candidates){
        const rel = c.replace(/^\/+/, "");
        if(!rel || PRIVATE.has(rel) || rel.startsWith("node_modules")) continue;
        const ext = path.extname(rel).toLowerCase();
        if(!MIME[ext]) continue;
        const file = path.join(ROOT, rel);
        if(!file.startsWith(ROOT + path.sep)) continue;
        try{
            const st = fs.statSync(file);
            if(!st.isFile()) continue;
            // html/js/css — всегда проверять свежую версию (после обновления сайта посетители сразу видят изменения)
            const cache = [".html", ".js", ".css"].includes(ext) ? "no-cache" : "public, max-age=3600";
            res.writeHead(200, {...SECURITY_HEADERS, "Content-Type": MIME[ext], "Content-Length": st.size, "Cache-Control": cache});
            if(req.method === "HEAD") return res.end();
            return fs.createReadStream(file).pipe(res);
        }catch(e){ /* следующий вариант */ }
    }
    notFound(res);
}
function notFound(res){
    const file = path.join(ROOT, "404.html");
    if(fs.existsSync(file)){
        res.writeHead(404, {...SECURITY_HEADERS, "Content-Type": MIME[".html"]});
        return fs.createReadStream(file).pipe(res);
    }
    send(res, 404, "Not found");
}

/* =========================================================
   ЗАПУСК
========================================================= */
const server = http.createServer(async (req, res) => {
    if(isHttps(req)) res.setHeader("Strict-Transport-Security", HSTS["Strict-Transport-Security"]);
    try{
        const url = new URL(req.url, "http://localhost");
        // Реальный IP — последний адрес в X-Forwarded-For (его добавляет прокси Railway; первые клиент может подделать)
        const xff = String(req.headers["x-forwarded-for"] || "").split(",").map(x => x.trim()).filter(Boolean);
        const ip = xff.length ? xff[xff.length - 1] : (req.socket.remoteAddress || "");
        if(url.pathname.startsWith("/api/")){
            // защита от подделки запросов с чужих сайтов
            if(req.method !== "GET"){
                const origin = req.headers.origin;
                if(origin && new URL(origin).host !== req.headers.host) return fail(res, 403, "badOrigin");
                if(!/application\/json/.test(req.headers["content-type"] || "")) return fail(res, 415, "jsonOnly");
            }
            for(const r of routes){
                if(r.method !== req.method) continue;
                const m = typeof r.pattern === "string" ? (r.pattern === url.pathname ? [] : null) : url.pathname.match(r.pattern);
                if(!m) continue;
                const body = ["POST", "PUT", "DELETE"].includes(req.method) ? await readBody(req, r.maxBody) : {};
                const user = await currentUser(req);
                return await r.handler(req, res, {body, user, ip, query: url.searchParams, params: Array.isArray(m) ? m.slice(1) : []});
            }
            return fail(res, 404, "notFound");
        }
        if(req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Method not allowed");
        // страница профиля моряка — та же страница «Моряки», скрипт сам покажет профиль
        if(/^\/seaman\/[\w-]+\/?$/.test(url.pathname)) return serveStatic(req, res, "/seamans");
        // правовые страницы: та же страница, что «Политика конфиденциальности», текст подставляет legal.js
        if(/^\/(terms|cookies)\/?$/.test(url.pathname)) return serveStatic(req, res, "/privacy");
        serveStatic(req, res, url.pathname);
    }catch(e){
        console.error(e);
        if(!res.headersSent) fail(res, e.status || 500, e.status ? e.message : "server");
    }
});
/* Разделение «Tanker/Gas Fleet» на «Tanker Fleet» и «Gas Fleet» (один раз, затем ничего не находит) */
async function migrateFleets(){
    const vac = await db.query(`SELECT id, vessel_type, title, info FROM vacancies WHERE fleet = 'Tanker/Gas Fleet'`);
    for(const v of vac){
        const f = detectFleet(v.vessel_type, `${v.title || ""} ${v.info || ""}`, "Tanker/Gas Fleet");
        await db.query(`UPDATE vacancies SET fleet = $1 WHERE id = $2`, [f, v.id]);
    }
    const profs = await db.query(`SELECT user_id, data FROM profiles WHERE data LIKE '%Tanker/Gas Fleet%'`);
    let moved = 0;
    for(const r of profs){
        let p; try { p = JSON.parse(r.data); } catch(e){ continue; }
        const hint = `${p.vesselType || ""} ${(p.experience || []).map(e => e.vesselType || "").join(" ")}`;
        if(p.fleetType !== "Tanker/Gas Fleet") continue;   // подписка «Tanker/Gas Fleet» получает оба флота (см. alertMatches)
        p.fleetType = splitTankerGas(p.fleetType, hint);
        moved++;
        await db.query(`UPDATE profiles SET data = $1 WHERE user_id = $2`, [JSON.stringify(p), r.user_id]);
    }
    if(vac.length || moved) console.log(`⚓ Флоты: разделено Tanker/Gas → Tanker / Gas: вакансий ${vac.length}, профилей ${moved}`);
}

initDb().then(async () => {
    try { await migrateFleets(); } catch(e){ console.error("❌ Миграция флотов:", e.message); }
    server.listen(PORT, () => console.log(`Way At Sea запущен на порту ${PORT}`));
    // рассылка вакансий подписчикам — проверяем каждые 5 минут, отправляется в 10:00 и 15:00 (Лондон), не чаще
    setInterval(() => sendVacancyDigest().catch(e => console.error("❌ Рассылка вакансий:", e.message)), 5 * 60_000);
    setTimeout(() => sendVacancyDigest().catch(e => console.error("❌ Рассылка вакансий:", e.message)), 30_000);
    // очистка просроченных сессий раз в сутки
    setInterval(() => {
        db.query(`DELETE FROM sessions WHERE expires < $1`, [Date.now()]).catch(() => {});
    }, 864e5).unref();
    // удаление устаревших вакансий — через минуту после запуска и затем каждый час
    const cleanup = () => cleanupVacancies().catch(e => console.error("❌ Очистка вакансий:", e.message));
    setTimeout(cleanup, 60_000);
    setInterval(cleanup, 60 * 60_000).unref();
}).catch(e => { console.error("Ошибка базы данных:", e); process.exit(1); });
