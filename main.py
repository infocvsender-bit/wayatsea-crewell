print("=== CREWELL VACANCIES FILE LOADED ===", flush=True)

# ============================================================
# ПАРСЕР ВАКАНСИЙ CREWELL.NET → сайт Way At Sea → бот @Cvsendler_bot
#
#  • Вакансии crewell открыты без входа, контактов в них нет.
#  • Контакт (e-mail) берём из НАШЕГО каталога компаний: компания crewell
#    с тем же номером, что в ссылке /companies/ID/.
#  • У компании нет e-mail → вакансию не собираем и не публикуем.
#  • Берём ТОЛЬКО вакансии, опубликованные сегодня (по Лондону).
#  • Сначала сайт (он решает: новая / дубль / мусор), новые — в бот.
#    Своего Telegram у этого парсера нет: сообщение кладём в очередь на сайте,
#    его забирает и отправляет в бот Telegram-парсер.
#
# Переменные Railway:
#   SITE_IMPORT_URL    https://www.wayatsea.com/api/import/vacancies
#   SITE_IMPORT_TOKEN  тот же ключ, что IMPORT_TOKEN на сайте
#   SITE_ONLY=1        (необязательно) только сайт, без бота
#   MAX_PAGES=40       (необязательно) сколько страниц списка смотреть максимум
#   SCHEDULE=10:00,12:00,14:00,16:00  (необязательно) когда проверять, по Лондону
# ============================================================

import asyncio
import json
import os
import re
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta
from pathlib import Path

from playwright.async_api import async_playwright

BASE = "https://crewell.net"

SITE_IMPORT_URL = os.getenv("SITE_IMPORT_URL")
SITE_IMPORT_TOKEN = os.getenv("SITE_IMPORT_TOKEN")
SITE_ONLY = os.getenv("SITE_ONLY", "").lower() in ("1", "true", "yes")
MAX_PAGES = int(os.getenv("MAX_PAGES", "40") or 40)
SCAN_EVERY_MIN = int(os.getenv("SCAN_EVERY_MIN", "60") or 60)
WORK_HOURS = (7, 21)   # по Лондону: ночью не сканируем

SENT_FILE = Path(os.getenv("SENT_FILE", "crewell_sent.json"))

USER_AGENT = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")


def log(msg=""):
    print(msg, flush=True)


def london_now():
    try:
        from zoneinfo import ZoneInfo
        return datetime.now(ZoneInfo("Europe/London"))
    except Exception:
        return datetime.now()


# ------------------------------------------------------------
# ПАМЯТЬ
# ------------------------------------------------------------

def load_sent():
    try:
        return set(json.loads(SENT_FILE.read_text(encoding="utf-8")))
    except Exception:
        return set()


def save_sent(sent):
    try:
        SENT_FILE.write_text(json.dumps(sorted(sent)[-20000:]), encoding="utf-8")
    except Exception as e:
        log(f"⚠️ Не удалось сохранить память: {e}")


# ------------------------------------------------------------
# САЙТ WAY AT SEA
# ------------------------------------------------------------

def _site(path, payload=None):
    req = urllib.request.Request(
        SITE_IMPORT_URL.replace("/api/import/vacancies", path),
        data=json.dumps(payload).encode("utf-8") if payload is not None else None,
        headers={"Content-Type": "application/json", "X-Import-Token": SITE_IMPORT_TOKEN, "User-Agent": "WayAtSea-Crewell/1.0"},
        method="POST" if payload is not None else "GET",
    )
    with urllib.request.urlopen(req, timeout=40) as r:
        return json.loads(r.read().decode("utf-8") or "{}")


async def load_contacts():
    """{номер компании crewell: {email, name}} — из каталога компаний сайта."""
    data = await asyncio.to_thread(_site, "/api/import/crewings/contacts?source=crewell")
    return data.get("contacts") or {}


async def send_to_site(job):
    """"new" / "duplicate" / "skipped" / False (сайт не ответил)."""
    payload = {
        "source": job.get("source", "crewell"),
        "external_id": job["id"],
        "region": job.get("region", ""),
        "vessel_name": job.get("vessel_name", ""),
        "phone": job.get("phone", ""),
        "url": job["url"],
        "title": job["rank"],
        "rank": job["rank"],
        "vessel_type": job["vessel_type"],
        "joining_date": job["join"],
        "duration": job["duration"],
        "salary": job["salary"],
        "email": job["email"],
        "company": job["company"],
        "info": job["info"],
        "published": london_now().strftime("%d.%m.%Y"),
    }
    try:
        data = await asyncio.to_thread(_site, "/api/import/vacancies", payload)
        res = (data.get("results") or [{}])[0]
        if res.get("ok") is False:
            log(f"❌ Сайт отклонил {job['id']}: {res.get('error')} {res.get('detail') or ''}")
            return False
        if res.get("skipped"):
            log(f"🗑 {job['id']}: сайт отклонил как мусор ({res.get('reason')}) — должность «{job.get('rank')}»")
            return "skipped"
        if res.get("duplicate"):
            log(f"♻️ {job['id']}: дубль ({res.get('reason')})")
            return "duplicate"
        log(f"🌐 {job['id']}: на сайте")
        return "new"
    except urllib.error.HTTPError as e:
        log(f"❌ Сайт: HTTP {e.code} для {job['id']}")
    except Exception as e:
        log(f"❌ Сайт: {type(e).__name__}: {e}")
    return False


BOT_PENDING = Path(os.getenv("BOT_PENDING_FILE", "bot_pending.json"))


def _pending_load():
    try:
        return json.loads(BOT_PENDING.read_text(encoding="utf-8"))
    except Exception:
        return []


def _pending_save(items):
    try:
        BOT_PENDING.write_text(json.dumps(items[-500:], ensure_ascii=False), encoding="utf-8")
    except Exception:
        pass


async def to_bot(text, source="crewell", queue_on_fail=True):
    """В бот через очередь на сайте (её отправляет Telegram-парсер). Не вышло — держим у себя и дошлём позже."""
    try:
        await asyncio.to_thread(_site, "/api/import/bot-outbox", {"text": text, "source": source})
        log("📨 В очередь бота")
        return True
    except Exception as e:
        log(f"⚠️ Очередь бота на сайте недоступна ({type(e).__name__}: {e}) — дошлю при следующей проверке")
        if queue_on_fail:
            items = _pending_load()
            items.append({"text": text, "source": source})
            _pending_save(items)
        return False


async def flush_bot_pending():
    items = _pending_load()
    if not items:
        return
    left = [it for it in items if not await to_bot(it["text"], it.get("source", "crewell"), queue_on_fail=False)]
    _pending_save(left)
    log(f"📤 Дослано в очередь бота: {len(items) - len(left)}, осталось {len(left)}")


# ------------------------------------------------------------
# РАЗБОР CREWELL
# ------------------------------------------------------------

