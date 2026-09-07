# Photosynth 1.9 (Windows Phone 8) → modern Android: conversion plan

Source package analysed: `Photosynth_1.9spaces.im.xap` (product ID `ef860a79-…`, version 1.9.0.0,
publisher Microsoft Corporation, `AppPlatformVersion="8.0"`, Silverlight runtime, built July 2015).

Goal as stated: **a modern Android application, minimal changes to the UI, functionality preserved.**

**Decisions taken (2026-09-07):** stay local (no cloud backend, no remote library, no upload
queue), no Facebook / Twitter and no SDK-based sharing (Android share sheet only), no "featured"
hub, and the Android app lives in its own repository (`photosynth-android`, see Section 8). The
plan below is scoped to those decisions.

This document is the plan. Section 1 says what the package actually is (so the plan is grounded in
the binary, not in memory of the product). Section 2 is the reality check that constrains
"preserved functionality". Sections 3–7 are the target architecture, the screen-by-screen UI
mapping, the native-engine plan, the data-format contract and the phased roadmap. Section 8 lists
the decisions that are yours to make.

---

## 0. Summary

- **What it is.** Microsoft Photosynth for WP8: a *panorama capture* app. Live camera preview with
  on-device image tracking + gyro/accelerometer fusion auto-captures overlapping frames while you
  sweep the phone; a native stitcher builds a spherical panorama; a native tiler writes a cubemap
  tile pyramid; a 3D viewer lets you look around it; sharing goes to camera roll, e-mail,
  Facebook, Twitter, Bing Maps and photosynth.net. It also registered as a *Lens* (launchable from
  the built-in camera) and as a `photosynth://` protocol handler.
- **What is portable.** 27 managed assemblies. **All IL is intact** (2,661/2,661 methods in
  `Photosynth.dll` have valid IL bodies; the package is MDIL-signed but MDIL keeps IL). ILSpy will
  give readable C# for every page, view-model, upload pipeline, file format writer and settings
  store. All 43 XAML pages/controls and the full 293-entry string table are recoverable (already
  extracted during this analysis). Icons, splash, coaching sprites, JSON templates and config XML
  are plain files in the package.
- **What is not portable.** Four ARMv7 C++/CX WinRT components with no source:
  `D3DCaptureTrackerComponent_Phone` (tracker + Direct3D 11 preview renderer, ~600 KB),
  `StitcherInterop_Phone` (stitcher, ~700 KB), `DeepZoomInterop_Phone` (cubemap/DeepZoom tiler
  over libjpeg, ~140 KB), `FileIOInterop_Phone` (a `MoveFile` shim). Two compiled HLSL shader
  pairs. These must be **re-implemented**, and they are the whole risk of the project.
- **What no longer exists.** photosynth.net (shut down February 2017), the Bing Maps v1 SOAP
  imagery/gazetteer/mobile-search services, the "Best of Bing" feed, Live Connect OAuth
  (`login.live.com/oauth20_*.srf` with `MBI_SSL` scope), Facebook SDK 6 embedded-WebView login,
  Twitter 1.1 OAuth 1.0a + `update_with_media`. Per the decisions above, none of these get a
  replacement backend: the app is local-only and every outbound share goes through the system
  share sheet (Section 2).
- **Recommendation.** Kotlin + Jetpack Compose app that reproduces the Metro panorama-hub / pivot
  UI one-to-one (same screens, same copy, same dark chrome and accent colour, same navigation
  graph), a C++ NDK engine (OpenCV + libjpeg-turbo + OpenGL ES 3) replacing the three native
  components behind the *same* interface shapes the WP8 code used, a local-only Library, and
  sharing rebuilt on the Android share sheet + MediaStore with no cloud layer at all. Four
  milestones, engine work dominating.

---

## 1. Inventory of the .xap (what we are converting)

### 1.1 Package layout

