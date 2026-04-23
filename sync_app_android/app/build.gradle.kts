plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("com.google.devtools.ksp")
}

android {
    namespace = "com.yhtiddly.sync"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.yhtiddly.sync"
        minSdk = 26
        targetSdk = 34
        // When releasing a new APK: bump versionCode (integer, monotonic) and
        // versionName (semver-ish string used for comparison against GitHub
        // release tag_name — see AutoUpdater.kt). Tag the commit `v<name>`
        // and attach the signed APK as a release asset.
        versionCode = 2
        versionName = "1.1"
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }

    buildFeatures {
        viewBinding = true
        // Needed by AutoUpdater.kt to read BuildConfig.VERSION_NAME at runtime.
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
    // Core
    implementation("androidx.core:core-ktx:1.12.0")
    implementation("androidx.appcompat:appcompat:1.6.1")
    implementation("com.google.android.material:material:1.11.0")
    implementation("androidx.constraintlayout:constraintlayout:2.1.4")
    implementation("androidx.swiperefreshlayout:swiperefreshlayout:1.1.0")

    // Room
    val roomVersion = "2.6.1"
    implementation("androidx.room:room-runtime:$roomVersion")
    implementation("androidx.room:room-ktx:$roomVersion")
    ksp("androidx.room:room-compiler:$roomVersion")

    // Coroutines
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.7.3")

    // Lifecycle
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.7.0")
    implementation("androidx.lifecycle:lifecycle-viewmodel-ktx:2.7.0")

    // WorkManager
    implementation("androidx.work:work-runtime-ktx:2.9.0")

    // OkHttp
    implementation("com.squareup.okhttp3:okhttp:4.12.0")

    // NanoHTTPD
    implementation("org.nanohttpd:nanohttpd:2.3.1")

    // Gson
    implementation("com.google.code.gson:gson:2.10.1")

    // Preferences
    implementation("androidx.preference:preference-ktx:1.2.1")
}