def posted_at(text, now=None):
    """Когда опубликована: «4h 52min ago», «1d 3h ago», «2 days ago», «just now», «вчера», «07.10.2026» → datetime (Лондон) или None."""
    now = now or london_now()
    t = (text or "").lower()
    m = re.search(r"((?:\d+\s*(?:d|day|days|h|hr|hrs|hour|hours|min|mins|minute|minutes|m|s|sec|дн|день|дня|дней|ч|час|часа|часов|мин|минут|сек)\.?\s*)+)(?:ago|назад)", t)
    if m:
        delta = timedelta()
        for num, unit in re.findall(r"(\d+)\s*([a-zа-я]+)", m.group(1)):
            n = int(num)
            if unit.startswith(("d", "дн", "ден", "дня", "дне")):
                delta += timedelta(days=n)
            elif unit.startswith(("h", "ч")):
                delta += timedelta(hours=n)
            elif unit.startswith(("min", "мин")) or unit == "m":
                delta += timedelta(minutes=n)
        return now - delta
    if re.search(r"just now|только что|сейчас", t):
        return now
    if re.search(r"yesterday|вчера", t):
        return now - timedelta(days=1)
    m = re.search(r"(\d{2})\.(\d{2})\.(\d{4})(?:\s+(\d{1,2}):(\d{2}))?", t)
    if m and re.search(r"(publish|posted|опублик|added|добавлен|created)", t):
        try:
            return now.replace(year=int(m.group(3)), month=int(m.group(2)), day=int(m.group(1)), hour=int(m.group(4) or 0), minute=int(m.group(5) or 0))
        except ValueError:
            return None
    return None


def is_today(text):
    """True — опубликована сегодня (по Лондону), False — раньше, None — не удалось понять."""
    p = posted_at(text)
    if p is None:
        return None
    return p.date() == london_now().date()


LIST_JS = r"""() => {
    const out = [];
    const seen = new Set();
    for (const a of document.querySelectorAll('a[href*="/vacancies/"]')) {
        const m = (a.href || '').match(/\/vacancies\/(\d+)\/?(?:[?#].*)?$/);
        if (!m || seen.has(m[1])) continue;
        // карточка: ближайший родитель, где есть ссылка на компанию и только одна вакансия
        // карточка: САМЫЙ БОЛЬШОЙ родитель, где ещё только одна вакансия (там и «4h 52min ago» внизу карточки)
        let el = a, card = null;
        for (let i = 0; el && i < 14; i++) {
            el = el.parentElement;
            if (!el || el.tagName === 'BODY') break;
            const vac = new Set([...el.querySelectorAll('a[href*="/vacancies/"]')].map(x => (x.href.match(/\/vacancies\/(\d+)/) || [])[1]).filter(Boolean));
            if (vac.size > 1) break;
            if (el.querySelector('a[href*="/companies/"]')) card = el;
        }
        if (!card) continue;
        seen.add(m[1]);
        const co = card.querySelector('a[href*="/companies/"]');
        const cm = (co.href.match(/\/companies\/(\d+)/) || [])[1];
        out.push({id: m[1], company_id: cm || '', company: (co.innerText || '').trim(), text: (card.innerText || '').slice(0, 1500)});
    }
    return out;
}"""


def field(lines, *labels):
    labs = [x.lower() for x in labels]
    for i, line in enumerate(lines):
        low = line.lower().strip()
        for lab in labs:
            if low.rstrip(":").strip() == lab and i + 1 < len(lines):
                return lines[i + 1].strip()
            if low.startswith(lab + ":") or low.startswith(lab + " :"):
                v = line.split(":", 1)[1].strip(" :")
                if v:
                    return v
    return ""


def parse_vacancy(text, title):
    lines = [re.sub(r"\s*\t+\s*", ": ", x).strip() for x in (text or "").splitlines() if x.strip()]
    lines = [re.sub(r"^([^:]{2,40}):\s*:\s*", r"\1: ", x) for x in lines]

    rank = field(lines, "position", "rank", "должность", "позиция")
    vessel = field(lines, "vessel type", "type of vessel", "тип судна")
    m = re.match(r"\s*(.+?)\s+(?:on|на)\s+(.+?)\s*$", title or "", re.I)
    if m:
        rank = rank or m.group(1)
        vessel = vessel or m.group(2)
    rank = rank or (title or "").strip()

    def f(*labs):
        return field(lines, *labs)

    job = {
        "rank": rank[:120],
        "vessel_type": vessel[:100],
        "salary": f("salary", "зарплата", "заработная плата")[:100],
        "join": f("join date", "joining date", "date of joining", "дата посадки", "дата начала")[:100],
        "duration": f("duration", "contract duration", "длительность", "продолжительность", "длительность контракта")[:100],
    }
    extra = [
        ("Build year", f("build year", "year of build", "year built", "год постройки")),
        ("Flag", f("vessel flag", "flag", "флаг")),
        ("DWT", f("dwt", "дедвейт")),
        ("Main engine", f("main engine", "главный двигатель", "двигатель")),
        ("Crew", f("crew composition", "crew", "экипаж", "состав экипажа")),
        ("English", f("english level", "english", "уровень английского", "английский")),
        ("Citizenship", f("preferred citizenship", "citizenship", "гражданство")),
    ]
    info = "\n".join(f"{k}: {v}" for k, v in extra if v and "login" not in v.lower())
    req = f("requirements", "требования", "description", "описание", "additional info", "дополнительно")
    if req and "login" not in req.lower():
        info = (info + "\n" + req).strip()
    job["info"] = info[:3000]
    return job


# ------------------------------------------------------------
# ПРОВЕРКА ПОЛЕЙ ПЕРЕД ОТПРАВКОЙ В БОТ
# зарплата «up to 1 $» (меньше 100) → Negotiable; «English proficiency» и т.п. — не тип судна
# ------------------------------------------------------------
_VESSEL_WORD = re.compile(
    r"\b(vessel|ship|boat|carrier|bulker|bulk|tanker|barge|ferry|tug|yacht|reefer|dredger|rig|jack[\s-]?up|drill\w*|platform|"
    r"fpso|fso|psv|ahts|osv|mpsv|errv|dsv|sov|csov|ctv|lng|lpg|vlcc|ro[\s-]?ro|ro[\s-]?pax|pctc|pcc|cargo|container|cruise|"
    r"passenger|offshore|supply|survey|research|cable|pipe\s*lay\w*|heavy\s+lift|crane|chemical|crude|product|gas)\b|"
    r"судно|танкер|балкер|контейнеровоз|сухогруз|газовоз|буксир|паром|рефрижератор",
    re.I,
)


def sane_vessel(value):
    v = (value or "").strip()
    return v if v and _VESSEL_WORD.search(v) else ""


def sane_salary(value):
    v = (value or "").strip()
    if not v or not re.search(r"\d", v):
        return v
    if re.search(r"\d\s*k\b|\d\s*тыс", v, re.I):
        return v
    nums = [int(x) for x in re.findall(r"\d{3,6}", re.sub(r"(\d)[\s,.](?=\d{3}\b)", r"\1", v))]
    return v if any(100 <= n < 200000 for n in nums) else "Negotiable"


def make_message(job):
    job = dict(job)
    job["vessel_type"] = sane_vessel(job.get("vessel_type"))
    job["salary"] = sane_salary(job.get("salary"))
    lines = [f"⚓ Rank: {job['rank']}"]
    if job["vessel_type"]:
        lines.append(f"🚢 Vessel type: {job['vessel_type']}")
    if job.get("region"):
        lines.append(f"🌍 Region: {job['region']}")
    if job["join"]:
        lines.append(f"📅 Date: {job['join']}")
    if job["duration"]:
        lines.append(f"⏱️ Duration: {job['duration']}")
    if job["salary"]:
        lines.append(f"💰 Salary: {job['salary']}")
    if job["info"]:
        lines.append("ℹ️ " + job["info"])
    if job["company"]:
        lines.append(f"🏢 Company: {job['company']}")
    lines.append(f"📩 Contact: {job['email']}")
    tags = []
    for v in (job["rank"], job["vessel_type"]):
        t = re.sub(r"[^A-Za-z0-9]", "", v or "")
        if t:
            tags.append("#" + t)
    tags.append(job.get("fleet_tag") or "#MerchantFleet")
    lines.append(" ".join(dict.fromkeys(tags)))
    return "\n".join(lines)