| Layer | Files | Notes |
|---|---|---|
| App manifests | `WMAppManifest.xml`, `AppManifest.xaml`, `MDILFileList.xml`, `RPALManifest.xml` | Capabilities: camera (rear required), location, sensors, networking, media library (photo/audio), microphone, contacts/appointments (unused by UI), push, web browser component, identity. Requires >90 MB RAM (`ID_REQ_MEMORY_90`), `ID_FUNCCAP_EXTEND_MEM`. Resolutions WVGA/WXGA/720p. |
| Entry | `Photosynth.dll` (1.19 MB, entry type `Photosynth.App`) | All pages, view-models, capture session, uploaders, sharing, DotPano writer. |
| App libraries | `PhotosynthWeb.dll` (upload pipeline, photosynth.net REST/SOAP, cubemap JSON, JPEG tools), `Settings.dll` (`AppSettings`, `PhotosynthWinPhoneConfig`, `DeviceConfig`), `Utilities.dll` (instrumentation/logging), `PhotosynthAppLib.dll` (tiny), `PSCommon.dll` (lock provider) | |
| Viewer stack (shared with Photosynth desktop/web) | `Microsoft.Photosynth.Viewer.dll` (886 KB), `IOM.Phone.dll` (Imagery Object Model: Panorama, CubeMap, Synth, Highlight, Hotspot…), `Microsoft.Maps.Scene3D_WinPhone.dll` (software 3D scene graph, BSP tree, `Viewport3D`, `TilePyramidRenderable`), `MapExtras_Phone.dll` (tile pyramid/downloader/cache), `Microsoft.MapPoint.Geometry_WinPhone.dll`, `Common.Phone.dll`, `Algorithms.Phone.dll`, `Diagnostic.Phone.dll`, `Microsoft.Photosynth.CommonUI.dll` | The viewer is **managed, software-projected** (Scene3D → `WriteableBitmap`/transformed `Image`s), not D3D. Fully decompilable. |
| Native (ARMv7, no source) | `D3DCaptureTrackerComponent_Phone.dll/.winmd`, `StitcherInterop_Phone.dll/.winmd`, `DeepZoomInterop_Phone.dll/.winmd`, `FileIOInterop_Phone.dll/.winmd`; shaders `PanoCapD-*.cso`, `PC-bkg-*.cso` | Built from `d:\tf\Ag4\AugmentedReality\PhotosynthWP8_Release\…` (Microsoft's ICE/AR team). Links MSVCR110, D3D11. |
| Third party (managed) | `Facebook.dll` 6.0.10, `Facebook.Client.dll` 0.5, `Hammock.WindowsPhone.dll` (REST/OAuth 1.0a), `Ionic.Zip.dll` 1.9.1.8, `System.Json.dll`, `Microsoft.Phone.Controls(.Toolkit).dll` (Panorama, Pivot, transitions, tilt, `PerformanceProgressBar`), `Microsoft.Expression.Interactions` + `System.Windows.Interactivity` (XAML behaviours/triggers) | |
| XNA | `Content/Audio/Waves/Shutter-22m.xnb`, `tonequietshort-22m.xnb`; refs to `Microsoft.Xna.Framework(.GamerServices/.MediaLibraryExtensions)` | XNA used only for `SoundEffect` playback (shutter + beep) and `MediaLibrary.SavePicture` (camera roll). |
| Assets | `SplashScreenImage.jpg` (769×1281, black + green leaf-aperture logo), `ApplicationIcon.png`, tiles, `Assets/Lens.Screen-*.png` (lens picker tile), `Resources/Images/appbar.*.png` (Metro app-bar glyphs: cancel, check, crop, delete, download, edit, error, next, refresh, save, share, undo, upload, camera, basecircle), `hand_1..6.png` (capture coaching sprite frames), `calibrate_compass.png` (figure-8 calibration diagram), `pushpin.png`, `tracker_testimg.png` (640×480 tracker self-test image) | |
| Data templates | `Resources/DotPanoJsonTemplate.json`, `DotPanoJsonFaceSubTemplate.json` (cubemap_json_version 1: `tile_size`, `face_size`, `field_of_view_bounds`, per-face `tile_boundaries`), `Pano*Old.json`, `PhotosynthWinPhoneConfigData.xml` (device camera config: `FocalSD` 0.81, `GyroStrength` 0.5, `UseGyro` false by default; dynamic-config / device-config URLs; Twitter/Live endpoints) | |

### 1.2 Screens and controls (from the embedded XAML)

Navigation entry: `UserInterface/MainPage.xaml?appStart=0`. Lens entry: `MainLensPage.xaml` →
`CapturePage.xaml?immediate=true&lensEntry=true`. Protocol:
`photosynth://viewExternalCid-{guid}` → viewer of a remote pano.

| WP8 page / control | What it does (behaviour recovered from XAML + method names) |
|---|---|
| **MainPage** (`controls:Panorama` "photosynth", portrait only) | Three hub sections: **capture** (live `VideoBrush` preview rotated 90°, "tap to start" overlay, fades in when camera ready; tap → CapturePage), **library** (`LibraryControl` + animated upload indicator badge top-right that bounces an upload arrow / blinks an error icon, tap → UploadQueuePage), **featured** (`BestOfBingControl`). Minimised app bar (opacity 0) with menu: help, settings, refresh library, rate & review. Camera/motion sensors activated on hub selection, deactivated on a timer. Checks for forced/optional updates. |
| **CapturePage** (portrait or landscape, system tray hidden) | Full-screen `DrawingSurface` (Direct3D) rendering the tracker's world view (captured frames pinned on a sphere + live preview quad). Preliminary preview shrinks from hub position to final position with an animation. Sliding **coaching panel** at top with four states: green "Auto capture / Move the camera to add images", yellow "Manual capture / Tap the screen to add an image", red "Can't capture / Aim at the last image to continue", calibration "Calibration needed / tap here to calibrate" (each with "For help and tips, tap here", green has a dismiss X). Tap on viewfinder = manual capture. Hardware shutter half/full press handled. Undo / Done app-bar buttons (`btnUndo_Click`, `btnFinish_Click`), Help menu → full-screen `HelpControl` dialog. Back key → "Delete panorama?" confirm (`CustomMessageBox` delete/cancel). Tracker status polled by a timer; frame count event; optional diagnostics overlay (`CapturePropertiesViewModel`, hidden setting). Plays beep on lock and shutter on capture. Geo-position watcher records location per session. |
| **StitchingPage** | 456×300 preview image that fades in each time the stitcher posts a new preview, "stitching panorama" header, `{progress}% complete` + determinate progress bar, and a `StitchingPageMessageControl` that slides a rotating "tip" card (19 titled tips: START SMALL, QUICK NAMING, PHOTOSYNTH-ESIS, CAPTURE TIP #1–4, CAMERA ROLL, CLOUD STORAGE…) every 7 s. App bar: delete / skip(“continue in background”) / properties. Back → "Delete panorama?" |
| **ViewerPage** (portrait/landscape, tray hidden) | Interactive spherical viewer (`PhotosynthControl` / `Viewport3D`), tap toggles overlays (title + author banner at top on `#A000` translucent black), double-tap zoom. App bar: share, properties, toggle highlights. Shows "upload started" toast; handles "pano not found" for remote panos. |
| **LibraryControl** | `IterativeListBox` of 192×97 thumbnail `GridItem`s (1 px `#444` border, 10 px gap), grouped under headers "on device (n)" / "on photosynth.net (n)" with an inline "Sign in with a Microsoft account" link and empty-state copy; unstitched items show a translucent "stitch" overlay; long-press context dialog with **delete**. |
| **UploadQueuePage / UploadQueueItem** | "CURRENT UPLOADS", "remaining items N", list rows: 160×80 thumb, title, state verb (waiting / uploading / upload failed), `% complete`, cancel upload / try again. |
| **PropertiesPage** ("EDIT PROPERTIES") | 460×230 thumbnail (tap → ThumbnailPickerPage), place (tap → LocationSearchPage), name text box, capture date. |
| **ThumbnailPickerPage** | Drag a crop frame over the flattened panorama to choose the thumbnail ("set thumbnail", Set). |
| **ImageCropPage** ("CROP IMAGE") | Flattened pano with four draggable lines / corner handles and dark overlays; presets "auto crop", "select all"; done button. Used before camera-roll/social share. |
| **LocationSearchPage** | Query box, "None", "NEARBY" list of gazetteer results (title + address). |
| **SharePickerPage** ("SHARE TO") | List: facebook, twitter, bing maps, photosynth.net, email, camera roll. |
| **SharePage** | Per-target page (verb + title header, e.g. "SHARE TO / facebook", "SAVE TO / camera roll", "PUBLISH TO / bing maps", "SEND IN / email"). Radio "image" vs "interactive panorama", message box with watermark + user avatar, cropped image preview (430×215), "make public on photosynth.net and bing maps" checkbox, sign-in overlays and "LOCATION MISSING" overlay for Bing Maps, map tile with pushpin for geolocated panos, waiting overlay with progress. |
| **SettingsPage** (`Pivot` "SETTINGS": general / accounts) | general: sound, capture resolution (if high-res supported), capture hints, exposure lock, white balance lock, autosave to camera roll, location services, gyroscope (if supported), sharing license (→ `SettingsDetailsSharingLicensePage`: Creative Commons radio list), restore defaults; debug page in debug builds. accounts: Microsoft account / Facebook / Twitter rows with status "please wait… / not signed in / signed in" and busy bar; "Create a name on photosynth.net" modal. Each row is a `SettingsItem` (40 px light title + 20 px subtle value). |
| **HelpControl** (`Pivot` "HELP") | about (version, ©, privacy, terms), getting started (4 numbered steps), capture hints (animated hand sprite), capture modes (auto / manual / can't capture), calibration (figure-8 diagram + live status), share (per-target explanations), attribution (third-party notices). |
| **EulaPage** | Service agreement + location-based services text, links, Accept. |
| Misc | `Toast`/`ToastNotificationBody` (accent-coloured banner with upload/error icon), `CustomMessageBox`, `ModalDialog`/`FullScreenModalDialog`/`PartialModalDialog`, `TextInputControl`, `CreatePhotosynthAccountControl`, `Login.LoginUI` (embedded `WebBrowser` OAuth), test pages (`TestPages/*` – debug only). |

### 1.3 Core runtime objects (from metadata)

- `CameraDevice` (start/stop, focus, focus lock, VGA preview), `InertialProcessingUnit`
  (accelerometer + compass + motion API → gravity, attitude, compass calibration state),
  `TrackView3d` (bridges the native controller: start/stop tracking & rendering, inhibit,
  undo, complete capture, save frame to disk, beep/shutter audio, geo watcher),
  `CaptureSession`/`CaptureFrame` (writes `PhotosynthCaptureSession.xml` /
  `PhotosynthCaptureSet.xml` manifests with per-frame corners and positions).
- Native `CCaptureController` API: `StartTracking/StopTracking/PauseTracking/ResumeTracking`,
  `StartRendering/StopRendering`, `GrabNextFrame`, `IsAbleToCaptureNewFrame`,
  `CurrentTrackingQuality`, `UndoCapture`, `InhibitCapture`, `SetMaxFrameCount`,
  `GetCurrentFrameRate`, `GetStats`; `InteropContainer` callbacks `AddedNewFrame`,
  `CenterOverNewRegion`, `getGravity`, `getAttitude`, `saveCaptureFrame`;
  `CaptureInitializationData` (NV12/YUV plane pitches, preview + source sizes,
  `NormalizedFocalLength`, `GyroStrength`, `UseGravity`, `UseAttitude`);
  `Direct3DInterop.SetPreviewCorners/OnPointer*`.
- Native `CStitcherWrapper.StitchJobAsync(...)` with progress callback (`Homography`,
  "Faceted Seam finder", "Saving cubemap tiles at level u of u"), `AbortCurrentJob`.
- Native `CDeepZoomWrapperClass.CreateFromSourceFileName/Buffer`, `SetClippingRect`,
  `SetJPEGQuality` (tile pyramid from the flattened image).
- `PanoramaManager`/`PanoramaProcessor` (state machine local → stitched → prepared → uploaded,
  `PanoramaManager.xml` persisted), `PanoramaItem` folders (`capture/`, `cubeface/`,
  `deepzoom/`, `thumbnail/`, `misc/`, `flattened.jpg`, crop rects, lat/long, YPID, remote id).
- `DotPano` writes the **`.pano` OPC package** (`[Content_Types].xml`, `_rels`,
  `properties/thumbnail.jpg`, `formats/cubemap/cubemap.json` + `atlas.jpg` + tiles) — the
  Windows 8.1 panorama format the Camera app could open.
- `UploaderPhotosynth` (`PhotosynthPrepare` → per-face zip chunks → `WebMethods`
  `CreatePanorama/AddPanoramaPhoto/PutData/CommitPanorama/GetPanoStatus`),
  `UploaderFacebookPhoto`, `UploaderTwitterPhoto`, `UploadQueue` (persisted, resumable).
- `AppSettings` (dozens of keys incl. debug toggles: DrawWorld, DrawBorders, CoverageMap,
  ShowGyro, ShowPerf, VirtualViewFinder…).

---

## 2. Reality check: what "preserved functionality" can mean in 2026

| Feature | 2015 implementation | Status today | Plan |
|---|---|---|---|
| Capture (tracking, auto-capture, coaching, undo) | Native tracker + D3D | No source | **Re-implement** (Section 5). Behaviour-level parity is the acceptance test. |
| Stitch + cubemap tiles | Native stitcher + tiler | No source | **Re-implement** with OpenCV `stitching` + own cube projection/tiler. |
| Interactive viewer | Managed Scene3D software renderer | Decompilable | **Port** the maths, render with OpenGL ES (simpler + faster than software projection on Android). Same gestures. |
| Library, properties, thumbnail picker, crop, settings, help, EULA, toasts | Managed | Decompilable | **Port 1:1.** |
| Camera roll (still image, and `.pano` "interactive" copy) | XNA `MediaLibrary` | Replaced by MediaStore | **Preserve**: JPEG with XMP GPano metadata (so Google Photos/Gallery show it as a 360 photo) + optional `.pano` file to `Documents/`. |
| E-mail share | Upload to photosynth.net then e-mail a link | Backend gone | **Preserve intent**: share sheet (`ACTION_SEND`) with the flattened JPEG attached, `.pano` as a second attachment, subject/body from `DefaultShareSubject*` / `DefaultShareMessage*`. The user picks their mail app. |
| Facebook / Twitter | Embedded WebView OAuth + SDKs | Both forbid WebView login; APIs changed | **Removed** (decision). No SDKs, no accounts. The share sheet's "image to app…" row covers posting to any social app. The Facebook/Twitter `SharePage` variants, `ShareHelper`, `UploaderFacebookPhoto`/`UploaderTwitterPhoto`, Hammock and the Facebook SDK are not ported. |
| photosynth.net upload, remote library, "on photosynth.net (n)" section, create account, sign-in with Microsoft account, upload queue | REST/SOAP + Live Connect | Service shut down 2017 | **Removed** (decision: stay local). Library shows only "on device (n)". `UploadQueue`, `UploadQueuePage`, the hub upload badge, `UploaderPhotosynth`, `PhotosynthPrepare`, `WebMethods`, Live Connect login and the create-account dialog are not ported. The on-disk format is still kept WP8-compatible (Section 6) because it costs nothing and keeps `.pano` files portable. |
| Bing Maps publish, place search (gazetteer), static map tile | Bing v1 SOAP + mobile gazetteer | Retired | **Publish removed.** Place search kept as a *local* feature of Properties via Android `Geocoder` (reverse geocode the capture location, "NEARBY" list from `getFromLocation`, free-text `getFromLocationName`); "None" option kept. Static map tile dropped (it only appeared on the Bing Maps share page). |
| Best of Bing "featured" hub | XML feed on Azure blob | Gone | **Removed** (decision). Hub has two sections: capture, library. `BestOfBingControl`/`BestOfBingViewModel` not ported. |
| Lens integration (launch from camera app) | WP8 `Camera_Capture_App` extension | No Android equivalent | Provide `android.media.action.IMAGE_CAPTURE`-style intent filter + app shortcut "Capture panorama"; **not** a camera-app plug-in. |
| `photosynth://` deep link | Protocol handler | — | Dropped; it only resolved remote collection ids. Instead register `.pano` (`application/zip` + extension) and GPano JPEG `ACTION_VIEW` intent filters so the app opens panoramas from files and other apps. |
| Rate & review | Marketplace task | — | Play In-App Review. |
| Update prompts (forced/optional), dynamic device config | Dynamic config XML | Config host gone | Dropped; Play handles updates. Device camera config (`FocalSD`, `GyroStrength`) becomes a bundled per-device table with a sensible default. |
| Analytics (Cosmos, mafdi crash reporter) | Custom | Gone | Dropped; the app makes no network calls. |

---

## 3. Target architecture

### 3.1 Stack

| Concern | Choice | Why |
|---|---|---|
| Language / UI | Kotlin, Jetpack Compose (Material 3 used only for primitives; custom Metro theme), single `Activity`, Navigation-Compose | Compose is the only practical way to reproduce the Panorama hub (parallax title, wrap-around sections) and Pivot without fighting the View system; Metro chrome is trivial to express as a custom theme. |
| Min / target SDK | minSdk 26 (CameraX + ARCore-free sensor fusion, MediaStore APIs), targetSdk latest | Same "rear camera + gyro" hardware bar as WP8; `<uses-feature android.hardware.camera.any` required, `sensor.gyroscope` optional-but-detected (mirrors `IsGyroSupported`). |
| Camera | CameraX `Preview` + `ImageAnalysis` (YUV_420_888, VGA analysis stream) + `ImageCapture` for full-res frames; `Camera2Interop` for AE/AWB lock and focus lock | Maps 1:1 onto `CameraDevice` (`SetPreviewResolutionVgaAsync`, `SetFocusLock`, exposure/white-balance lock settings). |
| Sensors | `SensorManager` `TYPE_ROTATION_VECTOR`/`TYPE_GAME_ROTATION_VECTOR`, `TYPE_GRAVITY`, `TYPE_MAGNETIC_FIELD` accuracy for compass calibration | Replaces `Microsoft.Devices.Sensors.Motion` in `InertialProcessingUnit`; calibration state → `SENSOR_STATUS_ACCURACY_*`. |
| Engine | C++17 NDK library `libpsengine.so` (OpenCV 4.x minimal build: core, imgproc, features2d, calib3d, stitching, video; libjpeg-turbo; glm), JNI bridge in `engine/` Gradle module | Replaces the three native WinRT components. Same public surface as the `.winmd` APIs so the ported Kotlin code keeps its shape. |
| Rendering | OpenGL ES 3.0 via `GLSurfaceView`/`SurfaceView` + EGL in the engine (capture world view and viewer); ported shaders in GLSL | Replaces `DrawingSurface` + D3D11 (`PanoCapD`, `PC-bkg`) and the software `Viewport3D`. |
| Persistence | Files under `filesDir/Panoramas/<id>/` with the **same folder layout and XML/JSON manifests** as WP8 isolated storage; `PanoramaManager.xml` kept as the library index (no database needed at this scale); `DataStore` for `AppSettings` | Keeps the data contract, makes `.pano` and capture-set files interchangeable with the original app's output. |
| Background work | `WorkManager` foreground worker for stitching (progress notification) | WP8 stitched in-process; Android must survive process death. |
| Sharing | `ShareCompat` / `ACTION_SEND` with `FileProvider`; MediaStore for camera roll | See Section 2. No `INTERNET` permission in the manifest. |
| Audio | `SoundPool` with the two clips transcoded from XNB (`Shutter-22m`, `tonequietshort-22m` → 22 kHz mono WAV/OGG) | Same sounds. |
| Strings | `res/values/strings.xml` generated from `Photosynth.Resources.Strings.resources` (293 keys, keep key names) | Verbatim copy, lowercase Metro capitalisation preserved. |
| Build | Gradle KTS, CMake for the engine, ABI arm64-v8a (+ x86_64 for emulator), R8 | |

### 3.2 Module layout

```
photosynth-android/
  app/            Compose UI, navigation, view-models (ported from Photosynth.dll)
  core/           PanoramaItem, PanoramaManager, CaptureSession, AppSettings, DotPano writer,
                  cubemap.json, capture-set XML, GPano XMP writer (ported from Photosynth.dll,
                  PhotosynthWeb.Utility/Prepare, Settings.dll) – pure Kotlin, unit-tested
  engine/         Kotlin API + JNI + C++ (tracker, stitcher, tiler, GL renderers)
  viewer/         Ported IOM + Scene3D maths (camera controllers, cube geometry, tile LOD)
                  on top of engine's GL renderer
  share/          Share sheet targets (camera roll, email, image to app, .pano to app),
                  FileProvider, Geocoder-backed place search
  metro-ui/       Theme, PanoramaHub, Pivot, AppBar, SettingsItem, Toast, CustomMessageBox,
                  Turnstile transition, tilt effect, PerformanceProgressBar
```

### 3.3 Porting method (managed code)

1. Decompile all 27 managed assemblies with ILSpy (on any machine with .NET; the xap is
   just a zip). Commit the C# under `reference/decompiled/` (not shipped) so every port PR can
   cite the original method.
2. Port bottom-up: `Settings` → `PhotosynthWeb.Utility`/`Prepare` → `Photosynth.UserInterface`
   models (`PanoramaItem`, `PanoramaManager`, `DotPano`) → view-models →
   pages. View-models map almost mechanically: `INotifyPropertyChanged` → `StateFlow`,
   converters → small Kotlin functions, Expression Blend triggers → Compose state.
3. Keep names. `ShareViewModel.ShowLocationMissingOverlay` stays
   `ShareViewModel.showLocationMissingOverlay`. This is what makes "minimal UI change"
   verifiable in review.
4. XAML → Compose is done page by page from the extracted XAML (pixel values are in the
   XAML; WP8 logical pixels at 480×800 map to Android `dp` ≈ 1:1 after a 0.9 scale, see 4.1).

---

## 4. UI: reproduce the Metro screens with minimal change

### 4.1 Theme and chrome

- **Dark theme only**, exactly as WP8 dark: background `#000000`, foreground `#FFFFFF`, subtle
  `#99FFFFFF`, chrome `#1F1F1F`, disabled `#66FFFFFF`. Accent: default WP8 blue `#1BA1E2`
  (user-selectable set of the WP8 accents as a setting, since the original followed the phone
  accent). Photosynth green from the logo (`#7DB800`→`#2E7D32` gradient) only in the splash.
- **Type**: Segoe WP → bundle **Selawik** (Microsoft's open-licensed, metric-compatible Segoe
  UI replacement) at Light/Semilight/Regular/Semibold. Sizes copied from XAML: hub title 65 sp
  (Panorama title), section headers 45 sp Light, `PhoneFontSizeExtraLarge` 42, `Large` 32,
  `MediumLarge` 25.3, `Medium` 22.7, `Normal` 20, `Small` 18.7; menu items 45 Light, settings
  titles 40 Light, settings values 20 subtle. Lowercase headers stay lowercase.
- **Scale**: WP8 480×800 logical px on a 4.3″ screen ≈ Android 360×600 dp. Use a 0.75–0.8
  layout factor from XAML px to dp and preserve the 12 px page gutter → 12 dp (`Margin="12,…"`
  appears on every page).
- **App bar**: bottom `ApplicationBar` reproduced as a bottom bar with up to four 48 dp
  circular-outline icon buttons (use the packaged `appbar.*.png` glyphs re-drawn as vector
  assets) and a "…" overflow that expands a menu list upward, 0.7 opacity on capture/viewer
  (`ApplicationBarPartialOpacity`), minimised/transparent on the hub (`Opacity=0`, menu only).
  Android's system back replaces the hardware Back key with identical semantics (e.g. capture
  and stitch pages intercept it with the "Delete panorama?" dialog).
- **Transitions**: Turnstile (page rotates in about the left edge) for hub/settings navigation,
  implemented as a Compose `AnimatedContent` transform; **tilt effect** on tappable list items.
- **Progress**: `PerformanceProgressBar` (five sliding dots) reproduced as a composable; used
  wherever the XAML used it (library loading, share waiting overlay, settings busy).
- **Status bar**: hidden on capture and viewer (`SystemTray.IsVisible=False`), shown elsewhere
  in black.

### 4.2 Screen-by-screen mapping

| WP8 | Android destination | Deliberate changes (only these) |
|---|---|---|
| MainPage Panorama hub (capture / library / featured) | `HubScreen`: custom `PanoramaHub` (HorizontalPager with parallax oversized title "photosynth", wrap-around, section headers) with **two** sections: capture, library | Camera preview inside the capture section uses CameraX `PreviewView`; requires runtime CAMERA permission prompt before the hub shows the preview (WP8 granted at install). "featured" section removed (decision); the upload badge in the library header removed (no uploads). Menu: help, settings, rate & review ("refresh library" no longer needed without a remote list). |
| MainLensPage | Not a separate screen; shortcut/intent launches `CaptureScreen(immediate=true)` | — |
| CapturePage | `CaptureScreen`: full-bleed `GLSurfaceView` from the engine; coaching panel composable with the same four states, colours (green/yellow/red/calibration dots), copy and slide animation; bottom app bar undo / done / help; system back → "Delete panorama?" | Hardware shutter → volume key optional. Orientation handling via `configChanges` so the GL surface isn't torn down. |
| StitchingPage | `StitchingScreen` (same layout, tip carousel, determinate progress, delete/skip/properties) | Stitching runs in a foreground `WorkManager` job; "skip" returns to the hub and progress continues in the library tile overlay (as WP8 did in-process). Of the 19 tips, the 7 that advertise photosynth.net, Bing Maps, Facebook/Twitter or the Marketplace are dropped; the capture tips, camera-roll and thumbnail tips stay. |
| ViewerPage | `ViewerScreen`: GL spherical viewer; tap toggles title/author banner; double-tap zoom; app bar share / properties | "toggle highlights" removed: highlights only ever existed on remote synths. |
| LibraryControl | `LibrarySection` inside the hub: grid of 192×97 → ~150×75 dp tiles with 1 dp `#444` border, "on device (n)" header, "stitch" overlay, long-press → delete sheet styled as the WP8 `ContextSelectModalDialog` | Single group; the "on photosynth.net" group, sign-in link and `LibraryNoRemotePanos` copy are gone. |
| UploadQueuePage / UploadQueueItem / UploadStatusControl | — | Not ported (no uploads). |
| PropertiesPage, ThumbnailPickerPage, ImageCropPage, LocationSearchPage | Same four screens, same layout | Location search backed by Android `Geocoder` (offline-capable on most devices); "NEARBY" results come from reverse-geocoding the capture location. |
| SharePickerPage / SharePage | `SharePickerScreen`, `ShareScreen(type)` | Picker rows: **camera roll, email, image to app…, interactive panorama (.pano) to app…**. `ShareScreen` keeps the WP8 layout for the surviving types: verb + title header ("SAVE TO / camera roll", "SEND IN / email"), image vs interactive-panorama radio, message box (becomes the share-sheet body text), cropped-image preview (tap → crop). Sign-in, "make public", map-tile and "LOCATION MISSING" elements are gone with their targets. |
| SettingsPage + sharing-license page | `SettingsScreen` (Pivot with the single "general" header) | "accounts" pivot removed (no accounts). "sharing license" row kept: it still writes the Creative Commons choice into the exported JPEG/`.pano` metadata (`licenceLink`). "gyroscope" row shown only when a gyro exists (same rule as WP8). |
| HelpControl (Pivot) | `HelpScreen` full-screen dialog | "share" pivot rewritten for the four local targets; attribution text updated for the new third-party set (OpenCV, libjpeg-turbo, Selawik…). |
| EulaPage | `EulaScreen` shown once (`AppEulaAcceptedSetting`) | Replace Microsoft Service Agreement links with your own terms/privacy URLs (config). |
| Toasts, CustomMessageBox, modal dialogs | `metro-ui` composables | — |

---

## 5. Engine: replacing the three native components

This is 60–70 % of the effort and the only place where behaviour cannot be *read* from the
package. The interface contracts *can* be read (Section 1.3) and the Kotlin side is written to
them first, so the engine can be developed and benchmarked independently.

### 5.1 Capture tracker (`D3DCaptureTrackerComponent_Phone` → `engine/tracker`)

Observed behaviour to reproduce: VGA preview frames (NV12 planes are passed with explicit
pitches), tracking quality drives the green/yellow/red coach, auto-capture fires when the view
has moved far enough from every captured frame and is stable (beep on lock, shutter on
capture), `CenterOverNewRegion` event lets the UI pan, gravity/attitude callbacks fuse sensor
data with `GyroStrength` (0.5 default, `UseGyro` off by default per device config,
`NormalizedFocalLength` 0.81 SD), undo removes the last frame, max frame count enforced,
`InhibitCapture` while dialogs are up, `IsAbleToCaptureNewFrame`.

Implementation:
1. **Rotation-only camera model.** Panorama capture on a phone is modelled as pure rotation.
   Keep a `Frame { R (3×3), K, keypoints, descriptors, gray VGA }` list. Maintain the current
   rotation estimate `R_cur` by fusing (a) `GAME_ROTATION_VECTOR` deltas weighted by
   `gyroStrength` with (b) visual tracking: sparse optical flow (`cv::calcOpticalFlowPyrLK` on
   GFTT/FAST corners) from the last frame, solve a rotation homography `H = K R K⁻¹`
   (`cv::findHomography` RANSAC then project to the nearest rotation) — this is the
   "Homography" string seen in the stitcher too.
2. **Tracking quality** = inlier ratio × track count thresholds → `Good/Marginal/Lost`; `Lost`
   is when fewer than N tracks survive against *any* captured frame: reproduce the red
   "Aim at the last image to continue" by re-matching against the last captured frame's
   descriptors (ORB) until it re-locks.
3. **Auto-capture rule**: angular distance from every captured frame centre > overlap threshold
   (derive from `NormalizedFocalLength`; ~⅓ frame width) *and* angular velocity below a
   stability threshold for ~250 ms → beep, then request a full-res `ImageCapture`, store R,
   emit `AddedNewFrame`. Manual mode (yellow) when gyro absent or quality marginal → tap
   captures immediately.
4. **Compass calibration state** from magnetometer accuracy → the calibration coach and the
   Help pivot's live "status".
5. **Diagnostics** (`GetStats`, `ValueCounter` min/avg/max, frame rate) exposed as before for
   the hidden diagnostics panel.
6. **World-view renderer** (`Direct3DInterop` + `PanoCapD`/`PC-bkg` shaders): GL ES scene with
   a dark background grid ("bkg"), captured frames drawn as textured quads on the unit sphere
   at their R, live preview quad at `R_cur` with the `SetPreviewCorners` outline, camera looks
   along `R_cur` so the world pans as you move (the WP8 "shrink from viewfinder to world"
   animation reproduced with the same 2-s ease).

Validation: replay recorded sessions (video + sensor log) through the tracker headlessly and
assert frame count/positions against a golden run; `tracker_testimg.png` for a synthetic
self-test as the original did.

### 5.2 Stitcher (`StitcherInterop_Phone` → `engine/stitcher`)

Inputs already on disk match WP8: `capture/frame-N.jpg` full-res frames + `PhotosynthCaptureSet.xml`
(per-frame corners/positions from the tracker). Pipeline with OpenCV `stitching_detail`
components, seeded by the tracker's rotations so it never has to search blindly:

1. Features (ORB/AKAZE on downscaled frames), pairwise matching limited to neighbours from the
   tracker graph, `BundleAdjusterRay` refinement, wave correction (horizontal).
2. Warp to spherical (`SphericalWarper`) for the **flattened.jpg** (needed for crop, thumbnail,
   camera roll) — record `FlattenedImageCropRect`/`AutoFlattenedImageCropRect` (auto-crop = largest
   inscribed rectangle of the coverage mask, same as "auto crop").
3. Exposure compensation (`GainCompensator`/blocks), seam finding (`GraphCutSeamFinder` — the
   original logged "Faceted Seam finder"), `MultiBandBlender`.
4. Render the six **cube faces** directly from the composed rotations (`cubeface/`), then the
   cubemap tile pyramid (5.3) and `cubemap.json` from the bundled template
   (`field_of_view_bounds` from the coverage extent). Progress callback in the same
   0–1 range with a preview JPEG at each stage for the StitchingScreen fade-in.
5. Abort support (`AbortCurrentJob`) via an atomic flag checked between stages.

Memory: WP8 required 90 MB+; on Android budget for 12–16 MP frames by working at
2–4 MP for registration and full-res only in the warp/blend, tile-streamed, mirroring
`MaxCaptureDiskUsageForCurrentCaptureResolution`.

### 5.3 Tiler (`DeepZoomInterop_Phone` → `engine/tiler`)

Straightforward: for each face, build a JPEG tile pyramid (tile size and quality from
`SetJPEGQuality`/template; DeepZoom folder naming `deepzoom/<face>/<level>/<x>_<y>.jpg`),
optional clipping rect, plus `atlas.jpg` (all six faces at the lowest level) used by `.pano`.
libjpeg-turbo; can be Kotlin if speed is acceptable, but C++ keeps it next to the stitcher.

### 5.4 Viewer renderer (replaces managed Scene3D software projection)

Port the *math* (cube geometry, perspective camera, LOD selection from `TilePyramid`,
camera controllers: spring, zoom, rotate, slideshow) and render with GL: six face meshes, tiles
uploaded as textures on demand from `deepzoom/` (local, or from an opened `.pano`),
touch → `CameraRotateCameraController`, pinch → `ZoomCameraController`, double-tap →
`PanoramaZoomCameraController`. Reuse the cubemap.json reader from `IOM` (`CubeMap`,
`CubeMapFace`).

---

## 6. Data contract (kept identical)

### 6.1 On-device layout per panorama

```
Panoramas/<guid>/
  PhotosynthCaptureSession.xml   session (device, resolution, start time, location, gyro use)
  PhotosynthCaptureSet.xml       frames: file name, corners, position/rotation
  capture/frame-<n>.jpg          full-res captured frames
  flattened.jpg                  spherical panorama + crop rects in PanoramaManager.xml
  cubeface/<face>.jpg
  deepzoom/<face>/<level>/<x>_<y>.jpg   tile pyramid
  thumbnail/BaseThumbnail.jpg, <w>x<h>.jpg
  misc/ (preview.jpg, photo.jpg for social share, ToBeUploaded_*.jpg)
  formats/cubemap/cubemap.json, atlas.jpg      (.pano contents)
PanoramaManager.xml              item index (id, title, capture time, lat/long, ypid, flags)
```

Keep the XML/JSON schemas byte-compatible (serialise with the same element names — ILSpy
gives the `DataContract` attributes). Benefit: a `.pano` produced by the WP8 app opens in the
Android viewer and vice-versa. The `misc/ToBeUploaded_*.jpg` files and `PanoramaManager.xml`'s
remote-id / ypid / collection-url fields are written empty and never read.

### 6.2 Exported formats

- Camera roll JPEG: flattened + crop applied, **plus XMP GPano** (`ProjectionType=equirectangular`,
  `CroppedArea*`, `Full*`, `PoseHeadingDegrees` from the compass) so Android galleries render it
  as a 360 photo — this is the modern equivalent of WP8's "interactive version in Camera Roll".
- `.pano` OPC zip exactly as `DotPano` writes it (content types, rels, thumbnail, cubemap).

---

## 7. Roadmap

| Milestone | Scope | Exit criteria |
|---|---|---|
| **M0 — Recovery + repo bootstrap** (1–2 wks) | Create `photosynth-android` (Section 8); ILSpy decompile all managed DLLs; extract XAML, strings, assets, XNB audio; write the interface specs for the three native components from the `.winmd` metadata and the callers; record 10 reference capture sessions on Android (video + sensors) for tracker validation. | Repo skeleton builds an empty app; `reference/` folder committed; `engine` API header agreed. |
| **M1 — Shell + Library** (3–4 wks) | `metro-ui` kit, hub, settings, help, EULA, library (reading WP8-format folders), properties/thumbnail/crop pages, viewer over existing `.pano`/deepzoom data (GL viewer). Ported `core` with unit tests against golden XML/JSON. | Can open a `.pano` from the original app and browse the library; UI screenshots side-by-side with WP8 emulator match. |
| **M2 — Capture + Stitch** (6–10 wks, engine-heavy) | Tracker (5.1) + world renderer, coaching states, undo/done, capture-set writer; stitcher (5.2) + tiler (5.3) as a WorkManager job; StitchingScreen; camera-roll export with GPano; `.pano` writer. | End-to-end: capture → stitch → view → save, on 3 reference devices; stitch time/quality benchmarks; golden replay tests pass. |
| **M3 — Sharing** (1–2 wks) | Share picker/pages, the four share-sheet targets with `FileProvider`, `.pano`/GPano `ACTION_VIEW` intent filters, Geocoder place search in Properties, in-app review. | Each target verified on stock Gmail/Photos/Files; a shared `.pano` re-opens in the app; no `INTERNET` permission in the merged manifest. |
| **M4 — Polish + release** (2 wks) | Accessibility (TalkBack labels mirroring WP8 automation peers), tablets/foldables (hub scales), Play assets from the packaged icon/splash, attribution page, crash/analytics opt-in. | Play internal track build. |

Risks, in order: (1) tracker feel — auto-capture must fire as reliably as the original or the
product is different; budget replay-driven tuning time. (2) Stitch quality on wide-FOV modern
lenses (OpenCV handles it, but seam/ghosting tuning is empirical). (3) Memory on 48 MP+ sensors —
cap capture resolution (the WP8 "capture resolution" setting exists for exactly this).
(4) Google Play's photo/video-permission policy: use the Photo Picker / MediaStore write APIs
only, never `READ_MEDIA_IMAGES`, so the local-only app stays policy-clean.

---

## 8. Decisions taken, and the new repository

| Question | Decision | Effect on the plan |
|---|---|---|
| Cloud posture | **Stay local.** No backend, no remote library, no upload queue. | Sections 2, 3, 4, 7 scoped accordingly; no `INTERNET` permission; no publisher module. |
| Social | **No Facebook, no SDK sharing.** | Share sheet only; Facebook/Twitter code, Hammock and the Facebook SDK are not ported. |
| Featured hub | **Dropped.** | Two-section hub (capture, library). |
| Repository | **Own repository.** | `photosynth-android`, bootstrapped in M0 as below. This plan stays in `tictactoe/docs/` as the record of the analysis; a copy goes into the new repo as `docs/PLAN.md`. |
| Device bar (default accepted) | minSdk 26, gyroscope optional with manual capture fallback. | As Section 3. |

### 8.1 Bootstrapping `photosynth-android`

```
photosynth-android/
  README.md                 what it is, build steps, device requirements
  docs/PLAN.md              this document
  reference/                NOT shipped; decompiled C#, extracted XAML + strings, WP8 screenshots
    decompiled/             ILSpy output per assembly
    xaml/                   the 43 pages/controls
    strings/Strings.resx    293 keys
    assets/                 original PNG/JPG/XNB, cubemap JSON templates, device config XML
    sessions/               recorded capture sessions (video + sensor CSV) for tracker replay
  app/ core/ engine/ viewer/ share/ metro-ui/        (Section 3.2)
  gradle/libs.versions.toml, settings.gradle.kts, build.gradle.kts
  engine/src/main/cpp/CMakeLists.txt                 OpenCV + libjpeg-turbo via prefab/FetchContent
  .github/workflows/android.yml                      assembleDebug + unit tests + lint on PR
```

- Licence: the original binaries are Microsoft's; nothing from `reference/` is redistributed.
  The new code base is a clean-room re-implementation informed by the decompilation; pick a
  licence for it (MIT/Apache-2.0) and keep the attribution page honest about OpenCV
  (Apache-2.0), libjpeg-turbo (BSD/IJG), Selawik (OFL).
- Package id `com.<you>.photosynth` (not `com.microsoft.*`), app name "Photosynth" only if you
  are comfortable with the trademark; otherwise choose a name in M0 and keep the hub title
  string as the one place it appears.
- The `android/` Capacitor shell in the `tictactoe` repo is unrelated and stays untouched.

---

## Appendix A — string table and XAML

The 293 string keys (e.g. `HubCaptureTapToStartPrompt`, `CaptureGreenCoachingTitle`,
`StitchHelperTitle1…19`, `ShareLocationMissingMessage1…3`, `SignInStatusList`) and the 43 XAML
files were extracted from `Photosynth.dll`'s `Photosynth.g.resources` /
`Photosynth.Resources.Strings.resources` with a small Python `dnfile` script; regenerate them
in M0 with ILSpy and commit under `reference/` — they are the specification for "minimal UI
change".

## Appendix B — endpoints referenced by the binary (historical; none are used by the Android app)

`photosynth.net` REST/SOAP (`WebMethods`: CreateUser, GetUserNameAvailability, CreatePanorama,
AddPanoramaPhoto, PutData/PutPCDData, CommitPanorama, GetPanoStatus, GetPanoMetadata,
ChangeMetadata, AddTags, DeletePano, GetUserPanoramas, IncrementViewCount, GetAccountStatus,
GetClientVersion, GetLocation, GetBestOfBingServer), `http://photosynth.net/view.aspx?cid=`,
`cdn1.ps1.photosynth.net/wp-config/*.xml` (dynamic + service config),
`photosynth.net/deviceconfig.psfx?deviceid=`, `bingmaps.blob.core.windows.net/bestofbing/bestofbing.xml`,
`dev.virtualearth.net/webservices/v1/imageryservice` (static map), `gazetteer.bingmobile.com/nearby.svc/v2`,
`api.m.bing.net/SearchService/Search.svc`, `login.live.com` OAuth 2.0 (`MBI_SSL` scope),
`graph.facebook.com`, `api.twitter.com/1.1` (+ `photosynth.blob.core.windows.net/auth/TwitterAuthCallback.html`),
`maps.slapi0.virtualearth.net/explore/CosmosAnalyticsService.svc`, `mafdi.cloudapp.net/Report.aspx` (crash reports).
