# nix/desktop.nix — Argus Desktop (Electron) app build + wrapper
#
# `hermesAgent` is the fully-built `.#default` package — it ships the
# canonical `argus` binary (plus legacy aliases) with the venv, runtime PATH,
# bundled skills/plugins, etc.
# already wired up.  We point the desktop at it via the existing
# `ARGUS_DESKTOP_ARGUS` override env var, so the desktop's resolver
# uses our fully wrapped binary at step 4 ("existing Argus CLI").
# No reimplementation of the agent resolution in this wrapper.
{
  pkgs,
  lib,
  stdenv,
  makeWrapper,
  hermesNpmLib,
  electron,
  hermesAgent,
  ...
}:
let
  npm = hermesNpmLib.mkNpmPassthru {
    folder = "apps/desktop";
    attr = "desktop";
    pname = "argus-desktop";
  };

  packageJson = builtins.fromJSON (builtins.readFile (npm.src + "/apps/desktop/package.json"));
  version = packageJson.version;

  # Build the renderer (dist/ + electron/ + package.json).
  renderer = pkgs.buildNpmPackage (
    npm
    // {
      pname = "argus-desktop-renderer";
      inherit version;
      doCheck = true;

      buildPhase = ''
        runHook preBuild

        # write-build-stamp.cjs replacement.  Packaged Electron reads this
        # at first-launch to pin the install.ps1 git ref; informational in
        # nix builds (the backend comes from the derivation directly).
        mkdir -p apps/desktop/build
        echo '{"schemaVersion":1,"commit":"nix","branch":"nix","dirty":false,"source":"nix"}' > apps/desktop/build/install-stamp.json

        # patch shebangs in node_modules/.bin so npm exec can find the
        # nix-store equivalents of /usr/bin/env (which doesn't exist in the sandbox)
        patchShebangs .

        pushd apps/desktop
          # stage node-pty native binaries into build/native-deps for the final nix output
          npm rebuild node-pty --build-from-source
          node scripts/stage-native-deps.cjs
          
          npm exec tsc -b
          npm exec vite build

          # Bundle the electron main into a single self-contained file so
          # the nix output doesn't need node_modules/.  simple-git (the only
          # external runtime dep of the electron main) gets inlined; electron
          # and node-pty are external (provided by the runtime / native-deps).
          # preload.cjs stays separate — Electron loads it via __dirname, not
          # require(), so it must remain a standalone file.
          node scripts/bundle-electron-main.mjs
        popd

        runHook postBuild
      '';

      checkPhase = ''
        runHook preCheck

        pushd apps/desktop

          npm run postbuild

          # validate staged node-pty native binary is present
          STAGED_PTY_NODE="./build/native-deps/node-pty/build/Release/pty.node"
          
          if [ ! -f "$STAGED_PTY_NODE" ]; then
            echo "FATAL: Missing staged node-pty native binary at $STAGED_PTY_NODE"
            echo "node-pty must be compiled natively"
            exit 1
          fi
          
        popd

        runHook postCheck
      '';

      installPhase = ''
        runHook preInstall
        mkdir -p $out
        # vite writes to apps/desktop/dist/ (we cd'd there in buildPhase).
        # apps/desktop/build was created before the cd.  electron/ is source.
        cp -rn apps/desktop/dist $out/
        cp -rn apps/desktop/electron $out/

        # flatten native-deps and install-stamp.json to the root level, exactly like
        # electron-builder's extraResources does ("from": "build/native-deps", "to": "native-deps")
        # so main.cjs can find it at process.resourcesPath + '/native-deps/node-pty'
        cp -rn apps/desktop/build/native-deps $out/
        cp -n apps/desktop/build/install-stamp.json $out/

        cp -n apps/desktop/package.json $out/
        runHook postInstall
      '';
    }
  );
in

# Electron wrapper: nixpkgs' electron binary pointed at the renderer dir.
stdenv.mkDerivation {
  pname = "argus-desktop";
  inherit version;

  dontUnpack = true;
  dontBuild = true;

  nativeBuildInputs = [ makeWrapper ];

  installPhase = ''
    runHook preInstall

    mkdir -p $out/share/argus-desktop $out/bin
    cp -r ${renderer}/* $out/share/argus-desktop/

    # Standard nixpkgs pattern for electron-builder apps: patch process.resourcesPath
    # to point to the app's directory. In Nix, unpackaged electron defaults this
    # to the electron distribution's resources path, breaking extraResources lookups.
    substituteInPlace $out/share/argus-desktop/electron/main.cjs \
      --replace-fail "process.resourcesPath" "'$out/share/argus-desktop'"

    # Wrap the nixpkgs electron binary to launch our app.  Set
    # ARGUS_DESKTOP_ARGUS to the absolute path of the nix-built `argus`
    # binary so the desktop's resolver step 4 ("existing Argus CLI on
    # PATH") uses our fully wrapped binary — venv with all deps,
    # bundled skills/plugins, runtime PATH (ripgrep/git/ffmpeg/etc).
    # No reimplementation of the agent resolver in the wrapper.
    makeWrapper ${lib.getExe electron} $out/bin/argus-desktop \
      --add-flags "$out/share/argus-desktop" \
      --set ARGUS_DESKTOP_ARGUS "${lib.getExe hermesAgent}" \
      --set ELECTRON_IS_DEV 0

    # Keep old automation working without exposing it as the primary program.
    ln -s argus-desktop $out/bin/hermes-desktop

    runHook postInstall
  '';

  passthru = {
    inherit (renderer.passthru) packageJsonPath;
  };

  meta = with lib; {
    description = "Native Electron desktop shell for Argus";
    homepage = "https://github.com/MMArgus-Team/Argus";
    license = licenses.mit;
    platforms = platforms.unix;
    mainProgram = "argus-desktop";
  };
}
