import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
}

// Server address baked into the APK as the default. It can be changed on the TV (pairing screen →
// "Sunucu adresi"), so one APK serves every installation; a build for a known server avoids typing it
// with the remote: ./gradlew :app:assembleDebug -Pmanagealltv.serverUrl=https://tv.firma.com
val defaultServerUrl: String =
    providers.gradleProperty("managealltv.serverUrl").orElse("https://tv.example.com").get()

// Release signing comes from the environment (CI secrets). Without it the release APK is signed with
// the debug key, so assembleRelease still works on a developer machine.
val releaseKeystorePath: String? =
    providers.environmentVariable("MTV_KEYSTORE_FILE").orNull?.takeIf { it.isNotBlank() }

val jvmTargetVersion: String = libs.versions.jvm.target.get()

android {
    namespace = "tv.managealltv.player"
    compileSdk = libs.versions.android.compileSdk.get().toInt()

    defaultConfig {
        applicationId = "tv.managealltv.player"
        minSdk = libs.versions.android.minSdk.get().toInt()
        // Deliberately 35 (not the catalog's 36): targeting 36 lets Android 16 ignore the fixed
        // landscape orientation on large screens and drops the edge-to-edge opt-out. Raise it only
        // after the player has been checked on the pilot TVs.
        targetSdk = 35
        // Bump both for every APK that is installed on TVs; the panel shows them per device.
        versionCode = 1
        versionName = "0.1.0"

        val escapedUrl = defaultServerUrl.replace("\\", "\\\\").replace("\"", "\\\"")
        buildConfigField("String", "DEFAULT_SERVER_URL", "\"$escapedUrl\"")
    }

    signingConfigs {
        releaseKeystorePath?.let { path ->
            create("release") {
                storeFile = file(path)
                storePassword = providers.environmentVariable("MTV_KEYSTORE_PASSWORD").orNull
                keyAlias = providers.environmentVariable("MTV_KEY_ALIAS").orNull
                keyPassword = providers.environmentVariable("MTV_KEY_PASSWORD").orNull
            }
        }
    }

    buildTypes {
        release {
            // Shrinking would need keep rules for kotlinx.serialization and Media3; the APK is small
            // enough and only installed on a handful of TVs.
            isMinifyEnabled = false
            signingConfig = signingConfigs.findByName("release") ?: signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.toVersion(jvmTargetVersion)
        targetCompatibility = JavaVersion.toVersion(jvmTargetVersion)
        // player-core uses java.time in its API; Android 7.x (API 24-25) has no java.time.
        isCoreLibraryDesugaringEnabled = true
    }

    buildFeatures {
        buildConfig = true
    }

    packaging {
        resources {
            excludes += setOf("/META-INF/{AL2.0,LGPL2.1}", "/META-INF/versions/9/OSGI-INF/MANIFEST.MF")
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.fromTarget(jvmTargetVersion))
    }
}

dependencies {
    implementation(libs.player.core)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.okhttp)
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.service)
    implementation(libs.media3.exoplayer)
    implementation(libs.media3.ui)
    coreLibraryDesugaring(libs.desugar.jdk.libs)

    // Pure logic in tv.managealltv.player.logic has no Android imports, so it runs as a plain JVM test.
    testImplementation(libs.junit4)
}
