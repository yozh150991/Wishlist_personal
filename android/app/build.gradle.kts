import java.net.URI

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val wishlistOrigin: String =
    (findProperty("wishlistOrigin") as String?)?.trimEnd('/')
        ?: "https://wishlist-personal.vercel.app"
val wishlistHost: String = URI(wishlistOrigin).host

// Постійний ключ підпису (ADR-081). Без нього збірка підписується тимчасовим
// debug-ключем: застосунок працює, але Chrome не впізнає його власником сайту
// (assetlinks.json) і показує вгорі рядок адреси.
val keystorePath = findProperty("wishlistKeystore") as String?
val keystorePassword = findProperty("wishlistKeystorePassword") as String?
val keystoreAlias = (findProperty("wishlistKeyAlias") as String?) ?: "wishlist"
val hasReleaseKey = keystorePath != null && keystorePassword != null && file(keystorePath).exists()

android {
    namespace = "pl.yozh.wishlist"
    compileSdk = 36

    defaultConfig {
        applicationId = "pl.yozh.wishlist"
        minSdk = 26
        // 34, а не 35: на Android 15 ціль 35 вмикає edge-to-edge примусово,
        // і нижня картка «У вішліст» лягала б під панель навігації.
        // Застосунок ставиться вручну, не через Play.
        targetSdk = 34
        versionCode = 3
        versionName = "0.2.1"

        buildConfigField("String", "APP_ORIGIN", "\"$wishlistOrigin\"")
        resValue("string", "launch_url", wishlistOrigin)
        resValue("string", "host_name", wishlistHost)
        resValue(
            "string",
            "asset_statements",
            """[{\"relation\":[\"delegate_permission/common.handle_all_urls\"],""" +
                """\"target\":{\"namespace\":\"web\",\"site\":\"$wishlistOrigin\"}}]""",
        )
        manifestPlaceholders["hostName"] = wishlistHost
    }

    signingConfigs {
        if (hasReleaseKey) {
            create("wishlist") {
                storeFile = file(keystorePath!!)
                storePassword = keystorePassword
                keyAlias = keystoreAlias
                // У PKCS12 (типовий формат keytool) пароль ключа = пароль сховища.
                keyPassword = keystorePassword
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = if (hasReleaseKey) signingConfigs.getByName("wishlist") else null
        }
        debug {
            // Збірка зі Studio тим самим ключем: ставиться поверх збірки з CI,
            // і Chrome так само впізнає застосунок.
            if (hasReleaseKey) signingConfig = signingConfigs.getByName("wishlist")
        }
    }

    buildFeatures {
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    // Trusted Web Activity: Wishlist на весь екран у Chrome, зі спільним входом
    // і push-сповіщеннями (github.com/GoogleChrome/android-browser-helper).
    implementation("com.google.androidbrowserhelper:androidbrowserhelper:2.7.4")
}
