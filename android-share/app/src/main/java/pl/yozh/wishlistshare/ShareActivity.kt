package pl.yozh.wishlistshare

import android.annotation.SuppressLint
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.view.View
import android.webkit.CookieManager
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast

/**
 * «Поділитися → У вішліст» (ADR-080).
 *
 * Сторінку магазину відкриває невидимий WebView на самому телефоні — з його
 * адреси й у справжньому рушії Chrome, тож захист від ботів бачить звичайного
 * відвідувача, а не наш сервер. Раз на секунду по сторінці проходить код
 * закладки «У вішліст» (`Grab`): щойно є назва, ціна й фото — відкривається
 * форма `/add?src=page&…` у застосунку Wishlist. Не вийшло за [GIVE_UP_MS] —
 * сторінка показується людині: там може бути перевірка «чи ти не робот», яку
 * можна пройти, або просто «Додати як є».
 */
class ShareActivity : Activity() {
    private val handler = Handler(Looper.getMainLooper())
    private val origin = BuildConfig.APP_ORIGIN

    private lateinit var web: WebView
    private lateinit var status: TextView
    private lateinit var progress: ProgressBar
    private lateinit var secondary: Button
    private lateinit var shared: Shared
    private lateinit var grabCall: String

    private var startedAt = 0L
    private var pageFinished = false
    private var pageShown = false
    private var done = false
    private var best: Grab? = null
    private var lastRaw: String? = null
    private var sameInARow = 0

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val fromIntent = Shared.from(intent)
        if (fromIntent == null) {
            Toast.makeText(this, R.string.no_link, Toast.LENGTH_LONG).show()
            finish()
            return
        }
        shared = fromIntent
        val grabSource = assets.open("grab.js").bufferedReader().use { it.readText() }
        grabCall = Grab.script(grabSource, origin)

        setContentView(R.layout.activity_share)
        web = findViewById(R.id.web)
        status = findViewById(R.id.status)
        progress = findViewById(R.id.progress)
        secondary = findViewById(R.id.secondary)
        findViewById<TextView>(R.id.host).text = shared.host
        findViewById<Button>(R.id.cancel).setOnClickListener {
            done = true
            finish()
        }
        secondary.setOnClickListener {
            if (pageShown) openBest() else showPage(R.string.status_page_shown)
        }

