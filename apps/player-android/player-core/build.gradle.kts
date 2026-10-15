import org.gradle.api.tasks.testing.logging.TestExceptionFormat
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    `java-library`
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.kotlin.serialization)
}

group = "tv.managealltv"
version = "0.1.0"

val jvmTargetVersion = libs.versions.jvm.target.get()

// Target 17 via --release instead of a toolchain: the bytecode and the visible JDK API are those of
// Java 17 whichever JDK (17+) runs Gradle, and no JDK has to be auto-provisioned (CI uses Temurin 17).
java {
    sourceCompatibility = JavaVersion.toVersion(jvmTargetVersion)
    targetCompatibility = JavaVersion.toVersion(jvmTargetVersion)
}

tasks.withType<JavaCompile>().configureEach {
    options.release.set(jvmTargetVersion.toInt())
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.fromTarget(jvmTargetVersion))
        freeCompilerArgs.add("-Xjdk-release=$jvmTargetVersion")
        optIn.add("kotlinx.serialization.ExperimentalSerializationApi")
    }
}

dependencies {
    // Exposed as api: the app uses the protocol types, coroutines flows and OkHttp client directly.
    api(libs.kotlinx.serialization.json)
    api(libs.kotlinx.coroutines.core)
    api(libs.okhttp)

    testImplementation(platform(libs.junit.bom))
    testImplementation(libs.junit.jupiter)
    testImplementation(libs.kotlin.test.junit5)
    testImplementation(libs.okhttp.mockwebserver)
    testImplementation(libs.kotlinx.coroutines.test)
    testRuntimeOnly(libs.junit.platform.launcher)
}

// The contract fixtures live in the TypeScript protocol package; tests read them from there so both
// sides are checked against the very same files.
val protocolFixtures = layout.projectDirectory.dir("../../../packages/protocol/fixtures")

tasks.test {
    useJUnitPlatform()
    inputs.dir(protocolFixtures)
        .withPropertyName("protocolFixtures")
        .withPathSensitivity(PathSensitivity.RELATIVE)
    systemProperty("managealltv.protocolFixturesDir", protocolFixtures.asFile.absolutePath)
    testLogging {
        events("failed", "skipped")
        exceptionFormat = TestExceptionFormat.FULL
    }
}
