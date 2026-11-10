plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val wishlistOrigin: String =
    (findProperty("wishlistOrigin") as String?)
        ?.trimEnd('/')
        ?: "https://wishlist-personal.vercel.app"

android {
    namespace = "pl.yozh.wishlistshare"
    compileSdk = 35

    defaultConfig {
        applicationId = "pl.yozh.wishlistshare"
        minSdk = 26
        // 34, а не 35: на Android 15 ціль 35 вмикає edge-to-edge примусово,
        // і нижня картка лягала б під панель навігації. Помічник ставиться
        // вручну, не через Play, тож вимоги Play до цілі його не стосуються.
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"
        buildConfigField("String", "APP_ORIGIN", "\"$wishlistOrigin\"")
    }

    buildFeatures {
        buildConfig = true
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}
