package pl.yozh.wishlist

import android.content.Intent
import android.net.Uri

/**
 * Що прийшло з «Поділитися». Браузер кладе адресу в EXTRA_TEXT, а назву
 * вкладки — в EXTRA_SUBJECT; додатки магазинів — усе в EXTRA_TEXT
 * («Керамічна лампа https://shop.ua/lampa»). Те саме зведення до пари
 * «адреса + назва», що й у застосунку (`lib/shareTarget.ts`, `fromShare`).
 */
class Shared private constructor(
    val url: String,
    val title: String?,
) {
    val host: String
        get() = Uri.parse(url).host?.removePrefix("www.") ?: url

    companion object {
        private val URL_IN_TEXT = Regex("""https?://[^\s<>"'«»]+""", RegexOption.IGNORE_CASE)
        private val SPACES = Regex("""\s+""")
        private const val TITLE_MAX = 200

        fun from(intent: Intent?): Shared? {
            if (intent?.action != Intent.ACTION_SEND) return null
            val text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString().orEmpty()
            val subject = intent.getCharSequenceExtra(Intent.EXTRA_SUBJECT)?.toString()

            val match = URL_IN_TEXT.find(text) ?: return null
            val url = match.value.trimEnd(')', '.', ',', '!', '?', ';', ':')

            // Решта тексту без адреси — назва, якщо окремої не передали.
            val rest =
                text
                    .removeRange(match.range)
                    .replace(SPACES, " ")
                    .trim()
                    .trimEnd(':', '-', '–', '—', '(')
                    .trim()
            val title =
                subject?.trim()?.takeIf { it.isNotEmpty() && !looksLikeUrl(it) }
                    ?: rest.takeIf { it.isNotEmpty() && !looksLikeUrl(it) }
            return Shared(url, title?.take(TITLE_MAX))
        }

        private fun looksLikeUrl(s: String): Boolean =
            s.startsWith("http://", true) || s.startsWith("https://", true) || s.startsWith("www.", true)
    }
}