        setUpWebView()
        startedAt = SystemClock.elapsedRealtime()
        web.loadUrl(shared.url)
        handler.postDelayed({ probe() }, FIRST_PROBE_MS)
        handler.postDelayed({
            if (!done && !pageShown) secondary.visibility = View.VISIBLE
        }, OFFER_PAGE_MS)
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun setUpWebView() {
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true)
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            loadsImagesAutomatically = true
            userAgentString = chromeLike(WebSettings.getDefaultUserAgent(this@ShareActivity))
        }
        web.webViewClient =
            object : WebViewClient() {
                // Сторінки магазинів люблять перекидати в свій застосунок (intent://,
                // allegro://…) — лишаємось на сайті.
                override fun shouldOverrideUrlLoading(
                    view: WebView,
                    request: WebResourceRequest,
                ): Boolean {
                    val scheme = request.url.scheme?.lowercase()
                    return scheme != "http" && scheme != "https"
                }

                override fun onPageStarted(
                    view: WebView,
                    url: String?,
                    favicon: Bitmap?,
                ) {
                    pageFinished = false
                }

                override fun onPageFinished(
                    view: WebView,
                    url: String?,
                ) {
                    pageFinished = true
                }
            }
    }

    /**
     * Типовий рядок WebView має «; wv» і «Version/4.0» — за ними сайти й
     * відрізняють вбудований браузер. Прибираємо обидва: лишається рядок,
     * як у Chrome на цьому ж телефоні.
     */
    private fun chromeLike(ua: String): String = ua.replace("; wv)", ")").replace(Regex("""Version/\d+(\.\d+)* """), "")

    private fun probe() {
        if (done) return
        web.evaluateJavascript(grabCall) { raw -> onProbe(raw) }
    }

    private fun onProbe(raw: String?) {
        if (done) return
        val grab = Grab.parse(raw, origin)
        val current = best
        if (grab != null && (current == null || grab.score >= current.score)) best = grab
        if (raw == lastRaw) {
            sameInARow++
        } else {
            sameInARow = 0
            lastRaw = raw
        }
        val elapsed = SystemClock.elapsedRealtime() - startedAt
        Log.d(TAG, "probe ${elapsed}ms finished=$pageFinished same=$sameInARow -> $raw")

        if (!pageShown && best?.hasTitle == true) status.setText(R.string.status_found_title)

        when {
            // Усе знайдено, і сторінка або довантажилась, або вже не змінюється.
            grab != null && grab.complete && (pageFinished || sameInARow >= 1) -> open(grab.target)
            // Ціна є, фото немає (буває), сторінка стоїть — далі чекати нічого.
            grab != null && grab.hasTitle && grab.hasPrice && pageFinished && sameInARow >= STABLE_PROBES -> open(grab.target)
            !pageShown && elapsed >= GIVE_UP_MS -> {
                showPage(R.string.status_no_price)
                handler.postDelayed({ probe() }, PROBE_EVERY_MS)
            }
            else -> handler.postDelayed({ probe() }, PROBE_EVERY_MS)
        }
    }

    private fun showPage(message: Int) {
        pageShown = true
        web.visibility = View.VISIBLE
        progress.visibility = View.GONE
        status.setText(message)
        secondary.setText(R.string.add_as_is)
        secondary.visibility = View.VISIBLE
    }

    /** «Додати як є»: найкраще, що знайшлося, а без назви — звичайне «Поділитися». */
    private fun openBest() {
        val current = best
        open(if (current != null && current.hasTitle) current.target else plainShare())
    }

    /** Той самий шлях, що й «Поділитися» без помічника: форма, парсер, назва з тексту. */
    private fun plainShare(): Uri {
        val builder = Uri.parse("$origin/add").buildUpon().appendQueryParameter("url", shared.url)
        shared.title?.let { builder.appendQueryParameter("title", it) }
        return builder.build()
    }

    private fun open(target: Uri) {
        if (done) return
        done = true
        handler.removeCallbacksAndMessages(null)
        val view = Intent(Intent.ACTION_VIEW, target).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        installedPwa(view)?.let { view.setPackage(it) }
        try {
            startActivity(view)
        } catch (e: ActivityNotFoundException) {
            view.setPackage(null)
            try {
                startActivity(view)
            } catch (e2: ActivityNotFoundException) {
                Toast.makeText(this, R.string.no_app, Toast.LENGTH_LONG).show()
            }
        }
        finish()
    }

    /**
     * Встановлений із Chrome PWA — це WebAPK (`org.chromium.webapk.…`), що
     * відкриває адреси свого сайту. Шлемо форму прямо йому: так вона
     * відкривається в застосунку, де людина вже увійшла, а не у вкладці Chrome.
     */
    @Suppress("DEPRECATION")
    private fun installedPwa(view: Intent): String? =
        packageManager
            .queryIntentActivities(view, PackageManager.MATCH_ALL)
            .map { it.activityInfo.packageName }
            .firstOrNull { it.startsWith("org.chromium.webapk.") }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        if (::web.isInitialized) {
            web.stopLoading()
            web.destroy()
        }
        super.onDestroy()
    }

    companion object {
        private const val TAG = "WishlistShare"
        private const val FIRST_PROBE_MS = 1200L
        private const val PROBE_EVERY_MS = 1000L
        private const val STABLE_PROBES = 2
        private const val OFFER_PAGE_MS = 6000L
        private const val GIVE_UP_MS = 15000L
    }
}
