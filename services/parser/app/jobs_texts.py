"""
Тексти сповіщень власника (ADR-049) — українською, польською й англійською.

Мова — та, якою людина востаннє відкривала застосунок: `user_metadata.locale`,
те саме поле, що й для листів Supabase (ADR-024). Невідома мова — українська.

До власника звертаємось на «ти» й без граматичного роду: жодного «отримав»,
«dostałeś» чи «зробила». Про позначки гостей тут немає жодного рядка й бути не
може (ADR-040).
"""

from datetime import date

LOCALES = ("uk", "pl", "en")

TEXTS: dict[str, dict[str, str]] = {
    "uk": {
        "after_event.title": "Як минуло свято?",
        "after_event.body": "«{list}»: познач отримане й перенеси, що ще хочеш.",
        "yearly.title": "Скоро «{list}»",
        "yearly.body": "{date} — річниця. Повторити список на {year}?",
        "link_gone.title": "Сторінки товару немає",
        "link_gone.body": "«{item}» у списку «{list}». Можна замінити посилання чи пошукати деінде.",
        "link_out.title": "Немає в наявності",
        "link_out.body": "«{item}» у списку «{list}» зараз не продається.",
        "price.title": "Ціна змінилась",
        "price.body": "«{item}»: у магазині зараз {price}, у списку — {own}.",
        "share.title": "Посилання скоро згасне",
        "share.body": "«{share}» діє до {date}. Після цього гості його не відкриють.",
        "many.title": "Нове у твоїх списках: {n}",
        "email.open": "Відкрити",
        "email.why": "Цей лист прийшов, бо сповіщення листом увімкнено в налаштуваннях Wishlist.",
        "email.settings": "Налаштувати сповіщення",
    },
    "pl": {
        "after_event.title": "Jak minęło święto?",
        "after_event.body": "„{list}”: zaznacz otrzymane prezenty i przenieś to, czego nadal chcesz.",
        "yearly.title": "Wkrótce „{list}”",
        "yearly.body": "{date} — rocznica. Powtórzyć listę na {year}?",
        "link_gone.title": "Strony produktu już nie ma",
        "link_gone.body": "„{item}” na liście „{list}”. Możesz podmienić link albo poszukać gdzie indziej.",
        "link_out.title": "Produkt niedostępny",
        "link_out.body": "„{item}” z listy „{list}” jest teraz niedostępny w sklepie.",
        "price.title": "Cena się zmieniła",
        "price.body": "„{item}”: w sklepie teraz {price}, na liście — {own}.",
        "share.title": "Link wkrótce wygaśnie",
        "share.body": "„{share}” działa do {date}. Potem goście go nie otworzą.",
        "many.title": "Nowości na Twoich listach: {n}",
        "email.open": "Otwórz",
        "email.why": "Ten e-mail przyszedł, bo powiadomienia e-mailem są włączone w ustawieniach Wishlist.",
        "email.settings": "Ustawienia powiadomień",
    },
    "en": {
        "after_event.title": "How did the celebration go?",
        "after_event.body": "“{list}”: mark what you received and carry over what you still want.",
        "yearly.title": "“{list}” is coming up",
        "yearly.body": "{date} — anniversary. Repeat the list for {year}?",
        "link_gone.title": "Product page is gone",
        "link_gone.body": "“{item}” in “{list}”. You can replace the link or look elsewhere.",
        "link_out.title": "Out of stock",
        "link_out.body": "“{item}” in “{list}” isn't available in the shop right now.",
        "price.title": "Price changed",
        "price.body": "“{item}”: {price} in the shop now, {own} in your list.",
        "share.title": "Link expires soon",
        "share.body": "“{share}” works until {date}. After that guests can't open it.",
        "many.title": "New in your lists: {n}",
        "email.open": "Open",
        "email.why": "You're getting this email because email notifications are on in Wishlist settings.",
        "email.settings": "Notification settings",
    },
}

# Місяць у родовому відмінку — «18 жовтня», «18 października».
MONTHS: dict[str, tuple[str, ...]] = {
    "uk": (
        "січня", "лютого", "березня", "квітня", "травня", "червня",
        "липня", "серпня", "вересня", "жовтня", "листопада", "грудня",
    ),
    "pl": (
        "stycznia", "lutego", "marca", "kwietnia", "maja", "czerwca",
        "lipca", "sierpnia", "września", "października", "listopada", "grudnia",
    ),
    "en": (
        "January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December",
    ),
}

# Позначення валют: у uk і pl — після суми, в en — перед нею.
_SUFFIX = {
    "uk": {"UAH": "грн", "PLN": "zł", "EUR": "€", "USD": "$"},
    "pl": {"UAH": "UAH", "PLN": "zł", "EUR": "€", "USD": "USD"},
}
_PREFIX = {"USD": "$", "EUR": "€", "PLN": "PLN ", "UAH": "UAH "}


def locale_of(value: object) -> str:
    return value if isinstance(value, str) and value in LOCALES else "uk"


def text(key: str, locale: str, **values: object) -> str:
    template = TEXTS.get(locale, TEXTS["uk"]).get(key) or TEXTS["uk"][key]
    return template.format(**values)


def format_date(day: date, locale: str) -> str:
    return f"{day.day} {MONTHS[locale_of(locale)][day.month - 1]}"


def format_money(minor: int, currency: str, locale: str) -> str:
    """Сума в мінорних одиницях: «1 390 грн», «1 390,50 zł», «$1,390.50»."""
    locale = locale_of(locale)
    whole, cents = divmod(abs(minor), 100)
    sign = "-" if minor < 0 else ""
    if locale == "en":
        number = f"{whole:,}" + (f".{cents:02d}" if cents else "")
        return f"{sign}{_PREFIX.get(currency, currency + ' ')}{number}"
    grouped = f"{whole:,}".replace(",", " ")
    number = grouped + (f",{cents:02d}" if cents else "")
    return f"{sign}{number} {_SUFFIX[locale].get(currency, currency)}"
