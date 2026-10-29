# Maestro smoke tests

End-to-end smoke flows for the Dev build (`Dashboarr Dev`, `com.dashboarr.app.dev`). Every flow runs in Demo Mode, so nothing reaches a real service.

## Run

1. Install the Dev build on a booted iOS simulator or a connected Android device (`pnpm ios:dev` / `pnpm android:dev`).
2. Start Metro with `pnpm start:dev`. For an Android device also run `adb reverse tcp:8081 tcp:8081`.
3. `maestro test .maestro` (or a single flow: `maestro test .maestro/smoke/movies.yaml`).

If `pnpm ios:dev` stops at "Can't determine id of Simulator app" (Xcode 27.1 no longer ships Simulator.app where Expo looks), build and install by hand after the prebuild it already ran:

```sh
cd ios && APP_VARIANT=development xcodebuild -workspace DashboarrDev.xcworkspace -scheme DashboarrDev \
  -configuration Debug -sdk iphonesimulator -destination id=<udid> -derivedDataPath build/dd build
xcrun simctl install <udid> build/dd/Build/Products/Debug-iphonesimulator/DashboarrDev.app
```

On the Android emulator (AVD `dashboarr_smoke`, Android 36 arm64), build from the prebuilt `android/` project and install by serial, so nothing lands on a phone that is also connected:

```sh
emulator -avd dashboarr_smoke -no-window -no-audio &
cd android && APP_VARIANT=development ./gradlew :app:assembleDebug -PreactNativeArchitectures=arm64-v8a
adb -s emulator-5554 install -r app/build/outputs/apk/debug/app-debug.apk
adb -s emulator-5554 reverse tcp:8081 tcp:8081
maestro --device emulator-5554 test .maestro
```

## Layout

- `smoke/`: one flow per area; `config.yaml` runs these.
- `subflows/start.yaml`: launch (connects to Metro, skips the first-run intro) and turn Demo Mode on. Every smoke flow starts with it.
- `subflows/open.yaml`: open a route through the Dev build's scheme (`dashboarr-dev://` on iOS; `dashboarr://` on Android, whose Dev build keeps the prod manifest), confirming the iOS "Open in" prompt. Navigate this way rather than through the tab bar: tabs are user-configurable, and in dev builds the LogBox toast covers the bar.

## Rules

- Never add `clearState`: on a real phone the Dev build holds the owner's real config and backend pairing.
- Demo Mode stays on after a run. On a phone, turn it off with the banner's Exit.
- Demo fixtures are static: actions report success but lists don't change, so assert on toasts and dialogs, not on the list afterwards. Cancel destructive confirms.
- Text selectors are case-insensitive full-string regexes, so "downloads" also matches the Downloads tab. Disambiguate with `below:` / `rightOf:`.
- On iOS a pressable merges its texts into one label ("Browse server, Every folder Radarr can see"), so match those with `.*text.*`.
- On Android the dev LogBox toast's container swallows taps across the bottom ~340px of the screen, not just on the visible toast. While a recurring dev error keeps the toast up, bottom-sheet rows and bottom buttons can't be tapped.
