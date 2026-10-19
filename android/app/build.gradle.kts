plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "app.wavedrop.android"
    compileSdk {
        version = release(37)
    }

    defaultConfig {
        applicationId = "app.wavedrop.android"
        minSdk = 29
        targetSdk = 36
        versionCode = (findProperty("wdVersionCode") as String?)?.toInt() ?: 3
        versionName = (findProperty("wdVersionName") as String?) ?: "1.0.2"
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            // Signed with the debug key so the release APK can be sideloaded for testing.
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
    }

    packaging {
        resources {
            excludes += setOf("/META-INF/{AL2.0,LGPL2.1}", "/META-INF/versions/9/OSGI-INF/MANIFEST.MF")
        }
    }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2026.09.00")
    implementation(composeBom)
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.ui:ui-tooling-preview")
    debugImplementation("androidx.compose.ui:ui-tooling")

    implementation("androidx.core:core-ktx:1.19.1")
    implementation("androidx.activity:activity-compose:1.13.0")
    implementation("androidx.lifecycle:lifecycle-runtime-compose:2.11.0")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.11.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.11.0")

    implementation("com.squareup.okhttp3:okhttp:5.5.0")
    implementation("com.squareup.okhttp3:okhttp-sse:5.5.0")
    implementation("org.bouncycastle:bcprov-jdk18on:1.86")
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20260814") // Android's org.json is a stub in JVM unit tests
}
