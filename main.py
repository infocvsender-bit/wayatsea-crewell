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
#   SCAN_EVERY_MIN=60  (необязательно) как часто проверять
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
        "source": "crewell",
        "external_id": job["id"],
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
            log(f"🗑 {job['id']}: сайт отклонил как мусор ({res.get('reason')})")
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


async def to_bot(text):
    """В бот через очередь на сайте (её отправляет Telegram-парсер)."""
    try:
        await asyncio.to_thread(_site, "/api/import/bot-outbox", {"text": text, "source": "crewell"})
        log("📨 В очередь бота")
        return True
    except Exception as e:
        log(f"⚠️ Очередь бота недоступна: {type(e).__name__}: {e}")
        return False


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
        let el = a, card = null;
        for (let i = 0; el && i < 10; i++) {
            el = el.parentElement;
            if (!el) break;
            const vac = new Set([...el.querySelectorAll('a[href*="/vacancies/"]')].map(x => (x.href.match(/\/vacancies\/(\d+)/) || [])[1]).filter(Boolean));
            if (vac.size > 1) break;
            if (el.querySelector('a[href*="/companies/"]')) { card = el; break; }
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


def make_message(job):
    lines = [f"⚓ Rank: {job['rank']}"]
    if job["vessel_type"]:
        lines.append(f"🚢 Vessel type: {job['vessel_type']}")
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
    tags.append("#MerchantFleet")
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

                    vurl = f"{BASE}/en/vacancies/{vid}/"
                    try:
                        await vpage.goto(vurl, wait_until="domcontentloaded", timeout=60000)
                        await vpage.wait_for_timeout(800)
                        title = ""
                        if await vpage.locator("h1").count():
                            title = (await vpage.locator("h1").first.inner_text()).strip()
                        text = await vpage.evaluate("() => document.body.innerText")
                    except Exception as e:
                        stats["error"] += 1
                        log(f"❌ {vid}: {type(e).__name__}: {e}")
                        continue

                    job = parse_vacancy(text, title)
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

                    await asyncio.sleep(1.5)   # бережно к сайту

                log(f"📄 Стр. {n}: карточек {len(cards)}, свежих {fresh}")

                if fresh == 0:
                    break      # на странице нет сегодняшних — дальше только старее

        finally:
            await browser.close()

    log(f"=== CREWELL DONE: новых {stats['new']}, дублей {stats['duplicate']}, мусор {stats['skipped']}, "
        f"нет e-mail {stats['no_email']}, не сегодня {stats['old']}, время не понял {stats['unknown']}, ошибок {stats['error']} ===")


async def main():

    log("=== CREWELL VACANCIES PARSER STARTED ===")
    log(f"Сайт: {bool(SITE_IMPORT_URL and SITE_IMPORT_TOKEN)}  SITE_ONLY={SITE_ONLY}  "
        f"только за сегодня  страниц ≤ {MAX_PAGES}  каждые {SCAN_EVERY_MIN} мин")

    sent = load_sent()
    log(f"💾 В памяти: {len(sent)} вакансий")

    while True:
        h = london_now().hour
        if WORK_HOURS[0] <= h < WORK_HOURS[1]:
            try:
                await scan(sent)
            except Exception as e:
                log(f"🔥 SCAN ERROR: {type(e).__name__}: {e}")
        else:
            log(f"🌙 Ночь по Лондону ({h}:00) — пропуск")
        log(f"⏳ Следующая проверка через {SCAN_EVERY_MIN} мин")
        await asyncio.sleep(SCAN_EVERY_MIN * 60)


if __name__ == "__main__":
    asyncio.run(main())