def join_expired(value):
    m = re.findall(r"(\d{2})\.(\d{2})\.(\d{4})", value or "")
    if not m:
        return False
    try:
        last = max(date(int(y), int(mo), int(d)) for d, mo, y in m)
        return last < date.today()
    except ValueError:
        return False


# ------------------------------------------------------------
# СКАН
# ------------------------------------------------------------

async def scan(sent):

    if not SITE_IMPORT_URL or not SITE_IMPORT_TOKEN:
        log("❌ Не заданы SITE_IMPORT_URL / SITE_IMPORT_TOKEN")
        return

    log("")
    log("=" * 60)
    log(f"=== CREWELL SCAN {london_now().strftime('%Y-%m-%d %H:%M')} ===")

    try:
        contacts = await load_contacts()
    except Exception as e:
        log(f"❌ Не удалось получить контакты компаний с сайта: {type(e).__name__}: {e}")
        return
    log(f"📇 Компаний crewell с e-mail в нашем каталоге: {len(contacts)}")

    stats = {"new": 0, "duplicate": 0, "skipped": 0, "no_email": 0, "old": 0, "unknown": 0, "error": 0}
    bad_pages = 0
    stop = False

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=True, args=["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--disable-setuid-sandbox"])
        ctx = await browser.new_context(user_agent=USER_AGENT, locale="en-US")
        page = await ctx.new_page()
        vpage = await ctx.new_page()

        try:
            for n in range(1, MAX_PAGES + 1):

                url = f"{BASE}/en/vacancies/" + (f"?page={n}" if n > 1 else "")
                try:
                    await page.goto(url, wait_until="domcontentloaded", timeout=60000)
                    await page.wait_for_timeout(1200)
                    cards = await page.evaluate(LIST_JS)
                except Exception as e:
                    log(f"❌ Страница {n}: {type(e).__name__}: {e}")
                    break

                if not cards:
                    log(f"📄 Стр. {n}: вакансий не найдено — конец")
                    break

                fresh = 0
                for c in cards:

                    # только опубликованные СЕГОДНЯ (по Лондону)
                    today = is_today(c["text"])
                    if today is None and c["id"] not in sent:
                        # на карточке времени нет — смотрим на странице вакансии
                        try:
                            await vpage.goto(f"{BASE}/en/vacancies/{c['id']}/", wait_until="domcontentloaded", timeout=60000)
                            await vpage.wait_for_timeout(600)
                            today = is_today(await vpage.evaluate("() => document.body.innerText"))
                        except Exception:
                            pass
                    if today is None:
                        stats["unknown"] += 1
                        if stats["unknown"] <= 3:
                            log(f"❓ {c['id']}: не понял время публикации — пропуск. Текст карточки: {c['text'][-160:]!r}")
                        continue
                    if not today:
                        stats["old"] += 1
                        continue
                    fresh += 1

                    vid = c["id"]
                    if vid in sent:
                        continue

                    contact = contacts.get(c["company_id"])
                    if not contact:
                        stats["no_email"] += 1
                        log(f"⛔ {vid}: у компании «{c['company'] or c['company_id']}» нет e-mail в каталоге — пропуск")
                        continue

                    # 1) основное — из карточки списка (должность, судно, зарплата, дата, длительность)
                    card_title = next((x.strip() for x in c["text"].splitlines() if re.search(r"\S\s+(on|на)\s+\S", x) and len(x.strip()) < 120), "")
                    job = parse_vacancy(c["text"], card_title)
                    card_ok = bool(card_title and job["rank"])

                    # 2) подробности — со страницы вакансии, ТОЛЬКО если открылась настоящая страница этой вакансии
                    vurl = f"{BASE}/en/vacancies/{vid}/"
                    try:
                        await vpage.goto(vurl, wait_until="domcontentloaded", timeout=60000)
                        await vpage.wait_for_timeout(800)
                        title = ""
                        if await vpage.locator("h1").count():
                            title = (await vpage.locator("h1").first.inner_text()).strip()
                        text = await vpage.evaluate("() => document.body.innerText")
                        page_ok = bool(re.search(r"\s(on|на)\s", title)) and (vid in text or (card_title and title.lower() == card_title.lower()))
                    except Exception as e:
                        page_ok, title, text = False, "", ""
                        log(f"⚠️ {vid}: страница вакансии не открылась ({type(e).__name__})")

                    if page_ok:
                        pj = parse_vacancy(text, title)
                        for k, v in pj.items():
                            if v and (k == "info" or not job.get(k)):
                                job[k] = v
                    else:
                        bad_pages += 1
                        log(f"⚠️ {vid}: вместо вакансии открылось «{(title or text[:60]).strip()[:60]}» — беру данные из карточки")
                        if not card_ok:
                            stats["error"] += 1
                            continue          # не запоминаем — повторим в следующий раз
                        if bad_pages >= 5:
                            log("🛑 crewell не отдаёт страницы вакансий (защита от частых запросов?) — пауза до следующей проверки")
                            stop = True
                            break

                    job.update({"id": vid, "url": f"{BASE}/ru/vacancies/{vid}/", "email": contact["email"],
                                "company": c["company"] or contact.get("name") or ""})

                    if stats["new"] + stats["duplicate"] < 2:
                        log("🔎 Пример: " + json.dumps({k: v for k, v in job.items() if k != "info"}, ensure_ascii=False))

                    if not job["rank"]:
                        log(f"⚠️ {vid}: не нашёл должность — пропуск")
                        stats["error"] += 1
                        continue

                    if join_expired(job["join"]):
                        sent.add(vid)
                        stats["old"] += 1
                        continue

                    site = await send_to_site(job)

                    if site is False:
                        stats["error"] += 1
                        continue          # повтор при следующем скане

                    stats[site] += 1
                    sent.add(vid)
                    save_sent(sent)

                    if site == "new" and not SITE_ONLY:
                        await to_bot(make_message(job))

                    await asyncio.sleep(3)   # бережно к сайту

                log(f"📄 Стр. {n}: карточек {len(cards)}, свежих {fresh}")

                if stop:
                    break

                if fresh == 0:
                    break      # на странице нет сегодняшних — дальше только старее

        finally:
            await browser.close()

    log(f"=== CREWELL DONE: новых {stats['new']}, дублей {stats['duplicate']}, мусор {stats['skipped']}, "
        f"нет e-mail {stats['no_email']}, не сегодня {stats['old']}, время не понял {stats['unknown']}, ошибок {stats['error']} ===")


# ============================================================
# ATLAS NEXTWAVE (atlasnextwave.com) — раздел Offshore Marine
#  • robots.txt запрещает только поиск (?s=) и фильтры (?f_), поэтому
#    список берём из карты сайта job-sitemap.xml (дата lastmod) и
#    из раздела /jobs/job-category/offshore-marine/ — оба разрешены.
#  • Только сегодняшние (lastmod = сегодня по Лондону), только Offshore Marine,
#    только с e-mail консультанта на странице. Морскую должность проверяет сайт.
# ============================================================

