package pl.yozh.wishlist

import android.net.Uri
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

/**
 * Один прохід коду закладки (`assets/grab.js` = `pageGrab` з
 * `app/src/lib/bookmarklet.ts`) по сторінці в WebView.
 *
 * Закладка в кінці відкриває `{origin}/add?src=page&…` через `window.open`.
 * Тут `window.open` на час виклику підмінено: адреса не відкривається, а
 * повертається в Kotlin, і помічник сам вирішує — вже відкривати форму чи
 * почекати, поки сторінка домалюється.
 */
class Grab private constructor(
    val target: Uri,
    val hasTitle: Boolean,
    val hasPrice: Boolean,
    val hasImage: Boolean,
) {
    val complete: Boolean
        get() = hasTitle && hasPrice && hasImage

    /** Ціна важить найбільше: саме її й нема, коли сторінку не пускають. */
    val score: Int
        get() = (if (hasTitle) 1 else 0) + (if (hasPrice) 2 else 0) + (if (hasImage) 1 else 0)

    companion object {
        /** Вираз для `evaluateJavascript`: результат — адреса форми або `null`. */
        fun script(
            grabSource: String,
            origin: String,
        ): String =
            "(function(){var u=null,o=window.open;" +
                "window.open=function(x){u=String(x);return {};};" +
                "try{(" + grabSource + "\n)(" + JSONObject.quote(origin) + ");}catch(e){}" +
                "finally{window.open=o;}return u;})()"

        /** Відповідь `evaluateJavascript` — JSON-літерал рядка або `null`. */
        fun parse(
            raw: String?,
            origin: String,
        ): Grab? {
            if (raw == null || raw == "null") return null
            val text =
                try {
                    JSONArray("[$raw]").optString(0, "")
                } catch (e: JSONException) {
                    return null
                }
            if (!text.startsWith("$origin/add?")) return null
            val uri = Uri.parse(text)
            // Пробу до того, як сторінка взагалі почала вантажитись, не рахуємо.
            val page = uri.getQueryParameter("url").orEmpty()
            if (!page.startsWith("http://") && !page.startsWith("https://")) return null

            fun has(key: String) = !uri.getQueryParameter(key).isNullOrBlank()
            return Grab(uri, has("title"), has("price"), has("image"))
        }
    }
}
