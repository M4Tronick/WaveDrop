// swift-tools-version: 6.0
import PackageDescription

// WaveDrop for iPhone, built with xtool (https://xtool.sh) on Linux/WSL or
// with Xcode on a Mac. WaveDropKit holds the protocol and also builds and
// tests on Linux (`swift test`); the app target is iOS-only.
let package = Package(
    name: "WaveDrop",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "WaveDrop", targets: ["WaveDrop"]),
    ],
    dependencies: [
        // On Apple platforms this re-exports CryptoKit.
        .package(url: "https://github.com/apple/swift-crypto.git", "3.0.0" ..< "5.0.0"),
    ],
    targets: [
        .target(
            name: "WaveDropKit",
            dependencies: [.product(name: "Crypto", package: "swift-crypto")],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .target(
            name: "WaveDrop",
            dependencies: ["WaveDropKit"],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .testTarget(
            name: "WaveDropKitTests",
            dependencies: ["WaveDropKit"],
            resources: [.copy("vectors.json")]
        ),
    ]
)
