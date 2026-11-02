use std::hash::{DefaultHasher, Hash, Hasher};
use std::path::Path;
use std::process::Command;

fn main() {
    // A runtime check, not #[cfg]: the build script runs on the build machine.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") { apple_helper(); }
    tauri_build::build()
}

const HELPER: &str = "binaries/quietnote-ai";
const SOURCE: &str = "swift/quietnote-ai.swift";

/// Builds the Apple Intelligence helper (`swift/quietnote-ai.swift`) for both Mac architectures, as the
/// `externalBin` tauri-build copies next to the app. It's rebuilt only when the source or the compiler
/// changes, since tauri-build reruns this script whenever the files it copies are written.
/// `QUIETNOTE_REQUIRE_APPLE_AI=1` (release builds) fails when the SDK has no FoundationModels.
fn apple_helper() {
    println!("cargo:rerun-if-changed={SOURCE}");
    println!("cargo:rerun-if-env-changed=DEVELOPER_DIR");
    println!("cargo:rerun-if-env-changed=QUIETNOTE_REQUIRE_APPLE_AI");
    let required = std::env::var("QUIETNOTE_REQUIRE_APPLE_AI").is_ok_and(|v| v == "1");
    let source = std::fs::read(SOURCE).expect("the Apple Intelligence helper's source");
    let output = |args: &[&str]| Command::new("xcrun").args(args).output().ok().filter(|o| o.status.success()).map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());
    let (swiftc, sdk) = (output(&["swiftc", "--version"]), output(&["--show-sdk-path"]));
    let models = sdk.as_deref().is_some_and(|sdk| Path::new(sdk).join("System/Library/Frameworks/FoundationModels.framework").exists());
    if required && !models { panic!("This SDK has no FoundationModels: select Xcode 26 or later to build QuietNote with Apple Intelligence."); }
    let mut hasher = DefaultHasher::new();
    (&source, &swiftc, &sdk).hash(&mut hasher);
    let stamp = format!("{:x}", hasher.finish());
    let names = ["aarch64", "x86_64", "universal"].map(|arch| format!("{HELPER}-{arch}-apple-darwin"));
    let stamp_file = format!("{HELPER}.stamp");
    // A stand-in is kept until the source or toolchain changes too (so a Mac without a working swiftc doesn't
    // retry, and rebuild the crate, on every build), except for a build that requires the real helper.
    let kept = std::fs::read_to_string(&stamp_file).unwrap_or_default();
    let stand_in = format!("stand-in {stamp}");
    if names.iter().all(|n| Path::new(n).exists()) && (kept == stamp || (kept == stand_in && !required)) { return; }
    std::fs::create_dir_all("binaries").expect("the binaries folder");
    // Stamped again only once the files are written, so an interrupted build tries again.
    let _ = std::fs::remove_file(&stamp_file);
    let out = std::env::var("OUT_DIR").expect("OUT_DIR");
    let built = swiftc.is_some() && ["arm64", "x86_64"].iter().all(|arch| {
        Command::new("xcrun").args(["swiftc", "-O", "-parse-as-library", "-swift-version", "5", "-target", &format!("{arch}-apple-macos14.2"),
            "-Xlinker", "-weak_framework", "-Xlinker", "FoundationModels", SOURCE, "-o", &format!("{out}/quietnote-ai-{arch}")])
            .status().is_ok_and(|s| s.success())
    }) && Command::new("lipo").args(["-create", &format!("{out}/quietnote-ai-arm64"), &format!("{out}/quietnote-ai-x86_64"), "-output", &format!("{out}/quietnote-ai")])
        .status().is_ok_and(|s| s.success());
    if !built {
        if required { panic!("The Apple Intelligence helper didn’t build."); }
        println!("cargo:warning=The Apple Intelligence helper didn’t build; this copy can’t use Apple Intelligence.");
        // tauri-build needs the file: a stand-in that answers every request with "not built".
        std::fs::write(format!("{out}/quietnote-ai"), "#!/bin/sh\nwhile read -r _; do echo '{\"built\":false,\"available\":false,\"reason\":\"notBuilt\",\"contextSize\":0,\"ok\":false,\"error\":\"other\",\"message\":\"This copy of QuietNote was built without Apple Intelligence.\"}'; done\n").expect("the stand-in helper");
        Command::new("chmod").args(["+x", &format!("{out}/quietnote-ai")]).status().expect("chmod");
    } else if !models {
        println!("cargo:warning=This SDK has no FoundationModels; this copy can’t use Apple Intelligence.");
    }
    for name in &names { std::fs::copy(format!("{out}/quietnote-ai"), name).expect("the helper"); }
    std::fs::write(stamp_file, if built { stamp } else { stand_in }).expect("the helper's stamp");
}