ATLAS = os.getenv("ATLAS", "1").lower() not in ("0", "false", "no")
ATLAS_BASE = "https://atlasnextwave.com"
ATLAS_CATEGORY = f"{ATLAS_BASE}/jobs/job-category/offshore-marine/"

MONTHS = "january|february|march|april|may|june|july|august|september|october|november|december"

# Разовая выгрузка Atlas при первом запуске: все вакансии Offshore Marine с посадкой ПОСЛЕ этой даты (ATLAS_BACKFILL_FROM=0 — выключить)
ATLAS_BACKFILL_FROM = os.getenv("ATLAS_BACKFILL_FROM", "07.10.2026").strip()
if ATLAS_BACKFILL_FROM in ("0", "no", "false"):
    ATLAS_BACKFILL_FROM = ""
try:
    _d, _m, _y = (int(x) for x in ATLAS_BACKFILL_FROM.split("."))
    ATLAS_BACKFILL_DATE = date(_y, _m, _d)
except Exception:
    ATLAS_BACKFILL_DATE, ATLAS_BACKFILL_FROM = None, ""


def parse_start(text):
    """«October 13th, 2026» / «13.10.2026» / «13 October 2026» → date или None."""
    t = (text or "").strip()
    m = re.search(r"(\d{1,2})\.(\d{1,2})\.(\d{4})", t)
    if m:
        try:
            return date(int(m.group(3)), int(m.group(2)), int(m.group(1)))
        except ValueError:
            return None
    months = MONTHS.split("|")
    m = re.search(rf"({MONTHS})\s+(\d{{1,2}})(?:st|nd|rd|th)?,?\s+(\d{{4}})", t, re.I) or None
    if m:
        try:
            return date(int(m.group(3)), months.index(m.group(1).lower()) + 1, int(m.group(2)))
        except ValueError:
            return None
    m = re.search(rf"(\d{{1,2}})(?:st|nd|rd|th)?\s+({MONTHS}),?\s+(\d{{4}})", t, re.I)
    if m:
        try:
            return date(int(m.group(3)), months.index(m.group(2).lower()) + 1, int(m.group(1)))
        except ValueError:
            return None
    if re.search(r"asap|immediate|urgent", t, re.I):
        return date.today()
    return None


def atlas_today_urls(xml):
    """URL вакансий с lastmod = сегодня (по Лондону)."""
    today = london_now().date()
    out = []
    for loc, lastmod in re.findall(r"<loc>\s*([^<]+?)\s*</loc>\s*(?:<lastmod>\s*([^<]+?)\s*</lastmod>)?", xml or ""):
        if "/job/" not in loc or not lastmod:
            continue
        try:
            dt = datetime.fromisoformat(lastmod.replace("Z", "+00:00"))
            try:
                from zoneinfo import ZoneInfo
                dt = dt.astimezone(ZoneInfo("Europe/London"))
            except Exception:
                pass
        except ValueError:
            continue
        if dt.date() == today:
            out.append(loc.strip())
    return out


ATLAS_JS = r"""() => {
    const h = document.querySelector('h1');
    const body = document.body.innerText || '';
    const title = h ? h.innerText.trim() : '';
    // текст вакансии: от заголовка до формы отклика
    let t = title ? body.slice(Math.max(0, body.indexOf(title))) : body;
    const cut = t.search(/\n\s*(apply for this job|apply now|first name\b|submit application|similar jobs|related jobs)/i);
    if (cut > 0) t = t.slice(0, cut);
    const crumbs = [...document.querySelectorAll('a[href*="/job-category/"]')].map(a => a.href + ' ' + a.innerText).join(' | ');
    const mails = [...document.querySelectorAll('a[href^="mailto:"]')].map(a => a.href.replace(/^mailto:/i, '').split('?')[0]);
    return {title, text: t.slice(0, 6000), full: body.slice(0, 20000), crumbs, mails};
}"""


