// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "friday-audio",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "friday-audio",
            path: "Sources/friday-audio",
            linkerSettings: [
                .linkedFramework("ScreenCaptureKit"),
                .linkedFramework("AVFoundation"),
                .linkedFramework("CoreMedia"),
            ]
        )
    ]
)
