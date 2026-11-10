package pl.yozh.wishlistshare

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.widget.Button
import android.widget.TextView

/** Іконка в меню застосунків: як додавати товари і кнопка до самого Wishlist. */
class InfoActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_info)
        findViewById<TextView>(R.id.origin).text = BuildConfig.APP_ORIGIN.removePrefix("https://")
        findViewById<Button>(R.id.open_app).setOnClickListener {
            try {
                startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(BuildConfig.APP_ORIGIN)))
            } catch (e: ActivityNotFoundException) {
                // Без браузера на телефоні відкривати нічим — кнопка просто нічого не робить.
            }
        }
    }
}