def atlas_parse(d, url):
    title = (d.get("title") or "").strip()
    lines = [re.sub(r"\s*\t+\s*", ": ", x).strip() for x in (d.get("text") or "").splitlines() if x.strip()]

    emails = [e.lower() for e in re.findall(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", (d.get("full") or "") + " " + " ".join(d.get("mails") or []))]
    emails = [e for e in dict.fromkeys(emails) if not re.match(r"^(no-?reply|privacy|gdpr|dpo|wordpress)@", e) and not e.endswith((".png", ".jpg"))]
    # консультант (имя@atlasnextwave.com) важнее общих адресов
    generic = re.compile(r"^(info|contact|hello|admin|office|careers|jobs|recruitment)@")
    email = next((e for e in emails if "atlasnextwave" in e and not generic.match(e)), None) or next(iter(emails), "")

    text = "\n".join(lines)
    start = field(lines, "start date", "start", "date", "mobilisation", "mobilization")
    if not start:
        m = re.search(rf"\b(?:{MONTHS})\s+\d{{1,2}}(?:st|nd|rd|th)?,?\s+\d{{4}}", text, re.I)
        start = m.group(0) if m else ""
    region = field(lines, "location", "country", "region")
    if not region and start:
        # строка вида «Angola  Contract  October 13th, 2026»
        for x in lines[:12]:
            if start in x:
                rest = re.sub(r"\b(contract|permanent|temporary|freelance|full[- ]time|part[- ]time|rotational)\b", " ", x.replace(start, " "), flags=re.I)
                rest = re.sub(r"[|•·,]+", " ", rest).strip()
                if 2 <= len(rest) <= 40:
                    region = re.sub(r"\s{2,}", " ", rest)
                break
    duration = field(lines, "duration", "rotation", "schedule", "length")
    if not duration:
        m = re.search(r"\d+\s*(?:weeks?|days?)\s*on\s*/\s*\d+\s*(?:weeks?|days?)\s*off", text, re.I)
        duration = m.group(0) if m else ""
    salary = field(lines, "salary", "day rate", "rate", "pay")
    vessel = ""
    m = re.search(r"\b(?:on|onboard|aboard|join|joining)\s+(?:an?\s+|the\s+|our\s+)?([A-Za-z /&-]{3,60}?(?:vessel|ship|tanker|carrier|barge|rig|jack-?up|fpso|psv|ahts|csv|dsv|osv|dredger|tug))\b", text, re.I)
    if m:
        vessel = m.group(1).strip()

    # описание (без шапки и строк с полями)
    drop = set()
    for i, x in enumerate(lines):
        if x.lower() in ("consultant", "recruitment consultant", "senior consultant") and i:
            drop.update({i - 1, i})
    desc = [x for i, x in enumerate(lines[1:], 1)
            if i not in drop and (not start or start not in x) and "@" not in x
            and not re.match(r"^(location|country|job type|type|start date|category|duration|salary|share|apply|job description|description)\b", x, re.I)]
    info = "\n".join(desc)[:2500]

    return {
        "source": "atlas",
        "id": url.rstrip("/").rsplit("/", 1)[-1],
        "url": url,
        "rank": title[:120],
        "vessel_type": vessel[:100],
        "region": region[:120],
        "join": start[:100],
        "duration": duration[:100],
        "salary": salary[:100],
        "email": email,
        "company": "Atlas NextWave",
        "info": info,
    }


async def scan_atlas(sent):

    if not ATLAS:
        return

    log("")
    log(f"=== ATLAS NEXTWAVE SCAN {london_now().strftime('%Y-%m-%d %H:%M')} ===")
    stats = {"new": 0, "duplicate": 0, "skipped": 0, "not_marine": 0, "no_email": 0, "error": 0}
    backfill = False

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=True, args=["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--disable-setuid-sandbox"])
        ctx = await browser.new_context(user_agent=USER_AGENT, locale="en-GB")
        page = await ctx.new_page()

        try:
            # 1) сегодняшние вакансии из карты сайта
            urls = []
            try:
                r = await page.goto(f"{ATLAS_BASE}/job-sitemap.xml", wait_until="domcontentloaded", timeout=60000)
                urls = atlas_today_urls(await r.text() if r else "")
            except Exception as e:
                log(f"⚠️ Atlas: карта сайта недоступна: {type(e).__name__}: {e}")

            # 2) из раздела Offshore Marine берём только те, что есть в «сегодняшних» (раздел — для отбора категории)
            marine = set()
            for n in (1, 2):
                try:
                    await page.goto(ATLAS_CATEGORY + (f"page/{n}/" if n > 1 else ""), wait_until="domcontentloaded", timeout=60000)
                    hrefs = await page.locator("a[href*='/job/']").evaluate_all("els => els.map(e => e.href)")
                    marine.update(h.split("?")[0].split("#")[0].rstrip("/") + "/" for h in hrefs)
                except Exception as e:
                    log(f"⚠️ Atlas: раздел Offshore Marine, стр. {n}: {type(e).__name__}")

            log(f"🗺 Atlas: сегодня в карте сайта {len(urls)}, в разделе Offshore Marine на 1–2 стр. {len(marine)}")

            # разовая выгрузка: ВСЕ вакансии раздела Offshore Marine с посадкой после ATLAS_BACKFILL_FROM
            st = _tos_state()
            backfill = ATLAS_BACKFILL_FROM and not st.get("atlas_backfill_done")
            if backfill:
                allj = []
                for n in range(1, 21):
                    try:
                        await page.goto(ATLAS_CATEGORY + (f"page/{n}/" if n > 1 else ""), wait_until="domcontentloaded", timeout=60000)
                        hrefs = await page.locator("a[href*='/job/']").evaluate_all("els => els.map(e => e.href)")
                    except Exception:
                        break
                    got = [h.split("?")[0].split("#")[0].rstrip("/") + "/" for h in hrefs if "/job/" in h]
                    new_ = [h for h in dict.fromkeys(got) if h not in allj]
                    if not new_:
                        break
                    allj += new_
                    marine.update(new_)
                log(f"📦 Atlas: разовая выгрузка — в разделе Offshore Marine {len(allj)} вакансий, беру с посадкой после {ATLAS_BACKFILL_FROM}")
                urls = list(dict.fromkeys(urls + allj))

            for url in urls:
                vid = "atlas:" + url.rstrip("/").rsplit("/", 1)[-1]
                if vid in sent:
                    continue
                key = url.split("?")[0].rstrip("/") + "/"
                if marine and key not in marine:
                    # нет в разделе — проверим категорию на самой странице
                    pass
                try:
                    await page.goto(url, wait_until="domcontentloaded", timeout=60000)
                    await page.wait_for_timeout(700)
                    d = await page.evaluate(ATLAS_JS)
                except Exception as e:
                    stats["error"] += 1
                    log(f"❌ Atlas {url}: {type(e).__name__}")
                    continue

                if key not in marine and "offshore-marine" not in (d.get("crumbs") or "").lower():
                    stats["not_marine"] += 1
                    sent.add(vid)
                    continue

                job = atlas_parse(d, url)
                job["id"] = vid.split(":", 1)[1]

                if not job["email"]:
                    stats["no_email"] += 1
                    log(f"⛔ Atlas {job['id']}: нет e-mail — пропуск")
                    sent.add(vid)
                    continue

                if stats["new"] + stats["duplicate"] + stats["skipped"] < 2:
                    log("🔎 Atlas пример: " + json.dumps({k: v for k, v in job.items() if k != "info"}, ensure_ascii=False))

                if join_expired(job["join"]):
                    sent.add(vid)
                    continue

                if backfill:
                    jd = parse_start(job["join"])
                    if not jd or jd <= ATLAS_BACKFILL_DATE:
                        sent.add(vid)
                        log(f"⏭ Atlas {job['id']}: посадка {job['join'] or 'не указана'} — не после {ATLAS_BACKFILL_FROM}")
                        continue

                site = await send_to_site(job)
                if site is False:
                    stats["error"] += 1
                    continue
                stats[site] += 1
                sent.add(vid)
                save_sent(sent)

                if site == "new" and not SITE_ONLY:
                    await to_bot(make_message(job), "atlas")

                await asyncio.sleep(2)

        finally:
            await browser.close()
            save_sent(sent)

    if backfill and stats["error"] == 0:
        st = _tos_state()
        st["atlas_backfill_done"] = True
        _tos_save(st)
    log(f"=== ATLAS DONE: новых {stats['new']}, дублей {stats['duplicate']}, не морские/мусор {stats['skipped']}, "
        f"не Offshore Marine {stats['not_marine']}, нет e-mail {stats['no_email']}, ошибок {stats['error']} ===")


# ============================================================
# TOS PEOPLE (jobs.tospeople.com) — robots.txt разрешает всё
#  • Даты публикации на сайте нет. Номера вакансий растут (10659, 10658…),
#    поэтому «новые» = номер больше запомненного. При самом первом запуске
#    парсер запоминает последний номер (TOS_FIRST_TAKE=15 — взять ещё и 15 последних); дальше — только новые.
#    (TOS_START_ID=10650 — взять всё, что новее этого номера.)
#  • Только морские разделы: Maritime, Offshore, Towage, Dredging, Ship Delivery.
#  • Имейл консультанта — со страницы вакансии (…@tospeople.com).
# ============================================================

TOS = os.getenv("TOS", "1").lower() not in ("0", "false", "no")
TOS_BASE = "https://jobs.tospeople.com"
TOS_STATE = Path(os.getenv("TOS_STATE_FILE", "tos_state.json"))
TOS_FIRST_TAKE = int(os.getenv("TOS_FIRST_TAKE", "0") or 0)   # сколько последних взять при первом запуске
TOS_MARINE = re.compile(r"\b(maritime|offshore|towage|dredging|ship delivery)\b", re.I)
TOS_LAND = re.compile(r"\b(onshore|port\s*&\s*logistics|logistics)\b", re.I)

TOS_RANKS = [
    (r"\bmaster\b|\bcaptain\b|\bskipper\b", "Master"), (r"\bc/?o\b|chief\s+(officer|mate)", "Chief Officer"),
    (r"\bc/?e\b|chief\s+engineer", "Chief Engineer"), (r"\b2/?o\b|second\s+officer|2nd\s+officer", "Second Officer"),
    (r"\b2/?e\b|second\s+engineer|2nd\s+engineer", "Second Engineer"), (r"\b3/?o\b|third\s+officer|3rd\s+officer", "Third Officer"),
    (r"\b3/?e\b|third\s+engineer|3rd\s+engineer", "Third Engineer"), (r"\beto\b|electro.?technical", "ETO"),
    (r"\belectrician\b", "Electrician"), (r"\bdpo\b|dynamic\s+positioning", "DPO"), (r"\bbosun\b|boatswain", "Bosun"),
    (r"\bab\b|able\s+seaman", "AB"), (r"\bos\b|ordinary\s+seaman", "OS"), (r"\bdeckhand\b", "Deckhand"),
    (r"\boiler\b", "Oiler"), (r"\bmotorman\b", "Motorman"), (r"\bfitter\b", "Fitter"), (r"\bpainter\b", "Painter"), (r"\bwelder\b", "Welder"), (r"\bcook\b", "Cook"),
    (r"\bsteward\b|messman", "Steward"), (r"\bcrane\s+operator\b", "Crane Operator"),
]


def tos_ranks(title):
    found = []
    for rx, name in TOS_RANKS:
        if re.search(rx, title or "", re.I) and name not in found:
            found.append(name)
    return found


def _tos_state():
    try:
        return json.loads(TOS_STATE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _tos_save(st):
    try:
        TOS_STATE.write_text(json.dumps(st), encoding="utf-8")
    except Exception:
        pass


TOS_JS = r"""() => {
    const h = document.querySelector('h1');
    const title = h ? h.innerText.trim() : '';
    const body = document.body.innerText || '';
    let t = title ? body.slice(Math.max(0, body.indexOf(title))) : body;
    const cut = t.search(/\n\s*(similar (jobs|vacancies)|other vacancies|related jobs|share this|apply now\s*\n\s*first name)/i);
    if (cut > 0) t = t.slice(0, cut);
    const mails = [...document.querySelectorAll('a[href^="mailto:"]')].map(a => a.href.replace(/^mailto:/i, '').split('?')[0]);
    return {title, text: t.slice(0, 6000), full: body.slice(0, 20000), mails};
}"""


def tos_parse(d, url, vid):
    title = (d.get("title") or "").strip()
    lines = [re.sub(r"\s*\t+\s*", ": ", x).strip() for x in (d.get("text") or "").splitlines() if x.strip()]
    text = "\n".join(lines)

    emails = [e.lower() for e in re.findall(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", (d.get("full") or "") + " " + " ".join(d.get("mails") or []))]
    emails = [e for e in dict.fromkeys(emails) if not re.match(r"^(no-?reply|privacy|gdpr|dpo)@", e)]
    generic = re.compile(r"^(info|contact|hello|admin|office|careers|jobs|recruitment|hr)@")
    personal = [e for e in emails if "tospeople" in e and not generic.match(e)]
    email = (personal or [e for e in emails if "tospeople" in e] or emails or [""])[0]

    ranks = tos_ranks(title)
    clean_title = re.sub(r"^\s*we\s+are\s+looking\s+for\s+", "", title, flags=re.I).strip()
    m = re.search(r"\bfor\s+(?:an?\s+|the\s+)?([^,;]+?)\s*$", clean_title, re.I)
    vessel = m.group(1).strip() if m and ranks else ""
    mc = re.search(r"\bfor\s+(?:an?\s+|the\s+)?(?:full\s+set\s+)?(?:crew\s+for\s+)?([A-Za-z0-9 /&-]+?)\s+crew\b", clean_title, re.I)
    if not vessel and mc:
        vessel = mc.group(1).strip()
    if not vessel:
        mf = re.search(r"crew\s+for\s+(?:an?\s+|the\s+)?(.+)$", clean_title, re.I)
        vessel = mf.group(1).strip() if mf else ""
    if not vessel:
        me = re.fullmatch(r"(?:full\s+set\s+)?([A-Za-z0-9 /&-]+?)\s+crew", clean_title.strip(), re.I)
        vessel = me.group(1).strip() if me else ""
    vessel = re.sub(r"^(full\s+set|set)\s+", "", vessel, flags=re.I)
    if len(ranks) == 1:
        rank = ranks[0]
    elif ranks or re.search(r"\bcrew\b", clean_title, re.I):
        rank = "Multiple positions"
    else:
        rank = clean_title[:120]

    region = field(lines, "location", "region", "country", "work location", "locatie")
    if not region:
        for x in lines[1:10]:
            if re.fullmatch(r"(south|north|east|west|southeast|south-east|middle)?\s*[A-Z][A-Za-z ,&-]{2,40}", x) and not TOS_MARINE.fullmatch(x.strip()):
                if re.search(r"asia|europe|africa|america|middle east|netherlands|indonesia|singapore|malaysia|uk|norway|brazil|gulf|sea", x, re.I):
                    region = x.strip()
                    break

    drop_rx = re.compile(r"^(apply|share|back|location|workfield|category|contact|contact person|©)\b|@|^©", re.I)
    # имена консультантов (строка перед e-mail) не нужны в описании
    names = {lines[i - 1] for i, x in enumerate(lines) if i and "@" in x}
    info = "\n".join(x for x in lines[1:] if not drop_rx.search(x) and x.strip() != region and x not in names
                     and not TOS_MARINE.fullmatch(x.strip()) and not TOS_LAND.fullmatch(x.strip()))[:2500]
    if len(ranks) > 1:
        info = ("Positions: " + ", ".join(ranks) + "\n" + info).strip()
    others = [e for e in emails if e != email and "tospeople" in e]
    if others:
        info += "\nAlso: " + ", ".join(others[:2])

    return {
        "source": "tospeople",
        "id": vid,
        "url": url,
        "rank": rank[:120],
        "vessel_type": (" ".join(w if len(w) <= 5 else w.capitalize() for w in vessel.split()) if vessel.isupper() else vessel)[:100],
        "region": region[:120],
        "join": field(lines, "start date", "start", "joining", "mobilisation", "mobilization")[:100],
        "duration": field(lines, "duration", "rotation", "contract")[:100],
        "salary": field(lines, "salary", "day rate", "rate")[:100],
        "email": email,
        "company": "TOS",
        "info": info,
        "fleet_tag": "#OffshoreFleet" if re.search(r"\boffshore\b|\b(psv|ahts|errv|mpsv|osv|dsv|csv|crew\s*boat|crewboat|fpso|jack.?up|rig)\b", text + " " + title, re.I) else "#MerchantFleet",
        "_marine": bool(TOS_MARINE.search(text)) and not (TOS_LAND.search(text) and not TOS_MARINE.search(text)),
        "_title": title,
    }


async def scan_tos(sent):

    if not TOS:
        return

    log("")
    log(f"=== TOS PEOPLE SCAN {london_now().strftime('%Y-%m-%d %H:%M')} ===")
    stats = {"new": 0, "duplicate": 0, "skipped": 0, "not_marine": 0, "no_email": 0, "error": 0}
    st = _tos_state()

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=True, args=["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--disable-setuid-sandbox"])
        ctx = await browser.new_context(user_agent=USER_AGENT, locale="en-GB")
        page = await ctx.new_page()

        try:
            ids = {}

            async def grab_list(url):
                await page.goto(url, wait_until="domcontentloaded", timeout=60000)
                try:
                    await page.wait_for_load_state("networkidle", timeout=10000)
                except Exception:
                    pass
                hrefs = await page.locator("a[href*='/job-posting/']").evaluate_all("els => els.map(e => e.href)")
                got = 0
                for h in hrefs:
                    m = re.search(r"/job-posting/(\d+)(/[^?#]*)?", h)
                    if m and int(m.group(1)) not in ids:
                        ids[int(m.group(1))] = f"{TOS_BASE}/en/job-posting/{m.group(1)}{m.group(2) or ''}"
                        got += 1
                # ссылка на следующую страницу, если есть
                nxt = await page.evaluate("""() => {
                    const a = [...document.querySelectorAll('a[href]')].find(x => /[?&]page=2\\b|\\/page\\/2\\b/.test(x.href)
                        || /^(next|volgende|›|»|>)$/i.test((x.innerText || x.getAttribute('aria-label') || '').trim()));
                    return a ? a.href : null;
                }""")
                return got, nxt

            got, nxt = await grab_list(f"{TOS_BASE}/en?lang=eng")
            # вторая–третья страницы (нужно на первом запуске, чтобы набрать 15 последних)
            for extra in [nxt, f"{TOS_BASE}/en?lang=eng&page=2", f"{TOS_BASE}/en?page=2&lang=eng"]:
                if len(ids) >= max(TOS_FIRST_TAKE, 1) or not extra:
                    break
                try:
                    g, _ = await grab_list(extra)
                    if g:
                        break
                except Exception:
                    pass

            if not ids:
                log("⚠️ TOS: на странице списка не нашёл вакансий")
                return

            last = st.get("last_id") or int(os.getenv("TOS_START_ID", "0") or 0)
            if not last:
                # первый запуск: берём последние TOS_FIRST_TAKE (по умолчанию 15) и дальше — только новее
                if TOS_FIRST_TAKE <= 0:
                    st["last_id"] = max(ids)
                    _tos_save(st)
                    log(f"📌 TOS: первый запуск — запомнил последний номер {max(ids)}, дальше беру только новые")
                    return
                newest = sorted(ids, reverse=True)[:TOS_FIRST_TAKE]
                last = min(newest) - 1
                log(f"📌 TOS: первый запуск — беру последние {len(newest)} вакансий (номера {min(newest)}–{max(newest)}) и запоминаю")

            fresh = sorted(i for i in ids if i > last)
            log(f"🗂 TOS: в списке {len(ids)}, новых (номер > {last}): {len(fresh)}")

            for i in fresh:
                key = f"tospeople:{i}"
                if key in sent:
                    continue
                url = ids[i]
                try:
                    await page.goto(url, wait_until="domcontentloaded", timeout=60000)
                    try:
                        await page.wait_for_load_state("networkidle", timeout=8000)
                    except Exception:
                        pass
                    d = await page.evaluate(TOS_JS)
                except Exception as e:
                    stats["error"] += 1
                    log(f"❌ TOS {i}: {type(e).__name__}")
                    continue

                job = tos_parse(d, url, str(i))

                if not job.pop("_marine"):
                    stats["not_marine"] += 1
                    log(f"⏭ TOS {i}: не морской раздел — «{job['_title'][:60]}»")
                    job.pop("_title", None)
                    sent.add(key)
                    continue
                job.pop("_title", None)

                if not job["email"]:
                    stats["no_email"] += 1
                    log(f"⛔ TOS {i}: нет e-mail — пропуск")
                    sent.add(key)
                    continue

                if stats["new"] + stats["duplicate"] + stats["skipped"] < 2:
                    log("🔎 TOS пример: " + json.dumps({k: v for k, v in job.items() if k != "info"}, ensure_ascii=False))

                site = await send_to_site(job)
                if site is False:
                    stats["error"] += 1
                    continue
                stats[site] += 1
                sent.add(key)
                save_sent(sent)

                if site == "new" and not SITE_ONLY:
                    await to_bot(make_message(job), "tospeople")

                await asyncio.sleep(3)

            if stats["error"] == 0:
                st["last_id"] = max([last] + fresh)
                _tos_save(st)

        finally:
            await browser.close()
            save_sent(sent)

    log(f"=== TOS DONE: новых {stats['new']}, дублей {stats['duplicate']}, не морские/мусор {stats['skipped']}, "
        f"не морской раздел {stats['not_marine']}, нет e-mail {stats['no_email']}, ошибок {stats['error']} ===")


# ============================================================
# SEA-MAN.ORG (crew.sea-man.org) — robots.txt разрешает /vacancies/ и /vac/
#  • Список подгружается в браузере (Playwright его видит), вакансия: /vac/ID/.
#  • Имейл и телефон компании видны без входа.
#  • Даты публикации нет, номера растут → как у TOS: первый запуск — последние 15, потом только новее.
# ============================================================

SEAMAN = os.getenv("SEAMAN", "1").lower() not in ("0", "false", "no")
SEAMAN_BASE = "https://crew.sea-man.org"
SEAMAN_FIRST_TAKE = int(os.getenv("SEAMAN_FIRST_TAKE", "0") or 0)

SEAMAN_JS = r"""() => {
    const h = document.querySelector('h1');
    const body = document.body.innerText || '';
    const title = h ? h.innerText.trim() : (document.title || '');
    let t = body;
    const i = h ? body.indexOf(h.innerText.trim()) : -1;
    if (i > 0) t = body.slice(i);
    const cut = t.search(/\n\s*(similar vacancies|other vacancies|похожие вакансии|cookie|we value your privacy)/i);
    if (cut > 0) t = t.slice(0, cut);
    const mails = [...document.querySelectorAll('a[href^="mailto:"]')].map(a => a.href.replace(/^mailto:/i, '').split('?')[0]);
    const tels = [...document.querySelectorAll('a[href^="tel:"]')].map(a => a.href.replace(/^tel:/i, ''));
    return {title, text: t.slice(0, 8000), mails, tels};
}"""


def seaman_parse(d, url, vid):
    title = re.sub(r"\s*\|\s*apply now\s*$", "", (d.get("title") or "").strip(), flags=re.I)
    lines = [re.sub(r"\s*\t+\s*", ": ", x).strip() for x in (d.get("text") or "").splitlines() if x.strip()]
    lines = [re.sub(r"^([^:]{2,40}):\s*:\s*", r"\1: ", x) for x in lines]
    text = "\n".join(lines)

    def f(*labs):
        v = field(lines, *labs)
        return "" if v in ("—", "-", "–") else v

    rank = f("rank", "position", "должность")
    vessel = f("vessel type", "type of vessel", "ship type", "тип судна")
    m = re.match(r"\s*(.+?)\s+on\s+(.+?)(?:,\s*([^,|]+?))?\s*$", title, re.I)
    if m:
        rank = rank or m.group(1)
        vessel = vessel or m.group(2)
    salary = f("salary", "wage", "зарплата") or (m.group(3) if m and m.group(3) else "")

    emails = [e.lower() for e in re.findall(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", text + " " + " ".join(d.get("mails") or []))]
    emails = [e for e in dict.fromkeys(emails) if "sea-man.org" not in e and not re.match(r"^(no-?reply|privacy|gdpr)@", e)]
    phone = (d.get("tels") or [""])[0] or f("phone", "tel", "телефон")

    extra = [("DWT", f("dwt")), ("Built", f("built", "year of build", "year built", "год постройки")), ("Flag", f("flag", "флаг")),
             ("Engine", f("engine", "main engine", "двигатель")), ("Citizenship", f("citizenship", "nationality", "гражданство")),
             ("English", f("english", "english level", "английский"))]
    desc = f("description", "описание", "about the vacancy", "requirements", "требования")
    info = "\n".join(f"{k}: {v}" for k, v in extra if v)
    if desc:
        info = (info + "\n" + desc).strip()

    return {
        "source": "seaman",
        "id": vid,
        "url": url,
        "rank": rank[:120],
        "vessel_type": vessel[:100],
        "vessel_name": f("vessel name", "ship name", "название судна")[:120],
        "region": f("region", "trading area", "регион")[:120],
        "join": f("join date", "joining date", "date of joining", "дата посадки")[:100],
        "duration": f("duration", "contract duration", "длительность", "контракт")[:100],
        "salary": salary[:100],
        "email": emails[0] if emails else "",
        "phone": phone[:60],
        "company": f("company", "crewing company", "employer", "компания", "крюинг")[:120],
        "info": info[:3000],
    }


async def scan_seaman(sent):

    if not SEAMAN:
        return

    log("")
    log(f"=== SEA-MAN SCAN {london_now().strftime('%Y-%m-%d %H:%M')} ===")
    stats = {"new": 0, "duplicate": 0, "skipped": 0, "no_email": 0, "error": 0}
    st = _tos_state()

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=True, args=["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--disable-setuid-sandbox"])
        ctx = await browser.new_context(user_agent=USER_AGENT, locale="en-GB")
        page = await ctx.new_page()

        try:
            ids = set()
            try:
                await page.goto(f"{SEAMAN_BASE}/vacancies/", wait_until="domcontentloaded", timeout=60000)
                try:
                    await page.wait_for_selector("a[href*='/vac/']", timeout=20000)
                except Exception:
                    pass
                for h in await page.locator("a[href*='/vac/']").evaluate_all("els => els.map(e => e.href)"):
                    m = re.search(r"/vac/(\d+)", h)
                    if m:
                        ids.add(int(m.group(1)))
            except Exception as e:
                log(f"⚠️ Sea-man: список не открылся: {type(e).__name__}")

            last = st.get("seaman_last") or int(os.getenv("SEAMAN_START_ID", "0") or 0)

            if not ids and last:
                # список не прогрузился — проверяем следующие номера подряд
                ids = set(range(last + 1, last + 31))
                log("⚠️ Sea-man: список не прогрузился — проверяю номера подряд")

            if not ids:
                log("⚠️ Sea-man: вакансий не нашёл")
                return

            if not last:
                if SEAMAN_FIRST_TAKE <= 0:
                    st["seaman_last"] = max(ids)
                    _tos_save(st)
                    log(f"📌 Sea-man: первый запуск — запомнил последний номер {max(ids)}, дальше беру только новые")
                    return
                newest = sorted(ids, reverse=True)[:SEAMAN_FIRST_TAKE]
                last = min(newest) - 1
                log(f"📌 Sea-man: первый запуск — беру последние {len(newest)} (номера {min(newest)}–{max(newest)}) и запоминаю")

            fresh = sorted(i for i in ids if i > last)
            log(f"🗂 Sea-man: в списке {len(ids)}, новых (номер > {last}): {len(fresh)}")
            top = last
            misses = 0

            for i in fresh:
                key = f"seaman:{i}"
                if key in sent:
                    top = max(top, i)
                    continue
                url = f"{SEAMAN_BASE}/vac/{i}/"
                try:
                    r = await page.goto(url, wait_until="domcontentloaded", timeout=60000)
                    if r and r.status == 404:
                        misses += 1
                        if misses >= 10:
                            break
                        continue
                    await page.wait_for_timeout(1200)
                    d = await page.evaluate(SEAMAN_JS)
                except Exception as e:
                    stats["error"] += 1
                    log(f"❌ Sea-man {i}: {type(e).__name__}")
                    continue

                job = seaman_parse(d, url, str(i))
                if not job["rank"]:
                    misses += 1
                    continue
                misses = 0
                top = max(top, i)

                if not job["email"]:
                    stats["no_email"] += 1
                    log(f"⛔ Sea-man {i}: нет e-mail — пропуск")
                    sent.add(key)
                    continue

                if stats["new"] + stats["duplicate"] + stats["skipped"] < 2:
                    log("🔎 Sea-man пример: " + json.dumps({k: v for k, v in job.items() if k != "info"}, ensure_ascii=False))

                if join_expired(job["join"]):
                    sent.add(key)
                    continue

                site = await send_to_site(job)
                if site is False:
                    stats["error"] += 1
                    continue
                stats[site] += 1
                sent.add(key)
                save_sent(sent)

                if site == "new" and not SITE_ONLY:
                    await to_bot(make_message(job), "seaman")

                await asyncio.sleep(3)

            if stats["error"] == 0:
                st["seaman_last"] = max(top, st.get("seaman_last") or 0)
                _tos_save(st)

        finally:
            await browser.close()
            save_sent(sent)

    log(f"=== SEA-MAN DONE: новых {stats['new']}, дублей {stats['duplicate']}, не морские/мусор {stats['skipped']}, "
        f"нет e-mail {stats['no_email']}, ошибок {stats['error']} ===")


SCHEDULE = [tuple(int(x) for x in t.strip().split(":")) for t in os.getenv("SCHEDULE", "10:00,12:00,14:00,16:00").split(",") if t.strip()]


def next_run(now):
    for h, m in SCHEDULE:
        t = now.replace(hour=h, minute=m, second=0, microsecond=0)
        if t > now:
            return t
    h, m = SCHEDULE[0]
    return (now + timedelta(days=1)).replace(hour=h, minute=m, second=0, microsecond=0)


async def run_all(sent):
    if not SITE_ONLY:
        await flush_bot_pending()
    try:
        await scan(sent)
    except Exception as e:
        log(f"🔥 SCAN ERROR: {type(e).__name__}: {e}")
    try:
        await scan_atlas(sent)
    except Exception as e:
        log(f"🔥 ATLAS ERROR: {type(e).__name__}: {e}")
    try:
        await scan_tos(sent)
    except Exception as e:
        log(f"🔥 TOS ERROR: {type(e).__name__}: {e}")
    try:
        await scan_seaman(sent)
    except Exception as e:
        log(f"🔥 SEA-MAN ERROR: {type(e).__name__}: {e}")


async def main():

    log("=== CREWELL + ATLAS + TOS + SEA-MAN VACANCIES PARSER STARTED ===")
    log(f"Сайт: {bool(SITE_IMPORT_URL and SITE_IMPORT_TOKEN)}  SITE_ONLY={SITE_ONLY}  только за сегодня  страниц ≤ {MAX_PAGES}")
    log("Расписание (Лондон): " + ", ".join(f"{h:02d}:{m:02d}" for h, m in SCHEDULE))

    sent = load_sent()
    log(f"💾 В памяти: {len(sent)} вакансий")

    # при запуске — сразу одна проверка, если сейчас рабочее время (между первым и последним запуском + 1 час)
    now = london_now()
    first, last = SCHEDULE[0], SCHEDULE[-1]
    if os.getenv("RUN_NOW", "").lower() in ("1", "true", "yes"):
        log("🚀 RUN_NOW=1 — проверяю сразу, вне расписания")
        await run_all(sent)
    elif (now.hour, now.minute) >= first and now.hour <= last[0]:
        log("🚀 Запуск в рабочее время — проверяю сразу")
        await run_all(sent)

    while True:
        now = london_now()
        target = next_run(now)
        log(f"⏳ Следующая проверка: {target.strftime('%d.%m %H:%M')} (через {int((target - now).total_seconds() // 60)} мин)")
        await asyncio.sleep(max(30, (target - now).total_seconds()))
        await run_all(sent)


if __name__ == "__main__":
    asyncio.run(main())
