import java.util.Properties

plugins {
    id("com.android.application")
}

// assets 来源（不放进 git）：node 二进制、CA 包、payload、运行库
val armDir = providers.gradleProperty("armDir").orElse("D:/QQBot/tools/arm64/extract").get()
val libsDir = providers.gradleProperty("libsDir").orElse("D:/QQBot/tools/arm64/termux-libs").get()
val withPayload = providers.gradleProperty("withPayload").orElse("false").get().toBoolean()
val repoDir = providers.gradleProperty("repoDir").orElse("D:/QQBot-open/qq-bridge").get()

android {
    namespace = "com.qqbridge.app"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.qqbridge.app"
        minSdk = 21
        // 关键：必须是 28。Android 10+ 对 targetSdk>=29 的 App 禁止执行私有目录文件，
        // 而我们要 exec 自己私有的 node（见 docs/design/ANDROID-APK-PLAN.md）。
        targetSdk = 28
        versionCode = 59
        versionName = "0.5.60"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }

    sourceSets["main"].assets.srcDirs("src/main/assets")

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }
}

/** 把外部生成的大文件同步进 assets（node / cacert / payload.tar / libs.tar） */
val syncAssets by tasks.registering(Copy::class) {
    into(layout.projectDirectory.dir("src/main/assets"))
    from(file("$armDir/node")) { rename { "node" } }
    from(file("$armDir/cacert.pem"))
    if (withPayload) {
        from(file("$repoDir/src/bridge.js"))
        from(file("$repoDir/config.example.json"))
        from(file("$repoDir/package.json")) { rename { "package.json.full" } }
        from(layout.projectDirectory.dir("../../build/assets")) { include("payload.tar", "libs.tar", "package.json") }
    }
    doFirst {
        val node = file("$armDir/node")
        if (!node.exists()) {
            throw GradleException("缺 $node —— 先把 Termux aarch64 的 node 解到 $armDir（见 mobile/apk/tools/fetch-node-libs.py 的说明）")
        }
        val ca = file("$armDir/cacert.pem")
        if (!ca.exists()) {
            throw GradleException("缺 $ca —— 没有 CA 的 node 在 Android 上所有 HTTPS 都会 UNABLE_TO_GET_ISSUER_CERT_LOCALLY")
        }
        if (withPayload) {
            val libs = file(libsDir)
            if (!libs.exists()) {
                throw GradleException("缺 $libsDir —— 先跑 python mobile/apk/tools/fetch-node-libs.py")
            }
        }
    }
}

tasks.named("preBuild") { dependsOn(syncAssets) }
